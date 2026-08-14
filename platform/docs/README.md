# KashikeyoPOS — production build handoff

A multi-outlet restaurant operating platform for the Maldives: point of sale,
kitchen display, inventory and real-time costing, procurement, accounting,
loyalty, and two guest-facing portals. Currency is MVR. Tax is GGST/TGST per
outlet, MIRA-ready.

This bundle is what a developer needs to build the production system without
guessing. Read this file, then `08-BUILD-STAGES.md`, then start.

---

## What is in this bundle

| Path | What it is |
|---|---|
| `README.md` | This file. Start here. |
| `01-DESIGN-TOKENS.md` | Every colour, font, size, radius and motion value, as literals. |
| `02-POS-SPEC.md` | The till and back office: 30 modules, screen by screen. |
| `03-GUEST-PORTAL-SPEC.md` | The QR table-side ordering portal. |
| `04-MEMBER-PORTAL-SPEC.md` | The loyalty and member bill portal. |
| `05-DATA-MODEL.md` | Tables, columns, invariants, and the chain of consequence. |
| `06-API-CONTRACT.md` | Every endpoint, request and response shape. |
| `07-SECURITY-RLS.md` | Tenancy, per-outlet roles, RLS policies, the leak test. |
| `08-BUILD-STAGES.md` | The three stages, with acceptance criteria per stage. |
| `09-TEST-PLAN.md` | What must be tested and the invariants that must hold. |
| `10-NO-DEMO-DATA.md` | How the system gets its data. Non-negotiable rules. |
| `11-OWNER-DASHBOARD-SPEC.md` | The rank-5 estate view, inside the POS. |
| `screenshots/` | The prototypes as they render. |
| `standalone/` | Each app as one self-contained HTML file — no server, opens offline. |
| `CLAUDE.md` | Drop this at the root of the new repo. |
| `design/` | The working HTML prototypes — the visual and behavioural reference. |
| `backend/` | The Railway service, schema, RLS and provisioning, already written. |

## About the design files

`design/` holds **working HTML prototypes**, not production code to copy. They
are Design Components: a single `.dc.html` per app, inline-styled, driven by a
logic class. They run in a browser and every interaction in them works — that is
deliberate, so behaviour is demonstrated rather than described.

Your job is to **recreate them in a real stack**, not to ship them. The
recommended stack is in `08-BUILD-STAGES.md` (React + TypeScript + Vite on the
front, the Express/Postgres service in `backend/` on Railway). Read the
prototype when a spec is ambiguous: it is the tiebreaker.

**Fidelity: high.** Colours, type, spacing and interactions in the prototypes are
final. Build them pixel-accurate. Where this bundle gives a hex or a pixel value,
use that exact value — do not substitute a framework default or a "close enough"
token from a component library.

## The governing principle

Every sale flows all the way from
**customer order → kitchen → payment → tax → inventory → COGS → accounting →
reconciliation → business intelligence.**

Four consequences, and they are the acceptance criteria for the whole system:

1. **No screen is a dead end.** If an action creates a financial or stock
   consequence, the UI shows where that consequence landed and lets the user
   reach it.
2. **Nothing is entered twice.** A figure captured once — a price, a receipt, a
   count — travels the chain. A screen that re-asks for it is a defect.
3. **Every link is attributable** to a person, a rank, a timestamp and a device.
   That is what makes it auditable to MIRA.
4. **Offline is the normal case.** The chain completes locally and reconciles on
   replay. A replay never overwrites a closed ticket.

## The rules that are not negotiable

- **No demo data, ever.** Not a seeded menu, not a fabricated sales figure, not a
  placeholder outlet. See `10-NO-DEMO-DATA.md`. An empty system shows an empty
  state and a route to fill it.
- **No hardcoded configuration.** Tax rates, service charge, currency, table
  counts, station names, account codes, tier thresholds, point rates — all come
  from the database, per outlet.
- **One rank ladder.** Kitchen 1, Till 2, Manager 3, Admin 4, Owner 5. Gate on
  rank through `canApprove()` / `canReceive()`. Never gate on a name or a job
  title string.
- **The phone never takes money.** Guest devices post intent; the till settles.
- **Costing is real-time.** A dish that sells moves its ingredients and its COGS
  at the moment of sale, not in a nightly batch.

## How to read the prototypes

Open `design/*.dc.html` in a browser. `support.js` must sit beside them.

- `KashikeyoPOS Guest Theme v3.dc.html` — the till and all 30 back-office
  modules. Sign in with any staff PIN shown on the lock screen.
- `KashikeyoGuest QR v3.dc.html` — the guest phone. Open it in a second tab
  alongside the POS; the two talk to each other through the browser.
- `KashikeyoMember Portal.dc.html` — the loyalty portal, same pairing.
- `KashikeyoOps Deploy Readiness.dc.html` — the hosting and isolation model.

**Or open `standalone/` instead.** Those are the same three apps compiled into
single self-contained files — no `support.js`, no server, no build step. Double
click and they run offline, which is the quickest way to see the behaviour the
specs describe.

The owner's screen is **inside the POS** (rail: Owner → Owner Dashboard, rank 5
only) rather than a separate portal — see `11-OWNER-DASHBOARD-SPEC.md`.

The prototypes share state through `localStorage` because they have no server.
In production that seam is the API; `design/kashikeyo-api.js` is the client that
replaces it, and its method names match what the prototypes call.
