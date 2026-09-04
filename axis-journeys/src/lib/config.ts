/**
 * One place that reads the environment. Nothing else in the app touches `process.env`, so a missing
 * variable is named at boot rather than discovered as `undefined` three screens in, and no
 * infrastructure value is hard-coded anywhere in application code.
 */

type Stage = 'development' | 'staging' | 'production'

const raw = (k: string): string => {
  const v = process.env[k]
  if (v == null) return ''
  const s = String(v).trim()
  // A platform resolves an unknown same-service reference to an empty string, but some leave the
  // literal. Either way it is not a value — treat `${{...}}` as unset rather than as a secret.
  if (/^\$\{\{.*\}\}$/.test(s)) return ''
  return s
}

const bool = (k: string, dflt = false): boolean => {
  const v = raw(k)
  if (!v) return dflt
  return v === '1' || v.toLowerCase() === 'true'
}

const num = (k: string, dflt: number): number => {
  const v = Number(raw(k))
  return Number.isFinite(v) && v > 0 ? v : dflt
}

const stage = ((): Stage => {
  const v = raw('APP_STAGE').toLowerCase()
  if (v === 'production' || v === 'staging' || v === 'development') return v
  return process.env.NODE_ENV === 'production' ? 'production' : 'development'
})()

const isProd = stage === 'production'

export const config = {
  stage,
  isProd,
  /** Canonical public origin. Every absolute URL (OG, sitemap, invitation links) derives from it. */
  siteUrl: raw('SITE_URL') || 'http://localhost:3000',
  apiOrigin: raw('API_ORIGIN'), // set only when the API is deployed on its own hostname
  mediaOrigin: raw('MEDIA_ORIGIN'), // e.g. https://media.axisjourneys.com

  /** Document store. `file` is the local/CI driver; `dynamodb` is the deployed one. */
  store: {
    driver: (raw('STORE_DRIVER') || (isProd ? 'dynamodb' : 'file')) as 'file' | 'dynamodb',
    dir: raw('STORE_DIR') || '.data',
    table: raw('DYNAMODB_TABLE'),
    region: raw('AWS_REGION') || 'me-central-1',
  },

  /** Media store. `local` writes under STORE_DIR; `s3` presigns to a bucket. */
  media: {
    driver: (raw('MEDIA_DRIVER') || (isProd ? 's3' : 'local')) as 'local' | 's3',
    bucket: raw('MEDIA_S3_BUCKET'),
    region: raw('MEDIA_S3_REGION') || raw('AWS_REGION') || 'me-central-1',
    maxBytes: num('MEDIA_MAX_BYTES', 10 * 1024 * 1024),
  },

  aws: {
    accessKeyId: raw('AWS_ACCESS_KEY_ID'),
    secretAccessKey: raw('AWS_SECRET_ACCESS_KEY'),
    sessionToken: raw('AWS_SESSION_TOKEN'),
  },

  /** Outbound mail. Unconfigured, the app says so rather than pretending a message was sent. */
  mail: {
    driver: (raw('MAIL_DRIVER') || (raw('SES_FROM') ? 'ses' : 'log')) as 'log' | 'ses',
    from: raw('SES_FROM') || 'no-reply@axisjourneys.com',
    region: raw('SES_REGION') || raw('AWS_REGION') || 'me-central-1',
    /** Where a new enquiry is announced. Falls back to the company inbox in settings. */
    notify: raw('ENQUIRY_NOTIFY_EMAIL'),
  },

  /** Cloudflare Turnstile. Without a secret the verifier says so and the form still works. */
  turnstile: {
    siteKey: raw('NEXT_PUBLIC_TURNSTILE_SITE_KEY'),
    secret: raw('TURNSTILE_SECRET_KEY'),
    required: bool('TURNSTILE_REQUIRED', isProd),
  },

  auth: {
    /** HMAC key for CMS session tokens. Refused at boot in production when absent or short. */
    secret: raw('SESSION_SECRET'),
    ttlHours: num('SESSION_TTL_HOURS', 12),
    cookieName: 'axis_session',
    /** Seeds the first owner account when the workspace is empty. */
    ownerEmail: raw('ADMIN_OWNER_EMAIL'),
    ownerPassword: raw('ADMIN_OWNER_PASSWORD'),
    ownerName: raw('ADMIN_OWNER_NAME') || 'Axis Owner',
  },

  limits: {
    /** Multiplies every rate-limit ceiling. The suite runs from one loopback address. */
    scale: num('RATE_LIMIT_SCALE', 1),
  },

  /** Public bundle cache. Serving `/api/public/site` from memory keeps the hot path off the store. */
  bundleTtlMs: num('BUNDLE_TTL_MS', 60_000),
  logLevel: (raw('LOG_LEVEL') || (isProd ? 'info' : 'debug')) as 'debug' | 'info' | 'warn' | 'error',
} as const

/** Configuration faults that must stop a production boot rather than surface as a 500 later. */
export function configFaults(): string[] {
  const bad: string[] = []
  if (!config.isProd) return bad
  if (config.auth.secret.length < 32) bad.push('SESSION_SECRET must be set to at least 32 characters')
  if (config.store.driver === 'dynamodb' && !config.store.table) bad.push('DYNAMODB_TABLE must name the table')
  if (config.media.driver === 's3' && !config.media.bucket) bad.push('MEDIA_S3_BUCKET must name the bucket')
  if (config.turnstile.required && !config.turnstile.secret) bad.push('TURNSTILE_SECRET_KEY is required when TURNSTILE_REQUIRED=1')
  if (!config.siteUrl.startsWith('https://')) bad.push('SITE_URL must be the https origin this site is served from')
  return bad
}
