# NexusPOS — Web (v2.4)

The full NexusPOS point-of-sale as an installable web app (PWA). Same features as the
Android build: PIN sign-in, sell & camera barcode scanning, takeaway/dine-in/delivery with
zones & fees, tables + QR guest ordering, Kitchen Display, shifts & Z-reports, customers
with credit accounts and WhatsApp/Viber statements, wastage, expenses, P&L, PDF-printable
reports, product photos, customizable dashboard. Works offline after first load.

**Data model:** each browser/device keeps its own data (localStorage), exactly like the
Android app. Use Admin → Data & Backup to move data between devices. Multi-device sync is
the server edition (phase 2).

## Deploy on GitHub Pages (no tools needed)
1. Create a GitHub account → **New repository** → name it `nexuspos` → Public → Create.
2. Upload every file/folder from this project (keep the `.github` folder!) → Commit.
3. Repo **Settings → Pages → Source: GitHub Actions**.
4. **Actions** tab → wait for "Deploy NexusPOS" to go green (~2 min).
5. Open `https://YOUR-USERNAME.github.io/nexuspos/` — sign in with PIN 9999.

## Update for testing
Edit any file on GitHub (e.g. `src/App.jsx`) → Commit to `main` → Actions rebuilds and
publishes automatically. Refresh the app to pick it up (close & reopen if installed).

## Run locally (optional)
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

Default PINs — Abdulla/owner 9999 · Shifna/manager 5555 · Ahmed/cashier 1111.
Change them in Admin → Users before real use.
