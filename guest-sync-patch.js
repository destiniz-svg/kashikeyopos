/* Startup patcher for the prebuilt web bundle (web/dist).
   Rewrites the guest checkout + waiter call inside the minified index.html so
   guest orders always go through the cloud API, adds a native dine-in table
   picker to the guest page itself, injects the offline write bridge, then
   boots the server.
   Every patch is idempotent: if the file already contains the fixed code the
   regexes/strings either don't match or replace with identical text (no
   write). Run with PATCH_ONLY=1 to apply the patches without starting the
   server (used to bake the fixes into the committed dist). */
const fs = require("fs");
const path = require("path");

const webDir = path.join(__dirname, "web", "dist");
const indexPath = path.join(webDir, "index.html");
const swPath = path.join(webDir, "sw.js");

function patchFile(filePath, patcher) {
  if (!fs.existsSync(filePath)) return;
  const before = fs.readFileSync(filePath, "utf8");
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(filePath, after, "utf8");
}

/* Dine-in table selection used to be bolted on with an external script that
   injected a <select>/button grid into the DOM outside React's control. Any
   re-render of the guest page (a poll tick, an SSE push, anything) could
   discard those foreign nodes — the picker "just vanished" mid-tap, and
   there was no reliable way to make external DOM survive a tree React owns.
   This patches the guest page's own order-type toggle (Pickup/Delivery) to
   add a real "Dine in" option, and its own JSX to render a table grid when
   picked — exactly the same pattern the till itself uses for "Which table?"
   in its own order-type modal: real state (fe.table via Dn), so it can never
   be wiped by a re-render. table/gtype flow through to checkout as fe.table/
   fe.gtype, already the highest-priority source in both rI and lb below. */
const orderTypeToggle =
  'h.jsx("div",{className:"flex gap-1.5 mb-2",children:(fe.table?[["table","To table "+fe.table],["delivery","Delivery"]]:[["pickup","Pickup"],["table","Dine in"],["delivery","Delivery"]]).map(([ne,ke])=>h.jsx("button",{onClick:()=>Dn(ze=>({...ze,gtype:ne})),className:`flex-1 rounded-lg py-2 text-xs font-semibold ${fe.gtype===ne?_.chipOn:_.chip}`,children:ke},ne))}),fe.gtype==="table"&&!fe.table&&h.jsxs("div",{className:"mb-2",children:[h.jsx("div",{className:`text-xs mb-1.5 ${_.sub}`,children:"Which table?"}),h.jsx("div",{className:"grid grid-cols-4 gap-1.5",children:((f&&f.tables)||[]).map(Tn=>h.jsx("button",{onClick:()=>Dn(ze=>({...ze,table:Tn})),className:`rounded-lg py-2 text-xs font-semibold ${_.chip}`,children:Tn},Tn))})]}),fe.gtype==="delivery"&&';

/* Guest checkout (till's no-slug preview fallback): fe.table/fe.gtype are
   now the only source of truth, set natively by the toggle above. */
const checkout =
  'rI=async f=>{if(!fe.cart.length)return Q("Cart is empty","warn");if(fe.gtype==="table"&&!fe.table)return Q("Select a table for dine in","warn");const A=fe.gtype==="delivery"?"delivery":fe.gtype==="pickup"?"takeaway":"dinein";if(A==="delivery"&&!Ou&&M.length)return Q("Pick your delivery zone first","warn");const St=fe.slug||(typeof Ie!=="undefined"&&Ie&&Ie.slug)||"";if(!St)return Q("Not connected to the cloud café — open the shared customer link or pair Cloud Sync first","warn");const Pa=new URLSearchParams(location.search),Sd=fe.storeId||Pa.get("storeId")||Pa.get("store")||Pa.get("st")||localStorage.getItem("kashikeyo.storeId")||"main";try{window.KashikeyoOffline&&window.KashikeyoOffline.setStoreId&&window.KashikeyoOffline.setStoreId(Sd)}catch{}const N={items:fe.cart.map(W=>({...W,pid:W.pid||W.id||W.productId,qty:W.qty||1})),table:fe.table||(A==="delivery"?"Delivery":"Pickup"),custId:fe.custId||null,gtype:fe.gtype,zoneId:fe.zoneId||null,note:(fe.note||"").trim()||A==="delivery"&&ia&&ia.address||"",payOnline:f,storeId:Sd};try{const I=await fetch(`/p/${St}/order?storeId=${encodeURIComponent(Sd)}`,{method:"POST",headers:{"Content-Type":"application/json","X-Store-Id":Sd},body:JSON.stringify(N)}),j=await I.json().catch(()=>({}));if(!I.ok)return Q(j.error||"Couldn\'t place the order — please try again","warn");const F=j.order||{};x(W=>W.some(he=>he.id===F.id)?W:[...W,F]),f1(W=>W?{...W,orders:[F,...(W.orders||[]).filter(he=>he.id!==F.id)]}:W),Dn(W=>({...W,cart:[],tab:"orders",note:""})),Q(`New order ${F.no||"sent"} · ${F.customerName?F.customerName+(F.table?" @ "+F.table:""):F.table||N.table}${f?" · paid online":""}`)}catch{Q("Can\'t reach the café — check your connection and try again","warn")}},Hw=(f,A)=>';
const call =
  'nI=async()=>{try{const St=fe&&fe.slug||(typeof Ie!=="undefined"&&Ie&&Ie.slug)||"";if(St){const Pa=new URLSearchParams(location.search),Sd=fe.storeId||Pa.get("storeId")||Pa.get("store")||Pa.get("st")||localStorage.getItem("kashikeyo.storeId")||"main";try{window.KashikeyoOffline&&window.KashikeyoOffline.setStoreId&&window.KashikeyoOffline.setStoreId(Sd)}catch{}await fetch(`/p/${St}/call?storeId=${encodeURIComponent(Sd)}`,{method:"POST",headers:{"Content-Type":"application/json","X-Store-Id":Sd},body:JSON.stringify({table:fe.table,custId:fe.custId||null,storeId:Sd})})}}catch{}Hw(fe.table,ia?ia.name:null)}';

/* Customer-facing guest links carried a "Staff sign-in" lock icon in the top
   corner that wiped the guest session and fell through to the till's staff
   login screen — confusing for real customers. Hide it for genuine guest
   sessions (urlMode, i.e. reached via a shared ?s=&c= link); staff previewing
   the guest view from inside the till (urlMode false) keep their close (X). */
const hideStaffSignIn =
  'fe.urlMode?null:h.jsx("button",{onClick:()=>Dn(null),className:`p-1.5 rounded-full ${_.btn}`,children:h.jsx(Be,{size:15})})';

/* Sync race: after pulling remote changes, the till marks each touched entity
   kind as "just came from the server" for one diff cycle so it doesn't echo
   that data straight back. If a local edit (e.g. a cashier accepting/settling
   an order) lands in the SAME React batch as an unrelated incoming pull for
   that same kind, the shortcut discards the local change instead of pushing
   it — the till's own screen shows the new status, but it silently never
   reaches the server or any other device. Reproduced end to end: settling a
   guest order updated the till's UI (table freed, order left the active
   list) while Postgres kept the previous status forever. Orders and sales
   are the kinds this actually bit (order status/settlement), so only they
   skip the shortcut and always get a real diff; every other kind keeps the
   original echo suppression unchanged. */
const skipEchoGuard =
  'if(wu.current.has(I)&&I!=="orders"&&I!=="sales"){wu.current.delete(I),Qf.current[I]=F;return}';

/* The checkout/call fixes above patch rI/nI — but those are only ever
   reached through their `else` branch. The actual guest page (Qw) defines its
   OWN checkout (lb) and waiter-call (ub) in a separate closure with different
   local variable names, and calls fetch directly whenever fe.slug is set —
   i.e. on every real, shared customer/table link. rI/nI only run for the
   till's own no-slug guest preview. Patched using Qw's own variable names
   (yt=cart, ye=selected zone, I=zones list). Table/gtype now come straight
   from fe (set natively by the order-type toggle above), so this stays as
   close to the original native lb/ub as possible — only storeId scoping and
   a same table-required check are added. */
const guestCheckout =
  'lb=async ne=>{if(yt.length){if(fe.gtype==="table"&&!fe.table)return Q("Select a table for dine in","warn");if(fe.gtype==="delivery"&&!ye&&I.length)return Q("Pick your delivery zone first","warn");if(fe.slug)try{const Pa=new URLSearchParams(location.search),Sd=fe.storeId||Pa.get("storeId")||Pa.get("store")||Pa.get("st")||localStorage.getItem("kashikeyo.storeId")||"main";try{window.KashikeyoOffline&&window.KashikeyoOffline.setStoreId&&window.KashikeyoOffline.setStoreId(Sd)}catch{}const ke=await fetch(`/p/${fe.slug}/order?storeId=${encodeURIComponent(Sd)}`,{method:"POST",headers:{"Content-Type":"application/json","X-Store-Id":Sd},body:JSON.stringify({items:fe.cart,table:fe.table,custId:fe.custId,gtype:fe.gtype,zoneId:fe.zoneId,note:fe.note||"",payOnline:ne,storeId:Sd})}),ze=await ke.json();if(!ke.ok)return Q(ze.error||"Couldn\'t place the order","warn");Dn(on=>({...on,cart:[],tab:"orders",note:""})),f1(on=>on&&{...on,orders:[ze.order,...on.orders||[]]}),Q(`Order ${ze.order.no} sent to the kitchen \u{1F389}`)}catch{Q("Network hiccup — try again","warn")}else rI(ne)}}';
const guestCall =
  'ub=async()=>{if(fe.slug)try{const Pa=new URLSearchParams(location.search),Sd=fe.storeId||Pa.get("storeId")||Pa.get("store")||Pa.get("st")||localStorage.getItem("kashikeyo.storeId")||"main";try{window.KashikeyoOffline&&window.KashikeyoOffline.setStoreId&&window.KashikeyoOffline.setStoreId(Sd)}catch{}await fetch(`/p/${fe.slug}/call?storeId=${encodeURIComponent(Sd)}`,{method:"POST",headers:{"Content-Type":"application/json","X-Store-Id":Sd},body:JSON.stringify({table:fe.table,custId:fe.custId,storeId:Sd})}),Q("\u{1F514} We\'re on our way!")}catch{}else nI()}';

/* "Lovable" theme: a warm cream/terracotta palette (from a Lovable.dev
   preview) added as a third theme alongside the existing Dark/Light toggle.
   The whole app already reads every color through one `_` object computed
   once per render (`_.app`, `_.panel`, `_.primary`, ...), so adding a theme
   here is a single swap, not hundreds of call-site edits. Custom CSS classes
   are required (not Tailwind's bg-[#hex] syntax) because this bundle ships
   pre-compiled, purged CSS — only classes Tailwind's build actually saw get
   a rule, so an invented arbitrary-value class here would render unstyled. */
const lovableCss = `
.ksh-lv-app{background-color:#F3ECE1;color:#2A241E}
.ksh-lv-header{background-color:rgba(250,246,239,.92);border-color:#E8DFCF}
.ksh-lv-panel{background-color:#FFFFFF;border:1px solid #EFE6D6}
.ksh-lv-panel2{background-color:#ECE3D3}
.ksh-lv-border{border-color:#E8DFCF}
.ksh-lv-sub{color:#8A8074}
.ksh-lv-faint{color:#B7AE9F}
.ksh-lv-input{background-color:#FFFFFF;border:1px solid #E8DFCF;color:#2A241E}
.ksh-lv-input::placeholder{color:#B7AE9F}
.ksh-lv-chip{background-color:#FBF7EF;color:#4A4238}
.ksh-lv-chipOn{background-color:#C1502D;color:#FFFFFF;border:1px solid #C1502D}
.ksh-lv-tile{background-color:#FFFFFF;border:1px solid #EFE6D6}
.ksh-lv-tile:hover{border-color:#C1502D}
.ksh-lv-nav{background-color:rgba(243,236,225,.95);border-color:#E8DFCF}
.ksh-lv-navOn{color:#C1502D}
.ksh-lv-navOff{color:#A79E8F}
.ksh-lv-modal{background-color:#FFFFFF;border:1px solid #EFE6D6}
.ksh-lv-btn{background-color:#F1E8D8;color:#4A4238}
.ksh-lv-btn:hover{background-color:#E8DCC5}
.ksh-lv-primary{background-color:#C1502D;color:#FFFFFF}
.ksh-lv-primary:hover{background-color:#AA4526}
.ksh-lv-accent{color:#C1502D}
.ksh-lv-accentBd{border-color:rgba(193,80,45,.4)}
`.replace(/\n/g, "");
const lovablePalette =
  '{app:"ksh-lv-app",header:"ksh-lv-header",panel:"ksh-lv-panel",panel2:"ksh-lv-panel2",border:"ksh-lv-border",sub:"ksh-lv-sub",faint:"ksh-lv-faint",input:"ksh-lv-input",chip:"ksh-lv-chip",chipOn:"ksh-lv-chipOn",tile:"ksh-lv-tile",nav:"ksh-lv-nav",navOn:"ksh-lv-navOn",navOff:"ksh-lv-navOff",modal:"ksh-lv-modal",btn:"ksh-lv-btn",primary:"ksh-lv-primary",accent:"ksh-lv-accent",accentBd:"ksh-lv-accentBd",axis:"#B7AE9F",bar:"#C1502D",grid:"#EFE6D6",tipBg:"#FFFFFF"}';

/* ── Multi-theme system ────────────────────────────────────────────────
   Five named fruit themes (Orange/Green Apple/Watermelon/Mango/Strawberry),
   each with a light (default) and a dark variant. Colours are delivered as
   CSS variables set by a per-theme class (.kt-<name>-<l|d>) on the app root;
   every `_` palette key maps to a fixed .ksh-* utility class that reads those
   variables. So switching theme is just swapping the root class — no
   per-theme class explosion, and fixed-position modals (in-tree) inherit the
   variables through the cascade. A light glass look (translucent panels +
   backdrop-blur + a soft gradient app background) is baked into the utility
   classes. Critically, picking a light theme also sets the app's existing
   dark flag to false, so the many `${i?"bg-slate-900":"bg-white"}` controls
   (steppers, amounts) render their light variant instead of dark-on-cream. */
const THEMES = {
  /* KashikeyoPOS design system v1 (§2 tokens): kashikeyo-fruit palette —
     keyo-600 #C7431D ripe segment (primary), sand-warm neutrals, flat white
     cards. Light mode is the money screen (bright cafés → sunlight legible:
     sand-900 #26221C text on white, never gray-on-gray). */
  orange: {
    l: { bg:"#FBFAF7", text:"#26221C", sub:"#8A8378", faint:"#B8B0A3", primary:"#C7431D", primaryHover:"#A33417", accent:"#C7431D",
         panel:"#FFFFFF", panel2:"#F4F1EB", border:"#E3DED4", input:"#FFFFFF", inputBorder:"#E3DED4", ph:"#B8B0A3",
         chip:"#F4F1EB", chipText:"#26221C", nav:"#FFFFFF", navOff:"#8A8378",
         modal:"#FFFFFF", btn:"#FFFFFF", btnText:"#26221C", btnHover:"#F4F1EB", accentBd:"rgba(199,67,29,.4)",
         axis:"#B8B0A3", bar:"#C7431D", grid:"#EFEBE2", tip:"#FFFFFF" },
    d: { bg:"#1B1713", text:"#ECE5DA", sub:"#A79E90", faint:"#7C7365", primary:"#E0794F", primaryHover:"#E88A62", accent:"#E0794F",
         panel:"#26211B", panel2:"#2F2922", border:"#3A322A", input:"#221D17", inputBorder:"#3A322A", ph:"#7C7365",
         chip:"#2F2922", chipText:"#D8CFC0", nav:"#211C16", navOff:"#7C7365",
         modal:"#26211B", btn:"#2F2922", btnText:"#E7DECF", btnHover:"#3A322A", accentBd:"rgba(224,121,79,.5)",
         axis:"#7C7365", bar:"#E0794F", grid:"#3A322A", tip:"#221D17" } },
  green: {
    l: { bg:"#EEF4E8", text:"#1E2A18", sub:"#6E7A64", faint:"#A6B29A", primary:"#4E8A3A", primaryHover:"#457C33", accent:"#4E8A3A",
         panel:"rgba(255,255,255,.86)", panel2:"rgba(228,238,219,.72)", border:"#DBE6CF", input:"#FFFFFF", inputBorder:"#DBE6CF", ph:"#A6B29A",
         chip:"rgba(240,246,233,.85)", chipText:"#3C4A32", nav:"rgba(238,244,232,.72)", navOff:"#93A085",
         modal:"rgba(255,255,255,.82)", btn:"#E4EEDA", btnText:"#3C4A32", btnHover:"#D6E4C8", accentBd:"rgba(78,138,58,.4)",
         axis:"#A6B29A", bar:"#4E8A3A", grid:"#E1EAD6", tip:"#FFFFFF" },
    d: { bg:"#131C0F", text:"#E4EFDD", sub:"#93A085", faint:"#6B7660", primary:"#7FBF5E", primaryHover:"#8ECB6E", accent:"#7FBF5E",
         panel:"rgba(30,42,24,.72)", panel2:"rgba(38,52,30,.6)", border:"#2C3A22", input:"#1C2716", inputBorder:"#2C3A22", ph:"#6B7660",
         chip:"rgba(38,52,30,.62)", chipText:"#CDDAC0", nav:"rgba(18,26,12,.72)", navOff:"#6B7660",
         modal:"rgba(28,40,22,.82)", btn:"#2C3A22", btnText:"#DDE9D2", btnHover:"#38492A", accentBd:"rgba(127,191,94,.5)",
         axis:"#6B7660", bar:"#7FBF5E", grid:"#2C3A22", tip:"#1C2716" } },
  watermelon: {
    l: { bg:"#FCECEC", text:"#2A1618", sub:"#8A6E70", faint:"#C4A6A8", primary:"#DA3B4B", primaryHover:"#C43140", accent:"#4E9A54",
         panel:"rgba(255,255,255,.86)", panel2:"rgba(250,224,224,.72)", border:"#F0D6D6", input:"#FFFFFF", inputBorder:"#F0D6D6", ph:"#C4A6A8",
         chip:"rgba(253,240,240,.85)", chipText:"#5A3E40", nav:"rgba(252,236,236,.72)", navOff:"#B58C8E",
         modal:"rgba(255,255,255,.82)", btn:"#FAE2E2", btnText:"#5A3E40", btnHover:"#F2D2D2", accentBd:"rgba(218,59,75,.4)",
         axis:"#C4A6A8", bar:"#DA3B4B", grid:"#F3DEDE", tip:"#FFFFFF" },
    d: { bg:"#1F1113", text:"#F1E1E2", sub:"#B58C8E", faint:"#7A5A5C", primary:"#F05563", primaryHover:"#F26E7A", accent:"#6FBF74",
         panel:"rgba(46,26,28,.72)", panel2:"rgba(58,34,36,.6)", border:"#3E2427", input:"#2A1618", inputBorder:"#3E2427", ph:"#7A5A5C",
         chip:"rgba(58,34,36,.62)", chipText:"#E0C4C6", nav:"rgba(28,16,18,.72)", navOff:"#7A5A5C",
         modal:"rgba(40,22,24,.82)", btn:"#3E2427", btnText:"#EAD6D8", btnHover:"#4E3034", accentBd:"rgba(240,85,99,.5)",
         axis:"#7A5A5C", bar:"#F05563", grid:"#3E2427", tip:"#241618" } },
  mango: {
    l: { bg:"#FBF3E0", text:"#2A2410", sub:"#8A7C58", faint:"#C4B688", primary:"#E19A12", primaryHover:"#C9880C", accent:"#E19A12",
         panel:"rgba(255,255,255,.86)", panel2:"rgba(248,238,214,.72)", border:"#EEE2C4", input:"#FFFFFF", inputBorder:"#EEE2C4", ph:"#C4B688",
         chip:"rgba(253,246,228,.85)", chipText:"#5A4E28", nav:"rgba(251,243,224,.72)", navOff:"#B5A578",
         modal:"rgba(255,255,255,.82)", btn:"#F6ECD2", btnText:"#5A4E28", btnHover:"#EEE0BE", accentBd:"rgba(225,154,18,.4)",
         axis:"#C4B688", bar:"#E19A12", grid:"#F1E8CE", tip:"#FFFFFF" },
    d: { bg:"#1F1B0E", text:"#F0E9D2", sub:"#B5A578", faint:"#7A6E48", primary:"#F2B733", primaryHover:"#F5C24A", accent:"#F2B733",
         panel:"rgba(46,40,22,.72)", panel2:"rgba(58,50,28,.6)", border:"#3E3620", input:"#2A2412", inputBorder:"#3E3620", ph:"#7A6E48",
         chip:"rgba(58,50,28,.62)", chipText:"#E0D2A8", nav:"rgba(28,24,12,.72)", navOff:"#7A6E48",
         modal:"rgba(40,34,18,.82)", btn:"#3E3620", btnText:"#EADFC0", btnHover:"#4E4428", accentBd:"rgba(242,183,51,.5)",
         axis:"#7A6E48", bar:"#F2B733", grid:"#3E3620", tip:"#241E10" } },
  strawberry: {
    l: { bg:"#FDECF1", text:"#2A1620", sub:"#8A6E78", faint:"#C4A6B2", primary:"#D8437A", primaryHover:"#C43A6E", accent:"#D8437A",
         panel:"rgba(255,255,255,.86)", panel2:"rgba(250,224,234,.72)", border:"#F0D6E0", input:"#FFFFFF", inputBorder:"#F0D6E0", ph:"#C4A6B2",
         chip:"rgba(253,240,245,.85)", chipText:"#5A3E48", nav:"rgba(253,236,241,.72)", navOff:"#B58CA0",
         modal:"rgba(255,255,255,.82)", btn:"#FAE2EC", btnText:"#5A3E48", btnHover:"#F2D2E0", accentBd:"rgba(216,67,122,.4)",
         axis:"#C4A6B2", bar:"#D8437A", grid:"#F3DEE8", tip:"#FFFFFF" },
    d: { bg:"#1F1118", text:"#F1E1E8", sub:"#B58CA0", faint:"#7A5A68", primary:"#F06C9B", primaryHover:"#F282AC", accent:"#F06C9B",
         panel:"rgba(46,26,34,.72)", panel2:"rgba(58,34,44,.6)", border:"#3E2432", input:"#2A1620", inputBorder:"#3E2432", ph:"#7A5A68",
         chip:"rgba(58,34,44,.62)", chipText:"#E0C4D0", nav:"rgba(28,16,22,.72)", navOff:"#7A5A68",
         modal:"rgba(40,22,30,.82)", btn:"#3E2432", btnText:"#EAD6E0", btnHover:"#4E3040", accentBd:"rgba(240,108,155,.5)",
         axis:"#7A5A68", bar:"#F06C9B", grid:"#3E2432", tip:"#241620" } },
};

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
/* Design system §4 rejects "stacked glows" — the register is a dense,
   sunlight-legible screen, so the app background is the flat sand-25 well,
   not a layered radial gradient. */
