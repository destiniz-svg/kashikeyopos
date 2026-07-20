import { useMemo, useState } from "react";
import { store, useStore } from "./store";
import { elevate, uid } from "./api";
import { money, money0, startOfDay, dayKey, tintFor } from "./util";

/* Reskinned versions of OUR existing Orders / Dashboard / Reports / Admin
   screens, wired to the synced entities (sales, tables, customers, …). Same
   features as the current till — no prototype-only additions. */

type Sale = any;
const isSale = (d: Sale) => d && d.type !== "refund" && !d.refunded;
const lineQty = (d: Sale) => (d.lines || []).reduce((a: number, l: any) => a + (l.qty || 0), 0);

/* ── shared chart helpers (inline SVG) ─────────────────────────────────────── */
function AreaLine({ vals, h = 210, stroke = "var(--green)" }: { vals: number[]; h?: number; stroke?: string }) {
  const w = 1000; const max = Math.max(1, ...vals); const n = vals.length;
  const pts = vals.map((v, i) => [n < 2 ? w / 2 : (i / (n - 1)) * w, h - 8 - (v / max) * (h - 20)] as const);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: h }} aria-hidden="true">
      <defs><linearGradient id="ag" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={stroke} stopOpacity=".22" /><stop offset="1" stopColor={stroke} stopOpacity="0" /></linearGradient></defs>
      <path d={d + ` L${w} ${h} L0 ${h} Z`} fill="url(#ag)" />
      <path d={d} fill="none" stroke={stroke} strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
function Bars({ vals, h = 210 }: { vals: number[]; h?: number }) {
  const max = Math.max(1, ...vals);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: h }}>
      {vals.map((v, i) => <div key={i} title={money(v)} style={{ flex: 1, height: `${Math.max(2, (v / max) * 100)}%`, background: v > 0 ? "var(--green)" : "var(--sur2)", borderRadius: "5px 5px 2px 2px" }} />)}
    </div>
  );
}

