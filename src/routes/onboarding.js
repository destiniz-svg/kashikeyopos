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
const crypto = require('crypto');
const { owner, withOutlet, control, ownerFor, CONTROL_DB } = require('../db');

/* The database this request is onboarding.

   FAILS CLOSED WHERE A REGISTRY EXISTS. `owner()` — the connection's own — is
   the single-database case, and the right answer for a local run, the test
   suite and every install until its registry exists. It is the WRONG answer
   the moment CONTROL_DB is set: falling back there writes one customer's
   company, outlets and staff into the database every business shares, which is
   the tenancy boundary failing open at the front door.

   It shipped that way for one deploy, because /account sent a verified account
   to /onboarding without creating a business first and nothing here refused.
   A missing business is now a refusal that says what to do. */
function biz(req) {
  if (req && req.bizDb) return ownerFor(req.bizDb);
  /* An ACCOUNT with no business never reaches a handler — the middleware below
     refuses it first — so this is a backstop, and it throws rather than
     quietly returning the shared database, because that failure is silent by
     nature. It must agree with that middleware exactly: anonymous onboarding
     is the single-database install claiming itself, and gets the connection's
     own database whether or not a registry exists. */
  if (CONTROL_DB() && req && req.account) {
    throw Object.assign(new Error('this account has no business yet — create'
      + ' one first (POST /api/account/business)'), { status: 409 });
  }
  return owner();
}

/* Which business this outlet belongs to. The registry is the map; a business
   database does not know its own registry id, and inventing one here would be
   a second source of truth for the thing routing depends on. */
async function businessIdOf(outletId) {
  const q = await control().query(
    'SELECT business_id FROM chain.outlet_directory WHERE outlet_id = $1',
    [outletId]);
  if (!q.rows.length) {
    throw Object.assign(new Error('outlet ' + outletId + ' is in no business —'
      + ' it was created without a registry entry'), { status: 500 });
  }
  return Number(q.rows[0].business_id);
}
const { provisionOutlet } = require('../provision');
const { normalise, shapeError, baseDomain, storeUrl, memberUrl } = require('../handle');
const { hashPin, sign, verifyAccount } = require('../secrets');
const { session, atLeast, ROLE_KEY_BY_RANK } = require('../auth');
const { applyOp } = require('../apply');
const { gate } = require('../limit');

const r = express.Router();

/* ── WHO GETS TO CLAIM A FRESH INSTALL ──────────────────────────────────────
   The three steps before there is anybody to sign in as — company, first
   outlet, first owner — cannot be behind a staff session, because the staff
   session is what step 3 creates. They were therefore behind nothing at all,
   and `chain.claim_first_owner()` succeeds exactly ONCE in the life of an
   installation: whoever POSTs first is the rank-5 owner of the business.

   That is a race, and the starting gun is public. A new install's hostname
   reaches the certificate transparency logs within minutes of its first TLS
   handshake, which is well inside the gap between "the seller provisions it"
   and "the customer sits down and types their company name".

   ONBOARDING_CLAIM_TOKEN closes it, and it is deliberately the same shape as
   PANEL_SETUP_TOKEN in Mission Control: a secret set on the install at
   provisioning time and handed to the customer with their address. Set, the
   three steps require it and compare in constant time. UNSET, they stay open —
   an install onboarding itself on a counter has no seller to get a code from —
   and the boot log says so BY NAME, exactly as an unset PLATFORM_KEY makes the
   platform door a 404 and says so. A fence that is silently absent is worse
   than no fence, because somebody believes in it.

   The doorman stands here either way: an open install is still not free to
   hammer, and a wrong code should cost something. */
