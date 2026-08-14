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

const ROOT = path.join(__dirname, '..', '..');          // platform/

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
