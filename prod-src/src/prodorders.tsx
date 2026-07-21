import { useMemo, useState } from "react";
import { store, useStore } from "./store";

/* ── Orders tab ──────────────────────────────────────────────────────────────
   Categorized by order type for operational speed, per the merge spec:
     • Walking & QR Tables  — dine-in from the register PLUS QR orders a guest
       placed against a table (otype "dinein", any source).
     • QR Delivery          — delivery orders (otype "delivery").
     • Takeaway             — takeaway orders (otype "takeaway").
   Plus a dedicated "Incoming QR" view that surfaces brand-new guest QR orders
   (source "qr", status "new") from every type in one place, so staff can
   accept them fast without hunting through the floor categories.

   Category is a pure projection of otype/source — never a stored field, so it
   can't drift from what the register/guest portal wrote. Cards reuse
   production's kitchen-ticket layout, themed via the `_` object. */

type Cat = "walk" | "deliv" | "away";
const CATS: { id: Cat; label: string; emoji: string }[] = [
  { id: "walk", label: "Walking & QR Tables", emoji: "🍽️" },
  { id: "deliv", label: "QR Delivery", emoji: "🛵" },
  { id: "away", label: "Takeaway", emoji: "🥡" },
];
const catOf = (o: any): Cat => (o.otype === "delivery" ? "deliv" : o.otype === "takeaway" ? "away" : "walk");

const FLOW = ["new", "preparing", "ready", "delivered", "done"];
const STATUS_LABEL: Record<string, string> = { new: "New", preparing: "Preparing", ready: "Ready", delivered: "Delivered", done: "Done", wasted: "Wasted" };
const KDS_COLS = ["Active", "New", "Preparing", "Ready", "Delivered", "Done", "Wasted", "All"];
const isActive = (s: string) => !["done", "delivered", "wasted"].includes(s);

function setStatus(o: any, to: string) {
  store.commit([{ kind: "orders", id: o.id, data: { ...o, status: to, updatedAt: Date.now() } }]);
}
const lineList = (o: any) => o.items || o.lines || [];
const orderStatus = (o: any) => String(o.status || "new").toLowerCase();

