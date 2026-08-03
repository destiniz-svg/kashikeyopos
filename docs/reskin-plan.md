# Template adoption — implementation plan

Goal, in the user's words: *"prototype template implemented to staging, keeping
those terms we used for non-accountants. Keep all the features in staging.
Don't degrade staging features while promoting to this template."*

So this is a **re-skin under a no-regression contract**, not a rebuild. Phase 1
(tokens, palette, fonts) is already on staging at `a1675b4`. Read `STACK.md` and
`reskin-inventory.md` first.

---

## Council

**A — Offline/Sync architect.** The re-skin never touches `/api`, the outbox or
`rowver`, so my exposure is indirect but real: the sync status pill, the
queued-ops badge, the offline banner and the conflict path are *UI surfaces of
sync state*. If a screen is rewritten and the pill quietly stops binding, the
till looks online while the outbox backs up. **My demand: the handler census
(guard 3) must cover the connectivity indicator on every screen that shows one,
and the service worker's PRECACHE must be re-verified whenever an asset name
changes.** We already shipped one outage caused by two safe changes meeting.

**B — CPA / financial auditor.** Every figure on screen comes from `totals()`
or `orderBreakdown()`. A re-skin must not retype a single number. My red line:
**no arithmetic moves into a template.** If a panel needs a subtotal it reads
`.L` — it does not recompute. The invariant `subtotal − discount + service +
GST = total` gets a test that runs on every phase, not just at the end. The
prototype's own ticket adds GST *on top*; if that layout is copied literally we
ship a tax bug. **My demand: the money test is a phase gate, and the prototype's
figures are never copied, only its layout.**

**C — VP restaurant operations.** The vocabulary is the product. Staff who are
not accountants use this at speed, and "Cost of goods" beating "COGS" is not
decoration — it is why the thing gets used correctly. The prototype's labels are
*also* plain ("Change due", "Tendered", "Name on the bill"), so there is no
conflict of philosophy — but there is a conflict of **strings**, and the merge
will silently prefer whichever was typed last. **My demand: take the prototype's
layout and keep our strings, enforced mechanically by the string census (guard
1), not by reviewer attention.**

**D — UX / ergonomics.** The contrast floor and 44px touch targets were audit
findings; a restyle is exactly how they get lost. The prototype specifies 9px
micro-labels and 7px nav padding — legitimate for a desk dashboard, wrong for a
counter tablet with wet hands. **My demand: prototype type scale is adopted, but
the ≥44px hit area and the contrast floor override it wherever they collide. And
Dhivehi/RTL — now measured as register-only, 260 keys — is a gate, not a
checklist item.**

**Integrator.** All four demands are mechanical, so make them mechanical. The
plan below is built around a **census harness** first and screens second,
because the failure mode here is not "it looks wrong" — that is visible and
cheap. It is "a button stopped existing and nobody noticed for three weeks."

---

## The one architectural decision

**Primitives are CSS classes, not components.** There is no build step and no
component layer; both front-ends are one HTML file with inline `style`
attributes. The handoff's Phase 2 ("build 22 primitives in your component
library, 2–3 days") does not apply to us.

Instead, add ~22 `.k-*` classes to the shared token block that Phase 1 already
created. Then a screen migrates by **replacing an inline `style` with a class**.
That is mechanical, reviewable, reversible, and it collapses the 517 remaining
colour literals into ~22 definitions. It is also the only version of this that
is *quick*.

```
<div style="background:var(--card);border:1px solid var(--line);border-radius:16px;…">
<div class="k-card">
```

---

## Guards — the no-degradation contract

Built **before** any screen changes. Each is a script that runs on both files
and fails loudly.

