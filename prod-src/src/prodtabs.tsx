import { useMemo, useState } from "react";
import { store, useStore } from "./store";
import { uid } from "./api";

/* ── Tabs tab (credit customer bills) ────────────────────────────────────────
   Staging's credit-tab layout in Production styling. Every customer carrying an
   outstanding balance (owed on credit) appears here. New in this build: PARTIAL
   payments — collect any amount up to the balance, logged as its own record and
   applied to the running due.

   Data is structured to feed the Customer Portal directly (nothing bespoke):
   • customer.balance   → outstanding dues, decremented server-side (FIN-02,
     GREATEST(0, balance + delta)) via store.commit(..., deltas.cust) — never a
     client-trusted overwrite.
   • payments entity    → { customerId, amount, method, at, by } audit records
     (a SHARED_KIND, so org-wide). /p/:slug/boot returns the customer's own
     payments + orders + balance, so the portal shows dues, order history and
     "you paid X on Y" with no extra endpoint.
   • sales (Credit)     → the credit purchases that built the balance = the
     portal's order history. */

const money = (laari: number) => "MVR " + (Math.round(Number(laari) || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const METHODS = ["Cash", "Card", "Transfer", "BML Gateway", "QR"];
const daysAgo = (t: number) => t ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
const initials = (n: string) => (n || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export function TabsScreen({ _, user, settings }: { _: any; user: any; settings: any }) {
  const st = useStore();
  const customers = st.byKind("customers").map((e) => e.data);
  const sales = st.byKind("sales").map((e) => e.data);
  const payments = st.byKind("payments").map((e) => e.data);
  const [payFor, setPayFor] = useState<any>(null);

  const owing = useMemo(() => customers.filter((c) => Number(c.balance || 0) > 0).sort((a, b) => Number(b.balance) - Number(a.balance)), [customers]);
  const outstanding = owing.reduce((a, c) => a + Number(c.balance || 0), 0);

  const collect = (c: any, amountLaari: number, method: string) => {
    const amt = Math.min(Math.max(0, Math.round(amountLaari)), Number(c.balance || 0));
    if (amt <= 0) return;
    const pay = {
      id: uid(), type: "payment", no: "PAY-" + String(payments.length + 1).padStart(5, "0"),
      customerId: c.id, customerName: c.name, amount: amt, method, at: Date.now(), by: user?.name || "",
      storeId: settings.storeId || "main",
      /* portal-facing snapshot: balance BEFORE and AFTER this collection */
      balanceBefore: Number(c.balance || 0), balanceAfter: Math.max(0, Number(c.balance || 0) - amt),
    };
    /* One op: the payment audit record (put) + a server-verified balance
       decrement (deltas.cust — FIN-02 clamps at 0). */
    store.commit([{ kind: "payments", id: pay.id, data: pay }], undefined, { cust: [{ id: c.id, bal: -amt }] });
    setPayFor(null);
  };

  return (
    <div className="pb-8">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <h2 className="ksh-display text-xl font-bold">Open tabs</h2>
        <div className="flex-1" />
        <span className="ksh-pill" style={{ background: "var(--k-panel2)", color: "var(--k-text)" }}>Outstanding · <b className="num">{money(outstanding)}</b></span>
        <span className="ksh-pill" style={{ background: "var(--k-panel2)", color: "var(--k-primary)" }}>{owing.length}</span>
      </div>
      <p className={`text-sm mb-4 ${_.sub}`}>Customer credit bills. Collect a full or partial payment — it logs against the due and syncs to the customer's portal.</p>

      <div className={`rounded-2xl overflow-hidden ${_.panel}`}>
        {owing.length ? owing.map((c, i) => {
          const d = daysAgo(c.tabSince || c.updatedAt || c.createdAt); const overdue = d != null && d >= 30;
          return (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: i < owing.length - 1 ? "1px solid var(--k-border)" : "none" }}>
              <span className="w-9 h-9 rounded-full grid place-items-center font-bold text-sm shrink-0" style={{ background: "var(--k-panel2)", color: "var(--k-primary)" }}>{initials(c.name)}</span>
              <div className="flex-1 min-w-0">
                <b className="text-sm block truncate">{c.name || "Walk-in"}</b>
                <small className={_.faint}>{d != null ? "on tab for " + d + "d" : "on tab"}{c.phone ? " · " + c.phone : ""}</small>
              </div>
              {d != null && <span className="ksh-pill" style={{ background: overdue ? "#FEE2E2" : d >= 10 ? "var(--k-panel2)" : "var(--k-panel2)", color: overdue ? "#B91C1C" : d >= 10 ? "#9A6208" : "var(--k-sub)", fontSize: 10 }}>{overdue ? "overdue 30d+" : d + "d"}</span>}
              <span className="num font-bold text-sm shrink-0" style={{ minWidth: 96, textAlign: "right" }}>{money(Number(c.balance))}</span>
              <button onClick={() => setPayFor(c)} className={`px-3.5 py-2 rounded-xl text-sm font-semibold ${_.primary}`}>Collect</button>
            </div>
          );
        }) : (
          <div className={`text-center py-16 text-sm ${_.sub}`}><div className="text-3xl mb-2">✅</div>All tabs settled — no open customer credit.</div>
        )}
      </div>

      {payFor && (
        <CollectModal _={_} customer={payFor}
          history={sales.filter((s) => s.customerId === payFor.id && (s.payments || []).some((p: any) => p.method === "Credit")).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 6)}
          pastPayments={payments.filter((p) => p.customerId === payFor.id).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 6)}
          onCollect={(amt, method) => collect(payFor, amt, method)} onClose={() => setPayFor(null)} />
      )}
    </div>
  );
}

