'use strict';
/* ═══ THE STORE HUB (BUILD-PLAN 2.5a) ══════════════════════════════════════
   The same server.js on a PC in the shop, started with HUB_UPSTREAM set to the
   cloud install. SPEC §9: the cloud stays the one book, the hub is
   store-and-forward. Online, the hub is a pass-through and nothing more:

     · /api/* goes upstream byte for byte, streamed both ways (the sync stream
       included), carrying each device's OWN token. The hub never issues an id,
       a document number or a clock value, and holds no secret and no database.
     · the pages are served from the hub's own disk, so the shells load on the
       LAN at LAN speed.
     · printing stays here, because the printers are here. The one thing a
       hub does that the cloud cannot is open a socket on the shop's LAN.

   Held ops (2.5b) and the kitchen fold (2.5c) build on this. */
const http = require('http');
const https = require('https');
const express = require('express');
const relay = require('./printrelay');

// Hop-by-hop headers describe one connection, not the message: never forwarded.
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'te', 'trailer', 'upgrade'];

const state = { online: null };

/* The cloud's origin, or '' when this process is not a hub. A token crosses
   the WAN on every request, so production refuses plain http BY NAME rather
   than quietly sending staff sessions in the clear. */
function upstream() {
  const raw = String(process.env.HUB_UPSTREAM || '').trim();
  if (!raw) return '';
  const u = new URL(raw);
  if (u.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('HUB_UPSTREAM must be https:// in production: every device'
      + ' token crosses the internet on it');
  }
  return u.origin;
}

function strip(h) {
  const out = Object.assign({}, h);
  HOP.forEach((k) => delete out[k]);
  return out;
}

/* `body`: bytes already read (a push, which the hub must also keep a copy
   of); otherwise the request streams straight through. `down`: what to answer
   when the cloud cannot be reached; `ok`: told when the cloud answered 2xx. */
function forward(up, opt) {
  const u = new URL(up);
  const lib = u.protocol === 'https:' ? https : http;
  const o = opt || {};
  return function (req, res) {
    const headers = strip(req.headers);
    headers.host = u.host;
    const out = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port,
      method: req.method, path: req.originalUrl, headers
    }, function (back) {
      state.online = true;
      if (back.statusCode < 300 && o.ok) o.ok(req);
      if (back.statusCode < 300 && o.keep) {
        const got = [];
        back.on('data', (c) => got.push(c));
        back.on('end', () => o.keep(req, Buffer.concat(got)));
      }
      res.writeHead(back.statusCode, strip(back.headers));
      back.pipe(res);
    });
    out.on('error', function () {
      state.online = false;
      if (res.headersSent) return res.destroy();
      if (o.down) return o.down(req, res);
      res.status(502).json({ error: 'the hub cannot reach the cloud' });
    });
    // A device that walks away from the sync stream ends the upstream leg too.
    res.on('close', function () { if (!res.writableFinished) out.destroy(); });
    if (Buffer.isBuffer(req.body)) out.end(req.body); else req.pipe(out);
  };
}

/* WHICH SESSIONS THE CLOUD HAS CLEARED HERE. The hub cannot verify a token
   and must not pretend to, so it remembers the cloud's own yes: to GET
   .../print, or to a push through this hub — both behind the same gate,
   sameOutlet + atLeast('kitchen'). A yes is used only while the cloud cannot
   be reached, for twelve hours: the kitchen keeps printing, and the hub keeps
   a copy of what a till rang, for sessions that worked here before the
   outage. A no is never remembered past the next ask. */
const GRACE_MS = 12 * 3600e3;
// ponytail: in memory, one entry per session, never swept. A hub rebooted mid-outage clears nobody until the cloud is back; persist hashed keys if that bites, sweep if a hub runs for months
const allowed = new Map();
const who = (req) => req.params.id + ' ' + (req.get('authorization') || '');
const cleared = (req) => { const at = allowed.get(who(req)); return !!at && Date.now() - at < GRACE_MS; };

