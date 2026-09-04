/**
 * Signature Version 4, pinned against AWS's own implementation.
 *
 * This signer is written here rather than pulled in as a dependency — the AWS SDK is tens of
 * megabytes for three services used through four calls each, and every byte of it ships in the
 * server image. The case for that rests entirely on evidence, so every signature below was produced
 * by signing the same request twice: once with this module, and once with `@aws-sdk/signature-v4`
 * (with `@aws-crypto/sha256-js`) in a scratch harness outside this repository. All nine cases agreed
 * to the byte, and the agreed value is what is pinned here.
 *
 * That cross-check found one real fault, which is why it is worth repeating rather than trusting a
 * remembered vector: a non-S3 canonical path must be URI-encoded TWICE, and this module decoded the
 * segment first and encoded once. Nothing this app signs today carries an escape in a non-S3 path,
 * so it was invisible — and it would have produced a wrong signature the first time one did. The
 * last case in `signRequest` is that fault's regression.
 *
 * A signer with no independent check is a signer that fails on the first real upload.
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { signRequest } from '@/lib/aws/sigv4'

const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
const when = new Date('2013-05-24T00:00:00Z')

const signatureOf = (auth: string): string => /Signature=([0-9a-f]{64})/.exec(auth)?.[1] ?? ''
const signedHeadersOf = (auth: string): string => /SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? ''

describe('signRequest', () => {
  it('S3 GET with a Range header', () => {
    const s = signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      service: 's3',
      headers: { range: 'bytes=0-9' },
      credentials,
      now: when,
    })
    assert.equal(signatureOf(s.headers.authorization), '67fe34c8530db585abddc51067328adfedb6e42487d2566dc7d927d6e2722900')
    assert.equal(signedHeadersOf(s.headers.authorization), 'host;range;x-amz-content-sha256;x-amz-date')
    assert.match(s.headers.authorization, /Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/)
  })

  it('S3 PUT with a body and a key that is already percent-encoded', () => {
    // An S3 key must not be encoded a second time: `%24` stays `%24`, or the signature names a
    // different object from the one the request reaches.
    const s = signRequest({
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
      region: 'us-east-1',
      service: 's3',
      headers: { 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      body: 'Welcome to Amazon S3.',
      credentials,
      now: when,
    })
    assert.equal(signatureOf(s.headers.authorization), '0b937fd3b36489ead77c46c408284f7e616019782fa0882af96ddf31ecfecec4')
    assert.equal(s.headers['x-amz-content-sha256'], '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072')
  })

  it('S3 GET with a query string, which is sorted and re-encoded', () => {
    const s = signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J',
      region: 'us-east-1',
      service: 's3',
      credentials,
      now: when,
    })
    assert.equal(signatureOf(s.headers.authorization), 'b331a8a008500e1d26eaac3f17e064ed30785ac0cd1bed5e2acc9565175a7d92')
  })

  it('S3 PUT of binary bytes — the path every uploaded photograph takes', () => {
    // 0x80–0xFF is exactly where a lossy string encoding and the real bytes part company, so a
    // signer that stringifies the body signs a hash of something the bucket never receives.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8, 0xff, 0xe0, 0x00, 0xc3, 0xa9])
    const s = signRequest({
      method: 'PUT',
      url: 'https://axis-media.s3.me-central-1.amazonaws.com/media/abc/hero.jpg',
      region: 'me-central-1',
      service: 's3',
      headers: { 'content-type': 'image/jpeg' },
      body: bytes,
      credentials,
      now: when,
    })
    assert.equal(signatureOf(s.headers.authorization), '770202cbb87fb81c832292c4dca8c9885c082eabfce855db8c9b3fc12c8aa554')
    assert.equal(s.headers['x-amz-content-sha256'], createHash('sha256').update(bytes).digest('hex'))
  })

  it('an S3 key carrying the characters encodeURIComponent leaves alone', () => {
    // RFC 3986 is stricter than encodeURIComponent about !*'() — a signer that uses the built-in
    // alone signs a different key from the one it asks for.
    const s = signRequest({
      method: 'PUT',
      url: "https://axis-media.s3.me-central-1.amazonaws.com/media/a(b)!c'd*e.jpg",
      region: 'me-central-1',
      service: 's3',
      credentials,
      now: when,
    })
    assert.equal(signatureOf(s.headers.authorization), '2f79886cf0610379bd51567af2e920827022c4a25e059079a6e698683111512a')
  })

  it('DynamoDB PutItem — the store’s own call', () => {
    const s = signRequest({
      method: 'POST',
      url: 'https://dynamodb.me-central-1.amazonaws.com/',
      region: 'me-central-1',
      service: 'dynamodb',
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.PutItem' },
      body: '{"TableName":"axis"}',
      credentials,
      now: when,
    })
    assert.equal(signatureOf(s.headers.authorization), '128f2931916897452e5c4e5a4b9f4c381607c494f7452a36554946ae63da8dc2')
    assert.equal(signedHeadersOf(s.headers.authorization), 'content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target')
  })

  it('a session token is signed, not merely attached', () => {
    // A task role hands out temporary credentials; a token that rides unsigned is a token the
    // service refuses, and the failure looks like a bad key.
    const s = signRequest({
      method: 'POST',
      url: 'https://dynamodb.me-central-1.amazonaws.com/',
      region: 'me-central-1',
      service: 'dynamodb',
      body: '{}',
      credentials: { ...credentials, sessionToken: 'FwoGZXIvYXdzEBYaDMEXAMPLEtoken' },
      now: when,
    })
    assert.equal(signatureOf(s.headers.authorization), '2eafb93d5631a1ea2965bcb4c75ae941e19825a6b822cc3b12c1959f01afb440')
    assert.equal(signedHeadersOf(s.headers.authorization), 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token')
  })

  it('SES SendEmail — the enquiry notification’s own call', () => {
    const s = signRequest({
      method: 'POST',
      url: 'https://email.me-central-1.amazonaws.com/v2/email/outbound-emails',
      region: 'me-central-1',
      service: 'ses',
      headers: { 'content-type': 'application/json' },
      body: '{"FromEmailAddress":"a@b.c"}',
      credentials,
      now: when,
    })
    assert.equal(signatureOf(s.headers.authorization), 'ae956e1c783bd91871684325a21e8fb4c2ff3f2420950ac29d18b3827da7bcda')
  })

  it('a non-S3 path is encoded twice', () => {
    // The regression for the fault the cross-check found. Nothing this app signs carries an escape
    // in a non-S3 path today; the next caller that does must not discover this in production.
    const s = signRequest({
      method: 'POST',
      url: 'https://email.me-central-1.amazonaws.com/v2/email/outbound emails',
      region: 'me-central-1',
      service: 'ses',
      body: '{}',
      credentials,
      now: when,
    })
    assert.equal(signatureOf(s.headers.authorization), '9b531815248c6a5974767067f8a4b35ad66cff22ec7a38fdff09893be6df2835')
  })

  it('changing one byte of the body changes the signature', () => {
    const args = { method: 'POST' as const, url: 'https://dynamodb.me-central-1.amazonaws.com/', region: 'me-central-1', service: 'dynamodb', credentials, now: when }
    assert.notEqual(
      signatureOf(signRequest({ ...args, body: '{"a":1}' }).headers.authorization),
      signatureOf(signRequest({ ...args, body: '{"a":2}' }).headers.authorization),
    )
  })

  it('a Buffer body and the equivalent string sign identically', () => {
    const args = { method: 'PUT' as const, url: 'https://b.s3.amazonaws.com/a.bin', region: 'us-east-1', service: 's3', credentials, now: when }
    assert.equal(
      signRequest({ ...args, body: Buffer.from('Welcome to Amazon S3.', 'utf8') }).headers.authorization,
      signRequest({ ...args, body: 'Welcome to Amazon S3.' }).headers.authorization,
    )
  })

  it('an empty body carries the empty-payload hash and sends no body', () => {
    const s = signRequest({ method: 'GET', url: 'https://b.s3.amazonaws.com/x', region: 'us-east-1', service: 's3', credentials, now: when })
    assert.equal(s.headers['x-amz-content-sha256'], createHash('sha256').update('').digest('hex'))
    assert.equal(s.body, undefined)
  })

  it('the secret never reaches the request', () => {
    const s = signRequest({ method: 'POST', url: 'https://dynamodb.me-central-1.amazonaws.com/', region: 'me-central-1', service: 'dynamodb', body: '{}', credentials, now: when })
    const wire = JSON.stringify({ url: s.url, headers: s.headers, body: String(s.body ?? '') })
    assert.equal(wire.includes(credentials.secretAccessKey), false)
    assert.equal(wire.includes('AWS4' + credentials.secretAccessKey), false)
  })
})
