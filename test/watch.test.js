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
  readiness: async () => ({ outlets: 4, unreachable: [], businesses: [] }),
  fleet: async () => ({ head: 38, live: 2, behind: [], failed: [] }),
  quietDevices: async () => [],
  backups: async () => ({ configured: true, where: 'file:/srv/backups',
    windowHours: 48, ageHours: 3, recentFailures: 0, lastWhy: null })
};
const broken = {
  readiness: async () => ({ outlets: 4, businesses: [],
    unreachable: [{ outlet: 3, error: 'role "outlet_3_app" does not exist' }] }),
  fleet: async () => ({ head: 38, live: 2,
    behind: [{ db: 'biz_1', at: 36 }],
    failed: [{ db: 'biz_2', at: 30, error: 'relation already exists' }] }),
  quietDevices: async () => ([{ db: 'biz_1', outlet: 1, name: 'Counter till', mins: 214 }]),
  backups: async () => ({ configured: true, where: 's3://shelf/kashikeyo',
    windowHours: 48, ageHours: 91, recentFailures: 2,
    lastWhy: 'pg_dump exited 1: could not connect' })
};

function reset() {
  Object.keys(watch._firing).forEach((k) => delete watch._firing[k]);
  watch._resetSeen();
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

  // Four conditions now, and this list is the point: a new one that forgets
  // to register itself here is a new one nobody is told about twice.
  assert.deepStrictEqual(Object.keys(watch._firing).sort(),
    ['backups', 'devices', 'readyz', 'schema']);
});

/* ═══ THE WEBHOOK IS A SECOND CHANNEL, NOT A REPLACEMENT ════════════════════
   ALERT_WEBHOOK takes a URL and receives {"text": "..."} — the shape Slack,
   Discord and most chat webhooks accept — fired beside the email and the log,
   never instead of them, so an operator who lives in chat hears about a
   condition without opening an inbox. A dangling ${{reference}} is no
   webhook, the same trap ALERT_EMAIL already refuses. */
