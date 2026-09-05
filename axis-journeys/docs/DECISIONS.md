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

## 16. Several photographs, and a standard that says what is wrong

Two requests in one sentence: let a room, a facility — anywhere an image appears — carry more than
one photograph, and check on upload whether a picture or a video is up to standard, saying so when
it is not.

### Where the extra photographs live

A villa and a venue were already tuples, and this build's own rule is that they stay tuples because
the seed, the CMS editors and the public site all index them positionally. So the photographs are
**appended** rather than folded into an object: `img` stays at slot 3 as the lead, the rest go to
slot 7, and their focal points to slot 8. A document written before this has nothing at 7 and
renders exactly as it did — asserted, property by property, in `test/api/media.test.ts`.

Slots 6 and 8 are written by the media resolver rather than by a person, which is why `ListColumn`
gained an `at`: the CMS column that edits slot 7 says so, instead of a dummy column standing in for
a field nobody edits.

**One trap, found by writing it.** `resolveMediaRefs()` has always read slot 3 of an array as "this
row's image" and written its focal position to slot 6. A plain list of photographs is an array
whose slot 3 is also a reference — so a room with four extra photographs would have had its seventh
replaced by a focal position. The guard is that no tuple in this model holds a media reference at
slot 0 and a photo list always does.

The destination page gained a gallery of its own on the same principle: set, it is used; empty, the
page draws the hero of its first few properties exactly as it always has. Neither is a placeholder.

On the site, the room and venue panels use the property gallery's own grid, hover and lightbox —
three columns, 110px rows, the same 6px gutter. A second gallery language on one screen reads as a
different product, and one was already written for this job. The lead photograph becomes clickable
**only when there is more than one**, so a property that has never been given a second photograph
renders exactly as before, and the lightbox now takes a named shot set instead of always being the
property's gallery.

### The standard: two levels, and why refusing is the smaller half

`src/lib/media/standards.ts` is one definition with three callers — the browser before an upload,
the server on the bytes it received, and the CMS's video field on an address somebody typed.

- **Refuse** is for what cannot work anywhere: the wrong type, past the byte cap, a file whose
  dimensions cannot be read, smaller than the smallest rendition this app stores, or a shape whose
  subject is cropped away in every slot on the site.
- **Warn** is everything else, and it is most of it. A resort that holds one photograph of its spa
  at 1200px still has that photograph. Losing real content to a rule is worse than the rule not
  existing, so it is accepted and the reason is said out loud — which is the whole of what was
  asked for.

Two numbers are worth naming. `wantLongEdge` is 1600 because that is the width of the `hero`
rendition this app stores, so a source below it is enlarged on a full-bleed hero — the sentence
says so rather than asserting a preference. And `minBytesPerPixel` reads prior compression off
**our own re-encode at one quality**, which is what makes the number comparable at all; it applies
to JPEG only, because a flat PNG logo is legitimately tiny and calling that poor quality would be a
rule about the wrong thing.

There is deliberately no separate megapixel warning. Every image it would have fired on is one
`small` or `crop` has already spoken about, and two sentences for one fault is how a warning stops
being read. It was written, the tests caught it duplicating, and it came out.

**The video floor was in the wrong place, and the shipped assets said so.** The first draft refused
below 640 × 360. Both hero clips this site serves are 640-wide and one of them is 640 × 338, so the
floor refused what is on the live site. It is a quarter of 1080p now — a wall-sized thumbnail, and
genuinely unusable — and the shipped pair warn instead. The standard is not tuned down to let the
existing content pass: `test/unit/media-standards.test.ts` asserts that `uae.mp4` draws exactly one
finding, and it is `small`.

### Measured on the bytes, never on the form

The upload used to take `w`, `h` and `bytes` from form fields the browser filled in. Those fields
are gone. `src/lib/media/probe.ts` reads dimensions out of the JPEG, PNG and WebP headers and out
of an MP4's own `tkhd` and `mvhd` boxes, and the record carries what was read.

The `hero` rendition is what an image is judged on, and that is load-bearing rather than
convenient: the browser only ever scales down (`Math.min(1, 1600 / longEdge)`), so a hero that
arrives under 1600 wide is proof the original was. Nothing has to trust a number beside it.

The MP4 walk was checked against an independent implementation of the same boxes before it was
trusted, including the audio track's 0 × 0 `tkhd`, which the "widest wins" rule skips. WebM answers
nothing — writing a second, worse EBML parser for a container nobody here has used would be a check
that half ran — and the standard reports that as unmeasured rather than as a pass.

### Video, because the one video a guest watches had no way in

