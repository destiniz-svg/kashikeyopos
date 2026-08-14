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
  req.ctx = {
    outletId: claims.o, rank: claims.r, actor: claims.s,
    deviceId: claims.d || null, scope: claims.scope || 'outlet'
  };
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

module.exports = { RANK, session, sameOutlet, atLeast };
