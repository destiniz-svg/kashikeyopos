# KashikeyoPOS · Build plan

25 Sep 2026 · approved direction: one layout, **two looks** (Standard and
Lagoon), each with day and night. Read with `PRODUCT.md` (who it is for and the
rules) and `SPEC.md` (what each device does and how sync works).

---

## 1. Where the product stands

### Strong, keep it

- **Money is right and provable.** One settlement order on every screen. Every
  sale posts a balanced journal on the server. Tax, service, rounding, points
  and tips are each tied to an account. The server repairs and flags a wrong
  till rather than rejecting a sale.
- **Offline selling works.** A durable outbox in IndexedDB, and ops that can
  be replayed without duplicating anything. Refused ops are parked with the
  outlet's own reason. Load-tested to 40 concurrent tills with no errors and no
  duplicates (`LOAD.md`).
- **Isolation.** A database per business, and a schema and login role per
  outlet. Row-level security on the shared tables and a 13-attempt leak test.
- **Honest screens.** A long sweep removed invented figures and controls that
  claimed to do things they didn't. Tests now enforce it (`test/audit.test.js`
  and `test/wiring.test.js`).
- **Coverage.** Till, KDS, back office (stock, purchasing, payroll, GST,
  accounts), QR ordering, member card, Mission Control, and 631 tests.
- **Ready for a new look.** The till already runs on colour tokens (≈2,200
  `var()` uses against 122 raw colours), with a light and a dark theme. A new
  look is a new token set, not a rewrite.

### Weak, fix in this plan

| # | Finding | Effect on a shop | Where it's fixed |
|---|---|---|---|
| R1 | Devices see each other's changes only through a 5-second poll (measured 2.5–5 s) | The kitchen gets orders late; two waiters work from stale floors | 1.6 |
| R2 | Unsent ticket lines live only on the device that took them | Order on the phone, walk to the till, and the lines aren't there | 2.1 |
| R3 | Receipt numbers are issued by the server | An offline receipt has no MIRA-valid number when it prints | 1.7 |
| R4 | Scalar edits (covers, guest name) are last-write-wins with no notice | Two waiters change one table and one change silently disappears | 2.2 |
| R5 | Kitchen colours are by state, not by time; no bump-bar keys | The chef can't see the oldest ticket at a glance | 1.5 |
| R6 | Dish options open in a modal; splitting has no "by item" | The ticket disappears while choosing; item splits are done by hand | 1.2, 1.4 |
| R7 | Touch targets are 44 px (spec: 48 / 56) | Mis-taps in a rush | 1.2–1.9 as each screen is restyled |
| R8 | `app/index.html` is 24,000 lines with ~1,000 inline styles | Every visual change is slow and risky | Tokens first (0.2), so most screens change look without being touched |
| R9 | The test store's trading is corrupted (the old units bug) | The money screens can't be re-verified on it | 0.1 |

### Known open items (already recorded in `CLAUDE.md`), in this plan as "alongside"

- ~~Batches are never drawn down as stock is used.~~ **Done (060).** Outward
  moves draw lots earliest use-by first, and a void puts back exactly what it
  took. Allocation only: no money figure moves.
- The Today briefing and CFO advisory still call a model helper that doesn't
  exist in a real browser. They say so honestly, but they're dead.
- There's no rota, so lateness can't be measured.
- The accessibility sweep covers landing screens, not every modal, and no
  screen reader has been run over the app.
- The live S3 backup round trip has never been run; the file driver is proven.
- The portal templates log three harmless SVG parse errors per load.
- Receipts print ASCII only, so Dhivehi can't be printed yet.

---

## 2. How the work runs

- **One PR per slice below.** Each is verified in a real browser at 390, 1024
  and 1440 px, in **both looks and both themes**, before review. Money slices
  also get an API test against real Postgres.
- **Merged and deployed only on your go-ahead**, as now.
- **Heavy logic gets the strongest model** (split rounding, receipt numbering,
  versions, SSE). Screen restyles use the standard one.
- **Nothing ships dark.** Each slice is visible to users when merged, or
  hidden behind the look switch until its screen is done (see 0.2).

