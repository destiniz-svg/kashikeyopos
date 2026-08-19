# POS and back office — screen spec

Reference prototype: `design/KashikeyoPOS Guest Theme v3.dc.html`.

The POS is one application with a persistent shell and 31 modules. It runs
full-screen on a terminal, a tablet and a phone. It is dark by default.

---

## 1. Shell

### 1.1 Layout

Desktop (≥1180px): a three-part frame.

```
┌────────┬──────────────────────────────────────────────┐
│  rail  │  topbar (outlet · clock · figures · actions) │
│ 208px  ├──────────────────────────────────────────────┤
│  or    │                                              │
│  56px  │  module body                                 │
│collapsed│                                             │
└────────┴──────────────────────────────────────────────┘
```

- **Rail** — `--bg-0`, 208px expanded / 56px collapsed, groups with ALL-CAPS
  headers (11px/700/.08em/`--text-faint`), items 13px with a 16px icon.
  Active item: `--bg-2` fill, `--amber-bright` icon and text.
  Foot: the signed-in identity chip — 28px circular `--bg-3` avatar with
  `--amber-bright` monospace initials, name 11px/600, rank beneath 9.5px.
- **Topbar** — outlet switcher, live clock (15px/600 JetBrains Mono over a
  9.5px date), the figure strip, and the command palette trigger.
- **Figure strip** — today's sales, covers, average, food cost %. Renders as
  full cards by default and collapses to a one-line ribbon on `pos` and `kds`
  where vertical space is the scarce resource. A manual toggle overrides for
  the session.

Tablet (760–1179px): rail collapses to icons; figure strip is a ribbon.

Phone (<760px): rail becomes a bottom bar with the five thumb-reachable
destinations (Floor, Orders, KDS, Today, More). The floor screen gains an
open-tables strip so the operator can see where they are without leaving the
menu.

**Height is a breakpoint too.** A 1440×600 window passes every width test as
desktop and still cannot show a keypad beside a bill. Anything that stacks or
scrolls consults `shortVp()` (`vh < 760`) as well as width.

### 1.2 Command palette

