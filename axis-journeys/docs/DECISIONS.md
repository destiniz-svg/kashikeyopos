# Architecture decisions, and what the build found

Written as a record rather than a summary: each entry is a decision that was not forced, with the
alternative that was rejected and why. Where something is missing or unverified it is stated here
by name — a build that reports itself complete while quietly skipping a thing is the failure this
document exists to prevent.

---

## 1. The prototype is an implementation specification, not a mood board

Every measurement in the shipped pages is the prototype's own, carried across as the declaration
string it was written as. `css()` in `src/components/ui/css.ts` parses those strings into React
style objects and caches them by source text, so the page ships the same `padding:24px 28px 0;` the
prototype had rather than somebody's reading of it.

**The alternative that was rejected:** re-expressing the design in Tailwind, CSS modules or a token
system. Every one of those is a translation, and a translation of 400 inline declarations is 400
opportunities to be a pixel out. The cost of the chosen approach is that `style-src` must keep
`'unsafe-inline'` — which carries no script, and is the trade named in the CSP itself.

`Hover` is the React equivalent of the prototype's `style-hover` attribute, and it applies on
`:focus` as well as `:hover`, which the prototype did not. That is a deliberate deviation under the
accessibility carve-out: a hover state a keyboard user cannot reach is a state they cannot see.

### Two places the prototype's files and its prose disagreed

The handoff's own rule is that the files win. Both are recorded here because the prose is what a
later reader is likely to find first.

- **The theme default.** `README.md` in the handoff says the site follows `prefers-color-scheme`.
  `applyTheme()` in the prototype defaults to **dark**. The code shipped, so dark is the default,
  and the toggle persists a choice from there.
- **The Selection card's price slot.** The handoff describes it as a price. The prototype puts the
  **tier or package name** there (`priceLabel: r.pkg`), and no card in the build prints money. That
  is also the honest rendering for this catalogue — see §5.

---

## 2. Four runtime dependencies

`next`, `react`, `react-dom`, `zod`. Everything else is written here, and each of those choices is
load-bearing rather than ascetic:

- **The AWS SDK is not a dependency.** It is tens of megabytes for three services used through four
  calls each, and every byte ships in the server image. `src/lib/aws/sigv4.ts` is the signer, over
  `node:crypto`. The case for writing it rests entirely on evidence, so it is pinned against AWS's
  own `@aws-sdk/signature-v4` — nine requests signed twice and compared to the byte. **That
  cross-check found a real fault**: a non-S3 canonical path must be URI-encoded *twice*, and this
  module decoded first and encoded once. Nothing the app signs today carries an escape in a non-S3
  path, so it was invisible, and it would have produced a wrong signature the first time one did.
- **No image library.** The three renditions (1600 / 800 / 320) are produced on a canvas in the
  browser before upload, which is where `admin/API.md` puts them. It keeps the server free of a
  native dependency and has a security dividend the brief asks for: re-encoding through a canvas
  drops EXIF and its GPS tags.
- **No ORM.** The store is a two-driver seam (`file`, `dynamodb`) behind one interface. The file
  driver is a real store, not a stub — it is what CI and local development run on.

`presignUrl()` **was deleted** during the test pass. It had no caller: the media store signs and
PUTs the bytes itself. An unexercised signer on a credential path is surface area with nothing
holding it up.

---

## 3. The public read is one item

`readBundle()` serves a denormalised `LIVE#BUNDLE`, rewritten inside the same transaction as a
publish, and held in memory for `BUNDLE_TTL_MS`. A guest's first paint is one `GetItem`, not a
fan-out across five collections.

**The rule that makes this safe:** the document and the rebuilt bundle are committed together
(`TransactWriteItems`). A published property the bundle does not carry is a publish that did not
happen, and half of it is worse than neither.

`isSiteReady` is applied **server-side**. A stub hidden only by the browser is a stub one
view-source away from being read, so an unready property is not in the answer at all.

---

## 4. One definition of every rule

`readiness()`, `isSiteReady()`, `validateOffer()` and `docStatus()` live in
`src/lib/content/rules.ts` and have three callers each: the publish endpoint that refuses 422, the
public bundle that filters with the same rule, and the CMS completeness bar that tells an editor
what is still missing. Two implementations of "is this ready" is how a property publishes and then
fails to render.

The same principle governs `filters.ts`: the toast that says "9 journeys match" and the grid that
draws nine cards read one function.

---

## 5. The catalogue is the real one, and it publishes no prices

`src/data/seed.ts` is the agency's own content: 32 properties, 25 offers, three destinations, the
homepage, the company settings and the legal documents. Nine properties are complete enough to
publish; the other 23 are honest drafts, and each one names what a specialist still has to write.

