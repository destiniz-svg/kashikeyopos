'use strict';
/* Settings, access and the audit log — 02-POS-SPEC §2 (`settings`, `users`,
 * `logs`), 08-BUILD-STAGES §29.
 *
 * Three screens, one file, because they are one subject: what this outlet is
 * configured to do, who is currently able to do it, and what has been done.
 * Splitting them would put the trail in a different module from the acts it
 * records.
 *
 * WHAT IS DELIBERATELY NOT HERE: rank assignment. It lives on the Staff screen
 * and has since that module was built, complete with the rule that nobody may
 * create or promote above their own rank. A second editor for the same column
 * is how the two come to disagree about what a rank means — this project has
 * already paid for that lesson with five copies of a chart of accounts and four
 * spellings of one table name. Users & Roles shows the rank picture, links to
 * the one place it is changed, and adds the thing Staff genuinely cannot do:
 * end a session that is open right now.
 */

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** A `date` column as an ISO day.
 *
 *  `pg` hands back a JavaScript Date for a `date`, and `String(aDate)` is
 *  "Wed Jan 01 2020 …" — so slicing ten characters off it gives "Wed Jan 01",
 *  which compares against an ISO day as pure noise. It read as "no rate is in
 *  force" on an outlet that had been charging GST since 2020. */
const isoDay = (d) => (d instanceof Date
  ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10)
  : String(d ?? '').slice(0, 10));
const RANKS = ['—', 'Kitchen', 'Till', 'Manager', 'Admin', 'Owner'];

/* ── settings ────────────────────────────────────────────────────────────── */

async function settings(c, outletId) {
  const [o, tax] = await Promise.all([
    c.query('SELECT id, code, name, currency, tz, service_pct, cash_round_laari,'
      + ' tables, active, created_at FROM chain.outlet WHERE id = $1', [outletId]),
    /* Every version, not just the live one. A rate change is a dated fact and
       the screen that sets one has to show what it is changing FROM and when —
       "8% from 2020" beside "16% from next month" is the whole story, and a
       screen showing only the current rate invites somebody to set it twice. */
    c.query('SELECT code, rate, effective_from, effective_to FROM chain.tax_version'
      + ' WHERE outlet_id = $1 ORDER BY effective_from DESC, code', [outletId]),
  ]);
  if (!o.rows.length) throw Object.assign(new Error('no such outlet'), { status: 404 });
  const r = o.rows[0];
  const today = new Date().toISOString().slice(0, 10);
  const versions = tax.rows.map((v) => ({
    code: v.code, rate: Number(v.rate),
    from: isoDay(v.effective_from), to: v.effective_to ? isoDay(v.effective_to) : null,
    /* Live TODAY, which is not the same as "the newest row" — a rate scheduled
       for next month is real, recorded, and not yet charging anybody. */
    live: isoDay(v.effective_from) <= today
      && (!v.effective_to || isoDay(v.effective_to) >= today),
    scheduled: isoDay(v.effective_from) > today,
  }));
  return {
    outlet: {
      id: r.id, code: r.code, name: r.name, currency: r.currency, tz: r.tz,
      servicePct: Number(r.service_pct),
      cashRoundLaari: r.cash_round_laari,
      tables: r.tables, active: r.active, createdAt: r.created_at,
    },
    tax: versions,
    /* Said rather than left to the screen: the four columns nobody can change
       from inside the application, and why. */
    fixed: {
      fields: ['id', 'code', 'schema_name', 'db_role'],
      why: 'An outlet\'s id, code, schema and database role are the tenancy '
        + 'model itself — the connection every request is made on is resolved '
        + 'through them. They are set when the outlet is provisioned and no '
        + 'grant in this application can write them.',
    },
  };
}

