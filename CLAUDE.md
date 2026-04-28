# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BC-CAD-Portal is an internal tool for HO Brothers' CAD design team. It lets users look up jobs in Business Central 14 (on-prem), upload CAD images (up to 4 per job), add Vntana/Thinkspace 3D model links, and edit Bill of Materials weights — then sync everything to BC in one step.

**Deployed at:** `https://cadportal.hobrothers.com` (Azure VM, Windows Server)

## Branch Structure

| Branch | Purpose |
|---|---|
| `main` | Original single-file prototype (do not use for new work) |
| `BC27-prototype` | Preserved reference — the original Cloudflare Worker + BC27 cloud version |
| `BC14-Prototype` | **Active development branch** — Node.js server + BC14 on-prem |

**Always work on `BC14-Prototype`.**

## Running Locally

```bash
npm install
cp .env.example .env   # fill in credentials
node server.js         # starts on PORT from .env (default 3000)
```

Visit `http://localhost:3000`. Google OAuth will redirect to `APP_URL/auth/callback` — for local dev, set `APP_URL=http://localhost:3000` in `.env` and add `http://localhost:3000/auth/callback` as an authorized redirect URI in Google Cloud Console.

For local testing without OAuth, you can temporarily bypass auth in `server.js` by returning a fake user in `requireAuth`.

## Architecture

### File Structure

```
BC-CAD-Portal/
├── index.html       — entire frontend (vanilla JS, no framework, ~1320 lines)
├── server.js        — Express server: Google OAuth, auth middleware, BC14 proxy, static serving
├── package.json
├── .env             — secrets (gitignored — never commit)
├── .env.example     — template for .env
└── CLAUDE.md
```

### Server (`server.js`)

Three responsibilities:
1. **Google OAuth 2.0** — `/auth/google` → Google → `/auth/callback` → session. Only `@hobrothers.com` accounts pass. Session lasts 8 hours.
2. **BC14 OData proxy** — `GET|PATCH|POST /api/bc/*` strips the prefix and forwards to `BC_BASE_URL/<remainder>`, injecting `Authorization: Basic ...`. The browser never touches BC14 directly.
3. **Image routes** — `/api/images/get`, `/api/images/upload`, `/api/images/delete` wrap the `JobImagesFactboxWS` OData page logic (filter by job+slot, PATCH the `Picture` field).
4. **Config endpoint** — `GET /config` (auth-protected) returns BC14 page names from env vars + the logged-in user's email. `index.html` fetches this on load via `init()`.

### Frontend (`index.html`)

On load, `init()` fetches `/config` and populates the `CFG` object:
```javascript
CFG = { jobsPage, jobsRwPage, bomPage, imagesPage, COMPANY }
```

All OData requests use `api(path, qs)` which builds `/api/bc/${path}${qs}` — same origin, no auth headers needed in the browser.

Image calls use `/api/images/*` directly.

**Key functions:**

| Function | What it does |
|---|---|
| `init()` | Fetches /config, sets CFG, logs ready message |
| `doLook()` | Looks up job via CFG.jobsPage, calls fillJob() |
| `fillJob(j)` | Populates UI, fetches BC images + BOM lines |
| `doSub()` | Runs all pending changes: link PATCH + image uploads + BOM saves |
| `proxyPatchByFilter(jobNo, etag, body)` | PATCH to CFG.jobsRwPage, tries 3 key formats |
| `proxyPicByJobNo(jobNo, b64, mime, slot)` | POSTs to /api/images/upload |
| `fetchBCImages(jobNo)` | Fetches slots 1–4 from /api/images/get, renders gallery |
| `deleteBCImage(jobNo, slot)` | DELETEs via /api/images/delete |
| `fetchBOMLines(jobNo)` | GETs CFG.bomPage, populates BOM table |
| `saveBOMWeights(jobNo, jobType)` | PATCHes changed BOM weights to CFG.bomPage |

**Global state:**
```javascript
job                   // current loaded job object from BC
images[]              // pending uploads: {name, b64, mime, size}
window._currentJob    // same as job, used by BOM sidebar
window._bomLines      // BOM items for current job
window._bomAllLines   // all BOM items including hidden
```

**UI conventions:**
- `toast(msg, type)` — 5-second notification ('ok' or 'err')
- `showOv(text)` / `hideOv()` — full-screen loading overlay
- `addLog(type, msg, detail)` — appends to activity log panel (types: 'ok','info','warn','error')
- Cards 2 and 3 start `locked`; class removed after successful job lookup
- Step badges get class `done` (checkmark) when step completes

### Environment Variables (`.env`)

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console OAuth credentials |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `SESSION_SECRET` | Random 32+ char string |
| `BC_BASE_URL` | `https://ej.hobrothers.com:9048/JW140PBIdev/ODataV4/Company('HOBrothers')` |
| `BC_USERNAME` | BC14 service account (e.g. `hosrv\shaligram`) |
| `BC_PASSWORD` | BC14 service account password |
| `ALLOWED_DOMAIN` | `hobrothers.com` — only this Google Workspace domain can log in |
| `BC_PAGE_JOBS` | OData page name for job lookup (read-only) |
| `BC_PAGE_JOBS_RW` | OData page name for job updates (writable) — needed for Vntana link + metal weight |
| `BC_PAGE_BOM` | OData page name for BOM components — needed for BOM weight editing |
| `BC_PAGE_IMAGES` | `JobImagesFactboxWS` — image upload/retrieval page |
| `PORT` | `3000` locally, `443` in production |
| `USE_HTTPS` | `false` locally, `true` in production |
| `CERT_KEY_PATH` | Path to Let's Encrypt private key PEM |
| `CERT_CERT_PATH` | Path to Let's Encrypt full chain PEM |
| `APP_URL` | `https://cadportal.hobrothers.com` in production |

### BC14 OData Page Dependencies

The app uses 4 BC14 OData pages. Not all are needed for every feature:

| Page env var | Required for |
|---|---|
| `BC_PAGE_JOBS` | Job lookup (Step 1 — required for everything) |
| `BC_PAGE_IMAGES` | Image upload/view (the primary use case) |
| `BC_PAGE_JOBS_RW` | Saving Vntana/Thinkspace link and metal weight |
| `BC_PAGE_BOM` | BOM weight editing sidebar |

To find page names in BC14: **Administration → IT Administration → General → Web Services**

### Known BC14 Specifics

- Image field on `JobImagesFactboxWS` is `Picture` (base64). Filtered by `Job_No` and `Picture_Slot` (1–4).
- `proxyPatchByFilter` tries 3 OData key formats (`Job_No='x'`, `'x'`, `No='x'`) because BC14 key field naming varies by page configuration.
- BC14 returns `@odata.etag` on records; the proxy forwards `If-Match: *` for all PATCHes to avoid ETag conflicts.
- The proxy at `/api/bc/*` passes query strings and request bodies through as-is — no transformation.