| # | Guard | Catches | Threshold |
|---|---|---|---|
| 1 | **String census** — extract every user-visible literal per screen, diff before/after | A dropped label, a reworded term, prototype vocabulary leaking in | Diff must be empty except an explicit allow-list |
| 2 | **Dhivehi census** — `dv` key count + Thaana character count | Translation regression | `index.html` ≥ 260 keys, ≥ 8,341 Thaana chars |
| 3 | **Handler census** — count `onClick`/`onChange`/`onInput` bindings per screen | A dropped button = a dropped feature | Count must not fall |
| 4 | **Structure** — `node --check` largest script + `sc-if`/`sc-for` balance | Silent blank screen | Already standard; now enforced per phase |
| 5 | **Money invariant** — `subtotal − discount + service + GST = total`, guest quote == till charge | B's red line | Test, every phase |
| 6 | **Literal count** — hardcoded hex per file | Progress toward the design's own "zero literals" rule | 394 / 123 → 0, monotonically down |

### Built — `npm run guards`

`tools/census.js` (guards 1–4, 6) + `test/money.test.js` (guard 5).
`--check` gates; `--update` re-baselines; `ALLOW_REMOVED` in the script is the
audit trail for every deliberate wording change. Baseline committed at
`tools/census-baseline.json`.

Every guard was **verified by deliberately breaking what it claims to catch** —
a guard that cannot fail is theatre. Two of them couldn't, and were fixed:

- **The handler count never fired.** `onClick` → `onClickX` still matched the
  substring, so a detached handler read green. Word-bounded now.
- **The string census was unstable** — one dropped Dhivehi string reported 37
  removals. The literal regex capped the body at 90 characters, so any longer
  string failed to match, the scanner resumed *inside* it, and every quote after
  that point paired up wrongly; editing one string re-shuffled the mis-pairing.
  Matching a complete JS string literal with no length bound fixed it (and
  recovered 303 strings that were being lost).
- **The money invariant alone could not catch a bad line calculation.** Every
  figure derives from `lineIncl`, so a wrong `lineIncl` still balances against
  itself — the same tautology the day-end journal had. Independent hand-computed
  oracles were added; they catch it, the invariant does not.

Baseline: **987 + 718 strings, 260 dv keys / 8,341 Thaana, 389 onClick,
399 + 123 literals.**

---

## Phases

Sized in work sessions, not days. Each ends green on all six guards, commits to
`staging`, and is verifiable on the staging URL before the next starts.

| # | Phase | Scope | Sessions |
|---|---|---|---|
| **2** | **Census harness** | Guards 1–3 as scripts + baseline snapshot committed | 1 |
| **3** | **Primitives** | ~22 `.k-*` classes: shell, sidebar, nav item, topbar, select, search, status pill, stat strip, table tile, menu card, tab pill, action button, data table, record card, info card, note panel, modal/sheet, toast, receipt, chip, badge, brand mark | 1 |
| **4** | **Shell** | Sidebar + topbar to spec on both surfaces. Admin is already close; the register moves from top-nav to the sidebar shell. Mobile drawer, tablet icon rail | 1 |
| **5** | **Register + floor** | The money screens: register, floor, ticket panel, payment drawer, KDS. Highest risk — guard 5 gates it | 2 |
| **6** | **Back office** | 16 cockpit sections, batched 4 per session, in ascending risk: config/staff → inventory/procurement → sales/customers → reports/receivables | 4 |
| **7** | **Guest portal** | ~~Mostly inherited from 5~~ — **wrong, see below**. Parity guard done; the re-skin itself is not | 1 → **2 more** |
| **8** | **QA** | Done — see below. Promote to `main` awaits sign-off | 1 |

**~11 sessions.** The handoff estimated 15–24 days for the equivalent; most of
the saving is Phase 3 (classes, not a component library) and the fact that 21 of
27 screens already have working data behind them.

## Phase 7 — the guest portal was a second palette. Now it isn't.

The plan assumed the portal was "mostly inherited" because it runs the same
`index.html`. True of the *file*, false of the *styling*: the guest markup
carried **181 hardcoded literals** forming a complete warm-café skin that
rendered light with terracotta accents whatever the theme.