/* Partial-payment collector — amount defaults to the full balance but edits
   down to any partial figure; a tender method is required. Shows the customer's
   credit history + past payments (the same data the portal renders). */
function CollectModal({ _, customer, history, pastPayments, onCollect, onClose }:
  { _: any; customer: any; history: any[]; pastPayments: any[]; onCollect: (amountLaari: number, method: string) => void; onClose: () => void }) {
  const balance = Number(customer.balance || 0);
  const [amtStr, setAmtStr] = useState((balance / 100).toFixed(2));
  const [method, setMethod] = useState(METHODS[0]);
  const amt = Math.round((Number(amtStr) || 0) * 100);
  const valid = amt > 0 && amt <= balance;
  const remaining = Math.max(0, balance - amt);
  const creditSum = (s: any) => (s.payments || []).filter((p: any) => p.method === "Credit").reduce((a: number, p: any) => a + (p.amount || 0), 0);
  const fmtDate = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,18,15,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} className={`w-[min(440px,96vw)] rounded-2xl p-5 ${_.modal}`} style={{ maxHeight: "92vh", overflowY: "auto" }}>
        <div className="flex items-center gap-2 mb-1">
          <div className="text-lg font-bold">{customer.name || "Walk-in"}</div>
          <div className="flex-1" />
          <div className={`text-sm ${_.sub}`}>Due <b className="num" style={{ color: "var(--k-text)" }}>{money(balance)}</b></div>
        </div>
        <div className={`text-sm mb-4 ${_.sub}`}>Collect a payment against this tab. Partial is fine — the rest stays on the balance.</div>

        {/* Amount */}
        <label className={`text-xs font-semibold ${_.sub}`}>AMOUNT TO COLLECT</label>
        <div className={`flex items-center gap-2 rounded-xl px-3 mt-1 ${_.input}`} style={{ height: 54 }}>
          <span className="text-xs font-bold" style={{ color: "var(--k-faint)" }}>MVR</span>
          <input autoFocus type="number" inputMode="decimal" value={amtStr} onChange={(e) => setAmtStr(e.target.value)} className="flex-1 bg-transparent outline-none num text-2xl font-bold" style={{ minWidth: 0 }} />
        </div>
        <div className="flex gap-2 mt-2">
          {[0.25, 0.5, 1].map((f) => (
            <button key={f} onClick={() => setAmtStr(((balance * f) / 100).toFixed(2))} className={`flex-1 py-1.5 rounded-lg text-xs font-semibold ${_.btn}`}>{f === 1 ? "Full" : f * 100 + "%"} · {money(balance * f)}</button>
          ))}
        </div>
        {amt > balance && <div className="text-xs mt-1.5 font-semibold" style={{ color: "#C13A26" }}>Can't collect more than the {money(balance)} due.</div>}
        {valid && remaining > 0 && <div className={`text-xs mt-1.5 ${_.sub}`}>Remaining on tab after this: <b className="num">{money(remaining)}</b></div>}
        {valid && remaining === 0 && <div className="text-xs mt-1.5 font-semibold" style={{ color: "var(--k-primary)" }}>Settles the tab in full.</div>}

        {/* Tender method */}
        <label className={`text-xs font-semibold mt-4 block ${_.sub}`}>TENDER</label>
        <div className="flex gap-2 flex-wrap mt-1">
          {METHODS.map((m) => (
            <button key={m} onClick={() => setMethod(m)} className={`px-3 py-2 rounded-full text-sm font-semibold ${method === m ? _.primary : _.chip}`}>{m}</button>
          ))}
        </div>

        {/* History — the same shape the portal shows */}
        {(history.length > 0 || pastPayments.length > 0) && (
          <div className={`mt-4 rounded-xl p-3 ${_.panel2}`}>
            {history.length > 0 && <>
              <div className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${_.faint}`}>Recent credit purchases</div>
              {history.map((s) => <div key={s.id} className="flex justify-between text-xs py-0.5"><span className={_.sub}>{fmtDate(s.t)} · {s.no}</span><span className="num">{money(creditSum(s))}</span></div>)}
            </>}
            {pastPayments.length > 0 && <>
              <div className={`text-xs font-semibold uppercase tracking-wide mt-2 mb-1.5 ${_.faint}`}>Payments made</div>
              {pastPayments.map((p) => <div key={p.id} className="flex justify-between text-xs py-0.5"><span className={_.sub}>{fmtDate(p.at)} · {p.method}</span><span className="num" style={{ color: "var(--k-primary)" }}>-{money(p.amount)}</span></div>)}
            </>}
          </div>
        )}

        <button disabled={!valid} onClick={() => onCollect(amt, method)} className={`w-full mt-5 rounded-xl py-3.5 font-semibold text-sm ${_.primary}`} style={{ opacity: valid ? 1 : .5 }}>
          Collect {money(valid ? amt : 0)} · {method}
        </button>
      </div>
    </div>
  );
}
