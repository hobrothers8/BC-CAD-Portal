# SETUP.md — Deployment Guide

Deployment target: Azure VM (Windows Server) at `https://cadportal.hobrothers.com`

---

## Part 1: Copy Files to Azure VM

**No inetpub, no IIS, no compilation.** Node.js runs the app directly — just copy the source files and start the server.

1. On the Azure VM, create a folder: `C:\cad-portal\`
2. Copy these files from the repo into that folder:
   ```
   index.html
   server.js
   package.json
   .env.example
   ```
   Do **not** copy `node_modules\` (you'll install fresh on the VM) or `.env` (you'll create it on the VM).

3. On the VM, open PowerShell in `C:\cad-portal\` and run:
   ```powershell
   npm install
   ```
   This reads `package.json` and downloads all dependencies into `node_modules\`. Takes ~30 seconds. No compilation step — Node.js runs JavaScript directly.

4. Create `.env` on the VM (copy from `.env.example` and fill in values):
   ```powershell
   copy .env.example .env
   notepad .env
   ```

---

## Part 2: Google Cloud Console — OAuth Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown (top left) → **New Project**
   - Name: `HO-Brothers-CAD-Portal` → Create
3. Make sure the new project is selected in the dropdown
4. Left sidebar → **APIs & Services → OAuth consent screen**
   - User type: **Internal** ← critical — this restricts to your Google Workspace org only
   - Click **Create**
   - App name: `CAD Portal`
   - User support email: your email
   - Developer contact email: your email
   - Click **Save and Continue** through all steps (no scopes needed beyond default)
5. Left sidebar → **APIs & Services → Credentials**
   - Click **+ Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Name: `CAD Portal Web`
   - Under **Authorized redirect URIs** → **Add URI**:
     ```
     https://cadportal.hobrothers.com/auth/callback
     ```
   - Click **Create**
6. A dialog shows your **Client ID** and **Client Secret** — copy both into `.env`:
   ```
   GOOGLE_CLIENT_ID=<paste here>
   GOOGLE_CLIENT_SECRET=<paste here>
   ```

**User management:** Because you chose "Internal", only users in your Google Workspace (`@hobrothers.com`) can log in. To grant access: add the user in Google Workspace Admin. To revoke: suspend or delete their Google account. No other list to manage.

---

## Part 3: Fill in `.env` on the VM

```env
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
SESSION_SECRET=<run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">

BC_BASE_URL=https://ej.hobrothers.com:9048/JW140PBIdev/ODataV4/Company('HOBrothers')
BC_USERNAME=hosrv\shaligram
BC_PASSWORD=<BC14 service account password>

ALLOWED_DOMAIN=hobrothers.com

BC_PAGE_JOBS=<look up in BC14 Web Services>
BC_PAGE_JOBS_RW=<look up in BC14 Web Services>
BC_PAGE_BOM=<look up in BC14 Web Services>
BC_PAGE_IMAGES=JobImagesFactboxWS

APP_URL=https://cadportal.hobrothers.com
PORT=443
USE_HTTPS=true
CERT_KEY_PATH=C:\certs\cadportal\privkey.pem
CERT_CERT_PATH=C:\certs\cadportal\fullchain.pem
```

To find BC14 page names: in BC14 go to **Administration → IT Administration → General → Web Services**. The "OData V4" column shows the page names.

---

## Part 4: HTTPS Certificate (win-acme / Let's Encrypt)

**Prerequisite:** GoDaddy DNS A record for `cadportal.hobrothers.com` must already point to the Azure VM's public IP, and port 80 must be open in Azure NSG (temporarily, for validation).

1. **Open port 80** in Azure Portal → VM → Networking → Add inbound rule: TCP 80
2. **Download win-acme** from [win-acme.com](https://www.win-acme.com) — extract to `C:\win-acme\`
3. Open PowerShell **as Administrator** in `C:\win-acme\` and run:
   ```powershell
   .\wacs.exe
   ```
4. Follow the interactive prompts:
   - `N` — Create certificate (default settings)
   - `4` — Manual input of host names
   - Host: `cadportal.hobrothers.com`
   - Validation: `1` — HTTP-01 (win-acme handles this automatically)
   - Private key: `1` — RSA 2048
   - Store: choose **PEM files** and set path to `C:\certs\cadportal\`
   - Installation: `5` — No installation (we read the files in Node.js)
5. win-acme creates a Windows Scheduled Task that auto-renews the cert every ~60 days.
6. Confirm files exist:
   ```
   C:\certs\cadportal\privkey.pem
   C:\certs\cadportal\fullchain.pem
   ```
7. **Close port 80** in Azure NSG after cert is issued (unless you need it for other reasons).
8. **Open port 443** in Azure NSG: TCP 443 inbound.

---

## Part 5: Start the Server with PM2

PM2 keeps the server running and auto-restarts it after crashes or reboots.

```powershell
# Install PM2 and Windows startup helper globally
npm install -g pm2
npm install -g pm2-windows-startup

# Start the app
cd C:\cad-portal
pm2 start server.js --name cad-portal

# Save process list so PM2 knows what to restart
pm2 save

# Register PM2 as a Windows Service (auto-starts on reboot)
pm2-startup install
```

**Useful PM2 commands:**
```powershell
pm2 logs cad-portal          # tail live logs
pm2 logs cad-portal --lines 100  # last 100 lines
pm2 restart cad-portal       # restart after .env or server.js changes
pm2 stop cad-portal          # stop
pm2 status                   # see running processes
```

---

## Part 6: Verify It's Working

1. Visit `https://cadportal.hobrothers.com` — should redirect to Google Sign-In
2. Sign in with a `@hobrothers.com` account — should land on the portal
3. Try signing in with a non-hobrothers account — should get the "Access Denied" page
4. Enter a job number and click Lookup — should hit BC14 and return job details
5. Upload an image and click "Update Job in BC" — check BC14 that the image saved

---

## Updating the App

After making code changes locally:
1. Copy updated `index.html` and/or `server.js` to `C:\cad-portal\` on the VM
2. `pm2 restart cad-portal`

If you add new npm packages: also run `npm install` on the VM after copying the updated `package.json`.

`.env` changes take effect on restart — `pm2 restart cad-portal`.
