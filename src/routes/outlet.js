'use strict';
const express = require('express');
const { withOutletRead } = require('../db');
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
