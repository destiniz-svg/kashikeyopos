'use strict';
/* ═══ HOW SOMEBODY FINDS OUT ════════════════════════════════════════════════
   The readiness audit's largest open item: this build had structured boot
   lines, an audit trail, /healthz and a genuinely good /readyz — and no way at
   all to LEARN that something had gone wrong. Nobody would discover a store
   had stopped syncing except by the shop ringing up.

   Two halves, and they are different things:

     COUNTING is passive. /metrics exposes what this process has seen since it
     started, in Prometheus text format, for whatever the operator points at
     it. No dependency: the format is a handful of lines of string building,
     and a client library we would have to keep patched forever is not worth
     the four lines it saves. Same rule as src/email.js talking to Resend over
     one fetch.

     ALERTING is active, and it is the half that matters at 2 a.m. Three
     conditions are watched and the operator is EMAILED — the one transport
     this build already has. Anything else (a pager, a webhook) is a second
     driver in this file and nothing else changes.

   THE THREE, and why these three:

     · /readyz is not 200. That probe checks out every outlet's own login role
       against its own schema, which is the whole path a real request takes. If
       it fails, no request for that outlet can be served. It is the single
       most load-bearing signal in the install.
     · a business is behind head, or its migration failed. One customer's till
       is then talking to a schema the code does not expect, and requireAtHead
       refuses its requests by name — correctly, and silently as far as anyone
       outside that shop is concerned.
     · a writing device has gone quiet. A signed-in till sitting on the only
       copy of the evening's sales behind a dead link is the failure this
       product exists to survive; chain.device.last_push_at answers it, and the
       bootstrap has published it for months with nobody watching.

   AN ALERT FIRES ON A TRANSITION, NEVER ON A TICK. A watchdog that emails
   every minute while something is broken is a watchdog nobody reads by the
   second morning — and then the one that matters arrives in a folder. So: one
   message when a condition goes bad, one when it clears, and a reminder only
   after ALERT_REPEAT_HOURS (default 6) if it is still bad. The whole state is
   in memory and resets on a restart, which is the correct failure: a fresh
   process re-evaluates and re-alerts if the condition is still true.

   UNCONFIGURED, IT SAYS SO — by name, at boot, exactly as an unset
   PLATFORM_KEY makes the platform door a 404 and says so. A watchdog nobody
   knows is switched off is worse than no watchdog, because somebody believes
   in it.
   ═══════════════════════════════════════════════════════════════════════ */

const email = require('./email');

/* ── counting ──────────────────────────────────────────────────────────────
   Deliberately small. Counters and one duration reservoir per route class;
   no cardinality explosion from putting an outlet id or a handle in a label,
   which is how a metrics endpoint becomes the thing that falls over. */
const started = Date.now();
const counters = Object.create(null);
const durations = [];                       // ring of recent request millis
const DUR_MAX = 2048;

function bump(name, by) {
  counters[name] = (counters[name] || 0) + (by == null ? 1 : by);
}

