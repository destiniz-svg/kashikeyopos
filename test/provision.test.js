'use strict';
/* ═══ PROVISIONING, EXERCISED WITHOUT SPENDING MONEY ════════════════════════
   panel/railway.js creates real infrastructure, so the one thing these tests
   must not do is call it for real. What they CAN do — and what actually
   carries the risk — is everything either side of the wire: which mutations
   are sent, in what order, with what variables; what happens when step four
   refuses; whether a partial run names what it made; whether rollback fires
   only for a project this run created.

   `fetch` is stubbed, so every assertion below is about the request this
   module composes and the decision it makes with the answer. The live call
   path is stated as unverified in DEPLOYMENT.md rather than implied by a
   green suite here — a test that mocks the network proves composition, never
   connectivity, and pretending otherwise is the exact class of defect this
   codebase keeps closing.
   ═══════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');

const RW = require('../panel/railway');

/* ── the stub ────────────────────────────────────────────────────────────── */

// Every call records the operation name and its variables, and answers with
// whatever the script says. An unscripted call is a test bug, and says so.
function stub(script) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const op = (/(?:mutation|query)\s+(\w+)/.exec(body.query) || [])[1] || '?';
    calls.push({ op: op, vars: body.variables, auth: opts.headers.authorization, url: url });
    const step = script[op];
    if (step === undefined) throw new Error('unscripted call: ' + op);
    const answer = typeof step === 'function' ? step(calls.filter((c) => c.op === op).length) : step;
    if (answer && answer.__errors) {
      return { status: 200, ok: true, headers: new Map(),
        text: async () => JSON.stringify({ errors: answer.__errors }) };
    }
    if (answer && answer.__status) {
      return { status: answer.__status, ok: false, headers: { get: () => null },
        text: async () => JSON.stringify({ data: null }) };
    }
    return { status: 200, ok: true, headers: { get: () => null },
      text: async () => JSON.stringify({ data: answer }) };
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

// A whole happy run, with the waits collapsed so the suite does not sleep.
function happy(over) {
  return Object.assign({
    projectCreate: { projectCreate: { id: 'prj_1',
      environments: { edges: [{ node: { id: 'env_1', name: 'production' } }] } } },
    serviceCreate: (n) => ({ serviceCreate: { id: n === 1 ? 'svc_pg' : 'svc_app',
      name: n === 1 ? 'Postgres' : 'kashikeyopos' } }),
    volumeCreate: { volumeCreate: { id: 'vol_1' } },
    variables: { variables: { DATABASE_URL: 'postgres://x' } },
    serviceDomainCreate: { serviceDomainCreate: { id: 'dom_1', domain: 'store.up.railway.app' } },
    serviceInstanceUpdate: { serviceInstanceUpdate: true },
    variableCollectionUpsert: { variableCollectionUpsert: true },
    serviceInstanceDeployV2: { serviceInstanceDeployV2: 'dep_1' },
    deployments: { deployments: { edges: [{ node: { id: 'dep_1', status: 'SUCCESS' } }] } },
    projectDelete: { projectDelete: true }
  }, over || {});
}

const NOWAIT = { wait: (fn) => fn(), now: () => 0 };

function withEnv(vars, fn) {
  const before = {};
  Object.keys(vars).forEach((k) => { before[k] = process.env[k]; process.env[k] = vars[k]; });
  return Promise.resolve().then(fn).finally(() => {
    Object.keys(before).forEach((k) => {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    });
  });
}

const ENV = { RAILWAY_API_TOKEN: 'tok_test_value', INSTALL_REPO: 'owner/repo' };

/* ── the gate ────────────────────────────────────────────────────────────── */

test('the automated path is off until it is configured, and says which piece is missing', () =>
  withEnv({ RAILWAY_API_TOKEN: '', INSTALL_REPO: '' }, () => {
    const a = RW.ready();
    assert.strictEqual(a.ok, false);
    assert.match(a.why, /RAILWAY_API_TOKEN/, 'names the variable, not "unavailable"');
    return withEnv({ RAILWAY_API_TOKEN: 'tok', INSTALL_REPO: '' }, () => {
      const b = RW.ready();
      assert.strictEqual(b.ok, false);
      assert.match(b.why, /INSTALL_REPO/, 'and names the next one once the first is set');
      assert.match(b.why, /owner\/name/, 'with the shape it expects');
    });
  }));

/* ── the secrets ─────────────────────────────────────────────────────────── */

