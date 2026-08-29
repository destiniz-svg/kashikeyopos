'use strict';
/* ═══ ADOPTING AN INSTALL THAT ALREADY EXISTS ════════════════════════════════
   The product used to be sold one INSTALL per customer: a whole app service and
   a Postgres of its own, with its accounts, its outlets and its handles inside
   it. It is now one app, one cluster, a database per business and a registry
   above them. This moves an existing install into that shape.

     node src/scripts/adopt-install.js --db kashikeyo_prod --name "Seaside Cafe"
     node src/scripts/adopt-install.js --db kashikeyo_prod --name "..." --apply

   DRY RUN BY DEFAULT. It prints exactly what it would do and changes nothing
   until --apply. This is the one script in the repo that rewrites primary keys
   on a live customer's data, and a run somebody did not mean is not recoverable
   by running it again.

   ═══ ORDER MATTERS, AND IT MATTERS MOST ════════════════════════════════════
   RUN THIS BEFORE DEPLOYING THE NEW CODE TO THAT INSTALL.

   Migration 011 is now a tombstone: it DROPS chain.account, account_identity
   and account_outlet, because the account plane moved to the registry. If the
   new code boots against an install first, those tables are gone and with them
   the only record of who owns the business. This script copies them out while
   they are still there. It refuses to pretend otherwise: an install whose
   account tables have already been dropped, with nothing in the registry to
   match, is reported as a loss rather than adopted quietly.

   ═══ WHAT AN OUTLET ID COSTS ═══════════════════════════════════════════════
   Every install allocated its outlets from 1, so two installs both have an
   outlet 1 — and a session token names an outlet, which under one registry has
   to resolve to exactly one store anywhere in the estate. The first install
   adopted keeps its ids. A later one whose id is already taken is REMAPPED:
   the row, every reference to it, the schema and the login role.

   The references are discovered from the catalog, not from a list. Two of them
   are not called `outlet_id` at all — chain.member.home_outlet and
   chain.outlet.parent_id — and a list is something somebody has to remember to
   update, which is how a remap silently orphans a customer's members.
   ═══════════════════════════════════════════════════════════════════════════ */

const { control, ownerFor, businessDb, CONTROL_DB } = require('../db');
const { outletPassword } = require('../secrets');

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const APPLY = !!arg('apply');
let plan = [];
const say = (s) => console.log(s);
const step = (s) => { plan.push(s); say((APPLY ? '  · ' : '  would ') + s); };

/* Every column in this database that points at an outlet: the foreign keys,
   whatever they are called, plus chain.audit.outlet_id which deliberately has
   no key (an account event is written with NULL, above every outlet). */
