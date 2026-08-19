'use strict';
/* Sync & Devices — 02-POS-SPEC §2 (`sync`): "Outbox state, device pairing,
 * remote diagnostics." 08-BUILD-STAGES §28.
 *
 * THE HARD PART OF THIS SCREEN IS THAT THE OUTBOX IS NOT HERE. A till that has
 * not reconnected is, by definition, holding writes this server has never seen;
 * a server confident it knows how many would be a server that already had them.
 * So this module reports two different things and never blurs them:
 *
 *   WHAT ARRIVED — every op in `op_log`, which device sent it, when the device
 *   said it happened and when it landed. That is real, complete, and the whole
 *   basis of the diagnostics below.
 *
 *   WHAT IS STILL OUT THERE — unknown, and said so. The only honest signal is
 *   SILENCE: a paired till that has not been heard from since 14:20 either has
 *   nothing to say or cannot say it, and which of those it is depends on
 *   whether the others are talking. That is the figure this screen leads with.
 *
 * REPLAY LAG AND CLOCK SKEW ARE THE SAME SUBTRACTION AND DIFFERENT FACTS, and
 * separating them is what makes either one usable. `applied_at − client_at` is
 * lag plus whatever that device's clock is wrong by. Over a window:
 *
 *   · the MINIMUM is the best estimate of the clock offset — an op that
 *     arrived the instant it was made still carries the full skew
 *   · the MAXIMUM is the worst an op waited, once the offset is taken off it
 *
 * Reporting the raw difference as "lag" is how a till with a clock ten minutes
 * fast gets read as a network problem, and a till with a clock ten minutes slow
 * hides a real one.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
const CODE_MINUTES = 30;
const KINDS = ['till', 'kds', 'expo', 'handheld', 'printer', 'display'];

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** A code somebody reads off one screen and types into another. Six characters
 *  from an alphabet with no I/O/0/1 in it, because they will be read aloud
 *  across a kitchen. Uniqueness is enforced by the partial index, not here —
 *  this retries on the collision rather than pretending it cannot happen. */
function newCode(random) {
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += CODE_ALPHABET[Math.floor((random ? random() : Math.random()) * CODE_ALPHABET.length)];
  }
  return s;
}

async function issueCode(c, id) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    try {
      const q = await c.query(
        'UPDATE chain.device SET pair_code = $2,'
        + " pair_code_expires = now() + ($3 || ' minutes')::interval"
        + ' WHERE id = $1 AND NOT revoked'
        + ' RETURNING pair_code, pair_code_expires', [id, code, String(CODE_MINUTES)]);
      if (!q.rows.length) throw bad('that device is revoked');
      return { code: q.rows[0].pair_code, expires: q.rows[0].pair_code_expires };
    } catch (e) {
      /* 23505 is the live-code unique index. Try another six characters. */
      if (e.code !== '23505') throw e;
    }
  }
  throw Object.assign(new Error('could not allocate a pairing code'), { status: 503 });
}

/* ── the list ────────────────────────────────────────────────────────────── */

/**
 * Every device this outlet knows about, with what it has actually been doing.
 *
 * The op counts come from `op_log` by a LEFT JOIN, so a paired device that has
 * never sent anything appears with zeros rather than not appearing — which is
 * the row somebody most needs to see.
 */