async function mayPrint(up, req) {
  try {
    const r = await fetch(up + '/api/outlet/' + encodeURIComponent(req.params.id)
      + '/print', { headers: { authorization: req.get('authorization') || '' },
      signal: AbortSignal.timeout(4000) });
    state.online = true;
    if (r.ok) { allowed.set(who(req), Date.now()); return { ok: true }; }
    allowed.delete(who(req));
    const b = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, error: b.error || 'not allowed to print here' };
  } catch (e) {
    state.online = false;
    if (cleared(req)) return { ok: true };
    return { ok: false, status: 503,
      error: 'the hub cannot reach the cloud to check this session' };
  }
}

/* ═══ HELD, NOT APPLIED (BUILD-PLAN 2.5b, SPEC §9 rule 2) ═══════════════════
   A push the cloud cannot be reached for is answered 503 "held", and the hub
   keeps a copy. The answer is deliberately NOT a results[] — the till deletes
   from its outbox exactly the ops a results[] acknowledges, so a failure keeps
   every op where it is: custody never moves, the device retries, and the
   cloud's op_log makes the retry land once. Nothing the hub holds is ever
   applied, numbered or sent upstream by the hub.

   The copy is what the kitchen reads during the outage (2.5c). Append-only
   JSONL, one op per line, deduplicated by opId, so a till retrying every five
   seconds adds nothing. The first push the cloud answers again ends the
   outage and the copy with it: from then on the cloud is the kitchen's
   source, and every till is already draining into it. */
