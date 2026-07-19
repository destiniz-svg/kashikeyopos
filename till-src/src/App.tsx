import { useMemo, useState, useEffect } from "react";

/* Reskin-only rebuild of OUR existing register — same features, prototype look.
   No prototype-only additions (no GST sector toggle, Dhivehi/RTL, KDS/QR/Outlets,
   service charge, or MIRA numbering). Prices are GST-inclusive; GST 8% is the
   portion within the price and Total == Subtotal, matching the current till. */

const GST_RATE = 0.08;
const money = (n: number) => "MVR " + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Cat = "all" | "main" | "coffee" | "drinks" | "bakery" | "grocery" | "hedhikaa";
type Prod = { id: string; name: string; price: number; cat: Exclude<Cat, "all">; glyph: string; tint: keyof typeof TINT; best?: boolean; stock?: number };

const TINT = {
  coffee: ["var(--ambersoft)", "var(--amber)"],
  main: ["var(--greensoft)", "var(--green)"],
  drinks: ["var(--bluesoft, rgba(47,107,224,.14))", "var(--blue)"],
  bakery: ["var(--coralsoft)", "var(--coral)"],
  grocery: ["var(--sur2)", "var(--ink2)"],
  sweet: ["var(--redsoft)", "var(--red)"],
} as const;

const CATS: { id: Cat; label: string; glyph: string }[] = [
  { id: "all", label: "All", glyph: "🍽️" }, { id: "main", label: "Main Dishes", glyph: "🍛" },
  { id: "coffee", label: "Coffee", glyph: "☕" }, { id: "drinks", label: "Drinks", glyph: "🥤" },
  { id: "bakery", label: "Bakery", glyph: "🥐" }, { id: "grocery", label: "Grocery", glyph: "🛒" },
  { id: "hedhikaa", label: "Hedhikaa", glyph: "🍢" },
];

const PRODUCTS: Prod[] = [
  { id: "espresso", name: "Espresso", price: 35, cat: "coffee", glyph: "E", tint: "coffee", best: true },
  { id: "flatwhite", name: "Flat White", price: 45, cat: "coffee", glyph: "F", tint: "coffee" },
  { id: "icedlatte", name: "Iced Latte", price: 50, cat: "coffee", glyph: "I", tint: "coffee", best: true },
  { id: "hotchoc", name: "Hot Chocolate", price: 45, cat: "coffee", glyph: "H", tint: "coffee" },
  { id: "croissant", name: "Almond Croissant", price: 40, cat: "bakery", glyph: "A", tint: "bakery" },
  { id: "muffin", name: "Blueberry Muffin", price: 35, cat: "bakery", glyph: "B", tint: "bakery", best: true },
  { id: "tunasand", name: "Tuna Sandwich", price: 45, cat: "bakery", glyph: "T", tint: "bakery", stock: 12 },
  { id: "choccake", name: "Chocolate Cake", price: 60, cat: "bakery", glyph: "C", tint: "sweet" },
  { id: "water", name: "Water 500ml", price: 15, cat: "grocery", glyph: "W", tint: "grocery", best: true },
  { id: "orange", name: "Orange Juice", price: 40, cat: "drinks", glyph: "O", tint: "drinks", best: true },
  { id: "kurumba", name: "Kurumba", price: 30, cat: "drinks", glyph: "K", tint: "drinks" },
  { id: "cola", name: "Cola Can", price: 25, cat: "grocery", glyph: "C", tint: "grocery" },
];

