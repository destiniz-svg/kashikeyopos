/* What survives a locked phone.
 *
 * 03-GUEST-PORTAL-SPEC.md §8: "The portal persists table, cart, sent rounds,
 * identity, promo and diet filters under a versioned key, and restores on
 * reload — a guest whose phone locks does not lose their round."
 *
 * Versioned because a shape change must not resurrect as a half-read object: a
 * key written by an older build is dropped, not migrated field by field. A
 * guest losing a cart at a deploy is a small annoyance; a guest getting
 * somebody else's cart, or a cart the till never saw, is not.
 *
 * Scoped by OUTLET AND TABLE. Two tables in one restaurant are two parties, and
 * a phone that walks from table 4 to table 9 must not carry the first table's
 * round with it.
 */

const VERSION = 1;
const key = (outletId: number, table: string) => `kashikeyo.guest.v${VERSION}.${outletId}.${table}`;

export interface CartLine {
  lineId: string;       // local only — identifies the row for edit and removal
  itemId: string;
  name: string;
  qty: number;
  unitPrice: number;    // laari, as quoted by the snapshot when it was added
  /* What was added on top. `unitPrice` already includes it — the phone shows
     one figure per line, and the TILL prices the round again when it accepts
     it, from its own catalogue. This is what the guest was quoted, never what
     they will be charged: those two agreeing is the server's job. */
  addons?: Array<{ id: string; name: string; price: number; qty: number }>;
  note?: string;
}

export interface SentRound {
  opId: string;
  at: number;
  lines: CartLine[];
  serverId?: string;    // set once the till has it; absent = still unsent
}

export interface Identity { name: string; phone: string; }

export interface Persisted {
  v: number;
  cart: CartLine[];
  sent: SentRound[];
  ident: Identity | null;
  promo: string;
  diets: string[];
  rated: boolean;
}

const EMPTY: Persisted = { v: VERSION, cart: [], sent: [], ident: null, promo: '', diets: [], rated: false };

export function load(outletId: number, table: string): Persisted {
  if (!table) return { ...EMPTY };
  try {
    const raw = localStorage.getItem(key(outletId, table));
    if (!raw) return { ...EMPTY };
    const d = JSON.parse(raw) as Persisted;
    if (!d || d.v !== VERSION) return { ...EMPTY };
    return {
      v: VERSION,
      cart: Array.isArray(d.cart) ? d.cart : [],
      sent: Array.isArray(d.sent) ? d.sent : [],
      ident: d.ident && typeof d.ident === 'object' ? d.ident : null,
      promo: typeof d.promo === 'string' ? d.promo : '',
      diets: Array.isArray(d.diets) ? d.diets : [],
      rated: !!d.rated,
    };
  } catch {
    // Private browsing, a full quota, a corrupted value. The session lives in
    // memory instead — degraded, never broken.
    return { ...EMPTY };
  }
}

export function save(outletId: number, table: string, d: Omit<Persisted, 'v'>): void {
  if (!table) return;
  try {
    localStorage.setItem(key(outletId, table), JSON.stringify({ v: VERSION, ...d }));
  } catch { /* see load() */ }
}
