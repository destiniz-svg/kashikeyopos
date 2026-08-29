'use strict';
const express = require('express');
const { withOutletRead, withOutlet, ownerForOutlet, control } = require('../db');
const { shapeError, storeUrl, memberUrl, joinUrl, receiptUrl, statementUrl,
  baseDomain } = require('../handle');
const directory = require('../directory');
const { sameOutlet, atLeast, groupScope } = require('../auth');
const { randomPin, hashPin, inviteToken, receiptToken, tokenHash,
  signDoc } = require('../secrets');
const { buildBootstrap, buildState, all } = require('../bootstrap');
const email = require('../email');
const INVITE = require('../../app/kashikeyo-invite.js');
const SHARE = require('../../app/kashikeyo-share.js');
const { gate } = require('../limit');
const setup = require('../setup');
const { applyOp } = require('../apply');
const { presetCounts, applyPreset } = require('../preset');

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

/* ── registering for GST, or not ─────────────────────────────────────────
   Registration is CONDITIONAL and it is a decision that gets REVISITED: a
   business opens below the threshold, charges nothing, grows, and crosses it.
   GST_WATCH puts that on the owner's Today list — this is the control that
   answers it, and without one the watch is a nag with nowhere to go.

   Rank 5. It changes what every receipt in the business says, and it changes
   the amount collected from every guest from that moment on. ─────────────── */
r.patch('/gst', sameOutlet, atLeast('owner'), async function (req, res, next) {
  const b = req.body || {};
  const want = b.registered === true || b.registered === 'yes' || b.registered === 'true';
  try {
    /* THE BUSINESS THIS REQUEST IS FOR, not the database this process dialled.
       These four calls used owner(), which is the process's own — and in a
       registry install that is a database nobody trades in. It would have
       marked THAT database's company registered and left the real one
       unregistered, so every outlet kept tax_code NONE and charged nothing
       while the screen said registered: a debt to MIRA nobody notices until an
       audit. The owner CONNECTION is still right — registration is a company
       fact that has to reach every outlet in one transaction, which no outlet
       role can do — but privilege and address are separate decisions and only
       the first had been made. */
    const db = await ownerForOutlet(req.ctx.outletId);
    if (want) {
      const tin = String(b.tin == null ? '' : b.tin).trim();
      if (!tin) {
        return res.status(400).json({ error: 'a TIN is required to register — it is what MIRA issues and what your receipts will carry' });
      }
      const code = b.code === 'TGST' ? 'TGST' : 'GGST';
      await db.query('SELECT chain.register_for_gst($1,$2,$3,$4)',
        [tin, code, b.rate == null ? null : Number(b.rate), b.from || null]);
    } else {
      /* Coming OFF the register. The outlets have to follow in the same
         breath: a company marked unregistered whose outlets still hold a rate
         would keep charging tax it may no longer collect. */
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        await c.query("UPDATE chain.outlet SET tax_code = 'NONE' WHERE tax_code <> 'NONE'");
        await c.query("DELETE FROM chain.tax_version WHERE outlet_id IS NOT NULL AND code <> 'NONE'");
        await c.query('UPDATE chain.company SET gst_registered = false, tin = NULL,'
          + ' updated_at = now() WHERE id = 1');
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    }

    const now = await db.query(
      'SELECT gst_registered, tin FROM chain.company WHERE id = 1');
    const mine = await db.query(
      'SELECT tax_code FROM chain.outlet WHERE id = $1', [req.ctx.outletId]);
    await withOutlet(req.ctx, (c) => c.query('SELECT chain.log($1,$2,$3,$4,$5)',
      ['gst_registration', 'company', '1', null,
        JSON.stringify({ registered: want, code: (mine.rows[0] || {}).tax_code })]));

    res.json({
      registered: (now.rows[0] || {}).gst_registered === true,
      tin: (now.rows[0] || {}).tin || '',
      code: (mine.rows[0] || {}).tax_code || 'NONE'
    });
  } catch (e) {
    const says = checkSays(e);
    if (says) return res.status(400).json({ error: says });
    next(e);
  }
});

/* ── what a 23514 is allowed to say out loud ─────────────────────────────
   Two kinds of thing raise a check violation here, and only one of them wrote
   a sentence for a person.

   A trigger or a function RAISEs with a MESSAGE somebody composed — "this
   business is not registered for GST, so Sea House cannot charge GGST" — and
   passing that through is the whole point of writing it.

   A DECLARATIVE check has no message. Postgres phrases it itself, as `new row
   for relation "outlet" violates check constraint "outlet_slug_is_a_handle"`,
   and that went to the browser verbatim: an internal constraint name and a
   table name handed to whoever asked, saying nothing an operator can act on.

   So: `e.constraint` present means Postgres wrote the sentence, and it gets
   translated by name or falls back to a plain refusal. Absent means a person
   wrote it, and it is repeated as written. */
