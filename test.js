// BC-CAD-Portal schema + write test
// Usage: node test.js <jobNo>   e.g.  node test.js J063757
// Requires: DEV_BYPASS_AUTH=true in .env, server running on PORT

require('dotenv').config();
const fetch = require('node-fetch');

const BASE = `http://localhost:${process.env.PORT || 3005}`;
const JOB  = process.argv[2];
if (!JOB) { console.error('Usage: node test.js <jobNo>'); process.exit(1); }

const PASS = '\x1b[32m PASS \x1b[0m';
const FAIL = '\x1b[31m FAIL \x1b[0m';
const WARN = '\x1b[33m WARN \x1b[0m';
const INFO = '\x1b[36m INFO \x1b[0m';

let _cookie = '';
async function req(method, path, body, extraHeaders={}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(_cookie ? { Cookie: _cookie } : {}), ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) _cookie = sc.split(';')[0];
  let data; try { data = await r.json(); } catch { data = await r.text(); }
  return { status: r.status, data };
}

const pass = (l, d='') => console.log(`${PASS} ${l}`, d);
const fail = (l, d='') => console.log(`${FAIL} ${l}`, d);
const warn = (l, d='') => console.log(`${WARN} ${l}`, d);
const info = (l, d='') => console.log(`${INFO} ${l}`, d);

function checkFields(label, record, required, optional=[]) {
  const keys = Object.keys(record);
  const missing = required.filter(f => !(f in record));
  const found   = required.filter(f => f in record);
  if (missing.length === 0) {
    pass(`${label} — required fields`, found.join(', '));
  } else {
    fail(`${label} — missing fields`, missing.join(', '));
    info(`${label} — fields present`, keys.join(', '));
  }
  const optFound    = optional.filter(f => f in record);
  const optMissing  = optional.filter(f => !(f in record));
  if (optFound.length)   info(`${label} — optional found`,   optFound.join(', '));
  if (optMissing.length) warn(`${label} — optional missing`, optMissing.join(', '));
}

