require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();

// ─── Passport / Google OAuth ─────────────────────────────────────────────────

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  `${process.env.APP_URL}/auth/callback`,
}, (accessToken, refreshToken, profile, done) => {
  const email = profile.emails?.[0]?.value || '';
  const allowed = process.env.ALLOWED_DOMAIN || 'hobrothers.com';
  if (!email.endsWith(`@${allowed}`)) {
    return done(null, false, { message: `Access restricted to @${allowed} accounts.` });
  }
  return done(null, { email, name: profile.displayName });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '50mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.USE_HTTPS === 'true',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

app.use(passport.initialize());
app.use(passport.session());

function requireAuth(req, res, next) {
  if (process.env.DEV_BYPASS_AUTH === 'true') {
    req.user = { email: 'dev@hobrothers.com', name: 'Dev Bypass' };
    return next();
  }
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/auth/google');
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/callback',
  passport.authenticate('google', { failureRedirect: '/auth/denied' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/denied', (req, res) => {
  res.status(403).send(`
    <html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>Access Denied</h2>
      <p>Only @${process.env.ALLOWED_DOMAIN || 'hobrothers.com'} accounts are permitted.</p>
      <a href="/auth/google">Try a different account</a>
    </body></html>
  `);
});

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/auth/google'));
});

// ─── Config Endpoint (tells index.html which BC page names to use) ────────────

app.get('/config', requireAuth, (req, res) => {
  res.json({
    jobsPage:   process.env.BC_PAGE_JOBS   || 'EJWJobs',
    jobsRwPage: process.env.BC_PAGE_JOBS_RW || 'EJWJobsRW',
    bomPage:    process.env.BC_PAGE_BOM    || 'EJWJobComponents',
    imagesPage: process.env.BC_PAGE_IMAGES || 'JobImagesFactboxWS',
    user: { email: req.user.email, name: req.user.name },
  });
});

// ─── BC14 OData Proxy ─────────────────────────────────────────────────────────

const BC_BASE = process.env.BC_BASE_URL;
const BC_AUTH  = 'Basic ' + Buffer.from(
  `${process.env.BC_USERNAME}:${process.env.BC_PASSWORD}`
).toString('base64');

app.all('/api/bc/*', requireAuth, async (req, res) => {
  const suffix = req.params[0]; // everything after /api/bc/
  const qs     = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = `${BC_BASE}/${suffix}${qs}`;

  const headers = {
    'Authorization': BC_AUTH,
    'Accept':        'application/json',
  };
  if (req.method === 'PATCH' || req.method === 'POST') {
    headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    if (req.headers['if-match']) headers['If-Match'] = req.headers['if-match'];
  }

  try {
    const bcRes = await fetch(target, {
      method:  req.method,
      headers,
      body:    ['PATCH', 'POST', 'PUT'].includes(req.method)
                 ? JSON.stringify(req.body)
                 : undefined,
    });

    const contentType = bcRes.headers.get('content-type') || '';
    res.status(bcRes.status);

    if (contentType.includes('json')) {
      const data = await bcRes.json();
      res.json(data);
    } else {
      const text = await bcRes.text();
      res.send(text);
    }
  } catch (err) {
    console.error('[BC proxy error]', err.message);
    res.status(502).json({ error: 'BC14 proxy error', detail: err.message });
  }
});

// ─── Image Routes (OData via JobImagesFactboxWS) ──────────────────────────────
// Schema: one record per job with fields Picture1–Picture4 and Picture_Type1–Picture_Type4.
// Key: Job_No, Job_Type, Item_No

const IMAGES_PAGE = () => process.env.BC_PAGE_IMAGES || 'JobImagesFactboxWS';