function appGrad(c) {
  return c.bg;
}
function varBlock(sel, c) {
  return `${sel}{--k-appbg:${appGrad(c)};--k-text:${c.text};--k-sub:${c.sub};--k-faint:${c.faint};--k-primary:${c.primary};--k-primary-h:${c.primaryHover};--k-accent:${c.accent};--k-panel:${c.panel};--k-panel2:${c.panel2};--k-border:${c.border};--k-input:${c.input};--k-input-border:${c.inputBorder};--k-ph:${c.ph};--k-chip:${c.chip};--k-chip-text:${c.chipText};--k-nav:${c.nav};--k-navoff:${c.navOff};--k-modal:${c.modal};--k-btn:${c.btn};--k-btn-text:${c.btnText};--k-btn-h:${c.btnHover};--k-accentbd:${c.accentBd}}`;
}
const themeVarsCss = (
  varBlock(":root", THEMES.orange.l) +
  Object.keys(THEMES).map((t) => varBlock(`.kt-${t}-l`, THEMES[t].l) + varBlock(`.kt-${t}-d`, THEMES[t].d)).join("")
);
const themeUtilCss = `
.ksh-app{background:var(--k-appbg);color:var(--k-text)}
.ksh-header{background:var(--k-nav);border-color:var(--k-border);-webkit-backdrop-filter:blur(16px) saturate(1.4);backdrop-filter:blur(16px) saturate(1.4)}
.ksh-nav{background:var(--k-nav);border-color:var(--k-border);-webkit-backdrop-filter:blur(16px) saturate(1.4);backdrop-filter:blur(16px) saturate(1.4)}
.ksh-panel{background:var(--k-panel);border:1px solid var(--k-border);box-shadow:0 1px 2px rgba(38,34,28,.04),0 10px 30px rgba(38,34,28,.05)}
.ksh-panel2{background:var(--k-panel2)}
.ksh-border{border-color:var(--k-border)}
.ksh-sub{color:var(--k-sub)}
.ksh-faint{color:var(--k-faint)}
.ksh-input{background:var(--k-input);border:1px solid var(--k-input-border);color:var(--k-text)}
.ksh-input::placeholder{color:var(--k-ph)}
.ksh-chip{background:var(--k-chip);color:var(--k-chip-text)}
.ksh-chipOn{background:var(--k-primary);color:#fff;border:1px solid var(--k-primary)}
.ksh-tile{background:var(--k-panel);border:1px solid var(--k-border);box-shadow:0 1px 2px rgba(38,34,28,.05);transition:box-shadow .18s ease,transform .18s ease,border-color .18s ease}
.ksh-tile:hover{border-color:var(--k-primary);box-shadow:0 6px 18px rgba(38,34,28,.10);transform:translateY(-2px)}
.ksh-navOn{color:var(--k-primary)}
.ksh-navOff{color:var(--k-navoff)}
.ksh-modal{background:var(--k-modal);border:1px solid var(--k-border);-webkit-backdrop-filter:blur(20px) saturate(1.4);backdrop-filter:blur(20px) saturate(1.4)}
.ksh-btn{background:var(--k-btn);color:var(--k-btn-text);border:1px solid var(--k-border)}
.ksh-btn:hover{background:var(--k-btn-h)}
.ksh-primary{background:var(--k-primary);color:#fff}
.ksh-primary:hover{background:var(--k-primary-h)}
.ksh-accent{color:var(--k-accent)}
.ksh-accentBd{border-color:var(--k-accentbd)}
@media(min-width:1024px){.ksh-reg-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1rem}.ksh-col1{grid-column:span 1/span 1}}
.ksh-pill{display:inline-flex;align-items:center;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;line-height:1;white-space:nowrap}
@keyframes kshexfill{0%,100%{opacity:.16}50%{opacity:1}}
.ksh-hexspin{display:block}
.ksh-hexspin path{fill:var(--k-primary);stroke:var(--k-appbg);stroke-width:2;animation:kshexfill 1.15s ease-in-out infinite}
.ksh-hexspin path:nth-child(1){animation-delay:0s}.ksh-hexspin path:nth-child(2){animation-delay:.19s}.ksh-hexspin path:nth-child(3){animation-delay:.38s}.ksh-hexspin path:nth-child(4){animation-delay:.57s}.ksh-hexspin path:nth-child(5){animation-delay:.76s}.ksh-hexspin path:nth-child(6){animation-delay:.95s}
.ksh-hexbg path{fill:none;stroke:var(--k-primary);stroke-width:1.4;opacity:.28}
@media (prefers-reduced-motion:reduce){.ksh-hexspin path{animation:none;opacity:.6}}
`.replace(/\n/g, "");

/* Design system §3 typography. Self-hosted (web/dist/fonts) variable woff2 —
   no font CDN, so it works offline in the PWA. DM Sans body (continuity with
   the Steva family), Bricolage Grotesque for headings + big numbers ("a face
   that isn't Inter-everywhere"), JetBrains Mono for order IDs/receipts. Two
   subsets per family (latin + latin-ext, the latter covers names like Malé).
   Injected after Tailwind so .font-mono/body overrides win on source order. */
const UR_LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const UR_LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const face = (fam, wght, file, range) => `@font-face{font-family:'${fam}';font-style:normal;font-weight:${wght};font-display:swap;src:url(/fonts/${file}.woff2) format('woff2');unicode-range:${range}}`;
const fontsCss = (
  face("DM Sans", "400 700", "dmsans-1", UR_LATIN) + face("DM Sans", "400 700", "dmsans-0", UR_LATIN_EXT) +
  face("Bricolage Grotesque", "500 800", "bricolage-1", UR_LATIN) + face("Bricolage Grotesque", "500 800", "bricolage-0", UR_LATIN_EXT) +
  face("JetBrains Mono", "400 600", "jbmono-1", UR_LATIN) + face("JetBrains Mono", "400 600", "jbmono-0", UR_LATIN_EXT) +
  `.ksh-app{font-family:'DM Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}` +
  `.ksh-app .font-mono,.ksh-app code,.ksh-app kbd,.ksh-app pre{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}` +
  `.ksh-app h1,.ksh-app h2,.ksh-app h3,.ksh-display{font-family:'Bricolage Grotesque','DM Sans',sans-serif;letter-spacing:-0.01em}`
);
const chartObj = "{" + Object.keys(THEMES).map((t) => {
  const ch = (v) => `{axis:"${THEMES[t][v].axis}",bar:"${THEMES[t][v].bar}",grid:"${THEMES[t][v].grid}",tipBg:"${THEMES[t][v].tip}"}`;
  return `${t}:{l:${ch("l")},d:${ch("d")}}`;
}).join(",") + "}";
const kpalJs = `window.__kpal=function(t,dark){var CH=${chartObj};var ok=CH[t]?t:"orange";var c=CH[ok][dark?"d":"l"];return{app:"ksh-app kt-"+ok+(dark?"-d":"-l"),header:"ksh-header",panel:"ksh-panel",panel2:"ksh-panel2",border:"ksh-border",sub:"ksh-sub",faint:"ksh-faint",input:"ksh-input",chip:"ksh-chip",chipOn:"ksh-chipOn",tile:"ksh-tile",nav:"ksh-nav",navOn:"ksh-navOn",navOff:"ksh-navOff",modal:"ksh-modal",btn:"ksh-btn",primary:"ksh-primary",accent:"ksh-accent",accentBd:"ksh-accentBd",axis:c.axis,bar:c.bar,grid:c.grid,tipBg:c.tipBg};};`;

/* ── Sound alerts ─────────────────────────────────────────────────────────
   A tiny WebAudio chime synthesizer (no audio files) shared by the till and
   the guest portal via window.__ksnd. Browsers block audio until a user
   gesture, so the AudioContext is resumed on the first pointer/key event —
   staff tap a PIN and guests tap to order, so it unlocks naturally. Plays are
   suppressed for the first few seconds after load so the initial data sync
   (which pulls historic orders/calls) is silent. Per-device mute lives in
   localStorage. Distinct patterns: waiter (urgent triple), order (two-note
   ding), status (soft rising chime), ok (single blip), alert (buzz). */
const sndJs = `(function(){
  var ctx=null, armed=false;
  function ac(){ if(!ctx){ try{ ctx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } return ctx; }
  function unlock(){ var c=ac(); if(c&&c.state==='suspended'){ try{c.resume();}catch(e){} } }
  try{ document.addEventListener('pointerdown',unlock,true); document.addEventListener('keydown',unlock,true); }catch(e){}
  setTimeout(function(){ armed=true; }, 3500);
  function muted(){ try{ return localStorage.getItem('kashikeyo-mute')==='1'; }catch(e){ return false; } }
  function tone(freq,dur,when,type,gain){
    var c=ac(); if(!c) return;
    var o=c.createOscillator(), g=c.createGain();
    o.type=type||'sine'; o.frequency.value=freq; o.connect(g); g.connect(c.destination);
    var t=c.currentTime+(when||0);
    g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(gain||0.18,t+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    o.start(t); o.stop(t+dur+0.03);
  }
  var P={
    waiter:function(){ tone(880,0.15,0,'sine',0.25); tone(1175,0.18,0.17,'sine',0.25); tone(880,0.22,0.36,'sine',0.22); },
    order:function(){ tone(660,0.13,0,'sine',0.22); tone(988,0.17,0.14,'sine',0.22); },
    status:function(){ tone(784,0.11,0,'sine',0.17); tone(1047,0.15,0.11,'sine',0.17); },
    ok:function(){ tone(1047,0.11,0,'sine',0.15); },
    alert:function(){ tone(392,0.16,0,'triangle',0.16); tone(392,0.16,0.2,'triangle',0.16); },
    /* "food's up" — a bright rising chime the counter hears when the kitchen
       marks an order ready to be delivered. */
    ready:function(){ tone(1047,0.13,0,'sine',0.24); tone(1319,0.15,0.12,'sine',0.24); tone(1568,0.26,0.26,'sine',0.2); }
  };
  var last={};
  window.__ksnd={
    play:function(kind,opts){
      if(muted()) return;
      if(!(opts&&opts.force)&&!armed) return;
      var now=Date.now(); if(!(opts&&opts.force) && now-(last[kind]||0)<700) return; last[kind]=now;
      unlock(); (P[kind]||P.ok)();
      try{ navigator.vibrate && navigator.vibrate(kind==='waiter'?[90,60,90]:60); }catch(e){}
    },
    muted:muted,
    setMuted:function(m){ try{ localStorage.setItem('kashikeyo-mute',m?'1':'0'); }catch(e){} },
    unlock:unlock
  };
})();`;

/* ── Dashboard chart ──────────────────────────────────────────────────────
   The bundle only tree-shook Recharts' BarChart in, so the line/area view is
   drawn as hand-built SVG. window.__ksChart returns an <svg> string holding
   both a line+area group and a bar group; the visible one is chosen from the
   localStorage mode (default "line"). The Line/Bars toggle flips them via the
   DOM — React state would reset on the dashboard's data-poll re-render. */
/* Design system §5: ONE status scale, resolved identically everywhere. Each
   entry is [tint-bg, 700-text, label] straight from the §2 semantic tokens;
   the app's lifecycle statuses fold onto it (ready→served teal, delivered/
   settled→completed green, wasted→cancelled red). */
const statusJs = `window.__kstatus=function(s){s=String(s||'').toLowerCase();var M={new:['#FEF3C7','#B45309','New'],pending:['#FEF3C7','#B45309','Pending'],preparing:['#DBEAFE','#1D4ED8','Preparing'],cooking:['#DBEAFE','#1D4ED8','Preparing'],ready:['#CCFBF1','#0F766E','Ready'],served:['#CCFBF1','#0F766E','Served'],delivered:['#DCFCE7','#15803D','Delivered'],completed:['#DCFCE7','#15803D','Done'],settled:['#DCFCE7','#15803D','Done'],paid:['#DCFCE7','#15803D','Done'],closed:['#DCFCE7','#15803D','Done'],wasted:['#FEE2E2','#B91C1C','Void'],cancelled:['#FEE2E2','#B91C1C','Cancelled'],refunded:['#FEE2E2','#B91C1C','Refunded'],offline:['#E7E5E4','#78716C','Offline']};var c=M[s]||['#F4F1EB','#8A8378',(s?s.charAt(0).toUpperCase()+s.slice(1):'—')];return{bg:c[0],fg:c[1],label:c[2]};};`;

/* Design system §1 signature: the kashikeyo hex-segment motif (fruit
   cross-section) — a hexagon split into six wedges from the centre. Used only
   in the loading spinner (wedges pulse clockwise) and empty states (faint
   outline). __kshexSvg(cls,size) returns the raw SVG for dangerouslySetInnerHTML. */
const hexJs = "window.__kshexSvg=function(cls,size){var p='';for(var i=0;i<6;i++){var a1=i*Math.PI/3,a2=(i+1)*Math.PI/3;p+='<path d=\"M50 50L'+(50+42*Math.cos(a1)).toFixed(1)+' '+(50+42*Math.sin(a1)).toFixed(1)+'L'+(50+42*Math.cos(a2)).toFixed(1)+' '+(50+42*Math.sin(a2)).toFixed(1)+'Z\"/>';}return '<svg viewBox=\"0 0 100 100\" class=\"'+cls+'\" width=\"'+size+'\" height=\"'+size+'\" aria-hidden=\"true\">'+p+'</svg>';};";

/* Out-of-stock predicate shared by every ordering surface: a product is
   unavailable when it's manually sold out, when it's recipe-tracked and the
   ingredient engine says zero servings remain (data.recipeAvail<=0), or when a
   stock-tracked product hit zero. Items with no stock field (services) are
   always sellable. */
const availJs = "window.__ksOut=function(f){if(!f)return false;if(f.soldOut===true||f.available===false)return true;if(f.recipeAvail!=null)return Number(f.recipeAvail)<=0;return f.stock!=null&&Number(f.stock)<=0;};";

/* Order-progress ring (§4, from the reference design): each live order card
   carries a small circular gauge of how far along it is. Progress is derived
   from the order's lifecycle status (new→preparing→ready→done) so it needs no
   extra data; a finished order shows a check instead of a number. __ksRing
   returns raw SVG for dangerouslySetInnerHTML; the track uses the theme border
   var and the arc + label take the status colour from __kstatus. */
const ringJs = "window.__ksProg=function(s){s=String(s||'').toLowerCase();var M={new:12,pending:12,preparing:55,cooking:55,ready:88,served:88,delivered:100,completed:100,settled:100,paid:100,closed:100,done:100};return M[s]!=null?M[s]:12;};"
  + "window.__ksRing=function(pct,color,size){pct=Math.max(0,Math.min(100,Number(pct)||0));var r=15.5,c=2*Math.PI*r,off=c*(1-pct/100),s=size||40,col=color||'#C1502D';var mid=pct>=100?'<path d=\"M14.5 20.4l3.6 3.6 7-7.6\" fill=\"none\" stroke=\"'+col+'\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>':'<text x=\"20\" y=\"20\" text-anchor=\"middle\" dominant-baseline=\"central\" font-size=\"11\" font-weight=\"700\" fill=\"'+col+'\">'+Math.round(pct)+'</text>';return '<svg width=\"'+s+'\" height=\"'+s+'\" viewBox=\"0 0 40 40\" style=\"display:block\"><circle cx=\"20\" cy=\"20\" r=\"'+r+'\" fill=\"none\" stroke=\"var(--k-border)\" stroke-width=\"3.5\"/><circle cx=\"20\" cy=\"20\" r=\"'+r+'\" fill=\"none\" stroke=\"'+col+'\" stroke-width=\"3.5\" stroke-linecap=\"round\" stroke-dasharray=\"'+c.toFixed(2)+'\" stroke-dashoffset=\"'+off.toFixed(2)+'\" transform=\"rotate(-90 20 20)\"/>'+mid+'</svg>';};";

/* Rotating guest welcome (§4.3). A café gets the same faces every day, so the
   QR menu greets with a different friendly line each visit. Picked once per page
   load (memoised) and never the same as the previous visit (last index kept in
   localStorage), so repeat visits keep feeling fresh. */
const greetJs = "window.__ksGreet=(function(){var p=null,L=['Order now and savor your favorites','What are you craving today?','Freshly made, just for you','Treat yourself today','Hungry? You are in the right place','So good to see you again','Find your new favorite','Great taste starts right here','Your feast is a few taps away','Pick something delicious','Good things are cooking here','A warm welcome to your table'];return function(){if(p!==null)return p;try{var last=parseInt(localStorage.getItem('ksh-greet'),10);if(isNaN(last))last=-1;var i;do{i=Math.floor(Math.random()*L.length)}while(L.length>1&&i===last);localStorage.setItem('ksh-greet',String(i));p=L[i]}catch(e){p=L[0]}return p}})();";

const chartJs = `window.__ksChartMode=function(){try{return localStorage.getItem('ksh-chart')==='bar'?'bar':'line';}catch(e){return 'line';}};
window.__ksChart=function(data,pal){
  var mode=window.__ksChartMode();
  var W=320,H=120,PL=2,PR=2,PT=8,PB=6,D=data||[],n=D.length||1,max=1;
  D.forEach(function(d){ if(d.v>max) max=d.v; });
  function X(i){ return n<=1?W/2:PL+i*(W-PL-PR)/(n-1); }
  function Y(v){ return H-PB-(v/max)*(H-PT-PB); }
  var lp='';D.forEach(function(d,i){ lp+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(d.v).toFixed(1)+' '; });
  var ap=D.length?('M'+X(0).toFixed(1)+' '+(H-PB)+' '+lp.replace(/^M/,'L')+'L'+X(D.length-1).toFixed(1)+' '+(H-PB)+' Z'):'';
  var bw=Math.max(2,(W-PL-PR)/n*0.6),bars='';
  D.forEach(function(d,i){ var by=Y(d.v); bars+='<rect x="'+(X(i)-bw/2).toFixed(1)+'" y="'+by.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(0.5,(H-PB)-by).toFixed(1)+'" rx="2" fill="'+pal.bar+'"/>'; });
  var grid='';for(var g=1;g<=3;g++){ var gy=(PT+(H-PT-PB)*g/4).toFixed(1); grid+='<line x1="'+PL+'" y1="'+gy+'" x2="'+(W-PR)+'" y2="'+gy+'" stroke="'+pal.grid+'" stroke-width="0.6" stroke-dasharray="3 4"/>'; }
  var lineG='<g class="ksch-line" style="'+(mode==='bar'?'display:none':'')+'"><path d="'+ap+'" fill="url(#ksgrad)"/><path d="'+lp+'" fill="none" stroke="'+pal.bar+'" stroke-width="2.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></g>';
  var barG='<g class="ksch-bar" style="'+(mode==='bar'?'':'display:none')+'">'+bars+'</g>';
  return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" style="width:100%;height:100%;display:block"><defs><linearGradient id="ksgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+pal.bar+'" stop-opacity="0.30"/><stop offset="1" stop-color="'+pal.bar+'" stop-opacity="0.02"/></linearGradient></defs>'+grid+lineG+barG+'</svg>';
};
window.__ksChartToggle=function(mode){
  try{ localStorage.setItem('ksh-chart',mode); }catch(e){}
  document.querySelectorAll('.ksch-line').forEach(function(el){ el.style.display=mode==='bar'?'none':''; });
  document.querySelectorAll('.ksch-bar').forEach(function(el){ el.style.display=mode==='bar'?'':'none'; });
  document.querySelectorAll('[data-kscht]').forEach(function(b){ b.setAttribute('data-on', b.getAttribute('data-kscht')===mode?'1':'0'); });
};
window.__ksSpark=function(data,pal){
  var D=data||[],W=200,H=34,P=3,n=D.length||1,max=1,min=1e18;
  D.forEach(function(d){ if(d.v>max)max=d.v; if(d.v<min)min=d.v; });
  if(min===1e18)min=0; var rng=(max-min)||1;
  function X(i){ return n<=1?W/2:P+i*(W-2*P)/(n-1); }
  function Y(v){ return H-P-((v-min)/rng)*(H-2*P); }
  var lp='';D.forEach(function(d,i){ lp+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(d.v).toFixed(1)+' '; });
  var ap=D.length?('M'+X(0).toFixed(1)+' '+(H-P)+' '+lp.replace(/^M/,'L')+'L'+X(D.length-1).toFixed(1)+' '+(H-P)+' Z'):'';
  return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" style="width:100%;height:100%;display:block"><defs><linearGradient id="kssg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+pal.bar+'" stop-opacity="0.24"/><stop offset="1" stop-color="'+pal.bar+'" stop-opacity="0"/></linearGradient></defs><path d="'+ap+'" fill="url(#kssg)"/><path d="'+lp+'" fill="none" stroke="'+pal.bar+'" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>';
};`;

/* Update-in-place CSS injection: wrap the payload in a marker comment and
   replace it on re-bake, so *changing* a CSS block (e.g. the theme palette)
   never leaves a stale duplicate behind. Appends before the first </style>
   the first time, so the block sits after Tailwind and wins on source order. */
function injectCss(html, css, marker) {
  const block = `/*${marker}*/${css}/*/${marker}*/`;
  const re = new RegExp(`/\\*${marker}\\*/[\\s\\S]*?/\\*/${marker}\\*/`);
  if (re.test(html)) return html.replace(re, block);
  return html.replace("</style>", block + "</style>");
}

