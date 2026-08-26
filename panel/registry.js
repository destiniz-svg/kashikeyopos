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

   THE PANEL STILL TOUCHES NOTHING IT DOES NOT NEED. It reads company name,
   outlet list, device staleness, fourteen days of takings and the licence —
   the same aggregates the platform door served and no more. Never a member,
   never a staff row, never a line item. What changed is the transport, not
   the promise.

   AND EVERY READ IS ON THAT BUSINESS'S OWN TRAIL, exactly as the platform
   door's were: a seller looking in is never invisible.
   ═══════════════════════════════════════════════════════════════════════ */

const { control, ownerFor, CONTROL_DB } = require('../src/db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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
    out.days = await takings(o, outlets.rows);

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

/* Fourteen days, in the outlet's OWN timezone. A business date is the outlet's
   local date — that is the whole point of migration 016 — so a seller's
   dashboard computing days in UTC would disagree with the owner's own Today
   screen by a third of every day's takings. */
async function takings(o, outlets) {
  if (!outlets.length) return [];
  const tz = outlets[0].tz || 'Indian/Maldives';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = fmt.format(new Date(Date.now() - i * 86400e3));
    let net = 0; let covers = 0; let tickets = 0;
    for (const out of outlets) {
      try {
        const q = await o.query(
          'SELECT coalesce(sum(net),0)::numeric AS net,'
          + ' coalesce(sum(covers),0)::int AS covers,'
          + ' count(*)::int AS tickets'
          + ' FROM outlet_' + Number(out.id) + '.sale'
          + ' WHERE business_date = $1 AND voided_at IS NULL', [d]);
        net += Number(q.rows[0].net || 0);
        covers += Number(q.rows[0].covers || 0);
        tickets += Number(q.rows[0].tickets || 0);
      } catch (e) { /* an outlet whose schema is mid-migration contributes 0 */ }
    }
    days.push({ date: d, net: r2(net), covers: covers, tickets: tickets });
  }
  return days;
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
  readLicence, differs };