async function fetchImageRecord(jobNo) {
  const url = `${BC_BASE}/${IMAGES_PAGE()}?$filter=Job_No eq '${encodeURIComponent(jobNo)}'&$top=1`;
  const res  = await fetch(url, { headers: { 'Authorization': BC_AUTH, 'Accept': 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status });
  const data = await res.json();
  return data.value?.[0] || null;
}

function imageRecordPatchUrl(record) {
  const jn = encodeURIComponent(record.Job_No);
  const jt = encodeURIComponent(record.Job_Type);
  const it = encodeURIComponent(record.Item_No);
  return `${BC_BASE}/${IMAGES_PAGE()}(Job_No='${jn}',Job_Type='${jt}',Item_No='${it}')`;
}

app.post('/api/images/get', requireAuth, async (req, res) => {
  const { jobNo, slot } = req.body;
  if (!jobNo || !slot) return res.status(400).json({ error: 'jobNo and slot required' });

  try {
    const record = await fetchImageRecord(jobNo);
    if (!record) return res.json({ success: false });
    const pic = record[`Picture${slot}`];
    if (!pic) return res.json({ success: false });
    res.json({ success: true, base64: pic, mime: record[`Picture_Type${slot}`] || 'image/jpeg' });
  } catch (err) {
    console.error('[image get error]', err.message);
    res.status(err.status || 502).json({ success: false, error: err.message.slice(0, 300) });
  }
});

app.post('/api/images/upload', requireAuth, async (req, res) => {
  const { jobNo, slot, base64, mime } = req.body;
  if (!jobNo || !slot || !base64) return res.status(400).json({ error: 'jobNo, slot, base64 required' });

  try {
    const record = await fetchImageRecord(jobNo);
    if (!record) return res.status(404).json({ success: false, error: `No image record found for job ${jobNo}` });

    const patchUrl = imageRecordPatchUrl(record);
    const rawB64   = base64.includes(',') ? base64.split(',')[1] : base64;

    const patchRes = await fetch(patchUrl, {
      method:  'PATCH',
      headers: { 'Authorization': BC_AUTH, 'Content-Type': 'application/json', 'If-Match': record['@odata.etag'] || '*' },
      body: JSON.stringify({ [`Picture${slot}`]: rawB64, [`Picture_Type${slot}`]: mime || 'image/jpeg' }),
    });

    if (patchRes.ok || patchRes.status === 204) return res.json({ success: true });
    const errText = await patchRes.text();
    return res.status(patchRes.status).json({ success: false, error: errText.slice(0, 300) });
  } catch (err) {
    console.error('[image upload error]', err.message);
    res.status(err.status || 502).json({ success: false, error: err.message.slice(0, 300) });
  }
});

app.post('/api/images/delete', requireAuth, async (req, res) => {
  const { jobNo, slot } = req.body;
  if (!jobNo || !slot) return res.status(400).json({ error: 'jobNo and slot required' });

  try {
    const record = await fetchImageRecord(jobNo);
    if (!record) return res.status(404).json({ success: false, error: `No image record found for job ${jobNo}` });

    const patchUrl = imageRecordPatchUrl(record);
    const patchRes = await fetch(patchUrl, {
      method:  'PATCH',
      headers: { 'Authorization': BC_AUTH, 'Content-Type': 'application/json', 'If-Match': record['@odata.etag'] || '*' },
      body: JSON.stringify({ [`Picture${slot}`]: '', [`Picture_Type${slot}`]: '' }),
    });

    if (patchRes.ok || patchRes.status === 204) return res.json({ success: true });
    const errText = await patchRes.text();
    return res.status(patchRes.status).json({ success: false, error: errText.slice(0, 300) });
  } catch (err) {
    console.error('[image delete error]', err.message);
    res.status(err.status || 502).json({ success: false, error: err.message.slice(0, 300) });
  }
});

// ─── Static File Serving ──────────────────────────────────────────────────────

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3005', 10);

if (process.env.USE_HTTPS === 'true') {
  const sslOptions = {
    key:  fs.readFileSync(process.env.CERT_KEY_PATH),
    cert: fs.readFileSync(process.env.CERT_CERT_PATH),
  };
  https.createServer(sslOptions, app).listen(PORT, () => {
    console.log(`CAD Portal running at https://cadportal.hobrothers.com (port ${PORT})`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`CAD Portal running at http://localhost:${PORT}`);
  });
}
