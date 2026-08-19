import { useCallback, useEffect, useState } from 'react';
import * as api from './api';
import type { Session } from './api';

/* The estate, as the two screens that read it see it.
 *
 * Owner Dashboard and Chain Overview are ONE payload from ONE endpoint. They
 * are different questions of the same figures — "how is the group doing" and
 * "how does each branch compare" — and if each fetched its own thing they would
 * eventually be two derivations, then two answers, then an argument nobody on
 * either screen could settle. So the types and the fetch live here and the
 * screens are presentation.
 */

export const MONO = "'JetBrains Mono',monospace";

export const mvr = (n: number | null | undefined) =>
  n === null || n === undefined ? '—'
    /* `+ 0` collapses negative zero. The P&L shows costs as negatives, so a
       labour line of zero came out as "-0.00" — which reads as a rounding
       artefact on a screen whose whole job is being trusted at a glance. */
    : (n + 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A percentage, or an em dash. Never "0%" for a figure that does not exist —
 *  that is the difference between a kitchen at zero food cost and a kitchen
 *  that has not sold anything. */
export const pctText = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n + '%';

export const shortDay = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB',
    { weekday: 'short', day: 'numeric', month: 'short' });

export interface OutletRow {
  id: number; name: string; code: string;
  takings: number; revenue: number; covers: number; bills: number;
  cogs: number; tax: number; discount: number; service: number;
  lastSaleAt: string | null;
  sharePct: number | null; foodCostPct: number | null; silent: boolean;
  alerts: {
    servicesOverdue: number;
    houseOverLimit: number; houseOverLimitValue: number;
    salesUnjournalled: number;
    receipts: { low: number | null; high: number | null; count: number; missing: number };
  } | null;
}

export interface Waiting {
  kind: string; text: string; value: number | null; goTo: string;
}

export interface Overview {
  requested: string; date: string; fellBack: boolean; tradedToday: boolean;
  target: {
    foodCostTargetPct: number | null;
    labourTargetPct: number; primeTargetPct: number;
    weights: Record<string, number>;
    setAt: string | null;
  };
  briefing: {
    score: number | null;
    why: Array<{ points: number; cause: string }>;
    headline: string; context: string;
  };
  figures: {
    netSales: { value: number; deltaPct: number | null; against: string };
    covers: { value: number; deltaPct: number | null; against: string };
    foodCost: { value: number | null; money: number; deltaPct: number | null;
      target: number | null; over: boolean | null; against: string };
    labour: { value: number | null; money: number; target: number;
      over: boolean | null; posted: boolean; against: string };
    primeCost: { value: number | null; money: number; target: number;
      over: boolean | null; complete: boolean; against: string };
    profit: { value: number; pct: number | null; against: string };
  };
  series: {
    from: string; to: string;
    bars: Array<{ date: string; revenue: number | null; traded: boolean }>;
    plottable: boolean; tradingDays: number;
    lastSeven: number; previousSeven: number;
    growthPct: number | null; growthSuppressed: string | null;
  };
  outlets: OutletRow[];
  pnl: {
    revenue: number; costOfSales: number; costOfSalesPct: number | null;
    grossProfit: number; grossMarginPct: number | null;
    labour: number; labourPct: number | null;
    primeCost: number; primeCostPct: number | null;
    overheads: number; overheadsPct: number | null;
    overheadLines: Array<{ code: string; name: string; balance: number }>;
    netProfit: number; netMarginPct: number | null;
    bar: Array<{ key: string; pct: number }>;
  };
  position: {
    ours: Array<{ key: string; label: string; value: number }>;
    heldForOthers: Array<{ key: string; label: string; value: number }>;
  };
  waiting: Waiting[];
  controls: Array<{ key: string; label: string; state: string; detail: string }>;
  reconciliation: {
    cogsFromSales: number; cogsFromLedger: number; difference: number; agrees: boolean;
  };
}

/**
 * One fetch, shared.
 *
 * The date in state is the day ASKED FOR; `data.date` is the day the server
 * actually had figures for, and `data.fellBack` says whether they differ. The
 * input keeps showing what was asked so an owner can see the fallback happen
 * rather than wonder why the date box disagrees with the heading.
 */
export function useOverview(session: Session) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const call = api.chainAuthed(session);
      setData(await call<Overview>('GET', `/estate/overview?date=${date}`));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [session, date]);

  useEffect(() => { void load(); }, [load]);

  return { data, error, loading, date, setDate, reload: load };
}
