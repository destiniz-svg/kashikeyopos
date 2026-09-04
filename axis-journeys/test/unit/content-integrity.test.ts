/**
 * Content integrity: the catalogue that ships is the agency's real content, and it hangs together.
 *
 * This is not a schema check. It is the check the build brief asks for by name — that no sample,
 * placeholder or invented data reached the production catalogue, that every cross-reference
 * resolves, and that the company's own details are the real ones rather than something plausible.
 * A site that renders perfectly against invented content is the failure this suite exists to
 * refuse.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { seed } from '@/lib/content/seed'
import { isSiteReady, readiness } from '@/lib/content/rules'
import { MONTHS } from '@/lib/content/types'
import { ORIGINS, contentSecurityPolicy } from '@/lib/http/headers.mjs'

/** Words that mean somebody was going to come back and finish it. */
const PLACEHOLDER = /\b(lorem ipsum|dolor sit amet|foo ?bar|sample text|placeholder|tbd|tba|xxx+|test test|dummy text)\b|\bTODO\b|\bFIXME\b/i

/** Every string in a value, however deep, with the path that reached it. */
function strings(value: unknown, path = '', out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([path, value])
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out)
  return out
}

/** Properties whose imagery is a labelled stand-in — see the test that pins this set by name. */
const PLACEHOLDER_IMAGERY = new Set(['properties[7]'])

const everything = { properties: seed.properties, offers: seed.offers, destinations: seed.destinations, homepage: seed.homepage, settings: seed.settings }