const fs = require('fs');
const path = require('path');
const HELD = path.join(process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'hub-data'), 'held.jsonl');
const heldIds = new Set();
// Whose op each held one is. RAM only: a bearer token never goes to disk.
const tokens = new Map();
function readHeld() {
  try {
    return fs.readFileSync(HELD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
}
readHeld().forEach((h) => heldIds.add(h.opId));

// ponytail: appendFileSync per op; a store's outage is hundreds of ops, not millions
function hold(req, res) {
  if (!cleared(req)) {
    return res.status(503).json({ error: 'The cloud cannot be reached, and this'
      + ' session has not worked through the store hub before. Everything stays'
      + ' on this till until the cloud is back.' });
  }
  let ops = [];
  try { ops = JSON.parse(req.body.toString('utf8')).ops || []; } catch (e) { /* kept on the till */ }
  fs.mkdirSync(path.dirname(HELD), { recursive: true });
  let kept = 0;
  for (const op of ops) {
    if (!op || !op.opId || heldIds.has(op.opId)) continue;
    heldIds.add(op.opId);
    tokens.set(op.opId, req.get('authorization') || '');
    fs.appendFileSync(HELD, JSON.stringify({ outletId: req.params.id, heldAt: Date.now(),
      opId: op.opId, kind: op.kind, label: op.label, entity: op.entity,
      payload: op.payload, lamport: op.lamport, at: op.at }) + '\n');
    kept++;
  }
  res.status(503).json({ held: kept, error: 'The cloud cannot be reached. The store'
    + ' hub has a copy for the kitchen; this till keeps every op until the cloud'
    + ' confirms it.' });
}

/* ═══ THE KITCHEN FOLD (BUILD-PLAN 2.5c, SPEC §9 rule 3) ════════════════════
   During an outage the kitchen screen still pulls every few seconds, and the
   cloud cannot answer. The hub answers instead, from two things it already
   has: the last pull the cloud answered for that outlet (the whole floor —
   `state.tickets` is always sent whole), and the ops it is holding. The five
   kitchen kinds are folded onto the floor exactly as src/apply.js applies
   them; everything else waits for the cloud. The answer carries NO ops[]: an
   op in a pull is the device's acknowledgement, and nothing here is. */
const snapshots = new Map();       // outletId -> the cloud's last pull answer
const tkey = (s) => String(s == null ? '' : s).toUpperCase().replace(/^T0*/, '');

function fold(tickets, held) {
  const T = JSON.parse(JSON.stringify(tickets || {}));
  const all = () => Object.keys(T).map((k) => T[k]);
  // ticketRef(): by id, then the exact table, then the digits ("6" is "T06").
  const find = (p) => {
    if (p.ticketId) { const t = all().find((x) => x.id === p.ticketId); if (t) return t; }
    if (p.table == null) return null;
    const split = Number(p.split) || 0;
    const same = all().filter((x) => (Number(x.split) || 0) === split);
    return same.find((x) => String(x.table) === String(p.table))
      || same.find((x) => tkey(x.table) === tkey(p.table)) || null;
  };
  const named = (t, p) => {
    const lids = [].concat(p.lids || [], p.lid ? [p.lid] : [], p.lineIds || []).map(String);
    return lids.length ? t.lines.filter((l) => lids.indexOf(String(l.lid)) >= 0
      || lids.indexOf(String(l.serverId)) >= 0) : null;
  };
  // rungFromPass(): nothing fired 0, anything still cooking 1, else 2.
  const rung = (t) => {
    const fired = t.lines.filter((l) => l.fired);
    return !fired.length ? 0 : fired.some((l) => !l.done) ? 1 : 2;
  };
  // In ARRIVAL order, not lamport: a device can only act on another device's
  // held op after this fold showed it, and the fold never advances anybody's
  // clock — so a kitchen's bump can carry a LOWER lamport than the line it
  // bumps. Arrival at the hub is the order that respects cause.
  held.forEach(function (op) {
      const p = op.payload || {}, at = op.at || op.heldAt;
      if (op.kind === 'add_line') {
        if (!p.item) return;
        let t = find(p);
        if (!t) {
          t = { id: null, table: String(p.table), split: Number(p.split) || 0, status: 'open',
            stage: 0, opened: at, waiter: '', note: '', guests: [], lines: [], held: true };
          T[t.table + ':' + t.split] = t;
        }
        const was = p.lid && t.lines.find((l) => l.lid === p.lid);
        if (was) Object.assign(was, { qty: Number(p.qty) || 1, note: p.note || '', course: p.course || '' });
        else {
          t.lines.push({ lid: p.lid || op.opId, serverId: null, id: p.item, name: p.name || p.item,
            qty: Number(p.qty) || 1, price: Number(p.price) || 0, addons: p.addons || [],
            guest: p.guest, split: p.guest, note: p.note || '', course: p.course || '',
            station: p.station || null, fired: false, firedAt: 0, since: 0, done: false,
            doneAt: 0, sent: false, at: at, held: true });
        }
      } else if (op.kind === 'void_line') {
        all().forEach((t) => { t.lines = t.lines.filter((l) => !((p.lid && l.lid === p.lid)
          || (p.lineId && l.serverId === p.lineId))); });
      } else if (op.kind === 'fire_course') {
        const t = find(p);
        if (!t) return;
        (named(t, p) || []).forEach((l) => { if (!l.fired) Object.assign(l, { fired: true, sent: true, firedAt: at }); });
        t.stage = 1;
      } else if (op.kind === 'kds_bump' || op.kind === 'kds_bump_all') {
        const t = find(p);
        if (!t) return;
        const which = op.kind === 'kds_bump' ? (named(t, p) || t.lines) : t.lines;
        which.forEach((l) => { if (l.fired && !l.done) Object.assign(l, { done: true, doneAt: at }); });
        t.stage = rung(t);
      }
    });
  return T;
}

function keepPull(req, buf) {
  allowed.set(who(req), Date.now());
  try {
    const b = JSON.parse(buf.toString('utf8'));
    if (b && b.state && b.state.tickets) snapshots.set(String(req.params.id), b);
  } catch (e) { /* a pull the hub cannot read is simply not kept */ }
}

function kitchenView(req, res) {
  const snap = snapshots.get(String(req.params.id));
  if (!cleared(req) || !snap) {
    return res.status(503).json({ error: 'The cloud cannot be reached, and the'
      + ' store hub has no copy of this outlet\'s floor to answer from.' });
  }
  const held = readHeld().filter((h) => String(h.outletId) === String(req.params.id));
  res.set('cache-control', 'no-store').json(Object.assign({}, snap, {
    ops: [],
    hub: { offline: true, held: held.length, floorAt: snap.state.at || null },
    state: Object.assign({}, snap.state, { tickets: fold(snap.state.tickets, held) })
  }));
}

/* ═══ THE OUTAGE ENDS IN THE ORDER IT HAPPENED ══════════════════════════════
   Found by driving it: a kitchen bumped, through the fold, a dish a tablet
   had rung during the outage. The kitchen came back online 2.4 s before the
   tablet, its bump reached the cloud before the dish did, `kds_bump_all`
   answered "no open ticket" — and the kitchen's work was gone, recorded as
   applied. Without a hub that cannot happen (the kitchen never sees the
   tablet's dish); the fold is what made it possible, so the hub closes it.

   Before any device's push goes through after an outage, the hub delivers
   what it holds, in arrival order, each run under its OWN device's token:
   the cloud attributes, fences and numbers every op exactly as if the device
   had sent it, and the device's own retry that follows is a replay op_log
   answers from its record. Custody never moved; only the ORDER is the hub's.
   An op whose token the hub no longer has (it was restarted) is left to its
   device, which is exactly the no-hub behaviour. */
let draining = null;
async function drain(up) {
  const held = readHeld();
  for (let i = 0; i < held.length;) {
    const h = held[i], auth = tokens.get(h.opId);
    if (!auth) { i++; continue; }
    const run = [h];
    while (i + run.length < held.length && run.length < 200) {
      const n = held[i + run.length];
      if (tokens.get(n.opId) !== auth || n.outletId !== h.outletId) break;
      run.push(n);
    }
    // Throws while the cloud is still unreachable, which keeps everything held.
    // Any ANSWER is the cloud's to give: a refusal reaches the device on its own retry.
    await fetch(up + '/api/outlet/' + encodeURIComponent(h.outletId) + '/sync/push', {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: run.map((o) => ({ opId: o.opId, kind: o.kind, label: o.label,
        entity: o.entity, payload: o.payload, lamport: o.lamport, at: o.at })) })
    });
    i += run.length;
  }
  heldIds.clear();
  tokens.clear();
  try { fs.unlinkSync(HELD); } catch (e) { /* already gone */ }
}

