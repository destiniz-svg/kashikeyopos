# Deploying Axis Journeys

The shape is Cloudflare in front, AWS behind: Cloudflare owns DNS, TLS, the CDN, the WAF and
Turnstile; AWS runs the container, the table, the bucket and the mail. Nothing in the application
knows which of them it is behind — every environment value is read at request time through
`src/lib/config.ts`, so **one image runs in development, staging and production** and the difference
is entirely in the variables.

---

## 1. What has to exist

| Piece | What it is | Notes |
| --- | --- | --- |
| **DynamoDB table** | The document store | Single table, `pk` (S) partition, `sk` (S) sort. On-demand billing. TTL attribute `ttl`. |
| **S3 bucket** | The media library | Block *all* public access. The app signs its own reads and writes; a CDN in front is optional. |
| **SES identity** | Outbound mail | The domain verified, DKIM on, and out of the sandbox before real enquiries arrive. |
| **App Runner / ECS service** | The container | Health check on `/api/ready`. Two instances minimum, so a deploy is not an outage. |
| **Cloudflare zone** | DNS, TLS, CDN, WAF | Proxied (orange cloud). Turnstile site + secret key issued here. |
| **Secrets Manager entry** | `SESSION_SECRET` and the Turnstile secret | Injected as environment variables by the task definition. |

### The table

One table, because every access pattern this app has is "give me this partition":

```
pk = COL#properties   sk = ID#baros          a document
pk = COL#offers       sk = ID#…              a document
pk = LIVE             sk = BUNDLE            the denormalised public bundle
pk = USERS            sk = ID#…              a CMS account
pk = ACTIVITY         sk = TS#…              the feed (expires by `ttl`)
pk = META             sk = LISTS             the published vocabularies
```

No global secondary index is needed and none should be added speculatively: the one hot read is
`LIVE#BUNDLE`, which is a single `GetItem`.

```bash
aws dynamodb create-table \
  --table-name axis-journeys \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --sse-specification Enabled=true \
  --region me-central-1

aws dynamodb update-time-to-live --table-name axis-journeys \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" --region me-central-1

# Point-in-time recovery is the rollback story for content. Turn it on before the first publish,
# not after the first mistake.
aws dynamodb update-continuous-backups --table-name axis-journeys \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true --region me-central-1
```

### The bucket

```bash
aws s3api create-bucket --bucket axis-journeys-media \
  --region me-central-1 --create-bucket-configuration LocationConstraint=me-central-1
aws s3api put-public-access-block --bucket axis-journeys-media \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
aws s3api put-bucket-encryption --bucket axis-journeys-media \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-versioning --bucket axis-journeys-media \
  --versioning-configuration Status=Enabled
```

Versioning is not paranoia: a media library is where an editor replaces the wrong file, and the
CMS's delete is permanent without it.

### The IAM policy