async function setSettings(c, body, ctx) {
  const name = String(body.name ?? '').trim();
  const tz = String(body.tz ?? '').trim();
  const service = Number(body.servicePct);
  const round = Number(body.cashRoundLaari);
  const tables = Number(body.tables);
  if (!name) throw bad('an outlet needs a name');
  if (!Number.isFinite(service) || service < 0 || service > 100) {
    throw bad('a service charge is a percentage between 0 and 100');
  }
  if (!Number.isInteger(round) || round < 0 || round > 100) {
    throw bad('cash rounding is a whole number of laari, 0 to 100');
  }
  if (!Number.isInteger(tables) || tables < 0 || tables > 500) {
    throw bad('that is not a plausible number of tables');
  }
  const before = await settings(c, ctx.outletId);
  await c.query('SELECT chain.set_outlet_settings($1,$2,$3,$4,$5)',
    [name, tz, service, round, tables]);
  const after = await settings(c, ctx.outletId);
  await c.query("SELECT chain.log('outlet_settings','outlet',$1,$2,$3)",
    [String(ctx.outletId), JSON.stringify(before.outlet), JSON.stringify(after.outlet)]);
  return after;
}

async function setTax(c, body, ctx) {
  const code = String(body.code || '').trim().toUpperCase();
  const rate = Number(body.rate);
  const from = String(body.from || '').slice(0, 10);
  if (!code) throw bad('a tax code is required');
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw bad('a tax rate is a percentage between 0 and 100');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw bad('an effective date is required');
  try {
    await c.query('SELECT chain.set_tax_rate($1,$2,$3)', [code, rate, from]);
  } catch (e) {
    /* The database's own sentence, which explains the rule, rather than a
       generic 500 that leaves somebody wondering why the date was refused. */
    if (/backdating/.test(e.message)) throw bad(e.message);
    throw e;
  }
  await c.query("SELECT chain.log('tax_rate','tax_version',$1,NULL,$2)",
    [code, JSON.stringify({ code, rate, from })]);
  return settings(c, ctx.outletId);
}

/* ── access: who can act right now ───────────────────────────────────────── */

/**
 * The roster with its rank picture, and every session that is open.
 *
 * A SESSION IS THE THING STAFF CANNOT SHOW YOU. The roster says who is allowed
 * in; this says who is in — on what device, since when, and how long it has
 * left. Until migration 031 ending one did nothing, which is why this screen
 * could not have existed before now.
 */
async function access(c, ctx) {
  const [roster, live, locked] = await Promise.all([
    c.query('SELECT id, name, rank, active, locked_until FROM chain.staff'
      + ' WHERE outlet_id = $1 ORDER BY rank DESC, name', [ctx.outletId]),
    c.query('SELECT s.id, s.staff_id, s.rank, s.issued_at, s.expires_at, s.scope,'
      + ' st.name AS staff_name, d.label AS device_label, d.id AS device_id,'
      + ' d.revoked AS device_revoked'
      + ' FROM chain.session s'
      + ' JOIN chain.staff st ON st.id = s.staff_id'
      + ' LEFT JOIN chain.device d ON d.id = s.device_id'
      + ' WHERE s.outlet_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()'
      + ' ORDER BY s.issued_at DESC', [ctx.outletId]),
    c.query('SELECT id, name, locked_until FROM chain.staff'
      + ' WHERE outlet_id = $1 AND locked_until > now()', [ctx.outletId]),
  ]);

  const byRank = new Map();
  for (const s of roster.rows) {
    if (!s.active) continue;
    byRank.set(s.rank, (byRank.get(s.rank) || 0) + 1);
  }

  return {
    /* The ladder, top to bottom, with how many people stand on each rung and
       whether anybody does. A rung with nobody on it is worth seeing: an outlet
       with no Admin cannot add staff, and finds out at the worst moment. */
    ladder: [5, 4, 3, 2, 1].map((rank) => ({
      rank, name: RANKS[rank], people: byRank.get(rank) || 0,
    })),
    sessions: live.rows.map((s) => ({
      id: s.id, staffId: s.staff_id, staffName: s.staff_name, rank: s.rank,
      rankName: RANKS[s.rank] || String(s.rank),
      issuedAt: s.issued_at, expiresAt: s.expires_at, scope: s.scope,
      device: s.device_id ? { id: s.device_id, label: s.device_label,
        revoked: s.device_revoked } : null,
      /* Yours. Ending it signs you out, which is a fair thing to do and not a
         thing to do by accident. */
      isMine: s.id === ctx.sessionId,
    })),
    lockedOut: locked.rows.map((s) => ({ id: s.id, name: s.name, until: s.locked_until })),
    canEnd: ctx.rank >= 3,
    myRank: ctx.rank,
  };
}

