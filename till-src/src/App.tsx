import { useEffect, useMemo, useState } from "react";
import { store, useStore } from "./store";
import { hashPin, uid } from "./api";
import { Dashboard, Reports, Orders } from "./screens";
import { GuestPortal } from "./guest";

/* A printed table QR points at "/?s=slug&t=table[&c=cust]" — same bundle, guest
   view. If those params are present we render the public guest portal instead
   of the PIN-gated till. */
function guestParams() {
  const q = new URLSearchParams(location.search);
  const slug = q.get("s") || (location.pathname.match(/^\/p\/([^/]+)/)?.[1] || "");
  if (!slug) return null;
  return { slug, table: q.get("t") || "", custId: q.get("c") || "", storeId: q.get("st") || q.get("store") || q.get("storeId") || "" };
}

/* Reskin-only rebuild of OUR existing till — same features + real sync, in the
   prototype look. No prototype-only additions. Money is laari (÷100 to show);
   GST is added on top of the subtotal (gstBp from settings), matching the
   existing till and the server's money audit. */

const money = (laari: number) => "MVR " + (Math.round(laari) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* Viewport width for responsive layout (inline styles can't use media queries).
   phone < 760, tablet 760–1100, desktop ≥ 1100. */
function useVW() {
  const [vw, setVw] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1280));
  useEffect(() => { const on = () => setVw(window.innerWidth); window.addEventListener("resize", on); return () => window.removeEventListener("resize", on); }, []);
  return vw;
}

const TINTS: [string, string][] = [
  ["var(--ambersoft)", "var(--amber)"], ["var(--greensoft)", "var(--green)"], ["var(--coralsoft)", "var(--coral)"],
  ["var(--bluesoft, rgba(47,107,224,.14))", "var(--blue)"], ["var(--redsoft)", "var(--red)"], ["var(--sur2)", "var(--ink2)"],
];
const tintFor = (cat: string) => { let h = 0; for (const c of cat || "") h = (h * 31 + c.charCodeAt(0)) >>> 0; return TINTS[h % TINTS.length]; };

/* Front-of-house rail — the full KashikeyoPOS prototype module set (top pill
   nav). `to` deep-links a module that lives in the back-office cockpit (/back);
   `soon` marks screens still being built (Placeholder). Register/Kitchen/
   Dashboard/Analytics map onto our existing screens. */
const NAV = [
  { id: "sell", label: "Register", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h3"/>' },
  { id: "floor", label: "Floor", icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { id: "kitchen", label: "Kitchen", icon: '<path d="M6 3v7a3 3 0 0 0 6 0V3M9 3v18M18 3c-1.5 1-2 3-2 6s.5 4 2 5v7"/>' },
  { id: "qr", label: "QR Orders", icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v7M17 20h4"/>' },
  { id: "outlets", label: "Outlets", icon: '<path d="M3 21V9l9-6 9 6v12M9 21v-6h6v6"/>' },
  { id: "delivery", label: "Delivery", icon: '<path d="M3 7h11v8H3zM14 10h4l3 3v2h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>' },
  { id: "dashboard", label: "Dashboard", icon: '<path d="M3 13h8V3H3zM13 21h8v-6h-8zM13 11h8V3h-8zM3 21h8v-6H3z"/>' },
  { id: "analytics", label: "Analytics", icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
  { id: "inventory", label: "Inventory", to: "/back", icon: '<path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10"/>' },
  { id: "expenses", label: "Expenses", to: "/back", icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>' },
  { id: "tabs", label: "Tabs", icon: '<path d="M3 6a2 2 0 0 1 2-2h9l4 4v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 12h6M8 16h4"/>' },
  { id: "dayend", label: "Day End", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  { id: "staff", label: "Staff", to: "/back", icon: '<circle cx="9" cy="8" r="3"/><path d="M2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0-1-5.8M22 21a6 6 0 0 0-6-6"/>' },
  { id: "setup", label: "Setup", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.6 1.6 0 0 0 .3 1.8 2 2 0 1 1-2.8 2.8 1.6 1.6 0 0 0-2.7 1.1 2 2 0 0 1-4 0 1.6 1.6 0 0 0-2.7-1.1 2 2 0 1 1-2.8-2.8A1.6 1.6 0 0 0 4.6 13a2 2 0 0 1 0-4 1.6 1.6 0 0 0 1.1-2.7 2 2 0 1 1 2.8-2.8A1.6 1.6 0 0 0 11 4a2 2 0 0 1 2 0 1.6 1.6 0 0 0 2.7 1.1 2 2 0 1 1 2.8 2.8A1.6 1.6 0 0 0 19.4 11z"/>' },
] as { id: string; label: string; icon: string; to?: string; soon?: boolean }[];
const METHODS = ["Cash", "Card", "BML Gateway", "Transfer", "QR"] as const;

export function App() {
  const guest = useMemo(guestParams, []);
  if (guest) return <GuestPortal {...guest} />;
  return <Till />;
}

function Till() {
  const st = useStore();
  const [user, setUserState] = useState<any>(null);
  const [now, setNow] = useState(() => new Date());
  /* Keep the signed-in operator across reloads within the tab (PIN is a fast
     shift selector, not a security boundary — the app session is the cookie). */
  const setUser = (u: any) => { setUserState(u); try { if (u) sessionStorage.setItem("ksh-op", JSON.stringify(u)); else sessionStorage.removeItem("ksh-op"); } catch { /* private mode */ } };
  useEffect(() => { try { const u = JSON.parse(sessionStorage.getItem("ksh-op") || "null"); if (u) setUserState(u); } catch { /* ignore */ } }, []);

  useEffect(() => { store.start(); }, []);
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(id); }, []);

  if (!st.ready) return <Splash />;
  if (!user) return <PinGate onSignIn={setUser} />;
  return <Shell user={user} now={now} onSignOut={() => setUser(null)} />;
}

function Splash() {
  return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink2)" }}>
    <div style={{ textAlign: "center" }}><div style={{ ...C.kchip, margin: "0 auto 12px" }}>K</div>Loading…</div>
  </div>;
}

/* ── PIN gate (our staff/PIN model, reskinned) ─────────────────────────────── */
function PinGate({ onSignIn }: { onSignIn: (u: any) => void }) {
  const st = useStore();
  const users = st.byKind("users").map((e) => e.data);
  const [sel, setSel] = useState<any>(users.length === 1 ? users[0] : null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  const submit = (p: string) => {
    if (!sel) return;
    if (hashPin(p) === String(sel.pin)) onSignIn(sel);
    else { setErr(true); setPin(""); setTimeout(() => setErr(false), 500); }
  };
  const press = (d: string) => { const p = (pin + d).slice(0, 6); setPin(p); if (p.length === 4 && sel) submit(p); };
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ ...C.kchip, width: 52, height: 52, fontSize: 26, borderRadius: 16, margin: "0 auto 12px" }}>K</div>
        <div style={{ fontWeight: 800, fontSize: 20 }}>KashikeyoPOS</div>
        <div style={{ color: "var(--ink2)", fontSize: 13, marginTop: 3 }}>Sign in with your PIN</div>
      </div>
      {!sel ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 320 }}>
          {users.map((u) => (
            <button key={u.id} onClick={() => setSel(u)} style={{ ...C.card, display: "flex", alignItems: "center", gap: 12, padding: 14, textAlign: "left" }}>
              <span style={{ ...C.avatar, background: "var(--green)" }}>{(u.name || "?")[0].toUpperCase()}</span>
              <b style={{ flex: 1, fontWeight: 700 }}>{u.name}</b><small style={{ color: "var(--ink3)" }}>{u.role}</small>
            </button>
          ))}
          {users.length === 0 && <button onClick={() => { store.cursor = 0; store.pullAll(); }} style={{ ...C.card, padding: "12px 16px", color: "var(--ink2)", fontSize: 13, fontWeight: 600 }}>No staff synced yet — tap to retry sync</button>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, animation: err ? "shake .4s" : undefined }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ ...C.avatar, background: "var(--green)" }}>{(sel.name || "?")[0].toUpperCase()}</span>
            <b>{sel.name}</b>{users.length > 1 && <button onClick={() => { setSel(null); setPin(""); }} style={{ color: "var(--coral)", fontSize: 12, fontWeight: 700 }}>change</button>}
          </div>
          <div style={{ display: "flex", gap: 12 }}>{[0, 1, 2, 3].map((i) => (
            <span key={i} style={{ width: 14, height: 14, borderRadius: 99, background: i < pin.length ? "var(--coral)" : "var(--sur2)", border: "1px solid var(--line)" }} />
          ))}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,64px)", gap: 10 }}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((d, i) => d === "" ? <span key={i} /> : (
              <button key={i} onClick={() => d === "⌫" ? setPin(pin.slice(0, -1)) : press(d)} style={C.key}>{d}</button>
            ))}
          </div>
          {err && <div style={{ color: "var(--red)", fontSize: 13, fontWeight: 700 }}>Wrong PIN</div>}
        </div>
      )}
      <style>{"@keyframes shake{10%,90%{transform:translateX(-2px)}30%,70%{transform:translateX(5px)}50%{transform:translateX(-5px)}}"}</style>
    </div>
  );
}

/* ── main shell + register ─────────────────────────────────────────────────── */
type Mod = { name: string; price: number };
type Line = { key: string; pid: string; qty: number; mods: Mod[] };
const hasMods = (p: any) => !!((p.addons && p.addons.length) || (p.spiceLevels && p.spiceLevels.length));

