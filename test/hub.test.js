'use strict';
/* The store hub (BUILD-PLAN 2.5a), driven against a stand-in cloud: the hub
   forwards what a device sends, byte for byte and token for token, streams
   the sync stream as it comes, and asks the cloud before it dials a printer. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const seen = [];
const cloud = http.createServer(function (req, res) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', function () {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization,
      host: req.headers.host, body });
    const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/healthz') return json(200, { ok: true });
    if (req.url === '/api/outlet/1/sync/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.write('data: changed 5\n\n');         // and stays open
    }
    if (req.url === '/api/outlet/1/print' && req.method === 'GET') {
      return req.headers.authorization === 'Bearer good'
        ? json(200, { ok: true }) : json(403, { error: 'kitchen or above' });
    }
    json(200, { echoed: true });
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kpos-hub-'));
const HELD = path.join(DATA, 'held.jsonl');
const heldLines = () => (fs.existsSync(HELD) ? fs.readFileSync(HELD, 'utf8').split('\n').filter(Boolean) : []);

let hub, base, up, cloudPort;
test.before(async function () {
  await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
  cloudPort = cloud.address().port;
  up = 'http://127.0.0.1:' + cloudPort;
  process.env.HUB_UPSTREAM = up;
  process.env.HUB_DATA_DIR = DATA;
  const { app } = require('../server');
  hub = app.listen(0, '127.0.0.1');
  await new Promise((r) => hub.on('listening', r));
  base = 'http://127.0.0.1:' + hub.address().port;
});
test.after(function () { hub.close(); cloud.closeAllConnections(); cloud.close(); });

const printJob = (auth) => fetch(base + '/api/outlet/1/print', {
  method: 'POST',
  headers: { authorization: auth, 'content-type': 'application/json' },
  body: JSON.stringify({ host: '127.0.0.1', data: Buffer.from('hello').toString('base64') })
});

test('the hub says it is a hub, and that the cloud answers', async function () {
  const b = await (await fetch(base + '/api/hub')).json();
  assert.deepStrictEqual(b, { mode: 'hub', upstream: up, online: true });
});

test('a request reaches the cloud with the device\'s own token, bytes untouched', async function () {
  const raw = '{"ops":[ {"kind":"add_line"} ],  "n":1}';
  const r = await fetch(base + '/api/outlet/1/sync/push', {
    method: 'POST', body: raw,
    headers: { authorization: 'Bearer device-7', 'content-type': 'application/json' }
  });
  assert.strictEqual(r.status, 200);
  const got = seen.find((s) => s.url === '/api/outlet/1/sync/push');
  assert.strictEqual(got.auth, 'Bearer device-7');
  assert.strictEqual(got.body, raw);                 // not re-serialised
  assert.strictEqual(got.host, new URL(up).host);
});

test('the sync stream arrives while it is still open', async function () {
  const ac = new AbortController();
  const r = await fetch(base + '/api/outlet/1/sync/stream', {
    headers: { authorization: 'Bearer device-7' }, signal: ac.signal
  });
  const { value } = await r.body.getReader().read();
  assert.match(Buffer.from(value).toString(), /changed 5/);
  ac.abort();
});

test('the pages are served from the hub\'s own disk', async function () {
  const r = await fetch(base + '/pos');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.ok(!seen.some((s) => s.url === '/pos'));
});

test('printing asks the cloud first, and a refusal is the cloud\'s refusal', async function () {
  const r = await printJob('Bearer cashier');
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await r.json()).error, 'kitchen or above');
});

test('an allowed job reaches the relay, and its fence', async function () {
  // Loopback is not a printer (PRINT_ALLOW_LOOPBACK is off), so reaching the
  // relay's own refusal is the proof the gate let it through.
  const r = await printJob('Bearer good');
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /not a printer on this network/);
});

test('with the cloud gone: forwarding says so, a known session still prints', async function () {
  cloud.closeAllConnections();
  await new Promise((r) => cloud.close(r));
  assert.strictEqual((await fetch(base + '/api/outlet/1/sync/pull')).status, 502);
  assert.strictEqual((await (await fetch(base + '/api/hub')).json()).online, false);
  assert.strictEqual((await printJob('Bearer good')).status, 400);     // relay reached
  assert.strictEqual((await printJob('Bearer stranger')).status, 503); // never allowed
});

const push = (auth, ops) => fetch(base + '/api/outlet/1/sync/push', {
  method: 'POST', body: JSON.stringify({ ops }),
  headers: { authorization: auth, 'content-type': 'application/json' }
});
const bill = [{ opId: 'o-1', kind: 'add_line', payload: { n: 4 }, lamport: 7 },
  { opId: 'o-2', kind: 'fire_course', payload: { n: 4 }, lamport: 8 }];

test('with the cloud gone, a push is held: a copy here, custody on the till', async function () {
  // device-7 pushed through the hub while the cloud was up (the test above).
  const r = await push('Bearer device-7', bill);
  assert.strictEqual(r.status, 503, 'a failure, so the till keeps every op');
  const b = await r.json();
  assert.strictEqual(b.held, 2);
  assert.ok(!('results' in b), 'no results[]: nothing may leave the outbox');
  assert.strictEqual(heldLines().length, 2);

  const again = await (await push('Bearer device-7', bill)).json();
  assert.strictEqual(again.held, 0, 'the retry every five seconds adds nothing');
  assert.strictEqual(heldLines().length, 2);

  const s = await push('Bearer stranger', [{ opId: 'x-1', kind: 'add_line' }]);
  assert.strictEqual(s.status, 503);
  assert.strictEqual(heldLines().length, 2, 'a session the cloud never cleared here holds nothing');
});

test('the cloud back: the push goes through, and the copy is done with', async function () {
  await new Promise((r) => cloud.listen(cloudPort, '127.0.0.1', r));
  const r = await push('Bearer device-7', bill);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(seen[seen.length - 1].body).ops.map((o) => o.opId), ['o-1', 'o-2'],
    'the till\'s own retry is what reaches the cloud');
  assert.strictEqual(heldLines().length, 0);
});