const NAV = [
  { id: "sell", label: "Sell", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h3"/>' },
  { id: "orders", label: "Orders", icon: '<path d="M4 21V7a2 2 0 0 1 2-2h9l5 5v11z"/><path d="M8 12h8M8 16h6"/>' },
  { id: "dashboard", label: "Dashboard", icon: '<path d="M3 13h8V3H3zM13 21h8v-6h-8zM13 11h8V3h-8zM3 21h8v-6H3z"/>' },
  { id: "reports", label: "Reports", icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
  { id: "admin", label: "Admin", icon: '<circle cx="12" cy="12" r="3"/><path d="M19 13a1.6 1.6 0 0 0 .3 1.8 2 2 0 1 1-2.8 2.8 1.6 1.6 0 0 0-2.7 1.1 2 2 0 0 1-4 0 1.6 1.6 0 0 0-2.7-1.1 2 2 0 1 1-2.8-2.8A1.6 1.6 0 0 0 2 13a2 2 0 0 1 0-4 1.6 1.6 0 0 0 1.1-2.7 2 2 0 1 1 2.8-2.8A1.6 1.6 0 0 0 8.7 4 2 2 0 0 1 12 4a1.6 1.6 0 0 0 2.7 1.1 2 2 0 1 1 2.8 2.8A1.6 1.6 0 0 0 20 11z"/>' },
];

export function App() {
  const [nav, setNav] = useState("sell");
  const [cat, setCat] = useState<Cat>("all");
  const [query, setQuery] = useState("");
  const [otype, setOtype] = useState<"dinein" | "takeaway" | "delivery">("takeaway");
  const [cart, setCart] = useState<Record<string, number>>({ espresso: 2, icedlatte: 1 });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(id); }, []);

  const bump = (id: string, d: number) => setCart((c) => {
    const q = (c[id] || 0) + d; const n = { ...c };
    if (q <= 0) delete n[id]; else n[id] = q; return n;
  });
  const items = PRODUCTS.filter((p) => (cat === "all" || p.cat === cat) && (!query || p.name.toLowerCase().includes(query.toLowerCase())));
  const lines = Object.keys(cart).filter((k) => cart[k] > 0).map((id) => ({ p: PRODUCTS.find((x) => x.id === id)!, q: cart[id] }));
  const sub = lines.reduce((a, l) => a + l.p.price * l.q, 0);
  const gst = sub - sub / (1 + GST_RATE);
  const count = lines.reduce((a, l) => a + l.q, 0);
  const clock = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + ", " + now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* left icon rail — OUR nav only */}
      <aside style={S.rail} className="glass">
        <div style={S.kchip}>K</div>
        <div style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: ".12em", color: "var(--ink3)", marginBottom: 8 }}>KASHIKEYO</div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 3, width: "100%" }}>
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setNav(n.id)} style={{ ...S.railBtn, ...(nav === n.id ? S.railOn : {}) }} aria-current={nav === n.id ? "page" : undefined}>
              <svg viewBox="0 0 24 24" width={21} height={21} dangerouslySetInnerHTML={{ __html: n.icon }} />
              <span style={{ fontSize: 10, fontWeight: 700 }}>{n.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* header */}
        <header style={S.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 16 }}>
            Kashikeyo Café <span style={{ color: "var(--ink2)", fontWeight: 600, fontSize: 13 }}>· Malé</span>
            <span style={{ color: "var(--ink3)", fontSize: 12 }}>▾</span>
          </div>
          <span style={{ ...S.pill, color: "var(--amber)" }}><i style={{ ...S.dot, background: "var(--amber)" }} />No shift</span>
          <div style={{ flex: 1 }} />
          <span className="num" style={{ fontSize: 13, color: "var(--ink2)" }}>{clock}</span>
          <span style={{ ...S.pill, color: "var(--green)" }}><i style={{ ...S.dot, background: "var(--green)", animation: "pulse 2s infinite" }} />Online</span>
          <span style={{ ...S.pill, gap: 8, padding: "5px 12px 5px 5px" }}><span style={S.avatar}>r</span>Owner</span>
        </header>

        {nav === "sell" ? (
          <div style={S.body}>
            <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 11 }}>
              {/* open bills — our feature, kept */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, overflowX: "auto" }}>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".09em", color: "var(--ink3)", whiteSpace: "nowrap" }}>OPEN BILLS</span>
                <span style={{ ...S.obill, ...S.obillOn }}>🥡 Takeaway · #1 <small style={{ color: "var(--coral)", opacity: .8 }}>Walk-in · 1</small></span>
                <span style={S.obill}>🍽️ Dine-in · #2 <small style={{ color: "var(--ink2)" }}>Table 4 · 2</small></span>
                <span style={{ ...S.obill, borderStyle: "dashed", color: "var(--ink2)" }}>＋ New bill</span>
              </div>
              <div style={S.shift}>🕓 No shift open — tap to open one before taking payments</div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={S.search}>
                  <svg viewBox="0 0 24 24" width={17} height={17} style={{ color: "var(--ink3)" }}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search or type barcode… (Enter adds)"
                    style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 14 }} />
                </div>
                <button style={S.scan}>📷 Scan</button>
              </div>
              <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2 }}>
                {CATS.map((c) => (
                  <button key={c.id} onClick={() => setCat(c.id)} style={{ ...S.chip, ...(cat === c.id ? S.chipOn : {}) }}>{c.glyph} {c.label}</button>
                ))}
                <button style={S.chip}>⋯ More</button>
              </div>
              <div style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
                <div style={S.grid}>
                  {items.map((p, i) => {
                    const q = cart[p.id] || 0; const t = TINT[p.tint];
                    return (
                      <div key={p.id} style={{ ...S.tile, borderColor: q > 0 ? "var(--coral)" : "var(--line)", animation: `rise .3s ${Math.min(i * 16, 240)}ms both` }}>
                        {p.best && <span style={S.best}>★ Best seller</span>}
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ ...S.glyph, background: t[0], color: t[1] }}>{p.glyph}</span>
                        </div>
                        <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 9, lineHeight: 1.2 }}>{p.name}</div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 7 }}>
                          <span className="num" style={{ fontSize: 13, fontWeight: 800 }}>{p.price.toFixed(2)}
                            <small style={{ fontSize: 10.5, color: "var(--ink3)", fontWeight: 600, marginLeft: 3 }}>{p.stock ? p.stock + " pcs" : "pcs"}</small></span>
                          {q > 0 ? (
                            <span style={S.stepper}>
                              <button style={S.stepBtn} onClick={() => bump(p.id, -1)}>−</button>
                              <span className="num" style={{ minWidth: 15, textAlign: "center", fontWeight: 800 }}>{q}</span>
                              <button style={S.stepBtn} onClick={() => bump(p.id, 1)}>+</button>
                            </span>
                          ) : <button style={S.plus} onClick={() => bump(p.id, 1)}>+</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* cart */}
            <aside style={S.cart} className="glass">
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "12px 14px 8px" }}>
                <span style={S.billtab}>#1</span><span style={{ ...S.billtab, ...S.billAdd }}>＋</span>
                <div style={{ flex: 1 }} /><span style={{ fontSize: 11, color: "var(--ink3)", fontWeight: 700 }}>{count} items</span>
              </div>
              <div style={{ display: "flex", gap: 6, padding: "2px 14px 10px" }}>
                {([["dinein", "🍽️ Dine-in"], ["takeaway", "🥡 Takeaway"], ["delivery", "🛵 Delivery"]] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setOtype(k)} style={{ ...S.oseg, ...(otype === k ? S.osegOn : {}) }}>{l}</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, padding: "0 14px 10px" }}>
                <div style={S.custBtn}>👤 Add customer</div><div style={S.custBtn}>🍴 Table · optional</div>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "2px 12px", borderTop: "1px solid var(--line)" }}>
                {lines.length === 0 ? (
                  <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--ink3)", gap: 10 }}>
                    <div style={{ fontSize: 30 }}>🛒</div><div style={{ fontSize: 13 }}>Scan or tap a product to start</div>
                  </div>
                ) : lines.map((l) => {
                  const t = TINT[l.p.tint];
                  return (
                    <div key={l.p.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 4px", animation: "rise .25s both" }}>
                      <span style={{ ...S.glyph, width: 34, height: 34, fontSize: 13, background: t[0], color: t[1] }}>{l.p.glyph}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <b style={{ fontSize: 13, fontWeight: 700, display: "block" }}>{l.p.name}</b>
                        <small style={{ fontSize: 11, color: "var(--ink2)" }}>{money(l.p.price)} each</small>
                      </div>
                      <span style={{ ...S.stepper, background: "var(--sur2)" }}>
                        <button style={S.stepBtn} onClick={() => bump(l.p.id, -1)}>−</button>
                        <span className="num" style={{ minWidth: 15, textAlign: "center", fontWeight: 800 }}>{l.q}</span>
                        <button style={S.stepBtn} onClick={() => bump(l.p.id, 1)}>+</button>
                      </span>
                      <span className="num" style={{ fontWeight: 800, fontSize: 13, minWidth: 58, textAlign: "right" }}>{money(l.p.price * l.q)}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ borderTop: "1px solid var(--line)", padding: "12px 16px 14px" }}>
                <div style={S.trow}><span>Subtotal</span><span className="num">{money(sub)}</span></div>
                <div style={S.disc}>＋ Bill disc</div>
                <div style={S.trow}><span>GST 8%</span><span className="num">{money(gst)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "8px 0 12px" }}>
                  <span style={{ fontWeight: 800, fontSize: 15 }}>Total</span><span className="num" style={{ fontWeight: 800, fontSize: 26 }}>{money(sub)}</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={S.act} title="Park">⏸</button><button style={S.act} title="Split">✂️</button><button style={S.act} title="Clear" onClick={() => setCart({})}>🗑️</button>
                  <button style={{ ...S.charge, opacity: count ? 1 : .5 }} disabled={!count}>Charge {money(sub)}</button>
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--ink2)" }}>
            <div style={{ width: 60, height: 60, borderRadius: 18, background: "var(--sur)", boxShadow: "var(--shadow)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg viewBox="0 0 24 24" width={26} height={26} style={{ color: "var(--coral)" }} dangerouslySetInnerHTML={{ __html: NAV.find((n) => n.id === nav)!.icon }} />
            </div>
            <div style={{ fontWeight: 800, fontSize: 18, color: "var(--ink)" }}>{NAV.find((n) => n.id === nav)!.label}</div>
            <div style={{ fontSize: 13 }}>This existing screen is reskinned in a later stage.</div>
          </div>
        )}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  rail: { width: 92, flex: "0 0 92px", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: "14px 8px", gap: 4, background: "var(--sur)", borderRight: "1px solid var(--line)" },
  kchip: { width: 40, height: 40, borderRadius: 13, background: "linear-gradient(150deg,#F0743F,#E1552D)", color: "#FFF6EF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 20, boxShadow: "0 6px 16px rgba(225,85,45,.34)" },
  railBtn: { display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "10px 4px", borderRadius: 13, color: "var(--ink2)" },
  railOn: { background: "var(--coralsoft)", color: "var(--coral)" },
  header: { height: 58, flex: "0 0 58px", display: "flex", alignItems: "center", gap: 12, padding: "0 18px" },
  pill: { border: "1px solid var(--line)", background: "var(--sur2)", borderRadius: 999, padding: "6px 13px", fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 7, whiteSpace: "nowrap" },
  dot: { width: 7, height: 7, borderRadius: 99, display: "inline-block" },
  avatar: { width: 30, height: 30, borderRadius: 99, background: "var(--green)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13 },
  body: { flex: 1, minHeight: 0, display: "flex", gap: 14, padding: "0 16px 16px" },
  obill: { whiteSpace: "nowrap", border: "1px solid var(--line)", background: "var(--sur)", borderRadius: 12, padding: "8px 13px", fontSize: 12.5, fontWeight: 700 },
  obillOn: { borderColor: "var(--coral)", background: "var(--coralsoft)", color: "var(--coral)" },
  shift: { borderRadius: 14, padding: "11px 16px", background: "var(--ambersoft)", border: "1px solid color-mix(in srgb,var(--amber) 32%,transparent)", color: "var(--amber)", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 9 },
  search: { flex: 1, display: "flex", alignItems: "center", gap: 10, background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 14, padding: "0 14px", height: 46 },
  scan: { background: "var(--sur)", border: "1px solid var(--line)", borderRadius: 14, padding: "0 16px", fontWeight: 700, fontSize: 13.5 },
  chip: { whiteSpace: "nowrap", padding: "8px 15px", borderRadius: 999, fontSize: 13, fontWeight: 700, color: "var(--ink2)", background: "var(--sur)", border: "1px solid var(--line)" },
  chipOn: { background: "var(--ink)", color: "var(--bg)", borderColor: "var(--ink)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 11 },
  tile: { position: "relative", display: "flex", flexDirection: "column", padding: 13, borderRadius: 16, background: "var(--sur)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", textAlign: "left" },
  glyph: { width: 38, height: 38, borderRadius: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15 },
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
};
