/* The till's seam to the server.
 *
 * Everything that WRITES goes through the outbox, not through here directly —
 * see outbox.ts. This module is the transport: it knows how to sign in, how to
 * read a snapshot, and how to push a batch of queued operations. It does not
 * know what a sale is, because the server decides that (backend/src/sale.js).
 */

export interface Session {
  token: string;
  name: string;
  rank: number;
  outletId: number;
}

export interface Outlet {
  id: number; name: string; currency: string; service_pct: string; tables: number;
  /* What a CASH bill rounds to, in laari; 0 means no rounding. The till has to
     hold this because the server rounds the bill when the tender is cash, and a
     till that cannot compute the same total cannot pay one. */
  cash_round_laari: string | number;
}
export interface Tax { code: string; rate: string; }
export interface Item {
  id: string; name: string; category: string | null; price: string; off_menu: boolean;
  station?: string | null;
  /* The dish's face — migration 037. A null photograph is a first class state:
     the till draws the section artifact in its place, never an empty box. */
  description?: string | null;
  image_url?: string | null;
  tags?: string[];
  spice?: number;
  /* false = offer whatever this dish's section publishes; true = offer only the
     add-ons this dish names, even when it names none. */
  addons_own?: boolean;
}
/** A section, as the merchant styled it. A section with no row here still
 *  exists — it is just one nobody has chosen a colour for yet. */
export interface Section {
  name: string; color: string | null; icon: string | null;
  station: string | null; sort: number; hidden: boolean;
}
/** The priced add-on catalogue. `sections` are the sections that offer it. */
export interface Modifier {
  id: string; name: string; price: string; sections: string[]; sort: number;
}
/** What was actually added to a line, and what each one cost. Written by the
 *  server, never by the terminal. */
export interface LineAddon {
  id: string; name: string; price: number; qty: number; recipeItemId?: string | null;
}
export interface TicketLine {
  /* Staff sessions only — a guest's phone is given the bill to READ, and an id
     it could send back is an id it could send back about somebody else's. */
  id?: string; itemId?: string;
  name: string; qty: string; price: string; sent: boolean; station: string | null;
  addons?: LineAddon[];
  /* What the server told the kitchen about this line — "no onion", "allergy —
     nuts". Written by nobody until §3.3's note was built. */
  note?: string | null;
  /* When it went to the kitchen. "Same again" repeats the last ROUND, and a
     round is everything fired at the same moment — a boolean cannot say that. */
  sentAt?: string | null;
}
export interface Ticket {
  id: string; table_no: string | null; split: number; covers: number;
  status: string; lines: TicketLine[];
  /* When the party sat down. The tile's age counts up from this rather than
     from a stored counter, so it survives a reload and two terminals agree
     (§3.1). */
  opened_at?: string;
  /* Whose bill this split is (§3.3). Null means nobody has said, and the till
     draws "Guest 2" as it always has. */
  guest_name?: string | null;
  /* Set only on a parked bill (§3.5) — the reference the cashier reads off the
     strip to pick it back up. */
  hold_ref?: string | null;
  held_at?: string | null;
  member_id: string | null;
  /* What the member's own phone offered against this bill. Staff sessions
     only — the guest portal is anonymous and gets null. */
  points_offered: string | null;
}
export interface Stage {
  id: string;
  ticket_id: string | null; station: string; stage: string;
  target_mins: number; fired_at: string;
}
export interface Station { name: string; target_mins: number; sort: number; }
export interface Snapshot {
  v: number; at: number;
  outlet: Outlet | null; tax: Tax | null;
  items: Item[]; tickets: Ticket[]; stages: Stage[]; stations: Station[];
  /* The menu's presentation and its add-ons ride on the same snapshot the
     dishes do, because the till is offline half the time and a menu that needs
     a round trip to know what an "extra sambol" costs stops working when the
     wifi does. Optional so an older cached snapshot still parses. */
  sections?: Section[];
  /* The room, when a merchant has named it (migration 038). Empty means nobody
     has — the floor draws the numbered grid, which is what it always did. */
  floor?: Array<{ name: string; zone: string | null; seats: number; sort: number }>;
  /* The busiest dishes of the last four weeks, busiest first. Derived from what
     has sold, never configured — staff sessions only. */
  topItems?: string[];
  /* What the room has taken today and what it cost, for the header strip.
     Staff only. `net` is already net of tax — see backend/src/sale.js. */
  today?: { date: string; net: string; cogs: string; sales: number };
  modifiers?: Modifier[];
  itemModifiers?: Array<{ item_id: string; modifier_id: string }>;
}

export class ApiError extends Error {
  status: number;
  /** A timeout or a 5xx is worth retrying; a 4xx is the server saying no, and
   *  retrying it forever hides the problem. The outbox reads this to decide
   *  between `queued` and `conflict`. */
  retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status === 0 || status >= 500 || status === 429;
  }
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
    // No network at all. Status 0 is retryable by definition — this is the
    // normal state of a till, not an error condition.
    throw new ApiError(0, e instanceof Error ? e.message : 'offline');
  }
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) {
    const msg = (json && typeof json === 'object' && 'error' in json)
      ? String((json as { error: unknown }).error) : 'HTTP ' + r.status;
    throw new ApiError(r.status, msg);
  }
  return json as T;
}

