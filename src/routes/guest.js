'use strict';
/* ═══ THE GUEST SIDE ════════════════════════════════════════════════════════
   A guest posts INTENT; the till decides. The phone never takes money, never
   sees a cost, never sees a staff record. That is why this router has its own
   token type (a table token, rank 0) and its own projection — a guest device
   holding a margin figure is a data leak, not a feature.
   ═══════════════════════════════════════════════════════════════════════ */

const express = require('express');
const { owner, withOutlet, withOutletRead } = require('../db');
const { signTable, verifyTable, signMember, verifyMember,
  hashPin, pinMatches, randomPin, tokenHash } = require('../secrets');
const { snapshot } = require('./outlet');
const { hostHandle } = require('../handle');
const INVITE = require('../../app/kashikeyo-invite.js');
const { gate } = require('../limit');

const r = express.Router();

/* ── the doorman on the member doors ─────────────────────────────────────
   Anybody with a table token — which is minted for anybody who scans a QR —
   can ask for sign-in codes and probe invitation tokens. Each code request
   writes rows and lands on the floor board; each verify burns one of a
   code's five tries. The identity bucket is keyed on the phone or address the
   request is ABOUT; the IP ceilings are deliberately wide, because a
   restaurant's wifi puts the whole room behind one address and the doorman
   must not lock forty guests out for the sins of none of them. */
const askedFor = (req) => (req.body || {}).id || (req.body || {}).phone || '';
const askedToken = (req) => INVITE.cleanToken((req.body || {}).token);
const codeIssue = { id: [3, 10 * 60e3], ip: [20, 10 * 60e3] };
const codeGuess = { id: [10, 10 * 60e3], ip: [40, 10 * 60e3] };
const tokenLook = { ip: [30, 10 * 60e3] };

// A QR encodes the outlet handle and the table. The token is minted here, not
// carried in the URL, so a guest cannot retype it onto another table.
async function mintTable(req, res, want) {
  // Current address or one the store gave up — chain.handle_points_at answers
  // both, so a card printed under the old name keeps opening the right menu.
  const o = await owner().query(
    'SELECT o.id, o.name, o.slug, p.retired FROM chain.handle_points_at($1) p'
    + ' JOIN chain.outlet o ON o.id = p.outlet_id', [want]);
  if (!o.rows.length) {
    // A handle nobody answers to. Say so rather than silently landing the
    // guest somewhere else.
    return res.status(404).json({ error: 'That code is not in use here any more — ask for a new one' });
  }
  const r = o.rows[0];
  const table = String(req.query.t || '').slice(0, 12) || null;
  const hours = 4;
  return res.set('cache-control', 'no-store').json({
    // The token names the store's CURRENT address, and the page adopts it, so
    // one hop through a retired handle is the last one this device makes.
    token: signTable({ o: r.id, tb: table, sl: r.slug,
      exp: Date.now() + hours * 3600e3 }),
    outlet: { id: r.id, name: r.name, slug: r.slug },
    movedFrom: r.retired ? want : undefined,
    table: table
  });
}

/* The same door opened by the HOST rather than the path. On
   <handle>.kashikeyopos.com the store is named by the address bar, so the page
   has no slug to send — and it must not guess one out of location.hostname,
   because only the server knows where the base domain ends. It answers with
   the handle it resolved, and every call after this one is by path again. */
r.get('/token', async function (req, res, next) {
  try {
    const want = hostHandle(req.hostname || req.get('host') || '');
    if (!want) {
      return res.status(404).json({ error: 'This address does not name a store' });
    }
    return await mintTable(req, res, want);
  } catch (e) { next(e); }
});