/* ── Dashboard ──────────────────────────────────────────────────────────────── */
export function Dashboard() {
  const st = useStore();
  const [mode, setMode] = useState<"line" | "bars">("line");
  const [refundSale, setRefundSale] = useState<any>(null);
  const sales = st.byKind("sales").map((e) => e.data);
  const today0 = startOfDay();
  const today = sales.filter((d) => d.t >= today0 && isSale(d));

  const net = today.reduce((a, d) => a + (d.total || 0), 0);
  const txns = today.length;
  const items = today.reduce((a, d) => a + lineQty(d), 0);
  const avg = txns ? net / txns : 0;

  const byHour = Array.from({ length: 24 }, () => 0);
  today.forEach((d) => { byHour[new Date(d.t).getHours()] += d.total || 0; });
  const busiestH = byHour.indexOf(Math.max(...byHour));
  const hourWindow = byHour.slice(7, 23);

  const trend7 = Array.from({ length: 7 }, (_, i) => {
    const day0 = today0 - (6 - i) * 86400000;
    return sales.filter((d) => isSale(d) && d.t >= day0 && d.t < day0 + 86400000).reduce((a, d) => a + (d.total || 0), 0);
  });

  const tally: Record<string, number> = {};
  today.forEach((d) => (d.lines || []).forEach((l: any) => { tally[l.name || l.pid] = (tally[l.name || l.pid] || 0) + (l.qty || 0); }));
  const topItems = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const mix: Record<string, number> = {};
  today.forEach((d) => (d.payments || []).forEach((p: any) => { mix[p.method || "Other"] = (mix[p.method || "Other"] || 0) + (p.amount || 0); }));

  const custs = st.byKind("customers").map((e) => e.data);
  const outstanding = custs.reduce((a, c) => a + Math.max(0, Number(c.balance || c.creditBalance || 0)), 0);
  const owing = custs.filter((c) => Number(c.balance || c.creditBalance || 0) > 0);

  const recent = [...today].sort((a, b) => b.t - a.t).slice(0, 8);
  const fmtTime = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  const hhLabel = (h: number) => (h % 12 || 12) + (h < 12 ? "a" : "p");

  return (
    <div style={X.scroll}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ color: "var(--ink2)", fontSize: 13, fontWeight: 600 }}>{new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
        <button style={X.pill}>⚙︎ Customize</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 14 }}>
        <Kpi k="NET SALES TODAY" v={money(net)} big />
        <Kpi k="TRANSACTIONS" v={String(txns)} big />
        <Kpi k="AVG BASKET" v={money(avg)} big />
        <Kpi k="ITEMS SOLD" v={String(items)} big />
      </div>
      <div style={{ ...X.card, padding: 18, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div><b style={{ fontSize: 15 }}>Sales by hour (today)</b><div style={{ color: "var(--ink3)", fontSize: 12, marginTop: 2 }}>Busiest {hhLabel(busiestH)} · {money(byHour[busiestH] || 0)}</div></div>
          <div style={X.seg}>
            <button onClick={() => setMode("line")} style={{ ...X.segBtn, ...(mode === "line" ? X.segOn : {}) }}>Line</button>
            <button onClick={() => setMode("bars")} style={{ ...X.segBtn, ...(mode === "bars" ? X.segOn : {}) }}>Bars</button>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>{mode === "line" ? <AreaLine vals={hourWindow} /> : <Bars vals={hourWindow} />}</div>
        <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink3)", fontSize: 11, marginTop: 4 }}>
          <span>7a</span><span>11a</span><span>3p</span><span>7p</span><span>10p</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <span style={{ color: "var(--ink3)", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>7-day trend</span>
          <div style={{ flex: 1 }}><AreaLine vals={trend7} h={40} /></div>
          <span className="num" style={{ color: "var(--green)", fontWeight: 800, fontSize: 13 }}>{money0(trend7[trend7.length - 1] || 0)}</span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14, marginBottom: 14 }}>
        <div style={{ ...X.card, padding: 18 }}>
          <b style={{ fontSize: 15 }}>Top items today</b>
          <div style={{ marginTop: 10 }}>
            {topItems.length ? topItems.map(([n, q], i) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 0", borderTop: i ? "1px solid var(--line)" : "none" }}>
                <span style={{ color: "var(--ink3)", fontWeight: 700, width: 14 }}>{i + 1}</span><span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{n}</span><span className="num" style={{ color: "var(--ink2)", fontWeight: 700 }}>{q}×</span>
              </div>
            )) : <div style={X.empty}>No sales yet today.</div>}
          </div>
        </div>
        <div style={{ ...X.card, padding: 18 }}>
          <b style={{ fontSize: 15 }}>Payment mix today</b>
          <div style={{ marginTop: 10 }}>
            {Object.keys(mix).length ? Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
              <div key={m} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0" }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{m}</span><span className="num" style={{ fontWeight: 700 }}>{money(v)}</span>
              </div>
            )) : <div style={X.empty}>No payments yet today.</div>}
          </div>
        </div>
      </div>
      <div style={{ ...X.card, padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <b style={{ fontSize: 15 }}>Recent sales</b>
          {outstanding > 0 && <span style={{ ...X.tag, color: "var(--amber)", background: "var(--ambersoft)" }}>Credit book: {money(outstanding)} across {owing.length} account{owing.length !== 1 ? "s" : ""}</span>}
        </div>
        {recent.length ? recent.map((d, i) => (
          <div key={d.id || i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: i ? "1px solid var(--line)" : "none" }}>
            <b className="num" style={{ fontSize: 13, width: 92 }}>{d.no}</b>
            <span style={{ flex: 1, color: "var(--ink2)", fontSize: 12.5 }}>{fmtTime(d.t)} · {d.userName || "—"} · {(d.payments || [])[0]?.method || "—"}</span>
            <span className="num" style={{ fontWeight: 800, fontSize: 13 }}>{money(d.total || 0)}</span>
            <button onClick={() => setRefundSale(d)} title="Refund this sale" style={{ color: "var(--ink3)", marginInlineStart: 6, fontSize: 15, padding: "2px 6px", borderRadius: 8 }}>↩</button>
          </div>
        )) : <div style={X.empty}>No sales yet today.</div>}
      </div>
      {refundSale && <RefundModal sale={refundSale} onClose={() => setRefundSale(null)} />}
    </div>
  );
}

/* Refund a sale — SEC-03: requires the store password (server-verified via
   /api/elevate); the elevation token rides on the refund op as X-Elevation so
   the server stamps it manager-approved (never rejected — offline-safe). */
function RefundModal({ sale, onClose }: { sale: any; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const doRefund = async () => {
    setBusy(true); setErr("");
    try {
      const elev = await elevate(pw);
      const refund = {
        id: uid(), no: "REF-" + (sale.no || sale.id), t: Date.now(), type: "refund", originalId: sale.id,
        storeId: sale.storeId || "main", shiftId: sale.shiftId || null, userName: "manager", customerId: sale.customerId || null,
        lines: sale.lines, subtotal: sale.subtotal, gst: sale.gst, total: sale.total, billDisc: sale.billDisc || 0,
        payments: [{ method: (sale.payments || [])[0]?.method || "Cash", amount: sale.total }], refunded: true, managerApproved: { method: "password", at: Date.now() },
      };
      store.commit([{ kind: "sales", id: refund.id, data: refund }], elev);
      // mark original as refunded so it drops out of live tallies
      store.commit([{ kind: "sales", id: sale.id, data: { ...sale, refunded: true } }]);
      onClose();
    } catch (e: any) { setErr(e.message || "wrong password"); setBusy(false); }
  };
  return (
    <div style={X.overlay} onClick={onClose}>
      <div style={X.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>Refund {sale.no}</div>
        <div style={{ color: "var(--ink2)", fontSize: 13, margin: "4px 0 14px" }}>{money(sale.total)} · {(sale.lines || []).reduce((a: number, l: any) => a + l.qty, 0)} items. A manager must approve.</div>
        <label style={{ color: "var(--ink3)", fontSize: 12, fontWeight: 700 }}>STORE / MANAGER PASSWORD</label>
        <input autoFocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && pw) doRefund(); }} style={{ ...X.input, width: "100%", marginTop: 6 }} />
        {err && <div style={{ color: "var(--red)", fontSize: 13, fontWeight: 700, marginTop: 8 }}>{err}</div>}
        <button disabled={!pw || busy} onClick={doRefund} style={{ ...X.refundBtn, opacity: (!pw || busy) ? .5 : 1 }}>{busy ? "Verifying…" : "Approve & refund"}</button>
      </div>
    </div>
  );
}