function pushThrough(up) {
  const pass = forward(up, { down: hold, ok: (req) => allowed.set(who(req), Date.now()) });
  return async function (req, res) {
    if (heldIds.size) {
      try {
        await (draining || (draining = drain(up).finally(() => { draining = null; })));
      } catch (e) { state.online = false; return hold(req, res); }
    }
    pass(req, res);
  };
}

function router(up) {
  const r = express.Router();
  /* Which mode this address is in, for the Printers and Sync & devices
     screens. `online` is asked fresh, not read from the last request. */
  r.get('/api/hub', async function (req, res) {
    try {
      const ping = await fetch(up + '/healthz', { signal: AbortSignal.timeout(3000) });
      state.online = ping.ok;
    } catch (e) { state.online = false; }
    res.json({ mode: 'hub', upstream: up, online: state.online });
  });
  // Ready means the hub can serve the shop; the cloud's readiness is its own.
  r.get('/readyz', function (req, res) { res.json({ ok: true, mode: 'hub' }); });
  r.post('/api/outlet/:id/print', express.json({ limit: '4mb' }), async function (req, res) {
    const v = await mayPrint(up, req);
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    return relay(req, res);
  });
  r.post('/api/outlet/:id/sync/push', express.raw({ type: '*/*', limit: '4mb' }),
    pushThrough(up));
  r.get('/api/outlet/:id/sync/pull', forward(up, { keep: keepPull, down: kitchenView }));
  r.use('/api', forward(up));
  return r;
}

module.exports = { upstream, router, readHeld, fold };
