'use strict';
/* Can this actually be deployed?
 *
 * Every other test in this suite runs INSIDE the repository, where every path
 * resolves and every workspace is present. A container does not have the
 * repository; it has whatever the Dockerfile copied. The gap between those two
 * is invisible to a green suite, and it is where a deploy dies on boot with the
 * whole thing apparently working on a laptop.
 *
 * That is not hypothetical. `backend/railway.json` set the service root to
 * `backend/`, and `backend/src/sale.js` requires `../../packages/money/money`,
 * because there is exactly one bill calculation and both the browser and the
 * server load the same file. The container would have crashed on the first
 * require, after eleven phases of green tests.
 *
 * So this file builds the tree the Dockerfile builds, in a temporary directory,
 * and loads the server out of it. It is a slow test and it is worth it.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');          // the repository root

describe('the deployable tree', () => {
  test('the Dockerfile copies everything the server requires', () => {
    /* Read what the image actually copies rather than a list kept in step with
       it by hand — a list that can drift is the same bug one level up. */
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const copied = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+\S+$/gm)]
      .map((m) => m[1])
      .filter((p) => !p.includes('*'));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpos-deploy-'));
    try {
      for (const src of copied) {
        const from = path.join(ROOT, src);
        if (!fs.existsSync(from)) continue;
        const to = path.join(dir, src);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, { recursive: true });
      }
      // `npm ci` in the image installs these; the copy above skips them
      // because node_modules is in .dockerignore.
      fs.cpSync(path.join(ROOT, 'backend', 'node_modules'),
        path.join(dir, 'backend', 'node_modules'), { recursive: true });

      /* Load the whole request surface out of the copied tree. A missing file
         is a MODULE_NOT_FOUND at require time, which is exactly how it would
         present in the container. */
      const out = execFileSync(process.execPath, [
        '-e',
        "require('./src/routes.js'); require('./server.js');"
        // Exit as soon as the module graph has loaded. A listening socket keeps
        // the event loop alive, and what is under test is the require tree, not
        // the socket — /readyz is what proves the socket, in the container.
        + " console.log('OK'); process.exit(0);",
      ], {
        cwd: path.join(dir, 'backend'),
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production', PORT: '0' },
      });
      assert.match(out, /OK/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('nothing in the request path uses the owner connection', () => {
    /* DEPLOYMENT.md: "That connection is the owner: migrations and provisioning
       only, and src/routes.js never imports it." A promise in a document that
       nothing checks is a promise that will be broken by a hurried edit — and
       this one is the difference between an outlet role and a superuser
       answering an HTTP request.

       db.js DEFINES owner() because provisioning needs it; nothing else in src/
       may call it. */
    const src = path.join(ROOT, 'backend', 'src');
    const offenders = [];
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.js') || f === 'db.js') continue;
      const text = fs.readFileSync(path.join(src, f), 'utf8');
      if (/\bowner\s*\(/.test(text) || /require\([^)]*db[^)]*\)[^;]*owner/.test(text)) {
        offenders.push(f);
      }
    }
    assert.deepEqual(offenders, [],
      'these reach the owner pool from the request path');
  });

  test('no screen builds its API caller on every render', () => {
    /* `api.authed(session)` returns a NEW function each time it is called. A
       screen that calls it in the component body gets a fresh identity on every
       render, so a `useCallback` that closes over it changes identity too, and
       the `useEffect` that loads on that callback fires again — which renders,
       which makes another caller. An endless fetch loop.

       It is not a performance nicety. On the Settings screen it ALSO reset
       every form field between the keystroke and the save, so a changed
       service charge went to the server as its old value and the audit entry
       recorded a change of nothing. It was found in a browser check, by an
       input that came back with the value it had before it was filled — which
       is the only way a bug like this is ever visible.

       Every screen already memoised it except the four written last; this is
       the test that makes the fifth impossible. */
    const dir = path.join(ROOT, 'apps', 'pos', 'src');
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.tsx$/.test(f)) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      /* A bare `const x = api.authed(...)` or `api.chainAuthed(...)` at the top
         of a component. Inside a callback it is fine — it is created and used
         in the same turn and never lands in a dependency array. */
      if (/^\s*const\s+\w+\s*=\s*api\.(chainA|a)uthed\(/m.test(text)) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
      'these rebuild their API caller every render — wrap it in useMemo');
  });

  test('no grid can be wider than the screen it is on', () => {
    /* `minmax(260px, 1fr)` has a floor of 260px, so two columns need 520px and
       a 360px phone gets a horizontally scrolling page — the layout spills
       sideways and the right-hand edge of every card is off screen. It is the
       prototype's own fix that is enforced here: `minmax(min(100%, 260px), 1fr)`
       is identical on any screen wide enough for the card and collapses to one
       column below it.

       Thirty-four of these shipped before anybody opened the till on a phone,
       which is why this is a test and not a note. */
    const offenders = [];
    for (const app of fs.readdirSync(path.join(ROOT, 'apps'))) {
      const dir = path.join(ROOT, 'apps', app, 'src');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!/\.tsx?$/.test(f)) continue;
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        if (/minmax\(\s*\d+px\s*,/.test(text)) offenders.push(app + '/' + f);
      }
    }
    assert.deepEqual(offenders, [],
      'these pin a grid column to a fixed minimum — wrap it in min(100%, …)');
  });

  test('every module in the rail is wired to a screen', () => {
    /* The rail is the design, so a module lands in `nav.ts` the moment it is
       designed and long before it is built. `App.tsx` decides what actually
       renders through `MODULES_BUILT`, and the two are edited in different
       files at different times — so the failure mode is a nav entry that opens
       the placeholder, which reads as "not built yet" to a user looking at a
       release where it IS built and simply was not wired.

       Now that every module is built, this test is what keeps that true: add a
       module to the rail and this fails until it renders something. */
    const dir = path.join(ROOT, 'apps', 'pos', 'src');
    const nav = fs.readFileSync(path.join(dir, 'nav.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const ids = [...nav.matchAll(/\{\s*id:\s*'([a-z]+)'/g)].map((m) => m[1]);
    assert.ok(ids.length > 20, 'the rail could not be read at all');

    const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
    const set = app.match(/const MODULES_BUILT = new Set\(\[([^\]]*)\]/);
    assert.ok(set, 'MODULES_BUILT could not be read');
    const built = new Set((set[1].match(/'[a-z]+'/g) || []).map((x) => x.slice(1, -1)));

    assert.deepEqual(ids.filter((i) => !built.has(i)), [],
      'these are in the navigation rail and open the "not built" placeholder');
    /* And the reverse: a key in MODULES_BUILT that no rail entry names is a
       screen nobody can reach, which is a different kind of dead code. */
    assert.deepEqual([...built].filter((b) => !ids.includes(b)), [],
      'these are marked built but appear nowhere in the rail');
  });

  test('no screen reaches the API on a hard-coded path', () => {
    /* The front-end half of the same class of bug, and it bit just as hard:
       nine screens each wrote their own fetch('/api/...'). That resolves ONLY
       behind the Vite dev/preview proxy. Deployed, the POS is a static site on
       its own origin and the API is somewhere else, so every one of those nine
       would have 404'd on first load — and nothing would have said so, because
       the integration tests call the API directly and the browser checks all ran
       behind the proxy.

       Everything goes through api.ts, which is the one place that knows about
       VITE_API_ORIGIN. */
    const dir = path.join(ROOT, 'apps', 'pos', 'src');
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.tsx?$/.test(f) || f === 'api.ts') continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      /* Any occurrence of the literal '/api' outside a comment. The first
         version of this test looked for fetch('/api…') and missed Menu.tsx,
         which built `const base = `/api/outlet/…`` and passed it to fetch on
         another line — so the static deploy 404'd on exactly one screen. The
         string itself is the thing that must not be here. */
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      if (code.includes('/api/')) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
      'these bypass api.ts and only work behind the dev proxy');
  });

  test('a table that was already named the old way is RENAMED, not orphaned',
    async () => {
      /* src/tables.js made `T05` the one spelling, and every path that writes a
         ticket now goes through it. That alone strands a trading database: the
         rows already there say `5`, and the moment the new code looks for `T05`
         every one of them becomes invisible — open tickets orphaned mid-service
         and a guest's phone showing an empty bill for the food in front of
         them. Migration 025 moves them, and this is the test that it does.

         Run against the scratch database the twice-over test builds, so it
         exercises the migration rather than the code that would have written
         the row correctly in the first place. */
      const { Client } = require('pg');
      const name = 'scratch_tables_' + process.pid;
      const admin = new Client({ connectionString: process.env.DATABASE_URL });
      await admin.connect();
      await admin.query('DROP DATABASE IF EXISTS ' + name);
      await admin.query('CREATE DATABASE ' + name);
      await admin.end();
      try {
        const url = new URL(process.env.DATABASE_URL);
        url.pathname = '/' + name;
        const env = { ...process.env, DATABASE_URL: url.toString(), PGDATABASE: name };
        const run = (script, args) => require('node:child_process').spawnSync(
          process.execPath, [path.join(ROOT, 'backend', 'scripts', script), ...(args || [])],
          { env, encoding: 'utf8' });

        assert.equal(run('migrate.js').status, 0, 'the scratch database migrates');
        const { outletPassword } = require('../src/secrets');
        assert.equal(
          run('provision-outlet.js', ['77', 'TBL-77', 'Table Names', outletPassword(77)]).status,
          0, 'and provisions an outlet');

        const c = new Client({ connectionString: url.toString() });
        await c.connect();
        try {
          /* A ticket the old way, exactly as a database that has been trading
             holds thousands of them. */
          await c.query("INSERT INTO outlet_77.ticket (table_no, split, status, covers)"
            + " VALUES ('7',0,'open',2), ('Terrace',0,'open',4)");
          assert.equal(run('migrate.js').status, 0, 'and migrates again');

          const after = await c.query(
            'SELECT table_no FROM outlet_77.ticket ORDER BY table_no');
          assert.deepEqual(after.rows.map((r) => r.table_no), ['T07', 'Terrace'],
            'the number moved; the NAME was left alone');
        } finally { await c.end(); }
      } finally {
        const drop = new Client({ connectionString: process.env.DATABASE_URL });
        await drop.connect();
        await drop.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)').catch(() => {});
        await drop.end();
      }
    });

  test('there is ONE chart of accounts, defined once', () => {
    /* Five migrations each held a complete copy of the chart, every one a
       CREATE OR REPLACE of the same function, so only the last to run had any
       effect. Adding an account to the chart-of-accounts migration — the file
       named after the thing, the file anybody would open — did nothing at all,
       because a migration about loyalty redefined the function forty lines
       later. The account was missing from every outlet and the first posting
       that needed it died on a foreign key.

       A migration that needs a new account adds it to the one list and re-seeds
       the outlets that already exist. It does not bring its own list. */
    const dir = path.join(ROOT, 'backend', 'migrations');
    const definers = fs.readdirSync(dir).filter((f) =>
      f.endsWith('.sql')
      && /CREATE OR REPLACE FUNCTION chain\.seed_chart/.test(
        fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.deepEqual(definers, ['004_chart_seed.sql'],
      'these each define the chart of accounts; only the last one runs');
  });

  test('there is ONE journal writer, and every source it is given has a name', () => {
    /* Two things that drift together.
     *
     * journal.js calls itself "the one copy" and was not: five modules kept a
     * private insert, and they had already diverged — the one in routes.js took
     * its figures in MVR while every other path in the build takes laari, so a
     * journal queued during an outage would have posted a hundredth of the
     * money and balanced, which is the kind of wrong nothing objects to.
     *
     * And the ledger screen turns a source into a sentence. A module that adds
     * a new one without adding its label shows an operator the word `opcosts`,
     * which means something to whoever wrote the code and nothing to anybody
     * reading the books. */
    const dir = path.join(ROOT, 'backend', 'src');
    const writers = [];
    const sources = new Set();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      if (f !== 'journal.js' && /INSERT INTO journal\s/.test(text)) writers.push(f);
      for (const m of text.matchAll(/source: '([a-z_]+)'/g)) sources.add(m[1]);
    }
    assert.deepEqual(writers, [], 'these write journals without journal.js');

    const screen = fs.readFileSync(
      path.join(ROOT, 'apps', 'pos', 'src', 'Accounting.tsx'), 'utf8');
    const labelled = new Set(
      [...screen.matchAll(/^\s{2}([a-z_]+): '/gm)].map((m) => m[1]));
    const unlabelled = [...sources].filter((s) => !labelled.has(s)).sort();
    assert.deepEqual(unlabelled, [], 'these post to the ledger with no name on the screen');
  });

  test('the gate typechecks EVERY front end, not just the one it started with', () => {
    /* `npm run lint` was `npm -w @kashikeyo/pos run typecheck` and nothing else,
       so the guest portal — the half a customer actually holds — was typechecked
       only by `vite build`, which nobody runs before committing. A type error
       there passed the gate green and would have been found by a guest.

       Any app that can be typechecked must be in the one command the checklist
       names. */
    const lint = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      .scripts.lint;
    const missing = [];
    for (const app of fs.readdirSync(path.join(ROOT, 'apps'))) {
      const pkgPath = path.join(ROOT, 'apps', app, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkg.scripts || !pkg.scripts.typecheck) { missing.push(app + ': no typecheck script'); continue; }
      if (!lint.includes(pkg.name)) missing.push(app + ': typechecks, but lint never calls it');
    }
    assert.deepEqual(missing, [], 'these are not covered by `npm run lint`');
  });

  test('every migration survives being run TWICE, because every boot runs them all',
    async () => {
      /* migrate.js has no lock table and no applied-migrations ledger: it runs
         the whole directory on every boot, by design, and the comment at the
         top of it promises every migration is `IF NOT EXISTS` or
         `CREATE OR REPLACE`. Nothing checked that promise.

         A bare `ALTER TABLE ... ADD CONSTRAINT` shipped in 019 and broke it.
         The first deploy was clean and the SECOND died before the server ever
         listened — the worst possible shape for a failure, because it passes
         every test on a fresh database and every fresh database is what a test
         uses.

         So: run the lot, then run the lot again, against a scratch database. */
      const { Client } = require('pg');
      const { execFileSync } = require('node:child_process');
      const name = 'kpos_twice_' + process.pid;
      const admin = new Client({ connectionString: process.env.DATABASE_URL });
      await admin.connect();
      try {
        await admin.query('DROP DATABASE IF EXISTS ' + name);
        await admin.query('CREATE DATABASE ' + name);
      } finally { await admin.end().catch(() => {}); }

      const url = String(process.env.DATABASE_URL).replace(/\/[^/]*$/, '/' + name);
      const env = { ...process.env, DATABASE_URL: url, PGDATABASE: name };
      const run = () => execFileSync(
        process.execPath, [path.join(ROOT, 'backend', 'scripts', 'migrate.js')],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

      try {
        run();
        run();                       // ← the second deploy
      } finally {
        const drop = new Client({ connectionString: process.env.DATABASE_URL });
        await drop.connect();
        try { await drop.query('DROP DATABASE IF EXISTS ' + name); }
        finally { await drop.end().catch(() => {}); }
      }
    });

  test('a rank gate with a name that is not in the ladder REFUSES TO EXIST', () => {
    /* `RANK[name]` for a name outside the ladder is undefined, and
       `anything < undefined` is false — so a gate written as atLeast('cashier'),
       when the ladder calls that rank `till`, let everyone through: a kitchen
       hand, and a rank-0 guest token too. It reads as the strictest line in the
       file and enforces nothing.

       It throws at require time now, which is server boot, which is the deploy. */
    const { atLeast, RANK } = require('../src/auth');
    assert.throws(() => atLeast('cashier'), /no such rank/);
    assert.throws(() => atLeast('supervisor'), /no such rank/);
    assert.throws(() => atLeast(undefined), /no such rank/);
    for (const name of Object.keys(RANK)) {
      assert.equal(typeof atLeast(name), 'function', name + ' is a real rank');
    }
  });

  test('the CORS allow-list answers a browser, including the wildcard', () => {
    /* Deployed, the POS is a static site on a DIFFERENT ORIGIN from the API, so
       every call it makes is cross-origin and CORS is load-bearing. Nothing else
       in this suite exercises it: the integration tests are server-to-server and
       send no Origin at all, so the header they never ask for is a header they
       can never miss.

       And the value that failed was the obvious one. `ALLOWED_ORIGINS=*` — how
       anybody writes "allow everything" — matched no origin, so no header went
       out and the browser blocked every request, while leaving the variable
       UNSET allowed everything. Exactly backwards, and visible only in a browser
       console. */
    // The shipped decision itself, not a retyped copy of it.
    const { allowOrigin } = require('../src/cors');
    const cases = [
      { value: '', origin: 'http://a.example', allowed: true, why: 'unset allows any origin' },
      { value: '*', origin: 'http://a.example', allowed: true, why: 'so does the wildcard' },
      { value: 'http://a.example', origin: 'http://a.example', allowed: true, why: 'a listed origin' },
      { value: 'http://a.example', origin: 'http://b.example', allowed: false, why: 'an unlisted one' },
      { value: 'http://a.example,*', origin: 'http://b.example', allowed: true, why: 'a wildcard among names still means any' },
    ];
    for (const c of cases) {
      const header = allowOrigin(c.value, c.origin);
      assert.equal(header === c.origin, c.allowed, c.why + ' (' + JSON.stringify(c.value) + ')');
    }
    // No Origin at all is not a browser, and gets no header either way.
    assert.equal(allowOrigin('*', undefined), null);
  });

  test('every environment variable the runbook promises is read somewhere', () => {
    /* The other direction of the same drift: a variable documented in
       .env.example that no code reads is a variable an operator will set,
       believe in, and be wrong about. */
    const example = fs.readFileSync(path.join(ROOT, 'backend', '.env.example'), 'utf8');
    const declared = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
    assert.ok(declared.length > 5, 'the example file still lists variables');

    let code = '';
    for (const dir of ['src', 'scripts']) {
      const d = path.join(ROOT, 'backend', dir);
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.js')) code += fs.readFileSync(path.join(d, f), 'utf8');
      }
    }
    code += fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');

    /* DATABASE_URL and the PG* family are read by `pg` itself from the
       environment, not by our code, so they are exempt by name rather than by
       accident. */
    const viaDriver = new Set(['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE',
      'PGUSER', 'PGPASSWORD']);
    const unread = declared.filter((v) => !viaDriver.has(v) && !code.includes(v));
    assert.deepEqual(unread, [], 'documented but never read');
  });
});