`Cmd/Ctrl+K`. Modal over a scrim, search input with a 16px magnifier and an
`ESC` chip (10px/700 monospace, 1px `--line` border, 5px radius). Results max
height `min(56dvh, 420px)`. Matches module names and verbs ("void", "open
register", "count stock"). Arrow keys move, Enter navigates.

### 1.3 Keyboard

The app owns keys only when focus is not in a field. `Cmd/Ctrl+K` palette,
`/` focuses the contextual search (the dish grid's search when the menu is up,
the outlet search otherwise — never a box the operator cannot see), `Esc` backs
out one level, digits drive the active keypad.

### 1.4 Lock and identity

A terminal with nobody signed in **is locked** — `requireSignIn()` puts up the
lock modal whenever `session` is null. Sign-in is by PIN against staff at this
outlet.

- 4 wrong attempts (`PIN_TRIES`) locks the till for 15 minutes
  (`PIN_HOLD_MIN`). The countdown is shown, not hidden.
- Signing out drops the acting role to the lowest (`LOCKED_ROLE`), so a
  permission check can never pass on a dead session.
- Signing in switches the acting identity: a shared till has one identity at a
  time, and it is the person — not the browser — that the audit log names.

### 1.5 Ranks

One ladder, five ranks: **Kitchen 1, Till 2, Manager 3, Admin 4, Owner 5**.
Every gate reads `canApprove(n)` / `canReceive()`. A module the current rank
cannot view is absent from the rail, not greyed.

### 1.6 Register guard

One gate every selling action passes through (`guardRegister()`), and it checks
in this order: **session first, register second.** A register left open by the
previous person is the normal state all shift, so checking the register first
makes the session test unreachable. Without an open register there is no float,
no expected cash and therefore no over/short — the single control every
cash-handling business is actually audited on.

---

## 2. Modules

31 modules in 10 groups. `id` is the route segment. Icons: copy the exact SVG
path data from `NAVDEF` in the prototype.

### Owner
| id | Name | What it does |
|---|---|---|
| `owner` | Owner Dashboard | The estate in aggregate, rank 5 only. First in the rail and the landing view for an owner sign-in. Full spec in `11-OWNER-DASHBOARD-SPEC.md`. |

### Start here
| id | Name | What it does |
|---|---|---|
| `today` | Today | The manager's morning screen: decisions waiting — unpriced deliveries, overdue suppliers, failed dockets, margin bleeders. Not a dashboard of numbers; a list of things to do, each linking to where it is done. |
| `start` | How this works | Orientation for a new operator. |

### Front of house
| id | Name | What it does |
|---|---|---|
| `pos` | POS Floor | The till. See §3. |
| `orders` | Orders & Tickets | Every ticket today, open and closed, with its receipt, tender, server and audit trail. |
| `kds` | Kitchen Display | See §4. |
| `reservations` | Reservations | Tonight's book, table assignment, arrival state. |
| `delivery` | Delivery & QR | Aggregator and QR channel orders, rider dispatch, stage tracking. |
| `customers` | Customers & Credit | Chain-wide profiles, loyalty tier, house-account credit ledger. |
| `promos` | Promotions & Banners | Codes, windows, caps. A promo the guest sees is a promo the till charges. |
| `loyalty` | Loyalty & Rewards | Earn rate, tier ladder, reward catalogue. Points are a liability (account 2200). |

### Menu & kitchen
| id | Name | What it does |
|---|---|---|
| `menu` | Menu Master | Chain price list with per-outlet overrides. One price, two surfaces. |
| `aimenu` | AI Menu Builder | Cost-engineered menu suggestions from the live item master. |
| `recipes` | Recipes & Costing | Ingredients, yield, sub-recipes, waste %, live plate cost and GP. |
| `production` | Production | Batch prep of sub-recipes; consumes ingredients, produces stock. |

### Stock
| id | Name | What it does |
|---|---|---|
| `inventory` | Inventory | On-hand, par, value, by sub-location. |
| `counts` | Stock Counts | Count sheets by category; variance in units and MVR; approval above a threshold. |
| `ledger` | Stock Ledger | Every movement with its reason and source document. |
| `batches` | Batches & Expiry | Lot tracking and expiry alerts. |

### Purchasing
| id | Name | What it does |
|---|---|---|
| `requests` | Indent Requests | A kitchen asks; a manager approves. |
| `purchases` | Purchases / GRN | PO → delivery → priced GRN → vendor invoice → ageing. |
| `dispatches` | Dispatches | Inter-outlet transfers, both sides of the move. |
| `vendors` | Vendors | Supplier master, terms, price history. |

### People
| id | Name | What it does |
|---|---|---|
| `staff` | Staff & Time Clock | Roster, clock in/out, rank assignment. |
| `payroll` | Payroll & Pension | Runs, pension, posts to 6000/2300. |

### Finance
| id | Name | What it does |
|---|---|---|
| `analytics` | Analytics & CFO | Prime cost, margin by dish, trend. |
| `reports` | Reports & Exports | Z-read, tax return, P&L, trial balance, MIRA exports. |
| `accounting` | Accounting Flow | The ledger itself: journals, trial balance, P&L. |
| `costs` | Operating Costs | 16 expense categories, overhead allocation, recurring costs. |
| `assets` | Equipment & Maintenance | Asset register, depreciation posting, service schedule. |

### Chain
| id | Name | What it does |
|---|---|---|
| `chain` | Chain Overview | Consolidated across trading outlets. Aggregates only — see `07-SECURITY-RLS.md`. |
| `branches` | Outlets | Locations, tax profiles, printers, stock sub-locations. |
| `users` | Users & Roles | Rank assignment; never above the assigner's own rank. |
| `logs` | Audit Log | Append-only, filterable, exportable. |

### Platform
| id | Name | What it does |
|---|---|---|
| `sync` | Sync & Devices | Outbox state, device pairing, remote diagnostics. |
| `architecture` | Architecture | The system's own map. |
| `settings` | Settings | Theme, accent, printers, preferences. |

---

## 3. POS Floor

The selling screen. Three columns on desktop: **zones + tables** → **menu** →
**ticket**.

### 3.1 Floor plan

- Zone rail across the top: pill buttons with the zone name and a monospace
  count at 10px/opacity .55.
- Table tiles in a responsive grid. Each tile: 20px/700 monospace label
  (`T04`, or the operator's own name — "Cabana 1" reads that way on the KDS
  ticket, the parked strip and the printed bill, not just here), a status chip
  top-right, and covers + elapsed time beneath.
- Status: Free (`--bg-1`, `--line`), Seated (`--amber`), Ordered, Served,
  Bill requested, Overdue (`--red`). Age counts up from `openedAt` for as long
  as the terminal is open — it is derived from a timestamp, never a stored
  counter.
- Long-press or right-click a tile: move, merge, park, assign server.
- Two non-table slots always exist: **Takeaway** and **Delivery**.

### 3.2 Menu grid

Category rail with counts, then dish tiles: name, 10.5px description, 14px/700
monospace price, and an ALL-CAPS 9.5px foot (station or diet marker). Off-menu
dishes are visibly struck, not hidden — the kitchen took them off tonight and
the operator needs to know why the guest cannot have one.

Search box focused by `/`.

### 3.3 Ticket panel

- Line: 13.5px/600 name, 13.5px/700 monospace amount, then a stepper row —
  26×24px −/+ either side of a 12px/700 monospace qty, inside a 6px-radius
  `--bg-2` well.
- Modifiers and notes sit under the line at 11px `--text-muted`.
- Guests: every line belongs to a guest (`Guest 1`, or a named member). One
  model covers split bills **and** several parties sharing one table.
- Foot: subtotal, discount, service charge, tax, total. Then **Send** (to
  kitchen) and **Pay**.

### 3.4 Payment modal

- Tender row: Cash, Card, Wallet, Points, Foreign currency, Split.
- Keypad on the left, bill on the right (stacks under `shortVp()`).
- **Tendered** is 22px/700 monospace in `--warn-bright`; **change due** appears
  the moment tendered exceeds the total.
- Foreign currency: enter the amount in its own currency; the recorded rate and
  the MVR equivalent are shown before confirming, and both are stored.
- Cash rounding to MVR 0.50 is shown as its own line and posted to 6910.
- Discounts: reason required, cap enforced by rank on **every** path.
- On confirm, in one transaction: allocate the receipt number from the series,
  write the sale and its lines, write the payments, move the stock, post the
  journal, close the ticket, queue the print job.

### 3.5 Parked tickets

`HOLD-` + sequence. Row shows 13px/700 monospace ref, meta, total, and a
`Resume` pill (11px/700, `--on-amber` on `--amber`, 7px radius).

---

## 4. Kitchen Display

- Column per station, ticket cards in fire order.
- Card header: 15px/700 monospace table label, 10px meta, and a background tint
  that shifts to `--warn` then `--red` as the ticket passes its station target.
- Per-station targets come from configuration, not a constant.
- **All-day strip** across the top: chips of `{count} {dish}` with the count in
  800-weight `--warn-bright` monospace — what the kitchen actually needs to
  cook, aggregated across tickets.
- **Expo view**: one screen showing every ticket's readiness across stations.
- Stages: Received → In the kitchen → Ready → Served. Delivery adds "With the
  rider" before Delivered.
- A new display pairs by entering a code on the tablet; no config file.

---

## 5. State

The prototype persists to `localStorage` under a versioned key and migrates on
read. In production the same state lives in three tiers:

| Tier | Holds | Lifetime |
|---|---|---|
| Component state | modal, focus, keypad buffer, search text | the mount |
| Local cache (IndexedDB) | tickets, menu, ingredients, today's sales, outbox | the device |
| Server | everything, per outlet | forever |

**The UI reads the local cache, never the network directly.** A fetch updates
the cache; the cache notifies the UI. This is what makes offline the normal case
rather than a degraded mode.

Key state the shell owns: `session`, `rank`, `outletId`, `view`, `theme`,
`accent`, `register`, `tickets`, `activeTable`, `activeSplit`, `outbox`,
`online`, `now` (ticked every second — ages are derived, never stored).

### 5.1 Outbox

Every write queues with a locally generated `opId`, a Lamport counter for
ordering, and a state of `queued | sent | done | conflict`. The list is trimmed
to 90 entries, keeping all live ones and the tail of the settled, so an all-day
terminal never grows without bound. The pending count is always visible in the
topbar — a hidden queue is how sales get lost.

---

## 6. Empty states

Because there is no demo data, **every module must have a real empty state**
with: one sentence saying what lands here, one sentence saying what creates it,
and a button that starts that. Never a spinner that resolves to nothing, never
a table with fabricated rows, never "No data".
