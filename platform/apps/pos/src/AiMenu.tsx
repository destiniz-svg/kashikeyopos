import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* AI Menu Builder — 02-POS-SPEC §2 (`aimenu`): "Cost-engineered menu
 * suggestions from the live item master."
 *
 * THE SCREEN WORKS WITH NO API KEY, and that is the design rather than a
 * fallback. Everything that decides anything here — what a dish costs today,
 * what margin it makes, how often it sells, where it sits against the rest of
 * this menu, what it would have to cost to hit a target — is arithmetic over
 * this outlet's own item master and its own sales. A model cannot know any of
 * it. The one thing a model is for is prose, and that panel says exactly what
 * is missing instead of failing or, worse, inventing a suggestion locally and
 * presenting it as advice.
 *
 * FOUR BOXES, NOT A SORTED LIST. A menu-engineering answer is two comparisons
 * at once — does it sell, does it earn — and a single ranked table collapses
 * one of them. The four columns are the actual method, and each one carries the
 * action rather than the label: a puzzle is not "a puzzle", it is "move it up
 * the menu".
 *
 * THE AVERAGES ARE ON SCREEN. A dish is called a dog by comparison with this
 * menu's own mean margin and mean volume, so a manager is entitled to see what
 * it was compared against — otherwise the four boxes are an oracle.
 *
 * THE TARGET PRICE IS AN INPUT, NOT A CONSTANT. There is no house GP figure
 * baked in, because a menu of beverages and a menu of steaks have nothing to
 * say to each other and a hardcoded "60%" would be exactly the invented
 * configuration this build refuses to ship. Type the target; the column
 * appears.
 */

const MONO = "'JetBrains Mono',monospace";
const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 13, padding: 14,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 10px',
};
const box: React.CSSProperties = {
  font: `400 14px/1 ${MONO}`, padding: '8px 9px', borderRadius: 8,
  background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--line-2)',
};
const btn = (primary?: boolean): React.CSSProperties => ({
  padding: '7px 13px', borderRadius: 9, cursor: 'pointer', font: '600 13px/1 system-ui',
  background: primary ? 'var(--amber)' : 'var(--bg-2)',
  color: primary ? '#111214' : 'var(--text-dim)',
  border: primary ? 'none' : '1px solid var(--line-2)',
});

const money = (laari: number) => (laari / 100)
  .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Dish {
  itemId: string; name: string; category: string | null;
  price: number; plateCost: number; net: number; gp: number;
  gpPct: number; foodCostPct: number;
  costed: boolean; incomplete: boolean;
  sold: number; revenue: number; contribution: number;
  bookedUnitCost: number | null; costDriftPct: number | null;
  suggestedPrice: number | null;
  quadrant: 'star' | 'ploughhorse' | 'puzzle' | 'dog' | null;
  why: string;
}
interface Board {
  days: number; taxRatePct: number; targetGpPct: number | null;
  items: Dish[];
  benchmark: {
    dishesRanked: number; meanSold: number; meanGpPct: number;
    uncosted: number; unsold: number;
  };
  ai: { configured: boolean; model: string; needs: string | null };
}
interface Draft {
  configured: boolean; needs?: string | null; model?: string;
  itemId: string; name: string; ingredients: string[];
  draft?: string; why?: string; note?: string;
}

/* The action, not the label. "Puzzle" is jargon; "move it up the menu" is the
   thing to do on Monday. */
const QUADRANT: Record<string, { title: string; action: string; tone: string }> = {
  star: { title: 'Stars', action: 'Sell well and make money. Protect them — do not reprice on a whim.', tone: 'var(--go-bright)' },
  ploughhorse: { title: 'Plough-horses', action: 'Sell well and make little. Reprice, or take cost out of the plate.', tone: 'var(--warn-bright)' },
  puzzle: { title: 'Puzzles', action: 'Make money and nobody orders them. Move them up the menu, or off it.', tone: 'var(--amber-bright)' },
  dog: { title: 'Dogs', action: 'Sell badly and make little. These are the candidates to cut.', tone: 'var(--red-bright)' },
};

