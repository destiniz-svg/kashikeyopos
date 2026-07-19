import { useMemo, useState } from "react";
import { useStore } from "./store";
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 14 }}>
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
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
          </div>
        )) : <div style={X.empty}>No sales yet today.</div>}
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
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
function Ticket({ o }: { o: any }) {
  const age = Math.max(0, Math.round((Date.now() - (o.t || Date.now())) / 60000));
  const tint = age < 5 ? "var(--green)" : age < 10 ? "var(--amber)" : "var(--red)";
  return (
    <div style={{ ...X.card, padding: 0, overflow: "hidden", animation: "rise .25s both" }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", background: "color-mix(in srgb," + tint + " 14%,transparent)", color: tint, fontWeight: 800, fontSize: 13 }}>
        <span>#{o.no || o.id}</span><span className="num">{age}:00</span>
      </div>
      <div style={{ padding: 12 }}>{(o.lines || o.items || []).map((l: any, i: number) => <div key={i} style={{ fontSize: 13, padding: "3px 0" }}>{l.qty || l.q}× {l.name || l.n}</div>)}</div>
    </div>
  );
}

/* ── Admin (module launcher grid) ──────────────────────────────────────────── */
const ADMIN = [
  ["🧾", "Products & Inventory", "catalog, prices, stock levels", "/back"],
  ["👤", "Customers", "CRM & loyalty points", "/back"],
  ["🔑", "Users & PINs", "staff accounts for shifts", ""],
  ["🍴", "Tables", "dine-in & QR ordering layout", ""],
  ["🛵", "Delivery Zones", "islands, fees & ETAs", ""],
  ["🗑️", "Wastage Log", "spoilage, spillage, expiry", "/back"],
  ["🧮", "Expenses", "bills, paid-outs, scan with OCR", "/back"],
  ["📦", "Purchase Orders", "raise POs, receive supplier bills", "/back"],
  ["🥫", "Kitchen Supplies", "bulk stock · par levels · stocktake", "/back"],
  ["⚙︎", "Store Settings", "name, GST, currency, receipt", ""],
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
      <div style={{ color: "var(--ink3)", fontSize: 12, marginTop: 14 }}>Cards marked with the back-office arrow open the full management view. Others manage in place.</div>
    </div>
  );
}

function Kpi({ k, v }: { k: string; v: string; big?: boolean }) {
  return <div style={{ ...X.card, padding: "15px 16px" }}>
    <div style={{ color: "var(--ink3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>{k}</div>
    <div className="num" style={{ fontWeight: 800, fontSize: 24, marginTop: 6, color: "var(--green)" }}>{v}</div>
  </div>;
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
};
