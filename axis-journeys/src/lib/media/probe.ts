/**
 * Reading a file's real dimensions out of its own bytes, on the server.
 *
 * The uploader tells us how big its picture is. That is a courtesy, not evidence — the same rule
 * this build already keeps for a content type, where the magic bytes decide and the header only
 * says what the client claims. So the standard is judged against what is actually in the bytes
 * that were stored.
 *
 * Header fields only: no decoding, no dependency, and a few dozen bytes read out of each file.
 * Everything here answers `null` rather than throwing — a container this build cannot read is an
 * unknown, and reporting an unknown as a fault would be an invented finding.
 */

export interface Dimensions { width: number; height: number }

export function imageDimensions(b: Buffer, mime: string): Dimensions | null {
  try {
    if (mime === 'image/jpeg') return jpeg(b)
    if (mime === 'image/png') return png(b)
    if (mime === 'image/webp') return webp(b)
  } catch {
    /* a truncated or malformed file is an unknown, not a crash */
  }
  return null
}

function jpeg(b: Buffer): Dimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = b.readUInt16BE(i + 2)
    // SOF0–SOF15 carry the frame header; DHT (c4), JPG (c8) and DAC (cc) do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

function png(b: Buffer): Dimensions | null {
  if (b.length < 24 || b.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function webp(b: Buffer): Dimensions | null {
  if (b.length < 30 || b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WEBP') return null
  const chunk = b.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8X') return { width: (b.readUIntLE(24, 3) & 0xffffff) + 1, height: (b.readUIntLE(27, 3) & 0xffffff) + 1 }
  if (chunk === 'VP8 ') {
    // Key-frame start code, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

// ---------------------------------------------------------------- video

export interface VideoFacts extends Partial<Dimensions> { seconds?: number }

/**
 * MP4 only, and deliberately so.
 *
 * Both videos this site ships are MP4 and it is what a camera and every editor produce. WebM's
 * EBML is a second parser for a container nobody here has used; rather than write one badly, a
 * WebM answers `{}` and the standard reports its size as unmeasured — which is true, and says so
 * on the screen, instead of quietly passing a check that never ran.
 */
export function videoFacts(b: Buffer, mime: string): VideoFacts {
  if (mime !== 'video/mp4') return {}
  try {
    const moov = findBox(b, 0, b.length, 'moov')
    if (!moov) return {}
    const out: VideoFacts = {}
    const mvhd = findBox(b, moov.start, moov.end, 'mvhd')
    if (mvhd) {
      const v = b[mvhd.start]
      const timescale = v === 1 ? b.readUInt32BE(mvhd.start + 20) : b.readUInt32BE(mvhd.start + 12)
      const duration = v === 1 ? Number(b.readBigUInt64BE(mvhd.start + 24)) : b.readUInt32BE(mvhd.start + 16)
      if (timescale > 0 && duration > 0) out.seconds = duration / timescale
    }
    // A file has one track per stream; the audio track's tkhd carries 0 × 0, so the widest wins.
    for (const trak of eachBox(b, moov.start, moov.end, 'trak')) {
      const tkhd = findBox(b, trak.start, trak.end, 'tkhd')
      if (!tkhd || tkhd.end - tkhd.start < 8) continue
      // width and height are the last two fields of the box, as 16.16 fixed point.
      const w = b.readUInt32BE(tkhd.end - 8) / 65536
      const h = b.readUInt32BE(tkhd.end - 4) / 65536
      if (w > 0 && h > 0 && w * h > (out.width ?? 0) * (out.height ?? 0)) {
        out.width = Math.round(w)
        out.height = Math.round(h)
      }
    }
    return out
  } catch {
    return {}
  }
}

interface Box { start: number; end: number }

/** Walk the boxes between `from` and `to`, yielding each one whose type matches. */
function* eachBox(b: Buffer, from: number, to: number, type: string): Generator<Box> {
  let i = from
  let guard = 0
  while (i + 8 <= to && guard++ < 4096) {
    let size = b.readUInt32BE(i)
    let head = 8
    if (size === 1) {
      if (i + 16 > to) return
      size = Number(b.readBigUInt64BE(i + 8))
      head = 16
    } else if (size === 0) {
      size = to - i
    }
    if (size < head || i + size > to) return
    if (b.subarray(i + 4, i + 8).toString('latin1') === type) yield { start: i + head, end: i + size }
    i += size
  }
}

/** The first box of this type at this level. `mvhd` and `trak` are children of `moov`, and
 * `tkhd` is a child of `trak`, so nothing here needs to descend further than its caller does. */
function findBox(b: Buffer, from: number, to: number, type: string): Box | null {
  for (const box of eachBox(b, from, to, type)) return box
  return null
}