Decision taken: **apply the prototype design**. The portal now uses the same
token set as the till and the cockpit.

**How, since the value never says background-or-text:** classify by the CSS
property each literal sits on. `color:#8A7B65` is text, `background:#8A7B65`
is a surface — the property is decisive where the value is not. Measured
first, then mapped:

| literal | dominant role | → |
|---|---|---|
| `#8A7B65` ×50 | `color` ×46 | `--ink2` |
| `#2E2418` ×35 | `color` ×25 | `--ink` |
| `#C1492A` ×26 | `color` ×12, `background` ×8 | `--coral` |
| `#ECE2D2` ×17 | `border` ×14 | `--line` |
| `#C9BFA6` ×9 | `border-*` ×9 | `--line` |
| `#FFF`/`#FFFFFF` ×20 | `background` | `--sur` |

The accent-picker presets (`ACC`) were fenced off — those hexes are data, the
white-label palette an operator chooses from, not styling.

**It took three rounds, and each round was found by rendering.** Mapping the
text without the surfaces left 28 light-on-white nodes; tokenising the white
grounds left 5; the last was a chip avatar on a stray `#F4EEE3`. Final audit
at 390px and 1200px: **0 low-contrast text, 0 sub-44px targets, no overflow,
no page errors.**

## Phase 8 — QA result

`npm run guards` clean. **58/58** money + guest-parity assertions. Census: 987
+ 720 strings, 260 dv keys / 8,341 Thaana, no handler lost.

Browser sweep — **0 problems across 7 configurations** (three surfaces × phone
/ tablet / desktop, plus RTL): no sub-44px targets, no low-contrast text, no
horizontal overflow, no page errors. All 18 cockpit sections still 0/18. Till
still sells: 87.96 + 7.04 = 95.00.

**Dhivehi/RTL verified by looking, not counting.** Switched through the app's
own control: `dir=rtl`, `lang=dv`, **979 Thaana characters** rendered, layout
fully mirrored, amber accents intact.

### The QA harness lied twice before it told the truth

Worth recording, because both failures are the kind that produce confident
wrong answers:

- **Flipping `data-dark` on `<html>` reported 45 contrast failures on the till
  that do not exist.** The theme lives in component state, and `accentVars()`
  injects `--coral` inline from that state. Removing the attribute left the
  DARK accent on a LIGHT token set. Driven through the app's own toggle,
  token and inline agree in all three themes — dark `#f2a43a`/`#f2a43a`,
  light and white `#9b6215`/`#9b6215`. **Never set the theme attribute
  directly to test theming.**
- **Gradient backdrops read as contrast failures.** `getComputedStyle` gives
  no sampleable colour for a gradient, so the walk-up found some distant
  ancestor and scored "Charge" at 1.05. Gradients are now an unmeasurable
  stop, not a failure.

One real finding came out of it: the cockpit's "Open register app" link was
187×35. Now 44px.

### Known and unchanged

- The customer portal has **no user-facing theme switch** — it renders in the
  component default (dark). A guest cannot choose light.
- Neither side can express a **GST-exempt store**: `gstBp: 0` falls through to
  the 8% sector default on the till and to `|| 800` on the server. They agree,
  so it is not drift, but a zero-rated store cannot be configured.
- Parts of the till's account sheet are still English under Dhivehi.
  Pre-existing; the census proves no dv key was lost.

## Sequencing rule

Never restyle a screen and change its behaviour in the same commit. The
non-overlapping features from `reskin-inventory.md` (per-guest tickets, blind
count, per-outlet price override, AI item generator, sync/devices screen) land
**after** their screen is restyled and green, as their own commits. That way a
regression is always attributable to one or the other.

## Explicitly out of scope

Schema, RLS, auth, tax calculation, rounding, receipt numbering, journal
posting, the sync protocol, the audit trail. A 5-member audit closed every
finding against these and they are in production. **If a design appears to need
one of them, stop and raise it.**
