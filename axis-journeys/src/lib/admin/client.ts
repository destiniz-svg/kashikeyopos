'use client'

/**
 * The CMS's one API client.
 *
 * Every request carries `X-Requested-With: axis` — the header half of the CSRF fence the server
 * checks — and every failure comes back as an `ApiFailure` carrying the server's own sentence, so
 * a screen shows what was refused rather than "something went wrong".
 */
import type { ActivityEvent, ContentCollection, Doc, Enquiry, Lists, MediaRecord } from '../content/types'
import type { Role } from '../auth/roles'
import { judge, type Verdict } from '../media/standards'

/**
 * The caps the browser checks against.
 *
 * They are the same defaults `config.ts` applies, restated because configuration is a server fact
 * and this file runs in somebody's browser. Being generous here would only be a worse experience —
 * an upload that travels for a minute and is then refused — and never a way past the server, which
 * reads its own configured values.
 */
const IMAGE_CAP_BYTES = 10 * 1024 * 1024
const VIDEO_CAP_BYTES = 64 * 1024 * 1024

export interface ApiFailure extends Error {
  status: number
  fields?: Record<string, string>
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'X-Requested-With': 'axis',
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
    body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
    credentials: 'same-origin',
    ...init,
  })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; fields?: Record<string, string> }
    const err = new Error(payload.error || `Request failed (${res.status})`) as ApiFailure
    err.status = res.status
    err.fields = payload.fields
    throw err
  }
  return data as T
}

export interface SessionUser {
  id: string
  name: string
  email: string
  role: Role
  can: string[]
}

export type DocView<T = Record<string, unknown>> = Doc<T> & { status: 'draft' | 'changed' | 'published'; ready?: boolean; missing?: string[] }

export const api = {
  me: () => request<{ user: SessionUser | null }>('GET', '/auth/me'),
  login: (email: string, password: string) => request<{ user: SessionUser; expiresAt: number }>('POST', '/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),

  lists: () => request<Lists>('GET', '/lists'),
  activity: () => request<ActivityEvent[]>('GET', '/activity'),

  list: (col: ContentCollection) => request<DocView[]>('GET', `/${col}`),
  get: (col: ContentCollection, id: string) => request<DocView>('GET', `/${col}/${id}`),
  create: (col: ContentCollection, id: string, draft: Record<string, unknown>) => request<DocView>('POST', `/${col}`, { id, draft }),
  save: (col: ContentCollection, id: string, draft: Record<string, unknown>) => request<DocView>('PUT', `/${col}/${id}`, { draft }),
  publish: (col: ContentCollection, id: string) => request<DocView>('POST', `/${col}/${id}/publish`),
  unpublish: (col: ContentCollection, id: string) => request<DocView>('POST', `/${col}/${id}/unpublish`),
  discard: (col: ContentCollection, id: string) => request<DocView>('POST', `/${col}/${id}/discard`),
  remove: (col: ContentCollection, id: string) => request<{ ok: true }>('DELETE', `/${col}/${id}`),

  enquiries: () => request<Enquiry[]>('GET', '/enquiries'),
  patchEnquiry: (id: string, patch: Record<string, unknown>) => request<Enquiry>('PATCH', `/enquiries/${id}`, patch),
  deleteEnquiry: (id: string) => request<{ ok: true }>('DELETE', `/enquiries/${id}`),

  media: () => request<(MediaRecord & { urls: Record<string, string> })[]>('GET', '/media'),
  uploadMedia: (form: FormData) => request<MediaRecord & { ref: string; urls: Record<string, string>; standard: Verdict }>('POST', '/media', form),
  patchMedia: (id: string, patch: Record<string, unknown>) => request<MediaRecord>('PATCH', `/media/${id}`, patch),
  deleteMedia: (id: string) => request<{ ok: true }>('DELETE', `/media/${id}`),

  users: () => request<{ id: string; name: string; email: string; role: Role; createdAt: number; invited?: boolean }[]>('GET', '/users'),
  createUser: (body: { name: string; email: string; role: Role; password?: string }) => request<{ id: string }>('POST', '/users', body),
  patchUser: (id: string, patch: Record<string, unknown>) => request<{ id: string }>('PATCH', `/users/${id}`, patch),
  deleteUser: (id: string) => request<{ ok: true }>('DELETE', `/users/${id}`),
}

/**
 * The three renditions, made in the browser before upload.
 *
 * Doing it here rather than in a Lambda keeps this build free of a native image dependency, and
 * re-encoding through a canvas drops EXIF — including the GPS tags a resort's own photographer
 * may not have meant to hand over.
 *
 * Each of these answers a verdict as well as a form. It is the same `judge()` the server runs, on
 * the same subject the server judges, for one reason: so a person is told their file is below
 * standard BEFORE they wait for it to upload. It decides nothing — the server judges the bytes it
 * actually received, and a check only the client makes is not a check.
 */
export interface Prepared {
  form: FormData
  verdict: Verdict
}

const SIZES: [string, number][] = [
  ['hero', 1600],
  ['card', 800],
  ['thumb', 320],
]

/** Draw a source onto a canvas at each rendition size and append the encoded blobs to a form. */
async function appendRenditions(
  form: FormData,
  src: CanvasImageSource,
  width: number,
  height: number,
  keepAlpha: boolean,
): Promise<{ bytes: number; w: number; h: number }> {
  let hero = { bytes: 0, w: 0, h: 0 }
  for (const [name, size] of SIZES) {
    const scale = Math.min(1, size / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot resize images')
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      // A logo keeps its alpha; a photograph becomes a JPEG, which is a third of the bytes.
      canvas.toBlob(resolve, keepAlpha ? 'image/png' : 'image/jpeg', 0.84),
    )
    if (!blob) throw new Error('This browser could not encode the image')
    form.append(name, blob, `${name}.${keepAlpha ? 'png' : 'jpg'}`)
    if (name === 'hero') hero = { bytes: blob.size, w: canvas.width, h: canvas.height }
  }
  return hero
}

export async function renditions(file: File): Promise<Prepared> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) throw new Error('That file could not be read as an image')
  const keepAlpha = file.type === 'image/png'
  const form = new FormData()
  const hero = await appendRenditions(form, bitmap, bitmap.width, bitmap.height, keepAlpha)
  form.append('name', baseName(file))
  bitmap.close()
  return {
    form,
    verdict: judge(
      { kind: 'image', mime: keepAlpha ? 'image/png' : 'image/jpeg', width: hero.w, height: hero.h, bytes: hero.bytes, sourceBytes: file.size },
      IMAGE_CAP_BYTES,
    ),
  }
}

