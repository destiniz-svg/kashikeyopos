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
  orange: {
    l: { bg:"#F3ECE1", text:"#2A241E", sub:"#8A8074", faint:"#B7AE9F", primary:"#C1502D", primaryHover:"#AA4526", accent:"#C1502D",
         panel:"rgba(255,255,255,.86)", panel2:"rgba(236,227,211,.72)", border:"#E8DFCF", input:"#FFFFFF", inputBorder:"#E8DFCF", ph:"#B7AE9F",
         chip:"rgba(251,247,239,.85)", chipText:"#4A4238", nav:"rgba(243,236,225,.72)", navOff:"#A79E8F",
         modal:"rgba(255,255,255,.82)", btn:"#F1E8D8", btnText:"#4A4238", btnHover:"#E8DCC5", accentBd:"rgba(193,80,45,.4)",
         axis:"#B7AE9F", bar:"#C1502D", grid:"#EFE6D6", tip:"#FFFFFF" },
    d: { bg:"#241A14", text:"#EDE6DA", sub:"#A79E8F", faint:"#7C7466", primary:"#E0794F", primaryHover:"#E88A62", accent:"#E0794F",
         panel:"rgba(46,38,30,.72)", panel2:"rgba(58,48,38,.6)", border:"#3A3025", input:"#2A2118", inputBorder:"#3A3025", ph:"#7C7466",
         chip:"rgba(58,48,38,.62)", chipText:"#D8CFC0", nav:"rgba(30,22,16,.72)", navOff:"#7C7466",
         modal:"rgba(40,32,24,.82)", btn:"#3A3025", btnText:"#E7DECF", btnHover:"#483C2C", accentBd:"rgba(224,121,79,.5)",
         axis:"#7C7466", bar:"#E0794F", grid:"#3A3025", tip:"#2A2018" } },
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
function appGrad(c) {
  return `radial-gradient(circle at 8% 4%, ${hexA(c.primary, 0.12)}, transparent 32%),radial-gradient(circle at 94% 2%, ${hexA(c.accent, 0.12)}, transparent 28%),radial-gradient(circle at 72% 84%, ${hexA(c.primary, 0.07)}, transparent 34%),${c.bg}`;
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
.ksh-panel{background:var(--k-panel);border:1px solid var(--k-border);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.ksh-panel2{background:var(--k-panel2)}
.ksh-border{border-color:var(--k-border)}
.ksh-sub{color:var(--k-sub)}
.ksh-faint{color:var(--k-faint)}
.ksh-input{background:var(--k-input);border:1px solid var(--k-input-border);color:var(--k-text)}
.ksh-input::placeholder{color:var(--k-ph)}
.ksh-chip{background:var(--k-chip);color:var(--k-chip-text)}
.ksh-chipOn{background:var(--k-primary);color:#fff;border:1px solid var(--k-primary)}
.ksh-tile{background:var(--k-panel);border:1px solid var(--k-border);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.ksh-tile:hover{border-color:var(--k-primary)}
.ksh-navOn{color:var(--k-primary)}
.ksh-navOff{color:var(--k-navoff)}
.ksh-modal{background:var(--k-modal);border:1px solid var(--k-border);-webkit-backdrop-filter:blur(20px) saturate(1.4);backdrop-filter:blur(20px) saturate(1.4)}
.ksh-btn{background:var(--k-btn);color:var(--k-btn-text)}
.ksh-btn:hover{background:var(--k-btn-h)}
.ksh-primary{background:var(--k-primary);color:#fff}
.ksh-primary:hover{background:var(--k-primary-h)}
.ksh-accent{color:var(--k-accent)}
.ksh-accentBd{border-color:var(--k-accentbd)}
`.replace(/\n/g, "");
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
    alert:function(){ tone(392,0.16,0,'triangle',0.16); tone(392,0.16,0.2,'triangle',0.16); }
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

function injectCss(html, css) {
  if (html.includes(css)) return html;
  return html.replace("</style>", css + "</style>");
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

patchFile(indexPath, (html) => {
  html = injectScript(html, "offline-bridge.js");
  html = injectCss(html, lovableCss);
  html = injectCss(html, themeVarsCss + themeUtilCss);
  html = injectInline(html, "ksh-kpal", kpalJs);
  html = injectInline(html, "ksh-snd", sndJs);
  html = injectInline(html, "ksh-chart", chartJs);
  html = injectCss(html, '.ksch-tab{transition:background .15s,color .15s;color:var(--k-sub,#8A8074)}.ksch-tab[data-on="1"]{background:var(--k-primary,#C1502D);color:#fff}');
  return html
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

  /* 59. The member's "On account" balance card lit up amber (bg + label +
     amount) when a balance was owed — again off every non-amber theme.
     Drive the highlight from the accent instead (_.bar, +"1a" ≈ the old /10
     card tint); the zero-balance state keeps its neutral _.panel/_.faint. */
  .replace(
    '`rounded-xl p-3 ${(j.balance||0)>0?"bg-amber-500/10":_.panel}`,children:[h.jsx("div",{className:`text-xs ${(j.balance||0)>0?"text-amber-500":_.faint}`,children:"On account"}),h.jsx("div",{className:`font-mono text-sm font-bold mt-0.5 ${(j.balance||0)>0?"text-amber-500":""}`,children:Y(j.balance||0)})',
    '`rounded-xl p-3 ${(j.balance||0)>0?"":_.panel}`,style:(j.balance||0)>0?{background:_.bar+"1a"}:void 0,children:[h.jsx("div",{className:`text-xs ${(j.balance||0)>0?"":_.faint}`,style:(j.balance||0)>0?{color:_.bar}:void 0,children:"On account"}),h.jsx("div",{className:"font-mono text-sm font-bold mt-0.5",style:(j.balance||0)>0?{color:_.bar}:void 0,children:Y(j.balance||0)})'
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
);

/* Force every installed PWA onto the current build. */
patchFile(swPath, (sw) => sw.replace(/kashikeyo-2\.[0-9]\.\d+/g, "kashikeyo-2.9.32"));

if (!process.env.PATCH_ONLY) require("./index.js");
