'use client'

/**
 * The five sections the 2026-09-05 home flow added: Why Axis, Explore by atoll, Every detail
 * compared, the guides, and the questions.
 *
 * They live together because they are one change to one page and each is small; splitting them
 * into five files would mean five imports and five headers for what a reader wants to see as a
 * single sequence. Every figure in them comes from `lib/content/home.ts`, which is where the
 * reasons for each derivation are.
 */
import { useState } from 'react'
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { atollCards, brandChips, comparison, GUIDES, HOME_FAQ } from '@/lib/content/home'
import { useSite } from '../state'

const WRAP = 'max-width:1400px;margin:0 auto;padding:0 32px;'
const KICKER = 'font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);'
const H2 = "font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.05;margin:14px 0 0;letter-spacing:-.02em;"

/** The header every one of these sections opens with: a numbered kicker, a title and a standfirst. */
function Head({ kicker, title, blurb }: { kicker: string; title: string; blurb: string }) {
  return (
    <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;')}>
      <div>
        <div style={css(KICKER)}>{kicker}</div>
        <h2 style={css(H2)}>{title}</h2>
      </div>
      <div style={css('font-size:14px;color:var(--muted);max-width:380px;line-height:1.6;')}>{blurb}</div>
    </div>
  )
}

// ---------------------------------------------------------------- 02 · Why Axis

/** What the agency claims about itself, in its own words. Three claims, no figures to get wrong. */
const WHY: [string, string, string][] = [
  [
    '01',
    'Honest positioning',
    'Every island carries our own verdict — what it does well, where it falls short and who it suits. No paid rankings, no sponsored placement.',
  ],
  [
    '02',
    'Exclusive packages',
    'Direct contract rates plus upgrades, spa credits and meal-plan enhancements you will not find booking direct. Transfers and taxes quoted upfront.',
  ],
  [
    '03',
    'Reef-first advice',
    'What is beneath the surface matters as much as the villa. We tell you how the house reef is, how you enter it and what you will see.',
  ],
]

