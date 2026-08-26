'use strict';
/* ═══ THE WATCHDOG SAYS SOMETHING, ONCE ══════════════════════════════════════
   The readiness audit's largest open item was that nothing in this build could
   tell anybody it had gone wrong. What replaced that has the same failure mode
   as every other control here: it can LOOK like it is watching. So the three
   properties that make an alert worth having are asserted rather than assumed.

     · it fires when a condition goes bad, and names what to do;
     · it does NOT fire again on the next tick — a watchdog that emails every
       minute is one nobody reads by the second morning, and then the message
       that matters arrives in a folder;
     · it says something TRUE when the condition clears. The first version
       reused the alarm's own body with the numbers zeroed, so recovery read
       "RECOVERED: 0 of 4 outlets cannot be reached / No request for these
       outlets can be served" over an empty list — a sentence that states the
       opposite of what happened.

   And the one that matters on an install with no mail transport: an alert that
   cannot be emailed is still LOGGED. The first version returned before saying
   anything at all, which would have given an install with no ALERT_EMAIL a
   watchdog that saw the fault and told nobody anywhere.
   ═══════════════════════════════════════════════════════════════════════ */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const watch = require('../src/watch');

/* Capture console.error, because that is the delivery channel of last resort
   and the only one available without a transport. */
function capture(fn) {
  const lines = [];
  const was = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  return Promise.resolve().then(fn).finally(() => { console.error = was; })
    .then(() => lines);
}

const clear = {
  readiness: async () => ({ outlets: 4, unreachable: [] }),
  fleet: async () => ({ head: 38, live: 2, behind: [], failed: [] }),
  quietDevices: async () => []
};
const broken = {
  readiness: async () => ({ outlets: 4,
    unreachable: [{ outlet: 3, error: 'role "outlet_3_app" does not exist' }] }),
  fleet: async () => ({ head: 38, live: 2,
    behind: [{ db: 'biz_1', at: 36 }],
    failed: [{ db: 'biz_2', at: 30, error: 'relation already exists' }] }),
  quietDevices: async () => ([{ db: 'biz_1', outlet: 1, name: 'Counter till', mins: 214 }])
};

function reset() {
  Object.keys(watch._firing).forEach((k) => delete watch._firing[k]);
}

test('a healthy sweep says nothing at all', async () => {
  reset();
  const lines = await capture(() => watch.sweep(clear));
  assert.deepStrictEqual(lines, [],
    'silence is the correct output when nothing is wrong — anything else'
    + ' teaches an operator to skim');
});

test('each condition fires once, with the remedy in the message', async () => {
  reset();
  const lines = await capture(() => watch.sweep(broken));
  const all = lines.join('\n');

  assert.match(all, /\[alert\] new · readyz/);
  assert.match(all, /outlet 3 — role "outlet_3_app" does not exist/,
    'and names the outlet and the reason, not just a count');
  assert.match(all, /provision:outlet -- --all/,
    'a 503 saying "not ready" leaves whoever holds the pager where they were');

  assert.match(all, /\[alert\] new · schema/);
  assert.match(all, /biz_2 — at 30 of 38 — MIGRATION FAILED/,
    'a failed migration is named apart from merely behind');
  assert.match(all, /npm run migrate/);

  assert.match(all, /\[alert\] new · devices/);
  assert.match(all, /Counter till — last delivered 214 minutes ago/);

  assert.deepStrictEqual(Object.keys(watch._firing).sort(),
    ['devices', 'readyz', 'schema']);
});

test('a second tick inside the window repeats nothing', async () => {
  reset();
  await capture(() => watch.sweep(broken));
  const again = await capture(() => watch.sweep(broken));
  assert.deepStrictEqual(again, [],
    'still-bad is not news — the repeat is on ALERT_REPEAT_HOURS, not on the tick');
});