r.get('/:slug/token', async function (req, res, next) {
  try { return await mintTable(req, res, req.params.slug); }
  catch (e) { next(e); }
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
    // Strip the room: a guest sees the menu and their OWN table, never anyone
    // else's open bill and never anyone else's ticket in the kitchen. The
    // floor plan itself stays — it is what the table chooser offers when the
    // QR does not name a table — but it carries labels and seats, nothing more.
    const mine = (data.tickets || []).filter((t) => t.table_no === req.guest.table);
    const ids = mine.map((t) => t.id);
    const stages = (data.stages || []).filter((k) => ids.indexOf(k.ticket_id) >= 0);
    res.set('cache-control', 'no-store').json(Object.assign({}, data, {
      tickets: mine, stages: stages, table: req.guest.table
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

/* ═══ THE MEMBER PORTAL ═════════════════════════════════════════════════════
   A member is neither staff nor anonymous: the person holding the phone owns
   exactly one record and must reach that one and no other. So the portal
   signs in — a code, checked like a PIN, in exchange for a token that names a
   member id and carries no rank.

   DELIVERY: this build has no SMS or email transport, so a code is delivered
   the way a restaurant already verifies a person — AT THE COUNTER. Issuing one
   raises a request on the floor board for a server to read out, and it is
   recorded in the audit trail. Wiring a transport later means sending
   `code` from issueCode() down that channel instead; nothing else changes.
   ═══════════════════════════════════════════════════════════════════════ */

const CODE_MINS = 10;
const CODE_TRIES = 5;

// A member checks their own points by phone. It returns their record and
// nothing else — no other member, no spend history from another outlet.
r.get('/:slug/member', guest, async function (req, res, next) {
  const phone = String(req.query.phone || '').trim();
  if (phone.length < 6) return res.status(400).json({ error: 'phone required' });
  try {
    const row = await withOutletRead(req.ctx, (c) => c.query(
      'SELECT name, points, joined_at FROM chain.member WHERE phone = $1',
      [phone]).then((q) => q.rows[0] || null));
    res.set('cache-control', 'no-store').json({ member: row });
  } catch (e) { next(e); }
});

r.post('/:slug/member/start', guest, gate('member-code', codeIssue, askedFor), async function (req, res, next) {
  // Either half of the membership: the phone on the card or the email on file.
  const phone = String((req.body || {}).id || (req.body || {}).phone || '').trim();
  if (phone.length < 6) return res.status(400).json({ error: 'phone or email required' });
  try {
    const out = await withOutlet(req.ctx, async function (c) {
      // Four digits from the CSPRNG, hashed with a per-row salt exactly like a
      // staff PIN — and, like a PIN, it is the expiry and the try limit that
      // make it safe, never the entropy. What the database holds is never the
      // code.
      const code = randomPin();
      const h = hashPin(code, null);
      const q = await c.query('SELECT chain.member_code_set($1,$2,$3,$4) AS id',
        [phone, h.hash, h.salt, CODE_MINS]);
      const id = q.rows[0].id;
      if (id) {
        await c.query('INSERT INTO guest_request (table_no, kind, detail)'
          + " VALUES ($1,'member_code',$2)",
        [req.guest.table || 'card', 'Sign-in code for ' + phone + ': ' + code]);
        await c.query("SELECT chain.log_anon($1,'member_code','member',$2,$3)",
          [req.ctx.outletId, id, JSON.stringify({ mins: CODE_MINS })]);
      }
      // The same answer either way: whether a phone number is a customer here
      // is not a question a stranger gets to ask.
      return { sent: true, via: 'counter', mins: CODE_MINS,
        code: (process.env.MEMBER_CODE_ECHO === '1' && id) ? code : undefined };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ═══ ARRIVING BY INVITATION ════════════════════════════════════════════════
   The phone posts the token it was handed and the server answers with ONE
   membership. The roster must never carry these: a roster that did would hand
   every device the keys to every account, which is the opposite of what a
   token is for.

   The answer is deliberately small — a first name, a tier's worth of context
   and a balance — because it is shown before anybody has proved they are that
   person. What it does NOT do is sign them in: it names the card, and the code
   that opens it goes to the address on the membership.

   A lapsed token still resolves, and says so. The membership is real, so
   dropping a guest with points on an account onto a dead end tells them there
   is nothing here for them, which is false. ═══════════════════════════════ */
r.post('/:slug/member/join', guest, gate('member-join', tokenLook, null), async function (req, res, next) {
  const tok = INVITE.cleanToken((req.body || {}).token);
  // Anything failing the minted shape is not a near-miss to be looked up, it is
  // somebody else's parameter. Nothing reaches the database.
  if (!tok) return res.status(400).json({ error: 'not an invitation' });
  try {
    const out = await withOutletRead(req.ctx, async function (c) {
      const q = await c.query('SELECT * FROM chain.member_by_invite($1)',
        [tokenHash(tok)]);
      const m = q.rows[0];
      if (!m) return null;
      const exp = m.token_exp ? new Date(m.token_exp).getTime() : 0;
      const left = Math.ceil((exp - Date.now()) / 86400000);
      const dead = m.revoked || m.used || !exp || exp <= Date.now();
      const hist = await c.query('SELECT count(*)::int AS visits FROM sale'
        + ' WHERE member_id = $1 AND voided_at IS NULL', [m.id]);
      /* What those points are worth, from the OUTLET's own published rate —
         the same figure the invitation's message quoted. The page used to work
         it out from the published programme, which a browser arriving cold on
         a link has never been sent: a guest holding 1,842 points was told they
         were worth MVR 0.00. A phone is TOLD its balance, not asked to derive
         one. */
      const rate = await c.query("SELECT value FROM chain.setting WHERE key = 'loyalty'");
      const cfg = (rate.rows[0] || {}).value || {};
      const cur = await c.query('SELECT currency FROM chain.outlet WHERE id = $1',
        [req.ctx.outletId]);
      const worth = ((cur.rows[0] || {}).currency || 'MVR') + ' '
        + Math.round((Number(m.points) || 0) / (Number(cfg.redeemPts) || 100)
          * (Number(cfg.redeemValue) || 25)).toLocaleString('en-US');
      return {
        // The state the landing card reads. `lapsed` is not a dead end — the
        // page falls through to the ordinary sign-in with the address already
        // filled in, because making somebody retype an address the app is
        // holding is a small insult at the moment they have been let down once.
        state: dead ? 'lapsed' : (left <= 2 ? 'expiring' : 'fresh'),
        left: Math.max(0, left),
        name: m.name || '',
        first: INVITE.firstNameOf(m.name),
        points: Number(m.points) || 0,
        worth: worth,
        visits: Number(hist.rows[0].visits) || 0,
        joined: m.joined_at ? m.joined_at.toISOString().slice(0, 10) : '',
        invitedBy: m.invited_by_name || '',
        invitedAt: m.invited_at ? m.invited_at.toISOString().slice(0, 10) : '',
        // The address the code will go to, and the one a lapsed link pre-fills.
        // Never an address typed on this screen: a forwarded link must not be
        // able to sign anybody else in.
        to: m.email || m.phone || ''
      };
    });
    // A token nobody minted and a token long since replaced are the same
    // answer, for the same reason `member/start` gives one: this endpoint must
    // not become a way to ask whether an invitation existed.
    if (!out) return res.status(404).json({ error: 'not an invitation' });
    res.set('cache-control', 'no-store').json(out);
  } catch (e) { next(e); }
});

/* "Send my code" from the landing card. The token is spent HERE — it opened
   the card once — and the code goes to the address on the membership, which is
   what makes a forwarded link useless to whoever it was forwarded to. */
r.post('/:slug/member/join/code', guest, gate('member-code', codeIssue, askedToken), async function (req, res, next) {
  const tok = INVITE.cleanToken((req.body || {}).token);
  if (!tok) return res.status(400).json({ error: 'not an invitation' });
  try {
    const out = await withOutlet(req.ctx, async function (c) {
      const hash = tokenHash(tok);
      const spent = await c.query('SELECT chain.member_invite_spend($1) AS id', [hash]);
      const id = spent.rows[0].id;
      if (!id) return null;
      const who = await c.query('SELECT name, phone, email FROM chain.member'
        + ' WHERE id = $1', [id]);
      const m = who.rows[0] || {};
      const code = randomPin();
      const h = hashPin(code, null);
      // Addressed by the membership's own identifier, never by anything in the
      // request body.
      await c.query('SELECT chain.member_code_set($1,$2,$3,$4)',
        [m.phone, h.hash, h.salt, CODE_MINS]);
      await c.query('INSERT INTO guest_request (table_no, kind, detail)'
        + " VALUES ($1,'member_code',$2)",
      ['card', 'Sign-in code for ' + (m.name || m.phone) + ': ' + code]);
      await c.query("SELECT chain.log_anon($1,'member_join','member',$2,$3)",
        [req.ctx.outletId, id, JSON.stringify({ mins: CODE_MINS })]);
      return { m: m, code: code };
    });
    if (!out) {
      return res.status(410).json({
        error: 'That link has already been used or has expired'
      });
    }
    res.set('cache-control', 'no-store').json({
      sent: true, mins: CODE_MINS,
      // The identifier the guest now keys their code against — the one on the
      // membership, so the next step cannot be redirected either.
      id: out.m.email || out.m.phone || '',
      code: process.env.MEMBER_CODE_ECHO === '1' ? out.code : undefined
    });
  } catch (e) { next(e); }
});

r.post('/:slug/member/verify', guest, gate('member-guess', codeGuess, askedFor), async function (req, res, next) {
  const b = req.body || {};
  const phone = String(b.id || b.phone || '').trim();
  const code = String(b.code || '').trim();
  if (phone.length < 6 || code.length < 4) {
    return res.status(400).json({ error: 'phone or email, and a code, required' });
  }
  try {
    const out = await withOutlet(req.ctx, async function (c) {
      const q = await c.query('SELECT * FROM chain.member_code_take($1)', [phone]);
      const m = q.rows[0];
      const no = { ok: false, error: 'That code does not match' };
      if (!m) return no;
      if (m.code_tries > CODE_TRIES || new Date(m.code_exp).getTime() < Date.now()) {
        await c.query('SELECT chain.member_code_clear($1,false)', [m.id]);
        return { ok: false, error: 'That code has expired — ask for another' };
      }
      if (!pinMatches(code, m.code_hash, m.code_salt)) {
        await c.query("SELECT chain.log_anon($1,'member_code_failed','member',$2,$3)",
          [req.ctx.outletId, m.id, JSON.stringify({ tries: m.code_tries })]);
        return no;
      }
      await c.query('SELECT chain.member_code_clear($1,true)', [m.id]);
      await c.query("SELECT chain.log_anon($1,'member_sign_in','member',$2,'{}')",
        [req.ctx.outletId, m.id]);
      return {
        ok: true,
        token: signMember({ m: m.id, o: req.ctx.outletId, sl: req.guest.slug,
          exp: Date.now() + 30 * 24 * 3600e3 })
      };
    });
    res.status(out.ok ? 200 : 401).json(out);
  } catch (e) { next(e); }
});

// The signed-in member's own card: their record, their open table, their own
// receipts. Nobody else's row is reachable from this token.
function member(req, res, next) {
  const claims = verifyMember(String(req.get('x-member-token') || ''));
  if (!claims || !claims.m) return res.status(401).json({ error: 'sign in again' });
  req.member = { id: claims.m, outletId: claims.o };
  req.ctx = { outletId: claims.o, rank: 0, actor: null, scope: 'outlet' };
  next();
}

r.get('/:slug/member/me', member, async function (req, res, next) {
  try {
    const out = await withOutletRead(req.ctx, async function (c) {
      const card = await c.query('SELECT * FROM chain.member_card($1)', [req.member.id]);
      if (!card.rows.length) return null;
      const hist = await c.query(
        'SELECT count(*)::int AS visits, sum(total)::numeric AS spent,'
        + ' max(business_date) AS last_visit FROM sale'
        + ' WHERE member_id = $1 AND voided_at IS NULL', [req.member.id]);
      const recent = await c.query(
        'SELECT receipt_no, business_date, at, covers, net, service, tax, total'
        + ' FROM sale WHERE member_id = $1 AND voided_at IS NULL'
        + ' ORDER BY at DESC LIMIT 25', [req.member.id]);
      const open = await c.query(
        "SELECT t.id, t.table_no, t.covers, t.stage,"
        + " coalesce(json_agg(json_build_object('id', l.item_id, 'name', l.name,"
        + "   'qty', l.qty, 'price', l.unit_price, 'sent', l.sent_at IS NOT NULL,"
        + "   'ready', l.ready_at IS NOT NULL)"
        + "   ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines"
        + ' FROM ticket t LEFT JOIN ticket_line l'
        + '   ON l.ticket_id = t.id AND l.void_at IS NULL'
        + " WHERE t.status = 'open' AND t.member_id = $1 GROUP BY t.id",
        [req.member.id]);
      // The docket, for the station and the ETA. Where the order IS rides on
      // the ticket above — this row is cleared the moment the table is served,
      // so a card that read its stage went blank as the food arrived.
      const stage = open.rows.length ? await c.query(
        'SELECT station, stage, target_mins, fired_at FROM kds_ticket'
        + ' WHERE ticket_id = $1 ORDER BY fired_at DESC LIMIT 1',
        [open.rows[0].id]) : { rows: [] };
      return {
        member: Object.assign({}, card.rows[0], {
          visits: Number(hist.rows[0].visits) || 0,
          spent: Number(hist.rows[0].spent) || 0,
          last: hist.rows[0].last_visit || ''
        }),
        receipts: recent.rows,
        ticket: open.rows[0] || null,
        stage: stage.rows[0] || null
      };
    });
    if (!out) return res.status(404).json({ error: 'no card on this token' });
    res.set('cache-control', 'no-store').json(out);
  } catch (e) { next(e); }
});

module.exports = r;
