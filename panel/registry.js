'use strict';
/* ═══ WHAT THE SELLER SEES, READ FROM THE REGISTRY ═══════════════════════════
   Mission Control was built for a product sold ONE INSTALL PER CUSTOMER: each
   customer had their own app service and their own database, the seller could
   not reach either, and so the panel learned everything by calling each
   install's `/api/platform/summary` over HTTPS with a per-install
   PLATFORM_KEY.

   That premise is gone. One app now serves every customer, one Postgres
   cluster holds a database per business, and the panel runs beside them —
   `chain.business` in the registry IS the customer list. Probing over HTTP for
   figures that are one query away is not merely redundant; it is a control
   describing a world that no longer exists, which is the defect class this
   codebase has spent months removing.

   So: read the registry, and each business's own database, directly.

   THE PANEL IS THE DEVELOPER'S, AND IT READS SYSTEM DATA ONLY. Company name,
   outlet list, device sync health, sync-op traffic, database size, schema
   state, the backup shelf and the licence — never a sales figure, never a
   member, never a staff row, never a line item. A customer's takings are
   reported by their own back office to the people entitled to read them.

   AND EVERY READ IS ON THAT BUSINESS'S OWN TRAIL, exactly as the platform
   door's were: a seller looking in is never invisible.
   ═══════════════════════════════════════════════════════════════════════ */

const { control, ownerFor, CONTROL_DB } = require('../src/db');
const { headCount } = require('../src/scripts/migrate');

/* Is this panel beside a registry, or is it the old remote-install panel? The
   answer decides which half of this service is real, so it is asked once and
   answered honestly rather than inferred from whether a query happened to
   work. */
function registryMode() {
  return !!CONTROL_DB();
}

/* One business's figures. Everything is best-effort per business: a customer
   whose database cannot be opened is REPORTED as unreachable with the reason,
   never silently dropped and never allowed to fail the whole dashboard. That
   is the same rule /readyz keeps — one customer down and named beats a page
   that shows nothing. */
async function readBusiness(b) {
  const out = {
    id: b.id, name: b.name, db: b.db_name, status: b.status,
    schemaVersion: Number(b.schema_version || 0),
    buildState: b.build_state || null,
    createdAt: b.created_at, liveAt: b.live_at || null
  };
  if (b.status !== 'live') {
    out.state = b.status === 'failed' ? 'failed' : 'building';
    out.note = b.build_state || null;
    return out;
  }
  let o;
  try {
    o = ownerFor(b.db_name);
    await o.query('SELECT 1');
  } catch (e) {
    out.state = 'unreachable';
    out.note = e.message;
    return out;
  }
  try {
    const co = await o.query(
      'SELECT legal_name, gst_registered, base_currency FROM chain.company LIMIT 1');
    const outlets = await o.query(
      'SELECT id, name, slug, tz, currency FROM chain.outlet WHERE active ORDER BY id');
    /* Writers only. Printers and displays never push, so their silence is not
       a health signal — the same rule the Sync ribbon and the watchdog keep,
       and it has to be the same rule or two screens disagree about one shop. */
    const dev = await o.query(
      'SELECT count(*)::int AS writers,'
      + " count(*) FILTER (WHERE last_push_at IS NULL"
      + "   OR last_push_at < now() - interval '1 hour')::int AS quiet"
      + ' FROM chain.device'
      + ' WHERE NOT revoked AND paired_at IS NOT NULL'
      + "   AND kind NOT IN ('printer','display')");

    out.state = 'live';
    out.company = co.rows.length ? {
      name: co.rows[0].legal_name,
      gstRegistered: co.rows[0].gst_registered !== false,
      currency: co.rows[0].base_currency
    } : null;
    out.outlets = outlets.rows;
    out.devices = dev.rows[0];
    out.licence = await readLicence(o);
    out.planRequest = await readPlanRequest(o);
    /* SYSTEM DATA, NEVER TRADE. This panel is the developer's, and a
       customer's takings are the customer's — their own back office reports
       them to the people entitled to read them. What an operator needs is
       TRAFFIC and HEALTH: how many writes the sync lane carried, how big the
       database is, whether anybody is signed in. */
    out.days = await syncTraffic(o, outlets.rows);
    out.dbBytes = await dbSize(o);
    out.sessions = await sessionsActive(o);
    /* A business BEHIND SCHEMA HEAD is one whose requests requireAtHead() is
       refusing by name — a customer down that nobody outside the shop would
       otherwise see. The head is the count of business migration files, the
       same figure the fleet runner compares against. */
    out.schemaHead = headCount();
    out.behind = out.schemaVersion < out.schemaHead;
    out.backup = await readBackupShelf(b.id);

    if (outlets.rows.length) {
      // On the trail, in the first outlet's log, like every other cross-outlet
      // read. A seller looking in is never invisible.
      await o.query(
        'INSERT INTO chain.audit (outlet_id, action, entity, after, scope)'
        + " VALUES ($1,'platform_read','business',$2,'group')",
        [outlets.rows[0].id, JSON.stringify({ via: 'registry', days: out.days.length })])
        .catch(() => {});
    }
  } catch (e) {
    out.state = 'unreachable';
    out.note = e.message;
  }
  return out;
}