function Shell({ user, now, onSignOut }: { user: any; now: Date; onSignOut: () => void }) {
  const st = useStore();
  const settings = st.byKind("settings")[0]?.data || {};
  const gstBp = Number(settings.gstBp ?? 800);
  const currency = settings.currency || "MVR";
  const groups: { name: string; subs: string[] }[] = settings.catGroups || [];

  const [nav, setNav] = useState("sell");
  const [group, setGroup] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [otype, setOtype] = useState<"dinein" | "takeaway" | "delivery">("takeaway");
  const [cart, setCart] = useState<Line[]>([]);
  const [disc, setDisc] = useState(0);
  const [discPct, setDiscPct] = useState(0);
  const [pay, setPay] = useState(false);
  const [shiftModal, setShiftModal] = useState(false);
  const [zModal, setZModal] = useState(false);
  const [receipt, setReceipt] = useState<any>(null);
  const [cust, setCust] = useState<any>(null);
  const [custPick, setCustPick] = useState(false);
  const [table, setTable] = useState("");
  const [tablePick, setTablePick] = useState(false);
  const [zone, setZone] = useState<any>(null);
  const [zonePick, setZonePick] = useState(false);
  const [deliveryNote, setDeliveryNote] = useState("");
  /* Order-type drives which fields show: Dine-In → customer + table;
     Takeaway → customer only; Delivery → customer + delivery location. */
  const pickOtype = (k: "dinein" | "takeaway" | "delivery") => { setOtype(k); if (k !== "dinein") setTable(""); if (k !== "delivery") setZone(null); };
  const [cartOpen, setCartOpen] = useState(false);
  const [lang, setLang] = useState<"en" | "dv">(() => (typeof document !== "undefined" && document.documentElement.dir === "rtl") ? "dv" : "en");
  const vw = useVW();
  const mob = vw < 760;
  const tab = vw >= 760 && vw < 1100;
  const sector: "general" | "tourism" = gstBp >= 1600 ? "tourism" : "general";
  const toggleLang = () => { const n = lang === "en" ? "dv" : "en"; setLang(n); if (typeof document !== "undefined") document.documentElement.dir = n === "dv" ? "rtl" : "ltr"; };
  const toggleSector = () => {
    const cur = st.byKind("settings")[0]; const data = { ...(cur?.data || {}), gstBp: sector === "tourism" ? 800 : 1700 };
    st.commit([{ kind: "settings", id: cur?.id || "settings", data }]);
  };
  const parked = st.byKind("parked").map((e) => e.data).sort((a, b) => (a.t || 0) - (b.t || 0));
  const orders = st.byKind("orders").map((e) => e.data);
  const orderNo = "#" + String(st.byKind("sales").length + parked.length + 1).padStart(4, "0");

  const shifts = st.byKind("shifts").map((e) => e.data);
  const openShift = shifts.find((s) => !s.closedAt) || null;

  const products = st.byKind("products").map((e) => e.data).filter((p) => p && !p.archived);
  const bestIds = useBestSellers();
  const clock = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + ", " + now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const subInGroup = (cat: string) => group === "all" || (groups.find((g) => g.name === group)?.subs || []).includes(cat);
  const items = products.filter((p) => subInGroup(p.cat) && (!query || (p.name || "").toLowerCase().includes(query.toLowerCase())));

  const [modProd, setModProd] = useState<any>(null);
  const prodById = (pid: string) => products.find((p) => p.id === pid);
  const lineUnit = (l: Line) => (prodById(l.pid)?.price || 0) + (l.mods || []).reduce((a, m) => a + (m.price || 0), 0);

  const addLine = (p: any, mods: Mod[]) => {
    const key = p.id + "|" + mods.map((m) => m.name).sort().join(",");
    setCart((c) => { const i = c.findIndex((l) => l.key === key); if (i >= 0) { const n = c.slice(); n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; } return c.concat([{ key, pid: p.id, qty: 1, mods }]); });
  };
  const tapProduct = (p: any) => { if (hasMods(p)) setModProd(p); else addLine(p, []); };
  const bump = (key: string, d: number) => setCart((c) => {
    const i = c.findIndex((l) => l.key === key); if (i < 0) return c;
    const n = c.slice(); const q = n[i].qty + d;
    if (q <= 0) n.splice(i, 1); else n[i] = { ...n[i], qty: q };
    return n;
  });
  const dropOne = (pid: string) => setCart((c) => { for (let i = c.length - 1; i >= 0; i--) if (c[i].pid === pid) { const n = c.slice(); if (n[i].qty <= 1) n.splice(i, 1); else n[i] = { ...n[i], qty: n[i].qty - 1 }; return n; } return c; });
  const qtyOf = (pid: string) => cart.filter((l) => l.pid === pid).reduce((a, l) => a + l.qty, 0);

  const svcBp = Number(settings.svcChargeBp ?? 0);
  const totals = useMemo(() => {
    const subtotal = cart.reduce((a, l) => a + lineUnit(l) * l.qty, 0);
    const d = Math.min(Math.max(0, disc), subtotal);
    const excl = subtotal - d;
    const svc = otype === "dinein" ? Math.round(excl * svcBp / 10000) : 0;   // service charge is dine-in only (prototype)
    const gst = Math.round((excl + svc) * gstBp / 10000);
    const fee = otype === "delivery" && zone ? Number(zone.fee || 0) : 0;    // delivery fee (pass-through, no GST)
    return { subtotal, disc: d, excl, svc, gst, fee, total: excl + svc + gst + fee };
  }, [cart, products, gstBp, svcBp, otype, disc, zone]);
  const count = cart.reduce((a, l) => a + l.qty, 0);

  const openShiftNow = (float: number) => {
    const s = { id: uid(), openedAt: Date.now(), openingFloat: float, userName: user.name, storeId: settings.storeId || "main", closedAt: null };
    store.commit([{ kind: "shifts", id: s.id, data: s }]); setShiftModal(false);
  };
  const closeShiftNow = (counted: number, expected: number) => {
    if (!openShift) return;
    store.commit([{ kind: "shifts", id: openShift.id, data: { ...openShift, closedAt: Date.now(), countedCash: counted, expectedCash: expected } }]);
    setZModal(false);
  };

  const onCharged = (payments: { method: string; amount: number }[], change: number) => {
    const no = nextInvoiceNo(st.byKind("sales").map((e) => e.data));
    const sale = {
      id: uid(), no, t: Date.now(), type: "sale", storeId: settings.storeId || "main", shiftId: openShift?.id || null,
      userName: user.name, customerId: cust?.id || null, customerName: cust?.name || null, otype, table: table || null,
      zone: otype === "delivery" && zone ? zone.name : null, fee: totals.fee, deliveryNote: otype === "delivery" ? deliveryNote.trim() : "",
      lines: cart.map((l) => { const p = prodById(l.pid); return { pid: l.pid, qty: l.qty, name: p?.name, price: lineUnit(l), basePrice: p?.price, cost: p?.cost || 0, unit: p?.unit, emoji: p?.emoji, addons: l.mods || [], discPct: 0, taxable: p?.taxable !== false }; }),
      subtotal: totals.subtotal, gst: totals.gst, total: totals.total, billDisc: totals.disc, billDiscPct: discPct, svcCharge: totals.svc,
      payments, change, refunded: false,
    };
    store.commit([{ kind: "sales", id: sale.id, data: sale }]);
    setReceipt({ sale, change, settings });
    resetBill(); setPay(false);
  };

  const resetBill = () => { setCart([]); setDisc(0); setDiscPct(0); setCust(null); setTable(""); setZone(null); setDeliveryNote(""); };

  const park = () => {
    if (!cart.length) return;
    const bill = { id: uid(), t: Date.now(), otype, table: table || null, lines: cart, disc, discPct, customerId: cust?.id || null, custName: cust?.name || null, userName: user.name, storeId: settings.storeId || "main" };
    store.commit([{ kind: "parked", id: bill.id, data: bill }]);
    resetBill();
  };
  /* Send to KOT — fire the current cart to the kitchen as an order ticket and
     keep it as an open bill (linked by orderId) so the rail can surface its live
     kitchen status, then clear the register for the next ticket. */
  const sendKOT = () => {
    if (!cart.length) return;
    const oid = uid();
    const order = {
      id: oid, no: orderNo, t: Date.now(), createdAt: Date.now(), source: "pos", status: "new",
      otype, table: table || null, customerName: cust?.name || null, userName: user.name, storeId: settings.storeId || "main",
      lines: cart.map((l) => { const p = prodById(l.pid); return { pid: l.pid, qty: l.qty, name: p?.name, emoji: p?.emoji, mods: l.mods || [] }; }),
    };
    const bill = { id: uid(), t: Date.now(), otype, table: table || null, lines: cart, disc, discPct, customerId: cust?.id || null, custName: cust?.name || null, userName: user.name, storeId: settings.storeId || "main", orderId: oid, no: orderNo };
    store.commit([{ kind: "orders", id: oid, data: order }, { kind: "parked", id: bill.id, data: bill }]);
    resetBill();
  };
  const resume = (bill: any) => {
    /* Normalise lines defensively — a bill parked by an earlier build may lack
       key/mods, which would crash lineUnit / the cart render on resume. */
    const norm: Line[] = (bill.lines || []).map((l: any) => {
      const mods: Mod[] = Array.isArray(l.mods) ? l.mods : (Array.isArray(l.addons) ? l.addons : []);
      return { pid: l.pid, qty: Number(l.qty) || 1, mods, key: l.key || (l.pid + "|" + mods.map((m) => m.name).sort().join(",")) };
    });
    setCart(norm); setDisc(bill.disc || 0); setDiscPct(bill.discPct || 0); setOtype(bill.otype || "takeaway"); setTable(bill.table || "");
    setCust(bill.customerId ? { id: bill.customerId, name: bill.custName } : null);
    store.del([{ kind: "parked", id: bill.id }]);
  };

  /* Left rail — the open bills (held + KOT-fired). The card in progress shows
     first (highlighted); tapping a parked bill resumes it into the register. A
     linked kitchen order lends its live status (In kitchen / Ready). */
  const kotStatusOf = (b: any): [string, string] => {
    if (b.orderId) {
      const o = orders.find((x) => x.id === b.orderId);
      const s = (o?.status || "new").toLowerCase();
      if (s === "ready") return ["Ready", "var(--green)"];
      if (s === "delivered" || s === "done") return ["Served", "var(--ink3)"];
      return ["In kitchen", "var(--amber)"];
    }
    return ["Open", "var(--ink3)"];
  };
  const otypeLabelOf = (t: string) => t === "dinein" ? "Dine-In" : t === "delivery" ? "Delivery" : "Takeaway";
  const billsRailInner = (
    <div style={C.railWrap} className="glass">
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 14px 8px" }}>
        <div style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>🧾 Open Bills</div>
        <span style={{ fontSize: 11, fontWeight: 800, background: "var(--sur2)", color: "var(--ink2)", borderRadius: 999, padding: "2px 9px" }} className="num">{parked.length + (count ? 1 : 0)}</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "2px 10px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
        {count > 0 && (
          <div style={{ ...C.railCard, borderColor: "var(--coral)", background: "var(--coralsoft)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <b style={{ fontSize: 13, flex: 1 }}>{otypeLabelOf(otype)} · <span className="num">{orderNo}</span></b>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink2)", marginTop: 2 }}>{cust?.name || "Walk-in"}{otype === "dinein" && table ? " · T" + table : ""}</div>
            <div style={{ marginTop: 7 }}><span style={{ ...C.stag, color: "var(--coral)", background: "var(--sur)" }}>● In progress</span></div>
          </div>
        )}
        {parked.slice().reverse().map((b) => {
          const [label, col] = kotStatusOf(b);
          const items = (b.lines || []).reduce((a: number, l: any) => a + (l.qty || 0), 0);
          const mins = Math.max(0, Math.floor((Date.now() - (b.t || Date.now())) / 60000));
          return (
            <button key={b.id} onClick={() => resume(b)} style={C.railCard} title="Resume this bill">
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <b style={{ fontSize: 13, flex: 1, textAlign: "start" }}>{otypeLabelOf(b.otype)} · <span className="num">{b.no || ("#" + items)}</span></b>
                <span onClick={(e) => { e.stopPropagation(); store.del([{ kind: "parked", id: b.id }]); }} style={{ color: "var(--ink3)", fontSize: 13 }}>✕</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink2)", marginTop: 2, textAlign: "start" }}>{b.custName || "Walk-in"}{b.otype === "dinein" && b.table ? " · T" + b.table : ""}</div>
              <div style={{ display: "flex", alignItems: "center", marginTop: 7 }}>
                <span style={{ ...C.stag, color: col, background: "var(--sur2)" }}>● {label}</span>
                <div style={{ flex: 1 }} />
                <span className="num" style={{ fontSize: 10.5, color: "var(--ink3)" }}>{mins}m</span>
              </div>
            </button>
          );
        })}
        {parked.length === 0 && count === 0 && (
          <div style={{ color: "var(--ink3)", fontSize: 12, textAlign: "center", padding: "26px 12px" }}>No open bills. Held and kitchen-fired orders show up here.</div>
        )}
      </div>
      <button onClick={resetBill} style={{ ...C.obill, borderStyle: "dashed", color: "var(--ink2)", margin: "0 10px 10px", textAlign: "center" }}>＋ New bill</button>
    </div>
  );

  const cartInner = (
    <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 16px 10px" }}>
                <div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>Order <span className="num" style={{ color: "var(--ink3)", fontWeight: 700, marginInlineStart: 2 }}>{orderNo}</span></div>
                <button onClick={park} disabled={!count} style={{ ...C.pill, cursor: "pointer", opacity: count ? 1 : .5 }} title="Hold this bill">Hold</button>
                <button onClick={resetBill} style={{ ...C.pill, cursor: "pointer" }} title="Clear the register">Clear</button>
                {mob && <button onClick={() => setCartOpen(false)} style={{ ...C.act, width: 34, height: 34, fontSize: 14 }}>✕</button>}
              </div>
              <div style={{ padding: "0 14px 10px" }}>
                <div style={{ display: "flex", gap: 3, background: "var(--sur2)", borderRadius: 12, padding: 3 }}>
                  {([["dinein", "Dine-In"], ["takeaway", "Takeaway"], ["delivery", "Delivery"]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => pickOtype(k)} style={{ flex: 1, padding: "8px 6px", borderRadius: 9, fontSize: 12.5, fontWeight: 800, cursor: "pointer", ...(otype === k ? { background: "var(--sur)", color: "var(--coral)", boxShadow: "0 1px 3px rgba(30,35,45,.12)" } : { color: "var(--ink2)" }) }}>{l}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 14px 10px" }}>
                <button onClick={() => setCustPick(true)} style={{ ...C.custBtn, display: "flex", alignItems: "center", ...(cust ? { background: "var(--coralsoft)", color: "var(--coral)" } : {}) }}>👤 <span style={{ flex: 1, textAlign: "start", marginInlineStart: 6 }}>{cust ? cust.name : "Add customer"}</span>{cust && <span onClick={(e) => { e.stopPropagation(); setCust(null); }}>✕</span>}</button>
                {otype === "dinein" && <button onClick={() => setTablePick(true)} style={{ ...C.custBtn, display: "flex", alignItems: "center", ...(table ? { background: "var(--coralsoft)", color: "var(--coral)" } : {}) }}>🖥 <span style={{ flex: 1, textAlign: "start", marginInlineStart: 6 }}>{table ? "Table " + table : "Select table"}</span><span style={{ opacity: .6 }}>▾</span></button>}
                {otype === "delivery" && <button onClick={() => setZonePick(true)} style={{ ...C.custBtn, textAlign: "start", lineHeight: 1.25, ...(zone || deliveryNote ? { background: "var(--coralsoft)", color: "var(--coral)" } : {}) }}>🛵 <b style={{ fontWeight: 700 }}>Delivery details</b><br /><small style={{ opacity: .8 }}>{zone ? zone.name + (zone.fee ? " · " + money(zone.fee) : "") : "zone · address"}</small></button>}
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "2px 12px", borderTop: "1px solid var(--line)", minHeight: mob ? 120 : 0 }}>
                {cart.length === 0 ? (
                  <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--ink3)", gap: 10, padding: "30px 0" }}><div style={{ fontSize: 30 }}>🛒</div><div style={{ fontSize: 13 }}>Scan or tap a product to start</div></div>
                ) : cart.map((l) => {
                  const p = prodById(l.pid); if (!p) return null; const t = tintFor(p.cat); const u = lineUnit(l);
                  return (
                    <div key={l.key} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 4px", animation: "rise .25s both" }}>
                      <span style={{ width: 32, height: 32, borderRadius: 999, background: t[0], color: t[1], display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13, flex: "0 0 32px" }}>{(p.name || "?")[0].toUpperCase()}</span>
                      <div style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 13, fontWeight: 700, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</b><small style={{ fontSize: 11, color: "var(--ink2)" }}>{(l.mods || []).length ? (l.mods || []).map((m) => m.name).join(" · ") : money(u) + " each"}</small></div>
                      <span style={{ ...C.stepper, background: "var(--sur2)" }}><button style={C.stepBtn} onClick={() => bump(l.key, -1)}>−</button><span className="num" style={{ minWidth: 15, textAlign: "center", fontWeight: 800 }}>{l.qty}</span><button style={C.stepBtn} onClick={() => bump(l.key, 1)}>+</button></span>
                      <span className="num" style={{ fontWeight: 800, fontSize: 13, minWidth: 58, textAlign: "right" }}>{money(u * l.qty)}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ borderTop: "1px solid var(--line)", padding: "12px 16px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingBottom: 10, marginBottom: 8, borderBottom: "1px dashed var(--line)" }}>
                  <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", color: "var(--ink2)", marginInlineEnd: 2 }}>DISCOUNT</span>
                  {[0, 5, 10, 15, 20].map((pct) => {
                    const on = pct === 0 ? !totals.disc : discPct === pct;
                    return <button key={pct} onClick={() => { if (pct === 0) { setDisc(0); setDiscPct(0); } else { setDiscPct(pct); setDisc(Math.round(totals.subtotal * pct / 100)); } }} style={{ border: "1px solid " + (on ? "var(--coral)" : "var(--line)"), borderRadius: 99, padding: "4px 11px", fontSize: 11, fontWeight: 800, cursor: "pointer", background: on ? "var(--coralsoft)" : "transparent", color: on ? "var(--coral)" : "var(--ink2)" }}>{pct === 0 ? "None" : pct + "%"}</button>;
                  })}
                </div>
                {totals.disc > 0 && <div style={C.trow}><span>Subtotal</span><span className="num">{money(totals.subtotal)}</span></div>}
                {totals.disc > 0 && <div style={{ ...C.trow, color: "var(--coral)" }}><span>Discount {discPct ? discPct + "%" : ""}</span><span className="num">−{money(totals.disc)}</span></div>}
                <div style={C.trow}><span>Value excl. GST</span><span className="num">{money(totals.excl)}</span></div>
                {totals.svc > 0 && <div style={C.trow}><span>Service charge {svcBp / 100}%</span><span className="num">{money(totals.svc)}</span></div>}
                <div style={C.trow}><span style={{ whiteSpace: "nowrap" }}>GST {sector === "tourism" ? "TGST 17%" : "GGST 8%"}</span><span className="num">{money(totals.gst)}</span></div>
                {totals.fee > 0 && <div style={C.trow}><span>Delivery{zone?.name ? " · " + zone.name : ""}</span><span className="num">{money(totals.fee)}</span></div>}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 0 12px" }}><span style={{ fontWeight: 800, fontSize: 13 }}>Total</span><span className="num" style={{ fontFamily: "var(--num)", fontWeight: 800, fontSize: 26 }}>{money(totals.total)}</span></div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button style={{ ...C.kot, opacity: count ? 1 : .5 }} disabled={!count} title="Fire this order to the kitchen" onClick={sendKOT}>Send to KOT</button>
                  <button style={{ ...C.charge, opacity: count ? 1 : .5, padding: 14 }} disabled={!count} onClick={() => { setCartOpen(false); openShift ? setPay(true) : setShiftModal(true); }}>Charge</button>
                </div>
              </div>
    </>
  );

  /* ── Floor / table map (prototype §Floor) ─────────────────────────────── */
  const tableNames: string[] = (() => {
    const t = st.byKind("tables").map((e: any) => e.data?.name).filter(Boolean);
    return t.length ? t : Array.from({ length: 12 }, (_, i) => "T" + (i + 1));
  })();
  const heldDine = parked.filter((b: any) => b.otype === "dinein" && b.table);
  const heldOther = parked.filter((b: any) => b.otype !== "dinein" || !b.table);
  const billFor = (name: string): any =>
    heldDine.find((b: any) => b.table === name) ||
    (otype === "dinein" && table === name && cart.length ? { id: "__active", lines: cart, t: Date.now(), active: true } : null);
  const billSub = (b: any) => (b.lines || []).reduce((a: number, l: any) => { const p = prodById(l.pid); return a + (p ? lineUnit(l) * l.qty : 0); }, 0);
  const billItems = (b: any) => (b.lines || []).reduce((a: number, l: any) => a + (l.qty || 0), 0);
  const occN = tableNames.filter((n) => billFor(n)).length;
  const openVal = tableNames.reduce((a, n) => { const b = billFor(n); return a + (b ? billSub(b) : 0); }, 0);
  const seatOrRecall = (name: string) => {
    const b = billFor(name);
    if (b && !b.active) resume(b);
    else if (!b) { setOtype("dinein"); setTable(name); }
    setNav("sell");
  };
  const floorInner = (
    <div style={{ flex: 1, overflowY: "auto", padding: mob ? "14px 12px" : "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ fontFamily: "var(--num)", fontWeight: 800, fontSize: 19 }}>Floor</div>
        <span style={{ fontSize: 11, fontWeight: 800, background: "var(--coralsoft)", color: "var(--coral)", borderRadius: 999, padding: "4px 10px" }}>{occN} occupied</span>
        <span style={{ fontSize: 11, fontWeight: 800, background: "var(--sur2)", color: "var(--ink2)", borderRadius: 999, padding: "4px 10px" }}>{tableNames.length - occN} free</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "var(--ink2)" }}>Open value <b className="num" style={{ color: "var(--ink)", fontSize: 15 }}>{money(openVal)}</b></span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 12 }}>
        {tableNames.map((n) => {
          const b = billFor(n), occ = !!b;
          const mins = occ && b.t ? Math.max(0, Math.floor((Date.now() - b.t) / 60000)) : 0;
          return (
            <button key={n} onClick={() => seatOrRecall(n)} style={{
              ...C.tile, cursor: "pointer", textAlign: "start", minHeight: 104, display: "flex", flexDirection: "column", gap: 4,
              borderColor: occ ? "var(--coral)" : "var(--line)", background: occ ? "var(--coralsoft)" : "var(--sur)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <b style={{ fontSize: 16 }}>{n}</b>
                {occ && !b.active && <span style={{ fontSize: 10, fontWeight: 800, color: "var(--amber)" }}>● held</span>}
              </div>
              {occ ? (
                <>
                  <div style={{ fontSize: 12.5, color: "var(--ink2)" }}>{billItems(b)} items · <span className="num">{money(billSub(b))}</span></div>
                  <div style={{ flex: 1 }} />
                  <div style={{ fontSize: 11, color: "var(--ink3)" }}>{b.active ? "on the counter" : mins + "m ago · tap to recall"}</div>
                </>
              ) : (
                <>
                  <div style={{ flex: 1 }} />
                  <div style={{ fontSize: 12, color: "var(--ink3)" }}>Free · tap to seat</div>
                </>
              )}
            </button>
          );
        })}
      </div>
      {heldOther.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: "var(--ink3)", margin: "20px 0 8px" }}>OTHER OPEN ORDERS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {heldOther.map((b: any) => (
              <button key={b.id} onClick={() => { resume(b); setNav("sell"); }} style={{ ...C.tile, cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: "11px 14px" }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: b.otype === "delivery" ? "var(--green)" : "var(--amber)" }}>{b.otype === "delivery" ? "🛵 Delivery" : "🥡 Takeaway"}</span>
                <span style={{ fontSize: 12.5, color: "var(--ink2)" }}>{billItems(b)} items{b.custName ? " · " + b.custName : ""}</span>
                <div style={{ flex: 1 }} />
                <span className="num" style={{ fontWeight: 800, fontSize: 13 }}>{money(billSub(b))}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );

  /* ── Day End (prototype §Day End) ─────────────────────────────────────── */
  const deScope = (() => {
    const all = st.byKind("sales").map((e: any) => e.data);
    const s = openShift ? all.filter((x: any) => x.shiftId === openShift.id && !x.refunded) : all.filter((x: any) => new Date(x.t).toDateString() === new Date().toDateString() && !x.refunded);
    const byMethod: Record<string, number> = {};
    s.forEach((x: any) => (x.payments || []).forEach((p: any) => { byMethod[p.method] = (byMethod[p.method] || 0) + (p.amount || 0); }));
    return { list: s, byMethod, gross: s.reduce((a: number, x: any) => a + (x.total || 0), 0), gst: s.reduce((a: number, x: any) => a + (x.gst || 0), 0), svc: s.reduce((a: number, x: any) => a + (x.svcCharge || 0), 0), orders: s.length };
  })();
  const deCard = { background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 16, padding: 16, boxShadow: "var(--shadow)" };
  const dayEndInner = (
    <div style={{ flex: 1, overflowY: "auto", padding: mob ? "14px 12px" : "18px 22px" }}>
      <div style={{ fontFamily: "var(--num)", fontWeight: 800, fontSize: 19 }}>Day End</div>
      <div style={{ color: "var(--ink2)", fontSize: 12.5, margin: "2px 0 16px" }}>{openShift ? "Current shift · opened " + new Date(openShift.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "No open shift — showing today’s sales"}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 14 }}>
        {([["Gross sales", money(deScope.gross)], ["Orders", String(deScope.orders)], ["GST collected", money(deScope.gst)], ["Service charge", money(deScope.svc)]] as [string, string][]).map(([k, v]) => (
          <div key={k} style={deCard}><div style={{ fontSize: 11, color: "var(--ink2)", textTransform: "uppercase", letterSpacing: ".04em" }}>{k}</div><div className="num" style={{ fontSize: 22, fontWeight: 800, marginTop: 2 }}>{v}</div></div>
        ))}
      </div>
      <div style={{ ...deCard, marginBottom: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>Payment breakdown</div>
        {[...METHODS, "Credit"].map((m) => (deScope.byMethod[m] ? (
          <div key={m} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 13.5 }}><span>{m === "Credit" ? "On tab" : m}</span><span className="num" style={{ fontWeight: 700 }}>{money(deScope.byMethod[m])}</span></div>
        ) : null))}
        {!Object.keys(deScope.byMethod).length && <div style={{ color: "var(--ink3)", fontSize: 13, padding: "6px 0" }}>No sales yet.</div>}
      </div>
      <button onClick={() => openShift ? setZModal(true) : setShiftModal(true)} style={{ ...C.charge, width: mob ? "100%" : "auto", padding: "12px 22px" }}>{openShift ? "Count drawer & close day →" : "Open a shift to start the day"}</button>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0, paddingTop: "var(--sat,0px)", paddingInline: "var(--sal,0px) var(--sar,0px)" }}>
        <header style={{ ...C.header, padding: mob ? "0 10px" : "0 16px" }}>
          <div style={C.kchipSm}>K</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 800, fontSize: mob ? 13 : 15, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {settings.storeName || "Kashikeyo Café"} <span style={{ color: "var(--ink3)", fontSize: 11 }}>▾</span>
          </div>
          <button onClick={toggleSector} style={{ ...C.pill, cursor: "pointer", color: "var(--ink)", padding: "6px 11px" }} title="Switch GST sector">
            <i style={{ ...C.dot, background: sector === "tourism" ? "var(--blue)" : "var(--green)" }} />{mob ? "" : (sector === "tourism" ? "Tourism · TGST 17%" : "General · GGST 8%")}
          </button>
          <div style={{ flex: 1 }} />
          {!mob && <span className="num" style={{ fontSize: 13, color: "var(--ink2)" }}>{clock}</span>}
          {!mob && <StatusPill />}
          <button onClick={toggleLang} style={{ ...C.pill, cursor: "pointer", padding: "6px 11px", fontWeight: 800 }} title="Language">{lang === "en" ? "ދިވެހި" : "EN"}</button>
          <button onClick={() => (window.location.href = "/back")} style={{ ...C.pill, cursor: "pointer", padding: mob ? "6px 9px" : "6px 12px" }} title="Admin cockpit">⚙︎{mob ? "" : " Admin"}</button>
          <button onClick={() => openShift ? setZModal(true) : setShiftModal(true)} style={{ ...C.pill, cursor: "pointer", color: openShift ? "var(--green)" : "var(--amber)", padding: "6px 11px" }} title={openShift ? "Close shift (Z-report)" : "Open a shift"}>
            <i style={{ ...C.dot, background: openShift ? "var(--green)" : "var(--amber)" }} />{mob ? "" : (openShift ? "Shift" : "No shift")}
          </button>
          <button onClick={onSignOut} style={{ ...C.pill, gap: 8, padding: mob ? "4px" : "5px 11px 5px 5px", cursor: "pointer" }} title="Sign out">
            <span style={C.avatar}>{(user.name || "?")[0].toUpperCase()}</span>{!mob && user.name}
          </button>
        </header>

        <nav style={mob ? C.navrowM : C.navrow} className="glass">
          {NAV.map((n) => {
            const on = nav === n.id;
            return (
              <button key={n.id} onClick={() => { if (n.to) { window.location.href = n.to; return; } setNav(n.id); }} style={{ ...C.npill, ...(on ? C.npillOn : {}) }} aria-current={on ? "page" : undefined} title={n.label}>
                <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: n.icon }} />
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{n.label}</span>
              </button>
            );
          })}
        </nav>

        {nav === "sell" ? (
          <div style={{ ...C.body, gap: mob ? 0 : 12 }}>
            {!mob && parked.length > 0 && billsRailInner}
            <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 11, paddingBottom: mob && count > 0 ? 66 : 0 }}>
              {!openShift && (
                <button onClick={() => setShiftModal(true)} style={C.shiftBar}>🕓 No shift open — tap to open one before taking payments</button>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <div style={C.search}>
                  <svg viewBox="0 0 24 24" width={17} height={17} style={{ color: "var(--ink3)" }}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search or type barcode…" style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 14 }} />
                </div>
                <button style={C.scan}>📷 Scan</button>
              </div>
              <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2 }}>
                <button onClick={() => setGroup("all")} style={{ ...C.chip, ...(group === "all" ? C.chipOn : {}) }}>All</button>
                {groups.map((g) => <button key={g.name} onClick={() => setGroup(g.name)} style={{ ...C.chip, ...(group === g.name ? C.chipOn : {}) }}>{g.name}</button>)}
              </div>
              <div style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
                <div style={C.grid}>
                  {items.map((p, i) => {
                    const q = qtyOf(p.id); const t = tintFor(p.cat);
                    return (
                      <div key={p.id} onClick={() => tapProduct(p)} style={{ ...C.tile, cursor: "pointer", borderColor: q > 0 ? "var(--coral)" : "var(--line)", animation: `rise .3s ${Math.min(i * 12, 220)}ms both` }}>
                        <div style={{ ...C.plate, background: `radial-gradient(120% 115% at 50% 8%, ${t[0]}, var(--sur2))` }}>
                          {p.img
                            ? <img src={p.img} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            : <span style={{ fontSize: 42, lineHeight: 1 }}>{p.emoji || "🍽️"}</span>}
                          {bestIds.has(p.id) && <span style={C.best}>★ Best</span>}
                          {hasMods(p) && <span style={{ position: "absolute", bottom: 7, insetInlineStart: 8, fontSize: 9.5, fontWeight: 800, background: "rgba(20,18,15,.55)", color: "#fff", borderRadius: 999, padding: "2px 8px", backdropFilter: "blur(2px)" }}>options</span>}
                          {q > 0 && <span style={{ position: "absolute", top: 7, insetInlineStart: 8, minWidth: 20, height: 20, borderRadius: 999, background: "var(--coral)", color: "var(--coralink)", fontSize: 11.5, fontWeight: 800, display: "grid", placeItems: "center", padding: "0 6px" }} className="num">{q}</span>}
                        </div>
                        <div style={C.tbody}>
                          <div style={C.tname}>{p.name}</div>
                          {p.desc && <div style={C.tdesc}>{p.desc}</div>}
                          <div style={{ flex: 1 }} />
                          <div style={C.tfoot}>
                            <span className="num" style={{ fontSize: 14, fontWeight: 800 }}><small style={{ fontSize: 9.5, color: "var(--ink3)", fontWeight: 700, marginInlineEnd: 3 }}>MVR</small>{(p.price / 100).toFixed(2)}</span>
                            {q > 0
                              ? <span style={C.stepper} onClick={(e) => e.stopPropagation()}><button style={C.stepBtn} onClick={() => dropOne(p.id)}>−</button><span className="num" style={{ minWidth: 15, textAlign: "center", fontWeight: 800 }}>{q}</span><button style={C.stepBtn} onClick={() => tapProduct(p)}>+</button></span>
                              : <button style={C.plus} onClick={(e) => { e.stopPropagation(); tapProduct(p); }}>+</button>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {items.length === 0 && <div style={{ color: "var(--ink3)", fontSize: 13, padding: 20 }}>No products in this category.</div>}
                </div>
              </div>
            </section>

            {!mob && (
              <aside style={{ ...C.cart, ...(tab ? { width: 300, flex: "0 0 300px" } : {}) }} className="glass">{cartInner}</aside>
            )}
            {mob && count > 0 && !cartOpen && (
              <button onClick={() => setCartOpen(true)} style={C.orderPillM}>
                <span style={{ background: "rgba(255,255,255,.25)", borderRadius: 99, padding: "2px 10px", fontWeight: 800 }}>{count}</span>
                <span style={{ flex: 1, textAlign: "start", marginInlineStart: 10 }}>View order</span>
                <span className="num" style={{ fontWeight: 800 }}>{money(totals.total)}</span>
              </button>
            )}
            {mob && cartOpen && (
              <div style={C.cartSheetWrap} onClick={() => setCartOpen(false)}>
                <div style={C.cartSheetM} className="glass" onClick={(e) => e.stopPropagation()}>{cartInner}</div>
              </div>
            )}
          </div>
        ) : nav === "floor" ? floorInner : nav === "dayend" ? dayEndInner : nav === "kitchen" ? <Orders /> : nav === "dashboard" ? <Dashboard /> : nav === "analytics" ? <Reports /> : <Placeholder nav={nav} />}
      {modProd && <ModifierModal product={modProd} onClose={() => setModProd(null)} onAdd={(mods) => { addLine(modProd, mods); setModProd(null); }} />}
      {pay && <PaySheet total={totals.total} currency={currency} hasCustomer={!!cust} custName={cust?.name} onClose={() => setPay(false)} onDone={onCharged} />}
      {custPick && <CustomerPicker customers={st.byKind("customers").map((e) => e.data)} onPick={(c) => { setCust(c); setCustPick(false); }} onClose={() => setCustPick(false)} />}
      {tablePick && <TablePicker tables={st.byKind("tables").map((e) => e.data)} current={table} onPick={(name) => { setTable(name); setOtype("dinein"); setTablePick(false); }} onClear={() => { setTable(""); setOtype("takeaway"); setTablePick(false); }} onClose={() => setTablePick(false)} />}
      {zonePick && <DeliveryDetails zones={st.byKind("zones").map((e) => e.data)} current={zone} note={deliveryNote} setNote={setDeliveryNote} custName={cust?.name} onPick={(z) => setZone(z)} onClear={() => setZone(null)} onAttachCustomer={() => { setZonePick(false); setCustPick(true); }} onClose={() => setZonePick(false)} />}
      {shiftModal && <ShiftModal onClose={() => setShiftModal(false)} onOpen={openShiftNow} />}
      {zModal && openShift && <ZModal shift={openShift} sales={st.byKind("sales").map((e) => e.data)} onClose={() => setZModal(false)} onCloseShift={closeShiftNow} />}
      {receipt && <Receipt data={receipt} gstBp={gstBp} onClose={() => setReceipt(null)} />}
    </div>
  );
}

/* ── shift open / close (Z-report) + receipt ───────────────────────────────── */
function ShiftModal({ onClose, onOpen }: { onClose: () => void; onOpen: (float: number) => void }) {
  const [v, setV] = useState("");
  return (
    <div style={C.overlay} onClick={onClose}>
      <div style={{ ...C.sheet, width: "min(420px,94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>Open shift</div>
        <div style={{ color: "var(--ink2)", fontSize: 13, marginBottom: 14 }}>Count the cash in the drawer to start the shift.</div>
        <label style={{ color: "var(--ink3)", fontSize: 12, fontWeight: 700 }}>OPENING FLOAT (MVR)</label>
        <input autoFocus type="number" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="0.00" style={{ ...C.input, width: "100%", marginTop: 6 }} />
        <button onClick={() => onOpen(Math.round(Number(v) * 100) || 0)} style={{ ...C.charge, width: "100%", marginTop: 16 }}>Open shift</button>
      </div>
    </div>
  );
}
function ZModal({ shift, sales, onClose, onCloseShift }: { shift: any; sales: any[]; onClose: () => void; onCloseShift: (counted: number, expected: number) => void }) {
  const cashSales = sales.filter((s) => s.shiftId === shift.id).reduce((a, s) => a + (s.payments || []).filter((p: any) => /cash/i.test(p.method)).reduce((x: number, p: any) => x + (p.amount || 0), 0), 0);
  const expected = (shift.openingFloat || 0) + cashSales;
  const [v, setV] = useState("");
  const counted = Math.round(Number(v) * 100) || 0;
  const variance = counted - expected;
  return (
    <div style={C.overlay} onClick={onClose}>
      <div style={{ ...C.sheet, width: "min(440px,94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 12 }}>Close shift · Z-report</div>
        <Row2 k="Opening float" v={money(shift.openingFloat || 0)} />
        <Row2 k="Cash sales" v={money(cashSales)} />
        <Row2 k="Expected in drawer" v={money(expected)} bold />
        <label style={{ color: "var(--ink3)", fontSize: 12, fontWeight: 700, display: "block", marginTop: 12 }}>COUNTED CASH (MVR)</label>
        <input autoFocus type="number" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="0.00" style={{ ...C.input, width: "100%", marginTop: 6 }} />
        {v !== "" && <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontWeight: 800, color: Math.abs(variance) < 50 ? "var(--green)" : "var(--red)" }}><span>Variance</span><span className="num">{variance >= 0 ? "+" : "−"}{money(Math.abs(variance))}</span></div>}
        <button onClick={() => onCloseShift(counted, expected)} style={{ ...C.charge, width: "100%", marginTop: 16 }}>Close day & post journal</button>
      </div>
    </div>
  );
}
const Row2 = ({ k, v, bold }: { k: string; v: string; bold?: boolean }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13.5, fontWeight: bold ? 800 : 600, color: bold ? "var(--ink)" : "var(--ink2)" }}><span>{k}</span><span className="num">{v}</span></div>
);

function Receipt({ data, gstBp, onClose }: { data: any; gstBp: number; onClose: () => void }) {
  const { sale, change, settings } = data;
  const method = (sale.payments || [])[0]?.method || "—";
  const docNo = "MLE-R1-" + new Date(sale.t).toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(sale.no || "").replace(/\D/g, "").padStart(4, "0");
  const otypeLabel = sale.otype === "dinein" ? ("Dine-in" + (sale.table ? " · Table " + sale.table : "")) : sale.otype === "delivery" ? "Delivery" : "Takeaway";
  const excl = Math.max(0, (sale.subtotal || 0) - (sale.billDisc || 0));
  return (
    <div style={C.overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(360px,94vw)", display: "flex", flexDirection: "column", gap: 10 }}>
        <div id="ksh-receipt" style={C.receipt}>
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{settings.storeName || "Kashikeyo Café"}</div>
            <div style={{ fontSize: 11, color: "#555" }}>{settings.address || "Malé, Maldives"}</div>
            {settings.tin && <div style={{ fontSize: 11, color: "#555" }}>TIN {settings.tin}</div>}
            <div style={{ display: "inline-block", marginTop: 6, fontSize: 10, fontWeight: 800, letterSpacing: ".1em", border: "1px solid #999", borderRadius: 4, padding: "2px 8px" }}>RECEIPT</div>
          </div>
          <div style={{ fontSize: 10.5, color: "#555", display: "flex", justifyContent: "space-between", marginBottom: 2 }}><span>{docNo}</span><span>{new Date(sale.t).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
          <div style={{ fontSize: 11, color: "#333", fontWeight: 700, textAlign: "center", marginBottom: 4 }}>{otypeLabel}</div>
          <div style={{ borderTop: "1px dashed #bbb", borderBottom: "1px dashed #bbb", margin: "8px 0", padding: "8px 0" }}>
            {(sale.lines || []).map((l: any, i: number) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}><span>{l.qty}× {l.name}</span><span className="num">{money((l.price || 0) * l.qty)}</span></div>
            ))}
          </div>
          <RRow k="Subtotal" v={money(sale.subtotal)} />
          {sale.billDisc > 0 && <RRow k="Discount" v={"−" + money(sale.billDisc)} />}
          <RRow k="Value excl. GST" v={money(excl)} />
          {sale.svcCharge > 0 && <RRow k="Service charge" v={money(sale.svcCharge)} />}
          <RRow k={`GST ${gstBp / 100}%`} v={money(sale.gst)} />
          {sale.fee > 0 && <RRow k={"Delivery" + (sale.zone ? " · " + sale.zone : "")} v={money(sale.fee)} />}
          <RRow k="Total" v={money(sale.total)} bold />
          <RRow k={method} v={money(sale.total)} />
          {change > 0 && <RRow k="Change" v={money(change)} />}
          <div style={{ textAlign: "center", fontSize: 11, color: "#555", marginTop: 10 }}>Prices are GST-inclusive · Thank you<br />ޝުކުރިއްޔާ</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => window.print()} style={{ ...C.charge, flex: 1 }}>🖨 Print</button>
          <button onClick={onClose} style={{ ...C.act, flex: 1, width: "auto", background: "var(--sur)", border: "1px solid var(--line)", color: "var(--ink)", fontWeight: 700 }}>New sale</button>
        </div>
      </div>
    </div>
  );
}
const RRow = ({ k, v, bold }: { k: string; v: string; bold?: boolean }) => (
  <div style={{ display: "flex", justifyContent: "space-between", fontSize: bold ? 14 : 12, fontWeight: bold ? 800 : 500, padding: "2px 0", color: "#111" }}><span>{k}</span><span className="num">{v}</span></div>
);