test('and it repeats once the window has passed', async () => {
  reset();
  await capture(() => watch.sweep(broken));
  // Wind every entry back past the repeat window rather than sleeping six hours.
  const back = Date.now() - (Number(process.env.ALERT_REPEAT_HOURS || 6) + 1) * 3600e3;
  Object.keys(watch._firing).forEach((k) => { watch._firing[k].at = back; });
  const later = await capture(() => watch.sweep(broken));
  assert.match(later.join('\n'), /\[alert\] repeat · readyz/,
    'a condition that is still holding after the window is said again, marked'
    + ' as a repeat so nobody reads it as a new fault');
});

test('a recovery says what is true, not the alarm with zeroes in it', async () => {
  reset();
  await capture(() => watch.sweep(broken));
  const lines = await capture(() => watch.sweep(clear));
  const all = lines.join('\n');

  assert.match(all, /RECOVERED — every outlet answers with its own login role again/);
  assert.match(all, /RECOVERED — every live business database is at head again/);
  assert.match(all, /RECOVERED — every writing device is delivering its pushes again/);
  assert.ok(!/cannot be reached/.test(all),
    'the recovery must not carry the alarm\'s own words — that is a message'
    + ' that says the opposite of what happened');
  assert.match(all, /It held for about \d+ minute/,
    'and says how long, because that is the first thing anybody asks');
  assert.deepStrictEqual(Object.keys(watch._firing), []);
});

test('with no transport it still reaches the log, which is all that is left', async () => {
  reset();
  const keep = process.env.ALERT_EMAIL;
  delete process.env.ALERT_EMAIL;
  try {
    assert.strictEqual(watch.configured(), false);
    assert.match(watch.why(), /ALERT_EMAIL is not set/);
    const lines = await capture(() => watch.sweep(broken));
    assert.ok(lines.length >= 3,
      'an install with nobody to email still writes the whole alert to the log'
      + ' — returning early there is a watchdog that sees the fault and tells'
      + ' nobody anywhere');
    assert.match(lines.join('\n'), /provision:outlet -- --all/,
      'including the remedy, in full');
  } finally {
    if (keep === undefined) delete process.env.ALERT_EMAIL;
    else process.env.ALERT_EMAIL = keep;
  }
});

test('the boot line says whether alerting is on, by name', () => {
  const keep = process.env.ALERT_EMAIL;
  try {
    delete process.env.ALERT_EMAIL;
    assert.match(watch.bootLine(), /alerting is OFF — ALERT_EMAIL is not set/,
      'a watchdog nobody knows is switched off is worse than no watchdog,'
      + ' because somebody believes in it');
    assert.match(watch.bootLine(), /\/metrics still counts/,
      'and says what IS still happening');
  } finally {
    if (keep === undefined) delete process.env.ALERT_EMAIL;
    else process.env.ALERT_EMAIL = keep;
  }
});

test('/metrics is the shape of the install, so it is a 404 until it is keyed', () => {
  const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = SRV.slice(SRV.indexOf("app.get('/metrics'"), SRV.indexOf("app.get('/healthz'"));
  assert.match(block, /METRICS_KEY/);
  assert.match(block, /length < 16\) return res\.status\(404\)\.end\(\)/,
    'unset, the endpoint does not exist — same doctrine as the platform door');
  assert.match(block, /timingSafeEqual/,
    'and the comparison is constant time, like every other secret comparison here');
});

test('the text format is Prometheus, and carries no per-outlet cardinality', () => {
  const out = watch.render({ ready: true, outlets: 4, unreachable: 0,
    businesses: 2, behind: 0, failed: 0, quiet: 0 });
  assert.match(out, /# TYPE kpos_up gauge/);
  assert.match(out, /^kpos_ready 1$/m);
  assert.match(out, /^kpos_businesses 2$/m);
  assert.match(out, /kpos_request_duration_ms\{quantile="0\.99"\}/);
  // One series per outlet is how a metrics endpoint becomes the thing that
  // falls over; the counters are by status CLASS and nothing else.
  assert.ok(!/outlet="/.test(out) && !/handle="/.test(out),
    'no label carries an outlet id or a store handle');
  assert.ok(out.endsWith('\n'), 'the exposition format ends with a newline');
});
