/* The member portal's one door to the API.
 *
 * Same shape as the guest portal's: one BASE, configured at build time, so the
 * deployed bundle carries no same-origin assumption. Everything else in this
 * app goes through `call`.
 */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const BASE = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? '';

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : 'no connection');
  }
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) {
    const msg = (json && typeof json === 'object' && 'error' in json)
      ? String((json as { error: unknown }).error) : 'Something went wrong.';
    throw new ApiError(r.status, msg);
  }
  return json as T;
}

export interface Tier { name: string | null; next: string | null; toNext: number }
export interface Card {
  name: string | null;
  phone: string;
  memberSince: string;
  points: number;
  worth: number;
  tier: Tier;
  scheme: { earnPerMvr: number; pointValue: number; running: boolean };
}
export interface Visit {
  at: string; outlet: string; covers: number; total: number; points: number;
}
export interface Visits {
  visits: Visit[];
  totals: { visits: number; spent: number; earned: number };
}
export interface Reward {
  id: string; name: string; points: number; value: number;
  affordable: boolean; short: number;
}
export interface Voucher {
  id: string; code: string; name: string; value: number; points: number;
  issuedAt: string; expiresAt: string | null; redeemedAt: string | null;
  state: 'ready' | 'used' | 'expired';
}
export interface Catalogue { points: number; rewards: Reward[]; vouchers: Voucher[] }
export interface BillLine {
  name: string; qty: number; price: number; amount: number; sent: boolean;
}
export interface Bill {
  open?: false;
  outlet: { id: number; name: string };
  ticketId: string; table: string | null; covers: number; openedAt: string;
  lines: BillLine[]; goods: number;
  pointsOffered: number | null; offeredAt: string | null;
}

export const requestCode = (phone: string) =>
  call<{ sent: boolean; to: string }>('POST', '/api/member/code', { phone });

export const signIn = (phone: string, code: string) =>
  call<{ token: string; expiresAt: number; member: Card }>(
    'POST', '/api/member/session', { phone, code });

export function authed(token: string) {
  return {
    me: () => call<Card>('GET', '/api/member/me', undefined, token),
    visits: () => call<Visits>('GET', '/api/member/visits', undefined, token),
    rewards: () => call<Catalogue>('GET', '/api/member/rewards', undefined, token),
    redeem: (rewardId: string) => call<{ code: string; name: string; message: string }>(
      'POST', '/api/member/redeem', { rewardId }, token),
    bill: () => call<Bill>('GET', '/api/member/bill', undefined, token),
    offerPoints: (outletId: number, ticketId: string, points: number) =>
      call<{ points: number; worth: number; message: string }>(
        'POST', '/api/member/bill/points', { outletId, ticketId, points }, token),
  };
}
