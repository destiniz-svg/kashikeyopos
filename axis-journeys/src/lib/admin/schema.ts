/**
 * The CMS editor schema, ported from `sections()` in `prototype/Axis Admin.dc.html`.
 *
 * Every field, label, placeholder, hint and help sentence is the prototype's own — those strings
 * are how a specialist knows what a field is for, and they were written alongside the site that
 * consumes them. The editor is generic over this table, so adding a field is a line here rather
 * than a new screen.
 */
import type { ContentCollection, Lists } from '../content/types'

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'percent'
  | 'select'
  | 'chips'
  | 'months'
  | 'tags'
  | 'image'
  | 'images'
  | 'video'
  | 'list'

export interface Choice {
  v: string | number
  l: string
}

export interface ListColumn {
  /** Present on object-shaped rows (gallery, voices); absent on tuple rows. */
  key?: string
  label: string
  type?: FieldType
  ph?: string
  span?: string
  /**
   * Which slot of a tuple row this column edits, when it is not the column's own position.
   *
   * A villa is `[name, meta, supplement, img, description, features, focalPos, imgs]` and slot 6
   * is written by the media resolver rather than by a person — so the column that edits slot 7
   * has to say so. The alternative is a dummy column standing in for a field nobody edits, which
   * is a row in the editor that exists to make an index line up.
   */
  at?: number
}

export interface Field {
  path: string
  label: string
  type?: FieldType
  req?: boolean
  ph?: string
  hint?: string
  rows?: number
  span?: string
  options?: Choice[]
  choices?: string[]
  cols?: ListColumn[]
  addLabel?: string
  /** A list that holds exactly one row (spa, dive centre). */
  single?: boolean
}

export interface Section {
  key: string
  title: string
  help?: string
  fields: Field[]
}

export interface SchemaContext {
  lists: Lists
  /** Destination names, for the property's Destination select. */
  destinations: { name: string }[]
  /** Published and draft properties, for the offer's Property select. */
  properties: { id: string; name: string; dest: string }[]
}

const opt = (a: string[]): Choice[] => a.map((x) => ({ v: x, l: x }))
const imgCol: ListColumn = { label: 'Lead photo', type: 'image', span: '1/-1' }
/** Slot 7 of a villa or venue row; slot 6 is the resolver's focal position. */
const moreCol: ListColumn = { label: 'More photos', type: 'images', span: '1/-1', at: 7 }

