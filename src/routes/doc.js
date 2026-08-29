'use strict';
/* ═══ A DOCUMENT SOMEBODY WAS HANDED ═══════════════════════════════════════
   Two public reads, and they are the only two: a RECEIPT at /api/doc/r/:token
   and an account STATEMENT at /api/doc/st/:token. Both are what a guest opens
   from a message, so neither asks for a credential beyond the token in the
   link — a receipt that needs a sign-in is a receipt nobody opens, and the
   guest handed it has no account here and never will.

   THE TOKEN IS THE WHOLE FENCE, so both doors get a doorman: the space is far
   too large to walk, and the limiter is what stops somebody trying anyway.

   WHAT THEY ANSWER IS A PROJECTION, never a row. A receipt says what the
   guest bought and paid; it does not carry cost, margin, staff, the ticket,
   another bill, or the outlet's own totals. A statement says what this one
   customer ran up and settled. That is the same rule the QR portal already
   keeps, and it is what makes a link safe to put in an inbox.
   ═══════════════════════════════════════════════════════════════════════ */
const express = require('express');
const { control, withOutletRead } = require('../db');
const { verifyDoc, docExpired } = require('../secrets');
const { gate } = require('../limit');

const r = express.Router();

// Generously wide: a family sharing one receipt link opens it a dozen times,
// and a bill re-read is not an attempt on anything. What this stops is a
// script walking the space.
const docRead = { ip: [300, 10 * 60e3] };

