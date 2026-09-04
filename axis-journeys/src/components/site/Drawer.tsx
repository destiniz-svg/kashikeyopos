'use client'

/**
 * The property drawer — the 600px right sheet that carries the whole property profile and the
 * enquiry funnel, and doubles as the shortlist view and the standalone Journey Designer.
 *
 * It is one component with three heads (`saved`, a property, or neither) because the enquiry form
 * at the bottom is the same form in all three cases; splitting it would give the site three places
 * to keep the honeypot, the Turnstile token and the validation in step.
 */
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { ImageSlot } from '@/components/ui/ImageSlot'
import { MONTHS } from '@/lib/content/types'
import { formatMoney } from '@/lib/content/filters'
import { ON, OFF } from './derive'
import { useSite } from './state'

const money = (usd: number, currency: 'USD' | 'EUR') => formatMoney(usd, currency)

export function Drawer() {
  const { state: s, actions } = useSite()
  const d = s.drawer
  const r = d?.resort ?? null
  const isSavedView = d?.view === 'saved'
  const settings = s.bundle.settings
  const hasRate = !!d?.dep

  const kicker = isSavedView ? 'Shortlist' : r ? (d?.dep ? `Offer · ${d.dep.date} · availability on request` : 'Curated journey') : 'Journey Designer'

  const waText = encodeURIComponent(
    r
      ? `Hello Axis Journeys — I'm interested in ${r.name} (${r.dest}, ${r.nights} nights${d?.dep ? ', departure ' + d.dep.date : ''}, ${r.villas[s.villa]?.[0] ?? ''}). Travelling as: ${s.party}. Budget band: ${s.budget}.`
      : "Hello Axis Journeys — I'd like help planning a journey.",
  )
  const waLink = `https://wa.me/${settings?.whatsapp || '971554855656'}?text=${waText}`

  return (
    <>
      <div
        onClick={actions.closeDrawer}
        style={{ ...css('position:fixed;inset:0;z-index:80;background:rgba(5,7,14,.7);backdrop-filter:blur(4px);transition:opacity .4s ease;'), opacity: s.drawerVisible ? 1 : 0, pointerEvents: s.drawerVisible ? 'auto' : 'none' }}
      />
      <aside
        id="drawer"
        aria-hidden={!s.drawerVisible}
        aria-label={r ? r.name : isSavedView ? 'Your shortlist' : 'Plan my journey'}
        style={{
          ...css('position:fixed;top:0;right:0;bottom:0;z-index:90;width:600px;background:var(--bg);border-left:1px solid var(--line-1);transition:transform .55s cubic-bezier(.22,1,.36,1);overflow-y:auto;box-shadow:-40px 0 80px var(--shadow-50);'),
          transform: `translateX(${s.drawerVisible ? '0' : '100%'})`,
        }}
      >
        {d && (
          <>
            <div style={css('position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:16px 28px;background:var(--bg-9);backdrop-filter:blur(12px);border-bottom:1px solid var(--line-08);')}>
              <span style={css('font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--gold-ink);')}>{kicker}</span>
              <Hover
                as="button"
                type="button"
                onClick={actions.closeDrawer}
                aria-label="Close"
                style="background:none;border:1px solid var(--line-2);color:var(--ink);width:36px;height:36px;border-radius:50%;font-size:16px;transition:all .2s;"
                hover="border-color:var(--gold-ink);color:var(--gold-ink);transform:rotate(90deg);"
              >
                ✕
              </Hover>
            </div>

            {isSavedView && <ShortlistView />}
            {r && <PropertyProfile waLink={waLink} hasRate={hasRate} />}
            <EnquiryForm waLink={waLink} />
          </>
        )}
      </aside>
    </>
  )
}

// ---------------------------------------------------------------- shortlist

