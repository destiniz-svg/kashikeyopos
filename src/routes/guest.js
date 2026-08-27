'use strict';
/* ═══ THE GUEST SIDE ════════════════════════════════════════════════════════
   A guest posts INTENT; the till decides. The phone never takes money, never
   sees a cost, never sees a staff record. That is why this router has its own
   token type (a table token, rank 0) and its own projection — a guest device
   holding a margin figure is a data leak, not a feature.
   ═══════════════════════════════════════════════════════════════════════ */

const express = require('express');
const { owner, control, ownerFor, withOutlet, withOutletRead } = require('../db');
const { signTable, verifyTable, signMember, verifyMember,
  hashPin, pinMatches, randomPin, tokenHash } = require('../secrets');
const { snapshot } = require('./outlet');
const { hostHandle } = require('../handle');
const INVITE = require('../../app/kashikeyo-invite.js');
const email = require('../email');
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
/* The table-token mint is the one anonymous door that reaches the database and
   was the one with no doorman. Nobody signs in to scan a QR, so the budget is
   generous — a room full of guests all scanning at once is the ordinary case,
   and forty a minute from one address is not. Every other open door on this
   router has had one since the rate-limit pass; this one was simply missed. */
const tableMint = { ip: [400, 10 * 60e3] };

// A QR encodes the outlet handle and the table. The token is minted here, not
// carried in the URL, so a guest cannot retype it onto another table.
async function mintTable(req, res, want) {
  // Current address or one the store gave up — chain.handle_points_at answers
  // both, so a card printed under the old name keeps opening the right menu.
  /* Resolved in the REGISTRY. A handle is one name across every business, and
     a business database only knows its own outlets — asking it "who holds
     seaside" gets "nobody" from every business that does not, so a guest
     scanning a card would land on a 404 or, worse, on whichever store the
     request happened to reach. The registry says which business, and only then
     is that business's own database opened for the store's name. */
  const p = await control().query(
    'SELECT p.outlet_id, p.business_id, NOT p.current AS retired, b.db_name'
    + ' FROM chain.handle_points_at($1) p'
    + ' JOIN chain.business b ON b.id = p.business_id', [want]);
  const o = p.rows.length
    ? await ownerFor(p.rows[0].db_name).query(
      'SELECT id, name, slug FROM chain.outlet WHERE id = $1', [p.rows[0].outlet_id])
      .then((q) => ({ rows: q.rows.map((x) => Object.assign({}, x,
        { retired: p.rows[0].retired })) }))
    : { rows: [] };
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
r.get('/token', gate('table-mint', tableMint, null), async function (req, res, next) {
  try {
    const want = hostHandle(req.hostname || req.get('host') || '');
    if (!want) {
      return res.status(404).json({ error: 'This address does not name a store' });
    }
    return await mintTable(req, res, want);
  } catch (e) { next(e); }
});

r.get('/:slug/token', gate('table-mint', tableMint, null), async function (req, res, next) {
  try { return await mintTable(req, res, req.params.slug); }
  catch (e) { next(e); }
});

function guest(req, res, next) {
  /* The header, and only the header. This also read `req.query.t`, which this
     build's own rule forbids — "a credential never rides in a query string",
     written when an unused `?at=` fallback came off the account guard, because
     a token in a URL is a token in the proxy log, the browser history and every
     bookmark somebody shares. Worse here: on the QR portal `?t=` is the TABLE
     NUMBER, so one parameter meant two things, which is exactly the confusion
     that put a foreign credential into a membership lookup on the phone side.
     Every client has always sent the header; nothing is being taken away. */
  const t = req.get('x-table-token') || '';
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
  /* A member ordering from their own card is attributed — FROM THE TOKEN,
     never from a body field. guest_order.member_id is what attaches the
     membership to the ticket the till opens, and a sale's member is what
     earns points, so an anonymous door that believed a client-claimed id
     would let anybody earn on anybody's card. A token for another outlet is
     simply not this outlet's member. */
  const mt = verifyMember(String(req.get('x-member-token') || ''));
  const memberId = (mt && mt.o === req.ctx.outletId && mt.m) ? mt.m : null;
  try {
    const out = await withOutlet(req.ctx, async function (c) {
      if (b.opId) {
        const seen = await c.query('SELECT result FROM op_log WHERE op_id = $1', [b.opId]);
        if (seen.rows.length) return seen.rows[0].result;   // replay, not a second order
      }
      const ins = await c.query(
        'INSERT INTO guest_order (table_no, lines, promo, guest_name, guest_phone, note, member_id)'
        + ' VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, at',
        [String(table), JSON.stringify(b.lines), b.promo || null,
          b.name || null, b.phone || null, b.note || null, memberId]);
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

/* THERE IS NO LOOK-A-MEMBER-UP-BY-PHONE DOOR, AND THAT IS THE POINT.
   `GET /:slug/member?phone=` used to answer with a customer's name, points and
   join date behind nothing but a table token — and a table token is mintable by
   anyone who can read a QR sticker. Walking a range of Maldivian mobile numbers
   would have harvested the roster: who is a customer here, what they are called,
   what they are worth. Every other door in this file keeps the opposite promise
   — /member/start answers identically whether or not the address is known — so
   this one contradicted the design rather than extending it.

   Nothing called it: the card signs in with a code (/member/start → /verify),
   which is the honest way to ask "am I a member here". It is deleted rather
   than rate-limited, because a slower leak is still a leak. */

r.post('/:slug/member/start', guest, gate('member-code', codeIssue, askedFor), async function (req, res, next) {
  // Either half of the membership: the phone on the card or the email on file.
  const phone = String((req.body || {}).id || (req.body || {}).phone || '').trim();
  if (phone.length < 6) return res.status(400).json({ error: 'phone or email required' });
  try {
    /* THE CODE GOES TO THE INBOX ON THE MEMBERSHIP. Reading a code off the
       floor board works across a counter and nowhere else — a member signing
       in from home was asking a terminal nobody was standing at. So where the
       membership carries an email and the install has a transport, the code
       is SENT; the floor board stays as the fallback for the member with no
       address on file, and for the night the transport is down.

       The send happens OUTSIDE the transaction: the hash is committed first,
       so a slow mail provider holds no pooled connection, and a send that
       fails leaves a code the counter can still read out. */
    const staged = await withOutlet(req.ctx, async function (c) {
      // Four digits from the CSPRNG, hashed with a per-row salt exactly like a
      // staff PIN — and, like a PIN, it is the expiry and the try limit that
      // make it safe, never the entropy. What the database holds is never the
      // code.
      const code = randomPin();
      const h = hashPin(code, null);
      const q = await c.query('SELECT chain.member_code_set($1,$2,$3,$4) AS id',
        [phone, h.hash, h.salt, CODE_MINS]);
      const id = q.rows[0].id;
      if (!id) return { code: code };
      const who = await c.query('SELECT email FROM chain.member WHERE id = $1', [id]);
      const o = await c.query('SELECT name FROM chain.outlet WHERE id = $1',
        [req.ctx.outletId]);
      await c.query("SELECT chain.log_anon($1,'member_code','member',$2,$3)",
        [req.ctx.outletId, id, JSON.stringify({ mins: CODE_MINS })]);
      return { id: id, code: code, to: (who.rows[0] || {}).email || null,
        outletName: (o.rows[0] || {}).name || '' };
    });
    let emailed = false;
    if (staged.id && staged.to && email.configured()) {
      try {
        const r = await email.send(email.signInCode({ to: staged.to,
          code: staged.code, mins: CODE_MINS,
          brand: staged.outletName || 'KashikeyoPOS' }));
        emailed = !!(r && r.sent !== false);
      } catch (e) { emailed = false; }
    }
    /* A code that could not be sent is still a code — it goes to the floor
       board for a server to read out, exactly as every code did before there
       was a transport. A DELIVERED code is deliberately NOT written there: a
       credential sent to an inbox and also posted to a board every till can
       read is a second place to steal it from. */
    if (staged.id && !emailed) {
      await withOutlet(req.ctx, (c) => c.query(
        'INSERT INTO guest_request (table_no, kind, detail)'
        + " VALUES ($1,'member_code',$2)",
      [req.guest.table || 'card', 'Sign-in code for ' + phone + ': ' + staged.code]));
    }
    /* The same answer whether or not the address is a customer here — `via`
       is the INSTALL's transport, identical for every caller, the same
       doctrine as `delivered` on the account plane. */
    res.json({ sent: true, via: email.configured() ? 'email' : 'counter',
      mins: CODE_MINS,
      code: (process.env.MEMBER_CODE_ECHO === '1' && staged.id) ? staged.code : undefined });
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
      const o = await c.query('SELECT name FROM chain.outlet WHERE id = $1',
        [req.ctx.outletId]);
      await c.query("SELECT chain.log_anon($1,'member_join','member',$2,$3)",
        [req.ctx.outletId, id, JSON.stringify({ mins: CODE_MINS })]);
      return { m: m, code: code, outletName: (o.rows[0] || {}).name || '' };
    });
    if (!out) {
      return res.status(410).json({
        error: 'That link has already been used or has expired'
      });
    }
    /* The invitation reached an inbox, so its code can too — same delivery
       rule as /member/start: sent where there is an address and a transport,
       on the floor board otherwise, never both. */
    let emailed = false;
    if (out.m.email && email.configured()) {
      try {
        const r = await email.send(email.signInCode({ to: out.m.email,
          code: out.code, mins: CODE_MINS,
          brand: out.outletName || 'KashikeyoPOS' }));
        emailed = !!(r && r.sent !== false);
      } catch (e) { emailed = false; }
    }
    if (!emailed) {
      await withOutlet(req.ctx, (c) => c.query(
        'INSERT INTO guest_request (table_no, kind, detail)'
        + " VALUES ($1,'member_code',$2)",
      ['card', 'Sign-in code for ' + (out.m.name || out.m.phone) + ': ' + out.code]));
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