The destination hero is a full-screen clip, and it was a path somebody typed pointing at a file a
developer had copied into the repository. The library takes MP4 and WebM now, stored as they
arrive: nothing transcodes, and a build with four runtime dependencies is not going to start. A
video record carries the three picture renditions too — a frame captured from the clip a moment in,
because the first frame is often a fade from black and a black poster is indistinguishable from a
video that failed to load.

A URL is still a real answer, and the field's **Check this video** button probes one: a page cannot
read the dimensions of a cross-origin file whose server sends no CORS header, and that is reported
as unmeasured rather than as a pass.

### The content-length check is not a fence, and the first version said it was

The handler reads `content-length` before calling `formData()`, which saves the multipart decode
and the copy of every part it allocates. The comment above it claimed the body was turned away
before it was read. **Measured: it is not.** A POST that announces 900 MB and sends seven bytes gets
no answer at all — and neither does one aimed at a route that does not exist, so it is the platform
receiving the body before anything is dispatched, not this handler.

The comment now says what is true, `test/api/media.test.ts` pins the silence so nobody writes the
claim back, and DEPLOYMENT.md §4 names the edge setting that is the actual fence.

Two smaller things fell out of the same test. The ceiling is derived — one video plus three poster
renditions plus framing — rather than a round number that would quietly contradict a raised cap.
And a refusal whose whole job is to name the limit was printing `That image is larger than 0 MB`,
because sizes were always formatted in megabytes; they are printed in the unit they fit now.

### What this does not do

Nothing generates alternative formats or sizes beyond the three renditions, nothing transcodes
video, and no captions are collected for a room's extra photographs — the room's own name is the
caption, and a second caption field on every photograph is a form nobody fills in. The browser
check before an upload is a courtesy that saves a wait; the server judges the bytes it received and
is the one that decides.

## 17. A publish reached the API and not the site

Found by an end-to-end test that failed only when the tests before it had run — which is the shape
of a defect nobody would have reproduced by hand, and it was live.

An editor publishes a property. Measured on the shipped build, immediately afterwards:

```
GET /api/public/site     the change,        25 times out of 25
GET /properties/{id}     the previous page, 12 times out of 12
```

and the page stayed on the previous content **for the life of the process** — past the bundle TTL,
past a cache-busting query string, on the home page as well, with `Cache-Control: no-store` on every
one of those responses. So a reader reloading saw nothing change and had no way to tell why.

**The cause is that a module-level variable is not one variable.** The pages and the route handlers
are compiled into separate server bundles, so each holds its own instance of every module they both
import. Three singletons were written as `let instance` at module scope, and each quietly became
two:

- `getStore()` — and `FileStore` keeps a partition cache for the life of the process. The API's copy
  wrote and updated its cache; the page's copy had read once, had never written, and never looked
  again. That is the whole of the staleness, and it is why the bundle TTL did not rescue it.
- the bundle memo in `repository.ts` — a publish updates it, and updated only the API's.
- the rate-limit buckets — the milder one, and the one worth stating plainly: a caller had a full
  allowance through the pages and another full allowance through the route handlers, so every
  ceiling was quietly double what it says.

`src/lib/singleton.ts` puts all three on `globalThis`. It is not a cache and not a work-around: it
is where a process-wide singleton has to live when a module can be instantiated more than once, and
it restores exactly what each of them already meant. Measured after: 0 stale out of 12.

**Why nothing caught it.** Every API test drives the route handlers, where the writer and the reader
are the same instance. The one e2e test that publishes through the CMS and then reads the site did
so on a page that had never been rendered before — a cold bundle reads from the store and is
therefore correct. It took a test that warmed the page first, which is what every real visitor does.
`test/api/public.test.ts` now warms it deliberately, and says why in the test.

The deployed install was serving this. It is a file-store deploy, which is the driver whose cache
never expires, so the symptom there was the strongest form: publish anything, and the public pages
do not change until the container restarts.

## 18. Curated quick paths, and five other dead ends around them

Reported as "destinations → Curated Quick Paths does not work, no content", which turned out to be
three separate defects wearing one symptom, and a sweep of every control on the site turned up
three more.

### The menu could not be opened by clicking it

The trigger carried `onMouseEnter={() => setMega(true)}` and `onClick={toggleMega}`. `mouseenter`
fires first, so with a mouse the menu is already open by the time the click lands and the toggle
can only ever shut it again. Measured: `aria-expanded` went false → true on approach and back to
false on the click. Anybody who moved to "Destinations" and clicked it — the ordinary way a person
opens a menu — saw it flash open and shut.

The click opens rather than toggles where the pointer hovers, and still toggles where it does not,
because a touch device never opened it on approach.

### The paths did nothing at all from a destination page

