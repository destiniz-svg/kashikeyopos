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

/* ── the licence, both directions ───────────────────────────────────────────
   The seller's registry is AUTHORITATIVE about what a customer is on; this
   install holds a copy so the till can say so without an outbound call to
   anything. The copy is written here and nowhere else — migration 033 grants
   no outlet role INSERT or UPDATE on chain.licence — and it is read back on
   the summary so the panel can see drift and re-push it. */
async function readLicence(o) {
  const q = await o.query(
    'SELECT kind, trial_ends, note, set_at, set_by FROM chain.licence WHERE id = 1');
  if (!q.rows.length) return null;
  const x = q.rows[0];
  return { kind: x.kind, trialEnds: x.trial_ends ? String(x.trial_ends).slice(0, 10) : null,
    note: x.note || '', setAt: x.set_at, setBy: x.set_by };
}

/* The customer asking to be put on a plan. It rides the audit trail rather
   than a table of its own: it is an event with a person and a time attached,
   the trail is append-only from the floor, and a request that has been
   answered still has to be answerable months later. */
async function readPlanRequest(o) {
  const q = await o.query(
    "SELECT value FROM chain.setting WHERE key = 'plan_request'");
  if (!q.rows.length) return null;
  const x = q.rows[0].value || {};
  if (!x.at) return null;
  return { at: x.at, by: x.by || null, want: x.want || null, note: x.note || '' };
}

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
      licence: await readLicence(o),
      planRequest: await readPlanRequest(o),
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

/* ── the one thing the platform WRITES ──────────────────────────────────────
   Mission Control pushes the licence whenever what this install believes
   differs from the registry. Same key, same constant-time compare, same audit
   trail as the read — and idempotent, so re-pushing an unchanged licence is a
   no-op rather than a new row every thirty seconds.

   It never blocks anything. The install renders a notice and the till keeps
   taking money: a restaurant mid-service is not where a licence check gets to
   stop a sale, and a customer who has fallen behind on an invoice has not
   stopped being a customer. */
r.post('/licence', express.json({ limit: '8kb' }), async function (req, res, next) {
  const ok = keyOk(req);
  if (ok === null) return res.status(404).json({ error: 'not found' });
  if (!ok) return res.status(401).json({ error: 'platform key required' });

  const b = req.body || {};
  const kind = String(b.kind || '').trim();
  if (!['trial', 'paid', 'internal'].includes(kind)) {
    return res.status(400).json({ error: 'kind is trial, paid or internal' });
  }
  const ends = b.trialEnds == null || b.trialEnds === ''
    ? null : String(b.trialEnds).slice(0, 10);
  if (ends !== null && !/^\d{4}-\d{2}-\d{2}$/.test(ends)) {
    return res.status(400).json({ error: 'trialEnds is a date, YYYY-MM-DD, or null' });
  }
  /* A paid or internal install counting down to a date is a contradiction the
     till would have to render, so it is refused by name rather than stored and
     quietly ignored. */
  if (kind !== 'trial' && ends) {
    return res.status(400).json({ error: 'only a trial has an end date' });
  }
  const note = String(b.note || '').slice(0, 400);

  try {
    const o = owner();
    const before = await readLicence(o);
    await o.query(
      'INSERT INTO chain.licence (id, kind, trial_ends, note, set_at, set_by)'
      + " VALUES (1, $1, $2, $3, now(), 'platform')"
      + ' ON CONFLICT (id) DO UPDATE SET kind = $1, trial_ends = $2, note = $3,'
      + " set_at = now(), set_by = 'platform'", [kind, ends, note]);
    const after = await readLicence(o);

    /* On the trail only when something actually MOVED. The panel re-pushes on
       every dashboard load to stay self-healing, and a trail that records
       thirty identical writes an hour is one nobody can find the real change
       in. */
    const moved = !before || before.kind !== after.kind
      || before.trialEnds !== after.trialEnds || before.note !== after.note;
    if (moved) {
      const first = await o.query(
        'SELECT id FROM chain.outlet WHERE active ORDER BY id LIMIT 1');
      if (first.rows.length) {
        await o.query(
          'INSERT INTO chain.audit (outlet_id, action, entity, before, after, scope)'
          + " VALUES ($1,'licence_set','install',$2,$3,'group')",
          [first.rows[0].id, JSON.stringify(before), JSON.stringify(after)]).catch(() => {});
      }
    }
    res.set('cache-control', 'no-store').json({ licence: after, changed: moved });
  } catch (e) { next(e); }
});

module.exports = r;
