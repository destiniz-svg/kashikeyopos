import { useEffect, useMemo, useState } from "react";
import { store, useStore } from "./store";
import { hashPin, uid } from "./api";
import { Dashboard, Reports, Orders, Admin } from "./screens";

/* Reskin-only rebuild of OUR existing till — same features + real sync, in the
   prototype look. No prototype-only additions. Money is laari (÷100 to show);
   GST is added on top of the subtotal (gstBp from settings), matching the
   existing till and the server's money audit. */

const money = (laari: number) => "MVR " + (Math.round(laari) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TINTS: [string, string][] = [
  ["var(--ambersoft)", "var(--amber)"], ["var(--greensoft)", "var(--green)"], ["var(--coralsoft)", "var(--coral)"],
  ["var(--bluesoft, rgba(47,107,224,.14))", "var(--blue)"], ["var(--redsoft)", "var(--red)"], ["var(--sur2)", "var(--ink2)"],
];
const tintFor = (cat: string) => { let h = 0; for (const c of cat || "") h = (h * 31 + c.charCodeAt(0)) >>> 0; return TINTS[h % TINTS.length]; };

const NAV = [
  { id: "sell", label: "Sell", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h3"/>' },
  { id: "orders", label: "Orders", icon: '<path d="M4 21V7a2 2 0 0 1 2-2h9l5 5v11z"/><path d="M8 12h8M8 16h6"/>' },
  { id: "dashboard", label: "Dashboard", icon: '<path d="M3 13h8V3H3zM13 21h8v-6h-8zM13 11h8V3h-8zM3 21h8v-6H3z"/>' },
  { id: "reports", label: "Reports", icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
  { id: "admin", label: "Admin", icon: '<circle cx="12" cy="12" r="3"/><path d="M19 13a1.6 1.6 0 0 0 .3 1.8 2 2 0 1 1-2.8 2.8 1.6 1.6 0 0 0-2.7 1.1 2 2 0 0 1-4 0 1.6 1.6 0 0 0-2.7-1.1 2 2 0 1 1-2.8-2.8A1.6 1.6 0 0 0 2 13a2 2 0 0 1 0-4 1.6 1.6 0 0 0 1.1-2.7 2 2 0 1 1 2.8-2.8A1.6 1.6 0 0 0 8.7 4 2 2 0 0 1 12 4a1.6 1.6 0 0 0 2.7 1.1 2 2 0 1 1 2.8 2.8A1.6 1.6 0 0 0 20 11z"/>' },
];
const METHODS = ["Cash", "Card", "Transfer", "QR"] as const;

export function App() {
  const st = useStore();
  const [user, setUser] = useState<any>(null);
  const [now, setNow] = useState(() => new Date());

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
          {users.length === 0 && <div style={{ color: "var(--ink3)", textAlign: "center", fontSize: 13 }}>No staff synced yet.</div>}
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
type Line = { pid: string; qty: number };

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
  const [discOpen, setDiscOpen] = useState(false);
  const [pay, setPay] = useState(false);
  const [shiftModal, setShiftModal] = useState(false);
  const [zModal, setZModal] = useState(false);
  const [receipt, setReceipt] = useState<any>(null);
  const [cust, setCust] = useState<any>(null);
  const [custPick, setCustPick] = useState(false);
  const parked = st.byKind("parked").map((e) => e.data).sort((a, b) => (a.t || 0) - (b.t || 0));

  const shifts = st.byKind("shifts").map((e) => e.data);
  const openShift = shifts.find((s) => !s.closedAt) || null;

  const products = st.byKind("products").map((e) => e.data).filter((p) => p && !p.archived);
  const bestIds = useBestSellers();
  const clock = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + ", " + now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const subInGroup = (cat: string) => group === "all" || (groups.find((g) => g.name === group)?.subs || []).includes(cat);
  const items = products.filter((p) => subInGroup(p.cat) && (!query || (p.name || "").toLowerCase().includes(query.toLowerCase())));

  const bump = (pid: string, d: number) => setCart((c) => {
    const i = c.findIndex((l) => l.pid === pid);
    if (i < 0) return d > 0 ? c.concat([{ pid, qty: 1 }]) : c;
    const n = c.slice(); const q = n[i].qty + d;
    if (q <= 0) n.splice(i, 1); else n[i] = { ...n[i], qty: q };
    return n;
  });
  const qtyOf = (pid: string) => cart.find((l) => l.pid === pid)?.qty || 0;
  const prodById = (pid: string) => products.find((p) => p.id === pid);

  const totals = useMemo(() => {
    const subtotal = cart.reduce((a, l) => a + (prodById(l.pid)?.price || 0) * l.qty, 0);
    const d = Math.min(Math.max(0, disc), subtotal);
    const taxable = subtotal - d;
    const gst = Math.round(taxable * gstBp / 10000);
    return { subtotal, disc: d, gst, total: taxable + gst };
  }, [cart, products, gstBp, disc]);
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
      userName: user.name, customerId: cust?.id || null, customerName: cust?.name || null, otype,
      lines: cart.map((l) => { const p = prodById(l.pid); return { pid: l.pid, qty: l.qty, name: p?.name, price: p?.price, cost: p?.cost || 0, unit: p?.unit, emoji: p?.emoji, discPct: 0, taxable: p?.taxable !== false }; }),
      subtotal: totals.subtotal, gst: totals.gst, total: totals.total, billDisc: totals.disc, svcCharge: 0,
      payments, change, refunded: false,
    };
    store.commit([{ kind: "sales", id: sale.id, data: sale }]);
    setReceipt({ sale, change, settings });
    setCart([]); setDisc(0); setPay(false); setCust(null);
  };

  const park = () => {
    if (!cart.length) return;
    const bill = { id: uid(), t: Date.now(), otype, lines: cart, disc, customerId: cust?.id || null, custName: cust?.name || null, userName: user.name, storeId: settings.storeId || "main" };
    store.commit([{ kind: "parked", id: bill.id, data: bill }]);
    setCart([]); setDisc(0); setCust(null);
  };
  const resume = (bill: any) => {
    setCart(bill.lines || []); setDisc(bill.disc || 0); setOtype(bill.otype || "takeaway");
    setCust(bill.customerId ? { id: bill.customerId, name: bill.custName } : null);
    store.del([{ kind: "parked", id: bill.id }]);
  };

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <aside style={C.rail} className="glass">
        <div style={C.kchip}>K</div>
        <div style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: ".12em", color: "var(--ink3)", marginBottom: 8 }}>KASHIKEYO</div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 3, width: "100%" }}>
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setNav(n.id)} style={{ ...C.railBtn, ...(nav === n.id ? C.railOn : {}) }} aria-current={nav === n.id ? "page" : undefined}>
              <svg viewBox="0 0 24 24" width={21} height={21} dangerouslySetInnerHTML={{ __html: n.icon }} /><span style={{ fontSize: 10, fontWeight: 700 }}>{n.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header style={C.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 16 }}>
            {settings.storeName || "Kashikeyo Café"} <span style={{ color: "var(--ink3)", fontSize: 12 }}>▾</span>
          </div>
          <div style={{ flex: 1 }} />
          <span className="num" style={{ fontSize: 13, color: "var(--ink2)" }}>{clock}</span>
          <button onClick={() => openShift ? setZModal(true) : setShiftModal(true)} style={{ ...C.pill, cursor: "pointer", color: openShift ? "var(--green)" : "var(--amber)" }} title={openShift ? "Close shift (Z-report)" : "Open a shift"}>
            <i style={{ ...C.dot, background: openShift ? "var(--green)" : "var(--amber)" }} />{openShift ? "Shift open" : "No shift"}
          </button>
          <StatusPill />
          <button onClick={onSignOut} style={{ ...C.pill, gap: 8, padding: "5px 12px 5px 5px", cursor: "pointer" }} title="Sign out">
            <span style={C.avatar}>{(user.name || "?")[0].toUpperCase()}</span>{user.name}
          </button>
        </header>

        {nav === "sell" ? (
          <div style={C.body}>
            <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, overflowX: "auto" }}>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".09em", color: "var(--ink3)", whiteSpace: "nowrap" }}>OPEN BILLS</span>
                <span style={{ ...C.obill, ...C.obillOn }}>🥡 {otype === "dinein" ? "Dine-in" : otype === "delivery" ? "Delivery" : "Takeaway"} · #{parked.length + 1} <small style={{ color: "var(--coral)", opacity: .8 }}>{cust?.name || "Walk-in"}</small></span>
                {parked.map((b, i) => (
                  <button key={b.id} onClick={() => resume(b)} style={C.obill} title="Resume this bill">
                    ⏸ Held · #{i + 1} <small style={{ color: "var(--ink2)" }}>{(b.lines || []).reduce((a: number, l: any) => a + l.qty, 0)} items</small>
                  </button>
                ))}
                <button onClick={() => { setCart([]); setDisc(0); setCust(null); }} style={{ ...C.obill, borderStyle: "dashed", color: "var(--ink2)" }}>＋ New bill</button>
              </div>
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
                      <div key={p.id} style={{ ...C.tile, borderColor: q > 0 ? "var(--coral)" : "var(--line)", animation: `rise .3s ${Math.min(i * 12, 220)}ms both` }}>
                        {bestIds.has(p.id) && <span style={C.best}>★ Best seller</span>}
                        <span style={{ ...C.glyph, background: t[0], color: t[1] }}>{p.emoji || (p.name || "?")[0]}</span>
                        <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 9, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 7 }}>
                          <span className="num" style={{ fontSize: 13, fontWeight: 800 }}>{(p.price / 100).toFixed(2)}<small style={{ fontSize: 10.5, color: "var(--ink3)", fontWeight: 600, marginLeft: 3 }}>{p.unit || "pcs"}</small></span>
                          {q > 0 ? (
                            <span style={C.stepper}><button style={C.stepBtn} onClick={() => bump(p.id, -1)}>−</button><span className="num" style={{ minWidth: 15, textAlign: "center", fontWeight: 800 }}>{q}</span><button style={C.stepBtn} onClick={() => bump(p.id, 1)}>+</button></span>
                          ) : <button style={C.plus} onClick={() => bump(p.id, 1)}>+</button>}
                        </div>
                      </div>
                    );
                  })}
                  {items.length === 0 && <div style={{ color: "var(--ink3)", fontSize: 13, padding: 20 }}>No products in this category.</div>}
                </div>
              </div>
            </section>

            <aside style={C.cart} className="glass">
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "12px 14px 8px" }}>
                <span style={C.billtab}>#1</span><span style={{ ...C.billtab, ...C.billAdd }}>＋</span>
                <div style={{ flex: 1 }} /><span style={{ fontSize: 11, color: "var(--ink3)", fontWeight: 700 }}>{count} items</span>
              </div>
              <div style={{ display: "flex", gap: 6, padding: "2px 14px 10px" }}>
                {([["dinein", "🍽️ Dine-in"], ["takeaway", "🥡 Takeaway"], ["delivery", "🛵 Delivery"]] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setOtype(k)} style={{ ...C.oseg, ...(otype === k ? C.osegOn : {}) }}>{l}</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, padding: "0 14px 10px" }}>
                <button onClick={() => setCustPick(true)} style={{ ...C.custBtn, ...(cust ? { background: "var(--coralsoft)", color: "var(--coral)" } : {}) }}>👤 {cust ? cust.name : "Add customer"}{cust && <span onClick={(e) => { e.stopPropagation(); setCust(null); }} style={{ marginInlineStart: 6 }}>✕</span>}</button>
                <div style={C.custBtn}>🍴 Table · optional</div>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "2px 12px", borderTop: "1px solid var(--line)" }}>
                {cart.length === 0 ? (
                  <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--ink3)", gap: 10 }}><div style={{ fontSize: 30 }}>🛒</div><div style={{ fontSize: 13 }}>Scan or tap a product to start</div></div>
                ) : cart.map((l) => {
                  const p = prodById(l.pid); if (!p) return null; const t = tintFor(p.cat);
                  return (
                    <div key={l.pid} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 4px", animation: "rise .25s both" }}>
                      <span style={{ ...C.glyph, width: 34, height: 34, fontSize: 16, background: t[0], color: t[1] }}>{p.emoji || (p.name || "?")[0]}</span>
                      <div style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 13, fontWeight: 700, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</b><small style={{ fontSize: 11, color: "var(--ink2)" }}>{money(p.price)} each</small></div>
                      <span style={{ ...C.stepper, background: "var(--sur2)" }}><button style={C.stepBtn} onClick={() => bump(l.pid, -1)}>−</button><span className="num" style={{ minWidth: 15, textAlign: "center", fontWeight: 800 }}>{l.qty}</span><button style={C.stepBtn} onClick={() => bump(l.pid, 1)}>+</button></span>
                      <span className="num" style={{ fontWeight: 800, fontSize: 13, minWidth: 58, textAlign: "right" }}>{money(p.price * l.qty)}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ borderTop: "1px solid var(--line)", padding: "12px 16px 14px" }}>
                <div style={C.trow}><span>Subtotal</span><span className="num">{money(totals.subtotal)}</span></div>
                {totals.disc > 0 ? (
                  <div style={C.trow}><span>Discount</span><span><span className="num" style={{ color: "var(--coral)" }}>−{money(totals.disc)}</span> <button onClick={() => setDisc(0)} style={{ color: "var(--ink3)", marginInlineStart: 6 }}>✕</button></span></div>
                ) : discOpen ? (
                  <div style={{ display: "flex", gap: 6, margin: "6px 0" }}>
                    <input autoFocus type="number" inputMode="decimal" placeholder="Discount (MVR)" onKeyDown={(e) => { if (e.key === "Enter") { setDisc(Math.round(Number((e.target as HTMLInputElement).value) * 100) || 0); setDiscOpen(false); } if (e.key === "Escape") setDiscOpen(false); }} style={C.input} />
                    <button style={C.chipSm} onMouseDown={(e) => { const inp = (e.currentTarget.previousSibling as HTMLInputElement); setDisc(Math.round(Number(inp.value) * 100) || 0); setDiscOpen(false); }}>Apply</button>
                  </div>
                ) : (
                  <button onClick={() => setDiscOpen(true)} style={{ ...C.disc, cursor: "pointer" }}>＋ Bill disc</button>
                )}
                <div style={C.trow}><span>GST {gstBp / 100}%</span><span className="num">{money(totals.gst)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "8px 0 12px" }}><span style={{ fontWeight: 800, fontSize: 15 }}>Total</span><span className="num" style={{ fontWeight: 800, fontSize: 26 }}>{money(totals.total)}</span></div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={{ ...C.act, opacity: count ? 1 : .5 }} disabled={!count} title="Hold / park bill" onClick={park}>⏸</button><button style={C.act} title="Split">✂️</button><button style={C.act} title="Clear" onClick={() => { setCart([]); setDisc(0); setCust(null); }}>🗑️</button>
                  <button style={{ ...C.charge, opacity: count ? 1 : .5 }} disabled={!count} onClick={() => openShift ? setPay(true) : setShiftModal(true)}>Charge {money(totals.total)}</button>
                </div>
              </div>
            </aside>
          </div>
        ) : nav === "orders" ? <Orders /> : nav === "dashboard" ? <Dashboard /> : nav === "reports" ? <Reports /> : nav === "admin" ? <Admin /> : <Placeholder nav={nav} />}
      </div>
      {pay && <PaySheet total={totals.total} currency={currency} hasCustomer={!!cust} custName={cust?.name} onClose={() => setPay(false)} onDone={onCharged} />}
      {custPick && <CustomerPicker customers={st.byKind("customers").map((e) => e.data)} onPick={(c) => { setCust(c); setCustPick(false); }} onClose={() => setCustPick(false)} />}
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
          <div style={{ fontSize: 11, color: "#555", display: "flex", justifyContent: "space-between" }}><span>{sale.no}</span><span>{new Date(sale.t).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
          <div style={{ borderTop: "1px dashed #bbb", borderBottom: "1px dashed #bbb", margin: "8px 0", padding: "8px 0" }}>
            {(sale.lines || []).map((l: any, i: number) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}><span>{l.qty}× {l.name}</span><span className="num">{money((l.price || 0) * l.qty)}</span></div>
            ))}
          </div>
          <RRow k="Subtotal" v={money(sale.subtotal)} />
          {sale.billDisc > 0 && <RRow k="Discount" v={"−" + money(sale.billDisc)} />}
          <RRow k={`GST ${gstBp / 100}%`} v={money(sale.gst)} />
          <RRow k="Total" v={money(sale.total)} bold />
          <RRow k={method} v={money(sale.total)} />
          {change > 0 && <RRow k="Change" v={money(change)} />}
          <div style={{ textAlign: "center", fontSize: 11, color: "#555", marginTop: 10 }}>Prices include GST · Thank you<br />ޝުކުރިއްޔާ</div>
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

