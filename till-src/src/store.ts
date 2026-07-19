import { useSyncExternalStore } from "react";
import { pull, pushOps, eventsUrl, uid, type Entity } from "./api";

/* Offline-first sync store — reproduces the existing till's engine against the
   same endpoints and localStorage keys, so it is interchangeable with the old
   bundle and preserves the audit-hardened guarantees:
   - a monotonic pull cursor (kashikeyo-cursor) so re-pulls are incremental;
   - an op-log OUTBOX (kashikeyo-outbox) with a stable opId per op, so a retried
     sale can never be duplicated server-side (the ops endpoint dedups on opId);
   - optimistic local application, drained in order when online. */

const K_CURSOR = "kashikeyo-cursor";
const K_OUTBOX = "kashikeyo-outbox";

type Op = { opId: string; puts?: { kind: string; id: string; data: any }[]; dels?: { kind: string; id: string }[]; elev?: string };

class Store {
  ents = new Map<string, Entity>();
  cursor = Number(localStorage.getItem(K_CURSOR) || 0);
  outbox: Op[] = safeParse(localStorage.getItem(K_OUTBOX), []);
  online = typeof navigator !== "undefined" ? navigator.onLine : true;
  syncing = false;
  ready = false;
  private listeners = new Set<() => void>();
  private es: EventSource | null = null;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private emit() { this.listeners.forEach((f) => f()); }

  byKind(kind: string): Entity[] {
    const out: Entity[] = [];
    this.ents.forEach((e) => { if (e.kind === kind && !e.deleted) out.push(e); });
    return out;
  }

  async start() {
    window.addEventListener("online", () => { this.online = true; this.emit(); this.drain(); });
    window.addEventListener("offline", () => { this.online = false; this.emit(); });
    await this.pullAll();
    this.ready = true; this.emit();
    this.connectSSE();
    this.drain();
  }

  async pullAll() {
    try {
      let guard = 0;
      // first sync from 0 always; thereafter incremental from the cursor
      while (guard++ < 100) {
        const j = await pull(this.cursor);
        (j.entities || []).forEach((e) => this.ents.set(e.kind + "|" + e.id, e));
        if (typeof j.rowver === "number") this.cursor = j.rowver;
        if (!j.more) break;
      }
      localStorage.setItem(K_CURSOR, String(this.cursor));
      this.online = true;
      this.emit();
    } catch { this.online = false; this.emit(); }
  }

  private connectSSE() {
    try {
      this.es = new EventSource(eventsUrl());
      this.es.onmessage = () => this.pullAll();
      this.es.onerror = () => { /* browser auto-reconnects */ };
    } catch { /* SSE unavailable — pull-on-drain still works */ }
  }

  private persistOutbox() { localStorage.setItem(K_OUTBOX, JSON.stringify(this.outbox)); }

  /* Optimistically apply puts locally, queue the op, and try to drain. An
     optional elevation token rides with the op (X-Elevation) for refunds. */
  commit(puts: { kind: string; id: string; data: any }[], elev?: string) {
    puts.forEach((p) => this.ents.set(p.kind + "|" + p.id, { kind: p.kind, id: p.id, data: p.data }));
    this.outbox.push({ opId: uid(), puts, ...(elev ? { elev } : {}) });
    this.persistOutbox();
    this.emit();
    this.drain();
  }

  /* Soft-delete entities (op.dels → server sets deleted=true, re-pull removes). */
  del(items: { kind: string; id: string }[]) {
    items.forEach((i) => this.ents.delete(i.kind + "|" + i.id));
    this.outbox.push({ opId: uid(), dels: items });
    this.persistOutbox();
    this.emit();
    this.drain();
  }

  async drain() {
    if (this.syncing || !this.online || this.outbox.length === 0) return;
    this.syncing = true; this.emit();
    try {
      while (this.outbox.length) {
        await pushOps([this.outbox[0]], this.outbox[0].elev);   // idempotent on opId; X-Elevation for refunds
        this.outbox.shift();
        this.persistOutbox();
        this.emit();
      }
      await this.pullAll();
    } catch { this.online = false; /* leave queued for the next online/SSE tick */ }
    this.syncing = false; this.emit();
  }

  status(): "synced" | "saving" | "offline" {
    if (!this.online) return "offline";
    if (this.syncing || this.outbox.length) return "saving";
    return "synced";
  }
  pending() { return this.outbox.reduce((a, o) => a + o.puts.length, 0); }
}

function safeParse<T>(s: string | null, fb: T): T { try { return s ? JSON.parse(s) : fb; } catch { return fb; } }

export const store = new Store();

/* React binding via useSyncExternalStore — every commit/pull re-renders subscribers. */
export function useStore() {
  useSyncExternalStore(store.subscribe, () => store.cursor + ":" + store.outbox.length + ":" + (store.syncing ? 1 : 0) + ":" + store.ents.size + ":" + (store.online ? 1 : 0) + ":" + (store.ready ? 1 : 0));
  return store;
}
