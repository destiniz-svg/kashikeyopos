import { useMemo } from 'react';
import type { Snapshot, TicketLine } from './api';
import * as outbox from './outbox';

/* Kitchen Display — 02-POS-SPEC.md §4.
 *
 * "Column per station, ticket cards in fire order. Card header: 15px/700
 *  monospace table label, 10px meta, and a background tint that shifts to
 *  --warn then --red as the ticket passes its station target."
 *
 * The target is the STATION's own (chain.station.target_mins), carried on the
 * kds_ticket row when it was fired — §4: "Per-station targets come from
 * configuration, not a constant." A grill at 14 minutes and a bar at 4 turn
 * amber at different moments, which is the entire point of having stations.
 *
 * Ages are derived from fired_at against a clock ticking in the shell, never
 * from a stored counter (§5). A KDS left open overnight must not accumulate
 * drift, and a screen that reloads must not reset every ticket to zero.
 */

const MONO = "'JetBrains Mono',monospace";

/* §4's stage list. A card shows the NEXT stage as its action, so the cook has
   one button and never has to remember what comes after what. */
const STAGES = ['Received', 'In the kitchen', 'Ready', 'Served'] as const;
const NEXT: Record<string, string | null> = {
  Received: 'In the kitchen',
  'In the kitchen': 'Ready',
  Ready: 'Served',
  Served: null,
};

interface Props {
  snap: Snapshot | null;
  now: Date;
  onQueued: () => void | Promise<void>;
}