function observe(ms) {
  durations.push(ms);
  if (durations.length > DUR_MAX) durations.splice(0, durations.length - DUR_MAX);
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/* Express middleware. Counts by STATUS CLASS rather than by path: a path label
   on a router with /outlet/:id in it is one series per outlet, which is the
   classic way to melt a scrape. */
function meter() {
  return function (req, res, next) {
    const t0 = Date.now();
    res.on('finish', function () {
      const ms = Date.now() - t0;
      observe(ms);
      bump('http_requests_total');
      bump('http_requests_' + Math.floor(res.statusCode / 100) + 'xx_total');
      if (res.statusCode >= 500) bump('http_server_errors_total');
    });
    next();
  };
}

function line(out, name, help, type, value, labels) {
  out.push('# HELP ' + name + ' ' + help);
  out.push('# TYPE ' + name + ' ' + type);
  out.push(name + (labels || '') + ' ' + value);
}

/* The text format, by hand. `state` is whatever the caller can answer cheaply
   — it is passed in rather than fetched here, so that /metrics can never
   disagree with /readyz about the same fact. */
function render(state) {
  const out = [];
  const mem = process.memoryUsage();
  const sorted = durations.slice().sort((a, b) => a - b);

  line(out, 'kpos_up', 'Always 1 while this process is serving.', 'gauge', 1);
  line(out, 'kpos_uptime_seconds', 'Seconds since this process started.',
    'gauge', Math.round((Date.now() - started) / 1000));
  line(out, 'kpos_resident_bytes', 'Resident set size of this process.',
    'gauge', mem.rss);
  line(out, 'kpos_heap_used_bytes', 'V8 heap in use.', 'gauge', mem.heapUsed);

  Object.keys(counters).sort().forEach((k) => {
    line(out, 'kpos_' + k, 'Counted since this process started.', 'counter', counters[k]);
  });

  line(out, 'kpos_request_duration_ms', 'Recent request latency.', 'summary',
    quantile(sorted, 0.5), '{quantile="0.5"}');
  out.push('kpos_request_duration_ms{quantile="0.95"} ' + quantile(sorted, 0.95));
  out.push('kpos_request_duration_ms{quantile="0.99"} ' + quantile(sorted, 0.99));

  const s = state || {};
  line(out, 'kpos_ready', '1 when every outlet answers with its own login role.',
    'gauge', s.ready ? 1 : 0);
  line(out, 'kpos_outlets', 'Active outlets across every live business.',
    'gauge', Number(s.outlets || 0));
  line(out, 'kpos_outlets_unreachable', 'Outlets that cannot be reached with their own role.',
    'gauge', Number(s.unreachable || 0));
  line(out, 'kpos_businesses', 'Live business databases in the registry.',
    'gauge', Number(s.businesses || 0));
  line(out, 'kpos_businesses_behind', 'Businesses whose schema is behind head.',
    'gauge', Number(s.behind || 0));
  line(out, 'kpos_businesses_failed', 'Businesses whose migration failed.',
    'gauge', Number(s.failed || 0));
  line(out, 'kpos_devices_quiet', 'Writing devices that have not delivered a push in the window.',
    'gauge', Number(s.quiet || 0));
  return out.join('\n') + '\n';
}

/* ── alerting ────────────────────────────────────────────────────────────── */

/* WHO TO TELL, AND WHERE THAT ADDRESS CAME FROM.

   `ALERT_EMAIL` is the explicit answer and always wins: an install that wants
   alerts somewhere other than the admin's inbox says so and is not overridden.

   `PLATFORM_ADMIN_EMAIL` is the fallback, and it is not a guess. It is already
   the address this install was handed as "the person who runs this" — it seeds
   the platform admin. An install that has named that person and then has no
   watchdog because a SECOND variable was never set is a fence somebody
   believes in and does not have, which is the failure this whole file exists
   to refuse.

   The obvious workaround does not work, and that is why this reads the
   variable rather than asking anybody to copy it: writing
   `ALERT_EMAIL=${{PLATFORM_ADMIN_EMAIL}}` looks right and boots as UNSET,
   because the platform resolves an unknown same-service reference to an EMPTY
   STRING rather than leaving the literal. Measured on the live install, twice.

   A DANGLING ${{reference}} IS STILL NOT AN ADDRESS. Where the name inside the
   braces names another service and is wrong, the literal DOES survive —
   non-empty, truthy, useless. That trap has already cost this build twice
   (src/email.js, panel/railway.js), and here it buys the worst version of it:
   a watchdog reporting itself ON, addressed to a string no mail provider will
   accept, telling nobody. Off and saying so is strictly better. So both
   sources go through the same guard, and the source is NAMED, because "which
   variable is this reading" is the first thing an operator asks. */
function alertSource() {
  const pick = (name) => {
    const v = String(process.env[name] || '').trim();
    return v ? { name: name, to: email.unresolved(v) ? '' : v } : null;
  };
  return pick('ALERT_EMAIL') || pick('PLATFORM_ADMIN_EMAIL')
    || { name: null, to: '' };
}
const ALERT_TO = () => alertSource().to;
const REPEAT_MS = () => Math.max(1, Number(process.env.ALERT_REPEAT_HOURS || 6)) * 3600e3;
const QUIET_MINS = () => Math.max(5, Number(process.env.DEVICE_QUIET_MINUTES || 60));

/* One entry per condition: whether it is currently bad, and when we last said
   so. Nothing is persisted — a restart re-evaluates from scratch, which is the
   right failure for a watchdog. */
const firing = Object.create(null);
/* The most outlets this process has ever seen — see the 'vanished' check. */
let seenOutlets = 0;

function configured() {
  return !!ALERT_TO() && email.health().ok;
}

/* WHY it is off, in the install's own words, so nobody goes looking in the
   wrong place. A missing address and a refusing transport are different
   problems with different fixes. */
function why() {
  const src = alertSource();
  if (!src.to) {
    return src.name
      ? src.name + ' is an unresolved platform reference — check the service'
        + ' name inside the braces; there is nobody to tell'
      : 'neither ALERT_EMAIL nor PLATFORM_ADMIN_EMAIL is set, so there is'
        + ' nobody to tell';
  }
  const h = email.health();
  // The operator's half. `reason` is what an anonymous caller is told; the
  // boot log and the alert log get the transport's own words.
  if (!h.ok) return h.detail || h.reason;
  return null;
}

/* A RECOVERY IS ITS OWN SENTENCE, not the alarm with the numbers changed. The
   first version reused the bad-state body, so clearing produced "RECOVERED: 0
   of 4 outlets cannot be reached" over "No request for these outlets can be
   served" and an empty list — a message that states the opposite of what
   happened. Whoever read that at 3 a.m. would go and check a shop that was
   fine. */
async function say(key, bad, subject, body, clearLine) {
  const was = firing[key];
  const now = Date.now();

  if (!bad) {
    if (!was) return null;                       // was fine, still fine
    const held = Math.max(1, Math.round((now - was.since) / 60000));
    delete firing[key];
    return deliver(key, 'RECOVERED — ' + (clearLine || 'the condition has cleared'),
      (clearLine || 'The condition has cleared.') + '\n\nIt held for about '
      + held + ' minute(s). Nothing further is needed.', 'recovered');
  }
  if (was && now - was.at < REPEAT_MS()) return null;   // still bad, said recently
  firing[key] = { at: now, since: (was && was.since) || now };
  return deliver(key, (was ? 'STILL: ' : '') + subject, body, was ? 'repeat' : 'new');
}

/* THE LOG FIRST, THE INBOX SECOND — and the first version of this file had it
   the other way round, returning before it said anything at all when no
   transport was configured. An install with no ALERT_EMAIL would then have a
   watchdog that saw the fault and told nobody, anywhere, which is worse than
   no watchdog: the boot line says alerting is off, so somebody reading the log
   would reasonably assume nothing had been detected either.

   Same doctrine as src/email.js writing a sign-in code to the audit trail
   where it could not send it. Where it cannot reach an inbox it still reaches
   the log, at error level, with the whole body — because that log is the only
   place left. */
async function deliver(key, subject, body, kind) {
  console.error('[alert] ' + kind + ' · ' + key + ' · ' + subject + '\n'
    + body.split('\n').map((l) => '        ' + l).join('\n'));
  if (!configured()) return { sent: false, reason: why() };
  try {
    const out = await email.send({
      to: ALERT_TO(),
      subject: '[KashikeyoPOS] ' + subject,
      text: body + '\n\n— this install\'s watchdog. It writes when a condition'
        + ' changes, and again every ' + Math.round(REPEAT_MS() / 3600e3)
        + ' hours while it holds.'
    });
    if (!out.sent) console.error('[alert] not emailed: ' + out.reason);
    return out;
  } catch (e) {
    console.error('[alert] could not send ' + key + ': ' + e.message);
    return { sent: false, reason: e.message };
  }
}

/* ── the sweep ─────────────────────────────────────────────────────────────
   `probes` is injected so this file opens no connection of its own and cannot
   answer differently from the endpoints it is watching. */
async function sweep(probes) {
  const state = { ready: true, outlets: 0, unreachable: 0,
    businesses: 0, behind: 0, failed: 0, quiet: 0 };

  // 1 · can a request be served at all?
  try {
    const r = await probes.readiness();
    state.outlets = r.outlets;
    /* A REGISTRY THAT HAS LOST ITS BUSINESSES READS AS PERFECTLY HEALTHY, and
       that is how this was found: during the restore drill the registry was
       dropped and recreated empty, and for the seconds before the restore
       landed, /readyz answered 200 and this sweep said nothing at all. No
       businesses means no outlets, no outlets means none unreachable, and
       "nothing to check" is indistinguishable from "everything is fine".

       "No outlets is not a failure" is deliberate and correct — that is a
       fresh install on its way to onboarding, and a probe that never goes
       green there is an install nobody can ever set up. What it cannot tell
       you is whether this install USED to have customers. So the process
       remembers: the most it has ever seen. Going from some to none is not a
       fresh install, it is a catastrophe, and it is the one shape of total
       loss that every other probe here reports as healthy.

       In memory and reset by a restart, like the rest of this file. A restart
       that comes up empty genuinely cannot tell the difference — but a
       restart is also when somebody is already looking. */
    if (state.outlets > seenOutlets) seenOutlets = state.outlets;
    await say('vanished', seenOutlets > 0 && state.outlets === 0,
      'every outlet has disappeared',
      'This process has served ' + seenOutlets + ' outlet(s) and now finds'
      + ' none. That is not a fresh install — it is a registry that has lost'
      + ' its businesses, or a connection pointed somewhere new. Every other'
      + ' probe here reads it as healthy, because no outlets means none'
      + ' unreachable.\n\nCheck CONTROL_DB and whether chain.business still'
      + ' has its rows before anything writes.',
      'the outlets are back');
    /* A DATABASE THAT WILL NOT OPEN AND AN OUTLET THAT WILL NOT SERVE ARE
       DIFFERENT PAGES. They were one message under one remedy, and that remedy
       — recreating login roles — cannot fix a missing database. Whoever read
       it at 2 a.m. would run it, watch nothing change, and still be holding the
       pager. The endpoint separates them now, and so does this. */
    const dead = r.businesses || [];
    state.unreachable = r.unreachable.length + dead.length;
    state.ready = !state.unreachable;
    const said = [];
    const body = [];
    if (dead.length) {
      said.push(dead.length + ' business database(s) cannot be opened');
      body.push('One customer\'s whole install is unreachable — not one store'
        + ' inside it:\n\n'
        + dead.map((d) => '  · ' + d.db + ' — ' + d.error).join('\n')
        + '\n\nRemedy: restore that database, or — if it is gone'
        + ' deliberately — take its row out of the live set'
        + ' (chain.business.status) so the fleet stops counting it.'
        + ' Recreating login roles does nothing for this one.');
    }
    if (r.unreachable.length) {
      said.push(r.unreachable.length + ' of ' + state.outlets
        + ' outlet(s) cannot be reached');
      body.push('No request for these outlets can be served — they answer'
        + ' neither with their own login role nor from their own schema:\n\n'
        + r.unreachable.map((u) => '  · outlet ' + u.outlet + ' — ' + u.error).join('\n')
        + '\n\nRemedy: npm run provision:outlet -- --all, with this install\'s'
        + ' own OUTLET_ROLE_SECRET. Outlet login roles are cluster-wide and a'
        + ' pg_dump of one database does not carry them.');
    }
    await say('readyz', !state.ready, said.join(', and '), body.join('\n\n'),
      'every business opens and every outlet answers with its own login role again');
  } catch (e) {
    state.ready = false;
    await say('readyz', true, 'the readiness probe itself failed',
      'The probe could not complete: ' + e.message,
      'the readiness probe is answering again');
  }

  // 2 · is any customer's schema behind the code that is serving it?
  try {
    const b = await probes.fleet();
    state.businesses = b.live;
    state.behind = b.behind.length;
    state.failed = b.failed.length;
    const stuck = b.behind.concat(b.failed);
    await say('schema', stuck.length > 0,
      stuck.length + ' business database(s) are not at head',
      'These customers\' tills are talking to a schema this build does not'
      + ' expect, and their requests are refused by name until it moves:\n\n'
      + stuck.map((x) => '  · ' + x.db + ' — at ' + x.at + ' of ' + b.head
        + (x.error ? ' — MIGRATION FAILED: ' + x.error : '')).join('\n')
      + '\n\nRemedy: npm run migrate (whole fleet) or'
      + ' npm run migrate -- --business <id>.',
    'every live business database is at head again');
  } catch (e) {
    console.error('[watch] fleet probe failed: ' + e.message);
  }

  // 3 · is a till sitting on the only copy of the evening?
  try {
    const q = await probes.quietDevices(QUIET_MINS());
    state.quiet = q.length;
    await say('devices', q.length > 0,
      q.length + ' writing device(s) have gone quiet',
      'A signed-in till that cannot deliver its writes is holding the only'
      + ' copy of what it has rung. Nothing is lost yet — the outbox is'
      + ' durable — but it is on one device:\n\n'
      + q.map((d) => '  · ' + d.db + ' outlet ' + d.outlet + ' · ' + d.name
        + ' — ' + (d.mins === null
          ? 'has NEVER delivered a push'
            + (d.since === null ? '' : ', and has been up ' + d.since + ' minutes')
          : 'last delivered ' + d.mins + ' minutes ago'))
        .join('\n')
      + '\n\nCheck the shop\'s connectivity before the till is switched off.',
    'every writing device is delivering its pushes again');
  } catch (e) {
    console.error('[watch] device probe failed: ' + e.message);
  }

  return state;
}

/* What the boot log says, once, so an operator can read it off the deploy
   rather than having to test it by breaking something. */
function bootLine() {
  const off = why();
  return off
    ? '[watch] alerting is OFF — ' + off + '. /metrics still counts.'
    : '[watch] alerting to ' + ALERT_TO() + ' (' + alertSource().name + ')'
      + ' · readiness, schema drift and quiet devices · repeats every '
      + Math.round(REPEAT_MS() / 3600e3) + 'h';
}

module.exports = { meter, render, sweep, bump, observe, configured, why,
  bootLine, _firing: firing, _resetSeen: () => { seenOutlets = 0; } };
