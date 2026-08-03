# STACK.md — what the re-skin is landing on

Phase 0 deliverable for the KashikeyoPOS design handoff. Written from the code,
not from assumption. Read `docs/reskin-inventory.md` next for the screen map.

## The headline: the handoff's core premise is wrong in our favour

`README.md` in the handoff says the prototype "runs on a bespoke prototyping
runtime … that does not exist in your codebase and should not be introduced to
it."

**It is our runtime.** `reference/support.js` and `web2/proto/support.js` are
builds of the same `dc-runtime` — identical module list (`react`, `parse`,
`template`, `logic`, …), same `<x-dc>` document, same `{{ }}` bindings, same
`<sc-if>` / `<sc-for>`, same `renderVals()` contract. The prototype is a newer
build of the same tool that produced our two front-ends.

Consequences:

- **No framework translation.** The prototype's markup can be read structurally,
  not just for values. The handoff's warning to "read for values and behaviour,
  never for structure" does not apply to us.
- **The 2–3 day "build 22 primitives in your component library" phase is not our
  phase.** We have no component library to port to; we have one HTML file per
  front-end with inline styles, which is what the prototype also has.
- **The effort table in `06-INTEGRATION-PLAN.md` is calibrated for a different
  target.** Phases 1–3 are cheaper for us. Phase 5 is more expensive, because it
  assumes screens exist to restyle and seven of them do not.

## Framework and runtime

| Concern | What we actually use |
|---|---|
| Server | Node 22, Express 5, CommonJS. Single `index.js` (~4,300 lines) + `inventory.js` mounted at `/api/inv` |
| Build tool | **None.** No bundler, no transpile, no `node_modules` in the served path |
| Front-end framework | React 18 UMD (`web2/proto/vendor/`), driven by `dc-runtime` (`web2/proto/support.js`) — not JSX, not a build |
| Component model | One ES class per front-end with `renderVals()` returning a flat object of bindings; the template is HTML in the same file |
| Router | Server-side: `serveProto({base, file, …})` in `index.js`. Client-side: a `scr` string in component state, persisted to `localStorage['kashikeyo_scr']` |
| State | Closure-scoped React component state. **Not injectable from the page** — see the testing note below |
| Styling | Inline `style` attributes + one `<style>` block per file holding CSS custom properties. No Tailwind, no CSS modules, no styled-components |
| Data | Postgres with FORCE RLS. `entities(org_id, kind, id, data JSONB, deleted, rowver, txid)` is the sync spine; inventory has real relational tables |
| Deploy | Railway, Dockerfile → `npm start`. `staging` branch → test env, `main` → production |

## The three front-ends

| URL | File | What it is |
|---|---|---|
| `/app` | `web2/proto/index.html` (~227k) | Register / till. PIN-gated, offline-first |
| `/admin` | `web2/proto/admin.html` (~171k) | Admin cockpit. MANAGER rank and above |
| `/?s=<slug>` | **same file as `/app`**, guest mode | Customer QR portal, via `serveGuestPortal` — a different code path from `serveProto` |

`web/dist` is a retired prebuilt bundle. It is no longer served at `/app`; it
survives only so already-installed legacy PWAs can fetch root-relative assets.
`npm start` still runs `guest-sync-patch.js` over it. **Do not put re-skin work
there.**

## Where global styles live

- `web2/proto/index.html` — one `<style>` block, **7** `:root` / `html[data-*]`
  token blocks
- `web2/proto/admin.html` — one `<style>` block, **4** token blocks
- `site/pages.css` — the marketing/login/signup pages (separate, smaller)

That is where `tokens.css` goes. There are currently **two** independent token
sets (register and admin) that must be unified into one during Phase 1 — this is
the "do not add a second, competing theme system" instruction, and we already
have the problem the instruction warns about.

## Current theme mechanism

There is no `Users.ThemeMode` / `Users.CustomColors`. The handoff's Phase 6
assumes columns we do not have.

What exists instead:

- **Mode** is an attribute on `<html>`: `data-dark`, `data-white`. Set by
  `applyDoc()` in both front-ends from component state.
- **Accent** is `localStorage['kashikeyo_accent']`, read at boot in the register.
- **Nothing is persisted server-side.** Theme does not follow a user across
  terminals; a reimaged tablet loses it.
- The admin cockpit has a Theme panel under Hardware & Offline that writes
  `localStorage['kashikeyo_cfg']`, which the register reads via a `storage` event.

**Decision needed at Phase 6:** either add the two columns the handoff assumes
(and persist through `/api/app2/config`), or keep it device-local and drop that
part of the plan. Recommendation: persist it — the handoff is right that a
reimaged terminal should pull its config back, and we already sync settings.

## Design-token realities that constrain Phase 1

- **Fonts are already self-hosted** (`web2/proto/fonts/`): Bricolage Grotesque,
  Inter, Space Mono, plus MV Randhoo for Dhivehi. The handoff wants Inter +
  **JetBrains Mono**; Space Mono is the swap candidate. Fonts are precached by
  `web2/proto/sw.js` — any change must update `PRECACHE`.
- **CSP has no third-party font host.** `font-src 'self' data:` and
  `style-src 'self' 'unsafe-inline'`. Do not reintroduce `fonts.googleapis.com`;
  self-host as the handoff itself recommends.
- **Dhivehi and RTL are ours, not the prototype's.** The prototype is
  English-only across 2,692 lines. We carry two full dictionaries and `dir`
  switching. **Every re-skinned screen must keep them.** This is the single
  easiest regression to introduce.
- **Money is integer laari, GST-inclusive.** The prototype's ticket shows
  GST *added on top* (515.00 + 51.50 + 45.32 = 611.82). Our menu prices include
  GST and we extract it as the tax fraction. The panel *layout* transfers; the
  *arithmetic* must not. Every total must keep calling `totals()`.

## Testing and verification

- **Syntax-check after every edit.** Extract the largest inline `<script>` and
  `node --check` it, and confirm `<sc-if>` / `<sc-for>` open/close counts still
  balance — an unbalanced tag renders an empty screen with no error.
- Component state is closure-scoped. To test a method's arithmetic, slice its
  source out of the HTML and run it with `new Function` against a stub `this`.
  That exercises the shipped text rather than a retyped copy.
- Local harness: Postgres 16 on a rotating port, app on `PORT=41xx`. See
  `CLAUDE.md`.
- `pkill -f "node index.js"` kills the shell running it. Use
  `pkill -f "[n]ode index[.]js"`.

## Out of scope, per the handoff and per us

Schema, RLS, auth, JWT shape, tax calculation, rounding, receipt numbering,
journal posting, the offline sync protocol, the audit trail. A 5-member
production audit closed every CRITICAL/HIGH/MEDIUM/LOW finding against these
paths and they are now in production. **If a design appears to need one of them,
stop and raise it.**