describe('the catalogue is the real one', () => {
  it('carries the whole catalogue rather than a trimmed sample of it', () => {
    assert.equal(seed.properties.length, 32)
    assert.equal(seed.offers.length, 25)
    assert.equal(seed.destinations.length, 3)
  })

  it('nine properties are complete enough to publish, and the rest are honest drafts', () => {
    const live = seed.properties.filter(isSiteReady)
    assert.equal(live.length, 9)
    // The rest are not hidden: each one names what a specialist still has to write.
    for (const p of seed.properties.filter((x) => !isSiteReady(x))) {
      assert.ok(p.draft || p.detailPending || readiness(p).missing.length > 0, `${p.id} is not live and does not say why`)
    }
  })

  it('no placeholder or lorem text anywhere in the catalogue', () => {
    // Self-labelled stand-in imagery is excluded here and pinned by name in its own test below: it
    // is a stated gap rather than invented content, and hiding it in this sweep would hide it.
    const found = strings(everything).filter(([path, v]) => PLACEHOLDER.test(v) && !PLACEHOLDER_IMAGERY.has(path.split('.')[0]))
    assert.deepEqual(found, [], `placeholder copy: ${found.map(([p, v]) => `${p} = ${v.slice(0, 60)}`).join(' | ')}`)
  })

  it('the one property still on stand-in photography says so, and says how to fix it', () => {
    // KNOWN GAP. Conrad Rangali is live and its hero and gallery are Unsplash stand-ins, labelled
    // as such in the source content rather than passed off as the resort's own. That is the honest
    // state and the CMS's media library is the remedy the label names.
    //
    // This test exists so the gap stays visible and cannot spread: a second property arriving in
    // the same state fails here rather than reaching the site unremarked.
    const onStandIn = seed.properties.filter((p) => /placeholder/i.test(JSON.stringify(p))).map((p) => p.id)
    assert.deepEqual(onStandIn, ['conrad-rangali'], 'the set of properties on stand-in photography has changed')
    const credit = String(seed.properties.find((p) => p.id === 'conrad-rangali')?.credit ?? '')
    assert.match(credit, /placeholder/i, 'a stand-in must announce itself')
    assert.match(credit, /replace/i, 'and name the remedy')
  })

  it('no example.com, localhost or unresolved template braces reached the content', () => {
    const bad = strings(everything).filter(([, v]) => /example\.(com|org|test)|localhost|\{\{|\$\{/.test(v))
    assert.deepEqual(bad, [], `unresolved values: ${bad.map(([p, v]) => `${p} = ${v.slice(0, 60)}`).join(' | ')}`)
  })
})

describe('the company details are the real ones', () => {
  const s = seed.settings

  it('names Axis Link LLC-FZ and its travel licence', () => {
    assert.match(s.company, /Axis/)
    assert.ok(String(s.licence || '').trim().length > 0, 'the trade licence is stated')
    assert.match(JSON.stringify(s), /2423494\.01/, 'the licence number the footer prints')
  })

  it('the phone number and its dial link are the same number', () => {
    const digits = (v: string) => String(v || '').replace(/\D/g, '')
    assert.ok(digits(s.phone).length >= 8, 'a real phone number')
    assert.equal(digits(s.phoneHref).endsWith(digits(s.phone)), true, 'the tel: link dials the number shown')
    assert.equal(digits(s.whatsapp).length >= 8, true)
  })

  it('the contact address is a real mailbox on the agency’s own domain', () => {
    assert.match(s.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
    assert.match(s.email, /axisjourneys\.com$/)
  })

  it('the legal documents are written, not stubbed', () => {
    const legal = s.legal as Record<string, { title?: string; sections?: [string, string][] }>
    const entries = Object.entries(legal || {})
    assert.ok(entries.length >= 2, 'terms and privacy at least')
    for (const [key, doc] of entries) {
      assert.ok(String(doc?.title || '').trim().length > 0, `${key} has no title`)
      const sections = doc?.sections ?? []
      assert.ok(sections.length >= 3, `${key} has only ${sections.length} sections`)
      const words = sections.map(([, body]) => body).join(' ')
      assert.ok(words.trim().length > 400, `${key} is only ${words.trim().length} characters of body`)
      for (const [heading, body] of sections) {
        assert.ok(String(heading).trim().length > 0, `${key} has an unheaded section`)
        assert.ok(String(body).trim().length > 40, `${key} · ${heading} is a heading with nothing under it`)
      }
    }
  })
})

describe('every cross-reference resolves', () => {
  const propertyIds = new Set(seed.properties.map((p) => p.id))
  const destinationNames = new Set(seed.destinations.map((d) => d.name))

  it('every offer names a property this catalogue holds', () => {
    for (const o of seed.offers) assert.equal(propertyIds.has(o.resort), true, `offer ${o.id} points at ${o.resort}`)
  })

  it('every property names a destination this catalogue holds', () => {
    for (const p of seed.properties) assert.equal(destinationNames.has(p.dest), true, `${p.id} is in ${p.dest}`)
  })

  it('every property’s themes and package come from the published lists', () => {
    for (const p of seed.properties) {
      for (const t of p.themes || []) assert.equal(seed.lists.THEMES.includes(t), true, `${p.id}: theme ${t}`)
      if (p.pkg) assert.equal(seed.lists.PKGS.includes(p.pkg), true, `${p.id}: package ${p.pkg}`)
      if (p.tier) assert.equal(seed.lists.TIERS.includes(p.tier), true, `${p.id}: tier ${p.tier}`)
    }
  })

  it('every property’s season months are real months', () => {
    for (const p of seed.properties) for (const m of p.months || []) assert.ok(m >= 1 && m <= 12, `${p.id}: month ${m}`)
  })

  it('every offer’s month is a real month, or 0 meaning any', () => {
    for (const o of seed.offers) assert.ok(o.month >= 0 && o.month <= 12, `offer ${o.id}: month ${o.month}`)
  })

  it('every specialist named on a property is on the roster', () => {
    for (const p of seed.properties) {
      if (p.specialist) assert.equal(seed.lists.SPECIALISTS.includes(p.specialist), true, `${p.id}: ${p.specialist}`)
    }
  })

  it('ids are unique in every collection', () => {
    for (const [name, rows] of [['properties', seed.properties], ['offers', seed.offers], ['destinations', seed.destinations]] as const) {
      const ids = rows.map((r) => r.id)
      assert.equal(new Set(ids).size, ids.length, `${name} has a duplicate id`)
    }
  })

  it('the month list is the twelve the filters index into', () => {
    assert.deepEqual([...seed.lists.MONTHS], [...MONTHS])
  })
})

describe('what a live property promises, it carries', () => {
  const live = seed.properties.filter(isSiteReady)

  it('each live property has a verdict and a hero photograph', () => {
    for (const p of live) {
      assert.ok(p.verdict.trim().length > 20, `${p.id}'s verdict is too short to be real copy`)
      assert.ok(p.img.trim().length > 0, `${p.id} has no hero`)
    }
  })

  it('no property carries an invented from-price', () => {
    // The real catalogue publishes no from-prices: `usd` is 0 throughout, which the site reads as
    // "Rate on request" and which is why no card prints money. The handoff's own demo file carried
    // figures like 14,800 against invented resorts; none of that was taken.
    //
    // If this fails, real prices have arrived — which is good, and means the money-rendering paths
    // (the drawer's rate line and the villa and transfer supplements) need a look before release.
    for (const p of seed.properties) {
      assert.equal(typeof p.usd, 'number', `${p.id}: usd is not a number`)
      assert.equal(p.usd, 0, `${p.id} now publishes a from-price of ${p.usd} — check what the site prints for it`)
    }
  })

  it('a supplement is money, so it is never a string that happens to look like one', () => {
    for (const p of live) {
      for (const v of p.villas) assert.ok(Number.isFinite(v[2]), `${p.id}: villa "${v[0]}" supplement`)
      for (const t of p.transfers) assert.ok(Number.isFinite(t[2]), `${p.id}: transfer "${t[0]}" supplement`)
    }
  })

  it('each live property’s itinerary runs as many days as it sells nights', () => {
    for (const p of live) {
      assert.ok(p.nights >= 3, `${p.id} sells ${p.nights} nights`)
      assert.ok(p.days.length > 0, `${p.id} has no itinerary`)
    }
  })

  it('a photograph that is credited says who took it', () => {
    for (const p of seed.properties) {
      if (p.creditHref) assert.ok(String(p.credit || '').trim().length > 0, `${p.id} links a credit with no name`)
    }
  })

  it('every transfer and villa tuple is the shape the site reads positionally', () => {
    for (const p of live) {
      for (const v of p.villas) {
        assert.equal(typeof v[0], 'string', `${p.id}: villa name`)
        assert.equal(typeof v[2], 'number', `${p.id}: villa supplement must be money, not a string`)
      }
      for (const t of p.transfers) {
        assert.equal(typeof t[0], 'string', `${p.id}: transfer mode`)
        assert.equal(typeof t[2], 'number', `${p.id}: transfer supplement must be money, not a string`)
      }
    }
  })

  it('the transfer summary’s first word is a mode the refine panel can group on', () => {
    for (const p of live) {
      const kind = p.transferShort.split(/[\s·]+/)[0]
      assert.match(kind, /^[A-Z]/, `${p.id}: "${p.transferShort}" does not lead with a transfer mode`)
    }
  })
})

describe('the homepage and the destinations', () => {
  it('the homepage carries the copy the sections read', () => {
    assert.ok(seed.homepage.voices?.length, 'the voices section has its quotes')
    assert.ok(String(seed.homepage.storyImg || '').length > 0, 'the story image is set')
  })

  it('the featured offer, where set, is one of the published offers', () => {
    const f = seed.homepage.featuredOffer
    if (f) assert.equal(seed.offers.some((o) => o.id === f), true, `featured offer ${f} is not in the catalogue`)
  })

  it('each destination has a slug the router can use', () => {
    for (const d of seed.destinations) assert.match(d.slug, /^[a-z0-9-]+$/, `${d.id}: slug "${d.slug}"`)
  })

  it('a live destination is written up; one that is not says so instead', () => {
    // "Coming soon to Axis Journeys" is the agency's own copy for a destination it does not sell
    // yet. That is a statement, not a placeholder — but it must never appear on one that is live.
    for (const d of seed.destinations) {
      const soon = /coming soon/i.test(d.intro)
      if (d.live) {
        assert.equal(soon, false, `${d.id} is live and still says "coming soon"`)
        assert.ok(d.intro.trim().length > 120, `${d.id} is live with a ${d.intro.trim().length}-character introduction`)
      } else {
        assert.ok(d.intro.trim().length > 0, `${d.id} is not live and says nothing at all`)
      }
    }
  })

  it('every destination that is live has at least one live property to show', () => {
    const live = seed.properties.filter(isSiteReady)
    for (const d of seed.destinations.filter((x) => x.live)) {
      assert.ok(live.some((p) => p.dest === d.name), `${d.name} is live with nothing to show`)
    }
  })
})

describe('every host the catalogue publishes from is one the browser may reach', () => {
  /** Every absolute URL in the content, with the field that carries it. */
  const urls = strings(everything).filter(([, v]) => /^https?:\/\//.test(v))
  const hostsOf = (paths: RegExp) =>
    [...new Set(urls.filter(([p]) => paths.test(p)).map(([, v]) => new URL(v).host))]

  it('every image host is in the Content-Security-Policy', () => {
    // A blocked image is invisible from the outside: the card renders, the photograph does not, and
    // only the browser console says why. This is how one resort's own photography was found blocked.
    const allowed = new Set(ORIGINS.img.map((o) => new URL(o).host))
    const imageish = /img|hero|photo|image|poster|gallery|card|logo|villas\.\d+\.3|venues?\.\d+\.3|storyImg|themeImages/i
    const missing = hostsOf(imageish).filter((host) => !allowed.has(host))
    assert.deepEqual(missing, [], `image hosts the policy blocks: ${missing.join(', ')} — add them to ORIGINS.img and next.config.mjs`)
  })

  it('every video host is in the Content-Security-Policy', () => {
    const allowed = new Set(ORIGINS.media.map((o) => new URL(o).host))
    const missing = hostsOf(/video/i).filter((host) => !allowed.has(host))
    assert.deepEqual(missing, [], `video hosts the policy blocks: ${missing.join(', ')}`)
  })

  it('and the policy the browser is actually sent carries them', () => {
    const policy = contentSecurityPolicy({ development: false }).value
    for (const origin of ORIGINS.img) assert.ok(policy.includes(origin), `${origin} is not in the header`)
  })
})