function claim(req, res, next) {
  const want = process.env.ONBOARDING_CLAIM_TOKEN || '';
  if (want.length < 8) return next();                    // fence not enabled

  /* AND THE RACE IT GUARDS DOES NOT EXIST FOR A BUSINESS THAT MADE ITSELF.
     Everything above is the per-install world: one empty database on a public
     hostname, three steps behind nothing, and whoever POSTs first is the
     owner. A registry install is not that. `req.bizDb` is set only where a
     VERIFIED, active account owns a live business in chain.account_business —
     a database that account created itself, through POST /api/account/business,
     which already requires a token, a confirmed address and a ceiling. There is
     no gun to jump: a stranger cannot reach these steps at all, because the
     middleware above answers 409 to an account with no business and the
     account token is what names the database.

     So the code is not asked for where the stronger credential is already
     present. It is not weakened anywhere else: with no registry, or with an
     account that owns nothing, the fence stands exactly as it did, and the
     doorman stands in front of it either way.

     Left in place, this asks a self-serve customer for a code no one ever
     issued them — the install's own boot log says "unclaimed", and there is
     nobody to ring. */
  if (req.bizDb) return next();

  const got = String(req.get('x-claim-token') || '');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (ok) return next();
  return res.status(403).json({
    claim: true,
    error: got
      ? 'That setup code is not this install\'s. Ask whoever set the store up.'
      : 'This install needs its setup code before it can be claimed.'
  });
}

/* Wrong codes and company names are both cheap to send and expensive to
   answer, so the three open steps are rate-limited whether or not the fence is
   on. Wide enough that a customer correcting a typo four times never notices;
   tight enough that walking a code space is not free. */
const openDoor = gate('onboard-claim', { ip: [30, 900e3] }, null);

/* Attach the signed-up account when one is presented. Never refuses: the
   account is who to CREDIT the business to, not permission to create it. */
r.use(async function (req, res, next) {
  const raw = String(req.get('x-account-token') || '');
  if (!raw) return next();
  const claims = verifyAccount(raw);
  if (!claims || !claims.a) return next();
  try {
    const q = await control().query(
      "SELECT id, email, name, status FROM chain.account WHERE id = $1", [claims.a]);
    if (q.rows.length && q.rows[0].status === 'active') req.account = q.rows[0];
    /* WHICH DATABASE IS BEING ONBOARDED. Onboarding runs before an outlet
       exists, so there is no outlet to route by — the account is the route,
       through the business it owns. Without this every customer's onboarding
       wrote into whichever database the app happened to be connected to,
       which is the whole tenancy boundary failing open at step one. */
    if (req.account && CONTROL_DB()) {
      /* WHICH BUSINESS, when an account owns more than one. This took the
         NEWEST — `ORDER BY b.id DESC LIMIT 1` — and there was no way to say
         otherwise. For the ordinary customer, who owns exactly one, that is
         the right answer and always will be. For a group that has signed up a
         second company it is a coin toss that writes a company, an outlet and
         a staff record into whichever database happened to be created last,
         silently, with nothing on any screen naming it.

         So the panel may say. `?business=<id>` is honoured when this account
         actually owns it, and REFUSED by name when it does not — an account
         naming somebody else's business is either a mistake worth reporting
         or an attempt worth refusing, and neither should quietly fall back to
         one of their own. With nothing asked for, the newest still wins,
         because that is what a customer who has just created one expects. */
      const mine = await control().query(
        'SELECT b.id, b.db_name, b.name FROM chain.account_business ab'
        + ' JOIN chain.business b ON b.id = ab.business_id'
        + " WHERE ab.account_id = $1 AND b.status = 'live'"
        + ' ORDER BY b.id DESC', [req.account.id]);
      req.businesses = mine.rows.map((x) => ({ id: x.id, name: x.name }));

      const asked = Number(req.query.business || req.get('x-business-id') || 0);
      let pick = mine.rows[0] || null;
      if (asked) {
        pick = mine.rows.find((x) => Number(x.id) === asked) || null;
        if (!pick) {
          return res.status(403).json({
            error: 'business ' + asked + ' is not one this account owns',
            businesses: req.businesses
          });
        }
      }
      if (pick) {
        req.bizDb = pick.db_name;
        req.bizId = pick.id;
        req.bizName = pick.name;
      }
    }
    next();
  } catch (e) {
    /* An unreadable registry must not silently onboard into the wrong
       database. Losing the account is survivable — the steps are open until
       claimed — but proceeding as though there were no business, when there
       is one, writes the company into whichever database this process happens
       to be connected to. That is the tenancy boundary failing open, so it
       fails loudly instead. */
    console.error('[onboarding] could not resolve the account: ' + e.message);
    next(e);
  }
});

