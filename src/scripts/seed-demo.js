'use strict';
/* ═══ A BUSINESS TO LOOK AT ═════════════════════════════════════════════════
   A staging environment with an empty database demonstrates nothing. This puts
   a small, believable restaurant into one — deliberately a business that is NOT
   registered for GST, because that is the case worth being able to see: no TIN
   anywhere, no tax line on anything, and GST_WATCH measuring turnover toward
   the threshold rather than nagging about a registration that already exists.

   It writes through the SAME handlers the onboarding panel posts to
   (chain.provision_outlet, applyOp, chain.claim_first_owner), so what comes out
   is an install the app made, not a set of rows somebody typed. A demo built by
   a different path is a demo that proves nothing about the real one.

   Three guards, because this writes to whatever DATABASE_URL points at:

     1. SEED_DEMO must be exactly "yes-i-mean-it";
     2. it REFUSES when RAILWAY_ENVIRONMENT_NAME is "production" — Railway
        injects that itself, so it cannot be forgotten in a copied variable set;
     3. it REFUSES if a company already exists. Seeding is for an EMPTY
        environment; on a populated one it would be somebody else's data.
   ═══════════════════════════════════════════════════════════════════════ */

const { owner, withOutlet, shutdown } = require('../db');
const { provisionOutlet } = require('../provision');
const { hashPin } = require('../secrets');
const { applyOp } = require('../apply');

const CONFIRM = 'yes-i-mean-it';
const PIN = '4726';

async function run(say) {
  const log = say || console.log;                        // eslint-disable-line no-console

  if (process.env.SEED_DEMO !== CONFIRM) {
    throw new Error('refusing: set SEED_DEMO="' + CONFIRM + '" to confirm');
  }
  if ((process.env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase() === 'production') {
    throw new Error('refusing: RAILWAY_ENVIRONMENT_NAME is "production"');
  }
  const has = await owner().query('SELECT count(*)::int AS n FROM chain.company');
  if (has.rows[0].n) {
    log('[seed] a company already exists — leaving this environment alone');
    return { seeded: false };
  }

  /* ── the company: below the threshold, so no TIN at all ───────────────── */
  await owner().query(
    'INSERT INTO chain.company (id, legal_name, reg_no, tin, address, atoll,'
    + ' phone, email, base_currency, gst_registered)'
    + " VALUES (1,'Kanamadhu Cafe Pvt Ltd','C-4417/2026',NULL,"
    + "'Majeedhee Magu','Malé','3324417','books@kanamadhu.mv','MVR',false)");
  log('[seed] company : Kanamadhu Cafe Pvt Ltd — NOT registered for GST, no TIN');

  /* ── the outlet. tax_code is NOT passed: provisioning takes it from
        chain.gst_registered(), which is the behaviour worth demonstrating. ── */
  const out = await provisionOutlet({
    name: 'Kanamadhu Cafe', code: 'KANA', kind: 'restaurant',
    slug: 'kanamadhu', servicePct: 10, address: 'Majeedhee Magu', atoll: 'Malé',
    phone: '3324417'
  });
  const tax = await owner().query('SELECT tax_code, slug FROM chain.outlet WHERE id = $1',
    [out.id]);
  log('[seed] outlet  : ' + out.name + ' (' + out.schema + ') tax_code='
    + tax.rows[0].tax_code + ' — followed the company, not the column default');

  /* ── the owner, so somebody can actually sign in and look ─────────────── */
  const h = hashPin(PIN);
  const who = await owner().query('SELECT chain.claim_first_owner($1,$2,$3,$4) AS id',
    [out.id, 'Ibrahim Nasheed', h.hash, h.salt]);
  log('[seed] owner   : Ibrahim Nasheed, rank 5, PIN ' + PIN);

  /* ── enough of a menu and a floor to ring a real sale ─────────────────── */
  const ctx = { outletId: out.id, rank: 5, actor: who.rows[0].id, scope: 'outlet' };
  const ops = [
    ['location_upsert', { name: 'Dry store', kind: 'store' }],
    ['menu_section_insert', { id: 'food', name: 'Food', pos: 1 }],
    // ids stated rather than derived: applyOp's own slug() uses underscores,
    // and a seed that guesses at another file's private helper is a seed that
    // breaks the day that helper is tidied up.
    ['menu_category_insert', { id: 'short_eats', name: 'Short eats', section: 'food', pos: 1 }],
    ['menu_category_insert', { id: 'hot_drinks', name: 'Hot drinks', section: 'food', pos: 2 }],
    ['dish_upsert', { id: 'mas_huni', name: 'Mas Huni', cat: 'short_eats', price: 35 }],
    ['dish_upsert', { id: 'bajiya', name: 'Bajiya (3 pc)', cat: 'short_eats', price: 18 }],
    ['dish_upsert', { id: 'gulha', name: 'Gulha (5 pc)', cat: 'short_eats', price: 25 }],
    ['dish_upsert', { id: 'sai', name: 'Sai (black tea)', cat: 'hot_drinks', price: 12 }],
    ['dish_upsert', { id: 'kiru_sai', name: 'Kiru Sai', cat: 'hot_drinks', price: 15 }],
    ['zones_update', { zones: [{ id: 'front_room', name: 'Front room', pos: 1 }] }],
    // One op per table: table_update takes a table, not a list of them. The
    // onboarding panel's /tables route maps its rows the same way.
    ['table_update', { id: 'T01', label: 'T01', zone: 'front_room', seats: 2, pos: 1 }],
    ['table_update', { id: 'T02', label: 'T02', zone: 'front_room', seats: 2, pos: 2 }],
    ['table_update', { id: 'T03', label: 'T03', zone: 'front_room', seats: 4, pos: 3 }],
    ['table_update', { id: 'T04', label: 'T04', zone: 'front_room', seats: 4, pos: 4 }],
    ['table_update', { id: 'T05', label: 'T05', zone: 'front_room', seats: 6, pos: 5 }]
  ];
  /* A savepoint per op, exactly as /sync/push does: in Postgres one failed
     statement poisons the whole transaction, so without this a single bad row
     takes every row after it down with a message about the transaction being
     aborted rather than about what was actually wrong. */
  let written = 0;
  await withOutlet(ctx, async function (c) {
    for (const [kind, payload] of ops) {
      await c.query('SAVEPOINT op');
      try {
        await applyOp(c, { kind: kind, payload: payload }, ctx);
        await c.query('RELEASE SAVEPOINT op');
        written++;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT op');
        log('[seed] skipped ' + kind + ': ' + e.message.split('\n')[0]);
      }
    }
  });
  log('[seed] menu    : ' + written + ' of ' + ops.length + ' written');

  const check = await owner().query(
    'SELECT c.gst_registered, c.tin, o.tax_code, o.slug,'
    + " (SELECT count(*)::int FROM chain.tax_version WHERE outlet_id = o.id AND code <> 'NONE') AS rates"
    + ' FROM chain.company c, chain.outlet o WHERE o.id = $1', [out.id]);
  const r = check.rows[0];
  log('[seed] result  : registered=' + r.gst_registered + ' tin=' + (r.tin || '(none)')
    + ' tax_code=' + r.tax_code + ' chargeable-rates=' + r.rates);
  log('[seed] sign in at the till with PIN ' + PIN + '; the store portal is /g/' + r.slug);
  return { seeded: true, outletId: out.id, pin: PIN, handle: r.slug };
}

if (require.main === module) {
  run().then(() => shutdown()).then(() => process.exit(0))
    .catch((e) => {
      console.error('[seed] ' + e.message);               // eslint-disable-line no-console
      process.exit(1);
    });
}

module.exports = { run };