async function list(c, now) {
  const q = await c.query(
    'SELECT d.id, d.label, d.kind, d.paired_at, d.last_seen, d.revoked,'
    + ' d.revoked_at, d.pair_code, d.pair_code_expires, d.platform, d.app_version,'
    + ' d.note, d.added_at,'
    + ' o.ops, o.last_op_at, o.first_op_at, o.min_offset_s, o.max_gap_s'
    + ' FROM chain.device d'
    + ' LEFT JOIN ('
    + "   SELECT device_id, count(*)::int AS ops, max(applied_at) AS last_op_at,"
    + '     min(applied_at) AS first_op_at,'
    /* See the header: the minimum difference is the clock offset, the maximum
       is the worst wait. Both in seconds, both signed — a device whose clock
       runs fast produces a NEGATIVE offset and that is the useful sign. */
    + '     min(extract(epoch from (applied_at - client_at)))::numeric AS min_offset_s,'
    + '     max(extract(epoch from (applied_at - client_at)))::numeric AS max_gap_s'
    + "   FROM op_log WHERE applied_at > now() - interval '7 days'"
    + '     AND device_id IS NOT NULL GROUP BY device_id'
    + ' ) o ON o.device_id = d.id'
    + ' ORDER BY d.revoked, d.label');

  const at = now ? new Date(now) : new Date();
  return q.rows.map(function (r) {
    const offset = r.min_offset_s === null ? null : Number(r.min_offset_s);
    const worst = r.max_gap_s === null ? null : Number(r.max_gap_s);
    const seen = r.last_seen ? new Date(r.last_seen) : null;
    return {
      id: r.id, label: r.label, kind: r.kind,
      pairedAt: r.paired_at, addedAt: r.added_at,
      lastSeen: r.last_seen,
      quietForMins: seen ? Math.max(0, Math.round((at - seen) / 60000)) : null,
      revoked: r.revoked, revokedAt: r.revoked_at,
      /* A code is only shown while it is live. An expired one on screen is an
         invitation to type it in and be told no. */
      pairCode: r.pair_code && (!r.pair_code_expires || new Date(r.pair_code_expires) > at)
        ? r.pair_code : null,
      pairCodeExpires: r.pair_code_expires,
      platform: r.platform, appVersion: r.app_version, note: r.note,
      ops: r.ops || 0,
      lastOpAt: r.last_op_at, firstOpAt: r.first_op_at,
      /* Rounded to the second: sub-second precision here would be reporting
         the width of a network hop as if it were a finding. */
      clockOffsetSecs: offset === null ? null : Math.round(offset),
      /* The worst an op waited, with that device's own clock error taken off.
         Never negative — if the subtraction goes below zero the two figures
         came from one op and there is no wait to report. */
      worstReplayWaitSecs: worst === null || offset === null
        ? null : Math.max(0, Math.round(worst - offset)),
    };
  });
}

/* ── the diagnostics ─────────────────────────────────────────────────────── */

/**
 * What the replay path has been doing, for the whole outlet.
 *
 * `silent` is the figure the screen leads with: paired, not revoked, and not
 * heard from — while others were. One till quiet at 03:00 is a closed
 * restaurant; one till quiet while three others are pushing is a till with a
 * problem, and only the comparison tells them apart. That is the same rule the
 * estate uses for a silent SITE, for the same reason.
 */
async function health(c, now) {
  const devices = await list(c, now);
  const [kinds, hours, unnamed] = await Promise.all([
    c.query("SELECT kind, count(*)::int AS n FROM op_log"
      + " WHERE applied_at > now() - interval '24 hours' GROUP BY kind ORDER BY n DESC"),
    c.query("SELECT date_trunc('hour', applied_at) AS hour, count(*)::int AS n"
      + " FROM op_log WHERE applied_at > now() - interval '24 hours'"
      + " GROUP BY 1 ORDER BY 1"),
    /* Ops that arrived with no device on them. Every one is a write nobody can
       attribute to a machine — which was ALL of them until this phase, because
       the terminal never sent an id. Shown so the number visibly falls as
       tills are paired rather than sitting at zero and meaning nothing. */
    c.query("SELECT count(*)::int AS n FROM op_log"
      + " WHERE applied_at > now() - interval '24 hours' AND device_id IS NULL"),
  ]);

  const live = devices.filter((d) => !d.revoked && d.pairedAt);
  const anyTalking = live.some((d) => d.quietForMins !== null && d.quietForMins < 15);
  const silent = live.filter((d) =>
    anyTalking && (d.quietForMins === null || d.quietForMins >= 15));

  return {
    devices,
    paired: live.length,
    unpairedOpsToday: unnamed.rows[0].n,
    silent: silent.map((d) => ({ id: d.id, label: d.label, quietForMins: d.quietForMins })),
    opsByKind: kinds.rows.map((r) => ({ kind: r.kind, ops: r.n })),
    opsByHour: hours.rows.map((r) => ({ hour: r.hour, ops: r.n })),
    /* Said in the payload, not left to a screen to remember to say. */
    outbox: {
      known: false,
      why: 'Writes waiting to be replayed are held on each till until it '
        + 'reconnects — that is what makes the register work offline. The server '
        + 'cannot count what has not reached it. Silence is the signal, and it '
        + 'is above.',
    },
  };
}

