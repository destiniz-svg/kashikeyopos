'use strict';
const express = require('express');
const { withOutlet, withEstate } = require('./db');
const { sign, pinMatches, pinLookup } = require('./secrets');
const { session, sameOutlet, atLeast, ownTable, staffOnly } = require('./auth');
const { settle } = require('./sale');
const kitchen = require('./kitchen');
const menu = require('./menu');
const recipes = require('./recipes');
const stock = require('./stock');
const orders = require('./orders');
const reports = require('./reports');
const drawer = require('./drawer');
const today = require('./today');
const purchasing = require('./purchasing');
const staff = require('./staff');
const { taxAsAt } = require('./sale');

const r = express.Router();
const LOCK_TRIES = 5, LOCK_MINS = 15;

// ── sign in with a PIN, at one outlet, on one device ────────────────────────
r.post('/auth/pin', async function (req, res, next) {
  const { outletId, pin, deviceId } = req.body || {};
  if (!outletId || !pin) return res.status(400).json({ error: 'outletId and pin required' });
  // Bound the input before it reaches a KDF: a PIN is a short numeric string,
  // and accepting a megabyte of it is a free way to make the server work.
  if (!/^[0-9]{4,12}$/.test(String(pin))) {
    return res.status(401).json({ error: 'PIN not recognised' });
  }
  try {
    const out = await withOutlet({ outletId: Number(outletId), rank: 0 }, async function (c) {
      /* Narrow to the one or two staff who could hold this PIN, then scrypt
         only those — instead of a KDF pass per member of staff, which an
         unauthenticated caller could trigger at will. The counters and the
         session row go through SECURITY DEFINER functions because at this
         point in the request there is no rank yet, and every policy on
         chain.staff resolves against one. See migration 007. */
      const lookup = pinLookup(Number(outletId), pin);
      const q = await c.query('SELECT * FROM chain.pin_candidates($1,$2)',
        [Number(outletId), lookup]);
      const now = Date.now();
      for (const s of q.rows) {
        if (s.locked_until && new Date(s.locked_until).getTime() > now) continue;
        let ok = false;
        try { ok = pinMatches(pin, s.pin_hash, s.pin_salt); } catch (e) { ok = false; }
        if (!ok) continue;
        await c.query('SELECT chain.note_pin_attempt($1,$2,true,$3,$4)',
          [Number(outletId), s.id, LOCK_TRIES, LOCK_MINS]);
        const ttlHours = Number(process.env.SESSION_TTL_HOURS || 12);
        const sess = await c.query('SELECT chain.open_session($1,$2,$3,$4,$5) AS id',
          [s.id, Number(outletId), deviceId || null, s.rank, ttlHours]);
        await c.query('SELECT chain.log_signin($1,$2,true)', [Number(outletId), s.id]);
        return {
          token: sign({ o: Number(outletId), r: s.rank, s: s.id,
                        d: deviceId || null, sid: sess.rows[0].id,
                        exp: now + ttlHours * 3600e3 }),
          name: s.name, rank: s.rank, outletId: Number(outletId)
        };
      }
      /* Wrong PIN: count the attempt against every unlocked account at this
         outlet. With PIN-only sign-in the attacker never names an account, so
         a per-account counter would let them walk the whole space while no
         single counter ever climbed. */
      await c.query('SELECT chain.note_pin_attempt($1,NULL,false,$2,$3)',
        [Number(outletId), LOCK_TRIES, LOCK_MINS]);
      return null;
    });
    if (!out) return res.status(401).json({ error: 'PIN not recognised' });
    res.json(out);
  } catch (e) { next(e); }
});

/* ── a guest's session, minted for a table ──────────────────────────────────
 *
 * The QR card on a table encodes an outlet and a table number and nothing else.
 * A printed card cannot hold a secret: it is on the table, photographable, and
 * lives for as long as the laminate does. So the card carries no credential —
 * it points here, and this endpoint issues a SHORT-LIVED token pinned to that
 * one table.
 *
 * What the token can do is deliberately small: read the snapshot for its own
 * table, post an order, and raise a request. It is rank 0, so every atLeast()
 * gate on every till endpoint refuses it without having to know it exists.
 *
 * Public by necessity — a guest has nothing to authenticate with — so it is
 * rate limited, and it refuses a table the outlet does not have. Handing out a
 * token for table 9,999 would otherwise let anyone mint a session that reads
 * an empty ticket forever and hunt for tables that do exist.
 */