/* NO BUSINESS, NO ONBOARDING. Refused here rather than inside a handler for a
   plain reason: these handlers are async, and express 4 does not catch a
   rejected promise — a throw deeper in would leave the request hanging with no
   response at all, which is what the first version of this did.

   Only where a registry exists — and an install without one is refused at
   boot now (server.js, registryNamed()), because outlet ids and store
   addresses are the registry's to give and step 2 cannot run without it. What
   is left of this branch is the anonymous claim on an install that has one,
   which is fenced by ONBOARDING_CLAIM_TOKEN. */
/* IS THE PROCESS'S OWN DATABASE A BUSINESS? Anonymous onboarding writes
   through owner(), which is that database — the install claiming itself, fenced
   by ONBOARDING_CLAIM_TOKEN. That is a real path and the suite runs on it.

   It is only real where that database HAS the business schema. In a registry
   install pointed at its registry it does not, and the anonymous branch fell
   through to a bare 500 from `chain.install_state() does not exist` — found in
   the audit by asking /state with no headers. Probed once and cached, because
   a database does not become a business between requests, and re-asking on
   every anonymous call would put a round trip on the front door. */
let selfIsBusiness = null;
async function processDbIsBusiness() {
  if (selfIsBusiness !== null) return selfIsBusiness;
  try {
    const q = await owner().query("SELECT to_regclass('chain.company') IS NOT NULL AS yes");
    selfIsBusiness = !!q.rows[0].yes;
  } catch (e) {
    // Unreachable is not "not a business" — do not cache a network blip.
    return false;
  }
  return selfIsBusiness;
}