const CHECK_SAYS = {
  outlet_slug_is_a_handle: 'A store address is 3 to 40 characters, lower-case'
    + ' letters, numbers and single hyphens — no leading, trailing or doubled'
    + ' hyphen',
  company_tin_iff_registered: 'A GST-registered business has a TIN, and one'
    + ' that is not registered has none — the two have to agree'
};
function checkSays(e) {
  if (!e || e.code !== '23514') return null;
  if (!e.constraint) return e.message;      // written for a person; say it
  return CHECK_SAYS[e.constraint]
    || 'That change is not one the books allow';
}

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
    // This store's own database — see ownerForOutlet(). Read from the process's
    // database it showed whatever slug happened to be on that outlet id there.
    const mine = await (await ownerForOutlet(id)).query(
      'SELECT slug FROM chain.outlet WHERE id = $1', [id]);
    // Retired addresses are registry rows now: they have to outlive a business
    // database being restored, and nobody else may claim them meanwhile.
    const past = await control().query(
      'SELECT name AS handle, retired_at FROM chain.handle_history'
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
    const why = await control().query('SELECT chain.handle_why($1,$2) AS w', [want, id]);
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
    /* The REGISTRY renames, in one transaction that retires the old name and
       claims the new one — a rename that recorded the old and failed to set the
       new leaves a store answering to an address the directory thinks is
       retired, and the reverse kills every card already printed. The business
       database's slug is a copy and follows. */
    const q = await control().query('SELECT chain.rename_handle($1,$2) AS now', [id, want]);
    /* THE COPY FOLLOWS IN THE STORE'S OWN DATABASE. Written through owner()
       this claimed the new name in the registry and then renamed an outlet in
       the process's database — so the registry said the store had moved and
       the store's own row still carried the old address, which is the half-
       done rename this transaction exists to prevent. */
    const db = await ownerForOutlet(id);
    const was = await db.query(
      'SELECT slug FROM chain.outlet WHERE id = $1', [id]).then((r) => (r.rows[0] || {}).slug);
    await db.query('UPDATE chain.outlet SET slug = $2 WHERE id = $1',
      [id, q.rows[0].now]);
    // The next request should see the new address rather than wait out the
    // directory's refresh window.
    directory.forget();
    res.json({
      handle: want, was: was, moved: was !== want,
      url: storeUrl(want, ''), memberUrl: memberUrl(want),
      base: baseDomain()
    });
  } catch (e) {
    // 23514 is the rename function refusing a handle it will not give out —
    // with its own words, unless it was the shape constraint, which has none.
    const says = checkSays(e);
    if (says) return res.status(409).json({ error: says });
    next(e);
  }
});

/* ── the live snapshot both guest portals read. Prices, stages and what is
      owed — no margins, no costs, no staff records. A guest device has no
      business holding those, so they are not in the projection at all. ───── */
/* ── inviting a customer to their own portal ─────────────────────────────
   An invitation is an EVENT, not a boolean. It was a flag flipped in bulk:
   no channel, no time, no sender, no resend, no revoke — and on a row where
   the field was simply absent it claimed the customer already had access.

   What support has to be able to answer is "was this person invited, how, by
   whom, when, and is that invitation still good". So the row records all six,
   and `chain.member_invite()` resolves the address for the channel and refuses
   BY NAME when there is none — inviting on WhatsApp a customer with no mobile
   silently falling back to email is how a code reaches the wrong person.

   Three channels, because all three ride something the customer has already
   given: email is on the membership, Viber and WhatsApp both ride the mobile
   number. Nothing here asks a guest for anything new, which is the point of
   inviting from that row rather than from a form.

   Email is a real transport when one is configured (`src/email.js`); Viber and
   WhatsApp are not wired in this build. Either way the response says which of
   the two happened — `sent` is never a guess — and the code comes back for the
   counter to read out, because a code that reached nobody is worse than one a
   person hands over.

   Sending again REISSUES the code, so the previous one stops working: an
   invitation forwarded to the wrong person cannot be used.

   Not an outbox op, for the same reason a rename is not: a sign-in code lives
   ten minutes, and one that arrives later through a replay queue is a code
   nobody can use. Rank 2 — the till. Whoever is standing with the guest.
   ─────────────────────────────────────────────────────────────────────── */
const CHANNELS = { email: 'Email', viber: 'Viber', whatsapp: 'WhatsApp' };
const TOKEN_DAYS = 7;

/* What a point is worth, in the outlet's own currency, from the outlet's own
   published rate. A hard-coded figure in a message quotes the guest a number
   the till will not honour the moment the merchant edits it. */
async function pointsWorth(c, points) {
  const q = await c.query("SELECT value FROM chain.setting WHERE key = 'loyalty'");
  const cfg = (q.rows[0] || {}).value || {};
  const per = Number(cfg.redeemPts) || 100;
  const val = Number(cfg.redeemValue) || 25;
  const cur = await c.query('SELECT currency FROM chain.outlet WHERE id ='
    + ' current_setting(\'app.outlet_id\')::int');
  const code = ((cur.rows[0] || {}).currency || 'MVR');
  return code + ' ' + Math.round((Number(points) || 0) / per * val).toLocaleString('en-US');
}

/* Rank 2 may invite, but the send is an email billed to the business, so one
   outlet gets sixty an hour — a busy counter never sees the ceiling, and a
   compromised till session cannot turn the outlet into a spam relay. Keyed on
   the OUTLET, not the device: the till is signed in, so the doorman here is
   about spend, not identity. */
/* ── HANDING A DOCUMENT TO THE GUEST ──────────────────────────────────────
   A receipt and an account statement, by email, WhatsApp or Viber. THREE
   CHANNELS AND ONE MECHANISM: the document lives at a permanent address and
   sharing it is handing over that address. Every till in this category works
   this way, and it is the only shape in which the three channels are one
   feature — a message app carries a URL, an inbox carries a URL, a printed QR
   carries a URL.

   The channel decides the transport and NOTHING else. Email goes through
   `src/email.js` and answers `sent` honestly; WhatsApp and Viber are handed
   back as click-to-chat links the cashier's own app completes, which is the
   only send this build can make on those two. A screen claiming a server-side
   WhatsApp send is the defect this build keeps refusing to ship.

   Rank 2 — whoever is standing with the guest — and the same per-outlet
   doorman the invitation has, because an email is billed to the business. */
