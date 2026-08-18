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
}
export interface Tax { code: string; rate: string; }
export interface Item {
  id: string; name: string; category: string | null; price: string; off_menu: boolean;
}
export interface TicketLine { name: string; qty: string; price: string; sent: boolean; station: string | null; }
export interface Ticket {
  id: string; table_no: string | null; split: number; covers: number;
  status: string; lines: TicketLine[];
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
