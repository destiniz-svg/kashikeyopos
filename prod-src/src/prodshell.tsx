import { useEffect, useMemo, useRef, useState } from "react";
import { store, useStore } from "./store";
import { uid, elevate } from "./api";
import { resolveTheme } from "./theme";
import { OrdersScreen } from "./prodorders";
import { FloorScreen } from "./prodfloor";
import { TabsScreen } from "./prodtabs";
import { DayEndScreen } from "./proddayend";

/* Cart line — matches the Step-1 model (pid + qty + mods; per-line discount +
   its approval live on the line so the canvas + audit trail read them). */
type Mod = { name: string; price: number };
type Line = { key: string; pid: string; qty: number; mods: Mod[]; discPct?: number; discAuth?: any };
type OType = "dinein" | "takeaway" | "delivery";

/* Category emoji, verbatim from production's window.__ksCatEmoji. */
const CAT_EMOJI: Record<string, string> = { All: "🍽️", "Main Dishes": "🍛", Coffee: "☕", Drinks: "🥤", Bakery: "🥐", Grocery: "🛒", Hedhikaa: "🍢", More: "⋯" };
const catLabel = (c: string) => (CAT_EMOJI[c] ? CAT_EMOJI[c] + " " : "") + c;
const cardPrice = (laari: number) => (Math.round(Number(laari) || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (laari: number) => "MVR " + cardPrice(laari);
/* Staging's void reasons (item modifications) — no manager password. */
const VOID_REASONS = ["Guest changed mind", "Kitchen error", "Out of stock", "Other"];
/* Staging's discount presets. */
const DISC_PRESETS = [0, 5, 10, 15, 20];

/* ── Production shell — faithful reconstruction of the deployed till chrome ───
   Header bar (logo · store name · location chip · ml-auto shift pill + account)
   is sticky; the nav is a SEPARATE floating centered pill fixed over it, exactly
   as production renders it (top:9px, translateX(-50%)). Everything is driven by
   the `_` theme object (production's __kpal output) so a store's brand palette —
   orange/green/watermelon/mango/strawberry × light/dark — paints the whole
   frame. The Sell body here is the three-pane skeleton (Open Bills · Menu ·
   Order canvas); the menu grid and canvas mechanics land in the next steps. */

const NAV: [string, string, string][] = [
  ["sell", "Sell", '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h2l2.6 12.4A2 2 0 0 0 8.5 17h9a2 2 0 0 0 2-1.6L21.5 7H6"/>'],
  ["floor", "Floor", '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'],
  ["orders", "Orders", '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h3"/>'],
  ["tabs", "Tabs", '<path d="M3 6a2 2 0 0 1 2-2h9l4 4v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 12h6M8 16h4"/>'],
  ["dayend", "Day End", '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  ["dash", "Dashboard", '<path d="M3 13h8V3H3zM13 21h8v-6h-8zM13 11h8V3h-8zM3 21h8v-6H3z"/>'],
  ["reports", "Reports", '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>'],
  ["admin", "Admin", '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'],
];

function Icon({ path, size = 18 }: { path: string; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: path }} />;
}

export function ProdShell({ user, onSignOut }: { user: any; onSignOut: () => void }) {
  const st = useStore();
  const settings = st.byKind("settings")[0]?.data || {};
  const _ = useMemo(() => resolveTheme(settings), [settings.theme]);
  const [nav, setNav] = useState("sell");
  /* Cross-screen seat intent: the Floor tab sets this to hand a table/party
     over to the register (seat a new party) or resume a held bill, then jumps
     to Sell which consumes it once. */
  const [seatIntent, setSeatIntent] = useState<any>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(id); }, []);

  const shifts = st.byKind("shifts").map((e) => e.data);
  const openShift = shifts.find((s) => !s.closedAt) || null;
  const parked = st.byKind("parked").map((e) => e.data);
  const orders = st.byKind("orders").map((e) => e.data).filter((o: any) => !["done", "wasted"].includes(String(o.status || "new").toLowerCase()));
  const products = st.byKind("products").map((e) => e.data).filter((p: any) => p && !p.archived);
  const clock = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + ", " + now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const storeName = settings.storeName || "Kashikeyo";
  const first = (user?.name || "Staff").split(" ")[0];

  return (
    <div className={`min-h-screen h-full flex flex-col font-sans ${_.app}`}>
      {/* Sticky header bar */}
      <div className={`no-print sticky top-0 z-30 backdrop-blur border-b px-4 py-3 flex items-center gap-3 ${_.header}`}>
        <img src="/icon-192.png" alt="" className="w-6 h-6 object-contain" />
        <div className="text-base font-bold tracking-tight" style={{ maxWidth: "48vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{storeName}</div>
        {settings.location && <span className={`hidden sm:inline text-xs px-2 py-1 rounded-full ${_.chip}`}>{settings.location}</span>}
        <div className="ml-auto flex items-center gap-2">
          <span className={`hidden md:inline text-xs num ${_.sub}`}>{clock}</span>
          <span className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium ${openShift ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${openShift ? "bg-emerald-500" : "bg-amber-500"}`} />
            {openShift ? "Shift open" : "No shift"}
          </span>
          <button onClick={onSignOut} className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full text-xs font-medium ${_.chip}`}>
            <span className={`w-6 h-6 rounded-full flex items-center justify-center font-semibold ${_.chipOn}`}>{(first[0] || "?").toUpperCase()}</span>
            {first}
          </button>
        </div>
      </div>

      {/* Floating centered nav pill (production positions this fixed over the header) */}
      <div className={`no-print backdrop-blur ksh-topnav ${_.nav}`} style={{ position: "fixed", top: "9px", left: "50%", transform: "translateX(-50%)", zIndex: 40, borderRadius: "22px", border: "1px solid var(--k-border)", boxShadow: "0 6px 20px rgba(16,40,28,.14)", maxWidth: "calc(100vw - 16px)" }}>
        <div className="flex items-center" style={{ gap: "4px", padding: "5px 6px", flexWrap: "wrap", justifyContent: "center" }}>
          {NAV.map(([id, label, path]) => {
            const on = nav === id;
            return (
              <button key={id} onClick={() => setNav(id)} className={`transition ${on ? _.primary : _.navOff}`} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "7px", padding: "8px 14px", borderRadius: "999px", fontSize: "13.5px", fontWeight: 500, whiteSpace: "nowrap" }}>
                <span className="relative" style={{ display: "inline-flex" }}>
                  <Icon path={path} />
                  {id === "orders" && orders.length > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 h-4 px-1 rounded-full bg-amber-500 text-white text-xs font-bold flex items-center justify-center">{orders.length}</span>
                  )}
                </span>
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="ksh-navpad flex-1 min-h-0 max-w-6xl w-full mx-auto px-4 pt-4">
        {nav === "sell" ? (
          <SellScreen _={_} parked={parked} openShift={openShift} products={products} settings={settings} user={user}
            seatIntent={seatIntent} clearSeatIntent={() => setSeatIntent(null)} />
        ) : nav === "floor" ? (
          <FloorScreen _={_} parked={parked} orders={st.byKind("orders").map((e) => e.data)} products={products} settings={settings}
            onSeat={(intent: any) => { setSeatIntent(intent); setNav("sell"); }} />
        ) : nav === "orders" ? (
          <OrdersScreen _={_} />
        ) : nav === "tabs" ? (
          <TabsScreen _={_} user={user} settings={settings} />
        ) : nav === "dayend" ? (
          <DayEndScreen _={_} user={user} settings={settings} />
        ) : <TabStub _={_} label={NAV.find((n) => n[0] === nav)?.[1] || nav} />}
      </div>
    </div>
  );
}

/* Three-pane Sell frame — production's register layout, rebuilt faithfully with
   two deliberate feature changes per the merge spec:
   • Item modifications (removing a line) require a REASON (Staging), not a
     manager password.
   • Discounts use Staging's mechanic — a preset-% picker gated on manager
     password approval, logged on the line/bill (discAuth). */
function SellScreen({ _, parked, openShift, products, settings, user, seatIntent, clearSeatIntent }:
  { _: any; parked: any[]; openShift: any; products: any[]; settings: any; user: any; seatIntent?: any; clearSeatIntent?: () => void }) {
  const st = useStore();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const searchRef = useRef<HTMLInputElement>(null);
  const [cart, setCart] = useState<Line[]>([]);
  const [otype, setOtype] = useState<OType>("takeaway");
  const [table, setTable] = useState("");
  const [guests, setGuests] = useState(1);
  const [partyName, setPartyName] = useState("");
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [cust, setCust] = useState<any>(null);
  const [billDiscPct, setBillDiscPct] = useState(0);
  const [billDiscAuth, setBillDiscAuth] = useState<any>(null);
  const [discReq, setDiscReq] = useState<{ scope: "bill" | "line"; idx?: number } | null>(null);
  const [voidReq, setVoidReq] = useState<{ idx: number; name: string } | null>(null);
  const [custPick, setCustPick] = useState(false);
  const [tablePick, setTablePick] = useState(false);

  const groups: { name: string; subs: string[] }[] = settings.catGroups || [];
  const cats = ["All", ...groups.map((g) => g.name)];
  const subInGroup = (cat: string) => group === "All" || (groups.find((g) => g.name === group)?.subs || []).includes(cat);
  const codeOf = (p: any) => String(p.barcode || p.sku || p.code || "").toLowerCase();
  const q = query.trim().toLowerCase();
  const items = products.filter((p) => subInGroup(p.cat) && (!q || (p.name || "").toLowerCase().includes(q) || (codeOf(p) && codeOf(p).includes(q))));
  const isOut = (p: any) => (p.recipeAvail != null && Number(p.recipeAvail) <= 0) || (p.stock != null && Number(p.stock) <= 0) || !!p.soldOut;
  const prodById = (pid: string) => products.find((p: any) => p.id === pid);
  const qtyOf = (pid: string) => cart.filter((l) => l.pid === pid).reduce((a, l) => a + l.qty, 0);

  const addLine = (p: any) => {
    const key = p.id + "|";
    setCart((c) => { const i = c.findIndex((l) => l.key === key); if (i >= 0) { const n = c.slice(); n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; } return c.concat([{ key, pid: p.id, qty: 1, mods: [] }]); });
  };
  const enterAdd = () => {
    if (!q) return;
    const exact = products.find((p) => codeOf(p) === q || String(p.id).toLowerCase() === q);
    const hit = exact || (items.length === 1 ? items[0] : null);
    if (hit && !isOut(hit)) { addLine(hit); setQuery(""); }
  };
  const bump = (idx: number, d: number) => {
    setCart((c) => { const n = c.slice(); const nq = n[idx].qty + d; if (nq <= 0) { const nm = n.slice(); nm.splice(idx, 1); return nm; } n[idx] = { ...n[idx], qty: nq }; return n; });
  };
  const requestDec = (idx: number) => { if (cart[idx].qty <= 1) { const p = prodById(cart[idx].pid); setVoidReq({ idx, name: p?.name || "item" }); } else bump(idx, -1); };
  const requestRemove = (idx: number) => { const p = prodById(cart[idx].pid); setVoidReq({ idx, name: p?.name || "item" }); };
  const confirmVoid = (reason: string) => { if (!voidReq) return; setCart((c) => c.filter((_l, i) => i !== voidReq.idx)); setVoidReq(null); void reason; };
  const applyDisc = (pct: number, auth: any) => {
    if (!discReq) return;
    if (discReq.scope === "bill") { setBillDiscPct(pct); setBillDiscAuth(pct ? auth : null); }
    else { const i = discReq.idx!; setCart((c) => { const n = c.slice(); n[i] = { ...n[i], discPct: pct || undefined, discAuth: pct ? auth : undefined }; return n; }); }
    setDiscReq(null);
  };

  const lineUnit = (l: Line) => (Number(prodById(l.pid)?.price) || 0) + (l.mods || []).reduce((a, m) => a + (m.price || 0), 0);
  const lineTotal = (l: Line) => Math.round(lineUnit(l) * l.qty * (1 - (l.discPct || 0) / 100));
  const subtotal = cart.reduce((a, l) => a + lineTotal(l), 0);
  const billDisc = Math.round(subtotal * billDiscPct / 100);
  const afterDisc = subtotal - billDisc;
  const svcBp = Number(settings.svcChargeBp || 0);
  const gstBp = Number(settings.gstBp || 800);
  const svc = Math.round(afterDisc * svcBp / 10000);
  const gst = Math.round(afterDisc * gstBp / 10000);
  const total = afterDisc + gst + svc;
  const count = cart.reduce((a, l) => a + l.qty, 0);

  /* Upsell — "Often added with X": suggest a best-seller not already on the
     bill, keyed off the last line added (production's paired-item nudge). */
  const lastLine = cart[cart.length - 1];
  const lastProd = lastLine ? prodById(lastLine.pid) : null;
  const suggestion = lastProd ? products.find((p: any) => !isOut(p) && p.bestSeller && !cart.some((l) => l.pid === p.id)) : null;

  const clearBill = () => { setCart([]); setBillDiscPct(0); setBillDiscAuth(null); setCust(null); setTable(""); setGuests(1); setPartyName(""); setResumeId(null); };
  /* Consume a seat intent handed over from the Floor tab, once. */
  useEffect(() => {
    if (!seatIntent) return;
    if (seatIntent.mode === "resume" && seatIntent.bill) {
      const b = seatIntent.bill;
      setCart((b.lines || []).map((l: any) => ({ key: l.key || l.pid + "|", pid: l.pid, qty: Number(l.qty) || 1, mods: l.mods || [], discPct: l.discPct, discAuth: l.discAuth })));
      setOtype(b.otype || "dinein"); setTable(b.table || ""); setGuests(Number(b.guests) || 1);
      setPartyName(b.customerId ? "" : (b.custName || "")); setCust(b.customerId ? { id: b.customerId, name: b.custName } : null);
      setBillDiscPct(Number(b.discPct) || 0); setBillDiscAuth(b.discAuth || null); setResumeId(b.id);
      store.del([{ kind: "parked", id: b.id }]);
    } else {
      setCart([]); setBillDiscPct(0); setBillDiscAuth(null); setCust(null); setResumeId(null);
      setOtype("dinein"); setTable(seatIntent.table || ""); setGuests(Number(seatIntent.guests) || 1); setPartyName(seatIntent.name || "");
    }
    clearSeatIntent?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatIntent]);
  const park = () => {
    if (!cart.length) return;
    const id = resumeId || uid();
    const bill = { id, t: Date.now(), no: "#" + String(parked.length + 1).padStart(4, "0"), otype, table: table || null, guests, lines: cart, discPct: billDiscPct, discAuth: billDiscAuth || undefined, customerId: cust?.id || null, custName: cust?.name || partyName || null, userName: user?.name, storeId: settings.storeId || "main" };
    store.commit([{ kind: "parked", id: bill.id, data: bill }]);
    clearBill();
  };
  const charge = () => {
    if (!cart.length) return;
    const sale = { id: uid(), no: "INV-" + String((st.byKind("sales").length) + 1).padStart(5, "0"), t: Date.now(), type: "sale", otype, table: table || null,
      userName: user?.name, customerId: cust?.id || null, customerName: cust?.name || null, storeId: settings.storeId || "main", shiftId: openShift?.id || null,
      lines: cart.map((l) => { const p = prodById(l.pid); return { pid: l.pid, qty: l.qty, name: p?.name, price: lineUnit(l), discPct: l.discPct || 0, discountAuth: l.discAuth || null, emoji: p?.emoji }; }),
      subtotal, billDisc, billDiscPct, discountAuth: billDiscAuth || null, gst, svcCharge: svc, total, payments: [{ method: "Cash", amount: total }], change: 0, refunded: false };
    store.commit([{ kind: "sales", id: sale.id, data: sale }]);
    clearBill();
  };

  return (
    <div className="grid gap-3 h-full pb-6" style={{ gridTemplateColumns: "minmax(0,220px) minmax(0,1fr) minmax(0,380px)" }}>
      {/* Open Bills rail */}
      <div className={`rounded-2xl p-3 ${_.panel}`} style={{ alignSelf: "start" }}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm font-semibold">🧾 Open Bills</span>
          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${_.chip}`}>{parked.length}</span>
        </div>
        {parked.length === 0 && <div className={`text-xs text-center py-6 ${_.sub}`}>No open bills. Held and kitchen-fired orders show up here.</div>}
        <button onClick={clearBill} className={`w-full mt-2 py-2 rounded-xl text-sm ${_.btn}`} style={{ borderStyle: "dashed" }}>+ New bill</button>
      </div>

      {/* Menu pane */}
      <div className="flex flex-col gap-3 min-w-0">
        {!openShift && <div className="w-full flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium border border-amber-500/50 text-amber-600 bg-amber-500/5">🕓 No shift open — tap to open one before taking payments</div>}
        <div className="flex gap-2">
          <div className={`flex items-center flex-1 rounded-xl px-3 ${_.input}`}>
            <svg viewBox="0 0 24 24" width={16} height={16} className={_.faint} fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enterAdd()}
              placeholder="Search or type barcode… (Enter adds)" className="flex-1 bg-transparent outline-none px-2 py-2.5 text-sm" />
            {query && <button onClick={() => setQuery("")} className={_.faint}>✕</button>}
          </div>
          <button className={`flex items-center gap-1.5 rounded-xl px-3 text-sm font-medium ${_.btn}`} onClick={() => searchRef.current?.focus()}>📷 Scan</button>
        </div>

        {/* Category chips */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar py-0.5">
          {cats.map((c) => (
            <button key={c} onClick={() => setGroup(c)} className={`whitespace-nowrap px-3 py-1.5 rounded-full text-sm font-medium ${group === c ? _.chipOn : _.chip}`}>{catLabel(c)}</button>
          ))}
        </div>

        {/* Product grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
          {items.map((p) => {
            const out = isOut(p); const inCart = qtyOf(p.id);
            const tracked = p.stock != null; const low = tracked && Number(p.stock) <= Number(p.reorder || 0);
            return (
              <button key={p.id} disabled={out} onClick={() => !out && addLine(p)} className={`relative rounded-2xl p-3 text-left transition active:scale-95 ${_.tile} ${out ? "opacity-50" : ""}`}>
                {out && <span className="absolute top-2 right-2 ksh-pill" style={{ background: "#FEE2E2", color: "#B91C1C", fontSize: 10, padding: "2px 8px", zIndex: 2 }}>Sold out</span>}
                {!out && p.bestSeller && <span className="absolute top-2 left-2 ksh-pill" style={{ background: "var(--k-primary)", color: "#fff", fontSize: 9, fontWeight: 600, padding: "2px 7px", zIndex: 2 }}>★ Best seller</span>}
                {!out && inCart > 0 && <span className={`absolute top-2 right-2 w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center ${_.primary}`} style={{ zIndex: 2 }}>{inCart}</span>}
                {p.img
                  ? <img src={p.img} alt="" className="w-full rounded-lg mb-1.5" style={{ aspectRatio: "4/3", objectFit: "contain", background: "#F4F1EB" }} />
                  : <div className="text-3xl mb-1.5 h-16 flex items-center">{p.emoji || (p.name || "?")[0]}</div>}
                <div className="text-sm font-medium leading-snug h-9 overflow-hidden">{p.name}</div>
                <div className="flex items-end justify-between mt-1">
                  <span className="num text-sm font-semibold">{cardPrice(p.price)}</span>
                  {tracked && <span className={`text-xs num ${low ? "text-amber-500 font-semibold" : _.faint}`}>{low && "⚠ "}{p.stock} {p.unit || "pcs"}</span>}
                </div>
              </button>
            );
          })}
          {!items.length && <div className={`col-span-full text-center py-8 text-sm ${_.faint}`}>No products match</div>}
        </div>
      </div>

      {/* Order canvas */}
      <div className={`rounded-2xl p-4 flex flex-col ${_.panel}`} style={{ alignSelf: "start", maxHeight: "calc(100vh - 120px)" }}>
        {/* Multi-bill tabs */}
        <div className="flex items-center gap-2 mb-3">
          <span className={`px-3 py-1 rounded-full text-sm font-semibold ${_.primary}`}>#1</span>
          <button onClick={park} title="Hold this bill & start a new one" className={`w-7 h-7 rounded-full text-sm ${_.btn}`}>+</button>
          <span className={`ml-auto text-xs ${_.sub}`}>{count} item{count === 1 ? "" : "s"}</span>
        </div>
        {/* Order-type toggle */}
        <div className="grid grid-cols-3 gap-1.5 mb-2">
          {(["dinein", "takeaway", "delivery"] as OType[]).map((t) => (
            <button key={t} onClick={() => { setOtype(t); if (t !== "dinein") setTable(""); }} className={`py-2 rounded-lg text-xs font-semibold ${otype === t ? _.primary : _.btn}`}>{t === "dinein" ? "Dine-in" : t === "takeaway" ? "Takeaway" : "Delivery"}</button>
          ))}
        </div>
        {/* Customer + table */}
        <div className="grid grid-cols-2 gap-2 mb-2">
          <button onClick={() => setCustPick(true)} className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm min-w-0 ${_.panel2}`}>
            <span>👤</span>
            {cust ? <span className="flex-1 text-left min-w-0"><span className="font-medium block truncate">{cust.name}</span><span className={`block text-xs ${_.sub}`}>{(cust.balance || 0) > 0 ? "owes " + money(cust.balance) : (cust.points || 0) + " pts"}</span></span>
                  : <span className={`flex-1 text-left ${_.sub}`}>Add customer</span>}
          </button>
          <button onClick={() => otype === "dinein" ? setTablePick(true) : setOtype("dinein")} className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm min-w-0 ${table ? _.chipOn : _.panel2}`}>
            <span>{otype === "delivery" ? "🛵" : "🍽️"}</span>
            <span className="flex-1 text-left min-w-0"><span className="font-medium block truncate">{otype === "delivery" ? "Delivery" : table ? "Table " + table : "Table"}</span><span className={`block text-xs ${_.sub}`}>{otype === "delivery" ? "" : "optional"}</span></span>
          </button>
        </div>

        {cart.length === 0 ? (
          <div className={`flex-1 grid place-items-center ${_.sub}`} style={{ minHeight: 180 }}><div className="text-sm text-center">🛒<br />Scan or tap a product to start</div></div>
        ) : (
          <>
            {/* Cart lines */}
            <div className="flex-1 overflow-y-auto -mx-1 px-1" style={{ minHeight: 80 }}>
              {cart.map((l, idx) => { const p = prodById(l.pid); if (!p) return null; return (
                <div key={l.key} className={`py-2.5 border-b border-dashed ${_.border}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{p.emoji || "🍽️"}</span>
                    <span className="flex-1 text-sm font-medium leading-tight">{p.name}</span>
                    <span className="num text-sm">{cardPrice(lineTotal(l))}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 pl-7">
                    <div className={`flex items-center rounded-lg ${_.panel2}`}>
                      <button onClick={() => requestDec(idx)} className="px-2 py-1">−</button>
                      <span className="w-7 text-center text-sm num">{l.qty}</span>
                      <button onClick={() => bump(idx, 1)} className="px-2 py-1">+</button>
                    </div>
                    <span className={`text-xs ${_.faint}`}>@ {cardPrice(lineUnit(l))}/{p.unit || "pcs"}</span>
                    <button onClick={() => setDiscReq({ scope: "line", idx })} className={`flex items-center gap-0.5 text-xs px-2 py-1 rounded-lg ${l.discPct ? "bg-amber-500/15 text-amber-500" : _.chip}`}>{l.discPct ? "-" + l.discPct + "%" : "% disc"}</button>
                    <button onClick={() => requestRemove(idx)} className={`ml-auto p-1 ${_.faint}`} style={{ lineHeight: 1 }} title="Remove item">✕</button>
                  </div>
                </div>
              ); })}
              {/* Upsell */}
              {suggestion && lastProd && (
                <button onClick={() => addLine(suggestion)} className={`mt-3 w-full flex items-center gap-2 text-xs rounded-xl px-3 py-2.5 border border-dashed ${_.accentBd} ${_.accent}`}>
                  <span>✨</span> Often added with {lastProd.name}:
                  <span className="font-medium">{suggestion.name}</span>
                  <span className="ml-auto num">+{cardPrice(suggestion.price)}</span>
                </button>
              )}
            </div>

            {/* Totals */}
            <div className={`pt-3 mt-2 border-t ${_.border}`}>
              <div className={`flex justify-between text-xs ${_.sub}`}><span>Subtotal</span><span className="num">{cardPrice(subtotal)}</span></div>
              <button onClick={() => setDiscReq({ scope: "bill" })} className={`flex items-center gap-1.5 rounded-xl px-3 py-1 text-xs mt-1 ${billDiscPct > 0 ? "bg-amber-500/15 text-amber-500" : _.chip}`}>{billDiscPct > 0 ? "Bill disc " + billDiscPct + "%" : "+ Bill disc"}</button>
              {billDiscPct > 0 && <div className={`flex justify-between text-xs mt-1 ${_.sub}`}><span>Discount {billDiscPct}%</span><span className="num text-amber-500">-{cardPrice(billDisc)}</span></div>}
              <div className={`flex justify-between text-xs mt-1 ${_.sub}`}><span>GST {gstBp / 100}%</span><span className="num">{cardPrice(gst)}</span></div>
              {svcBp > 0 && <div className={`flex justify-between text-xs mt-1 ${_.sub}`}><span>Svc charge {svcBp / 100}%</span><span className="num">{cardPrice(svc)}</span></div>}
              <div className="flex justify-between items-baseline mt-2">
                <span className="text-sm font-semibold">Total</span>
                <span className="ksh-display num text-xl font-bold">{money(total)}</span>
              </div>
              {otype !== "takeaway" && cart.length > 0 && (
                <button onClick={park} className={`w-full flex items-center justify-center gap-2 rounded-xl py-2.5 mt-3 text-sm font-medium border border-dashed ${_.accentBd} ${_.accent}`}>🔥 Send to kitchen (KOT) — settle from Orders</button>
              )}
              <div className="flex gap-2 mt-3">
                <button onClick={park} className={`flex items-center justify-center gap-1.5 rounded-xl px-3 py-3 text-sm ${_.btn}`}>⏸ Park</button>
                <button title="Split bill" className={`flex items-center justify-center rounded-xl px-3 py-3 ${_.btn}`}>✂️</button>
                <button onClick={clearBill} title="Clear bill" className={`flex items-center justify-center rounded-xl px-3 py-3 ${_.btn}`}>🗑</button>
                <button onClick={charge} className={`flex-1 rounded-xl py-4 font-semibold text-sm ${_.primary} active:scale-95 transition`} style={{ minHeight: 56 }}>Charge {money(total)}</button>
              </div>
            </div>
          </>
        )}
      </div>

      {voidReq && <ReasonModal _={_} name={voidReq.name} onConfirm={confirmVoid} onClose={() => setVoidReq(null)} />}
      {discReq && <DiscountModal _={_} scope={discReq.scope} current={discReq.scope === "bill" ? billDiscPct : (cart[discReq.idx!]?.discPct || 0)} user={user} onApply={applyDisc} onClose={() => setDiscReq(null)} />}
      {custPick && <CustomerModal _={_} customers={st.byKind("customers").map((e) => e.data)} onPick={(c) => { setCust(c); setCustPick(false); }} onClose={() => setCustPick(false)} />}
      {tablePick && <TableModal _={_} tables={(st.byKind("tables").map((e: any) => e.data?.name).filter(Boolean).length ? st.byKind("tables").map((e: any) => e.data.name) : Array.from({ length: 12 }, (_x, i) => "T" + (i + 1)))} onPick={(t) => { setTable(t); setOtype("dinein"); setTablePick(false); }} onClose={() => setTablePick(false)} />}
    </div>
  );
}

