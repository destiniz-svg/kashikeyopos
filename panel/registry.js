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
const { headCount } = require('../src/scripts/migrate');

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

/* Fourteen days, in the outlet's OWN timezone. A business date is the outlet's
   local date — that is the whole point of migration 016 — so a seller's
   dashboard computing days in UTC would disagree with the owner's own Today
   screen by a third of every day's takings. */
async function takings(o, outlets) {
  if (!outlets.length) return [];
  const tz = outlets[0].tz || 'Indian/Maldives';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const today = fmt.format(new Date());
  /* ONE GROUPED QUERY PER OUTLET, never one per day. The first version asked
     each outlet fourteen separate questions, so a dashboard over a real fleet
     paid 14 × outlets × businesses round-trips on every load — measured at
     19 s across this dev cluster's 63 businesses. The database groups by day
     in one pass. */
  const byDate = {};
  for (const out of outlets) {
    try {
      const q = await o.query(
        'SELECT business_date::text AS date, coalesce(sum(net),0)::numeric AS net,'
        + ' coalesce(sum(covers),0)::int AS covers, count(*)::int AS tickets'
        + ' FROM outlet_' + Number(out.id) + '.sale'
        + ' WHERE business_date >= $1::date - 13 AND voided_at IS NULL'
        + ' GROUP BY business_date', [today]);
      for (const r of q.rows) {
        const d = byDate[r.date] || (byDate[r.date] = { net: 0, covers: 0, tickets: 0 });
        d.net += Number(r.net); d.covers += r.covers; d.tickets += r.tickets;
      }
    } catch (e) { /* an outlet whose schema is mid-migration contributes 0 */ }
  }
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = fmt.format(new Date(Date.now() - i * 86400e3));
    const r = byDate[d] || { net: 0, covers: 0, tickets: 0 };
    days.push({ date: d, net: r2(r.net), covers: r.covers, tickets: r.tickets });
  }
  return days;
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

/* ── THE USAGE REPORT, OUTLET BY OUTLET ─────────────────────────────────────
   The dashboard card sums a business into one line, which is right for a
   glance and useless for the conversation a seller actually has — "your Malé
   store is carrying the whole chain" is an OUTLET sentence. This is the
   drill-in: for each active outlet, the trading windows a vendor report
   normally carries (today, last 7, last 30, this month, last month), a daily
   series, the device health, and how much the QR portal is being used.

   STILL AGGREGATES ONLY. Sums, counts and averages per outlet per day — never
   a member, never a staff row, never a line item — and the read lands on the
   business's own trail like every other look the seller takes.

   Every window is computed in the OUTLET'S OWN timezone from its own
   `business_date`, the same figure the owner's Today screen reads; a seller's
   report computed in UTC would disagree with the customer it is about by a
   third of every day's takings. */
function monthKey(dateStr) { return String(dateStr).slice(0, 7); }
function prevMonthKey(dateStr) {
  const y = Number(dateStr.slice(0, 4)); const m = Number(dateStr.slice(5, 7));
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
}
function windowOf(rows, from, to) {
  const w = { net: 0, tickets: 0, covers: 0 };
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    w.net += Number(r.net); w.tickets += r.tickets; w.covers += r.covers;
  }
  w.net = r2(w.net);
  w.avgTicket = w.tickets ? r2(w.net / w.tickets) : 0;
  return w;
}

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

  const co = await o.query('SELECT legal_name, base_currency FROM chain.company LIMIT 1');
  out.company = co.rows.length ? co.rows[0].legal_name : null;
  out.currency = co.rows.length ? co.rows[0].base_currency : '';
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
    const today = fmt.format(new Date());
    const dayAgo = (n) => fmt.format(new Date(Date.now() - n * 86400e3));
    let rows = []; let qr30 = 0;
    try {
      /* Two months of daily aggregates in one grouped query — never a row per
         sale — so last month is complete however long it was. */
      const d = await o.query(
        'SELECT business_date::text AS date, coalesce(sum(net),0)::numeric AS net,'
        + ' count(*)::int AS tickets, coalesce(sum(covers),0)::int AS covers'
        + ' FROM outlet_' + Number(ot.id) + '.sale'
        + ' WHERE voided_at IS NULL AND business_date >= $1::date - 62'
        + ' GROUP BY business_date ORDER BY business_date', [today]);
      rows = d.rows.map((r) => ({ date: r.date, net: r2(r.net),
        tickets: r.tickets, covers: r.covers }));
      const g = await o.query(
        'SELECT count(*)::int AS n FROM outlet_' + Number(ot.id) + '.guest_order'
        + " WHERE at > now() - interval '30 days'");
      qr30 = g.rows[0].n;
    } catch (e) { /* an outlet whose schema is mid-migration reports zeros */ }

    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const dte = dayAgo(i);
      const r = byDate[dte];
      days.push({ date: dte, net: r ? r.net : 0, tickets: r ? r.tickets : 0,
        covers: r ? r.covers : 0 });
    }
    const mk = monthKey(today); const pk = prevMonthKey(today);
    out.outlets.push({
      id: Number(ot.id), name: ot.name, slug: ot.slug, tz: tz,
      today: windowOf(rows, today, today),
      last7: windowOf(rows, dayAgo(6), today),
      last30: windowOf(rows, dayAgo(29), today),
      thisMonth: windowOf(rows, mk + '-01', mk + '-31'),
      lastMonth: windowOf(rows, pk + '-01', pk + '-31'),
      days: days,
      qrOrders30: qr30,
      devices: devOf[Number(ot.id)]
        ? { writers: devOf[Number(ot.id)].writers, quiet: devOf[Number(ot.id)].quiet,
          lastPush: devOf[Number(ot.id)].last_push }
        : { writers: 0, quiet: 0, lastPush: null }
    });
  }

  if (outlets.rows.length) {
    // A seller looking in is never invisible — same trail as the card read.
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
  readLicence, differs, usage, readBackupShelf };