function StatusPill() {
  const st = useStore();
  const s = st.status(); const n = st.pending();
  const map = { synced: ["var(--green)", "Synced"], saving: ["var(--amber)", n ? `Saving ${n}…` : "Saving…"], offline: ["var(--red)", n ? `Offline · ${n} saved here` : "Offline"] } as const;
  const [c, label] = map[s];
  return <span style={{ ...C.pill, color: c }}><i style={{ ...C.dot, background: c, animation: s === "saving" ? "pulse 1s infinite" : s === "synced" ? "pulse 2.4s infinite" : undefined }} />{label}</span>;
}

/* Payment drawer — matched to the KashikeyoPOS prototype: a right-side slide-in
   drawer with a centered Total-due, split squares, a 2-column tender-card grid,
   cash-received chips and a green change-due card. On tab + QR carry over from
   our build (prototype tenders are Cash/Card/BML/Transfer/On tab). */
const PAY_ICON: Record<string, string> = { Cash: "💵", Card: "💳", "BML Gateway": "🏦", Transfer: "🔁", QR: "▦", Credit: "🧾" };
function PaySheet({ total, hasCustomer, custName, onClose, onDone }: { total: number; currency: string; hasCustomer: boolean; custName?: string; onClose: () => void; onDone: (p: { method: string; amount: number }[], change: number) => void }) {
  const [method, setMethod] = useState<string>("Cash");
  const [tender, setTender] = useState<number>(0);
  const [guests, setGuests] = useState(1);
  const isTab = method === "Credit", cashSel = method === "Cash";
  const perGuest = Math.ceil(total / guests / 100) * 100;
  const change = cashSel ? Math.max(0, tender - total) : 0;
  const tenders = [total, Math.ceil(total / 5000) * 5000, Math.ceil(total / 10000) * 10000, Math.ceil(total / 50000) * 50000].filter((v, i, a) => a.indexOf(v) === i);
  const ok = (!cashSel || tender >= total) && (!isTab || hasCustomer);
  const METH: [string, string][] = [["Cash", "Cash"], ["Card", "Card"], ["BML Gateway", "BML Gateway"], ["Transfer", "Transfer"], ["QR", "QR"], ["Credit", "On tab"]];
  const confirm = () => onDone(
    guests > 1 ? Array.from({ length: guests }, (_, i) => ({ method, amount: i === guests - 1 ? total - perGuest * (guests - 1) : perGuest })) : [{ method, amount: total }],
    change);
  return (
    <div style={{ ...C.overlay, justifyContent: "flex-end", alignItems: "stretch" }} onClick={onClose}>
      <div className="glass" onClick={(e) => e.stopPropagation()} style={{ width: "min(430px,96vw)", height: "100%", background: "var(--sur)", borderInlineStart: "1px solid var(--line)", display: "flex", flexDirection: "column", animation: "sheet .3s cubic-bezier(.2,.9,.3,1.1)", paddingTop: "var(--sat,0px)", paddingBottom: "var(--sab,0px)" }}>
        <div style={{ padding: "16px 22px", borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Payment</div><div style={{ flex: 1 }} />
            <button onClick={onClose} style={{ ...C.act, width: 30, height: 30, fontSize: 15 }}>✕</button>
          </div>
          <div style={{ textAlign: "center", padding: "14px 0 6px" }}>
            <div style={{ fontSize: 12, color: "var(--ink2)", fontWeight: 700 }}>Total due</div>
            <div className="num" style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-.01em" }}>{money(total)}</div>
            {guests > 1 && <div style={{ fontSize: 12.5, color: "var(--coral)", fontWeight: 800, marginTop: 2, animation: "pop .25s" }}>{money(perGuest)} per guest</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
            <span style={{ fontSize: 11.5, color: "var(--ink2)", fontWeight: 700 }}>Split</span>
            {[1, 2, 3, 4].map((n) => <button key={n} onClick={() => setGuests(n)} style={{ width: 34, height: 34, borderRadius: 11, border: "1px solid var(--line)", fontSize: 13, fontWeight: 800, cursor: "pointer", ...(guests === n ? { background: "var(--coral)", color: "var(--coralink)", borderColor: "var(--coral)" } : { background: "var(--sur2)", color: "var(--ink2)" }) }}>{n}</button>)}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
            {METH.map(([m, label]) => {
              const on = method === m, disabled = m === "Credit" && !hasCustomer;
              return (
                <button key={m} disabled={disabled} title={disabled ? "Attach a customer first" : label} onClick={() => { setMethod(m); if (m !== "Cash") setTender(total); }}
                  style={{ border: "1.5px solid " + (on ? "var(--coral)" : "var(--line)"), borderRadius: 15, padding: "15px 12px", cursor: disabled ? "default" : "pointer", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 7, background: on ? "var(--coralsoft)" : "var(--sur2)", color: "var(--ink)", opacity: disabled ? .45 : 1 }}>
                  <span style={{ width: 30, height: 30, borderRadius: 10, background: "var(--sur)", display: "grid", placeItems: "center", fontSize: 15 }}>{PAY_ICON[m]}</span>
                  <span style={{ fontSize: 13, fontWeight: 800 }}>{label}</span>
                </button>
              );
            })}
          </div>
          {isTab && <div style={{ marginTop: 14, fontSize: 13, color: "var(--ink2)" }}>Charged to <b style={{ color: "var(--ink)" }}>{custName}</b>’s tab — posts to receivables.</div>}
          {cashSel && (
            <div style={{ marginTop: 16, animation: "rise .25s" }}>
              <div style={{ fontSize: 11.5, color: "var(--ink2)", fontWeight: 700, marginBottom: 8 }}>Cash received</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {tenders.map((v) => <button key={v} onClick={() => setTender(v)} className="num" style={{ border: "1px solid " + (tender === v ? "var(--coral)" : "var(--line)"), borderRadius: 12, padding: "10px 15px", fontSize: 13, fontWeight: 800, cursor: "pointer", background: tender === v ? "var(--coralsoft)" : "var(--sur2)", color: tender === v ? "var(--coral)" : "var(--ink)" }}>{v === total ? "Exact" : money(v)}</button>)}
              </div>
              {change > 0 && <div style={{ marginTop: 14, background: "var(--greensoft)", borderRadius: 14, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", animation: "pop .25s" }}>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--green)" }}>Change due</span>
                <span className="num" style={{ fontFamily: "var(--num)", fontSize: 20, fontWeight: 800, color: "var(--green)" }}>{money(change)}</span>
              </div>}
            </div>
          )}
        </div>
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--line)" }}>
          <button disabled={!ok} onClick={confirm} style={{ ...C.charge, width: "100%", padding: 14, opacity: ok ? 1 : .5 }}>Confirm payment</button>
        </div>
      </div>
    </div>
  );
}

function ModifierModal({ product, onClose, onAdd }: { product: any; onClose: () => void; onAdd: (mods: Mod[]) => void }) {
  const addons: any[] = product.addons || [];
  const spice: any[] = (product.spiceLevels || []).map((s: any) => typeof s === "string" ? { name: s, price: 0 } : { name: s.name, price: s.price || 0 });
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [spiceSel, setSpiceSel] = useState<string>("");
  const mods: Mod[] = [
    ...addons.filter((a) => picked[a.name]).map((a) => ({ name: a.name, price: a.price || 0 })),
    ...(spiceSel ? [{ name: spiceSel, price: (spice.find((s) => s.name === spiceSel)?.price) || 0 }] : []),
  ];
  const unit = (product.price || 0) + mods.reduce((a, m) => a + m.price, 0);
  return (
    <div style={C.overlay} onClick={onClose}>
      <div style={{ ...C.sheet, width: "min(440px,94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <span style={{ ...C.glyph, background: tintFor(product.cat)[0], color: tintFor(product.cat)[1] }}>{product.emoji || (product.name || "?")[0]}</span>
          <div><div style={{ fontWeight: 800, fontSize: 16 }}>{product.name}</div><div className="num" style={{ color: "var(--ink2)", fontSize: 13 }}>{money(product.price || 0)}</div></div>
        </div>
        {addons.length > 0 && <div style={{ color: "var(--ink3)", fontSize: 11, fontWeight: 700, letterSpacing: ".04em", margin: "4px 0 6px" }}>ADD-ONS</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {addons.map((a) => { const on = !!picked[a.name]; return (
            <button key={a.name} onClick={() => setPicked({ ...picked, [a.name]: !on })} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderRadius: 13, border: "1px solid " + (on ? "var(--coral)" : "var(--line)"), background: on ? "var(--coralsoft)" : "var(--sur)" }}>
              <span style={{ width: 18, height: 18, borderRadius: 6, border: "2px solid " + (on ? "var(--coral)" : "var(--ink3)"), display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--coral)", fontSize: 12 }}>{on ? "✓" : ""}</span>
              <span style={{ flex: 1, textAlign: "start", fontWeight: 600, fontSize: 13.5 }}>{a.name}</span>
              {a.price > 0 && <span className="num" style={{ color: "var(--ink2)", fontSize: 12.5 }}>+{money(a.price).replace("MVR ", "")}</span>}
            </button>
          ); })}
        </div>
        {spice.length > 0 && <div style={{ color: "var(--ink3)", fontSize: 11, fontWeight: 700, letterSpacing: ".04em", margin: "12px 0 6px" }}>SPICE LEVEL</div>}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {spice.map((s) => <button key={s.name} onClick={() => setSpiceSel(spiceSel === s.name ? "" : s.name)} style={{ ...C.chip, ...(spiceSel === s.name ? C.methodOn : {}) }}>{s.name}</button>)}
        </div>
        <button onClick={() => onAdd(mods)} style={{ ...C.charge, width: "100%", marginTop: 18 }}>Add · {money(unit)}</button>
      </div>
    </div>
  );
}

/* Delivery details — the delivery-only step: attach a customer, pick the
   island/zone (fee + ETA added automatically) and jot a delivery note. No
   order-type row here — that lives on the cart, so this stays focused. */
function DeliveryDetails({ zones, current, note, setNote, custName, onPick, onClear, onAttachCustomer, onClose }: { zones: any[]; current?: any; note: string; setNote: (v: string) => void; custName?: string; onPick: (z: any) => void; onClear: () => void; onAttachCustomer: () => void; onClose: () => void }) {
  return (
    <div style={C.overlay} onClick={onClose}>
      <div style={{ ...C.sheet, width: "min(470px,94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 18, flex: 1 }}>Delivery details</div>
          <button onClick={onClose} style={{ ...C.act, width: 34, height: 34, fontSize: 14 }}>✕</button>
        </div>
        {!custName
          ? <button onClick={onAttachCustomer} style={{ display: "block", width: "100%", textAlign: "start", background: "var(--coralsoft)", color: "var(--coral)", fontWeight: 700, fontSize: 13.5, borderRadius: 13, padding: "13px 15px", cursor: "pointer", marginBottom: 14 }}>Attach a customer for this delivery →</button>
          : <div style={{ fontSize: 13, color: "var(--ink2)", marginBottom: 14 }}>Delivering to <b style={{ color: "var(--ink)" }}>{custName}</b></div>}
        <div style={{ fontSize: 11, color: "var(--ink3)", fontWeight: 700, marginBottom: 8 }}>Delivery zone — fee &amp; ETA added automatically</div>
        {zones.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8 }}>
            {zones.map((z) => {
              const on = current && current.name === z.name;
              return (
                <button key={z.id || z.name} onClick={() => on ? onClear() : onPick(z)} style={{ textAlign: "start", padding: "11px 13px", borderRadius: 13, border: "1.5px solid " + (on ? "var(--coral)" : "var(--line)"), background: on ? "var(--coralsoft)" : "var(--sur2)", cursor: "pointer" }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: on ? "var(--coral)" : "var(--ink)" }}>{z.name}{Number(z.fee) ? <span className="num"> · {money(z.fee)}</span> : <span style={{ color: "var(--green)" }}> · Free</span>}</div>
                  {z.eta && <div style={{ fontSize: 11, color: "var(--ink3)", marginTop: 2 }}>{z.eta}</div>}
                </button>
              );
            })}
          </div>
        ) : <div style={{ color: "var(--ink3)", fontSize: 13, textAlign: "center", padding: 16, background: "var(--sur2)", borderRadius: 13 }}>No delivery zones yet — add them in the back office.</div>}
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Delivery note — address, landmark, rider…" style={{ ...C.input, width: "100%", marginTop: 14 }} />
        <button onClick={onClose} style={{ ...C.charge, width: "100%", marginTop: 14, padding: 14 }}>Done</button>
      </div>
    </div>
  );
}
function TablePicker({ tables, current, onPick, onClear, onClose }: { tables: any[]; current?: string; onPick: (name: string) => void; onClear: () => void; onClose: () => void }) {
  return (
    <div style={C.overlay} onClick={onClose}>
      <div style={{ ...C.sheet, width: "min(420px,94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Choose a table</div>
            <div style={{ fontSize: 12, color: "var(--ink3)", marginTop: 2 }}>Seats this order as Dine-in</div>
          </div>
          <button onClick={onClose} style={{ ...C.act, width: 34, height: 34, fontSize: 14 }}>✕</button>
        </div>
        {tables.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(88px,1fr))", gap: 10 }}>
            {tables.map((t) => {
              const on = current === t.name;
              return (
                <button key={t.id || t.name} onClick={() => onPick(t.name)} style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
                  padding: "16px 8px", borderRadius: 15, fontWeight: 800, fontSize: 16,
                  border: "1.5px solid " + (on ? "var(--coral)" : "var(--line)"),
                  background: on ? "var(--coralsoft)" : "var(--sur)",
                  color: on ? "var(--coral)" : "var(--ink)", boxShadow: "var(--shadow)",
                }}>
                  <span style={{ fontSize: 18, opacity: on ? 1 : .55 }}>🍴</span>
                  {t.name}
                </button>
              );
            })}
          </div>
        ) : <div style={{ color: "var(--ink3)", fontSize: 13, textAlign: "center", padding: 16 }}>No tables set up — add them in the back office.</div>}
        {current && (
          <button onClick={onClear} style={{ ...C.custBtn, width: "100%", marginTop: 14, justifyContent: "center", color: "var(--ink2)" }}>Clear table · back to Takeaway</button>
        )}
      </div>
    </div>
  );
}