function PaySheet({ total, currency, hasCustomer, custName, onClose, onDone }: { total: number; currency: string; hasCustomer: boolean; custName?: string; onClose: () => void; onDone: (p: { method: string; amount: number }[], change: number) => void }) {
  const [method, setMethod] = useState<string>("Cash");
  const [tender, setTender] = useState<number>(0);
  const isTab = method === "Credit";
  const change = method === "Cash" ? Math.max(0, tender - total) : 0;
  const quick = [total, Math.ceil(total / 5000) * 5000, Math.ceil(total / 10000) * 10000, Math.ceil(total / 50000) * 50000].filter((v, i, a) => a.indexOf(v) === i);
  const ok = (method !== "Cash" || tender >= total) && (!isTab || hasCustomer);
  return (
    <div style={C.overlay} onClick={onClose}>
      <div style={{ ...C.sheet, width: "min(460px,94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ color: "var(--ink2)", fontSize: 12, fontWeight: 700, letterSpacing: ".05em" }}>TOTAL DUE</div>
        <div className="num" style={{ fontSize: 34, fontWeight: 800, margin: "2px 0 16px" }}>{money(total)}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8 }}>
          {METHODS.map((m) => <button key={m} onClick={() => setMethod(m)} style={{ ...C.method, ...(method === m ? C.methodOn : {}) }}>{m}</button>)}
          <button onClick={() => hasCustomer && setMethod("Credit")} disabled={!hasCustomer} title={hasCustomer ? "Charge to customer tab" : "Attach a customer first"} style={{ ...C.method, ...(isTab ? C.methodOn : {}), opacity: hasCustomer ? 1 : .45 }}>On tab</button>
        </div>
        {isTab && <div style={{ marginTop: 12, fontSize: 13, color: "var(--ink2)" }}>Charged to <b style={{ color: "var(--ink)" }}>{custName}</b>’s tab — posts to receivables.</div>}
        {method === "Cash" && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {quick.map((v) => <button key={v} onClick={() => setTender(v)} style={{ ...C.chip, ...(tender === v ? C.chipOn : {}) }}>{v === total ? "Exact" : money(v)}</button>)}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 14 }}>
              <span style={{ color: "var(--ink2)", fontWeight: 600 }}>Change due</span>
              <span className="num" style={{ fontWeight: 800, color: "var(--green)" }}>{money(change)}</span>
            </div>
          </div>
        )}
        <button disabled={!ok} onClick={() => onDone([{ method, amount: total }], change)} style={{ ...C.charge, width: "100%", marginTop: 18, opacity: ok ? 1 : .5 }}>Confirm payment</button>
      </div>
    </div>
  );
}

