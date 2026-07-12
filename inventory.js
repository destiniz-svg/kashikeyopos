/* KashikeyoPOS · Inventory & Pricing module
   Recipe-first ingredient tracking with periodic ("stock check") audits.
   Design + data-flow rationale: docs/inventory-and-pricing.md.

   Everything here runs through the withOrg scope handed in from index.js, so
   the tenant_isolation RLS policies apply to every query — the org_id in the
   SQL is belt-and-braces on top of that, never the only guard.

   Quantities: always NUMERIC in the ingredient's BASE unit (g / ml / pcs).
   Bulk units ("Case", "25kg bag") exist only at the edges — invoice entry and
   stock-check entry — as per-ingredient factors converted the moment data
   comes in. Money: NUMERIC laari (the platform's integer sub-unit); unit
   costs carry 6 decimals because cost per gram is a fraction of a laari. */

module.exports = function createInventory({ withOrg, uid, wrap, recordError, resolveAppSession, bearerAuth, poke }) {
  const express = require("express");
  const router = express.Router();

  /* Back-office pages sign in with the app-session cookie; the till uses its
     bearer JWT. Accept either, and expose req.orgId either way. */
  const authAny = (req, res, next) => {
    resolveAppSession(req).then((orgId) => {
      if (orgId) { req.orgId = orgId; return next(); }
      bearerAuth(req, res, () => { req.orgId = req.org.o; next(); });
    }).catch(next);
  };

  const num = (v, d = 0) => { const n = Number(v); return isNaN(n) ? d : n; };
  const round3 = (v) => Math.round(v * 1000) / 1000;

  /* ── Unit conversion ────────────────────────────────────────────────────
     factorFor resolves "how many base units is one <unitName>" for an
     ingredient. '' or 'base' means the base unit itself. Unknown names are a
     hard error rather than a silent factor-1: a "Case" quietly counted as
     one bottle is exactly the data corruption this module exists to stop. */
  async function factorFor(client, orgId, ingredientId, unitName) {
    if (!unitName || unitName === "base") return 1;
    const r = await client.query(
      "SELECT factor FROM ingredient_units WHERE org_id=$1 AND ingredient_id=$2 AND lower(name)=lower($3)",
      [orgId, ingredientId, unitName]);
    if (!r.rowCount) throw Object.assign(new Error(`unknown unit "${unitName}" for this ingredient`), { status: 400 });
    return Number(r.rows[0].factor);
  }

  /* ── Sale → ingredient deduction (real-time) ────────────────────────────
     Called by index.js AFTER /api/ops commits, with the sale entities that
     op batch contained. Runs in its own transaction per sale so one bad
     sale can't poison the others, and is idempotent end to end: the ledger
     row (org_id, ref, ingredient_id) is unique, and the stock decrement
     only happens when that insert actually inserted. A replayed sync op,
     a retried call, or a crash-and-rerun all deduct exactly once.
     Refund sales put the ingredients back under a distinct ref. */
  async function processSales(orgId, sales) {
    const touched = new Set();
    for (const sale of sales || []) {
      if (!sale || !Array.isArray(sale.lines) || !sale.id) continue;
      const isRefund = sale.type === "refund";
      const sign = isRefund ? 1 : -1;
      const ref = (isRefund ? "refund:" : "sale:") + sale.id;
      try {
        await withOrg(orgId, async (client) => {
          const pids = [...new Set(sale.lines.map((l) => String(l.pid || "")).filter(Boolean))];
          if (!pids.length) return;
          const rec = await client.query(
            "SELECT product_id, ingredient_id, qty FROM recipe_lines WHERE org_id=$1 AND product_id = ANY($2)",
            [orgId, pids]);
          if (!rec.rowCount) return; // no recipes → product-level stock (the till's own sd()) is the tracking layer
          const perIngredient = new Map();
          for (const line of sale.lines) {
            const sold = num(line.qty, 1);
            for (const rl of rec.rows.filter((r) => r.product_id === String(line.pid))) {
              const prev = perIngredient.get(rl.ingredient_id) || 0;
              perIngredient.set(rl.ingredient_id, prev + Number(rl.qty) * sold);
            }
          }
          for (const [ingredientId, baseQty] of perIngredient) {
            const ins = await client.query(
              `INSERT INTO stock_moves (org_id, id, ingredient_id, store_id, kind, qty, unit_cost, ref)
               SELECT $1, $2, $3, $4, $5, $6, i.avg_cost, $7
               FROM ingredients i WHERE i.org_id=$1 AND i.id=$3
               ON CONFLICT (org_id, ref, ingredient_id) WHERE ref <> '' DO NOTHING
               RETURNING 1`,
              [orgId, uid(), ingredientId, sale.storeId || "main", isRefund ? "refund" : "sale", round3(sign * baseQty), ref]);
            if (ins.rowCount) {
              await client.query(
                "UPDATE ingredients SET current_stock = current_stock + $3, updated_at = now() WHERE org_id=$1 AND id=$2",
                [orgId, ingredientId, round3(sign * baseQty)]);
              touched.add(ingredientId);
            }
          }
        });
      } catch (e) { recordError("inventory deduction " + ref, e); }
    }
    if (touched.size) await recomputeAvailability(orgId, [...touched]);
  }

  /* ── Availability engine (the central "what remains" made sellable) ──────
     A recipe-tracked product can be sold only while every ingredient it needs
     is in stock. We fold that down to one number the till + guest already
     understand — how many servings the current ingredient levels can still
     make — and write it onto the product entity (data.recipeAvail) together
     with the limiting ingredient's name (data.soldOutReason). Because that
     rides the normal sync stream, every ordering surface disables the item
     the moment an ingredient runs out, and restores it when stock returns —
     no separate availability feed to keep in step. Recomputed after any
     ingredient-stock change (sale, purchase, audit) or recipe edit; scoped to
     the affected products so a busy till never recomputes the whole menu. */
  async function recomputeAvailability(orgId, ingredientIds) {
    try {
      let maxRowver = 0;
      await withOrg(orgId, async (client) => {
        const prodQ = ingredientIds && ingredientIds.length
          ? await client.query("SELECT DISTINCT product_id FROM recipe_lines WHERE org_id=$1 AND ingredient_id = ANY($2)", [orgId, ingredientIds])
          : await client.query("SELECT DISTINCT product_id FROM recipe_lines WHERE org_id=$1", [orgId]);
        const productIds = prodQ.rows.map((r) => r.product_id);
        if (!productIds.length) return;
        const rc = await client.query(
          `SELECT rl.product_id, rl.qty, i.name, i.current_stock
           FROM recipe_lines rl JOIN ingredients i ON i.org_id=rl.org_id AND i.id=rl.ingredient_id
           WHERE rl.org_id=$1 AND rl.product_id = ANY($2) AND i.active`, [orgId, productIds]);
        const byProduct = new Map();
        for (const row of rc.rows) { (byProduct.get(row.product_id) || byProduct.set(row.product_id, []).get(row.product_id)).push(row); }
        for (const pid of productIds) {
          const lines = byProduct.get(pid) || [];
          let servings = lines.length ? Infinity : null, limName = null;
          for (const l of lines) {
            const q = Number(l.qty) || 0; if (q <= 0) continue;
            const s = Math.floor(Number(l.current_stock) / q);
            if (s < servings) { servings = s; limName = l.name; }
          }
          if (servings === Infinity) servings = null;
          const avail = servings == null ? null : Math.max(0, servings);
          const reason = servings != null && servings <= 0 ? "Out of " + (limName || "ingredients") : null;
          const upd = await client.query(
            `UPDATE entities SET
               data = data || jsonb_build_object('recipeAvail', $3::int, 'soldOutReason', $4::text),
               rowver = nextval('entities_rowver_seq'), updated_at = now()
             WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false RETURNING rowver`,
            [orgId, pid, avail, reason]);
          for (const row of upd.rows) maxRowver = Math.max(maxRowver, Number(row.rowver));
        }
      });
      if (maxRowver && poke) poke(orgId, maxRowver);
    } catch (e) { recordError("availability recompute", e); }
  }

  /* ── Menu items (for the recipe mapper) ─────────────────────────────────
     The back office needs the org's menu to map recipes onto. Products live
     as entities (kind='products'); expose the fields the editor needs plus
     which items already have a recipe, and the store currency for labels. */
  router.get("/products", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const r = await client.query(
        "SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [req.orgId]);
      const st = await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false", [req.orgId]);
      const rc = await client.query(
        "SELECT product_id, count(*) AS n FROM recipe_lines WHERE org_id=$1 GROUP BY product_id", [req.orgId]);
      const recipeCounts = Object.fromEntries(rc.rows.map((x) => [x.product_id, Number(x.n)]));
      const products = r.rows
        .map((x) => {
          const d = x.data || {};
          const id = String(d.id || x.id).split(":").pop();
          return { id, name: d.name || "Item", emoji: d.emoji || "", cat: d.cat || "General", price: num(d.price), recipeLines: recipeCounts[id] || 0 };
        })
        .sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
      const sd = st.rowCount ? st.rows[0].data : {};
      return {
        currency: sd.currency || "MVR",
        storeName: sd.storeName || "",
        /* till writes its chosen theme into settings (see guest-sync-patch
           #30/31) so the back office can follow the same palette */
        theme: { name: sd.ktheme || "orange", dark: sd.ktdark === true },
        products,
      };
    });
    res.json(out);
  }));

  /* ── Ingredients ──────────────────────────────────────────────────────── */
  router.get("/ingredients", authAny, wrap(async (req, res) => {
    const rows = await withOrg(req.orgId, async (client) => {
      const ing = await client.query(
        "SELECT id, name, sku, base_unit, current_stock, min_stock, avg_cost, location FROM ingredients WHERE org_id=$1 AND active ORDER BY location, name",
        [req.orgId]);
      const units = await client.query(
        "SELECT ingredient_id, name, factor FROM ingredient_units WHERE org_id=$1", [req.orgId]);
      return ing.rows.map((i) => ({
        ...i,
        current_stock: Number(i.current_stock), min_stock: Number(i.min_stock), avg_cost: Number(i.avg_cost),
        low: Number(i.min_stock) > 0 && Number(i.current_stock) <= Number(i.min_stock),
        units: units.rows.filter((u) => u.ingredient_id === i.id).map((u) => ({ name: u.name, factor: Number(u.factor) })),
      }));
    });
    res.json({ ingredients: rows });
  }));

  router.post("/ingredients", authAny, wrap(async (req, res) => {
    const { id, name, sku, baseUnit, minStock, location, units } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "ingredient name required" });
    const base = ["g", "ml", "pcs"].includes(baseUnit) ? baseUnit : "g";
    const ingId = id || uid();
    await withOrg(req.orgId, async (client) => {
      await client.query(
        `INSERT INTO ingredients (org_id, id, name, sku, base_unit, min_stock, location)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (org_id, id) DO UPDATE SET
           name=excluded.name, sku=excluded.sku, min_stock=excluded.min_stock,
           location=excluded.location, active=true, updated_at=now()`,
        [req.orgId, ingId, String(name).trim(), String(sku || "").trim(), base, num(minStock), String(location || "Dry")]);
      if (Array.isArray(units)) {
        await client.query("DELETE FROM ingredient_units WHERE org_id=$1 AND ingredient_id=$2", [req.orgId, ingId]);
        for (const u of units) {
          if (!u || !u.name || !(num(u.factor) > 0)) continue;
          await client.query(
            "INSERT INTO ingredient_units (org_id, id, ingredient_id, name, factor) VALUES ($1,$2,$3,$4,$5)",
            [req.orgId, uid(), ingId, String(u.name).trim(), num(u.factor)]);
        }
      }
    });
    res.json({ ok: true, id: ingId });
  }));

  router.delete("/ingredients/:id", authAny, wrap(async (req, res) => {
    await withOrg(req.orgId, (client) => client.query(
      "UPDATE ingredients SET active=false, updated_at=now() WHERE org_id=$1 AND id=$2", [req.orgId, req.params.id]));
    res.json({ ok: true });
  }));

  /* ── Stock history / movement timeline (§12) ────────────────────────────
     Every movement of an ingredient, straight from the immutable ledger, so
     the owner can read "what came in, where it went, and what's left" without
     any accounting. The running balance is derived, never stored. */
  router.get("/history/:ingredientId", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const ing = await client.query(
        "SELECT id, name, base_unit, current_stock, avg_cost FROM ingredients WHERE org_id=$1 AND id=$2",
        [req.orgId, req.params.ingredientId]);
      if (!ing.rowCount) throw Object.assign(new Error("ingredient not found"), { status: 404 });
      const mv = await client.query(
        `SELECT id, kind, qty, unit_cost, ref, note, created_at
         FROM stock_moves WHERE org_id=$1 AND ingredient_id=$2 ORDER BY created_at ASC, id ASC LIMIT 500`,
        [req.orgId, req.params.ingredientId]);
      const i = ing.rows[0];
      return {
        ingredient: { id: i.id, name: i.name, baseUnit: i.base_unit, currentStock: Number(i.current_stock), avgCost: Number(i.avg_cost) },
        moves: mv.rows.map((m) => ({ id: m.id, kind: m.kind, qty: Number(m.qty), unitCost: Number(m.unit_cost), ref: m.ref, note: m.note, at: m.created_at })),
      };
    });
    res.json(out);
  }));

  /* ── Wastage & stock corrections (Phase 2) ──────────────────────────────
     Two everyday realities that used to have nowhere to go: something spoiled
     or got thrown out (waste), and "the shelf just doesn't match the system"
     (a correction). Both land as first-class ledger entries so the stock
     figure, the value on hand and the COGS reports all stay honest — no
     silent edits to current_stock behind the ledger's back.

       mode "waste"   — staff say how much was thrown out; qty is a positive
                        amount that we subtract. Guarded so you can never
                        waste more than you actually hold.
       mode "correct" — staff type the true amount now on the shelf; we work
                        out the difference and record it. Enter what you SEE,
                        not a delta, so there's nothing to get backwards. */
  router.post("/adjust", authAny, wrap(async (req, res) => {
    const { ingredientId, mode, qty, unitName, reason } = req.body || {};
    if (!ingredientId) return res.status(400).json({ error: "which ingredient?" });
    if (mode !== "waste" && mode !== "correct") return res.status(400).json({ error: "mode must be waste or correct" });
    const amount = num(qty);
    if (mode === "waste" && !(amount > 0)) return res.status(400).json({ error: "enter how much was thrown out" });
    if (mode === "correct" && amount < 0) return res.status(400).json({ error: "a stock count can't be negative" });

    const out = await withOrg(req.orgId, async (client) => {
      const ing = await client.query(
        "SELECT id, name, base_unit, current_stock, avg_cost FROM ingredients WHERE org_id=$1 AND id=$2 AND active FOR UPDATE",
        [req.orgId, ingredientId]);
      if (!ing.rowCount) throw Object.assign(new Error("ingredient not found"), { status: 404 });
      const i = ing.rows[0];
      const factor = await factorFor(client, req.orgId, ingredientId, unitName);
      const stock = Number(i.current_stock), avg = Number(i.avg_cost);
      const baseAmt = round3(amount * factor);

      let kind, delta, newStock;
      if (mode === "waste") {
        if (baseAmt > stock + 1e-9) {
          throw Object.assign(new Error(`You only have ${round3(stock)} ${i.base_unit} of ${i.name} in stock — you can't waste more than that.`), { status: 400 });
        }
        kind = "waste"; delta = round3(-baseAmt); newStock = round3(stock - baseAmt);
      } else {
        newStock = baseAmt; delta = round3(baseAmt - stock);
        if (delta === 0) return { unchanged: true, name: i.name };
        kind = "manual";
      }

      const noteBase = mode === "waste" ? "wastage" : "stock correction";
      const note = String(reason || "").trim() ? `${noteBase}: ${String(reason).trim().slice(0, 120)}` : noteBase;
      await client.query(
        "INSERT INTO stock_moves (org_id, id, ingredient_id, kind, qty, unit_cost, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [req.orgId, uid(), ingredientId, kind, delta, avg, note]);
      await client.query(
        "UPDATE ingredients SET current_stock=$3, updated_at=now() WHERE org_id=$1 AND id=$2",
        [req.orgId, ingredientId, newStock]);
      return { name: i.name, baseUnit: i.base_unit, newStock, delta, valueChange: round3(delta * avg) };
    });

    if (out && !out.unchanged) await recomputeAvailability(req.orgId, [String(ingredientId)]);
    res.json(Object.assign({ ok: true }, out));
  }));

  /* ── Recipes + live margin preview ──────────────────────────────────────
     The margin figures come straight from the same avg_cost the deduction
     and audit math use, so the number the owner sees while building a
     recipe is the number the COGS report will later agree with. */
  async function recipeCost(client, orgId, productId) {
    const r = await client.query(
      `SELECT rl.ingredient_id, rl.qty, i.name, i.base_unit, i.avg_cost
       FROM recipe_lines rl JOIN ingredients i ON i.org_id = rl.org_id AND i.id = rl.ingredient_id
       WHERE rl.org_id=$1 AND rl.product_id=$2 ORDER BY i.name`, [orgId, productId]);
    const lines = r.rows.map((x) => ({
      ingredientId: x.ingredient_id, name: x.name, baseUnit: x.base_unit,
      qty: Number(x.qty), unitCost: Number(x.avg_cost), lineCost: Math.round(Number(x.qty) * Number(x.avg_cost)),
    }));
    return { lines, cost: lines.reduce((a, l) => a + l.lineCost, 0) };
  }

  router.get("/recipes/:productId", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const { lines, cost } = await recipeCost(client, req.orgId, req.params.productId);
      const prod = await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false",
        [req.orgId, req.params.productId]);
      const price = prod.rowCount ? num(prod.rows[0].data.price) : 0;
      return { lines, cost, price, margin: price - cost, marginPct: price > 0 ? Math.round((price - cost) / price * 10000) / 100 : 0 };
    });
    res.json(out);
  }));

  router.put("/recipes/:productId", authAny, wrap(async (req, res) => {
    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    const out = await withOrg(req.orgId, async (client) => {
      await client.query("DELETE FROM recipe_lines WHERE org_id=$1 AND product_id=$2", [req.orgId, req.params.productId]);
      for (const l of lines) {
        if (!l || !l.ingredientId || !(num(l.qty) > 0)) continue;
        await client.query(
          "INSERT INTO recipe_lines (org_id, id, product_id, ingredient_id, qty) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, product_id, ingredient_id) DO UPDATE SET qty=excluded.qty",
          [req.orgId, uid(), req.params.productId, String(l.ingredientId), num(l.qty)]);
      }
      return recipeCost(client, req.orgId, req.params.productId);
    });
    /* Editing a recipe changes what the product needs, so its availability
       must be re-derived even if no stock moved. */
    await recomputeAvailability(req.orgId, lines.map((l) => l && String(l.ingredientId)).filter(Boolean));
    res.json({ ok: true, ...out });
  }));

  /* ── Procurement: suppliers + invoice posting ─────────────────────────── */
  router.get("/suppliers", authAny, wrap(async (req, res) => {
    const r = await withOrg(req.orgId, (client) => client.query(
      "SELECT id, name, phone, email, notes FROM suppliers WHERE org_id=$1 AND active ORDER BY name", [req.orgId]));
    res.json({ suppliers: r.rows });
  }));

  router.post("/suppliers", authAny, wrap(async (req, res) => {
    const { id, name, phone, email, notes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "supplier name required" });
    const sid = id || uid();
    await withOrg(req.orgId, (client) => client.query(
      `INSERT INTO suppliers (org_id, id, name, phone, email, notes) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email, notes=excluded.notes, active=true`,
      [req.orgId, sid, String(name).trim(), String(phone || ""), String(email || ""), String(notes || "")]));
    res.json({ ok: true, id: sid });
  }));

  /* Posting an invoice is the single write path that both raises stock and
     re-averages cost — weighted average, the method a non-accountant never
     has to think about: new cost = (old stock value + this delivery's value)
     / total units. Ledger refs are per invoice LINE so two lines of the same
     ingredient on one invoice both land.

     Bridge to the till's books: the same transaction writes an "expenses"
     entity (cat Purchases) into the regular sync stream, so the till's
     expense reports and P&L include ingredient purchases without anyone
     entering the bill twice. srcRef makes the booking idempotent — an
     expense for this invoice/PO can only ever exist once. */
  async function postInvoiceTx(client, orgId, { supplierId, supplierName, invoiceNo, lines, expenseRef, expenseNote }) {
    const invId = uid();
    let total = 0;
    const posted = [];
    for (const l of lines) {
      const qty = num(l.qty), lineCost = Math.round(num(l.cost));
      if (!l.ingredientId || !(qty > 0) || !(lineCost >= 0)) continue;
      const factor = await factorFor(client, orgId, String(l.ingredientId), l.unitName);
      const baseQty = round3(qty * factor);
      const lineId = uid();
      const cur = await client.query(
        "SELECT current_stock, avg_cost FROM ingredients WHERE org_id=$1 AND id=$2 AND active FOR UPDATE",
        [orgId, l.ingredientId]);
      if (!cur.rowCount) throw Object.assign(new Error("unknown ingredient on invoice line"), { status: 400 });
      const stock = Number(cur.rows[0].current_stock), avg = Number(cur.rows[0].avg_cost);
      const unitCost = baseQty > 0 ? lineCost / baseQty : 0;
      /* Negative on-hand (over-deduction awaiting an audit) must not poison
         the average — fold new stock in against max(stock,0). */
      const posStock = Math.max(stock, 0);
      const newAvg = (posStock + baseQty) > 0 ? (posStock * avg + lineCost) / (posStock + baseQty) : avg;
      await client.query(
        "INSERT INTO purchase_invoice_lines (org_id, id, invoice_id, ingredient_id, qty, unit_name, factor, base_qty, line_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [orgId, lineId, invId, l.ingredientId, qty, String(l.unitName || ""), factor, baseQty, lineCost]);
      await client.query(
        "INSERT INTO stock_moves (org_id, id, ingredient_id, kind, qty, unit_cost, ref) VALUES ($1,$2,$3,'purchase',$4,$5,$6)",
        [orgId, uid(), l.ingredientId, baseQty, unitCost, `invoice:${invId}:${lineId}`]);
      await client.query(
        "UPDATE ingredients SET current_stock = current_stock + $3, avg_cost = $4, updated_at = now() WHERE org_id=$1 AND id=$2",
        [orgId, l.ingredientId, baseQty, newAvg]);
      total += lineCost;
      posted.push({ ingredientId: l.ingredientId, baseQty, lineCost });
    }
    if (!posted.length) throw Object.assign(new Error("no valid invoice lines"), { status: 400 });
    await client.query(
      "INSERT INTO purchase_invoices (org_id, id, supplier_id, invoice_no, total) VALUES ($1,$2,$3,$4,$5)",
      [orgId, invId, String(supplierId || ""), String(invoiceNo || ""), total]);
    const expense = {
      id: uid(), no: "EXP-" + (invoiceNo || invId.slice(0, 6).toUpperCase()), t: Date.now(),
      cat: "Purchases", supplier: String(supplierName || ""), amount: total,
      note: expenseNote || `${invoiceNo || "Delivery"} · ${posted.length} line${posted.length === 1 ? "" : "s"} · back office`,
      paidFrom: "other", userName: "Back office", shiftId: null, img: "",
      srcRef: expenseRef || "invoice:" + invId,
    };
    const exp = await client.query(
      `INSERT INTO entities (org_id, kind, id, data)
       SELECT $1, 'expenses', $2, $3
       WHERE NOT EXISTS (SELECT 1 FROM entities WHERE org_id=$1 AND kind='expenses' AND deleted=false AND data->>'srcRef'=$4)
       RETURNING rowver`,
      [orgId, expense.id, JSON.stringify(expense), expense.srcRef]);
    return { id: invId, total, lines: posted, rowver: exp.rowCount ? Number(exp.rows[0].rowver) : 0 };
  }

  router.post("/invoices", authAny, wrap(async (req, res) => {
    const { supplierId, invoiceNo, lines } = req.body || {};
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: "invoice needs at least one line" });
    const out = await withOrg(req.orgId, async (client) => {
      let supplierName = "";
      if (supplierId) {
        const s = await client.query("SELECT name FROM suppliers WHERE org_id=$1 AND id=$2", [req.orgId, supplierId]);
        supplierName = s.rowCount ? s.rows[0].name : "";
      }
      return postInvoiceTx(client, req.orgId, { supplierId, supplierName, invoiceNo, lines });
    });
    if (out.rowver && poke) poke(req.orgId, out.rowver);
    await recomputeAvailability(req.orgId, (out.lines || []).map((l) => l && String(l.ingredientId)).filter(Boolean));
    res.json({ ok: true, id: out.id, total: out.total, lines: out.lines });
  }));

  /* ── Bridge 2: purchase orders raised at the till ───────────────────────
     POs live as "pords" entities in the till's own sync stream. The back
     office lists the open ones and can receive one as a pre-filled delivery:
     one tap posts the invoice (stock + weighted cost), books the expense
     (ref po:<id>, so the till's own Receive can never double-book), and
     flips the PO to received — which also hides the till's Receive button. */
  router.get("/pos", authAny, wrap(async (req, res) => {
    const r = await withOrg(req.orgId, (client) => client.query(
      `SELECT id, data FROM entities
       WHERE org_id=$1 AND kind='pords' AND deleted=false AND data->>'status'='open'
       ORDER BY (data->>'t')::numeric DESC LIMIT 50`, [req.orgId]));
    res.json({ pos: r.rows.map((x) => {
      const d = x.data || {};
      return { id: String(d.id || x.id), no: d.no || "", supplier: d.supplier || "", total: num(d.total), t: num(d.t), note: d.note || "",
        items: (d.items || []).map((it) => ({ desc: it.desc || "", qty: num(it.qty, 1), cost: num(it.cost) })) };
    }) });
  }));

  router.post("/pos/:id/receive", authAny, wrap(async (req, res) => {
    const { lines, invoiceNo } = req.body || {};
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: "map the PO lines to ingredients first" });
    const out = await withOrg(req.orgId, async (client) => {
      const po = await client.query(
        "SELECT id, data FROM entities WHERE org_id=$1 AND kind='pords' AND id=$2 AND deleted=false", [req.orgId, req.params.id]);
      if (!po.rowCount) throw Object.assign(new Error("purchase order not found"), { status: 404 });
      const d = po.rows[0].data || {};
      if (d.status !== "open") throw Object.assign(new Error("this PO was already received"), { status: 409 });
      const inv = await postInvoiceTx(client, req.orgId, {
        supplierId: "", supplierName: d.supplier || "", invoiceNo: invoiceNo || d.no || "",
        lines, expenseRef: "po:" + req.params.id,
        expenseNote: `${d.no || "PO"} received · ${lines.length} line${lines.length === 1 ? "" : "s"} · back office`,
      });
      const upd = await client.query(
        `UPDATE entities SET
           data = data || jsonb_build_object('status','received','receivedAt',$3::numeric,'receivedVia','back-office'),
           rowver = nextval('entities_rowver_seq'), updated_at = now()
         WHERE org_id=$1 AND kind='pords' AND id=$2 AND data->>'status'='open'
         RETURNING rowver`, [req.orgId, req.params.id, Date.now()]);
      if (!upd.rowCount) throw Object.assign(new Error("this PO was already received"), { status: 409 });
      return { ...inv, rowver: Math.max(inv.rowver, Number(upd.rows[0].rowver)) };
    });
    if (out.rowver && poke) poke(req.orgId, out.rowver);
    await recomputeAvailability(req.orgId, (out.lines || []).map((l) => l && String(l.ingredientId)).filter(Boolean));
    res.json({ ok: true, id: out.id, total: out.total, lines: out.lines });
  }));

  router.get("/invoices", authAny, wrap(async (req, res) => {
    const r = await withOrg(req.orgId, (client) => client.query(
      `SELECT pi.id, pi.invoice_no, pi.total, pi.received_at, s.name AS supplier
       FROM purchase_invoices pi LEFT JOIN suppliers s ON s.org_id = pi.org_id AND s.id = pi.supplier_id
       WHERE pi.org_id=$1 ORDER BY pi.received_at DESC LIMIT 100`, [req.orgId]));
    res.json({ invoices: r.rows.map((x) => ({ ...x, total: Number(x.total) })) });
  }));

  /* ── Periodic audit ("stock check") ─────────────────────────────────────
     open  → snapshot every active ingredient's expected stock and the
             opening value (last closed check's ending value, or the system's
             current belief for a first-ever check).
     count → entries accepted in any of the ingredient's units, converted on
             arrival; can be saved incrementally as the owner walks the store.
     close → variance per line (>5% flagged "review" with a plain-language
             reason), stock snapped to counted via ledgered audit moves, and
             period COGS = opening + purchases − ending. */
  router.post("/audits", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const open = await client.query("SELECT id FROM audit_sessions WHERE org_id=$1 AND status='open'", [req.orgId]);
      if (open.rowCount) throw Object.assign(new Error("a stock check is already in progress"), { status: 409 });
      const prev = await client.query(
        "SELECT closing_value FROM audit_sessions WHERE org_id=$1 AND status='closed' ORDER BY closed_at DESC LIMIT 1", [req.orgId]);
      const ing = await client.query(
        "SELECT id, current_stock, avg_cost FROM ingredients WHERE org_id=$1 AND active", [req.orgId]);
      const systemValue = ing.rows.reduce((a, i) => a + Number(i.current_stock) * Number(i.avg_cost), 0);
      const opening = prev.rowCount ? Number(prev.rows[0].closing_value) : Math.round(systemValue);
      const sessionId = uid();
      await client.query(
        "INSERT INTO audit_sessions (org_id, id, label, started_by, opening_value) VALUES ($1,$2,$3,$4,$5)",
        [req.orgId, sessionId, String((req.body && req.body.label) || ""), String((req.body && req.body.startedBy) || ""), opening]);
      for (const i of ing.rows) {
        await client.query(
          "INSERT INTO audit_lines (org_id, id, session_id, ingredient_id, expected) VALUES ($1,$2,$3,$4,$5)",
          [req.orgId, uid(), sessionId, i.id, Number(i.current_stock)]);
      }
      return { id: sessionId, lines: ing.rowCount, openingValue: opening };
    });
    res.json({ ok: true, ...out });
  }));

  router.get("/audits", authAny, wrap(async (req, res) => {
    const r = await withOrg(req.orgId, (client) => client.query(
      "SELECT id, label, status, started_at, closed_at, opening_value, purchases_value, closing_value, cogs FROM audit_sessions WHERE org_id=$1 ORDER BY started_at DESC LIMIT 50", [req.orgId]));
    res.json({ audits: r.rows });
  }));

  router.get("/audits/:id", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const s = await client.query("SELECT * FROM audit_sessions WHERE org_id=$1 AND id=$2", [req.orgId, req.params.id]);
      if (!s.rowCount) throw Object.assign(new Error("stock check not found"), { status: 404 });
      const lines = await client.query(
        `SELECT al.id, al.ingredient_id, al.expected, al.counted, al.variance, al.variance_pct, al.flag, al.reason,
                i.name, i.base_unit, i.location, i.avg_cost
         FROM audit_lines al JOIN ingredients i ON i.org_id = al.org_id AND i.id = al.ingredient_id
         WHERE al.org_id=$1 AND al.session_id=$2 ORDER BY i.location, i.name`, [req.orgId, req.params.id]);
      const units = await client.query("SELECT ingredient_id, name, factor FROM ingredient_units WHERE org_id=$1", [req.orgId]);
      /* Grouped by storage location so the wizard walks Fridge → Dry → Bar. */
      const byLocation = {};
      for (const l of lines.rows) {
        (byLocation[l.location] = byLocation[l.location] || []).push({
          id: l.id, ingredientId: l.ingredient_id, name: l.name, baseUnit: l.base_unit,
          expected: Number(l.expected), counted: l.counted === null ? null : Number(l.counted),
          variance: Number(l.variance), variancePct: Number(l.variance_pct), flag: l.flag, reason: l.reason,
          units: units.rows.filter((u) => u.ingredient_id === l.ingredient_id).map((u) => ({ name: u.name, factor: Number(u.factor) })),
        });
      }
      return { session: s.rows[0], byLocation };
    });
    res.json(out);
  }));

  router.put("/audits/:id/counts", authAny, wrap(async (req, res) => {
    const counts = Array.isArray(req.body && req.body.counts) ? req.body.counts : [];
    await withOrg(req.orgId, async (client) => {
      const s = await client.query("SELECT status FROM audit_sessions WHERE org_id=$1 AND id=$2", [req.orgId, req.params.id]);
      if (!s.rowCount || s.rows[0].status !== "open") throw Object.assign(new Error("this stock check is not open"), { status: 409 });
      for (const cItem of counts) {
        if (!cItem || !cItem.ingredientId || cItem.qty === undefined || cItem.qty === null) continue;
        const factor = await factorFor(client, req.orgId, String(cItem.ingredientId), cItem.unitName);
        const counted = round3(num(cItem.qty) * factor);
        await client.query(
          "UPDATE audit_lines SET counted=$4, reason=COALESCE($5, reason) WHERE org_id=$1 AND session_id=$2 AND ingredient_id=$3",
          [req.orgId, req.params.id, cItem.ingredientId, counted, cItem.reason !== undefined ? String(cItem.reason) : null]);
      }
    });
    res.json({ ok: true });
  }));

  router.post("/audits/:id/close", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const s = await client.query("SELECT * FROM audit_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE", [req.orgId, req.params.id]);
      if (!s.rowCount) throw Object.assign(new Error("stock check not found"), { status: 404 });
      if (s.rows[0].status !== "open") throw Object.assign(new Error("already closed"), { status: 409 });
      const prev = await client.query(
        "SELECT closed_at, closing_value FROM audit_sessions WHERE org_id=$1 AND status='closed' ORDER BY closed_at DESC LIMIT 1", [req.orgId]);
      const since = prev.rowCount ? prev.rows[0].closed_at : new Date(0);
      const lines = await client.query(
        `SELECT al.id, al.ingredient_id, al.expected, al.counted, i.avg_cost
         FROM audit_lines al JOIN ingredients i ON i.org_id = al.org_id AND i.id = al.ingredient_id
         WHERE al.org_id=$1 AND al.session_id=$2`, [req.orgId, req.params.id]);
      let closingValue = 0, review = 0;
      for (const l of lines.rows) {
        const expected = Number(l.expected), avg = Number(l.avg_cost);
        /* Skipped lines (never counted) keep the system figure — the owner
           only pays attention to what they actually walked past. */
        const counted = l.counted === null ? expected : Number(l.counted);
        const variance = round3(counted - expected);
        const pct = Math.abs(expected) > 0 ? Math.round(Math.abs(variance) / Math.abs(expected) * 10000) / 100 : (variance !== 0 ? 100 : 0);
        const flag = pct > 5 ? "review" : "ok";
        if (flag === "review") review += 1;
        closingValue += counted * avg;
        await client.query(
          "UPDATE audit_lines SET counted=$4, variance=$5, variance_pct=$6, flag=$7 WHERE org_id=$1 AND id=$2 AND session_id=$3",
          [req.orgId, l.id, req.params.id, counted, variance, pct, flag]);
        if (variance !== 0) {
          await client.query(
            `INSERT INTO stock_moves (org_id, id, ingredient_id, kind, qty, unit_cost, ref, note)
             VALUES ($1,$2,$3,'audit',$4,$5,$6,'stock check adjustment')
             ON CONFLICT (org_id, ref, ingredient_id) WHERE ref <> '' DO NOTHING`,
            [req.orgId, uid(), l.ingredient_id, variance, avg, "audit:" + req.params.id]);
          await client.query(
            "UPDATE ingredients SET current_stock=$3, updated_at=now() WHERE org_id=$1 AND id=$2",
            [req.orgId, l.ingredient_id, counted]);
        }
      }
      const purch = await client.query(
        "SELECT COALESCE(SUM(qty * unit_cost), 0) AS v FROM stock_moves WHERE org_id=$1 AND kind='purchase' AND created_at > $2",
        [req.orgId, since]);
      const purchasesValue = Math.round(Number(purch.rows[0].v));
      const opening = Number(s.rows[0].opening_value);
      const closing = Math.round(closingValue);
      const cogs = opening + purchasesValue - closing;
      await client.query(
        "UPDATE audit_sessions SET status='closed', closed_at=now(), purchases_value=$3, closing_value=$4, cogs=$5 WHERE org_id=$1 AND id=$2",
        [req.orgId, req.params.id, purchasesValue, closing, cogs]);
      return { openingValue: opening, purchasesValue, closingValue: closing, cogs, flaggedForReview: review };
    });
    /* A stock check snaps every counted ingredient to its physical figure, so
       re-derive availability across the whole recipe menu. */
    await recomputeAvailability(req.orgId);
    res.json({ ok: true, ...out });
  }));

  /* ── Alerts: what needs the owner's attention right now ───────────────── */
  router.get("/alerts", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const low = await client.query(
        "SELECT id, name, base_unit, current_stock, min_stock, location FROM ingredients WHERE org_id=$1 AND active AND min_stock > 0 AND current_stock <= min_stock ORDER BY current_stock / NULLIF(min_stock,0)",
        [req.orgId]);
      const rev = await client.query(
        `SELECT al.ingredient_id, i.name, al.variance, al.variance_pct, al.reason, a.label, a.closed_at
         FROM audit_lines al
         JOIN audit_sessions a ON a.org_id = al.org_id AND a.id = al.session_id
         JOIN ingredients i ON i.org_id = al.org_id AND i.id = al.ingredient_id
         WHERE al.org_id=$1 AND al.flag='review' AND al.reason='' AND a.status='closed'
         ORDER BY a.closed_at DESC LIMIT 25`, [req.orgId]);
      return { lowStock: low.rows, needsReview: rev.rows };
    });
    res.json(out);
  }));

  return { router, processSales };
};
