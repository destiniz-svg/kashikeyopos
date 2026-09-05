# Axis Journeys

The production website for **axisjourneys.com** — Axis Link LLC-FZ, Dubai (Trade Licence
2423494.01), a Maldives-first luxury travel agency — together with **Axis Studio**, the CMS its
specialists run it from.

It is a Next.js application with four runtime dependencies, a document store behind a two-driver
seam, and a design carried across from the Claude Design prototype declaration by declaration. What
that means, and the decisions behind it, are in [`docs/DECISIONS.md`](docs/DECISIONS.md); how it
deploys is in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Running it

**Node 22.6 or newer.** The seed script runs TypeScript through Node's own type stripping rather
than a second toolchain, and `package.json` states the floor so a host picks the right runtime.

```bash
npm install
cp .env.example .env.local     # then fill in SESSION_SECRET and the ADMIN_OWNER_* pair
npm run seed                   # the catalogue, and the first CMS account
npm run dev                    # http://localhost:3000
```

With no configuration at all it still runs: the store falls back to `.data/` on disk, media to the
same place, and mail to the process log. Nothing pretends — an unconfigured transport says so
rather than reporting a send it did not make.

| | |
| --- | --- |
| `/` | the site |
| `/properties/:id`, `/destinations/:slug` | a property, a destination |
| `/admin` | Axis Studio |
| `/api/ready` | the readiness probe, with the remedy for anything it finds |

---

## The commands

```bash
npm run dev          # development server
npm run build        # production build (standalone output)
npm start            # run the built server
npm run typecheck    # tsc --noEmit, in strict mode — the static gate
npm run seed         # put the catalogue in the store; safe to run twice
npm test             # unit
npm run test:api     # HTTP, against a real built server and a real store
npm run test:e2e     # Chromium, against that same server
npm run test:all     # all three
```

---

## How it is laid out

```
src/app/            routes — pages, the API, the CMS
src/components/
  site/             the public site: one provider, the sections, the drawer
  admin/            Axis Studio
  ui/               css() and Hover — the two pieces the design port rests on
src/lib/
  content/          the domain: types, rules, filters, the repository, the seed
  store/            the document store — file and DynamoDB behind one interface
  auth/             sessions, passwords, roles, users
  http/             headers, respond, request, rate limiting, logging, Turnstile
  media/            uploads, renditions, video, the standard, reference resolution
  aws/              SigV4, over node:crypto
  seo/              structured data
src/data/seed.ts    the real catalogue
test/               unit · api · e2e, and the two harnesses they share
docs/               decisions, deployment
```

### The four ideas worth knowing before changing anything

**`css()` is the design contract.** The prototype's measurements are carried across as the
declaration strings they were written as, parsed into style objects and cached by source text. Do
not rewrite a `style` into classes: the string is the specification.

**One definition of every rule.** `readiness()` has three callers — the publish endpoint, the public
bundle and the CMS completeness bar — so what the bar says is what the server does. The same holds
for the filters: the toast's count and the grid's cards read one function.

**The public read is one item.** A denormalised `LIVE#BUNDLE`, rewritten inside the same transaction
as a publish. A published property the bundle does not carry would be a publish that did not happen.

**Nothing reads `process.env` but `src/lib/config.ts`**, and a production boot refuses rather than
degrades when something required is missing.

---

## Content

`src/data/seed.ts` is the agency's own catalogue — 32 properties, 25 offers, three destinations, the
homepage, the company details and the legal documents. It is real content, not sample data, and
`test/unit/content-integrity.test.ts` holds it to that: no placeholder copy, every cross-reference
resolving, the company's own licence and contact details, and no invented prices.

Two things it does not have, both stated rather than papered over:

- **No from-prices.** Every `usd` is 0, which is the content's own state; the site says "Rate on
  request" and no card prints money.
- **One property on stand-in photography.** Conrad Rangali's images are labelled Unsplash
  placeholders in the source content, with the CMS media library as the remedy the label names.
- **No property is classified as an Overwater Villa.** The package type exists in the CMS and the
  catalogue uses none of it, so the "Overwater icons · Maldives" quick path matches nothing and the
  menu declines to draw it. Tagging one property in the CMS brings the path back by itself.
- **Both hero clips are 640 wide** — one of them says so in its own filename. They play, and the
  media standard reports them as below what a full-screen hero should be rather than being tuned
  down to let them pass. Replacing them is an upload, not a deploy.
- **Three islands name no marine life.** The property page reads "regularly seen here or nearby"
  out of what a specialist wrote about the reef, and matches the animal — so a profile that never
  mentions one names none, and the chips are simply absent. The CMS's `marine` field on the
  Property page tab is where a specialist says what is there.
- **No property carries a `pricing` table or a hero `video` yet.** Both are optional: the pricing
  section falls back to a seasonal guide derived from the tier and says it is a guide, and the hero
  falls back to the photograph. Neither is a blank section.

---

## Security

The whole of it is in `docs/DECISIONS.md` §6–8, and the tests that hold each property are in
`test/api/security.test.ts`. In short: HttpOnly session cookies with a version claim that makes
revocation real, scrypt passwords, a rank gate on every route, two-tier rate limiting on every open
door, a nonce-based CSP with no `unsafe-inline` in `script-src`, magic-byte checking on uploads, and
an error path that never returns an internal message.

No secret is hard-coded, and the only environment value the browser ever sees is the Turnstile
**site** key, which is public by design.

---

## What is not verified

Stated here rather than left to be discovered:

- **No live AWS, SES or Cloudflare call has been made.** The signer is pinned against AWS's own
  implementation and the drivers are tested against their request composition, but the first real
  call on a deployed install is the first proof that the table name, the bucket policy and the SES
  identity are right. `/api/ready` names anything it finds.
- **The catalogue's photography is on hosts this build environment refuses**, so the browser drives
  substitute bytes at the network layer only. That the URLs are correct is checked; that they
  resolve is not.
- **No screen reader has been driven.** Contrast, keyboard reachability, focus rings and WCAG 2.5.8
  target sizes are measured in a real browser; the rest is not automated.
- **Responsive tests drive the screens rather than the URLs.** That distinction cost something once:
  a CMS test that navigated by URL passed while the sidebar was hidden on every phone, with nothing
  in its place. A drive that never clicks cannot notice that the navigation is gone.