export function Kds({ snap, now, onQueued }: Props) {
  const stations = snap?.stations ?? [];
  const stages = snap?.stages ?? [];
  const tickets = snap?.tickets ?? [];

  const tableOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tickets) m.set(t.id, t.table_no || '—');
    return m;
  }, [tickets]);

  const linesOf = useMemo(() => {
    const m = new Map<string, TicketLine[]>();
    for (const t of tickets) m.set(t.id, t.lines);
    return m;
  }, [tickets]);

  /* The lines THIS station cooks. A card on the grill must not list the bar's
     drinks: the cook reads the card as their own work, and a wrong line is
     either food nobody makes or food made twice.
     A line with no routed station falls to the first column — the same rule
     kitchen.js applied when it decided which stations to fire, so the display
     and the fire agree. */
  const columns = stations.length
    ? stations.map((s) => s.name)
    // An outlet that has configured no stations still has a pass; the server
    // fires everything to one, and this must show it rather than nothing.
    : [...new Set(stages.map((s) => s.station))];

  /* Falls back to the first column, which is itself derived from the stage rows
     when no stations are configured. Keyed off `stations` alone this was `null`
     in exactly that case, while the kitchen had fired everything to a station
     called "Pass" — so the columns drew, the cards drew, and not one of them
     listed any food. The snapshot now supplies the implicit pass too; this is
     the second half of the same fix, so a card cannot be emptied by a
     disagreement between two sources again. */
  const firstStation = (stations[0]?.name) ?? columns[0] ?? null;
  const linesForStation = (ticketId: string | null, station: string) =>
    (linesOf.get(ticketId ?? '') ?? []).filter((l) => (l.station ?? firstStation) === station);

  /* §4: "All-day strip across the top: chips of {count} {dish} — what the
     kitchen actually needs to cook, aggregated across tickets." Counted across
     every live ticket, because a cook batching six burgers wants one number,
     not six cards to add up in their head. */
  const allDay = useMemo(() => {
    const n = new Map<string, number>();
    /* Count each TICKET once, not once per station it touched. Iterating the
       stage rows double-counted a ticket that hit two stations, so one burger
       and one cola read as two of each. */
    const seen = new Set<string>();
    for (const s of stages) {
      if (s.stage === 'Served' || !s.ticket_id || seen.has(s.ticket_id)) continue;
      seen.add(s.ticket_id);
      for (const l of linesOf.get(s.ticket_id) ?? []) {
        n.set(l.name, (n.get(l.name) ?? 0) + Number(l.qty));
      }
    }
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [stages, linesOf]);

  const advance = async (kdsId: string, stage: string) => {
    await outbox.enqueue('kds_advance', { kdsId, stage });
    await onQueued();
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ── All-day strip (§4) ──────────────────────────────────────────── */}
      <div className="krail" style={{
        flexShrink: 0, display: 'flex', gap: 8, padding: '10px 14px',
        overflowX: 'auto', borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-1)',
      }}>
        <span style={{ flexShrink: 0, alignSelf: 'center', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-faint)' }}>
          ALL DAY
        </span>
        {allDay.map(([name, count]) => (
          <span key={name} style={{
            flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: 7,
            padding: '6px 11px', borderRadius: 999, background: 'var(--bg-2)',
            border: '1px solid var(--line)',
          }}>
            <span style={{ fontSize: 13, fontWeight: 800, fontFamily: MONO, color: 'var(--warn-bright)' }}>
              {count}
            </span>
            <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
              {name}
            </span>
          </span>
        ))}
        {!allDay.length && (
          <span style={{ alignSelf: 'center', fontSize: 11.5, color: 'var(--text-faint)' }}>
            Nothing on the pass.
          </span>
        )}
      </div>

      {/* ── Station columns (§4) ────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 1, background: 'var(--line-soft)', overflowX: 'auto' }}>
        {columns.map((station) => {
          const target = stations.find((s) => s.name === station)?.target_mins ?? 12;
          const cards = stages
            .filter((s) => s.station === station && s.stage !== 'Served')
            // Fire order: the oldest ticket is the most urgent, always.
            .sort((a, b) => new Date(a.fired_at).getTime() - new Date(b.fired_at).getTime());

          return (
            <section key={station} style={{
              flex: '1 1 260px', minWidth: 240, background: 'var(--bg)',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              <div style={{ flexShrink: 0, padding: '10px 12px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{station}</span>
                <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: MONO }}>{target}m</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO, color: 'var(--text-dim)' }}>{cards.length}</span>
              </div>

              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
                {cards.map((s) => {
                  const mins = (now.getTime() - new Date(s.fired_at).getTime()) / 60000;
                  const over = mins / (s.target_mins || target);
                  /* §4: the tint shifts to --warn then --red as the ticket
                     passes its station target. Two thresholds, both relative to
                     THIS station's target rather than a shared clock. */
                  const tint = over >= 1 ? 'var(--red-dim)' : over >= 0.75 ? 'var(--warn-dim)' : 'var(--bg-1)';
                  const edge = over >= 1 ? 'var(--red-line)' : over >= 0.75 ? 'var(--warn-line)' : 'var(--line)';
                  const clock = over >= 1 ? 'var(--red-bright)' : over >= 0.75 ? 'var(--warn-bright)' : 'var(--text-faint)';
                  const next = NEXT[s.stage];

                  return (
                    <article key={s.id} style={{
                      background: tint, border: '1px solid ' + edge, borderRadius: 9, overflow: 'hidden',
                    }}>
                      <div style={{ padding: '9px 11px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, letterSpacing: '-.02em', color: 'var(--text)' }}>
                          {tableOf.get(s.ticket_id ?? '') ?? '—'}
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{s.stage}</span>
                        <span style={{ flex: 1 }} />
                        <span style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO, color: clock }}>
                          {Math.floor(mins)}m
                        </span>
                      </div>

                      <div style={{ padding: '0 11px 9px' }}>
                        {linesForStation(s.ticket_id, station).map((l, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO, color: 'var(--warn-bright)', minWidth: 18 }}>
                              {Number(l.qty)}
                            </span>
                            <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{l.name}</span>
                          </div>
                        ))}
                      </div>

                      {next && (
                        <button
                          onClick={() => void advance(s.id, next)}
                          style={{
                            width: '100%', minHeight: 40, textAlign: 'center',
                            background: 'var(--bg-2)', borderTop: '1px solid ' + edge,
                            color: 'var(--text)', fontSize: 12, fontWeight: 700,
                          }}
                        >
                          {next}
                        </button>
                      )}
                    </article>
                  );
                })}

                {!cards.length && (
                  <div style={{ padding: '26px 6px', textAlign: 'center', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)' }}>
                    Nothing waiting on {station}. Rounds fired from the floor land here.
                  </div>
                )}
              </div>
            </section>
          );
        })}

        {!columns.length && (
          <div style={{ flex: 1, display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 24 }}>
            <div style={{ maxWidth: 380, textAlign: 'center', fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-faint)' }}>
              No stations are configured for this outlet yet, and nothing has been fired.
              Rounds sent from the POS Floor appear here as soon as they are.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export { STAGES };