export function AiMenu({ session }: { session: Session }) {
  const call = useMemo(() => api.authed(session), [session]);
  const [data, setData] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [days, setDays] = useState('30');
  const [target, setTarget] = useState('');
  const [applied, setApplied] = useState({ days: '30', target: '' });
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ days: applied.days });
    if (applied.target) q.set('targetGpPct', applied.target);
    try { setData(await call<Board>('GET', `/aimenu?${q}`)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [call, applied]);

  useEffect(() => { void load(); }, [load]);

  if (error && !data) return <div style={{ ...card, color: 'var(--red-bright)' }}>{error}</div>;
  if (!data) return <div style={{ ...card, color: 'var(--text-muted)' }}>Reading…</div>;

  const dish = (d: Dish) => (
    <div key={d.itemId} style={{
      padding: '9px 10px', borderRadius: 9, background: 'var(--bg-2)',
      border: '1px solid var(--line)',
    }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ font: '600 13px/1.3 system-ui', color: 'var(--text)' }}>{d.name}</span>
        {d.category && (
          <span style={{ font: '400 11px/1.3 system-ui', color: 'var(--text-faint)' }}>
            {d.category}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ font: `600 13px/1.3 ${MONO}`, color: 'var(--text)' }}>
          {money(d.price)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4,
        font: `400 11px/1.4 ${MONO}`, color: 'var(--text-faint)' }}>
        <span>costs {money(d.plateCost)}</span>
        <span style={{ color: d.gpPct >= data.benchmark.meanGpPct
          ? 'var(--go-bright)' : 'var(--warn-bright)' }}>
          {d.gpPct}% GP
        </span>
        <span>sold {d.sold}</span>
        <span style={{ color: 'var(--text-dim)' }}>{money(d.contribution)} contribution</span>
      </div>
      {/* The drift: the price was set against a cost that has since moved. */}
      {d.costDriftPct !== null && Math.abs(d.costDriftPct) >= 5 && (
        <div style={{ marginTop: 4, font: '400 11px/1.4 system-ui',
          color: d.costDriftPct > 0 ? 'var(--red-bright)' : 'var(--go-bright)' }}>
          The plate costs {Math.abs(d.costDriftPct)}% {d.costDriftPct > 0 ? 'more' : 'less'} today
          than it did on average when it sold — this price was set against a different cost.
        </div>
      )}
      {d.suggestedPrice !== null && (
        <div style={{ marginTop: 4, font: `400 11px/1.4 ${MONO}`, color: 'var(--amber-bright)' }}>
          {money(d.suggestedPrice)} would hit {data.targetGpPct}% GP
          {d.suggestedPrice !== d.price
            && ` (${d.suggestedPrice > d.price ? '+' : ''}${money(d.suggestedPrice - d.price)})`}
        </div>
      )}
      {d.incomplete && (
        <div style={{ marginTop: 4, font: '400 11px/1.4 system-ui', color: 'var(--warn-bright)' }}>
          Something in this recipe has no cost — the figure above is not the whole story.
        </div>
      )}
      {session.rank >= 4 && (
        <button type="button" style={{ ...btn(), marginTop: 7, padding: '5px 10px' }}
          disabled={busy === d.itemId}
          onClick={() => void (async () => {
            setBusy(d.itemId); setError('');
            try {
              setDraft(await call<Draft>('POST', `/aimenu/${d.itemId}/describe`, { tone: 'plain' }));
            } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(''); }
          })()}>
          Write menu copy
        </button>
      )}
    </div>
  );

  const inQuadrant = (q: string) => data.items.filter((d) => d.quadrant === q);
  const uncosted = data.items.filter((d) => !d.costed);
  const unsold = data.items.filter((d) => d.costed && !d.sold);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── what everything below is measured against ──────────────────── */}
      <div style={{ ...card, display: 'flex', gap: 22, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={h}>Dishes ranked</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`, color: 'var(--text)' }}>
            {data.benchmark.dishesRanked || 'none'}
          </div>
        </div>
        <div>
          <div style={h}>This menu&rsquo;s average GP</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`, color: 'var(--text)' }}>
            {data.benchmark.meanGpPct}%
          </div>
        </div>
        <div>
          <div style={h}>Average sold</div>
          <div style={{ font: `600 22px/1.1 ${MONO}`, color: 'var(--text)' }}>
            {data.benchmark.meanSold}
          </div>
        </div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={h}>Window (days)</span>
          <input value={days} inputMode="numeric" style={{ ...box, width: 88 }}
            onChange={(e) => setDays(e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={h}>Target GP %</span>
          <input value={target} inputMode="decimal" placeholder="none"
            style={{ ...box, width: 96 }}
            onChange={(e) => setTarget(e.target.value)} />
        </label>
        <button type="button" style={btn(true)}
          onClick={() => setApplied({ days, target })}>
          Apply
        </button>
        <div style={{ flex: 1, minWidth: 260, font: '400 11px/1.6 system-ui',
          color: 'var(--text-faint)' }}>
          Every dish below is judged against this menu&rsquo;s own averages, not an
          industry figure. Margin is measured on the price NET of the {data.taxRatePct}% GST —
          measuring it on the menu price flatters every dish by the tax rate at once,
          so nothing looks wrong.
        </div>
      </div>

      {/* ── the four boxes ─────────────────────────────────────────────── */}
      {data.benchmark.dishesRanked === 0 ? (
        <div style={{ ...card, font: '400 13px/1.6 system-ui', color: 'var(--text-muted)' }}>
          Nothing has sold in this window, so there is no popularity to rank against.
          The costing below is still live — it is the sales half that is missing.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12,
          gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
          {(['star', 'ploughhorse', 'puzzle', 'dog'] as const).map((q) => {
            const list = inQuadrant(q);
            return (
              <div key={q} style={card}>
                <div style={{ ...h, color: QUADRANT[q].tone }}>{QUADRANT[q].title}</div>
                <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)',
                  margin: '-6px 0 10px' }}>
                  {QUADRANT[q].action}
                </div>
                {list.length === 0 ? (
                  <div style={{ font: '400 13px/1.5 system-ui', color: 'var(--text-muted)' }}>
                    None.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>{list.map(dish)}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── the two honest exclusions ──────────────────────────────────── */}
      {uncosted.length > 0 && (
        <div style={card}>
          <div style={h}>Not costed — ranked nowhere</div>
          <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)',
            margin: '-6px 0 10px' }}>
            A dish with no recipe is not a 100% margin dish. Putting these top of the
            board as the menu&rsquo;s best performers is how the recipe never gets written.
            Write them in Recipes &amp; Costing.
          </div>
          <div style={{ display: 'grid', gap: 8,
            gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
            {uncosted.map(dish)}
          </div>
        </div>
      )}

      {unsold.length > 0 && (
        <div style={card}>
          <div style={h}>Costed, but nothing sold in this window</div>
          <div style={{ font: '400 11px/1.5 system-ui', color: 'var(--text-faint)',
            margin: '-6px 0 10px' }}>
            No popularity to compare, so they sit outside the four boxes rather than
            being called dogs by default.
          </div>
          <div style={{ display: 'grid', gap: 8,
            gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
            {unsold.map(dish)}
          </div>
        </div>
      )}

      {/* ── the one part that calls out ────────────────────────────────── */}
      <div style={card}>
        <div style={h}>Menu copy</div>
        {data.ai.configured ? (
          <div style={{ font: '400 12px/1.6 system-ui', color: 'var(--text-muted)' }}>
            {data.ai.model} is configured. Pick a dish above and press
            &ldquo;Write menu copy&rdquo; — it returns a draft, and nothing is saved until
            you save it in Menu Master.
          </div>
        ) : (
          <div style={{ font: '400 12px/1.6 system-ui', color: 'var(--text-muted)' }}>
            No model is configured, and everything above this panel works without one —
            it is your own menu and your own sales. Writing menu copy is the only part
            that calls out to an outside service.
            <div style={{ marginTop: 6, font: `400 12px/1.5 ${MONO}`,
              color: 'var(--warn-bright)' }}>
              {data.ai.needs}
            </div>
          </div>
        )}

        {draft && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 10,
            background: 'var(--bg-2)', border: '1px solid var(--line-2)' }}>
            <div style={{ font: '600 13px/1.3 system-ui', color: 'var(--text)' }}>
              {draft.name}
            </div>
            <div style={{ font: `400 11px/1.4 ${MONO}`, color: 'var(--text-faint)',
              marginTop: 3 }}>
              {draft.ingredients.length ? draft.ingredients.join(' · ') : 'no recipe written'}
            </div>
            {draft.draft ? (
              <>
                <div style={{ marginTop: 8, font: '400 14px/1.6 system-ui',
                  color: 'var(--text)' }}>
                  {draft.draft}
                </div>
                <div style={{ marginTop: 6, font: '400 11px/1.5 system-ui',
                  color: 'var(--text-faint)' }}>
                  {draft.note}
                </div>
              </>
            ) : (
              <div style={{ marginTop: 8, font: '400 12px/1.6 system-ui',
                color: 'var(--text-muted)' }}>
                {draft.why}
                <div style={{ marginTop: 6, font: `400 12px/1.5 ${MONO}`,
                  color: 'var(--warn-bright)' }}>
                  {draft.needs}
                </div>
              </div>
            )}
            <button type="button" style={{ ...btn(), marginTop: 10 }}
              onClick={() => setDraft(null)}>
              Close
            </button>
          </div>
        )}
      </div>

      {error && (
        <div style={{ ...card, color: 'var(--red-bright)', font: '400 13px/1.4 system-ui' }}>
          {error}
        </div>
      )}
    </div>
  );
}
