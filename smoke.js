/* End-to-end smoke test:
   till pairing -> catalog push -> guest ordering -> KDS flow -> waiter call -> multi-store isolation */
const B = process.env.BASE || "http://127.0.0.1:4000";
const uniq = Date.now().toString(36);
const j = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  return body;
};

(async () => {
  const email = `abdulla+${uniq}@steva.mv`;
  const reg = await fetch(B + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "test1234", storeName: "Island Zone Cafe" }),
  }).then(j);
  console.log("1 register:", reg.slug, reg.register, "store", reg.storeId);

  const H = { "Content-Type": "application/json", Authorization: "Bearer " + reg.token };
  const op = { opId: "op1-" + uniq, storeId: "main", puts: [
    { kind: "settings", id: "settings", data: { id: "settings", storeName: "Island Zone Cafe", gstBp: 800, currency: "MVR" } },
    { kind: "products", id: "p1", data: { id: "p1", name: "Espresso", emoji: "coffee", cat: "Coffee", price: 3500, cost: 900, stock: 50, unit: "cup" } },
    { kind: "zones", id: "z1", data: { id: "z1", storeId: "main", name: "Male", fee: 2000, eta: "30-45 min" } },
    { kind: "tables", id: "tb1", data: { id: "tb1", storeId: "main", name: "T1" } },
    { kind: "customers", id: "c1", data: { id: "c1", name: "Aisha Naeem", points: 340, balance: 0, address: "H. Orchid Lodge" } },
  ] };

  let r = await fetch(B + "/api/ops", { method: "POST", headers: H, body: JSON.stringify({ ops: [op] }) }).then(j);
  console.log("2 push catalog rowver:", r.rowver);

  r = await fetch(B + "/api/ops", { method: "POST", headers: H, body: JSON.stringify({ ops: [op] }) }).then(j);
  console.log("3 idempotent replay skipped:", r.rowver === 0 ? "yes" : "NO");

  const reg2 = await fetch(B + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "test1234", storeId: "main" }),
  }).then(j);
  const pull = await fetch(B + "/api/pull?since=0&storeId=main", { headers: { Authorization: "Bearer " + reg2.token } }).then(j);
  console.log("4 second register", reg2.register, "pulled", pull.entities.length, "main entities");

  const boot = await fetch(`${B}/p/${reg.slug}/boot?c=c1&storeId=main`).then(j);
  console.log("5 guest boot:", boot.settings.storeName, "-", boot.products.length, "products - cust:", boot.cust.name, "- visits:", boot.cust.visits);

  const ord = await fetch(`${B}/p/${reg.slug}/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ pid: "p1", qty: 2 }], table: "T1", custId: "c1", gtype: "table", storeId: "main" }),
  }).then(j);
  console.log("6 guest order:", ord.order.no, "by", ord.order.customerName, "@", ord.order.table, "store", ord.order.storeId);

  const pull2 = await fetch(B + "/api/pull?since=" + pull.rowver + "&storeId=main", { headers: H }).then(j);
  const got = pull2.entities.find((e) => e.kind === "orders" && e.data.id === ord.order.id);
  if (!got) throw new Error("main POS did not pull guest order");
  console.log("7 till pulled order:", got.data.no, "-", got.data.status);

  await fetch(B + "/api/ops", { method: "POST", headers: H, body: JSON.stringify({ ops: [
    { opId: "op-status-" + uniq, storeId: "main", puts: [{ kind: "orders", id: got.id, data: { ...got.data, status: "preparing" } }] },
  ] }) }).then(j);
  const gv = await fetch(`${B}/p/${reg.slug}/orders?c=c1&storeId=main`).then(j);
  console.log("8 guest sees live status:", gv.orders[0].status);

  await fetch(`${B}/p/${reg.slug}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table: "T1", custId: "c1", storeId: "main" }),
  }).then(j);
  const pull3 = await fetch(B + "/api/pull?since=" + pull2.rowver + "&storeId=main", { headers: H }).then(j);
  const call = pull3.entities.find((e) => e.kind === "waiterCalls");
  if (!call) throw new Error("main POS did not pull waiter call");
  console.log("9 till alarm:", call.data.name, "-", call.data.table);

  await fetch(B + "/api/ops", { method: "POST", headers: H, body: JSON.stringify({ ops: [
    { opId: "op-legacy-" + uniq, storeId: "main", puts: [
      { kind: "customers", id: "1719400000001", data: { id: 1719400000001, name: "Hawwa Zahir", points: 120, balance: 0, address: "Male" } },
    ] },
  ] }) }).then(j);
  const boot2 = await fetch(`${B}/p/${reg.slug}/boot?c=1719400000001&storeId=main`).then(j);
  if (!boot2.cust || boot2.cust.name !== "Hawwa Zahir") throw new Error("numeric-id customer profile did not load");
  const ord2 = await fetch(`${B}/p/${reg.slug}/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ pid: "p1", qty: 1 }], custId: "1719400000001", gtype: "pickup", storeId: "main" }),
  }).then(j);
  if (!ord2.order.customerName) throw new Error("guest order not linked to numeric-id customer");
  const gv2 = await fetch(`${B}/p/${reg.slug}/orders?c=1719400000001&storeId=main`).then(j);
  if (!gv2.orders.length) throw new Error("numeric-id customer cannot see own orders");
  console.log("10 numeric-id profile:", boot2.cust.name, "-", ord2.order.no, "by", ord2.order.customerName);

  const store = await fetch(B + "/api/stores", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ id: "airport", code: "AIR", name: "Airport Cafe" }),
  }).then(j);
  const selected = await fetch(B + "/api/select-store", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ storeId: "airport" }),
  }).then(j);
  const H2 = { "Content-Type": "application/json", Authorization: "Bearer " + selected.token };
  await fetch(B + "/api/ops", { method: "POST", headers: H2, body: JSON.stringify({ ops: [
    { opId: "op-air-" + uniq, storeId: "airport", puts: [
      { kind: "products", id: "p2", data: { id: "p2", storeId: "airport", name: "Airport Latte", emoji: "coffee", cat: "Coffee", price: 6500, stock: 20, unit: "cup" } },
      { kind: "tables", id: "tb-air", data: { id: "tb-air", storeId: "airport", name: "A1" } },
    ] },
  ] }) }).then(j);
  const airBoot = await fetch(`${B}/p/${reg.slug}/boot?storeId=airport`).then(j);
  if (!airBoot.tables.includes("A1")) throw new Error("airport store table missing from guest boot");
  if (!airBoot.products.some((p) => p.id === "p2")) throw new Error("airport store product missing from guest boot");
  const airOrder = await fetch(`${B}/p/${reg.slug}/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ pid: "p2", qty: 1 }], table: "A1", gtype: "table", storeId: "airport" }),
  }).then(j);
  const airPull = await fetch(B + "/api/pull?since=0&storeId=airport", { headers: H2 }).then(j);
  if (!airPull.entities.some((e) => e.kind === "orders" && e.data.id === airOrder.order.id && e.data.storeId === "airport")) throw new Error("airport register did not pull airport order");
  const mainPullAgain = await fetch(B + "/api/pull?since=0&storeId=main", { headers: H }).then(j);
  if (mainPullAgain.entities.some((e) => e.kind === "orders" && e.data.id === airOrder.order.id)) throw new Error("airport order leaked into main store pull");
  console.log("11 multi-store:", store.store.name, "order", airOrder.order.no, "isolated");

  console.log("ALL SMOKE CHECKS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAIL:", e.message);
  process.exit(1);
});