test('an alert also reaches the webhook, in chat-webhook shape', async () => {
  reset();
  const http = require('http');
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { got.push({ ct: req.headers['content-type'], body: b });
      res.end('ok'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const keep = process.env.ALERT_WEBHOOK;
  process.env.ALERT_WEBHOOK = 'http://127.0.0.1:' + srv.address().port + '/hook';
  try {
    await capture(() => watch.sweep(broken));
    assert.ok(got.length >= 1, 'the webhook was called');
    assert.match(got[0].ct, /application\/json/);
    const payload = JSON.parse(got[0].body);
    assert.match(payload.text, /^\[KashikeyoPOS\] /, 'named sender, chat shape');
    assert.ok(got.some((g) => /provision:outlet/.test(JSON.parse(g.body).text)),
      'and the remedy rides the message, exactly as it rides the email');

    // A dangling reference is refused as an address, not dialled as one.
    reset();
    got.length = 0;
    process.env.ALERT_WEBHOOK = '${{kashikeyopos.ALERT_WEBHOOK}}';
    await capture(() => watch.sweep(broken));
    assert.strictEqual(got.length, 0, 'a dangling ${{reference}} is no webhook');
  } finally {
    if (keep === undefined) delete process.env.ALERT_WEBHOOK;
    else process.env.ALERT_WEBHOOK = keep;
    await new Promise((r) => srv.close(r));
    reset();
  }
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

  assert.match(all, /RECOVERED — every business opens and every outlet answers/);
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
  const keep = process.env.ALERT_EMAIL, keepAdmin = process.env.PLATFORM_ADMIN_EMAIL;
  delete process.env.ALERT_EMAIL;
  delete process.env.PLATFORM_ADMIN_EMAIL;
  try {
    assert.strictEqual(watch.configured(), false);
    assert.match(watch.why(), /neither ALERT_EMAIL nor PLATFORM_ADMIN_EMAIL is set/);
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
    if (keepAdmin === undefined) delete process.env.PLATFORM_ADMIN_EMAIL;
    else process.env.PLATFORM_ADMIN_EMAIL = keepAdmin;
  }
});

test('the boot line says whether alerting is on, by name', () => {
  const keep = process.env.ALERT_EMAIL, keepAdmin = process.env.PLATFORM_ADMIN_EMAIL;
  try {
    delete process.env.ALERT_EMAIL;
    delete process.env.PLATFORM_ADMIN_EMAIL;
    assert.match(watch.bootLine(),
      /alerting is OFF — neither ALERT_EMAIL nor PLATFORM_ADMIN_EMAIL is set/,
      'a watchdog nobody knows is switched off is worse than no watchdog,'
      + ' because somebody believes in it');
    assert.match(watch.bootLine(), /\/metrics still counts/,
      'and says what IS still happening');
  } finally {
    if (keep === undefined) delete process.env.ALERT_EMAIL;
    else process.env.ALERT_EMAIL = keep;
    if (keepAdmin === undefined) delete process.env.PLATFORM_ADMIN_EMAIL;
    else process.env.PLATFORM_ADMIN_EMAIL = keepAdmin;
  }
});

/* AN INSTALL THAT NAMED THE PERSON WHO RUNS IT HAS NAMED WHO TO WAKE.
   PLATFORM_ADMIN_EMAIL already carries that address — it seeds the platform
   admin — so an install with a watchdog and no ALERT_EMAIL was one variable
   away from telling nobody, and the obvious workaround makes it worse:
   ALERT_EMAIL=${{PLATFORM_ADMIN_EMAIL}} boots as UNSET, because the platform
   resolves an unknown same-service reference to an empty string rather than
   leaving the literal. Measured on the live install, twice. */
test('the platform admin is who to tell when nobody else is named', () => {
  const keep = process.env.ALERT_EMAIL, keepAdmin = process.env.PLATFORM_ADMIN_EMAIL;
  const keepKey = process.env.RESEND_API_KEY, keepFrom = process.env.EMAIL_FROM;
  // A transport, so the boot line gets past "nothing to send with" and reaches
  // the half this test is about: who it would send TO.
  process.env.RESEND_API_KEY = 're_not_a_real_key';
  process.env.EMAIL_FROM = 'KashikeyoPOS <hello@example.mv>';
  require('../src/email')._reset();
  try {
    delete process.env.ALERT_EMAIL;
    process.env.PLATFORM_ADMIN_EMAIL = 'runs-this@example.mv';
    assert.doesNotMatch(String(watch.why() || ''), /nobody to tell/,
      'there IS somebody to tell, and this install already named them');
    assert.match(watch.bootLine(), /alerting to runs-this@example\.mv \(PLATFORM_ADMIN_EMAIL\)/,
      'and the boot line names WHICH variable it read, because that is the'
      + ' first thing an operator asks');

    // Explicit always wins: an install wanting alerts elsewhere says so.
    process.env.ALERT_EMAIL = 'oncall@example.mv';
    assert.match(watch.bootLine(), /alerting to oncall@example\.mv \(ALERT_EMAIL\)/);

    // And the dangling-reference guard covers the fallback too.
    delete process.env.ALERT_EMAIL;
    process.env.PLATFORM_ADMIN_EMAIL = '${{other.PLATFORM_ADMIN_EMAIL}}';
    assert.match(watch.why(), /PLATFORM_ADMIN_EMAIL is an unresolved platform reference/,
      'a literal that survived is named as one, whichever variable held it');
  } finally {
    if (keep === undefined) delete process.env.ALERT_EMAIL;
    else process.env.ALERT_EMAIL = keep;
    if (keepAdmin === undefined) delete process.env.PLATFORM_ADMIN_EMAIL;
    else process.env.PLATFORM_ADMIN_EMAIL = keepAdmin;
    if (keepKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = keepKey;
    if (keepFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = keepFrom;
    require('../src/email')._reset();
  }
});

/* A DANGLING ${{reference}} IS NOT AN ADDRESS, and this is the third place
   that trap has been laid. Railway lets a variable be written as a reference
   to another service's; where the name inside the braces is wrong the literal
   survives — non-empty, truthy, no complaint. src/email.js learned it about a
   key and panel/railway.js about a handover. Here it buys the worst version:
   a watchdog reporting itself ON, addressed to a string no mail provider will
   accept, telling nobody. Off and saying so is strictly better. */
test('an alert address that is a dangling reference is no address at all', () => {
  const keep = process.env.ALERT_EMAIL;
  try {
    process.env.ALERT_EMAIL = '${{elsewhere.SOME_ADDRESS}}';
    assert.strictEqual(watch.configured(), false,
      'a reference that did not resolve is not somebody to tell');
    assert.match(watch.why(), /ALERT_EMAIL is an unresolved platform reference/,
      'and it is named as that, not as "not set" — one is a five-second fix'
      + ' inside the braces, the other is looking for a variable that is there');
    assert.match(watch.bootLine(), /alerting is OFF/,
      'so the boot line says off, which is the true half');

    // A real address is a real address: whatever else is unconfigured here,
    // ALERT_EMAIL stops being the reason.
    process.env.ALERT_EMAIL = 'ops@example.mv';
    assert.doesNotMatch(String(watch.why()), /ALERT_EMAIL/,
      'the complaint moves on to whatever is actually still missing');
  } finally {
    if (keep === undefined) delete process.env.ALERT_EMAIL;
    else process.env.ALERT_EMAIL = keep;
  }
});

/* A DEVICE THAT HAS NEVER PUSHED IS NOT A DEVICE THAT HAS STOPPED.

   Found by auditing a real store's first hour. The probe's predicate was
   `last_push_at IS NULL OR last_push_at < now() - interval`, and the NULL half
   fires the instant a till first signs in — so the only terminal on every
   brand-new store was reported as having gone quiet before anybody had rung a
   thing, and every newly enrolled till after that.

   A warning that fires on every new install is one nobody reads by the second
   one. Same rule the printers already get, and the same rule the tax sweep
   keeps: flag a wrong figure, never the absence of one. */
/* A DATABASE THAT WILL NOT OPEN IS NOT AN OUTLET THAT WILL NOT SERVE, and the
   difference is which remedy to run. They were one message under one remedy —
   "npm run provision:outlet -- --all" — which recreates login roles and cannot
   do a thing about a missing database. Found by auditing a real store: the
   local registry held four businesses whose databases had been dropped, and
   /readyz reported them as four unreachable OUTLETS with that remedy attached. */
test('a missing database and a refused outlet are two pages, not one', async () => {
  reset();
  const lines = await capture(() => watch.sweep(Object.assign({}, clear, {
    readiness: async () => ({ outlets: 2,
      unreachable: [{ outlet: 7, error: 'role "outlet_7_app" does not exist' }],
      businesses: [{ db: 'kashikeyo_biz_4', error: 'database "kashikeyo_biz_4" does not exist' }] })
  })));
  const all = lines.join('\n');

  assert.match(all, /1 business database\(s\) cannot be opened/);
  assert.match(all, /1 of 2 outlet\(s\) cannot be reached/);
  assert.match(all, /kashikeyo_biz_4 — database "kashikeyo_biz_4" does not exist/);
  assert.match(all, /outlet 7 — role "outlet_7_app" does not exist/);

  assert.match(all, /Recreating login roles does nothing for this one/,
    'the database half says so, rather than pointing at the role remedy');
  assert.match(all, /provision:outlet -- --all/,
    'and the outlet half still carries the remedy that does fit it');
});

test('the quiet-device probe measures from when a device started owing pushes', () => {
  const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const probe = SRV.slice(SRV.indexOf('async function quietDevices'),
    SRV.indexOf('async function pruneHistory'));
  assert.ok(probe.length > 200, 'found quietDevices()');

  assert.ok(!/last_push_at IS NULL OR/.test(probe),
    'a device that has never pushed no longer counts as one that has stopped');
  assert.match(probe, /coalesce\(last_push_at, paired_at, last_seen\)/,
    'the clock starts when it paired, or failing that when it was first seen');
  assert.match(probe, /kind NOT IN \('printer','display'\)/,
    'and printers and displays never push, so they are still never counted');
});

/* And the message says WHICH silence it is, because they need different
   answers: a till that delivered an hour ago and stopped is a link that has
   just died; one that has never delivered at all may never have been able to. */
test('the alert distinguishes never-delivered from stopped-delivering', () => {
  const out = [];
  const was = console.error;
  console.error = (...a) => out.push(a.join(' '));
  return Promise.resolve()
    .then(() => {
      reset();
      return watch.sweep(Object.assign({}, clear, {
        quietDevices: async () => ([
          { db: 'biz_1', outlet: 1, name: 'Counter till', mins: 214 },
          { db: 'biz_1', outlet: 1, name: 'New till', mins: null, since: 95 }
        ])
      }));
    })
    .finally(() => { console.error = was; })
    .then(() => {
      const all = out.join('\n');
      assert.match(all, /Counter till — last delivered 214 minutes ago/);
      assert.match(all, /New till — has NEVER delivered a push, and has been up 95 minutes/,
        'never-delivered is named as that, with how long it has had the chance');
    });
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

/* A REGISTRY THAT HAS LOST ITS BUSINESSES READS AS PERFECTLY HEALTHY.

   Found during the restore drill: with the registry dropped and not yet
   restored, /readyz answered 200 and the sweep said nothing. No businesses
   means no outlets, no outlets means none unreachable, and "nothing to check"
   is indistinguishable from "everything is fine".

   "No outlets is not a failure" is deliberate — that is a fresh install on its
   way to onboarding, and a probe that never goes green there is an install
   nobody can set up. What it cannot see is whether this install USED to have
   customers. The process remembers. */
test('outlets that vanish are a catastrophe, not a fresh install', async () => {
  reset();
  const some = Object.assign({}, clear,
    { readiness: async () => ({ outlets: 4, unreachable: [], businesses: [] }) });
  const none = Object.assign({}, clear,
    { readiness: async () => ({ outlets: 0, unreachable: [], businesses: [] }) });

  // A genuinely fresh install: none, and never any. Silence is right.
  assert.deepStrictEqual(await capture(() => watch.sweep(none)), [],
    'an install that has never had an outlet is onboarding, not broken');

  await capture(() => watch.sweep(some));           // now it has customers
  const lost = await capture(() => watch.sweep(none));
  assert.match(lost.join('\n'), /\[alert\] new · vanished/,
    'from some to none is a registry that has lost its businesses');
  assert.match(lost.join('\n'), /has served 4 outlet\(s\) and now finds none/);
  assert.match(lost.join('\n'), /CONTROL_DB/, 'and names where to look first');

  const back = await capture(() => watch.sweep(some));
  assert.match(back.join('\n'), /RECOVERED — the outlets are back/);
});

/* ═══ A BACKUP SYSTEM NOBODY WATCHES ════════════════════════════════════════
   The same defect class as a screen that reports an action it did not take:
   an install believing it is protected because something is scheduled. It is
   silent by construction — nothing goes wrong on the night a dump fails, only
   on the day somebody needs it. */
test('a stale backup fires, and names what is wrong and what to run', async () => {
  reset();
  const lines = await capture(() => watch.sweep(broken));
  const all = lines.join('\n');
  assert.match(all, /\[alert\] new · backups/);
  assert.match(all, /91h old/, 'it says how stale, not just that it is');
  assert.match(all, /s3:\/\/shelf\/kashikeyo/,
    'and where the copies were supposed to be landing');
  assert.match(all, /2 of the last runs failed/,
    'plus the failures behind it, which is usually the actual cause');
  assert.match(all, /pg_dump exited 1/, 'in the words the run itself gave');
  assert.match(all, /npm run backup -- --check/,
    'and the command that answers it, because an alert without a remedy leaves'
    + ' whoever reads it where they were');
  assert.match(all, /What is lost is the ability to go back/,
    'and it is honest about the stake: nothing has been lost YET');
});

test('an install that has never completed one is told so in those words', async () => {
  reset();
  const never = Object.assign({}, clear, {
    backups: async () => ({ configured: true, where: 'file:/srv/backups',
      windowHours: 48, ageHours: null, recentFailures: 0, lastWhy: null })
  });
  const all = (await capture(() => watch.sweep(never))).join('\n');
  assert.match(all, /no backup has ever completed on this install/,
    '"never" and "stale" need different answers — one is a broken schedule,'
    + ' the other is a schedule that was never configured to work');
});

/* AND AN INSTALL THAT CHOSE NOT TO HAVE THEM IS NOT PAGED ABOUT ITS OWN
   DECISION. The boot line says it, the Settings card says it; an alert every
   six hours on top of that is how an alert channel gets muted, and then the
   message that matters arrives in a folder. */
test('with no destination configured the watchdog stays silent about backups',
  async () => {
    reset();
    const none = Object.assign({}, clear, {
      backups: async () => ({ configured: false, where: null, windowHours: 48,
        ageHours: null, recentFailures: 0, lastWhy: null })
    });
    const lines = await capture(() => watch.sweep(none));
    assert.deepStrictEqual(lines, [],
      'an install with no backup destination has made a choice, and being'
      + ' paged about it every six hours is not news');
  });

test('the backup age reaches /metrics, with -1 for never', async () => {
  const withAge = watch.render({ ready: 1, outlets: 4, backupAgeHours: 3.25 });
  assert.match(withAge, /kpos_backup_age_hours 3\.25/);
  const never = watch.render({ ready: 1, outlets: 4, backupAgeHours: null });
  assert.match(never, /kpos_backup_age_hours -1/,
    '0 hours old is the HEALTHIEST possible answer, so it cannot also mean'
    + ' "never" — a gauge that reports the worst state as the best one is'
    + ' worse than no gauge');
  const off = watch.render({ ready: 1, outlets: 4 });
  assert.doesNotMatch(off, /kpos_backup_age_hours/,
    'and an install with no destination emits no series at all rather than a'
    + ' permanently -1 one somebody will end up silencing');
});
