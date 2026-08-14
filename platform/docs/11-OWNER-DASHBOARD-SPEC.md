# Owner Dashboard — screen spec

Reference: `design/KashikeyoPOS Guest Theme v3.dc.html`, view `owner`
(`ownerVals()` in the logic class). Screenshots 02–04.

**It is a view inside the POS, not a separate application.** An owner signs in
to the same terminal with the same PIN and lands here; there is one identity
model, one session, one audit trail. Building it as a second portal would mean a
second login, a second deploy and two places for a figure to disagree with
itself.

---

## 1. Access

- Visible only at **rank 5** (SuperAdmin, ChainAdmin).
- The gate is not a module permission. `can("owner")` returns
  `this.rank() >= 5` — no module grant opens it and no module grant closes it.
- It is the **first item in the rail**, in its own "Owner" group, and
  `signIn()` asks for it first: a rank 5 sign-in lands on the estate rather than
  on a till they are not going to work.
- If rank drops below 5 while the view is open, the app returns to the site's
  home screen on the next render.

## 2. Data

Everything comes from `analyticsData()` — the same single derivation the CFO
briefing uses. One derivation means the owner and the accountant can never be
shown two different numbers for the same thing.

**The day being shown.** An owner opens this before service. If today has not
traded, the screen falls back to the last business date that did and says so in
the briefing chip — never silently. Sales-side figures are re-derived for that
day by `estateFor(dateKey)`, which uses the same reducers as `outletDay()`.
Standing costs (labour from clock punches, overheads, depreciation) are day
figures and carry across.

## 3. Layout

Same shell, same tokens as the rest of the POS (see `01-DESIGN-TOKENS.md` §1).
Cards are `--bg-1` on `1px solid --line`, 13px radius. Figures are JetBrains
Mono. Nothing on this screen writes: every control navigates.

| Breakpoint | Behaviour |
|---|---|
| Desktop ≥1180px | KPIs `auto-fit minmax(168px,1fr)`; trend + estate side by side (1fr / 1.15fr); P&L + cash and decisions + controls in 2 columns |
| Tablet 760–1179px | KPIs `auto-fit minmax(150px,1fr)`; every pair stacks to one column |
| Phone <760px | KPIs 2-up (`repeat(2,minmax(0,1fr))`); everything single column; the estate table drops its Share column and floors at 268px; P&L labels shorten to one word each and never wrap; the day is written short (`Thu 13 Aug`); padding drops to 12/11px |

### 3.1 Briefing band

Score chip (74px, `--bg-2`) + one sentence of headline and one of context.
Health is 0–100, computed by deduction: 3 points per point of food cost over
target, 2 per point of labour over 30%, 1.5 per point of prime over 65%, 6 per
silent site, 8 per sync conflict, 5 per asset down, 3 per overdue house account.
**With no revenue it shows an em dash, not a score** — a day that has not
happened is not a judgement.

### 3.2 The six figures

Net sales · Covers · Food cost · Labour · Prime cost · Profit. Each carries a
delta and a one-line explanation of what it is measured against. Food, labour
and prime turn `--red-bright` when over target, `--go-bright` when inside.

### 3.3 Fourteen days

Real daily series from `ownerSeries()` — each bar is the sum of that day's
closed sales, ending on the day being shown, last bar in `--amber`. No
smoothing, no synthetic history. Growth is last 7 against the previous 7, and
is **suppressed entirely when either week has no trading** — a percentage
against zero is not a percentage. When fewer than two of the fourteen days have
traded, the plot is replaced by a sentence saying so: thirteen empty columns
carry less information than the sentence does.

### 3.4 The estate

One row per trading outlet: name with a status dot, sales, share, covers, food
cost. Rows navigate to Chain Overview. Footer states the isolation rule: each
site's figures are computed inside that site's own books, and this table is the
sum — the only cross-outlet read the system performs, written to the audit trail
as a group-scope query.

### 3.5 P&L and money position

Revenue → cost of sales → **gross profit** → labour → **prime cost** →
overheads → **net profit**, each with its percentage of revenue, then a
four-segment bar (food / labour / overheads / profit).

Money position: cash in drawers, card awaiting settlement, house account, GST
collected and held for MIRA, service charge owed to staff, owed to suppliers.
The last three are money the business is holding on behalf of someone else and
are labelled as such.

### 3.6 Waiting on you

Only what a rank 5 must answer; anything a manager can clear is absent. Built
from live data, never a fixed list: silent sites (only flagged when others are
trading), sync conflicts, food cost over target with its MVR value, labour over
30%, equipment down, services overdue, house accounts at the limit. Each row
navigates to where it is resolved. Empty state says so plainly.

### 3.7 Controls, checked not claimed

Receipt series integrity (duplicate detection computed on the day's numbers),
writes waiting to reach the cloud, days to the GST return, outlet isolation,
sites reporting, waste against sales, and a verification line.

### 3.8 Deliberately not here

A closing panel naming what the screen cannot show: individual receipts, open
tickets or the floor, staff PINs, guest contact details, writes of any kind,
another outlet's rows. This is not decoration — it states the security model in
the place where someone might otherwise ask for those things to be added.

## 4. Production notes

- Server-side this view is `GET /api/estate/day` (`06-API-CONTRACT.md`), which
  is rank 5, read-only, aggregate-only and audited as group scope.
- Do not add a drill-through from this screen to another outlet's receipts. The
  isolation model in `07-SECURITY-RLS.md` makes that query impossible by design;
  a request for it is a request to weaken the model.
- The health score's weights belong in configuration, not in code.