const GUEST_TTL_HOURS = Number(process.env.GUEST_TTL_HOURS || 4);

/* Per-instance, in memory. Railway may run more than one instance, so this
   bounds abuse per process rather than globally — it is a speed bump on a
   cheap endpoint, not the tenancy boundary, which is the token's own scope. */
const mintLog = new Map();
const MINT_MAX = 30, MINT_WINDOW_MS = 60000;
function mintAllowed(ip) {
  const now = Date.now();
  const hits = (mintLog.get(ip) || []).filter(function (t) { return now - t < MINT_WINDOW_MS; });
  hits.push(now);
  mintLog.set(ip, hits);
  if (mintLog.size > 5000) mintLog.clear();   // bounded: this is a speed bump, not a ledger
  return hits.length <= MINT_MAX;
}

/* The outlet's public face: the name on the welcome screen and how many tables
   to draw on the table gate. Public and credential-free BY DESIGN — it is the
   same information as the sign over the door and the number painted on the
   table, and the gate has to render before any table has been chosen, so there
   is no session to read it with yet.
   Nothing else is here: no prices, no tickets, no staff, no configuration. */
r.get('/outlet/:outletId/guest/card', async function (req, res, next) {
  const outletId = Number(req.params.outletId);
  if (!outletId) return res.status(400).json({ error: 'outletId required' });
  if (!mintAllowed(req.ip)) return res.status(429).json({ error: 'too many requests' });
  try {
    const out = await withOutlet({ outletId: outletId, rank: 0 }, function (c) {
      return c.query('SELECT name, tables FROM chain.outlet WHERE id = $1 AND active',
        [outletId]).then(function (q) { return q.rows[0] || null; });
    });
    if (!out) return res.status(404).json({ error: 'outlet not found' });
    res.set('cache-control', 'no-store')
      .json({ outletId: outletId, name: out.name, tables: Number(out.tables) });
  } catch (e) { next(e); }
});

r.post('/outlet/:outletId/guest/session', async function (req, res, next) {
  const outletId = Number(req.params.outletId);
  const table = String((req.body || {}).table || '').trim();
  if (!outletId || !table) return res.status(400).json({ error: 'outletId and table required' });
  if (!mintAllowed(req.ip)) return res.status(429).json({ error: 'too many requests' });
  try {
    /* Read the outlet as the outlet's own role. The table must be one this
       outlet actually has: tables are numbered 1..n on the outlet record, which
       is the same source the portal's table gate draws its tiles from. */
    const out = await withOutlet({ outletId: outletId, rank: 0 }, function (c) {
      return c.query('SELECT id, name, tables FROM chain.outlet WHERE id = $1 AND active',
        [outletId]).then(function (q) { return q.rows[0] || null; });
    });
    if (!out) return res.status(404).json({ error: 'outlet not found' });
    const n = Number(table);
    if (!Number.isInteger(n) || n < 1 || n > Number(out.tables)) {
      return res.status(404).json({ error: 'no such table' });
    }
    const exp = Date.now() + GUEST_TTL_HOURS * 3600e3;
    res.json({
      token: sign({ o: outletId, g: true, tbl: String(n), exp: exp }),
      outletId: outletId, table: String(n), outlet: out.name, expiresAt: exp,
    });
  } catch (e) { next(e); }
});

r.use(session);

r.get('/me', function (req, res) { res.json(req.ctx); });

