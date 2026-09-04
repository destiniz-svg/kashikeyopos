/**
 * What "up to standard" means for a photograph or a video, in one place.
 *
 * Three callers need the same answer and must not disagree about it: the browser, which checks
 * before it spends a minute uploading; the server, which is the one that decides, because a check
 * only the client makes is not a check; and the CMS's video field, which probes a URL somebody
 * typed. A second copy of these numbers is how a file is accepted by one and refused by the other.
 *
 * Two levels, and the difference is deliberate:
 *
 *   REFUSE  the file cannot work anywhere on this site — the wrong type, past the byte cap, or
 *           smaller than the smallest rendition the site stores. Nothing is gained by keeping it.
 *   WARN    it will render, and it will not render well. A resort that only holds one photograph
 *           of its spa at 1200px still has that photograph, and refusing it would lose real
 *           content to a rule. So it is accepted, and the reason is said out loud — which is the
 *           whole of what was asked for: let somebody know when it is not up to size and quality.
 *
 * Nothing here reads configuration. The byte caps are the caller's (they are deployment limits,
 * not editorial ones) and arrive as arguments.
 */

export type MediaKind = 'image' | 'video'

/** The measurable facts about a file. `duration` is video-only; 0 means "not measured". */
export interface Measurement {
  kind: MediaKind
  mime: string
  /** Pixels of the largest rendition actually stored — never a figure the uploader asserted. */
  width: number
  height: number
  /** Bytes of the rendition these dimensions describe. */
  bytes: number
  /** Seconds. Video only. */
  duration?: number
  /** Bytes of the file the person chose, before any resizing. Reported, never enforced. */
  sourceBytes?: number
}

export type Level = 'refuse' | 'warn'

export interface Finding {
  level: Level
  /** Stable, for tests and logs. The sentence is for a person and may be reworded. */
  code: string
  says: string
}

export interface Verdict {
  ok: boolean
  findings: Finding[]
}

export const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const
export const VIDEO_MIME = ['video/mp4', 'video/webm'] as const

/**
 * The photograph standard.
 *
 * `wantLongEdge` is not a taste: 1600 is the width of the `hero` rendition this app stores, so a
 * source below it is enlarged on every full-bleed hero it is used in. `minLongEdge` is the `thumb`
 * rendition — below that a file is upscaled even in a 320px tile, which nothing can rescue.
 *
 * `minBytesPerPixel` is a detail proxy, and it is only meaningful because the rendition it is
 * measured on is always our own encoder at the same quality: a source that arrives soft or full of
 * compression artefacts re-encodes small. It is applied to JPEG only — a flat PNG logo is
 * legitimately tiny, and reading that as "poor quality" would be a rule about the wrong thing.
 */
export const IMAGE_STANDARD = {
  minLongEdge: 320,
  wantLongEdge: 1600,
  /** Beyond these the subject is cropped away in every slot the site draws. */
  minAspect: 0.25,
  maxAspect: 4,
  wantMinAspect: 0.6,
  wantMaxAspect: 2,
  minBytesPerPixel: 0.04,
} as const

/**
 * The video standard.
 *
 * A video on this site is one thing: the silent, looping, full-bleed hero behind a destination's
 * headline. So the numbers are that job's. Landscape, because the hero is; short, because it
 * loops; and small, because `Hero.tsx` already names the cost — a hero video is megabytes on
 * somebody's phone plan for something the poster image has already said.
 */
export const VIDEO_STANDARD = {
  // Both hero clips this site ships are 640-wide, and one of them is 640 × 338. A floor that
  // refuses what is on the live site is a floor in the wrong place: this one is a quarter of
  // 1080p, which is a wall-sized thumbnail and genuinely unusable. The shipped pair warn instead.
  minWidth: 480,
  minHeight: 270,
  wantWidth: 1280,
  wantHeight: 720,
  /** Seconds. Under two seconds is a stutter; a long clip is a film nobody waits for. */
  minSeconds: 2,
  maxSeconds: 300,
  wantMinSeconds: 5,
  wantMaxSeconds: 45,
  /** Bytes. Not a cap — the cap is deployment configuration — but what a hero should weigh. */
  wantBytes: 8 * 1024 * 1024,
} as const

/**
 * A size somebody can read.
 *
 * Always-megabytes is how a 200 KB limit came to be printed as "0 MB" in a refusal whose whole job
 * was to say what the limit is.
 */
export const bytesLabel = (n: number): string => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const px = (m: Measurement): string => `${m.width} × ${m.height}`

const refuse = (code: string, says: string): Finding => ({ level: 'refuse', code, says })
const warn = (code: string, says: string): Finding => ({ level: 'warn', code, says })

/**
 * Judge one file. `capBytes` is the deployment's own limit for this kind of media.
 *
 * A measurement of zero means "nobody could measure this", which is reported as unknown rather
 * than as a failure: a WebM whose dimensions this build cannot read is not thereby a bad video,
 * and saying it is would be an invented finding.
 */
