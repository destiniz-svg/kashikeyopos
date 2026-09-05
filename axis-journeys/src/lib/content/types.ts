/**
 * The content domain. Shapes are `design_handoff_axis_journeys/DATA_MODEL.md` verbatim — tuple
 * fields stay tuples because the seed, the CMS editors and the public site all index them
 * positionally, and renaming them into objects here would fork the data model.
 */

export const THEMES = ['Honeymoon', 'Family', 'Adults Only', 'Luxury', 'All-Inclusive', 'Diving', 'Surfing', 'Wellness'] as const
export const PKGS = ['Beach Villa', 'Overwater Villa', 'Private Island', 'All-Inclusive Island', 'Dive & Surf Island'] as const
export const TIERS = ['Ultra-Luxury Collection', 'Luxury Collection', 'Five-Star Escapes', 'Premium Resorts'] as const
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const

export type Theme = (typeof THEMES)[number]
export type Pkg = (typeof PKGS)[number]
export type Tier = (typeof TIERS)[number]

/** `[label, title, detail]` */
export type Day = [string, string, string]
/**
 * `[name, meta, supplementUsd, img?, description?, features?, focalPos?, imgs?, imgsPos?]`
 *
 * `img` is the lead photograph — the one on the collapsed row and the one a card crops to. `imgs`
 * is every further photograph of the same room, in the order somebody chose; `imgsPos` is their
 * focal points, filled in by the resolver rather than stored. Appending rather than reshaping is
 * deliberate: the seed, the CMS and the site all read these positionally, so a document written
 * before this simply has nothing at index 7 and renders exactly as it did.
 */
export type Villa = [string, string, number, string?, string?, string[]?, string?, string[]?, string[]?]
/** `[mode, duration, supplementUsd]` */
export type Transfer = [string, string, number]
/** `[venue, cuisine, setting, img?, description?, tags?, focalPos?, imgs?, imgsPos?]` — see `Villa`. */
export type Venue = [string, string, string, string?, string?, string[]?, string?, string[]?, string[]?]
/** `[name, meta, description, treatments]` */
export type Spa = [string, string, string, string[]]
/** `[name, meta, houseReef, marineLife]` */
export type Dive = [string, string, string, string[]]
/** `[category, name, detail]` */
export type Experience = [string, string, string]
/** `[question, answer]` */
export type Faq = [string, string]
/** `[label, value]` */
export type Fact = [string, string]

export interface GalleryShot { img: string; cap: string; pos?: string }

/** `[lat, lng]`, decimal degrees. */
export type Geo = [number, number]
/** `[place, why it matters]` */
export type Nearby = [string, string]
/** `[title, source]` */
export type Award = [string, string]
/** `[window, entry USD, mid-tier USD]` — per couple, for the property's own `nights`. */
export type PriceWindow = [string, number, number]
/** `[low label, high label, position 0–100]` */
export type Scale = [string, string, number]

export interface Property {
  id: string
  dest: string
  name: string
  area: string
  nights: number
  tier: Tier | string
  pkg: Pkg | string
  themes: string[]
  /** "Speedboat · 45 min" — the first word drives the Transfer filter. */
  transferShort: string
  usd: number
  /** 1–12, the months this property is best in. */
  months: number[]
  bestFor?: string
  specialist?: string
  img: string
  credit?: string
  creditHref?: string
  photoHint?: string
  map?: string
  tags?: string[]
  verdict: string
  about?: string
  love?: string
  included?: string[]
  amenities?: string[]
  rooms?: string
  diningShort?: string
  board?: string
  checkin?: string
  children?: string
  reef?: string
  cancel?: string
  languages?: string
  days: Day[]
  villas: Villa[]
  transfers: Transfer[]
  dining?: Venue[]
  spa?: Spa | null
  dive?: Dive | null
  experiences?: Experience[]
  faq?: Faq[]
  facts?: Fact[]
  gallery?: GalleryShot[]

  /*
   * The property page (2026-09-05 handoff). Every one of these is optional and the page derives a
   * fallback for each, so a document written before them renders the same page — only with the
   * derived answer where a specialist has not given a better one. That is why none of them may
   * become required: an empty `awards` list is "nobody has verified an award", which is a
   * different fact from "this resort has none", and only the first may be silent.
   */
  /** `[lat, lng]` in decimal degrees. Positions the pin on the stylised atoll map. */
  geo?: Geo
  /** Axis-only package perks, labelled as such beside the derived inclusions. */
  exclusives?: string[]
  /** `[place, why it matters]` — proximity highlights. */
  nearby?: Nearby[]
  /** A muted hero loop. Falls back to the hero photograph. */
  video?: string
  /** "Conrad · Hilton" — the first segment drives the Brand filter; derived from the name when absent. */
  brand?: string
  /** The handle without the @. */
  instagram?: string
  /** `[title, source]`. Verified by a person before publishing — never derived. */
  awards?: Award[]
  /** `[window, entryUSD, midUSD]` per couple for `nights`; absent, the seasonal guide is derived. */
  pricing?: PriceWindow[]
  /** `[low label, high label, 0–100]` — the five comparison scales, where reading them is not enough. */
  scales?: Scale[]
  /** What is regularly seen here, where the profile's prose does not name it. */
  marine?: string[]
  /** Who the island suits, where the themes are too blunt to say it. */
  idealFor?: string[]
  /** Who should look elsewhere, and why. */
  notFor?: string[]