r.use(async function (req, res, next) {
  if (!CONTROL_DB() || req.bizDb) return next();
  if (!req.account && await processDbIsBusiness()) return next();
  /* An ACCOUNT with no business is the case that shipped broken: /account sent
     a verified account here and the route fell back to the database every
     business shares. Refused, with where to go.

     NO ACCOUNT AT ALL used to be let through, as the single-database install
     claiming itself. There is no such install any more — one without a
     registry is refused at boot — so what that branch actually did on a
     registry install was fall through to owner(), which is a database with no
     chain.company in it, and answer a bare 500. Found in the audit by asking
     /state with no headers. An anonymous caller here has no business to
     describe and there is no honest answer but to say so. */
  res.status(409).json(req.account ? {
    error: 'this account has no business yet — create one first',
    next: 'business'
  } : {
    error: 'sign in first — this app serves many businesses, and setting one'
      + ' up starts from the account that will own it',
    next: 'account'
  });
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
    const st = await biz(req).query('SELECT * FROM chain.install_state()');
    const s = st.rows[0];
    const done = { company: Number(s.company) > 0, outlet: Number(s.outlets) > 0,
      owner: Number(s.staff) > 0 };
    // Whether the business registered for GST reshapes steps 2 and 4, so the
    // panel has to know it before it renders them — and it has to be the saved
    // answer, not one inferred from an outlet that does not exist yet.
    const reg = await biz(req).query('SELECT chain.gst_registered() AS on');
    const gstRegistered = !!reg.rows[0].on;
    /* WHAT HAS ALREADY BEEN SAID, so the panel can show it back. Two jobs:
       "same as the business" on step 2 has to read the RECORD or a reload
       breaks the offer, and a step somebody goes Back to must show what is
       stored rather than an empty form under a chip reading "done".

       Only until an owner exists — the same window the setup code covers, and
       after that this is Settings' job, behind a session. */
    let company = null;
    let outletRec = null;
    if (done.company && !done.owner) {
      const co = await biz(req).query('SELECT legal_name, reg_no, tin, address,'
        + ' atoll, phone, email, base_currency, brand FROM chain.company WHERE id = 1');
      const c = co.rows[0] || {};
      company = { legalName: c.legal_name, regNo: c.reg_no, tin: c.tin,
        address: c.address, atoll: c.atoll, phone: c.phone, email: c.email,
        currency: c.base_currency, brand: c.brand || {} };
    }
    if (done.outlet && !done.owner) {
      const o = await biz(req).query('SELECT o.id, o.code, o.name, o.slug, o.kind,'
        + ' o.tax_code, o.service_pct, o.day_start, o.address, o.atoll, o.phone, o.brand,'
        // The rate IN FORCE, not the statutory one for the class: a store that
        // charges a rate of its own must be shown its own on the way back.
        + ' (SELECT tv.rate FROM chain.tax_version tv WHERE tv.outlet_id = o.id'
        + '   AND tv.effective_from <= current_date'
        + '   AND (tv.effective_to IS NULL OR tv.effective_to >= current_date)'
        + '   ORDER BY tv.effective_from DESC LIMIT 1) AS tax_rate,'
        + ' (SELECT tv.effective_from FROM chain.tax_version tv WHERE tv.outlet_id = o.id'
        + '   ORDER BY tv.effective_from DESC LIMIT 1) AS tax_from'
        + ' FROM chain.outlet o ORDER BY o.id LIMIT 1');
      const x = o.rows[0];
      if (x) {
        outletRec = { id: x.id, code: x.code, name: x.name, slug: x.slug,
          kind: x.kind, taxCode: x.tax_code,
          servicePct: x.service_pct == null ? null : String(Number(x.service_pct)),
          dayStart: x.day_start ? String(x.day_start).slice(0, 5) : null,
          address: x.address, atoll: x.atoll, phone: x.phone, brand: x.brand || {},
          taxRate: x.tax_rate == null ? null : String(Number(x.tax_rate)),
          taxFrom: x.tax_from ? String(x.tax_from).slice(0, 10) : null };
      }
    }
    let deeper = {};
    if (done.outlet) {
      const o = await biz(req).query('SELECT id, schema_name FROM chain.outlet'
        + ' ORDER BY id LIMIT 1');
      const sc = o.rows[0].schema_name;
      const q = await biz(req).query(
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
      counts: deeper.counts || {},
      gstRegistered: gstRegistered,
      /* Whether this install wants its setup code — never the code itself,
         and only while the three open steps are still open. Once an owner
         exists there is nothing left to claim, so the panel should stop
         asking rather than keep a field on screen that does nothing. */
      claimRequired: (process.env.ONBOARDING_CLAIM_TOKEN || '').length >= 8
        && !done.owner
        // Not of a business that made itself — see claim() for why the code
        // has nothing left to protect there. Asked for, it would be a field
        // nobody can fill.
        && !req.bizDb,
      /* WHAT THEY CALLED THE BUSINESS WHEN THEY SIGNED UP. Typed once, on the
         account form, and it is the registry's name for this customer — not
         the outlet's, which step 2 asks for separately, and not a trading
         fascia. The panel prefills step 1's legal name with it so the same
         answer is not given twice; step 1 then writes back, because the
         registered name is the one that matters and the signup's was a
         working title. */
      business: req.bizName || null,
      businessId: req.bizId || null,
      /* THE COMPANY'S OWN CONTACT, so step 2 can offer "same as the business"
         and mean it. A single-outlet business trades at its registered address
         on its registered number — asking for both twice is the panel asking a
         customer to type the same street name into two boxes. It has to come
         from the RECORD rather than from what step 1 happened to leave in the
         page, or the offer is broken by a reload. Only what step 1 itself
         collected, and only until an owner exists, which is the same window
         the setup code covers. */
      company: company,
      outlet: outletRec,
      /* EVERY business this account owns, so a group with two can be told
         which one it is setting up rather than discovering it afterwards from
         the company name on a receipt. One business is the ordinary case and
         the panel says nothing about it. */
      businesses: req.businesses || []
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
/* Is this the code? Asked at the gate, before the panel lets anybody type a
   company name — because this build's own rule about the store handle applies
   here too: a green tick must not be followed by a refusal on save. It shares
   the company step's bucket by name, so checking a code costs exactly what
   sending one costs and there is no cheaper oracle to walk. */
r.post('/claim', openDoor, claim, function (req, res) {
  res.json({ ok: true });
});

r.post('/company', openDoor, claim, async function (req, res, next) {
  const b = req.body || {};
  /* Registration is CONDITIONAL — migration 009 has the threshold, and a
     business below it charges nothing. So the TIN is required of a REGISTERED
     business and of nobody else: an unregistered one has none to give, and
     asking it to invent one puts a false statement on every receipt it
     prints. */
  const registered = b.gstRegistered === true || b.gstRegistered === 'yes'
    || b.gstRegistered === 'true';
  const tin = String(b.tin == null ? '' : b.tin).trim();
  if (!b.legalName || !b.regNo || !b.address) {
    return res.status(400).json({ error: 'legal name, registration number and registered address are all required' });
  }
  if (registered && !tin) {
    return res.status(400).json({ error: 'a TIN is required — it is what a GST-registered business puts on its receipts' });
  }
  /* ONE TRANSACTION, BECAUSE THIS STEP IS FOUR WRITES AND THREE OF THEM ARE
     CONSEQUENCES. Turning registration off has to reach the outlets and the
     rate versions, and crediting the account has to reach the company — and
     these ran as four separate statements on a pooled connection. A crash, a
     dropped connection or a container restart between any two of them left the
     install in a state the database's own guards call impossible: a company
     marked unregistered whose outlets still hold a tax code, or a business
     with nobody owning it. Both are recoverable by hand and neither is
     discoverable without looking. */
  const c = await biz(req).connect();
  try {
    await c.query('BEGIN');
    const already = await c.query('SELECT id FROM chain.company WHERE id = 1');
    if (already.rows.length) {
      // Editable from Settings afterwards, through the same columns.
      if (!req.get('authorization')) {
        await c.query('ROLLBACK');
        return res.status(409).json({ error: 'company already set — edit it in Settings' });
      }
    }
    await c.query(
      'INSERT INTO chain.company (id, legal_name, reg_no, tin, address, atoll,'
      + ' country, phone, email, base_currency, fy_start_month, brand, gst_registered)'
      + " VALUES (1,$1,$2,$3,$4,$5,coalesce($6,'Maldives'),$7,$8,coalesce($9,'MVR'),"
      + ' coalesce($10,1), $11, $12) ON CONFLICT (id) DO UPDATE SET legal_name = $1,'
      + ' reg_no = $2, tin = $3, address = $4, atoll = $5, phone = $7, email = $8,'
      + ' gst_registered = $12,'
      // The base currency is the books' currency; re-running the step must be
      // able to correct it while the install is still empty.
      + " base_currency = coalesce($9, chain.company.base_currency),"
      + ' brand = $11, updated_at = now()',
      [b.legalName, b.regNo, registered ? tin : null, b.address,
        b.atoll || null, b.country || null,
        b.phone || null, b.email || null, b.currency || null,
        b.fyStartMonth || null, JSON.stringify(b.brand || {}), registered]);

    /* Turning registration OFF has to reach the outlets, or they keep a rate
       they may no longer charge. The database would refuse the next write
       anyway; doing it here means the refusal never has to happen. */
    if (!registered) {
      await c.query("UPDATE chain.outlet SET tax_code = 'NONE' WHERE tax_code <> 'NONE'");
      await c.query('DELETE FROM chain.tax_version WHERE outlet_id IS NOT NULL'
        + " AND code <> 'NONE'");
    }
    // Whoever is signed in as they complete this owns the business. The
    // question "whose is this" must not depend on which outlet you look at.
    if (req.account) {
      await c.query(
        'UPDATE chain.company SET owner_account_id = coalesce(owner_account_id, $1)'
        + ' WHERE id = 1', [req.account.id]);
    }
    await c.query('COMMIT');

    /* THE REGISTRY LEARNS THE REGISTERED NAME. What the customer typed on the
       signup form was a working title — enough to name a database by, given
       before anybody asked for a registration number. The legal name is the
       one on the return, and if the registry keeps the working title for ever
       then the seller's list and the customer's own receipts disagree about
       who this is, which is the kind of difference nobody notices until it is
       on an invoice.

       Deliberately AFTER the commit and deliberately not fatal: this is one
       name in one list, and the company is already correctly written. Failing
       the step here would tell a customer their company did not save when it
       did. It goes on the trail instead. */
    if (req.bizId && b.legalName) {
      try {
        await control().query(
          'UPDATE chain.business SET name = $2 WHERE id = $1 AND name IS DISTINCT FROM $2',
          [req.bizId, String(b.legalName).trim()]);
      } catch (e) {
        console.error('[onboarding] the registry kept the signup name: ' + e.message);
      }
    }
    res.json({ ok: true, step: 'company', gstRegistered: registered });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { c.release(); }
});

// The books' currency, as the company step recorded it.
async function baseCurrency(db) {
  const q = await db.query('SELECT base_currency FROM chain.company WHERE id = 1');
  return (q.rows[0] || {}).base_currency || 'MVR';
}

/* Is this store address free? Asked while somebody is typing, so it answers
   the same question the database will answer when they submit — one function,
   chain.handle_why(), reached from both — and it says WHY rather than "no". A
   panel that shows a green tick and then refuses on save is worse than one
   that never checked. It also hands back the suggestion, so the field can fill
   itself in from the business name without the page knowing the rules. */
r.get('/handle', async function (req, res, next) {
  try {
    const raw = String(req.query.h || req.query.handle || '');
    const want = raw.trim().toLowerCase();
    const suggested = normalise(req.query.from || raw);
    const shape = shapeError(want);
    if (shape) {
      return res.json({ handle: want, free: false, why: shape,
        suggested: suggested, base: baseDomain(), url: null });
    }
    const q = await biz(req).query('SELECT chain.handle_why($1) AS w', [want]);
    const why = q.rows[0].w;
    res.json({ handle: want, free: !why, why: why || null,
      suggested: suggested, base: baseDomain(),
      url: why ? null : storeUrl(want, '') });
  } catch (e) { next(e); }
});

/* ── 2 · First outlet. Creates the schema and the login role. ───────────── */
r.post('/outlet', openDoor, claim, async function (req, res, next) {
  const b = req.body || {};
  if (!b.name || !b.code) return res.status(400).json({ error: 'outlet name and code required' });
  try {
    const st = await biz(req).query('SELECT * FROM chain.install_state()');
    const first = Number(st.rows[0].outlets) === 0;
    if (!first && !req.get('authorization')) {
      return res.status(403).json({ error: 'sign in to add another outlet' });
    }
    const out = await provisionOutlet({
      // The business this request is onboarding, not whichever database the
      // process happens to be connected to.
      db: req.bizDb || null,
      name: b.name, code: b.code, kind: b.kind || 'restaurant',
      // provisionOutlet settles this against chain.gst_registered(); passing
      // null lets it, rather than asserting GGST on a business that has none.
      taxCode: b.taxCode || null, taxRate: b.taxRate, taxFrom: b.taxFrom,
      servicePct: b.servicePct == null ? 10 : b.servicePct,
      address: b.address, atoll: b.atoll, phone: b.phone,
      /* The store's own face — logo, email, website, postal code, mobile.
         Migration 044 gave the outlet a `brand` of its own for exactly these:
         they are what a receipt and a portal print, and none of them is a
         column anybody queries on. */
      brand: b.brand || null,
      // An outlet keeps the company's books, so it keeps the company's
      // currency unless it is explicitly given another one.
      tz: b.tz, currency: b.currency || (await baseCurrency(biz(req))), dayStart: b.dayStart,
      // The store's public address. Absent, provisioning derives one from the
      // name; given, it is honoured or refused by name — never quietly swapped,
      // because they are about to print it on the tables.
      slug: b.slug || b.handle || null
    });
    const q = await biz(req).query('SELECT slug FROM chain.outlet WHERE id = $1', [out.id]);
    const h = (q.rows[0] || {}).slug || '';
    res.status(201).json(Object.assign({}, out, {
      handle: h, storeUrl: storeUrl(h, ''), memberUrl: memberUrl(h)
    }));
  } catch (e) { next(e); }
});

/* ── 3 · Owner account. Rank 5. Callable once, then never again. ────────── */
r.post('/owner', openDoor, claim, async function (req, res, next) {
  const b = req.body || {};
  if (!b.name || !b.pin) return res.status(400).json({ error: 'name and PIN required' });
  if (!/^\d{4,8}$/.test(String(b.pin))) return res.status(400).json({ error: 'PIN must be 4 to 8 digits' });
  try {
    const o = await biz(req).query('SELECT id FROM chain.outlet ORDER BY id LIMIT 1');
    if (!o.rows.length) return res.status(409).json({ error: 'create the first outlet before the owner account' });
    const h = hashPin(b.pin);
    const q = await biz(req).query('SELECT chain.claim_first_owner($1,$2,$3,$4) AS id',
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
      /* Ownership is a REGISTRY fact now, not a business one: an account may
         own several businesses, and "what do I own" has to be answerable
         without opening every database in the cluster. The staff record stays
         where the floor is — it is a different person's credential even when
         it is the same human. */
      await control().query(
        'INSERT INTO chain.account_business (account_id, business_id, role)'
        + " VALUES ($1,$2,'owner')"
        + ' ON CONFLICT (account_id, business_id) DO NOTHING',
        [req.account.id, await businessIdOf(o.rows[0].id)]);
      await biz(req).query('UPDATE chain.company SET owner_account_id = $1'
        + ' WHERE owner_account_id IS NULL', [req.account.id]).catch(() => {});
      await biz(req).query(
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
    /* The company decides whether there is a rate at all; the outlet decides
       WHICH rate once there is. An unregistered business confirms nothing here
       — and saying so is better than a step that quietly writes GGST because
       the select defaulted to it. */
    const reg = await biz(req).query('SELECT chain.gst_registered() AS on');
    const code = reg.rows[0].on ? (b.code || 'GGST') : 'NONE';
    await withOutlet(req.ctx, async function (c) {
      await c.query('UPDATE chain.outlet SET tax_code = $2 WHERE id = $1',
        [req.ctx.outletId, code]);
      if (code === 'NONE') {
        await c.query('INSERT INTO chain.tax_version (outlet_id, code, rate,'
          + " effective_from, authority_ref) VALUES ($1,'NONE',0,$2,'Not registered')"
          + ' ON CONFLICT DO NOTHING', [req.ctx.outletId, b.from || today()]);
      } else {
        await c.query('INSERT INTO chain.tax_version (outlet_id, code, rate,'
          + ' effective_from, authority_ref) VALUES ($1,$2,$3,$4,$5)'
          + ' ON CONFLICT (outlet_id, code, effective_from) DO UPDATE SET rate = $3',
          [req.ctx.outletId, code, Number(b.rate), b.from || today(),
            b.ref || 'Confirmed at onboarding']);
      }
      if (b.servicePct != null) {
        await c.query('UPDATE chain.outlet SET service_pct = $2 WHERE id = $1',
          [req.ctx.outletId, Number(b.servicePct)]);
      }
    });
    res.json({ ok: true, step: 'tax', code: code });
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

/* Onboarding runs before an outlet has a timezone of its own to read, so it
   takes the country's — which is the only zone this build is ever installed in,
   and is what the outlet will be created with. UTC here backdated the first tax
   version by a day for anyone onboarding in the evening. */
function today() {
  return new Intl.DateTimeFormat('en-CA',
    { timeZone: 'Indian/Maldives' }).format(new Date());
}

module.exports = r;
module.exports.STEPS = STEPS;
