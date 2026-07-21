import { useEffect, useMemo, useRef, useState } from "react";
import { store, useStore } from "./store";
import { elevate, hashPin, uid } from "./api";
import { ProdShell } from "./prodshell";
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
/* Top nav — Production's tab set (Sell/Orders/Dashboard/Reports/Admin) kept
   in full, merged with the tabs the operational spec requires (Floor/Tabs/
   Day End) and Staging's channel-categorized Orders. Kitchen/QR Orders/
   Delivery are no longer separate pills — they're the three category tabs
   inside Orders now, so the top row never grows past what Production+spec
   actually needs. */
const NAV = [
  { id: "sell", label: "Sell", icon: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h2l2.6 12.4A2 2 0 0 0 8.5 17h9a2 2 0 0 0 2-1.6L21.5 7H6"/>' },
  { id: "floor", label: "Floor", icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { id: "orders", label: "Orders", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h3"/>' },
  { id: "tabs", label: "Tabs", icon: '<path d="M3 6a2 2 0 0 1 2-2h9l4 4v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 12h6M8 16h4"/>' },
  { id: "dayend", label: "Day End", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  { id: "dashboard", label: "Dashboard", icon: '<path d="M3 13h8V3H3zM13 21h8v-6h-8zM13 11h8V3h-8zM3 21h8v-6H3z"/>' },
  { id: "analytics", label: "Reports", icon: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>' },
  { id: "admin", label: "Admin", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
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
  return <ProdShell user={user} onSignOut={() => setUser(null)} />;
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
  /* Glass panel + full-width keypad, matched to the production login panel:
     wordmark over the store line, a "← name" back affordance, tinted PIN dots
     and big glassy keys that stretch the panel instead of floating loose. */
  const panel: React.CSSProperties = { width: "min(440px, 94vw)", background: "var(--sur)", border: "1px solid var(--line)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow)", padding: "var(--s5)" };
  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, padding: "calc(24px + var(--sat,0px)) 20px calc(24px + var(--sab,0px))" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ ...C.kchip, width: 52, height: 52, fontSize: 26, borderRadius: 16, margin: "0 auto 12px" }}>K</div>
        <div style={{ fontFamily: "var(--num)", fontWeight: 800, fontSize: 22, letterSpacing: "-.01em" }}>Kashikeyo<span style={{ color: "var(--coral-text)" }}>POS</span></div>
        <div style={{ color: "var(--ink2)", fontSize: 13, marginTop: 3 }}>{(settings.storeName ? settings.storeName + " · " : "") + (sel ? "enter your PIN" : "who's on the till?")}</div>
        <div className="num" style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.2, marginTop: 8 }}>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        <div style={{ color: "var(--ink2)", fontSize: 12.5 }}>{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</div>
      </div>
      {!sel ? (
        <div className="glass" style={{ ...panel, width: users.length > 1 ? "min(720px, 94vw)" : "min(380px, 94vw)" }}>
          <div style={{ display: "grid", gridTemplateColumns: users.length > 1 ? "repeat(auto-fill,minmax(230px,1fr))" : "1fr", gap: 10 }}>
            {users.map((u) => (
              <button key={u.id} onClick={() => setSel(u)} style={{ background: "var(--sur)", border: "1px solid var(--line)", borderRadius: "var(--r-m)", display: "flex", alignItems: "center", gap: 12, minHeight: "var(--tap-lg)", padding: "12px 14px", textAlign: "left" }}>
                <span style={{ ...C.avatar, width: 36, height: 36, fontSize: 14, background: "var(--green)" }}>{(u.name || "?")[0].toUpperCase()}</span>
                <b style={{ flex: 1, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</b><small style={{ color: "var(--ink2)" }}>{u.role}</small>
              </button>
            ))}
            {users.length === 0 && <button onClick={() => { store.cursor = 0; store.pullAll(); }} style={{ padding: "14px 16px", color: "var(--ink2)", fontSize: 13, fontWeight: 600 }}>No staff synced yet — tap to retry sync</button>}
          </div>
        </div>
      ) : (
        <div className="glass" style={{ ...panel, animation: err ? "shake .4s" : undefined }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
            {users.length > 1
              ? <button onClick={() => { setSel(null); setPin(""); }} style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: "var(--tap)", padding: "0 8px", margin: "0 -8px", color: "var(--ink2)", fontSize: 14, fontWeight: 700 }}>← {sel.name}</button>
              : <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: "var(--tap)", color: "var(--ink2)", fontSize: 14, fontWeight: 700 }}>{sel.name}</span>}
          </div>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", marginBottom: 18 }}>{[0, 1, 2, 3].map((i) => (
            <span key={i} style={{ width: 14, height: 14, borderRadius: 99, background: i < pin.length ? "var(--coral)" : "var(--coralsoft)", transition: "background var(--dur-1)" }} />
          ))}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: vw >= 760 ? 12 : 10 }}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((d, i) => d === "" ? <span key={i} /> : (
              <button key={i} aria-label={d === "⌫" ? "Delete digit" : d} onClick={() => d === "⌫" ? setPin(pin.slice(0, -1)) : press(d)}
                className="num" style={{ height: keySize, borderRadius: "var(--r-l)", background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "0 1px 2px rgba(30,35,45,.08)", fontSize: 23, fontWeight: 700 }}>{d}</button>
            ))}
          </div>
          {err && <div style={{ color: "var(--red)", fontSize: 13, fontWeight: 700, textAlign: "center", marginTop: 12 }}>Wrong PIN</div>}
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
  const n = NAV.find((x) => x.id === nav);
  return <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--ink2)" }}>
    <div style={{ width: 60, height: 60, borderRadius: 18, background: "var(--sur)", boxShadow: "var(--shadow)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {n && <svg viewBox="0 0 24 24" width={26} height={26} style={{ color: "var(--coral-text)" }} dangerouslySetInnerHTML={{ __html: n.icon }} />}
    </div>
    <div style={{ fontWeight: 800, fontSize: 18, color: "var(--ink)" }}>{n ? n.label : nav}</div>
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
  kchipSm: { width: 30, height: 30, borderRadius: 9, background: "linear-gradient(150deg,#17B378,#0B7A4C)", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15, flex: "0 0 30px" },
  navrow: { display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", overflowX: "auto", borderBottom: "1px solid var(--line)", flex: "0 0 auto" },
  navrowM: { display: "flex", alignItems: "center", gap: 5, padding: "7px 10px", overflowX: "auto", borderBottom: "1px solid var(--line)", flex: "0 0 auto" },
  npill: { display: "flex", alignItems: "center", gap: 8, padding: "8px 15px", borderRadius: 999, color: "var(--ink2)", background: "transparent", whiteSpace: "nowrap", cursor: "pointer", flex: "0 0 auto" },
  npillOn: { background: "var(--coral)", color: "var(--coralink)", animation: "pop .25s" },
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
