import { useEffect, useState } from "react";
import { money } from "./util";
import { tintFor } from "./util";

/* Guest QR portal — the same bundle serves this when the URL carries ?s=<slug>
   (a printed table QR points at "/?s=slug&t=table"). Public: no PIN/token. It
   loads the store's menu from /p/:slug/boot, and runs the three-screen self-
   order flow from the QR portal handoff:
     menu (photo grid) → item detail (add-ons + notes + qty) → order summary
     (promo + tax + total) → POST /p/:slug/order (drops a kitchen ticket).
   Add-on prices are validated + priced server-side. A waiter can be called via
   /p/:slug/call. Mobile-first; mirrors the register's menu design. */

type Boot = { settings: any; storeId: string; products: any[]; tables: string[]; zones: any[]; cust: any };
type Add = { name: string; price: number; qty: number };
type Line = { lid: string; id: string; name: string; qty: number; addons: Add[]; note: string; lineTot: number };

const PROMO_CODE = "KASHIKEYO5";

export function GuestPortal({ slug, table, custId, storeId }: { slug: string; table: string; custId: string; storeId: string }) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [err, setErr] = useState("");
  const [view, setView] = useState<"menu" | "item" | "summary">("menu");
  const [cat, setCat] = useState("all");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [addSel, setAddSel] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [cartL, setCartL] = useState<Line[]>([]);
  const [promo, setPromo] = useState(false);
  const [promoInput, setPromoInput] = useState("");
  const [placed, setPlaced] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [called, setCalled] = useState(false);

  const qp = (k: string, v: string) => v ? `${k}=${encodeURIComponent(v)}` : "";
  const bootUrl = `/p/${encodeURIComponent(slug)}/boot?` + [qp("st", storeId), qp("t", table), qp("c", custId)].filter(Boolean).join("&");

  useEffect(() => {
    fetch(bootUrl).then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || "not found"))))
      .then(setBoot).catch((e) => setErr(e.message || "could not load menu"));
  }, [slug]);

  const settings = boot?.settings || {};
  const gstBp = Number(settings.gstBp ?? 800);
  const products = boot?.products || [];
  const groups: { name: string; subs: string[] }[] = settings.catGroups || [];
  const prodById = (id: string) => products.find((p) => p.id === id);
  const inGroup = (c: string) => cat === "all" || (groups.find((g) => g.name === cat)?.subs || []).includes(c);
  const items = products.filter((p) => inGroup(p.cat) && (!query || (p.name || "").toLowerCase().includes(query.toLowerCase())));
  const chipIcon = (g: { subs: string[] }) => products.find((p) => (g.subs || []).includes(p.cat));

  /* ── item detail ─────────────────────────────────────────────────────────── */
  const dm = sel ? prodById(sel) : null;
  const dmAddons: any[] = dm && Array.isArray(dm.addons) ? dm.addons : [];
  const addTot = dmAddons.reduce((s, a) => s + (addSel[a.name] || 0) * (Number(a.price) || 0), 0);
  const detailTotal = dm ? (dm.price * qty + addTot) : 0;
  const openItem = (id: string) => { setSel(id); setQty(1); setAddSel({}); setNote(""); setView("item"); };
  const addonInc = (n: string) => setAddSel((s) => ({ ...s, [n]: (s[n] || 0) + 1 }));
  const addonDec = (n: string) => setAddSel((s) => ({ ...s, [n]: Math.max(0, (s[n] || 0) - 1) }));
  const addToOrder = () => {
    if (!dm) return;
    const chosen: Add[] = dmAddons.filter((a) => (addSel[a.name] || 0) > 0).map((a) => ({ name: a.name, price: Number(a.price) || 0, qty: addSel[a.name] }));
    const addUnit = chosen.reduce((x, a) => x + a.qty * a.price, 0);
    const line: Line = { lid: "q" + Date.now(), id: dm.id, name: dm.name, qty, addons: chosen, note: note.trim(), lineTot: dm.price * qty + addUnit };
    setCartL((c) => [line, ...c]); setView("summary"); setSel(null);
  };

  /* ── summary / totals ────────────────────────────────────────────────────── */
  const reqty = (l: Line, q: number): Line => { const addUnit = l.addons.reduce((x, a) => x + a.qty * a.price, 0); const base = (prodById(l.id)?.price || 0); return { ...l, qty: q, lineTot: base * q + addUnit }; };
  const lineInc = (lid: string) => setCartL((c) => c.map((l) => l.lid === lid ? reqty(l, l.qty + 1) : l));
  const lineDec = (lid: string) => setCartL((c) => c.reduce((acc: Line[], l) => { if (l.lid !== lid) acc.push(l); else if (l.qty > 1) acc.push(reqty(l, l.qty - 1)); return acc; }, []));
  const sub = cartL.reduce((a, l) => a + l.lineTot, 0);
  const tax = Math.round(sub * gstBp / 10000);
  const promoOff = promo ? Math.round(sub * 0.05) : 0;
  const total = sub + tax - promoOff;
  const count = cartL.reduce((a, l) => a + l.qty, 0);
  const applyPromo = () => { if (promoInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").startsWith(PROMO_CODE)) { setPromo(true); setErr(""); } else setErr("That promo code isn't valid."); };

  const place = (payOnline: boolean) => {
    if (!cartL.length) return;
    setBusy(true); setErr("");
    const orderItems = cartL.map((l) => ({ id: l.id, qty: l.qty, addons: l.addons.flatMap((a) => Array.from({ length: a.qty }, () => ({ name: a.name }))) }));
    const notes = cartL.filter((l) => l.note).map((l) => l.name + ": " + l.note).join(" · ");
    const body = { items: orderItems, table, custId, gtype: table ? "dinein" : "pickup", storeId, note: notes, payOnline };
    fetch(`/p/${encodeURIComponent(slug)}/order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || "could not place order"))))
      .then((j) => { setPlaced({ ...j.order, paid: payOnline }); setCartL([]); setPromo(false); setView("menu"); })
      .catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  const callWaiter = () => {
    setCalled(true);
    fetch(`/p/${encodeURIComponent(slug)}/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ table, storeId }) }).catch(() => {});
    setTimeout(() => setCalled(false), 4000);
  };

  if (err && !boot) return <Center><div style={{ fontSize: 30 }}>🍽️</div><div style={{ fontWeight: 700, marginTop: 8 }}>{err}</div></Center>;
  if (!boot) return <Center><div style={G.chip}>K</div><div style={{ color: "var(--ink2)", marginTop: 10 }}>Loading menu…</div></Center>;

  if (placed) return (
    <div style={G.wrap}><div style={G.phone}>
      <Center>
        <div style={{ width: 64, height: 64, borderRadius: 99, background: "var(--greensoft)", color: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30 }}>✓</div>
        <div style={{ fontWeight: 800, fontSize: 20, marginTop: 12 }}>{placed.paid ? "Paid & ordered" : "Order placed"}</div>
        <div style={{ color: "var(--ink2)", fontSize: 14, marginTop: 4 }}>{placed.no} · sent to the kitchen{table ? " · " + table : ""}</div>
        <button onClick={() => setPlaced(null)} style={{ ...G.primary, marginTop: 20, width: "auto", padding: "12px 22px" }}>Order more</button>
        {table && <button onClick={callWaiter} style={{ ...G.ghost, marginTop: 10 }}>{called ? "Waiter on the way ✓" : "🔔 Call waiter"}</button>}
      </Center>
    </div></div>
  );

  const tableLbl = table ? "Table " + table : "Order & pickup";

  /* ── ITEM DETAIL ─────────────────────────────────────────────────────────── */
  if (view === "item" && dm) {
    const t = tintFor(dm.cat);
    return (
      <div style={G.wrap}><div style={G.phone}>
        <div style={{ position: "relative", height: 236, flex: "0 0 236px", background: `radial-gradient(120% 115% at 50% 6%, ${t[0]}, var(--sur2))`, display: "grid", placeItems: "center", overflow: "hidden" }}>
          {dm.img ? <img src={dm.img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 72 }}>{dm.emoji || "🍽️"}</span>}
          <button onClick={() => setView("menu")} style={G.fab} aria-label="Back">‹</button>
          <button onClick={() => setView(cartL.length ? "summary" : "menu")} style={{ ...G.fab, insetInlineStart: "auto", insetInlineEnd: 14 }}>⋯</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px 96px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{ fontWeight: 800, fontSize: 19, flex: 1 }}>{dm.name}</div>
            <span style={{ color: "var(--green)", fontSize: 17 }}>✓</span>
          </div>
          {dm.tag && <div style={{ color: "var(--ink3)", fontSize: 12.5, marginTop: 2 }}>{dm.tag}</div>}
          <div style={{ display: "flex", alignItems: "center", marginTop: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}><span style={{ color: "#F6B01E" }}>★</span> <span className="num">{dm.rating || "4.7"}</span> <span style={{ color: "var(--ink3)", fontWeight: 600 }} className="num">({dm.rn || "120"})</span></span>
            <div style={{ flex: 1 }} />
            <span className="num" style={{ fontWeight: 800, fontSize: 17, color: "var(--coral)" }}>{money(dm.price)}</span>
          </div>
          {dm.desc && <div style={{ color: "var(--ink2)", fontSize: 13.5, lineHeight: 1.5, marginTop: 12 }}>{dm.desc}</div>}
          {dmAddons.length > 0 && (
            <>
              <div style={G.sect}>Add Ons</div>
              <div style={{ border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden" }}>
                {dmAddons.map((a, i) => { const q = addSel[a.name] || 0; return (
                  <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderTop: i ? "1px solid var(--line)" : "none" }}>
                    <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{a.name} {Number(a.price) ? <span style={{ color: "var(--coral)", fontWeight: 700 }} className="num">(+{money(a.price).replace("MVR ", "")})</span> : <span style={{ color: "var(--green)", fontWeight: 700 }}>(Free)</span>}</span>
                    {q > 0 ? <span style={G.stepper}><button style={G.stepBtn} onClick={() => addonDec(a.name)}>−</button><span className="num" style={{ minWidth: 16, textAlign: "center", fontWeight: 800 }}>{q}</span><button style={G.stepBtn} onClick={() => addonInc(a.name)}>+</button></span>
                      : <button style={G.add} onClick={() => addonInc(a.name)}>+</button>}
                  </div>
                ); })}
              </div>
            </>
          )}
          <div style={G.sect}>Notes</div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. no chili, extra spicy…" dir="auto" style={G.input} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
            <span style={{ fontSize: 12.5, color: "var(--ink3)", fontWeight: 700 }}>Qty</span>
            <span style={G.stepper}><button style={G.stepBtn} onClick={() => setQty((v) => Math.max(1, v - 1))}>−</button><span className="num" style={{ minWidth: 18, textAlign: "center", fontWeight: 800 }}>{qty}</span><button style={G.stepBtn} onClick={() => setQty((v) => v + 1)}>+</button></span>
          </div>
        </div>
        <div style={G.footer}>
          <div><div style={{ fontSize: 11, color: "var(--ink3)", fontWeight: 700 }}>Total</div><div className="num" style={{ fontWeight: 800, fontSize: 17 }}>{money(detailTotal)}</div></div>
          <button onClick={addToOrder} style={{ ...G.primary, flex: 1 }}>Add to order</button>
        </div>
      </div></div>
    );
  }

  /* ── ORDER SUMMARY ───────────────────────────────────────────────────────── */
  if (view === "summary") {
    return (
      <div style={G.wrap}><div style={G.phone}>
        <header style={{ ...G.head, gap: 10 }}>
          <button onClick={() => setView("menu")} style={G.back}>‹</button>
          <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 17 }}>Your Order Summary</div></div>
          <span style={{ ...G.tablePill }}>🏷 {tableLbl}</span>
        </header>
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 16px 96px" }}>
          {cartL.length === 0 && <div style={{ color: "var(--ink3)", textAlign: "center", padding: 40 }}>Your order is empty.</div>}
          {cartL.map((l) => { const p = prodById(l.id); const tt = tintFor(p?.cat || l.name); return (
            <div key={l.lid} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 0", borderBottom: "1px solid var(--line)" }}>
              <span style={{ width: 46, height: 46, borderRadius: 12, overflow: "hidden", background: tt[0], color: tt[1], display: "grid", placeItems: "center", fontSize: 20, flex: "0 0 46px" }}>{p?.img ? <img src={p.img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (p?.emoji || "🍽️")}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{l.name}</div>
                {(l.addons.length || l.note) ? <div style={{ color: "var(--ink3)", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[...l.addons.map((a) => (a.qty > 1 ? a.qty + "× " : "") + a.name), l.note].filter(Boolean).join(", ")}</div> : null}
                <div className="num" style={{ color: "var(--coral)", fontWeight: 800, fontSize: 12.5, marginTop: 2 }}>{money(l.lineTot)}</div>
              </div>
              <span style={G.stepper}><button style={G.stepBtn} onClick={() => lineDec(l.lid)}>−</button><span className="num" style={{ minWidth: 16, textAlign: "center", fontWeight: 800 }}>{l.qty}</span><button style={G.stepBtn} onClick={() => lineInc(l.lid)}>+</button></span>
            </div>
          ); })}
          {cartL.length > 0 && <>
            <div style={G.sect}>Have a Promo Code?</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid " + (promo ? "var(--green)" : "var(--line)"), borderRadius: 12, padding: "4px 4px 4px 14px" }}>
              <input value={promoInput} onChange={(e) => setPromoInput(e.target.value)} placeholder={PROMO_CODE + "5%"} disabled={promo} style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 14, fontWeight: 700 }} />
              <button onClick={applyPromo} disabled={promo} style={{ ...G.primary, width: "auto", padding: "9px 16px", opacity: promo ? .5 : 1 }}>{promo ? "Applied" : "Enter"}</button>
            </div>
            {promo && <div style={{ color: "var(--green)", fontSize: 12.5, fontWeight: 700, marginTop: 8 }}>✓ Promo applied · {PROMO_CODE}5% — 5% off</div>}
            <div style={G.sect}>Payment Summary</div>
            <div style={{ background: "var(--sur2)", borderRadius: 14, padding: "12px 15px" }}>
              <Row k="Subtotal" v={money(sub)} />
              <Row k={`Tax & Service (${gstBp / 100}%)`} v={money(tax)} />
              {promo && <Row k="Promo Code (5%)" v={"− " + money(promoOff)} accent />}
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 16, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}><span>Total Payment</span><span className="num" style={{ color: "var(--coral)" }}>{money(total)}</span></div>
            </div>
          </>}
          {err && <div style={{ color: "var(--red)", fontSize: 13, marginTop: 10, textAlign: "center" }}>{err}</div>}
        </div>
        {cartL.length > 0 && (
          <div style={{ ...G.footer, gap: 10 }}>
            <button disabled={busy} onClick={() => place(true)} style={{ ...G.ghost, flex: 1, borderColor: "var(--coral)", color: "var(--coral)", background: "var(--sur)", border: "1.5px solid var(--coral)" }}>Order &amp; Pay Now</button>
            <button disabled={busy} onClick={() => place(false)} style={{ ...G.primary, flex: 1, opacity: busy ? .6 : 1 }}>{busy ? "…" : "Order Now"}</button>
          </div>
        )}
      </div></div>
    );
  }

  /* ── MENU ────────────────────────────────────────────────────────────────── */
  return (
    <div style={G.wrap}>
      <div style={G.phone}>
        <header style={{ padding: "18px 16px 10px" }}>
          <div style={{ display: "flex", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: "var(--ink3)", fontSize: 13 }}>Welcome to</div>
              <div style={{ fontWeight: 800, fontSize: 21, lineHeight: 1.15 }}>{settings.storeName || "Menu"}</div>
              <div style={{ color: "var(--coral)", fontSize: 13, fontWeight: 700, marginTop: 3 }}>🏷 {tableLbl}</div>
            </div>
            <button onClick={callWaiter} style={G.callBtn}>{called ? "✓" : "🔔"}</button>
          </div>
          <div style={G.search}>
            <span style={{ color: "var(--ink3)" }}>🔍</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for a dish…" style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 14 }} />
          </div>
        </header>
        <div style={{ fontWeight: 800, fontSize: 14, padding: "6px 16px 8px" }}>Categories</div>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "0 16px 8px" }}>
          <button onClick={() => setCat("all")} style={{ ...G.catChip, ...(cat === "all" ? G.catOn : {}) }}>All</button>
          {groups.map((g) => { const ic = chipIcon(g); return (
            <button key={g.name} onClick={() => setCat(g.name)} style={{ ...G.catChip, ...(cat === g.name ? G.catOn : {}) }}>
              <span style={{ width: 22, height: 22, borderRadius: 99, overflow: "hidden", background: "var(--sur)", display: "grid", placeItems: "center", fontSize: 12 }}>{ic?.img ? <img src={ic.img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (ic?.emoji || "🍽️")}</span>
              {g.name}
            </button>
          ); })}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 14px 90px" }}>
          <div style={G.grid}>
            {items.map((p) => { const t = tintFor(p.cat); const so = p.soldOut; const inCart = cartL.filter((l) => l.id === p.id).reduce((a, l) => a + l.qty, 0);
              return (
                <div key={p.id} onClick={() => !so && openItem(p.id)} style={{ ...G.tile, opacity: so ? .6 : 1, cursor: so ? "default" : "pointer", borderColor: inCart ? "var(--coral)" : "var(--line)" }}>
                  <div style={{ ...G.plate, background: `radial-gradient(120% 115% at 50% 8%, ${t[0]}, var(--sur2))` }}>
                    {p.img ? <img src={p.img} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 40 }}>{p.emoji || "🍽️"}</span>}
                    {p.rating && !so && <span style={G.rate}><span style={{ color: "#FFC94D" }}>★</span><span className="num">{p.rating}</span></span>}
                    {inCart > 0 && <span style={G.qbadge} className="num">{inCart}</span>}
                    {so && <div style={{ position: "absolute", inset: 0, background: "rgba(20,18,15,.45)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 13 }}>Sold out</div>}
                  </div>
                  <div style={G.tbody}>
                    <div style={G.tname}>{p.name}</div>
                    {p.desc && <div style={G.tdesc}>{p.desc}</div>}
                    <div style={{ flex: 1 }} />
                    <div style={G.tfoot}>
                      <span className="num" style={{ fontSize: 13.5, fontWeight: 800, color: "var(--coral)" }}>{money(p.price)}</span>
                      {!so && <button style={G.add} onClick={(e) => { e.stopPropagation(); openItem(p.id); }}>+</button>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {items.length === 0 && <div style={{ color: "var(--ink3)", textAlign: "center", padding: 30 }}>No items in this category.</div>}
        </div>
        {count > 0 && (
          <button onClick={() => setView("summary")} style={G.cartBar}>
            <span style={{ background: "rgba(255,255,255,.25)", borderRadius: 99, padding: "2px 10px", fontWeight: 800 }}>{count}</span>
            <span style={{ flex: 1, textAlign: "start", marginInlineStart: 10 }}>Your Order</span>
            <span className="num" style={{ fontWeight: 800 }}>{money(sub)}</span>
          </button>
        )}
      </div>
    </div>
  );
}

const Row = ({ k, v, accent }: { k: string; v: string; accent?: boolean }) => <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: accent ? "var(--green)" : "var(--ink2)", padding: "3px 0", fontWeight: accent ? 700 : 500 }}><span>{k}</span><span className="num">{v}</span></div>;
const Center = ({ children }: any) => <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}>{children}</div>;

const G: Record<string, React.CSSProperties> = {
  wrap: { height: "100%", display: "flex", justifyContent: "center" },
  phone: { width: "min(480px,100%)", height: "100%", display: "flex", flexDirection: "column", background: "var(--sur)", position: "relative", overflow: "hidden" },
  head: { display: "flex", alignItems: "center", padding: "16px 14px 12px", borderBottom: "1px solid var(--line)" },
  chip: { width: 40, height: 40, borderRadius: 12, background: "linear-gradient(150deg,#F0743F,#E1552D)", color: "#FFF6EF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18 },
  callBtn: { width: 42, height: 42, borderRadius: 99, background: "var(--coralsoft)", color: "var(--coral)", fontSize: 18, flex: "0 0 42px" },
  back: { width: 38, height: 38, borderRadius: 99, background: "var(--sur2)", color: "var(--ink)", fontSize: 22, fontWeight: 800, display: "grid", placeItems: "center", flex: "0 0 38px", lineHeight: 1 },
  tablePill: { fontSize: 12.5, fontWeight: 700, color: "var(--coral)", whiteSpace: "nowrap" },
  search: { display: "flex", alignItems: "center", gap: 9, background: "var(--sur2)", border: "1px solid var(--line)", borderRadius: 13, padding: "0 14px", height: 44, marginTop: 12 },
  catChip: { display: "inline-flex", alignItems: "center", gap: 7, whiteSpace: "nowrap", padding: "6px 13px 6px 6px", borderRadius: 999, fontSize: 13, fontWeight: 700, color: "var(--ink2)", background: "var(--sur)", border: "1px solid var(--line)" },
  catOn: { background: "var(--coral)", color: "var(--coralink)", borderColor: "var(--coral)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 11 },
  tile: { position: "relative", display: "flex", flexDirection: "column", borderRadius: 18, background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", textAlign: "start", overflow: "hidden" },
  plate: { position: "relative", aspectRatio: "16 / 11", display: "grid", placeItems: "center", overflow: "hidden" },
  rate: { position: "absolute", bottom: 7, insetInlineEnd: 8, fontSize: 10, fontWeight: 800, background: "rgba(20,18,15,.55)", color: "#fff", borderRadius: 999, padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: 3 },
  qbadge: { position: "absolute", top: 7, insetInlineStart: 8, minWidth: 20, height: 20, borderRadius: 999, background: "var(--coral)", color: "var(--coralink)", fontSize: 11.5, fontWeight: 800, display: "grid", placeItems: "center", padding: "0 6px" },
  tbody: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", flex: 1 },
  tname: { fontWeight: 700, fontSize: 13.5, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tdesc: { fontSize: 11, color: "var(--ink2)", lineHeight: 1.32, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 29 },
  tfoot: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9 },
  sect: { fontWeight: 800, fontSize: 14, margin: "18px 0 8px" },
  fab: { position: "absolute", top: 14, insetInlineStart: 14, width: 38, height: 38, borderRadius: 99, background: "rgba(255,255,255,.92)", color: "#1B1A17", fontSize: 22, fontWeight: 800, display: "grid", placeItems: "center", lineHeight: 1, boxShadow: "0 2px 8px rgba(0,0,0,.18)" },
  add: { width: 30, height: 30, borderRadius: 99, background: "var(--coral)", color: "var(--coralink)", fontSize: 18, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 30px" },
  stepper: { display: "inline-flex", alignItems: "center", gap: 4, background: "var(--coralsoft)", borderRadius: 999, padding: "3px 5px" },
  stepBtn: { width: 26, height: 26, borderRadius: 99, background: "var(--sur)", color: "var(--coral)", fontSize: 16, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1 },
  input: { width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--sur2)", color: "var(--ink)", fontSize: 14, outline: "none" },
  footer: { display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--line)", background: "var(--sur)" },
  cartBar: { position: "absolute", left: 14, right: 14, bottom: 16, display: "flex", alignItems: "center", padding: "13px 16px", borderRadius: 15, background: "var(--coral)", color: "var(--coralink)", fontWeight: 700, fontSize: 15, boxShadow: "0 8px 22px -6px rgba(225,85,45,.55)" },
  primary: { width: "100%", padding: "13px", borderRadius: 13, background: "var(--coral)", color: "var(--coralink)", fontWeight: 800, fontSize: 15 },
  ghost: { padding: "12px", borderRadius: 13, background: "var(--sur2)", color: "var(--ink)", fontWeight: 700, fontSize: 14 },
};