async function outletRefs(db) {
  const q = await db.query(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN unnest(c.conkey) k ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
     WHERE c.contype = 'f' AND c.confrelid = 'chain.outlet'::regclass
    UNION
    SELECT 'chain.' || table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'chain' AND column_name = 'outlet_id'`);
  return q.rows;
}

async function head(db) {
  const q = await db.query("SELECT count(*)::int AS n FROM chain.migration");
  return Number(q.rows[0].n);
}

async function hasTable(db, name) {
  const q = await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name]);
  return q.rows[0].ok;
}

/* ── the account plane, carried out before 011 takes it away ──────────────── */
async function adoptAccounts(db) {
  if (!(await hasTable(db, 'chain.account'))) {
    const known = await control().query('SELECT count(*)::int AS n FROM chain.account');
    say(Number(known.rows[0].n)
      ? '· accounts: already gone from this install; the registry has '
        + known.rows[0].n + ' — assuming a previous run carried them'
      : '· accounts: GONE from this install and the registry is empty.'
        + ' Migration 011 dropped them before they were copied. Nothing here can'
        + ' bring them back; the owner will have to sign up again and be linked'
        + ' to this business by hand.');
    return new Map();
  }

  const rows = await db.query('SELECT * FROM chain.account ORDER BY created_at');
  const map = new Map();
  for (const a of rows.rows) {
    const seen = await control().query(
      'SELECT id FROM chain.account WHERE lower(email) = lower($1)', [a.email]);
    if (seen.rows.length) {
      /* The same person, already in the registry from another install. Their
         credentials there stand: overwriting a password hash with an older
         one would sign them out of an account they are using. */
      map.set(a.id, seen.rows[0].id);
      step('link existing registry account ' + a.email);
      continue;
    }
    step('copy account ' + a.email);
    if (!APPLY) { map.set(a.id, a.id); continue; }
    const made = await control().query(
      'INSERT INTO chain.account (id, email, name, password_hash, password_salt,'
      + ' verified_at, status, created_at, last_seen_at)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)'
      + ' ON CONFLICT (id) DO NOTHING RETURNING id',
      [a.id, a.email, a.name, a.password_hash, a.password_salt,
        a.verified_at, a.status, a.created_at, a.last_seen_at]);
    map.set(a.id, (made.rows[0] || {}).id || a.id);
  }

  if (await hasTable(db, 'chain.account_identity')) {
    const ids = await db.query('SELECT * FROM chain.account_identity');
    for (const i of ids.rows) {
      const to = map.get(i.account_id);
      if (!to) continue;
      step('copy ' + i.provider + ' identity for ' + (i.email || i.subject));
      if (!APPLY) continue;
      await control().query(
        'INSERT INTO chain.account_identity (account_id, provider, subject, email,'
        + ' created_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6)'
        + ' ON CONFLICT (provider, subject) DO NOTHING',
        [to, i.provider, i.subject, i.email, i.created_at, i.last_seen_at]);
    }
  }
  return map;
}

/* ── moving an outlet onto a free id ──────────────────────────────────────── */
async function remapOutlet(db, from, to) {
  const refs = await outletRefs(db);
  step('REMAP outlet ' + from + ' -> ' + to + ' (' + refs.length
    + ' references, schema and login role)');
  if (!APPLY) return;

  const c = await db.connect();
  try {
    await c.query('BEGIN');

    /* The foreign keys are ON UPDATE NO ACTION, so the parent id cannot simply
       be updated while children point at it — and copying the row instead
       collides with chain.outlet's UNIQUE code. So the keys come off, the id
       moves, and they go back on FROM THEIR OWN DEFINITIONS: pg_get_constraintdef
       replays exactly what was there, including anything a later migration
       added that nobody writing this remembered. */
    const keys = await c.query(`
      SELECT c.conname, c.conrelid::regclass::text AS tbl,
             pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
       WHERE c.contype = 'f' AND c.confrelid = 'chain.outlet'::regclass`);
    for (const k of keys.rows) {
      await c.query('ALTER TABLE ' + k.tbl + ' DROP CONSTRAINT ' + quote(k.conname));
    }

    await c.query('UPDATE chain.outlet SET id = $2 WHERE id = $1', [from, to]);
    for (const r of refs) {
      if (r.tbl === 'chain.outlet' && r.col === 'id') continue;
      await c.query('UPDATE ' + r.tbl + ' SET ' + r.col + ' = $2 WHERE ' + r.col + ' = $1',
        [from, to]);
    }

    for (const k of keys.rows) {
      await c.query('ALTER TABLE ' + k.tbl + ' ADD CONSTRAINT ' + quote(k.conname)
        + ' ' + k.def);
    }

    await c.query('ALTER SCHEMA outlet_' + from + ' RENAME TO outlet_' + to);
    await c.query('ALTER ROLE outlet_' + from + '_app RENAME TO outlet_' + to + '_app');
    /* The password is DERIVED from the id, so moving the id moves the password.
       Renaming a role can invalidate what was stored, which is why it is set
       again explicitly rather than assumed to have followed. */
    await c.query('ALTER ROLE outlet_' + to + '_app PASSWORD '
      + literal(outletPassword(to)));
    await c.query('ALTER ROLE outlet_' + to + '_app SET search_path = outlet_'
      + to + ', chain, public');
    await c.query('UPDATE chain.outlet SET schema_name = $2 WHERE id = $1',
      [to, 'outlet_' + to]);

    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

/* An id the REGISTRY has not handed out, whose schema is free in this database
   and whose login role is free in the CLUSTER. The sequence answers the first;
   it cannot answer the other two, because a role is cluster-wide and a schema
   belongs to the database being adopted — and colliding with either is how a
   remap half-completes and leaves a store unable to sign in. Bounded, because
   a search that cannot end is worse than a refusal that names the problem. */
async function freeId(db) {
  for (let tries = 0; tries < 200; tries++) {
    const next = await control().query("SELECT nextval('chain.outlet_id_seq')::int AS n");
    const id = Number(next.rows[0].n);
    const clash = await db.query(
      'SELECT (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS sch,'
      + ' (SELECT 1 FROM pg_roles WHERE rolname = $2) AS rol',
      ['outlet_' + id, 'outlet_' + id + '_app']);
    if (!clash.rows[0].sch && !clash.rows[0].rol) return id;
    say('  (outlet id ' + id + ' is spoken for by a schema or a role; trying the next)');
  }
  throw new Error('could not find a free outlet id in 200 tries — something else'
    + ' is allocating them');
}

// Identifiers and literals, because neither can be parameterised and both come
// from the catalog or from a derived secret rather than from a caller.
function quote(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }
function literal(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

async function main() {
  const dbName = arg('db');
  const name = arg('name');
  if (!dbName || dbName === true || !name || name === true) {
    console.error('usage: adopt-install.js --db <database> --name "<Business>" [--apply]');
    process.exit(2);
  }
  if (!CONTROL_DB()) {
    console.error('CONTROL_DB is not set — the registry has to be named, never guessed');
    process.exit(2);
  }
  /* And the registry is not an install to adopt. Registering it as a business
     hands it to the fleet migration, which runs the BUSINESS set over it —
     whose 011 is a tombstone that drops chain.account. See refuseRegistry() in
     src/business.js: same refusal, the other door. Refused before the dry run
     prints, because a dry run that describes this plan is a plan somebody
     will then run with --apply. */
  if (dbName === CONTROL_DB()) {
    console.error('refusing: ' + dbName + ' is this install\'s REGISTRY, not a'
      + ' business. Adopting it would let the fleet migrate it with the'
      + ' business set, whose migration 011 drops chain.account — every'
      + ' account on the install, gone.');
    process.exit(2);
  }

  say(APPLY ? '=== ADOPTING ' + dbName + ' ===' : '=== DRY RUN for ' + dbName
    + ' (nothing will change; add --apply) ===');

  const db = ownerFor(dbName);
  const at = await head(db);
  say('· schema: ' + at + ' migrations applied');

  /* An install already carrying the tombstone has lost its accounts unless a
     previous run took them. Said before anything is written. */
  const accounts = await adoptAccounts(db);

  // ── the business row ──────────────────────────────────────────────────────
  let biz = await control().query('SELECT * FROM chain.business WHERE db_name = $1', [dbName]);
  let businessId;
  if (biz.rows.length) {
    businessId = biz.rows[0].id;
    say('· business: already registered as ' + businessId);
  } else {
    step('register business "' + name + '" -> ' + dbName + ' at schema ' + at);
    if (APPLY) {
      const made = await control().query(
        "INSERT INTO chain.business (name, db_name, status, schema_version, live_at)"
        + " VALUES ($1,$2,'live',$3,now()) RETURNING id", [name, dbName, at]);
      businessId = Number(made.rows[0].id);
    } else { businessId = -1; }
  }

  /* An adopted install keeps its own database name, which is almost never the
     kashikeyo_biz_<id> the registry would have chosen. That is fine and worth
     saying: db_name is the routing answer, and nothing derives it. */
  if (APPLY && dbName !== businessDb(businessId)) {
    say('  (keeps its own name; the registry routes by db_name, never by a rule)');
  }

  // ── the outlets ───────────────────────────────────────────────────────────
  const outlets = await db.query(
    'SELECT id, code, name, slug, active FROM chain.outlet ORDER BY id');
  for (const o of outlets.rows) {
    const taken = await control().query(
      'SELECT business_id FROM chain.outlet_directory WHERE outlet_id = $1', [o.id]);
    let id = o.id;

    if (taken.rows.length && Number(taken.rows[0].business_id) !== businessId) {
      id = await freeId(db);
      await remapOutlet(db, o.id, id);
    } else if (!taken.rows.length) {
      step('register outlet ' + o.id + ' (' + o.code + ') under business ' + businessId);
      if (APPLY) {
        await control().query(
          'INSERT INTO chain.outlet_directory (outlet_id, business_id, name, active)'
          + ' VALUES ($1,$2,$3,$4) ON CONFLICT (outlet_id) DO NOTHING',
          [id, businessId, o.name || '', o.active]);
        // Never hand the same id out again.
        await control().query(
          "SELECT setval('chain.outlet_id_seq', greatest(nextval('chain.outlet_id_seq'), $1))",
          [id]);
      }
    } else {
      say('· outlet ' + o.id + ' already registered here');
    }

    if (APPLY && id !== o.id) {
      await control().query(
        'INSERT INTO chain.outlet_directory (outlet_id, business_id, name, active)'
        + ' VALUES ($1,$2,$3,$4) ON CONFLICT (outlet_id) DO NOTHING',
        [id, businessId, o.name || '', o.active]);
    }

    // ── the handle ──────────────────────────────────────────────────────────
    if (o.slug) {
      const why = await control().query('SELECT chain.handle_why($1,$2) AS w', [o.slug, id]);
      if (why.rows[0].w) {
        /* NEVER quietly renamed. They printed it on their table cards; a
           handle taken by somebody else is a conversation, not a fixup. */
        say('  ! handle "' + o.slug + '" cannot be claimed: ' + why.rows[0].w);
        say('    Resolve it before this store goes live — its QR codes point here.');
      } else {
        step('claim handle "' + o.slug + '" for outlet ' + id);
        if (APPLY) {
          await control().query('SELECT chain.claim_handle($1,$2,$3)',
            [id, businessId, o.slug]);
          if (id !== o.id) {
            await db.query('UPDATE chain.outlet SET slug = $2 WHERE id = $1', [id, o.slug]);
          }
        }
      }
    }

    // Retired addresses come too: a card printed years ago still has to land.
    if (await hasTable(db, 'chain.outlet_handle_history')) {
      const past = await db.query(
        'SELECT handle, retired_at FROM chain.outlet_handle_history WHERE outlet_id = $1',
        [id]);
      for (const p of past.rows) {
        step('carry retired address "' + p.handle + '"');
        if (APPLY) {
          await control().query(
            'INSERT INTO chain.handle_history (name, outlet_id, business_id, retired_at)'
            + ' VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING',
            [p.handle, id, businessId, p.retired_at]);
        }
      }
    }
  }

  // ── who owns it ───────────────────────────────────────────────────────────
  if (await hasTable(db, 'chain.account_outlet')) {
    const owners = await db.query(
      "SELECT DISTINCT account_id, role FROM chain.account_outlet WHERE role = 'owner'");
    for (const ow of owners.rows) {
      const to = accounts.get(ow.account_id) || ow.account_id;
      step('record owner ' + to + ' of business ' + businessId);
      if (APPLY) {
        await control().query(
          "INSERT INTO chain.account_business (account_id, business_id, role)"
          + " VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING", [to, businessId]);
      }
    }
  }

  say(APPLY
    ? '=== done. ' + plan.length + ' change(s). Deploy the new code to this'
      + ' install now: its next boot migrates the business set, and 011 drops'
      + ' the account tables this run has already carried out. ==='
    : '=== dry run: ' + plan.length + ' change(s) would be made. Re-run with'
      + ' --apply, THEN deploy. ===');
}

if (require.main === module) {
  main()
    .then(() => require('../db').shutdown())
    .then(() => process.exit(0))
    .catch(async (e) => {
      console.error('[adopt] failed: ' + e.message);
      await require('../db').shutdown().catch(() => {});
      process.exit(1);
    });
}

module.exports = { outletRefs, remapOutlet, _main: main };