export function OrdersScreen({ _ }: { _: any }) {
  const st = useStore();
  const orders = st.byKind("orders").map((e) => e.data);
  const [view, setView] = useState<"qr" | Cat>("walk");
  const [col, setCol] = useState("Active");

  const qrIncoming = useMemo(() => orders.filter((o) => o.source === "qr" && orderStatus(o) === "new")
    .sort((a, b) => (a.createdAt || a.t || 0) - (b.createdAt || b.t || 0)), [orders]);
  const catCount = (c: Cat) => orders.filter((o) => catOf(o) === c && isActive(orderStatus(o))).length;

  const inCat = view !== "qr" ? orders.filter((o) => catOf(o) === view) : [];
  const colCount = (c: string) => c === "All" ? inCat.length : inCat.filter((o) => orderStatus(o) === c.toLowerCase() || (c === "Active" && isActive(orderStatus(o)))).length;
  const shown = col === "All" ? inCat : inCat.filter((o) => orderStatus(o) === col.toLowerCase() || (col === "Active" && isActive(orderStatus(o))));

  return (
    <div className="pb-8">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="ksh-display text-xl font-bold">Orders</h2>
        <span className={`text-sm ${_.sub}`}>· grouped by channel</span>
      </div>
      <p className={`text-sm mb-4 ${_.sub}`}>Every order across the register, QR and delivery — categorized so nothing gets lost.</p>

      {/* Top view tabs: Incoming QR + the three channels */}
      <div className="flex gap-2 flex-wrap mb-4">
        <button onClick={() => setView("qr")} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-semibold ${view === "qr" ? _.primary : _.chip}`}>
          <span>▦</span> Incoming QR
          {qrIncoming.length > 0 && <span className={`ml-0.5 h-5 min-w-5 px-1 rounded-full text-xs font-bold flex items-center justify-center ${view === "qr" ? "bg-white/25" : "bg-amber-500 text-white"}`}>{qrIncoming.length}</span>}
        </button>
        <span className={`self-center w-px h-6 ${_.border}`} style={{ borderLeft: "1px solid var(--k-border)" }} />
        {CATS.map((c) => (
          <button key={c.id} onClick={() => { setView(c.id); setCol("Active"); }} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-semibold ${view === c.id ? _.primary : _.chip}`}>
            {c.emoji} {c.label}
            <span className={`ml-0.5 h-5 min-w-5 px-1 rounded-full text-xs font-bold flex items-center justify-center ${view === c.id ? "bg-white/25" : _.panel2}`}>{catCount(c.id)}</span>
          </button>
        ))}
      </div>

      {view === "qr" ? (
        <QrIncoming _={_} rows={qrIncoming} />
      ) : (
        <>
          {/* Status filter within the channel */}
          <div className="flex gap-2 overflow-x-auto no-scrollbar mb-4">
            {KDS_COLS.map((c) => (
              <button key={c} onClick={() => setCol(c)} className={`whitespace-nowrap px-3 py-1.5 rounded-full text-sm font-medium ${col === c ? _.chipOn : _.chip}`}>{c} <span className="opacity-60">{colCount(c)}</span></button>
            ))}
          </div>
          {shown.length ? (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))" }}>
              {shown.map((o) => <OrderCard key={o.id} _={_} o={o} />)}
            </div>
          ) : (
            <div className={`rounded-2xl grid place-items-center py-16 ${_.panel}`}>
              <div className={`text-center text-sm ${_.sub}`}><div className="text-3xl mb-2">🍳</div>No {CATS.find((c) => c.id === view)?.label.toLowerCase()} orders right now.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* Dedicated incoming-QR queue — fast accept, minimal chrome. */
function QrIncoming({ _, rows }: { _: any; rows: any[] }) {
  const slug = (() => { try { return JSON.parse(localStorage.getItem("kashikeyo-cloud") || "{}").slug || ""; } catch { return ""; } })();
  const itemsLine = (o: any) => lineList(o).map((l: any) => (l.qty || l.q) + "× " + (l.name || l.n)).join(", ");
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
      <div className={`rounded-2xl p-4 ${_.panel}`}>
        <div className="flex items-center gap-2 mb-3">
          <div className={`text-xs font-semibold uppercase tracking-wide ${_.faint}`}>Incoming QR orders</div>
          {rows.length > 0 && <span className="ml-auto h-5 min-w-5 px-1.5 rounded-full text-xs font-bold flex items-center justify-center bg-amber-500 text-white">{rows.length}</span>}
        </div>
        {rows.length ? rows.map((o) => (
          <div key={o.id} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 mb-2 ${_.panel2}`}>
            <span className="w-2 h-2 rounded-full bg-amber-500" style={{ animation: "kpop .3s" }} />
            <b className="text-sm">{o.no || "#" + String(o.id).slice(0, 4)}</b>
            <span className={`text-xs font-semibold ${_.sub}`}>{o.otype === "delivery" ? "🛵 Delivery" : o.table ? "🍽️ " + o.table : "🥡 Takeaway"}</span>
            <span className={`flex-1 min-w-0 text-sm truncate ${_.sub}`}>{itemsLine(o) || "—"}</span>
            <button onClick={() => setStatus(o, "preparing")} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${_.primary}`}>Accept →</button>
          </div>
        )) : <div className={`text-sm text-center py-10 ${_.sub}`}>No incoming QR orders. Guest orders land here the moment they tap Place order.</div>}
      </div>
      <div className={`rounded-2xl px-4 py-3.5 flex gap-3 items-start`} style={{ background: "var(--k-panel2)" }}>
        <span className="text-lg">▦</span>
        <div className={`flex-1 text-sm ${_.sub}`} style={{ lineHeight: 1.45 }}>Print one QR per table — guests scan, order and pay from their phone, and it lands here tagged with the table.
          {slug && <div className="mt-2"><button onClick={() => window.open("/?s=" + encodeURIComponent(slug), "_blank")} className={`px-3 py-1.5 rounded-full text-xs font-semibold ${_.btn}`}>Open live guest view ↗</button></div>}
        </div>
      </div>
    </div>
  );
}

