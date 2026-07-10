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
  if (html.includes(marker)) return html;
  const tag = `<script>/*${marker}*/${js}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  return tag + html;
}

patchFile(indexPath, (html) => {
  html = injectScript(html, "offline-bridge.js");
  html = injectCss(html, lovableCss);
  html = injectCss(html, themeVarsCss + themeUtilCss);
  html = injectInline(html, "ksh-kpal", kpalJs);
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
  /* 1. Settings default object: add loyaltyBp and svcChargeBp */
  .replace(
    'gstBp:800,currency:"MVR",footer:',
    'gstBp:800,loyaltyBp:10000,svcChargeBp:0,currency:"MVR",footer:'
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

  /* 9. Gate per-item discount button to admin/manager (cashier has no "refund" perm) */
  .replace(
    'h.jsxs("button",{onClick:()=>GT(A),className:`flex items-center gap-0.5 text-xs px-2 py-1 rounded-lg ${f.discPct?"bg-amber-500/15 text-amber-500":_.chip}`,children:[h.jsx(vk,{size:11}),f.discPct?`-${f.discPct}%`:"disc"]})',
    'br("refund")&&h.jsxs("button",{onClick:()=>GT(A),className:`flex items-center gap-0.5 text-xs px-2 py-1 rounded-lg ${f.discPct?"bg-amber-500/15 text-amber-500":_.chip}`,children:[h.jsx(vk,{size:11}),f.discPct?`-${f.discPct}%`:"disc"]})'
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
     Find string anchors on the currency input's unique toUpperCase().slice(0,4) call so that
     after first application that exact sequence no longer precedes "Changes apply…" and the
     patch is a no-op on every subsequent server boot (server runs node guest-sync-patch.js). */
  .replace(
    'toUpperCase().slice(0,4)})),className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]})]}),h.jsx("div",{className:`text-xs px-1 ${_.faint}`,children:"Changes apply immediately and save automatically — receipts, reports, and the tax engine all follow these settings."})',
    'toUpperCase().slice(0,4)})),className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]})]}),h.jsxs("div",{className:"grid grid-cols-2 gap-3 mt-2",children:[h.jsxs("div",{children:[h.jsx("div",{className:`text-xs mb-1 ${_.sub}`,children:"Service charge (%)"}),h.jsx("input",{value:String((ce.svcChargeBp||0)/100),inputMode:"decimal",onChange:f=>{const A=parseFloat(f.target.value);xs(N=>({...N,svcChargeBp:isNaN(A)?0:Math.round(A*100)}))},className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]}),h.jsxs("div",{children:[h.jsx("div",{className:`text-xs mb-1 ${_.sub}`,children:"Loyalty (MVR/$ per point)"}),h.jsx("input",{value:String((ce.loyaltyBp||10000)/100),inputMode:"decimal",onChange:f=>{const A=parseFloat(f.target.value);xs(N=>({...N,loyaltyBp:isNaN(A)||A<=0?10000:Math.round(A*100)}))},className:`w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none ${_.input}`})]})]}),h.jsx("div",{className:`text-xs px-1 ${_.faint}`,children:"Changes apply immediately and save automatically — receipts, reports, and the tax engine all follow these settings."})'
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
);

/* Force every installed PWA onto the current build. */
patchFile(swPath, (sw) => sw.replace(/kashikeyo-2\.[0-9]\.\d+/g, "kashikeyo-2.9.14"));

if (!process.env.PATCH_ONLY) require("./index.js");
