/* The seam the prototype did not have.
 *
 * design/KashikeyoGuest QR v3.dc.html talks to the till through localStorage —
 * `kashikeyo.session.v3` for what the till holds, `kashikeyo.bridge.v1` for
 * what the phone posts back. That exists so the prototype runs in a browser
 * with no server; README.md is explicit that "in production that seam is the
 * API". This file is that seam, and nothing else in the app knows the
 * difference.
 *
 * Two rules carried over from the spec, and they shape every function here:
 *
 *   · A PHONE NEVER DECIDES MONEY. There is no settle(), no charge(), no
 *     endpoint here that moves a ledger. `askToPay` posts a REQUEST. The till
 *     takes the money, because that is where it is attributable to a person,
 *     a rank and a device.
 *   · The bill is the till's. The phone renders `snapshot.tickets`; it never
 *     keeps its own copy of what is owed, or the two disagree the moment a
 *     server adds a round at the table.
 */

export type Money = number;   // integer laari (MVR × 100), never a float

export interface Outlet {
  id: number;
  name: string;
  currency: string;
  service_pct: string;
  tables: number;
}

export interface Tax { code: string; rate: string; }

export interface Item {
  id: string;
  name: string;
  category: string | null;
  price: string;        // MVR, as numeric(12,2) from the database
  off_menu: boolean;
}

export interface TicketLine { name: string; qty: string; price: string; sent: boolean; }

export interface Ticket {
  id: string;
  table_no: string | null;
  split: number;
  covers: number;
  status: string;
  lines: TicketLine[];
}

export interface Stage {
  ticket_id: string | null;
  station: string;
  stage: string;
  target_mins: number;
  fired_at: string;
}

export interface Snapshot {
  v: number;
  at: number;
  outlet: Outlet | null;
  tax: Tax | null;
  items: Item[];
  tickets: Ticket[];
  stages: Stage[];
}

export interface GuestOrderLine { itemId: string; qty: number; addons?: string[]; note?: string; }

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/* The API origin. Configured at build time so the deployed static bundle has
   no same-origin assumption in it; falls back to same-origin for `vite dev`,
   which proxies /api. */
const BASE = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? '';

export interface GuestSession {
  token: string;
  outletId: number;
  table: string;
  outlet: string;
  expiresAt: number;
}

/* Exchange a table for a session.
 *
 * The QR card carries an outlet and a table and NO credential — a laminated
 * card on a table cannot hold a secret. The token comes from here, is pinned to
 * that one table, and expires in hours rather than living as long as the card.
 * It is rank 0, so every till endpoint refuses it. */
export async function openGuestSession(outletId: number, table: string): Promise<GuestSession> {
  const r = await fetch(BASE + `/api/outlet/${outletId}/guest/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table }),
  });
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* an error page */ }
  if (!r.ok) {
    const msg = (json && typeof json === 'object' && 'error' in json)
      ? String((json as { error: unknown }).error)
      : 'We could not open your table.';
    throw new ApiError(r.status, msg);
  }
  return json as GuestSession;
}

/** The outlet's public face, for the table gate: the name to welcome someone
 *  with and how many tables to draw. The gate renders before any table has been
 *  chosen, so there is no session to read a snapshot with — and this is the same
 *  information as the sign over the door, so it needs no credential. */
export async function outletCard(outletId: number): Promise<{ name: string; tables: number } | null> {
  try {
    const r = await fetch(BASE + `/api/outlet/${outletId}/guest/card`);
    if (!r.ok) return null;
    return await r.json() as { name: string; tables: number };
  } catch {
    return null;
  }
}

export class Api {
  constructor(private outletId: number, private token: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(BASE + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + this.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* an error page, not JSON */ }
    if (!r.ok) {
      const msg = (json && typeof json === 'object' && 'error' in json)
        ? String((json as { error: unknown }).error)
        : 'Something went wrong. Please ask a member of our team.';
      throw new ApiError(r.status, msg);
    }
    return json as T;
  }

  /** Prices, open tickets and kitchen stages — the stable published interface
   *  the spec calls "the till's live session snapshot". It carries no costs, no
   *  margins and no staff records: a guest device has no business holding
   *  those, so they are not in the projection at all. */
  snapshot(): Promise<Snapshot> {
    return this.call<Snapshot>('GET', `/api/outlet/${this.outletId}/snapshot`);
  }

  /** Post a round. `opId` is generated on the phone and is what makes a retry
   *  safe: a guest on hotel wifi who taps Send twice, or whose request times
   *  out and retries, gets ONE order. The server returns the stored result for
   *  a replay rather than creating a second. */
  sendRound(opId: string, table: string, lines: GuestOrderLine[], promo?: string,
            name?: string, phone?: string) {
    return this.call<{ id: string; at: string; status: string }>(
      'POST', `/api/outlet/${this.outletId}/guest/order`,
      { opId, table, lines, promo, name, phone });
  }

  /** What is this code worth on what is in the cart?
   *
   *  03-GUEST-PORTAL-SPEC §4: "the phone treats an entered code as an OFFER,
   *  never a fact." So this asks the server — the SAME evaluator the till uses
   *  at settlement, reading the same row — and shows the answer as an offer.
   *  The code still travels with the order and the till decides again, by which
   *  time the basket, the clock and the caps may all have moved. */
  quotePromo(code: string, goods: number) {
    return this.call<{
      ok: boolean; reason?: string; code?: string; name?: string;
      discount?: number; discountMvr?: number; capped?: boolean; note?: string;
    }>('POST', `/api/outlet/${this.outletId}/guest/promo`, { code, goods });
  }

  /** Call a server, ask for water, ask for the bill. Each appears on the floor
   *  terminal until somebody acknowledges it. */
  request(table: string, kind: 'server' | 'bill' | 'water' | 'help', detail?: string) {
    return this.call<{ id: string; at: string }>(
      'POST', `/api/outlet/${this.outletId}/guest/request`,
      { table, kind, detail });
  }

  /** "Ask to pay" — a REQUEST carrying the tender preference, the split and the
   *  tip. It charges nothing. The cashier settles, and the ledger fires once,
   *  on the till. */
  askToPay(table: string, detail: string) {
    return this.request(table, 'bill', detail);
  }
}