export function judge(m: Measurement, capBytes: number): Verdict {
  const findings: Finding[] = m.kind === 'video' ? judgeVideo(m, capBytes) : judgeImage(m, capBytes)
  return { ok: !findings.some((f) => f.level === 'refuse'), findings }
}

function judgeImage(m: Measurement, capBytes: number): Finding[] {
  const out: Finding[] = []
  const S = IMAGE_STANDARD

  if (!(IMAGE_MIME as readonly string[]).includes(m.mime)) {
    out.push(refuse('type', 'That file is not a JPEG, PNG or WebP image'))
    return out
  }
  if (capBytes > 0 && m.bytes > capBytes) {
    out.push(refuse('bytes', `That image is ${bytesLabel(m.bytes)} — the limit is ${bytesLabel(capBytes)}`))
    return out
  }
  if (!m.width || !m.height) {
    out.push(refuse('unreadable', 'That image could not be read — it may be damaged or not really an image'))
    return out
  }

  const long = Math.max(m.width, m.height)
  const aspect = m.width / m.height

  if (long < S.minLongEdge) {
    out.push(refuse('tiny', `${px(m)} is smaller than the smallest size this site stores (${S.minLongEdge}px). It would be enlarged even in a thumbnail.`))
  } else if (long < S.wantLongEdge) {
    out.push(warn('small', `${px(m)} — a full-bleed hero is ${S.wantLongEdge}px wide, so this one is enlarged there. It is fine on cards and in a gallery.`))
  }

  if (aspect < S.minAspect || aspect > S.maxAspect) {
    out.push(refuse('shape', `${px(m)} is far too ${aspect > 1 ? 'wide' : 'tall'} for the shapes this site crops to — most of the picture would be cut away.`))
  } else if (aspect < S.wantMinAspect || aspect > S.wantMaxAspect) {
    out.push(warn('crop', `${px(m)} is an unusual shape — set the focal point so the crop keeps the subject.`))
  }

  // There is deliberately no separate megapixel warning. Every image it would have fired on is one
  // `small` or `crop` has already spoken about, and two sentences for one fault is how a warning
  // stops being read.

  // Measured on our own re-encode, at one quality, which is what makes the number comparable.
  if (m.mime === 'image/jpeg' && m.bytes > 0) {
    const bpp = m.bytes / (m.width * m.height)
    if (bpp < S.minBytesPerPixel) {
      out.push(warn('compressed', 'This looks like it has already been through heavy compression — it is soft or blocky for its size. Ask for the original file if you can.'))
    }
  }
  return out
}

function judgeVideo(m: Measurement, capBytes: number): Finding[] {
  const out: Finding[] = []
  const S = VIDEO_STANDARD

  if (!(VIDEO_MIME as readonly string[]).includes(m.mime)) {
    out.push(refuse('type', 'That file is not an MP4 or WebM video'))
    return out
  }
  if (capBytes > 0 && m.bytes > capBytes) {
    out.push(refuse('bytes', `That video is ${bytesLabel(m.bytes)} — the limit is ${bytesLabel(capBytes)}`))
    return out
  }

  if (m.width && m.height) {
    if (m.width < S.minWidth || m.height < S.minHeight) {
      out.push(refuse('tiny', `${px(m)} is below ${S.minWidth} × ${S.minHeight}. A hero video fills the screen, and this would be enlarged several times over.`))
    } else if (m.width < S.wantWidth || m.height < S.wantHeight) {
      out.push(warn('small', `${px(m)} — ${S.wantWidth} × ${S.wantHeight} or better is the standard for a full-screen hero.`))
    }
    if (m.height > m.width) {
      out.push(warn('portrait', `${px(m)} is portrait. The hero is a wide band, so a portrait clip is cropped to its middle third.`))
    }
  } else {
    out.push(warn('unmeasured', 'The size of this video could not be read here, so it has not been checked against the standard.'))
  }

  const secs = m.duration ?? 0
  if (secs > 0) {
    if (secs < S.minSeconds) {
      out.push(refuse('short', `${secs.toFixed(1)}s is too short to loop — it reads as a stutter rather than a scene.`))
    } else if (secs > S.maxSeconds) {
      out.push(refuse('long', `${Math.round(secs)}s is a film, not a hero loop. Trim it to ${S.wantMaxSeconds}s or less.`))
    } else if (secs < S.wantMinSeconds || secs > S.wantMaxSeconds) {
      out.push(warn('duration', `${Math.round(secs)}s — ${S.wantMinSeconds}–${S.wantMaxSeconds}s loops best.`))
    }
  }

  if (m.bytes > S.wantBytes) {
    out.push(warn('weight', `${bytesLabel(m.bytes)} is a lot to send to a phone. Under ${bytesLabel(S.wantBytes)} is the standard; re-export at a lower bitrate.`))
  }
  return out
}

/** One sentence for a toast, when there is no room for the list. */
export function summarise(v: Verdict): string {
  const bad = v.findings.filter((f) => f.level === 'refuse')
  if (bad.length) return bad[0].says
  const soft = v.findings.filter((f) => f.level === 'warn')
  if (!soft.length) return ''
  return soft.length === 1 ? soft[0].says : `${soft.length} things are below standard — ${soft[0].says}`
}
