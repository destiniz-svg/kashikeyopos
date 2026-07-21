import { useState } from "react";
import { store, useStore } from "./store";
import { uid } from "./api";

/* ── Day End tab ─────────────────────────────────────────────────────────────
   Staging's Day End (shift close / Z-report) in Production styling. Shows the
   current shift (or today when none is open): gross sales, orders, GST and
   service charge collected, paid-outs, and the payment-method breakdown, with
   open-shift / record-paid-out / count-drawer-and-close actions. All figures
   derive from the synced sales/shifts/expenses entities. */

const money = (laari: number) => "MVR " + (Math.round(Number(laari) || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const METHODS = ["Cash", "Card", "Transfer", "BML Gateway", "QR", "Credit"];
const PAIDOUT_REASONS = ["Supplies", "Delivery", "Staff meal", "Other"];

export function DayEndScreen({ _, user, settings }: { _: any; user: any; settings: any }) {
  const st = useStore();
  const shifts = st.byKind("shifts").map((e) => e.data);
  const openShift = shifts.find((s) => !s.closedAt) || null;
  const sales = st.byKind("sales").map((e) => e.data).filter((x: any) => x.type !== "refund" && !x.refunded);
  const expenses = st.byKind("expenses").map((e) => e.data);
  const [modal, setModal] = useState<null | "open" | "close" | "paidout">(null);

  const scope = openShift
    ? sales.filter((x: any) => x.shiftId === openShift.id)
    : sales.filter((x: any) => new Date(x.t).toDateString() === new Date().toDateString());
  const byMethod: Record<string, number> = {};
  scope.forEach((x: any) => (x.payments || []).forEach((p: any) => { byMethod[p.method] = (byMethod[p.method] || 0) + (p.amount || 0); }));
  const gross = scope.reduce((a: number, x: any) => a + (x.total || 0), 0);
  const gst = scope.reduce((a: number, x: any) => a + (x.gst || 0), 0);
  const svc = scope.reduce((a: number, x: any) => a + (x.svcCharge || 0), 0);
  const paidOut = openShift ? expenses.filter((e: any) => e.shiftId === openShift.id).reduce((a: number, e: any) => a + (e.amount || 0), 0) : 0;

  const openShiftNow = (float: number) => { const s = { id: uid(), openedAt: Date.now(), openingFloat: float, userName: user?.name, storeId: settings.storeId || "main", closedAt: null }; store.commit([{ kind: "shifts", id: s.id, data: s }]); setModal(null); };
  const closeShiftNow = (counted: number) => {
    if (!openShift) return;
    const seq = shifts.filter((s: any) => s.closedAt).length + 1;
    const zNo = "Z-" + String(seq).padStart(5, "0");
    store.commit([{ kind: "shifts", id: openShift.id, data: { ...openShift, closedAt: Date.now(), countedCash: counted, expectedCash: (openShift.openingFloat || 0) + (byMethod["Cash"] || 0) - paidOut, zNo } }]);
    setModal(null);
  };
  const recordPaidOut = (amount: number, reason: string, note: string) => {
    if (!openShift) return;
    const e = { id: uid(), t: Date.now(), type: "paidout", amount, reason, note, shiftId: openShift.id, storeId: settings.storeId || "main", userName: user?.name };
    store.commit([{ kind: "expenses", id: e.id, data: e }]); setModal(null);
  };

  const kpis: [string, string][] = [["Gross sales", money(gross)], ["Orders", String(scope.length)], ["GST collected", money(gst)], ["Service charge", money(svc)]];

  return (
    <div className="pb-8">
      <div className="flex items-baseline gap-2 mb-1">
        <h2 className="ksh-display text-xl font-bold">Day End</h2>
        <span className={`text-sm ${_.sub}`}>{openShift ? "Current shift · opened " + new Date(openShift.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "No open shift — showing today's sales"}</span>
      </div>

      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
        {kpis.map(([k, v]) => (
          <div key={k} className={`rounded-2xl p-4 ${_.panel}`}>
            <div className={`text-xs uppercase tracking-wide ${_.sub}`}>{k}</div>
            <div className="ksh-display num text-2xl font-bold mt-1">{v}</div>
          </div>
        ))}
      </div>

      <div className={`rounded-2xl p-4 flex items-center gap-3 mb-4 ${_.panel}`}>
        <div className="flex-1">
          <div className={`text-xs uppercase tracking-wide ${_.sub}`}>Paid out this shift</div>
          <div className="ksh-display num text-2xl font-bold mt-1">{money(paidOut)}</div>
        </div>
        <button onClick={() => openShift ? setModal("paidout") : setModal("open")} className={`px-4 py-2.5 rounded-xl text-sm font-semibold ${_.btn}`}>💸 Record paid-out</button>
      </div>

      <div className={`rounded-2xl p-4 mb-4 ${_.panel}`}>
        <div className="text-sm font-semibold mb-2">Payment breakdown</div>
        {METHODS.filter((m) => byMethod[m]).length ? METHODS.map((m) => byMethod[m] ? (
          <div key={m} className="flex justify-between py-1.5 text-sm" style={{ borderBottom: "1px solid var(--k-border)" }}>
            <span className={_.sub}>{m === "Credit" ? "On tab (credit)" : m}</span>
            <span className="num font-semibold">{money(byMethod[m])}</span>
          </div>
        ) : null) : <div className={`text-sm py-2 ${_.faint}`}>No sales yet.</div>}
      </div>

      <button onClick={() => setModal(openShift ? "close" : "open")} className={`rounded-xl px-6 py-3 font-semibold text-sm ${_.primary}`}>
        {openShift ? "Count drawer & close day →" : "Open a shift to start the day"}
      </button>

      {modal === "open" && <AmountModal _={_} title="Open a shift" label="OPENING FLOAT (cash in drawer)" cta="Open shift" onConfirm={openShiftNow} onClose={() => setModal(null)} />}
      {modal === "close" && openShift && <CloseModal _={_} expected={(openShift.openingFloat || 0) + (byMethod["Cash"] || 0) - paidOut} gross={gross} onConfirm={closeShiftNow} onClose={() => setModal(null)} />}
      {modal === "paidout" && <PaidOutModal _={_} onConfirm={recordPaidOut} onClose={() => setModal(null)} />}
    </div>
  );
}

function Overlay({ children, onClose }: { children: any; onClose: () => void }) {
  return <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,18,15,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 12 }}>{children}</div>;
}

function AmountModal({ _, title, label, cta, onConfirm, onClose }: { _: any; title: string; label: string; cta: string; onConfirm: (laari: number) => void; onClose: () => void }) {
  const [v, setV] = useState("");
  const amt = Math.round((Number(v) || 0) * 100);
  return (
    <Overlay onClose={onClose}><div onClick={(e) => e.stopPropagation()} className={`w-[min(400px,94vw)] rounded-2xl p-5 ${_.modal}`}>
      <div className="text-lg font-bold mb-4">{title}</div>
      <label className={`text-xs font-semibold ${_.sub}`}>{label}</label>
      <div className={`flex items-center gap-2 rounded-xl px-3 mt-1 ${_.input}`} style={{ height: 54 }}>
        <span className="text-xs font-bold" style={{ color: "var(--k-faint)" }}>MVR</span>
        <input autoFocus type="number" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="0.00" className="flex-1 bg-transparent outline-none num text-2xl font-bold" />
      </div>
      <button onClick={() => onConfirm(amt)} className={`w-full mt-5 rounded-xl py-3.5 font-semibold text-sm ${_.primary}`}>{cta}</button>
    </div></Overlay>
  );
}

function CloseModal({ _, expected, gross, onConfirm, onClose }: { _: any; expected: number; gross: number; onConfirm: (counted: number) => void; onClose: () => void }) {
  const [v, setV] = useState("");
  const counted = Math.round((Number(v) || 0) * 100);
  const diff = counted - expected;
  return (
    <Overlay onClose={onClose}><div onClick={(e) => e.stopPropagation()} className={`w-[min(420px,94vw)] rounded-2xl p-5 ${_.modal}`}>
      <div className="text-lg font-bold mb-1">Count drawer & close day</div>
      <div className={`text-sm mb-4 ${_.sub}`}>Z-report for this shift · gross <b className="num" style={{ color: "var(--k-text)" }}>{money(gross)}</b></div>
      <div className={`flex justify-between text-sm mb-1 ${_.sub}`}><span>Expected in drawer</span><span className="num">{money(expected)}</span></div>
      <label className={`text-xs font-semibold mt-3 block ${_.sub}`}>COUNTED CASH</label>
      <div className={`flex items-center gap-2 rounded-xl px-3 mt-1 ${_.input}`} style={{ height: 54 }}>
        <span className="text-xs font-bold" style={{ color: "var(--k-faint)" }}>MVR</span>
        <input autoFocus type="number" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="0.00" className="flex-1 bg-transparent outline-none num text-2xl font-bold" />
      </div>
      {v !== "" && <div className="text-sm mt-2 font-semibold" style={{ color: diff === 0 ? "var(--k-primary)" : diff > 0 ? "#177E4B" : "#C13A26" }}>{diff === 0 ? "Balances exactly" : (diff > 0 ? "Over by " : "Short by ") + money(Math.abs(diff))}</div>}
      <button onClick={() => onConfirm(counted)} className={`w-full mt-5 rounded-xl py-3.5 font-semibold text-sm ${_.primary}`}>Close day & post Z-report</button>
    </div></Overlay>
  );
}

function PaidOutModal({ _, onConfirm, onClose }: { _: any; onConfirm: (amount: number, reason: string, note: string) => void; onClose: () => void }) {
  const [v, setV] = useState(""); const [reason, setReason] = useState(PAIDOUT_REASONS[0]); const [note, setNote] = useState("");
  const amt = Math.round((Number(v) || 0) * 100);
  return (
    <Overlay onClose={onClose}><div onClick={(e) => e.stopPropagation()} className={`w-[min(400px,94vw)] rounded-2xl p-5 ${_.modal}`}>
      <div className="text-lg font-bold mb-1">Paid out</div>
      <div className={`text-sm mb-4 ${_.sub}`}>Cash taken from the drawer — deducted from the expected count.</div>
      <div className={`flex items-center gap-2 rounded-xl px-3 ${_.input}`} style={{ height: 54 }}>
        <span className="text-xs font-bold" style={{ color: "var(--k-faint)" }}>MVR</span>
        <input autoFocus type="number" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="0.00" className="flex-1 bg-transparent outline-none num text-2xl font-bold" />
      </div>
      <div className="flex gap-2 flex-wrap my-3">
        {PAIDOUT_REASONS.map((r) => <button key={r} onClick={() => setReason(r)} className={`px-3 py-1.5 rounded-full text-xs font-semibold ${reason === r ? _.primary : _.chip}`}>{r}</button>)}
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={`w-full rounded-xl px-3 py-2.5 text-sm ${_.input}`} />
      <button disabled={amt <= 0} onClick={() => onConfirm(amt, reason, note.trim())} className={`w-full mt-4 rounded-xl py-3.5 font-semibold text-sm ${_.primary}`} style={{ opacity: amt > 0 ? 1 : .5 }}>Record paid-out</button>
    </div></Overlay>
  );
}