/* ── Reports ──────────────────────────────────────────────────────────────── */
const RANGES = [["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["all", "All time"]] as const;
export function Reports() {
  const st = useStore();
  const [range, setRange] = useState<string>("today");
  const all = st.byKind("sales").map((e) => e.data);
  const cutoff = range === "today" ? startOfDay() : range === "7" ? Date.now() - 7 * 86400000 : range === "30" ? Date.now() - 30 * 86400000 : 0;
  const sales = all.filter((d) => d.t >= cutoff);
  const good = sales.filter(isSale);
  const gross = good.reduce((a, d) => a + (d.total || 0), 0);
  const refunds = sales.filter((d) => d.type === "refund" || d.refunded).reduce((a, d) => a + Math.abs(d.total || 0), 0);
  const taxable = good.reduce((a, d) => a + (d.subtotal || 0), 0);
  const gst = good.reduce((a, d) => a + (d.gst || 0), 0);
  const items = good.reduce((a, d) => a + lineQty(d), 0);
  const ch = { takeaway: 0, dinein: 0, delivery: 0 } as Record<string, number>;
  good.forEach((d) => { ch[d.otype || "takeaway"] = (ch[d.otype || "takeaway"] || 0) + 1; });

  const perf: Record<string, { q: number; rev: number }> = {};
  good.forEach((d) => (d.lines || []).forEach((l: any) => { const k = l.name || l.pid; (perf[k] ||= { q: 0, rev: 0 }); perf[k].q += l.qty || 0; perf[k].rev += (l.price || 0) * (l.qty || 0); }));
  const topPerf = Object.entries(perf).sort((a, b) => b[1].rev - a[1].rev).slice(0, 5);

  const custs = st.byKind("customers").map((e) => e.data).filter((c) => Number(c.balance || c.creditBalance || 0) > 0);
  const outstanding = custs.reduce((a, c) => a + Number(c.balance || c.creditBalance || 0), 0);
  const print = () => window.print();

  return (
    <div style={X.scroll}>
      <div style={{ display: "flex", gap: 7, marginBottom: 14 }}>
        {RANGES.map(([k, l]) => <button key={k} onClick={() => setRange(k)} style={{ ...X.chip, ...(range === k ? X.chipOn : {}) }}>{l}</button>)}
      </div>
      <Report title="Sales Summary" sub="KPIs, tenders, top sellers" onPdf={print}>
        <Grid rows={[["Gross sales", money(gross)], ["Refunds", "-" + money(refunds)], ["Net sales", money(gross - refunds)], ["Transactions / items", good.length + " / " + items], ["Average basket", money(good.length ? gross / good.length : 0)], ["Channels", `${ch.takeaway || 0} takeaway · ${ch.dinein || 0} dine-in · ${ch.delivery || 0} delivery`]]} />
      </Report>
      <Report title="GST / Tax Report" sub="filing-ready taxable value & GST" onPdf={print}>
        <Grid rows={[["Taxable value", money(taxable)], ["GST payable (8%)", money(gst)]]} />
      </Report>
      <Report title="Product Performance" sub="qty, revenue per product" onPdf={print}>
        {topPerf.length ? topPerf.map(([n, v]) => (
          <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{n} · {v.q}×</span><span className="num" style={{ fontWeight: 700 }}>{money(v.rev)}</span>
          </div>
        )) : <div style={X.empty}>No sales in range.</div>}
      </Report>
      <Report title="Shift Z-Reports" sub="float, expected vs counted, over/short" onPdf={print}><div style={X.empty}>No closed shifts yet.</div></Report>
      <Report title="Customer Credit Book" sub="receivables as of today" onPdf={print}>
        {custs.length ? custs.map((c) => (
          <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</span><span className="num" style={{ fontWeight: 700 }}>{money(Number(c.balance || c.creditBalance || 0))}</span>
          </div>
        )).concat([<div key="t" style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, fontWeight: 800 }}><span>Total outstanding</span><span className="num">{money(outstanding)}</span></div>]) : <div style={X.empty}>No outstanding balances.</div>}
      </Report>
    </div>
  );
}
function Report({ title, sub, onPdf, children }: any) {
  return (
    <div style={{ ...X.card, padding: 18, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
        <div><b style={{ fontSize: 15 }}>{title}</b><div style={{ color: "var(--ink3)", fontSize: 12, marginTop: 2 }}>{sub}</div></div>
        <button onClick={onPdf} style={X.pill}>⭳ Export PDF</button>
      </div>
      {children}
    </div>
  );
}
function Grid({ rows }: { rows: [string, string][] }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
    {rows.map(([k, v]) => <div key={k} style={{ background: "var(--sur2)", borderRadius: 12, padding: "11px 13px" }}><div style={{ color: "var(--ink3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>{k}</div><div className="num" style={{ fontWeight: 800, fontSize: 17, marginTop: 3 }}>{v}</div></div>)}
  </div>;
}

/* ── Orders (tables + kitchen display) ─────────────────────────────────────── */
const KDS_COLS = ["Active", "New", "Preparing", "Ready", "Delivered", "Done", "Wasted", "All"];
export function Orders() {
  const st = useStore();
  const [kds, setKds] = useState(false);
  const [col, setCol] = useState("Active");
  const tables = st.byKind("tables").map((e) => e.data);
  const orders = st.byKind("orders").map((e) => e.data);
  const count = (c: string) => c === "All" ? orders.length : orders.filter((o) => (o.status || "New").toLowerCase() === c.toLowerCase() || (c === "Active" && !["done", "delivered", "wasted"].includes((o.status || "new").toLowerCase()))).length;
  const shown = col === "All" ? orders : orders.filter((o) => (o.status || "New").toLowerCase() === col.toLowerCase() || (col === "Active" && !["done", "delivered", "wasted"].includes((o.status || "new").toLowerCase())));

  return (
    <div style={X.scroll}>
      <div style={{ ...X.card, padding: 18, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <b style={{ fontSize: 15 }}>▦ Tables & QR ordering</b>
          <button onClick={() => setKds(!kds)} style={{ ...X.pill, ...(kds ? { background: "var(--coral)", color: "var(--coralink)", borderColor: "var(--coral)" } : {}) }}>🍳 Kitchen display</button>
        </div>
        <div style={{ color: "var(--ink3)", fontSize: 12.5, marginBottom: 12 }}>Guests scan the table QR to browse, order, pay, and call a waiter. Occupied tables glow — tap any table to open the guest view.</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10 }}>
          {(tables.length ? tables : [1, 2, 3, 4, 5, 6].map((n) => ({ id: "T" + n, name: "T" + n }))).map((t: any) => (
            <div key={t.id} style={{ ...X.card, padding: "16px 14px", textAlign: "center", background: t.occupied ? "var(--coralsoft)" : "var(--greensoft)", borderColor: t.occupied ? "var(--coral)" : "transparent" }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{t.name || t.id}</div><div style={{ color: t.occupied ? "var(--coral)" : "var(--green)", fontSize: 12, fontWeight: 600 }}>{t.occupied ? "occupied" : "free"}</div>
            </div>
          ))}
          <div style={{ ...X.card, padding: "16px 14px", textAlign: "center", borderStyle: "dashed", color: "var(--ink3)" }}><div style={{ fontSize: 18 }}>＋</div><div style={{ fontSize: 12, fontWeight: 600 }}>Edit</div></div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 7, marginBottom: 12, overflowX: "auto" }}>
        {KDS_COLS.map((c) => <button key={c} onClick={() => setCol(c)} style={{ ...X.chip, ...(col === c ? X.chipOn : {}) }}>{c} <span style={{ opacity: .6 }}>{count(c)}</span></button>)}
      </div>
      <div style={{ ...X.card, padding: 0, minHeight: 260 }}>
        {shown.length ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(235px,1fr))", gap: 12, padding: 14 }}>
          {shown.map((o, i) => <Ticket key={o.id || i} o={o} />)}
        </div> : <div style={{ padding: "60px 20px", textAlign: "center", color: "var(--ink3)" }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>⬡</div>No orders here yet — open a guest view above and place one.
        </div>}
      </div>
    </div>
  );
}
const ORDER_FLOW = ["new", "preparing", "ready", "delivered", "done"];
const STATUS_LABEL: Record<string, string> = { new: "New", preparing: "Preparing", ready: "Ready", delivered: "Delivered", done: "Done", wasted: "Wasted" };
function setStatus(o: any, to: string) {
  store.commit([{ kind: "orders", id: o.id, data: { ...o, status: to, updatedAt: Date.now() } }]);
}
function Ticket({ o }: { o: any }) {
  const created = o.createdAt || o.t || Date.now();
  const age = Math.max(0, Math.round((Date.now() - created) / 60000));
  const tint = age < 5 ? "var(--green)" : age < 10 ? "var(--amber)" : "var(--red)";
  const status = (o.status || "new").toLowerCase();
  const step = Math.max(0, ORDER_FLOW.indexOf(status));
  const next = ORDER_FLOW[step + 1];
  const src = o.source === "qr" ? (o.table ? "QR · " + o.table : "QR") : o.table ? o.table : "POS";
  return (
    <div style={{ ...X.card, padding: 0, overflow: "hidden", animation: "rise .25s both" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: "color-mix(in srgb," + tint + " 14%,transparent)", color: tint, fontWeight: 800, fontSize: 13 }}>
        <span>#{o.no || o.id} <span style={{ opacity: .7, fontWeight: 700 }}>· {src}</span></span><span className="num">{age}:00</span>
      </div>
      {/* status progress bar */}
      <div style={{ display: "flex", gap: 3, padding: "8px 12px 0" }}>
        {ORDER_FLOW.map((s, i) => <div key={s} title={STATUS_LABEL[s]} style={{ flex: 1, height: 5, borderRadius: 99, background: status === "wasted" ? "var(--red)" : i <= step ? "var(--green)" : "var(--sur2)" }} />)}
      </div>
      <div style={{ padding: "6px 12px 4px", fontSize: 11, fontWeight: 800, letterSpacing: ".03em", color: status === "wasted" ? "var(--red)" : "var(--green)" }}>{STATUS_LABEL[status] || status}</div>
      <div style={{ padding: "2px 12px 10px" }}>{(o.items || o.lines || []).map((l: any, i: number) => <div key={i} style={{ fontSize: 13, padding: "3px 0" }}>{l.qty || l.q}× {l.name || l.n}</div>)}</div>
      {status !== "done" && status !== "wasted" && (
        <div style={{ display: "flex", gap: 6, padding: "0 12px 12px" }}>
          {next && <button onClick={() => setStatus(o, next)} style={{ flex: 1, borderRadius: 10, padding: "9px", background: "var(--coral)", color: "var(--coralink)", fontWeight: 800, fontSize: 12.5 }}>{next === "done" ? "Bump ✓" : STATUS_LABEL[next] + " →"}</button>}
          <button onClick={() => setStatus(o, "done")} title="Bump / complete" style={{ borderRadius: 10, padding: "9px 12px", background: "var(--sur2)", color: "var(--ink)", fontWeight: 800, fontSize: 12.5 }}>✓</button>
        </div>
      )}
    </div>
  );
}

/* ── Admin (module launcher grid) ──────────────────────────────────────────── */
/* Management lives in the back office (/back). Business-data cards deep-link
   there; Cloud Sync + Data & Backup stay in-till since they're device-local. */
const ADMIN = [
  ["🧾", "Products & Inventory", "catalog, prices, stock levels", "/back"],
  ["👤", "Customers", "CRM & loyalty points", "/back"],
  ["🔑", "Users & PINs", "staff accounts for shifts", "/back"],
  ["🍴", "Tables", "dine-in & QR ordering layout", "/back"],
  ["🛵", "Delivery Zones", "islands, fees & ETAs", "/back"],
  ["🗑️", "Wastage Log", "spoilage, spillage, expiry", "/back"],
  ["🧮", "Expenses", "bills, paid-outs, scan with OCR", "/back"],
  ["📦", "Purchase Orders", "raise POs, receive supplier bills", "/back"],
  ["🥫", "Kitchen Supplies", "bulk stock · par levels · stocktake", "/back"],
  ["⚙︎", "Store Settings", "name, GST, currency, receipt", "/back"],
  ["☁️", "Cloud Sync", "connected", ""],
  ["💾", "Data & Backup", "export, restore, reset", ""],
];
export function Admin() {
  const st = useStore();
  const slug = (() => { try { return JSON.parse(localStorage.getItem("kashikeyo-cloud") || "{}").slug || ""; } catch { return ""; } })();
  return (
    <div style={X.scroll}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 12 }}>
        {ADMIN.map(([icon, title, sub, href]) => {
          const inner = (
            <>
              <div style={{ width: 42, height: 42, borderRadius: 12, background: "var(--coralsoft)", color: "var(--coral)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{icon}</div>
              <div style={{ marginTop: 10 }}><b style={{ fontSize: 14.5 }}>{title}</b><div style={{ color: "var(--ink3)", fontSize: 12, marginTop: 2 }}>{title === "Cloud Sync" ? "connected · " + slug : sub}</div></div>
            </>
          );
          return href
            ? <a key={title} href={href} style={{ ...X.card, ...X.tap, padding: 16, textDecoration: "none", color: "inherit", display: "block" }}>{inner}</a>
            : <div key={title} style={{ ...X.card, ...X.tap, padding: 16 }}>{inner}</div>;
        })}
      </div>
      <div style={{ color: "var(--ink3)", fontSize: 12, marginTop: 14 }}>Management opens in the back office. Cloud Sync and Data &amp; Backup are handled on this device.</div>
    </div>
  );
}

function Kpi({ k, v }: { k: string; v: string; big?: boolean }) {
  return <div style={{ ...X.card, padding: "15px 16px" }}>
    <div style={{ color: "var(--ink3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>{k}</div>
    <div className="num" style={{ fontWeight: 800, fontSize: 24, marginTop: 6, color: "var(--green)" }}>{v}</div>
  </div>;
}

/* ── Delivery board (prototype: Online ordering & delivery) ────────────────── */
const DELIV_STEPS = ["Preparing", "On the way", "Delivered"];
export function Delivery() {
  const st = useStore();
  const zones = st.byKind("zones").map((e) => e.data);
  const parked = st.byKind("parked").map((e) => e.data).filter((b: any) => b.otype === "delivery").sort((a: any, b: any) => (a.t || 0) - (b.t || 0));
  const products = st.byKind("products").map((e) => e.data);
  const nameOf = (pid: string) => products.find((p: any) => p.id === pid)?.name || "Item";
  const advance = (b: any) => {
    const next = (b.delivStatus || 0) + 1;
    if (next > 2) { store.del([{ kind: "parked", id: b.id }]); return; }
    store.commit([{ kind: "parked", id: b.id, data: { ...b, delivStatus: next } }]);
  };
  const pillCol = (s: number): [string, string] => s >= 2 ? ["var(--greensoft)", "var(--green)"] : s === 1 ? ["var(--coralsoft)", "var(--coral)"] : ["var(--ambersoft)", "var(--amber)"];
  return (
    <div style={X.scroll}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "var(--num)", fontWeight: 800, fontSize: 19 }}>Online ordering &amp; delivery</div>
        <span style={{ ...X.tag, background: "var(--greensoft)", color: "var(--green)" }}>● Web store live</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14, alignItems: "start" }}>
        <div style={{ ...X.card, padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".06em", color: "var(--ink3)", marginBottom: 10 }}>LIVE DELIVERIES</div>
          {parked.length ? parked.map((b: any) => {
            const s = b.delivStatus || 0; const [bg, fg] = pillCol(s);
            const items = (b.lines || []).map((l: any) => l.qty + "× " + nameOf(l.pid)).join(" · ");
            return (
              <div key={b.id} style={{ border: "1px solid var(--line)", borderRadius: 14, padding: 13, marginBottom: 10, background: "var(--sur2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <b style={{ fontSize: 13.5 }}>{b.no || "Delivery"}</b>
                  <span style={{ fontSize: 12, color: "var(--ink2)" }}>{(b.custName || "Walk-in") + (b.zone ? " · " + b.zone : "")}</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ ...X.tag, background: bg, color: fg }}>{DELIV_STEPS[Math.min(s, 2)]}</span>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink2)", margin: "7px 0 10px" }}>{items || "—"}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {b.deliveryNote && <span style={{ fontSize: 11.5, color: "var(--ink3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📍 {b.deliveryNote}</span>}
                  <div style={{ flex: 1 }} />
                  <button onClick={() => advance(b)} style={{ ...X.pill, cursor: "pointer", color: "var(--coral)", borderColor: "var(--coral)" }}>{s >= 2 ? "Complete ✓" : "Advance →"}</button>
                </div>
              </div>
            );
          }) : <div style={X.empty}>No live deliveries right now. Delivery orders from the register appear here.</div>}
        </div>
        <div style={{ ...X.card, padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".06em", color: "var(--ink3)", marginBottom: 4 }}>DELIVERY ZONES · BY ISLAND</div>
          {zones.length ? zones.map((z: any) => (
            <div key={z.id || z.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 4px", borderBottom: "1px solid var(--line)" }}>
              <span style={{ color: "var(--coral)", fontSize: 15 }}>📍</span>
              <b style={{ flex: 1, fontSize: 13.5 }}>{z.name}</b>
              {z.eta && <span style={{ fontSize: 12, color: "var(--ink3)" }}>{z.eta}</span>}
              <span className="num" style={{ fontWeight: 800, fontSize: 13, minWidth: 62, textAlign: "right", color: Number(z.fee) ? "var(--ink)" : "var(--green)" }}>{Number(z.fee) ? money(z.fee) : "Free"}</span>
            </div>
          )) : <div style={X.empty}>No delivery zones yet — add them in the back office.</div>}
        </div>
      </div>
    </div>
  );
}

/* ── QR Orders (prototype: same portal as the customer/guest app) ───────────
   The guest portal (guest.tsx, served at /?s=<slug>&t=<table>) posts to
   /p/:slug/order, which drops an `orders` entity tagged source:"qr" + table +
   otype. Those sync straight to the till — this screen is the incoming-orders
   view over exactly that stream, with a phone preview of what guests see. */
export function QrOrders() {
  const st = useStore();
  const settings = st.byKind("settings").map((e) => e.data)[0] || {};
  const storeName = settings.storeName || "Kashikeyo Café";
  const products = st.byKind("products").map((e) => e.data).filter((p: any) => p && !p.archived).slice(0, 6);
  const slug = (() => { try { return JSON.parse(localStorage.getItem("kashikeyo-cloud") || "{}").slug || ""; } catch { return ""; } })();
  const incoming = st.byKind("orders").map((e) => e.data)
    .filter((o: any) => o.source === "qr" && !["done", "delivered", "wasted"].includes(String(o.status || "new").toLowerCase()))
    .sort((a: any, b: any) => (a.createdAt || a.t || 0) - (b.createdAt || b.t || 0));
  const itemsLine = (o: any) => (o.items || o.lines || []).map((l: any) => (l.qty || l.q) + "× " + (l.name || l.n)).join(", ");
  return (
    <div style={X.scroll}>
      <div style={{ fontFamily: "var(--num)", fontWeight: 800, fontSize: 19 }}>QR Orders</div>
      <div style={{ color: "var(--ink3)", fontSize: 13, margin: "3px 0 16px", maxWidth: 560 }}>Guests scan a table QR, order from their phone, and tickets land straight on the kitchen display — no re-keyed tablets. It's the same menu and portal your customers use.</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,300px) minmax(0,1fr)", gap: 18, alignItems: "start" }}>
        {/* Phone preview of the guest portal */}
        <div style={{ background: "#1B1A17", borderRadius: 30, padding: 10, boxShadow: "var(--shadow)", justifySelf: "center", width: "100%", maxWidth: 300 }}>
          <div style={{ background: "var(--bg)", borderRadius: 22, overflow: "hidden", display: "flex", flexDirection: "column", height: 500 }}>
            <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ width: 46, height: 5, borderRadius: 99, background: "var(--sur2)", margin: "0 auto 12px" }} />
              <div style={{ fontWeight: 800, fontSize: 15 }}>{storeName}</div>
              <div style={{ fontSize: 11.5, color: "var(--ink3)" }}>Table 4 · Scan · order · pay</div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
              {products.map((p: any) => { const [bg, fg] = tintFor(p.cat || p.name); return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 13, padding: "9px 11px" }}>
                  <span style={{ width: 30, height: 30, borderRadius: 9, background: bg, color: fg, display: "grid", placeItems: "center", fontSize: 15 }}>{p.emoji || (p.name || "?")[0]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 12.5, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</b><small className="num" style={{ color: "var(--ink3)", fontSize: 11 }}>{money(p.price || 0)}</small></div>
                  <span style={{ width: 24, height: 24, borderRadius: 99, background: "var(--coralsoft)", color: "var(--coral)", display: "grid", placeItems: "center", fontWeight: 800 }}>+</span>
                </div>
              ); })}
            </div>
            <div style={{ padding: 12, borderTop: "1px solid var(--line)" }}>
              <div style={{ background: "var(--coral)", color: "var(--coralink)", borderRadius: 13, padding: "12px", textAlign: "center", fontWeight: 800, fontSize: 13.5, opacity: .9 }}>Place order</div>
            </div>
          </div>
        </div>
        {/* Incoming orders + info */}
        <div>
          <div style={{ ...X.card, padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".06em", color: "var(--ink3)", flex: 1 }}>INCOMING QR ORDERS</div>
              {incoming.length > 0 && <span style={{ ...X.tag, background: "var(--coralsoft)", color: "var(--coral)" }}>{incoming.length}</span>}
            </div>
            {incoming.length ? incoming.map((o: any) => {
              const isNew = String(o.status || "new").toLowerCase() === "new";
              return (
                <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderRadius: 13, background: "var(--sur2)", marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: isNew ? "var(--coral)" : "var(--green)", animation: isNew ? "pulse 1.4s infinite" : undefined }} />
                  <b style={{ fontSize: 13 }}>#{o.no || o.id}</b>
                  <span style={{ fontSize: 11.5, color: "var(--ink3)", fontWeight: 700 }}>QR{o.table ? " · " + o.table : ""}</span>
                  <span style={{ flex: 1, minWidth: 120, fontSize: 12.5, color: "var(--ink2)", textAlign: "end" }}>{itemsLine(o) || "—"}</span>
                  <button onClick={() => setStatus(o, isNew ? "preparing" : "ready")} style={{ ...X.pill, cursor: "pointer", color: "var(--coral)", borderColor: "var(--coral)" }}>{isNew ? "Accept →" : "Ready →"}</button>
                </div>
              );
            }) : <div style={{ ...X.empty, textAlign: "center", padding: "30px 16px" }}>No incoming QR orders. Guests' orders appear here the moment they tap Place order.</div>}
          </div>
          <div style={{ background: "var(--greensoft)", borderRadius: 14, padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ fontSize: 18 }}>▦</span>
            <div style={{ flex: 1, fontSize: 12.5, color: "var(--green)", fontWeight: 600, lineHeight: 1.45 }}>Print one QR per table. Orders are tagged with source and table, and roll into the Z-report automatically.
              {slug && <div style={{ marginTop: 8 }}><button onClick={() => window.open("/?s=" + encodeURIComponent(slug), "_blank")} style={{ ...X.pill, cursor: "pointer", background: "var(--sur)", color: "var(--green)", borderColor: "var(--green)" }}>Open live guest view ↗</button></div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Open tabs (prototype: customer credit / on-account) ────────────────────── */
export function Tabs() {
  const st = useStore();
  const custs = st.byKind("customers").map((e) => e.data).filter((c: any) => Number(c.balance || 0) > 0).sort((a: any, b: any) => Number(b.balance) - Number(a.balance));
  const total = custs.reduce((a: number, c: any) => a + Number(c.balance || 0), 0);
  const settle = (c: any) => store.commit([{ kind: "customers", id: c.id, data: { ...c, balance: 0, tabSince: null } }]);
  const daysOf = (c: any) => { const t = c.tabSince || c.updatedAt || c.createdAt; return t ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null; };
  const initials = (n: string) => (n || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div style={X.scroll}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ fontFamily: "var(--num)", fontWeight: 800, fontSize: 19 }}>Open tabs</div>
        <div style={{ flex: 1 }} />
        <span className="num" style={X.pill}>Outstanding · {money(total)}</span>
        <span style={{ ...X.tag, background: "var(--coralsoft)", color: "var(--coral)" }}>{custs.length}</span>
      </div>
      <div style={{ ...X.card, overflow: "hidden" }}>
        {custs.length ? custs.map((c: any, i: number) => {
          const d = daysOf(c); const overdue = d != null && d >= 30; const [bg, fg] = tintFor(c.name || "?");
          return (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: i < custs.length - 1 ? "1px solid var(--line)" : "none" }}>
              <span style={{ width: 38, height: 38, borderRadius: 999, background: bg, color: fg, display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13, flex: "0 0 38px" }}>{initials(c.name)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: 14, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name || "Walk-in"}</b>
                <small style={{ color: "var(--ink3)" }}>{d != null ? "on tab for " + d + "d" : "on tab"}{c.phone ? " · " + c.phone : ""}</small>
              </div>
              {d != null && <span style={{ ...X.tag, background: overdue ? "var(--redsoft)" : d >= 10 ? "var(--ambersoft)" : "var(--greensoft)", color: overdue ? "var(--red)" : d >= 10 ? "var(--amber)" : "var(--green)" }}>{overdue ? "overdue 30d+" : d + "d"}</span>}
              <span className="num" style={{ fontWeight: 800, fontSize: 14, minWidth: 92, textAlign: "right" }}>{money(Number(c.balance))}</span>
              <button onClick={() => settle(c)} style={{ ...X.pill, cursor: "pointer", color: "var(--green)", borderColor: "var(--green)" }}>Settle</button>
            </div>
          );
        }) : <div style={{ ...X.empty, textAlign: "center", padding: "40px 20px" }}>All tabs settled — no open customer credit.</div>}
      </div>
    </div>
  );
}