test('every install gets its own secrets, and the three are three', () => {
  const a = RW.mintSecrets(), b = RW.mintSecrets();
  ['OUTLET_ROLE_SECRET', 'SESSION_SECRET', 'PORTAL_SECRET', 'PLATFORM_KEY']
    .forEach((k) => {
      assert.ok(a[k].length >= 32, k + ' is at least 32 characters');
      assert.notStrictEqual(a[k], b[k], k + ' differs between installs');
    });
  // The whole point of generating them: "three different values" is the
  // discipline a human under time pressure quietly abandons.
  const three = new Set([a.OUTLET_ROLE_SECRET, a.SESSION_SECRET, a.PORTAL_SECRET]);
  assert.strictEqual(three.size, 3, 'a leak of one must not mint the others');
  assert.ok(a.ONBOARDING_CLAIM_TOKEN.length >= 8, 'the setup code is typed by a person');
  assert.ok(!/[^A-Za-z0-9_-]/.test(a.ONBOARDING_CLAIM_TOKEN), 'and read aloud, so no punctuation');
});

test('the app is handed a reference to the database, never a password', () => {
  const v = RW.appVariables(RW.mintSecrets());
  assert.strictEqual(v.DATABASE_URL, '${{Postgres.DATABASE_URL}}',
    'Railway resolves this at deploy time, so the app config holds no credential');
  assert.ok(!/postgres:\/\/[^$]/.test(JSON.stringify(v)),
    'and no literal connection string anywhere');
});

/* THE CORRECTION THE THROWAWAY REHEARSAL FORCED.

   This module first assumed Railway's Postgres image publishes DATABASE_URL by
   itself. It does not. A service created bare from
   ghcr.io/railwayapp-templates/postgres-ssl:18 comes up with ONLY Railway's own
   injected variables — RAILWAY_ENVIRONMENT, RAILWAY_PRIVATE_DOMAIN and their
   siblings. DATABASE_URL, POSTGRES_USER, POSTGRES_PASSWORD and PGDATA all come
   from the TEMPLATE. Verified on a disposable project against the real API:
   every provisioning run would otherwise have polled three minutes at step four
   and failed, and nothing in a stubbed suite could have found it. */
test('the database is created with the template wiring the image does not carry', () => {
  const secrets = RW.mintSecrets();
  const v = RW.pgVariables(secrets);

  // The four the image does not set, and without which nothing downstream works.
  assert.strictEqual(v.POSTGRES_USER, 'postgres');
  assert.strictEqual(v.POSTGRES_DB, 'railway');
  assert.strictEqual(v.POSTGRES_PASSWORD, secrets.POSTGRES_PASSWORD);
  assert.match(v.DATABASE_URL, /^postgresql:\/\/\$\{\{PGUSER\}\}/,
    'composed from references, so Railway resolves it rather than this process');

  /* PGDATA is a SUBDIRECTORY of the mount. initdb refuses a data directory that
     is not empty, and a mounted volume already has lost+found — pointing PGDATA
     at the mount itself is the classic way to get a Postgres that never boots. */
  assert.strictEqual(v.PGDATA, '/var/lib/postgresql/data/pgdata');
  assert.ok(v.PGDATA.startsWith(RW._internal.PG_MOUNT + '/'),
    'inside the volume, not at its root');

  // URL-safe, so DATABASE_URL composes without escaping.
  assert.ok(!/[^A-Za-z0-9_-]/.test(secrets.POSTGRES_PASSWORD),
    'a password with punctuation would break the connection string it rides in');
  assert.ok(secrets.POSTGRES_PASSWORD.length >= 20);
});

/* AN INSTALL WITH NO EMAIL IS AN INSTALL NOBODY CAN CLAIM.

   The first live run provisioned successfully and the customer still could not
   sign up: appVariables() carried no transport, so src/email.js took its
   "not configured" path, wrote the verification code to the audit trail and
   said so. Everything behaved exactly as designed and the outcome was a dead
   end — the account plane is how an install is claimed, and it is reached by
   email. Confirmed from the other side too: nothing arrived at Resend that
   day, because nothing was ever sent. */
test('an install inherits an email transport, or it cannot be claimed', () =>
  withEnv(Object.assign({}, ENV, {
    RESEND_API_KEY: 're_seller_key', EMAIL_FROM: 'KashikeyoPOS <no-reply@example.com>'
  }), () => {
    const v = RW.appVariables(RW.mintSecrets());
    assert.strictEqual(v.RESEND_API_KEY, 're_seller_key');
    assert.strictEqual(v.EMAIL_FROM, 'KashikeyoPOS <no-reply@example.com>');
  }));

