'use strict';
const { verify } = require('./secrets');

// Rank ladder, single source of truth: Kitchen 1, Till 2, Manager 3,
// Admin 4, Owner 5. Gate on rank, never on a name or a title.
const RANK = { kitchen: 1, till: 2, manager: 3, admin: 4, owner: 5 };

function session(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const claims = token && verify(token);
  if (!claims) return res.status(401).json({ error: 'session required' });
  /* A GUEST token is a different kind of thing from a staff session and must
     never be mistaken for one. It carries no staff id, is pinned to a single
     table, and is rank 0 — so every atLeast() gate refuses it without needing
     to know guest tokens exist. `guest` is set from the claim, not inferred
     from a missing field, because "no rank" and "a guest" are different
     states and only one of them may read a table's bill. */
  const guest = claims.g === true;
  req.ctx = {
    outletId: claims.o,
    rank: guest ? 0 : claims.r,
    actor: guest ? null : claims.s,
    deviceId: guest ? null : (claims.d || null),
    scope: guest ? 'guest' : (claims.scope || 'outlet'),
    guest: guest,
    table: guest ? String(claims.tbl || '') : null,
  };
  if (guest && !req.ctx.table) return res.status(401).json({ error: 'session required' });
  next();
}

/* A guest may only ever act on the table its own token names. The table in the
   request body is a client-supplied string; the one in the token was issued by
   the server against a table that exists. Where they disagree, the request is
   asking about somebody else's table. */
function ownTable(req, res, next) {
  if (!req.ctx.guest) return next();
  const asked = String((req.body && req.body.table) || '');
  if (asked && asked !== req.ctx.table) {
    return res.status(403).json({ error: 'table mismatch' });
  }
  next();
}

/* Staff only. Used where a guest token must not reach at all, whatever its
   rank — the rank ladder starts at Kitchen 1, so rank 0 already fails
   atLeast(), but saying so explicitly keeps the intent readable at the route. */
function staffOnly(req, res, next) {
  if (req.ctx.guest) return res.status(403).json({ error: 'staff session required' });
  next();
}

// The outlet in the path must be the outlet in the token. A request cannot
// name a different one, whatever the client believes.
function sameOutlet(req, res, next) {
  const asked = Number(req.params.outletId);
  if (asked !== req.ctx.outletId) {
    return res.status(403).json({ error: 'outlet mismatch' });
  }
  next();
}

function atLeast(rank) {
  const need = typeof rank === 'string' ? RANK[rank] : rank;
  return function (req, res, next) {
    if ((req.ctx.rank || 0) < need) {
      return res.status(403).json({ error: 'rank ' + need + ' required' });
    }
    next();
  };
}

module.exports = { RANK, session, sameOutlet, atLeast, ownTable, staffOnly };