const X: Record<string, React.CSSProperties> = {
  scroll: { flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 18px 40px" },
  card: { background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 16, boxShadow: "var(--shadow)" },
  tap: { cursor: "pointer" },
  pill: { border: "1px solid var(--line)", background: "var(--sur)", borderRadius: 999, padding: "7px 13px", fontSize: 12.5, fontWeight: 700, color: "var(--ink2)" },
  chip: { whiteSpace: "nowrap", padding: "8px 15px", borderRadius: 999, fontSize: 13, fontWeight: 700, color: "var(--ink2)", background: "var(--sur)", border: "1px solid var(--line)" },
  chipOn: { background: "var(--coral)", color: "var(--coralink)", borderColor: "var(--coral)" },
  seg: { display: "inline-flex", gap: 2, background: "var(--sur2)", borderRadius: 999, padding: 3 },
  segBtn: { padding: "5px 13px", borderRadius: 999, fontSize: 12.5, fontWeight: 700, color: "var(--ink2)" },
  segOn: { background: "var(--green)", color: "#fff" },
  tag: { fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999 },
  empty: { color: "var(--ink3)", fontSize: 13, padding: "14px 2px" },
  overlay: { position: "fixed", inset: 0, background: "rgba(20,18,15,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40, animation: "fade .2s" },
  modal: { width: "min(420px,94vw)", background: "var(--bg)", borderRadius: 22, padding: 22, boxShadow: "var(--shadow)", animation: "sheet .3s cubic-bezier(.2,.9,.3,1.1)" },
  input: { padding: "11px 13px", borderRadius: 11, border: "1px solid var(--line)", background: "var(--sur)", color: "var(--ink)", fontSize: 14, outline: "none" },
  refundBtn: { width: "100%", marginTop: 16, borderRadius: 13, padding: "12px", background: "var(--red)", color: "#fff", fontWeight: 800, fontSize: 15 },
};
