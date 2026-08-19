/* The outbox — 02-POS-SPEC.md §5.1.
 *
 * "Every write queues with a locally generated opId, a Lamport counter for
 *  ordering, and a state of queued | sent | done | conflict."
 *
 * WHY THE UI NEVER AWAITS THE NETWORK. §5: "The UI reads the local cache, never
 * the network directly. A fetch updates the cache; the cache notifies the UI.
 * This is what makes offline the normal case rather than a degraded mode."
 *
 * So selling is a local write that always succeeds. The queue drains when there
 * is a network; nothing about taking money depends on there being one. A till
 * that refuses to sell because the wifi dropped is a till that has failed at the
 * only job it has.
 *
 * IDEMPOTENCY. The `opId` is generated HERE, once, when the operation is
 * created — never at send time. That is the whole of the story: a retry sends
 * the same id, and the server's op_log has it as a primary key, so a replay
 * returns the stored result instead of doing the work twice. Minting the id at
 * send time would make every retry a new sale, which is the exact failure this
 * design exists to prevent.
 *
 * DURABILITY. IndexedDB, not localStorage: a day's tickets do not fit in 5MB,
 * and localStorage is synchronous — a write on the main thread during a rush is
 * a frame the cashier waits for. The queue survives a crash, a reload and a
 * flat battery, because a sale that only exists in a JavaScript variable is a
 * sale that a power cut deletes.
 */

export type OpState = 'queued' | 'sent' | 'done' | 'conflict';

export interface Op {
  opId: string;
  kind: string;
  payload: unknown;
  /** Lamport counter. Orders operations from THIS device without a clock: a
   *  till whose time is wrong (and they are, often) still replays in the order
   *  things actually happened. */
  seq: number;
  at: number;
  state: OpState;
  tries: number;
  lastTriedAt: number | null;
  error: string | null;
  result: unknown;
}

const DB_NAME = 'kashikeyo-pos';
const DB_VERSION = 1;
const STORE = 'outbox';
const CACHE = 'cache';

/* §5.1: "The list is trimmed to 90 entries, keeping all live ones and the tail
   of the settled, so an all-day terminal never grows without bound." */
const KEEP_SETTLED = 90;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'opId' });
        s.createIndex('seq', 'seq');
        s.createIndex('state', 'state');
      }
      if (!db.objectStoreNames.contains(CACHE)) db.createObjectStore(CACHE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  }));
}

export async function allOps(): Promise<Op[]> {
  const rows = await tx<Op[]>(STORE, 'readonly', (s) => s.getAll() as IDBRequest<Op[]>);
  return rows.sort((a, b) => a.seq - b.seq);
}

/** The next Lamport value: one past the highest this device has issued.
 *  Read from the store rather than kept in memory, so a reload does not restart
 *  the sequence and interleave a replayed op ahead of one already queued. */
async function nextSeq(): Promise<number> {
  const rows = await allOps();
  return rows.reduce((a, o) => Math.max(a, o.seq), 0) + 1;
}

/** Queue an operation. Returns immediately — the caller does not await a
 *  network, because there may not be one, and the sale happened either way. */
export async function enqueue(kind: string, payload: unknown): Promise<Op> {
  const op: Op = {
    opId: crypto.randomUUID(),
    kind,
    payload,
    seq: await nextSeq(),
    at: Date.now(),
    state: 'queued',
    tries: 0,
    lastTriedAt: null,
    error: null,
    result: null,
  };
  await tx(STORE, 'readwrite', (s) => s.put(op));
  return op;
}

export async function update(op: Op): Promise<void> {
  await tx(STORE, 'readwrite', (s) => s.put(op));
}

/** Trim settled operations, keeping every live one. A `conflict` is LIVE: it is
 *  a thing somebody has to look at, and trimming it away would lose the only
 *  record that a sale did not land. */
export async function trim(): Promise<void> {
  const rows = await allOps();
  const settled = rows.filter((o) => o.state === 'done');
  if (settled.length <= KEEP_SETTLED) return;
  const drop = settled.slice(0, settled.length - KEEP_SETTLED);
  const db = await open();
  const t = db.transaction(STORE, 'readwrite');
  const s = t.objectStore(STORE);
  for (const o of drop) s.delete(o.opId);
  await new Promise((r) => { t.oncomplete = () => r(null); });
  db.close();
}

export async function pendingCount(): Promise<number> {
  const rows = await allOps();
  return rows.filter((o) => o.state === 'queued' || o.state === 'sent').length;
}

/**
 * Operations the SERVER REFUSED.
 *
 * These are not pending — retrying will be refused again — so they are not in
 * the count above, and for a long time that meant they were counted nowhere and
 * shown nowhere. A sale queued optimistically, refused a second later, and
 * vanished: the ticket panel had already cleared, the flash already said
 * "Sale queued", the pending badge stayed at zero, and the bill simply
 * reappeared on the floor at the next snapshot with nothing anywhere saying
 * why. That is the worst failure mode this application had — money that the
 * till says it took and the books have never heard of.
 */
export async function conflicts(): Promise<Op[]> {
  const rows = await allOps();
  return rows.filter((o) => o.state === 'conflict').sort((a, b) => b.at - a.at);
}

/** Acknowledge a refusal: the operator has read it and dealt with it. */
export async function clearConflict(opId: string): Promise<void> {
  const rows = await allOps();
  const op = rows.find((o) => o.opId === opId);
  if (!op) return;
  /* Marked done rather than deleted, so `trim` ages it out with the rest and
     the record of what was refused survives until then. */
  op.state = 'done';
  await update(op);
}

/* ── the local cache the UI reads ────────────────────────────────────────── */

export async function putCache<T>(key: string, value: T): Promise<void> {
  await tx(CACHE, 'readwrite', (s) => s.put(value as unknown as never, key));
}

export async function getCache<T>(key: string): Promise<T | null> {
  const v = await tx<T | undefined>(CACHE, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  return v === undefined ? null : v;
}

/**
 * Drain the queue. One operation at a time, IN SEQ ORDER, because a sale that
 * closes a ticket must not overtake the round that opened it.
 *
 * A failed send leaves the op `queued` with its error recorded — never dropped,
 * never silently retried forever without a trace. `conflict` is reserved for a
 * server answer that says the operation can never succeed (a 4xx that is not a
 * timeout): retrying that until the end of time would hide it, and somebody
 * needs to look at it.
 */
export async function drain(
  send: (op: Op) => Promise<{ ok: true; result: unknown } | { ok: false; retryable: boolean; error: string }>,
): Promise<{ sent: number; failed: number }> {
  const rows = (await allOps()).filter((o) => o.state === 'queued');
  let sent = 0, failed = 0;
  for (const op of rows) {
    op.tries++;
    op.lastTriedAt = Date.now();
    const out = await send(op);
    if (out.ok) {
      op.state = 'done';
      op.result = out.result;
      op.error = null;
      sent++;
    } else {
      op.error = out.error;
      // Not retryable = the server has made a decision. Stop, and surface it.
      op.state = out.retryable ? 'queued' : 'conflict';
      failed++;
      await update(op);
      // Stop draining on the first failure: the queue is ordered, and pushing
      // later operations past a stuck one is how a closed ticket arrives before
      // the round that filled it.
      break;
    }
    await update(op);
  }
  await trim();
  return { sent, failed };
}
