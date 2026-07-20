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

module.exports = function createInventory({ withOrg, uid, wrap, recordError, resolveAppSession, bearerAuth, poke, logActivity }) {
  const noteActivity = typeof logActivity === "function" ? logActivity : async () => {};
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

  /* ── Minimal XLSX read/write (no dependency) ────────────────────────────
     An .xlsx is a ZIP of XML parts. Node's built-in zlib does the (in|de)flate,
     so a tiny ZIP container + a one-sheet workbook is all we need to export and
     re-import the menu as a real Excel file that Excel/Numbers/Sheets open. */
  const zlib = require("zlib");
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const xesc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const xunesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const colName = (n) => { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };
  const colIdx = (ref) => { let n = 0; for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

  function zipParts(files) {
    const chunks = [], central = []; let offset = 0;
    for (const f of files) {
      const name = Buffer.from(f.name, "utf8"), comp = zlib.deflateRawSync(f.data), crc = crc32(f.data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
      chunks.push(lh, name, comp);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
      cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(f.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
      central.push(cd, name);
      offset += lh.length + name.length + comp.length;
    }
    const cbuf = Buffer.concat(central), eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cbuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, cbuf, eocd]);
  }
  function unzipParts(buf) {
    let eo = -1;
    for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break; } }
    if (eo < 0) throw new Error("not a zip");
    const count = buf.readUInt16LE(eo + 10); let p = buf.readUInt32LE(eo + 16); const out = {};
    for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
      const method = buf.readUInt16LE(p + 10), compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
      const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const comp = buf.subarray(ds, ds + compSize);
      out[name] = method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp);
      p += 46 + nameLen + extraLen + commLen;
    }
    return out;
  }
  function buildXlsx(rows) {
    let sd = "";
    rows.forEach((row, ri) => {
      sd += `<row r="${ri + 1}">`;
      (row || []).forEach((cell, ci) => {
        if (cell == null || cell === "") return;
        const ref = colName(ci) + (ri + 1);
        if (typeof cell === "number" && isFinite(cell)) sd += `<c r="${ref}"><v>${cell}</v></c>`;
        else sd += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(cell)}</t></is></c>`;
      });
      sd += "</row>";
    });
    const P = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    return zipParts([
      { name: "[Content_Types].xml", data: Buffer.from(P + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
      { name: "_rels/.rels", data: Buffer.from(P + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: "xl/workbook.xml", data: Buffer.from(P + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Menu" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(P + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(P + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sd + "</sheetData></worksheet>") },
    ]);
  }
  function parseXlsx(buf) {
    const files = unzipParts(buf);
    const shared = [];
    const ssKey = Object.keys(files).find((k) => k.toLowerCase().endsWith("sharedstrings.xml"));
    if (ssKey) for (const m of files[ssKey].toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g))
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xunesc(x[1])).join(""));
    const shKey = Object.keys(files).filter((k) => /xl\/worksheets\/.*\.xml$/i.test(k)).sort()[0];
    if (!shKey) throw new Error("no worksheet");
    const sx = files[shKey].toString("utf8"), rows = [];
    for (const rm of sx.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], inner = cm[2] || "", ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
        if (!ref) continue;
        const t = (attrs.match(/t="([^"]+)"/) || [])[1] || "n";
        let val = "";
        if (t === "inlineStr") { const im = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/); val = im ? xunesc(im[1]) : ""; }
        else { const vm = inner.match(/<v>([\s\S]*?)<\/v>/); const raw = vm ? vm[1] : ""; val = t === "s" ? (shared[Number(raw)] || "") : xunesc(raw); }
        cells[colIdx(ref)] = val;
      }
      rows.push(cells);
    }
    return rows;
  }

  const MENU_COLS = ["SKU / ID", "Name", "Category", "Price (MVR)", "Taxable (Yes/No)", "Stock", "Image URL", "Emoji", "Description", "Allergens", "Add-ons (name:price, …)"];
  const addonsToCell = (arr) => (Array.isArray(arr) ? arr : []).map((a) => `${a.name}:${num(a.price) / 100}`).join(", ");
  const cellToAddons = (s) => String(s || "").split(/[,;\n]+/).map((part) => {
    const m = part.match(/^\s*(.+?)\s*[:=]\s*([0-9.]+)\s*$/); return m ? { name: m[1].trim().slice(0, 40), price: Math.round(parseFloat(m[2]) * 100) } : null;
  }).filter((a) => a && a.name).slice(0, 20);
  async function menuRows(orgId) {
    const r = await withOrg(orgId, (c) => c.query(
      "SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false ORDER BY data->>'cat', data->>'name'", [orgId]));
    return r.rows.map((x) => { const d = x.data || {}; return [
      String(d.id || x.id), d.name || "", d.cat || "", num(d.price) / 100,
      d.taxable === false ? "No" : "Yes", d.stock == null ? "" : num(d.stock),
      d.img || "", d.emoji || "", d.desc || "", d.allergens || "", addonsToCell(d.addons),
    ]; });
  }
  const menuIdFromName = (s) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || uid());

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
            // Returns: a line the cashier marked as wasted (opened/used, e.g. a
            // drunk coffee) does not come back into stock — the original sale's
            // deduction stands. Only restock-disposition lines are restored.
            if (isRefund && line.disp === "waste") continue;
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
    if ((sales || []).some((s) => s && Array.isArray(s.lines) && s.lines.length)) await recomputeBestSellers(orgId);
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

  /* Best-sellers (§4 menu polish): the top movers over the trailing 30 days,
     flagged onto the product entity (data.bestSeller) so the till menu can
     badge them — the same "annotate the entity, let sync carry it" pattern the
     availability engine uses. Ranked by net units sold (sales minus refunds);
     an item must have moved at least a small threshold so a brand-new product
     isn't crowned on its first sale. Only the products entering or leaving the
     top set are rewritten, so re-running after every sale barely churns rowver. */
  async function recomputeBestSellers(orgId) {
    const TOP_N = 6, MIN_UNITS = 2;
    try {
      let maxRowver = 0;
      await withOrg(orgId, async (client) => {
        const agg = await client.query(
          `SELECT ln->>'pid' AS pid,
                  SUM(COALESCE(NULLIF(ln->>'qty','')::numeric,1)
                      * CASE WHEN data->>'type'='refund' THEN -1 ELSE 1 END) AS sold
             FROM entities, jsonb_array_elements(data->'lines') AS ln
            WHERE org_id=$1 AND kind='sales' AND deleted=false
              AND jsonb_typeof(data->'lines')='array'
              AND updated_at > now() - interval '30 days'
            GROUP BY 1`, [orgId]);
        const top = new Set(agg.rows
          .map((r) => ({ pid: String(r.pid || ""), sold: Number(r.sold) || 0 }))
          .filter((r) => r.pid && r.sold >= MIN_UNITS)
          .sort((a, b) => b.sold - a.sold)
          .slice(0, TOP_N)
          .map((r) => r.pid));
        const cur = await client.query(
          "SELECT id FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false AND (data->>'bestSeller')::boolean IS TRUE", [orgId]);
        const curSet = new Set(cur.rows.map((r) => String(r.id)));
        const setTrue = [...top].filter((p) => !curSet.has(p));
        const clear = [...curSet].filter((p) => !top.has(p));
        for (const pid of setTrue) {
          const u = await client.query(
            `UPDATE entities SET data = data || jsonb_build_object('bestSeller', true),
               rowver = nextval('entities_rowver_seq'), updated_at = now()
             WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false RETURNING rowver`, [orgId, pid]);
          for (const row of u.rows) maxRowver = Math.max(maxRowver, Number(row.rowver));
        }
        for (const pid of clear) {
          const u = await client.query(
            `UPDATE entities SET data = data - 'bestSeller',
               rowver = nextval('entities_rowver_seq'), updated_at = now()
             WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false RETURNING rowver`, [orgId, pid]);
          for (const row of u.rows) maxRowver = Math.max(maxRowver, Number(row.rowver));
        }
      });
      if (maxRowver && poke) poke(orgId, maxRowver);
    } catch (e) { recordError("best-sellers recompute", e); }
  }

  /* Per-location balances, derived from the ledger. A move with a blank
     location belongs to the ingredient's home location, so the buckets always
     sum to current_stock and no history backfill is needed. */
  async function perLocation(client, orgId, ingredientId, homeLoc) {
    const r = await client.query(
      `SELECT COALESCE(NULLIF(location,''), $3) AS loc, SUM(qty) AS qty
       FROM stock_moves WHERE org_id=$1 AND ingredient_id=$2
       GROUP BY 1 HAVING SUM(qty) <> 0 ORDER BY 2 DESC`,
      [orgId, ingredientId, homeLoc]);
    return r.rows.map((x) => ({ location: x.loc, qty: Number(x.qty) }));
  }

  /* Item roles (§6): keep an ingredient's "sellable" role in step with a real
     till product + a 1:1 self-recipe. Selling one unit then deducts one base
     unit of the same item, and the availability engine flips it sold-out at
     zero — the item plays both roles off one stock figure. Returns the sync
     rowver to poke (0 when nothing changed). */
  async function syncResaleProduct(client, orgId, ingId, seed) {
    const ing = (await client.query(
      "SELECT id, name, sellable, sell_price, product_id, base_unit FROM ingredients WHERE org_id=$1 AND id=$2",
      [orgId, ingId])).rows[0];
    if (!ing) return 0;
    let rowver = 0;
    if (ing.sellable && Number(ing.sell_price) > 0) {
      const pid = ing.product_id || uid();
      const meta = (await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2", [orgId, pid])).rows[0];
      const prev = (meta && meta.data) || {};
      const data = Object.assign({}, prev, {
        id: pid, name: ing.name, price: Number(ing.sell_price),
        emoji: prev.emoji || (seed && seed.emoji) || "🥤",
        cat: prev.cat || (seed && seed.cat) || "Resale", unit: "pcs",
        srcRef: "resale:" + ingId,
      });
      const up = await client.query(
        `INSERT INTO entities (org_id, kind, id, data, deleted)
         VALUES ($1,'products',$2,$3,false)
         ON CONFLICT (org_id, kind, id) DO UPDATE SET
           data = excluded.data, deleted = false,
           rowver = nextval('entities_rowver_seq'), updated_at = now()
         RETURNING rowver`,
        [orgId, pid, JSON.stringify(data)]);
      rowver = up.rowCount ? Number(up.rows[0].rowver) : 0;
      await client.query(
        `INSERT INTO recipe_lines (org_id, id, product_id, ingredient_id, qty) VALUES ($1,$2,$3,$4,1)
         ON CONFLICT (org_id, product_id, ingredient_id) DO UPDATE SET qty=1`,
        [orgId, uid(), pid, ingId]);
      if (!ing.product_id) await client.query("UPDATE ingredients SET product_id=$3 WHERE org_id=$1 AND id=$2", [orgId, ingId, pid]);
    } else if (ing.product_id) {
      const del = await client.query(
        `UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now()
         WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false RETURNING rowver`,
        [orgId, ing.product_id]);
      rowver = del.rowCount ? Number(del.rows[0].rowver) : 0;
      await client.query("DELETE FROM recipe_lines WHERE org_id=$1 AND product_id=$2", [orgId, ing.product_id]);
    }
    return rowver;
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
          return { id, name: d.name || "Item", emoji: d.emoji || "", cat: d.cat || "General", price: num(d.price), img: d.img || "", allergens: d.allergens || "", addons: Array.isArray(d.addons) ? d.addons : [], spiceLevels: Array.isArray(d.spiceLevels) ? d.spiceLevels : [], comments: !!d.comments, noKitchen: !!d.noKitchen, hidden: !!d.hidden, desc: d.desc || "", recipeLines: recipeCounts[id] || 0, stockable: !!d.stockIngredientId };
        })
        .sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
      const sd = st.rowCount ? st.rows[0].data : {};
      return {
        currency: sd.currency || "MVR",
        storeName: sd.storeName || "",
        /* till writes its chosen theme into settings (see guest-sync-patch
           #30/31) so the back office can follow the same palette */
        theme: { name: sd.ktheme || "green", dark: sd.ktdark === true },
        /* owner-defined menu category order (applied on the till + guest menu);
           empty means "no custom order — fall back to insertion/default" */
        catOrder: Array.isArray(sd.catOrder) ? sd.catOrder : [],
        /* owner-defined two-level menu tree (main category -> sub categories),
           drives the till + guest two-row nav. [{name, subs:[...]}] */
        catGroups: Array.isArray(sd.catGroups) ? sd.catGroups : [],
        products,
      };
    });
    res.json(out);
  }));

  /* Persist the owner's menu category order into the shared settings entity.
     The till (ce.catOrder) and guest menu (A.catOrder) both read this and sort
     their category chips + sections by it, so one arrangement drives both. */
  router.put("/category-order", authAny, wrap(async (req, res) => {
    const order = Array.isArray(req.body && req.body.order)
      ? [...new Set(req.body.order.filter((c) => typeof c === "string").map((c) => c.trim()).filter(Boolean))].slice(0, 200)
      : [];
    const rowver = await withOrg(req.orgId, async (client) => {
      const row = (await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false FOR UPDATE", [req.orgId])).rows[0];
      const data = Object.assign({}, (row && row.data) || {});
      data.catOrder = order;
      const up = await client.query(
        `INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2)
         ON CONFLICT (org_id, kind, id) DO UPDATE SET data=$2, rowver=nextval('entities_rowver_seq'), updated_at=now()
         RETURNING rowver`, [req.orgId, JSON.stringify(data)]);
      return up.rows[0] ? Number(up.rows[0].rowver) : null;
    });
    if (poke && rowver) poke(req.orgId, rowver);
    res.json({ ok: true, order });
  }));

  /* Persist the owner's two-level menu tree (main category -> sub categories)
     into the shared settings entity. The till and guest menu read catGroups and
     render a two-row nav (main categories on top; the selected main's sub
     categories below). We also keep the flat catOrder in step (the concatenated
     sub order) so older/other readers stay consistent. Groups + subs are trimmed,
     de-duplicated and bounded. */
  router.put("/category-groups", authAny, wrap(async (req, res) => {
    const seenSub = new Set();
    const groups = (Array.isArray(req.body && req.body.groups) ? req.body.groups : [])
      .map((g) => {
        const name = String((g && g.name) || "").trim().slice(0, 40);
        const subs = [...new Set((Array.isArray(g && g.subs) ? g.subs : [])
          .map((s) => String(s || "").trim().slice(0, 40)).filter(Boolean))]
          .filter((s) => !seenSub.has(s) && seenSub.add(s)) // a sub belongs to one main
          .slice(0, 60);
        return { name, subs };
      })
      .filter((g) => g.name)
      .slice(0, 40);
    const order = groups.reduce((a, g) => a.concat(g.subs), []);
    /* Sub-category renames from the layout editor: move every product on the old
       label to the new one so items travel with their renamed sub category. */
    const renames = (req.body && req.body.renames && typeof req.body.renames === "object") ? req.body.renames : {};
    const rowver = await withOrg(req.orgId, async (client) => {
      let last = null;
      for (const from of Object.keys(renames)) {
        const to = String(renames[from] || "").trim().slice(0, 40);
        if (!to || to === from) continue;
        const mv = await client.query(
          `UPDATE entities SET data = jsonb_set(data, '{cat}', to_jsonb($3::text), true),
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind='products' AND deleted=false AND data->>'cat' = $2
           RETURNING rowver`, [req.orgId, from, to]);
        for (const row of mv.rows) last = Number(row.rowver);
      }
      const row = (await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false FOR UPDATE", [req.orgId])).rows[0];
      const data = Object.assign({}, (row && row.data) || {});
      data.catGroups = groups;
      data.catOrder = order;
      const up = await client.query(
        `INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2)
         ON CONFLICT (org_id, kind, id) DO UPDATE SET data=$2, rowver=nextval('entities_rowver_seq'), updated_at=now()
         RETURNING rowver`, [req.orgId, JSON.stringify(data)]);
      return up.rows[0] ? Number(up.rows[0].rowver) : last;
    });
    if (poke && rowver) poke(req.orgId, rowver);
    res.json({ ok: true, groups });
  }));

  /* Set (or clear) a menu item's photo from the back office. The till already
     resizes photos on upload; the back office does the same client-side, so we
     only accept a bounded image data URI here and write it onto the product
     entity — it then rides the normal sync stream onto every till tile and the
     guest menu. Passing an empty img clears the photo (back to the emoji). */
  router.put("/products/:id/image", authAny, wrap(async (req, res) => {
    const pid = req.params.id;
    const img = typeof (req.body && req.body.img) === "string" ? req.body.img : "";
    if (img && !/^data:image\/(png|jpe?g|webp);base64,/.test(img)) return res.status(400).json({ error: "expected an image" });
    if (img.length > 700000) return res.status(413).json({ error: "image too large — use a smaller photo" });
    const rowver = await withOrg(req.orgId, async (client) => {
      const row = (await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false FOR UPDATE", [req.orgId, pid])).rows[0];
      if (!row) return null;
      const data = Object.assign({}, row.data || {});
      if (img) data.img = img; else delete data.img;
      const up = await client.query(
        `UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now()
         WHERE org_id=$1 AND kind='products' AND id=$2 RETURNING rowver`,
        [req.orgId, pid, JSON.stringify(data)]);
      return up.rows[0] ? Number(up.rows[0].rowver) : null;
    });
    if (rowver == null) return res.status(404).json({ error: "unknown menu item" });
    if (poke) poke(req.orgId, rowver);
    res.json({ ok: true, rowver });
  }));

  /* Set a menu item's allergen note and add-on options (the guest item sheet
     shows both). Add-on prices arrive in MVR and are stored as laari, matching
     product.price. Empty values clear the field. */
  const cleanAddons = (arr) => (Array.isArray(arr) ? arr : [])
    .map((a) => ({ name: String((a && a.name) || "").trim().slice(0, 40), price: Math.max(0, Math.round(num(a && a.price) * 100)) }))
    .filter((a) => a.name).slice(0, 20);
  /* Spice levels are a free single-choice modifier (no price) — the owner names
     the options per item (e.g. "Non-spicy, Spicy" or "Mild, Medium, Hot"). */
  const cleanSpice = (arr) => (Array.isArray(arr) ? arr : [])
    .map((s) => String(s || "").trim().slice(0, 30)).filter(Boolean).slice(0, 8);
  router.put("/products/:id/meta", authAny, wrap(async (req, res) => {
    const pid = req.params.id, body = req.body || {};
    const cat = typeof body.cat === "string" ? body.cat.trim().slice(0, 40) : undefined;
    const allergens = typeof body.allergens === "string" ? body.allergens.slice(0, 200) : undefined;
    const addons = body.addons !== undefined ? cleanAddons(body.addons) : undefined;
    const spiceLevels = body.spiceLevels !== undefined ? cleanSpice(body.spiceLevels) : undefined;
    const comments = body.comments !== undefined ? !!body.comments : undefined;
    const noKitchen = body.noKitchen !== undefined ? !!body.noKitchen : undefined;
    const hidden = body.hidden !== undefined ? !!body.hidden : undefined;
    const rowver = await withOrg(req.orgId, async (client) => {
      const row = (await client.query("SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false FOR UPDATE", [req.orgId, pid])).rows[0];
      if (!row) return null;
      const data = Object.assign({}, row.data || {});
      if (cat !== undefined && cat) data.cat = cat; // reassign to a sub category
      if (allergens !== undefined) { if (allergens.trim()) data.allergens = allergens.trim(); else delete data.allergens; }
      if (addons !== undefined) { if (addons.length) data.addons = addons; else delete data.addons; }
      if (spiceLevels !== undefined) { if (spiceLevels.length) data.spiceLevels = spiceLevels; else delete data.spiceLevels; }
      if (comments !== undefined) { if (comments) data.comments = true; else delete data.comments; }
      if (noKitchen !== undefined) { if (noKitchen) data.noKitchen = true; else delete data.noKitchen; }
      if (hidden !== undefined) { if (hidden) data.hidden = true; else delete data.hidden; }
      const up = await client.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND id=$2 RETURNING rowver", [req.orgId, pid, JSON.stringify(data)]);
      return up.rows[0] ? Number(up.rows[0].rowver) : null;
    });
    if (rowver == null) return res.status(404).json({ error: "unknown menu item" });
    if (poke) poke(req.orgId, rowver);
    res.json({ ok: true, rowver });
  }));

  /* Bulk restock: set every menu item's stock to a quantity, or clear it so the
     items go back to always-available (stock-untracked). Handy to recover a whole
     menu that has been driven to "sold out". Writes onto the products entities so
     it rides the sync stream to the till tiles and guest menu. */
  router.post("/products/restock", authAny, wrap(async (req, res) => {
    const body = req.body || {};
    const clear = body.clear === true;
    const qty = clear ? null : Math.max(0, Math.round(num(body.qty)));
    const rowver = await withOrg(req.orgId, async (client) => {
      const r = clear
        ? await client.query(
            `UPDATE entities SET data = data - 'stock', rowver=nextval('entities_rowver_seq'), updated_at=now()
             WHERE org_id=$1 AND kind='products' AND deleted=false AND data ? 'stock' RETURNING rowver`, [req.orgId])
        : await client.query(
            `UPDATE entities SET data = jsonb_set(data, '{stock}', to_jsonb($2::numeric), true), rowver=nextval('entities_rowver_seq'), updated_at=now()
             WHERE org_id=$1 AND kind='products' AND deleted=false RETURNING rowver`, [req.orgId, qty]);
      let mx = 0; for (const row of r.rows) mx = Math.max(mx, Number(row.rowver));
      return { count: r.rowCount, rowver: mx };
    });
    if (poke && rowver.rowver) poke(req.orgId, rowver.rowver);
    res.json({ ok: true, count: rowver.count, qty: clear ? null : qty });
  }));

  /* ── Outlets (stores) ───────────────────────────────────────────────────
     Manage the org's outlets from the back office. Every outlet automatically
     shares the org-level menu, categories and customers (they're seeded/held as
     global), so a new outlet opens with the same menu — the till just pulls its
     own store-scoped orders. Cookie-auth (authAny) so the owner console reaches
     it. */
  const storeSlug = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  router.get("/stores", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const r = await client.query(
        "SELECT id, code, name, address, active FROM stores WHERE org_id=$1 ORDER BY created_at ASC", [req.orgId]);
      const st = await client.query(
        "SELECT data->'outletPrefs' AS p FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false", [req.orgId]);
      return { stores: r.rows, prefs: (st.rows[0] && st.rows[0].p) || {} };
    });
    res.json({ stores: out.stores, prefs: out.prefs, defaultStoreId: "main" });
  }));

  /* Per-outlet operating preferences (owner-set): floatLogout = auto sign-out to
     the PIN lock after each completed sale (shared-terminal "float" mode);
     ownTablesOnly = waiters see only their own open tables/tickets. Stored on the
     shared settings entity keyed by store id (settings.outletPrefs[storeId]); the
     till reads its own outlet's prefs from the synced settings. */
  router.post("/stores/:id/prefs", authAny, wrap(async (req, res) => {
    const sid = String(req.params.id || "").slice(0, 32);
    const body = req.body || {};
    const rowver = await withOrg(req.orgId, async (client) => {
      const row = (await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false FOR UPDATE", [req.orgId])).rows[0];
      const data = Object.assign({}, (row && row.data) || {});
      const prefs = Object.assign({}, data.outletPrefs || {});
      const cur = Object.assign({}, prefs[sid] || {});
      if (body.floatLogout !== undefined) cur.floatLogout = !!body.floatLogout;
      if (body.ownTablesOnly !== undefined) cur.ownTablesOnly = !!body.ownTablesOnly;
      if (body.idleLockSec !== undefined) {
        const n = Math.max(0, Math.min(3600, Math.round(num(body.idleLockSec))));
        if (n) cur.idleLockSec = n; else delete cur.idleLockSec;
      }
      // drop empty entries to keep the map tidy
      if (!cur.floatLogout && !cur.ownTablesOnly && !cur.idleLockSec) delete prefs[sid]; else prefs[sid] = cur;
      data.outletPrefs = prefs;
      const up = await client.query(
        `INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2)
         ON CONFLICT (org_id, kind, id) DO UPDATE SET data=$2, rowver=nextval('entities_rowver_seq'), updated_at=now()
         RETURNING rowver`, [req.orgId, JSON.stringify(data)]);
      return up.rows[0] ? Number(up.rows[0].rowver) : null;
    });
    if (poke && rowver) poke(req.orgId, rowver);
    res.json({ ok: true });
  }));
  router.post("/stores", authAny, wrap(async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "outlet name required" });
    const id = storeSlug(body.id || name) || ("store-" + Date.now().toString(36));
    const code = (String(body.code || id).toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 16)) || "STORE";
    const address = String(body.address || "").slice(0, 200);
    const r = await withOrg(req.orgId, (client) => client.query(
      `INSERT INTO stores (org_id, id, code, name, address) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, id) DO UPDATE SET code=excluded.code, name=excluded.name, address=excluded.address, active=true
       RETURNING id, code, name, address, active`,
      [req.orgId, id, code, name, address]));
    res.json({ store: r.rows[0] });
  }));
  router.post("/stores/:id/active", authAny, wrap(async (req, res) => {
    const active = !!(req.body && req.body.active);
    const out = await withOrg(req.orgId, async (client) => {
      if (!active) {
        const n = (await client.query("SELECT count(*)::int AS c FROM stores WHERE org_id=$1 AND active=true AND id<>$2", [req.orgId, req.params.id])).rows[0].c;
        if (n < 1) return { guard: true };
      }
      const r = await client.query("UPDATE stores SET active=$3 WHERE org_id=$1 AND id=$2 RETURNING id, active", [req.orgId, req.params.id, active]);
      return { store: r.rows[0] };
    });
    if (out.guard) return res.status(400).json({ error: "keep at least one outlet open" });
    if (!out.store) return res.status(404).json({ error: "outlet not found" });
    res.json({ ok: true, store: out.store });
  }));

  /* ── Menu import / export (Excel) ───────────────────────────────────────
     Download a template or the live menu as .xlsx, edit in any spreadsheet
     app, and re-import to bulk create/update items. Import matches rows to
     products by SKU/ID (falling back to a slug of the name), so the same file
     round-trips: export → edit → import updates the same items. */
  const sendXlsx = (res, name, buf) => {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(buf);
  };
  router.get("/menu/template.xlsx", authAny, wrap(async (req, res) => {
    sendXlsx(res, "menu-import-template.xlsx", buildXlsx([
      MENU_COLS,
      ["AMI-EX-001", "Beef Burger", "Food", 45, "Yes", 30, "https://example.com/photo.jpg", "🍔", "Juicy beef patty, melted cheese, fresh veg.", "Beef, Gluten", "Extra meat:4, Extra cheese:1, Extra sauce:1"],
      ["AMI-EX-002", "Still Water", "Drinks", 10, "No", 30, "", "💧", "", "", ""],
    ]));
  }));
  router.get("/menu/export.xlsx", authAny, wrap(async (req, res) => {
    sendXlsx(res, "menu-export.xlsx", buildXlsx([MENU_COLS, ...await menuRows(req.orgId)]));
  }));
  router.post("/menu/import", authAny, wrap(async (req, res) => {
    const src = String((req.body && req.body.file) || "");
    const b64 = (src.match(/^data:[^;]*;base64,(.*)$/) || [, src])[1];
    let rows;
    try { rows = parseXlsx(Buffer.from(b64, "base64")); }
    catch (e) { return res.status(400).json({ error: "couldn't read that .xlsx file — use the template" }); }
    const header = (rows[0] || []).map((h) => String(h || "").toLowerCase());
    const find = (...keys) => header.findIndex((h) => keys.some((k) => h.includes(k)));
    const ci = { id: find("sku", "id"), name: find("name"), cat: find("categ"), price: find("price"), tax: find("tax"), stock: find("stock"), img: find("image", "photo", "img", "url"), emoji: find("emoji"), desc: find("desc"), allergens: find("allerg"), addons: find("add-on", "addon", "add on", "extras") };
    if (ci.name < 0) return res.status(400).json({ error: "no 'Name' column found — start from the template" });
    const cell = (row, i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : "");
    const items = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]; if (!row) continue;
      const name = cell(row, ci.name); if (!name) continue;
      items.push({
        id: cell(row, ci.id), name, cat: cell(row, ci.cat),
        price: ci.price >= 0 ? num(String(row[ci.price]).replace(/[^0-9.]/g, "")) : 0,
        taxable: ci.tax < 0 ? true : !/^(no|n|zero|false|0|exempt)/i.test(cell(row, ci.tax)),
        stock: ci.stock >= 0 && cell(row, ci.stock) !== "" ? num(String(row[ci.stock]).replace(/[^0-9.-]/g, "")) : null,
        img: cell(row, ci.img), emoji: cell(row, ci.emoji), desc: cell(row, ci.desc),
        allergens: cell(row, ci.allergens), addons: ci.addons >= 0 ? cellToAddons(cell(row, ci.addons)) : null,
      });
    }
    if (!items.length) return res.status(400).json({ error: "no rows with a Name to import" });
    const replace = !!(req.body && req.body.replace);
    const out = await withOrg(req.orgId, async (client) => {
      const ex = await client.query("SELECT id FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [req.orgId]);
      const exIds = new Set(ex.rows.map((r) => String(r.id)));
      const keep = new Set(); let maxRowver = 0, created = 0, updated = 0, removed = 0;
      for (const it of items) {
        const pid = it.id || menuIdFromName(it.name); keep.add(pid);
        const prev = (await client.query("SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2", [req.orgId, pid])).rows[0];
        const base = (prev && prev.data) || {};
        const data = Object.assign({}, base, {
          id: pid, name: it.name, cat: it.cat || base.cat || "General",
          price: Math.round((it.price || 0) * 100), unit: base.unit || "pcs", taxable: it.taxable,
          emoji: it.emoji || base.emoji || "🍽️",
        });
        if (it.stock != null) data.stock = it.stock;      // blank stock keeps the current level
        if (it.img !== "") data.img = it.img;             // blank image/description keeps the current value
        if (it.desc !== "") data.desc = it.desc;
        if (it.allergens !== "") data.allergens = it.allergens;
        if (it.addons != null && it.addons.length) data.addons = it.addons;   // only replace add-ons when the cell has some
        const up = await client.query(
          `INSERT INTO entities (org_id, kind, id, data, deleted) VALUES ($1,'products',$2,$3,false)
           ON CONFLICT (org_id, kind, id) DO UPDATE SET data=$3, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()
           RETURNING rowver`, [req.orgId, pid, JSON.stringify(data)]);
        maxRowver = Math.max(maxRowver, Number(up.rows[0].rowver));
        exIds.has(pid) ? updated++ : created++;
      }
      if (replace) for (const id of exIds) if (!keep.has(id)) {
        const d = await client.query("UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND id=$2 RETURNING rowver", [req.orgId, id]);
        if (d.rows[0]) { maxRowver = Math.max(maxRowver, Number(d.rows[0].rowver)); removed++; }
      }
      return { maxRowver, created, updated, removed };
    });
    if (out.maxRowver && poke) poke(req.orgId, out.maxRowver);
    res.json({ ok: true, created: out.created, updated: out.updated, removed: out.removed, total: items.length });
  }));

  /* ── Ingredients ──────────────────────────────────────────────────────── */
  router.get("/ingredients", authAny, wrap(async (req, res) => {
    const rows = await withOrg(req.orgId, async (client) => {
      const ing = await client.query(
        "SELECT id, name, sku, base_unit, current_stock, min_stock, avg_cost, location, sellable, sell_price, producible FROM ingredients WHERE org_id=$1 AND active ORDER BY location, name",
        [req.orgId]);
      const units = await client.query(
        "SELECT ingredient_id, name, factor FROM ingredient_units WHERE org_id=$1", [req.orgId]);
      return ing.rows.map((i) => ({
        ...i,
        current_stock: Number(i.current_stock), min_stock: Number(i.min_stock), avg_cost: Number(i.avg_cost),
        sellable: i.sellable === true, sell_price: Number(i.sell_price), producible: i.producible === true,
        low: Number(i.min_stock) > 0 && Number(i.current_stock) <= Number(i.min_stock),
        units: units.rows.filter((u) => u.ingredient_id === i.id).map((u) => ({ name: u.name, factor: Number(u.factor) })),
      }));
    });
    res.json({ ingredients: rows });
  }));

  router.post("/ingredients", authAny, wrap(async (req, res) => {
    const { id, name, sku, baseUnit, minStock, location, units, sellable, sellPrice, sellEmoji, sellCat, producible, prepLines } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "ingredient name required" });
    const base = ["g", "ml", "pcs"].includes(baseUnit) ? baseUnit : "g";
    const ingId = id || uid();
    const willSell = sellable === true && num(sellPrice) > 0;
    const cleanPrep = Array.isArray(prepLines) ? prepLines.filter((l) => l && l.ingredientId && String(l.ingredientId) !== String(ingId) && num(l.qty) > 0) : [];
    const willPrep = producible === true && cleanPrep.length > 0;
    const out = await withOrg(req.orgId, async (client) => {
      await client.query(
        `INSERT INTO ingredients (org_id, id, name, sku, base_unit, min_stock, location, sellable, sell_price, producible)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (org_id, id) DO UPDATE SET
           name=excluded.name, sku=excluded.sku, min_stock=excluded.min_stock,
           location=excluded.location, sellable=excluded.sellable, sell_price=excluded.sell_price,
           producible=excluded.producible, active=true, updated_at=now()`,
        [req.orgId, ingId, String(name).trim(), String(sku || "").trim(), base, num(minStock), String(location || "Dry"), willSell, Math.round(num(sellPrice)), willPrep]);
      if (Array.isArray(units)) {
        await client.query("DELETE FROM ingredient_units WHERE org_id=$1 AND ingredient_id=$2", [req.orgId, ingId]);
        for (const u of units) {
          if (!u || !u.name || !(num(u.factor) > 0)) continue;
          await client.query(
            "INSERT INTO ingredient_units (org_id, id, ingredient_id, name, factor) VALUES ($1,$2,$3,$4,$5)",
            [req.orgId, uid(), ingId, String(u.name).trim(), num(u.factor)]);
        }
      }
      /* The prep recipe lives in recipe_lines keyed by the item's own id.
         Rewrite it whenever the producible role is present; clear it if the
         role was turned off (only when prepLines was explicitly sent, so a
         plain edit that omits it leaves an existing recipe untouched). */
      if (producible !== undefined) {
        await client.query("DELETE FROM recipe_lines WHERE org_id=$1 AND product_id=$2", [req.orgId, ingId]);
        for (const l of cleanPrep) {
          await client.query(
            "INSERT INTO recipe_lines (org_id, id, product_id, ingredient_id, qty) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, product_id, ingredient_id) DO UPDATE SET qty=excluded.qty",
            [req.orgId, uid(), ingId, String(l.ingredientId), num(l.qty)]);
        }
      }
      /* Seed the linked product's emoji/category on first enable so the till
         tile looks right; syncResaleProduct preserves the till's own edits
         (prev.emoji/cat) on later saves. */
      return await syncResaleProduct(client, req.orgId, ingId, { emoji: sellEmoji, cat: sellCat });
    });
    if (out && poke) poke(req.orgId, out);
    if (willSell) await recomputeAvailability(req.orgId, [String(ingId)]);
    res.json({ ok: true, id: ingId });
  }));

  router.delete("/ingredients/:id", authAny, wrap(async (req, res) => {
    const rowver = await withOrg(req.orgId, async (client) => {
      /* Drop the sellable role too, so its till tile disappears with it. */
      await client.query("UPDATE ingredients SET sellable=false, sell_price=0 WHERE org_id=$1 AND id=$2", [req.orgId, req.params.id]);
      const rv = await syncResaleProduct(client, req.orgId, req.params.id);
      /* Drop its prep recipe (keyed by its own id) and the producible role. */
      await client.query("DELETE FROM recipe_lines WHERE org_id=$1 AND product_id=$2", [req.orgId, req.params.id]);
      await client.query(
        "UPDATE ingredients SET active=false, producible=false, updated_at=now() WHERE org_id=$1 AND id=$2", [req.orgId, req.params.id]);
      return rv;
    });
    if (rowver && poke) poke(req.orgId, rowver);
    res.json({ ok: true });
  }));

  /* ── Stock history / movement timeline (§12) ────────────────────────────
     Every movement of an ingredient, straight from the immutable ledger, so
     the owner can read "what came in, where it went, and what's left" without
     any accounting. The running balance is derived, never stored. */
  router.get("/history/:ingredientId", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const ing = await client.query(
        "SELECT id, name, base_unit, current_stock, avg_cost, location FROM ingredients WHERE org_id=$1 AND id=$2",
        [req.orgId, req.params.ingredientId]);
      if (!ing.rowCount) throw Object.assign(new Error("ingredient not found"), { status: 404 });
      const i = ing.rows[0];
      const mv = await client.query(
        `SELECT id, kind, qty, unit_cost, ref, note, location, created_at
         FROM stock_moves WHERE org_id=$1 AND ingredient_id=$2 ORDER BY created_at ASC, id ASC LIMIT 500`,
        [req.orgId, req.params.ingredientId]);
      return {
        ingredient: { id: i.id, name: i.name, baseUnit: i.base_unit, currentStock: Number(i.current_stock), avgCost: Number(i.avg_cost), location: i.location },
        moves: mv.rows.map((m) => ({ id: m.id, kind: m.kind, qty: Number(m.qty), unitCost: Number(m.unit_cost), ref: m.ref, note: m.note, location: m.location || i.location, at: m.created_at })),
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

  /* ── Per-location balances & transfers ──────────────────────────────────
     Where an ingredient physically sits. Balances are derived from the ledger
     so there's nothing extra to keep in sync; a transfer just redistributes
     the same total between two shelves. */
  router.get("/locations/:ingredientId", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const ing = (await client.query(
        "SELECT id, name, base_unit, current_stock, location FROM ingredients WHERE org_id=$1 AND id=$2 AND active",
        [req.orgId, req.params.ingredientId])).rows[0];
      if (!ing) throw Object.assign(new Error("ingredient not found"), { status: 404 });
      const units = (await client.query(
        "SELECT name, factor FROM ingredient_units WHERE org_id=$1 AND ingredient_id=$2", [req.orgId, ing.id])).rows
        .map((u) => ({ name: u.name, factor: Number(u.factor) }));
      return {
        ingredient: { id: ing.id, name: ing.name, baseUnit: ing.base_unit, currentStock: Number(ing.current_stock), home: ing.location, units },
        breakdown: await perLocation(client, req.orgId, ing.id, ing.location),
      };
    });
    res.json(out);
  }));

  router.post("/transfer", authAny, wrap(async (req, res) => {
    const { ingredientId, fromLoc, toLoc, qty, unitName, reason } = req.body || {};
    if (!ingredientId) return res.status(400).json({ error: "which ingredient?" });
    if (!fromLoc || !toLoc) return res.status(400).json({ error: "pick where it's moving from and to" });
    if (fromLoc === toLoc) return res.status(400).json({ error: "pick two different locations" });
    if (!(num(qty) > 0)) return res.status(400).json({ error: "enter how much to move" });

    const out = await withOrg(req.orgId, async (client) => {
      const ing = (await client.query(
        "SELECT id, name, base_unit, avg_cost, location FROM ingredients WHERE org_id=$1 AND id=$2 AND active FOR UPDATE",
        [req.orgId, ingredientId])).rows[0];
      if (!ing) throw Object.assign(new Error("ingredient not found"), { status: 404 });
      const factor = await factorFor(client, req.orgId, ingredientId, unitName);
      const base = round3(num(qty) * factor);
      const balances = await perLocation(client, req.orgId, ingredientId, ing.location);
      const have = (balances.find((b) => b.location === fromLoc) || { qty: 0 }).qty;
      if (base > have + 1e-9) {
        throw Object.assign(new Error(`Only ${round3(have)} ${ing.base_unit} of ${ing.name} is in ${fromLoc} — you can't move more than that.`), { status: 400 });
      }
      const avg = Number(ing.avg_cost);
      const noteBase = `${fromLoc} → ${toLoc}`;
      const note = String(reason || "").trim() ? `${noteBase} · ${String(reason).trim().slice(0, 100)}` : noteBase;
      /* Two net-zero legs: the total stock (current_stock) never changes. */
      await client.query(
        "INSERT INTO stock_moves (org_id, id, ingredient_id, kind, qty, unit_cost, location, note) VALUES ($1,$2,$3,'transfer',$4,$5,$6,$7)",
        [req.orgId, uid(), ingredientId, round3(-base), avg, fromLoc, note]);
      await client.query(
        "INSERT INTO stock_moves (org_id, id, ingredient_id, kind, qty, unit_cost, location, note) VALUES ($1,$2,$3,'transfer',$4,$5,$6,$7)",
        [req.orgId, uid(), ingredientId, base, avg, toLoc, note]);
      return { name: ing.name, baseUnit: ing.base_unit, moved: base, fromLoc, toLoc, breakdown: await perLocation(client, req.orgId, ingredientId, ing.location) };
    });
    res.json(Object.assign({ ok: true }, out));
  }));

  /* ── Make a batch of a prep item (§6 producible role) ───────────────────
     "Made in-house" items (dough, sauce, cold brew) are built from other
     ingredients. Producing a batch consumes the components (ledger 'prep')
     and stocks the finished item (ledger 'produce'), rolling the components'
     cost into the prep item's weighted-average cost — the same number recipes
     and COGS already trust. The build recipe is stored in recipe_lines keyed
     by the prep item's own id, with qty = components per ONE base unit made. */
  router.post("/produce", authAny, wrap(async (req, res) => {
    const { ingredientId, qty, unitName } = req.body || {};
    if (!ingredientId) return res.status(400).json({ error: "which item are you making?" });
    if (!(num(qty) > 0)) return res.status(400).json({ error: "enter how much you made" });

    const out = await withOrg(req.orgId, async (client) => {
      const ing = (await client.query(
        "SELECT id, name, base_unit, current_stock, avg_cost, producible FROM ingredients WHERE org_id=$1 AND id=$2 AND active FOR UPDATE",
        [req.orgId, ingredientId])).rows[0];
      if (!ing) throw Object.assign(new Error("ingredient not found"), { status: 404 });
      const comps = (await client.query(
        `SELECT rl.ingredient_id, rl.qty, i.name, i.base_unit, i.current_stock, i.avg_cost
         FROM recipe_lines rl JOIN ingredients i ON i.org_id=rl.org_id AND i.id=rl.ingredient_id
         WHERE rl.org_id=$1 AND rl.product_id=$2 AND i.active`, [req.orgId, ingredientId])).rows;
      if (!comps.length) throw Object.assign(new Error(`${ing.name} has no recipe yet — add what it's made from first.`), { status: 400 });

      const factor = await factorFor(client, req.orgId, ingredientId, unitName);
      const outputBase = round3(num(qty) * factor);
      /* Check every component is in stock before touching anything. */
      const plan = comps.map((c) => ({ c, need: round3(Number(c.qty) * outputBase) }));
      for (const { c, need } of plan) {
        if (need > Number(c.current_stock) + 1e-9) {
          throw Object.assign(new Error(`Not enough ${c.name}: this batch needs ${round3(need)} ${c.base_unit} but only ${round3(Number(c.current_stock))} is in stock.`), { status: 400 });
        }
      }
      const ref = "produce:" + uid();
      let batchCost = 0;
      for (const { c, need } of plan) {
        const cAvg = Number(c.avg_cost);
        batchCost += need * cAvg;
        await client.query(
          "INSERT INTO stock_moves (org_id, id, ingredient_id, kind, qty, unit_cost, ref, note) VALUES ($1,$2,$3,'prep',$4,$5,$6,$7)",
          [req.orgId, uid(), c.ingredient_id, round3(-need), cAvg, ref, "used to make " + ing.name]);
        await client.query(
          "UPDATE ingredients SET current_stock = current_stock - $3, updated_at=now() WHERE org_id=$1 AND id=$2",
          [req.orgId, c.ingredient_id, need]);
      }
      batchCost = Math.round(batchCost);
      const stock = Number(ing.current_stock), avg = Number(ing.avg_cost);
      const posStock = Math.max(stock, 0);
      const newAvg = (posStock + outputBase) > 0 ? (posStock * avg + batchCost) / (posStock + outputBase) : avg;
      const unitCost = outputBase > 0 ? batchCost / outputBase : 0;
      await client.query(
        "INSERT INTO stock_moves (org_id, id, ingredient_id, kind, qty, unit_cost, ref, note) VALUES ($1,$2,$3,'produce',$4,$5,$6,$7)",
        [req.orgId, uid(), ingredientId, outputBase, unitCost, ref, "made a batch"]);
      await client.query(
        "UPDATE ingredients SET current_stock = current_stock + $3, avg_cost=$4, producible=true, updated_at=now() WHERE org_id=$1 AND id=$2",
        [req.orgId, ingredientId, outputBase, newAvg]);
      return {
        name: ing.name, baseUnit: ing.base_unit, made: outputBase,
        newStock: round3(stock + outputBase), batchCost, unitCost: round3(unitCost),
        components: plan.map(({ c, need }) => ({ name: c.name, used: need, baseUnit: c.base_unit })),
        touched: comps.map((c) => String(c.ingredient_id)).concat([String(ingredientId)]),
      };
    });
    /* The prep item's stock rose and its components fell, so any menu item
       that uses either must re-derive how many servings remain. */
    await recomputeAvailability(req.orgId, out.touched);
    res.json(Object.assign({ ok: true }, out));
  }));

  /* ── Scan a delivery note (§13, OCR) ────────────────────────────────────
     Photograph a supplier's delivery note / invoice and let a vision model
     read the line items, so the owner reviews a pre-filled delivery instead of
     typing it. The model is given the store's ingredient catalogue and maps
     each printed line to an existing ingredient (or leaves it for the owner to
     pick), and returns the pack unit + quantity + line total it read. Nothing
     is written here — the endpoint returns a draft the UI posts through the
     normal /invoices path once the owner confirms.

     Needs ANTHROPIC_API_KEY in the environment; without it the endpoint says
     so plainly rather than failing, and the rest of Deliveries is unaffected. */
  let _anthropic; // lazily constructed so a missing SDK/key never blocks boot
  function anthropicClient() {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    if (_anthropic === undefined) {
      try { const Anthropic = require("@anthropic-ai/sdk"); _anthropic = new (Anthropic.default || Anthropic)(); }
      catch (e) { recordError("anthropic sdk load", e); _anthropic = null; }
    }
    return _anthropic;
  }

  const OCR_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
      supplier: { type: "string", description: "Supplier / vendor name printed on the note, or empty string" },
      invoiceNo: { type: "string", description: "Invoice or delivery-note number, or empty string" },
      date: { type: "string", description: "Date on the note as printed, or empty string" },
      lines: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            description: { type: "string", description: "The item text exactly as printed" },
            ingredientId: { type: "string", description: "The id of the best-matching ingredient from the catalogue, or empty string if none is a clear match" },
            unitName: { type: "string", description: "The pack unit name from that ingredient's catalogue that matches how this line is sold (e.g. Case), or empty string for the base unit" },
            qty: { type: "number", description: "How many of that unit were delivered" },
            lineTotal: { type: "number", description: "The total money for this line in the note's currency (0 if not printed)" },
          },
          required: ["description", "ingredientId", "unitName", "qty", "lineTotal"],
        },
      },
    },
    required: ["supplier", "invoiceNo", "date", "lines"],
  };

  router.post("/ocr", authAny, wrap(async (req, res) => {
    const client = anthropicClient();
    if (!client) {
      return res.json({ ok: true, configured: false, message: "Scanning isn't set up yet. Add an ANTHROPIC_API_KEY to turn it on — or enter this delivery by hand below." });
    }
    let { image, mediaType } = req.body || {};
    if (!image) return res.status(400).json({ error: "no image" });
    /* Accept a data URL or a bare base64 payload. */
    const m = /^data:([^;]+);base64,(.*)$/s.exec(String(image));
    if (m) { mediaType = m[1]; image = m[2]; }
    mediaType = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType) ? mediaType : "image/jpeg";

    const cat = await withOrg(req.orgId, async (dbc) => {
      const ing = await dbc.query("SELECT id, name, base_unit FROM ingredients WHERE org_id=$1 AND active ORDER BY name", [req.orgId]);
      const units = await dbc.query("SELECT ingredient_id, name FROM ingredient_units WHERE org_id=$1", [req.orgId]);
      return ing.rows.map((i) => {
        const packs = units.rows.filter((u) => u.ingredient_id === i.id).map((u) => u.name);
        return { id: i.id, name: i.name, base_unit: i.base_unit, packs };
      });
    });
    const catalogue = cat.map((i) => `${i.id} | ${i.name} | base unit ${i.base_unit}${i.packs.length ? " | packs: " + i.packs.join(", ") : ""}`).join("\n") || "(no ingredients yet)";

    let parsed;
    try {
      const model = process.env.OCR_MODEL || "claude-opus-4-8";
      const msg = await client.messages.create({
        model,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        system:
          "You read a photographed supplier delivery note or invoice and return its line items as data. " +
          "Only report what is printed — never invent items, quantities or prices. " +
          "Match each printed line to the single best ingredient from the catalogue the user provides; " +
          "use that ingredient's exact id. If no catalogue ingredient clearly matches, leave ingredientId empty. " +
          "When a line is sold by a pack that matches one of that ingredient's pack names, put that pack name in unitName; otherwise leave unitName empty (the base unit).",
        output_config: { format: { type: "json_schema", schema: OCR_SCHEMA } },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: "Ingredient catalogue (id | name | base unit | packs):\n" + catalogue + "\n\nRead this delivery note and return its supplier, invoice number, date and line items." },
          ],
        }],
      });
      if (msg.stop_reason === "refusal") throw Object.assign(new Error("The scanner declined to read that image."), { status: 422 });
      const txt = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      parsed = JSON.parse(txt);
    } catch (e) {
      recordError("ocr delivery note", e);
      return res.status(e.status === 422 ? 422 : 502).json({ error: e.status === 422 ? e.message : "Couldn't read that photo — try a clearer, straight-on shot, or enter the delivery by hand." });
    }

    const byId = new Map(cat.map((i) => [String(i.id), i]));
    const lines = (parsed.lines || []).map((l) => {
      const ing = l.ingredientId && byId.get(String(l.ingredientId));
      return {
        description: String(l.description || "").slice(0, 200),
        ingredientId: ing ? ing.id : "",
        ingredientName: ing ? ing.name : "",
        unitName: ing && l.unitName && ing.packs.includes(l.unitName) ? l.unitName : "",
        qty: num(l.qty) > 0 ? num(l.qty) : 1,
        cost: Math.max(0, Math.round(num(l.lineTotal) * 100)), // note currency → laari
      };
    }).filter((l) => l.description);

    res.json({ ok: true, configured: true, supplier: String(parsed.supplier || ""), invoiceNo: String(parsed.invoiceNo || ""), date: String(parsed.date || ""), lines });
  }));

  /* ── Insights: learn each item's rhythm from its own ledger (§19) ────────
     No model, no training — just read the immutable stock_moves history and
     work out how fast each ingredient is actually being used, how long the
     current stock will last, and what's worth ordering or watching. This is
     the "behaviour learning" the store already paid for by recording every
     movement; the AI assistant (§18) then narrates and answers questions on
     top of exactly these numbers. */
  const REORDER_AT_DAYS = 7;   // flag when cover drops below a week
  const REORDER_TO_DAYS = 21;  // top back up to about three weeks
  async function computeInsights(orgId) {
    return withOrg(orgId, async (client) => {
      const settings = await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false", [orgId]);
      const currency = (settings.rowCount && settings.rows[0].data.currency) || "MVR";
      const ing = await client.query(
        "SELECT id, name, base_unit, current_stock, min_stock, avg_cost FROM ingredients WHERE org_id=$1 AND active", [orgId]);
      const units = await client.query("SELECT ingredient_id, name, factor FROM ingredient_units WHERE org_id=$1", [orgId]);
      /* Outflow (what got consumed) and wastage per ingredient over the window,
         plus the first move seen so a young store isn't judged over a full 30
         days it hasn't lived yet. */
      const mv = await client.query(
        `SELECT ingredient_id,
            SUM(CASE WHEN kind IN ('sale','prep','waste') AND qty < 0 THEN -qty ELSE 0 END) AS used,
            SUM(CASE WHEN kind='waste' THEN -qty ELSE 0 END) AS wasted,
            MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM stock_moves
         WHERE org_id=$1 AND created_at > now() - interval '30 days'
         GROUP BY ingredient_id`, [orgId]);
      const lastEver = await client.query(
        "SELECT ingredient_id, MAX(created_at) AS last_at FROM stock_moves WHERE org_id=$1 GROUP BY ingredient_id", [orgId]);
      const byIng = new Map(mv.rows.map((r) => [r.ingredient_id, r]));
      const lastByIng = new Map(lastEver.rows.map((r) => [r.ingredient_id, r.last_at]));
      const now = Date.now();

      const items = ing.rows.map((i) => {
        const m = byIng.get(i.id);
        const packs = units.rows.filter((u) => u.ingredient_id === i.id).map((u) => ({ name: u.name, factor: Number(u.factor) }));
        const used = m ? Number(m.used) : 0;
        const wasted = m ? Number(m.wasted) : 0;
        const firstAt = m && m.first_at ? new Date(m.first_at).getTime() : now;
        const days = Math.min(30, Math.max(1, Math.round((now - firstAt) / 86400000) + 1));
        const dailyRate = round3(used / days);
        const stock = Number(i.current_stock);
        const daysCover = dailyRate > 0 ? Math.floor(stock / dailyRate) : null; // null = not moving
        const lastMoveAt = lastByIng.get(i.id) || null;
        const idleDays = lastMoveAt ? Math.round((now - new Date(lastMoveAt).getTime()) / 86400000) : null;
        return {
          id: i.id, name: i.name, baseUnit: i.base_unit, stock: round3(stock), minStock: Number(i.min_stock),
          avgCost: Number(i.avg_cost), dailyRate, daysCover, used: round3(used), wasted: round3(wasted),
          wastePct: used > 0 ? Math.round((wasted / used) * 100) : 0, idleDays, packs,
        };
      });

      /* Reorder list: cover under a week (or already below the alert level), and
         actually moving. Suggest enough to reach the target cover, expressed in
         the largest pack that fits so it reads like "order 2 Cases". */
      const reorder = items.filter((it) => it.dailyRate > 0 && (it.daysCover != null && it.daysCover < REORDER_AT_DAYS))
        .map((it) => {
          const need = Math.max(0, round3(it.dailyRate * REORDER_TO_DAYS - it.stock));
          const pack = it.packs.slice().sort((a, b) => b.factor - a.factor).find((p) => p.factor <= need) || null;
          const suggestUnit = pack ? pack.name : it.baseUnit;
          const suggestQty = pack ? Math.max(1, Math.ceil(need / pack.factor)) : Math.ceil(need);
          const orderedBase = pack ? suggestQty * pack.factor : suggestQty;
          return { id: it.id, name: it.name, baseUnit: it.baseUnit, stock: it.stock, daysCover: it.daysCover,
            dailyRate: it.dailyRate, suggestQty, suggestUnit, suggestCost: Math.round(orderedBase * it.avgCost) };
        }).sort((a, b) => a.daysCover - b.daysCover);

      const watch = [];
      items.forEach((it) => {
        if (it.minStock > 0 && it.stock <= it.minStock) watch.push({ id: it.id, name: it.name, type: "low", detail: `Below your alert level (${qtyStr(it.stock, it.baseUnit)} left, alert at ${qtyStr(it.minStock, it.baseUnit)})` });
        else if (it.wastePct >= 15 && it.wasted > 0) watch.push({ id: it.id, name: it.name, type: "wastage", detail: `${it.wastePct}% of what you used was thrown out this month` });
        if (it.stock > 0 && it.dailyRate === 0 && (it.idleDays == null || it.idleDays >= 21)) watch.push({ id: it.id, name: it.name, type: "dead", detail: `${qtyStr(it.stock, it.baseUnit)} sitting unused${it.idleDays ? ` for ${it.idleDays} days` : ""}` });
      });

      const moving = items.filter((it) => it.dailyRate > 0).sort((a, b) => b.used - a.used);
      const stockValue = items.reduce((a, it) => a + it.stock * it.avgCost, 0);
      return { currency, windowDays: 30, generatedAt: new Date().toISOString(), items, reorder, watch,
        fast: moving.slice(0, 5).map((it) => ({ name: it.name, used: it.used, baseUnit: it.baseUnit })),
        stockValue: Math.round(stockValue), ingredientCount: items.length };
    });
  }
  function qtyStr(n, unit) { return (Math.round(Number(n || 0) * 1000) / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 }) + " " + unit; }

  router.get("/insights", authAny, wrap(async (req, res) => {
    const out = await computeInsights(req.orgId);
    /* The full per-item table is only needed by the assistant digest; the UI
       wants the actionable lists, so keep the response lean. */
    res.json({ currency: out.currency, windowDays: out.windowDays, reorder: out.reorder, watch: out.watch, fast: out.fast, stockValue: out.stockValue, ingredientCount: out.ingredientCount });
  }));

  /* ── AI assistant (§18) — answers grounded on the numbers above ──────────
     The store's data never leaves as a training signal; each question is
     answered against a fresh, compact digest of the current figures, so the
     assistant can only talk about what's actually true right now. Degrades to
     a plain message when no key is configured (the insights above still work). */
  router.post("/assistant", authAny, wrap(async (req, res) => {
    const client = anthropicClient();
    const question = String((req.body && req.body.question) || "").trim().slice(0, 500);
    if (!question) return res.status(400).json({ error: "ask a question first" });
    if (!client) return res.json({ ok: true, configured: false, answer: "The assistant isn't set up yet. Add an ANTHROPIC_API_KEY to switch it on — the reorder and watch lists below work without it." });

    const ins = await computeInsights(req.orgId);
    const recent = await withOrg(req.orgId, (dbc) => dbc.query(
      "SELECT invoice_no, total, received_at FROM purchase_invoices WHERE org_id=$1 ORDER BY received_at DESC LIMIT 8", [req.orgId]));
    const money = (laari) => ins.currency + " " + (Number(laari) / 100).toFixed(2);
    /* A tight, factual digest — top items by usage, the reorder + watch lists,
       and recent deliveries. Small enough to stay cheap and current. */
    const digest = {
      currency: ins.currency, stockValueOnHand: money(ins.stockValue), ingredientCount: ins.ingredientCount,
      items: ins.items.slice().sort((a, b) => b.used - a.used).slice(0, 40).map((it) => ({
        name: it.name, inStock: qtyStr(it.stock, it.baseUnit), usedPerDay: it.dailyRate + " " + it.baseUnit,
        daysOfCover: it.daysCover == null ? "not moving" : it.daysCover, avgCost: money(it.avgCost) + "/" + it.baseUnit,
        wasteThisMonth: it.wasted ? qtyStr(it.wasted, it.baseUnit) + ` (${it.wastePct}%)` : "none",
      })),
      reorderSoon: ins.reorder.map((r) => ({ name: r.name, coverDays: r.daysCover, suggestOrder: `${r.suggestQty} ${r.suggestUnit}`, estCost: money(r.suggestCost) })),
      watch: ins.watch.map((w) => `${w.name}: ${w.detail}`),
      recentDeliveries: recent.rows.map((d) => ({ invoice: d.invoice_no || "—", total: money(d.total), when: new Date(d.received_at).toISOString().slice(0, 10) })),
    };

    let answer;
    try {
      const model = process.env.OCR_MODEL || "claude-opus-4-8";
      const msg = await client.messages.create({
        model, max_tokens: 1024, thinking: { type: "adaptive" },
        system:
          "You are the inventory assistant for a small café or shop. Answer the owner's question using ONLY the JSON data provided — it is the current state of their stock, usage, costs and deliveries. " +
          "Never invent items, numbers or trends that aren't in the data. If the data can't answer the question, say so plainly. " +
          "Be brief and practical: a sentence or two, or a short list. All money is already formatted in the store's currency; don't recompute it.",
        messages: [{ role: "user", content: "Here is my current inventory data as JSON:\n\n" + JSON.stringify(digest) + "\n\nQuestion: " + question }],
      });
      if (msg.stop_reason === "refusal") throw Object.assign(new Error("I can't answer that one."), { status: 422 });
      answer = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    } catch (e) {
      recordError("inventory assistant", e);
      return res.status(e.status === 422 ? 422 : 502).json({ error: e.status === 422 ? e.message : "The assistant couldn't answer just now — try again in a moment." });
    }
    res.json({ ok: true, configured: true, answer: answer || "I don't have enough data to answer that yet." });
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
      const data = prod.rowCount ? prod.rows[0].data : {};
      const price = num(data.price);
      /* Surface the stock-item link so the editor can show its toggle state. */
      let stock = null;
      if (data.stockIngredientId) {
        const b = await client.query(
          "SELECT id, name, base_unit, current_stock FROM ingredients WHERE org_id=$1 AND id=$2 AND active", [req.orgId, data.stockIngredientId]);
        if (b.rowCount) {
          const self = lines.find((l) => String(l.ingredientId) === String(data.stockIngredientId));
          stock = { ingredientId: b.rows[0].id, name: b.rows[0].name, unit: b.rows[0].base_unit, currentStock: Number(b.rows[0].current_stock), perSale: self ? self.qty : 1 };
        }
      }
      return { lines, cost, price, margin: price - cost, marginPct: price > 0 ? Math.round((price - cost) / price * 10000) / 100 : 0, stock };
    });
    res.json(out);
  }));

  /* ── Stockable menu product (§6, mirror of the resale role) ──────────────
     Promote a menu item to a tracked stock item so it can be sold from stock
     AND used in other recipes (a bottled sauce you sell and also cook with).
     A backing ingredient is created; the product's raw recipe moves onto it as
     a build recipe (scaled to one stock unit), and the product's own recipe
     becomes a single line that draws `perSale` units of that stock when sold —
     so the existing sale-deduction and availability paths do all the work.
     Demote reverses it (blocked while other recipes still use the stock item). */
  router.post("/products/:id/stockable", authAny, wrap(async (req, res) => {
    const { on, unit, perSale } = req.body || {};
    const stockUnit = ["g", "ml", "pcs"].includes(unit) ? unit : "pcs";
    const per = num(perSale) > 0 ? num(perSale) : 1;
    const pid = req.params.id;
    const round6 = (v) => Math.round(v * 1e6) / 1e6;

    const out = await withOrg(req.orgId, async (client) => {
      const prodQ = await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false FOR UPDATE", [req.orgId, pid]);
      if (!prodQ.rowCount) throw Object.assign(new Error("menu item not found"), { status: 404 });
      const data = prodQ.rows[0].data || {};

      if (on) {
        let bId = data.stockIngredientId;
        if (bId) {
          const ex = await client.query("SELECT 1 FROM ingredients WHERE org_id=$1 AND id=$2 AND active", [req.orgId, bId]);
          if (!ex.rowCount) bId = null;
        }
        if (bId) {
          /* Already stockable — just update how much a sale draws. */
          await client.query("UPDATE recipe_lines SET qty=$4 WHERE org_id=$1 AND product_id=$2 AND ingredient_id=$3", [req.orgId, pid, bId, per]);
          await client.query("UPDATE ingredients SET base_unit=$3 WHERE org_id=$1 AND id=$2", [req.orgId, bId, stockUnit]);
        } else {
          bId = uid();
          /* The product's current recipe lines become the build recipe, scaled
             from "per serving" to "per one stock unit" (÷ perSale). */
          const raws = await client.query("SELECT ingredient_id, qty FROM recipe_lines WHERE org_id=$1 AND product_id=$2", [req.orgId, pid]);
          await client.query(
            `INSERT INTO ingredients (org_id, id, name, base_unit, location, product_id, producible)
             VALUES ($1,$2,$3,$4,'Prep',$5,$6)`,
            [req.orgId, bId, String(data.name || "Item"), stockUnit, pid, raws.rowCount > 0]);
          for (const r of raws.rows) {
            await client.query(
              "INSERT INTO recipe_lines (org_id, id, product_id, ingredient_id, qty) VALUES ($1,$2,$3,$4,$5)",
              [req.orgId, uid(), bId, r.ingredient_id, round6(Number(r.qty) / per)]);
          }
          await client.query("DELETE FROM recipe_lines WHERE org_id=$1 AND product_id=$2", [req.orgId, pid]);
          await client.query(
            "INSERT INTO recipe_lines (org_id, id, product_id, ingredient_id, qty) VALUES ($1,$2,$3,$4,$5)",
            [req.orgId, uid(), pid, bId, per]);
        }
        const up = await client.query(
          `UPDATE entities SET data = data || jsonb_build_object('stockIngredientId',$3::text),
             rowver = nextval('entities_rowver_seq'), updated_at=now()
           WHERE org_id=$1 AND kind='products' AND id=$2 RETURNING rowver`, [req.orgId, pid, bId]);
        return { rowver: Number(up.rows[0].rowver), stockIngredientId: bId, touched: [bId] };
      }

      /* Demote. */
      const bId = data.stockIngredientId;
      if (!bId) return { rowver: 0 };
      const others = await client.query(
        "SELECT DISTINCT product_id FROM recipe_lines WHERE org_id=$1 AND ingredient_id=$2 AND product_id NOT IN ($3,$2)", [req.orgId, bId, pid]);
      if (others.rowCount) throw Object.assign(new Error(`This item is used in ${others.rowCount} other recipe(s) — remove it from those first.`), { status: 409 });
      const self = await client.query("SELECT qty FROM recipe_lines WHERE org_id=$1 AND product_id=$2 AND ingredient_id=$3", [req.orgId, pid, bId]);
      const perNow = self.rowCount ? Number(self.rows[0].qty) : 1;
      await client.query("DELETE FROM recipe_lines WHERE org_id=$1 AND product_id=$2", [req.orgId, pid]);
      /* Move the build recipe back onto the product, scaled to "per serving". */
      const prep = await client.query("SELECT ingredient_id, qty FROM recipe_lines WHERE org_id=$1 AND product_id=$2", [req.orgId, bId]);
      for (const r of prep.rows) {
        await client.query(
          "INSERT INTO recipe_lines (org_id, id, product_id, ingredient_id, qty) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, product_id, ingredient_id) DO UPDATE SET qty=excluded.qty",
          [req.orgId, uid(), pid, r.ingredient_id, round6(Number(r.qty) * perNow)]);
      }
      await client.query("DELETE FROM recipe_lines WHERE org_id=$1 AND product_id=$2", [req.orgId, bId]);
      await client.query("UPDATE ingredients SET active=false, producible=false, updated_at=now() WHERE org_id=$1 AND id=$2", [req.orgId, bId]);
      const up = await client.query(
        `UPDATE entities SET data = data - 'stockIngredientId',
           rowver = nextval('entities_rowver_seq'), updated_at=now()
         WHERE org_id=$1 AND kind='products' AND id=$2 RETURNING rowver`, [req.orgId, pid]);
      return { rowver: Number(up.rows[0].rowver), touched: prep.rows.map((r) => String(r.ingredient_id)) };
    });

    if (out.rowver && poke) poke(req.orgId, out.rowver);
    if (out.touched && out.touched.length) await recomputeAvailability(req.orgId, out.touched);
    res.json(Object.assign({ ok: true }, out));
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

  /* ── Admin cockpit: sales summary (spec §3.1 / §4) ───────────────────────
     Server-authoritative aggregation over kind='sales' entities for the admin
     Dashboard/Reports. The client only displays these figures — money and GST
     are computed here. Ranges are calendar windows in Maldives local time
     (UTC+5) so "today"/"this month" line up with the shop's day. Returns the
     selected range plus its immediately-preceding equal window for deltas. */
  router.get("/summary", authAny, wrap(async (req, res) => {
    const RANGES = { today: "today", yest: "yesterday", week: "this week", month: "this month", quarter: "this quarter", year: "this year" };
    const range = RANGES[req.query.range] ? String(req.query.range) : "today";
    const MVT = 5 * 3600 * 1000;                 // Maldives is UTC+5, no DST
    const now = Date.now();
    const localMidnight = (ms) => { const d = new Date(ms + MVT); d.setUTCHours(0, 0, 0, 0); return d.getTime() - MVT; };
    const addDays = (ms, n) => ms + n * 86400000;
    const t0 = localMidnight(now);
    // window [from,to) for the selected range + bucketing plan for the chart
    let from, to = now, buckets, labelOf, granularity;
    if (range === "today") { from = t0; buckets = 24; granularity = "hour"; }
    else if (range === "yest") { from = addDays(t0, -1); to = t0; buckets = 24; granularity = "hour"; }
    else if (range === "week") { from = addDays(t0, -6); buckets = 7; granularity = "day"; }
    else if (range === "month") { const d = new Date(t0 + MVT); const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - MVT; from = s; buckets = Math.max(1, Math.round((to - from) / 86400000) + 1); granularity = "day"; }
    else if (range === "quarter") { const d = new Date(t0 + MVT); const qs = Math.floor(d.getUTCMonth() / 3) * 3; const s = Date.UTC(d.getUTCFullYear(), qs, 1) - MVT; from = s; buckets = 13; granularity = "week"; }
    else { const d = new Date(t0 + MVT); const s = Date.UTC(d.getUTCFullYear(), 0, 1) - MVT; from = s; buckets = 12; granularity = "month"; }
    const span = to - from;
    const prevFrom = from - span, prevTo = from;

    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    // map a timestamp to a bucket index within [from,to); -1 if outside
    function bucketOf(ms) {
      if (ms < from || ms >= to) return -1;
      if (granularity === "hour") return new Date(ms + MVT).getUTCHours();
      if (granularity === "day") return Math.floor((ms - from) / 86400000);
      if (granularity === "week") return Math.min(buckets - 1, Math.floor((ms - from) / (7 * 86400000)));
      return new Date(ms + MVT).getUTCMonth() - new Date(from + MVT).getUTCMonth();
    }
    function labels() {
      if (granularity === "hour") return ["12a", "6a", "12p", "6p", "11p"];
      if (granularity === "day") {
        const out = []; const step = Math.max(1, Math.ceil(buckets / 6));
        if (buckets <= 7) { for (let i = 0; i < buckets; i++) out.push(DOW[new Date(from + i * 86400000 + MVT).getUTCDay()]); return out; }
        for (let i = 0; i < buckets; i += step) out.push(String(new Date(from + i * 86400000 + MVT).getUTCDate())); return out;
      }
      if (granularity === "week") { const out = []; for (let i = 0; i < buckets; i += 4) out.push(MONTHS[new Date(from + i * 7 * 86400000 + MVT).getUTCMonth()]); return out; }
      if (granularity === "month") return MONTHS.slice(new Date(from + MVT).getUTCMonth());
      return [];
    }

    const rows = await withOrg(req.orgId, async (client) => {
      const sales = await client.query(
        `SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false
           AND COALESCE((data->>'t')::numeric, 0) >= $2`, [req.orgId, prevFrom]);
      const prods = await client.query(
        `SELECT id, data->>'cat' AS cat, data->>'name' AS name FROM entities
          WHERE org_id=$1 AND kind='products' AND deleted=false`, [req.orgId]);
      return { sales: sales.rows.map((r) => r.data || {}), prods: prods.rows };
    });
    const catOf = {}; rows.prods.forEach((p) => { catOf[p.id] = p.cat || "Other"; });
    const normT = (d) => { let t = num(d.t); if (t > 0 && t < 1e12) t *= 1000; return t; };
    const payClass = (m) => { m = String(m || "").toLowerCase(); if (/cash/.test(m)) return "cash"; if (/card|bml|visa|master/.test(m)) return "card"; if (/transf|bank/.test(m)) return "transfer"; if (/tab|credit|account/.test(m)) return "tab"; return "card"; };
    const chanOf = (d) => { if (d.channel === "qr" || d.qr || d.via === "guest") return "qr"; if (d.otype === "delivery") return "delivery"; return "reg"; };

    function agg(lo, hi) {
      const A = { rev: 0, gross: 0, orders: 0, items: 0, gp: 0, disc: 0, gst: 0, refunds: 0, svc: 0,
        pay: { cash: 0, card: 0, transfer: 0, tab: 0 }, chan: { reg: 0, qr: 0, delivery: 0 }, cat: {}, rc: new Array(buckets).fill(0), peak: new Array(24).fill(0) };
      for (const d of rows.sales) {
        const t = normT(d); if (t < lo || t >= hi) continue;
        const total = num(d.total);
        if (d.refunded) { A.refunds += total; continue; }
        A.gross += total; A.rev += total; A.orders += 1; A.disc += num(d.billDisc); A.gst += num(d.gst); A.svc += num(d.svcCharge);
        (d.lines || []).forEach((l) => { const q = num(l.qty, 1); A.items += q; A.gp += (num(l.price) - num(l.cost)) * q; const c = catOf[l.pid] || "Other"; A.cat[c] = (A.cat[c] || 0) + num(l.price) * q; });
        (d.payments || []).forEach((p) => { A.pay[payClass(p.method)] += num(p.amount); });
        A.chan[chanOf(d)] += total;
        if (lo === from) { const b = bucketOf(t); if (b >= 0 && b < buckets) A.rc[b] += total; A.peak[new Date(t + MVT).getUTCHours()] += total; }
      }
      return A;
    }
    const cur = agg(from, to), prev = agg(prevFrom, prevTo);
    const pct = (a, b) => { if (!b) return a ? 100 : 0; return ((a - b) / b) * 100; };
    const sign = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "%";
    const aov = cur.orders ? cur.rev / cur.orders : 0, paov = prev.orders ? prev.rev / prev.orders : 0;
    const peakHour = cur.peak.indexOf(Math.max.apply(null, cur.peak));
    const hourLabel = (h) => (h % 12 || 12) + (h < 12 ? "am" : "pm");
    const cats = Object.keys(cur.cat).map((c) => ({ cat: c, amt: cur.cat[c] })).sort((a, b) => b.amt - a.amt).slice(0, 6);
    const catTotal = cats.reduce((a, c) => a + c.amt, 0) || 1;

    res.json({
      range, word: RANGES[range],
      rev: cur.rev, gross: cur.gross, orders: cur.orders, items: cur.items,
      gpVal: cur.gp, gpPct: cur.rev ? +(cur.gp / cur.rev * 100).toFixed(1) : 0,
      aov, basket: cur.orders ? cur.items / cur.orders : 0,
      disc: cur.disc, gst: cur.gst, svc: cur.svc, refunds: cur.refunds, net: cur.gross - cur.disc - cur.refunds,
      d: [sign(pct(cur.rev, prev.rev)), sign(pct(cur.orders, prev.orders)), sign(pct(cur.gp, prev.gp)), sign(pct(aov, paov))],
      prevRev: prev.rev,
      rc: cur.rc, xl: labels(), peak: cur.peak,
      peakHour, peakLabel: hourLabel(peakHour), peakAmt: cur.peak[peakHour] || 0, hasSales: cur.peak.some((x) => x),
      pay: cur.pay, chan: cur.chan,
      cat: cats.map((c) => ({ cat: c.cat, amt: c.amt, pct: Math.round(c.amt / catTotal * 100) })),
    });
  }));

  /* Admin cockpit: orders list (spec §3.2). Range-scoped individual sales for
     the Sales table + stat cards, optionally filtered by channel
     (reg = dine-in|takeaway, qr = self-order, delivery). Same calendar-window
     rules as /summary. Server stays the source of truth for money. */
  router.get("/orders", authAny, wrap(async (req, res) => {
    const RANGES = { today: 1, yest: 1, week: 1, month: 1, quarter: 1, year: 1 };
    const CHAN = { reg: 1, qr: 1, delivery: 1 };
    const range = RANGES[req.query.range] ? String(req.query.range) : "today";
    const channel = CHAN[req.query.channel] ? String(req.query.channel) : "all";
    const MVT = 5 * 3600 * 1000, now = Date.now();
    const localMidnight = (ms) => { const d = new Date(ms + MVT); d.setUTCHours(0, 0, 0, 0); return d.getTime() - MVT; };
    const t0 = localMidnight(now);
    let from, to = now;
    if (range === "today") from = t0;
    else if (range === "yest") { from = t0 - 86400000; to = t0; }
    else if (range === "week") from = t0 - 6 * 86400000;
    else if (range === "month") { const d = new Date(t0 + MVT); from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - MVT; }
    else if (range === "quarter") { const d = new Date(t0 + MVT); from = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1) - MVT; }
    else { const d = new Date(t0 + MVT); from = Date.UTC(d.getUTCFullYear(), 0, 1) - MVT; }

    const rows = await withOrg(req.orgId, (c) => c.query(
      `SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false
         AND COALESCE((data->>'t')::numeric, 0) >= $2
       ORDER BY (data->>'t')::numeric DESC NULLS LAST`, [req.orgId, from]));
    const chanOf = (d) => (d.channel === "qr" || d.qr || d.via === "guest") ? "qr" : (d.otype === "delivery" ? "delivery" : "reg");
    const normT = (d) => { let t = num(d.t); if (t > 0 && t < 1e12) t *= 1000; return t; };
    let orders = 0, rev = 0; const list = [];
    for (const r of rows.rows) {
      const d = r.data || {}, t = normT(d);
      if (t < from || t >= to) continue;
      const ch = chanOf(d);
      if (channel !== "all" && ch !== channel) continue;
      const total = num(d.total);
      if (!d.refunded) { orders += 1; rev += total; }
      list.push({ id: String(d.id || ""), no: d.no || "", ch, t, otype: d.otype || "",
        items: (d.lines || []).reduce((a, l) => a + num(l.qty, 1), 0), staff: d.userName || "",
        total, refunded: !!d.refunded, table: d.table || null });
    }
    res.json({ range, channel, stats: { orders, rev, aov: orders ? rev / orders : 0 }, orders: list.slice(0, 300) });
  }));

  /* Admin cockpit: wastage ledger (spec §3.5). Range-scoped waste moves from the
     immutable stock ledger, joined to ingredient names. Cost = |qty| × unit_cost
     (laari). Read-only — recording wastage stays the per-item Adjust flow. */
  router.get("/wastage", authAny, wrap(async (req, res) => {
    const RANGES = { today: 1, yest: 1, week: 1, month: 1, quarter: 1, year: 1 };
    const range = RANGES[req.query.range] ? String(req.query.range) : "month";
    const MVT = 5 * 3600 * 1000, now = Date.now();
    const localMidnight = (ms) => { const d = new Date(ms + MVT); d.setUTCHours(0, 0, 0, 0); return d.getTime() - MVT; };
    const t0 = localMidnight(now);
    let from, to = now;
    if (range === "today") from = t0;
    else if (range === "yest") { from = t0 - 86400000; to = t0; }
    else if (range === "week") from = t0 - 6 * 86400000;
    else if (range === "month") { const d = new Date(t0 + MVT); from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - MVT; }
    else if (range === "quarter") { const d = new Date(t0 + MVT); from = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1) - MVT; }
    else { const d = new Date(t0 + MVT); from = Date.UTC(d.getUTCFullYear(), 0, 1) - MVT; }

    const rows = await withOrg(req.orgId, (c) => c.query(
      `SELECT EXTRACT(EPOCH FROM m.created_at)*1000 AS at, m.qty, m.unit_cost, m.note, m.location,
              i.name, i.base_unit
         FROM stock_moves m LEFT JOIN ingredients i ON i.org_id = m.org_id AND i.id = m.ingredient_id
        WHERE m.org_id=$1 AND m.kind='waste'
          AND EXTRACT(EPOCH FROM m.created_at)*1000 >= $2 AND EXTRACT(EPOCH FROM m.created_at)*1000 < $3
        ORDER BY m.created_at DESC LIMIT 500`, [req.orgId, from, to]));
    const list = rows.rows.map((r) => {
      const qty = Math.abs(Number(r.qty) || 0);
      const reason = String(r.note || "").replace(/^wastage:\s*/i, "").trim() || "Wastage";
      return { at: Math.round(Number(r.at) || 0), name: r.name || "(removed item)", qty,
        unit: r.base_unit || "", location: r.location || "", reason, cost: Math.round(qty * (Number(r.unit_cost) || 0)) };
    });
    res.json({ range, total: list.reduce((a, x) => a + x.cost, 0), count: list.length, wastage: list });
  }));

  /* Admin cockpit: expenses ledger (spec §3.6). Range-scoped 'expenses' entities
     (booked by the till's expense capture and by back-office deliveries). */
  router.get("/expenses", authAny, wrap(async (req, res) => {
    const RANGES = { today: 1, yest: 1, week: 1, month: 1, quarter: 1, year: 1 };
    const range = RANGES[req.query.range] ? String(req.query.range) : "month";
    const MVT = 5 * 3600 * 1000, now = Date.now();
    const localMidnight = (ms) => { const d = new Date(ms + MVT); d.setUTCHours(0, 0, 0, 0); return d.getTime() - MVT; };
    const t0 = localMidnight(now);
    let from, to = now;
    if (range === "today") from = t0;
    else if (range === "yest") { from = t0 - 86400000; to = t0; }
    else if (range === "week") from = t0 - 6 * 86400000;
    else if (range === "month") { const d = new Date(t0 + MVT); from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - MVT; }
    else if (range === "quarter") { const d = new Date(t0 + MVT); from = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1) - MVT; }
    else { const d = new Date(t0 + MVT); from = Date.UTC(d.getUTCFullYear(), 0, 1) - MVT; }
    const normT = (d) => { let t = num(d.t); if (t > 0 && t < 1e12) t *= 1000; return t; };
    const rows = await withOrg(req.orgId, (c) => c.query(
      `SELECT data FROM entities WHERE org_id=$1 AND kind='expenses' AND deleted=false
         AND COALESCE((data->>'t')::numeric, 0) >= $2
       ORDER BY (data->>'t')::numeric DESC NULLS LAST LIMIT 400`, [req.orgId, from]));
    const list = [];
    for (const r of rows.rows) {
      const d = r.data || {}, t = normT(d);
      if (t < from || t >= to) continue;
      list.push({ t, cat: d.cat || "Other", supplier: d.supplier || "", method: d.paidFrom || "other", amount: num(d.amount), note: d.note || "" });
    }
    res.json({ range, total: list.reduce((a, x) => a + x.amount, 0), count: list.length, expenses: list });
  }));

  /* Admin cockpit: receivables (spec §3.7). Customers carrying an open balance,
     with aging from when the balance last moved and a status band. Read-only. */
  router.get("/receivables", authAny, wrap(async (req, res) => {
    const rows = await withOrg(req.orgId, (c) => c.query(
      `SELECT id, data, EXTRACT(EPOCH FROM updated_at)*1000 AS upd FROM entities
        WHERE org_id=$1 AND kind='customers' AND deleted=false
          AND COALESCE((data->>'balance')::numeric, 0) > 0
        ORDER BY (data->>'balance')::numeric DESC LIMIT 300`, [req.orgId]));
    const now = Date.now();
    const list = rows.rows.map((r) => {
      const d = r.data || {}, bal = num(d.balance), limit = num(d.creditLimit);
      const over = !!d.creditOverLimit || (limit > 0 && bal > limit);
      const since = num(d.creditOverAt) || Math.round(Number(r.upd) || 0);
      const ageDays = since ? Math.max(0, Math.floor((now - since) / 86400000)) : 0;
      const status = over ? "overdue" : (limit > 0 && bal >= limit * 0.8 ? "due" : "current");
      return { id: String(d.id || r.id), name: d.name || "Customer", phone: d.phone || "",
        balance: bal, creditLimit: limit, over, overBy: num(d.creditOverBy), ageDays, status };
    });
    res.json({ outstanding: list.reduce((a, x) => a + x.balance, 0), overdue: list.filter((x) => x.status === "overdue").length, customers: list.length, rows: list });
  }));

  /* Admin cockpit: settings (spec §3.10). Read/write the shared 'settings'
     entity that the till syncs. GST rate (gstBp) + service charge (svcChargeBp)
     are honoured by the register today; the other flags persist for when the
     till wires them. Every write bumps rowver + pokes so tills pick it up. */
  router.get("/settings", authAny, wrap(async (req, res) => {
    const row = await withOrg(req.orgId, (c) => c.query(
      "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false", [req.orgId]));
    const d = (row.rows[0] && row.rows[0].data) || {};
    res.json({
      gstBp: num(d.gstBp, 800), svcChargeBp: num(d.svcChargeBp, 0),
      autoKot: d.autoKot !== false, roundTotals: !!d.roundTotals,
      taxInclusive: !!d.taxInclusive, autoPrint: d.autoPrint !== false,
      methods: Object.assign({ cash: true, card: true, transfer: true, tab: true }, d.methods || {}),
    });
  }));
  router.put("/settings", authAny, wrap(async (req, res) => {
    const b = req.body || {};
    const rowver = await withOrg(req.orgId, async (client) => {
      const row = (await client.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false FOR UPDATE", [req.orgId])).rows[0];
      const data = Object.assign({}, (row && row.data) || {});
      if (b.gstBp !== undefined) data.gstBp = Number(b.gstBp) === 1600 ? 1600 : 800;
      if (b.svcChargeBp !== undefined) data.svcChargeBp = Number(b.svcChargeBp) > 0 ? 1000 : 0;
      ["autoKot", "roundTotals", "taxInclusive", "autoPrint"].forEach((k) => { if (b[k] !== undefined) data[k] = !!b[k]; });
      if (b.methods && typeof b.methods === "object") data.methods = Object.assign({ cash: true, card: true, transfer: true, tab: true }, data.methods || {}, b.methods);
      const up = await client.query(
        `INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2)
         ON CONFLICT (org_id, kind, id) DO UPDATE SET data=$2, rowver=nextval('entities_rowver_seq'), updated_at=now()
         RETURNING rowver`, [req.orgId, JSON.stringify(data)]);
      return up.rows[0] ? Number(up.rows[0].rowver) : 0;
    });
    if (poke && rowver) poke(req.orgId, rowver);
    res.json({ ok: true });
  }));

  /* ── Compliance review (audit FIN-01/02) ─────────────────────────────────
     Surfaces the two server-side integrity flags for a manager: sales the sync
     endpoint stamped with data.serverAudit (a total/price/tax mismatch) and
     customers whose balance broke their credit limit (data.creditOverLimit).
     Acknowledging a flag records who cleared it and when, and drops it off the
     list without touching the money — the record itself is never altered. */
  router.get("/flags", authAny, wrap(async (req, res) => {
    const out = await withOrg(req.orgId, async (client) => {
      const sales = await client.query(
        `SELECT id, data FROM entities
         WHERE org_id=$1 AND kind='sales' AND deleted=false
           AND data->'serverAudit'->>'flagged'='true'
           AND COALESCE(data->'serverAudit'->>'ack','') <> 'true'
         ORDER BY (data->'serverAudit'->>'at')::numeric DESC NULLS LAST LIMIT 200`, [req.orgId]);
      const credit = await client.query(
        `SELECT id, data FROM entities
         WHERE org_id=$1 AND kind='customers' AND deleted=false
           AND data->>'creditOverLimit'='true'
         ORDER BY (data->>'creditOverAt')::numeric DESC NULLS LAST LIMIT 200`, [req.orgId]);
      return { sales: sales.rows, credit: credit.rows };
    });
    res.json({
      sales: out.sales.map((x) => {
        const d = x.data || {}, a = d.serverAudit || {};
        return { id: String(d.id || x.id), no: d.no || "", t: num(d.t), total: num(d.total),
          claimedTotal: num(a.claimedTotal), computedTotal: num(a.computedTotal),
          reasons: Array.isArray(a.reasons) ? a.reasons : [], at: num(a.at),
          userName: d.userName || "", storeId: d.storeId || "",
          payments: (d.payments || []).map((p) => ({ method: p.method, amount: num(p.amount) })),
          lines: (d.lines || []).map((l) => ({ name: l.name || l.pid || "item", qty: num(l.qty, 1), price: num(l.price) })) };
      }),
      credit: out.credit.map((x) => {
        const d = x.data || {};
        return { id: String(d.id || x.id), name: d.name || "Customer", balance: num(d.balance),
          creditLimit: num(d.creditLimit), overBy: num(d.creditOverBy), at: num(d.creditOverAt) };
      }),
    });
  }));

  /* Acknowledge one flag. kind = 'sale' stamps serverAudit.ack; kind = 'credit'
     clears the customer's over-limit flag (the balance stays as-is). */
  router.post("/flags/:kind/:id/ack", authAny, wrap(async (req, res) => {
    const who = String((req.body && req.body.by) || "back office").slice(0, 60);
    const kind = req.params.kind === "credit" ? "credit" : "sale";
    const r = await withOrg(req.orgId, (client) => kind === "sale"
      ? client.query(
          `UPDATE entities SET
             data = data || jsonb_build_object('serverAudit',
                      COALESCE(data->'serverAudit','{}'::jsonb) || jsonb_build_object('ack', true, 'ackBy', $3::text, 'ackAt', $4::numeric)),
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind='sales' AND id=$2 AND data->'serverAudit'->>'flagged'='true'
           RETURNING rowver`, [req.orgId, req.params.id, who, Date.now()])
      : client.query(
          `UPDATE entities SET
             data = data || jsonb_build_object('creditOverLimit', false, 'creditAckBy', $3::text, 'creditAckAt', $4::numeric),
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind='customers' AND id=$2 AND data->>'creditOverLimit'='true'
           RETURNING rowver`, [req.orgId, req.params.id, who, Date.now()]));
    if (!r.rowCount) return res.status(404).json({ error: "flag not found or already cleared" });
    if (poke) poke(req.orgId, Number(r.rows[0].rowver));
    await noteActivity(req.orgId, { actor: who, action: "flag.ack", ref: req.params.id, requestId: req.id, detail: { kind } });
    res.json({ ok: true });
  }));

  /* Read the append-only audit trail (FIN-03) for the Review / compliance view. */
  router.get("/activity", authAny, wrap(async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const r = await withOrg(req.orgId, (client) => client.query(
      `SELECT at, actor, action, ref, request_id, detail FROM activity_log
       WHERE org_id=$1 ORDER BY at DESC LIMIT $2`, [req.orgId, limit]));
    res.json({ activity: r.rows.map((x) => ({
      at: x.at, actor: x.actor, action: x.action, ref: x.ref, requestId: x.request_id, detail: x.detail || {},
    })) });
  }));

  /* Accounting / GL export (audit FIN-04). Turns the till's sales, refunds and
     payments over a date range into journal-style totals an accountant can post
     or reconcile: revenue, GST liability, service charge, tips, each tender, AR
     movement (credit sales), and COGS from the immutable stock ledger. Read-only
     and derived — it never mutates anything. Money is laari (÷100 to display). */
  router.get("/ledger-export", authAny, wrap(async (req, res) => {
    const storeId = req.query.storeId ? String(req.query.storeId) : null;
    const from = Number(req.query.from) || 0;
    const to = Number(req.query.to) || Date.now();
    const rows = await withOrg(req.orgId, (client) => client.query(
      `SELECT data FROM entities
       WHERE org_id=$1 AND kind='sales' AND deleted=false
         AND ($2::text IS NULL OR COALESCE(data->>'storeId','global')=$2)
         AND (data->>'t')::numeric BETWEEN $3 AND $4`, [req.orgId, storeId, from, to]));
    const cogs = await withOrg(req.orgId, (client) => client.query(
      `SELECT COALESCE(-SUM(qty*unit_cost),0) AS cogs FROM stock_moves
       WHERE org_id=$1 AND kind='sale' AND (EXTRACT(EPOCH FROM created_at)*1000) BETWEEN $2 AND $3`, [req.orgId, from, to]));
    const j = { grossSales: 0, discounts: 0, gst: 0, serviceCharge: 0, tips: 0, refunds: 0, foc: 0, netSales: 0, tenders: {}, accountsReceivable: 0, cogs: Math.round(Number(cogs.rows[0].cogs) || 0), saleCount: 0, refundCount: 0 };
    /* Payments-decision A+: per-line detail for the external non-cash tenders
       (Card/QR/Transfer), each with the reference the cashier captured at the
       till, so end-of-day reconciliation is a line-by-line tick-off against the
       card terminal batch and the bank feed. */
    const tenderDetail = [];
    for (const row of rows.rows) {
      const d = row.data || {};
      const isRefund = d.type === "refund";
      const total = num(d.total), sub = num(d.subtotal), gst = num(d.gst), svc = num(d.svcCharge), disc = num(d.billDisc);
      if (d.foc) { j.foc += num(d.focValue); continue; }
      if (isRefund) { j.refunds += Math.abs(total); j.refundCount++; }
      else { j.grossSales += sub; j.discounts += disc; j.gst += gst; j.serviceCharge += svc; j.saleCount++; }
      for (const p of (d.payments || [])) {
        const m = String(p.method || "Other");
        j.tenders[m] = (j.tenders[m] || 0) + num(p.amount);
        if (/tip/i.test(m)) j.tips += num(p.amount);
        if (/credit/i.test(m) && !isRefund) j.accountsReceivable += num(p.amount);
        if (/^(card|qr|transfer)$/i.test(m)) tenderDetail.push({
          saleNo: d.no || d.id, at: num(d.t), method: m, amount: num(p.amount),
          ref: p.ref ? String(p.ref).slice(0, 40) : "", refund: isRefund,
        });
      }
    }
    tenderDetail.sort((a, b) => a.at - b.at);
    j.netSales = j.grossSales - j.discounts;
    j.grossProfit = j.netSales - j.cogs;
    res.json({ from, to, storeId: storeId || "all", currency: "laari", journal: j,
      tenderDetail, tenderRefsMissing: tenderDetail.filter((t) => !t.ref).length,
      note: "All amounts in laari (MVR×100). AR = credit-tender sales; tenders map to their clearing accounts. tenderDetail lists each Card/QR/Transfer payment with the reference captured at the till." });
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