/* THE TRAFFIC SERIES IS SYNC OPS, NOT SALES. Every write a till makes goes
   through one seam and lands in op_log, so ops-per-day is the honest measure
   of how hard a business is using the system — and it says nothing about
   money, which is not this panel's to read. Bucketed by day in the outlet's
   own timezone; one grouped query per outlet, never one per day (the money
   version of this loop once cost 19 s across 63 businesses). op_log is a
   90-day replay window, which more than covers a 14-day series. */
async function syncTraffic(o, outlets) {
  if (!outlets.length) return [];
  const tz = outlets[0].tz || 'Indian/Maldives';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const byDate = {};
  for (const out of outlets) {
    try {
      const q = await o.query(
        'SELECT (applied_at AT TIME ZONE $1)::date::text AS date, count(*)::int AS ops'
        + ' FROM outlet_' + Number(out.id) + '.op_log'
        + " WHERE applied_at > now() - interval '15 days'"
        + ' GROUP BY 1', [tz]);
      for (const r of q.rows) byDate[r.date] = (byDate[r.date] || 0) + r.ops;
    } catch (e) { /* an outlet whose schema is mid-migration contributes 0 */ }
  }
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = fmt.format(new Date(Date.now() - i * 86400e3));
    days.push({ date: d, ops: byDate[d] || 0 });
  }
  return days;
}

async function dbSize(o) {
  try {
    const q = await o.query('SELECT pg_database_size(current_database())::bigint AS b');
    return Number(q.rows[0].b);
  } catch (e) { return null; }
}

async function sessionsActive(o) {
  try {
    const q = await o.query('SELECT count(*)::int AS n FROM chain.session'
      + ' WHERE revoked_at IS NULL AND expires_at > now()');
    return q.rows[0].n;
  } catch (e) { return null; }
}

/* THE APP'S OWN HEALTH, asked the way the platform asks it. /readyz checks
   out every outlet's login role against its own schema, so its answer — and
   how long it took — is the one line an operator wants at the top of the
   page. A failure carries the endpoint's own body, which names the failing
   outlet and the remedy. */
async function appHealth(baseUrl) {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  if (!url) return { ok: false, reason: 'APP_URL is not set on this panel' };
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(url + '/readyz', { signal: ctl.signal });
    clearTimeout(timer);
    const body = await r.text().catch(() => '');
    return { ok: r.status === 200, status: r.status, ms: Date.now() - t0,
      detail: r.status === 200 ? null : body.slice(0, 400) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.message };
  }
}

/* ── the backup shelf, read from the REGISTRY ───────────────────────────────
   chain.backup lives in the control database (control/004) precisely so it is
   readable when the business database is not — and so "which customers did
   last night's run miss" is answerable at all. The seller's card carries the
   two facts that matter: when the last GOOD copy finished, and whether the
   most recent run failed. No shelf rows at all is a stated state, not an
   alarm: an install with no destination configured takes no copies and says
   so on its own boot line. */
async function readBackupShelf(businessId) {
  try {
    const good = await control().query(
      'SELECT finished_at, bytes FROM chain.backup'
      + ' WHERE business_id = $1 AND ok AND finished_at IS NOT NULL'
      + ' ORDER BY finished_at DESC LIMIT 1', [businessId]);
    const last = await control().query(
      'SELECT ok, started_at, why FROM chain.backup'
      + ' WHERE business_id = $1 ORDER BY started_at DESC LIMIT 1', [businessId]);
    if (!last.rows.length) return null;
    const g = good.rows[0] || null;
    return {
      lastGoodAt: g ? g.finished_at : null,
      ageHours: g ? Math.floor((Date.now() - new Date(g.finished_at).getTime()) / 3600e3) : null,
      bytes: g ? Number(g.bytes || 0) : null,
      lastOk: last.rows[0].ok === true,
      lastWhy: last.rows[0].ok ? null : (last.rows[0].why || null)
    };
  } catch (e) { return null; }
}

