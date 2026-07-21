import { useEffect, useMemo, useRef, useState } from "react";
import { store, useStore } from "./store";
import { uid } from "./api";
import { resolveTheme } from "./theme";

/* Cart line — matches the Step-1 model (pid + qty + mods; per-line discount
   and reason live on the line so the canvas + audit trail read them). */
type Mod = { name: string; price: number };
type Line = { key: string; pid: string; qty: number; mods: Mod[]; discPct?: number };

/* Category emoji, verbatim from production's window.__ksCatEmoji. */
const CAT_EMOJI: Record<string, string> = { All: "🍽️", "Main Dishes": "🍛", Coffee: "☕", Drinks: "🥤", Bakery: "🥐", Grocery: "🛒", Hedhikaa: "🍢", More: "⋯" };
const catLabel = (c: string) => (CAT_EMOJI[c] ? CAT_EMOJI[c] + " " : "") + c;
const cardPrice = (laari: number) => (Math.round(Number(laari) || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  ["orders", "Orders", '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h3"/>'],
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
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(id); }, []);

  const shifts = st.byKind("shifts").map((e) => e.data);
  const openShift = shifts.find((s) => !s.closedAt) || null;
  const parked = st.byKind("parked").map((e) => e.data);
  const orders = st.byKind("orders").map((e) => e.data).filter((o: any) => !["done", "wasted"].includes(String(o.status || "new").toLowerCase()));

  /* Menu + cart state (the canvas mechanics build on this next step). */
  const products = st.byKind("products").map((e) => e.data).filter((p: any) => p && !p.archived);
  const [cart, setCart] = useState<Line[]>([]);
  const addLine = (p: any, mods: Mod[] = []) => {
    const key = p.id + "|" + mods.map((m) => m.name).sort().join(",");
    setCart((c) => { const i = c.findIndex((l) => l.key === key); if (i >= 0) { const n = c.slice(); n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; } return c.concat([{ key, pid: p.id, qty: 1, mods }]); });
  };
  const qtyOf = (pid: string) => cart.filter((l) => l.pid === pid).reduce((a, l) => a + l.qty, 0);
  const prodById = (pid: string) => products.find((p: any) => p.id === pid);
  const count = cart.reduce((a, l) => a + l.qty, 0);
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
          <SellScreen _={_} parked={parked} openShift={openShift} products={products} settings={settings}
            cart={cart} addLine={addLine} qtyOf={qtyOf} prodById={prodById} count={count} />
        ) : <TabStub _={_} label={NAV.find((n) => n[0] === nav)?.[1] || nav} />}
      </div>
    </div>
  );
}

/* Three-pane Sell frame — production's register layout. The menu grid + search
   are production-faithful here; the order-canvas mechanics (per-line disc,
   upsell, bill disc, svc charge, park/cut/void) land in the next step. */
function SellScreen({ _, parked, openShift, products, settings, cart, addLine, qtyOf, prodById, count }:
  { _: any; parked: any[]; openShift: any; products: any[]; settings: any; cart: Line[]; addLine: (p: any) => void; qtyOf: (id: string) => number; prodById: (id: string) => any; count: number }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const searchRef = useRef<HTMLInputElement>(null);
  const groups: { name: string; subs: string[] }[] = settings.catGroups || [];
  const cats = ["All", ...groups.map((g) => g.name)];
  const subInGroup = (cat: string) => group === "All" || (groups.find((g) => g.name === group)?.subs || []).includes(cat);
  const codeOf = (p: any) => String(p.barcode || p.sku || p.code || "").toLowerCase();
  const q = query.trim().toLowerCase();
  const items = products.filter((p) => subInGroup(p.cat) && (!q || (p.name || "").toLowerCase().includes(q) || (codeOf(p) && codeOf(p).includes(q))));
  const isOut = (p: any) => (p.recipeAvail != null && Number(p.recipeAvail) <= 0) || (p.stock != null && Number(p.stock) <= 0) || !!p.soldOut;
  const enterAdd = () => {
    if (!q) return;
    const exact = products.find((p) => codeOf(p) === q || String(p.id).toLowerCase() === q);
    const hit = exact || (items.length === 1 ? items[0] : null);
    if (hit && !isOut(hit)) { addLine(hit); setQuery(""); }
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
        <button className={`w-full mt-2 py-2 rounded-xl text-sm ${_.btn}`} style={{ borderStyle: "dashed" }}>+ New bill</button>
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

      {/* Order canvas — cart preview (full mechanics next step) */}
      <div className={`rounded-2xl p-4 flex flex-col ${_.panel}`} style={{ alignSelf: "start", minHeight: 420 }}>
        <div className="flex items-center gap-2 mb-3">
          <span className={`px-3 py-1 rounded-full text-sm font-semibold ${_.primary}`}>#1</span>
          <button className={`w-7 h-7 rounded-full text-sm ${_.btn}`}>+</button>
          <span className={`ml-auto text-xs ${_.sub}`}>{count} item{count === 1 ? "" : "s"}</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {["Dine-in", "Takeaway", "Delivery"].map((t, i) => (
            <button key={t} className={`py-2 rounded-lg text-xs font-semibold ${i === 1 ? _.primary : _.btn}`}>{t}</button>
          ))}
        </div>
        {cart.length === 0 ? (
          <div className={`flex-1 grid place-items-center ${_.sub}`}><div className="text-sm text-center">Scan or tap a product to start</div></div>
        ) : (
          <div className="flex-1 overflow-y-auto flex flex-col gap-2">
            {cart.map((l) => { const p = prodById(l.pid); if (!p) return null; return (
              <div key={l.key} className={`flex items-center gap-2 rounded-xl px-3 py-2 ${_.panel2 || _.chip}`}>
                <span className="text-xl">{p.emoji || "🍽️"}</span>
                <div className="flex-1 min-w-0"><div className="text-sm font-medium truncate">{p.name}</div><div className={`text-xs num ${_.sub}`}>@ {cardPrice(p.price)}/{p.unit || "pcs"}</div></div>
                <span className="num text-sm font-semibold">{l.qty}×</span>
                <span className="num text-sm font-semibold">{cardPrice((Number(p.price) || 0) * l.qty)}</span>
              </div>
            ); })}
            <div className={`mt-2 pt-2 border-t text-xs text-center ${_.sub}`} style={{ borderColor: "var(--k-border)" }}>Canvas mechanics — per-line disc, upsell, bill disc, svc charge — next step (3b)</div>
          </div>
        )}
      </div>
    </div>
  );
}

function TabStub({ _, label }: { _: any; label: string }) {
  return <div className={`rounded-2xl grid place-items-center ${_.panel}`} style={{ minHeight: 300 }}>
    <div className={`text-sm ${_.sub}`}>{label} — rebuilt in a later step</div>
  </div>;
}