The task role gets exactly what the app calls and nothing else. `dynamodb:Scan` is absent on
purpose — the app never scans, and a role that may scan is a role that can be made to.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Documents",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:TransactWriteItems"],
      "Resource": "arn:aws:dynamodb:me-central-1:ACCOUNT:table/axis-journeys"
    },
    {
      "Sid": "Media",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::axis-journeys-media/*"
    },
    { "Sid": "Mail", "Effect": "Allow", "Action": ["ses:SendEmail"], "Resource": "*" }
  ]
}
```

---

## 2. The variables

`.env.example` is the complete list with a line on each. Two rules govern all of them:

- **Nothing is hard-coded.** `src/lib/config.ts` is the only module that reads `process.env`, so a
  missing value is named at boot rather than discovered as `undefined` three screens in.
- **A production boot refuses rather than degrades.** `configFaults()` stops the process when
  `SESSION_SECRET` is short or absent, when the store or bucket is unnamed, when Turnstile is
  required and has no secret, or when `SITE_URL` is not an https origin. An install that boots
  half-configured is one somebody trusts.

A platform that resolves an unknown reference to an empty string is a real hazard: a variable that
reads `${{SOME_SERVICE.KEY}}` in a dashboard can arrive as nothing. `config.ts` treats a value
still wearing `${{…}}` as unset, so this fails loudly at boot rather than silently at 2 a.m.

**Secrets never go in the image, in the repository, or in the browser.** `SESSION_SECRET`,
`TURNSTILE_SECRET_KEY` and the AWS credentials are injected from Secrets Manager by the task
definition. The only variable the browser ever sees is `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, which is a
public key by design.

---

## 3. Building and running

```bash
docker build -t axis-journeys:$(git rev-parse --short HEAD) .
docker run --rm -p 3000:3000 --env-file .env.production axis-journeys:$(git rev-parse --short HEAD)
```

The image is multi-stage: the runtime carries the standalone server, the static assets and nothing
else — no source, no toolchain, no development dependencies. It runs as `node`, not root.

**Seed once, on first deploy only:**

```bash
npm run seed          # the catalogue, and the first owner if ADMIN_OWNER_* are set
npm run seed -- --force   # replaces existing documents; never on a live workspace
```

`npm run seed` is safe to run twice — it leaves an existing document alone. `--force` is not, and
that is what the flag is for.

---

## 4. Cloudflare

### DNS

| Record | Value | Proxy |
| --- | --- | --- |
| `A` / `CNAME` `axisjourneys.com` | the App Runner / ALB hostname | proxied |
| `CNAME` `www` | `axisjourneys.com` | proxied |
| `CNAME` `media` | the CloudFront distribution or S3 endpoint | proxied, only if `MEDIA_ORIGIN` is set |

### Cache rules

The application already sends the right `Cache-Control` on every response; these rules only make
Cloudflare honour it rather than guess.

| Path | Rule |
| --- | --- |
| `/_next/static/*`, `/assets/*` | Cache everything, edge TTL a year — the filenames are hashed |
| `/api/public/site` | Cache everything, respect origin TTL (it sends `s-maxage` + `stale-while-revalidate`) |
| `/api/*` (everything else) | **Bypass cache** |
| `/admin*` | **Bypass cache** |

Getting the last two wrong is how one editor's session is served to another. They are bypass rules
rather than short-TTL rules for exactly that reason.

### WAF

- Rate-limit `/api/public/enquiries` and `/api/auth/login` at the edge, above the application's own
  ceilings. The app's limiter is in memory and per instance; the edge is what holds when there are
  several.
- Managed rules on, with the OWASP set in "log" for a week before "block" — a WAF that blocks a real
  enquiry is worse than one that watches.
- Turnstile: issue the site and secret key here, set both variables, and leave
  `TURNSTILE_REQUIRED=1` in production. With no secret the verifier says so and the form still
  works, which is right for development and wrong for the live site.

### Redirects

`www` → apex is a Cloudflare bulk redirect. The application's own redirects (`/login`,
`/property/:id`, `/destination/:slug`) are in `next.config.mjs`, because they are facts about this
application's routes rather than about its hosting.

---

## 5. Health, and what "ready" means

| Endpoint | Answers |
| --- | --- |
| `/api/health` | The process is up. Cheap enough for a load balancer to ask constantly. |
| `/api/ready` | The store answers, the published bundle composes, media storage is usable, and no configuration fault stands. `503` with a `faults` array naming the remedy. |

Point the load balancer at **`/api/ready`**, not `/api/health`. A probe that only proves the process
started reports green on an instance that cannot show a guest a single property.

---

## 6. Releasing, and getting back

1. Merge to `main`; CI runs `npm run typecheck`, `npm test`, `npm run test:api` and `npm run test:e2e`.
2. Build and push the image tagged with the commit.
3. Deploy to **staging** (`APP_STAGE=staging`, its own table and bucket) and let the smoke run.
4. Deploy to production. App Runner rolls one instance at a time behind the readiness probe.

**Rolling back** has two independent halves, and knowing which one you need is most of the work:

- **The code** is a redeploy of the previous image tag. Every image is complete and carries no
  state, so this is a minute and never a migration.
- **The content** is not in the image. A bad publish is undone in the CMS — Unpublish, or Discard
  back to the published version — and a deleted document comes back from point-in-time recovery on
  the table. Rolling the code back does not undo a publish, and should not.

There is no database migration step and no build-time data fetch, which is what makes both halves
independent.

---

## 6a. A container deploy with the store on a disk

The AWS shape above puts the store in DynamoDB and the operator seeds it from a checkout. A
single-node container deploy — a review environment, or a small install that does not want a table —
puts the store on a mounted disk instead, and that changes one thing worth stating: **the runtime
image carries no source, so `npm run seed` cannot run inside it.** That is deliberate (it is what
keeps the image to the standalone server and nothing else) and it means a volume-backed container
has no way to get its catalogue from the image alone.

So a deploy of that shape builds from the repository rather than from the Dockerfile, and seeds on
boot. `railway.json` describes it, so the deployment is in the repository rather than in a
dashboard:

```json
{
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "npm run seed && npm start",
    "healthcheckPath": "/api/ready"
  }
}
```

Seeding on every boot is safe and nearly free: `seedWorkspace()` leaves an existing document alone
unless `--force` is given, and `ensureFirstOwner()` creates an account only when the workspace has
no users at all. Set `STORE_DIR` to the mount path (`/data`), and the media library lands on the
same disk.

**The gap this leaves**, stated rather than left to be found: if you want the Dockerfile image
itself to seed a fresh volume, it needs a compiled seed entry point in the runtime stage. Nothing in
this build has one, because the AWS deploy this image was written for does not need it.

---

## 7. Environments

| | Development | Staging | Production |
| --- | --- | --- | --- |
| `APP_STAGE` | `development` | `staging` | `production` |
| Store | `file` (`.data/`) | DynamoDB, own table | DynamoDB |
| Media | `local` | S3, own bucket | S3 |
| Mail | `log` | `log` or SES sandbox | SES |
| Turnstile | off — the form says the check did not run | on | on, `TURNSTILE_REQUIRED=1` |
| `robots.txt` | disallow everything | disallow everything | allow, with the sitemap |

Staging disallowing everything is deliberate: an unpublished staging copy of a real business's site
outranking the real one is costly and entirely preventable.

---

## 8. What is not verified here

Stated rather than implied, because a green suite that quietly skips something is worse than no
suite:

- **No live AWS round trip has been made.** The DynamoDB, S3 and SES drivers are exercised against
  their request composition, and the SigV4 signer is pinned against AWS's own implementation
  (`test/unit/sigv4.test.ts`) — but the first real call on a deployed install is the first proof
  that the table name, the bucket policy and the SES identity are right. Run `/api/ready` after the
  first deploy and read the `faults` array.
- **No Cloudflare account was configured.** The cache and WAF rules above are the shape the
  application's own headers expect; they have not been applied to a zone.
- **The third-party photography was not fetched in the test environment.** The catalogue's images
  are on the agency's own domain and Unsplash, and this sandbox's egress policy refuses both, so the
  browser drives substitute bytes at the network layer. That the URLs are correct is checked; that
  they resolve is not.
