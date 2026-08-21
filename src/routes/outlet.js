'use strict';
const express = require('express');
const { withOutletRead, owner } = require('../db');
const { shapeError, storeUrl, memberUrl, baseDomain } = require('../handle');
const directory = require('../directory');
const { sameOutlet, atLeast, groupScope } = require('../auth');
const { buildBootstrap, buildState, all } = require('../bootstrap');

const r = express.Router({ mergeParams: true });

/* ── everything the terminal needs to come up, in one round trip ─────────── */
r.get('/bootstrap', sameOutlet, groupScope, async function (req, res, next) {
  try {
    const [boot, state] = await Promise.all([
      buildBootstrap(req.ctx),
      buildState(req.ctx, { days: Number(req.query.days || 60) })
    ]);
    res.set('cache-control', 'no-store').json({
      v: 1, at: Date.now(),
      session: {
        outletId: req.ctx.outletId, rank: req.ctx.rank, actor: req.ctx.actor,
        name: req.ctx.name, roleKey: req.ctx.roleKey, deviceId: req.ctx.deviceId
      },
      kpos: boot.kpos, raw: boot.raw, state: state
    });
  } catch (e) { next(e); }
});

/* ── the store's public address ──────────────────────────────────────────
   Renaming is rank 5 and nothing less. It changes what is printed on the table
   cards, on the receipts and in the message the host sent last week — a manager
   who can discount a bill has no business changing where the business lives.

   The old address is kept and redirects here (migration 013), so the cards
   already stuck to the tables keep opening the right menu. It also stops being
   claimable by anybody else: a dead QR is bad, and a QR pointing at a
   competitor is worse. ────────────────────────────────────────────────────── */
r.get('/handle', sameOutlet, atLeast('admin'), async function (req, res, next) {
  try {
    const want = String(req.query.h || '').trim().toLowerCase();
    const id = req.ctx.outletId;
    const mine = await owner().query(
      'SELECT slug FROM chain.outlet WHERE id = $1', [id]);
    const past = await owner().query(
      'SELECT handle, retired_at FROM chain.outlet_handle_history'
      + ' WHERE outlet_id = $1 ORDER BY retired_at DESC', [id]);
    const now = {
      handle: (mine.rows[0] || {}).slug || null,
      url: storeUrl((mine.rows[0] || {}).slug || '', ''),
      base: baseDomain(),
      // Every address this store has given up. They still point here, and
      // nobody else can take them.
      former: past.rows.map((x) => ({ handle: x.handle, retiredAt: x.retired_at }))
    };
    if (!want) return res.json(now);

    const shape = shapeError(want);
    if (shape) return res.json(Object.assign(now, { want: want, free: false, why: shape }));
    const why = await owner().query('SELECT chain.handle_why($1,$2) AS w', [want, id]);
    res.json(Object.assign(now, {
      want: want, free: !why.rows[0].w, why: why.rows[0].w || null,
      wantUrl: why.rows[0].w ? null : storeUrl(want, '')
    }));
  } catch (e) { next(e); }
});

r.patch('/handle', sameOutlet, atLeast('owner'), async function (req, res, next) {
  try {
    const want = String((req.body || {}).handle || '').trim().toLowerCase();
    const shape = shapeError(want);
    if (shape) return res.status(400).json({ error: shape });

    const id = req.ctx.outletId;
    const q = await owner().query('SELECT chain.rename_outlet($1,$2) AS was', [id, want]);
    const was = q.rows[0].was;
    // The next request should see the new address rather than wait out the
    // directory's refresh window.
    directory.forget();
    res.json({
      handle: want, was: was, moved: was !== want,
      url: storeUrl(want, ''), memberUrl: memberUrl(want),
      base: baseDomain()
    });
  } catch (e) {
    // 23514 is the rename function refusing a handle it will not give out.
    if (e && e.code === '23514') return res.status(409).json({ error: e.message });
    next(e);
  }
});

/* ── the live snapshot both guest portals read. Prices, stages and what is
      owed — no margins, no costs, no staff records. A guest device has no
      business holding those, so they are not in the projection at all. ───── */
r.get('/snapshot', sameOutlet, async function (req, res, next) {
  try {
    const data = await withOutletRead(req.ctx, (c) => snapshot(c, req.ctx.outletId));
    res.set('cache-control', 'no-store').json(data);
  } catch (e) { next(e); }
});

