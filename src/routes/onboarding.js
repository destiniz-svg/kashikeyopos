'use strict';
/* ═══ ONBOARDING ════════════════════════════════════════════════════════════
   Fourteen steps, forced by dependency. Each step writes THE SAME RECORDS the
   running app reads and edits afterwards — there is no config blob and no
   wizard-only table. That is the whole discipline: if step 2 wrote something
   only the wizard understood, step 2 would become un-editable the moment the
   wizard closed.

   Every step therefore has an equivalent edit path once the app is running,
   and this router mostly delegates to the same handlers the sync path uses.

   Only the first three steps run without a STAFF session, because until step 3
   there is nobody to sign in as. `chain.claim_first_owner()` can succeed exactly
   once in the life of an installation.

   An ACCOUNT session — the person who signed up on the website — may be present
   from the first step, and if it is, the business that gets created is theirs.
   It is attached optionally rather than required, so an install that predates
   accounts still finishes, and a terminal onboarding itself on the counter is
   not blocked by an email address nobody has typed yet.
   ═══════════════════════════════════════════════════════════════════════ */

const express = require('express');
const { owner, withOutlet } = require('../db');
const { provisionOutlet } = require('../provision');
const { hashPin, sign, verifyAccount } = require('../secrets');
const { session, atLeast, ROLE_KEY_BY_RANK } = require('../auth');
const { applyOp } = require('../apply');

const r = express.Router();

/* Attach the signed-up account when one is presented. Never refuses: the
   account is who to CREDIT the business to, not permission to create it. */
r.use(async function (req, res, next) {
  const raw = String(req.get('x-account-token') || '');
  if (!raw) return next();
  const claims = verifyAccount(raw);
  if (!claims || !claims.a) return next();
  try {
    const q = await owner().query(
      "SELECT id, email, name, status FROM chain.account WHERE id = $1", [claims.a]);
    if (q.rows.length && q.rows[0].status === 'active') req.account = q.rows[0];
    next();
  } catch (e) { next(); }
});

const STEPS = [
  { key: 'company', label: 'Company', sub: 'The entity that files the return' },
  { key: 'outlet', label: 'First outlet', sub: 'Its own schema and login role' },
  { key: 'owner', label: 'Owner account', sub: 'Rank 5 — the only account that can create others' },
  { key: 'tax', label: 'Tax profile', sub: 'The rate in force, and from when' },
  { key: 'series', label: 'Document series', sub: 'Once used, never renumbered' },
  { key: 'chart', label: 'Chart of accounts', sub: 'Shipped complete — confirm the bank' },
  { key: 'units', label: 'Units', sub: 'What the kitchen buys and cooks in' },
  { key: 'locations', label: 'Locations', sub: 'Stock cannot exist without one' },
  { key: 'items', label: 'Items', sub: 'The first ingredients, with a cost' },
  { key: 'menu', label: 'Menu', sub: 'Sections, dishes, then the recipe on each' },
  { key: 'floor', label: 'Tables and zones', sub: 'Or takeaway only, if that is the business' },
  { key: 'staff', label: 'Staff', sub: 'The people who will use it, each with a rank' },
  { key: 'device', label: 'Device', sub: 'A device is attributable or it takes no money' },
  { key: 'register', label: 'Open the register', sub: 'Float counted. Only now can a sale happen' }
];

/* ── where are we? Anonymous until an owner exists, because until then there
      is nobody who could be asked to authenticate. ─────────────────────── */