// ── the snapshot both guest portals read. Prices, stages and what is owed —
//    no margins, no costs, no staff records. A guest device has no business
//    holding those, so they are not in the projection at all.
r.get('/outlet/:outletId/snapshot', sameOutlet, async function (req, res, next) {
  try {
    const data = await withOutlet(req.ctx, async function (c) {
      const [outlet, tax, items, tickets, stages] = await Promise.all([
        c.query('SELECT id, name, currency, service_pct, tables FROM chain.outlet WHERE id = $1', [req.ctx.outletId]),
        c.query('SELECT code, rate FROM chain.tax_version WHERE outlet_id = $1'
          + ' AND effective_from <= current_date'
          + ' AND (effective_to IS NULL OR effective_to >= current_date)'
          + ' ORDER BY effective_from DESC LIMIT 1', [req.ctx.outletId]),
        c.query('SELECT id, name, category, price, off_menu, station FROM item WHERE active'),
        /* A GUEST sees ONE table's ticket — its own. The projection used to
           return every open ticket in the outlet, so a phone at table 4 could
           read what table 9 had eaten and what they owed. Nothing in the app
           displayed it, which is exactly the point: the client was the only
           thing keeping one party's bill off another party's screen, and a
           client is not a boundary. $2 is NULL for a staff session, which sees
           the whole floor because that is its job. */
        /* `station` rides on each LINE, joined from the item master. The KDS
           draws a column per station and must show that station only what it
           cooks — without this the grill card listed the bar's drinks and the
           all-day strip counted every dish once per station the ticket
           touched, so a table ordering a burger and a cola read as two of
           each. A line whose item has no station falls to the pass, matching
           what kitchen.js did when it fired the round. */
        c.query("SELECT t.id, t.table_no, t.split, t.covers, t.status,"
          + " coalesce(json_agg(json_build_object('name', l.name, 'qty', l.qty,"
          + "   'price', l.unit_price, 'sent', l.sent_at IS NOT NULL,"
          + "   'station', i.station)"
          + "   ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines"
          + ' FROM ticket t LEFT JOIN ticket_line l'
          + '   ON l.ticket_id = t.id AND l.void_at IS NULL'
          + ' LEFT JOIN item i ON i.id = l.item_id'
          + " WHERE t.status = 'open' AND ($1::text IS NULL OR t.table_no = $1)"
          + ' GROUP BY t.id', [req.ctx.guest ? req.ctx.table : null]),
        /* Stages are joined to the tickets the caller may see, for the same
           reason: a stage row names a ticket, and a ticket names a table. */
        c.query('SELECT k.id, k.ticket_id, k.station, k.stage, k.target_mins, k.fired_at'
          + ' FROM kds_ticket k LEFT JOIN ticket t ON t.id = k.ticket_id'
          + ' WHERE k.served_at IS NULL'
          + " AND ($1::text IS NULL OR t.table_no = $1)",
        [req.ctx.guest ? req.ctx.table : null])
      ]);
      /* Stations ride on the snapshot so the KDS can draw its columns and
         colour its cards against each station's OWN target, without a second
         round trip on a screen that lives in a hot kitchen on poor wifi. */
      const stations = req.ctx.guest ? { rows: [] }
        : await c.query('SELECT name, target_mins, sort FROM chain.station'
          + ' WHERE outlet_id = $1 AND active ORDER BY sort, name', [req.ctx.outletId]);
      return {
        v: 5, at: Date.now(),
        outlet: outlet.rows[0] || null,
        tax: tax.rows[0] || null,
        items: items.rows,
        tickets: tickets.rows,
        stages: stages.rows,
        stations: stations.rows
      };
    });
    res.set('cache-control', 'no-store').json(data);
  } catch (e) { next(e); }
});