export function sectionsFor(col: ContentCollection, ctx: SchemaContext): Section[] {
  const L = ctx.lists
  const destOpts: Choice[] = ctx.destinations.map((d) => ({ v: d.name, l: d.name }))

  if (col === 'properties')
    return [
      {
        key: 'basics',
        title: 'Basics',
        help: 'What it is, where it is and who it suits. These fields drive the cards, filters and search on the site.',
        fields: [
          { path: 'name', label: 'Property name', req: true, ph: 'e.g. Amara Atoll Reserve' },
          { path: 'dest', label: 'Destination', type: 'select', options: destOpts, req: true },
          { path: 'area', label: 'Area / atoll / region', req: true, ph: 'Noonu Atoll' },
          { path: 'tier', label: 'Tier', type: 'select', options: opt(L.TIERS) },
          { path: 'pkg', label: 'Package type', type: 'select', options: opt(L.PKGS) },
          { path: 'nights', label: 'Suggested nights', type: 'number' },
          { path: 'themes', label: 'Themes', type: 'chips', choices: L.THEMES, span: '1/-1', hint: 'Powers the Experiences filters' },
          { path: 'bestFor', label: 'Best for', ph: 'Couples · Families · Divers' },
          { path: 'specialist', label: 'Specialist', type: 'select', options: opt(L.SPECIALISTS) },
          { path: 'months', label: 'Best months', type: 'months', span: '1/-1' },
          { path: 'usd', label: 'Reference rate USD per couple', type: 'number', hint: 'Only shown inside offers' },
        ],
      },
      {
        key: 'arrival',
        title: 'Arrival & transfers',
        help: 'How guests get there. The first transfer is the default; supplements are added to offer rates.',
        fields: [
          { path: 'transferShort', label: 'Transfer summary', req: true, ph: 'Seaplane · 45 min' },
          {
            path: 'transfers',
            label: 'Transfer options',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add transfer',
            cols: [
              { label: 'Mode', ph: 'Seaplane' },
              { label: 'Duration · note', ph: '45 min · shared cabin' },
              { label: 'Supplement USD (− for saving)', type: 'number' },
            ],
          },
        ],
      },
      {
        key: 'story',
        title: 'Story & itinerary',
        help: 'The specialist voice. Verdict appears on the card hover and at the top of the profile; the itinerary is the day-by-day guests scroll first.',
        fields: [
          { path: 'verdict', label: "Specialist's verdict", type: 'textarea', req: true, rows: 3, span: '1/-1', ph: 'Two honest sentences — who it is for and who it is not for.' },
          { path: 'about', label: 'About the property', type: 'textarea', rows: 5, span: '1/-1' },
          { path: 'love', label: 'Why we love it', type: 'textarea', rows: 2, span: '1/-1' },
          {
            path: 'days',
            label: 'Day by day',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add day',
            cols: [{ label: 'Label', ph: 'Day 2' }, { label: 'Title', ph: 'House reef' }, { label: 'Detail', type: 'textarea', span: '1/-1' }],
          },
        ],
      },
      {
        key: 'rooms',
        title: 'Accommodation',
        help: 'Each room type gets its photographs, a short description and a feature list. The lead photo is the one on the room list; the rest open as a gallery. Supplement is added on top of the offer rate; 0 = included.',
        fields: [
          { path: 'rooms', label: 'Summary', ph: '38 villas' },
          {
            path: 'villas',
            label: 'Room types',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add room type',
            req: true,
            cols: [
              { label: 'Name', ph: 'Beach Pool Villa' },
              { label: 'Meta', ph: '210 sqm · 2 guests · private pool' },
              { label: 'Supplement USD', type: 'number' },
              imgCol,
              { label: 'Description', type: 'textarea', span: '1/-1' },
              { label: 'Features', type: 'tags', span: '1/-1' },
              moreCol,
            ],
          },
        ],
      },
      {
        key: 'dining',
        title: 'Dining',
        help: 'Venues with cuisine, setting, photographs and hours or inclusion tags. The lead photo is the one on the venue list; the rest open as a gallery.',
        fields: [
          { path: 'diningShort', label: 'Summary', ph: '4 venues · 1 bar' },
          { path: 'board', label: 'Board basis', ph: 'Half board included · Full board available' },
          {
            path: 'dining',
            label: 'Venues',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add venue',
            cols: [
              { label: 'Venue', ph: 'Lagoon Grill' },
              { label: 'Cuisine', ph: 'Wood-fire seafood' },
              { label: 'Setting', ph: 'Overwater deck' },
              imgCol,
              { label: 'Description', type: 'textarea', span: '1/-1' },
              { label: 'Hours / tags', type: 'tags', span: '1/-1' },
              moreCol,
            ],
          },
        ],
      },
      {
        key: 'photos',
        title: 'Photography',
        help: 'The hero photo is used on cards and at the top of the profile. Six gallery images is the sweet spot.',
        fields: [
          { path: 'img', label: 'Hero photo', type: 'image', req: true, span: '1/-1' },
          { path: 'photoHint', label: 'Caption', ph: 'Amara Atoll Reserve · overwater villa at dusk' },
          { path: 'credit', label: 'Photo credit' },
          {
            path: 'gallery',
            label: 'Gallery',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add photo',
            cols: [{ key: 'img', label: 'Photo', type: 'image' }, { key: 'cap', label: 'Caption' }],
          },
        ],
      },
      {
        key: 'wellness',
        title: 'Spa & marine',
        help: 'Leave the dive centre empty for land properties — the site hides the section.',
        fields: [
          {
            path: 'spa',
            label: 'Spa',
            type: 'list',
            single: true,
            span: '1/-1',
            addLabel: 'Add spa',
            cols: [
              { label: 'Name' },
              { label: 'Meta', ph: 'Six overwater pavilions · resident doctor' },
              { label: 'Description', type: 'textarea', span: '1/-1' },
              { label: 'Signature treatments', type: 'tags', span: '1/-1' },
            ],
          },
          {
            path: 'dive',
            label: 'Dive centre',
            type: 'list',
            single: true,
            span: '1/-1',
            addLabel: 'Add dive centre',
            cols: [
              { label: 'Name' },
              { label: 'Certification / meta', ph: 'PADI 5-star · nitrox' },
              { label: 'House reef', ph: 'Drop-off 30 m from the villa' },
              { label: 'Marine life', type: 'tags', span: '1/-1' },
            ],
          },
        ],
      },
      {
        key: 'experiences',
        title: 'Experiences',
        help: 'Grouped by category on the site (Marine, Adventure, Wellness, Romance, Family, Culture, Safari).',
        fields: [
          {
            path: 'experiences',
            label: 'Experiences',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add experience',
            cols: [{ label: 'Category', ph: 'Marine' }, { label: 'Name', ph: 'House-reef snorkel' }, { label: 'Detail', ph: 'Guided daily with the marine biologist' }],
          },
        ],
      },
      {
        key: 'facts',
        title: 'Facts & policies',
        help: 'The fact sheet, good-to-know rows and FAQ. Be specific — these answer the questions guests would otherwise WhatsApp.',
        fields: [
          {
            path: 'facts',
            label: 'Fact sheet',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add fact',
            cols: [{ label: 'Label', ph: 'Location' }, { label: 'Value', ph: 'Noonu Atoll · 4.5° N' }],
          },
          { path: 'checkin', label: 'Check-in / out', ph: '14:00 → 12:00' },
          { path: 'children', label: 'Children policy' },
          { path: 'reef', label: 'House reef', hint: 'Use — for none' },
          { path: 'languages', label: 'Languages spoken' },
          { path: 'cancel', label: 'Cancellation', type: 'textarea', rows: 2, span: '1/-1' },
          { path: 'amenities', label: 'Amenities', type: 'tags', span: '1/-1' },
          {
            path: 'faq',
            label: 'FAQ',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add question',
            cols: [{ label: 'Question', span: '1/-1' }, { label: 'Answer', type: 'textarea', span: '1/-1' }],
          },
        ],
      },
      {
        key: 'page',
        title: 'Property page',
        help:
          'The property page derives a version of all of this from the rest of the profile. What you set here replaces the derived answer, so fill in what a specialist knows and leave the rest — an empty field is not a blank section.',
        fields: [
          {
            path: 'exclusives',
            label: 'Axis exclusives',
            type: 'tags',
            span: '1/-1',
            hint: 'One perk per tag. Shown with an “Axis exclusive” label beside the inclusions the package already carries.',
          },
          {
            path: 'nearby',
            label: 'Proximity highlights',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add highlight',
            cols: [
              { label: 'Place', ph: 'Hanifaru Bay · UNESCO Biosphere' },
              { label: 'Why it matters', type: 'textarea', ph: 'Manta season Jun–Nov, 30 min by boat' },
            ],
          },
          {
            path: 'geo',
            label: 'Coordinates',
            type: 'list',
            hint: 'One row, decimal degrees. It positions the pin on the atoll map and measures the distance from Malé.',
            addLabel: 'Set coordinates',
            cols: [{ label: 'Latitude', ph: '4.28' }, { label: 'Longitude', ph: '73.43' }],
          },
          { path: 'video', label: 'Hero video', type: 'video', span: '1/-1', hint: 'A muted loop over the hero photograph. Without one the photograph stands alone.' },
          { path: 'brand', label: 'Brand or group', ph: 'Sun Siyam Resorts', hint: 'Drives the Brand filter. Left blank it is read from the name.' },
          { path: 'instagram', label: 'Instagram handle', ph: 'barosmaldives', hint: 'Without the @' },
          {
            path: 'awards',
            label: 'Recognition',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add award',
            hint: 'Verify each one before publishing — nothing here is derived, and an award nobody checked is on the page in the resort’s name.',
            cols: [{ label: 'Award', ph: "Indian Ocean's Most Romantic Resort" }, { label: 'Source', ph: 'World Travel Awards' }],
          },
          {
            path: 'pricing',
            label: 'Pricing by travel date',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add window',
            hint: 'Per couple for the package nights. Left empty the page shows the derived seasonal guide, which is labelled as a guide.',
            cols: [
              { label: 'Travel window', ph: '11 Jan – 9 Apr 2027' },
              { label: 'Entry villa USD', ph: '7180' },
              { label: 'Mid-tier villa USD', ph: '7707' },
            ],
          },
        ],
      },
    ]

  if (col === 'offers')
    return [
      {
        key: 'offer',
        title: 'Offer',
        help: 'Offers are the only place a rate appears on the site. Rate = property reference rate × (1 − discount), plus room and transfer supplements. Availability is always on request.',
        fields: [
          { path: 'resort', label: 'Property', type: 'select', req: true, options: ctx.properties.map((p) => ({ v: p.id, l: `${p.name} · ${p.dest}` })) },
          { path: 'badge', label: 'Badge', req: true, ph: 'Early bird' },
          { path: 'date', label: 'Departure date', req: true, ph: '14 Nov 2026' },
          { path: 'label', label: 'Short date label', req: true, ph: '14 Nov' },
          { path: 'month', label: 'Month', type: 'select', options: L.MONTHS.map((m, i) => ({ v: i + 1, l: m })) },
          { path: 'off', label: 'Discount %', type: 'percent' },
          { path: 'perk', label: 'Perks included', type: 'textarea', req: true, rows: 2, span: '1/-1', ph: 'Seaplane transfers included for two' },
          { path: 'seats', label: 'Availability note', ph: 'On request', hint: 'Never imply scarcity' },
          { path: 'from', label: 'From price USD', type: 'number', hint: 'Leave empty for “on request”' },
          { path: 'title', label: 'Offer title', span: '1/-1' },
          { path: 'img', label: 'Offer image', type: 'image', span: '1/-1' },
        ],
      },
    ]

  if (col === 'destinations')
    return [
      {
        key: 'hero',
        title: 'Hero & story',
        help: 'The destination page opens on a full-screen video with the tagline; the intro sits under it.',
        fields: [
          { path: 'name', label: 'Destination name', req: true },
          { path: 'slug', label: 'URL slug', req: true, hint: '/destinations/slug' },
          { path: 'live', label: 'Published to the site', type: 'select', options: [{ v: 'yes', l: 'Yes — show on the site' }, { v: 'no', l: 'No — coming soon' }] },
          { path: 'tagline', label: 'Tagline', req: true, span: '1/-1' },
          { path: 'intro', label: 'Intro', type: 'textarea', rows: 4, span: '1/-1' },
          { path: 'hero', label: 'Hero image (poster)', type: 'image' },
          { path: 'card', label: 'Card image (menus, tiles)', type: 'image' },
          { path: 'video', label: 'Hero video', type: 'video', span: '1/-1', hint: 'Uploaded, or an address — either way, check it' },
          { path: 'videoCredit', label: 'Video credit' },
          {
            path: 'gallery',
            label: 'Gallery',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add photo',
            hint: 'Leave empty and the page shows the first few properties here',
            cols: [{ key: 'img', label: 'Photo', type: 'image' }, { key: 'cap', label: 'Caption' }],
          },
        ],
      },
      {
        key: 'facts',
        title: 'Facts & highlights',
        fields: [
          { path: 'facts', label: 'Quick facts', type: 'list', span: '1/-1', addLabel: 'Add fact', cols: [{ label: 'Label', ph: 'Flight' }, { label: 'Value', ph: '4 h 15 from Dubai' }] },
          { path: 'highlights', label: 'Highlights', type: 'tags', span: '1/-1' },
        ],
      },
      {
        key: 'plan',
        title: 'Getting there & when to go',
        fields: [
          {
            path: 'logistics',
            label: 'Transfer logistics',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add option',
            cols: [{ label: 'Option', ph: 'Seaplane-only' }, { label: 'Timing', ph: '30–50 min · daylight' }, { label: 'Detail', type: 'textarea', span: '1/-1' }],
          },
          {
            path: 'seasons',
            label: 'Seasons',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add season',
            cols: [{ label: 'Season', ph: 'Peak' }, { label: 'Months', ph: 'Mid-Dec → Mid-Jan' }, { label: 'Note', span: '1/-1' }],
          },
        ],
      },
    ]

  if (col === 'homepage')
    return [
      {
        key: 'hero',
        title: 'Homepage hero',
        help: 'Choose which destination clip plays behind the headline, or Photo for the still poster only.',
        fields: [
          { path: 'heroVideo', label: 'Hero video', type: 'select', options: opt(['Photo', 'Maldives', 'Sri Lanka', 'UAE']) },
          { path: 'heroPoster', label: 'Poster image', type: 'image' },
          { path: 'storyImg', label: 'Our Story image', type: 'image' },
        ],
      },
      {
        key: 'themes',
        title: 'Experience tiles',
        fields: [{ path: 'themeImages', label: 'Theme images', type: 'list', span: '1/-1', cols: [{ label: 'Theme' }, { label: 'Image', type: 'image' }] }],
      },
      {
        key: 'voices',
        title: 'Guest voices',
        fields: [
          {
            path: 'voices',
            label: 'Testimonials',
            type: 'list',
            span: '1/-1',
            addLabel: 'Add quote',
            cols: [{ key: 'quote', label: 'Quote', type: 'textarea', span: '1/-1' }, { key: 'who', label: 'Who' }, { key: 'trip', label: 'Trip' }],
          },
        ],
      },
    ]

  if (col === 'settings') {
    const legalSection = (key: string, title: string): Section => ({
      key,
      title,
      fields: [
        { path: `legal.${key}.title`, label: 'Title' },
        {
          path: `legal.${key}.sections`,
          label: 'Sections',
          type: 'list',
          span: '1/-1',
          addLabel: 'Add section',
          cols: [{ label: 'Heading', span: '1/-1' }, { label: 'Text', type: 'textarea', span: '1/-1' }],
        },
      ],
    })
    return [
      {
        key: 'contact',
        title: 'Contact',
        help: 'Shown in the header, footer, mobile dock and every WhatsApp button.',
        fields: [
          { path: 'company', label: 'Legal entity' },
          { path: 'licence', label: 'Trade licence' },
          { path: 'phone', label: 'Phone (display)', ph: '+971 4 456 7890' },
          { path: 'phoneHref', label: 'Phone (dial)', ph: '+97144567890' },
          { path: 'whatsapp', label: 'WhatsApp number (digits only)', ph: '97144567890' },
          { path: 'email', label: 'Email' },
          { path: 'address', label: 'Address', span: '1/-1' },
        ],
      },
      {
        key: 'social',
        title: 'Social',
        help: 'The gold ring icons in the footer. Leave a field empty and its icon is not drawn.',
        fields: [
          { path: 'social.instagram', label: 'Instagram' },
          { path: 'social.tiktok', label: 'TikTok' },
          { path: 'social.youtube', label: 'YouTube' },
          { path: 'social.facebook', label: 'Facebook' },
        ],
      },
      {
        key: 'story',
        title: 'About the company',
        help: 'The About section and the story copy across the site.',
        fields: [
          { path: 'who', label: 'Who we are', type: 'textarea', rows: 3, span: '1/-1' },
          { path: 'story', label: 'Story', type: 'textarea', rows: 4, span: '1/-1' },
          { path: 'promise', label: 'Promise', type: 'textarea', rows: 2, span: '1/-1' },
          { path: 'vision', label: 'Vision', type: 'textarea', rows: 2, span: '1/-1' },
          { path: 'mission', label: 'Mission', type: 'textarea', rows: 2, span: '1/-1' },
          { path: 'team', label: 'Team', type: 'textarea', rows: 2, span: '1/-1' },
          { path: 'teamImg', label: 'Team image', type: 'image' },
        ],
      },
      legalSection('terms', 'Terms & conditions'),
      legalSection('privacy', 'Privacy'),
      legalSection('cancel', 'Cancellation & refunds'),
      legalSection('security', 'Payment security'),
    ]
  }

  return []
}

/** The blank document a wizard starts from. */
export function blankDoc(col: ContentCollection, ctx: SchemaContext): Record<string, unknown> {
  if (col === 'properties')
    return {
      dest: ctx.destinations[0]?.name || '',
      tier: ctx.lists.TIERS[0] || '',
      pkg: ctx.lists.PKGS[0] || '',
      nights: 5,
      themes: [],
      months: [],
      usd: 0,
      specialist: ctx.lists.SPECIALISTS[0] || '',
      villas: [],
      days: [],
      transfers: [],
      draft: true,
    }
  if (col === 'offers') return { month: 0, off: 0, seats: 'On request' }
  if (col === 'destinations') return { live: false, facts: [], highlights: [], logistics: [], seasons: [] }
  return {}
}