  /** Legacy stub flags. A document carrying either is never published. */
  draft?: boolean
  detailPending?: boolean
}

export interface Offer {
  id: string
  resort: string
  badge: string
  title?: string
  date: string
  /** 0 = valid in any month. */
  month: number
  label: string
  seats: string
  perk: string
  /** 0–1 */
  off: number
  /** USD */
  from?: number
  img?: string
}

export interface Destination {
  id: string
  name: string
  slug: string
  live: boolean
  tagline: string
  intro: string
  hero: string
  card: string
  video?: string
  videoCredit?: string
  /**
   * The destination page's own gallery. Left empty it falls back to the hero photograph of the
   * first few properties in that destination, which is what the page has always drawn — so this
   * adds an editorial choice without taking away the sensible default.
   */
  gallery?: GalleryShot[]
  facts: Fact[]
  highlights: string[]
  /** `[option, timing, detail]` */
  logistics: [string, string, string][]
  /** `[season, months, note]` */
  seasons: [string, string, string][]
}

export interface Homepage {
  id: 'main'
  heroVideo: 'Photo' | 'Maldives' | 'Sri Lanka' | 'UAE' | string
  heroPoster: string
  storyImg: string
  themeImages: [string, string][]
  voices: { quote: string; who: string; trip: string; img?: string }[]
  featuredOffer?: string
}

export interface LegalDoc { title: string; sections: [string, string][] }

export interface Settings {
  id: 'main'
  company: string
  licence: string
  phone: string
  phoneHref: string
  callUs: string
  whatsapp: string
  email: string
  address: string
  social: { instagram?: string; tiktok?: string; youtube?: string; facebook?: string }
  trust: [string, string][]
  howItWorks: [string, string][]
  vision: string
  mission: string
  promise: string
  story: string
  who: string
  team: string
  teamImg: string
  interests: string[]
  legal: { terms: LegalDoc; privacy: LegalDoc; cancel: LegalDoc; security: LegalDoc }
}

export type EnquiryStatus = 'new' | 'contacted' | 'quoted' | 'won' | 'closed'

export interface Enquiry {
  id: string
  status: EnquiryStatus
  name: string
  email: string
  phone: string
  month: string
  message: string
  party: string
  budget: string
  property: string
  propertyId: string
  offer: string
  shortlist: string[]
  source: string
  assignedTo: string
  notes: { by: string; at: number; text: string }[]
  createdAt: number
}

export interface MediaRecord {
  id: string
  /**
   * A record written before the library took video carries no kind at all. That is a real answer
   * rather than a gap — every one of them is an image — so readers ask `kindOf()` instead of
   * reading this field raw, and nothing had to be rewritten to introduce it.
   */
  kind?: 'image' | 'video'
  /** Seconds. Video only, and 0 where nothing could measure it. */
  duration?: number
  name: string
  alt: string
  credit: string
  focal: { x: number; y: number }
  w: number
  h: number
  bytes: number
  createdAt: number
  by: string
  /** Content type of the stored renditions — of the video itself on a video record. */
  mime: string
  /** What the standard said about it when it was uploaded, kept so the library can show it. */
  standard?: { level: 'refuse' | 'warn'; code: string; says: string }[]
}

/** Every record without a kind is an image; see the field's own note. */
export const kindOf = (m: Pick<MediaRecord, 'kind'> | null | undefined): 'image' | 'video' =>
  m?.kind === 'video' ? 'video' : 'image'

export type ContentCollection = 'properties' | 'offers' | 'destinations' | 'homepage' | 'settings'
export const CONTENT_COLLECTIONS: ContentCollection[] = ['properties', 'offers', 'destinations', 'homepage', 'settings']

export type DocStatus = 'draft' | 'changed' | 'published'

/** Every content document is a draft, an optional published copy, and its history. */
export interface Doc<T> {
  id: string
  draft: T
  live: T | null
  createdAt: number
  updatedAt: number
  updatedBy: string
  publishedAt: number | null
  /**
   * Where this document sits in its collection.
   *
   * The store lists a partition in sort-key order, which is alphabetical by id — and the order a
   * collection is in is a curatorial decision, not an accident of naming. The carousel, the
   * property grid and the offer grid all read it, so it is carried on the document rather than
   * re-derived from whatever the store happened to return.
   */
  order: number
}

export interface SiteBundle {
  properties: Property[]
  offers: Offer[]
  destinations: Destination[]
  homepage: Homepage
  settings: Settings
  generatedAt: number
  preview: boolean
}

export interface Lists {
  THEMES: string[]
  PKGS: string[]
  MONTHS: string[]
  TIERS: string[]
  SPECIALISTS: string[]
}

export interface ActivityEvent { id: string; at: number; by: string; what: string }