// ── a guest posts intent; the till decides. The phone never takes money. ────
r.post('/outlet/:outletId/guest/order', sameOutlet, ownTable, async function (req, res, next) {
  const { table, lines, promo, name, phone, opId } = req.body || {};
  if (!table || !Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: 'table and lines required' });
  }
  try {
    const out = await withOutlet(req.ctx, async function (c) {
      if (opId) {
        const seen = await c.query('SELECT result FROM op_log WHERE op_id = $1', [opId]);
        if (seen.rows.length) return seen.rows[0].result;   // replay, not a new order
      }
      const ins = await c.query(
        'INSERT INTO guest_order (table_no, lines, promo, guest_name, guest_phone)'
        + ' VALUES ($1,$2,$3,$4,$5) RETURNING id, at',
        [String(table), JSON.stringify(lines), promo || null, name || null, phone || null]);
      const result = { id: ins.rows[0].id, at: ins.rows[0].at, status: 'awaiting till' };
      if (opId) {
        await c.query('INSERT INTO op_log (op_id, kind, payload, client_at, result)'
          + " VALUES ($1,'guest_order',$2, now(), $3)",
          [opId, JSON.stringify(req.body), JSON.stringify(result)]);
      }
      await c.query("SELECT chain.log('guest_order','guest_order',$1,NULL,$2)",
        [ins.rows[0].id, JSON.stringify({ table: table, lines: lines.length })]);
      return result;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.post('/outlet/:outletId/guest/request', sameOutlet, ownTable, async function (req, res, next) {
  const { table, kind, detail } = req.body || {};
  if (!table || !kind) return res.status(400).json({ error: 'table and kind required' });
  try {
    const out = await withOutlet(req.ctx, function (c) {
      return c.query('INSERT INTO guest_request (table_no, kind, detail)'
        + ' VALUES ($1,$2,$3) RETURNING id, at', [String(table), kind, detail || null])
        .then(function (q) { return q.rows[0]; });
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/* ── Menu Master (§2 `menu`) ────────────────────────────────────────────────
 *
 * Manager rank and above. NOT on the offline replay path: a menu is edited in
 * an office by one person at a time, and an edit queued on a tablet for three
 * hours then replayed over somebody else's newer price is a worse outcome than
 * being told to reconnect. The till is offline-first because a queue of
 * customers cannot wait; a price list is not that.
 */
r.get('/outlet/:outletId/menu', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        return { items: await menu.list(c), stations: await menu.stations(c, req.ctx.outletId) };
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.post('/outlet/:outletId/menu', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return menu.create(c, req.body || {}, req.ctx);
      });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

r.patch('/outlet/:outletId/menu/:itemId', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return menu.update(c, req.params.itemId, req.body || {}, req.ctx);
      });
      res.json(out);
    } catch (e) { next(e); }
  });

r.delete('/outlet/:outletId/menu/:itemId', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return menu.retire(c, req.params.itemId);
      });
      res.json(out);
    } catch (e) { next(e); }
  });

/* ── Recipes & Costing (§2 `recipes`) ───────────────────────────────────────
 *
 * Manager rank. Costing is read against the tax rate in force TODAY, because
 * GP is measured on the price net of tax and a menu price is GST-inclusive —
 * measuring margin against a figure that includes the government's share
 * flatters every dish by the tax rate.
 */
async function todayRate(c, outletId) {
  try {
    return (await taxAsAt(c, outletId, new Date().toISOString().slice(0, 10))).rate;
  } catch (e) {
    // An outlet with no tax version yet is not GST-registered as far as this
    // screen is concerned; margin is then simply measured on the price.
    return 0;
  }
}

r.get('/outlet/:outletId/ingredients', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) { return recipes.listIngredients(c); });
      res.set('cache-control', 'no-store').json({ ingredients: out, units: recipes.UNITS });
    } catch (e) { next(e); }
  });

r.post('/outlet/:outletId/ingredients', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return recipes.createIngredient(c, req.body || {}, req.ctx);
      });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

r.patch('/outlet/:outletId/ingredients/:id', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return recipes.updateIngredient(c, req.params.id, req.body || {});
      });
      res.json(out);
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/recipes', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        return recipes.costedMenu(c, await todayRate(c, req.ctx.outletId));
      });
      res.set('cache-control', 'no-store').json({ items: out });
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/recipes/:itemId', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        return recipes.recipeFor(c, req.params.itemId, await todayRate(c, req.ctx.outletId));
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.put('/outlet/:outletId/recipes/:itemId', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return recipes.putRecipe(c, req.params.itemId, req.body || {}, req.ctx);
      });
      res.json(out);
    } catch (e) { next(e); }
  });

/* ── Inventory and the stock ledger (§2 `inventory`, `ledger`) ─────────────
 * Reads at manager rank. WRITES go through the replay path below, so a stock
 * count taken on a tablet in a walk-in freezer with no signal is queued and
 * replayed exactly once, like every other movement of value in the system.
 */
r.get('/outlet/:outletId/inventory', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) { return stock.inventory(c); });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/inventory/:id/ledger', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return stock.ledger(c, req.params.id, Number(req.query.limit) || 0);
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

/* ── Orders & Tickets (§2 `orders`) ────────────────────────────────────────
 *
 * TILL rank: a cashier must be able to find the receipt they handed over a
 * minute ago. What a cashier may NOT see is what the food cost — orders.js
 * strips cost, COGS and the inventory legs of the journal below manager rank,
 * and the audit trail is manager-only because that is what the RLS policy on
 * chain.audit already says.
 *
 * Read-only. Voiding a sale is a reversing journal and a stock return, which is
 * its own operation on the replay path with its own rank — not an edit made
 * from a history screen.
 */
