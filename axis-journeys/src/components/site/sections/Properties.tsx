'use client'

/** Our Properties: destination chips, the Refine panel, and the two-column card grid. */
import { css } from '@/components/ui/css'
import { Hover } from '@/components/ui/Hover'
import { QUIZ } from '@/lib/content/filters'
import { chipColours, useProperties } from '../derive'
import { useSite } from '../state'
import { EmptyProperties, PropertyCardTile, RefinePanel } from './RefinePanel'

export function Properties() {
  const { state: s, actions } = useSite()
  const { groups, cards, cats, answered, hasPf, summary } = useProperties(s.bundle, s.propDest, s.pf, s.saved, s.cat, s.qz)
  const destChips = ['All', ...s.liveDestinations.map((d) => d.name)]

  return (
    <section id="properties" data-screen-label="Properties" style={css('padding:40px 0 96px;border-top:1px solid var(--line-06);')}>
      <div id="props-wrap" style={css('max-width:1400px;margin:0 auto;padding:96px 32px 0;')}>
        <div data-reveal="" style={css('display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;')}>
          <div>
            <div style={css('font-size:11px;letter-spacing:.36em;text-transform:uppercase;color:var(--gold-ink);')}>05 · Our Properties</div>
            <h2 id="props-h2" style={css("font-family:var(--font-display),'Outfit',system-ui,sans-serif;font-weight:300;font-size:42px;line-height:1.05;margin:14px 0 0;letter-spacing:-.02em;")}>
              Every island, villa and retreat we represent
            </h2>
          </div>
          <div style={css('font-size:14px;color:var(--muted);max-width:380px;line-height:1.6;')}>
            Full details on each property. Rates are quoted by your specialist against live availability — only our Offers carry published prices.
          </div>
        </div>

        <div data-reveal="" style={css('display:flex;gap:8px;flex-wrap:wrap;margin-top:32px;')}>
          {destChips.map((label) => {
            const on = s.propDest === label
            const c = chipColours(on)
            return (
              <Hover
                key={label}
                as="button"
                type="button"
                aria-pressed={on}
                onClick={() => actions.setPropDest(label)}
                style={{ ...css('padding:10px 16px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;border-radius:2px;transition:all .2s;min-height:44px;'), background: c.bg, border: `1px solid ${c.bd}`, color: c.fg }}
                hover="border-color:var(--gold-ink);color:var(--gold-ink);"
              >
                {label}
              </Hover>
            )
          })}
        </div>

        {/* Shortcuts through the same catalogue: one tap for the thing most guests arrive wanting,
            where the Refine panel below is for somebody who already knows what they are after. */}
        <div data-reveal="" style={css('display:flex;gap:8px;flex-wrap:wrap;margin-top:32px;')}>
          {cats.map((label) => {
            const on = s.cat === label
            return (
              <Hover
                key={label}
                as="button"
                type="button"
                aria-pressed={on}
                onClick={() => actions.setCat(label)}
                style={{
                  ...css('padding:8px 14px;font-size:12px;border-radius:999px;transition:all .2s;min-height:44px;white-space:nowrap;cursor:pointer;'),
                  background: on ? 'rgba(224,185,79,.14)' : 'transparent',
                  border: `1px solid ${on ? '#E0B94F' : 'var(--line-14)'}`,
                  color: on ? '#E0B94F' : 'var(--ink)',
                }}
                hover="border-color:var(--gold-ink);color:var(--gold-ink);"
              >
                {label}
              </Hover>
            )
          })}
        </div>

        <Matchmaker answered={answered} />

        <RefinePanel groups={groups} summary={summary} hasPf={hasPf} />

        {cards.length === 0 && <EmptyProperties />}

        <div id="props-grid" data-reveal="" style={css('display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:28px;')}>
          {cards.map((p) => (
            <PropertyCardTile key={p.id} p={p} />
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * The sixty-second matchmaker.
 *
 * It re-ranks the grid; it never shortens it. On a catalogue of nine islands a quiz that filtered
 * would answer "nothing matches" to somebody who had just told it four true things about their
 * holiday — so the useful output is an order, and the count under the grid is the same either way.
 * The panel says which of the two it is doing, in the summary and again beside Clear.
 */
function Matchmaker({ answered }: { answered: number }) {
  const { state: s, actions } = useSite()
  const on = s.quizOpen
  return (
    <div id="quiz" data-reveal="" style={css('margin-top:24px;border:1px solid var(--gold-50);border-radius:3px;background:var(--panel);overflow:hidden;')}>
      <button
        type="button"
        aria-expanded={on}
        onClick={actions.toggleQuiz}
        style={css(
          'width:100%;display:flex;align-items:center;justify-content:space-between;gap:14px;background:none;border:0;color:var(--ink);text-align:left;padding:16px 18px;min-height:56px;cursor:pointer;',
        )}
      >
        <span style={css('display:flex;flex-direction:column;gap:2px;')}>
          <span style={css('font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold-ink);')}>Find your match</span>
          <span style={css('font-size:13px;color:var(--muted);')}>
            {answered ? `Sorted by your best matches — ${answered} of ${QUIZ.length} answered` : '60-second quiz — four quick questions, ranked results'}
          </span>
        </span>
        <span style={css('font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-ink);white-space:nowrap;')}>{on ? 'Close' : 'Start'}</span>
      </button>
      {on && (
        <div
          id="quiz-grid"
          style={css('display:grid;grid-template-columns:repeat(4,1fr);gap:24px;padding:8px 18px 22px;border-top:1px solid var(--line-08);animation:fadein .3s ease;')}
        >
          {QUIZ.map(([question, options], i) => (
            <fieldset key={question} style={css('border:0;padding:0;margin:0;min-width:0;')}>
              <legend style={css('font-size:14px;color:var(--ink);margin:14px 0 12px;padding:0;')}>{question}</legend>
              <div style={css('display:flex;flex-direction:column;gap:6px;')}>
                {options.map(([value, label]) => {
                  const picked = s.qz[i] === value
                  return (
                    <Hover
                      key={value}
                      as="button"
                      type="button"
                      aria-pressed={picked}
                      onClick={() => actions.answerQuiz(i, value)}
                      style={{
                        ...css('text-align:left;padding:10px 12px;font-size:13px;border-radius:2px;transition:all .2s;min-height:44px;cursor:pointer;'),
                        background: picked ? 'rgba(224,185,79,.14)' : 'transparent',
                        border: `1px solid ${picked ? '#E0B94F' : 'var(--line-14)'}`,
                        color: picked ? '#E0B94F' : 'var(--ink)',
                      }}
                      hover="border-color:var(--gold-ink);"
                    >
                      {label}
                    </Hover>
                  )
                })}
              </div>
            </fieldset>
          ))}
          <div
            style={css('grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--line-07);')}
          >
            <span style={css('font-size:13px;color:var(--muted);')}>
              {answered ? 'Best matches are listed first below. Nothing is hidden.' : 'Answer any question to re-rank the list.'}
            </span>
            <button
              type="button"
              onClick={actions.clearQuiz}
              style={css(
                'background:none;border:1px solid var(--line-14);color:var(--ink);font-size:12px;letter-spacing:.1em;text-transform:uppercase;padding:10px 16px;border-radius:2px;min-height:44px;cursor:pointer;',
              )}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
