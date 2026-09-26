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

function forward(up) {
  const u = new URL(up);
  const lib = u.protocol === 'https:' ? https : http;
  return function (req, res) {
    const headers = strip(req.headers);
    headers.host = u.host;
    const out = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port,
      method: req.method, path: req.originalUrl, headers
    }, function (back) {
      state.online = true;
      res.writeHead(back.statusCode, strip(back.headers));
      back.pipe(res);
    });
    out.on('error', function () {
      state.online = false;
      if (res.headersSent) return res.destroy();
      res.status(502).json({ error: 'the hub cannot reach the cloud' });
    });
    // A device that walks away from the sync stream ends the upstream leg too.
    res.on('close', function () { if (!res.writableFinished) out.destroy(); });
    req.pipe(out);
  };
}

/* MAY THIS SESSION PRINT? The cloud's own gate is asked (GET .../print, the
   same sameOutlet + atLeast('kitchen') as the POST), because the hub cannot
   verify a token and must not pretend to. A yes is remembered for twelve
   hours, and only used when the cloud cannot be reached: the kitchen keeps
   printing through an outage for a session that was allowed to print before
   it. A no is never remembered past the next ask. */
const GRACE_MS = 12 * 3600e3;
// ponytail: one entry per session that printed here, never swept; add a sweep if a hub runs for months without a restart
const allowed = new Map();

async function mayPrint(up, req) {
  const auth = req.get('authorization') || '';
  const key = req.params.id + ' ' + auth;
  try {
    const r = await fetch(up + '/api/outlet/' + encodeURIComponent(req.params.id)
      + '/print', { headers: { authorization: auth }, signal: AbortSignal.timeout(4000) });
    state.online = true;
    if (r.ok) { allowed.set(key, Date.now()); return { ok: true }; }
    allowed.delete(key);
    const b = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, error: b.error || 'not allowed to print here' };
  } catch (e) {
    state.online = false;
    const at = allowed.get(key);
    if (at && Date.now() - at < GRACE_MS) return { ok: true };
    return { ok: false, status: 503,
      error: 'the hub cannot reach the cloud to check this session' };
  }
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
  r.use('/api', forward(up));
  return r;
}

module.exports = { upstream, router };