/* `link` IS A CHANNEL, and it is the one that needs nothing. Giving a document
   an address and DELIVERING it are two acts, and the till's "Copy the link" is
   only the first — a cashier reading the address out, or pasting it into an
   app this build has never heard of. It used to be sent as an `email` share
   with the answer thrown away, so copying a link for a customer with no
   address on file was refused 409 and opened a form asking for one. Nothing
   was going to be emailed. */
const SHARE_KINDS = { email: 1, whatsapp: 1, viber: 1, link: 1 };

// Where a document would live, or nothing. Checked BEFORE anything is minted:
// a message carrying `/r/RC…` reaches an inbox with nothing to resolve it, and
// the guest is left holding a link that does nothing.
function docLinkOrRefuse(kind, slug, token) {
  const url = kind === 'statement' ? statementUrl(slug, token) : receiptUrl(slug, token);
  if (url) return url;
  const err = new Error('this deploy has no public address, so a shared '
    + 'document would carry a link that resolves to nothing \u2014 set '
    + 'PUBLIC_URL (or PORTAL_BASE_DOMAIN) and share it again');
  err.status = 503;
  throw err;
}

async function deliver(via, msg, to) {
  // Nothing is being sent, so nothing is claimed and nothing is a failure.
  if (via === 'link') return { sent: false, reason: '' };
  if (via === 'email') {
    try {
      const r0 = await email.send({ to: to, subject: msg.subject, text: msg.body });
      return { sent: r0.sent === true, reason: r0.reason || '' };
    } catch (e) {
      return { sent: false, reason: e.message || 'the transport refused' };
    }
  }
  // Named, not pretended. The cashier completes it from their own app.
  return { sent: false, reason: via === 'whatsapp'
    ? 'WhatsApp has no server transport here \u2014 open the link and WhatsApp '
      + 'will have the message ready to send'
    : 'Viber has no server transport here \u2014 open the link and Viber will '
      + 'have the message ready to share' };
}

r.post('/sale/:saleId/share', sameOutlet, atLeast('till'),
  gate('doc-share', { id: [120, 3600e3] }, (req) => 'outlet:' + req.ctx.outletId),
  async function (req, res, next) {
    const via = String((req.body || {}).via || 'email').toLowerCase();
    if (!SHARE_KINDS[via]) {
      return res.status(400).json({ error: 'not a channel this build can share on: ' + via });
    }
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        const o = (await c.query('SELECT slug, name, currency FROM chain.outlet'
          + ' WHERE id = $1', [req.ctx.outletId])).rows[0] || {};
        docLinkOrRefuse('receipt', o.slug || '', 'RC' + 'x'.repeat(32));

        const sale = (await c.query('SELECT s.*, m.name AS member_name,'
          + ' m.phone AS member_phone, m.email AS member_email'
          + ' FROM sale s LEFT JOIN chain.member m ON m.id = s.member_id'
          + ' WHERE s.id = $1', [req.params.saleId])).rows[0];
        if (!sale) return null;

        /* MINTED ONCE AND KEPT. A receipt re-sent has to reach the SAME page:
           a new link every time would leave the guest's older message pointing
           at a document that no longer answers, which is a receipt they cannot
           produce at the moment they need it. */
        let tok = sale.share_token;
        if (!tok) {
          tok = receiptToken();
          await c.query('UPDATE sale SET share_token = $2 WHERE id = $1',
            [sale.id, tok]);
        }
        return { o: o, sale: sale, token: tok };
      });
      if (!out) return res.status(404).json({ error: 'no such sale at this outlet' });

      const link = docLinkOrRefuse('receipt', out.o.slug || '', out.token);
      /* THE ADDRESS TO USE, in one order that is the same on every channel:
         what the cashier typed for this send, then what is on the customer's
         record. A guest who gives an address at the counter is answering for
         this receipt; the record is the standing answer. */
      const typed = String((req.body || {}).to || '').trim();
      const to = typed || (via === 'email' ? (out.sale.member_email || '')
        : (out.sale.member_phone || ''));
      const doc = {
        kind: 'receipt', outlet: out.o.name || '',
        name: out.sale.member_name || '', docNo: out.sale.receipt_no,
        total: Number(out.sale.total) || 0, currency: out.o.currency || 'MVR',
        when: String(out.sale.business_date || '').slice(0, 10),
        link: link, email: via === 'email' ? to : (out.sale.member_email || ''),
        phone: via === 'email' ? (out.sale.member_phone || '') : to
      };
      const msg = { subject: SHARE.subjectFor('receipt', doc), body: SHARE.bodyFor('receipt', doc) };

      const blocked = SHARE.why(via, doc);
      if (blocked) return res.status(409).json({ error: blocked, link: link });

      const sent = await deliver(via, msg, to);
      await withOutlet(req.ctx, (c) => c.query(
        "SELECT chain.log_anon($1,'receipt_shared','sale',$2,$3)",
        [req.ctx.outletId, out.sale.id, JSON.stringify({
          by: req.ctx.actor, via: via, to: to, sent: sent.sent,
          doc: out.sale.receipt_no })]));

      res.set('cache-control', 'no-store').json({
        link: link, docNo: out.sale.receipt_no, via: via, to: to,
        subject: msg.subject, body: msg.body,
        // Click-to-chat, for the two channels a person completes by hand.
        handoff: (via === 'email' || via === 'link') ? '' : SHARE.channelUrl(via, doc),
        sent: sent.sent === true, reason: sent.reason || ''
      });
    } catch (e) {
      if (e && e.status === 503) return res.status(503).json({ error: e.message });
      next(e);
    }
  });