`apply()` wrote the filters into `state.f` and scrolled to `#selection`. The destination page reads
`state.pf`, and `#selection` is on the home page only — so on `/destinations/maldives` the menu
closed, nothing moved, and a toast said **"3 journeys match"** over a screen where nothing had.
That is the worst form of a dead control: one that reports success.

It looks for the Selection before pretending to have filtered it. Where the Selection is not on the
page, the filter set goes into the address and the browser navigates — and a filter that survives a
navigation is one somebody can also send, so `/?pkg=Private+Island` now arrives filtered and
scrolled. `filtersFromQuery()` bounds every value, because that address is one anybody can compose.

### On a phone they did not exist

The four were written inline in `Header.tsx`. The mobile menu is a different component and nobody
copied them across, so the phone had the heading nowhere and the list nowhere. They are one
definition in `filters.ts` now, read by both — a second copy is also how two menus come to offer
different journeys under the same name.

### And one of the four could never have worked

Found by a test rather than by clicking: **nothing in the catalogue is classified as an Overwater
Villa**, so "Overwater icons · Maldives" always landed on "No exact match — try widening". The CMS
offers that package type and no property uses it, which is a gap in the CONTENT rather than in the
menu — so the list is not rewritten. `availableQuickPaths()` declines to draw a path that leads
nowhere, and the path returns by itself the moment a specialist tags a property.

### A section label on a destination page swapped the page underneath the address

"Our Story" from `/destinations/maldives` set `page: null`, which renders the home page while the
address still reads `/destinations/maldives#story`: a reload came back to the destination, and the
link was unshareable. `goHome()` has always navigated for exactly this reason. The three labels
that have a local section on that page (`dp-props`, `dp-offers`, `dp-exp`) still scroll to it — that
half was right — and the ones that do not now navigate to `/#id`.

### What the sweep covered, and what it could not

Every visible `button` and `a` on the home page, a destination page, `/offers`, and six CMS screens
was clicked with a fingerprint of the whole document taken either side: 471 controls, and after the
false positives (the logo on the page it already points at, and a skip link measured mid-transition)
the only one where nothing at all happened was the Destinations trigger. The CMS's 143 controls were
all live. A second pass swept inside the overlays the first could not reach — the mega menu, the
property drawer, the mobile nav — because a control that only exists once something is open is
exactly the kind nobody notices is dead.

What it does not cover: a control whose effect is real but wrong, which is what four of these six
were. Those came from reading what each handler writes and asking who reads it.

## 19. The audit: what a browser said about the motion, the keyboard and the Back button

Asked for a complete audit of the site, its flow, its effects and its motion. What follows is what
was measured in Chromium against `next start` on a production build, at 1440×900 and at 390×844,
and what was changed because of it. Nothing here is a taste call; the taste calls are named at the
end and were left alone, because the prototype is the visual contract.

### The primary action of the site could not be reached with a keyboard

Seventy tab stops walk the home page, and not one of them opened a property. The Selection card is
an `<article>` with a click handler — no role, no tabindex, `focusable: false` — so a keyboard user
could shortlist a resort (the heart inside it is a real button) and could not open it. The Offers
tile and `PropertyCardTile` are both real buttons, so this was one card out of step rather than a
decision.

The card is still the click target a pointer expects. What changed is that the **View** affordance
the design already draws in the corner is now a `<button>` carrying the property's name, and its
click bubbles to the `<article>` above — so there is exactly one handler, and the whole card keeps
working as it did. Making the card itself the control would have nested the shortlist heart and the
photo credit link inside a button.

Measured after: focusing that control and pressing Enter opens `/properties/sun-siyam-olhuveli`
with the drawer at `translateX(0)`.

Found on the way: a swipe on the carousel ends in a click on whichever card it started on, so
sliding past a resort opened it. The drag flag the arrows already set is now read by the card.

### A panel that says it is a dialog, and then is not one

`aria-modal="true"` is a promise: a screen reader stops announcing the page behind because the
application has said focus is inside the panel. The drawer did not declare it at all, and moved no
focus — focus stayed on the button that opened it, **Tab left the panel on the first press in 25 of
25 attempts**, and closing left focus wherever it had wandered. The gallery lightbox and the legal
modal did declare it, and managed no focus either, which is the worse half of the same defect: the
reader falls silent about the page while the keyboard is still standing on it.

`useDialogFocus` in `src/components/ui/dialog.ts` is the one definition of the three halves — move
in, keep in, hand back — and `test/unit/wiring.test.ts` fails on any file that declares the role
without calling it.

Measured after: focus lands on **Close**, **Tab left the panel 0 of 40 times**, and Escape returns
focus to the View control that opened it.