function injectScript(html, src) {
  if (html.includes(src)) return html;
  const tag = `<script src="/${src}"></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  return tag + html;
}

function injectInline(html, marker, js) {
  const tag = `<script>/*${marker}*/${js}</script>`;
  /* Update-in-place: if this marker's script already exists, replace its body
     so edits to the helper propagate on re-bake (and re-baking identical
     content is a no-op). */
  const re = new RegExp(`<script>/\\*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*/[\\s\\S]*?</script>`);
  if (re.test(html)) return html.replace(re, tag);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  return tag + html;
}

/* Dark item sheet (§4.3, reference design): only the guest item-detail sheet
   goes charcoal — the rest of the app keeps its light palette. Scoped to the
   .ksh-isheet wrapper so the add-on rows, muted text and radios follow, while
   the orange "Add to cart" (ksh-primary) is untouched. */
const isheetCss = ".ksh-isheet{background:#211c19;color:#f5f1ea;box-shadow:0 -8px 40px rgba(0,0,0,.45)}.ksh-isheet .ksh-panel2{background:rgba(255,255,255,.09)}.ksh-isheet .ksh-sub{color:rgba(245,241,234,.74)}.ksh-isheet .ksh-faint{color:rgba(245,241,234,.5)}";

patchFile(indexPath, (html) => {
  html = injectScript(html, "offline-bridge.js");
  html = injectCss(html, lovableCss, "ksh-lovable");
  html = injectCss(html, isheetCss, "ksh-isheet");
  html = injectCss(html, themeVarsCss + themeUtilCss, "ksh-theme");
  html = injectCss(html, fontsCss, "ksh-fonts");
  html = injectInline(html, "ksh-kpal", kpalJs);
  html = injectInline(html, "ksh-snd", sndJs);
  html = injectInline(html, "ksh-chart", chartJs);
  html = injectInline(html, "ksh-status", statusJs);
  html = injectInline(html, "ksh-hex", hexJs);
  html = injectInline(html, "ksh-avail", availJs);
  html = injectInline(html, "ksh-ring", ringJs);
  html = injectInline(html, "ksh-greet", greetJs);
  html = injectCss(html, '.ksch-tab{transition:background .15s,color .15s;color:var(--k-sub,#8A8074)}.ksch-tab[data-on="1"]{background:var(--k-primary,#C1502D);color:#fff}');
  return html
  /* 76. Stock tracking is opt-in per product (fixes "Sold out after one sale").
     The catalogue form defaulted a new product's stock to "0", so patch #73's
     sold-out gate (__ksOut: stock<=0 ⇒ unavailable) fired on every product a
     merchant added but never stocked — and any item left untracked was driven
     to -1 by the first sale's stock delta. A café that sells make-to-order
     items (coffee, juice) never wants that. Now: leave stock blank ⇒ the item
     is untracked and always sellable; enter a number ⇒ it is stock-tracked and
     the §24 sold-out gate applies. (Mirror server guards live in index.js: the
     sale delta only touches products that already carry a numeric stock, and
     the guest menu keeps untracked items visible.)
     Each find is consumed by its replacement, so all five are no-ops on re-bake. */
  /* 76a. New-product form starts with stock blank, not "0". */
  .replace(
    'reorder:"10",stock:"0",unit:"pcs"',
    'reorder:"10",stock:"",unit:"pcs"'
  )
  /* 76b. Editing an untracked product shows a blank stock field, not "null". */
  .replace(
    'reorder:String(f.reorder),stock:String(f.stock),unit:f.unit',
    'reorder:String(f.reorder),stock:f.stock==null?"":String(f.stock),unit:f.unit'
  )
  /* 76c. Saving with stock left blank stores no stock (untracked), not 0. */
  .replace(
    'reorder:Number(f.reorder)||0,stock:Number(f.stock)||0,unit:f.unit',
    'reorder:Number(f.reorder)||0,stock:f.stock===""||f.stock==null?null:Number(f.stock)||0,unit:f.unit'
  )
  /* 76d. Settling a sale never decrements (or oversell-warns) an untracked item. */
  .replace(
    'const I=f.find(F=>F.pid===N.id);if(!I)return N;const j=N.stock-I.qty;',
    'const I=f.find(F=>F.pid===N.id);if(!I||N.stock==null)return N;const j=N.stock-I.qty;'
  )
  /* 76e. Refunding never re-stocks an untracked item. */
  .replace(
    'return F?{...j,stock:j.stock+F.qty}:j',
    'return F&&j.stock!=null?{...j,stock:j.stock+F.qty}:j'
  )
  /* 76f. Make the opt-in stock behaviour discoverable at the point of entry:
     the stock field placeholder spells out that blank means untracked. */
  .replace(
    'placeholder:"Opening stock"',
    'placeholder:"Opening stock — blank if not counted"'
  )
  /* 77. Loyalty preview: when a member is on the ticket, their points line now
     also shows what the current sale will earn (+N this sale), so the cashier
     can tell the guest before settling — not only on the receipt afterwards.
     Same formula the settle path uses (floor(total / loyaltyBp)); hidden when
     the earn rounds to zero or the cart is empty. Find ends `pts`}) whereas the
     replacement ends `pts${…}`}), so it is a no-op on re-bake. */
  .replace(
    'children:(He.balance||0)>0?`owes ${Y(He.balance)}`:`${He.points} pts`})',
    'children:(He.balance||0)>0?`owes ${Y(He.balance)}`:`${He.points} pts${Math.floor(cr.total/(ce.loyaltyBp||1e4))>0?` · +${Math.floor(cr.total/(ce.loyaltyBp||1e4))} this sale`:""}`})'
  )
  /* 75. Waiter calls stuck on the till after "On my way". Accepting removed
     the call from local state and pushed a server delete (patch 52), but a
     pull already in flight when the button was tapped could re-apply the same
     call (still deleted=false on the server for those few hundred ms) — and it
     lands back in the shared waiterCalls state that feeds the Orders list, the
     header 🔔 count and the nav badge, so it looks stuck on the main module.
     Fix: a device-local "dismissed" set. Accept records the id; both the
     incremental pull-apply and the saved-state restore drop any dismissed id,
     so an in-flight echo can never resurrect an accepted call on this device.
     The server delete still clears it for everyone else, and a fresh reload
     (empty set) correctly re-shows anything that was never really handled.
     Each find is consumed by its replacement, so all three are no-ops on
     re-bakes. */
  .replace(
    'h.jsx("button",{onClick:()=>{uu(A=>A.filter(N=>N.id!==f.id));try{FT([],[{kind:"waiterCalls",id:f.id}])}catch{}},className:"rounded-lg px-3 py-1.5 text-xs font-semibold bg-amber-500 text-slate-950",children:"On my way"})',
    'h.jsx("button",{onClick:()=>{try{(window.__ksDismissedCalls=window.__ksDismissedCalls||new Set).add(f.id)}catch{}uu(A=>A.filter(N=>N.id!==f.id));try{FT([],[{kind:"waiterCalls",id:f.id}])}catch{}},className:"rounded-lg px-3 py-1.5 text-xs font-semibold bg-amber-500 text-slate-950",children:"On my way"})'
  )
  .replace(
    'N(uu,A.waiterCalls,"waiterCalls")',
    'N(uu,A.waiterCalls.filter(_c=>!(window.__ksDismissedCalls&&window.__ksDismissedCalls.has(_c.id))),"waiterCalls")'
  )
  .replace(
    'uu(f.waiterCalls||[])',
    'uu((f.waiterCalls||[]).filter(_c=>!(window.__ksDismissedCalls&&window.__ksDismissedCalls.has(_c.id))))'
  )
  .replace(
    '[i,a]=R.useState(!0),[o,s]=R.useState("sell")',
    '[i,a]=R.useState(!0),[KshLovable,KshSetLovable]=R.useState(!1),[o,s]=R.useState("sell")'
  )
  .replace(
    'const _=i?{app:"bg-slate-950 text-slate-100",header:"bg-slate-950/90 border-slate-800",panel:"bg-slate-900 border border-slate-800",panel2:"bg-slate-800/60",border:"border-slate-800",sub:"text-slate-400",faint:"text-slate-500",input:"bg-slate-900 border border-slate-700 text-slate-100 placeholder-slate-500",chip:"bg-slate-800 text-slate-300",chipOn:"bg-cyan-500/15 text-cyan-300 border border-cyan-500/40",tile:"bg-slate-900 border border-slate-800 hover:border-cyan-500/60",nav:"bg-slate-950/95 border-slate-800",navOn:"text-cyan-400",navOff:"text-slate-500",modal:"bg-slate-900 border border-slate-700",btn:"bg-slate-800 hover:bg-slate-700 text-slate-200",primary:"bg-cyan-500 hover:bg-cyan-400 text-slate-950",accent:"text-cyan-400",accentBd:"border-cyan-500/40",axis:"#64748b",bar:"#22d3ee",grid:"#1e293b",tipBg:"#0f172a"}:{app:"bg-slate-100 text-slate-900",header:"bg-white/90 border-slate-200",panel:"bg-white border border-slate-200",panel2:"bg-slate-100",border:"border-slate-200",sub:"text-slate-500",faint:"text-slate-400",input:"bg-white border border-slate-300 text-slate-900 placeholder-slate-400",chip:"bg-slate-200 text-slate-600",chipOn:"bg-cyan-600/10 text-cyan-700 border border-cyan-600/40",tile:"bg-white border border-slate-200 hover:border-cyan-500",nav:"bg-white/95 border-slate-200",navOn:"text-cyan-600",navOff:"text-slate-400",modal:"bg-white border border-slate-200",btn:"bg-slate-200 hover:bg-slate-300 text-slate-700",primary:"bg-cyan-600 hover:bg-cyan-500 text-white",accent:"text-cyan-600",accentBd:"border-cyan-600/40",axis:"#94a3b8",bar:"#0891b2",grid:"#e2e8f0",tipBg:"#ffffff"}',
    `const _=KshLovable?${lovablePalette}:i?{app:"bg-slate-950 text-slate-100",header:"bg-slate-950/90 border-slate-800",panel:"bg-slate-900 border border-slate-800",panel2:"bg-slate-800/60",border:"border-slate-800",sub:"text-slate-400",faint:"text-slate-500",input:"bg-slate-900 border border-slate-700 text-slate-100 placeholder-slate-500",chip:"bg-slate-800 text-slate-300",chipOn:"bg-cyan-500/15 text-cyan-300 border border-cyan-500/40",tile:"bg-slate-900 border border-slate-800 hover:border-cyan-500/60",nav:"bg-slate-950/95 border-slate-800",navOn:"text-cyan-400",navOff:"text-slate-500",modal:"bg-slate-900 border border-slate-700",btn:"bg-slate-800 hover:bg-slate-700 text-slate-200",primary:"bg-cyan-500 hover:bg-cyan-400 text-slate-950",accent:"text-cyan-400",accentBd:"border-cyan-500/40",axis:"#64748b",bar:"#22d3ee",grid:"#1e293b",tipBg:"#0f172a"}:{app:"bg-slate-100 text-slate-900",header:"bg-white/90 border-slate-200",panel:"bg-white border border-slate-200",panel2:"bg-slate-100",border:"border-slate-200",sub:"text-slate-500",faint:"text-slate-400",input:"bg-white border border-slate-300 text-slate-900 placeholder-slate-400",chip:"bg-slate-200 text-slate-600",chipOn:"bg-cyan-600/10 text-cyan-700 border border-cyan-600/40",tile:"bg-white border border-slate-200 hover:border-cyan-500",nav:"bg-white/95 border-slate-200",navOn:"text-cyan-600",navOff:"text-slate-400",modal:"bg-white border border-slate-200",btn:"bg-slate-200 hover:bg-slate-300 text-slate-700",primary:"bg-cyan-600 hover:bg-cyan-500 text-white",accent:"text-cyan-600",accentBd:"border-cyan-600/40",axis:"#94a3b8",bar:"#0891b2",grid:"#e2e8f0",tipBg:"#ffffff"}`
  )
  .replace(
    'dark:i,units:T',
    'dark:i,lovable:KshLovable,units:T'
  )
  .replace(
    'a(f.dark!==!1),rn.current=f.seq||1041',
    'a(f.dark!==!1),KshSetLovable(f.lovable===!0),rn.current=f.seq||1041'
  )
  .replace(
    '350))},[c,p,m,b,g,C,E,ce,d1,Ti,h1,i]),R.useEffect',
    '350))},[c,p,m,b,g,C,E,ce,d1,Ti,h1,i,KshLovable]),R.useEffect'
  )
  .replace(
    'h.jsxs("button",{onClick:()=>a(!i),className:`w-full flex items-center gap-3 rounded-xl px-4 py-3 mb-2 text-sm ${_.panel2}`,children:[i?h.jsx(Ck,{size:16}):h.jsx(pk,{size:16}),h.jsx("span",{className:"flex-1 text-left",children:i?"Switch to light theme":"Switch to dark theme"})]}),h.jsxs("button",{onClick:jI,',
    'h.jsxs("button",{onClick:()=>a(!i),className:`w-full flex items-center gap-3 rounded-xl px-4 py-3 mb-2 text-sm ${_.panel2}`,children:[i?h.jsx(Ck,{size:16}):h.jsx(pk,{size:16}),h.jsx("span",{className:"flex-1 text-left",children:i?"Switch to light theme":"Switch to dark theme"})]}),h.jsxs("button",{onClick:()=>KshSetLovable(v=>!v),className:`w-full flex items-center gap-3 rounded-xl px-4 py-3 mb-2 text-sm ${_.panel2}`,children:[h.jsx("span",{className:"w-4 h-4 rounded-full inline-block flex-shrink-0",style:{background:"linear-gradient(135deg,#C1502D 50%,#F3ECE1 50%)",border:"1px solid rgba(0,0,0,.15)"}}),h.jsx("span",{className:"flex-1 text-left",children:KshLovable?"Switch to classic theme":"Switch to Lovable theme"})]}),h.jsxs("button",{onClick:jI,'
  )
  .replace(
    'h.jsx("div",{className:"flex gap-1.5 mb-2",children:(fe.table?[["table","To table "+fe.table],["delivery","Delivery"]]:[["pickup","Pickup"],["delivery","Delivery"]]).map(([ne,ke])=>h.jsx("button",{onClick:()=>Dn(ze=>({...ze,gtype:ne})),className:`flex-1 rounded-lg py-2 text-xs font-semibold ${fe.gtype===ne?_.chipOn:_.chip}`,children:ke},ne))}),fe.gtype==="delivery"&&',
    orderTypeToggle
  )
  .replace(/rI=f=>\{if\(!R1\.length\)return;const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
  .replace(/rI=async f=>\{if\(!R1\.length\)return;const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
  .replace(/rI=async f=>\{if\(!fe\.cart\.length\)return Q\("Cart is empty","warn"\);const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
  .replace(/rI=async f=>\{if\(!fe\.cart\.length\)return Q\("Cart is empty","warn"\);if\(fe\.gtype==="table"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
  .replace(
    'rI=async f=>{if(!fe.cart.length)return Q("Cart is empty","warn");const Mo=window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.getOrderMode?window.KashikeyoGuestProfile.getOrderMode():"",A=Mo==="dinein"?"dinein":fe.gtype==="delivery"?"delivery":fe.gtype==="pickup"?"takeaway":"dinein";if(A==="delivery"&&!Ou&&M.length)return Q("Pick your delivery zone first","warn");const St=fe.slug||(typeof Ie!=="undefined"&&Ie&&Ie.slug)||"";if(!St)return Q("Not connected to the cloud café — open the shared customer link or pair Cloud Sync first","warn");const Pa=new URLSearchParams(location.search),Sd=fe.storeId||Pa.get("storeId")||Pa.get("store")||Pa.get("st")||localStorage.getItem("kashikeyo.storeId")||"main";let Tb=fe.table||Pa.get("t")||(Mo==="dinein"&&window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.getSelectedTable?window.KashikeyoGuestProfile.getSelectedTable():"")||"",Gt=Tb&&A!=="delivery"?"table":fe.gtype;if(Mo==="dinein"&&!Tb&&window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.pickTable){Tb=await window.KashikeyoGuestProfile.pickTable();Gt=Tb?"table":fe.gtype;if(!Tb)return Q("Select a table for dine in","warn")}try{window.KashikeyoOffline&&window.KashikeyoOffline.setStoreId&&window.KashikeyoOffline.setStoreId(Sd)}catch{}const N={items:fe.cart.map(W=>({...W,pid:W.pid||W.id||W.productId,qty:W.qty||1})),table:Tb||(A==="delivery"?"Delivery":"Pickup"),custId:fe.custId||null,gtype:Gt,zoneId:fe.zoneId||null,note:(fe.note||"").trim()||A==="delivery"&&ia&&ia.address||"",payOnline:f,storeId:Sd};try{const I=await fetch(`/p/${St}/order?storeId=${encodeURIComponent(Sd)}`,{method:"POST",headers:{"Content-Type":"application/json","X-Store-Id":Sd},body:JSON.stringify(N)}),j=await I.json().catch(()=>({}));if(!I.ok)return Q(j.error||"Couldn\'t place the order — please try again","warn");const F=j.order||{};try{window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.refreshOrders&&window.KashikeyoGuestProfile.refreshOrders()}catch{}x(W=>W.some(he=>he.id===F.id)?W:[...W,F]),f1(W=>W?{...W,orders:[F,...(W.orders||[]).filter(he=>he.id!==F.id)]}:W),Dn(W=>({...W,cart:[],tab:"orders",note:""})),Q(`New order ${F.no||"sent"} · ${F.customerName?F.customerName+(F.table?" @ "+F.table:""):F.table||N.table}${f?" · paid online":""}`)}catch{Q("Can\'t reach the café — check your connection and try again","warn")}},Hw=(f,A)=>',
    checkout
  )
  .replace("nI=()=>Hw(fe.table,ia?ia.name:null)", call)
  .replace(/nI=async\(\)=>\{try\{[\s\S]*?Hw\(fe\.table,ia\?ia\.name:null\)\}/, call)
  .replace(
    'fe.urlMode?h.jsx("button",{onClick:_6,className:`p-1.5 rounded-full ${_.chip}`,title:"Staff sign-in",children:h.jsx(C3,{size:13})}):h.jsx("button",{onClick:()=>Dn(null),className:`p-1.5 rounded-full ${_.btn}`,children:h.jsx(Be,{size:15})})',
    hideStaffSignIn
  )
  .replace(
    'if(wu.current.has(I)){wu.current.delete(I),Qf.current[I]=F;return}',
    skipEchoGuard
  )
  .replace(
    'lb=async ne=>{if(yt.length){if(fe.gtype==="delivery"&&!ye&&I.length)return Q("Pick your delivery zone first","warn");if(fe.slug)try{const ke=await fetch(`/p/${fe.slug}/order`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items:fe.cart,table:fe.table,custId:fe.custId,gtype:fe.gtype,zoneId:fe.zoneId,note:fe.note||"",payOnline:ne})}),ze=await ke.json();if(!ke.ok)return Q(ze.error||"Couldn\'t place the order","warn");Dn(on=>({...on,cart:[],tab:"orders",note:""})),f1(on=>on&&{...on,orders:[ze.order,...on.orders||[]]}),Q(`Order ${ze.order.no} sent to the kitchen \u{1F389}`)}catch{Q("Network hiccup — try again","warn")}else rI(ne)}}',
    guestCheckout
  )
  .replace(
    'lb=async ne=>{if(yt.length){const Mo=window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.getOrderMode?window.KashikeyoGuestProfile.getOrderMode():"",A=Mo==="dinein"?"dinein":fe.gtype==="delivery"?"delivery":fe.gtype==="pickup"?"takeaway":"dinein";if(A==="delivery"&&!ye&&I.length)return Q("Pick your delivery zone first","warn");if(fe.slug)try{const Pa=new URLSearchParams(location.search),Sd=fe.storeId||Pa.get("storeId")||Pa.get("store")||Pa.get("st")||localStorage.getItem("kashikeyo.storeId")||"main";let Tb=fe.table||Pa.get("t")||(Mo==="dinein"&&window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.getSelectedTable?window.KashikeyoGuestProfile.getSelectedTable():"")||"",Gt=Tb&&A!=="delivery"?"table":fe.gtype;if(Mo==="dinein"&&!Tb&&window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.pickTable){Tb=await window.KashikeyoGuestProfile.pickTable();Gt=Tb?"table":fe.gtype;if(!Tb)return Q("Select a table for dine in","warn")}try{window.KashikeyoOffline&&window.KashikeyoOffline.setStoreId&&window.KashikeyoOffline.setStoreId(Sd)}catch{}const ke=await fetch(`/p/${fe.slug}/order?storeId=${encodeURIComponent(Sd)}`,{method:"POST",headers:{"Content-Type":"application/json","X-Store-Id":Sd},body:JSON.stringify({items:fe.cart,table:Tb||fe.table,custId:fe.custId,gtype:Gt,zoneId:fe.zoneId,note:fe.note||"",payOnline:ne,storeId:Sd})}),ze=await ke.json();if(!ke.ok)return Q(ze.error||"Couldn\'t place the order","warn");try{window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.refreshOrders&&window.KashikeyoGuestProfile.refreshOrders()}catch{}Dn(on=>({...on,cart:[],tab:"orders",note:""})),f1(on=>on&&{...on,orders:[ze.order,...on.orders||[]]}),Q(`Order ${ze.order.no} sent to the kitchen \u{1F389}`)}catch{Q("Network hiccup — try again","warn")}else rI(ne)}}',
    guestCheckout
  )
  .replace(
    'ub=async()=>{if(fe.slug)try{await fetch(`/p/${fe.slug}/call`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({table:fe.table,custId:fe.custId})}),Q("\u{1F514} We\'re on our way!")}catch{}else nI()}',
    guestCall
  )
  .replace(
    'ub=async()=>{if(fe.slug)try{const Pa=new URLSearchParams(location.search),Sd=fe.storeId||Pa.get("storeId")||Pa.get("store")||Pa.get("st")||localStorage.getItem("kashikeyo.storeId")||"main",Dt=window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.getSelectedTable?window.KashikeyoGuestProfile.getSelectedTable():"",Tb=fe.table||Pa.get("t")||Dt||"";try{window.KashikeyoOffline&&window.KashikeyoOffline.setStoreId&&window.KashikeyoOffline.setStoreId(Sd)}catch{}await fetch(`/p/${fe.slug}/call?storeId=${encodeURIComponent(Sd)}`,{method:"POST",headers:{"Content-Type":"application/json","X-Store-Id":Sd},body:JSON.stringify({table:Tb||fe.table,custId:fe.custId,storeId:Sd})}),Q("\u{1F514} We\'re on our way!")}catch{}else nI()}',
    guestCall
  )
  /* An earlier revision injected a separate guest-profile-guard.js script tag
     directly into the committed bundle; strip it now that table selection is
     native and that script is gone. */
  .replace('<script src="/guest-profile-guard.js"></script>', "")
  /* "Disconnect" used to just clear local cloud state and fall back to a
     standalone/offline mode - harmless for the original single-till product,
     but /app is now gated on a real server session (see requireAppSession in
     index.js), so this needs to actually sign out: clear the server cookie
     too (keepalive so the request survives the navigation that follows) and
     land back on /login rather than a demo-like standalone screen. */
  .replace(
    'UT=()=>{fw(null),Ew(null),ki.current=[],rd(),Q("Cloud disconnected — running standalone")}',
    'UT=()=>{fw(null),Ew(null),ki.current=[],rd(),fetch("/api/logout",{method:"POST",keepalive:!0}).catch(()=>{}),location.href="/login"}'
  )
  .replace(
    'h.jsx("button",{onClick:UT,className:"w-full rounded-xl py-3 text-sm font-semibold border border-rose-500/40 text-rose-400",children:"Disconnect"})',
    'h.jsx("button",{onClick:UT,className:"w-full rounded-xl py-3 text-sm font-semibold border border-rose-500/40 text-rose-400",children:"Sign out"})'
  )
  /* Qv is a hardcoded demo staff roster (Abdulla/Shifna/Ahmed) baked into the
     bundle for the original standalone product's very first run. It's meant
     as a fallback only when there's no real staff yet, but the sync merge
     that's supposed to replace it with real data only ever adds to it, so
     every fresh signup saw these three fake employees alongside their own
     seeded owner account (see ensureOwnerSeed/hashTillPin in index.js) with
     no indication they were fake or how to sign in as them. Every org now
     always gets a real seeded owner from the moment they sign in, so the
     fallback can just go away outright instead of ever needing to be merged
     away - a brand new store starts with exactly the staff it actually has. */
  .replace('[g,w]=R.useState(Qv),', '[g,w]=R.useState([]),')
  .replace('w(f.users&&f.users.length?f.users:Qv),', 'w(f.users||[]),')
  .replace('x([]),w(Qv),S([]),O(Jv)', 'x([]),w([]),S([]),O(Jv)')
  /* ── Multi-theme upgrade ──────────────────────────────────────────────
     Transforms the earlier single-boolean "Lovable" theme into the five
     named themes (each light+dark) defined above. These patches target the
     already-Lovable-baked strings, so on a fresh build the Lovable patches
     above run first and these transform their output; on the committed
     (already-baked) bundle the Lovable patches no-op and these match. */
  // theme state: KshLovable(bool) -> KshTheme(name); default to a light theme
  .replace(
    '[i,a]=R.useState(!0),[KshLovable,KshSetLovable]=R.useState(!1),[o,s]=R.useState("sell")',
    '[i,a]=R.useState(!1),[KshTheme,KshSetTheme]=R.useState("orange"),[o,s]=R.useState("sell")'
  )
  // palette: read from window.__kpal(theme,dark); classic dark/light stays as fallback
  .replace(`const _=KshLovable?${lovablePalette}:`, 'const _=window.__kpal?window.__kpal(KshTheme,i):')
  // persist + restore the chosen theme; default restore to light + orange
  .replace('dark:i,lovable:KshLovable,units:T', 'dark:i,ktheme:KshTheme,units:T')
  .replace('a(f.dark!==!1),KshSetLovable(f.lovable===!0),rn.current=f.seq||1041', 'a(f.dark===!0),KshSetTheme(f.ktheme||"orange"),rn.current=f.seq||1041')
  .replace('350))},[c,p,m,b,g,C,E,ce,d1,Ti,h1,i,KshLovable]),R.useEffect', '350))},[c,p,m,b,g,C,E,ce,d1,Ti,h1,i,KshTheme]),R.useEffect')
  // settings UI: replace the single Lovable toggle with a 5-swatch theme picker
  .replace(
    'h.jsxs("button",{onClick:()=>KshSetLovable(v=>!v),className:`w-full flex items-center gap-3 rounded-xl px-4 py-3 mb-2 text-sm ${_.panel2}`,children:[h.jsx("span",{className:"w-4 h-4 rounded-full inline-block flex-shrink-0",style:{background:"linear-gradient(135deg,#C1502D 50%,#F3ECE1 50%)",border:"1px solid rgba(0,0,0,.15)"}}),h.jsx("span",{className:"flex-1 text-left",children:KshLovable?"Switch to classic theme":"Switch to Lovable theme"})]}),',
    'h.jsxs("div",{className:"mb-2",children:[h.jsx("div",{className:`text-xs mb-1.5 px-1 ${_.sub}`,children:"Theme"}),h.jsx("div",{style:{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:"8px"},children:[["orange","Orange","#C1502D"],["green","Green Apple","#4E8A3A"],["watermelon","Watermelon","#DA3B4B"],["mango","Mango","#E19A12"],["strawberry","Strawberry","#D8437A"]].map(([tn,tl,col])=>h.jsx("button",{onClick:()=>KshSetTheme(tn),title:tl,style:{height:"38px",borderRadius:"12px",background:col,cursor:"pointer",border:KshTheme===tn?"2px solid #fff":"2px solid transparent",boxShadow:KshTheme===tn?"0 0 0 2px "+col:"inset 0 0 0 1px rgba(0,0,0,.12)",transform:KshTheme===tn?"scale(1.06)":"none",transition:"transform .12s"}},tn))})]}),'
  )
  /* Guest/customer profile links were broken: LT() returned
     origin+pathname = "https://kashikeyopos.com/app", so shared links became
     /app?s=...&c=... which hits requireAppSession and redirects guests to
     /login. Fix: always generate links from the root ("/") so they land on
     the route that serves the till without a session check. */
  .replace(
    'LT=()=>{try{return window.location.origin+window.location.pathname}catch{return""}}',
    'LT=()=>{try{return window.location.origin+"/"}catch{return""}}'
  );
});

/* ── Billing features ────────────────────────────────────────────────────────
   All patches here implement:
   1. Configurable loyalty rate (loyaltyBp in settings; default 1 pt per MVR 100)
   2. Service charge (svcChargeBp in settings; tracked in sales/reports)
   3. Bill-level discount (admin/manager only; cycles 0→5→10→15→20→25%)
   4. Customer auto-discount (discPct on customer profile; admin-only field)
   5. Per-item discount button gated to admin/manager (cashiers cannot access)
   6. Per-item GST flag (taxable field on products; non-taxable items skip GST)
   ─────────────────────────────────────────────────────────────────────────── */

patchFile(indexPath, (html) => html
  /* 1. Settings default object: add loyaltyBp, svcChargeBp, and usdRate (fresh bundle) */
  .replace(
    'gstBp:800,currency:"MVR",footer:',
    'gstBp:800,loyaltyBp:10000,svcChargeBp:0,usdRate:1542,currency:"MVR",footer:'
  )
  /* 1b. Already-baked bundle: loyaltyBp/svcChargeBp present but usdRate not yet */
  .replace(
    'gstBp:800,loyaltyBp:10000,svcChargeBp:0,currency:"MVR",footer:',
    'gstBp:800,loyaltyBp:10000,svcChargeBp:0,usdRate:1542,currency:"MVR",footer:'
  )

  /* 2. Y5 subtotal helper: exclude non-taxable items from the GST base */
  .replace(
    'Y5=(t,e=800)=>{const r=t.reduce((i,a)=>i+Un(a),0),n=Math.round(r*e/1e4);return{subtotal:r,gst:n,total:r+n}}',
    'Y5=(t,e=800)=>{const r=t.reduce((i,a)=>i+Un(a),0),tb=t.reduce((i,a)=>a.taxable===false?i:i+Un(a),0),n=Math.round(tb*e/1e4);return{subtotal:r,gst:n,total:r+n}}'
  )

  /* 3. $n checkout totals: add service charge + optional bill-level discount param */
  .replace(
    '$n=(f,A=0)=>{const I=Y5(f,ce.gstBp).subtotal+(A||0),j=Math.round(I*ce.gstBp/1e4);return{subtotal:I,gst:j,total:I+j,fee:A||0}}',
    '$n=(f,A=0,KshBD=0)=>{const I=f.reduce((a,b)=>a+Un(b),0)+(A||0),tb=f.reduce((a,b)=>b.taxable===false?a:a+Un(b),0)+(A||0),disc=KshBD>0?Math.round(I*KshBD/100):0,gstBase=Math.round(tb*(1-KshBD/100)),j=Math.round(gstBase*(ce.gstBp||0)/1e4),sv=Math.round((I-disc)*(ce.svcChargeBp||0)/1e4);return{subtotal:I,billDisc:disc,billDiscPct:KshBD,gst:j,svcCharge:sv,total:I-disc+j+sv,fee:A||0}}'
  )

  /* 4. Add KshBillDisc state next to KshTheme */
  .replace(
    '[i,a]=R.useState(!1),[KshTheme,KshSetTheme]=R.useState("orange"),[o,s]=R.useState("sell")',
    '[i,a]=R.useState(!1),[KshTheme,KshSetTheme]=R.useState("orange"),[KshBillDisc,KshSetBillDisc]=R.useState(0),[o,s]=R.useState("sell")'
  )

  /* 5. cr computation: pass effective bill discount (manual or customer auto-discount) */
  .replace(
    'bu=nt==="delivery"&&nn?nn.fee:0,cr=$n(Rt,bu),C1=',
    'bu=nt==="delivery"&&nn?nn.fee:0,KshBD=KshBillDisc>0?KshBillDisc:(He&&He.discPct||0),cr=$n(Rt,bu,KshBD),C1='
  )

  /* 6. Fix loyalty points rate in JT (main register settlement) */
  .replace(
    'if(sd(Rt),He){const j=Math.floor(cr.total/1e3);',
    'if(sd(Rt),He){const j=Math.floor(cr.total/(ce.loyaltyBp||10000));'
  )

  /* 7. Reset bill discount + store billDiscPct in sale after JT settlement */
  .replace(
    'y(j=>[...j,I]),Pi({open:!1,payments:[],amt:""}),od(_e.id),vu(I)',
    'y(j=>[...j,I]),Pi({open:!1,payments:[],amt:""}),KshSetBillDisc(0),od(_e.id),vu(I)'
  )

  /* 8. Fix loyalty points rate in B1 (settle from Orders tab) */
  .replace(
    'const j=Math.floor(N.total/1e3),F=A==="Credit"?N.total:0;',
    'const j=Math.floor(N.total/(ce.loyaltyBp||10000)),F=A==="Credit"?N.total:0;'
  )

  /* 9. Gate per-item discount button to admin/manager (cashier has no "refund" perm).
     Anchored on the price-display span that immediately precedes the button, so after
     insertion the button is no longer the immediate successor of the span — idempotent.
     Regex normalizer first collapses any accumulated duplicates from earlier bad runs. */
  .replace(/(br\("refund"\)&&){2,}h\.jsxs\("button",\{onClick:\(\)=>GT\(A\)/g, 'br("refund")&&h.jsxs("button",{onClick:()=>GT(A)')
  .replace(
    'children:["@ ",Y(f.price),"/",f.unit||"pcs"]}),h.jsxs("button",{onClick:()=>GT(A),className:`flex items-center gap-0.5 text-xs px-2 py-1 rounded-lg ${f.discPct?"bg-amber-500/15 text-amber-500":_.chip}`,children:[h.jsx(vk,{size:11}),f.discPct?`-${f.discPct}%`:"disc"]})',
    'children:["@ ",Y(f.price),"/",f.unit||"pcs"]}),br("refund")&&h.jsxs("button",{onClick:()=>GT(A),className:`flex items-center gap-0.5 text-xs px-2 py-1 rounded-lg ${f.discPct?"bg-amber-500/15 text-amber-500":_.chip}`,children:[h.jsx(vk,{size:11}),f.discPct?`-${f.discPct}%`:"disc"]})'
  )

  /* 10. Copy taxable flag when a product is added to a till order line */
  .replace(
    '{pid:f.id,name:f.name,emoji:f.emoji,price:f.price,cost:f.cost,unit:f.unit||"pcs",vendor:!!f.vendor,qty:1,discPct:0}',
    '{pid:f.id,name:f.name,emoji:f.emoji,price:f.price,cost:f.cost,unit:f.unit||"pcs",vendor:!!f.vendor,qty:1,discPct:0,taxable:f.taxable!==false}'
  )

  /* 11. Bill summary: add bill-discount toggle button, discount row, service-charge row */
  .replace(
    'h.jsxs("div",{className:`flex justify-between text-xs mt-1 ${_.sub}`,children:[h.jsxs("span",{children:["GST ",ce.gstBp/100,"%"]}),h.jsx("span",{className:"font-mono tabular-nums",children:Y(cr.gst)})]}),h.jsxs("div",{className:"flex justify-between items-baseline mt-2"',
    'br("refund")&&h.jsx("button",{onClick:()=>KshSetBillDisc(f=>{const j=[0,5,10,15,20,25];return j[(j.indexOf(f)+1)%j.length]}),className:`flex items-center gap-1.5 rounded-xl px-3 py-1 text-xs mt-1 ${KshBD>0?"bg-amber-500/15 text-amber-500":_.chip}`,children:KshBD>0?"Bill disc "+KshBD+"%":"+ Bill disc"}),KshBD>0&&h.jsxs("div",{className:`flex justify-between text-xs mt-1 ${_.sub}`,children:[h.jsxs("span",{children:["Discount ",KshBD,"%"]}),h.jsx("span",{className:"font-mono tabular-nums text-amber-500",children:"-"+Y(cr.billDisc||0)})]}),h.jsxs("div",{className:`flex justify-between text-xs mt-1 ${_.sub}`,children:[h.jsxs("span",{children:["GST ",ce.gstBp/100,"%"]}),h.jsx("span",{className:"font-mono tabular-nums",children:Y(cr.gst)})]}),(ce.svcChargeBp||0)>0&&h.jsxs("div",{className:`flex justify-between text-xs mt-1 ${_.sub}`,children:[h.jsxs("span",{children:["Svc charge ",(ce.svcChargeBp||0)/100,"%"]}),h.jsx("span",{className:"font-mono tabular-nums",children:Y(cr.svcCharge||0)})]}),h.jsxs("div",{className:"flex justify-between items-baseline mt-2"'
  )

  /* 12. Thermal receipt VT: add bill discount and service charge lines */
  .replace(
    'j.push({l:`GST ${ce.gstBp/100}%`,r:Y(f.gst),dim:!0},{l:"TOTAL",r:ue(f.total),bold:!0,big:!0})',
    '(f.billDisc||0)>0&&j.push({l:`Discount ${f.billDiscPct||0}%`,r:"-"+Y(f.billDisc),dim:!0,accent:!0}),j.push({l:`GST ${ce.gstBp/100}%`,r:Y(f.gst),dim:!0}),(f.svcCharge||0)>0&&j.push({l:`Svc charge ${(ce.svcChargeBp||0)/100}%`,r:Y(f.svcCharge),dim:!0}),j.push({l:"TOTAL",r:ue(f.total),bold:!0,big:!0})'
  )

  /* 13. Screen receipt modal (Pe): add service charge and bill discount rows */
  .replace(
    'h.jsxs("div",{className:"flex justify-between",children:[h.jsxs("span",{children:["GST ",ce.gstBp/100,"%"]}),h.jsx("span",{className:"tabular-nums",children:Y(Pe.gst)})]}),Pe.foc&&',
    '(Pe.billDisc||0)>0&&h.jsxs("div",{className:"flex justify-between",children:[h.jsxs("span",{children:["Disc ",Pe.billDiscPct||0,"%"]}),h.jsx("span",{className:"tabular-nums text-amber-500",children:"-"+Y(Pe.billDisc)})]}),h.jsxs("div",{className:"flex justify-between",children:[h.jsxs("span",{children:["GST ",ce.gstBp/100,"%"]}),h.jsx("span",{className:"tabular-nums",children:Y(Pe.gst)})]}),(Pe.svcCharge||0)>0&&h.jsxs("div",{className:"flex justify-between",children:[h.jsxs("span",{children:["Svc charge ",(ce.svcChargeBp||0)/100,"%"]}),h.jsx("span",{className:"tabular-nums",children:Y(Pe.svcCharge)})]}),Pe.foc&&'
  )

  /* 14. Settings form: add service charge and loyalty rate inputs after GST/Currency grid.
     Anchored on the currency input's unique toUpperCase().slice(0,4) onChange call so the
     find string spans from that call to "Changes apply…", and after insertion the grid sits
     between them — the original span no longer exists, making this patch a no-op on re-runs.
     Fresh bundle: toUpperCase...Changes apply is present → grid inserted.
     Already-baked bundle: grid is already between them → no-op. */
  .replace(
    'toUpperCase().slice(0,4)})),className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]})]}),h.jsx("div",{className:`text-xs px-1 ${_.faint}`,children:"Changes apply immediately and save automatically — receipts, reports, and the tax engine all follow these settings."})',
    'toUpperCase().slice(0,4)})),className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]})]}),h.jsxs("div",{className:"grid grid-cols-2 gap-3 mt-2",children:[h.jsxs("div",{children:[h.jsx("div",{className:`text-xs mb-1 ${_.sub}`,children:"Service charge (%)"}),h.jsx("input",{value:String((ce.svcChargeBp||0)/100),inputMode:"decimal",onChange:f=>{const A=parseFloat(f.target.value);xs(N=>({...N,svcChargeBp:isNaN(A)?0:Math.round(A*100)}))},className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]}),h.jsxs("div",{children:[h.jsx("div",{className:`text-xs mb-1 ${_.sub}`,children:"Loyalty (MVR/$ per point)"}),h.jsx("input",{value:String((ce.loyaltyBp||10000)/100),inputMode:"decimal",onChange:f=>{const A=parseFloat(f.target.value);xs(N=>({...N,loyaltyBp:isNaN(A)||A<=0?10000:Math.round(A*100)}))},className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]})]}),h.jsx("div",{className:`text-xs px-1 ${_.faint}`,children:"Changes apply immediately and save automatically — receipts, reports, and the tax engine all follow these settings."})'
  )

  /* 24. Settings form: add exchange rate input after svc/loyalty grid.
     Find anchors on the tail of the loyalty input followed immediately by "Changes apply" —
     after insertion the exchange rate div sits between them, breaking the anchor. */
  .replace(
    'loyaltyBp:isNaN(A)||A<=0?10000:Math.round(A*100)}))},className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]})]}),h.jsx("div",{className:`text-xs px-1 ${_.faint}`,children:"Changes apply immediately and save automatically — receipts, reports, and the tax engine all follow these settings."})',
    'loyaltyBp:isNaN(A)||A<=0?10000:Math.round(A*100)}))},className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]})]}),h.jsxs("div",{className:"mt-2",children:[h.jsx("div",{className:`text-xs mb-1 ${_.sub}`,children:"Exchange rate (MVR per USD)"}),h.jsx("input",{value:String((ce.usdRate||1542)/100),inputMode:"decimal",onChange:f=>{const A=parseFloat(f.target.value);xs(N=>({...N,usdRate:isNaN(A)||A<=0?1542:Math.round(A*100)}))},className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]}),h.jsx("div",{className:`text-xs px-1 ${_.faint}`,children:"Changes apply immediately and save automatically — receipts, reports, and the tax engine all follow these settings."})'
  )

  /* 25. Thermal receipt: show secondary currency below TOTAL.
     MVR stores → show USD equivalent; USD stores → show MVR equivalent.
     Anchored on payQrNote+footer sequence; secondary lines are inserted between them. */
  .replace(
    'ce.payQrNote&&j.push({c:ce.payQrNote,small:!0,accent:!0}),j.push({c:ce.footer,small:!0,dim:!0}),j}',
    'ce.payQrNote&&j.push({c:ce.payQrNote,small:!0,accent:!0}),ce.usdRate&&ce.currency==="MVR"&&j.push({c:"≈ USD "+(f.total/ce.usdRate).toFixed(2),small:!0,dim:!0}),ce.usdRate&&ce.currency==="USD"&&j.push({c:"≈ MVR "+(f.total*ce.usdRate/10000).toFixed(2),small:!0,dim:!0}),j.push({c:ce.footer,small:!0,dim:!0}),j}'
  )

  /* 26. Screen receipt footer: show secondary currency below the receipt icon.
     The outer div uses h.jsxs (multiple children). After patching the icon is no longer
     immediately followed by the footer div, breaking the original match on re-runs. */
  .replace(
    'h.jsxs("div",{className:"flex flex-col items-center mt-4",children:[h.jsx(Uu,{size:40,className:"opacity-40"}),h.jsx("div",{className:"mt-1 opacity-60",children:ce.footer})]',
    'h.jsxs("div",{className:"flex flex-col items-center mt-4",children:[h.jsx(Uu,{size:40,className:"opacity-40"}),ce.usdRate&&ce.currency==="MVR"&&h.jsx("div",{className:"mt-1 opacity-60 text-xs",children:"≈ USD "+(Pe.total/ce.usdRate).toFixed(2)}),ce.usdRate&&ce.currency==="USD"&&h.jsx("div",{className:"mt-1 opacity-60 text-xs",children:"≈ MVR "+(Pe.total*ce.usdRate/10000).toFixed(2)}),h.jsx("div",{className:"mt-1 opacity-60",children:ce.footer})]'
  )

  /* 30. Theme picker: also persist the chosen theme into the settings entity
     (ktheme) so the back office (/back) can render in the same palette. The
     till itself keeps using its per-device local copy — this is sync-out only.
     Find is consumed: the bare KshSetTheme(tn) onClick no longer exists. */
  .replace(
    'onClick:()=>KshSetTheme(tn),title:tl',
    'onClick:()=>{KshSetTheme(tn);try{xs(kv=>({...kv,ktheme:tn}))}catch{}},title:tl'
  )

  /* 31. Dark toggle: mirror the dark flag into settings (ktdark) for /back. */
  .replace(
    'h.jsxs("button",{onClick:()=>a(!i),className:`w-full flex items-center gap-3 rounded-xl px-4 py-3 mb-2 text-sm ${_.panel2}`',
    'h.jsxs("button",{onClick:()=>{a(!i);try{xs(kv=>({...kv,ktdark:!i}))}catch{}},className:`w-full flex items-center gap-3 rounded-xl px-4 py-3 mb-2 text-sm ${_.panel2}`'
  )

  /* 34. Order lifecycle: add a "delivered" stage between ready and settled.
     Guests watched the status stick at "Ready — coming to you" until the
     bill was settled — nothing ever said the food arrived. New flow across
     both screens: received → preparing → ready → delivered → settled.

     34a. Guest status bar: 5 stages + friendlier terminal labels. */
  .replace(
    'cb=["new","preparing","ready","completed"],S6={new:"Order received",preparing:"Kitchen is preparing",ready:"Ready — coming to you",completed:"Completed"}',
    'cb=["new","preparing","ready","delivered","completed"],S6={new:"Order received",preparing:"Kitchen is preparing",ready:"Ready — coming to you",delivered:"Delivered — enjoy!",completed:"Settled — thank you"}'
  )

  /* 34b. Till advance handler (Vw): ready now marks delivered; settling (or
     completing a paid-online order) happens from delivered. */
  .replace(
    ':f.status==="preparing"?x(A=>A.map(N=>N.id===f.id?{...N,status:"ready"}:N)):f.status==="ready"&&(f.paidOnline?B1(f,"QR (online)"):As(f))',
    ':f.status==="preparing"?x(A=>A.map(N=>N.id===f.id?{...N,status:"ready"}:N)):f.status==="ready"?x(A=>A.map(N=>N.id===f.id?{...N,status:"delivered"}:N)):f.status==="delivered"&&(f.paidOnline?B1(f,"QR (online)"):As(f))'
  )

  /* 34c. Order-card action button: "Mark delivered" at ready, settle wording
     moves to the delivered stage; both stages keep the primary styling. */
  .replace(
    'className:`mt-3 w-full rounded-xl py-2.5 text-sm font-semibold ${f.status==="ready"?_.primary:_.btn}`,children:f.status==="ready"?f.paidOnline?"Complete (already paid)":"Settle & pay":MI[f.status]',
    'className:`mt-3 w-full rounded-xl py-2.5 text-sm font-semibold ${f.status==="ready"||f.status==="delivered"?_.primary:_.btn}`,children:f.status==="ready"?"Mark delivered":f.status==="delivered"?f.paidOnline?"Complete (already paid)":"Settle & pay":MI[f.status]'
  )

  /* 34d. Orders tab filter chips: a Delivered filter between Ready and Done.
     (The Active/table-occupancy checks all use !["completed","wasted"], so
     delivered orders already stay active and keep their table.) */
  .replace(
    '[["active","Active"],["new","New"],["preparing","Preparing"],["ready","Ready"],["completed","Done"],["wasted","Wasted"],["all","All"]]',
    '[["active","Active"],["new","New"],["preparing","Preparing"],["ready","Ready"],["delivered","Delivered"],["completed","Done"],["wasted","Wasted"],["all","All"]]'
  )

  /* 33. Till side menu: "Back office" switcher between the theme picker and
     the Lock button, gated to admin/manager (br("refund")) — cashiers don't
     see it. Same session cookie powers /back, so it's a plain navigation.
     Find spans the theme-picker tail + Lock button head; after insertion the
     button sits between them, so the find no longer matches on re-runs. */
  .replace(
    '}},tn))})]}),h.jsxs("button",{onClick:jI,',
    '}},tn))})]}),br("refund")&&h.jsxs("button",{onClick:()=>{location.href="/back"},className:`w-full flex items-center gap-3 rounded-xl px-4 py-3 mb-2 text-sm ${_.panel2}`,children:[h.jsx("span",{className:"text-base leading-none",children:"📦"}),h.jsx("span",{className:"flex-1 text-left",children:"Back office — stock, recipes & deliveries"}),h.jsx("span",{className:`text-xs ${_.faint}`,children:"→"})]}),h.jsxs("button",{onClick:jI,'
  )

  /* 35. Till side menu: a visible "Sign out" under Lock · switch user. The
     only sign-out used to hide inside Admin → Cloud sync; UT (already wired:
     clears the server cookie + local pairing, lands on /login) lives in the
     same component scope. Find is consumed — after insertion the Lock button
     is no longer immediately followed by the menu's closing brackets. */
  .replace(
    'children:[h.jsx(C3,{size:16})," Lock · switch user"]})]})',
    'children:[h.jsx(C3,{size:16})," Lock · switch user"]}),h.jsx("button",{onClick:UT,className:"w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 mt-2 text-sm font-semibold border border-rose-500/40 text-rose-400",children:"Sign out"})]})'
  )

  /* 39. Customer profile modal (till Admin -> Customers): align the action
     button rows.
     39a. The "Share... / Copy / WhatsApp" buttons for the personal ordering
     link lived INSIDE the link card (px-4), so they were inset and narrower
     than the "Sell / Receive" and "Share image..." rows below. Pull them out
     to a full-width sibling row (label + URL stay in the card) so all three
     button rows line up. Find consumed (mt-2 grid no longer inside card). */
  .replace(
    'text-xs font-mono break-all mt-1 opacity-80",children:td(xe.id)}),h.jsxs("div",{className:"grid grid-cols-3 gap-2 mt-2",children:[',
    'text-xs font-mono break-all mt-1 opacity-80",children:td(xe.id)})]}),h.jsxs("div",{className:"grid grid-cols-3 gap-2 mb-3",children:['
  )
  /* 39a-ii. The card used to close AFTER the grid; now that the grid is a
     sibling, drop that orphaned card-close so the JSX stays balanced. */
  .replace(
    'children:"WhatsApp"})]})]}),h.jsxs("div",{className:"flex gap-2 mb-4"',
    'children:"WhatsApp"})]}),h.jsxs("div",{className:"flex gap-2 mb-4"'
  )
  /* 39b. Unify the pulled-out buttons to the statement row height (py-2 -> py-2.5). */
  .replace(
    'rounded-xl py-2 text-xs font-semibold ${_.chipOn}`,children:"Share…"',
    'rounded-xl py-2.5 text-xs font-semibold ${_.chipOn}`,children:"Share…"'
  )
  .replace(
    'rounded-xl py-2 text-xs font-semibold ${_.btn}`,children:"Copy"',
    'rounded-xl py-2.5 text-xs font-semibold ${_.btn}`,children:"Copy"'
  )
  .replace(
    'rounded-xl py-2 text-xs font-semibold bg-emerald-500/15 text-emerald-400",children:"WhatsApp"',
    'rounded-xl py-2.5 text-xs font-semibold bg-emerald-500/15 text-emerald-400",children:"WhatsApp"'
  )
  /* (No colour change on "Receive payment": its green is an intentional
     money-in semantic like the amber balance/credit badges, and its dark
     text is the accessible choice on emerald-500 — white would drop to
     ~2.3:1. The purged Tailwind build has no emerald-600 to calm it with.
     The real problem was alignment, fixed above.) */

  /* 40. Customer profile modal: simplify the colour palette. It had a
     rainbow of button colours — orange (Share/Sell), green (WhatsApp x2 +
     Receive), purple (Viber), amber (money). Rule now: accent = primary
     share/sell actions; green kept ONLY for the semantic "Receive payment"
     (money in); amber only for money owed; the messaging buttons (WhatsApp,
     Viber) become neutral so the eye lands on what matters. Find strings
     carry the old brand tints, so this is a no-op on re-runs. */
  .replace(
    /"rounded-xl py-2\.5 text-xs font-semibold bg-emerald-500\/15 text-emerald-400",children:"WhatsApp"/g,
    '`rounded-xl py-2.5 text-xs font-semibold ${_.btn}`,children:"WhatsApp"'
  )
  .replace(
    '"rounded-xl py-2.5 text-xs font-semibold bg-purple-500/15 text-purple-400",children:"Viber"',
    '`rounded-xl py-2.5 text-xs font-semibold ${_.btn}`,children:"Viber"'
  )
  /* 40b. Same statement-share buttons rendered per-customer in the credit
     list view (variable A instead of xe): neutralise WhatsApp + Viber to
     match the modal. WhatsApp keeps its no-phone muted state. */
  .replace(
    '${A.phone?"bg-emerald-500/15 text-emerald-400":_.chip}`,children:"WhatsApp"',
    '${A.phone?_.btn:_.chip}`,children:"WhatsApp"'
  )
  .replace(
    '"rounded-xl py-2 text-xs font-semibold bg-purple-500/15 text-purple-400",children:"Viber"',
    '`rounded-xl py-2 text-xs font-semibold ${_.btn}`,children:"Viber"'
  )

  /* 41. Sound: till plays an alert when new portal orders and waiter calls
     arrive. Hooked into zT (the inbound entity-apply) right after entities
     are grouped by kind: a non-deleted waiterCall → "waiter" chime; a
     non-deleted order that's freshly placed from a portal (status "new",
     source "qr") → "order" chime. The helper stays silent for the first few
     seconds so the initial sync doesn't blast historic rows. Find spans into
     "const N=" so the anchor is displaced after insertion (idempotent). */
  .replace(
    'f.forEach(I=>{(A[I.kind]=A[I.kind]||[]).push(I)});const N=(I,j,F,W)=>{',
    'f.forEach(I=>{(A[I.kind]=A[I.kind]||[]).push(I)});try{if(window.__ksnd){var _sn=window.__ksndSeen||(window.__ksndSeen={o:{},w:{}});A.waiterCalls&&A.waiterCalls.forEach(function(_c){!_c.deleted&&!_sn.w[_c.id]&&(_sn.w[_c.id]=1,window.__ksnd.play("waiter"))}),A.orders&&A.orders.forEach(function(_o){!_o.deleted&&_o.data&&_o.data.status==="new"&&_o.data.source==="qr"&&!_sn.o[_o.id]&&(_sn.o[_o.id]=1,window.__ksnd.play("order"))})}}catch{}const N=(I,j,F,W)=>{'
  )

  /* 42. Sound: guest device chimes when one of its orders changes status
     (preparing → ready → delivered → settled). Extends the boot-poll handler
     (patch 37): compares each order's status against the previous poll and
     plays "status" if any advanced. First poll just seeds the map (no chime).
     Find is the patch-37 tail; consumed by the inserted comparison. */
  .replace(
    'kt&&kt.ktdark!==void 0&&a(kt.ktdark===!0)}catch{}})())',
    'kt&&kt.ktdark!==void 0&&a(kt.ktdark===!0);var _os=j.orders||[],_pv=window.__ksndGuestPrev||{},_chg=!1;_os.forEach(function(_o){_o&&_o.id&&_pv[_o.id]!==void 0&&_pv[_o.id]!==_o.status&&(_chg=!0)}),window.__ksndGuestPrev=Object.fromEntries(_os.map(function(_o){return[_o.id,_o.status]})),_chg&&window.__ksnd&&window.__ksnd.play("status")}catch{}})())'
  )

  /* 43. Sound: a per-device mute toggle in the till side menu (above the Back
     office link). Available to all staff. Reads/writes localStorage via the
     helper; updates its own label imperatively (no React state needed) and
     plays a test chime when switched on. */
  .replace(
    '}},tn))})]}),br("refund")&&h.jsxs("button",{onClick:()=>{location.href="/back"}',
    '}},tn))})]}),h.jsx("button",{onClick:_e=>{var _m=!(window.__ksnd&&window.__ksnd.muted());window.__ksnd&&window.__ksnd.setMuted(_m),_e.currentTarget.textContent=_m?"🔕 Alert sounds off":"🔔 Alert sounds on",!_m&&window.__ksnd&&window.__ksnd.play("order",{force:!0})},className:`w-full flex items-center gap-3 rounded-xl px-4 py-3 mb-2 text-sm ${_.panel2}`,children:window.__ksnd&&window.__ksnd.muted()?"🔕 Alert sounds off":"🔔 Alert sounds on"}),br("refund")&&h.jsxs("button",{onClick:()=>{location.href="/back"}'
  )

  /* 44. Sound: guest gets a confirmation blip when their order is sent and a
     chime when they call a waiter (forced — direct user actions, always on). */
  .replace(
    'sent to the kitchen 🎉`)}catch{',
    'sent to the kitchen 🎉`),window.__ksnd&&window.__ksnd.play("ok",{force:!0})}catch{'
  )
  .replace(
    'storeId:Sd})}),Q("🔔 We\'re on our way!")}catch',
    'storeId:Sd})}),window.__ksnd&&window.__ksnd.play("status",{force:!0}),Q("🔔 We\'re on our way!")}catch'
  )

  /* 45. Dashboard chart: default to a line+area view with a Line/Bars toggle.
     Replaces the Recharts bar chart with hand-drawn SVG (window.__ksChart via
     dangerouslySetInnerHTML) plus a segmented toggle and an hour-label row. */
  .replace(
    'chart:h.jsxs("div",{className:`rounded-2xl p-4 ${_.panel}`,children:[h.jsx("div",{className:"text-sm font-semibold mb-3",children:"Sales by hour (today)"}),h.jsx("div",{className:"h-44",children:h.jsx(VA,{width:"100%",height:"100%",children:h.jsxs(gC,{data:Ir.hours,margin:{top:4,right:4,left:-18,bottom:0},children:[h.jsx(D5,{strokeDasharray:"3 3",stroke:_.grid,vertical:!1}),h.jsx(Af,{dataKey:"h",tick:{fontSize:10,fill:_.axis},axisLine:!1,tickLine:!1}),h.jsx(e1,{tick:{fontSize:10,fill:_.axis},axisLine:!1,tickLine:!1}),h.jsx(Bi,{cursor:{fill:"transparent"},formatter:f=>[ce.currency+" "+f.toFixed(2),"Sales"],contentStyle:{background:_.tipBg,border:"1px solid "+_.grid,borderRadius:10,fontSize:12}}),h.jsx(fo,{dataKey:"v",fill:_.bar,radius:[5,5,0,0]})]})})})]})',
    'chart:h.jsxs("div",{className:`rounded-2xl p-4 ${_.panel}`,children:[h.jsxs("div",{className:"flex items-center justify-between mb-3",children:[h.jsx("div",{className:"text-sm font-semibold",children:"Sales by hour (today)"}),h.jsxs("div",{className:`flex gap-0.5 rounded-lg p-0.5 ${_.panel2}`,children:[h.jsx("button",{"data-kscht":"line","data-on":window.__ksChartMode&&window.__ksChartMode()==="bar"?"0":"1",onClick:()=>window.__ksChartToggle&&window.__ksChartToggle("line"),className:"ksch-tab px-2.5 py-1 rounded-md text-xs font-semibold",children:"Line"}),h.jsx("button",{"data-kscht":"bar","data-on":window.__ksChartMode&&window.__ksChartMode()==="bar"?"1":"0",onClick:()=>window.__ksChartToggle&&window.__ksChartToggle("bar"),className:"ksch-tab px-2.5 py-1 rounded-md text-xs font-semibold",children:"Bars"})]})]}),h.jsx("div",{className:"h-44",dangerouslySetInnerHTML:{__html:window.__ksChart?window.__ksChart(Ir.hours,_):""}}),h.jsx("div",{className:`flex justify-between mt-1.5 text-xs ${_.faint}`,children:(Ir.hours||[]).filter((d,i)=>i%4===0||i===(Ir.hours.length-1)).map((d,i)=>h.jsx("span",{children:d.h},i))})]})'
  )

  /* 46. Dashboard KPI tiles: bigger number + uppercase label for a cleaner,
     more premium look. */
  .replace(
    'vd=(f,A,N)=>h.jsxs("div",{className:`rounded-2xl p-4 ${_.panel}`,children:[h.jsx("div",{className:`text-xs ${_.sub}`,children:f}),h.jsx("div",{className:`font-mono tabular-nums text-lg font-bold mt-1 ${N||""}`,children:A})]})',
    'vd=(f,A,N)=>h.jsxs("div",{className:`rounded-2xl p-4 ${_.panel}`,children:[h.jsx("div",{className:`text-xs uppercase tracking-wide ${_.sub}`,children:f}),h.jsx("div",{className:`font-mono tabular-nums text-2xl font-bold mt-1 ${N||_.accent}`,children:A})]})'
  )

  /* 47. Member card revamp (guest portal): a glassy, tier-coloured membership
     card — Bronze/Silver/Gold gradient, medal watermark, member name + code,
     points and progress. 47a = header + name, 47b = progress + hint colours,
     47c = the "usuals" chips restyled to read on the gradient. */
  .replace(
    'return h.jsxs("div",{className:`rounded-2xl p-4 mb-3 ${_.panel}`,children:[h.jsxs("div",{className:"flex items-center justify-between mb-1.5",children:[h.jsxs("span",{className:"text-sm font-bold",children:[tr==="Gold"?"🥇":tr==="Silver"?"🥈":"🥉"," ",tr," member"]}),h.jsxs("span",{className:`text-xs font-mono ${_.sub}`,children:[pt," pts"]})]}),',
    'var _tc=tr==="Gold"?{g:"linear-gradient(135deg,#F6D869 0%,#C99A1E 100%)",b:"rgba(214,175,54,.65)",t:"#3a2e00",m:"🥇",tag:"GOLD MEMBER"}:tr==="Silver"?{g:"linear-gradient(135deg,#EEF0F3 0%,#AEB4BE 100%)",b:"rgba(174,180,190,.75)",t:"#2a2e35",m:"🥈",tag:"SILVER MEMBER"}:{g:"linear-gradient(135deg,#E6A972 0%,#A9683B 100%)",b:"rgba(169,104,59,.65)",t:"#3a2410",m:"🥉",tag:"BRONZE MEMBER"},_code="NO. "+String(j.id||"").replace(/[^a-zA-Z0-9]/g,"").slice(-6).toUpperCase();return h.jsxs("div",{style:{position:"relative",overflow:"hidden",borderRadius:"18px",padding:"18px",marginBottom:"12px",background:_tc.g,border:"1px solid "+_tc.b,boxShadow:"0 12px 32px rgba(0,0,0,.22)",color:_tc.t},children:[h.jsx("div",{style:{position:"absolute",inset:0,background:"linear-gradient(120deg,rgba(255,255,255,.45),transparent 44%)",pointerEvents:"none"}}),h.jsx("div",{style:{position:"absolute",right:"-14px",top:"-22px",fontSize:"96px",opacity:.18,pointerEvents:"none",lineHeight:1},children:_tc.m}),h.jsxs("div",{style:{position:"relative",display:"flex",alignItems:"center",justifyContent:"space-between"},children:[h.jsxs("div",{style:{display:"flex",alignItems:"center",gap:"9px"},children:[h.jsx("span",{style:{fontSize:"26px"},children:_tc.m}),h.jsxs("div",{children:[h.jsx("div",{style:{fontSize:"11px",fontWeight:800,letterSpacing:".07em",opacity:.9},children:_tc.tag}),h.jsx("div",{style:{fontSize:"10px",fontFamily:"ui-monospace,monospace",opacity:.72,marginTop:"1px"},children:_code})]})]}),h.jsxs("div",{style:{textAlign:"right"},children:[h.jsx("div",{style:{fontSize:"23px",fontWeight:800,fontFamily:"ui-monospace,monospace",lineHeight:1},children:pt}),h.jsx("div",{style:{fontSize:"10px",opacity:.78},children:"points"})]})]}),h.jsx("div",{style:{position:"relative",fontSize:"20px",fontWeight:700,marginTop:"14px"},children:j.name}),'
  )
  .replace(
    'h.jsx("div",{style:{height:"6px",borderRadius:"3px",background:"rgba(128,128,128,.18)",overflow:"hidden"},children:h.jsx("div",{style:{width:pc+"%",height:"100%",borderRadius:"3px",background:_.bar,transition:"width .4s"}})}),h.jsx("div",{className:`text-xs mt-1.5 ${_.faint}`,children:nx?nx[1]-pt+" pts to "+nx[0]+" — you earn points on every order":"Top tier — thanks for being a regular ⭐"}),',
    'h.jsx("div",{style:{position:"relative",height:"7px",borderRadius:"4px",background:"rgba(0,0,0,.16)",overflow:"hidden",marginTop:"14px"},children:h.jsx("div",{style:{width:pc+"%",height:"100%",borderRadius:"4px",background:"rgba(255,255,255,.9)",transition:"width .5s"}})}),h.jsx("div",{style:{position:"relative",fontSize:"11.5px",marginTop:"7px",opacity:.9,fontWeight:600},children:nx?nx[1]-pt+" pts to "+nx[0]+" ✨":"Top tier — thank you for being a regular 👑"}),'
  )
  .replace(
    'h.jsxs("div",{className:"mt-3",children:[h.jsx("div",{className:`text-xs font-semibold mb-1.5 ${_.sub}`,children:"Your usuals — tap to reorder"}),h.jsx("div",{className:"flex gap-1.5 flex-wrap",children:fav.map(x=>h.jsxs("button",{onClick:()=>{$1(x.pid,1);Q(`${x.name} added to your cart`)},className:`px-3 py-1.5 rounded-full text-xs font-semibold ${_.chip}`,children:',
    'h.jsxs("div",{style:{position:"relative"},className:"mt-3",children:[h.jsx("div",{style:{fontSize:"11px",fontWeight:700,marginBottom:"6px",opacity:.85},children:"Your usuals — tap to reorder"}),h.jsx("div",{className:"flex gap-1.5 flex-wrap",children:fav.map(x=>h.jsxs("button",{onClick:()=>{$1(x.pid,1);Q(`${x.name} added to your cart`)},style:{background:"rgba(255,255,255,.6)",color:"inherit"},className:"px-3 py-1.5 rounded-full text-xs font-semibold",children:'
  )

  /* 49. Dashboard analytics roll-up: extend the Ir memo with yesterday's
     net/txns (for KPI deltas), a 7-day daily-total series (sparkline) and
     the peak hour. All derived from the same sales array m + today-start pd,
     inside the existing useMemo so it only recomputes when sales change. */
  .replace(
    'reorder);return{today:f,net:A,txns:N,',
    'reorder);const _dy=864e5,_p0=pd.getTime(),_yf=m.filter(ie=>ie.t>=_p0-_dy&&ie.t<_p0&&ie.type==="sale"),_yNet=_yf.reduce((a,e)=>a+e.total,0),_yTxns=_yf.length,_wk=[];for(let _d=6;_d>=0;_d--){const _s=_p0-_d*_dy;_wk.push({d:new Date(_s).toLocaleDateString([],{weekday:"short"}).slice(0,2),v:m.filter(ie=>ie.t>=_s&&ie.t<_s+_dy&&ie.type==="sale").reduce((a,x)=>a+x.total,0)/100})}const _pk=j.reduce((a,x)=>x.v>a.v?x:a,{h:"",v:0});return{today:f,net:A,txns:N,'
  )
  .replace(
    ',low:yt}},[m,c])',
    ',low:yt,prevNet:_yNet,prevTxns:_yTxns,week:_wk,peak:_pk}},[m,c])'
  )

  /* 50. KPI tiles: show a delta chip vs yesterday (▲/▼ %) when a prior value
     is available. vd gains two optional args (current, previous). */
  .replace(
    'vd=(f,A,N)=>h.jsxs("div",{className:`rounded-2xl p-4 ${_.panel}`,children:[h.jsx("div",{className:`text-xs uppercase tracking-wide ${_.sub}`,children:f}),h.jsx("div",{className:`font-mono tabular-nums text-2xl font-bold mt-1 ${N||_.accent}`,children:A})]})',
    'vd=(f,A,N,cu,pv)=>{var dl=cu!=null&&pv!=null&&pv>0?Math.round((cu-pv)/pv*100):null;return h.jsxs("div",{className:`rounded-2xl p-4 ${_.panel}`,children:[h.jsxs("div",{className:"flex items-center justify-between gap-1",children:[h.jsx("div",{className:`text-xs uppercase tracking-wide ${_.sub}`,children:f}),dl!=null?h.jsxs("span",{className:`text-xs font-bold ${dl>=0?"text-emerald-400":"text-rose-400"}`,children:[dl>=0?"▲":"▼",Math.abs(dl),"%"]}):null]}),h.jsx("div",{className:`font-mono tabular-nums text-2xl font-bold mt-1 ${N||_.accent}`,children:A})]})}'
  )
  .replace(
    'kpis:h.jsxs("div",{className:"grid grid-cols-2 lg:grid-cols-4 gap-3",children:[vd("Net sales today",ue(Ir.net),_.accent),vd("Transactions",Ir.txns),vd("Avg basket",ue(Ir.avg)),vd("Items sold",Ir.items)]})',
    'kpis:h.jsxs("div",{className:"grid grid-cols-2 lg:grid-cols-4 gap-3",children:[vd("Net sales today",ue(Ir.net),_.accent,Ir.net,Ir.prevNet),vd("Transactions",Ir.txns,"",Ir.txns,Ir.prevTxns),vd("Avg basket",ue(Ir.avg)),vd("Items sold",Ir.items)]})'
  )

  /* 51. Chart card: a "Busiest …" subtitle (peak hour) under the title, and a
     7-day trend sparkline row under the hour labels. */
  .replace(
    'h.jsx("div",{className:"text-sm font-semibold",children:"Sales by hour (today)"}),h.jsxs("div",{className:`flex gap-0.5 rounded-lg p-0.5',
    'h.jsxs("div",{children:[h.jsx("div",{className:"text-sm font-semibold",children:"Sales by hour (today)"}),Ir.peak&&Ir.peak.v>0?h.jsxs("div",{className:`text-xs ${_.faint}`,children:["Busiest ",Ir.peak.h," · ",ce.currency," ",Ir.peak.v.toFixed(2)]}):null]}),h.jsxs("div",{className:`flex gap-0.5 rounded-lg p-0.5'
  )
  .replace(
    'map((d,i)=>h.jsx("span",{children:d.h},i))})]})',
    'map((d,i)=>h.jsx("span",{children:d.h},i))}),window.__ksSpark&&(Ir.week||[]).length?h.jsxs("div",{className:"flex items-center gap-3 mt-3 pt-3",style:{borderTop:"1px solid "+_.grid},children:[h.jsx("div",{className:`text-xs ${_.sub}`,style:{whiteSpace:"nowrap"},children:"7-day trend"}),h.jsx("div",{style:{flex:1,height:"32px"},dangerouslySetInnerHTML:{__html:window.__ksSpark(Ir.week,_)}}),h.jsxs("div",{className:`text-xs font-semibold ${_.accent}`,style:{whiteSpace:"nowrap"},children:[ce.currency," ",(Ir.week||[]).reduce((a,x)=>a+x.v,0).toFixed(0)]})]}):null]})'
  )

  /* 48. Dashboard payment-mix bar was a hardcoded bg-cyan-500 — recolour it
     from the theme accent so it matches the store's palette. */
  .replace(
    'h.jsx("div",{className:"h-1.5 rounded-full bg-cyan-500",style:{width:Math.round(A/Ir.gross*100)+"%"}})',
    'h.jsx("div",{className:"h-1.5 rounded-full",style:{width:Math.round(A/Ir.gross*100)+"%",background:_.bar}})'
  )

  /* 52. Waiter-call notifications that wouldn't clear. "On my way" only did
     uu(filter) — it removed the call from local state but never deleted the
     waiterCalls entity, so it stayed deleted=false on the server and
     reappeared on the next pull / when the till was reopened (the sync-diff
     delete could also be swallowed by the echo guard). Accept now also pushes
     an explicit delete op (FT) so the entity is really removed everywhere. */
  .replace(
    'h.jsx("button",{onClick:()=>uu(A=>A.filter(N=>N.id!==f.id)),className:"rounded-lg px-3 py-1.5 text-xs font-semibold bg-amber-500 text-slate-950",children:"On my way"})',
    'h.jsx("button",{onClick:()=>{uu(A=>A.filter(N=>N.id!==f.id));try{FT([],[{kind:"waiterCalls",id:f.id}])}catch{}},className:"rounded-lg px-3 py-1.5 text-xs font-semibold bg-amber-500 text-slate-950",children:"On my way"})'
  )

  /* 53. Tablet/phone POS order drawer clipped its footer off-screen. Below
     the lg breakpoint the cart moves into a bottom-sheet fixed at height:85vh
     that held a drag handle *and* the cart body Jw (flex flex-col h-full).
     Because the sheet was a plain block, Jw's h-full resolved to 100% of the
     full 85vh — so stacked under the handle and the p-4 padding the total
     overflowed the sheet and the totals + Charge button fell below the
     viewport, unreachable. Make the sheet a flex column and give Jw a
     flex-1 slot (minHeight:0 inline — min-h-0 isn't in the purged CSS) so it
     fills only the space left under the handle and its inner list scrolls.
     Find lacks "flex flex-col", so this is a no-op on re-bakes. */
  .replace(
    'className:`w-full rounded-t-3xl p-4 ${_.modal}`,style:{height:"85vh"},children:[h.jsx("div",{className:`w-10 h-1 rounded-full mx-auto mb-3 ${i?"bg-slate-700":"bg-slate-300"}`}),Jw]})',
    'className:`w-full rounded-t-3xl p-4 flex flex-col ${_.modal}`,style:{height:"85vh"},children:[h.jsx("div",{className:`w-10 h-1 rounded-full mx-auto mb-3 shrink-0 ${i?"bg-slate-700":"bg-slate-300"}`}),h.jsx("div",{className:"flex-1",style:{minHeight:0},children:Jw})]})'
  )

  /* 54. Menu ordering (the guest/table "Menu" tab, shared by the customer QR
     portal and the in-till table-order flow) stacked every item in a single
     rounded panel with dashed dividers — one tall vertical column that wasted
     all the horizontal room on a tablet. Turn each category's list into a
     responsive grid of individual cards (1 col on a phone, 2 on a tablet, 3
     on a large screen) matching the main POS card grid. Find carries the old
     panel+divider classes, so this is a no-op on re-bakes. */
  .replace(
    '`rounded-2xl ${_.panel}`,children:ke.map(ze=>{const on=fe.cart.find(To=>To.pid===ze.id);return h.jsxs("div",{className:`flex items-center gap-3 px-3.5 py-3 border-b border-dashed last:border-0 ${_.border}`',
    '`grid gap-2 sm:grid-cols-2 lg:grid-cols-3`,children:ke.map(ze=>{const on=fe.cart.find(To=>To.pid===ze.id);return h.jsxs("div",{className:`flex items-center gap-3 px-3.5 py-3 rounded-2xl ${_.panel}`'
  )

  /* 55. That same menu was capped at max-w-md (448px) and centred, so even on
     a wide tablet it never grew past a single narrow column. Widen it (inline
     maxWidth, since no wider max-w-* class survived the CSS purge) so the new
     grid actually spreads; phones are unaffected (screen < the cap). */
  .replace(
    'max-w-md mx-auto px-4",style:{paddingBottom:"16rem"}',
    'mx-auto px-4",style:{paddingBottom:"16rem",maxWidth:"56rem"}'
  )

  /* 56. The menu's floating order summary (item toggle · total · Charge/Send)
     was fixed at bottom-0 z-20 — fine on the QR portal, but in the till the
     bottom nav bar (fixed bottom-0 z-30) sat on top of it, hiding the action
     buttons so a table order could never be completed on a tablet. Lift the
     card above the nav (and any safe-area inset) whenever it's the in-till
     flow (!fe.urlMode); the QR portal, which has no nav, stays at bottom-0.
     Raised to z-40 so it can never be occluded. */
  .replace(
    'className:"fixed inset-x-0 bottom-0 z-20 p-3",children:',
    'className:"fixed inset-x-0 z-40 p-3",style:{bottom:fe.urlMode?0:"calc(4.5rem + env(safe-area-inset-bottom,0px))"},children:'
  )

  /* 57. Customer portal — "Waiter" call button was a hardcoded amber pill
     (bg-amber-500/15 text-amber-500) that clashed with every store theme
     except the amber one. Recolour it from the live accent (_.bar hex; the
     +"26" alpha ≈ the old /15 tint). Find carries the amber classes, so the
     patch is a no-op on re-runs. */
  .replace(
    '"flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-500",children:[h.jsx(ks,{size:12})," Waiter"]',
    '"flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-semibold",style:{background:_.bar+"26",color:_.bar},children:[h.jsx(ks,{size:12})," Waiter"]'
  )

  /* 58. Same for the per-order "Call" (waiter) pill in the customer's order
     list — off-theme amber → the store accent. */
  .replace(
    '"ml-auto flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-500 cursor-pointer",children:[h.jsx(ks,{size:11})," Call"',
    '"ml-auto flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold cursor-pointer",style:{background:_.bar+"26",color:_.bar},children:[h.jsx(ks,{size:11})," Call"'
  )

  /* 59. The member's "On account" balance is intentionally a WARNING tone,
     not the store accent: it flags money the member owes, so it should read
     as caution (amber) regardless of theme — unlike the Waiter/Call action
     pills above, which follow the accent. Left at the bundle's original
     amber (bg-amber-500/10 · text-amber-500); no override needed. */

  /* 60. Kitchen role — a new staff role for a chef on the pass. It can only
     reach the Orders queue (the kitchen display), nothing else. */
  .replace(
    'iae={cashier:["sell","orders","customers"],manager:',
    'iae={cashier:["sell","orders","customers"],kitchen:["orders"],manager:'
  )

  /* 61. Offer "Kitchen" in the Users & PINs role picker so an owner can
     create a "Kitchen" login (the button label is capitalised from the id). */
  .replace(
    '["cashier","manager","owner"].map(f=>h.jsx("button",{onClick:()=>ra({...ui,role:f})',
    '["cashier","kitchen","manager","owner"].map(f=>h.jsx("button",{onClick:()=>ra({...ui,role:f})'
  )

  /* 62. On PIN sign-in, land a kitchen user straight on the Orders board
     (their only permitted view) instead of the Sell screen. */
  .replace(
    'n(gu.id),Yf(null),Es(""),s("sell"),u("menu")',
    'n(gu.id),Yf(null),Es(""),s(gu.role==="kitchen"?"orders":"sell"),u("menu")'
  )

  /* 63. The Sell tab was pinned always-on in the bottom nav (gate !0). Gate
     it by br("sell") so a kitchen login (no "sell" perm) sees only Orders;
     cashier/manager/owner all have "sell", so nothing changes for them. */
  .replace(
    'w6=[["sell","Sell",$d,!0],',
    'w6=[["sell","Sell",$d,br("sell")],'
  )

  /* 64. Kitchen advance stops at "ready". On an order card the advance button
     normally runs the full lifecycle (…→ready→delivered→settle). For a
     kitchen user it may only push new→preparing→ready (cooking); once ready
     it becomes a static "Ready ✓ — for delivery" badge (delivering + settling
     are front-of-house). Find has the bare onClick:()=>Vw(f), which the
     guarded replacement lacks, so it's a no-op on re-bakes. */
  .replace(
    'onClick:()=>Vw(f),className:`mt-3 w-full rounded-xl py-2.5 text-sm font-semibold ${f.status==="ready"||f.status==="delivered"?_.primary:_.btn}`,children:f.status==="ready"?"Mark delivered":f.status==="delivered"?f.paidOnline?"Complete (already paid)":"Settle & pay":MI[f.status]',
    'onClick:()=>{if(Ne&&Ne.role==="kitchen"&&f.status!=="new"&&f.status!=="preparing")return;Vw(f)},className:`mt-3 w-full rounded-xl py-2.5 text-sm font-semibold ${Ne&&Ne.role==="kitchen"&&f.status!=="new"&&f.status!=="preparing"?_.chipOn:f.status==="ready"||f.status==="delivered"?_.primary:_.btn}`,children:Ne&&Ne.role==="kitchen"&&f.status!=="new"&&f.status!=="preparing"?"Ready ✓ — for delivery":f.status==="ready"?"Mark delivered":f.status==="delivered"?f.paidOnline?"Complete (already paid)":"Settle & pay":MI[f.status]'
  )

  /* 65. When an order flips to "ready", chime "food's up" on every till so the
     counter knows it's ready to be delivered — the same inbound-sync hook that
     already announces new QR orders and waiter calls (the 3.5s arm delay keeps
     it from firing a burst for pre-existing ready orders on first load). */
  .replace(
    'A.orders&&A.orders.forEach(function(_o){!_o.deleted&&_o.data&&_o.data.status==="new"&&_o.data.source==="qr"&&!_sn.o[_o.id]&&(_sn.o[_o.id]=1,window.__ksnd.play("order"))})',
    'A.orders&&A.orders.forEach(function(_o){if(_o.deleted||!_o.data)return;_o.data.status==="new"&&_o.data.source==="qr"&&!_sn.o[_o.id]&&(_sn.o[_o.id]=1,window.__ksnd.play("order"));_o.data.status==="ready"&&!(_sn.r=_sn.r||{})[_o.id]&&(_sn.r[_o.id]=1,window.__ksnd.play("ready"))})'
  )

  /* 66. Register restyle (design §4.1): the Pay button is the money screen's
     hero — full-width keyo-600, ≥56px tall. Bump py-3 → py-4 + minHeight 56px,
     and drop the off-theme cyan drop-shadow (§4 allows one flat shadow only,
     never a coloured glow). Find carries the shadow-cyan classes, absent from
     the replacement, so it's a no-op on re-bakes. */
  .replace(
    'className:`flex-1 rounded-xl py-3 font-semibold text-sm shadow-lg ${i?"shadow-cyan-500/20":"shadow-cyan-600/20"} ${_.primary} active:scale-95 transition`,children:["Charge ",ue(cr.total)]',
    'className:`flex-1 rounded-xl py-4 font-semibold text-sm ${_.primary} active:scale-95 transition`,style:{minHeight:"56px"},children:["Charge ",ue(cr.total)]'
  )

  /* 67. Register ticket TOTAL is a "big number" (design §3) — render it in the
     Bricolage display face with tabular figures instead of the receipt mono,
     so the amount the cashier reads all day has the product's own typographic
     signature. */
  .replace(
    '"font-mono tabular-nums text-xl font-bold",children:ue(cr.total)',
    '"ksh-display tabular-nums text-xl font-bold",children:ue(cr.total)'
  )

  /* 68. Manager dashboard §4.2 — the Orders board's status filters double as
     the stat strip: show each filter's live count so the chips ARE the stats
     (one control, never a separate counter that can drift). Counts derive
     from the same `b` orders array + qf filter logic used to render the list. */
  .replace(
    '.map(([f,A])=>h.jsx("button",{onClick:()=>PT(f),className:`px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${qf===f?_.chipOn:_.chip}`,children:A},f))',
    '.map(([f,A])=>h.jsxs("button",{onClick:()=>PT(f),className:`px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${qf===f?_.chipOn:_.chip}`,children:[A,h.jsx("span",{className:"ml-1.5 tabular-nums opacity-60",children:f==="all"?b.length:f==="active"?b.filter(N=>!["completed","wasted"].includes(N.status)).length:b.filter(N=>N.status===f).length})]},f))'
  )

  /* 69. Customer QR menu §4.3 (editorial warmth): the returning-member
     greeting becomes a large Bricolage display hero instead of a plain
     text-lg line. */
  .replace(
    'h.jsxs("div",{className:"text-lg font-bold",children:[(kh=>kh<5?"Good night":kh<12?"Good morning":kh<18?"Good afternoon":"Good evening")',
    'h.jsxs("div",{className:"ksh-display text-2xl font-bold",children:[(kh=>kh<5?"Good night":kh<12?"Good morning":kh<18?"Good afternoon":"Good evening")'
  )

  /* 69b. First-time guests (table QR, no member) had only a small grey
     subtitle — give them the same editorial hero: an appetising Bricolage
     display headline over the "order from your phone" line. */
  .replace(
    'h.jsx("div",{className:`text-xs mb-2 ${_.sub}`,children:"Order from your phone — we\'ll bring it to you."})',
    'h.jsxs("div",{className:"mb-2",children:[h.jsx("div",{className:"ksh-display text-2xl font-bold leading-tight",children:"Order now & savor"}),h.jsx("div",{className:`text-xs mt-0.5 ${_.sub}`,children:"Order from your phone — we\'ll bring it to you."})]})'
  )

  /* 73b. Hardening: the "Recent sales" list did f.payments.map(...) unguarded,
     so a single sale row without a payments array (an FOC/refund edge, or an
     imported record) crashed the entire till to a blank screen. Guard it. */
  .replace(
    'f.payments.map(A=>A.method)',
    '(f.payments||[]).map(A=>A.method)'
  )

  /* 73. Availability §2 / Phase 3 — a till catalog tile whose ingredients (or
     tracked stock) have run out can no longer be tapped into an order: it dims,
     shows a "Sold out" pill, and its add handler is blocked. Restores itself
     automatically when the availability engine reports stock again. */
  .replace(
    'Sw.map(f=>h.jsxs("button",{onClick:()=>id(f),className:`relative rounded-2xl p-3 text-left transition active:scale-95 ${_.tile}`,children:[',
    'Sw.map(f=>h.jsxs("button",{onClick:()=>{if(window.__ksOut(f))return;id(f)},className:`relative rounded-2xl p-3 text-left transition active:scale-95 ${_.tile} ${window.__ksOut(f)?"opacity-50":""}`,children:[window.__ksOut(f)?h.jsx("span",{className:"absolute top-2 right-2 ksh-pill",style:{background:"#FEE2E2",color:"#B91C1C",fontSize:"10px",padding:"2px 8px",zIndex:2},children:"Sold out"}):null,'
  )

  /* 78. One-tap restock from the sell screen. A stock-tracked item that has
     counted down to zero shows "Sold out +" — tapping the pill prompts for a
     quantity and adds it (optimistic local bump + a stock delta the same way
     the manual adjust does), so a cashier can put an item back on sale without
     leaving for /back. Only offered for plain stock items (f.stock is a number):
     a recipe-driven sold-out is an ingredient shortage the product can't fix, so
     its pill stays a plain "Sold out". stopPropagation keeps the tap off the
     (blocked) add handler. Runs after #73, which creates the pill it rewrites;
     the find ends `children:"Sold out"}):null,` and the replacement begins
     `h.jsx("span",{onClick:`, so it is a no-op on re-bake. */
  .replace(
    'window.__ksOut(f)?h.jsx("span",{className:"absolute top-2 right-2 ksh-pill",style:{background:"#FEE2E2",color:"#B91C1C",fontSize:"10px",padding:"2px 8px",zIndex:2},children:"Sold out"}):null,',
    'window.__ksOut(f)?h.jsx("span",{onClick:ke=>{if(f.recipeAvail!=null||f.stock==null)return;ke.stopPropagation();var kq=parseInt(window.prompt("Restock "+(f.name||"item")+" — add how many "+(f.unit||"pcs")+"?","1"),10);if(kq>0){d(cj=>cj.map(cf=>cf.id===f.id?{...cf,stock:(Number(cf.stock)||0)+kq}:cf));na({stock:[{id:f.id,d:kq}]})}},title:(f.recipeAvail!=null||f.stock==null)?"Sold out":"Tap to restock",className:"absolute top-2 right-2 ksh-pill",style:{background:"#FEE2E2",color:"#B91C1C",fontSize:"10px",padding:"2px 8px",zIndex:2,cursor:(f.recipeAvail!=null||f.stock==null)?"default":"pointer"},children:(f.recipeAvail!=null||f.stock==null)?"Sold out":"Sold out +"}):null,'
  )

  /* 79. Best-seller tags (§4 menu polish, from the reference design). A product
     the backend flagged as a top mover (data.bestSeller, set by
     recomputeBestSellers, arriving on the normal sync stream) gets a small
     brand-coloured "★ Best seller" badge in the tile's top-left. Hidden while
     the item is sold out, so the sold-out pill never competes with it. Runs
     after #78, whose "Sold out +" text it anchors on; the find keeps the
     `f.img?…:f.emoji}),` tail whereas the replacement pushes that tail behind
     the new badge, so it is a no-op on re-bake. */
  .replace(
    '"Sold out +"}):null,f.img?h.jsx("img",{src:f.img,alt:"",className:"w-full h-16 rounded-lg object-cover mb-1.5"}):h.jsx("div",{className:"text-3xl mb-1.5",children:f.emoji}),',
    '"Sold out +"}):null,(!window.__ksOut(f)&&f.bestSeller)?h.jsx("span",{className:"absolute top-2 left-2 ksh-pill",style:{background:"var(--k-primary)",color:"#fff",fontSize:"9px",fontWeight:"600",padding:"2px 7px",zIndex:2},children:"★ Best seller"}):null,f.img?h.jsx("img",{src:f.img,alt:"",className:"w-full h-16 rounded-lg object-cover mb-1.5"}):h.jsx("div",{className:"text-3xl mb-1.5",children:f.emoji}),'
  )

  /* 80. Order-progress rings on the Orders board (§4, reference design). Each
     live order card leads with a circular gauge of its lifecycle progress
     (new→preparing→ready→done via __ksProg), coloured by the same status token
     the pill uses. Inserted as the first child of the card's header flex row,
     before the table chip. The find keeps `children:[h.jsx("span"…f.table})`
     contiguous whereas the replacement wedges the ring div between them, so it
     is a no-op on re-bake. */
  .replace(
    'h.jsxs("div",{className:"flex items-center gap-3",children:[h.jsx("span",{className:`px-2.5 py-1.5 rounded-xl text-sm font-bold ${_.chipOn}`,children:f.table}),',
    'h.jsxs("div",{className:"flex items-center gap-3",children:[h.jsx("div",{className:"shrink-0",title:"Order progress",dangerouslySetInnerHTML:{__html:window.__ksRing(window.__ksProg(f.status),window.__kstatus(f.status).fg,40)}}),h.jsx("span",{className:`px-2.5 py-1.5 rounded-xl text-sm font-bold ${_.chipOn}`,children:f.table}),'
  )

  /* 89. Orders-board card header alignment (from IMG_6949). The type/table chip
     ("Pickup"/"Takeaway"/table no) was oversized (px-2.5 py-1.5 text-sm),
     hogging width and forcing the order number ("ORD-522") and customer name to
     wrap onto their own broken lines. This shrinks the chip and pins it
     (shrink-0), makes the meta row wrap between chips instead of within them
     (flex-wrap gap-x/gap-y), and keeps the order number + customer name each on
     one line (whitespace-nowrap). Idempotent: the find carries the old
     px-2.5/rounded-xl/text-sm chip + the non-wrapping meta row, none of which
     survive into the replacement. */
  .replace(
    'h.jsx("span",{className:`px-2.5 py-1.5 rounded-xl text-sm font-bold ${_.chipOn}`,children:f.table}),h.jsxs("div",{className:"flex-1 min-w-0",children:[h.jsxs("div",{className:"text-sm font-medium flex items-center gap-2",children:[f.no,f.customerName&&h.jsx("span",{className:"text-xs px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400",children:f.customerName}),',
    'h.jsx("span",{className:`px-2 py-0.5 rounded-lg text-xs font-bold ${_.chipOn} shrink-0 whitespace-nowrap`,children:f.table}),h.jsxs("div",{className:"flex-1 min-w-0",children:[h.jsxs("div",{className:"text-sm font-medium flex flex-wrap items-center gap-x-2 gap-y-1",children:[h.jsx("span",{className:"whitespace-nowrap font-semibold",children:f.no}),f.customerName&&h.jsx("span",{className:"text-xs px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 whitespace-nowrap",children:f.customerName}),'
  )

  /* 93. Show stock-untracked items on the guest menu. The guest category grid
     filtered products with `ze.stock>0`, which hid every item whose stock is
     left blank/untracked (the opt-in-stock default, patch #76) — so a menu of
     always-available items rendered as empty categories. Boot already decides
     visibility (untracked + in-stock + sold-out recipe items pass; only plain
     stock-tracked-to-zero items are dropped), so the card grid only needs to
     drop items that have gone to zero live: keep untracked (stock==null) and
     positive-stock items. Idempotent: the bare `ze.stock>0` find is gone from
     the replacement. */
  .replace(
    'const ke=N.filter(ze=>ze.cat===ne&&ze.stock>0);',
    'const ke=N.filter(ze=>ze.cat===ne&&(ze.stock==null||ze.stock>0));'
  )

  /* 90. Keep the Orders-board elapsed-time subtitle on one line. The status
     pill + "N min" text lived in a plain `flex items-center` span, so on a
     narrow (mobile) card the number and "min" could break across two lines
     ("1954" / "min"). Pin the row with whitespace-nowrap so the pill and time
     stay together. Idempotent: the find carries the pre-nowrap class string,
     which the replacement no longer contains. */
  .replace(
    '(qp=>h.jsxs("span",{className:"flex items-center",children:[h.jsx("span",{className:"ksh-pill mr-1.5"',
    '(qp=>h.jsxs("span",{className:"flex items-center whitespace-nowrap",children:[h.jsx("span",{className:"ksh-pill mr-1.5"'
  )

  /* 74. Availability §2 on the customer QR menu — a recipe/stock item that has
     sold out stays on the menu (dimmed) with a "Sold out" pill instead of an
     add button, so guests see it but can't order it. Items already in the cart
     keep their stepper so they can still be removed. */
  .replace(
    'return h.jsxs("div",{className:`flex items-center gap-3 px-3.5 py-3 rounded-2xl ${_.panel}`,children:[ze.img?',
    'return h.jsxs("div",{className:`flex items-center gap-3 px-3.5 py-3 rounded-2xl ${_.panel} ${ze.soldOut?"opacity-60":""}`,children:[ze.img?'
  )
  .replace(
    ']}),on?h.jsxs("div",{className:`flex items-center rounded-lg ${_.panel2}`,children:[h.jsx("button",{onClick:()=>$1(ze.id,-1)',
    ']}),ze.soldOut&&!on?h.jsx("span",{className:"ksh-pill",style:{background:"#FEE2E2",color:"#B91C1C",fontSize:"10px",padding:"2px 8px"},children:"Sold out"}):on?h.jsxs("div",{className:`flex items-center rounded-lg ${_.panel2}`,children:[h.jsx("button",{onClick:()=>$1(ze.id,-1)'
  )

  /* 81. Photo-forward guest menu cards (§4.3, from the reference design). The
     QR menu listed items as compact rows with an 11px thumbnail; make each a
     card with the dish photo filling the top, the name, a two-line
     description/allergen note, and the price + add stepper along the bottom —
     the same add/stepper/sold-out logic, restyled. Needs data.desc from the
     guest boot (added in index.js). Runs after #74, whose card it rewrites; the
     find keeps the compact `flex items-center gap-3 … w-11 h-11` layout, the
     replacement is the photo card, so it is a no-op on re-bake. */
  .replace(
    'return h.jsxs("div",{className:`flex items-center gap-3 px-3.5 py-3 rounded-2xl ${_.panel} ${ze.soldOut?"opacity-60":""}`,children:[ze.img?h.jsx("img",{src:ze.img,alt:"",className:"w-11 h-11 rounded-lg object-cover"}):h.jsx("span",{className:"text-2xl",children:ze.emoji}),h.jsxs("div",{className:"flex-1 min-w-0",children:[h.jsx("div",{className:"text-sm font-medium",children:ze.name}),h.jsx("div",{className:`text-xs font-mono ${_.faint}`,children:Y(ze.price)})]}),ze.soldOut&&!on?h.jsx("span",{className:"ksh-pill",style:{background:"#FEE2E2",color:"#B91C1C",fontSize:"10px",padding:"2px 8px"},children:"Sold out"}):on?h.jsxs("div",{className:`flex items-center rounded-lg ${_.panel2}`,children:[h.jsx("button",{onClick:()=>$1(ze.id,-1),className:"px-2.5 py-1.5",children:h.jsx(Lu,{size:13})}),h.jsx("span",{className:"w-6 text-center text-sm font-mono",children:on.qty}),h.jsx("button",{onClick:()=>$1(ze.id,1),className:"px-2.5 py-1.5",children:h.jsx(fi,{size:13})})]}):h.jsx("button",{onClick:()=>$1(ze.id,1),className:`p-2 rounded-lg ${_.btn}`,children:h.jsx(fi,{size:15})})]},ze.id)',
    'return h.jsxs("div",{className:`rounded-2xl overflow-hidden ${_.panel} ${ze.soldOut?"opacity-60":""}`,children:[ze.img?h.jsx("img",{src:ze.img,alt:"",className:"w-full object-cover",style:{height:"150px"}}):h.jsx("div",{className:`w-full flex items-center justify-center text-4xl ${_.panel2}`,style:{height:"150px"},children:ze.emoji}),h.jsxs("div",{className:"p-3",children:[h.jsx("div",{className:"text-sm font-medium leading-tight",children:ze.name}),ze.desc?h.jsx("div",{className:`text-xs mt-1 ${_.faint}`,style:{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"},children:ze.desc}):null,h.jsxs("div",{className:"flex items-center justify-between mt-2",children:[h.jsx("div",{className:"text-sm font-mono font-semibold",children:Y(ze.price)}),ze.soldOut&&!on?h.jsx("span",{className:"ksh-pill",style:{background:"#FEE2E2",color:"#B91C1C",fontSize:"10px",padding:"2px 8px"},children:"Sold out"}):on?h.jsxs("div",{className:`flex items-center rounded-lg ${_.panel2}`,children:[h.jsx("button",{onClick:()=>$1(ze.id,-1),className:"px-2.5 py-1.5",children:h.jsx(Lu,{size:13})}),h.jsx("span",{className:"w-6 text-center text-sm font-mono",children:on.qty}),h.jsx("button",{onClick:()=>$1(ze.id,1),className:"px-2.5 py-1.5",children:h.jsx(fi,{size:13})})]}):h.jsx("button",{onClick:()=>$1(ze.id,1),className:`p-2 rounded-lg ${_.btn}`,children:h.jsx(fi,{size:15})})]})]})]},ze.id)'
  )

  /* 82. Interactive item sheet (§4.3, reference design). Tapping a menu card
     opens a bottom sheet — big photo, description, allergens, a quantity
     stepper and the item's add-ons (each a priced toggle) — then "Add to cart"
     folds the choice into the cart. The open item + its pending qty/add-ons
     live on the guest state object (fe.sheet / fe.sheetQty / fe.sheetAddons),
     toggled through the same Dn(N=>({...N,…})) updater the rest of the guest
     view uses, so no new React hook is needed. Add-on prices are re-validated
     server-side (see index.js), so the sheet's price is display-only.
     82a — tapping a card opens the sheet; the +/- controls stopPropagation so
     they still just change quantity. */
  .replace(
    'return h.jsxs("div",{className:`rounded-2xl overflow-hidden ${_.panel} ${ze.soldOut?"opacity-60":""}`,children:[',
    'return h.jsxs("div",{onClick:()=>{if(!ze.soldOut)Dn(N=>{const ex=N.cart.find(x=>x.pid===ze.id)||{};return{...N,sheet:ze,sheetQty:ex.qty||1,sheetAddons:ex.addons||[]}})},style:{cursor:"pointer"},className:`rounded-2xl overflow-hidden ${_.panel} ${ze.soldOut?"opacity-60":""}`,children:['
  )
  .replace('onClick:()=>$1(ze.id,-1),className:"px-2.5 py-1.5"', 'onClick:e=>{e.stopPropagation();$1(ze.id,-1)},className:"px-2.5 py-1.5"')
  .replace('onClick:()=>$1(ze.id,1),className:"px-2.5 py-1.5"', 'onClick:e=>{e.stopPropagation();$1(ze.id,1)},className:"px-2.5 py-1.5"')
  .replace('onClick:()=>$1(ze.id,1),className:`p-2 rounded-lg ${_.btn}`', 'onClick:e=>{e.stopPropagation();$1(ze.id,1)},className:`p-2 rounded-lg ${_.btn}`')
  /* 82b — the sheet overlay, injected as a sibling of the menu/member view. */
  .replace(
    ']}),fe.tab==="menu"?h.jsx("div",{className:"mx-auto px-4",style:{paddingBottom:"16rem",maxWidth:"56rem"},children:he.map(ne=>{',
    ']}),fe.sheet?(so=>h.jsx("div",{onClick:()=>Dn(N=>({...N,sheet:null})),style:{position:"fixed",inset:0,zIndex:70,background:"rgba(0,0,0,.55)",display:"flex",alignItems:"flex-end",justifyContent:"center"},children:h.jsxs("div",{onClick:e=>e.stopPropagation(),className:_.panel,style:{width:"100%",maxWidth:"32rem",maxHeight:"92vh",overflowY:"auto",borderTopLeftRadius:"1.25rem",borderTopRightRadius:"1.25rem"},children:[so.img?h.jsx("img",{src:so.img,alt:"",className:"w-full object-cover",style:{height:"200px"}}):h.jsx("div",{className:`w-full flex items-center justify-center text-6xl ${_.panel2}`,style:{height:"200px"},children:so.emoji}),h.jsxs("div",{className:"p-4",children:[h.jsxs("div",{className:"flex items-start justify-between gap-3",children:[h.jsx("div",{className:"text-lg font-bold leading-tight",children:so.name}),h.jsx("button",{onClick:()=>Dn(N=>({...N,sheet:null})),className:_.faint,style:{fontSize:"22px",lineHeight:1},children:"✕"})]}),so.desc?h.jsx("div",{className:`text-sm mt-1 ${_.sub}`,children:so.desc}):null,so.allergens?h.jsx("div",{className:`text-xs mt-2 ${_.faint}`,children:"⚠ Allergens: "+so.allergens}):null,(so.addons&&so.addons.length)?h.jsxs("div",{className:"mt-4",children:[h.jsx("div",{className:"text-sm font-semibold mb-2",children:"Add-ons"}),h.jsx("div",{children:so.addons.map(ao=>{const sel=(fe.sheetAddons||[]).some(x=>x.name===ao.name);return h.jsxs("button",{onClick:()=>Dn(N=>{const cur=N.sheetAddons||[],has=cur.some(x=>x.name===ao.name);return{...N,sheetAddons:has?cur.filter(x=>x.name!==ao.name):[...cur,{name:ao.name,price:ao.price}]}}),className:`w-full flex items-center justify-between px-3 py-2.5 rounded-xl mb-1.5 ${_.panel2}`,children:[h.jsxs("span",{className:"flex items-center gap-2 text-sm",children:[h.jsx("span",{style:{width:"18px",height:"18px",borderRadius:"999px",border:"2px solid",borderColor:sel?"var(--k-primary)":"var(--k-border)",background:sel?"var(--k-primary)":"transparent",flex:"none"}}),ao.name]}),h.jsx("span",{className:"text-sm font-mono",children:"+"+Y(ao.price)})]},ao.name)})})]}):null,h.jsxs("div",{className:"flex items-center gap-3 mt-5",children:[h.jsxs("div",{className:`flex items-center rounded-xl ${_.panel2}`,children:[h.jsx("button",{onClick:()=>Dn(N=>({...N,sheetQty:Math.max(1,(N.sheetQty||1)-1)})),className:"px-3.5 py-2.5 text-lg",children:"−"}),h.jsx("span",{className:"w-8 text-center font-mono",children:fe.sheetQty||1}),h.jsx("button",{onClick:()=>Dn(N=>({...N,sheetQty:(N.sheetQty||1)+1})),className:"px-3.5 py-2.5 text-lg",children:"+"})]}),h.jsx("button",{onClick:()=>Dn(N=>({...N,cart:[...N.cart.filter(x=>x.pid!==so.id),{pid:so.id,qty:N.sheetQty||1,addons:N.sheetAddons||[]}],sheet:null})),className:`flex-1 rounded-xl py-3 text-sm font-semibold ${_.primary}`,children:"Add to cart · "+Y((so.price+(fe.sheetAddons||[]).reduce((s,a)=>s+(a.price||0),0))*(fe.sheetQty||1))})]})]})]})}))(fe.sheet):null,fe.tab==="menu"?h.jsx("div",{className:"mx-auto px-4",style:{paddingBottom:"16rem",maxWidth:"56rem"},children:he.map(ne=>{'
  )
  /* 82c — the cart/total preview folds each line's add-on prices into its price
     and appends the add-on names, so the guest sees the right total. */
  .replace(
    'return A?{pid:A.id,name:A.name,emoji:A.emoji,price:A.price,cost:A.cost,unit:A.unit||"pcs",vendor:!!A.vendor,qty:f.qty,discPct:0}:null',
    'return A?{pid:A.id,name:A.name+((f.addons&&f.addons.length)?" · "+f.addons.map(a=>a.name).join(", "):""),emoji:A.emoji,price:A.price+((f.addons||[]).reduce((s,a)=>s+(a.price||0),0)),cost:A.cost,unit:A.unit||"pcs",vendor:!!A.vendor,qty:f.qty,discPct:0,addons:f.addons}:null'
  )
  /* 82d — the guest cart drawer + its running total (yt/ie) also fold add-on
     prices into each line and show the add-on names. */
  .replace(
    'return ke?{pid:ke.id,name:ke.name,emoji:ke.emoji,price:ke.price,cost:ke.cost||0,unit:ke.unit||"pcs",qty:ne.qty,discPct:0}:null',
    'return ke?{pid:ke.id,name:ke.name+((ne.addons&&ne.addons.length)?" · "+ne.addons.map(a=>a.name).join(", "):""),emoji:ke.emoji,price:ke.price+((ne.addons||[]).reduce((s,a)=>s+(a.price||0),0)),cost:ke.cost||0,unit:ke.unit||"pcs",qty:ne.qty,discPct:0,addons:ne.addons}:null'
  )
  /* 82e — the Orders board line summary spells out each item's chosen add-ons
     (server stores them on line.note), so staff read "2× Tuna Kotthu (+Extra
     tuna, Fried egg)". */
  .replace(
    'f.items.map(I=>`${I.qty}× ${I.name}`).join(" · ")',
    'f.items.map(I=>`${I.qty}× ${I.name}`+(I.note?" (+"+I.note+")":"")).join(" · ")'
  )
  /* 82f — the kitchen ticket (KOT) prints the add-ons under each item name so
     the cook makes it right. */
  .replace(
    'h.jsx("span",{className:"flex-1",children:f.name})]},A)),ut.order.note',
    'h.jsxs("span",{className:"flex-1",children:[f.name,f.note?h.jsx("span",{className:"block text-xs font-medium opacity-70",children:"+ "+f.note}):null]})]},A)),ut.order.note'
  )

  /* 83. Sales channels: three order types — Dine-in, Takeaway, Delivery. A
     counter "walk-in" is just takeaway, so the separate Walk-in type is retired
     and folded into Takeaway everywhere (default, segment, effective-otype,
     order label, orders board, receipts, reports). The customer-side "Walk-in"
     (= no customer attached) is a different concept and is relabelled so nothing
     still reads "Walk-in" as a type. */
  /* 83a — default a new ticket to takeaway (the old walk-in). */
  .replace('covers:1,otype:"walkin",deliveryNote:""', 'covers:1,otype:"takeaway",deliveryNote:""')
  /* 83b — the segment control: Dine-in · Takeaway · Delivery. */
  .replace(
    'SC=[["walkin","Walk-in",_k],["takeaway","Takeaway",Ak],["dinein","Dine-in",Ls],["delivery","Delivery",SO]]',
    'SC=[["dinein","Dine-in",Ls],["takeaway","Takeaway",Ak],["delivery","Delivery",SO]]'
  )
  /* 83c — any legacy walk-in order now labels as Takeaway. */
  .replace('_C={walkin:"Walk-in",takeaway:"Takeaway"', '_C={walkin:"Takeaway",takeaway:"Takeaway"')
  /* 83d — effective order type: no table ⇒ takeaway; a legacy walkin ⇒ takeaway. */
  .replace(
    'nt=_e?_e.otype||(_e.table?"dinein":"walkin"):"walkin"',
    'nt=_e?(_e.otype==="walkin"?"takeaway":_e.otype)||(_e.table?"dinein":"takeaway"):"takeaway"'
  )
  /* 83e — the ticket's table label for a non-delivery, no-table sale. */
  .replace('table:_e.table||(nt==="delivery"?"Delivery":"Walk-in")', 'table:_e.table||(nt==="delivery"?"Delivery":"Takeaway")')
  /* 83f — orders board channel label. */
  .replace('${f.otype==="takeaway"?"Takeaway":"Walk-in"}', '${f.otype==="dinein"?"Dine-in":"Takeaway"}')
  /* 83g — reports: classify no-table / legacy-walkin sales as takeaway. */
  .replace(
    'const Ee=ie.otype||(ie.table?"dinein":"walkin");yt[Ee]&&',
    'const Ee=(ie.otype==="walkin"?null:ie.otype)||(ie.table?"dinein":"takeaway");yt[Ee]&&'
  )
  /* 83h — reports channel summary drops the (now-empty) walk-in count. */
  .replace(
    '`${mt.chan.walkin.n} walk-in · ${mt.chan.takeaway.n} takeaway · ${mt.chan.dinein.n} dine-in · ${mt.chan.delivery.n} delivery`',
    '`${mt.chan.takeaway.n} takeaway · ${mt.chan.dinein.n} dine-in · ${mt.chan.delivery.n} delivery`'
  )
  /* 83i — reports channel table drops the Walk-in row. */
  .replace(
    '[["Walk-in",mt.chan.walkin],["Takeaway",mt.chan.takeaway],["Dine-in",mt.chan.dinein],["Delivery",mt.chan.delivery]]',
    '[["Takeaway",mt.chan.takeaway],["Dine-in",mt.chan.dinein],["Delivery",mt.chan.delivery]]'
  )
  /* 83j — customer chip/picker: "Walk-in" (no customer) relabelled so it no
     longer clashes with the retired order type. */
  .replace('children:"Walk-in · attach"', 'children:"Add customer"')
  .replace('children:"Walk-in (no customer)"', 'children:"No customer"')

  /* 84. Guest wording matches the till: "Pickup" → "Takeaway" (and "Dine in" →
     "Dine-in"). The internal gtype value stays "pickup" (it already maps to
     takeaway in the order), so this is label-only; the orders filter keeps
     "Pickup" alongside "Takeaway" so already-placed orders still resolve. */
  .replace(
    '[["pickup","Pickup"],["table","Dine in"],["delivery","Delivery"]]',
    '[["pickup","Takeaway"],["table","Dine-in"],["delivery","Delivery"]]'
  )
  .replace('(A==="delivery"?"Delivery":"Pickup")', '(A==="delivery"?"Delivery":"Takeaway")')
  .replace('["Pickup","Delivery"].includes(ne.table)', '["Pickup","Takeaway","Delivery"].includes(ne.table)')

  /* 85. Category filter chips on the guest menu (§4.3, reference design). The
     QR menu stacked every category as a headed section; add a horizontal chip
     row (All · Breakfast · Kotthu …) that filters the menu to one category —
     the reference's Food/Dessert/Drinks tabs, in the store's own palette. The
     chosen category rides on fe.mcat via the existing Dn updater. 85a wraps the
     menu container to prepend the chips and filter the category map (start) and
     close the new children array (end). */
  .replace(
    'fe.tab==="menu"?h.jsx("div",{className:"mx-auto px-4",style:{paddingBottom:"16rem",maxWidth:"56rem"},children:he.map(ne=>{',
    'fe.tab==="menu"?h.jsxs("div",{className:"mx-auto px-4",style:{paddingBottom:"16rem",maxWidth:"56rem"},children:[h.jsx("div",{className:"flex gap-2 overflow-x-auto pb-2 mb-3 -mx-1 px-1",children:[["","All"],...he.map(ce=>[ce,ce])].map(([cv,cl])=>h.jsx("button",{onClick:()=>Dn(N=>({...N,mcat:cv})),className:`px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap ${(fe.mcat||"")===cv?_.chipOn:_.chip}`,children:cl},cv))}),he.filter(ne=>!fe.mcat||ne===fe.mcat).map(ne=>{'
  )
  .replace(
    ',ne):null})}):h.jsxs("div",{className:"max-w-md mx-auto px-4 pb-16"',
    ',ne):null})]}):h.jsxs("div",{className:"max-w-md mx-auto px-4 pb-16"'
  )
  /* 85b — menu cards lead with the allergen note (reference design) when set,
     falling back to the description. */
  .replace(
    'ze.desc?h.jsx("div",{className:`text-xs mt-1 ${_.faint}`,style:{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"},children:ze.desc}):null',
    '(ze.allergens||ze.desc)?h.jsx("div",{className:`text-xs mt-1 ${_.faint}`,style:{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"},children:ze.allergens?"Allergies: "+ze.allergens:ze.desc}):null'
  )

  /* 86. Guest menu: two photo cards per row on mobile (reference design) and a
     rotating welcome greeting that changes each visit. */
  .replace('`grid gap-2 sm:grid-cols-2 lg:grid-cols-3`', '`grid grid-cols-2 gap-2 lg:grid-cols-3`')
  .replace('children:"Order now & savor"', 'children:window.__ksGreet()')

  /* 87. Dark item sheet — swap its light panel class for the scoped .ksh-isheet
     dark wrapper (CSS injected above). */
  .replace(
    'onClick:e=>e.stopPropagation(),className:_.panel,style:{width:"100%",maxWidth:"32rem"',
    'onClick:e=>e.stopPropagation(),className:"ksh-isheet",style:{width:"100%",maxWidth:"32rem"'
  )

  /* 88. Editable order panel: the checkout sheet showed only an item count and
     total. Add an expandable list of the lines (name, unit price, quantity
     stepper, remove) above the summary, so a guest can review and edit before
     ordering — reusing the cart's own $1 add/remove. Collapsed by default with
     an "Edit ▾" toggle (fe.cexp). The summary line gains `mt-1` so this patch is
     a no-op on re-bake. */
  .replace(
    'h.jsx("div",{className:`flex justify-between text-xs ${_.sub}`,children:h.jsxs("span",{children:[yt.reduce((ne,ke)=>ne+ke.qty,0)," items"',
    'h.jsxs("div",{className:"mb-2",children:[h.jsxs("button",{onClick:()=>Dn(N=>({...N,cexp:!N.cexp})),className:"w-full flex items-center justify-between py-1 text-sm font-semibold",children:[h.jsxs("span",{children:[yt.reduce((a,b)=>a+b.qty,0)," item",yt.reduce((a,b)=>a+b.qty,0)===1?"":"s"," in your order"]}),h.jsx("span",{className:`text-xs ${_.faint}`,children:fe.cexp?"Hide ▴":"Edit ▾"})]}),fe.cexp?h.jsx("div",{className:"space-y-1.5 mt-1.5",children:yt.map(ne=>h.jsxs("div",{className:`flex items-center gap-2 rounded-xl px-2.5 py-2 ${_.panel2}`,children:[h.jsxs("div",{className:"flex-1 min-w-0",children:[h.jsx("div",{className:"text-sm font-medium truncate",children:ne.name}),h.jsx("div",{className:`text-xs font-mono ${_.faint}`,children:Y(ne.price)})]}),h.jsxs("div",{className:`flex items-center rounded-lg ${_.panel}`,children:[h.jsx("button",{onClick:()=>$1(ne.pid,-1),className:"px-2.5 py-1",children:"−"}),h.jsx("span",{className:"w-6 text-center text-sm font-mono",children:ne.qty}),h.jsx("button",{onClick:()=>$1(ne.pid,1),className:"px-2.5 py-1",children:"+"})]}),h.jsx("button",{onClick:()=>$1(ne.pid,-ne.qty),className:`px-1 text-lg ${_.faint}`,children:"×"})]},ne.pid))}):null]}),h.jsx("div",{className:`flex justify-between text-xs mt-1 ${_.sub}`,children:h.jsxs("span",{children:[yt.reduce((ne,ke)=>ne+ke.qty,0)," items"'
  )

  /* 72. Brand motif §1 — the boot loader showed a static logo; replace it with
     the kashikeyo hex-segment spinner whose six wedges pulse clockwise. */
  .replace(
    'h.jsx("img",{src:Po,alt:"",className:"w-12 h-12 object-contain mb-3"}),h.jsx("div",{className:`text-sm ${_.sub}`,children:"Connecting to the café…"',
    'h.jsx("div",{className:"mb-3",dangerouslySetInnerHTML:{__html:window.__kshexSvg("ksh-hexspin",52)}}),h.jsx("div",{className:`text-sm ${_.sub}`,children:"Connecting to the café…"'
  )

  /* 72b. Empty states get the faint hex-segment motif above the sentence
     (design §1 / §7). */
  .replace(
    'h.jsx("div",{className:`rounded-2xl p-8 text-center text-sm ${_.panel} ${_.faint}`,children:"No orders here yet — open a guest view above and place one."})',
    'h.jsxs("div",{className:`rounded-2xl p-8 text-center text-sm ${_.panel} ${_.faint}`,children:[h.jsx("div",{className:"flex justify-center mb-3",dangerouslySetInnerHTML:{__html:window.__kshexSvg("ksh-hexbg",64)}}),"No orders here yet — open a guest view above and place one."]})'
  )

  /* 71. Status-pill scale §5 — the order card's leading status word was plain
     faint text ("new · 3 min · QR"). Render it as the one shared status pill
     (tint bg + 700 text from __kstatus) so Orders and the Kitchen display
     speak the same status language; the age + source stay as faint meta. */
  .replace(
    'children:[f.status," · ",Math.floor((Date.now()-f.createdAt)/6e4)," min · ",f.source==="pos"?"POS":"QR"]',
    'children:[(qp=>h.jsx("span",{className:"ksh-pill mr-1.5",style:{background:qp.bg,color:qp.fg},children:qp.label}))(window.__kstatus(f.status)),Math.floor((Date.now()-f.createdAt)/6e4)," min · ",f.source==="pos"?"POS":"QR"]'
  )

  /* 71b. The Orders board / Kitchen display card subtitle rendered the status
     inside a template string (`${A} min · ${status}`). Split it: the shared
     status pill + the faint age. Completed orders keep their settled-time. */
  .replace(
    'h.jsx("div",{className:`text-xs ${N}`,children:f.status==="completed"?Vr(f.createdAt):`${A} min · ${f.status}`})',
    'h.jsx("div",{className:`text-xs ${N} flex items-center`,children:f.status==="completed"?Vr(f.createdAt):(qp=>h.jsxs("span",{className:"flex items-center",children:[h.jsx("span",{className:"ksh-pill mr-1.5",style:{background:qp.bg,color:qp.fg},children:qp.label}),A+" min"]}))(window.__kstatus(f.status))})'
  )

  /* 70. Register three-zone layout §4.1 — add the left order-queue rail on
     desktop: the open bills/tickets (Ti) as a vertical list with tap-to-switch
     (parked → resume, active → select), current highlighted. Reuses the same
     handlers the in-cart ticket strip already uses ($w/ea/_e), so it's a pure
     layout add. Grid goes 5→6 cols (rail 1 · menu 3 · ticket 2); the rail is
     hidden below lg, where the ticket tabs still live in the cart drawer. */
  .replace(
    'kI=h.jsxs("div",{className:"lg:grid lg:grid-cols-5 lg:gap-4",children:[',
    'kI=h.jsxs("div",{className:"ksh-reg-grid",children:[h.jsx("div",{className:"hidden lg:block ksh-col1",children:h.jsxs("div",{className:`rounded-2xl p-2 sticky top-20 ${_.panel}`,style:{maxHeight:"78vh",overflowY:"auto"},children:[h.jsx("div",{className:`text-xs font-semibold uppercase tracking-wide px-1.5 mb-2 ${_.faint}`,children:"Open bills"}),h.jsx("div",{className:"space-y-2",children:Ti.map(rj=>h.jsxs("button",{onClick:()=>rj.parked?$w(rj.id):ea(rj.id),className:`w-full text-left rounded-xl px-2.5 py-2 ${_e&&rj.id===_e.id&&!rj.parked?_.chipOn:_.chip}`,children:[h.jsx("div",{className:"text-xs font-semibold truncate",children:rj.table?rj.table:rj.otype==="delivery"?"🛵 "+rj.label:rj.label}),h.jsx("div",{className:"text-xs opacity-60 truncate",children:rj.parked?"Parked":rj.label})]},rj.id))})]})}),'
  )

  /* 38. Guest order status bar: the progress segments were a hardcoded
     bg-cyan-500 and the status label text-emerald-400 — a cyan/green bar on
     a red (or any non-cyan) store theme. Recolour both from the live theme
     accent (_.bar is the palette's hex) so the customer profile matches the
     outlet's colours. Find strings carry the old class names, so both are
     consumed and the patch is a no-op on re-runs. */
  .replace(
    'cb.map((sn,Iu)=>h.jsx("div",{className:`flex-1 h-1.5 rounded-full ${Iu<=ke?"bg-cyan-500":_.panel2}`},sn))',
    'cb.map((sn,Iu)=>h.jsx("div",{className:`flex-1 h-1.5 rounded-full ${Iu<=ke?"":_.panel2}`,style:Iu<=ke?{background:_.bar}:void 0},sn))'
  )
  .replace(
    'h.jsxs("span",{className:`text-xs font-medium ${ke>=2?"text-emerald-400":_.sub}`,children:[S6[ne.status]||ne.status',
    'h.jsxs("span",{className:`text-xs font-medium ${ke>=2?"":_.sub}`,style:ke>=2?{color:_.bar}:void 0,children:[S6[ne.status]||ne.status'
  )

  /* 36. Guest/member profile: time-of-day greeting instead of a flat "Hi" —
     "Good evening, Ahmed! 👋" by the device's local clock. */
  .replace(
    'children:["Hi, ",j.name.split(" ")[0]," 👋"]',
    'children:[(kh=>kh<5?"Good night":kh<12?"Good morning":kh<18?"Good afternoon":"Good evening")(new Date().getHours())+", "+j.name.split(" ")[0]+"! 👋"]'
  )

  /* 37. Guest pages follow the store's theme: the till mirrors its palette
     into settings (ktheme/ktdark, patches #30/31) and the guest boot payload
     carries settings — apply it so a watermelon-dark store shows guests a
     watermelon-dark profile instead of the default orange. React bails out
     on identical setState values, so re-applying on each 6s poll is free. */
  .replace(
    'f&&f1({boot:I,orders:j.orders||[]})',
    'f&&(f1({boot:I,orders:j.orders||[]}),(()=>{try{const kt=I&&I.settings;kt&&kt.ktheme&&KshSetTheme(kt.ktheme),kt&&kt.ktdark!==void 0&&a(kt.ktdark===!0)}catch{}})())'
  )

  /* 32. Guest/member profile: rewards card with tier progress + "your usuals"
     one-tap reorder chips, inserted above the Visits/Spent/On-account tiles.
     Uses only data already on the page: j = customer from /p/:slug/boot
     (points + last 25 orders), N = live menu products, Zv = existing tier fn
     (Bronze <100 / Silver <500 / Gold), $1 = add-to-cart. Chips only offer
     items that still exist on the menu with stock. Find is consumed: the
     children array no longer starts with the stats grid. */
  .replace(
    'children:[j&&h.jsxs("div",{className:"grid grid-cols-3 gap-2 mb-3"',
    'children:[j&&(()=>{const pt=j.points||0,tr=Zv(pt),nx=pt>=500?null:pt>=100?["Gold",500]:["Silver",100],pc=nx?Math.min(100,Math.round(pt/nx[1]*100)):100,fav=(()=>{const ctn={};return((j.orders||[]).forEach(o=>(o.items||[]).forEach(it=>{if(it.pid){ctn[it.pid]=ctn[it.pid]||{n:0,name:it.name,emoji:it.emoji||""};ctn[it.pid].n+=Number(it.qty)||1}})),Object.keys(ctn).map(pid=>({pid,...ctn[pid]})).filter(x=>N.some(p=>String(p.id)===String(x.pid)&&(p.stock||0)>0)).sort((a,b)=>b.n-a.n).slice(0,4))})();return h.jsxs("div",{className:`rounded-2xl p-4 mb-3 ${_.panel}`,children:[h.jsxs("div",{className:"flex items-center justify-between mb-1.5",children:[h.jsxs("span",{className:"text-sm font-bold",children:[tr==="Gold"?"🥇":tr==="Silver"?"🥈":"🥉"," ",tr," member"]}),h.jsxs("span",{className:`text-xs font-mono ${_.sub}`,children:[pt," pts"]})]}),h.jsx("div",{style:{height:"6px",borderRadius:"3px",background:"rgba(128,128,128,.18)",overflow:"hidden"},children:h.jsx("div",{style:{width:pc+"%",height:"100%",borderRadius:"3px",background:_.bar,transition:"width .4s"}})}),h.jsx("div",{className:`text-xs mt-1.5 ${_.faint}`,children:nx?nx[1]-pt+" pts to "+nx[0]+" — you earn points on every order":"Top tier — thanks for being a regular ⭐"}),fav.length?h.jsxs("div",{className:"mt-3",children:[h.jsx("div",{className:`text-xs font-semibold mb-1.5 ${_.sub}`,children:"Your usuals — tap to reorder"}),h.jsx("div",{className:"flex gap-1.5 flex-wrap",children:fav.map(x=>h.jsxs("button",{onClick:()=>{$1(x.pid,1);Q(`${x.name} added to your cart`)},className:`px-3 py-1.5 rounded-full text-xs font-semibold ${_.chip}`,children:[x.emoji?x.emoji+" ":"",x.name," +"]},x.pid))})]}):null]})})(),j&&h.jsxs("div",{className:"grid grid-cols-3 gap-2 mb-3"'
  )

  /* 15. Product form: add taxable to new-product initial state */
  .replace(
    'onClick:()=>qt({name:"",emoji:"",cat:"",price:"",cost:"",barcode:"",reorder:"10",stock:"0",unit:"pcs",img:"",vendor:!1})',
    'onClick:()=>qt({name:"",emoji:"",cat:"",price:"",cost:"",barcode:"",reorder:"10",stock:"0",unit:"pcs",img:"",vendor:!1,taxable:!0})'
  )

  /* 16. Product form: add taxable when opening an existing product for edit */
  .replace(
    'onClick:()=>qt({id:f.id,name:f.name,emoji:f.emoji,cat:f.cat,price:Y(f.price),cost:Y(f.cost),barcode:f.barcode||"",reorder:String(f.reorder),stock:String(f.stock),unit:f.unit||"pcs",img:f.img||"",vendor:!!f.vendor})',
    'onClick:()=>qt({id:f.id,name:f.name,emoji:f.emoji,cat:f.cat,price:Y(f.price),cost:Y(f.cost),barcode:f.barcode||"",reorder:String(f.reorder),stock:String(f.stock),unit:f.unit||"pcs",img:f.img||"",vendor:!!f.vendor,taxable:f.taxable!==false})'
  )

  /* 17. Product save (uI): persist taxable on both edit and create paths */
  .replace(
    'f.id?(d(I=>I.map(j=>j.id===f.id?{...j,name:f.name.trim(),emoji:f.emoji||"📦",cat:f.cat.trim()||"General",price:A,cost:N,barcode:f.barcode.trim(),reorder:Number(f.reorder)||0,unit:f.unit||"pcs",img:f.img||"",vendor:!!f.vendor}:j)),Q("Product updated")):(d(I=>[...I,{id:ct(),name:f.name.trim(),emoji:f.emoji||"📦",cat:f.cat.trim()||"General",price:A,cost:N,barcode:f.barcode.trim()||String(1e5+I.length+1),reorder:Number(f.reorder)||0,stock:Number(f.stock)||0,unit:f.unit||"pcs",img:f.img||"",vendor:!!f.vendor}]),Q("Product added"))',
    'f.id?(d(I=>I.map(j=>j.id===f.id?{...j,name:f.name.trim(),emoji:f.emoji||"📦",cat:f.cat.trim()||"General",price:A,cost:N,barcode:f.barcode.trim(),reorder:Number(f.reorder)||0,unit:f.unit||"pcs",img:f.img||"",vendor:!!f.vendor,taxable:f.taxable!==false}:j)),Q("Product updated")):(d(I=>[...I,{id:ct(),name:f.name.trim(),emoji:f.emoji||"📦",cat:f.cat.trim()||"General",price:A,cost:N,barcode:f.barcode.trim()||String(1e5+I.length+1),reorder:Number(f.reorder)||0,stock:Number(f.stock)||0,unit:f.unit||"pcs",img:f.img||"",vendor:!!f.vendor,taxable:f.taxable!==false}]),Q("Product added"))'
  )

  /* 18. Product form UI: add GST toggle button next to Vendor-supplied */
  .replace(
    'h.jsxs("button",{onClick:()=>qt({...Ge,vendor:!Ge.vendor}),className:`w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium text-left ${Ge.vendor?_.chipOn:_.panel2}`,children:[h.jsx(xv,{size:13})," Vendor-supplied — brought in ready, no kitchen prep",Ge.vendor?" ✓":""]})',
    'h.jsxs("div",{className:"flex gap-2",children:[h.jsxs("button",{onClick:()=>qt({...Ge,vendor:!Ge.vendor}),className:`flex-1 flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium text-left ${Ge.vendor?_.chipOn:_.panel2}`,children:[h.jsx(xv,{size:13})," Vendor-supplied",Ge.vendor?" ✓":""]}),h.jsxs("button",{onClick:()=>qt({...Ge,taxable:Ge.taxable===false}),className:`flex-1 flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium text-left ${Ge.taxable===false?_.panel2:_.chipOn}`,children:["GST",Ge.taxable===false?" exempt":" ✓"]}),]})'
  )

  /* 19. Customer "Add" button: include discPct in new-customer form state */
  .replace(
    'onClick:()=>tn({name:"",phone:"",email:"",address:"",company:"",notes:"",creditLimit:""})',
    'onClick:()=>tn({name:"",phone:"",email:"",address:"",company:"",notes:"",creditLimit:"",discPct:""})'
  )

  /* 20. Customer "full profile" button from checkout attach panel: include discPct */
  .replace(
    'tn({name:g1.trim(),phone:"",email:"",address:"",company:"",notes:"",creditLimit:"",attach:!0})',
    'tn({name:g1.trim(),phone:"",email:"",address:"",company:"",notes:"",creditLimit:"",discPct:"",attach:!0})'
  )

  /* 21. Customer edit: pre-populate discPct in the form when opening an existing customer */
  .replace(
    'onClick:()=>tn({id:xe.id,name:xe.name,phone:xe.phone||"",email:xe.email||"",address:xe.address||"",company:xe.company||"",notes:xe.notes||"",creditLimit:xe.creditLimit?Y(xe.creditLimit):""})',
    'onClick:()=>tn({id:xe.id,name:xe.name,phone:xe.phone||"",email:xe.email||"",address:xe.address||"",company:xe.company||"",notes:xe.notes||"",creditLimit:xe.creditLimit?Y(xe.creditLimit):"",discPct:xe.discPct?String(xe.discPct):""})'
  )

  /* 22. Customer save (pI): persist discPct (admin-only field; stored as number 0–100) */
  .replace(
    'const A=Math.round(parseFloat(f.creditLimit||"0")*100)||0,N={name:f.name.trim(),phone:(f.phone||"").trim(),email:(f.email||"").trim(),address:(f.address||"").trim(),company:(f.company||"").trim(),notes:(f.notes||"").trim(),creditLimit:A}',
    'const A=Math.round(parseFloat(f.creditLimit||"0")*100)||0,dp=Math.min(100,Math.max(0,parseFloat(f.discPct||"0")||0)),N={name:f.name.trim(),phone:(f.phone||"").trim(),email:(f.email||"").trim(),address:(f.address||"").trim(),company:(f.company||"").trim(),notes:(f.notes||"").trim(),creditLimit:A,discPct:dp}'
  )

  /* 23. Customer edit modal: add discount input after creditLimit (admin/manager only) */
  .replace(
    'h.jsxs("div",{children:[h.jsxs("div",{className:`text-xs mb-1 ${_.sub}`,children:["Credit limit (",ce.currency,") — 0 or blank disables the cap"]}),h.jsx("input",{value:Xt.creditLimit,inputMode:"decimal",onChange:f=>tn({...Xt,creditLimit:f.target.value.replace(/[^0-9.]/g,"")}),placeholder:"e.g. 5000.00",className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]}),h.jsx("button",{onClick:pI',
    'h.jsxs("div",{children:[h.jsxs("div",{className:`text-xs mb-1 ${_.sub}`,children:["Credit limit (",ce.currency,") — 0 or blank disables the cap"]}),h.jsx("input",{value:Xt.creditLimit,inputMode:"decimal",onChange:f=>tn({...Xt,creditLimit:f.target.value.replace(/[^0-9.]/g,"")}),placeholder:"e.g. 5000.00",className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]}),br("refund")&&h.jsxs("div",{children:[h.jsx("div",{className:`text-xs mb-1 ${_.sub}`,children:"Auto-discount on bills (%) — admin only"}),h.jsx("input",{value:Xt.discPct||"",inputMode:"decimal",onChange:f=>tn({...Xt,discPct:f.target.value.replace(/[^0-9.]/g,"")}),placeholder:"e.g. 10 for 10%",className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]}),h.jsx("button",{onClick:pI'
  )

  /* ── Order-settlement parity (guest/QR + POS orders settled from the Orders tab) ──
     Guest-profile orders were settled through B1/the settle modal with none of the
     billing features the register has: no item or bill discounts, no GST-exempt
     handling (guest lines had no taxable flag until the server started copying it),
     and no visible GST/service-charge breakdown. Patches 27-29 give that path the
     exact same math ($n), the same discount controls (gated to admin/manager via
     br("refund"), same as the register), and the same on-screen breakdown, so a
     settled guest order produces a sale — and therefore a receipt — identical in
     format to a cashier-created bill. */

  /* 27a. B1 head: enrich legacy lines with taxable (looked up from products by pid),
     resolve the effective bill discount (manual from the modal via f.KshBD, else the
     customer's auto-discount — skipped for paid-online orders whose amount is already
     fixed), and pass it into $n. Find is consumed: $n(f.items,...) no longer exists. */
  .replace(
    'Q("Open a shift before settling orders","warn");const N=$n(f.items,f.fee||0);if(A==="Credit")',
    'Q("Open a shift before settling orders","warn");const Ki=(f.items||[]).map(W=>W.taxable!==void 0?W:{...W,taxable:((c.find(he=>String(he.id)===String(W.pid))||{}).taxable)!==!1}),Kc=f.customerId?p.find(W=>W.id===f.customerId):null,Kb=(f.KshBD||0)>0?f.KshBD:f.paidOnline?0:Kc&&Kc.discPct||0,N=$n(Ki,f.fee||0,Kb);if(A==="Credit")'
  )
  /* 27b. Sale lines come from the enriched/discount-edited items */
  .replace(
    't:Date.now(),lines:f.items,...N',
    't:Date.now(),lines:Ki,...N'
  )
  /* 27c. Stock deduction uses the same enriched lines */
  .replace(
    'De.id};if(sd(f.items),f.customerId)',
    'De.id};if(sd(Ki),f.customerId)'
  )
  /* 27d. Persist edited items + final settled total onto the order itself, so the
     guest's order history (server normalizeOrder honours a stored total) shows the
     exact amount that was billed, discounts included. */
  .replace(
    'x(j=>j.map(F=>F.id===f.id?{...F,status:"completed",call:!1,saleId:I.id,settledWith:A}:F))',
    'x(j=>j.map(F=>F.id===f.id?{...F,status:"completed",call:!1,saleId:I.id,settledWith:A,items:Ki,total:N.total}:F))'
  )

  /* 28. Settle modal: itemised rows with per-line discount buttons (0→5→10→20%,
     same cycle as the register's GT, gated to admin/manager). Edits live on the
     modal's own Rn state so B1 receives them on settle. */
  .replace(
    'h.jsx("div",{className:`text-xs mb-3 ${_.sub}`,children:Rn.items.map(f=>`${f.qty}× ${f.name}`).join(" · ")})',
    'h.jsx("div",{className:`text-xs mb-3 space-y-1 ${_.sub}`,children:Rn.items.map((f,A)=>h.jsxs("div",{className:"flex items-center gap-2",children:[h.jsxs("span",{className:"flex-1",children:[f.qty,"× ",f.name]}),br("refund")&&h.jsx("button",{onClick:()=>As({...Rn,items:Rn.items.map((N,I)=>{if(I!==A)return N;const j=[0,5,10,20];return{...N,discPct:j[(j.indexOf(N.discPct||0)+1)%j.length]}})}),className:`text-xs px-2 py-0.5 rounded-lg ${f.discPct?"bg-amber-500/15 text-amber-500":_.chip}`,children:f.discPct?`-${f.discPct}%`:"disc"}),h.jsx("span",{className:"font-mono tabular-nums",children:Y(Un(f))})]},A))})'
  )

  /* 29. Settle modal: replace the bare "Amount due" figure with the register's full
     breakdown (subtotal / bill discount / GST / service charge / total) plus the
     bill-discount cycle button (0→5→10→15→20→25%, admin/manager only). Discounts
     are applied to the pre-tax amount: $n discounts the subtotal first, then
     computes GST on the discounted taxable base. Find is consumed:
     ue($n(Rn.items,...)) no longer exists after patching. */
  .replace(
    'h.jsxs("div",{className:"text-center my-4",children:[h.jsx("div",{className:`text-xs ${_.sub}`,children:"Amount due"}),h.jsx("div",{className:"font-mono tabular-nums text-3xl font-bold",children:ue($n(Rn.items,Rn.fee||0).total)})]})',
    '(()=>{const Kc=Rn.customerId?p.find(W=>W.id===Rn.customerId):null,Kb=(Rn.KshBD||0)>0?Rn.KshBD:Rn.paidOnline?0:Kc&&Kc.discPct||0,Kq=$n((Rn.items||[]).map(W=>W.taxable!==void 0?W:{...W,taxable:((c.find(he=>String(he.id)===String(W.pid))||{}).taxable)!==!1}),Rn.fee||0,Kb);return h.jsxs("div",{className:"my-4",children:[br("refund")&&!Rn.paidOnline&&h.jsx("button",{onClick:()=>{const j=[0,5,10,15,20,25];As({...Rn,KshBD:j[(j.indexOf(Rn.KshBD||0)+1)%j.length]})},className:`rounded-xl px-3 py-1 text-xs mb-2 ${(Rn.KshBD||0)>0?"bg-amber-500/15 text-amber-500":_.chip}`,children:(Rn.KshBD||0)>0?"Bill disc "+Rn.KshBD+"%":"+ Bill disc"}),h.jsxs("div",{className:`flex justify-between text-xs mt-1 ${_.sub}`,children:[h.jsx("span",{children:"Subtotal"}),h.jsx("span",{className:"font-mono tabular-nums",children:Y(Kq.subtotal)})]}),(Kq.billDisc||0)>0&&h.jsxs("div",{className:`flex justify-between text-xs mt-1 ${_.sub}`,children:[h.jsxs("span",{children:["Discount ",Kq.billDiscPct,"%"]}),h.jsx("span",{className:"font-mono tabular-nums text-amber-500",children:"-"+Y(Kq.billDisc)})]}),h.jsxs("div",{className:`flex justify-between text-xs mt-1 ${_.sub}`,children:[h.jsxs("span",{children:["GST ",(ce.gstBp||0)/100,"%"]}),h.jsx("span",{className:"font-mono tabular-nums",children:Y(Kq.gst)})]}),(Kq.svcCharge||0)>0&&h.jsxs("div",{className:`flex justify-between text-xs mt-1 ${_.sub}`,children:[h.jsxs("span",{children:["Svc charge ",(ce.svcChargeBp||0)/100,"%"]}),h.jsx("span",{className:"font-mono tabular-nums",children:Y(Kq.svcCharge)})]}),h.jsxs("div",{className:"text-center mt-3",children:[h.jsx("div",{className:`text-xs ${_.sub}`,children:"Amount due"}),h.jsx("div",{className:"font-mono tabular-nums text-3xl font-bold",children:ue(Kq.total)})]})]})})()'
  )

  /* 91. Guest theme switcher on the customer portal. The store's chosen palette
     already flows to the portal (from settings.ktheme/ktdark, applied in the
     guest boot effect below), but the guest had no way to change it. This adds
     a 🎨 button to the guest header that opens a small popover of the five
     available themes (Orange/Green Apple/Watermelon/Mango/Strawberry) plus a
     light/dark toggle. Picking a theme calls the app's own KshSetTheme / dark
     setter (`a`) — the palette `_` recomputes and the root `kt-*` class swaps —
     and persists the guest's choice in localStorage (ksh-gtheme / ksh-gdark),
     independent of the store default. Popover open state rides on fe.themeOpen
     (Dn spread, same pattern as fe.sheet/fe.cexp) so no new React hook is
     needed. Idempotent: the find is the bare header action group before the
     Waiter button; the replacement wedges the 🎨 button + popover in front of
     it, so the exact `children:[(fe.table||fe.slug)` opener no longer appears. */
  .replace(
    'h.jsxs("div",{className:"ml-auto flex items-center gap-1.5",children:[(fe.table||fe.slug)&&h.jsxs("button",{onClick:ub,',
    'h.jsxs("div",{className:"ml-auto flex items-center gap-1.5",children:[h.jsx("button",{onClick:()=>Dn(N=>({...N,themeOpen:!(N&&N.themeOpen)})),className:`p-1.5 rounded-full ${_.btn}`,title:"Theme","aria-label":"Change theme",children:h.jsx("span",{style:{fontSize:"14px",lineHeight:1},children:"🎨"})}),fe.themeOpen&&h.jsxs("div",{style:{position:"fixed",top:"56px",right:"10px",zIndex:60,minWidth:"172px"},className:`p-3 rounded-2xl shadow-xl ${_.modal}`,children:[h.jsx("div",{className:`text-[11px] font-semibold uppercase tracking-wide mb-2 ${_.sub}`,children:"Theme"}),h.jsx("div",{style:{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:"8px"},children:[["orange","#C1502D"],["green","#4E8A3A"],["watermelon","#DA3B4B"],["mango","#E19A12"],["strawberry","#D8437A"]].map(([tn,col])=>h.jsx("button",{onClick:()=>{KshSetTheme(tn);try{localStorage.setItem("ksh-gtheme",tn)}catch(e){}},title:tn,style:{height:"30px",borderRadius:"9px",background:col,cursor:"pointer",border:"2px solid "+(KshTheme===tn?"#fff":"transparent"),boxShadow:KshTheme===tn?"0 0 0 2px "+col:"inset 0 0 0 1px rgba(0,0,0,.14)"}},tn))}),h.jsx("button",{onClick:()=>{try{localStorage.setItem("ksh-gdark",i?"0":"1")}catch(e){}a(v=>!v)},className:`mt-2.5 w-full text-xs font-medium py-1.5 rounded-lg ${_.btn}`,children:i?"☀️  Light mode":"🌙  Dark mode"})]}),(fe.table||fe.slug)&&h.jsxs("button",{onClick:ub,'
  )

  /* 92. Let the guest theme choice (patch #91) survive reloads and win over the
     store default. The guest boot effect used to apply only the store settings;
     now it reads the guest's saved ksh-gtheme/ksh-gdark first and falls back to
     the store palette when the guest hasn't overridden. Idempotent: the find is
     the original store-only apply, which the replacement no longer contains. */
  .replace(
    'const kt=I&&I.settings;kt&&kt.ktheme&&KshSetTheme(kt.ktheme),kt&&kt.ktdark!==void 0&&a(kt.ktdark===!0)',
    'const kt=I&&I.settings;var _gt=null,_gd=null;try{_gt=localStorage.getItem("ksh-gtheme");_gd=localStorage.getItem("ksh-gdark")}catch(e){}var _th=_gt||(kt&&kt.ktheme);_th&&KshSetTheme(_th);if(_gd!=null)a(_gd==="1");else if(kt&&kt.ktdark!==void 0)a(kt.ktdark===!0)'
  )
);

/* Force every installed PWA onto the current build. */
patchFile(swPath, (sw) => sw.replace(/kashikeyo-2\.[0-9]\.\d+/g, "kashikeyo-2.9.59"));

if (!process.env.PATCH_ONLY) require("./index.js");
