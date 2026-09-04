/**
 * AWS Signature Version 4, over node:crypto.
 *
 * Written here rather than pulled in as a dependency because the AWS SDK is tens of megabytes for
 * three services used through four calls each, and every byte of it ships in the server image. The
 * algorithm is a published specification and is exercised against AWS's own test vector in
 * `test/unit/sigv4.test.ts`.
 */
import { createHash, createHmac } from 'node:crypto'

export interface Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SignInput {
  method: string
  /** Absolute URL. The host header is taken from it. */
  url: string
  region: string
  service: string
  headers?: Record<string, string>
  /** A string for JSON APIs, a Buffer for binary uploads — the hash is over the bytes either way. */
  body?: string | Buffer
  credentials: Credentials
  /** Overridable so the test can pin a signature against a known vector. */
  now?: Date
}

const sha256 = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex')
const hmac = (key: Buffer | string, v: string): Buffer => createHmac('sha256', key).update(v).digest()

const stamp = (d: Date): { date: string; dateTime: string } => {
  const dateTime = d.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { date: dateTime.slice(0, 8), dateTime }
}

/** Percent-encode per RFC 3986, which is stricter than encodeURIComponent about `!*'()`. */
const uriEncode = (v: string): string =>
  encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

const canonicalPath = (pathname: string, service: string): string => {
  // S3 keys are already encoded in the URL and must not be encoded twice; every other service
  // encodes the path a SECOND time, which the specification states and which only shows up on a
  // segment that already carries an escape — cross-checked against AWS's own signer.
  if (service === 's3') return pathname || '/'
  return (
    '/' +
    pathname
      .split('/')
      .filter((_, i) => i > 0)
      .map((seg) => uriEncode(seg))
      .join('/')
  ).replace(/^\/\//, '/')
}

const canonicalQuery = (search: URLSearchParams): string =>
  [...search.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

export interface SignedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string | Buffer
}

/** Sign a request with headers (the form every API call in this app uses). */
export function signRequest(input: SignInput): SignedRequest {
  const url = new URL(input.url)
  const { date, dateTime } = stamp(input.now ?? new Date())
  const body = input.body ?? ''
  const payloadHash = sha256(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)

  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    host: url.host,
    'x-amz-date': dateTime,
    'x-amz-content-sha256': payloadHash,
  }
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken

  const signedHeaders = Object.keys(headers).sort()
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${headers[k].trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaderList = signedHeaders.join(';')

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname, input.service),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n')

  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', dateTime, scope, sha256(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, date)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, input.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex')

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`

  return { url: url.toString(), method: input.method.toUpperCase(), headers, body: body.length ? body : undefined }
}
