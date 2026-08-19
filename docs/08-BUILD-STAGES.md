# Build stages

Three stages. Each one ends with something that can be **deployed and used** —
not a layer that only makes sense once the next layer lands.

The stages are deliberately **not** "one app each". The guest portal cannot
exist before the till holds tickets, and the member portal cannot settle points
before the ledger holds a liability. Value is delivered along the chain of
consequence, not by application boundary.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| API | Node 20 + Express + `pg` | Already written in `backend/`. No ORM: the isolation model depends on connecting as a specific role and setting transaction-local context, which ORMs fight. |
| Database | Postgres 16 on Railway | Schemas per outlet, RLS on the control plane. |
| Front end | React 18 + TypeScript + Vite | Three apps in one repo, one shared client and UI package. |
| Local cache | IndexedDB via `idb` | The UI reads the cache; the network is the mirror. `localStorage` is too small and synchronous for a day's tickets. |
| State | Zustand (or equivalent) + the cache as the source | No global fetch-on-render. |
| Styling | CSS custom properties + CSS modules | The tokens in `01-DESIGN-TOKENS.md` map 1:1 to properties. No utility framework: the POS palette is semantic, not a scale. |
| Tests | Vitest (unit), Playwright (e2e), `pg` integration tests against a real database | The invariants are database invariants; mocking them proves nothing. |
| Hosting | Railway: one API service, one Postgres, three static sites | `railway.json` and `DEPLOYMENT.md` are written. |

```
kashikeyo/
├── backend/                  ← already written; extend it
├── apps/
│   ├── pos/                  ← till + 30 back-office modules
│   ├── guest/                ← QR portal
│   └── member/               ← loyalty portal
├── packages/
│   ├── api-client/           ← port of kashikeyo-api.js, typed
│   ├── tokens/               ← the design tokens, one source
│   └── ui/                   ← shared primitives (money, stepper, sheet, empty state)
└── design/                   ← the HTML prototypes, for reference
```

---

## Stage 1 — The money chain, end to end

**Goal: one outlet can take a real order and the books are right.**

Ship:

1. **Provisioning and onboarding.** Migrations run; `provision:outlet` creates a
   real outlet. An onboarding flow captures outlet, tax profile, service charge,
   tables, staff and ranks — see `10-NO-DEMO-DATA.md`. No seeded anything.
2. **Auth**: PIN sign-in, rank ladder, lockout, session, device pairing.
3. **Menu master**: items, categories, prices, per-outlet overrides. Entered or
   imported by the user.
4. **POS Floor**: zones, tables, ticket, menu grid, guests, send, park, resume.
5. **Payment**: cash, card, foreign currency, split, discount with reason and
   rank cap, cash rounding.
6. **The transaction**: receipt number from the series, sale + lines + payments,
   journal posted and balanced, ticket closed, print job queued.
7. **Chart of accounts** and a trial balance that balances.
8. **Offline**: IndexedDB cache, outbox with `opId`, replay through
   `/sync/push`, visible pending count.
9. **Audit**: every action attributed to person, rank, timestamp, device.

**Acceptance criteria**

- A cashier signs in, opens the register with a float, sells, takes cash, and
  the drawer reconciles at close with a real over/short figure.
- The trial balance balances after 50 sales, verified by query, not by eye.
- Pull the network cable mid-service: selling continues, and on reconnect every
  sale appears exactly once. Replay the same outbox twice: still once.
- Two terminals selling simultaneously never mint the same receipt number.
- `npm run leak-test -- 3 4` passes with two provisioned outlets.
- Zero fabricated rows anywhere in the build (CI check, §`10`).

---

## Stage 2 — Kitchen, stock, cost, and the guest's phone

**Goal: what sells moves stock and cost in real time, and the guest can order.**

Ship:

10. **Recipes & costing**: ingredients, yield, sub-recipes, waste %, live plate
    cost and GP. Sale posts `stock_move` and COGS at the moment of sale.
11. **Inventory, counts, ledger, batches**: on-hand, par, variance in units and
    MVR, theoretical vs actual consumption, approval above a threshold.
12. **Purchasing**: indent → PO → delivery → priced GRN → vendor invoice →
    ageing. A price captured on a GRN updates the ingredient's average cost and
    therefore every dish that uses it.
13. **KDS**: stations, per-station targets, all-day strip, expo view, stage
    transitions, pairing by code.
14. **Guest QR portal** (`03-GUEST-PORTAL-SPEC.md`): menu with recipe-derived
    allergen and diet filters, cart, rounds, tracker, live bill, split four ways,
    tip, ask-to-pay, call a server, rate after.
15. **Delivery & QR module** on the till: accept, reject, dispatch, track.
16. **Promotions**: codes with windows and caps, honoured identically on the
    phone and the till.

**Acceptance criteria**

- Selling a dish reduces exactly the ingredients its recipe (and sub-recipes)
  specify, net of waste %, divided by yield.
- `ingredient.on_hand` equals the sum of its stock moves, for every ingredient,
  after a full day.
- A guest orders from a phone, the till accepts it, the kitchen sees it, the
  guest's tracker follows it, and the bill on the phone matches the till to the
  laari.
- A recipe change updates the guest's allergen filter within one snapshot poll.
- A promo quoted on the phone is charged by the till, or refused with a reason —
  never quoted and then silently dropped.

---

## Stage 3 — Close the books, the member, and the estate

**Goal: the month closes, the loyalty scheme settles, and an owner sees the
group without seeing anyone's rows.**

Ship:

17. **Settlement reconciliation**: acquirer batches matched to payments, fees to
    6180, variance surfaced.
18. **Operating costs**: all 16 expense categories, recurring costs, overhead
    allocation.
19. **Payroll & pension**: runs posting to 6000 / 2300.
20. **Assets & depreciation**: register, schedule, monthly posting to 6300/1510.
21. **Credit notes**: numbered documents against a sale, with approval.
22. **Accounting module**: journals, trial balance, **P&L**, tax return, MIRA
    exports.
23. **Member portal** (`04-MEMBER-PORTAL-SPEC.md`): OTP sign-in, member card,
    bill, points as tender against liability 2200, real visit history, rewards.
24. **Loyalty module** on the till: earn rate, tiers, catalogue.
25. **Chain overview and estate reporting** via `chain.estate_day()`.
26. **Today screen**: the manager's morning list of decisions waiting.
27. **Analytics/CFO**: prime cost, margin by dish, variance trend, bleeders.
28. **Sync & devices**: remote diagnostics, device management.
29. **Reports & exports**, **audit log** UI, **settings**.

**Acceptance criteria**

- A full month closes: P&L, trial balance and tax return agree with each other
  and with the sum of the day's Z-reads.
- Prime cost and net margin are computed from posted journals, not from a
  parallel calculation.
- A member earns at one outlet and redeems at another; the liability moves and
  the P&L never sees a point.
- An owner opens the estate view; the audit log shows a group-scope read; no
  request in the trace returned another outlet's rows.
- Restore drill: `pg_dump -n outlet_3` restores one outlet without touching the
  others.

---

## Order of work inside a stage

Database → API → client → UI, per feature, not per layer. A feature is done when
its consequence is visible in the accounts, not when its screen renders.
