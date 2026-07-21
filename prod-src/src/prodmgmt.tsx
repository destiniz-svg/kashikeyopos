import { useMemo, useState } from "react";
import { useStore } from "./store";

/* ── Management screens: Dashboard · Reports · Admin ──────────────────────────
   Production's cockpit screens rebuilt in the ksh theme, from the synced
   sales/shifts/expenses entities. Admin is a launcher grid — business modules
   deep-link to the full back office (/back); Cloud Sync + Data & Backup are
   device-local. */

const money = (laari: number) => "MVR " + (Math.round(Number(laari) || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (laari: number) => "MVR " + Math.round((Number(laari) || 0) / 100).toLocaleString("en-US");
const isSale = (d: any) => d && d.type !== "refund" && !d.refunded;
const sameDay = (t: number) => new Date(t).toDateString() === new Date().toDateString();

/* ── Dashboard ─────────────────────────────────────────────────────────────── */
export function DashboardScreen({ _ }: { _: any }) {
  const st = useStore();
  const sales = st.byKind("sales").map((e) => e.data).filter(isSale);
  const today = useMemo(() => sales.filter((s) => sameDay(s.t)), [sales]);

  const net = today.reduce((a, s) => a + (s.total || 0), 0);
  const tx = today.length;
  const items = today.reduce((a, s) => a + (s.lines || []).reduce((x: number, l: any) => x + (l.qty || 0), 0), 0);
  const avg = tx ? Math.round(net / tx) : 0;

  const byHour = new Array(24).fill(0);
  today.forEach((s) => { byHour[new Date(s.t).getHours()] += (s.total || 0); });
  const hours = byHour.slice(7, 23); // 7a–10p
  const maxH = Math.max(1, ...hours);
  const busiest = hours.indexOf(Math.max(...hours));

  const tally: Record<string, number> = {};
  today.forEach((s) => (s.lines || []).forEach((l: any) => { const n = l.name || "Item"; tally[n] = (tally[n] || 0) + (l.qty || 0); }));
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const mix: Record<string, number> = {};
  today.forEach((s) => (s.payments || []).forEach((p: any) => { mix[p.method] = (mix[p.method] || 0) + (p.amount || 0); }));
  const mixTotal = Object.values(mix).reduce((a, b) => a + b, 0) || 1;

  const kpis: [string, string][] = [["Net sales today", money(net)], ["Transactions", String(tx)], ["Avg basket", money(avg)], ["Items sold", String(items)]];

  return (
    <div className="pb-8">
      <div className={`text-sm mb-3 ${_.sub}`}>{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div>
      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
        {kpis.map(([k, v]) => (
          <div key={k} className={`rounded-2xl p-4 ${_.panel}`}>
            <div className={`text-xs uppercase tracking-wide ${_.sub}`}>{k}</div>
            <div className="ksh-display num text-2xl font-bold mt-1" style={{ color: "var(--k-primary)" }}>{v}</div>
          </div>
        ))}
      </div>

      <div className={`rounded-2xl p-4 mb-4 ${_.panel}`}>
        <div className="flex items-baseline gap-2 mb-3">
          <div className="text-sm font-semibold">Sales by hour (today)</div>
          {net > 0 && <div className={`text-xs ${_.sub}`}>Busiest {busiest + 7}:00 · {money(maxH)}</div>}
        </div>
        <div className="flex items-end gap-1" style={{ height: 160 }}>
          {hours.map((h, i) => (
            <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1" style={{ height: "100%" }}>
              <div className="w-full rounded-t" style={{ height: Math.max(2, (h / maxH) * 130) + "px", background: i === busiest && h > 0 ? "var(--k-primary)" : "var(--k-panel2)" }} title={money(h)} />
            </div>
          ))}
        </div>
        <div className={`flex justify-between text-xs mt-1.5 ${_.faint}`}><span>7a</span><span>1p</span><span>10p</span></div>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
        <div className={`rounded-2xl p-4 ${_.panel}`}>
          <div className="text-sm font-semibold mb-2">Top items today</div>
          {top.length ? top.map(([n, q], i) => (
            <div key={n} className="flex items-center gap-2 py-1.5 text-sm">
              <span className={`w-5 ${_.faint}`}>{i + 1}</span><span className="flex-1 truncate">{n}</span><span className="num font-semibold">{q}×</span>
            </div>
          )) : <div className={`text-sm py-2 ${_.faint}`}>No sales yet today.</div>}
        </div>
        <div className={`rounded-2xl p-4 ${_.panel}`}>
          <div className="text-sm font-semibold mb-2">Payment mix today</div>
          {Object.keys(mix).length ? Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
            <div key={m} className="py-1.5">
              <div className="flex justify-between text-sm"><span className={_.sub}>{m === "Credit" ? "On tab" : m}</span><span className="num font-semibold">{money(v)}</span></div>
              <div className="h-1.5 rounded-full mt-1" style={{ background: "var(--k-panel2)" }}><div className="h-full rounded-full" style={{ width: (v / mixTotal * 100) + "%", background: "var(--k-primary)" }} /></div>
            </div>
          )) : <div className={`text-sm py-2 ${_.faint}`}>No sales yet today.</div>}
        </div>
      </div>
    </div>
  );
}

/* ── Reports ───────────────────────────────────────────────────────────────── */
export function ReportsScreen({ _, settings }: { _: any; settings: any }) {
  const st = useStore();
  const sales = st.byKind("sales").map((e) => e.data).filter(isSale);
  const shifts = st.byKind("shifts").map((e) => e.data);
  const [range, setRange] = useState<"today" | "7d" | "all">("today");

  const from = range === "today" ? new Date().setHours(0, 0, 0, 0) : range === "7d" ? Date.now() - 7 * 86400000 : 0;
  const scope = sales.filter((s) => (s.t || 0) >= from);
  const gross = scope.reduce((a, s) => a + (s.total || 0), 0);
  const gst = scope.reduce((a, s) => a + (s.gst || 0), 0);
  const svc = scope.reduce((a, s) => a + (s.svcCharge || 0), 0);
  const net = gross - gst;
  const closed = shifts.filter((s) => s.closedAt).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 12);

  return (
    <div className="pb-8">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="ksh-display text-xl font-bold">Reports</h2>
        <div className="flex-1" />
        <div className={`inline-flex rounded-full p-1 ${_.panel2}`}>
          {([["today", "Today"], ["7d", "7 days"], ["all", "All"]] as [any, string][]).map(([r, l]) => (
            <button key={r} onClick={() => setRange(r)} className={`px-3 py-1.5 rounded-full text-xs font-semibold ${range === r ? _.primary : ""}`} style={range !== r ? { color: "var(--k-sub)" } : {}}>{l}</button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
        {([["Gross sales", money(gross)], ["Net (ex-GST)", money(net)], ["GST collected", money(gst)], ["Service charge", money(svc)]] as [string, string][]).map(([k, v]) => (
          <div key={k} className={`rounded-2xl p-4 ${_.panel}`}>
            <div className={`text-xs uppercase tracking-wide ${_.sub}`}>{k}</div>
            <div className="ksh-display num text-xl font-bold mt-1">{v}</div>
          </div>
        ))}
      </div>

      <div className={`rounded-2xl p-4 ${_.panel}`}>
        <div className="text-sm font-semibold mb-2">Z-report history</div>
        {closed.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead><tr className={`text-xs uppercase ${_.faint}`}>
                <th className="text-left py-1.5">Z-report</th><th className="text-left">Closed</th><th className="text-right">Counted</th><th className="text-right">Expected</th><th className="text-right">Over / short</th>
              </tr></thead>
              <tbody>
                {closed.map((s) => { const diff = (s.countedCash || 0) - (s.expectedCash || 0); return (
                  <tr key={s.id} style={{ borderTop: "1px solid var(--k-border)" }}>
                    <td className="py-2 num font-semibold">{s.zNo || "Z-—"}</td>
                    <td className={_.sub}>{new Date(s.closedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="text-right num">{money0(s.countedCash || 0)}</td>
                    <td className="text-right num">{money0(s.expectedCash || 0)}</td>
                    <td className="text-right num font-semibold" style={{ color: diff === 0 ? "var(--k-sub)" : diff > 0 ? "#177E4B" : "#C13A26" }}>{diff === 0 ? "—" : (diff > 0 ? "+" : "−") + money0(Math.abs(diff))}</td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
        ) : <div className={`text-sm py-3 ${_.faint}`}>No closed shifts yet. Close a day from the Day End tab to post a Z-report.</div>}
      </div>
      <div className={`text-xs mt-3 ${_.faint}`}>Deeper analytics, GST filings and exports live in the back office · <a href="/back" style={{ color: "var(--k-primary)" }}>open /back →</a></div>
    </div>
  );
}

/* ── Admin (module launcher) ───────────────────────────────────────────────── */
const ADMIN: [string, string, string, string][] = [
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
export function AdminScreen({ _ }: { _: any }) {
  const slug = (() => { try { return JSON.parse(localStorage.getItem("kashikeyo-cloud") || "{}").slug || ""; } catch { return ""; } })();
  return (
    <div className="pb-8">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))" }}>
        {ADMIN.map(([icon, title, sub, href]) => {
          const inner = <>
            <div className="w-11 h-11 rounded-xl grid place-items-center text-xl" style={{ background: "var(--k-panel2)", color: "var(--k-primary)" }}>{icon}</div>
            <div className="mt-2.5"><b className="text-sm">{title}</b><div className={`text-xs mt-0.5 ${_.faint}`}>{title === "Cloud Sync" ? "connected · " + slug : sub}</div></div>
          </>;
          return href
            ? <a key={title} href={href} className={`rounded-2xl p-4 block ${_.panel}`} style={{ textDecoration: "none", color: "inherit" }}>{inner}</a>
            : <div key={title} className={`rounded-2xl p-4 ${_.panel}`}>{inner}</div>;
        })}
      </div>
      <div className={`text-xs mt-3 ${_.faint}`}>Management opens in the back office. Cloud Sync and Data &amp; Backup are handled on this device.</div>
    </div>
  );
}
