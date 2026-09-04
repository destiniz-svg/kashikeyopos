/**
 * Media storage: one seam, two drivers (S3 for the deployed install, the filesystem for local and
 * CI). Content references media as `media:{id}`; the resolver turns that into a URL at the edge of
 * the app, so no document ever stores a hostname that a domain move would invalidate.
 *
 * The three renditions are produced in the browser before upload — canvas at 1600 / 800 / 320,
 * exactly the sizes in `admin/API.md`. Doing it there rather than in a Lambda is what keeps this
 * build free of a native image dependency, and it has a security dividend SECURITY.md asks for:
 * re-encoding through a canvas drops EXIF and its GPS tags.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { signRequest } from '../aws/sigv4'
import { config } from '../config'
import { log } from '../http/log'

export const SIZES = { hero: 1600, card: 800, thumb: 320 } as const
export type Size = keyof typeof SIZES
export const isSize = (v: string): v is Size => v === 'hero' || v === 'card' || v === 'thumb'

/** The only content types accepted. A rendition is always a JPEG; a logo may keep its alpha. */
export const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

export interface MediaStore {
  put(id: string, size: Size, bytes: Buffer, mime: string): Promise<void>
  get(id: string, size: Size): Promise<{ bytes: Buffer; mime: string } | null>
  remove(id: string): Promise<void>
  /** Where the browser should fetch this rendition from. */
  url(id: string, size: Size): string
  health(): Promise<{ ok: boolean; detail: string }>
}

const ext = (mime: string): string => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg')

class LocalMediaStore implements MediaStore {
  private readonly dir: string
  constructor(dir: string) {
    this.dir = resolve(dir, 'media')
  }
  private path(id: string, size: Size, e: string): string {
    // Ids are minted here, but they reach a path, so anything that is not a plain id is refused
    // rather than encoded — a traversal is not a filename with a slash in it, it is a bug.
    if (!/^[a-z0-9]+$/i.test(id)) throw new Error('bad media id')
    // The bundler traces `path.join` on a non-literal as "this route reads the whole project".
    // It does not: the directory is configuration and the filename is an id this module minted.
    return join(/* turbopackIgnore: true */ this.dir, `${id}.${size}.${e}`)
  }
  async put(id: string, size: Size, bytes: Buffer, mime: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.path(id, size, ext(mime)), bytes)
  }
  async get(id: string, size: Size): Promise<{ bytes: Buffer; mime: string } | null> {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      try {
        return { bytes: await readFile(this.path(id, size, ext(mime))), mime }
      } catch {
        /* try the next encoding */
      }
    }
    return null
  }
  async remove(id: string): Promise<void> {
    for (const size of Object.keys(SIZES) as Size[]) {
      for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
        try {
          await unlink(this.path(id, size, ext(mime)))
        } catch {
          /* already gone */
        }
      }
    }
  }
  url(id: string, size: Size): string {
    return `/api/media/${id}/${size}`
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await mkdir(this.dir, { recursive: true })
      return { ok: true, detail: `local media at ${this.dir}` }
    } catch (e) {
      return { ok: false, detail: `local media at ${this.dir} is not writable: ${(e as Error).message}` }
    }
  }
}

class S3MediaStore implements MediaStore {
  private readonly bucket: string
  private readonly region: string
  private readonly fetchImpl: typeof fetch

  constructor(bucket: string, region: string, fetchImpl: typeof fetch = fetch) {
    this.bucket = bucket
    this.region = region
    this.fetchImpl = fetchImpl
  }

  private key(id: string, size: Size, mime: string): string {
    return `${id}/${size}.${ext(mime)}`
  }
  private endpoint(key: string): string {
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`
  }
  private creds() {
    return {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
      sessionToken: config.aws.sessionToken || undefined,
    }
  }

  async put(id: string, size: Size, bytes: Buffer, mime: string): Promise<void> {
    const key = this.key(id, size, mime)
    const signed = signRequest({
      method: 'PUT',
      url: this.endpoint(key),
      region: this.region,
      service: 's3',
      headers: { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable' },
      body: bytes,
      credentials: this.creds(),
    })
    const res = await this.fetchImpl(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(bytes) })
    if (!res.ok) {
      const detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
      log.error('media', `S3 refused the upload (HTTP ${res.status})`, { key, detail })
      throw new Error(`Could not store that image (HTTP ${res.status})`)
    }
  }

  async get(id: string, size: Size): Promise<{ bytes: Buffer; mime: string } | null> {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      const signed = signRequest({
        method: 'GET',
        url: this.endpoint(this.key(id, size, mime)),
        region: this.region,
        service: 's3',
        credentials: this.creds(),
      })
      const res = await this.fetchImpl(signed.url, { method: 'GET', headers: signed.headers })
      if (res.ok) return { bytes: Buffer.from(await res.arrayBuffer()), mime }
    }
    return null
  }

  async remove(id: string): Promise<void> {
    for (const size of Object.keys(SIZES) as Size[]) {
      for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
        const signed = signRequest({
          method: 'DELETE',
          url: this.endpoint(this.key(id, size, mime)),
          region: this.region,
          service: 's3',
          credentials: this.creds(),
        })
        await this.fetchImpl(signed.url, { method: 'DELETE', headers: signed.headers }).catch(() => undefined)
      }
    }
  }

  url(id: string, size: Size): string {
    // A CDN in front of the bucket is the deployed shape; without one the app proxies, which works
    // and says so by being the slower path rather than by failing.
    return config.mediaOrigin ? `${config.mediaOrigin}/${id}/${size}.jpg` : `/api/media/${id}/${size}`
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.bucket) return { ok: false, detail: 'MEDIA_S3_BUCKET is not set' }
    if (!config.aws.accessKeyId) return { ok: false, detail: 'no AWS credentials are set for the media bucket' }
    return { ok: true, detail: `s3 bucket ${this.bucket} in ${this.region}` }
  }
}

let store: MediaStore | null = null

export function getMediaStore(): MediaStore {
  if (!store) {
    store = config.media.driver === 's3'
      ? new S3MediaStore(config.media.bucket, config.media.region)
      : new LocalMediaStore(config.store.dir)
  }
  return store
}

export function setMediaStore(s: MediaStore | null): void {
  store = s
}

// ---------------------------------------------------------------- reference resolution

export const MEDIA_PREFIX = 'media:'
export const isMediaRef = (v: unknown): v is string => typeof v === 'string' && v.startsWith(MEDIA_PREFIX)
export const mediaId = (ref: string): string => ref.slice(MEDIA_PREFIX.length)