r.get('/outlet/:outletId/orders', sameOutlet, staffOnly, atLeast('till'),
  async function (req, res, next) {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return orders.day(c, { date, limit: req.query.limit, offset: req.query.offset });
      });
      res.set('cache-control', 'no-store').json(orders.redactDay(out, req.ctx.rank));
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/orders/:saleId', sameOutlet, staffOnly, atLeast('till'),
  async function (req, res, next) {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.saleId))) {
      return res.status(404).json({ error: 'no such sale' });
    }
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return orders.receipt(c, req.params.saleId, req.ctx.rank);
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

/* ── the cash drawer ───────────────────────────────────────────────────────
 *
 * TILL rank to read: a cashier working the register has to see where their own
 * drawer stands before they count it. Opening and closing go through the replay
 * path with the other operations that move money.
 */
r.get('/outlet/:outletId/drawer', sameOutlet, staffOnly, atLeast('till'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) { return drawer.current(c); });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

/* ── Today (§2 `today`) ────────────────────────────────────────────────────
 *
 * The manager's morning list. Manager rank, matching the rail. Margin is
 * measured against the price NET of tax, so it needs today's rate — read here
 * rather than assumed, because an outlet that is not GST-registered has a rate
 * of zero and measuring its margin against 8% would invent a loss.
 */
r.get('/outlet/:outletId/today', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        return today.waiting(c, date, await todayRate(c, req.ctx.outletId));
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

/* ── Reports & Exports (§2 `reports`) ──────────────────────────────────────
 *
 * MANAGER rank, matching the rail. Every figure is derived in reports.js from
 * `journal_line` — §22 requires the P&L, the trial balance, the tax return and
 * the Z-reads to agree with each other, and they can only agree if they are the
 * same arithmetic over the same rows.
 *
 * A date range is validated here rather than passed through: `from`/`to` reach
 * SQL as parameters, but a malformed date should be a 400 with a sentence, not
 * a driver error surfacing as a 500.
 */
function range(req, res) {
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  for (const d of [from, to]) {
    if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
      return null;
    }
  }
  if (from && to && from > to) {
    res.status(400).json({ error: 'from is after to' });
    return null;
  }
  return { from, to };
}

r.get('/outlet/:outletId/reports/zread', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        return reports.zRead(c, date, await drawer.sessionsOn(c, date));
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/reports/trial-balance', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    const p = range(req, res); if (!p) return;
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return reports.trialBalance(c, p.from, p.to);
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/reports/pnl', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    const p = range(req, res); if (!p) return;
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return reports.profitAndLoss(c, p.from, p.to);
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/reports/tax', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    const p = range(req, res); if (!p) return;
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return reports.taxReturn(c, p.from, p.to);
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

/* ── Staff & Time Clock (§2 `staff`) ──────────────────────────────────────
 *
 * The ROSTER is manager rank, matching the rail. Writing it is ADMIN, and the
 * rank ceiling — nobody creates or promotes above their own rank — is enforced
 * by the `staff_write` RLS policy as well as by staff.js, because rank is the
 * only gate in this system and a check in application code is a check somebody
 * forgets to write on the next endpoint.
 *
 * The CLOCK is on the replay path at rank 1: a kitchen hand clocks themselves
 * in at 6am, and a system that needed a manager present to start a shift is a
 * system people work around with a notebook.
 */
r.get('/outlet/:outletId/staff', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        return {
          roster: await staff.roster(c, req.ctx.outletId),
          day: await staff.shifts(c, date),
          ranks: staff.RANK_NAME,
          // What THIS caller may do, so the screen does not offer a button that
          // will be refused — and does not hide one that would be allowed.
          maxRank: req.ctx.rank,
          canWrite: req.ctx.rank >= 4,
        };
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

/* A member of staff can always see their OWN clock, at any rank — that is the
   till's shift badge, and it is the one thing on this module a kitchen hand
   needs. */
r.get('/outlet/:outletId/staff/me', sameOutlet, staffOnly, atLeast('kitchen'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        const q = await c.query(
          'SELECT id, in_at FROM shift WHERE staff_id = $1 AND out_at IS NULL',
          [req.ctx.actor]);
        return q.rows.length
          ? { onShift: true, shiftId: q.rows[0].id, since: q.rows[0].in_at }
          : { onShift: false };
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.post('/outlet/:outletId/staff', sameOutlet, staffOnly, atLeast('admin'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return staff.addStaff(c, req.body || {}, req.ctx);
      });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

r.patch('/outlet/:outletId/staff/:id', sameOutlet, staffOnly, atLeast('admin'),
  async function (req, res, next) {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {
      return res.status(404).json({ error: 'nobody works here under that id' });
    }
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return staff.updateStaff(c, req.params.id, req.body || {}, req.ctx);
      });
      res.json(out);
    } catch (e) { next(e); }
  });

/* Releasing a lockout is a MANAGER's job, not an admin's: the usual cause is
   five fat-fingered attempts on a wet screen mid-service, and the person who
   can fix it is the one standing there. */
r.post('/outlet/:outletId/staff/:id/unlock', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {
      return res.status(404).json({ error: 'nobody works here under that id' });
    }
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return staff.unlock(c, req.params.id, req.ctx);
      });
      res.json(out);
    } catch (e) { next(e); }
  });

