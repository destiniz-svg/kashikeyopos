import { useEffect, useMemo, useState } from "react";
import { money } from "./util";
import { tintFor } from "./util";

/* Guest QR portal — the same bundle serves this when the URL carries ?s=<slug>
   (a printed table QR points at "/?s=slug&t=table"). Public: no PIN/token. It
   loads the store's menu from /p/:slug/boot, lets a guest build an order, and
   posts it to /p/:slug/order (drops a ticket to the kitchen); a waiter can be
   called via /p/:slug/call. Same reskin look, mobile-first. */

type Boot = { settings: any; storeId: string; products: any[]; tables: string[]; zones: any[]; cust: any };

export function GuestPortal({ slug, table, custId, storeId }: { slug: string; table: string; custId: string; storeId: string }) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [err, setErr] = useState("");
  const [cat, setCat] = useState("all");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
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
  const inGroup = (c: string) => cat === "all" || (groups.find((g) => g.name === cat)?.subs || []).includes(c);
  const items = products.filter((p) => inGroup(p.cat));
  const prodById = (id: string) => products.find((p) => p.id === id);
  const bump = (id: string, d: number) => setCart((c) => { const q = (c[id] || 0) + d; const n = { ...c }; if (q <= 0) delete n[id]; else n[id] = q; return n; });
  const lines = Object.keys(cart).filter((k) => cart[k] > 0);
  const subtotal = lines.reduce((a, id) => a + (prodById(id)?.price || 0) * cart[id], 0);
  const gst = Math.round(subtotal * gstBp / 10000);
  const total = subtotal + gst;
  const count = lines.reduce((a, id) => a + cart[id], 0);

  const place = () => {
    setBusy(true);
    const body = { items: lines.map((id) => ({ id, qty: cart[id] })), table, custId, gtype: table ? "dinein" : "pickup", storeId };
    fetch(`/p/${encodeURIComponent(slug)}/order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || "could not place order"))))
      .then((j) => { setPlaced(j.order); setCart({}); setOpen(false); })
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
    <div style={G.wrap}>
      <div style={G.phone}>
        <Center>
          <div style={{ width: 64, height: 64, borderRadius: 99, background: "var(--greensoft)", color: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30 }}>✓</div>
          <div style={{ fontWeight: 800, fontSize: 20, marginTop: 12 }}>Order placed</div>
          <div style={{ color: "var(--ink2)", fontSize: 14, marginTop: 4 }}>{placed.no} · sent to the kitchen{table ? " · " + table : ""}</div>
          <button onClick={() => setPlaced(null)} style={{ ...G.primary, marginTop: 20, width: "auto", padding: "12px 22px" }}>Order more</button>
          {table && <button onClick={callWaiter} style={{ ...G.ghost, marginTop: 10 }}>{called ? "Waiter on the way ✓" : "🔔 Call waiter"}</button>}
        </Center>
      </div>
    </div>
  );

  return (
    <div style={G.wrap}>
      <div style={G.phone}>
        <header style={G.head}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={G.chip}>{(settings.storeName || "K")[0]}</span>
            <div><div style={{ fontWeight: 800, fontSize: 16 }}>{settings.storeName || "Menu"}</div><div style={{ color: "var(--ink3)", fontSize: 12 }}>{table ? "Table " + table : "Order & pickup"} · scan · order · pay</div></div>
          </div>
          {table && <button onClick={callWaiter} style={G.callBtn}>{called ? "✓" : "🔔"}</button>}
        </header>
        <div style={{ display: "flex", gap: 7, overflowX: "auto", padding: "10px 14px" }}>
          <button onClick={() => setCat("all")} style={{ ...G.catChip, ...(cat === "all" ? G.catOn : {}) }}>All</button>
          {groups.map((g) => <button key={g.name} onClick={() => setCat(g.name)} style={{ ...G.catChip, ...(cat === g.name ? G.catOn : {}) }}>{g.name}</button>)}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 90px" }}>
          {items.map((p) => {
            const q = cart[p.id] || 0; const t = tintFor(p.cat); const so = p.soldOut;
            return (
              <div key={p.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "11px 0", borderBottom: "1px solid var(--line)", opacity: so ? .5 : 1 }}>
                <span style={{ ...G.glyph, background: t[0], color: t[1] }}>{p.emoji || (p.name || "?")[0]}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                  {p.desc && <div style={{ color: "var(--ink3)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.desc}</div>}
                  <div className="num" style={{ fontWeight: 800, fontSize: 13, marginTop: 3 }}>{money(p.price)}{so && <span style={{ color: "var(--red)", marginInlineStart: 8, fontSize: 11, fontWeight: 700 }}>Sold out</span>}</div>
                </div>
                {so ? null : q > 0 ? (
                  <span style={G.stepper}><button style={G.stepBtn} onClick={() => bump(p.id, -1)}>−</button><span className="num" style={{ minWidth: 16, textAlign: "center", fontWeight: 800 }}>{q}</span><button style={G.stepBtn} onClick={() => bump(p.id, 1)}>+</button></span>
                ) : <button style={G.add} onClick={() => bump(p.id, 1)}>+</button>}
              </div>
            );
          })}
          {items.length === 0 && <div style={{ color: "var(--ink3)", textAlign: "center", padding: 30 }}>No items in this category.</div>}
        </div>
        {count > 0 && (
          <button onClick={() => setOpen(true)} style={G.cartBar}>
            <span style={{ background: "rgba(255,255,255,.25)", borderRadius: 99, padding: "2px 10px", fontWeight: 800 }}>{count}</span>
            <span style={{ flex: 1, textAlign: "start", marginInlineStart: 10 }}>View order</span>
            <span className="num" style={{ fontWeight: 800 }}>{money(total)}</span>
          </button>
        )}
        {open && (
          <div style={G.sheetWrap} onClick={() => setOpen(false)}>
            <div style={G.sheet} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 10 }}>Your order</div>
              <div style={{ maxHeight: "40vh", overflowY: "auto" }}>
                {lines.map((id) => { const p = prodById(id)!; return (
                  <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                    <span style={{ fontWeight: 700, flex: 1 }}>{p.name}</span>
                    <span style={G.stepper}><button style={G.stepBtn} onClick={() => bump(id, -1)}>−</button><span className="num" style={{ minWidth: 16, textAlign: "center", fontWeight: 800 }}>{cart[id]}</span><button style={G.stepBtn} onClick={() => bump(id, 1)}>+</button></span>
                    <span className="num" style={{ fontWeight: 800, minWidth: 62, textAlign: "end" }}>{money(p.price * cart[id])}</span>
                  </div>
                ); })}
              </div>
              <div style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 10 }}>
                <Row k="Subtotal" v={money(subtotal)} /><Row k={`GST ${gstBp / 100}%`} v={money(gst)} />
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 16, margin: "6px 0 12px" }}><span>Total</span><span className="num">{money(total)}</span></div>
                <button disabled={busy} onClick={place} style={{ ...G.primary, opacity: busy ? .6 : 1 }}>{busy ? "Placing…" : "Place order"}</button>
                {err && <div style={{ color: "var(--red)", fontSize: 13, marginTop: 8, textAlign: "center" }}>{err}</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--ink2)", padding: "2px 0" }}><span>{k}</span><span className="num">{v}</span></div>;
const Center = ({ children }: any) => <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}>{children}</div>;

const G: Record<string, React.CSSProperties> = {
  wrap: { height: "100%", display: "flex", justifyContent: "center" },
  phone: { width: "min(480px,100%)", height: "100%", display: "flex", flexDirection: "column", background: "var(--sur)", position: "relative" },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 14px 10px", borderBottom: "1px solid var(--line)" },
  chip: { width: 40, height: 40, borderRadius: 12, background: "linear-gradient(150deg,#F0743F,#E1552D)", color: "#FFF6EF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18 },
  callBtn: { width: 42, height: 42, borderRadius: 99, background: "var(--coralsoft)", color: "var(--coral)", fontSize: 18 },
  catChip: { whiteSpace: "nowrap", padding: "8px 15px", borderRadius: 999, fontSize: 13, fontWeight: 700, color: "var(--ink2)", background: "var(--sur2)", border: "1px solid var(--line)" },
  catOn: { background: "var(--ink)", color: "var(--bg)", borderColor: "var(--ink)" },
  glyph: { width: 44, height: 44, borderRadius: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 20, flex: "0 0 44px" },
  add: { width: 32, height: 32, borderRadius: 99, background: "var(--coral)", color: "var(--coralink)", fontSize: 19, fontWeight: 700 },
  stepper: { display: "inline-flex", alignItems: "center", gap: 4, background: "var(--coralsoft)", borderRadius: 999, padding: "3px 5px" },
  stepBtn: { width: 26, height: 26, borderRadius: 99, background: "var(--sur)", fontSize: 16, fontWeight: 700 },
  cartBar: { position: "absolute", left: 14, right: 14, bottom: 16, display: "flex", alignItems: "center", padding: "13px 16px", borderRadius: 15, background: "var(--coral)", color: "var(--coralink)", fontWeight: 700, fontSize: 15, boxShadow: "0 8px 22px -6px rgba(225,85,45,.55)" },
  sheetWrap: { position: "absolute", inset: 0, background: "rgba(20,18,15,.42)", display: "flex", alignItems: "flex-end", animation: "fade .2s" },
  sheet: { width: "100%", background: "var(--bg)", borderRadius: "22px 22px 0 0", padding: 20, animation: "sheet .3s cubic-bezier(.2,.9,.3,1.1)" },
  primary: { width: "100%", padding: "14px", borderRadius: 14, background: "var(--coral)", color: "var(--coralink)", fontWeight: 800, fontSize: 15 },
  ghost: { width: "100%", padding: "12px", borderRadius: 14, background: "var(--sur2)", color: "var(--ink)", fontWeight: 700, fontSize: 14 },
};