/* ── Item-modification reason (Staging) — replaces production's manager
   password on removing/reducing a fired line. ─────────────────────────────── */
function ReasonModal({ _, name, onConfirm, onClose }: { _: any; name: string; onConfirm: (r: string) => void; onClose: () => void }) {
  const [sel, setSel] = useState(VOID_REASONS[0]);
  const [other, setOther] = useState("");
  return (
    <Overlay onClose={onClose}>
      <div className={`w-[min(400px,94vw)] rounded-2xl p-5 ${_.modal}`} onClick={(e) => e.stopPropagation()}>
        <div className="text-lg font-bold mb-1">Remove item</div>
        <div className={`text-sm mb-4 ${_.sub}`}><b>{name}</b> — pick a reason for the change (recorded on the order).</div>
        <div className="flex flex-col gap-2">
          {VOID_REASONS.map((r) => (
            <button key={r} onClick={() => setSel(r)} className={`text-left px-3 py-2.5 rounded-xl text-sm font-medium ${sel === r ? _.chipOn : _.btn}`}>{r}</button>
          ))}
        </div>
        {sel === "Other" && <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Reason…" className={`w-full mt-2 rounded-xl px-3 py-2.5 text-sm ${_.input}`} />}
        <button onClick={() => onConfirm(sel === "Other" ? (other.trim() || "Other") : sel)} className={`w-full mt-4 rounded-xl py-3 font-semibold text-sm text-white`} style={{ background: "#C13A26" }}>Remove item</button>
      </div>
    </Overlay>
  );
}

/* ── Discount (Staging) — preset % gated on manager password approval, logged
   as discAuth on the line/bill. ───────────────────────────────────────────── */
function DiscountModal({ _, scope, current, user, onApply, onClose }: { _: any; scope: "bill" | "line"; current: number; user: any; onApply: (pct: number, auth: any) => void; onClose: () => void }) {
  const [pct, setPct] = useState(current || 0);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    if (pct === 0) { onApply(0, null); return; }         // clearing needs no approval
    if (!pw) { setErr("Manager password required"); return; }
    setBusy(true); setErr("");
    try { await elevate(pw); onApply(pct, { pct, method: "password", at: Date.now(), by: user?.name || "" }); }
    catch (e: any) { setErr(e.message || "Wrong password"); setBusy(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <div className={`w-[min(400px,94vw)] rounded-2xl p-5 ${_.modal}`} onClick={(e) => e.stopPropagation()}>
        <div className="text-lg font-bold mb-1">{scope === "bill" ? "Bill discount" : "Line discount"}</div>
        <div className={`text-sm mb-4 ${_.sub}`}>Staff discounts need manager approval — the approval is logged on the sale.</div>
        <div className="flex gap-2 flex-wrap mb-4">
          {DISC_PRESETS.map((d) => (
            <button key={d} onClick={() => setPct(d)} className={`px-3 py-2 rounded-full text-sm font-semibold ${pct === d ? _.primary : _.chip}`}>{d === 0 ? "None" : d + "%"}</button>
          ))}
        </div>
        {pct > 0 && <>
          <label className={`text-xs font-semibold ${_.sub}`}>STORE / MANAGER PASSWORD</label>
          <input autoFocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && pw && go()} className={`w-full mt-1 rounded-xl px-3 py-2.5 text-sm ${_.input}`} />
        </>}
        {err && <div className="text-xs mt-2 font-semibold" style={{ color: "#C13A26" }}>{err}</div>}
        <button disabled={busy} onClick={go} className={`w-full mt-4 rounded-xl py-3 font-semibold text-sm ${_.primary}`} style={{ opacity: busy ? .6 : 1 }}>{busy ? "Verifying…" : pct === 0 ? "Remove discount" : "Approve " + pct + "% discount"}</button>
      </div>
    </Overlay>
  );
}

function CustomerModal({ _, customers, onPick, onClose }: { _: any; customers: any[]; onPick: (c: any) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = customers.filter((c) => !q || (c.name || "").toLowerCase().includes(q.toLowerCase()) || (c.phone || "").includes(q));
  return (
    <Overlay onClose={onClose}>
      <div className={`w-[min(420px,94vw)] rounded-2xl p-5 ${_.modal}`} onClick={(e) => e.stopPropagation()}>
        <div className="text-lg font-bold mb-3">Add customer</div>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone…" className={`w-full rounded-xl px-3 py-2.5 text-sm mb-3 ${_.input}`} />
        <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
          {list.map((c) => (
            <button key={c.id} onClick={() => onPick(c)} className={`flex items-center gap-2 text-left px-3 py-2.5 rounded-xl text-sm ${_.btn}`}>
              <span className="flex-1"><b>{c.name || "Walk-in"}</b>{c.phone ? " · " + c.phone : ""}</span>
              {(c.balance || 0) > 0 && <span className="text-xs num text-amber-500">{money(c.balance)}</span>}
            </button>
          ))}
          {!list.length && <div className={`text-sm text-center py-6 ${_.sub}`}>No customers match.</div>}
        </div>
      </div>
    </Overlay>
  );
}

function TableModal({ _, tables, onPick, onClose }: { _: any; tables: string[]; onPick: (t: string) => void; onClose: () => void }) {
  return (
    <Overlay onClose={onClose}>
      <div className={`w-[min(420px,94vw)] rounded-2xl p-5 ${_.modal}`} onClick={(e) => e.stopPropagation()}>
        <div className="text-lg font-bold mb-3">Choose a table</div>
        <div className="grid grid-cols-4 gap-2">
          {tables.map((t) => (
            <button key={t} onClick={() => onPick(t)} className={`py-4 rounded-xl text-sm font-semibold ${_.btn}`}>{t}</button>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

function Overlay({ children, onClose }: { children: any; onClose: () => void }) {
  return <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,18,15,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>{children}</div>;
}

function TabStub({ _, label }: { _: any; label: string }) {
  return <div className={`rounded-2xl grid place-items-center ${_.panel}`} style={{ minHeight: 300 }}>
    <div className={`text-sm ${_.sub}`}>{label} — rebuilt in a later step</div>
  </div>;
}