/**
 * A video, plus the poster frame this app needs to draw it anywhere.
 *
 * The frame is taken a moment in rather than at zero: the first frame of a clip is very often a
 * fade from black, and a black poster is indistinguishable from a video that failed to load.
 * Nothing here transcodes — the file is uploaded as it is, which is why the standard's advice is
 * to re-export rather than promising the site will fix it.
 */
export async function videoRenditions(file: File): Promise<Prepared> {
  const url = URL.createObjectURL(file)
  const v = document.createElement('video')
  v.preload = 'metadata'
  v.muted = true
  v.playsInline = true
  v.crossOrigin = 'anonymous'
  try {
    const meta = await videoMetadata(v, url)
    const form = new FormData()
    await seek(v, Math.min(1.5, (meta.duration || 1) / 3))
    await appendRenditions(form, v, meta.width || 1280, meta.height || 720, false)
    form.append('video', file, file.name)
    form.append('name', baseName(file))
    return {
      form,
      verdict: judge(
        { kind: 'video', mime: file.type || 'video/mp4', width: meta.width, height: meta.height, bytes: file.size, duration: meta.duration },
        VIDEO_CAP_BYTES,
      ),
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Check a video the CMS has only been given the address of.
 *
 * The destination hero can name a file under `/assets` or somebody else's URL, and neither goes
 * through the upload door — so without this the one video a guest actually watches is the one
 * nothing ever checked. It reports what the browser can measure and says plainly when it cannot:
 * a cross-origin server that sends no CORS header will not let a page read its dimensions, and
 * claiming a pass there would be a check that never ran.
 */
export async function probeVideoUrl(url: string): Promise<Verdict> {
  const v = document.createElement('video')
  v.preload = 'metadata'
  v.muted = true
  v.crossOrigin = 'anonymous'
  const meta = await videoMetadata(v, url).catch(() => null)
  if (!meta) {
    return { ok: false, findings: [{ level: 'refuse', code: 'unreachable', says: 'That video could not be loaded from this address. Check the link, and that the server allows it to be played here.' }] }
  }
  // Only a same-origin file can be weighed; a foreign host may refuse the request outright.
  let bytes = 0
  try {
    const head = await fetch(url, { method: 'HEAD' })
    bytes = Number(head.headers.get('content-length') || 0)
  } catch {
    /* a cross-origin host that refuses HEAD leaves the weight unknown, which is reported as such */
  }
  const verdict = judge({ kind: 'video', mime: 'video/mp4', width: meta.width, height: meta.height, bytes, duration: meta.duration }, 0)
  if (!bytes) {
    verdict.findings.push({ level: 'warn', code: 'unweighed', says: 'The file size could not be read from this address, so it has not been checked against what a phone should download.' })
  }
  return verdict
}

interface VideoMeta { width: number; height: number; duration: number }

function videoMetadata(v: HTMLVideoElement, url: string): Promise<VideoMeta> {
  return new Promise<VideoMeta>((resolve, reject) => {
    const done = window.setTimeout(() => reject(new Error('That video took too long to respond')), 20_000)
    v.onloadedmetadata = () => {
      window.clearTimeout(done)
      resolve({ width: v.videoWidth, height: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : 0 })
    }
    v.onerror = () => {
      window.clearTimeout(done)
      reject(new Error('That video could not be read — this browser may not play the format'))
    }
    v.src = url
  })
}

function seek(v: HTMLVideoElement, to: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const go = () => resolve()
    v.onseeked = go
    // A clip that refuses to seek still has its first frame, which is better than no poster.
    window.setTimeout(go, 4000)
    try {
      v.currentTime = to
    } catch {
      go()
    }
  })
}

const baseName = (f: File): string => f.name.replace(/\.[^.]+$/, '')
