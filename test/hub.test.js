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
    if (req.url.startsWith('/api/outlet/1/sync/pull')) {
      return json(200, { now: 1000, ops: [{ op_id: 'done-before' }], state: { live: true, at: 1000,
        tickets: { 'T06:0': { id: 't1', table: 'T06', split: 0, status: 'open', stage: 0,
          lines: [{ lid: 'a', serverId: 's1', name: 'Soup', fired: false, done: false }] } } } });
    }
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

test('a pull passes through untouched while the cloud answers', async function () {
  const b = await (await fetch(base + '/api/outlet/1/sync/pull?since=0',
    { headers: { authorization: 'Bearer device-7' } })).json();
  assert.deepStrictEqual(b.ops, [{ op_id: 'done-before' }]);
  assert.ok(!b.hub, 'the cloud\'s answer, not the hub\'s');
  // The kitchen screen polls too, so the cloud clears it here as well.
  assert.strictEqual((await fetch(base + '/api/outlet/1/sync/pull?since=0',
    { headers: { authorization: 'Bearer kds' } })).status, 200);
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
  assert.strictEqual((await fetch(base + '/api/outlet/1/bootstrap')).status, 502);
  assert.strictEqual((await (await fetch(base + '/api/hub')).json()).online, false);
  assert.strictEqual((await printJob('Bearer good')).status, 400);     // relay reached
  assert.strictEqual((await printJob('Bearer stranger')).status, 503); // never allowed
});

const push = (auth, ops) => fetch(base + '/api/outlet/1/sync/push', {
  method: 'POST', body: JSON.stringify({ ops }),
  headers: { authorization: auth, 'content-type': 'application/json' }
});
// Rung on the tablet as table "6"; the floor calls it "T06".
const bill = [{ opId: 'o-1', kind: 'add_line', lamport: 7,
  payload: { table: '6', item: 'i9', name: 'Rice', lid: 'L2', qty: 1 } },
{ opId: 'o-2', kind: 'fire_course', lamport: 8, payload: { table: '6', lids: ['L2'] } }];

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

  // The kitchen, which saw the dish only through the fold, calls the table away.
  const k = await (await push('Bearer kds', [{ opId: 'o-3', kind: 'kds_bump_all', lamport: 1,
    payload: { table: 'T06' } }])).json();
  assert.strictEqual(k.held, 1);
});

test('with the cloud gone, the kitchen reads the last floor with the held ops folded on', async function () {
  const r = await fetch(base + '/api/outlet/1/sync/pull?since=1000',
    { headers: { authorization: 'Bearer device-7' } });
  assert.strictEqual(r.status, 200);
  const b = await r.json();
  assert.deepStrictEqual(b.ops, [], 'nothing in a hub answer acknowledges anything');
  assert.deepStrictEqual(b.hub.offline, true);
  const t = b.state.tickets['T06:0'];
  assert.deepStrictEqual(t.lines.map((l) => l.lid), ['a', 'L2'], 'the tablet\'s line joined the floor\'s table');
  assert.strictEqual(t.lines[1].fired, true);
  assert.strictEqual(t.lines[1].done, true,
    'the bump folds AFTER the dish although its lamport is lower: arrival order');
  assert.strictEqual(t.lines[0].done, false, 'an unfired line is never finished');

  const s = await fetch(base + '/api/outlet/1/sync/pull', { headers: { authorization: 'Bearer stranger' } });
  assert.strictEqual(s.status, 503, 'the floor is not handed to a session the cloud never cleared');
});

test('the fold: bumps, voids and a table nobody had open yet', function () {
  const { fold } = require('../src/hub');
  const floor = { 'T06:0': { id: 't1', table: 'T06', split: 0, stage: 1, lines: [
    { lid: 'a', serverId: 's1', fired: true, done: false },
    { lid: 'b', serverId: 's2', fired: true, done: false },
    { lid: 'c', serverId: 's3', fired: false, done: false }] } };
  const one = fold(floor, [{ kind: 'kds_bump', payload: { table: 'T06', lids: ['a'] }, heldAt: 1 }]);
  assert.deepStrictEqual(one['T06:0'].lines.map((l) => l.done), [true, false, false]);
  assert.strictEqual(one['T06:0'].stage, 1, 'b is still cooking');
  const all = fold(floor, [{ kind: 'kds_bump_all', payload: { ticketId: 't1' }, heldAt: 1 }]);
  assert.deepStrictEqual(all['T06:0'].lines.map((l) => l.done), [true, true, false], 'an unfired line is never finished');
  assert.strictEqual(all['T06:0'].stage, 2);
  const v = fold(floor, [{ kind: 'void_line', payload: { lineId: 's2' }, heldAt: 1 }]);
  assert.deepStrictEqual(v['T06:0'].lines.map((l) => l.lid), ['a', 'c']);
  const fresh = fold({}, [{ kind: 'add_line', payload: { table: 'W1', item: 'x', lid: 'n1' }, heldAt: 1 },
    { kind: 'add_line', payload: { table: 'W1', item: 'x', lid: 'n1', qty: 3 }, heldAt: 2 }]);
  assert.deepStrictEqual(fresh['W1:0'].lines.map((l) => [l.lid, l.qty]), [['n1', 3]], 'the same lid again is a quantity, not a second dish');
  assert.deepStrictEqual(floor['T06:0'].lines[0].done, false, 'the snapshot itself is never changed');
});

test('the cloud back: the outage lands in the order it happened, whoever reconnects first', async function () {
  await new Promise((r) => cloud.listen(cloudPort, '127.0.0.1', r));
  const mark = seen.length;
  // The KITCHEN reconnects first — the order that lost the bump on a real till.
  const r = await push('Bearer kds', [{ opId: 'o-3', kind: 'kds_bump_all', lamport: 1, payload: { table: 'T06' } }]);
  assert.strictEqual(r.status, 200);
  const pushes = seen.slice(mark).filter((s) => s.url === '/api/outlet/1/sync/push')
    .map((s) => s.auth + ' ' + JSON.parse(s.body).ops.map((o) => o.opId).join(','));
  assert.deepStrictEqual(pushes, [
    'Bearer device-7 o-1,o-2',   // the dish, under the tablet's own token
    'Bearer kds o-3',            // the bump, under the kitchen's
    'Bearer kds o-3'             // the kitchen's own push: a replay op_log answers
  ]);
  assert.strictEqual(heldLines().length, 0);
});
