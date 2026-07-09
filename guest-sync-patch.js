/* Startup patcher for the prebuilt web bundle (web/dist).
   Rewrites the guest checkout + waiter call inside the minified index.html so
   guest orders always go through the cloud API, injects the offline write
   bridge, then boots the server.
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

/* Guest checkout: post to the cloud, show the server's human-readable error
   verbatim, and never surface raw browser exceptions (e.g. WebKit's
   "The string did not match the expected pattern.") in the toast. */
const checkout =
  'rI=async f=>{if(!fe.cart.length)return Q("Cart is empty","warn");const A=fe.gtype==="delivery"?"delivery":fe.gtype==="pickup"?"takeaway":"dinein";if(A==="delivery"&&!Ou&&M.length)return Q("Pick your delivery zone first","warn");const St=fe.slug||(typeof Ie!=="undefined"&&Ie&&Ie.slug)||"";if(!St)return Q("Not connected to the cloud caf\u00e9 \u2014 open the shared customer link or pair Cloud Sync first","warn");const N={items:fe.cart.map(W=>({...W,pid:W.pid||W.id||W.productId,qty:W.qty||1})),table:fe.table||(A==="delivery"?"Delivery":"Pickup"),custId:fe.custId||null,gtype:fe.gtype,zoneId:fe.zoneId||null,note:(fe.note||"").trim()||A==="delivery"&&ia&&ia.address||"",payOnline:f};try{const I=await fetch(`/p/${St}/order`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(N)}),j=await I.json().catch(()=>({}));if(!I.ok)return Q(j.error||"Couldn\'t place the order — please try again","warn");const F=j.order||{};x(W=>W.some(he=>he.id===F.id)?W:[...W,F]),f1(W=>W?{...W,orders:[F,...(W.orders||[]).filter(he=>he.id!==F.id)]}:W),Dn(W=>({...W,cart:[],tab:"orders",note:""})),Q(`New order ${F.no||"sent"} · ${F.customerName?F.customerName+(F.table?" @ "+F.table:""):F.table||N.table}${f?" · paid online":""}`)}catch{Q("Can\'t reach the café — check your connection and try again","warn")}},Hw=(f,A)=>';
const call =
  'nI=async()=>{try{const St=fe&&fe.slug||(typeof Ie!=="undefined"&&Ie&&Ie.slug)||"";if(St){await fetch(`/p/${St}/call`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({table:fe.table,custId:fe.custId||null})})}}catch{}Hw(fe.table,ia?ia.name:null)}';

function injectOfflineBridge(html) {
  if (html.includes("offline-bridge.js")) return html;
  const tag = '<script src="/offline-bridge.js"></script>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  return tag + html;
}

patchFile(indexPath, (html) => injectOfflineBridge(html)
  .replace(/rI=f=>\{if\(!R1\.length\)return;const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
  .replace(/rI=async f=>\{if\(!R1\.length\)return;const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
  .replace(/rI=async f=>\{if\(!fe\.cart\.length\)return Q\("Cart is empty","warn"\);const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/, checkout)
  .replace("nI=()=>Hw(fe.table,ia?ia.name:null)", call)
  .replace(/nI=async\(\)=>\{try\{[\s\S]*?Hw\(fe\.table,ia\?ia\.name:null\)\}/, call)
);

/* Force every installed PWA onto the current build. */
patchFile(swPath, (sw) => sw.replace(/kashikeyo-2\.[0-9]\.\d+/g, "kashikeyo-2.9.2"));

if (!process.env.PATCH_ONLY) require("./index.js");