async function snapshot(c, outletId) {
  const q = await all(c, {
    outlet: ['SELECT id, name, currency, service_pct, tax_code, slug FROM chain.outlet'
      + ' WHERE id = $1', [outletId]],
    tax: ['SELECT code, rate FROM chain.tax_version WHERE outlet_id = $1'
      + ' AND effective_from <= current_date'
      + ' AND (effective_to IS NULL OR effective_to >= current_date)'
      + ' ORDER BY effective_from DESC LIMIT 1', [outletId]],
    items: ['SELECT id, name, category_id, price, description, image, allergens,'
      + ' diets, off_menu, sold_out_reason FROM item WHERE active ORDER BY pos, name'],
    cats: ['SELECT id, name, pos FROM menu_category WHERE active ORDER BY pos, name'],
    // The floor is the outlet's own, never a count guessed by the phone: a
    // room with six tables must not offer a guest twelve to sit at.
    floor: ['SELECT id, label, seats, zone_id FROM table_def WHERE active'
      + ' ORDER BY pos, label'],
    zones: ['SELECT id, name FROM zone WHERE active ORDER BY pos, name'],
    tickets: ["SELECT t.id, t.table_no, t.split, t.covers, t.status,"
      + " coalesce(json_agg(json_build_object('id', l.item_id, 'name', l.name,"
      + "   'qty', l.qty, 'price', l.unit_price, 'note', l.note,"
      + "   'sent', l.sent_at IS NOT NULL)"
      + "   ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines"
      + ' FROM ticket t LEFT JOIN ticket_line l'
      + '   ON l.ticket_id = t.id AND l.void_at IS NULL'
      + " WHERE t.status = 'open' GROUP BY t.id"],
    stages: ['SELECT ticket_id, station, stage, target_mins, fired_at FROM kds_ticket'
      + ' WHERE served_at IS NULL'],
    banners: ['SELECT id, slot, title, body, image, link FROM banner WHERE active'],
    promos: ['SELECT id, name, kind, value, code, max_pct FROM promo WHERE active'
      + ' AND (starts_on IS NULL OR starts_on <= current_date)'
      + ' AND (ends_on IS NULL OR ends_on >= current_date)'],
    // What a member's card is worth here. These three are customer-facing by
    // definition — a reward nobody can see is a reward nobody redeems.
    loyalty: ["SELECT key, value FROM chain.setting"
      + " WHERE key IN ('tiers','rewards','loyalty','currencies')"],
    // Who the guest is dealing with, as it is going to appear on their receipt.
    company: ['SELECT legal_name, brand, country, base_currency FROM chain.company'
      + ' LIMIT 1'],
  });
  const zoneName = {};
  q.zones.rows.forEach((z) => { zoneName[z.id] = z.name; });
  const loyalty = {};
  q.loyalty.rows.forEach((r) => { loyalty[r.key] = r.value; });

  return {
    v: 5, at: Date.now(),
    outlet: q.outlet.rows[0] || null,
    tax: q.tax.rows[0] || null,
    categories: q.cats.rows,
    items: q.items.rows,
    floor: q.floor.rows.map((t) => ({
      id: t.id, label: t.label, seats: t.seats, zone: zoneName[t.zone_id] || ''
    })),
    tickets: q.tickets.rows,
    stages: q.stages.rows,
    banners: q.banners.rows,
    promos: q.promos.rows,
    company: q.company.rows[0]
      ? { name: q.company.rows[0].legal_name,
        brand: q.company.rows[0].brand || {},
        country: q.company.rows[0].country,
        currency: q.company.rows[0].base_currency }
      : null,
    currencies: loyalty.currencies || [],
    tiers: loyalty.tiers || null,
    rewards: loyalty.rewards || [],
    loyalty: loyalty.loyalty || {}
  };
}

/* ── the audit trail. Manager+ for its own outlet; the RLS policy says the
      same thing underneath, so a bug here cannot get past it. ───────────── */
r.get('/audit', sameOutlet, atLeast('manager'), async function (req, res, next) {
  try {
    const rows = await withOutletRead(req.ctx, (c) => c.query(
      'SELECT id, at, actor, rank, device_id, action, entity, entity_id, scope'
      + ' FROM chain.audit WHERE outlet_id = $1 ORDER BY at DESC LIMIT $2',
      [req.ctx.outletId, Math.min(Number(req.query.limit || 200), 1000)])
      .then((q) => q.rows));
    res.json({ audit: rows });
  } catch (e) { next(e); }
});

/* ── receipt history, paged. The same rows the Z-report reads. ──────────── */
r.get('/sales', sameOutlet, atLeast('till'), async function (req, res, next) {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  try {
    const out = await withOutletRead(req.ctx, async function (c) {
      const q = await all(c, {
        rows: ['SELECT id, receipt_no, at, business_date, channel, covers, net,'
          + ' service, tax, rounding, total, server_name, voided_at FROM sale'
          + ' WHERE ($1::date IS NULL OR business_date = $1)'
          + ' ORDER BY at DESC LIMIT $2 OFFSET $3',
        [req.query.date || null, limit, offset]],
        count: ['SELECT count(*)::int AS n FROM sale'
          + ' WHERE ($1::date IS NULL OR business_date = $1)', [req.query.date || null]],
      });
      const rows = q.rows;
      const count = q.count;

      return { sales: rows.rows, total: count.rows[0].n, limit, offset };
    });
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = r;
module.exports.snapshot = snapshot;