/* ═══ A STORE'S SETUP, IN A FILE SOMEBODY HOLDS ════════════════════════════
   Download what the shop spent a fortnight typing in — sections, dishes,
   recipes, ingredients, customers, suppliers, the floor plan, the settings —
   and put it back after a reset.

   RANK 5, because this is the whole store's configuration leaving the
   building, and putting one back rewrites every one of those things at once.
   Not rank 4: an admin runs the shop; the owner decides what the shop IS.

   NO OWNER CONNECTION. Every table this touches is one the outlet's own login
   role already reads under RLS — it is the same data the bootstrap publishes
   to the till on every sign-in. So the six-exception list in `src/db.js` does
   not grow, and this endpoint cannot reach a business it is not scoped to.

   AUDITED BOTH WAYS. A configuration leaving on somebody's laptop, and a
   configuration arriving from one, are both events a support call three weeks
   later needs to find. */
r.get('/setup/parts', sameOutlet, atLeast('owner'), function (req, res) {
  res.json({ parts: setup.PARTS(), format: setup.FORMAT });
});

r.get('/setup/export', sameOutlet, atLeast('owner'),
  gate('setup-export', { id: [30, 3600e3] }, (req) => 'outlet:' + req.ctx.outletId),
  async function (req, res, next) {
    try {
      const file = await withOutletRead(req.ctx, async function (c) {
        const o = (await c.query('SELECT id, code, name FROM chain.outlet'
          + ' WHERE id = $1', [req.ctx.outletId])).rows[0] || {};
        return setup.exportSetup(c, { parts: req.query.parts, outlet: o });
      });
      await withOutlet(req.ctx, (c) => c.query(
        "SELECT chain.log_anon($1,'setup_exported','outlet',$2,$3)",
        [req.ctx.outletId, String(req.ctx.outletId), JSON.stringify({
          by: req.ctx.actor, parts: file.parts, counts: file.counts })]));
      const name = 'kashikeyo-setup-' + (file.outlet.code || req.ctx.outletId)
        + '-' + String(file.at).slice(0, 10) + '.json';
      res.set('content-disposition', 'attachment; filename="' + name + '"')
        .set('cache-control', 'no-store')
        .json(file);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

/* A setup file carries dish photographs, which are the largest thing in it —
   the global parser is capped at 4mb and a photographed menu is bigger than
   that. Its own parser rather than a wider global one: every other door in
   this app should stay at 4mb. */
r.post('/setup/import', sameOutlet, atLeast('owner'),
  express.json({ limit: '48mb' }),
  gate('setup-import', { id: [10, 3600e3] }, (req) => 'outlet:' + req.ctx.outletId),
  async function (req, res, next) {
    try {
      const body = req.body || {};
      const file = body.file || body;
      const out = await withOutlet(req.ctx, (c) => setup.importSetup(c, file,
        { parts: body.parts == null ? null : body.parts, ctx: req.ctx }));
      await withOutlet(req.ctx, (c) => c.query(
        "SELECT chain.log_anon($1,'setup_imported','outlet',$2,$3)",
        [req.ctx.outletId, String(req.ctx.outletId), JSON.stringify({
          by: req.ctx.actor, applied: out.applied, refused: out.refused.length,
          from: (file.outlet || {}).code || null, at: file.at || null })]));
      res.set('cache-control', 'no-store').json(out);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

/* ── THE PRE-SET MENU, for a store that already exists. The same catalogue the
   onboarding choice offers a brand-new store (src/preset.js), through the same
   handlers, so an outlet added later — or one that chose "empty" and thought
   better of it — gets it in one act. Rank 5 like the setup import, because
   this writes the whole of what the store sells; no offline path, because
   landing 430 rows is not a till op and a half-applied menu behind a toast is
   the defect the holding pen exists to catch. Idempotent: every kind is an
   upsert keyed by the row's own id, so a retry converges. */
r.post('/menu/preset', sameOutlet, atLeast('owner'),
  gate('menu-preset', { id: [10, 3600e3] }, (req) => 'outlet:' + req.ctx.outletId),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, (c) => applyPreset(c, req.ctx, applyOp));
      await withOutlet(req.ctx, (c) => c.query(
        "SELECT chain.log_anon($1,'menu_preset_loaded','outlet',$2,$3)",
        [req.ctx.outletId, String(req.ctx.outletId), JSON.stringify({
          by: req.ctx.actor, applied: out.applied })]));
      res.set('cache-control', 'no-store').json(Object.assign({ ok: true }, out));
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

/* What the choice would land — for the screen that offers it. */
r.get('/menu/preset', sameOutlet, atLeast('manager'), function (req, res) {
  res.json(presetCounts());
});

/* A STATEMENT is a PERIOD, so it names one — an account summary with no dates
   is a figure the customer cannot check against anything. Signed rather than
   stored and it expires, because a permanent link to "this customer's account"
   is a standing window into somebody's spending; a receipt is one document
   they keep, which is why that one does not expire. */
const STATEMENT_DAYS = 30;

r.post('/member/:memberId/statement', sameOutlet, atLeast('till'),
  gate('doc-share', { id: [120, 3600e3] }, (req) => 'outlet:' + req.ctx.outletId),
  async function (req, res, next) {
    const via = String((req.body || {}).via || 'email').toLowerCase();
    if (!SHARE_KINDS[via]) {
      return res.status(400).json({ error: 'not a channel this build can share on: ' + via });
    }
    const day = (v, fallback) => {
      const t = String(v || '').trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : fallback;
    };
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        const o = (await c.query('SELECT slug, name, currency FROM chain.outlet'
          + ' WHERE id = $1', [req.ctx.outletId])).rows[0] || {};
        const today = (await c.query('SELECT current_date::text AS d')).rows[0].d;
        const back = (await c.query(
          "SELECT (current_date - interval '90 days')::date::text AS d")).rows[0].d;
        const m = (await c.query('SELECT id, name, phone, email, credit_used'
          + ' FROM chain.member WHERE id = $1', [req.params.memberId])).rows[0];
        if (!m) return null;
        return { o: o, m: m,
          from: day((req.body || {}).from, back), to: day((req.body || {}).to, today) };
      });
      if (!out) return res.status(404).json({ error: 'no such customer' });

      const tok = signDoc({ o: req.ctx.outletId, m: out.m.id,
        f: out.from, t: out.to, exp: Date.now() + STATEMENT_DAYS * 86400e3 });
      const link = docLinkOrRefuse('statement', out.o.slug || '', tok);

      const typed = String((req.body || {}).to_addr || '').trim();
      const to = typed || (via === 'email' ? (out.m.email || '') : (out.m.phone || ''));
      const doc = {
        kind: 'statement', outlet: out.o.name || '', name: out.m.name || out.m.phone,
        from: out.from, to: out.to, balance: Number(out.m.credit_used) || 0,
        currency: out.o.currency || 'MVR', link: link,
        email: via === 'email' ? to : (out.m.email || ''),
        phone: via === 'email' ? (out.m.phone || '') : to
      };
      const msg = { subject: SHARE.subjectFor('statement', doc),
        body: SHARE.bodyFor('statement', doc) };

      const blocked = SHARE.why(via, doc);
      if (blocked) return res.status(409).json({ error: blocked, link: link });

      const sent = await deliver(via, msg, to);
      await withOutlet(req.ctx, (c) => c.query(
        "SELECT chain.log_anon($1,'statement_shared','member',$2,$3)",
        [req.ctx.outletId, out.m.id, JSON.stringify({
          by: req.ctx.actor, via: via, to: to, sent: sent.sent,
          from: out.from, until: out.to })]));

      res.set('cache-control', 'no-store').json({
        link: link, via: via, to: to, from: out.from, until: out.to,
        expires: new Date(Date.now() + STATEMENT_DAYS * 86400e3).toISOString(),
        days: STATEMENT_DAYS, subject: msg.subject, body: msg.body,
        handoff: (via === 'email' || via === 'link') ? '' : SHARE.channelUrl(via, doc),
        sent: sent.sent === true, reason: sent.reason || ''
      });
    } catch (e) {
      if (e && e.status === 503) return res.status(503).json({ error: e.message });
      next(e);
    }
  });

r.post('/member/:memberId/invite', sameOutlet, atLeast('till'),
  gate('invite', { id: [60, 3600e3] }, (req) => 'outlet:' + req.ctx.outletId),
  async function (req, res, next) {
    const via = String((req.body || {}).via || 'email').toLowerCase();
    if (!CHANNELS[via]) {
      return res.status(400).json({
        error: 'not a channel this build can invite on: ' + via
      });
    }
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        const o = await c.query('SELECT slug, name FROM chain.outlet WHERE id = $1',
          [req.ctx.outletId]);
        const slug0 = (o.rows[0] || {}).slug || '';

        /* AN INVITATION IS A LINK, so a deploy that cannot spell an absolute
           one has no invitation to send. Checked HERE, before the token is
           minted: `chain.member_invite()` replaces the live token, so a refusal
           after it would kill a working invitation to report a broken one.

           This is not a nicety. A message carrying `/join/MV-...` reaches an
           inbox where there is nothing to resolve it against, and the guest is
           left holding a link that does nothing while the row says they were
           invited. Set PUBLIC_URL, or PORTAL_BASE_DOMAIN. */
        if (!joinUrl(slug0, 'MV-probe-0')) {
          const err = new Error('this deploy has no public address, so an '
            + 'invitation would carry a link that resolves to nothing \u2014 set '
            + 'PUBLIC_URL (or PORTAL_BASE_DOMAIN) and send it again');
          err.status = 503;
          throw err;
        }

        // The token says WHO. It travels in the message, lives seven days, and
        // is spent on use — so what is stored is its hash, never itself.
        // Issuing one invalidates the last, which is what makes a resend an
        // invalidation rather than a second live key.
        const tok = inviteToken();
        const inv = await c.query(
          'SELECT * FROM chain.member_invite($1,$2,$3,$4,$5,$6)',
          [req.params.memberId, via, (req.body || {}).to || null,
            req.ctx.actor || null, tokenHash(tok), TOKEN_DAYS]);
        if (!inv.rows.length) return null;
        const m = inv.rows[0];
        const co = await c.query('SELECT brand FROM chain.company LIMIT 1');
        // A guest should read a person's name, not a login handle: "Sent by
        // nashwa" is a system talking about itself. The audit trail keeps the
        // handle; the message carries the name they can ask for at the counter.
        const by = req.ctx.actor
          ? await c.query('SELECT name FROM chain.staff WHERE id = $1', [req.ctx.actor])
          : { rows: [] };
        const msg = INVITE.compose({
          chan: via,
          name: m.name || m.phone,
          outlet: (o.rows[0] || {}).name || '',
          chain: ((co.rows[0] || {}).brand || {}).name || 'Kashikeyo',
          points: Number(m.points) || 0,
          worth: await pointsWorth(c, m.points),
          sender: (by.rows[0] || {}).name || req.ctx.name || '',
          link: joinUrl(slug0, tok)
        });
        return { m: m, token: tok, msg: msg, slug: slug0,
          brand: (o.rows[0] || {}).name || '' };
      });
      if (!out) return res.status(404).json({ error: 'no such customer' });

      // Sending happens OUTSIDE the transaction: a transport that hangs must
      // not hold a row lock, and a transport that refuses must not roll back an
      // invitation the counter can still complete by handing the link over.
      let delivery = { sent: false, via: 'none', reason: 'no transport configured' };
      if (via === 'email') {
        try {
          delivery = await email.send({
            to: out.m.invited_to, subject: out.msg.subject,
            text: out.msg.body
          });
        } catch (e) {
          delivery = { sent: false, via: 'none', reason: e.message || 'the transport refused' };
        }
      } else if (via === 'whatsapp') {
        // The only WhatsApp send this build can honestly make is the staff
        // member's own: click-to-chat opens THEIR WhatsApp with the message
        // composed. A server cannot post to it, and a screen claiming
        // otherwise is the defect this build keeps refusing to ship.
        delivery = { sent: false, via: 'handoff',
          reason: 'WhatsApp has no server transport here — open the link below '
            + 'and WhatsApp will have the message ready to send' };
      } else {
        delivery = { sent: false, via: 'none',
          reason: 'Viber is recorded, not wired: this build has no Viber '
            + 'business API configured, so the message is handed over at the counter' };
      }

      await withOutlet(req.ctx, async function (c) {
        await c.query("SELECT chain.log_anon($1,'member_invite','member',$2,$3)",
          [req.ctx.outletId, out.m.id, JSON.stringify({
            by: req.ctx.actor, via: via, to: out.m.invited_to,
            n: out.m.invite_count, sent: delivery.sent, exp: out.m.token_exp
          })]);
        /* The wording is audited SEPARATELY from the send. What a guest was
           told is a different fact from the fact that they were told, and a
           support call three weeks later needs the wording, not the timestamp.
           The token is not in it: an audit trail is read by more people than
           an inbox is. */
        await c.query("SELECT chain.log_anon($1,'member_invite_body','member',$2,$3)",
          [req.ctx.outletId, out.m.id, JSON.stringify({
            via: via, to: out.m.invited_to,
            subject: out.msg.subject || null,
            body: out.msg.body.split(out.token).join('<link>')
          })]);
      });

      res.set('cache-control', 'no-store').json({
        member: { id: out.m.id, name: out.m.name, phone: out.m.phone },
        // Where their card is, for a counter that would rather point than send.
        url: memberUrl(out.slug),
        // The invitation itself: one link, whichever channel carries it.
        link: out.msg.link, expires: out.m.token_exp, days: TOKEN_DAYS,
        subject: out.msg.subject, body: out.msg.body,
        // Click-to-chat, for the one channel a person can complete by hand.
        handoff: via === 'whatsapp'
          ? INVITE.whatsappHandoff(out.m.invited_to, out.msg.body) : '',
        via: via, channel: CHANNELS[via], to: out.m.invited_to,
        count: out.m.invite_count, restored: out.m.was_revoked === true,
        sent: delivery.sent === true, reason: delivery.reason || ''
      });
    } catch (e) {
      // P0001 is the invite function refusing a channel by name — "Aishath has
      // no email address on file". That is an answer, not a server fault.
      if (e && e.code === 'P0001') return res.status(409).json({ error: e.message });
      // And a deploy with no public address is a configuration answer, which is
      // the operator's to fix rather than the cashier's to retry.
      if (e && e.status === 503) return res.status(503).json({ error: e.message });
      next(e);
    }
  });

