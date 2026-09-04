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
  uploadMedia: (form: FormData) => request<MediaRecord & { ref: string; urls: Record<string, string> }>('POST', '/media', form),
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
 */
export async function renditions(file: File): Promise<{ form: FormData; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  const keepAlpha = file.type === 'image/png'
  const form = new FormData()
  for (const [name, size] of Object.entries({ hero: 1600, card: 800, thumb: 320 })) {
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot resize images')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      // A logo keeps its alpha; a photograph becomes a JPEG, which is a third of the bytes.
      canvas.toBlob(resolve, keepAlpha ? 'image/png' : 'image/jpeg', 0.84),
    )
    if (!blob) throw new Error('This browser could not encode the image')
    form.append(name, blob, `${name}.${keepAlpha ? 'png' : 'jpg'}`)
  }
  form.append('name', file.name.replace(/\.[^.]+$/, ''))
  form.append('w', String(bitmap.width))
  form.append('h', String(bitmap.height))
  form.append('bytes', String(file.size))
  bitmap.close()
  return { form, width: bitmap.width, height: bitmap.height }
}