const num = (v) => (v == null ? 0 : Number(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);

/* WHICH STORE THIS DOCUMENT BELONGS TO IS IN THE ADDRESS, not in the token.
   A receipt link is `https://<handle>.kashikeyopos.com/r/<token>`, so the host
   already names the store — the same fact the QR portal has always resolved,
   through the same registry lookup, which is the one named exception in the
   owner-connection table.

   The first version of this walked every business and every outlet looking
   for the token. It worked, and it was wrong twice over: it opened a
   privileged connection this file has no business holding, and it turned
   opening a receipt into an O(businesses × outlets) scan. Reading the host is
   both cheaper and narrower — a token is only ever looked for in the one
   store whose address the guest is already on. */
async function outletFor(req) {
  const want = String(req.storeHandle || req.query.s || '').trim().toLowerCase();
  if (!want) return null;
  const p = await control().query(
    'SELECT p.outlet_id, b.db_name FROM chain.handle_points_at($1) p'
    + ' JOIN chain.business b ON b.id = p.business_id', [want]);
  return p.rows.length ? p.rows[0].outlet_id : null;
}

async function receiptBody(outletId, saleId) {
  return withOutletRead({ outletId, rank: 5, actor: null, scope: 'outlet' },
    async function (c) {
      const s = (await c.query('SELECT * FROM sale WHERE id = $1', [saleId])).rows[0];
      if (!s) return null;
      const lines = (await c.query(
        'SELECT name, qty, unit_price, line_total FROM sale_line'
        + ' WHERE sale_id = $1 ORDER BY id', [saleId])).rows;
      const pays = (await c.query(
        'SELECT method, amount, currency, auth_ref FROM payment'
        + ' WHERE sale_id = $1 ORDER BY id', [saleId])).rows;
      const co = (await c.query(
        'SELECT legal_name, tin, gst_registered FROM chain.company LIMIT 1')).rows[0] || {};
      const o = (await c.query(
        "SELECT name, currency, address, brand->>'logo' AS logo"
        + ' FROM chain.outlet WHERE id = $1',
        [outletId])).rows[0] || {};
      return {
        kind: 'receipt',
        outlet: o.name || '', address: o.address || '',
        /* The store's mark, exactly as published under Store branding — a
           data URL the page renders inline. Only an image data URL travels:
           this document is read by a stranger's phone, and anything else in
           that column is not a picture. */
        logo: /^data:image\//.test(o.logo || '') ? o.logo : '',
        company: co.legal_name || '',
        // A TIN prints only where the business actually holds one. A tax line
        // on a document from a business that is not registered claims a
        // registration it does not have.
        tin: co.gst_registered ? (co.tin || '') : '',
        currency: o.currency || 'MVR',
        docNo: s.receipt_no, at: iso(s.at), date: s.business_date,
        lines: lines.map((l) => ({ name: l.name, qty: num(l.qty),
          price: num(l.unit_price), total: num(l.line_total) })),
        net: num(s.net), discount: num(s.discount), service: num(s.service),
        taxLabel: s.tax_label, taxRate: num(s.tax_rate), tax: num(s.tax),
        rounding: num(s.rounding), tip: num(s.tip), total: num(s.total),
        points: s.pts || 0, pointsValue: num(s.pts_value),
        // The evidence the processor issued, named the way it names it. A
        // guest checking a card charge against their statement needs it.
        payments: pays.map((p) => ({ method: p.method, amount: num(p.amount),
          currency: p.currency, reference: p.auth_ref || '' })),
        voided: !!s.voided_at
      };
    });
}

r.get('/r/:token', gate('doc-read', docRead, null), async function (req, res, next) {
  try {
    const token = String(req.params.token || '');
    if (!/^RC[A-Za-z0-9]{32}$/.test(token)) {
      return res.status(404).json({ error: 'that receipt could not be found' });
    }
    const outletId = await outletFor(req);
    if (!outletId) return res.status(404).json({ error: 'that receipt could not be found' });
    const hit = await withOutletRead(
      { outletId: outletId, rank: 5, actor: null, scope: 'outlet' },
      (c) => c.query('SELECT id FROM sale WHERE share_token = $1', [token]));
    if (!hit.rows.length) {
      return res.status(404).json({ error: 'that receipt could not be found' });
    }
    const body = await receiptBody(outletId, hit.rows[0].id);
    if (!body) return res.status(404).json({ error: 'that receipt could not be found' });
    res.set('cache-control', 'private, max-age=60').json(body);
  } catch (e) { next(e); }
});

/* A STATEMENT is signed rather than stored, so the token says which outlet,
   which member and until when. It EXPIRES, unlike a receipt: a permanent link
   to "this customer's account" is a standing window into somebody's spending,
   and a statement is a period rather than a document they keep. */
r.get('/st/:token', gate('doc-read', docRead, null), async function (req, res, next) {
  try {
    const tok = String(req.params.token || '');
    const claims = verifyDoc(tok);
    if (!claims || !claims.o || !claims.m) {
      /* OLD IS NOT WRONG. A link the store really did issue, which has simply
         aged past its window, says so — because the only useful thing the
         person holding it can do is ask for a new one, and "could not be
         found" sends them to check their own copying instead. */
      if (docExpired(tok)) {
        return res.status(410).json({
          error: 'this statement link has expired — ask the store for a new one' });
      }
      return res.status(404).json({ error: 'that statement could not be found' });
    }
    const body = await withOutletRead(
      { outletId: claims.o, rank: 5, actor: null, scope: 'outlet' },
      async function (c) {
        const m = (await c.query(
          'SELECT id, name, phone, points, credit_limit, credit_used'
          + ' FROM chain.member WHERE id = $1', [claims.m])).rows[0];
        if (!m) return null;
        const o = (await c.query(
          'SELECT name, currency FROM chain.outlet WHERE id = $1', [claims.o])).rows[0] || {};
        const co = (await c.query(
          'SELECT legal_name FROM chain.company LIMIT 1')).rows[0] || {};
        const rows = (await c.query(
          'SELECT receipt_no, at, business_date, total, pts, pts_value'
          + ' FROM sale WHERE member_id = $1 AND business_date BETWEEN $2 AND $3'
          + ' AND voided_at IS NULL ORDER BY at', [claims.m, claims.f, claims.t])).rows;
        return {
          kind: 'statement',
          outlet: o.name || '', company: co.legal_name || '',
          currency: o.currency || 'MVR',
          name: m.name || m.phone, phone: m.phone,
          from: claims.f, to: claims.t,
          points: m.points || 0,
          creditLimit: num(m.credit_limit), creditUsed: num(m.credit_used),
          lines: rows.map((s) => ({ docNo: s.receipt_no, at: iso(s.at),
            date: s.business_date, total: num(s.total),
            points: s.pts || 0, pointsValue: num(s.pts_value) })),
          spent: rows.reduce((a, s) => a + num(s.total), 0)
        };
      });
    if (!body) return res.status(404).json({ error: 'that statement could not be found' });
    res.set('cache-control', 'no-store').json(body);
  } catch (e) { next(e); }
});

module.exports = r;