async function readLicence(o) {
  try {
    const q = await o.query('SELECT kind, trial_ends, note FROM chain.licence WHERE id = 1');
    if (!q.rows.length) return null;
    return { kind: q.rows[0].kind,
      trialEnds: q.rows[0].trial_ends ? String(q.rows[0].trial_ends).slice(0, 10) : null,
      note: q.rows[0].note || '' };
  } catch (e) { return null; }
}

async function readPlanRequest(o) {
  try {
    const q = await o.query("SELECT value FROM chain.setting WHERE key = 'plan_request'");
    if (!q.rows.length) return null;
    const x = q.rows[0].value || {};
    if (!x.at) return null;
    return { at: x.at, by: x.by || null, want: x.want || null, note: x.note || '' };
  } catch (e) { return null; }
}

/* ── writing the licence ────────────────────────────────────────────────────
   THIS REGISTRY IS AUTHORITATIVE about what a customer is on, and the business
   database holds a copy so the till can render its countdown without reaching
   out to anything. That was pushed over HTTP because there was no other way to
   reach it. There is now: the panel opens that database.

   `chain.licence` is granted SELECT to outlet roles and INSERT/UPDATE to none
   at all (migration 033) — a licence a customer can edit is a text field, not
   a licence — so this write goes through the owner connection, which is the
   only writer the design has ever had.

   Idempotent by construction: it writes only when something actually differs,
   so reconciling on every dashboard load costs a comparison and never a row.
   The install's own trail records the change, not the check. */
function differs(want, got) {
  if (!got) return true;
  return got.kind !== want.kind
    || (got.trialEnds || null) !== (want.trialEnds || null)
    || (got.note || '') !== (want.note || '');
}

async function writeLicence(dbName, want) {
  const o = ownerFor(dbName);
  const got = await readLicence(o);
  if (!differs(want, got)) return { pushed: false, same: true };
  await o.query(
    'INSERT INTO chain.licence (id, kind, trial_ends, note, set_at, set_by)'
    + " VALUES (1,$1,$2,$3,now(),'panel')"
    + ' ON CONFLICT (id) DO UPDATE SET kind = $1, trial_ends = $2, note = $3,'
    + " set_at = now(), set_by = 'panel'",
    [want.kind, want.trialEnds || null, want.note || '']);
  await o.query(
    'INSERT INTO chain.audit (outlet_id, action, entity, after, scope)'
    + " VALUES (NULL,'licence_set','licence',$1,'group')",
    [JSON.stringify(want)]).catch(() => {});
  return { pushed: true };
}

/* ── THE SYSTEM REPORT, OUTLET BY OUTLET ────────────────────────────────────
   This panel is the DEVELOPER'S, and a customer's takings are the customer's:
   their own back office reports money to the people entitled to read it, and
   this report deliberately reads none. What an operator drills into is the
   SYSTEM: how many writes the sync lane carried and when (op_log — every
   till write goes through that one seam), how much of it arrived through the
   QR portal, whether the devices that owe pushes are pushing, how big the
   database has grown, and whether anybody is signed in.

   Counts of system events only — never a sale figure, never a member, never
   a staff row, never a line item — and the read still lands on the
   business's own trail: a developer looking in is never invisible either. */
