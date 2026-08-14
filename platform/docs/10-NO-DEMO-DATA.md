# No demo data. No hardcoded configuration.

The prototypes in `design/` generate a plausible service so the interactions can
be demonstrated in a browser with no server. **None of that survives into
production.** The seeding functions, the fabricated day, the sample outlets and
the invented figures exist to make a prototype demonstrable and are to be
deleted, not ported.

---

## The rules

1. **A figure on screen traces to a row.** If you cannot click from a number to
   the record that produced it, the number should not be rendered.
2. **No fallback literals.** `price ?? 45`, `taxRate || 8`, `name || "Outlet"`
   are all defects. Missing configuration is an error state with a route to fix
   it, not a plausible-looking default.
3. **No sample content in any bundle.** No demo menu, no "Acme Restaurant", no
   Lorem, no placeholder avatars, no example customers.
4. **Empty is a first-class state.** Every list, chart and report renders an
   empty state saying what lands here, what creates it, and a button that starts
   that. Never "No data", never a spinner that resolves to nothing, never a
   chart with invented axes.
5. **Configuration lives in the database, per outlet.** Tax code and rate,
   service charge, currency, rounding increment, table count and names, zones,
   stations and their targets, account codes, expense categories, point earn
   rate, tier thresholds, reward costs, discount caps by rank, PIN policy,
   printer targets. None of these are constants in the source.
6. **Tax is versioned by effective date.** Reading "the current rate" for a
   historical sale is a defect: the rate is on the sale row.

---

## How the system actually gets its data

### Onboarding (Stage 1, first-run)

A wizard, gated at rank 5, that cannot be skipped and creates real records:

1. **Chain** — name, base currency (MVR), financial year start.
2. **Outlet** — name, code, timezone, tax code (GGST/TGST) with rate and
   effective date, service charge %, rounding increment, table count or a floor
   plan drawn by the user, zones.
3. **People** — at least one rank 5 and one rank 2, each with a PIN.
4. **Chart of accounts** — seeded from the standard chart
   (`chain.seed_chart`), then editable. This is the one seeded thing, because
   an accounting standard is not demo data; it is a template the user amends.
5. **Menu** — entered by hand, or imported (see below).
6. **Ingredients and recipes** — entered or imported. A dish without a recipe
   sells and reports zero COGS with a visible warning until costed.

Until step 3 is complete the till refuses to sell, and says why.

### Import

CSV/XLSX import for menu items, ingredients, recipes, suppliers, opening stock
and opening balances. Each import: preview, per-row validation, an explicit
mapping step, and a receipt in the audit log naming who imported what and when.
Failed rows are downloadable with reasons — never partially applied silently.

### Opening balances

An outlet that existed before the system has a real opening position. Capture it
as a dated opening journal, so the trial balance is right from day one and the
first month's P&L is not nonsense.

---

## Enforcing it in CI

Add a lint rule and a build check:

- Grep the production bundle for known prototype markers (`seed(`,
  `ensureTradingDay`, `rng(`, sample names, `Lorem`). Any hit fails the build.
- Fail on numeric literals in the pricing, tax and costing modules outside a
  configuration read — allow-list the genuinely constant (0, 1, 100, 2 for
  decimal places).
- A test that boots the app against an **empty provisioned outlet** and asserts:
  no screen crashes, every module shows an empty state, and no figure other than
  zero appears anywhere.

That last test is the real guard. If the app looks right with nothing in it, it
has no demo data in it.