/* ── Vendors (§2 `vendors`) and Purchases / GRN (§2 `purchases`) ──────────
 *
 * Reads at manager rank — a chef checking what a supplier charged is doing
 * their job. Writing the SUPPLIER MASTER is admin: it is shared across the
 * estate, and it carries payment terms. Receiving and pricing go through the
 * replay path, because a delivery arrives at a back door with no signal.
 */
r.get('/outlet/:outletId/vendors', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) { return purchasing.suppliers(c); });
      res.set('cache-control', 'no-store').json({ suppliers: out });
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/vendors/:id', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {
      return res.status(404).json({ error: 'no such supplier' });
    }
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return purchasing.supplier(c, req.params.id);
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.post('/outlet/:outletId/vendors', sameOutlet, staffOnly, atLeast('admin'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return purchasing.createSupplier(c, req.body || {}, req.ctx);
      });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

r.patch('/outlet/:outletId/vendors/:id', sameOutlet, staffOnly, atLeast('admin'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return purchasing.updateSupplier(c, req.params.id, req.body || {}, req.ctx);
      });
      res.json(out);
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/purchases', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        return {
          deliveries: await purchasing.deliveries(c, req.query.limit),
          ageing: await purchasing.ageing(c),
          suppliers: await purchasing.suppliers(c),
        };
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/purchases/:id', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {
      return res.status(404).json({ error: 'no such delivery' });
    }
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return purchasing.delivery(c, req.params.id);
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

/* ── Stock Counts (§2 `counts`) and the Stock Ledger (§2 `ledger`) ────────
 * Reads at manager rank. Counting itself, and approving a count, go through
 * the replay path with everything else that moves value.
 */