test('a panel with no transport says so before the run, not after', () =>
  withEnv(Object.assign({}, ENV, { RESEND_API_KEY: '', EMAIL_FROM: '' }), () => {
    const g = RW.ready();
    // Still allowed — an install with no email works, its customer just has to
    // be read the code. But it is named up front rather than discovered.
    assert.strictEqual(g.ok, true, 'not a refusal');
    assert.match(g.warn, /RESEND_API_KEY/, 'and the gap is named');
    const v = RW.appVariables(RW.mintSecrets());
    assert.ok(!('RESEND_API_KEY' in v),
      'half a transport is worse than none — an empty key reads as configured');
  }));

/* A RAILWAY HOSTNAME HAS NO WILDCARD, so `<handle>.<that host>` resolves
   nowhere. Left unset, src/handle.js inherits the apex from PUBLIC_URL and
   hands out QR addresses that answer nothing — printed onto table cards before
   anyone scans one. Explicitly EMPTY is the meaningful value: subdomains off,
   path forms on, and those do resolve. */
test('a provisioned install is told which address form actually resolves', () =>
  withEnv(ENV, () => {
    const v = RW.appVariables(RW.mintSecrets());
    assert.ok('PORTAL_BASE_DOMAIN' in v, 'set, because unset means "inherit the apex"');
    assert.strictEqual(v.PORTAL_BASE_DOMAIN, '', 'and empty means "use the path forms"');
    return withEnv({ INSTALL_PORTAL_BASE_DOMAIN: 'kashikeyopos.com' }, () => {
      assert.strictEqual(RW.appVariables(RW.mintSecrets()).PORTAL_BASE_DOMAIN,
        'kashikeyopos.com', 'and a real wildcard domain is honoured once there is one');
    });
  }));

/* THE SERVICE NAME BECOMES THE HOSTNAME, so it is the store's, not the
   product's. Every install was called `kashikeyopos`, so every address came out
   `kashikeyopos-production.up.railway.app` — indistinguishable between
   customers, and Railway suffixes once they collide. */
test('the store names its own address', () => {
  assert.strictEqual(RW.slug('Kanamadhu Cafe'), 'kanamadhu-cafe');
  assert.strictEqual(RW.slug("Sephora Cafe'"), 'sephora-cafe', 'punctuation is dropped');
  assert.strictEqual(RW.slug('  --Reef & Palm--  '), 'reef-palm', 'and never leads or trails');
  assert.strictEqual(RW.slug('ދިވެހި'), 'kashikeyopos',
    'a name with no latin letters still needs a hostname');
  assert.ok(RW.slug('x'.repeat(80)).length <= 40);
  assert.ok(!/^-|-$/.test(RW.slug('!!!Cafe!!!')));
});

test('the app service is named after the store, not the product', () =>
  withEnv(ENV, async () => {
    const s = stub(happy());
    try {
      await RW.provision(Object.assign({ name: 'Kanamadhu Cafe' }, NOWAIT));
      const app = s.calls.filter((c) => c.op === 'serviceCreate')[1];
      assert.strictEqual(app.vars.input.name, 'kanamadhu-cafe');
    } finally { s.restore(); }
  }));

/* ── the happy path ──────────────────────────────────────────────────────── */

test('one run creates the project, database, disk, app, domain and deploy — in that order', () =>
  withEnv(ENV, async () => {
    const s = stub(happy());
    try {
      const out = await RW.provision(Object.assign({ name: 'Kanamadhu Cafe' }, NOWAIT));
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.baseUrl, 'https://store.up.railway.app');

      const order = s.calls.map((c) => c.op);
      assert.deepStrictEqual(
        order.filter((o) => ['projectCreate', 'serviceCreate', 'volumeCreate',
          'serviceDomainCreate', 'serviceInstanceDeployV2'].includes(o)),
        ['projectCreate', 'serviceCreate', 'volumeCreate', 'serviceCreate',
          'serviceDomainCreate', 'serviceInstanceDeployV2'],
        'the database exists before the app that references it');

      // Everything it made is named, so nothing can be orphaned unnoticed.
      assert.deepStrictEqual(
        { p: out.made.projectId, pg: out.made.pgServiceId, app: out.made.appServiceId,
          vol: out.made.volumeId, dom: out.made.domain },
        { p: 'prj_1', pg: 'svc_pg', app: 'svc_app', vol: 'vol_1',
          dom: 'store.up.railway.app' });
    } finally { s.restore(); }
  }));