---

## 3. Phase 0 · groundwork (≈ 3 days)

### 0.1 A clean test store *(you, 5 minutes)*
Settings → Device & data → **Clear the trading…** on the test store (owner PIN,
type RESET). Then the e2e agents re-run the money screens to get a clean
baseline before anything visual changes.
**Done when:** the Z-report, the trial balance and cash takings tie on a fresh
day of test sales.

### 0.2 The look switch
- **Tokens:** `app/kashikeyo.css` gets `[data-look="lagoon"]` token sets for
  day and night, mapped onto the **existing** token names (`--bg`, `--text`,
  `--line`, the status families). Standard is today's tokens, adjusted to the
  V1 boards.
- **Setting:**
  - `look` is an outlet setting, so it applies to every device (the `PREFS`
    road).
  - Day or night stays per device (already in `DEVICE_PREFS`). Its default
    becomes "follow the device", with a manual override.
- **Fonts:** Bricolage Grotesque is self-hosted in `app/fonts`, because the CSP
  allows only fonts served by the app itself.
- **Store accent colour:** the owner's custom accent (`applyTheme()`) keeps
  working in Standard. Lagoon keeps its own turquoise on the till. Portals use
  the store's brand colour in both looks.
- Settings → Appearance gets a two-card picker with a live preview.

**Done when:**
- switching the look repaints every screen without a reload;
- `test/a11y.test.js` contrast passes in all four combinations;
- the waterline class (`.wl`) exists and is reduced-motion safe.

---

## 4. Phase 1 · the till, redesigned (≈ 3–4 weeks)

The order puts the signature first, then money, then kitchen, then the
platform pieces.

| Slice | What | Main files | Done when |
|---|---|---|---|
| **1.1 Floor + waterline** | The floor layout (tables lead, "Now" column), and the waterline filling against the wait target. The target is a new store setting (kitchen already has `kdsSla`). Standard shows the same fill as a thin progress bar. | `app/index.html` floor gens, `kashikeyo.css` | The longest wait is visible from 3 m in both looks; the fill is computed from `opened_at` against the target and unit-tested |
| **1.2 Order + options side panel** | Menu grid + live ticket. Dish options replace the grid instead of opening a modal. A required choice shows orange and blocks Send with a reason ("Send · 1 to finish"). 48 px targets. | order gens, options modal → panel | Scenario I in `SPEC.md` passes; no modal on tablet |
| **1.3 Pay + paid moment** | The large amount-due figure, tenders, and cash pad. The paid screen shows the change at display size with the receipt beside it. | pay modal (`kind: "pay"`) | Receipt rows equal screen rows (existing pin); the change counts up, and with reduced motion it doesn't |
| **1.4 Split by item** | Drag a line onto a guest, or tap then tap. Shared lines divide evenly. The rounding rule: shares sum to the bill exactly, with leftover laari on the first unpaid share. Each share is its own payment record. | pay/split, `kashikeyo-bill.js`, `src/apply.js` | Scenario F: 269.24 ÷ 3 = 89.75 + 89.75 + 89.74; refunding one share leaves the others paid; journals balance |
| **1.5 Kitchen display** | Green for new, amber from half the target, coral past it with a slow pulse. Thresholds per station. Bump keys 1–9 printed on the buttons. | KDS gens, keydown handler | Scenario J (overdue tells apart from new in greyscale at 3 m); a USB bump bar bumps the right ticket |
| **1.6 Live updates (SSE)** | `GET /api/outlet/:id/sync/stream` sends "changed, lamport N" and wakes the existing `pull()`. The 5 s poll stays as the fallback. | `src/routes/sync.js`, `app/kashikeyo-api.js` | Scenario A: a line reaches the KDS within 1 s p95 on the live install; survives Railway's proxy; reconnects |
| **1.7 Offline receipt numbers** | Offline sales print a device-prefixed provisional number (e.g. `HLC-T2-000118`), and the server keeps it instead of issuing a second one. **Needs the accountant's OK on the format first.** | `src/apply.js`, `chain.doc_series`, till receipt | Scenario C: two tills offline never share a number; the server never renumbers a printed receipt |
| **1.8 One offline pill** | "Online · all sent" / "Offline · N waiting · printing here". No spinner anywhere because of the network. | top bar, all shells | A sweep with the network off finds no spinner or disabled Pay |
| **1.9 Waiter phone** | Floor, order, ticket, options (bottom sheet) and pay on 390 px, in both looks. | phone shells in `app/index.html` | Can be used one-handed; nothing on the phone is under 48 px |
| **1.10 Guest + member portals** | Both portals in both looks. They take the store's brand colour. Lagoon's cover photo ends in a wave; points show as water rising to the next tier. | `app/guest.html`, `app/member.html` | `test/responsive.test.js` passes; a white-label store shows no Kashikeyo colour |
| **1.11 Back office pass** | Tokens and targets only, no layout changes: stock, purchasing, people, reports, settings. | back-office gens | Every rail screen renders in all four combinations without layout breaks |