/* Kitchen ticket card — production's layout, ksh-themed. */
function OrderCard({ _, o }: { _: any; o: any }) {
  const created = o.createdAt || o.t || Date.now();
  const age = Math.max(0, Math.round((Date.now() - created) / 60000));
  const s = orderStatus(o);
  const step = Math.max(0, FLOW.indexOf(s));
  const next = FLOW[step + 1];
  const ageColor = age >= 10 ? "text-rose-500" : age >= 5 ? "text-amber-500" : _.faint;
  const head = o.table ? o.table : o.otype === "delivery" ? "Delivery" : "Takeaway";
  const src = o.source === "qr" ? "QR" : "POS";
  return (
    <div className={`rounded-2xl p-3 flex flex-col ${_.panel}`} style={{ animation: "kpop .25s" }}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base font-black">{head}</span>
        {o.covers > 1 && <span className={`text-xs ${_.faint}`}>{o.covers}p</span>}
        {o.otype === "delivery" && <span className="text-sm">🛵</span>}
        {o.call && <span className="text-amber-500">🔔</span>}
        <span className={`ml-auto num text-sm font-bold ${ageColor}`}>{age}m</span>
      </div>
      {/* status progress bar */}
      <div className="flex gap-1 mb-1.5">
        {FLOW.map((f, i) => <div key={f} title={STATUS_LABEL[f]} className="flex-1 rounded-full" style={{ height: 4, background: s === "wasted" ? "#C13A26" : i <= step ? "var(--k-primary)" : "var(--k-panel2)" }} />)}
      </div>
      <div className={`text-xs mb-2 ${_.sub}`}>{o.no}{o.customerName ? " · " + o.customerName : ""} · {src} · {STATUS_LABEL[s] || s}</div>
      <div className="flex-1 space-y-1 mb-3">
        {lineList(o).map((l: any, j: number) => (
          <div key={j} className="flex gap-2 text-sm font-semibold leading-snug">
            <span className={`w-7 text-right shrink-0 ${_.accent}`}>{l.qty || l.q}×</span>
            <span>{l.name || l.n}</span>
          </div>
        ))}
        {o.note && <div className="text-xs text-amber-600 border border-amber-500/40 rounded-lg px-2 py-1.5 mt-1">{o.note}</div>}
      </div>
      {s === "ready" ? (
        <div className="text-center text-xs font-semibold py-2.5 rounded-xl bg-emerald-500/15 text-emerald-600">READY — {o.paidOnline ? "paid, hand over" : "settle at counter"}</div>
      ) : s === "done" || s === "wasted" ? (
        <div className={`text-center text-xs font-semibold py-2.5 rounded-xl ${_.panel2} ${_.sub}`}>{STATUS_LABEL[s]}</div>
      ) : (
        <div className="flex gap-2">
          {next && <button onClick={() => setStatus(o, next)} className={`flex-1 rounded-xl py-2.5 text-sm font-bold ${_.primary} active:scale-95 transition`}>{s === "new" ? "ACCEPT" : next === "done" ? "BUMP ✓" : "MARK " + STATUS_LABEL[next].toUpperCase()}</button>}
          <button onClick={() => setStatus(o, "done")} title="Bump / complete" className={`rounded-xl px-3 py-2.5 text-sm font-bold ${_.btn}`}>✓</button>
        </div>
      )}
    </div>
  );
}