export function WhyAxis() {
  return (
    <section data-screen-label="Why Axis" style={css('border-bottom:1px solid var(--line-06);')}>
      <div style={css('max-width:1400px;margin:0 auto;padding:96px 32px;')}>
        <Head
          kicker="02 · Why Axis"
          title="More than a booking site"
          blurb="We visit the islands, negotiate the contracts and answer the phone ourselves — from Dubai, in your time zone."
        />
        <div
          id="why-grid"
          style={css(
            'display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line-08);border:1px solid var(--line-08);border-radius:3px;overflow:hidden;margin-top:40px;',
          )}
        >
          {WHY.map(([n, title, body]) => (
            <div key={n} data-reveal="" style={css('background:var(--bg);padding:32px 28px;')}>
              <div style={css('font-size:12px;letter-spacing:.2em;color:var(--gold-ink);')}>{n}</div>
              <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:24px;font-weight:300;margin-top:16px;")}>{title}</div>
              <p style={css('font-size:14px;line-height:1.7;color:var(--soft);margin:12px 0 0;text-wrap:pretty;')}>{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- 06 · Explore by atoll

export function ByAtoll() {
  const { state: s, actions } = useSite()
  const atolls = atollCards(s.bundle.properties)
  const brands = brandChips(s.bundle.properties)
  // Nothing to explore by on a catalogue that is all one atoll — see `atollCards`.
  if (!atolls.length) return null

  return (
    <section data-screen-label="By atoll" style={css('padding:0 0 96px;')}>
      <div style={css(WRAP)}>
        <Head
          kicker="06 · Explore by atoll"
          title="Each atoll, a different Maldives"
          blurb="From speedboat islands off Malé to the manta bays of the UNESCO biosphere."
        />
        <div id="atoll-grid" style={css('display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:40px;')}>
          {atolls.map((at) => (
            <button
              key={at.value}
              type="button"
              className="zoomhost"
              data-reveal=""
              onClick={() => actions.openFacet('atoll', at.value, `Showing ${at.name}`)}
              aria-label={`Show the ${at.count} we represent in ${at.name}`}
              style={css(
                'position:relative;aspect-ratio:4/5;border:1px solid var(--line-08);border-radius:3px;overflow:hidden;padding:0;text-align:left;color:#fff;background:var(--panel);cursor:pointer;',
              )}
            >
              <div
                className="zoomable"
                style={{
                  ...css('position:absolute;inset:0;background-size:cover;background-position:center;transition:transform .8s ease;'),
                  backgroundImage: `url(${at.img})`,
                }}
              />
              <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,16,47,.2),rgba(0,16,47,.92));')} />
              {/* The gradient is only 20% dark at the top, so this label sits over whatever the
                  photograph happens to be — and an atoll's lead photograph is usually a bright
                  beach. The shadow is invisible against a dark shot and is what keeps the gold
                  legible against a pale one; measured at 1.87:1 without it. The bottom labels need
                  none: the gradient is 92% there. */}
              <div
                style={css(
                  'position:absolute;left:20px;top:18px;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#E0B94F;text-shadow:0 1px 3px rgba(0,16,47,.9),0 0 10px rgba(0,16,47,.7);',
                )}
              >
                {at.tag}
              </div>
              <div style={css('position:absolute;left:20px;right:20px;bottom:20px;')}>
                <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:26px;font-weight:300;line-height:1.05;")}>{at.name}</div>
                <div style={css('font-size:12px;color:rgba(255,255,255,.7);margin-top:8px;')}>
                  {at.count} · {at.transfer}
                </div>
              </div>
            </button>
          ))}
        </div>
        {brands.length > 0 && (
          <div
            data-reveal=""
            style={css('margin-top:40px;display:flex;align-items:baseline;gap:24px;flex-wrap:wrap;border-top:1px solid var(--line-1);padding-top:24px;')}
          >
            <span style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);flex:none;')}>Browse by brand</span>
            <div id="brand-row" style={css('display:flex;gap:8px;flex-wrap:wrap;')}>
              {brands.map((b) => {
                const on = s.pf.brand === b.label
                return (
                  <Hover
                    key={b.label}
                    as="button"
                    type="button"
                    aria-pressed={on}
                    onClick={() => actions.openFacet('brand', b.label, `Showing ${b.label}`)}
                    style={{
                      ...css(
                        'background:none;color:var(--ink);padding:9px 14px;font-size:13px;border-radius:2px;display:inline-flex;gap:10px;align-items:baseline;transition:all .2s;min-height:44px;cursor:pointer;',
                      ),
                      border: `1px solid ${on ? '#E0B94F' : 'var(--line-08)'}`,
                    }}
                    hover="border-color:var(--gold-ink);color:var(--gold-ink);"
                  >
                    {b.label}
                    <span style={css('font-size:11px;color:var(--muted);')}>{b.count}</span>
                  </Hover>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- 07 · Every detail, compared

export function Compared() {
  const { state: s, actions } = useSite()
  const { columns, rows } = comparison(s.bundle, s.currency)
  // Two islands is the fewest that can be compared; one column is a fact sheet.
  if (columns.length < 2) return null

  /*
   * On a phone this stops being a table.
   *
   * Three islands and five rows cannot fit 296px, and every way of making them try is worse than
   * the last: a 160px label column left a third of one property visible; narrowing it to 96px and
   * adding a swipe hint still put a clipped second column on screen, with a property name wrapping
   * one letter per line. Reported twice, from a real phone, and both times the complaint was the
   * same — it reads as broken rather than as scrollable.
   *
   * So the comparison becomes what a comparison is when you cannot lay it side by side: one card
   * per island, each carrying the same five rows. Nothing is clipped, nothing has to be swiped,
   * and every figure is readable. The typography, the hairlines, the gold kicker and the row
   * labels are the table's own — it is the same object in a shape that fits.
   */
  const narrow = s.vw <= 640

  const heading = (
    <Head
      kicker="07 · Every detail, compared"
      title="The numbers behind the recommendation"
      blurb="A taste of what every property page holds — villas, reef, transfer and package pricing, side by side."
    />
  )
  const foot = (
    <div data-reveal="" style={css('display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center;margin-top:24px;')}>
      <div style={css('font-size:13px;color:var(--muted);')}>
        Package prices are per couple and only shown where an Offer is live; everything else is quoted against availability.
      </div>
      <button type="button" onClick={actions.nav('properties')} className="pill" style={css('height:44px;')}>
        Compare every property<i>→</i>
      </button>
    </div>
  )

  return (
    <section
      data-screen-label="Compared"
      style={css('padding:96px 0;background:var(--panel);border-top:1px solid var(--line-06);border-bottom:1px solid var(--line-06);')}
    >
      <div style={css(WRAP)}>
        {heading}

        {narrow ? (
          <div id="cmp-cards" style={css('display:flex;flex-direction:column;gap:14px;margin-top:32px;')}>
            {columns.map((c, i) => (
              <div key={c.id} data-reveal="" style={css('border:1px solid var(--line-08);border-radius:3px;background:var(--bg);overflow:hidden;')}>
                <a
                  href={`/properties/${c.id}`}
                  style={css('display:block;padding:20px 20px 18px;border-bottom:1px solid var(--line-08);color:var(--ink);')}
                >
                  <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>{c.area}</div>
                  <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:24px;font-weight:300;margin-top:6px;line-height:1.15;")}>
                    {c.name}
                  </div>
                </a>
                {rows.map((row) => (
                  <div
                    key={row.label}
                    style={css(
                      'display:grid;grid-template-columns:96px minmax(0,1fr);gap:14px;align-items:baseline;padding:13px 20px;border-bottom:1px solid var(--line-07);',
                    )}
                  >
                    <span style={css('font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);')}>{row.label}</span>
                    <span style={css('font-size:15px;color:var(--ink);line-height:1.45;')}>{row.cells[i]}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div id="cmp-wrap" data-reveal="" style={css('margin-top:40px;overflow-x:auto;border:1px solid var(--line-08);border-radius:3px;background:var(--bg);')}>
            <div
              id="cmp-grid"
              style={{
                ...css('display:grid;'),
                minWidth: `${160 + 180 * columns.length}px`,
                gridTemplateColumns: `160px repeat(${columns.length},minmax(180px,1fr))`,
              }}
            >
              <div style={css('padding:22px 24px;border-bottom:1px solid var(--line-08);')} />
              {columns.map((c) => (
                <a
                  key={c.id}
                  href={`/properties/${c.id}`}
                  style={css('padding:22px 24px;border-bottom:1px solid var(--line-08);border-left:1px solid var(--line-07);color:var(--ink);display:block;')}
                >
                  <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>{c.area}</div>
                  <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:22px;font-weight:300;margin-top:6px;line-height:1.1;")}>
                    {c.name}
                  </div>
                </a>
              ))}
              {rows.map((row) => (
                <div key={row.label} style={css('display:contents;')}>
                  <div
                    style={css(
                      'padding:16px 24px;border-bottom:1px solid var(--line-07);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;',
                    )}
                  >
                    {row.label}
                  </div>
                  {row.cells.map((cell, i) => (
                    <div
                      key={columns[i].id}
                      style={css('padding:16px 24px;border-bottom:1px solid var(--line-07);border-left:1px solid var(--line-07);font-size:15px;color:var(--ink);line-height:1.5;')}
                    >
                      {cell}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {foot}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- 11 · Plan your trip

export function Guides() {
  const [open, setOpen] = useState<string | null>(null)
  const current = GUIDES.find((g) => g.n === open) || null

  return (
    <section data-screen-label="Guides" style={css('padding:96px 0;border-top:1px solid var(--line-06);')}>
      <div style={css(WRAP)}>
        <Head
          kicker="11 · Plan your trip"
          title="Essential Maldives guides"
          blurb="Seasons, transfers, budgets and how to choose — the four things every first-timer asks us."
        />
        <div id="guide-grid" style={css('display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:40px;')}>
          {GUIDES.map((g) => {
            const on = open === g.n
            return (
              <Hover
                key={g.n}
                as="button"
                type="button"
                data-reveal=""
                aria-expanded={on}
                onClick={() => setOpen(on ? null : g.n)}
                style={{
                  ...css(
                    'text-align:left;border-radius:3px;padding:26px 24px;color:var(--ink);transition:all .2s;cursor:pointer;min-height:150px;display:flex;flex-direction:column;justify-content:space-between;gap:18px;',
                  ),
                  background: on ? 'rgba(224,185,79,.08)' : 'var(--panel)',
                  border: `1px solid ${on ? '#E0B94F' : 'var(--line-08)'}`,
                }}
                hover="border-color:var(--gold-ink);"
              >
                <span style={css('font-size:12px;letter-spacing:.2em;color:var(--gold-ink);')}>{g.n}</span>
                <span>
                  <span style={css("display:block;font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:24px;font-weight:300;line-height:1.1;")}>
                    {g.title}
                  </span>
                  <span style={css('display:block;font-size:13px;color:var(--muted);margin-top:8px;line-height:1.5;')}>{g.sub}</span>
                </span>
              </Hover>
            )
          })}
        </div>
        {current && (
          <div
            id="guide-body"
            style={css(
              'margin-top:14px;border:1px solid var(--gold-50);border-radius:3px;background:var(--panel);padding:32px 36px;display:grid;grid-template-columns:1fr 1fr;gap:40px;animation:fadein .3s ease;',
            )}
          >
            <div>
              <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-size:30px;font-weight:300;line-height:1.1;")}>
                {current.title}
              </div>
              <p style={css('font-size:15px;line-height:1.7;color:var(--soft);margin:16px 0 0;text-wrap:pretty;')}>{current.intro}</p>
            </div>
            <div style={css('border-top:1px solid var(--line-1);')}>
              {current.points.map(([k, v]) => (
                <div
                  key={k}
                  style={css('display:grid;grid-template-columns:150px 1fr;gap:16px;padding:14px 0;border-bottom:1px solid var(--line-07);font-size:14px;line-height:1.55;')}
                >
                  <span style={css('color:var(--gold-ink);')}>{k}</span>
                  <span style={css('color:var(--ink);')}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- 12 · Common questions

export function HomeFaq() {
  const [open, setOpen] = useState<number | null>(null)

  return (
    <section data-screen-label="FAQ" style={css('padding:96px 0;border-top:1px solid var(--line-06);')}>
      <div id="faq-grid" style={css('max-width:1400px;margin:0 auto;padding:0 32px;display:grid;grid-template-columns:1fr 1.4fr;gap:64px;align-items:start;')}>
        <div data-reveal="">
          <div style={css(KICKER)}>12 · Common questions</div>
          <h2 style={css(H2 + 'margin-bottom:20px;text-wrap:balance;')}>Planning a first — or next — Maldives trip</h2>
          <p style={css('font-size:15px;line-height:1.7;color:var(--soft);margin:0;max-width:420px;text-wrap:pretty;')}>
            Straight answers from the specialists who book these islands every week. Anything else — ask on WhatsApp.
          </p>
        </div>
        <div data-reveal="" style={css('border-top:1px solid var(--line-1);')}>
          {HOME_FAQ.map(([q, a], i) => (
            <div key={q} style={css('border-bottom:1px solid var(--line-07);')}>
              <button
                type="button"
                aria-expanded={open === i}
                onClick={() => setOpen(open === i ? null : i)}
                style={css(
                  'width:100%;display:flex;justify-content:space-between;align-items:center;gap:16px;background:none;border:0;padding:20px 0;text-align:left;color:var(--ink);font-size:17px;cursor:pointer;',
                )}
              >
                <span>{q}</span>
                <span style={css('font-size:20px;color:var(--gold-ink);flex:none;width:24px;text-align:center;')} aria-hidden="true">
                  {open === i ? '−' : '+'}
                </span>
              </button>
              {open === i && (
                <p style={css('font-size:15px;line-height:1.7;color:var(--soft);margin:0 48px 22px 0;text-wrap:pretty;animation:fadein .3s ease;')}>{a}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