/**
 * An authenticated call to this outlet, through the SAME base URL as everything
 * else.
 *
 * It exists because nine screens each wrote their own `fetch('/api/...')`. That
 * works on a laptop and only on a laptop: the Vite dev and preview servers proxy
 * /api to the API process, so a hard-coded absolute path resolves. Deployed, the
 * POS is a static site on its own origin and the API is somewhere else — every
 * one of those nine screens would have 404'd on first load, and no test would
 * have said so, because the tests call the API directly and the browser checks
 * ran behind the proxy.
 *
 * One helper, one BASE, one place to be wrong.
 */
export function authed(session: { outletId: number; token: string }) {
  return <T = unknown>(method: string, path: string, body?: unknown) =>
    call<T>(method, `/api/outlet/${session.outletId}${path}`, body, session.token);
}

/**
 * The same call, NOT scoped to an outlet.
 *
 * Almost everything in this application is one outlet's business and lives
 * under `/api/outlet/:id/…`, which is why `authed()` puts it there. The estate
 * is the exception the whole tenancy model is built around: it is the chain, it
 * is rank 5, and its path has no outlet in it because it belongs to no outlet.
 *
 * It is a SEPARATE function rather than an argument to `authed()` so that
 * reaching outside one outlet is a visible choice at the call site. A boolean
 * flag would put the most security-relevant decision in this codebase inside a
 * parameter list.
 */
export function chainAuthed(session: { token: string }) {
  return <T = unknown>(method: string, path: string, body?: unknown) =>
    call<T>(method, `/api${path}`, body, session.token);
}

/**
 * Download a file the SERVER produced, through the same base URL and the same
 * token as everything else.
 *
 * A screen that builds its own CSV from JSON it happens to have is a second
 * formatter of the same figures — with its own idea of which columns matter,
 * its own rounding, and, in the one that existed before this, no defence
 * against a memo beginning with `=` becoming a formula when the file is opened.
 * The file the accountant reads should be the file the server wrote.
 *
 * It cannot be a plain link: the API wants an Authorization header, and an
 * `<a href>` cannot carry one. So it is fetched, and handed to the browser as a
 * blob under the filename the server chose.
 */
export function download(session: { outletId: number; token: string }) {
  return async (path: string, fallbackName: string) => {
    let r: Response;
    try {
      r = await fetch(BASE + `/api/outlet/${session.outletId}${path}`, {
        headers: { authorization: 'Bearer ' + session.token },
      });
    } catch (e) {
      throw new ApiError(0, e instanceof Error ? e.message : 'offline');
    }
    const text = await r.text();
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try {
        const j = JSON.parse(text) as { error?: unknown };
        if (j && j.error) msg = String(j.error);
      } catch { /* not json */ }
      throw new ApiError(r.status, msg);
    }
    const named = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = named ? named[1] : fallbackName;
    a.click();
    URL.revokeObjectURL(url);
  };
}

export const signIn = (outletId: number, pin: string, deviceId?: string) =>
  call<Session>('POST', '/api/auth/pin', { outletId, pin, deviceId });

/* ── this machine's identity ───────────────────────────────────────────────
 *
 * A device id is NOT a credential. It lives in this browser's local storage,
 * anybody holding the machine can read it, and anybody can invent one — so the
 * server treats an unknown id as no device at all and the PIN remains the only
 * thing that opens the till (backend/migrations/030).
 *
 * What it buys is attribution and a kill switch: ops carry the machine that
 * made them, and a manager can revoke a till that has walked off, which ends
 * its open sessions immediately. So it is only stored once a PAIRING CODE has
 * been redeemed — an unpaired machine sends nothing and works exactly as
 * before, which is the right behaviour for a new terminal on a Friday night.
 */
const LS_DEVICE = 'kashikeyo.pos.device.v1';

export function thisDevice(): string | null {
  try { return localStorage.getItem(LS_DEVICE); } catch { return null; }
}

export function forgetDevice() {
  try { localStorage.removeItem(LS_DEVICE); } catch { /* private mode */ }
}

/** Redeem a pairing code. Unauthenticated by design — the machine has to be
 *  usable before it is trusted, so this sits in front of the PIN pad. */
export async function pairDevice(outletId: number, code: string) {
  const d = await call<{ id: string; label: string; kind: string }>(
    'POST', `/api/outlet/${outletId}/devices/claim`,
    { code, platform: navigator.userAgent.slice(0, 120), appVersion: APP_VERSION });
  try { localStorage.setItem(LS_DEVICE, d.id); } catch { /* private mode */ }
  return d;
}

export const APP_VERSION = '1.0.0';

export const snapshot = (outletId: number, token: string) =>
  call<Snapshot>('GET', `/api/outlet/${outletId}/snapshot`, undefined, token);

export interface PushResult {
  results: Array<{ opId?: string; replay?: boolean; result?: unknown; error?: string }>;
}

/** Push one operation. The outbox sends them singly and in order — batching
 *  would be fewer round trips, but a batch that half-applies leaves the queue
 *  not knowing which half, and a till cannot afford that ambiguity about money. */
export const push = (outletId: number, token: string, op: { opId: string; kind: string; payload: unknown; at: number }) =>
  call<PushResult>('POST', `/api/outlet/${outletId}/sync/push`, { ops: [op] }, token);