r.get('/state', async function (req, res, next) {
  try {
    const st = await owner().query('SELECT * FROM chain.install_state()');
    const s = st.rows[0];
    const done = { company: Number(s.company) > 0, outlet: Number(s.outlets) > 0,
      owner: Number(s.staff) > 0 };
    let deeper = {};
    if (done.outlet) {
      const o = await owner().query('SELECT id, schema_name FROM chain.outlet'
        + ' ORDER BY id LIMIT 1');
      const sc = o.rows[0].schema_name;
      const q = await owner().query(
        'SELECT (SELECT count(*) FROM chain.tax_version WHERE outlet_id = $1) AS tax,'
        + ' (SELECT count(*) FROM chain.doc_series WHERE outlet_id = $1) AS series,'
        + ' (SELECT count(*) FROM ' + q0(sc) + '.account) AS chart,'
        + ' (SELECT count(*) FROM ' + q0(sc) + '.location) AS locations,'
        + ' (SELECT count(*) FROM ' + q0(sc) + '.ingredient) AS items,'
        + ' (SELECT count(*) FROM ' + q0(sc) + '.item) AS dishes,'
        + ' (SELECT count(*) FROM ' + q0(sc) + '.recipe_line) AS recipes,'
        + ' (SELECT count(*) FROM ' + q0(sc) + '.table_def) AS tables,'
        + ' (SELECT count(*) FROM chain.staff) AS staff,'
        + ' (SELECT count(*) FROM chain.device WHERE outlet_id = $1) AS devices,'
        + ' (SELECT count(*) FROM ' + q0(sc) + '.drawer_session'
        + '    WHERE closed_at IS NULL) AS register,'
        + ' (SELECT count(*) FROM ' + q0(sc) + '.bank_opening) AS bank',
        [o.rows[0].id]);
      const n = q.rows[0];
      deeper = {
        tax: Number(n.tax) > 0, series: Number(n.series) > 0,
        chart: Number(n.chart) > 0 && Number(n.bank) > 0,
        units: true,
        locations: Number(n.locations) > 0,
        items: Number(n.items) > 0,
        menu: Number(n.dishes) > 0,
        floor: Number(n.tables) > 0,
        staff: Number(n.staff) > 1 || Number(n.staff) > 0,
        device: Number(n.devices) > 0,
        register: Number(n.register) > 0,
        counts: {
          items: Number(n.items), dishes: Number(n.dishes),
          recipes: Number(n.recipes), tables: Number(n.tables),
          staff: Number(n.staff), devices: Number(n.devices)
        }
      };
    }
    const state = Object.assign({}, done, deeper);
    res.set('cache-control', 'no-store').json({
      steps: STEPS.map((x) => Object.assign({}, x, { done: !!state[x.key] })),
      done: STEPS.every((x) => state[x.key]),
      next: (STEPS.find((x) => !state[x.key]) || {}).key || null,
      counts: deeper.counts || {}
    });
  } catch (e) { next(e); }
});

// Schema names come from chain.outlet, which only this server writes, and are
// matched against the shape provision_outlet() creates. Anything else is a bug
// upstream and must not reach a query.
function q0(schema) {
  if (!/^outlet_\d+$/.test(schema)) throw new Error('bad schema name');
  return schema;
}

/* ── 1 · Company. The legal entity: this is who files the return. ────────── */
r.post('/company', async function (req, res, next) {
  const b = req.body || {};
  if (!b.legalName || !b.regNo || !b.tin || !b.address) {
    return res.status(400).json({ error: 'legal name, registration number, TIN and registered address are all required' });
  }
  try {
    const already = await owner().query('SELECT id FROM chain.company WHERE id = 1');
    if (already.rows.length) {
      // Editable from Settings afterwards, through the same columns.
      if (!req.get('authorization')) return res.status(409).json({ error: 'company already set — edit it in Settings' });
    }
    await owner().query(
      'INSERT INTO chain.company (id, legal_name, reg_no, tin, address, atoll,'
      + ' country, phone, email, base_currency, fy_start_month, brand)'
      + " VALUES (1,$1,$2,$3,$4,$5,coalesce($6,'Maldives'),$7,$8,coalesce($9,'MVR'),"
      + ' coalesce($10,1), $11) ON CONFLICT (id) DO UPDATE SET legal_name = $1,'
      + ' reg_no = $2, tin = $3, address = $4, atoll = $5, phone = $7, email = $8,'
      // The base currency is the books' currency; re-running the step must be
      // able to correct it while the install is still empty.
      + " base_currency = coalesce($9, chain.company.base_currency),"
      + ' brand = $11, updated_at = now()',
      [b.legalName, b.regNo, b.tin, b.address, b.atoll || null, b.country || null,
        b.phone || null, b.email || null, b.currency || null,
        b.fyStartMonth || null, JSON.stringify(b.brand || {})]);
    // Whoever is signed in as they complete this owns the business. The
    // question "whose is this" must not depend on which outlet you look at.
    if (req.account) {
      await owner().query(
        'UPDATE chain.company SET owner_account_id = coalesce(owner_account_id, $1)'
        + ' WHERE id = 1', [req.account.id]);
    }
    res.json({ ok: true, step: 'company' });
  } catch (e) { next(e); }
});