/* ── taking the portal back ──────────────────────────────────────────────
   Revoking stops the sign-in and KEEPS the history: the row reads "Revoked",
   never "Not invited", so support can tell a member who was let go from one
   who was never asked. Any live code is spent in the same statement, because
   a revocation that leaves a working code in a guest's inbox is not one.

   The gate is in `chain.member_code_set()`, which refuses a revoked member —
   so it holds for the code the guest requests for themselves as well as for
   the one the counter issues, and a phone cannot get in by asking nicely.

   Rank 3: withdrawing someone's access is not a cashier's to make. ──────── */
r.post('/member/:memberId/revoke', sameOutlet, atLeast('manager'),
  async function (req, res, next) {
    try {
      const out = await withOutlet(req.ctx, async function (c) {
        const g = await c.query('SELECT * FROM chain.member_revoke($1,$2)',
          [req.params.memberId, req.ctx.actor || null]);
        if (!g.rows.length) return null;
        await c.query("SELECT chain.log_anon($1,'member_revoke','member',$2,$3)",
          [req.ctx.outletId, g.rows[0].id, JSON.stringify({ by: req.ctx.actor })]);
        return g.rows[0];
      });
      if (!out) return res.status(404).json({ error: 'no such customer' });
      res.set('cache-control', 'no-store')
        .json({ member: { id: out.id, name: out.name }, revoked: true });
    } catch (e) { next(e); }
  });

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
    /* What a GUEST may be offered. `active` was the only filter, which let two
       things onto a phone that must never be there: a dish the back office has
       taken off the menu — the toggle says "till, QR menu and printed list
       alike" — and a BATCH the kitchen makes, which is an item so that
       recipe_line.sub_item_id resolves and is not something anybody orders.

       THE QR CHANNEL IS RESOLVED HERE, ONCE (048): a dish or a whole section
       switched off the guest's phone — while the counter keeps ringing it —
       never reaches either portal, so no phone works out a section rule for
       itself and the table menu and the member card can never disagree. A
       HIDDEN section goes with it: hidden is off every channel, and the
       dish-level filter alone let a hidden section's dishes onto the phone.

       And a bought-in tray SELLS ITSELF OUT: the count is the shelf's, so at
       zero the dish reads sold out on the phone without anyone touching a
       switch — projected through the same sold_out_reason field both portals
       already render. */
    items: ['SELECT i.id, i.name, i.category_id, i.price, i.description, i.image,'
      + ' i.allergens, i.diets, i.off_menu,'
      + ' coalesce(i.sold_out_reason, CASE WHEN i.buy_item IS NOT NULL'
      + '   AND coalesce(ing.on_hand, 0) <= 0 THEN \'Sold out\' END)'
      + '   AS sold_out_reason'
      + ' FROM item i'
      // LEFT joins: a dish in no section is not thereby promoted or demoted.
      + ' LEFT JOIN menu_category mc ON mc.id = i.category_id'
      + ' LEFT JOIN ingredient ing ON ing.id = i.buy_item'
      + ' WHERE i.active AND NOT i.off_menu AND NOT i.is_batch'
      + '   AND NOT i.qr_off AND NOT coalesce(mc.hidden, false)'
      + '   AND NOT coalesce(mc.qr_off, false)'
      + ' ORDER BY i.pos, i.name'],
    cats: ['SELECT id, name, pos FROM menu_category'
      + ' WHERE active AND NOT hidden AND NOT qr_off ORDER BY pos, name'],
    // The floor is the outlet's own, never a count guessed by the phone: a
    // room with six tables must not offer a guest twelve to sit at.
    floor: ['SELECT id, label, seats, zone_id FROM table_def WHERE active'
      + ' ORDER BY pos, label'],
    zones: ['SELECT id, name FROM zone WHERE active ORDER BY pos, name'],
    // `stage` is where the order IS — the rung the pass and the floor both
    // write. The docket rows below carry the station and the ETA, but they
    // vanish the moment a table is served, so a tracker that read them went
    // blank exactly when the guest's food was ready.
    tickets: ["SELECT t.id, t.table_no, t.split, t.covers, t.status, t.stage,"
      + " coalesce(json_agg(json_build_object('id', l.item_id, 'name', l.name,"
      + "   'qty', l.qty, 'price', l.unit_price, 'note', l.note,"
      + "   'sent', l.sent_at IS NOT NULL, 'ready', l.ready_at IS NOT NULL)"
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
      + " WHERE key IN ('tiers','rewards','loyalty','currencies','processors')"],
    /* Add-ons are MENU facts — name, price, which sections they dress — so a
       guest may see them; nothing here carries a cost or a margin. Without
       these the phone fell back to the SHIPPED demo modifiers, which offered
       every store's guests somebody else's extra cheese. */
    mods: ['SELECT id, name, price, group_id FROM modifier ORDER BY pos, name'],
    itemMods: ['SELECT item_id, group_id FROM item_modifier'],
    // Who the guest is dealing with, as it is going to appear on their receipt.
    company: ['SELECT legal_name, brand, country, base_currency FROM chain.company'
      + ' LIMIT 1'],
  });
  const zoneName = {};
  q.zones.rows.forEach((z) => { zoneName[z.id] = z.name; });
  const loyalty = {};
  q.loyalty.rows.forEach((r) => { loyalty[r.key] = r.value; });

  /* THE TENDERS ARE THE TILL'S OWN, not a guess on the phone. The portals
     used to read a till's localStorage — present only when a till shares the
     browser — and fall back to a hardcoded three, so a real guest's phone
     never offered QR or Transfer however the store took money. Suspending a
     contract takes its tender off the till, so it comes off the phone in the
     same act; cash has no contract and is always offered; customer credit is
     a MEMBER's tender and says so. */
  const procOv = loyalty.processors || {};
  const suspended = (procId) => !!(procOv[procId] || {}).suspended;
  const tenders = [{ k: 'cash', label: 'Cash' }];
  if (!suspended('term')) tenders.push({ k: 'card', label: 'Card' });
  if (!suspended('wallet')) tenders.push({ k: 'wallet', label: 'BML Pay' });
  if (!suspended('gw')) tenders.push({ k: 'qr', label: 'QR' });
  if (!suspended('direct')) tenders.push({ k: 'transfer', label: 'Transfer' });
  tenders.push({ k: 'credit', label: 'My account', memberOnly: true });

  /* The same shape the bootstrap publishes to the till, so `addonsFor()` on
     the phone is the same filter the till runs: which sections a group
     dresses is derived from the dishes that carry it. */
  const modsByGroup = {};
  q.itemMods.rows.forEach((im) => {
    (modsByGroup[im.group_id] = modsByGroup[im.group_id] || []).push(im.item_id);
  });
  const catOfItem = {};
  q.items.rows.forEach((i) => { catOfItem[i.id] = i.category_id; });
  const modifiers = q.mods.rows.map((m) => ({
    id: m.id, name: m.name, price: Number(m.price) || 0, group: m.group_id,
    cats: Array.from(new Set((modsByGroup[m.group_id] || [])
      .map((itemId) => catOfItem[itemId]).filter(Boolean)))
  }));

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
    loyalty: loyalty.loyalty || {},
    tenders: tenders,
    modifiers: modifiers
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