function CustomerPicker({ customers, onPick, onClose }: { customers: any[]; onPick: (c: any) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = customers.filter((c) => !q || (c.name || "").toLowerCase().includes(q.toLowerCase()) || (c.phone || "").includes(q));
  return (
    <div style={C.overlay} onClick={onClose}>
      <div style={{ ...C.sheet, width: "min(440px,94vw)", maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 10 }}>Charge to customer</div>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone…" style={{ ...C.input, width: "100%" }} />
        <div style={{ overflowY: "auto", marginTop: 10 }}>
          {list.length ? list.map((c) => (
            <button key={c.id} onClick={() => onPick(c)} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "11px 8px", borderBottom: "1px solid var(--line)", textAlign: "left" }}>
              <span style={{ ...C.avatar, background: "var(--coral)" }}>{(c.name || "?")[0].toUpperCase()}</span>
              <span style={{ flex: 1 }}><b style={{ display: "block", fontSize: 14 }}>{c.name}</b><small style={{ color: "var(--ink3)" }}>{c.phone || ""}</small></span>
              {Number(c.balance || 0) > 0 && <span className="num" style={{ color: "var(--amber)", fontWeight: 700, fontSize: 12 }}>{money(Number(c.balance))}</span>}
            </button>
          )) : <div style={{ color: "var(--ink3)", fontSize: 13, padding: 16, textAlign: "center" }}>No customers found.</div>}
        </div>
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
  kchip: { width: 40, height: 40, borderRadius: 13, background: "linear-gradient(150deg,#F0743F,#E1552D)", color: "#FFF6EF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 20, boxShadow: "0 6px 16px rgba(225,85,45,.34)" },
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
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 11 },
  tile: { position: "relative", display: "flex", flexDirection: "column", padding: 13, borderRadius: 16, background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", textAlign: "left" },
  glyph: { width: 38, height: 38, borderRadius: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18 },
  best: { position: "absolute", top: 8, right: 8, background: "var(--green)", color: "#fff", fontSize: 9.5, fontWeight: 800, padding: "3px 7px", borderRadius: 999 },
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
  receipt: { background: "#fff", color: "#111", borderRadius: 14, padding: 18, fontFamily: "ui-monospace,Menlo,monospace", boxShadow: "var(--shadow)" },
};
