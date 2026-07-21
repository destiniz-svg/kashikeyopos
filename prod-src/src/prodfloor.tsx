import { useState } from "react";

/* ── Floor tab ───────────────────────────────────────────────────────────────
   Staging's floor plan, rebuilt in Production styling. Shows the table layout,
   the customer count per table, order types and customer/party names, and
   applies the Step-1 multi-party model: a physical table can host 2+ separate
   parties at once — each is its own held bill (a `parked` entity that shares
   the table name), rendered as its own row on the tile. Seating a party or
   tapping one hands a seat intent up to the register (Sell). */

const money = (laari: number) => "MVR " + (Math.round(Number(laari) || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STATUS_LABEL: Record<string, string> = { new: "New", preparing: "Preparing", ready: "Ready", delivered: "Delivered", done: "Done", wasted: "Wasted" };

export function FloorScreen({ _, parked, orders, products, settings, onSeat }:
  { _: any; parked: any[]; orders: any[]; products: any[]; settings: any; onSeat: (intent: any) => void }) {
  const [seatFor, setSeatFor] = useState<string | null>(null);

  const tableNames: string[] = (() => {
    const t = (settings.tables || []).map((x: any) => x?.name || x).filter(Boolean);
    return t.length ? t : Array.from({ length: 12 }, (_x, i) => "T" + (i + 1));
  })();
  const priceOf = (pid: string) => Number(products.find((p: any) => p.id === pid)?.price) || 0;
  const billSub = (b: any) => (b.lines || []).reduce((a: number, l: any) => a + priceOf(l.pid) * (l.qty || 0) * (1 - (l.discPct || 0) / 100), 0);
  const billItems = (b: any) => (b.lines || []).reduce((a: number, l: any) => a + (l.qty || 0), 0);
  /* Multi-party: ALL held dine-in bills sharing this table name. */
  const partiesAt = (name: string) => parked.filter((b: any) => b.otype === "dinein" && b.table === name).sort((a, b) => (a.t || 0) - (b.t || 0));
  const heldOther = parked.filter((b: any) => b.otype !== "dinein" || !b.table);
  const kot = (b: any): [string, string] | null => {
    if (!b.orderId) return null;
    const o = orders.find((x) => x.id === b.orderId); if (!o) return null;
    const s = String(o.status || "new").toLowerCase();
    return [STATUS_LABEL[s] || s, s === "done" || s === "ready" ? "var(--k-primary)" : "#9A6208"];
  };

  const occN = tableNames.filter((n) => partiesAt(n).length > 0).length;
  const openVal = tableNames.reduce((a, n) => a + partiesAt(n).reduce((s, b) => s + billSub(b), 0), 0);
  const guestsAt = (n: string) => partiesAt(n).reduce((a, b) => a + (Number(b.guests) || 1), 0);

  return (
    <div className="pb-8">
      {/* Header strip */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <h2 className="ksh-display text-xl font-bold">Floor</h2>
        <span className="ksh-pill" style={{ background: "var(--k-panel2)", color: "var(--k-primary)" }}>{occN} occupied</span>
        <span className="ksh-pill" style={{ background: "var(--k-panel2)", color: "var(--k-sub)" }}>{tableNames.length - occN} free</span>
        <div className="flex-1" />
        <span className={`text-sm ${_.sub}`}>Open value <b className="num" style={{ color: "var(--k-text)" }}>{money(openVal)}</b></span>
      </div>

      {/* Table map */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))" }}>
        {tableNames.map((n) => {
          const parties = partiesAt(n); const occ = parties.length > 0;
          return (
            <div key={n} className={`rounded-2xl p-3 flex flex-col gap-2 ${_.panel}`} style={{ minHeight: 116, borderColor: occ ? "var(--k-primary)" : undefined, borderWidth: occ ? 1 : undefined }}>
              <div className="flex items-center gap-2">
                <b className="text-base">{n}</b>
                {occ && <span className={`text-xs ${_.sub}`}>· 👤 {guestsAt(n)}</span>}
                {parties.length > 1 && <span className="ksh-pill" style={{ background: "var(--k-panel2)", color: "var(--k-primary)", fontSize: 10 }}>{parties.length} parties</span>}
                <div className="flex-1" />
                <button onClick={() => setSeatFor(n)} className="text-xs font-semibold" style={{ color: "var(--k-primary)" }}>{occ ? "+ party" : "Seat"}</button>
              </div>
              {occ ? (
                <div className="flex flex-col gap-1.5">
                  {parties.map((b: any) => { const k = kot(b); const mins = b.t ? Math.max(0, Math.floor((Date.now() - b.t) / 60000)) : 0; return (
                    <button key={b.id} onClick={() => onSeat({ mode: "resume", bill: b })} className={`text-left rounded-xl px-2.5 py-2 ${_.panel2}`}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate flex-1 min-w-0">{b.custName || "Walk-in"}{(b.guests || 1) > 1 ? " · " + b.guests + " guests" : ""}</span>
                        {k ? <span className="text-xs font-bold shrink-0" style={{ color: k[1] }}>● {k[0]}</span>
                           : <span className="text-xs font-bold shrink-0" style={{ color: "#9A6208" }}>● held</span>}
                      </div>
                      <div className={`text-xs ${_.sub}`}>Dine-in · {billItems(b)} items · <span className="num">{money(billSub(b))}</span> · {mins}m</div>
                    </button>
                  ); })}
                </div>
              ) : (
                <div className="flex-1 flex items-end"><span className={`text-xs ${_.faint}`}>Free · tap Seat to open a bill</span></div>
              )}
            </div>
          );
        })}
      </div>

      {/* Takeaway / delivery held bills that aren't seated at a table */}
      {heldOther.length > 0 && (
        <>
          <div className={`text-xs font-semibold uppercase tracking-wide mt-6 mb-2 ${_.faint}`}>Other open orders</div>
          <div className="flex flex-col gap-2">
            {heldOther.map((b: any) => (
              <button key={b.id} onClick={() => onSeat({ mode: "resume", bill: b })} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${_.panel}`}>
                <span className="text-sm font-semibold" style={{ color: b.otype === "delivery" ? "var(--k-primary)" : "#9A6208" }}>{b.otype === "delivery" ? "🛵 Delivery" : "🥡 Takeaway"}</span>
                <span className={`text-sm ${_.sub}`}>{billItems(b)} items{b.custName ? " · " + b.custName : ""}</span>
                <div className="flex-1" />
                <span className="num text-sm font-semibold">{money(billSub(b))}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {seatFor && <SeatModal _={_} tableName={seatFor} existing={partiesAt(seatFor).length}
        onConfirm={(g, name) => { onSeat({ mode: "new", table: seatFor, guests: g, name }); setSeatFor(null); }}
        onClose={() => setSeatFor(null)} />}
    </div>
  );
}

/* Seat a party — captures guest count (+ optional party name) up front so
   multi-party tables read at a glance. Used for a table's first party and for
   an additional party alongside one already there. */
function SeatModal({ _, tableName, existing, onConfirm, onClose }: { _: any; tableName: string; existing: number; onConfirm: (guests: number, name: string) => void; onClose: () => void }) {
  const [guests, setGuests] = useState(2);
  const [name, setName] = useState("");
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,18,15,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} className={`w-[min(380px,94vw)] rounded-2xl p-5 ${_.modal}`}>
        <div className="text-lg font-bold mb-1">{existing > 0 ? "Add a party at " + tableName : "Seat " + tableName}</div>
        <div className={`text-sm mb-4 ${_.sub}`}>{existing > 0 ? existing + " part" + (existing === 1 ? "y" : "ies") + " already here — this starts a separate bill." : "New dine-in bill for this table."}</div>
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-semibold">Guests</span>
          <div className={`flex items-center rounded-xl ${_.panel2}`}>
            <button onClick={() => setGuests((g) => Math.max(1, g - 1))} className="px-3.5 py-2 text-lg">−</button>
            <span className="w-8 text-center num font-bold">{guests}</span>
            <button onClick={() => setGuests((g) => Math.min(20, g + 1))} className="px-3.5 py-2 text-lg">+</button>
          </div>
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Party name (optional)" className={`w-full rounded-xl px-3 py-2.5 text-sm mb-4 ${_.input}`} />
        <button onClick={() => onConfirm(guests, name.trim())} className={`w-full rounded-xl py-3 font-semibold text-sm ${_.primary}`}>Seat table →</button>
      </div>
    </div>
  );
}
