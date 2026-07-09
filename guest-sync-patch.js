const fs = require("fs");
const path = require("path");

const webDir = path.join(__dirname, "web", "dist");
const indexPath = path.join(webDir, "index.html");
const swPath = path.join(webDir, "sw.js");
const serverPath = path.join(__dirname, "index.js");

function patchFile(filePath, patcher) {
  if (!fs.existsSync(filePath)) return;
  const before = fs.readFileSync(filePath, "utf8");
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(filePath, after, "utf8");
}

patchFile(indexPath, (html) => {
  const checkout =
    'rI=async f=>{if(!fe.cart.length)return Q("Cart is empty","warn");const A=fe.gtype==="delivery"?"delivery":fe.gtype==="pickup"?"takeaway":"dinein";if(A==="delivery"&&!Ou&&M.length)return Q("Pick your delivery zone first","warn");const N={items:fe.cart.map(W=>({pid:W.pid||W.id||W.productId,qty:W.qty||1,...W})),table:fe.table||(A==="delivery"?"Delivery":"Pickup"),custId:fe.custId||null,gtype:fe.gtype,zoneId:fe.zoneId||null,note:(fe.note||"").trim()||A==="delivery"&&ia&&ia.address||"",payOnline:f};try{const I=await fetch(`/p/${fe.slug}/order`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(N)}),j=await I.json();if(!I.ok)throw new Error(j.error||"Order failed");const F=j.order||{};x(W=>W.some(he=>he.id===F.id)?W:[...W,F]),f1(W=>W?{...W,orders:[F,...(W.orders||[]).filter(he=>he.id!==F.id)]}:W),Dn(W=>({...W,cart:[],tab:"orders",note:""})),Q(`New order ${F.no||"sent"} · ${F.customerName?F.customerName+(F.table?" @ "+F.table:""):F.table||N.table}${f?" · paid online":""}`)}catch(I){Q(I.message||"Could not send order","warn")}},Hw=(f,A)=>';
  const call =
    'nI=async()=>{try{if(fe&&fe.slug){await fetch(`/p/${fe.slug}/call`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({table:fe.table,custId:fe.custId||null})})}}catch{}Hw(fe.table,ia?ia.name:null)}';

  return html
    .replace(
      /rI=f=>\{if\(!R1\.length\)return;const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/,
      checkout
    )
    .replace(
      /rI=async f=>\{if\(!R1\.length\)return;const A=fe\.gtype==="delivery"[\s\S]*?\},Hw=\(f,A\)=>/,
      checkout
    )
    .replace("nI=()=>Hw(fe.table,ia?ia.name:null)", call);
});

patchFile(serverPath, (server) => server.replace(
  `  const lines = items.map((ci) => {
    const p = products.find((x) => x.id === ci.pid);
    return p ? { pid: p.id, name: p.name, emoji: p.emoji, price: p.price, cost: p.cost || 0,
                 unit: p.unit || "pcs", vendor: !!p.vendor, qty: Math.max(1, Math.min(99, Number(ci.qty) || 1)), discPct: 0 } : null;
  }).filter(Boolean);`,
  `  const lines = items.map((ci) => {
    const pid = String(ci.pid || ci.id || ci.productId || "");
    const p = products.find((x) => String(x.id) === pid);
    const src = p || ci;
    if (!src || (!pid && !src.name)) return null;
    return { pid: p ? p.id : pid || String(src.id || uid()), name: src.name || "Item", emoji: src.emoji || "",
             price: Number(src.price) || 0, cost: Number(src.cost) || 0, unit: src.unit || "pcs",
             vendor: !!src.vendor, qty: Math.max(1, Math.min(99, Number(ci.qty) || 1)), discPct: Number(src.discPct) || 0 };
  }).filter(Boolean);`
));

patchFile(swPath, (sw) => sw.replace("kashikeyo-2.8.0", "kashikeyo-2.8.1"));

require("./index.js");