**Alongside phase 1:** the S3 backup live check (a 10-minute run on the live
install), and the SVG parse noise in the portals.

---

## 5. Phase 2 · devices working as one (≈ 4–6 weeks)

| Slice | What | Done when |
|---|---|---|
| **2.1 Draft lines + handoff** | Unsent lines sync as draft lines (author and device). Another device shows "Picked up from Aisha's phone". Drafts are never printed, fired or charged. | Scenario B: the lines are on the till within 1 s; sending fires them once; replaying the phone's outbox duplicates nothing |
| **2.2 Per-ticket versions** | A `version` on each ticket. A scalar edit against an old version is refused, and the device shows "Changed on the till: covers are now 4". | Scenario G passes |
| **2.3 Web Push alerts** | Order ready, bill asked, QR order to accept, sold out, manager call. Sent only to the right person, with one action each. They reach the watch through the phone. | An alert arrives on a locked Android phone and an iPhone (home-screen app); the action works |
| **2.4 Camera scan** | `BarcodeDetector`, with a small decoder fallback for Safari. Scans member cards and the guest QR. | A member card scans on an iPad and an Android phone |
| **2.5a Hub pass-through** | `server.js` in hub mode (`HUB_UPSTREAM`): proxies `/api/*` (SSE included) to the cloud with each device's own token, serves `app/`, keeps the print relay local. `GET /api/hub` says which mode; Printers and Sync & devices show it. | A till pointed at the hub trades exactly as against the cloud; a network printer prints through the hub |
| **2.5b Held, not applied** | WAN down: the hub answers a push "held" and keeps a copy. The device keeps its outbox until the cloud acknowledges. | Scenario C: unplug the WAN, ring bills, plug it back; every op lands once, numbered by the cloud |
| **2.5c Kitchen fold** | Held ops go to an append-only JSONL file (dedup by `opId`). A fold over held lines, fires, bumps and voids feeds the KDS pull during an outage. | With the WAN unplugged, an order fired on a tablet reaches the KDS through the hub |
| **2.5d LAN HTTPS** *(owner-owed)* | A hub name on `kashikeyopos.com` pointing at a private IP, DNS-01 certificate, LAN DNS entry. See SPEC §9. | The PWA installs and works offline from the hub's address |

**Alongside phase 2:** the accessibility sweep of every modal and a screen
reader pass; batch draw-down (FEFO allocation); a third server route for the
two dead model features, or removing them.

---

## 6. Phase 3 · on demand

Voice ordering (the orange-line correction screen is already designed), NFC
tap-to-pay (needs a bank's SDK), a native watch app, and a rota with lateness.
Each starts only when a pilot store asks for it.

---

## 7. Decisions (25 Sep 2026)

1. **Offline receipt numbers:** they carry the till's code (`HLC-T2-000118`).
   Tell the accountant before 1.7 ships.
2. **Default look for new stores:** Lagoon. Standard is one setting away.
3. **Pilot store for phase 2:** Seaside Holdings.
4. **Dhivehi:** stays open until a pilot store asks for it.
