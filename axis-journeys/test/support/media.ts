/**
 * Files for the media tests.
 *
 * The old fixture was a JPEG with a JFIF block and no frame header — enough for a sniffer that
 * only reads the first three bytes, and not an image: nothing in it says how big it is. That was
 * invisible while the server believed whatever dimensions the form asserted, and it is exactly
 * what the standard now refuses, so the fixture has to carry a real SOF0 like every camera's does.
 *
 * `logo.png` is used where a genuine, whole file matters. It is 1920 × 1007, which is a real
 * photograph's shape and comfortably over the standard.
 */
import { readFileSync } from 'node:fs'

/**
 * A JPEG whose header says exactly this size.
 *
 * SOI, a baseline SOF0 carrying the dimensions, padding, EOI. It is not decodable, and it does not
 * need to be: what is under test is the server reading a frame header out of bytes it was handed
 * rather than trusting a number in the form beside them.
 */
export function jpegOf(width: number, height: number, bytes = 90_000): Buffer {
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), sof])
  const pad = Math.max(0, bytes - head.length - 2)
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), Buffer.from([0xff, 0xd9])])
}

/** The default fixture: a hero-sized photograph that meets the standard with nothing to say. */
export const jpeg = (): Buffer => jpegOf(1600, 1067)

export const realPng = (): Buffer => readFileSync('public/assets/logo.png')
export const realMp4 = (name = 'uae.mp4'): Buffer => readFileSync(`public/assets/video/${name}`)

/** A multipart body. Buffers become files; strings become fields. */
export function form(parts: Record<string, Buffer | string | { bytes: Buffer; name: string; type: string }>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(parts)) {
    if (typeof v === 'string') f.set(k, v)
    else if (Buffer.isBuffer(v)) f.set(k, new File([new Uint8Array(v)], `${k}.jpg`, { type: 'image/jpeg' }))
    else f.set(k, new File([new Uint8Array(v.bytes)], v.name, { type: v.type }))
  }
  return f
}

/** The three picture renditions, all the same file. */
export const renditions = (b: Buffer, extra: Record<string, Buffer | string | { bytes: Buffer; name: string; type: string }> = {}): FormData =>
  form({ hero: b, card: b, thumb: b, ...extra })