/* ── the writes ──────────────────────────────────────────────────────────── */

async function add(c, body, ctx) {
  const label = String(body.label || '').trim();
  const kind = String(body.kind || '').trim();
  if (!label) throw bad('a device needs a label somebody can read across a room');
  if (!KINDS.includes(kind)) throw bad('kind must be one of ' + KINDS.join(', '));
  const q = await c.query(
    'INSERT INTO chain.device (outlet_id, label, kind, note, added_by)'
    + ' VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [ctx.outletId, label, kind, String(body.note || '').trim() || null, ctx.actor || null]);
  const id = q.rows[0].id;
  const code = await issueCode(c, id);
  await c.query("SELECT chain.log('device_add','device',$1,NULL,$2)",
    [id, JSON.stringify({ label, kind })]);
  return { id, label, kind, ...code };
}

/** Re-issue. A code expires in half an hour on purpose: a pairing code on a
 *  whiteboard for a fortnight is a way in, not a convenience. */
async function reissue(c, id, ctx) {
  const code = await issueCode(c, id);
  await c.query("SELECT chain.log('device_pair_code','device',$1,NULL,NULL)", [id]);
  return { id, ...code };
}

async function rename(c, id, body, ctx) {
  const label = String(body.label || '').trim();
  if (!label) throw bad('a device needs a label');
  const q = await c.query(
    'UPDATE chain.device SET label = $2, note = $3 WHERE id = $1 RETURNING id',
    [id, label, String(body.note || '').trim() || null]);
  if (!q.rows.length) throw Object.assign(new Error('no such device'), { status: 404 });
  await c.query("SELECT chain.log('device_rename','device',$1,NULL,$2)",
    [id, JSON.stringify({ label })]);
  return { id, label };
}

/** Revoking kills the open sessions too — see migration 030 for why a revoked
 *  device that keeps selling until midnight is not a revoked device. */
async function revoke(c, id, ctx) {
  const q = await c.query('SELECT chain.revoke_device($1,$2) AS sessions',
    [id, ctx.actor || null]);
  await c.query("SELECT chain.log('device_revoke','device',$1,NULL,$2)",
    [id, JSON.stringify({ sessionsEnded: q.rows[0].sessions })]);
  return { id, revoked: true, sessionsEnded: q.rows[0].sessions };
}

/** Bringing one back. It has to be paired again — the machine's stored id was
 *  refused while it was revoked, and a device that walks back in without
 *  anybody typing a code is not a device anybody revoked. */
async function restore(c, id, ctx) {
  const q = await c.query(
    'UPDATE chain.device SET revoked = false, revoked_at = NULL, revoked_by = NULL,'
    + ' paired_at = NULL WHERE id = $1 AND outlet_id = $2 RETURNING id',
    [id, ctx.outletId]);
  if (!q.rows.length) throw Object.assign(new Error('no such device'), { status: 404 });
  const code = await issueCode(c, id);
  await c.query("SELECT chain.log('device_restore','device',$1,NULL,NULL)", [id]);
  return { id, revoked: false, ...code };
}

/** A device redeeming its code. No session yet — see chain.claim_device. */
async function claim(c, outletId, body) {
  const code = String(body.code || '').trim();
  if (!code) throw bad('a pairing code is required');
  const q = await c.query('SELECT * FROM chain.claim_device($1,$2,$3,$4)',
    [outletId, code, String(body.platform || '').slice(0, 120),
      String(body.appVersion || '').slice(0, 60)]);
  return q.rows[0];
}

module.exports = { list, health, add, reissue, rename, revoke, restore, claim, newCode, KINDS };