test('the app service is created WITH its secrets, not bare and patched after', () =>
  withEnv(ENV, async () => {
    const s = stub(happy());
    try {
      await RW.provision(Object.assign({ name: 'Store' }, NOWAIT));
      const pg = s.calls.filter((c) => c.op === 'serviceCreate')[0];
      assert.ok(pg.vars.input.variables && pg.vars.input.variables.DATABASE_URL,
        'the database is created WITH its wiring — the image carries none');
      const app = s.calls.filter((c) => c.op === 'serviceCreate')[1];
      const v = app.vars.input.variables;
      /* The app refuses to migrate without its secrets and in production exits
         rather than serve on a half-built schema — correct behaviour that
         would look exactly like a provisioning bug if the first build ran
         without them. */
      ['OUTLET_ROLE_SECRET', 'SESSION_SECRET', 'PORTAL_SECRET', 'PLATFORM_KEY',
        'ONBOARDING_CLAIM_TOKEN', 'DATABASE_URL'].forEach((k) =>
        assert.ok(v[k], 'the first build already has ' + k));
      assert.strictEqual(app.vars.input.source.repo, 'owner/repo');
      assert.strictEqual(app.vars.input.branch, 'main');
    } finally { s.restore(); }
  }));

test('the health check is /readyz, and the public URL waits for the domain', () =>
  withEnv(ENV, async () => {
    const s = stub(happy());
    try {
      await RW.provision(Object.assign({ name: 'Store' }, NOWAIT));
      const upd = s.calls.find((c) => c.op === 'serviceInstanceUpdate');
      assert.strictEqual(upd.vars.input.healthcheckPath, '/readyz',
        'the probe that detects an install which cannot serve an outlet request');

      const pub = s.calls.find((c) => c.op === 'variableCollectionUpsert');
      assert.strictEqual(pub.vars.input.variables.PUBLIC_URL, 'https://store.up.railway.app');
      /* PUBLIC_URL is the one place the build learns its own hostname, so it
         cannot be set before the domain exists. */
      assert.ok(s.calls.indexOf(pub) > s.calls.findIndex((c) => c.op === 'serviceDomainCreate'),
        'and it is set after the domain, never guessed before it');
    } finally { s.restore(); }
  }));

test('it waits for the database to publish its address before building the app', () =>
  withEnv(ENV, async () => {
    let asked = 0;
    const s = stub(happy({
      // Empty twice, then wired — the ordinary case, since a fresh Postgres
      // takes a moment to compose DATABASE_URL.
      variables: () => (++asked < 3 ? { variables: {} } : { variables: { DATABASE_URL: 'x' } })
    }));
    try {
      await RW.provision(Object.assign({ name: 'Store' }, NOWAIT));
      assert.strictEqual(asked, 3, 'it polled rather than assumed');
      const firstApp = s.calls.findIndex((c) => c.op === 'serviceCreate' && c.vars.input.source.repo);
      const lastVar = s.calls.map((c) => c.op).lastIndexOf('variables');
      assert.ok(lastVar < firstApp, 'the app is not built until the database answers');
    } finally { s.restore(); }
  }));

/* ── failure ─────────────────────────────────────────────────────────────── */

test('a partial run names the step that failed and everything it had made', () =>
  withEnv(ENV, async () => {
    const s = stub(happy({
      serviceDomainCreate: { __errors: [{ message: 'no domains left on this plan' }] }
    }));
    try {
      await assert.rejects(
        () => RW.provision(Object.assign({ name: 'Store' }, NOWAIT)),
        (e) => {
          assert.strictEqual(e.failedAt, 'domain');
          assert.match(e.message, /no domains left/, 'the reason is the outlet\'s own words');
          // What exists. The next question is always "what do I clean up".
          assert.strictEqual(e.made.projectId, 'prj_1');
          assert.strictEqual(e.made.pgServiceId, 'svc_pg');
          assert.strictEqual(e.made.appServiceId, 'svc_app');
          assert.strictEqual(e.made.domain, null, 'and what does not');
          const done = e.steps.filter((x) => x.ok).map((x) => x.key);
          assert.deepStrictEqual(done, ['project', 'database', 'volume', 'database-url', 'app']);
          return true;
        });
    } finally { s.restore(); }
  }));