The handoff also shipped a **demo file** (`prototype/admin/seed.js`) carrying invented resorts —
"Amara Atoll Reserve", "Noor Private Island", "Fort Lantern House" — with invented specialists and
invented from-prices up to $14,800. **None of it was taken.** `content-axis.js`, the real
catalogue, is the source.

**Every property's `usd` is 0, and that is the content's own state**, not a gap in the port. Axis
publishes no from-prices for these resorts, so the drawer says "Rate on request" and "Your
specialist confirms rate & availability", villa and transfer supplements render as nothing rather
than "$0", and no card prints money. `test/unit/content-integrity.test.ts` pins this: if a real
price ever arrives, that test fails and tells whoever added it to check the money-rendering paths
before release.

### The one content gap, stated

**Conrad Maldives Rangali Island is live on stand-in photography.** Its hero and gallery are
Unsplash images, and the source content labels them as such —
*"Placeholder photo · Unsplash — replace with resort photography via Media"*. That is the honest
state rather than passing somebody else's photograph off as the resort's, and the CMS media library
is the remedy the label names. A test pins the set of affected properties at exactly this one, so a
second cannot join it unremarked.

Two destinations — Sri Lanka and UAE — read "Coming soon to Axis Journeys". They are `live: false`,
which is the agency's own statement about what it sells today, and a test refuses that sentence on
any destination that *is* live.

---

## 6. Sessions, and what signing out means

An HMAC-signed token in an `HttpOnly; Secure; SameSite=Lax` cookie. Never `localStorage`: a token a
script can read is a token an injected script can take.

The token carries a `ver` claim compared against the user's own `tokenVersion` on every request, so
a revocation is *read* rather than merely recorded.

**A defect the test pass found:** `POST /api/auth/logout` cleared the cookie and nothing else. The
browser stopped sending the token and the token went on being valid for the rest of its twelve
hours — so a copy taken from a shared machine, a synced profile or a proxy log still opened the CMS
long after somebody believed they had left. It now increments `tokenVersion`, which means signing
out here signs the account out **everywhere**. For an administration plane that is the right
default, and the control says so.

**A second defect:** `can(role, perm)` tested `ROLES[role] !== undefined`, and `ROLES['__proto__']`
is not undefined — it is the prototype — so a crafted role string reached `.can.includes` and threw.
It never granted anything, but a 500 from a value the caller chose is a gate that can be made to
fail. It is `Object.hasOwn` now.

---

## 7. Two belts on the open doors

Every endpoint anybody on the internet may call gets two token buckets and **both must have room**:
an identity bucket keyed on the address (hashed before it is held — a rate-limit table is not a
customer list), and an IP bucket several times wider. A hotel's wifi puts a whole lobby behind one
address, and a doorman that cannot tell forty guests from one attacker locks out the guests.

The sign-in budget is charged **on failure only**, so a team signing in correctly all morning never
touches it.

It is in memory on purpose: one process, minute-wide windows, and it fails open on a restart, which
is the correct failure. If this ever runs as several instances, `src/lib/http/rate-limit.ts` is the
one seam to move onto Cloudflare Rate Limiting — and the WAF rules in `DEPLOYMENT.md` are the belt
that holds in the meantime.

---

## 8. What a caller is told

`src/lib/http/respond.ts` is the only place that decides. An internal message — a store error, a
stack, a provider's verbatim refusal — never reaches the browser; the class and the status do, and
the detail goes to the log, which is where the person who can act on it looks.

The enquiry honeypot answers **200 with a plausible reference** and stores nothing. Telling a bot it
was caught is telling it what to change.

Sign-in answers byte-identically whether the address is unknown or the password is wrong.

---

## 9. Testing, and what it is allowed to prove

- **Unit** (`npm test`) — the rules, the filters, the sanitiser, the signer, the credential plane,
  the limiter, the CSP, and the catalogue's own integrity.
- **API** (`npm run test:api`) — `next start` on a production build, over HTTP, against a real
  store in a temporary directory. Not a mocked handler and not an in-process import: the
  middleware, the routing, the cookies, the CSP nonce and the error wrapper are the ones that
  deploy.
- **End to end** (`npm run test:e2e`) — Chromium against that same server. A guest filters, opens a
  property, sends an enquiry, and the record is read back from the other plane. Every drive also
  asserts the page logged nothing, because a screen that renders and throws on every keystroke looks
  identical in a screenshot to one that works.

**What is not proven, stated plainly:**

- No live AWS or SES call has been made. Composition and decision are tested; connectivity is not.
- No Cloudflare zone was configured.
- The catalogue's photography is on hosts this environment's egress policy refuses, so the browser
  drives substitute bytes at the **network layer only** — the app, the markup and the CSS are
  untouched. That the URLs are correct is checked; that they resolve is not.
- Screen-reader behaviour has not been driven. Contrast, keyboard reachability, focus rings and
  WCAG 2.5.8 target sizes are measured in a real browser; the rest of WCAG is not automated.