/* ═══ THE LAN PRINT RELAY ═══════════════════════════════════════════════════
   An Ethernet receipt printer listens on raw TCP 9100 and a browser cannot
   open a socket — so the till hands the composed ESC/POS bytes to the server,
   and the server writes them to the printer. That is only REAL when the
   server shares the printer's network (a LAN-hosted install); a cloud deploy
   that tries it gets a timeout and the spool records the truth, which is the
   contract everywhere else in this build.

   A relay that connects wherever it is told is an SSRF primitive with a
   payload, so the fence is explicit: the port is 9100 and not negotiable, and
   the resolved ADDRESS — not the name, which anyone can point anywhere — must
   not be loopback, link-local (169.254.x is every cloud's metadata service)
   or this process's own host. Private LAN ranges stay open on purpose:
   that is where printers live. */
r.post('/print', sameOutlet, atLeast('kitchen'), async function (req, res, next) {
  const b = req.body || {};
  const host = String(b.host || '').trim();
  const data = String(b.data || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host)) {
    return res.status(400).json({ error: 'that is not a printer address' });
  }
  if (!data || data.length > 90000) {
    return res.status(400).json({ error: 'a print job is at most 64KB of bytes' });
  }
  let buf;
  try { buf = Buffer.from(data, 'base64'); } catch (e) { buf = null; }
  if (!buf || !buf.length) return res.status(400).json({ error: 'no bytes to print' });

  try {
    const dns = require('dns');
    const { address } = await dns.promises.lookup(host);
    /* AN ALLOW-LIST, NOT A DENY-LIST. This blocked the addresses somebody had
       thought of — 127.x, ::1, 169.254.x — and let everything else through,
       which meant two things. It let 0.0.0.0 through, and on Linux a connect
       to the unspecified address goes to loopback: proved by dialling it, the
       bytes arrived at a listener on 127.0.0.1:9100 and this endpoint answered
       {"sent":true}. And it let PUBLIC addresses through, so a signed-in
       cashier could ask the server to open a socket to any host on the
       internet, one port at a time.

       A printer is never on a public address. So the question is turned round:
       the resolved address must be inside a PRIVATE range, and everything
       outside one is refused without anybody having to have thought of it
       first. That is the whole of the SSRF surface closed rather than fenced.

       An IPv4-mapped IPv6 address is the same address wearing a different
       spelling, so it is unwrapped BEFORE it is judged rather than
       pattern-matched twice — and the address dialled below is the unwrapped
       one, so what was judged is what is reached. */
    const flat = String(address).replace(/^::ffff:/i, '');
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(flat);
    const o = v4 ? v4.slice(1, 5).map(Number) : null;
    const privateV4 = !!o && o.every((n) => n >= 0 && n <= 255) && (
      o[0] === 10                                   // 10/8
      || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)  // 172.16/12
      || (o[0] === 192 && o[1] === 168)              // 192.168/16
      || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) // 100.64/10, carrier NAT
    );
    // fc00::/7 is the v6 side of "private", and the only v6 range a printer
    // is plausibly on. Link-local (fe80::/10, and 169.254 on the v4 side) is
    // deliberately NOT private here: 169.254.169.254 is every cloud's
    // metadata service.
    const privateV6 = /^f[cd][0-9a-f]{2}:/i.test(flat);
    const allowLoop = process.env.NODE_ENV !== 'production'
      && process.env.PRINT_ALLOW_LOOPBACK === '1'
      && (/^127\./.test(flat) || flat === '::1');

    if (!privateV4 && !privateV6 && !allowLoop) {
      return res.status(400).json({
        error: 'that is not a printer on this network — a receipt printer sits'
             + ' on the shop\'s own LAN, and only those addresses are dialled'
      });
    }
    const net = require('net');
    await new Promise(function (resolve, reject) {
      // Dial exactly what was judged, not the string DNS handed back.
      const sock = net.connect({ host: flat, port: 9100 });
      const die = (msg) => { sock.destroy(); reject(new Error(msg)); };
      sock.setTimeout(4000, () => die('the printer did not answer in 4 seconds'));
      sock.on('error', (e) => die(e.code === 'ECONNREFUSED'
        ? 'nothing is listening at ' + host + ':9100' : e.message));
      sock.on('connect', function () {
        sock.end(buf, () => resolve());
      });
    });
    res.json({ sent: true, via: 'net', bytes: buf.length });
  } catch (e) {
    // An unreachable printer is an operational fact, not a server fault.
    res.status(502).json({ error: e.message });
  }
});

module.exports = r;
module.exports.snapshot = snapshot;
