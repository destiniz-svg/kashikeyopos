/* Startup patcher for the prebuilt web bundle (web/dist).
   Rewrites the guest checkout + waiter call inside the minified index.html so
   guest orders always go through the cloud API, injects the offline write
   bridge and guest-profile guard, then boots the server.
   Every patch is idempotent: if the file already contains the fixed code the
   regexes either don't match or replace with identical text (no write).
   Run with PATCH_ONLY=1 to apply the patches without starting the server
   (used to bake the fixes into the committed dist). */
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

/* Guest checkout: post to the cloud, preserve store/table, and only override
   the original portal's order type when the added Dine in mode is selected. */
const checkout =
  'rI=async f=>{if(!fe.cart.length)return Q("Cart is empty","warn");const Mo=window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.getOrderMode?window.KashikeyoGuestProfile.getOrderMode():"",A=Mo==="dinein"?"dinein":fe.gtype==="delivery"?"delivery":fe.gtype==="pickup"?"takeaway":"dinein";if(A==="delivery"&&!Ou&&M.length)return Q("Pick your delivery zone first","warn");const St=fe.slug||(typeof Ie!=="undefined"&&Ie&&Ie.slug)||"";if(!St)return Q("Not connected to the cloud caf\u00e9 \u2014 open the shared customer link or pair Cloud Sync first","warn");const Pa=new URLSearchParams(location.search),Sd=fe.storeId||Pa.get("storeId")||Pa.get("store")||Pa.get("st")||localStorage.getItem("kashikeyo.storeId")||"main";let Tb=fe.table||Pa.get("t")||(Mo==="dinein"&&window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.getSelectedTable?window.KashikeyoGuestProfile.getSelectedTable():"")||"",Gt=Tb&&A!=="delivery"?"table":fe.gtype;if(Mo==="dinein"&&!Tb&&window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.pickTable){Tb=await window.KashikeyoGuestProfile.pickTable();Gt=Tb?"table":fe.gtype;if(!Tb)return Q("Select a table for dine in","warn")}try{window.KashikeyoOffline&&window.KashikeyoOffline.setStoreId&&window.KashikeyoOffline.setStoreId(Sd)}catch{}const N={items:fe.cart.map(W=>({...W,pid:W.pid||W.id||W.productId,qty:W.qty||1})),table:Tb||(A==="delivery"?"Delivery":"Pickup"),custId:fe.custId||null,gtype:Gt,zoneId:fe.zoneId||null,note:(fe.note||"").trim()||A==="delivery"&&ia&&ia.address||"",payOnline:f,storeId:Sd};try{const I=await fetch(`/p/${St}/order?storeId=${encodeURIComponent(Sd)}`,{method:"POST",headers:{"Content-Type":"application/json","X-Store-Id":Sd},body:JSON.stringify(N)}),j=await I.json().catch(()=>({}));if(!I.ok)return Q(j.error||"Couldn\'t place the order — please try again","warn");const F=j.order||{};try{window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.refreshOrders&&window.KashikeyoGuestProfile.refreshOrders()}catch{}x(W=>W.some(he=>he.id===F.id)?W:[...W,F]),f1(W=>W?{...W,orders:[F,...(W.orders||[]).filter(he=>he.id!==F.id)]}:W),Dn(W=>({...W,cart:[],tab:"orders",note:""})),Q(`New order ${F.no||"sent"} · ${F.customerName?F.customerName+(F.table?" @ "+F.table:""):F.table||N.table}${f?" · paid online":""}`)}catch{Q("Can\'t reach the café — check your connection and try again","warn")}},Hw=(f,A)=>';
const call =
  'nI=async()=>{try{const St=fe&&fe.slug||(typeof Ie!=="undefined"&&Ie&&Ie.slug)||"";if(St){const Pa=new URLSearchParams(location.search),Sd=fe.storeId||Pa.get("storeId")||Pa.get("store")||Pa.get("st")||localStorage.getItem("kashikeyo.storeId")||"main",Dt=window.KashikeyoGuestProfile&&window.KashikeyoGuestProfile.getSelectedTable?window.KashikeyoGuestProfile.getSelectedTable():"",Tb=fe.table||Pa.get("t")||Dt||"";try{window.KashikeyoOffline&&window.KashikeyoOffline.setStoreId&&window.KashikeyoOffline.setStoreId(Sd)}catch{}await fetch(`/p/${St}/call?storeId=${encodeURIComponent(Sd)}`,{method:"POST",headers:{"Content-Type":"application/json","X-Store-Id":Sd},body:JSON.stringify({table:Tb||fe.table,custId:fe.custId||null,storeId:Sd})})}}catch{}Hw(fe.table,ia?ia.name:null)}';

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

function injectScript(html, src) {
  if (html.includes(src)) return html;
  const tag = `<script src="/${src}"></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  return tag + html;
}

function injectRuntimeGuards(html) {
  return ["offline-bridge.js", "guest-profile-guard.js"].reduce((out, src) => injectScript(out, src), html);
}

patchFile(indexPath, (html) => injectRuntimeGuards(html)
  .replace(/rI=f=>\{if\(!R1\.length\)return;const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
  .replace(/rI=async f=>\{if\(!R1\.length\)return;const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
  .replace(/rI=async f=>\{if\(!fe\.cart\.length\)return Q\("Cart is empty","warn"\);const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
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
);

/* Force every installed PWA onto the current build. */
patchFile(swPath, (sw) => sw.replace(/kashikeyo-2\.[0-9]\.\d+/g, "kashikeyo-2.9.10"));

if (!process.env.PATCH_ONLY) require("./index.js");