async function usage(businessId) {
  const q = await control().query(
    'SELECT id, name, db_name, status FROM chain.business WHERE id = $1', [businessId]);
  if (!q.rows.length) return null;
  const b = q.rows[0];
  const out = { id: Number(b.id), name: b.name, db: b.db_name, state: b.status };
  if (b.status !== 'live') return out;
  let o;
  try { o = ownerFor(b.db_name); await o.query('SELECT 1'); }
  catch (e) { out.state = 'unreachable'; out.note = e.message; return out; }

  const co = await o.query('SELECT legal_name FROM chain.company LIMIT 1');
  out.company = co.rows.length ? co.rows[0].legal_name : null;
  out.dbBytes = await dbSize(o);
  out.sessions = await sessionsActive(o);
  const outlets = await o.query(
    'SELECT id, name, slug, tz FROM chain.outlet WHERE active ORDER BY id');

  const dev = await o.query(
    'SELECT outlet_id, count(*)::int AS writers,'
    + " count(*) FILTER (WHERE last_push_at IS NULL"
    + "   OR last_push_at < now() - interval '1 hour')::int AS quiet,"
    + ' max(last_push_at) AS last_push'
    + ' FROM chain.device WHERE NOT revoked AND paired_at IS NOT NULL'
    + " AND kind NOT IN ('printer','display') GROUP BY outlet_id");
  const devOf = Object.fromEntries(dev.rows.map((r) => [Number(r.outlet_id), r]));

  out.outlets = [];
  for (const ot of outlets.rows) {
    const tz = ot.tz || 'Indian/Maldives';
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const dayAgo = (n) => fmt.format(new Date(Date.now() - n * 86400e3));
    let opsByDate = {}; let qrByDate = {}; let ops24 = 0; let qr24 = 0;
    try {
      /* One grouped query per table — 30 days of op traffic bucketed on the
         outlet's own clock, and the last 24 hours as its own figure because
         "today so far" and "yesterday's total" answer different questions. */
      const d = await o.query(
        'SELECT (applied_at AT TIME ZONE $1)::date::text AS date, count(*)::int AS n'
        + ' FROM outlet_' + Number(ot.id) + '.op_log'
        + " WHERE applied_at > now() - interval '31 days' GROUP BY 1", [tz]);
      d.rows.forEach((r) => { opsByDate[r.date] = r.n; });
      const h = await o.query(
        'SELECT count(*)::int AS n FROM outlet_' + Number(ot.id) + '.op_log'
        + " WHERE applied_at > now() - interval '24 hours'");
      ops24 = h.rows[0].n;
      const g = await o.query(
        'SELECT (at AT TIME ZONE $1)::date::text AS date, count(*)::int AS n'
        + ' FROM outlet_' + Number(ot.id) + '.guest_order'
        + " WHERE at > now() - interval '31 days' GROUP BY 1", [tz]);
      g.rows.forEach((r) => { qrByDate[r.date] = r.n; });
      const gh = await o.query(
        'SELECT count(*)::int AS n FROM outlet_' + Number(ot.id) + '.guest_order'
        + " WHERE at > now() - interval '24 hours'");
      qr24 = gh.rows[0].n;
    } catch (e) { /* an outlet whose schema is mid-migration reports zeros */ }

    const days = []; let ops7 = 0; let ops30 = 0; let qr30 = 0;
    for (let i = 29; i >= 0; i--) {
      const dte = dayAgo(i);
      const ops = opsByDate[dte] || 0; const qr = qrByDate[dte] || 0;
      days.push({ date: dte, ops: ops, qr: qr });
      ops30 += ops; qr30 += qr;
      if (i <= 6) ops7 += ops;
    }
    out.outlets.push({
      id: Number(ot.id), name: ot.name, slug: ot.slug, tz: tz,
      ops24h: ops24, ops7d: ops7, ops30d: ops30,
      qr24h: qr24, qrOrders30: qr30,
      days: days,
      devices: devOf[Number(ot.id)]
        ? { writers: devOf[Number(ot.id)].writers, quiet: devOf[Number(ot.id)].quiet,
          lastPush: devOf[Number(ot.id)].last_push }
        : { writers: 0, quiet: 0, lastPush: null }
    });
  }

  if (outlets.rows.length) {
    // A developer looking in is never invisible — same trail as the card read.
    await o.query(
      'INSERT INTO chain.audit (outlet_id, action, entity, after, scope)'
      + " VALUES ($1,'platform_read','usage',$2,'group')",
      [outlets.rows[0].id, JSON.stringify({ via: 'registry', outlets: out.outlets.length })])
      .catch(() => {});
  }
  return out;
}

/* Every customer, newest first. `status` is the registry's own vocabulary —
   building, live, failed, suspended — and it is rendered as itself rather than
   collapsed into "ok / not ok", because those four need four different
   actions. */
async function overview() {
  const q = await control().query(
    'SELECT id, name, db_name, status, schema_version, build_state, created_at, live_at'
    + ' FROM chain.business ORDER BY id DESC');
  return Promise.all(q.rows.map(readBusiness));
}

module.exports = { registryMode, overview, readBusiness, writeLicence,
  readLicence, differs, usage, readBackupShelf, appHealth };