/** End one open session. Manager rank — the same rank that revokes a device,
 *  and for the same reason: it is the person standing there when somebody has
 *  to be got off a terminal. */
async function endSession(c, id, ctx) {
  const q = await c.query(
    'UPDATE chain.session SET revoked_at = now()'
    + ' WHERE id = $1 AND outlet_id = $2 AND revoked_at IS NULL RETURNING staff_id',
    [id, ctx.outletId]);
  if (!q.rows.length) {
    throw Object.assign(new Error('that session has already ended'), { status: 404 });
  }
  await c.query("SELECT chain.log('session_end','session',$1,NULL,$2)",
    [id, JSON.stringify({ staffId: q.rows[0].staff_id })]);
  return { id, ended: true };
}

/* ── the audit log ───────────────────────────────────────────────────────── */

const PAGE = 100;

/**
 * Append-only, filterable, exportable — 02-POS-SPEC §2 (`logs`).
 *
 * It is append-only because the outlet role holds SELECT and INSERT on
 * `chain.audit` and no UPDATE or DELETE, anywhere, ever. That is not a policy
 * somebody could relax by editing a USING clause; it is the absence of a
 * privilege, and `backend/scripts/leak-test.js` proves it on every run by
 * trying both.
 *
 * KEYSET PAGING, not OFFSET. A trail is read newest-first while new rows are
 * still arriving at the top of it, and OFFSET 200 into a moving list silently
 * skips and repeats entries — on an audit trail, which is the one place a
 * missing row is the whole problem.
 */
async function auditLog(c, q, ctx) {
  const params = [ctx.outletId];
  /* Qualified: the join to chain.staff below brings a second `outlet_id` into
     scope and an unqualified one is ambiguous. */
  const where = ['a.outlet_id = $1'];
  /* replaceAll, not replace — the text filter names the placeholder three
     times and `String.replace` with a string pattern substitutes only the
     first, which would have left two literal `$$` in the SQL. */
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll('$$', '$' + params.length));
  };

  if (q.action) add('a.action = $$', String(q.action));
  if (q.entity) add('a.entity = $$', String(q.entity));
  if (q.actor) add('a.actor = $$::uuid', String(q.actor));
  if (q.scope) add('a.scope = $$', String(q.scope));
  if (q.from) add('a.at >= $$::date', String(q.from).slice(0, 10));
  /* The `to` date is INCLUSIVE of its own day. `at <= '2026-08-18'` means
     midnight, so a day filter that reads "18th to 18th" would return nothing
     that happened during it. */
  if (q.to) add("a.at < ($$::date + interval '1 day')", String(q.to).slice(0, 10));
  if (q.text) {
    add('(a.action ILIKE $$ OR a.entity ILIKE $$ OR a.entity_id ILIKE $$)',
      '%' + String(q.text) + '%');
  }
  if (q.before) add('a.id < $$::bigint', String(q.before));

  const limit = Math.min(Number(q.limit) || PAGE, 500);
  const rows = await c.query(
    'SELECT a.id, a.at, a.actor, a.rank, a.action, a.entity, a.entity_id,'
    + ' a.scope, a.before, a.after, s.name AS actor_name'
    + ' FROM chain.audit a LEFT JOIN chain.staff s ON s.id = a.actor'
    + ' WHERE ' + where.join(' AND ')
    + ' ORDER BY a.id DESC LIMIT ' + (limit + 1), params);

  const page = rows.rows.slice(0, limit);
  return {
    entries: page.map((r) => ({
      id: String(r.id), at: r.at,
      actor: r.actor, actorName: r.actor_name || null,
      rank: r.rank, rankName: RANKS[r.rank] || String(r.rank),
      action: r.action, entity: r.entity, entityId: r.entity_id,
      scope: r.scope,
      /* The before/after payloads are what makes a trail worth keeping — an
         entry saying "settings changed" and not what to is a note, not a
         record. */
      before: r.before, after: r.after,
    })),
    /* The cursor, not a page number. */
    nextBefore: rows.rows.length > limit ? String(page[page.length - 1].id) : null,
    appendOnly: {
      enforced: 'no grant',
      why: 'The outlet role holds SELECT and INSERT on chain.audit and no '
        + 'UPDATE or DELETE. Append-only here is the absence of a privilege, '
        + 'not a rule in a policy somebody could relax — the leak test tries '
        + 'to rewrite and to delete a row on every run.',
    },
  };
}

