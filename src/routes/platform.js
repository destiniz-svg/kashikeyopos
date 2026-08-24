'use strict';
/* ═══ WHAT AN INSTALL TELLS ITS PLATFORM ═════════════════════════════════════
   The product is sold one INSTALL per customer — that is what keeps every
   isolation guarantee in this repository true per-customer by construction —
   and the seller's panel (Mission Control) needs one thing from each install:
   a health-and-headlines read. This is that read, and deliberately nothing
   more.

   AGGREGATES ONLY, like the estate view it borrows its discipline from: the
   company's name, the outlets, fourteen days of takings, device staleness.
   No member rows, no staff, no line items, no documents — a platform that
   holds a customer's customer list is a liability to both of them.

   The door is a PLATFORM_KEY: set per install by the platform when it
   provisions the customer, at least 32 characters, compared in constant
   time. Unset, the door does not exist (404, indistinguishable from any
   other unknown path) — an install that was never sold has no platform.

   It runs on the owner connection for the scalar reads, like the account
   plane does and for the same reason: this sits ABOVE every outlet, there is
   no outlet identity to set, and the whole surface is this one file. The
   day figures go through the read-only report role, exactly as the estate
   screen's do.
   ═══════════════════════════════════════════════════════════════════════ */

const express = require('express');
const crypto = require('crypto');
const { owner, withEstate } = require('../db');

const r = express.Router();

function keyOk(req) {
  const want = process.env.PLATFORM_KEY || '';
  if (want.length < 32) return null;                      // door not enabled
  const got = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

r.get('/summary', async function (req, res, next) {
  const ok = keyOk(req);
  if (ok === null) return res.status(404).json({ error: 'not found' });
  if (!ok) return res.status(401).json({ error: 'platform key required' });
  try {
    const o = owner();
    const co = await o.query(
      'SELECT legal_name, gst_registered, base_currency FROM chain.company LIMIT 1');
    const inst = await o.query(
      "SELECT value->>'id' AS id FROM chain.setting WHERE key = 'install'");
    const outlets = await o.query(
      'SELECT id, name, slug, tz, currency FROM chain.outlet WHERE active ORDER BY id');
    // Writers only: printers and displays never push, so their silence is not
    // a health signal. "Quiet" mirrors the Sync ribbon's own hour rule.
    const dev = await o.query(
      "SELECT count(*)::int AS writers,"
      + " count(*) FILTER (WHERE last_push_at IS NULL"
      + "   OR last_push_at < now() - interval '1 hour')::int AS quiet"
      + " FROM chain.device"
      + " WHERE NOT revoked AND paired_at IS NOT NULL"
      + "   AND kind NOT IN ('printer','display')");

    /* Fourteen days of takings through the read-only report role — the same
       function, the same audit stance, as the owner's own estate screen. */
    const days = [];
    if (outlets.rows.length) {
      const tz = outlets.rows[0].tz || 'Indian/Maldives';
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
      await withEstate({ outletId: 0, rank: 5, actor: null, scope: 'group' },
        async function (c) {
          for (let i = 13; i >= 0; i--) {
            const d = fmt.format(new Date(Date.now() - i * 86400e3));
            const q = await c.query('SELECT * FROM chain.estate_day($1)', [d]);
            days.push({
              date: d,
              net: r2(q.rows.reduce((a, x) => a + Number(x.sales || 0), 0)),
              covers: q.rows.reduce((a, x) => a + Number(x.covers || 0), 0),
              tickets: q.rows.reduce((a, x) => a + Number(x.tickets || 0), 0)
            });
          }
        });
      // The read is on the trail, in the first outlet's log, like every other
      // cross-outlet read: a platform looking in is never invisible.
      await o.query(
        "INSERT INTO chain.audit (outlet_id, action, entity, after, scope)"
        + " VALUES ($1,'platform_read','install',$2,'group')",
        [outlets.rows[0].id, JSON.stringify({ days: days.length })]).catch(() => {});
    }

    res.set('cache-control', 'no-store').json({
      install: (inst.rows[0] || {}).id || null,
      company: co.rows.length ? {
        name: co.rows[0].legal_name,
        gstRegistered: co.rows[0].gst_registered !== false,
        currency: co.rows[0].base_currency
      } : null,
      outlets: outlets.rows,
      devices: dev.rows[0],
      days: days,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      at: new Date().toISOString()
    });
  } catch (e) { next(e); }
});

module.exports = r;