r.get('/outlet/:outletId/counts', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        const o = await c.query(
          'SELECT count_approval_laari FROM chain.outlet WHERE id = $1', [req.ctx.outletId]);
        return {
          counts: await stock.counts(c, req.query.limit),
          // The policy in force, so the screen can say what will need approving
          // BEFORE somebody spends twenty minutes counting a freezer.
          threshold: Number((o.rows[0] || {}).count_approval_laari || 0) / 100,
          approveRank: stock.APPROVE_RANK,
        };
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

/* A blank sheet to go and count against. `sheet` before `:countId` in the
   router, or the literal would be read as a count id. */
r.get('/outlet/:outletId/counts/sheet', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    const cats = req.query.categories
      ? String(req.query.categories).split(',').map((x) => x.trim()).filter(Boolean)
      : [];
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        return {
          ...(await stock.categories(c)),
          chosen: cats,
          items: await stock.countSheetFor(c, cats),
        };
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/counts/:countId', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.countId))) {
      return res.status(404).json({ error: 'no such count' });
    }
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return stock.countSheet(c, req.params.countId);
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/ledger', sameOutlet, staffOnly, atLeast('manager'),
  async function (req, res, next) {
    for (const d of [req.query.from, req.query.to]) {
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
        return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
      }
    }
    try {
      const out = await withOutlet(req.ctx, function (c) {
        return stock.movements(c, {
          ingredientId: req.query.ingredient, reason: req.query.reason,
          from: req.query.from, to: req.query.to,
          limit: req.query.limit, offset: req.query.offset,
        });
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

// ── offline replay. Idempotent by construction: the client's own op_id is the
//    primary key, and a closed sale is never reopened by a late arrival.
r.post('/outlet/:outletId/sync/push', sameOutlet, staffOnly, atLeast('kitchen'),
  async function (req, res, next) {
    const ops = (req.body || {}).ops;
    if (!Array.isArray(ops)) return res.status(400).json({ error: 'ops[] required' });
    try {
      const results = await withOutlet(req.ctx, async function (c) {
        const out = [];
        for (const op of ops) {
          if (!op || !op.opId) { out.push({ error: 'opId required' }); continue; }
          const seen = await c.query('SELECT result FROM op_log WHERE op_id = $1', [op.opId]);
          if (seen.rows.length) { out.push({ opId: op.opId, replay: true, result: seen.rows[0].result }); continue; }
          let result;
          try { result = await apply(c, op, req.ctx); }
          catch (e) { out.push({ opId: op.opId, error: e.message }); continue; }
          await c.query('INSERT INTO op_log (op_id, kind, payload, client_at, device_id, by_staff, result)'
            + ' VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [op.opId, op.kind, JSON.stringify(op.payload || {}),
             new Date(op.at || Date.now()), req.ctx.deviceId, req.ctx.actor,
             JSON.stringify(result || {})]);
          out.push({ opId: op.opId, result: result });
        }
        return out;
      });
      res.json({ results: results });
    } catch (e) { next(e); }
  });

r.get('/outlet/:outletId/sync/pull', sameOutlet, staffOnly, atLeast('till'),
  async function (req, res, next) {
    const since = new Date(Number(req.query.since || 0) || 0);
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        const [ops, orders, reqs] = await Promise.all([
          c.query('SELECT op_id, kind, result, applied_at FROM op_log'
            + ' WHERE applied_at > $1 ORDER BY applied_at LIMIT 500', [since]),
          c.query('SELECT id, table_no, lines, promo, at FROM guest_order'
            + ' WHERE accepted_at IS NULL AND rejected_reason IS NULL ORDER BY at'),
          c.query('SELECT id, table_no, kind, detail, at FROM guest_request'
            + ' WHERE ack_at IS NULL ORDER BY at')
        ]);
        return { now: Date.now(), ops: ops.rows, guestOrders: orders.rows, guestRequests: reqs.rows };
      });
      res.set('cache-control', 'no-store').json(out);
    } catch (e) { next(e); }
  });

// The one cross-outlet read in the system: aggregates only, rank 5 only,
// through a read-only role, and stamped in the audit trail as group scope.
r.get('/estate/day', staffOnly, atLeast('owner'), async function (req, res, next) {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const rows = await withEstate(req.ctx, function (c) {
      return c.query('SELECT * FROM chain.estate_day($1)', [date])
        .then(function (q) { return q.rows; });
    });
    res.json({ date: date, outlets: rows });
  } catch (e) { next(e); }
});

// ── apply one replayed operation ────────────────────────────────────────────
/* The rank each operation needs, BY OPERATION rather than by endpoint.
 *
 * /sync/push is one pipe carrying very different acts, and gating the pipe was
 * wrong in both directions: at till rank a kitchen hand could not advance their
 * own pass (the KDS is rank 1 precisely so it needs no session that can sell),
 * and anything that got through the pipe could post a journal. A transport is
 * not an authorisation model. */
const OP_RANK = {
  kds_advance: 1,          // the pass — the lowest rank, deliberately
  /* Clocking on is rank 1 by design. staff.js refuses clocking SOMEBODY ELSE
     below manager rank, which is the distinction that matters. */
  clock_in: 1,
  clock_out: 1,
  ticket_send: 2,          // firing the kitchen moves no money
  guest_order_accept: 2,
  sale: 2,                 // taking money is the till's job
  drawer_open: 2,          // …and so is counting the drawer it comes out of
  drawer_close: 2,
  stock_receive: 3,        // receiving stock creates value in the accounts
  stock_waste: 3,          // and wastage destroys it
  stock_count: 3,          // a count writes on-hand; that is a manager's act
  /* Approving somebody else's count is ADMIN. A count is the one operation
     where a person types a number and the accounts move to meet it, so the
     signature has to come from above the person who took it — stock.js refuses
     a self-approval on top of this. */
  stock_count_approve: 4,
  stock_count_reject: 4,
  /* Receiving is a MANAGER's act — somebody has to be able to take a delivery
     at 6am. Pricing it moves money between accounts and settles what is owed,
     so those are admin. */
  delivery_receive: 3,
  delivery_price: 4,
  invoice_pay: 4,
  journal: 3,              // a hand-posted journal, with its own audit entry
};