async function run() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`BC-CAD-Portal schema + write test  →  ${BASE}`);
  console.log(`Job: ${JOB}`);
  console.log(`${'─'.repeat(60)}\n`);

  // ── Bootstrap: get config ────────────────────────────────────────────────
  const { status: cs, data: cfg } = await req('GET', '/config');
  if (cs !== 200 || !cfg.jobsPage) {
    fail('/config unreachable — is server running with DEV_BYPASS_AUTH=true?');
    process.exit(1);
  }
  info('Config', `jobsPage=${cfg.jobsPage}  jobsRwPage=${cfg.jobsRwPage}  imagesPage=${cfg.imagesPage}`);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── 1. JWJobCard (read) ─────────────────────────────────────────\n');
  // ════════════════════════════════════════════════════════════════════════

  const { status: js, data: jd } = await req('GET', `/api/bc/${cfg.jobsPage}?$filter=Job_No eq '${encodeURIComponent(JOB)}'&$top=1`);
  if (js !== 200 || !jd.value?.length) {
    fail('Job lookup failed', `status=${js}  ${JSON.stringify(jd).slice(0,200)}`);
    process.exit(1);
  }
  const jobRec = jd.value[0];
  pass('Job lookup', `Found "${jobRec.Description}" (Job_Type=${jobRec.Job_Type})`);

  // Fields the frontend reads on fillJob()
  checkFields('JWJobCard read schema',
    jobRec,
    ['Job_No', '@odata.etag', 'Description', 'Status', 'Total_Metal_Weight'],
    ['Vntana_Link', 'Thinkspace_Link', 'Customer_Name', 'Job_Type']
  );

  // Detect the actual link field name
  const linkField = 'Vntana_Link' in jobRec ? 'Vntana_Link'
                  : 'Thinkspace_Link' in jobRec ? 'Thinkspace_Link'
                  : null;
  if (linkField === 'Vntana_Link') {
    pass('Link field', 'Vntana_Link exists — frontend PATCH will work as-is');
  } else if (linkField === 'Thinkspace_Link') {
    pass('Link field', 'Thinkspace_Link exists — frontend now uses correct field name');
  } else {
    fail('Link field', 'Neither Vntana_Link nor Thinkspace_Link found on this page');
  }
  info('Link field current value', `${linkField}: "${jobRec[linkField] || '(empty)'}"`);
  info('Metal weight current value', `Total_Metal_Weight: ${jobRec.Total_Metal_Weight ?? '(not set)'}`);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── 2. JWJobCard (RW) — PATCH key format + writability ──────────\n');
  // ════════════════════════════════════════════════════════════════════════

  // Test which key format BC accepts (no-op PATCH — same value back)
  const noOpBody = { Total_Metal_Weight: jobRec.Total_Metal_Weight ?? 0 };
  const jn = encodeURIComponent(JOB);
  const jt = encodeURIComponent(jobRec.Job_Type || '');
  const it = encodeURIComponent(jobRec.Item_No  || '');
  const keyFormats = [
    { label: `(Job_No,Job_Type,Item_No)`, url: `/api/bc/${cfg.jobsRwPage}(Job_No='${jn}',Job_Type='${jt}',Item_No='${it}')` },
    { label: `(Job_No,Job_Type)`,         url: `/api/bc/${cfg.jobsRwPage}(Job_No='${jn}',Job_Type='${jt}')` },
    { label: `(Job_No='${JOB}')`,         url: `/api/bc/${cfg.jobsRwPage}(Job_No='${jn}')` },
    { label: `('${JOB}')`,               url: `/api/bc/${cfg.jobsRwPage}('${jn}')` },
    { label: `(No='${JOB}')`,            url: `/api/bc/${cfg.jobsRwPage}(No='${jn}')` },
  ];

  const rwEtag = jobRec['@odata.etag'] || '*';
  let workingKeyUrl = null;
  for (const { label, url } of keyFormats) {
    const { status, data } = await req('PATCH', url, noOpBody, { 'If-Match': rwEtag });
    if (status === 200 || status === 204) {
      pass(`PATCH key format`, `${label}  →  ${status} (writable)`);
      workingKeyUrl = url;
      break;
    } else {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      warn(`PATCH key ${label}`, `${status} — ${msg.slice(0, 120)}`);
    }
  }
  if (!workingKeyUrl) {
    fail('PATCH key format', 'All three key formats rejected — JWJobCard may be read-only or key field unknown');
  }

  // Test patching the link field specifically
  if (workingKeyUrl && linkField) {
    const currentLink = jobRec[linkField] || '';
    const patchField  = linkField;
    const { status, data } = await req('PATCH', workingKeyUrl, { [patchField]: currentLink }, { 'If-Match': rwEtag });
    if (status === 200 || status === 204) {
      pass(`PATCH ${patchField}`, 'field is writable');
    } else {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      fail(`PATCH ${patchField}`, `${status} — ${msg.slice(0, 200)}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── 3. JobImagesFactboxWS — schema + writability ────────────────\n');
  // ════════════════════════════════════════════════════════════════════════

  const { status: is, data: imgData } = await req('POST', '/api/images/get', { jobNo: JOB, slot: 1 });
  if (is === 200) {
    if (imgData.success) {
      pass('Image get slot 1', `${Math.round(imgData.base64.length / 1024)} KB  mime=${imgData.mime}`);
    } else {
      info('Image get slot 1', 'No image in slot 1 (empty slot — normal)');
    }
  } else {
    fail('Image get slot 1', `${is} — ${JSON.stringify(imgData).slice(0,200)}`);
  }

  // Verify all 4 slots are queryable
  for (const slot of [2, 3, 4]) {
    const { status, data } = await req('POST', '/api/images/get', { jobNo: JOB, slot });
    if (status === 200) {
      info(`Image get slot ${slot}`, data.success ? `${Math.round(data.base64.length/1024)} KB` : 'empty');
    } else {
      fail(`Image get slot ${slot}`, `${status} — ${JSON.stringify(data).slice(0,100)}`);
    }
  }

  // Test write: no-op PATCH on Picture_Type1 (lightweight — no image data)
  // Fetch raw record to get key fields
  const { status: rrs, data: rrd } = await req('GET',
    `/api/bc/${cfg.imagesPage}?$filter=Job_No eq '${encodeURIComponent(JOB)}'&$top=1`);
  if (rrs === 200 && rrd.value?.[0]) {
    const imgRec = rrd.value[0];
    checkFields('JobImagesFactboxWS schema', imgRec,
      ['Job_No', 'Job_Type', 'Item_No', '@odata.etag',
       'Picture1', 'Picture2', 'Picture3', 'Picture4',
       'Picture_Type1', 'Picture_Type2', 'Picture_Type3', 'Picture_Type4']
    );

    // No-op PATCH: write back the current Picture_Type1 value, using real ETag
    const jn2      = encodeURIComponent(imgRec.Job_No);
    const imgJt    = encodeURIComponent(imgRec.Job_Type);
    const imgIt    = encodeURIComponent(imgRec.Item_No);
    const patchUrl = `/api/bc/${cfg.imagesPage}(Job_No='${jn2}',Job_Type='${imgJt}',Item_No='${imgIt}')`;
    const etag     = imgRec['@odata.etag'] || '*';
    const { status: ps, data: pd } = await req('PATCH', patchUrl,
      { Picture_Type1: imgRec.Picture_Type1 || '' }, { 'If-Match': etag });
    if (ps === 200 || ps === 204) {
      pass('JobImagesFactboxWS PATCH', `key (Job_No, Job_Type, Item_No) accepted — images are writable`);
    } else {
      const msg = typeof pd === 'string' ? pd : JSON.stringify(pd);
      fail('JobImagesFactboxWS PATCH', `${ps} — ${msg.slice(0, 200)}`);
    }
  } else {
    fail('JobImagesFactboxWS raw fetch', `${rrs} — ${JSON.stringify(rrd).slice(0,200)}`);
  }

  console.log('');
}

run().catch(err => { console.error('\nUnhandled error:', err.message); process.exit(1); });