/** The distinct actions and entities actually present, for the filter chips.
 *  Built from the trail rather than from a list in the code: a hardcoded set
 *  goes stale the first time somebody adds a module, and then the filter
 *  quietly cannot find the newest thing anybody did. */
async function auditFacets(c, ctx) {
  const [actions, entities, actors] = await Promise.all([
    c.query('SELECT action, count(*)::int AS n FROM chain.audit WHERE outlet_id = $1'
      + ' GROUP BY action ORDER BY n DESC LIMIT 60', [ctx.outletId]),
    c.query('SELECT entity, count(*)::int AS n FROM chain.audit WHERE outlet_id = $1'
      + ' GROUP BY entity ORDER BY n DESC LIMIT 40', [ctx.outletId]),
    c.query('SELECT a.actor, s.name, count(*)::int AS n FROM chain.audit a'
      + ' LEFT JOIN chain.staff s ON s.id = a.actor'
      + ' WHERE a.outlet_id = $1 AND a.actor IS NOT NULL'
      + ' GROUP BY a.actor, s.name ORDER BY n DESC LIMIT 40', [ctx.outletId]),
  ]);
  return {
    actions: actions.rows.map((r) => ({ value: r.action, count: r.n })),
    entities: entities.rows.map((r) => ({ value: r.entity, count: r.n })),
    actors: actors.rows.map((r) => ({ value: r.actor, label: r.name || 'unknown', count: r.n })),
  };
}

/* ── the export ──────────────────────────────────────────────────────────── */

/** A field, escaped for a spreadsheet.
 *
 *  The leading apostrophe on `=`, `+`, `-` and `@` is not decoration: those
 *  four characters start a FORMULA in Excel, Sheets and LibreOffice, and an
 *  audit trail is exactly where somebody's typed reason could begin with one.
 *  The same guard the accounting exports use. */
function csvField(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

async function auditCsv(c, q, ctx) {
  const out = await auditLog(c, { ...q, limit: 5000 }, ctx);
  const head = ['id', 'at', 'actor', 'actor_name', 'rank', 'action', 'entity',
    'entity_id', 'scope', 'before', 'after'];
  const lines = [head.join(',')];
  for (const e of out.entries) {
    lines.push([e.id, e.at instanceof Date ? e.at.toISOString() : e.at,
      e.actor, e.actorName, e.rankName, e.action, e.entity, e.entityId,
      e.scope, e.before, e.after].map(csvField).join(','));
  }
  await c.query("SELECT chain.log('audit_export','audit',$1,NULL,$2)",
    [String(out.entries.length), JSON.stringify({ rows: out.entries.length, filters: q })]);
  return lines.join('\n') + '\n';
}

module.exports = {
  settings, setSettings, setTax,
  access, endSession,
  auditLog, auditFacets, auditCsv,
  RANKS,
};