function CustomerPicker({ customers, onPick, onClose }: { customers: any[]; onPick: (c: any) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const list = customers.filter((c) => !q || (c.name || "").toLowerCase().includes(q.toLowerCase()) || (c.phone || "").includes(q));
  const startAdd = () => { setName(q.replace(/^\+?\d[\d ]*$/, "").trim()); setPhone(/^\+?\d[\d ]*$/.test(q.trim()) ? q.trim() : ""); setAdding(true); };
  const create = () => {
    const nm = name.trim(); if (!nm) return;
    const c = { id: uid(), name: nm, phone: phone.trim(), balance: 0, createdAt: Date.now() };
    store.commit([{ kind: "customers", id: c.id, data: c }]);
    onPick(c);
  };
  return (
    <div style={C.overlay} onClick={onClose}>
      <div style={{ ...C.sheet, width: "min(440px,94vw)", maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17, flex: 1 }}>{adding ? "New customer" : "Charge to customer"}</div>
          {!adding && <button onClick={startAdd} style={{ ...C.chipSm, cursor: "pointer" }}>＋ New</button>}
        </div>
        {adding ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div><label style={{ color: "var(--ink3)", fontSize: 12, fontWeight: 700 }}>NAME</label>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" style={{ ...C.input, width: "100%", marginTop: 5 }} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create(); }} /></div>
            <div><label style={{ color: "var(--ink3)", fontSize: 12, fontWeight: 700 }}>PHONE <span style={{ fontWeight: 400 }}>(optional)</span></label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="7XX XXXX" style={{ ...C.input, width: "100%", marginTop: 5 }} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create(); }} /></div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button onClick={() => setAdding(false)} style={{ ...C.custBtn, justifyContent: "center", cursor: "pointer" }}>Cancel</button>
              <button onClick={create} disabled={!name.trim()} style={{ ...C.charge, flex: 1, opacity: name.trim() ? 1 : .5 }}>Add customer</button>
            </div>
          </div>
        ) : (
          <>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone…" style={{ ...C.input, width: "100%" }} />
            <div style={{ overflowY: "auto", marginTop: 10 }}>
              {list.map((c) => (
                <button key={c.id} onClick={() => onPick(c)} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "11px 8px", borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                  <span style={{ ...C.avatar, background: "var(--coral)" }}>{(c.name || "?")[0].toUpperCase()}</span>
                  <span style={{ flex: 1 }}><b style={{ display: "block", fontSize: 14 }}>{c.name}</b><small style={{ color: "var(--ink3)" }}>{c.phone || ""}</small></span>
                  {Number(c.balance || 0) > 0 && <span className="num" style={{ color: "var(--amber)", fontWeight: 700, fontSize: 12 }}>{money(Number(c.balance))}</span>}
                </button>
              ))}
              <button onClick={startAdd} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 8px", textAlign: "left", cursor: "pointer", color: "var(--coral)", fontWeight: 700 }}>
                <span style={{ ...C.avatar, background: "var(--coralsoft)", color: "var(--coral)" }}>＋</span>
                <span>Add {q.trim() ? "“" + q.trim() + "”" : "a new customer"}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Placeholder({ nav }: { nav: string }) {
  const n = NAV.find((x) => x.id === nav)!;
  return <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--ink2)" }}>
    <div style={{ width: 60, height: 60, borderRadius: 18, background: "var(--sur)", boxShadow: "var(--shadow)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg viewBox="0 0 24 24" width={26} height={26} style={{ color: "var(--coral)" }} dangerouslySetInnerHTML={{ __html: n.icon }} />
    </div>
    <div style={{ fontWeight: 800, fontSize: 18, color: "var(--ink)" }}>{n.label}</div>
    <div style={{ fontSize: 13 }}>This existing screen is reskinned in a later stage.</div>
  </div>;
}

function useBestSellers(): Set<string> {
  const st = useStore();
  return useMemo(() => {
    const tally: Record<string, number> = {};
    st.byKind("sales").forEach((e) => (e.data.lines || []).forEach((l: any) => { tally[l.pid] = (tally[l.pid] || 0) + (l.qty || 0); }));
    return new Set(Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id));
  }, [st.ents.size]);
}

function nextInvoiceNo(sales: any[]): string {
  let max = 0;
  for (const s of sales) { const m = /(\d+)\s*$/.exec(String(s.no || "")); if (m) max = Math.max(max, Number(m[1])); }
  return "INV-" + String(max + 1).padStart(5, "0");
}

const C: Record<string, React.CSSProperties> = {
  rail: { width: 92, flex: "0 0 92px", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: "14px 8px", gap: 4, background: "var(--sur)", borderRight: "1px solid var(--line)" },
  railM: { position: "fixed", bottom: 0, left: 0, right: 0, height: 58, zIndex: 30, display: "flex", alignItems: "center", padding: "0 4px", background: "var(--sur)", borderTop: "1px solid var(--line)" },
  railBtnM: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "8px 2px", borderRadius: 12, color: "var(--ink2)", minWidth: 0 },
  orderPillM: { position: "fixed", left: 12, right: 12, bottom: "calc(14px + var(--sab,0px))", zIndex: 25, display: "flex", alignItems: "center", padding: "13px 16px", borderRadius: 15, background: "var(--coral)", color: "var(--coralink)", fontWeight: 700, fontSize: 15, boxShadow: "0 8px 22px -6px rgba(225,85,45,.55)" },
  cartSheetWrap: { position: "fixed", inset: 0, background: "rgba(20,18,15,.42)", display: "flex", alignItems: "flex-end", zIndex: 40, animation: "fade .2s" },
  cartSheetM: { width: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", background: "var(--sur)", borderRadius: "20px 20px 0 0", animation: "sheet .3s cubic-bezier(.2,.9,.3,1.1)", overflow: "hidden", paddingBottom: "var(--sab,0px)" },
  kchip: { width: 40, height: 40, borderRadius: 13, background: "linear-gradient(150deg,#F0743F,#E1552D)", color: "#FFF6EF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 20, boxShadow: "0 6px 16px rgba(225,85,45,.34)" },
  kchipSm: { width: 30, height: 30, borderRadius: 9, background: "linear-gradient(150deg,#F0743F,#E1552D)", color: "#FFF6EF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15, flex: "0 0 30px" },
  navrow: { display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", overflowX: "auto", borderBottom: "1px solid var(--line)", flex: "0 0 auto" },
  navrowM: { display: "flex", alignItems: "center", gap: 5, padding: "7px 10px", overflowX: "auto", borderBottom: "1px solid var(--line)", flex: "0 0 auto" },
  npill: { display: "flex", alignItems: "center", gap: 8, padding: "8px 15px", borderRadius: 999, color: "var(--ink2)", background: "transparent", whiteSpace: "nowrap", cursor: "pointer", flex: "0 0 auto" },
  npillOn: { background: "var(--coralsoft)", color: "var(--coral)", animation: "pop .25s" },
  railBtn: { display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "10px 4px", borderRadius: 13, color: "var(--ink2)" },
  railOn: { background: "var(--coralsoft)", color: "var(--coral)" },
  header: { height: 58, flex: "0 0 58px", display: "flex", alignItems: "center", gap: 12, padding: "0 18px" },
  pill: { border: "1px solid var(--line)", background: "var(--sur2)", borderRadius: 999, padding: "6px 13px", fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 7, whiteSpace: "nowrap" },
  dot: { width: 7, height: 7, borderRadius: 99, display: "inline-block" },
  avatar: { width: 30, height: 30, borderRadius: 99, background: "var(--green)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13 },
  card: { background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 14, boxShadow: "var(--shadow)" },
  key: { height: 60, borderRadius: 15, background: "var(--sur)", border: "1px solid var(--line)", fontSize: 22, fontWeight: 700, fontFamily: "var(--num)" },
  body: { flex: 1, minHeight: 0, display: "flex", gap: 14, padding: "0 16px 16px" },
  obill: { whiteSpace: "nowrap", border: "1px solid var(--line)", background: "var(--sur)", borderRadius: 12, padding: "8px 13px", fontSize: 12.5, fontWeight: 700 },
  obillOn: { borderColor: "var(--coral)", background: "var(--coralsoft)", color: "var(--coral)" },
  search: { flex: 1, display: "flex", alignItems: "center", gap: 10, background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 14, padding: "0 14px", height: 46 },
  scan: { background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 14, padding: "0 16px", fontWeight: 700, fontSize: 13.5 },
  chip: { whiteSpace: "nowrap", padding: "8px 15px", borderRadius: 999, fontSize: 13, fontWeight: 700, color: "var(--ink2)", background: "var(--sur)", border: "1px solid var(--line)" },
  chipOn: { background: "var(--ink)", color: "var(--bg)", borderColor: "var(--ink)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(158px,1fr))", gap: 12 },
  tile: { position: "relative", display: "flex", flexDirection: "column", borderRadius: 18, background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", textAlign: "left", overflow: "hidden" },
  plate: { position: "relative", aspectRatio: "16 / 11", display: "grid", placeItems: "center", overflow: "hidden" },
  tbody: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", flex: 1 },
  tname: { fontWeight: 700, fontSize: 13.5, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tdesc: { fontSize: 11, color: "var(--ink2)", lineHeight: 1.32, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 29 },
  tfoot: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9 },
  glyph: { width: 38, height: 38, borderRadius: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18 },
  best: { position: "absolute", top: 7, right: 8, background: "var(--green)", color: "#fff", fontSize: 9.5, fontWeight: 800, padding: "3px 8px", borderRadius: 999, boxShadow: "0 2px 6px rgba(0,0,0,.18)" },
  railWrap: { width: 224, flex: "0 0 224px", display: "flex", flexDirection: "column", borderRadius: 18, background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", overflow: "hidden" },
  railCard: { display: "block", width: "100%", border: "1.5px solid var(--line)", background: "var(--sur2)", borderRadius: 14, padding: "10px 12px", cursor: "pointer" },
  stag: { fontSize: 10.5, fontWeight: 800, borderRadius: 999, padding: "3px 9px", display: "inline-flex", alignItems: "center", gap: 4 },
  kot: { flex: 1, borderRadius: 13, padding: 14, background: "var(--sur)", border: "1.5px solid var(--line)", color: "var(--ink)", fontWeight: 800, fontSize: 14 },
  stepper: { display: "inline-flex", alignItems: "center", gap: 4, background: "var(--coralsoft)", borderRadius: 999, padding: "2px 4px" },
  stepBtn: { width: 24, height: 24, borderRadius: 99, background: "var(--sur)", fontSize: 15, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1 },
  plus: { width: 26, height: 26, borderRadius: 99, background: "var(--coral)", color: "var(--coralink)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700 },
  cart: { width: 352, flex: "0 0 352px", display: "flex", flexDirection: "column", borderRadius: 18, background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", overflow: "hidden" },
  billtab: { width: 34, height: 30, borderRadius: 9, background: "var(--coral)", color: "var(--coralink)", fontWeight: 800, fontSize: 13, display: "inline-flex", alignItems: "center", justifyContent: "center" },
  billAdd: { background: "var(--sur2)", color: "var(--ink2)" },
  oseg: { flex: 1, padding: "9px 6px", borderRadius: 11, fontSize: 12.5, fontWeight: 700, color: "var(--ink2)", background: "var(--sur2)" },
  osegOn: { background: "var(--coral)", color: "var(--coralink)" },
  custBtn: { flex: 1, background: "var(--sur2)", borderRadius: 11, padding: "10px 12px", fontSize: 12.5, color: "var(--ink2)", fontWeight: 600 },
  trow: { display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--ink2)", fontWeight: 600, padding: "3px 0" },
  disc: { display: "inline-block", margin: "4px 0", fontSize: 11.5, fontWeight: 700, color: "var(--coral)", background: "var(--coralsoft)", borderRadius: 999, padding: "4px 10px" },
  act: { width: 46, height: 46, borderRadius: 13, background: "var(--sur2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink2)", fontSize: 16 },
  charge: { flex: 1, borderRadius: 13, background: "var(--coral)", color: "var(--coralink)", fontWeight: 800, fontSize: 15, boxShadow: "0 8px 20px -6px rgba(225,85,45,.5)" },
  overlay: { position: "fixed", inset: 0, background: "rgba(20,18,15,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40, animation: "fade .2s" },
  sheet: { background: "var(--bg)", borderRadius: 22, padding: 22, boxShadow: "var(--shadow)", animation: "sheet .3s cubic-bezier(.2,.9,.3,1.1)" },
  method: { padding: "12px 6px", borderRadius: 12, background: "var(--sur)", border: "1px solid var(--line)", fontWeight: 700, fontSize: 13 },
  methodOn: { background: "var(--coralsoft)", borderColor: "var(--coral)", color: "var(--coral)" },
  shiftBar: { width: "100%", textAlign: "start", borderRadius: 14, padding: "11px 16px", background: "var(--ambersoft)", border: "1px solid color-mix(in srgb,var(--amber) 32%,transparent)", color: "var(--amber)", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  input: { padding: "11px 13px", borderRadius: 11, border: "1px solid var(--line)", background: "var(--sur)", color: "var(--ink)", fontSize: 14, outline: "none", flex: 1 },
  chipSm: { padding: "8px 14px", borderRadius: 11, background: "var(--coral)", color: "var(--coralink)", fontWeight: 700, fontSize: 13 },
  discChip: { padding: "7px 13px", borderRadius: 999, background: "var(--sur2)", border: "1px solid var(--line)", fontWeight: 700, fontSize: 12.5, color: "var(--ink)" },
  receipt: { background: "#fff", color: "#111", borderRadius: 14, padding: 18, fontFamily: "ui-monospace,Menlo,monospace", boxShadow: "var(--shadow)" },
};
