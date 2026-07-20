import { useEffect, useMemo, useRef, useState } from "react";
import { store, useStore } from "./store";
import { elevate, hashPin, uid } from "./api";
import { Dashboard, Reports, Orders, Delivery, Tabs, QrOrders, Outlets, Setup } from "./screens";
import { GuestPortal } from "./guest";
import { t } from "./i18n";
import { IconBtn, Modal, Stepper, useToast } from "./ui";

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
/* Front-of-house tabs only (prototype register spec §2): Register · Floor ·
   Kitchen · QR Orders · Delivery · Tabs · Day End. Dashboard is kept for a
   shift-lead's at-a-glance day view. Everything else managerial (Analytics,
   Outlets, Inventory, Expenses, Staff, Configurations/Setup) lives in the
   master cockpit at /back — one tap away via the profile menu's Admin panel.
   Those screen components stay in the codebase (render switch below), just off
   the cashier's nav. */
const NAV = [
  { id: "sell", label: "Register", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h3"/>' },
  { id: "floor", label: "Floor", icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { id: "kitchen", label: "Kitchen", icon: '<path d="M6 3v7a3 3 0 0 0 6 0V3M9 3v18M18 3c-1.5 1-2 3-2 6s.5 4 2 5v7"/>' },
  { id: "qr", label: "QR Orders", icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v7M17 20h4"/>' },
  { id: "delivery", label: "Delivery", icon: '<path d="M3 7h11v8H3zM14 10h4l3 3v2h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>' },
  { id: "tabs", label: "Tabs", icon: '<path d="M3 6a2 2 0 0 1 2-2h9l4 4v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 12h6M8 16h4"/>' },
  { id: "dayend", label: "Day End", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  { id: "dashboard", label: "Dashboard", icon: '<path d="M3 13h8V3H3zM13 21h8v-6h-8zM13 11h8V3h-8zM3 21h8v-6H3z"/>' },
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
  /* Lock dashboard: store identity + live clock above the sign-in, adaptive to
     the device — staff cards flow into columns on tablet/desktop, keypad keys
     grow on big touch screens, and a hardware keyboard types the PIN. */
  const settings = st.byKind("settings")[0]?.data || {};
  const vw = useVW();
  const keySize = vw >= 760 ? 76 : 64;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(id); }, []);
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, pin]);
  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, padding: "calc(24px + var(--sat,0px)) 20px calc(24px + var(--sab,0px))" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ ...C.kchip, width: 52, height: 52, fontSize: 26, borderRadius: 16, margin: "0 auto 12px" }}>K</div>
        <div style={{ fontWeight: 800, fontSize: 20 }}>{settings.storeName || "KashikeyoPOS"}</div>
        <div className="num" style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.15, marginTop: 6 }}>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        <div style={{ color: "var(--ink2)", fontSize: 13, marginTop: 2 }}>{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</div>
        <div style={{ color: "var(--ink2)", fontSize: 13, marginTop: 10 }}>{sel ? "Enter your PIN" : "Who's on the till?"}</div>
      </div>
      {!sel ? (
        <div style={{ display: "grid", gridTemplateColumns: users.length > 1 ? "repeat(auto-fill,minmax(230px,1fr))" : "1fr", gap: 10, width: "min(720px, 94vw)", maxWidth: users.length > 1 ? undefined : 340 }}>
          {users.map((u) => (
            <button key={u.id} onClick={() => setSel(u)} style={{ ...C.card, display: "flex", alignItems: "center", gap: 12, minHeight: "var(--tap-lg)", padding: "12px 14px", textAlign: "left" }}>
              <span style={{ ...C.avatar, width: 36, height: 36, fontSize: 14, background: "var(--green)" }}>{(u.name || "?")[0].toUpperCase()}</span>
              <b style={{ flex: 1, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</b><small style={{ color: "var(--ink2)" }}>{u.role}</small>
            </button>
          ))}
          {users.length === 0 && <button onClick={() => { store.cursor = 0; store.pullAll(); }} style={{ ...C.card, padding: "14px 16px", color: "var(--ink2)", fontSize: 13, fontWeight: 600 }}>No staff synced yet — tap to retry sync</button>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, animation: err ? "shake .4s" : undefined }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ ...C.avatar, background: "var(--green)" }}>{(sel.name || "?")[0].toUpperCase()}</span>
            <b>{sel.name}</b>{users.length > 1 && <button onClick={() => { setSel(null); setPin(""); }} style={{ color: "var(--coral-text)", fontSize: 12, fontWeight: 700, minHeight: 32, padding: "0 6px" }}>Switch</button>}
          </div>
          <div style={{ display: "flex", gap: 12 }}>{[0, 1, 2, 3].map((i) => (
            <span key={i} style={{ width: 14, height: 14, borderRadius: 99, background: i < pin.length ? "var(--coral)" : "var(--sur2)", border: "1px solid var(--line)" }} />
          ))}</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(3,${keySize}px)`, gap: vw >= 760 ? 12 : 10 }}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((d, i) => d === "" ? <span key={i} /> : (
              <button key={i} aria-label={d === "⌫" ? "Delete digit" : d} onClick={() => d === "⌫" ? setPin(pin.slice(0, -1)) : press(d)} style={{ ...C.key, height: keySize - 4 }}>{d}</button>
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
  const [lang, setLang] = useState<"en" | "dv">(() => {
    try { const v = localStorage.getItem("kashikeyo-lang"); if (v === "dv" || v === "en") return v; } catch { /* ignore */ }
    return (typeof document !== "undefined" && document.documentElement.dir === "rtl") ? "dv" : "en";
  });
  useEffect(() => { if (typeof document !== "undefined") document.documentElement.dir = lang === "dv" ? "rtl" : "ltr"; try { localStorage.setItem("kashikeyo-lang", lang); } catch { /* ignore */ } }, [lang]);
  /* Register number is per-DEVICE (localStorage), not a synced setting — each
     till device carries its own number so their Z-reports / receipts don't
     collide. Set it on the device via the profile menu. */
  const [registerNo, setRegisterNo] = useState<number>(() => { try { return Math.max(1, Number(localStorage.getItem("kashikeyo-register-no")) || 1); } catch { return 1; } });
  const saveRegisterNo = (n: number) => { const v = Math.max(1, Math.floor(Number(n)) || 1); setRegisterNo(v); try { localStorage.setItem("kashikeyo-register-no", String(v)); } catch { /* ignore */ } };
  const [regModal, setRegModal] = useState(false);
  /* Module-5 flows: void-after-KOT (reason, no PIN), staff-discount approval
     (manager password on EVERY register chip; back-office/product pricing is
     untouched), and drawer paid-outs (expense tied to the open shift). */
  const [resumedOrderId, setResumedOrderId] = useState<string | null>(null);
  const [voidReq, setVoidReq] = useState<{ key: string; pid: string; name: string } | null>(null);
  const [discReq, setDiscReq] = useState<number | null>(null);
  const [discAuth, setDiscAuth] = useState<any>(null);
  const [paidOutModal, setPaidOutModal] = useState(false);
  const T = (s: string) => t(s, lang);
  const nm = (p: any) => (lang === "dv" && p && p.dv) ? p.dv : (p ? (p.name || "") : "");
  const vw = useVW();
  const mob = vw < 760;
  const tab = vw >= 760 && vw < 1100;
  /* Open Bills placement (prototype §1): full rail at >=1120 — rendered even
     when empty so holding the first bill never reflows the menu mid-service;
     below 1120 held bills surface as a horizontal strip above the search bar. */
  const showRail = vw >= 1120;
  const toast = useToast();
  const sector: "general" | "tourism" = gstBp >= 1600 ? "tourism" : "general";
  const toggleLang = () => setLang((l) => (l === "en" ? "dv" : "en"));
  /* GST sector (general/tourism) is configured in the back office at store
     setup and published to the till via settings.gstBp — the register no
     longer toggles it. `sector` is still derived for the totals GST label. */
  const parked = st.byKind("parked").map((e) => e.data).sort((a, b) => (a.t || 0) - (b.t || 0));
  const orders = st.byKind("orders").map((e) => e.data);
  const orderNo = "#" + String(st.byKind("sales").length + parked.length + 1).padStart(4, "0");

  const shifts = st.byKind("shifts").map((e) => e.data);
  const openShift = shifts.find((s) => !s.closedAt) || null;

  const products = st.byKind("products").map((e) => e.data).filter((p) => p && !p.archived);
  const bestIds = useBestSellers();
  const clock = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + ", " + now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const subInGroup = (cat: string) => group === "all" || (groups.find((g) => g.name === group)?.subs || []).includes(cat);
  const codeOf = (p: any) => String(p.barcode || p.sku || p.code || "").toLowerCase();
  const items = products.filter((p) => subInGroup(p.cat) && (!query || (p.name || "").toLowerCase().includes(query.toLowerCase()) || (codeOf(p) && codeOf(p).includes(query.toLowerCase()))));

  const [modProd, setModProd] = useState<any>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  /* Resolve a scanned/typed code to a product: exact barcode/sku/id, else the
     sole name/code match currently on screen. */
  const findByCode = (raw: string): any => {
    const c = raw.trim().toLowerCase();
    if (!c) return null;
    const exact = products.find((p) => codeOf(p) === c || String(p.id).toLowerCase() === c);
    if (exact) return exact;
    const hits = items.filter((p) => (p.name || "").toLowerCase().includes(c) || (codeOf(p) && codeOf(p).includes(c)));
    return hits.length === 1 ? hits[0] : null;
  };
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
    /* Assign a persisted Z-report number: Z-R{register}-{seq}. The register
       number is this device's own (localStorage); the sequence is monotonic
       PER register (highest issued on this register + 1), so two devices in
       the same store keep independent, non-colliding Z-report runs. */
    const reg = registerNo;
    const seq = shifts.filter((s) => (Number(s.zReg) || 1) === reg).reduce((mx, s) => Math.max(mx, Number(s.zSeq) || 0), 0) + 1;
    const zNo = "Z-R" + reg + "-" + String(seq).padStart(5, "0");
    store.commit([{ kind: "shifts", id: openShift.id, data: { ...openShift, closedAt: Date.now(), countedCash: counted, expectedCash: expected, zNo, zSeq: seq, zReg: reg } }]);
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
      /* every staff discount carries its manager approval (who/when/how) */
      discountAuth: totals.disc > 0 ? (discAuth || null) : null,
      payments, change, refunded: false,
    };
    store.commit([{ kind: "sales", id: sale.id, data: sale }]);
    setReceipt({ sale, change, settings, registerNo });
    resetBill(); setPay(false);
  };

  const resetBill = () => { setCart([]); setDisc(0); setDiscPct(0); setCust(null); setTable(""); setZone(null); setDeliveryNote(""); setResumedOrderId(null); setDiscAuth(null); };
  /* Reducing a line on a bill already fired to the kitchen goes through the
     void-reason flow; pre-KOT edits stay instant. */
  const requestDec = (key: string, pid: string, name: string) => {
    if (resumedOrderId) setVoidReq({ key, pid, name });
    else bump(key, -1);
  };
  const dropOneGuard = (p: any) => {
    if (!resumedOrderId) { dropOne(p.id); return; }
    for (let i = cart.length - 1; i >= 0; i--) if (cart[i].pid === p.id) { setVoidReq({ key: cart[i].key, pid: p.id, name: p.name || "item" }); return; }
  };
  const confirmVoid = (reason: string) => {
    if (!voidReq) return;
    bump(voidReq.key, -1);
    /* record the void on the fired order so the kitchen + Z-report see it */
    const o = orders.find((x) => x.id === resumedOrderId);
    if (o) {
      let took = false;
      const lines = (o.lines || []).map((l: any) => { if (!took && l.pid === voidReq.pid && (l.qty || 0) > 0) { took = true; return { ...l, qty: l.qty - 1 }; } return l; }).filter((l: any) => (l.qty || 0) > 0);
      const voids = [...(o.voids || []), { pid: voidReq.pid, name: voidReq.name, qty: 1, reason, at: Date.now(), by: user.name }];
      store.commit([{ kind: "orders", id: o.id, data: { ...o, lines, voids } }]);
    }
    toast("Removed " + voidReq.name + " · " + reason);
    setVoidReq(null);
  };
  /* Drawer paid-out: requires an open shift (it must land on a Z-report). */
  const openPaidOut = () => { if (!openShift) { toast("Open a shift first"); setShiftModal(true); return; } setPaidOutModal(true); };
  const recordPaidOut = (amount: number, reason: string, note: string) => {
    if (!openShift) return;
    const e = { id: uid(), t: Date.now(), type: "paidout", amount, reason, note, shiftId: openShift.id, storeId: settings.storeId || "main", userName: user.name };
    store.commit([{ kind: "expenses", id: e.id, data: e }]);
    toast("Paid out " + money(amount) + " · " + reason);
    setPaidOutModal(false);
  };
  const shiftPaidOut = openShift ? st.byKind("expenses").map((e) => e.data).filter((e: any) => e.shiftId === openShift.id).reduce((a: number, e: any) => a + (e.amount || 0), 0) : 0;

  const park = () => {
    if (!cart.length) return;
    const bill = { id: uid(), t: Date.now(), otype, table: table || null, lines: cart, disc, discPct, discAuth: discAuth || undefined, customerId: cust?.id || null, custName: cust?.name || null, userName: user.name, storeId: settings.storeId || "main", orderId: resumedOrderId || undefined };
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
    const bill = { id: uid(), t: Date.now(), otype, table: table || null, lines: cart, disc, discPct, discAuth: discAuth || undefined, customerId: cust?.id || null, custName: cust?.name || null, userName: user.name, storeId: settings.storeId || "main", orderId: oid, no: orderNo };
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
    setResumedOrderId(bill.orderId || null); setDiscAuth(bill.discAuth || null);
    store.del([{ kind: "parked", id: bill.id }]);
  };

  /* Left rail — the open bills (held + KOT-fired). The card in progress shows
     first (highlighted); tapping a parked bill resumes it into the register. A
     linked kitchen order lends its live status (In kitchen / Ready). */
  const kotStatusOf = (b: any): [string, string] => {
    if (b.orderId) {
      const o = orders.find((x) => x.id === b.orderId);
      const s = (o?.status || "new").toLowerCase();
      if (s === "ready") return [T("Ready"), "var(--green)"];
      if (s === "delivered" || s === "done") return [T("Served"), "var(--ink3)"];
      return [T("In kitchen"), "var(--amber)"];
    }
    return [T("Open"), "var(--ink3)"];
  };
  const otypeLabelOf = (t: string) => t === "dinein" ? T("Dine-In") : t === "delivery" ? T("Delivery") : T("Takeaway");
  /* Deleting a held bill is recoverable, not confirmable — an Undo toast keeps
     service fast while closing the old silent-destroy trap. */
  const delBill = (b: any) => {
    store.del([{ kind: "parked", id: b.id }]);
    toast(T("Bill deleted") + (b.no ? " · " + b.no : ""), { label: T("Undo"), fn: () => store.commit([{ kind: "parked", id: b.id, data: b }]) });
  };
  const billsRailInner = (
    <div style={C.railWrap} className="glass">
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 14px 8px" }}>
        <div style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>🧾 {T("Open Bills")}</div>
        <span style={{ fontSize: 11, fontWeight: 800, background: "var(--sur2)", color: "var(--ink2)", borderRadius: 999, padding: "2px 9px" }} className="num">{parked.length + (count ? 1 : 0)}</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "2px 10px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
        {count > 0 && (
          <div style={{ ...C.railCard, borderColor: "var(--coral)", background: "var(--coralsoft)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <b style={{ fontSize: 13, flex: 1 }}>{otypeLabelOf(otype)} · <span className="num">{orderNo}</span></b>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink2)", marginTop: 2 }}>{cust?.name || T("Walk-in")}{otype === "dinein" && table ? " · T" + table : ""}</div>
            <div style={{ marginTop: 7 }}><span style={{ ...C.stag, color: "var(--coral-text)", background: "var(--sur)" }}>● {T("In progress")}</span></div>
          </div>
        )}
        {parked.slice().reverse().map((b) => {
          const [label, col] = kotStatusOf(b);
          const items = (b.lines || []).reduce((a: number, l: any) => a + (l.qty || 0), 0);
          const mins = Math.max(0, Math.floor((Date.now() - (b.t || Date.now())) / 60000));
          return (
            <div key={b.id} role="button" tabIndex={0} onClick={() => resume(b)} onKeyDown={(e) => { if (e.key === "Enter") resume(b); }} style={{ ...C.railCard }} title="Resume this bill">
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <b style={{ fontSize: 13, flex: 1, textAlign: "start" }}>{otypeLabelOf(b.otype)} · <span className="num">{b.no || ("#" + items)}</span></b>
                <IconBtn label={T("Delete bill")} size={36} tone="danger" style={{ background: "transparent", fontSize: 13 }}
                  onClick={(e) => { e.stopPropagation(); delBill(b); }}>✕</IconBtn>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink2)", marginTop: 2, textAlign: "start" }}>{b.custName || T("Walk-in")}{b.otype === "dinein" && b.table ? " · T" + b.table : ""}</div>
              <div style={{ display: "flex", alignItems: "center", marginTop: 7 }}>
                <span style={{ ...C.stag, color: col, background: "var(--sur2)" }}>● {label}</span>
                <div style={{ flex: 1 }} />
                <span className="num" style={{ fontSize: 10.5, color: "var(--ink3)" }}>{mins}m</span>
              </div>
            </div>
          );
        })}
        {parked.length === 0 && count === 0 && (
          <div style={{ color: "var(--ink3)", fontSize: 12, textAlign: "center", padding: "26px 12px" }}>{T("No open bills. Held and kitchen-fired orders show up here.")}</div>
        )}
      </div>
      <button onClick={resetBill} style={{ ...C.obill, borderStyle: "dashed", color: "var(--ink2)", margin: "0 10px 10px", textAlign: "center" }}>＋ {T("New bill")}</button>
    </div>
  );

  const cartInner = (
    <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 16px 10px" }}>
                <div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>{T("Order")} <span className="num" style={{ color: "var(--ink3)", fontWeight: 700, marginInlineStart: 2 }}>{orderNo}</span></div>
                <button onClick={park} disabled={!count} style={{ ...C.pill, cursor: "pointer", opacity: count ? 1 : .5 }} title="Hold this bill">{T("Hold")}</button>
                <button onClick={resetBill} style={{ ...C.pill, cursor: "pointer" }} title="Clear the register">{T("Clear")}</button>
                {mob && <button onClick={() => setCartOpen(false)} style={{ ...C.act, width: 34, height: 34, fontSize: 14 }}>✕</button>}
              </div>
              <div style={{ padding: "0 14px 10px" }}>
                <div style={{ display: "flex", gap: 3, background: "var(--sur2)", borderRadius: 12, padding: 3 }}>
                  {([["dinein", "Dine-In"], ["takeaway", "Takeaway"], ["delivery", "Delivery"]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => pickOtype(k)} style={{ flex: 1, padding: "8px 6px", borderRadius: 9, fontSize: 12.5, fontWeight: 800, cursor: "pointer", ...(otype === k ? { background: "var(--sur)", color: "var(--coral-text)", boxShadow: "0 1px 3px rgba(30,35,45,.12)" } : { color: "var(--ink2)" }) }}>{T(l)}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, padding: "0 14px 10px", alignItems: "stretch" }}>
                <button onClick={() => setCustPick(true)} style={{ ...C.custBtn, flex: 1, minWidth: 0, display: "flex", alignItems: "center", ...(cust ? { background: "var(--coralsoft)", color: "var(--coral-text)" } : {}) }}>👤 <span style={{ flex: 1, minWidth: 0, textAlign: "start", marginInlineStart: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cust ? cust.name : T("Add customer")}</span>{cust && <span role="button" aria-label="Remove customer" onClick={(e) => { e.stopPropagation(); setCust(null); }} style={{ padding: "12px 10px", margin: "-12px -10px", display: "inline-flex" }}>✕</span>}</button>
                {otype === "dinein" && <button onClick={() => setTablePick(true)} style={{ ...C.custBtn, flex: 1, minWidth: 0, display: "flex", alignItems: "center", ...(table ? { background: "var(--coralsoft)", color: "var(--coral-text)" } : {}) }}>🖥 <span style={{ flex: 1, minWidth: 0, textAlign: "start", marginInlineStart: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{table ? T("Table") + " " + table : T("Select table")}</span><span style={{ opacity: .6 }}>▾</span></button>}
                {otype === "delivery" && <button onClick={() => setZonePick(true)} style={{ ...C.custBtn, flex: 1, minWidth: 0, textAlign: "start", lineHeight: 1.25, overflow: "hidden", ...(zone || deliveryNote ? { background: "var(--coralsoft)", color: "var(--coral-text)" } : {}) }}>🛵 <b style={{ fontWeight: 700 }}>{T("Delivery details")}</b><br /><small style={{ opacity: .8, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{zone ? zone.name + (zone.fee ? " · " + money(zone.fee) : "") : T("zone · address")}</small></button>}
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "2px 12px", borderTop: "1px solid var(--line)", minHeight: mob ? 120 : 0 }}>
                {cart.length === 0 ? (
                  <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--ink3)", gap: 10, padding: "30px 0" }}><div style={{ fontSize: 30 }}>🛒</div><div style={{ fontSize: 13 }}>{T("Scan or tap a product to start")}</div></div>
                ) : cart.map((l) => {
                  const p = prodById(l.pid); if (!p) return null; const t = tintFor(p.cat); const u = lineUnit(l);
                  return (
                    <div key={l.key} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 4px", animation: "rise .25s both" }}>
                      <span style={{ width: 32, height: 32, borderRadius: 999, background: t[0], color: t[1], display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13, flex: "0 0 32px" }}>{(p.name || "?")[0].toUpperCase()}</span>
                      <div style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 13, fontWeight: 700, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nm(p)}</b><small style={{ fontSize: 11, color: "var(--ink2)" }}>{(l.mods || []).length ? (l.mods || []).map((m) => m.name).join(" · ") : money(u) + " " + T("each")}</small></div>
                      <Stepper value={l.qty} onDec={() => requestDec(l.key, l.pid, prodById(l.pid)?.name || "item")} onInc={() => bump(l.key, 1)} decLabel="Remove one" incLabel="Add one" />
                      <span className="num" style={{ fontWeight: 800, fontSize: 13, minWidth: 58, textAlign: "right" }}>{money(u * l.qty)}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ borderTop: "1px solid var(--line)", padding: "12px 16px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingBottom: 10, marginBottom: 8, borderBottom: "1px dashed var(--line)" }}>
                  <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", color: "var(--ink2)", marginInlineEnd: 2 }}>{T("DISCOUNT")}</span>
                  {[0, 5, 10, 15, 20].map((pct) => {
                    const on = pct === 0 ? !totals.disc : discPct === pct;
                    return <button key={pct} onClick={() => { if (pct === 0) { setDisc(0); setDiscPct(0); setDiscAuth(null); } else { setDiscReq(pct); } }} style={{ border: "1px solid " + (on ? "var(--coral)" : "var(--line)"), borderRadius: 99, padding: "4px 11px", fontSize: 11, fontWeight: 800, cursor: "pointer", background: on ? "var(--coralsoft)" : "transparent", color: on ? "var(--coral)" : "var(--ink2)" }}>{pct === 0 ? T("None") : pct + "%"}</button>;
                  })}
                </div>
                {totals.disc > 0 && <div style={C.trow}><span>{T("Subtotal")}</span><span className="num">{money(totals.subtotal)}</span></div>}
                {totals.disc > 0 && <div style={{ ...C.trow, color: "var(--coral-text)" }}><span>{T("Discount")} {discPct ? discPct + "%" : ""}</span><span className="num">−{money(totals.disc)}</span></div>}
                <div style={C.trow}><span>{T("Before GST")}</span><span className="num">{money(totals.excl)}</span></div>
                {totals.svc > 0 && <div style={C.trow}><span>{T("Service charge")} {svcBp / 100}%</span><span className="num">{money(totals.svc)}</span></div>}
                <div style={C.trow}><span style={{ whiteSpace: "nowrap" }}>{T("GST")} {sector === "tourism" ? "TGST 17%" : "GGST 8%"}</span><span className="num">{money(totals.gst)}</span></div>
                {totals.fee > 0 && <div style={C.trow}><span>{T("Delivery")}{zone?.name ? " · " + zone.name : ""}</span><span className="num">{money(totals.fee)}</span></div>}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 0 12px" }}><span style={{ fontWeight: 800, fontSize: 13 }}>{T("Total")}</span><span className="num" style={{ fontFamily: "var(--num)", fontWeight: 800, fontSize: 26 }}>{money(totals.total)}</span></div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button style={{ ...C.kot, opacity: count ? 1 : .5 }} disabled={!count} title="Fire this order to the kitchen" onClick={sendKOT}>{T("Send to kitchen")}</button>
                  <button style={{ ...C.charge, opacity: count ? 1 : .5, padding: 14 }} disabled={!count} onClick={() => { setCartOpen(false); openShift ? setPay(true) : setShiftModal(true); }}>{T("Charge")}</button>
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
        <span style={{ fontSize: 11, fontWeight: 800, background: "var(--coralsoft)", color: "var(--coral-text)", borderRadius: 999, padding: "4px 10px" }}>{occN} occupied</span>
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
                {occ && !b.active && (b.orderId
                  /* the tile carries the live kitchen state (spec §3 floor) */
                  ? (() => { const [lbl, col] = kotStatusOf(b); return <span style={{ fontSize: 10, fontWeight: 800, color: col }}>● {lbl}</span>; })()
                  : <span style={{ fontSize: 10, fontWeight: 800, color: "var(--amber)" }}>● held</span>)}
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
      <div style={{ ...deCard, display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--ink2)", textTransform: "uppercase", letterSpacing: ".04em" }}>Paid out this shift</div>
          <div className="num" style={{ fontSize: 22, fontWeight: 800, marginTop: 2 }}>{money(shiftPaidOut)}</div>
        </div>
        <button onClick={openPaidOut} style={{ ...C.kot, flex: "0 0 auto", minHeight: "var(--tap)", padding: "0 18px" }}>💸 Record paid-out</button>
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
          <div style={{ flex: 1 }} />
          {!mob && <span className="num" style={{ fontSize: 13, color: "var(--ink2)" }}>{clock}</span>}
          {!mob && <StatusPill />}
          <button onClick={() => openShift ? setZModal(true) : setShiftModal(true)} style={{ ...C.pill, cursor: "pointer", color: openShift ? "var(--green)" : "var(--amber)", padding: "6px 11px" }} title={openShift ? "Close shift (Z-report)" : "Open a shift"}>
            <i style={{ ...C.dot, background: openShift ? "var(--green)" : "var(--amber)" }} />{mob ? "" : (openShift ? T("Shift open") : T("Open shift"))}
          </button>
          <ProfileMenu user={user} mob={mob} lang={lang} registerNo={registerNo} onEditRegister={() => setRegModal(true)} onPaidOut={openPaidOut} onToggleLang={toggleLang} onSignOut={onSignOut} />
        </header>

        <nav style={mob ? C.navrowM : C.navrow} className="glass">
          {NAV.map((n) => {
            const on = nav === n.id;
            return (
              <button key={n.id} onClick={() => { if (n.to) { window.location.href = n.to; return; } setNav(n.id); }} style={{ ...C.npill, ...(on ? C.npillOn : {}) }} aria-current={on ? "page" : undefined} title={T(n.label)}>
                <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: n.icon }} />
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{T(n.label)}</span>
              </button>
            );
          })}
        </nav>

        {nav === "sell" ? (
          <div style={{ ...C.body, gap: mob ? 0 : 12 }}>
            {showRail && billsRailInner}
            <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 11, paddingBottom: mob && count > 0 ? 66 : 0 }}>
              {!openShift && (
                <button onClick={() => setShiftModal(true)} style={C.shiftBar}>🕓 No shift open — tap to open one before taking payments</button>
              )}
              {!showRail && parked.length > 0 && (
                /* Compact held-bills strip (tablet/mobile) — the rail's little
                   sibling: tap a pill to resume that bill into the register. */
                <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2, flex: "0 0 auto" }}>
                  {parked.slice().reverse().map((b) => {
                    const [label, col] = kotStatusOf(b);
                    return (
                      <button key={b.id} onClick={() => resume(b)} style={{ ...C.obill, minHeight: 44, display: "inline-flex", alignItems: "center", gap: 7, flex: "0 0 auto" }}>
                        <i style={{ ...C.dot, background: col }} />
                        <span className="num">{b.no || "•"}</span>
                        <span style={{ color: "var(--ink2)", fontWeight: 600 }}>{otypeLabelOf(b.otype)}{b.otype === "dinein" && b.table ? " · T" + b.table : ""}</span>
                        <span style={{ color: col, fontSize: 10.5, fontWeight: 800 }}>{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <div style={C.search}>
                  <svg viewBox="0 0 24 24" width={17} height={17} style={{ color: "var(--ink3)" }}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
                  <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { const p = findByCode(query); if (p) { tapProduct(p); setQuery(""); } } }}
                    placeholder={T("Search or type barcode…")} style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 14 }} />
                </div>
                <button style={C.scan} onClick={() => {
                  if (typeof (window as any).BarcodeDetector === "function") { setScanOpen(true); }
                  else { searchRef.current?.focus(); }
                }}>📷 {T("Scan")}</button>
              </div>
              <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2 }}>
                <button onClick={() => setGroup("all")} style={{ ...C.chip, ...(group === "all" ? C.chipOn : {}) }}>{T("All")}</button>
                {groups.map((g) => <button key={g.name} onClick={() => setGroup(g.name)} style={{ ...C.chip, ...(group === g.name ? C.chipOn : {}) }}>{T(g.name)}</button>)}
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
                          {p.rating && <span style={{ position: "absolute", bottom: 7, insetInlineEnd: 8, fontSize: 10, fontWeight: 800, background: "rgba(20,18,15,.55)", color: "#fff", borderRadius: 999, padding: "2px 8px", backdropFilter: "blur(2px)", display: "inline-flex", alignItems: "center", gap: 3 }}><span style={{ color: "#FFC94D" }}>★</span><span className="num">{p.rating}</span>{p.rn ? <span style={{ opacity: .7, fontWeight: 700 }} className="num">({p.rn})</span> : null}</span>}
                          {hasMods(p) && <span style={{ position: "absolute", bottom: 7, insetInlineStart: 8, fontSize: 9.5, fontWeight: 800, background: "rgba(20,18,15,.55)", color: "#fff", borderRadius: 999, padding: "2px 8px", backdropFilter: "blur(2px)" }}>options</span>}
                          {q > 0 && <span style={{ position: "absolute", top: 7, insetInlineStart: 8, minWidth: 20, height: 20, borderRadius: 999, background: "var(--coral)", color: "var(--coralink)", fontSize: 11.5, fontWeight: 800, display: "grid", placeItems: "center", padding: "0 6px" }} className="num">{q}</span>}
                        </div>
                        <div style={C.tbody}>
                          {p.tag && <div style={C.ttag}>{T(p.tag)}</div>}
                          <div style={C.tname}>{nm(p)}</div>
                          {p.desc && <div style={C.tdesc}>{T(p.desc)}</div>}
                          <div style={{ flex: 1 }} />
                          <div style={C.tfoot}>
                            <span className="num" style={{ fontSize: 14, fontWeight: 800 }}><small style={{ fontSize: 9.5, color: "var(--ink3)", fontWeight: 700, marginInlineEnd: 3 }}>MVR</small>{(p.price / 100).toFixed(2)}</span>
                            {q > 0
                              ? <span style={C.stepper} onClick={(e) => e.stopPropagation()}><button aria-label="Remove one" style={C.stepBtn} onClick={() => dropOneGuard(p)}>−</button><span className="num" style={{ minWidth: 15, textAlign: "center", fontWeight: 800 }}>{q}</span><button aria-label="Add one" style={C.stepBtn} onClick={() => tapProduct(p)}>+</button></span>
                              : <button aria-label={"Add " + (p.name || "item")} style={C.plus} onClick={(e) => { e.stopPropagation(); tapProduct(p); }}>+</button>}
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
        ) : nav === "floor" ? floorInner : nav === "dayend" ? dayEndInner : nav === "kitchen" ? <Orders /> : nav === "dashboard" ? <Dashboard /> : nav === "analytics" ? <Reports /> : nav === "delivery" ? <Delivery /> : nav === "tabs" ? <Tabs /> : nav === "qr" ? <QrOrders /> : nav === "outlets" ? <Outlets /> : nav === "setup" ? <Setup /> : <Placeholder nav={nav} />}
      {scanOpen && <ScanModal onClose={() => setScanOpen(false)} onDetect={(code) => { const p = findByCode(code); if (p) { setScanOpen(false); tapProduct(p); } }} />}
      {modProd && <ModifierModal product={modProd} onClose={() => setModProd(null)} onAdd={(mods) => { addLine(modProd, mods); setModProd(null); }} />}
      {pay && <PaySheet total={totals.total} currency={currency} hasCustomer={!!cust} custName={cust?.name} onClose={() => setPay(false)} onDone={onCharged} />}
      {custPick && <CustomerPicker customers={st.byKind("customers").map((e) => e.data)} onPick={(c) => { setCust(c); setCustPick(false); }} onClose={() => setCustPick(false)} />}
      {tablePick && <TablePicker tables={st.byKind("tables").map((e) => e.data)} current={table} onPick={(name) => { setTable(name); setOtype("dinein"); setTablePick(false); }} onClear={() => { setTable(""); setOtype("takeaway"); setTablePick(false); }} onClose={() => setTablePick(false)} />}
      {zonePick && <DeliveryDetails zones={st.byKind("zones").map((e) => e.data)} current={zone} note={deliveryNote} setNote={setDeliveryNote} custName={cust?.name} onPick={(z) => setZone(z)} onClear={() => setZone(null)} onAttachCustomer={() => { setZonePick(false); setCustPick(true); }} onClose={() => setZonePick(false)} />}
      {shiftModal && <ShiftModal user={user} shifts={shifts} T={T} onClose={() => setShiftModal(false)} onOpen={openShiftNow} />}
      {zModal && openShift && <ZModal shift={openShift} sales={st.byKind("sales").map((e) => e.data)} expenses={st.byKind("expenses").map((e) => e.data)} shifts={shifts} T={T} onClose={() => setZModal(false)} onCloseShift={closeShiftNow} />}
      {receipt && <Receipt data={receipt} gstBp={gstBp} onClose={() => setReceipt(null)} />}
      {regModal && <RegisterModal current={registerNo} T={T} onSave={(n) => { saveRegisterNo(n); setRegModal(false); }} onClose={() => setRegModal(false)} />}
      {voidReq && <VoidModal name={voidReq.name} onConfirm={confirmVoid} onClose={() => setVoidReq(null)} />}
      {discReq != null && <DiscountApproveModal pct={discReq} onApproved={() => { setDiscPct(discReq); setDisc(Math.round(totals.subtotal * discReq / 100)); setDiscAuth({ pct: discReq, method: "password", at: Date.now(), cashier: user.name }); setDiscReq(null); toast(discReq + "% discount approved"); }} onClose={() => setDiscReq(null)} />}
      {paidOutModal && <PaidOutModal onSave={recordPaidOut} onClose={() => setPaidOutModal(false)} />}
    </div>
  );
}

/* ── camera barcode scanner (uses the native BarcodeDetector) ───────────────
   Opens the rear camera, polls frames for a barcode, and reports the first
   code it reads. Falls back to a clear message if the camera can't start. */
function ScanModal({ onClose, onDetect }: { onClose: () => void; onDetect: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let stream: MediaStream | null = null, raf = 0, stopped = false, det: any = null;
    try { det = new (window as any).BarcodeDetector(); } catch { setErr("This device can't scan barcodes with the camera."); return; }
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current!; v.srcObject = stream; await v.play();
        const tick = async () => {
          if (stopped) return;
          try { const codes = await det.detect(v); if (codes && codes[0] && codes[0].rawValue) { onDetect(String(codes[0].rawValue)); return; } } catch { /* frame not ready */ }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch { setErr("Couldn't open the camera. Check the browser's camera permission."); }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  }, [onDetect]);
  return (
    <Modal title="Scan a barcode" onClose={onClose}>
      {err
        ? <div style={{ color: "var(--ink2)", fontSize: 13, padding: "18px 4px" }}>{err} You can still type the code into the search box.</div>
        : <><div style={{ borderRadius: 14, overflow: "hidden", background: "#000", aspectRatio: "4 / 3" }}>
            <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
          <div style={{ color: "var(--ink2)", fontSize: 12.5, marginTop: 10, textAlign: "center" }}>Point the camera at the product barcode.</div></>}
    </Modal>
  );
}

/* ── shift open / close (Z-report) + receipt ───────────────────────────────── */
type Tr = (s: string) => string;
/* MVR-prefixed money input, matching the drawer-count field in the design. */
const MoneyField = ({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 13, padding: "0 14px", height: 54 }}>
    <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink3)" }}>MVR</span>
    <input autoFocus={autoFocus} type="number" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className="num" style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 22, fontWeight: 800, minWidth: 0 }} />
  </div>
);
/* Recent Z-reports — the last few closed shifts with their over/short. */
function RecentZ({ shifts, T }: { shifts: any[]; T: Tr }) {
  const closed = shifts.filter((s) => s.closedAt).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 3);
  if (!closed.length) return null;
  const asc = shifts.filter((x) => x.closedAt).sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  const zLabel = (s: any) => s.zNo || ("Z-R1-" + String(asc.indexOf(s) + 1).padStart(5, "0"));
  return (
    <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: "var(--ink3)", marginBottom: 8 }}>{T("Recent Z-reports")}</div>
      {closed.map((s) => { const os = (s.countedCash || 0) - (s.expectedCash || 0); return (
        <div key={s.id} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "3px 0", fontSize: 12.5, color: "var(--ink3)" }}>
          <span>{zLabel(s)} · {s.userName || "—"}</span>
          <span className="num" style={{ color: Math.abs(os) < 50 ? "var(--ink3)" : os < 0 ? "var(--red)" : "var(--ink2)" }}>{os < 0 ? "−" : ""}{money(Math.abs(os)).replace("MVR ", "")} o/s</span>
        </div>
      ); })}
    </div>
  );
}
function ShiftModal({ user, shifts, T, onClose, onOpen }: { user: any; shifts: any[]; T: Tr; onClose: () => void; onOpen: (float: number) => void }) {
  const [v, setV] = useState("");
  return (
    <Modal title={T("Open shift")} onClose={onClose}>
      <div style={{ color: "var(--ink2)", fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>Count the opening float. Sales you take will be stamped to this shift under <b>{user.name}</b>.</div>
      <MoneyField value={v} onChange={setV} placeholder="1000.00" autoFocus />
      <button onClick={() => onOpen(Math.round(Number(v) * 100) || 0)} style={{ ...C.charge, width: "100%", minHeight: "var(--tap-lg)", marginTop: 14 }}>{T("Open shift")}</button>
      <RecentZ shifts={shifts} T={T} />
    </Modal>
  );
}
function ZModal({ shift, sales, expenses, shifts, T, onClose, onCloseShift }: { shift: any; sales: any[]; expenses: any[]; shifts: any[]; T: Tr; onClose: () => void; onCloseShift: (counted: number, expected: number) => void }) {
  const mine = sales.filter((s) => s.shiftId === shift.id && !s.refunded);
  const salesTotal = mine.reduce((a, s) => a + (s.total || 0), 0);
  const cashSales = mine.reduce((a, s) => a + (s.payments || []).filter((p: any) => /cash/i.test(p.method)).reduce((x: number, p: any) => x + (p.amount || 0), 0), 0);
  const paidOut = (expenses || []).filter((e) => e.shiftId === shift.id).reduce((a, e) => a + (e.amount || 0), 0);
  const expected = (shift.openingFloat || 0) + cashSales - paidOut;
  const [v, setV] = useState("");
  const counted = Math.round(Number(v) * 100) || 0;
  const variance = counted - expected;
  const openTime = shift.openedAt ? new Date(shift.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  return (
    <Modal title={T("Close shift")} onClose={onClose} width={460}>
      <Row2 k={T("Opened by")} v={(shift.userName || "—") + " · " + openTime} />
      <Row2 k={T("Opening float")} v={money(shift.openingFloat || 0)} />
      <Row2 k={T("Sales this shift")} v={money(salesTotal)} />
      <Row2 k={T("Paid out (expenses)")} v={money(paidOut)} bold />
      <Row2 k={T("Expected in drawer")} v={"MVR " + money(expected).replace("MVR ", "")} bold />
      <div style={{ color: "var(--ink2)", fontSize: 13, margin: "14px 0 8px" }}>Blind count — enter the cash actually in the drawer:</div>
      <MoneyField value={v} onChange={setV} placeholder="Counted cash…" autoFocus />
      {v !== "" && <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontWeight: 800, color: Math.abs(variance) < 50 ? "var(--green)" : "var(--red)" }}><span>{T("Variance")}</span><span className="num">{variance >= 0 ? "+" : "−"}{money(Math.abs(variance))}</span></div>}
      <button onClick={() => onCloseShift(counted, expected)} style={{ ...C.charge, width: "100%", minHeight: "var(--tap-lg)", marginTop: 14 }}>{T("Close shift")} (Z)</button>
      <RecentZ shifts={shifts} T={T} />
    </Modal>
  );
}
const Row2 = ({ k, v, bold }: { k: string; v: string; bold?: boolean }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13.5, fontWeight: bold ? 800 : 600, color: bold ? "var(--ink)" : "var(--ink2)" }}><span>{k}</span><span className="num">{v}</span></div>
);

/* Void a kitchen-fired item — quick reason, no PIN; recorded on the order so
   the kitchen and the Z-report both see what left the ticket and why. */
function VoidModal({ name, onConfirm, onClose }: { name: string; onConfirm: (reason: string) => void; onClose: () => void }) {
  const REASONS = ["Guest changed mind", "Kitchen error", "Out of stock", "Other"];
  const [sel, setSel] = useState(REASONS[0]);
  return (
    <Modal title="Remove sent item" onClose={onClose} width={420}>
      <div style={{ color: "var(--ink2)", fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}><b>{name}</b> was already sent to the kitchen. Pick a reason — it’s recorded on the order.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {REASONS.map((r) => (
          <button key={r} aria-pressed={sel === r} onClick={() => setSel(r)} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: "var(--tap)", padding: "0 14px", borderRadius: 13, border: "1.5px solid " + (sel === r ? "var(--coral)" : "var(--line)"), background: sel === r ? "var(--coralsoft)" : "var(--sur)", fontWeight: 700, fontSize: 13.5, color: sel === r ? "var(--coral-text)" : "var(--ink)" }}>{r}</button>
        ))}
      </div>
      <button onClick={() => onConfirm(sel)} style={{ width: "100%", minHeight: "var(--tap-lg)", marginTop: 14, borderRadius: 13, background: "var(--red)", color: "#fff", fontWeight: 800, fontSize: 15 }}>Remove item</button>
    </Modal>
  );
}

/* Manager approval for a staff discount — password verified server-side
   (same elevation as refunds); the approval is logged on the sale. */
function DiscountApproveModal({ pct, onApproved, onClose }: { pct: number; onApproved: () => void; onClose: () => void }) {
  const [pw, setPw] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true); setErr("");
    try { await elevate(pw); onApproved(); }
    catch (e: any) { setErr(e.message || "Wrong password"); setBusy(false); }
  };
  return (
    <Modal title={"Apply " + pct + "% discount"} onClose={onClose} width={420}>
      <div style={{ color: "var(--ink2)", fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>Staff discounts need manager approval — the approval is logged on the sale. Standing customer prices from the back office aren’t affected.</div>
      <label style={{ color: "var(--ink2)", fontSize: 12, fontWeight: 700 }}>STORE / MANAGER PASSWORD</label>
      <input autoFocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && pw) go(); }} style={{ ...C.input, width: "100%", marginTop: 6 }} />
      {err && <div style={{ color: "var(--red)", fontSize: 13, fontWeight: 700, marginTop: 8 }}>{err}</div>}
      <button disabled={!pw || busy} onClick={go} style={{ ...C.charge, width: "100%", minHeight: "var(--tap-lg)", marginTop: 14, opacity: (!pw || busy) ? .5 : 1 }}>{busy ? "Verifying…" : "Approve discount"}</button>
    </Modal>
  );
}

/* Drawer paid-out — cash out mid-shift, booked as an expense on the open
   shift so the Z-report's expected-in-drawer stays honest. */
function PaidOutModal({ onSave, onClose }: { onSave: (amount: number, reason: string, note: string) => void; onClose: () => void }) {
  const REASONS = ["Supplies", "Delivery", "Staff meal", "Other"];
  const [v, setV] = useState(""); const [reason, setReason] = useState(REASONS[0]); const [note, setNote] = useState("");
  const amt = Math.round(Number(v) * 100) || 0;
  return (
    <Modal title="Paid out" onClose={onClose} width={420}>
      <div style={{ color: "var(--ink2)", fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>Cash taken from the drawer — booked to this shift and deducted from the expected drawer count.</div>
      <MoneyField value={v} onChange={setV} placeholder="0.00" autoFocus />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "12px 0" }}>
        {REASONS.map((r) => <button key={r} aria-pressed={reason === r} onClick={() => setReason(r)} style={{ minHeight: 40, padding: "0 14px", borderRadius: 999, fontSize: 12.5, fontWeight: 700, border: "1px solid " + (reason === r ? "var(--coral)" : "var(--line)"), background: reason === r ? "var(--coralsoft)" : "var(--sur)", color: reason === r ? "var(--coral-text)" : "var(--ink2)" }}>{r}</button>)}
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note — what was it for? (optional)" style={{ ...C.input, width: "100%" }} />
      <button disabled={amt <= 0} onClick={() => onSave(amt, reason, note.trim())} style={{ ...C.charge, width: "100%", minHeight: "var(--tap-lg)", marginTop: 14, opacity: amt > 0 ? 1 : .5 }}>Record paid-out</button>
    </Modal>
  );
}

/* Per-device register number — stored locally so each till device carries its
   own; drives Z-report numbers and receipt doc numbers. */
function RegisterModal({ current, T, onSave, onClose }: { current: number; T: Tr; onSave: (n: number) => void; onClose: () => void }) {
  const [v, setV] = useState(String(current));
  const n = Math.max(1, Math.floor(Number(v)) || 1);
  return (
    <Modal title={T("Register number")} onClose={onClose} width={420}>
      <div style={{ color: "var(--ink2)", fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>This number identifies <b>this device</b>. It appears on receipts (R{n}) and Z-reports (Z-R{n}-…). Give each till in the store a different number so their reports don’t collide.</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 13, padding: "0 14px", height: 54 }}>
        <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink3)" }}>R</span>
        <input autoFocus type="number" inputMode="numeric" min={1} value={v} onChange={(e) => setV(e.target.value)} placeholder="1"
          className="num" style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 22, fontWeight: 800, minWidth: 0 }} />
      </div>
      <button onClick={() => onSave(n)} style={{ ...C.charge, width: "100%", minHeight: "var(--tap-lg)", marginTop: 14 }}>Save register number</button>
    </Modal>
  );
}
function Receipt({ data, gstBp, onClose }: { data: any; gstBp: number; onClose: () => void }) {
  const { sale, change, settings, registerNo } = data;
  const method = (sale.payments || [])[0]?.method || "—";
  const docNo = "MLE-R" + (Number(registerNo) || 1) + "-" + new Date(sale.t).toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(sale.no || "").replace(/\D/g, "").padStart(4, "0");
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

/* Header profile switcher — one menu off the avatar that carries who you are
   (name + role), the language switch, the jump to the admin cockpit, and sign
   out. Mirrored in the back office so both apps switch from the same place. */
function ProfileMenu({ user, mob, lang, registerNo, onEditRegister, onPaidOut, onToggleLang, onSignOut }: { user: any; mob: boolean; lang: "en" | "dv"; registerNo: number; onEditRegister: () => void; onPaidOut: () => void; onToggleLang: () => void; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const role = user.role || "Cashier";
  const Item = ({ icon, label, sub, onClick, danger }: { icon: string; label: string; sub?: string; onClick: () => void; danger?: boolean }) => (
    <button onClick={() => { setOpen(false); onClick(); }} style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 12px", borderRadius: 11, textAlign: "start", cursor: "pointer", color: danger ? "var(--red)" : "var(--ink)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--sur2)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <span style={{ width: 20, textAlign: "center", fontSize: 15 }}>{icon}</span>
      <span style={{ flex: 1 }}><span style={{ fontSize: 13, fontWeight: 700, display: "block" }}>{label}</span>{sub && <span style={{ fontSize: 11, color: "var(--ink3)" }}>{sub}</span>}</span>
    </button>
  );
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((v) => !v)} style={{ ...C.pill, gap: 8, padding: mob ? "4px" : "5px 11px 5px 5px", cursor: "pointer" }} title="Profile & settings" aria-haspopup="menu" aria-expanded={open}>
        <span style={C.avatar}>{(user.name || "?")[0].toUpperCase()}</span>{!mob && user.name}{!mob && <span style={{ color: "var(--ink3)", fontSize: 11 }}>▾</span>}
      </button>
      {open && (
        <div role="menu" className="glass" style={{ position: "absolute", insetInlineEnd: 0, top: "calc(100% + 8px)", width: 232, background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 16, boxShadow: "var(--shadow)", padding: 6, zIndex: 60, animation: "rise .18s both" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px 12px" }}>
            <span style={{ ...C.avatar, width: 38, height: 38, fontSize: 15 }}>{(user.name || "?")[0].toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--coral-text)", fontWeight: 700 }}>{role}</div>
            </div>
          </div>
          <div style={{ height: 1, background: "var(--line)", margin: "2px 6px 4px" }} />
          <Item icon="🖥" label={t("Register number", lang)} sub={"This device · R" + registerNo} onClick={onEditRegister} />
          <Item icon="💸" label="Paid out" sub="Cash out of the drawer" onClick={onPaidOut} />
          <Item icon="🌐" label={t("Language", lang)} sub={lang === "en" ? "English" : "ދިވެހި"} onClick={onToggleLang} />
          <Item icon="⚙︎" label={t("Admin panel", lang)} sub="Back office & reports" onClick={() => (window.location.href = "/back")} />
          <div style={{ height: 1, background: "var(--line)", margin: "4px 6px" }} />
          <Item icon="⎋" label={t("Sign out", lang)} onClick={onSignOut} danger />
        </div>
      )}
    </div>
  );
}

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div style={{ ...C.overlay, justifyContent: "flex-end", alignItems: "stretch" }} onClick={onClose}>
      <div className="glass" onClick={(e) => e.stopPropagation()} style={{ width: "min(430px,96vw)", height: "100%", background: "var(--sur)", borderInlineStart: "1px solid var(--line)", display: "flex", flexDirection: "column", animation: "sheet .3s cubic-bezier(.2,.9,.3,1.1)", paddingTop: "var(--sat,0px)", paddingBottom: "var(--sab,0px)" }}>
        <div style={{ padding: "16px 22px", borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Payment</div><div style={{ flex: 1 }} />
            <IconBtn label="Close" onClick={onClose}>✕</IconBtn>
          </div>
          <div style={{ textAlign: "center", padding: "14px 0 6px" }}>
            <div style={{ fontSize: 12, color: "var(--ink2)", fontWeight: 700 }}>Total due</div>
            <div className="num" style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-.01em" }}>{money(total)}</div>
            {guests > 1 && <div style={{ fontSize: 12.5, color: "var(--coral-text)", fontWeight: 800, marginTop: 2, animation: "pop .25s" }}>{money(perGuest)} per guest</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
            <span style={{ fontSize: 11.5, color: "var(--ink2)", fontWeight: 700 }}>Split</span>
            {[1, 2, 3, 4].map((n) => <button key={n} onClick={() => setGuests(n)} aria-label={n === 1 ? "No split" : "Split between " + n + " guests"} style={{ width: 44, height: 44, borderRadius: 12, border: "1px solid var(--line)", fontSize: 14, fontWeight: 800, cursor: "pointer", ...(guests === n ? { background: "var(--coral)", color: "var(--coralink)", borderColor: "var(--coral)" } : { background: "var(--sur2)", color: "var(--ink2)" }) }}>{n}</button>)}
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
                {tenders.map((v) => <button key={v} onClick={() => setTender(v)} className="num" style={{ border: "1px solid " + (tender === v ? "var(--coral)" : "var(--line)"), borderRadius: 12, minHeight: "var(--tap)", padding: "0 15px", fontSize: 13, fontWeight: 800, cursor: "pointer", background: tender === v ? "var(--coralsoft)" : "var(--sur2)", color: tender === v ? "var(--coral-text)" : "var(--ink)" }}>{v === total ? "Exact" : money(v)}</button>)}
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
    <Modal title={product.name || "Item"} onClose={onClose}
      footer={<button onClick={() => onAdd(mods)} style={{ ...C.charge, width: "100%", minHeight: "var(--tap-lg)" }}>Add · {money(unit)}</button>}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <span style={{ ...C.glyph, background: tintFor(product.cat)[0], color: tintFor(product.cat)[1] }}>{product.emoji || (product.name || "?")[0]}</span>
        <div className="num" style={{ color: "var(--ink2)", fontSize: 14, fontWeight: 700 }}>{money(product.price || 0)}</div>
      </div>
      {addons.length > 0 && <div style={{ color: "var(--ink2)", fontSize: 11, fontWeight: 800, letterSpacing: ".04em", margin: "4px 0 6px" }}>ADD-ONS</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {addons.map((a) => { const on = !!picked[a.name]; return (
          <button key={a.name} role="checkbox" aria-checked={on} onClick={() => setPicked({ ...picked, [a.name]: !on })} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: "var(--tap)", padding: "10px 14px", borderRadius: 13, border: "1px solid " + (on ? "var(--coral)" : "var(--line)"), background: on ? "var(--coralsoft)" : "var(--sur)" }}>
            <span style={{ width: 20, height: 20, borderRadius: 6, border: "2px solid " + (on ? "var(--coral)" : "var(--ink3)"), display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--coral-text)", fontSize: 12 }}>{on ? "✓" : ""}</span>
            <span style={{ flex: 1, textAlign: "start", fontWeight: 600, fontSize: 13.5 }}>{a.name}</span>
            {a.price > 0 && <span className="num" style={{ color: "var(--ink2)", fontSize: 12.5 }}>+{money(a.price).replace("MVR ", "")}</span>}
          </button>
        ); })}
      </div>
      {spice.length > 0 && <div style={{ color: "var(--ink2)", fontSize: 11, fontWeight: 800, letterSpacing: ".04em", margin: "12px 0 6px" }}>SPICE LEVEL</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {spice.map((s) => <button key={s.name} aria-pressed={spiceSel === s.name} onClick={() => setSpiceSel(spiceSel === s.name ? "" : s.name)} style={{ ...C.chip, ...(spiceSel === s.name ? C.methodOn : {}) }}>{s.name}</button>)}
      </div>
    </Modal>
  );
}

/* Delivery details — the delivery-only step: attach a customer, pick the
   island/zone (fee + ETA added automatically) and jot a delivery note. No
   order-type row here — that lives on the cart, so this stays focused. */
function DeliveryDetails({ zones, current, note, setNote, custName, onPick, onClear, onAttachCustomer, onClose }: { zones: any[]; current?: any; note: string; setNote: (v: string) => void; custName?: string; onPick: (z: any) => void; onClear: () => void; onAttachCustomer: () => void; onClose: () => void }) {
  return (
    <Modal title="Delivery details" onClose={onClose} width={470}
      footer={<button onClick={onClose} style={{ ...C.charge, width: "100%", minHeight: "var(--tap-lg)" }}>Done</button>}>
      <>
        {!custName
          ? <button onClick={onAttachCustomer} style={{ display: "block", width: "100%", textAlign: "start", background: "var(--coralsoft)", color: "var(--coral-text)", fontWeight: 700, fontSize: 13.5, borderRadius: 13, padding: "13px 15px", cursor: "pointer", marginBottom: 14 }}>Attach a customer for this delivery →</button>
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
      </>
    </Modal>
  );
}
function TablePicker({ tables, current, onPick, onClear, onClose }: { tables: any[]; current?: string; onPick: (name: string) => void; onClear: () => void; onClose: () => void }) {
  return (
    <Modal title="Choose a table" onClose={onClose} width={420}>
      <>
        <div style={{ fontSize: 12.5, color: "var(--ink2)", margin: "-6px 0 12px" }}>Seats this order as Dine-in</div>
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
          <button onClick={onClear} style={{ ...C.custBtn, width: "100%", minHeight: "var(--tap)", marginTop: 14, justifyContent: "center", color: "var(--ink2)" }}>Clear table · back to Takeaway</button>
        )}
      </>
    </Modal>
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
    <Modal title={adding ? "New customer" : "Customer"} onClose={onClose} width={440}>
      <>
        {adding ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div><label style={{ color: "var(--ink2)", fontSize: 12, fontWeight: 700 }}>NAME</label>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" style={{ ...C.input, width: "100%", marginTop: 5 }} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create(); }} /></div>
            <div><label style={{ color: "var(--ink2)", fontSize: 12, fontWeight: 700 }}>PHONE <span style={{ fontWeight: 400 }}>(optional)</span></label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="7XX XXXX" style={{ ...C.input, width: "100%", marginTop: 5 }} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create(); }} /></div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button onClick={() => setAdding(false)} style={{ ...C.custBtn, minHeight: "var(--tap)", justifyContent: "center", cursor: "pointer" }}>Cancel</button>
              <button onClick={create} disabled={!name.trim()} style={{ ...C.charge, flex: 1, minHeight: "var(--tap)", opacity: name.trim() ? 1 : .5 }}>Add customer</button>
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
              <button onClick={startAdd} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 8px", textAlign: "left", cursor: "pointer", color: "var(--coral-text)", fontWeight: 700 }}>
                <span style={{ ...C.avatar, background: "var(--coralsoft)", color: "var(--coral-text)" }}>＋</span>
                <span>Add {q.trim() ? "“" + q.trim() + "”" : "a new customer"}</span>
              </button>
            </div>
          </>
        )}
      </>
    </Modal>
  );
}

function Placeholder({ nav }: { nav: string }) {
  const n = NAV.find((x) => x.id === nav)!;
  return <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--ink2)" }}>
    <div style={{ width: 60, height: 60, borderRadius: 18, background: "var(--sur)", boxShadow: "var(--shadow)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg viewBox="0 0 24 24" width={26} height={26} style={{ color: "var(--coral-text)" }} dangerouslySetInnerHTML={{ __html: n.icon }} />
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
  npillOn: { background: "var(--coralsoft)", color: "var(--coral-text)", animation: "pop .25s" },
  railBtn: { display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "10px 4px", borderRadius: 13, color: "var(--ink2)" },
  railOn: { background: "var(--coralsoft)", color: "var(--coral-text)" },
  header: { height: 58, flex: "0 0 58px", display: "flex", alignItems: "center", gap: 12, padding: "0 18px" },
  pill: { border: "1px solid var(--line)", background: "var(--sur2)", borderRadius: 999, padding: "6px 13px", fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 7, whiteSpace: "nowrap" },
  dot: { width: 7, height: 7, borderRadius: 99, display: "inline-block" },
  avatar: { width: 30, height: 30, borderRadius: 99, background: "var(--green)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13 },
  card: { background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 14, boxShadow: "var(--shadow)" },
  key: { height: 60, borderRadius: 15, background: "var(--sur)", border: "1px solid var(--line)", fontSize: 22, fontWeight: 700, fontFamily: "var(--num)" },
  body: { flex: 1, minHeight: 0, display: "flex", gap: 14, padding: "0 16px 16px" },
  obill: { whiteSpace: "nowrap", border: "1px solid var(--line)", background: "var(--sur)", borderRadius: 12, padding: "8px 13px", fontSize: 12.5, fontWeight: 700 },
  obillOn: { borderColor: "var(--coral)", background: "var(--coralsoft)", color: "var(--coral-text)" },
  search: { flex: 1, display: "flex", alignItems: "center", gap: 10, background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 14, padding: "0 14px", height: 46 },
  scan: { background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 14, padding: "0 16px", fontWeight: 700, fontSize: 13.5 },
  chip: { whiteSpace: "nowrap", minHeight: 44, display: "inline-flex", alignItems: "center", padding: "0 16px", borderRadius: 999, fontSize: 13, fontWeight: 700, color: "var(--ink2)", background: "var(--sur)", border: "1px solid var(--line)" },
  chipOn: { background: "var(--ink)", color: "var(--bg)", borderColor: "var(--ink)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(158px,1fr))", gap: 12 },
  tile: { position: "relative", display: "flex", flexDirection: "column", borderRadius: 18, background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", textAlign: "left", overflow: "hidden" },
  plate: { position: "relative", aspectRatio: "16 / 11", display: "grid", placeItems: "center", overflow: "hidden" },
  tbody: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", flex: 1 },
  ttag: { fontSize: 10.5, fontWeight: 800, letterSpacing: ".03em", textTransform: "uppercase", color: "var(--coral-text)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tname: { fontWeight: 700, fontSize: 13.5, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tdesc: { fontSize: 11, color: "var(--ink2)", lineHeight: 1.32, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 29 },
  tfoot: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9 },
  glyph: { width: 38, height: 38, borderRadius: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18 },
  best: { position: "absolute", top: 7, right: 8, background: "var(--green)", color: "#fff", fontSize: 9.5, fontWeight: 800, padding: "3px 8px", borderRadius: 999, boxShadow: "0 2px 6px rgba(0,0,0,.18)" },
  railWrap: { width: 224, flex: "0 0 224px", display: "flex", flexDirection: "column", borderRadius: 18, background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", overflow: "hidden" },
  railCard: { display: "block", width: "100%", border: "1.5px solid var(--line)", background: "var(--sur2)", borderRadius: 14, padding: "10px 12px", cursor: "pointer" },
  stag: { fontSize: 10.5, fontWeight: 800, borderRadius: 999, padding: "3px 9px", display: "inline-flex", alignItems: "center", gap: 4 },
  kot: { flex: 1, borderRadius: 13, padding: 14, background: "var(--sur)", border: "1.5px solid var(--line)", color: "var(--ink)", fontWeight: 800, fontSize: 14 },
  /* On-tile stepper: 32px visible keys (tile width can't fit the full 40px
     cart stepper) — still a third larger than the old 24px; the cart uses the
     shared 44px Stepper. Tile add "+" is 36px (was 26). */
  stepper: { display: "inline-flex", alignItems: "center", gap: 4, background: "var(--coralsoft)", borderRadius: 999, padding: "2px 3px", minHeight: 38 },
  stepBtn: { width: 32, height: 32, borderRadius: 99, background: "var(--sur)", fontSize: 17, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1 },
  plus: { width: 36, height: 36, borderRadius: 99, background: "var(--coral)", color: "var(--coralink)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700 },
  cart: { width: 352, flex: "0 0 352px", display: "flex", flexDirection: "column", borderRadius: 18, background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", overflow: "hidden" },
  billtab: { width: 34, height: 30, borderRadius: 9, background: "var(--coral)", color: "var(--coralink)", fontWeight: 800, fontSize: 13, display: "inline-flex", alignItems: "center", justifyContent: "center" },
  billAdd: { background: "var(--sur2)", color: "var(--ink2)" },
  oseg: { flex: 1, padding: "9px 6px", borderRadius: 11, fontSize: 12.5, fontWeight: 700, color: "var(--ink2)", background: "var(--sur2)" },
  osegOn: { background: "var(--coral)", color: "var(--coralink)" },
  custBtn: { flex: 1, background: "var(--sur2)", borderRadius: 11, padding: "10px 12px", fontSize: 12.5, color: "var(--ink2)", fontWeight: 600 },
  trow: { display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--ink2)", fontWeight: 600, padding: "3px 0" },
  disc: { display: "inline-block", margin: "4px 0", fontSize: 11.5, fontWeight: 700, color: "var(--coral-text)", background: "var(--coralsoft)", borderRadius: 999, padding: "4px 10px" },
  act: { width: 46, height: 46, borderRadius: 13, background: "var(--sur2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink2)", fontSize: 16 },
  charge: { flex: 1, borderRadius: 13, background: "var(--coral)", color: "var(--coralink)", fontWeight: 800, fontSize: 15, boxShadow: "0 8px 20px -6px rgba(225,85,45,.5)" },
  overlay: { position: "fixed", inset: 0, background: "rgba(20,18,15,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40, animation: "fade .2s" },
  sheet: { background: "var(--bg)", borderRadius: 22, padding: 22, boxShadow: "var(--shadow)", animation: "sheet .3s cubic-bezier(.2,.9,.3,1.1)" },
  method: { padding: "12px 6px", borderRadius: 12, background: "var(--sur)", border: "1px solid var(--line)", fontWeight: 700, fontSize: 13 },
  methodOn: { background: "var(--coralsoft)", borderColor: "var(--coral)", color: "var(--coral-text)" },
  shiftBar: { width: "100%", textAlign: "start", borderRadius: 14, padding: "11px 16px", background: "var(--ambersoft)", border: "1px solid color-mix(in srgb,var(--amber) 32%,transparent)", color: "var(--amber)", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  input: { padding: "11px 13px", borderRadius: 11, border: "1px solid var(--line)", background: "var(--sur)", color: "var(--ink)", fontSize: 14, outline: "none", flex: 1 },
  chipSm: { padding: "8px 14px", borderRadius: 11, background: "var(--coral)", color: "var(--coralink)", fontWeight: 700, fontSize: 13 },
  discChip: { padding: "7px 13px", borderRadius: 999, background: "var(--sur2)", border: "1px solid var(--line)", fontWeight: 700, fontSize: 12.5, color: "var(--ink)" },
  receipt: { background: "#fff", color: "#111", borderRadius: 14, padding: 18, fontFamily: "ui-monospace,Menlo,monospace", boxShadow: "var(--shadow)" },
};