test('a GraphQL refusal is an error, not a success with an errors array', () =>
  withEnv(ENV, async () => {
    // GraphQL answers 200 on a refusal, so a bare res.ok check reports success.
    const s = stub(happy({ projectCreate: { __errors: [{ message: 'Not Authorized' }] } }));
    try {
      await assert.rejects(() => RW.provision(Object.assign({ name: 'X' }, NOWAIT)),
        /Not Authorized/);
    } finally { s.restore(); }
  }));

test('a bad token is named as a bad token', () =>
  withEnv(ENV, async () => {
    const s = stub(happy({ projectCreate: { __status: 401 } }));
    try {
      await assert.rejects(() => RW.provision(Object.assign({ name: 'X' }, NOWAIT)),
        /RAILWAY_API_TOKEN/);
    } finally { s.restore(); }
  }));

test('a failed first deploy stops the run rather than waiting out the clock', () =>
  withEnv(ENV, async () => {
    const s = stub(happy({
      deployments: { deployments: { edges: [{ node: { id: 'd', status: 'FAILED' } }] } }
    }));
    try {
      await assert.rejects(
        () => RW.provision(Object.assign({ name: 'X' }, NOWAIT)),
        (e) => {
          assert.strictEqual(e.failedAt, 'live');
          assert.match(e.message, /build log/, 'and points at where the reason actually is');
          return true;
        });
    } finally { s.restore(); }
  }));

test('rollback destroys only a project this run created, and only when asked', () =>
  withEnv(ENV, async () => {
    const fail = { serviceDomainCreate: { __errors: [{ message: 'nope' }] } };

    // Not asked: nothing is destroyed, however far it got.
    let s = stub(happy(fail));
    try {
      await assert.rejects(() => RW.provision(Object.assign({ name: 'X' }, NOWAIT)));
      assert.ok(!s.calls.some((c) => c.op === 'projectDelete'),
        'a failure is never silently cleaned up under the operator');
    } finally { s.restore(); }

    // Asked: destroyed, and the error says so.
    s = stub(happy(fail));
    try {
      await assert.rejects(
        () => RW.provision(Object.assign({ name: 'X', rollback: true }, NOWAIT)),
        (e) => {
          assert.strictEqual(e.rolledBack, true);
          return true;
        });
      const del = s.calls.filter((c) => c.op === 'projectDelete');
      assert.strictEqual(del.length, 1);
      assert.strictEqual(del[0].vars.id, 'prj_1', 'the project it made, and no other');
    } finally { s.restore(); }
  }));

test('a rollback that itself fails is reported, not swallowed', () =>
  withEnv(ENV, async () => {
    const s = stub(happy({
      serviceDomainCreate: { __errors: [{ message: 'nope' }] },
      projectDelete: { __errors: [{ message: 'project is locked' }] }
    }));
    try {
      await assert.rejects(
        () => RW.provision(Object.assign({ name: 'X', rollback: true }, NOWAIT)),
        (e) => {
          assert.ok(!e.rolledBack, 'it did not roll back');
          assert.match(e.rollbackError, /locked/, 'and the operator is told why');
          return true;
        });
    } finally { s.restore(); }
  }));

/* ── the token ───────────────────────────────────────────────────────────── */

test('the token goes to Railway and nowhere else', () =>
  withEnv(ENV, async () => {
    const s = stub(happy());
    try {
      const out = await RW.provision(Object.assign({ name: 'Store' }, NOWAIT));
      s.calls.forEach((c) => {
        assert.strictEqual(c.url, 'https://backboard.railway.com/graphql/v2');
        assert.strictEqual(c.auth, 'Bearer tok_test_value');
      });
      // The result is handed to a browser. The token must not be in it.
      assert.ok(!JSON.stringify(out).includes('tok_test_value'),
        'nothing the panel returns carries the token');
    } finally { s.restore(); }
  }));

test('a run refuses before it starts when the panel is not configured for it', () =>
  withEnv({ RAILWAY_API_TOKEN: '', INSTALL_REPO: '' }, async () => {
    const s = stub({});
    try {
      await assert.rejects(() => RW.provision({ name: 'X' }), /RAILWAY_API_TOKEN/);
      assert.strictEqual(s.calls.length, 0, 'and touches nothing');
    } finally { s.restore(); }
  }));
