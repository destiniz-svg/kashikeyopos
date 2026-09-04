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

---

## 10. Two files that must not be built once

`robots.txt` and `sitemap.xml` are rendered per request rather than at build time, and both would
have been wrong the other way round.

**`robots.txt`** decides by `APP_STAGE`, and `next build` runs with `NODE_ENV=production`. One image
runs in every environment — that is the whole shape of the deploy — so a statically generated file
would bake production's "allow everything" and serve it on staging. The file whose entire job is
keeping a staging copy out of the index would be the thing that put it there.

**`sitemap.xml`** is composed from the published bundle, and at build time there is no store: the
image is built once and points at a different table in each environment. It would have shipped
carrying the home page and nothing else.

Both cost one read of the in-memory bundle, and crawlers ask rarely.

---

## 11. The visual QA, and what it compared against

The finished implementation was captured beside the running prototype at identical viewports, with
the reveal transitions settled, and compared per pixel by a decoder written for the purpose. Above
the fold at 1440px: **0.204% of pixels differ**, concentrated in text antialiasing. At 390px the two
are visually identical.

Two differences were traced to their cause and fixed rather than accepted:

- **Document order.** The store lists by sort key, which is alphabetical by id, so the Selection
  carousel, the Properties grid and the Offers rail rendered in a different order from the
  catalogue. `Doc<T>` carries an `order` now, assigned by position at seed time, and `listDocs`
  sorts by it.
- **The logo.** Rendered through `next/image` it was resampled, and accounted for most of the
  remaining delta. It is a plain `<img>` at its true 851×1007 aspect, with the eslint exemption
  carrying the reason.

One change of mine was reverted as overreach: the trust strip's "38 properties" was briefly replaced
with a computed count. That string is the agency's own claim about its partner contracts — business
copy, not a derived figure — so it is verbatim again, with a comment saying why.

---

## 12. The performance budgets, and what they are measured on

| | Measured | Budget |
| --- | --- | --- |
| JavaScript reaching the browser | **207 KB** compressed | 280 KB |
| Server-rendered HTML, home page | **43 KB** compressed | 100 KB |
| Stylesheet | **4.5 KB** compressed | 20 KB |
| Fonts, two families subset | measured per run | 200 KB |
| Cumulative layout shift, 390px | measured per run | < 0.1 |

Two things about how those are taken.

**They are compressed bytes**, read from the browser's own Resource Timing (`encodedBodySize`) —
what a guest's connection actually pays. Reading response bodies instead measures the decompressed
size, which on this build reads 735 KB against the 207 KB that is really sent, and would have set
every budget against a number nobody experiences.

**The stylesheet is 4.5 KB because almost all of the design is inline.** The prototype's
measurements travel as style attributes in the markup, so the sheet carries only the tokens, the
resets and the media queries. That is the same decision as §1 seen from the other side: it is why
the HTML is comparatively large and the CSS is not.

A budget is not a benchmark. One run on one machine says nothing about a phone in Malé, so what is
asserted is the shape a slow connection cannot recover from — how much has to arrive before
anything is interactive, whether a third party is on the critical path, whether the layout moves
after it paints, and whether the largest paint is the hero rather than something below the fold.

**Image weight is not measured**, because the catalogue's photography is on hosts this environment
refuses. That is §9's limitation, not a budget that passed.

---

## 13. The dead code that was removed, and the one piece that was wired instead

A sweep for exports with no reader found eight. Seven were deleted:

- **`sizeForKey`** was the worse kind: a second, subtly different definition of the rule
  `resolve.ts` already applies with its own `sizeFor`. Two definitions of one rule, one of them
  dead, is how they come to disagree.
- `setStore`, `setMailer`, `forgetBundle`, `isEmpty`, `cssWith` — seams and helpers nothing used. A
  seam with no user is surface area, not flexibility; each is three lines if it is ever wanted.
- `requireActor` is called only by `need()` in its own file, so it stopped being exported.

**`breadcrumbJsonLd` was wired rather than deleted.** It was written, correct, and rendered nowhere
— a property page sits two levels down and a search result that shows the trail is one a person
trusts more. It is on the property and destination pages now, with the destination's own slug, so
the middle rung points at a page the site actually serves.

The same sweep confirmed that `src/lib/config.ts` is the only module reading `process.env` — it was
not, quite: `src/proxy.ts` read `API_ORIGIN` and `MEDIA_ORIGIN` directly, because Next reserves the
name `config` in that file for its own matcher. That was the one place skipping the rule that a
dangling `${{…}}` reference is not a value, which would have put the literal into the
Content-Security-Policy as an allowed origin. It imports the config under an alias now.

There is deliberately **no lint script**. `next lint` was removed in Next 16 and the one in
`package.json` did nothing — a control that reports success without running is the defect this
build keeps finding, and leaving it would have been an instance of it. The static gate is
`npm run typecheck`, which runs TypeScript in strict mode over the application and the tests. The
`eslint-disable-next-line` comments that remain are notes on intent for whoever adds a linter, and
each says why the rule is being set aside rather than only that it is.

---

## 14. The logger cannot take the request with it

`redact()` is applied to every field rather than to the ones somebody remembered — the only version
of this that survives a new field being added — and it redacts on the KEY (`password`, `token`,
`authorization`, `cookie`, a hash) and on the VALUE (a bearer token or a stored `scrypt$…$…` pasted
into a message, whatever the field is called).

Writing the test for it found that the logger **threw on a cyclic value**. The depth cap did not
help: past the cap the value was returned as it stood, so the cycle came straight back and
`JSON.stringify` raised. A request object, an error with a `cause` chain, an ORM row — any of them
can hold one, and the logger is called from catch blocks with values nobody chose. A logger that can
throw takes the request with it, and the thing it was reporting is the thing that is lost. Cycles
are marked `[circular]` now, depth is `[deep]`, and `emit()` has a last fence that still writes the
level, the scope and the message when a field cannot be serialised at all.

---

## 15. The CMS had no navigation on a phone

Reported from a real device, and it was exactly what it sounded like. `admin.css` hid the sidebar
below 820px:

```css
@media (max-width: 820px) { .axis-studio #sidebar { display: none !important; } }
```

Nothing took its place. The sidebar is the only way to reach seven of the nine sections, so what was
left on a phone was three dashboard cards — Properties, Offers, Enquiries — and no route at all to
Destinations, Homepage, Media, Settings or Team, no theme toggle, no link to the live site, and no
way to sign out. Once you were on one of those three screens there was no way back to the dashboard
but the browser's own button. Measured before the fix: 27 reachable controls at 1440px, 15 at 390px.

The sidebar is a **drawer** at that width now, opened from a bar carrying the menu button and the
name of the screen you are on. It is the same sidebar — the same markup, the same items, the same
styling — and only where it sits changes; above 820px nothing about the rendering is different,
which matters because the desktop layout is the prototype's.

It closes on navigating, on the scrim, and on Escape, which hands focus back to the button that
opened it. The transition is disabled under `prefers-reduced-motion`, because a drawer that arrives
by transform is a drawer that never arrives when the animation does not run.

**Why the suite did not catch it.** There was already a responsive test for the CMS at 390px, and it
passed: it asserts no screen scrolls sideways, and it reaches each screen **by URL**. A drive that
never clicks cannot notice that the navigation is gone. The replacement drives it the way a person
does — open the menu, read what is in it, tap one — at 820, 390 and 320px, and asserts the desktop
still has no menu button at all.