### Back left the site from a screen that looked like a page

Opening a property `replaceState`d the address to `/properties/<id>`. On a phone the drawer is the
whole screen and Back is how anyone leaves a screen — and Back left the site: measured landing on
`about:blank` at both viewports, with `history.length` unchanged at 2.

Opening now pushes an entry, a `popstate` listener closes the drawer when that entry goes, and
closing by any other route (Escape, the backdrop, the close button) goes back through it, so the
address and the history always agree. Switching from one property to another replaces rather than
pushes, or Back would walk a guest through everything they had glanced at. A deep link straight to
`/properties/<id>` pushes nothing and hands the address back by hand — Back there means leaving,
which is correct.

The scroll spy writes the hash with `history.replaceState(history.state, …)` rather than `null`,
or it would wipe the marker the drawer put there.

### Motion the visitor asked not to have

The CSS half was already right: 12 keyframes and 7 animations running normally, **0 under
`prefers-reduced-motion: reduce`**. What CSS cannot reach is motion this application asks for.

- **Programmatic scroll.** Four call sites hard-coded `behavior: 'smooth'`, measured animating over
  28 distinct positions under `reduce`. `scrollBehaviour()` in `src/components/ui/motion.ts` reads
  the media query; the destination is unchanged, only the travelling. Measured after: 2 positions
  under reduce, 28 without.
- **The background clips.** Three sections carry a muted looping video and two of them asked for it
  with an `autoplay` attribute, which starts the clip before any script can read the preference —
  and no `matchMedia('(prefers-reduced-motion: reduce)')` existed anywhere in the JavaScript. No
  element carries the attribute now; `useAmbientPlayback` is the single decision, and under reduce
  the poster the design already layers underneath is what a visitor sees.

**Not proven in a browser**: this Chromium build cannot decode the shipped H.264 clips
(`readyState` stayed 0 after 6.5 s), so the *absence* of playback under reduce is established from
the source and from the attribute, not from a moving picture.

### 3.1 MB of video nobody was looking at

Writing that hook exposed the cost. `play()` overrides `preload="none"`, so a clip that starts on
mount is fetched whether or not anybody scrolls to it — and the About bento sits eight screens
down. Measured on a phone profile (4× CPU, Fast 3G): **6,243 KB of media before, 3,122 KB after**,
with playback now gated on an `IntersectionObserver`.

The remaining 3.1 MB is the hero clip, which is on screen and therefore genuinely asked for. Making
it desktop-only would remove it from a phone entirely — that is a brand decision about the first
thing a guest sees, not an engineering one, so it is reported rather than taken. The `preload`
comment in `Hero.tsx` claimed a saving it was not making, and now says what preload actually buys.

**A correction to an earlier note in this session**: a first pass recorded 0 KB of media on a phone.
That was wrong — measured against the same commit afterwards it was 6,243 KB. The number above is
the one taken with the profile stated beside it.

### The home page had no `<main>`

The skip link's whole job is to put a keyboard user in the content. `DestinationPage` has a `<main>`;
the home funnel had none, so the link landed in a document with no main region to be in.

### Core Web Vitals, on this build

| | desktop 1440 | phone 390, 4× CPU, Fast 3G |
| --- | --- | --- |
| TTFB | 193 ms | 51 ms |
| FCP / LCP | 492 ms | 1,280 ms |
| LCP element | `H1#hero-h1` | `H1#hero-h1` |
| CLS | 0.0000 | 0.0000 |
| long tasks | 1, worst 140 ms | 6, worst 424 ms |
| transferred | font 70 KB · image 95 KB · media 3,122 KB | the same |
| scroll | 3 frames of 39 over 33 ms | 1 of 65 |

The LCP element being the headline rather than the hero photograph is the poster doing its job.
The long tasks on the throttled phone are hydration; they land before the first interaction is
possible, and the slowest interaction recorded in either profile was under the 200 ms INP good
threshold.

### What was found and deliberately not changed

- **The hero clip on a phone** — 3.1 MB, above.
- **The card surface is still a pointer target that is not itself focusable.** The equivalent
  keyboard route is the named control inside it, which is the ordinary pattern; making the whole
  card a button would nest two other controls inside it.
- **Four transitions animate layout properties** (`.skip-link`'s `top`, a `height`, `.drow`'s
  `padding-left`, a `width`). Each is on a single element reacting to a deliberate act, none showed
  up in the scroll frame budget, and rewriting them as transforms would change the movement the
  prototype specifies.
- **Three SVG path errors per load on the two phone portals**, from the template's `d="{{ a.icon }}"`
  being parsed as DOM before the runtime compiles it. Parse-time noise only; the icons render.