async function apply(c, op, ctx) {
  const need = OP_RANK[op.kind];
  if (need === undefined) throw new Error('unknown op kind: ' + op.kind);
  if ((ctx.rank || 0) < need) {
    throw Object.assign(new Error(op.kind + ' needs rank ' + need), { status: 403 });
  }
  switch (op.kind) {
    case 'sale': {
      /* Everything financial is derived server-side — see src/sale.js for why
         the payload's own gross/tax/total/journal are not trusted. The outlet
         row carries the service charge and the cash-rounding increment, and it
         is read HERE rather than passed in, so a replay arriving days later is
         priced by the outlet's configuration and not by the client's memory
         of it. */
      const outlet = await c.query(
        'SELECT service_pct, cash_round_laari FROM chain.outlet WHERE id = $1',
        [ctx.outletId]);
      if (!outlet.rows.length) throw new Error('outlet not found');
      return await settle(c, op.payload || {}, ctx, outlet.rows[0]);
    }
    case 'ticket_send':
      return await kitchen.sendRound(c, op.payload || {}, ctx);

    case 'kds_advance':
      return await kitchen.advance(c, op.payload || {}, ctx);

    case 'clock_in':
      return await staff.clockIn(c, op.payload || {}, ctx);

    case 'clock_out':
      return await staff.clockOut(c, op.payload || {}, ctx);

    case 'drawer_open':
      return await drawer.open(c, op.payload || {}, ctx);

    case 'drawer_close':
      return await drawer.close(c, op.payload || {}, ctx);

    case 'stock_receive':
      return await stock.receive(c, op.payload || {}, ctx);

    case 'stock_waste':
      return await stock.waste(c, op.payload || {}, ctx);

    case 'stock_count': {
      /* The approval threshold is the OUTLET's, read here rather than sent by
         the client — a tablet replaying a count from three hours ago must be
         held to the policy in force now, not to the one it remembered. */
      const o = await c.query(
        'SELECT count_approval_laari FROM chain.outlet WHERE id = $1', [ctx.outletId]);
      return await stock.count(c, op.payload || {}, ctx, o.rows[0] || {});
    }

    case 'delivery_receive':
      return await purchasing.receiveDelivery(c, op.payload || {}, ctx);

    case 'delivery_price':
      return await purchasing.priceDelivery(c, op.payload || {}, ctx);

    case 'invoice_pay':
      return await purchasing.payInvoice(c, op.payload || {}, ctx);

    case 'stock_count_approve':
      return await stock.approveCount(c, op.payload || {}, ctx);

    case 'stock_count_reject':
      return await stock.rejectCount(c, op.payload || {}, ctx);

    case 'journal':
      return { journalId: await postJournal(c, op.payload, ctx, op.payload.source || 'manual', null) };
    case 'guest_order_accept': {
      const p = op.payload || {};
      await c.query('UPDATE guest_order SET accepted_at = now(), accepted_by = $2,'
        + ' ticket_id = $3 WHERE id = $1 AND accepted_at IS NULL',
        [p.id, ctx.actor, p.ticketId || null]);
      return { id: p.id, accepted: true };
    }
    default:
      throw new Error('unknown op kind: ' + op.kind);
  }
}

async function postJournal(c, j, ctx, source, sourceId) {
  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['JV']);
  const h = await c.query('INSERT INTO journal (jv_no, entry_date, memo, source,'
    + ' source_id, posted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [no.rows[0].no, j.date, j.memo, source, sourceId, ctx.actor]);
  for (const l of (j.lines || [])) {
    await c.query('INSERT INTO journal_line (journal_id, account_code, dr, cr)'
      + ' VALUES ($1,$2,$3,$4)', [h.rows[0].id, l.account, l.dr || 0, l.cr || 0]);
  }
  return h.rows[0].id;   // the deferred trigger refuses an unbalanced entry at COMMIT
}

module.exports = r;
