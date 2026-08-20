'use strict';
/* ═══ THE GUEST SIDE ════════════════════════════════════════════════════════
   A guest posts INTENT; the till decides. The phone never takes money, never
   sees a cost, never sees a staff record. That is why this router has its own
   token type (a table token, rank 0) and its own projection — a guest device
   holding a margin figure is a data leak, not a feature.
   ═══════════════════════════════════════════════════════════════════════ */

const express = require('express');
const { owner, withOutlet, withOutletRead } = require('../db');
const { signTable, verifyTable } = require('../secrets');
const { snapshot } = require('./outlet');

const r = express.Router();

// A QR encodes the outlet slug and the table. The token is minted here, not
// carried in the URL, so a guest cannot retype it onto another table.
r.get('/:slug/token', async function (req, res, next) {
  try {
    const o = await owner().query('SELECT id, name, slug FROM chain.outlet'
      + ' WHERE slug = $1 AND active', [req.params.slug]);
    if (!o.rows.length) {
      // An unknown handle means a QR printed for a store that moved. Say so
      // rather than silently landing the guest somewhere else.
      return res.status(404).json({ error: 'That code is not in use here any more — ask for a new one' });
    }
    const table = String(req.query.t || '').slice(0, 12) || null;
    const hours = 4;
    res.set('cache-control', 'no-store').json({
      token: signTable({ o: o.rows[0].id, tb: table, sl: o.rows[0].slug,
        exp: Date.now() + hours * 3600e3 }),
      outlet: { id: o.rows[0].id, name: o.rows[0].name, slug: o.rows[0].slug },
      table: table
    });
  } catch (e) { next(e); }
});

function guest(req, res, next) {
  const t = req.get('x-table-token') || req.query.t || '';
  const claims = verifyTable(String(t));
  if (!claims || !claims.o) return res.status(401).json({ error: 'scan the code again' });
  req.guest = { outletId: claims.o, table: claims.tb || null, slug: claims.sl };
  // Rank 0: this context can read the menu projection and write intent, and
  // the RLS policies see a rank that cannot approve, price or settle anything.
  req.ctx = { outletId: claims.o, rank: 0, actor: null, scope: 'outlet' };
  next();
}

r.get('/:slug/menu', guest, async function (req, res, next) {
  try {
    const data = await withOutletRead(req.ctx, (c) => snapshot(c, req.ctx.outletId));
    // Strip the floor: a guest sees the menu and their own table, never the
    // room's open tickets.
    const mine = (data.tickets || []).filter((t) => t.table_no === req.guest.table);
    res.set('cache-control', 'no-store').json(Object.assign({}, data, {
      tickets: mine, table: req.guest.table
    }));
  } catch (e) { next(e); }
});

r.post('/:slug/order', guest, async function (req, res, next) {
  const b = req.body || {};
  const table = req.guest.table || b.table;
  if (!table || !Array.isArray(b.lines) || !b.lines.length) {
    return res.status(400).json({ error: 'table and at least one line required' });
  }
  if (b.lines.length > 60) return res.status(413).json({ error: 'too many lines' });
  try {
    const out = await withOutlet(req.ctx, async function (c) {
      if (b.opId) {
        const seen = await c.query('SELECT result FROM op_log WHERE op_id = $1', [b.opId]);
        if (seen.rows.length) return seen.rows[0].result;   // replay, not a second order
      }
      const ins = await c.query(
        'INSERT INTO guest_order (table_no, lines, promo, guest_name, guest_phone, note)'
        + ' VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, at',
        [String(table), JSON.stringify(b.lines), b.promo || null,
          b.name || null, b.phone || null, b.note || null]);
      const result = { id: ins.rows[0].id, at: ins.rows[0].at, status: 'awaiting till' };
      if (b.opId) {
        await c.query('INSERT INTO op_log (op_id, kind, payload, client_at, result)'
          + " VALUES ($1,'qr_order',$2, now(), $3) ON CONFLICT DO NOTHING",
        [b.opId, JSON.stringify({ table, lines: b.lines.length }), JSON.stringify(result)]);
      }
      await c.query("SELECT chain.log_anon($1,'qr_order','guest_order',$2,$3)",
        [req.ctx.outletId, ins.rows[0].id,
          JSON.stringify({ table, lines: b.lines.length })]);
      return result;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.post('/:slug/request', guest, async function (req, res, next) {
  const b = req.body || {};
  const table = req.guest.table || b.table;
  if (!table || !b.kind) return res.status(400).json({ error: 'table and kind required' });
  try {
    const row = await withOutlet(req.ctx, (c) => c.query(
      'INSERT INTO guest_request (table_no, kind, detail) VALUES ($1,$2,$3)'
      + ' RETURNING id, at', [String(table), String(b.kind).slice(0, 24),
        (b.detail || '').slice(0, 400)]).then((q) => q.rows[0]));
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// A member checks their own points by phone. It returns their record and
// nothing else — no other member, no spend history from another outlet.
r.get('/:slug/member', guest, async function (req, res, next) {
  const phone = String(req.query.phone || '').trim();
  if (phone.length < 6) return res.status(400).json({ error: 'phone required' });
  try {
    const row = await withOutletRead(req.ctx, (c) => c.query(
      'SELECT name, points, tier, joined_at FROM chain.member WHERE phone = $1',
      [phone]).then((q) => q.rows[0] || null));
    res.set('cache-control', 'no-store').json({ member: row });
  } catch (e) { next(e); }
});

module.exports = r;