// The books' currency, as the company step recorded it.
async function baseCurrency() {
  const q = await owner().query('SELECT base_currency FROM chain.company WHERE id = 1');
  return (q.rows[0] || {}).base_currency || 'MVR';
}

/* ── 2 · First outlet. Creates the schema and the login role. ───────────── */
r.post('/outlet', async function (req, res, next) {
  const b = req.body || {};
  if (!b.name || !b.code) return res.status(400).json({ error: 'outlet name and code required' });
  try {
    const st = await owner().query('SELECT * FROM chain.install_state()');
    const first = Number(st.rows[0].outlets) === 0;
    if (!first && !req.get('authorization')) {
      return res.status(403).json({ error: 'sign in to add another outlet' });
    }
    const out = await provisionOutlet({
      name: b.name, code: b.code, kind: b.kind || 'restaurant',
      taxCode: b.taxCode || 'GGST', taxRate: b.taxRate, taxFrom: b.taxFrom,
      servicePct: b.servicePct == null ? 10 : b.servicePct,
      address: b.address, atoll: b.atoll, phone: b.phone,
      // An outlet keeps the company's books, so it keeps the company's
      // currency unless it is explicitly given another one.
      tz: b.tz, currency: b.currency || (await baseCurrency()), dayStart: b.dayStart
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/* ── 3 · Owner account. Rank 5. Callable once, then never again. ────────── */
r.post('/owner', async function (req, res, next) {
  const b = req.body || {};
  if (!b.name || !b.pin) return res.status(400).json({ error: 'name and PIN required' });
  if (!/^\d{4,8}$/.test(String(b.pin))) return res.status(400).json({ error: 'PIN must be 4 to 8 digits' });
  try {
    const o = await owner().query('SELECT id FROM chain.outlet ORDER BY id LIMIT 1');
    if (!o.rows.length) return res.status(409).json({ error: 'create the first outlet before the owner account' });
    const h = hashPin(b.pin);
    const q = await owner().query('SELECT chain.claim_first_owner($1,$2,$3,$4) AS id',
      [o.rows[0].id, b.name, h.hash, h.salt]);
    const hours = Number(process.env.SESSION_TTL_HOURS || 12);
    const staffId = q.rows[0].id;
    await withOutlet({ outletId: o.rows[0].id, rank: 5, actor: staffId }, (c) =>
      c.query('INSERT INTO chain.session (staff_id, outlet_id, rank, expires_at)'
        + " VALUES ($1,$2,5, now() + ($3 || ' hours')::interval)",
      [staffId, o.rows[0].id, String(hours)]));
    /* The account that completed onboarding becomes this outlet's OWNER —
       the master admin — and keeps the rank-5 staff record it just created for
       the floor. A founder is usually both people; they are still two records,
       because one signs in with an email and the other taps four digits. */
    if (req.account) {
      await owner().query(
        'INSERT INTO chain.account_outlet (account_id, outlet_id, role, staff_id)'
        + " VALUES ($1,$2,'owner',$3)"
        + ' ON CONFLICT (account_id, outlet_id) DO UPDATE SET staff_id = $3',
        [req.account.id, o.rows[0].id, staffId]);
      await owner().query(
        "SELECT chain.log_anon($1,'outlet_owner_set','account',$2,$3)",
        [o.rows[0].id, req.account.id,
          JSON.stringify({ email: req.account.email, staffId: staffId })]).catch(() => {});
    }
    res.status(201).json({
      staffId,
      token: sign({ o: o.rows[0].id, r: 5, s: staffId, n: b.name,
        rk: 'SuperAdmin', exp: Date.now() + hours * 3600e3 }),
      name: b.name, rank: 5, roleKey: 'SuperAdmin', outletId: o.rows[0].id,
      ownedBy: req.account ? req.account.email : null
    });
  } catch (e) {
    if (/already exists/.test(e.message)) return res.status(409).json({ error: 'an owner already exists — sign in with a PIN' });
    next(e);
  }
});

// Everything past step 3 is a signed-in act, at rank 4 or above.
r.use(session, atLeast('admin'));

/* ── 4 · Tax profile. A version is law: it carries the date it took effect,
      so a rate change next year cannot restate this year's receipts. ────── */
r.post('/tax', async function (req, res, next) {
  const b = req.body || {};
  try {
    await withOutlet(req.ctx, async function (c) {
      await c.query('UPDATE chain.outlet SET tax_code = $2 WHERE id = $1',
        [req.ctx.outletId, b.code || 'GGST']);
      if (b.code === 'NONE') {
        await c.query('INSERT INTO chain.tax_version (outlet_id, code, rate,'
          + " effective_from, authority_ref) VALUES ($1,'NONE',0,$2,'Not registered')"
          + ' ON CONFLICT DO NOTHING', [req.ctx.outletId, b.from || today()]);
      } else {
        await c.query('INSERT INTO chain.tax_version (outlet_id, code, rate,'
          + ' effective_from, authority_ref) VALUES ($1,$2,$3,$4,$5)'
          + ' ON CONFLICT (outlet_id, code, effective_from) DO UPDATE SET rate = $3',
          [req.ctx.outletId, b.code, Number(b.rate), b.from || today(),
            b.ref || 'Confirmed at onboarding']);
      }
      if (b.servicePct != null) {
        await c.query('UPDATE chain.outlet SET service_pct = $2 WHERE id = $1',
          [req.ctx.outletId, Number(b.servicePct)]);
      }
    });
    res.json({ ok: true, step: 'tax' });
  } catch (e) { next(e); }
});

/* ── 5 · Document series. A series that has issued a number cannot be
      renumbered — that is what makes the trail auditable. ──────────────── */
r.post('/series', async function (req, res, next) {
  const list = (req.body || {}).series;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'series[] required' });
  try {
    const out = await withOutlet(req.ctx, async function (c) {
      const changed = [], refused = [];
      for (const s of list) {
        const cur = await c.query('SELECT used, next_no FROM chain.doc_series'
          + ' WHERE outlet_id = $1 AND kind = $2', [req.ctx.outletId, s.kind]);
        if (cur.rows.length && cur.rows[0].used) { refused.push(s.kind); continue; }
        await c.query('INSERT INTO chain.doc_series (outlet_id, kind, prefix, next_no)'
          + ' VALUES ($1,$2,$3,$4) ON CONFLICT (outlet_id, kind) DO UPDATE'
          + ' SET prefix = excluded.prefix, next_no = excluded.next_no',
          [req.ctx.outletId, s.kind, s.prefix, Number(s.start) || 1]);
        changed.push(s.kind);
      }
      return { changed, refused };
    });
    res.json(Object.assign({ ok: true, step: 'series' }, out,
      out.refused.length ? { note: 'A series that has already issued a number cannot be renumbered: ' + out.refused.join(', ') } : {}));
  } catch (e) { next(e); }
});

/* ── 6 · Chart of accounts — shipped complete. The step is to confirm the
      bank account and its opening balance, which is what the reconciliation
      counts forward from. ────────────────────────────────────────────── */
r.post('/chart', async function (req, res, next) {
  const b = req.body || {};
  try {
    await withOutlet(req.ctx, async function (c) {
      if (b.bankName) {
        await c.query('UPDATE account SET name = $2 WHERE code = $1',
          [b.bankCode || '1020', b.bankName]);
      }
      // The opening balance is the anchor the RECONCILIATION counts forward
      // from — the statement position on the day the books started. It is
      // deliberately not a journal: posting it would need an equity account
      // the chart does not carry, and the trial balance must square on an
      // empty database, which it does only if nothing was posted into it.
      await applyOp(c, { kind: 'bank_opening', payload: {
        acct: b.bankCode || '1020', asOf: b.asOf || today(), amt: Number(b.opening) || 0
      } }, req.ctx);
    });
    res.json({ ok: true, step: 'chart' });
  } catch (e) { next(e); }
});

/* ── 7 · Units. Confirm the base units the kitchen buys and cooks in. ───── */
r.post('/units', async function (req, res, next) {
  const list = (req.body || {}).units;
  try {
    if (Array.isArray(list) && list.length) {
      await withOutlet(req.ctx, (c) => c.query(
        'INSERT INTO chain.setting (key, value, updated_by)'
        + " VALUES ('units',$1,$2) ON CONFLICT (key) DO UPDATE SET value = $1,"
        + ' updated_at = now()', [JSON.stringify(list), req.ctx.actor]));
    }
    res.json({ ok: true, step: 'units' });
  } catch (e) { next(e); }
});

/* ── 8-13 · The rest write through the SAME handlers the running app uses.
      One implementation, so the wizard's output and the app's model cannot
      drift apart. ─────────────────────────────────────────────────────── */
const BULK = {
  locations: ['locations', 'location_upsert'],
  items: ['items', 'item_upsert'],
  sections: ['sections', 'menu_section_insert'],
  categories: ['categories', 'menu_category_insert'],
  dishes: ['dishes', 'dish_upsert'],
  tables: ['tables', 'table_update'],
  zones: ['zones', 'zones_update'],
  employees: ['employees', 'employee_upsert']
};

Object.keys(BULK).forEach(function (path) {
  const [field, kind] = BULK[path];
  r.post('/' + path, async function (req, res, next) {
    const list = (req.body || {})[field];
    if (!Array.isArray(list)) return res.status(400).json({ error: field + '[] required' });
    try {
      const results = await withOutlet(req.ctx, async function (c) {
        const out = [];
        for (const row of list) out.push(await applyOp(c, { kind, payload: row }, req.ctx));
        return out;
      });
      res.json({ ok: true, written: results.length, results });
    } catch (e) { next(e); }
  });
});

/* ── 12 · Staff. Rank-gated the same way the running app gates it. ──────── */
r.post('/staff', async function (req, res, next) {
  const list = (req.body || {}).staff;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'staff[] required' });
  try {
    const made = await withOutlet(req.ctx, async function (c) {
      const out = [];
      for (const p of list) {
        if (!p.name || !p.pin || !p.rank) continue;
        if (Number(p.rank) > req.ctx.rank) {
          out.push({ name: p.name, refused: 'above your own rank' });
          continue;
        }
        const h = hashPin(p.pin);
        const q = await c.query(
          'INSERT INTO chain.staff (name, rank, role_key, outlet_id, pin_hash, pin_salt)'
          + ' VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, rank',
          [p.name, Number(p.rank), p.roleKey || ROLE_KEY_BY_RANK[Number(p.rank)],
            req.ctx.outletId, h.hash, h.salt]);
        // The employment record is a separate thing from the login: hours and
        // wages belong to a person whether or not they ever touch a till.
        if (p.job) {
          await applyOp(c, { kind: 'employee_upsert', payload: Object.assign({},
            p, { staffId: q.rows[0].id }) }, req.ctx);
        }
        out.push(q.rows[0]);
      }
      return out;
    });
    res.json({ ok: true, staff: made });
  } catch (e) { next(e); }
});

/* ── 13 · Device, 14 · Register — both already exist as running-app paths;
      onboarding just calls them so nothing is written twice. ───────────── */
r.post('/register', async function (req, res, next) {
  try {
    const out = await withOutlet(req.ctx, (c) => applyOp(c,
      { kind: 'open_register', payload: { float: Number((req.body || {}).float) || 0 } },
      req.ctx));
    res.json(Object.assign({ ok: true, step: 'register' }, out));
  } catch (e) { next(e); }
});

/* ── finish: stamp the outlet as onboarded. The checklist stays visible in
      the app until every step is genuinely done, so this is a record, not a
      way to hide the remaining work. ──────────────────────────────────── */
r.post('/finish', async function (req, res, next) {
  try {
    await withOutlet(req.ctx, async function (c) {
      await c.query('UPDATE chain.outlet SET onboarded_at = now() WHERE id = $1',
        [req.ctx.outletId]);
      await c.query("SELECT chain.log('onboarded','outlet',$1,NULL,NULL)",
        [String(req.ctx.outletId)]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function today() { return new Date().toISOString().slice(0, 10); }

module.exports = r;
module.exports.STEPS = STEPS;