function ShortlistView() {
  const { state: s, actions } = useSite()
  const saved = s.bundle.properties.filter((p) => s.saved.includes(p.id))

  return (
    <div style={css('padding:32px 28px 0;')}>
      <h3 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:36px;line-height:1.05;margin:0 0 8px;")}>
        {s.saved.length ? 'Your shortlist' : 'Nothing saved yet'}
      </h3>
      <div style={css('display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin:0 0 24px;')}>
        <p style={css('font-size:13px;color:var(--muted);margin:0;line-height:1.6;')}>
          {s.saved.length
            ? 'Tap a journey to reopen it, or send the whole list to a specialist below.'
            : 'Tap the heart on any journey to keep it here — then send the list to a specialist in one go.'}
        </p>
        {s.saved.length > 0 && (
          <Hover
            as="button"
            type="button"
            onClick={actions.clearSaved}
            style="flex-shrink:0;background:none;border:1px solid var(--line-18);color:var(--ink);font-size:12px;padding:6px 12px;border-radius:999px;transition:all .2s;white-space:nowrap;"
            hover="border-color:var(--gold-ink);color:var(--gold-ink);"
          >
            Clear all
          </Hover>
        )}
      </div>
      <div style={css('display:flex;flex-direction:column;gap:10px;')}>
        {saved.map((c) => (
          <div key={c.id} style={css('display:grid;grid-template-columns:1fr auto;gap:8px;align-items:stretch;')}>
            <Hover
              as="button"
              type="button"
              onClick={() => actions.openDrawer(c)}
              style="text-align:left;display:grid;grid-template-columns:96px 1fr auto;gap:14px;align-items:center;background:var(--panel);border:1px solid var(--line-08);padding:10px;color:var(--ink);border-radius:3px;transition:all .2s;"
              hover="border-color:var(--gold-ink);"
            >
              <div style={{ ...css('height:68px;background-size:cover;background-position:center;border-radius:2px;'), backgroundImage: `url(${c.img})` }} />
              <div>
                <div style={css('font-size:14px;font-weight:500;')}>{c.name}</div>
                <div style={css('font-size:12px;color:var(--muted);margin-top:3px;')}>
                  {c.dest} · {c.nights} nights
                </div>
              </div>
              <div style={css('font-size:14px;color:var(--gold-ink);white-space:nowrap;')}>{c.tier}</div>
            </Hover>
            <Hover
              as="button"
              type="button"
              onClick={(e: React.MouseEvent) => actions.toggleSave(c.id, e)}
              aria-label={`Remove ${c.name} from shortlist`}
              title="Remove"
              style="width:44px;background:var(--panel);border:1px solid var(--line-08);color:var(--muted);font-size:16px;border-radius:3px;transition:all .2s;"
              hover="border-color:#E07A6B;color:#E07A6B;"
            >
              ✕
            </Hover>
          </div>
        ))}
      </div>
      {s.saved.length === 0 && (
        <button
          type="button"
          onClick={() => {
            actions.closeDrawer()
            setTimeout(() => actions.nav('properties')(), 350)
          }}
          style={css('margin-top:8px;background:#E0B94F;border:0;color:#00102F;padding:12px 20px;font-size:13px;font-weight:600;border-radius:2px;')}
        >
          Browse properties
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- the property profile

function PropertyProfile({ waLink, hasRate }: { waLink: string; hasRate: boolean }) {
  const { state: s, actions } = useSite()
  const d = s.drawer
  const r = d?.resort
  if (!r) return null

  const cur = s.currency
  const facts = (r.facts || []).map(([k, v]) => ({ k, v }))
  const gallery = r.gallery || []
  const expGroups = Object.entries(
    (r.experiences || []).reduce<Record<string, { n: string; dd: string }[]>>((acc, x) => {
      ;(acc[x[0]] = acc[x[0]] || []).push({ n: x[1], dd: x[2] })
      return acc
    }, {}),
  ).map(([cat, items]) => ({ cat, items }))

  const hasGtk = !!(r.checkin || r.board || r.children || r.languages || r.cancel || (r.amenities && r.amenities.length))
  const jump = (id: string) => () => actions.jump(id)

  const offerMeta = d?.dep
  const drawerPrice = offerMeta?.from ? 'From ' + money(offerMeta.from, cur) : offerMeta?.off ? 'Save ' + Math.round(offerMeta.off * 100) + '%' : 'Rate on request'
  const drawerPriceAlt = offerMeta ? offerMeta.perk || '' : 'Your specialist confirms rate & availability'
  const saved = s.saved.includes(r.id)
  const mapSrc = r.map || `https://maps.google.com/maps?q=${encodeURIComponent(r.name + ' ' + r.dest)}&output=embed`
  const mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + ' ' + r.dest)}`

  const chip = (label: string, onClick: () => void) => (
    <Hover
      key={label}
      as="button"
      type="button"
      onClick={onClick}
      style="background:none;border:1px solid var(--line-14);color:var(--ink);font-size:12px;padding:7px 12px;border-radius:999px;transition:all .2s;"
      hover="border-color:var(--gold-ink);color:var(--gold-ink);"
    >
      {label}
    </Hover>
  )

  return (
    <>
      <div className="dk" style={css('height:300px;position:relative;overflow:hidden;')}>
        <div style={css('position:absolute;inset:0;animation:kenburns 12s ease-out both;')}>
          <ImageSlot src={r.img} alt={`${r.name}, ${r.dest}`} credit={r.credit} creditHref={r.creditHref} placeholder={r.photoHint} pos={(r as { pos?: string }).pos} loading="eager" sizes="600px" />
        </div>
        <div style={css('position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(0,16,47,.85) 100%);pointer-events:none;')} />
        <div style={css('position:absolute;left:28px;bottom:40px;right:28px;pointer-events:none;')}>
          <div style={css('font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>
            {r.dest} · {r.area}
          </div>
          <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:44px;line-height:1;margin-top:8px;")}>{r.name}</div>
        </div>
      </div>

      <div id="drawer-pad" style={css('padding:24px 28px 0;')}>
        <div id="qf-grid" style={css('display:grid;grid-template-columns:repeat(3,1fr);gap:10px;')}>
          <QuickFact label="Tier" value={r.tier} />
          <QuickFact label="Nights" value={String(r.nights)} />
          <QuickFact label="Transfer" value={r.transferShort} />
          {r.bestFor && <QuickFact label="Best for" value={r.bestFor} />}
          {r.rooms && <QuickFact label="Accommodation" value={r.rooms} />}
          {r.diningShort && <QuickFact label="Dining" value={r.diningShort} />}
        </div>

        <div style={css('display:flex;gap:18px;flex-wrap:wrap;margin-top:14px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);')}>
          {['Direct contract rates', 'Best-rate guarantee', '24/7 on-ground support'].map((t) => (
            <span key={t} style={css('display:flex;align-items:center;gap:6px;')}>
              <span style={css('width:5px;height:5px;background:#E0B94F;border-radius:50%;')} />
              {t}
            </span>
          ))}
        </div>

        <div style={css('display:flex;gap:4px;flex-wrap:wrap;margin-top:22px;padding-bottom:14px;border-bottom:1px solid var(--line-08);')}>
          {chip('Overview', jump('dr-about'))}
          {facts.length > 0 && chip('Facts', jump('dr-facts'))}
          {gallery.length > 0 && chip('Gallery', jump('dr-gallery'))}
          {(r.dining || []).length > 0 && chip('Dining', jump('dr-dining'))}
          {(r.villas || []).length > 0 && chip('Stays', jump('dr-stays'))}
          {r.spa && chip('Spa', jump('dr-spa'))}
          {(r.experiences || []).length > 0 && chip(`Experiences · ${(r.experiences || []).length}`, jump('dr-exp'))}
          {(r.faq || []).length > 0 && chip('FAQ', jump('dr-faq'))}
        </div>

        <div id="dr-about" style={css('margin-top:28px;')}>
          <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;')}>The property</div>
          <p style={css('font-size:14px;line-height:1.7;color:var(--soft);margin:0;text-wrap:pretty;')}>{r.about}</p>
          {r.detailPending && (
            <div style={css('margin-top:14px;font-size:12px;color:var(--muted);border-left:2px solid var(--gold-50);padding-left:12px;line-height:1.6;')}>
              Full villa, dining and gallery details for this resort are being added. Your specialist can send the complete fact sheet today.
            </div>
          )}
        </div>

        <div id="dr-facts" style={css('margin-top:32px;')}>
          {facts.length > 0 && <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:12px;')}>Fact sheet</div>}
          <div id="facts-grid" style={css('display:grid;grid-template-columns:1fr 1fr;gap:0 24px;border-top:1px solid var(--line-1);')}>
            {facts.map((f, i) => (
              <div key={`${f.k}-${i}`} style={css('padding:11px 0;border-bottom:1px solid var(--line-07);')}>
                <div style={css('font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold-ink);')}>{f.k}</div>
                <div style={css('font-size:13px;margin-top:4px;line-height:1.5;color:var(--ink);')}>{f.v}</div>
              </div>
            ))}
          </div>
        </div>

        {gallery.length > 0 && (
          <div id="dr-gallery" style={css('margin-top:32px;')}>
            <div style={css('display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;')}>
              <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);')}>Gallery</div>
              <div style={css('font-size:11px;color:var(--muted);')}>{gallery.length} photos · tap to enlarge</div>
            </div>
            <div id="gal-grid" style={css('display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:110px;gap:6px;')}>
              {gallery.map((g, i) => (
                <button key={`${g.img}-${i}`} type="button" onClick={() => actions.setLightbox(i)} style={css('position:relative;overflow:hidden;border:none;padding:0;border-radius:2px;background:var(--panel);cursor:zoom-in;')}>
                  <Hover
                    role="img"
                    aria-label={g.cap}
                    style={{ ...css('width:100%;height:100%;background-size:cover;background-position:center;transition:transform .6s cubic-bezier(.2,.7,.2,1);'), backgroundImage: `url(${g.img})`, backgroundPosition: g.pos || 'center' }}
                    hover="transform:scale(1.06);"
                  />
                  <div className="dk" style={css('position:absolute;left:0;right:0;bottom:0;padding:18px 8px 6px;font-size:10px;color:var(--ink);text-align:left;background:linear-gradient(180deg,transparent,rgba(0,16,47,.85));pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>
                    {g.cap}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {r.verdict && r.verdict !== r.about && !r.detailPending && (
          <div style={css('margin-top:32px;border-left:1px solid var(--gold-ink);padding-left:18px;')}>
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>Specialist&apos;s Verdict</div>
            <p style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:21px;line-height:1.4;margin:10px 0 6px;")}>{r.verdict}</p>
            <div style={css('font-size:12px;color:var(--muted);')}>— {r.specialist}</div>
          </div>
        )}

        {r.love && (
          <div style={css('margin-top:28px;background:var(--panel);border:1px solid rgba(224,185,79,.25);padding:18px 20px;border-radius:3px;')}>
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>Why we love it</div>
            <p style={css('font-size:14px;line-height:1.65;margin:8px 0 0;color:var(--ink);')}>{r.love}</p>
          </div>
        )}

        {(r.days || []).length > 0 && (
          <div style={css('margin-top:36px;')}>
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;')}>Day by day</div>
            <div style={css('display:flex;flex-direction:column;')}>
              {r.days.map((day, i) => (
                <div key={`${day[0]}-${i}`} style={css('display:grid;grid-template-columns:76px 1fr;gap:16px;align-items:start;padding:14px 0;border-top:1px solid var(--line-08);')}>
                  <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-ink);line-height:1.5;padding-top:2px;white-space:nowrap;")}>{day[0]}</div>
                  <div style={css('min-width:0;')}>
                    <div style={css('font-size:14px;font-weight:500;line-height:1.5;')}>{day[1]}</div>
                    <div style={css('font-size:13px;color:var(--muted);line-height:1.6;margin-top:3px;')}>{day[2]}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {(r.dining || []).length > 0 && (
          <div id="dr-dining" style={css('margin-top:36px;')}>
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;')}>Dining</div>
            <div style={css('display:flex;flex-direction:column;gap:8px;')}>
              {(r.dining || []).map((v, i) => {
                const open = s.venueOpen === i
                const img = v[3] || r.img
                const pos = v[6] || '50% 50%'
                return (
                  <div key={`${v[0]}-${i}`} style={{ ...css('background:var(--panel);border-radius:3px;overflow:hidden;transition:border-color .2s;'), border: `1px solid ${open ? 'var(--gold-ink)' : 'var(--line-08)'}` }}>
                    <button type="button" onClick={() => actions.setVenueOpen(i)} aria-expanded={open} style={css('width:100%;text-align:left;display:grid;grid-template-columns:72px 1fr auto;gap:14px;align-items:center;background:none;border:none;padding:10px 14px 10px 10px;color:var(--ink);')}>
                      <div role="img" aria-label={v[0]} style={{ ...css('width:72px;height:56px;background-size:cover;border-radius:2px;'), backgroundImage: `url(${img})`, backgroundPosition: pos }} />
                      <div>
                        <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:17px;")}>{v[0]}</div>
                        <div style={css('font-size:12px;color:var(--gold-ink);margin-top:2px;')}>
                          {v[1]} <span style={css('color:var(--muted);')}>· {v[2]}</span>
                        </div>
                      </div>
                      <span style={css('color:var(--gold-ink);font-size:18px;line-height:1;')}>{open ? '−' : '+'}</span>
                    </button>
                    {open && (
                      <div style={css('padding:0 14px 14px;')}>
                        <div role="img" aria-label={v[0]} style={{ ...css('width:100%;height:200px;background-size:cover;border-radius:2px;'), backgroundImage: `url(${img})`, backgroundPosition: pos }} />
                        <p style={css('font-size:13px;line-height:1.65;color:var(--soft);margin:12px 0 10px;')}>{v[4]}</p>
                        <div style={css('display:flex;flex-wrap:wrap;gap:6px;')}>
                          {(v[5] || []).map((t) => (
                            <span key={t} style={css('font-size:11px;padding:5px 10px;border:1px solid rgba(224,185,79,.4);border-radius:999px;')}>
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {(r.villas || []).length > 0 && (
          <div id="dr-stays" style={css('margin-top:32px;')}>
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;')}>Accommodation</div>
            <div style={css('display:flex;flex-direction:column;gap:8px;')}>
              {r.villas.map((v, i) => {
                const chosen = s.villa === i
                const open = s.roomOpen === i
                const img = v[3] || r.img
                const pos = v[6] || '50% 50%'
                const add = !hasRate ? '' : v[2] === 0 ? 'Included' : '+ ' + money(v[2], cur)
                return (
                  <div key={`${v[0]}-${i}`} style={{ ...css('border-radius:3px;overflow:hidden;transition:all .2s;'), background: chosen ? 'rgba(224,185,79,.1)' : 'var(--panel)', border: `1px solid ${chosen ? 'var(--gold-ink)' : 'var(--line-08)'}` }}>
                    <Hover
                      as="button"
                      type="button"
                      onClick={() => {
                        actions.setVilla(i)
                        actions.setRoomOpen(i)
                      }}
                      aria-pressed={chosen}
                      style="width:100%;text-align:left;display:grid;grid-template-columns:72px 1fr auto;gap:14px;align-items:center;background:none;border:none;padding:10px 14px 10px 10px;color:var(--ink);"
                      hover="color:var(--gold-ink);"
                    >
                      <div role="img" aria-label={v[0]} style={{ ...css('width:72px;height:56px;background-size:cover;border-radius:2px;'), backgroundImage: `url(${img})`, backgroundPosition: pos }} />
                      <div>
                        <div style={css('font-size:14px;font-weight:500;')}>{v[0]}</div>
                        <div style={css('font-size:12px;color:var(--muted);margin-top:3px;')}>{v[1]}</div>
                      </div>
                      <div style={css('text-align:right;')}>
                        <div style={css('font-size:13px;color:var(--gold-ink);white-space:nowrap;')}>{add}</div>
                        <div style={css('font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:3px;')}>
                          {chosen ? 'Selected' : 'Select'} {open ? '−' : '+'}
                        </div>
                      </div>
                    </Hover>
                    {open && (
                      <div style={css('padding:0 14px 14px;')}>
                        <div role="img" aria-label={v[0]} style={{ ...css('width:100%;height:220px;background-size:cover;border-radius:2px;'), backgroundImage: `url(${img})`, backgroundPosition: pos }} />
                        <p style={css('font-size:13px;line-height:1.65;color:var(--soft);margin:12px 0 10px;')}>{v[4]}</p>
                        <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;')}>
                          {(v[5] || []).map((f) => (
                            <div key={f} style={css('font-size:12px;color:var(--ink);display:flex;gap:8px;align-items:center;')}>
                              <span style={css('width:4px;height:4px;background:#E0B94F;border-radius:50%;flex-shrink:0;')} />
                              {f}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div style={css('margin-top:32px;')}>
          <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;')}>Private transfer</div>
          <div id="transfer-grid" style={css('display:grid;grid-template-columns:repeat(2,1fr);gap:8px;')}>
            {(r.transfers || []).map((v, i) => {
              const chosen = s.transfer === i
              const add = !hasRate ? '' : v[2] === 0 ? 'Included' : v[2] < 0 ? '− ' + money(-v[2], cur) : '+ ' + money(v[2], cur)
              return (
                <Hover
                  key={`${v[0]}-${i}`}
                  as="button"
                  type="button"
                  onClick={() => actions.setTransfer(i)}
                  aria-pressed={chosen}
                  style={{ ...css('text-align:left;padding:14px 16px;color:var(--ink);border-radius:3px;transition:all .2s;'), background: chosen ? 'rgba(224,185,79,.1)' : 'var(--panel)', border: `1px solid ${chosen ? 'var(--gold-ink)' : 'var(--line-08)'}` }}
                  hover="border-color:var(--gold-ink);"
                >
                  <div style={css('font-size:14px;font-weight:500;')}>{v[0]}</div>
                  <div style={css('font-size:12px;color:var(--muted);margin-top:3px;')}>{v[1]}</div>
                  <div style={css('font-size:13px;color:var(--gold-ink);margin-top:6px;')}>{add}</div>
                </Hover>
              )
            })}
          </div>

          <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin:26px 0 14px;')}>Location</div>
          <div style={css('border:1px solid var(--line-1);border-radius:3px;overflow:hidden;background:var(--panel);')}>
            <iframe title={`Map of ${r.name}`} src={mapSrc} loading="lazy" referrerPolicy="no-referrer-when-downgrade" style={css('display:block;width:100%;height:240px;border:0;filter:saturate(.85) contrast(1.05);')} />
            <div style={css('display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--line-08);')}>
              <div style={css('font-size:12px;color:var(--muted);')}>
                {r.area}, {r.dest}
              </div>
              <a href={mapLink} target="_blank" rel="noopener" style={css('font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-ink);border-bottom:1px solid var(--gold-ink);white-space:nowrap;')}>
                Open in Google Maps
              </a>
            </div>
          </div>
        </div>

        {r.spa && (
          <div id="dr-spa" style={css('margin-top:36px;background:var(--panel);border:1px solid var(--line-08);padding:20px;border-radius:3px;')}>
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);')}>Wellness &amp; spa</div>
            <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:26px;margin-top:8px;line-height:1.1;")}>{r.spa[0]}</div>
            <div style={css('font-size:12px;color:var(--gold-ink);margin-top:6px;')}>{r.spa[1]}</div>
            <p style={css('font-size:13px;line-height:1.65;color:var(--soft);margin:12px 0 14px;')}>{r.spa[2]}</p>
            <div style={css('display:flex;flex-wrap:wrap;gap:8px;')}>
              {(r.spa[3] || []).map((t) => (
                <span key={t} style={css('font-size:12px;padding:6px 12px;border:1px solid rgba(224,185,79,.4);border-radius:999px;color:var(--ink);')}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {r.dive && (
          <div style={css('margin-top:12px;background:var(--panel);border:1px solid var(--line-08);padding:20px;border-radius:3px;')}>
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);')}>Dive centre</div>
            <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:26px;margin-top:8px;line-height:1.1;")}>{r.dive[0]}</div>
            <div style={css('font-size:12px;color:var(--gold-ink);margin-top:6px;')}>{r.dive[1]}</div>
            <div style={css('font-size:13px;color:var(--soft);margin-top:10px;')}>{r.dive[2]}</div>
            <div style={css('font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-top:14px;')}>Marine life</div>
            <div style={css('display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;')}>
              {(r.dive[3] || []).map((t) => (
                <span key={t} style={css('font-size:12px;padding:6px 12px;border:1px solid var(--line-14);border-radius:999px;')}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        <div id="dr-exp" style={css('margin-top:36px;')}>
          {expGroups.length > 0 && (
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;')}>Experiences · {(r.experiences || []).length}</div>
          )}
          {expGroups.map((g) => (
            <div key={g.cat} style={css('margin-top:16px;')}>
              <div style={css('font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-ink);padding-bottom:8px;border-bottom:1px solid var(--line-08);')}>{g.cat}</div>
              <div className="exp-grid" style={css('display:grid;grid-template-columns:repeat(2,1fr);gap:0 20px;')}>
                {g.items.map((e, i) => (
                  <div key={`${e.n}-${i}`} style={css('padding:10px 0;border-bottom:1px solid var(--line-06);')}>
                    <div style={css('font-size:14px;font-weight:500;')}>{e.n}</div>
                    <div style={css('font-size:12px;color:var(--muted);margin-top:2px;line-height:1.5;')}>{e.dd}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {hasGtk && (
          <div style={css('margin-top:32px;')}>
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;')}>Good to know</div>
            <div style={css('display:flex;flex-direction:column;')}>
              {r.checkin && <GtkRow label="Check-in / out" value={r.checkin} />}
              {r.board && <GtkRow label="Board" value={r.board} />}
              {r.children && <GtkRow label="Children" value={r.children} />}
              {r.cancel && <GtkRow label="Cancellation" value={r.cancel} />}
              {r.languages && <GtkRow label="Languages" value={r.languages} />}
              {r.reef && r.reef !== '—' && <GtkRow label="House reef" value={r.reef} />}
            </div>
            <div style={css('display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;')}>
              {(r.amenities || []).map((a) => (
                <span key={a} style={css('font-size:12px;padding:6px 12px;border:1px solid var(--line-14);border-radius:999px;color:var(--ink);')}>
                  {a}
                </span>
              ))}
            </div>
          </div>
        )}

        {(r.faq || []).length > 0 && (
          <div id="dr-faq" style={css('margin-top:32px;')}>
            <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;')}>Questions we’re asked</div>
            <div style={css('display:flex;flex-direction:column;gap:6px;')}>
              {(r.faq || []).map((f, i) => {
                const open = s.faqOpen === i
                return (
                  <div key={`${f[0]}-${i}`} style={{ ...css('border-radius:3px;transition:border-color .2s;'), border: `1px solid ${open ? '#E0B94F' : 'var(--line-10)'}` }}>
                    <button type="button" onClick={() => actions.setFaqOpen(i)} aria-expanded={open} style={css('width:100%;text-align:left;background:none;border:none;color:var(--ink);padding:14px 16px;display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:14px;font-weight:500;')}>
                      <span>{f[0]}</span>
                      <span style={css('color:var(--gold-ink);font-size:18px;line-height:1;')}>{open ? '−' : '+'}</span>
                    </button>
                    {open && <p style={css('font-size:13px;line-height:1.65;color:var(--soft);margin:0;padding:0 16px 14px;')}>{f[1]}</p>}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div style={css('margin-top:32px;background:var(--panel);border:1px solid var(--line-08);padding:18px 20px;display:flex;justify-content:space-between;align-items:center;gap:16px;border-radius:3px;flex-wrap:wrap;')}>
          {hasRate ? (
            <div>
              <div style={css('font-size:12px;color:var(--muted);')}>This offer · availability on request</div>
              <div style={css('font-size:30px;font-weight:600;color:var(--ink);letter-spacing:-.01em;line-height:1.1;margin-top:2px;animation:fadein .35s ease;')}>{drawerPrice}</div>
              <div style={css('font-size:12px;color:var(--muted);margin-top:4px;')}>{drawerPriceAlt}</div>
            </div>
          ) : (
            <div>
              <div style={css('font-size:12px;color:var(--muted);')}>Suggested stay · {r.nights} nights</div>
              <div style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:400;font-size:22px;color:var(--ink);line-height:1.1;margin-top:2px;")}>Rates on request</div>
              <div style={css('font-size:12px;color:var(--muted);margin-top:4px;')}>Your specialist quotes against live availability, usually within the hour.</div>
            </div>
          )}
          <div style={css('display:flex;gap:8px;')}>
            <Hover
              as="button"
              type="button"
              onClick={() => actions.toggleSave(r.id)}
              aria-label={saved ? 'Remove from shortlist' : 'Save to shortlist'}
              aria-pressed={saved}
              style={{ ...css('background:none;border:1px solid var(--line-2);width:42px;height:42px;border-radius:2px;font-size:16px;transition:all .2s;'), color: saved ? '#E0B94F' : 'var(--ink)' }}
              hover="border-color:var(--gold-ink);color:var(--gold-ink);"
            >
              {saved ? '♥' : '♡'}
            </Hover>
            <Hover
              as="a"
              href={waLink}
              target="_blank"
              rel="noopener"
              style="display:inline-flex;align-items:center;gap:8px;color:var(--ink);border:1px solid var(--line-2);padding:11px 14px;font-size:13px;border-radius:2px;white-space:nowrap;transition:all .2s;"
              hover="border-color:var(--gold-ink);color:var(--gold-ink);"
            >
              <span style={css('width:8px;height:8px;border-radius:50%;background:#25D366;')} />
              Ask on WhatsApp
            </Hover>
          </div>
        </div>
      </div>
    </>
  )
}

function QuickFact({ label, value }: { label: string; value: string }) {
  return (
    <div style={css('background:var(--panel);padding:12px;border-radius:3px;')}>
      <div style={css('font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);')}>{label}</div>
      <div style={css('font-size:14px;margin-top:5px;')}>{value}</div>
    </div>
  )
}

function GtkRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={css('display:grid;grid-template-columns:120px 1fr;gap:14px;padding:11px 0;border-top:1px solid var(--line-08);font-size:13px;')}>
      <div style={css('color:var(--muted);')}>{label}</div>
      <div style={css('line-height:1.55;')}>{value}</div>
    </div>
  )
}

// ---------------------------------------------------------------- the enquiry form

const NEXT_STEPS = [
  { when: '< 15 min', what: 'Your specialist reads your notes and replies personally on WhatsApp.', delay: '.1s' },
  { when: '< 4 hrs', what: 'A tailored quote with villa, transfer and honest from-price band.', delay: '.25s' },
  { when: '24 hrs', what: "A shortlist of three alternatives if you'd like to compare.", delay: '.4s' },
  { when: 'When ready', what: 'Secure hosted payment link — deposit or instalments, 3-D Secure.', delay: '.55s' },
]

function EnquiryForm({ waLink }: { waLink: string }) {
  const { state: s, actions } = useSite()
  const d = s.drawer
  const r = d?.resort ?? null
  const isSavedView = d?.view === 'saved'
  const err = s.err
  const bd = (k: string) => (err[k] ? '#E07A6B' : 'var(--line-12)')
  const first = (s.form.name || '').trim().split(' ')[0] || 'traveller'
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''

  const kicker = isSavedView ? 'Send the list' : r ? 'Enquire' : 'Plan my journey'
  const title = isSavedView ? 'Send your shortlist to a specialist' : r ? `Get your tailored quote for ${r.name}` : 'Tell us about the trip you have in mind'

  if (s.submitted) {
    return (
      <div id="drawer-form" style={css('padding:36px 28px 60px;')}>
        <div style={css('animation:rise .6s ease both;')}>
          <div style={css('width:56px;height:56px;border-radius:50%;border:1px solid var(--gold-ink);display:flex;align-items:center;justify-content:center;color:var(--gold-ink);font-size:22px;animation:pulse .6s .3s ease;')}>✓</div>
          <h3 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:36px;line-height:1.05;margin:20px 0 8px;")}>Thank you, {first}.</h3>
          <p style={css('font-size:14px;color:var(--muted);line-height:1.7;margin:0 0 28px;')}>
            Your request <span style={css('color:var(--ink);')}>{s.leadId}</span> is with {s.assignedTo || 'your specialist'}. A confirmation has gone to {s.form.email} and your WhatsApp.
          </p>
          <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);margin-bottom:14px;')}>What happens next</div>
          <div style={css('display:flex;flex-direction:column;')}>
            {NEXT_STEPS.map((step) => (
              <div key={step.when} style={{ ...css('display:grid;grid-template-columns:90px 1fr;gap:14px;padding:12px 0;border-top:1px solid var(--line-08);animation:rise .5s ease both;'), animationDelay: step.delay }}>
                <div style={css('font-size:12px;color:var(--gold-ink);letter-spacing:.06em;')}>{step.when}</div>
                <div style={css('font-size:14px;line-height:1.5;')}>{step.what}</div>
              </div>
            ))}
          </div>
          <div style={css('display:flex;gap:12px;margin-top:28px;flex-wrap:wrap;')}>
            <a href={waLink} target="_blank" rel="noopener" style={css('display:inline-flex;align-items:center;gap:8px;background:#E0B94F;color:#00102F;padding:13px 20px;font-size:13px;font-weight:600;border-radius:2px;')}>
              <span style={css('width:8px;height:8px;border-radius:50%;background:var(--bg);')} />
              Continue on WhatsApp
            </a>
            <button type="button" onClick={actions.closeDrawer} style={css('background:none;border:1px solid var(--line-2);color:var(--ink);padding:13px 20px;font-size:13px;border-radius:2px;')}>
              Back to the selection
            </button>
          </div>
        </div>
      </div>
    )
  }

  const pill = (label: string, on: boolean, onClick: () => void) => {
    const c = on ? ON : OFF
    return (
      <button key={label} type="button" aria-pressed={on} onClick={onClick} style={{ ...css('padding:9px 16px;font-size:13px;border-radius:999px;transition:all .2s;'), background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}>
        {label}
      </button>
    )
  }

  return (
    <div id="drawer-form" style={css('padding:36px 28px 60px;')}>
      <div style={css('font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>{kicker}</div>
      <h3 style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:34px;line-height:1.05;margin:10px 0 6px;")}>{title}</h3>
      <p style={css('font-size:13px;color:var(--muted);margin:0 0 24px;line-height:1.6;')}>A named specialist replies within 15 minutes in business hours. Quote within 4 hours.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void actions.submitEnquiry()
        }}
        noValidate
      >
        <div style={css('font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;')}>Travelling as</div>
        <div style={css('display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px;')}>
          {['Couple', 'Family', 'Friends', 'Solo'].map((p) => pill(p, s.party === p, () => actions.setParty(p)))}
        </div>
        <div style={css('font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;')}>Budget band</div>
        <div style={css('display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px;')}>
          {['Select', 'Premium', 'Ultra Lux'].map((p) => pill(p, s.budget === p, () => actions.setBudget(p)))}
        </div>

        <div id="form-grid" style={css('display:grid;grid-template-columns:1fr 1fr;gap:14px;')}>
          <Field label="Full name" htmlFor="f-name" error={err.name}>
            <input
              id="f-name"
              name="name"
              autoComplete="name"
              value={s.form.name}
              onChange={(e) => actions.setFormField('name', e.target.value)}
              placeholder="Layla Al Mansoori"
              aria-invalid={!!err.name}
              style={{ ...css('background:var(--panel);color:var(--ink);padding:13px 14px;font-size:14px;border-radius:2px;letter-spacing:0;text-transform:none;transition:border-color .2s;'), border: `1px solid ${bd('name')}` }}
            />
          </Field>
          <Field label="Email" htmlFor="f-email" error={err.email}>
            <input
              id="f-email"
              name="email"
              type="email"
              autoComplete="email"
              value={s.form.email}
              onChange={(e) => actions.setFormField('email', e.target.value)}
              placeholder="layla@example.com"
              aria-invalid={!!err.email}
              style={{ ...css('background:var(--panel);color:var(--ink);padding:13px 14px;font-size:14px;border-radius:2px;letter-spacing:0;text-transform:none;transition:border-color .2s;'), border: `1px solid ${bd('email')}` }}
            />
          </Field>
          <Field label="WhatsApp number" htmlFor="f-phone" error={err.phone}>
            <input
              id="f-phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              value={s.form.phone}
              onChange={(e) => actions.setFormField('phone', e.target.value)}
              placeholder="+971 50 000 0000"
              aria-invalid={!!err.phone}
              style={{ ...css('background:var(--panel);color:var(--ink);padding:13px 14px;font-size:14px;border-radius:2px;letter-spacing:0;text-transform:none;transition:border-color .2s;'), border: `1px solid ${bd('phone')}` }}
            />
          </Field>
          <Field label="Travel month" htmlFor="f-month" error={err.month}>
            <select
              id="f-month"
              name="month"
              value={s.form.month}
              onChange={(e) => actions.setFormField('month', e.target.value)}
              aria-invalid={!!err.month}
              style={{ ...css('background:var(--panel);color:var(--ink);padding:13px 14px;font-size:14px;border-radius:2px;letter-spacing:0;text-transform:none;'), border: `1px solid ${bd('month')}` }}
            >
              <option value="">Choose a month</option>
              <option value="Flexible">Flexible</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <label htmlFor="f-message" style={css('display:flex;flex-direction:column;gap:6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:14px;')}>
          Anything we should know
          <textarea
            id="f-message"
            name="message"
            rows={3}
            value={s.form.message}
            onChange={(e) => actions.setFormField('message', e.target.value)}
            placeholder="Anniversary on the 14th, prefer seaplane, one guest is vegetarian…"
            style={css('background:var(--panel);border:1px solid var(--line-12);color:var(--ink);padding:13px 14px;font-size:14px;border-radius:2px;resize:vertical;letter-spacing:0;text-transform:none;transition:border-color .2s;')}
          />
        </label>

        <div style={css('display:flex;gap:12px;align-items:center;margin-top:20px;flex-wrap:wrap;')}>
          {/* The honeypot. A real guest never sees it; a bot fills it and the server drops the
              record while answering 200, so nothing tells the bot it was caught. */}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={s.hp}
            onChange={(e) => actions.setHp(e.target.value)}
            style={css('position:absolute;left:-9999px;width:1px;height:1px;opacity:0;')}
          />
          <div id="turnstile-slot" className="cf-turnstile" data-sitekey={siteKey} style={siteKey ? undefined : css('display:none;')} />
          <Hover
            as="button"
            type="submit"
            disabled={s.sending}
            style={{ ...css('background:#E0B94F;color:#00102F;border:0;padding:14px 24px;font-size:14px;font-weight:600;letter-spacing:.04em;border-radius:2px;min-width:200px;transition:all .2s;'), opacity: s.sending ? 0.7 : 1 }}
            hover="background:#EBCB72;"
          >
            {s.sending ? 'Sending…' : 'Get my tailored quote'}
          </Hover>
          <Hover as="a" href={waLink} target="_blank" rel="noopener" style="font-size:13px;color:var(--ink);border-bottom:1px solid var(--ink-35);transition:color .2s;" hover="color:var(--gold-ink);">
            Skip the form — WhatsApp instead
          </Hover>
        </div>

        <div style={css('font-size:11px;color:var(--muted);margin-top:14px;line-height:1.6;')}>
          Protected by Turnstile. By sending, you agree to our{' '}
          <button type="button" onClick={() => actions.setLegal('terms')} style={css('background:none;border:0;padding:0;color:var(--gold-ink);font-size:11px;')}>
            Terms
          </button>{' '}
          and{' '}
          <button type="button" onClick={() => actions.setLegal('privacy')} style={css('background:none;border:0;padding:0;color:var(--gold-ink);font-size:11px;')}>
            Privacy Policy
          </button>
          . No card details are ever requested here.
        </div>
      </form>
    </div>
  )
}

function Field({ label, htmlFor, error, children }: { label: string; htmlFor: string; error?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} style={css('display:flex;flex-direction:column;gap:6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);')}>
      {label}
      {children}
      {error && <span style={css('color:#E07A6B;font-size:11px;letter-spacing:0;text-transform:none;animation:fadein .2s;')}>{error}</span>}
    </label>
  )
}
