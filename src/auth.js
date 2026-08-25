'use strict';
const { verify, verifyTable } = require('./secrets');
const { stillGood } = require('./revoked');

/* ═══ THE ONE LADDER ════════════════════════════════════════════════════════
   Kitchen 1 · Till 2 · Manager 3 · Admin 4 · Owner 5.

   Gate on rank, never on a name and never on a job title. There is exactly one
   ladder in the system and this is it; the front end's permission catalogue is
   a presentation of the same ranks, not a second authority.
   ═══════════════════════════════════════════════════════════════════════ */

const RANK = { kitchen: 1, till: 2, manager: 3, admin: 4, owner: 5 };

// The permission-catalogue key each rank lands on in the terminal. A backend
// rank with no mapping would silently fall through to the whole cockpit, so
// every rank is named here rather than defaulted.
const ROLE_KEY_BY_RANK = {
  1: 'KitchenManager', 2: 'Cashier', 3: 'OutletManager',
  4: 'ChainAdmin', 5: 'SuperAdmin'
};

/* A VALID SIGNATURE IS NOT THE WHOLE QUESTION. This verified the token and
   nothing else, so two revocations that the screens promised were never
   enforced: signing out every other session set `chain.session.revoked_at` and
   a signed-out till kept working for the twelve hours its token had left, and
   deregistering a device set `chain.device.revoked` and the device kept
   signing in and writing. Both are asked here now — once, for all three
   routers that mount this — through src/revoked.js, which explains what the
   check costs and why it fails open. */
async function session(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const claims = token && verify(token);
  if (!claims) return res.status(401).json({ error: 'session required' });
  req.ctx = {
    outletId: claims.o,
    rank: claims.r,
    actor: claims.s,
    sessionId: claims.sid || null,
    deviceId: claims.d || null,
    name: claims.n || '',
    roleKey: claims.rk || ROLE_KEY_BY_RANK[claims.r] || 'Cashier',
    scope: claims.scope === 'group' ? 'group' : 'outlet'
  };
  try {
    const live = await stillGood(req.ctx);
    if (!live.ok) {
      /* Named, because the two land a person in different places: a signed-out
         session is fixed by keying a PIN, and a deregistered device is not
         fixed by anything the person holding it can do. */
      return res.status(401).json({
        error: live.why === 'device'
          ? 'This terminal has been deregistered — ask a manager to enrol it again'
          : 'This session was signed out — key your PIN to sign back in',
        revoked: live.why
      });
    }
  } catch (e) { return next(e); }
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
      // The wording matters: a refusal names the rank, so an operator learns
      // what to ask for instead of learning that the app is broken.
      return res.status(403).json({
        error: 'Rank ' + need + ' required — ' + rankName(need) + ' or above'
      });
    }
    next();
  };
}

function rankName(n) {
  return ['', 'Kitchen', 'Till', 'Manager', 'Admin', 'Owner'][n] || 'Owner';
}

// Group scope is a claim the client can make, and it is only honoured at rank
// 5. Anything else is downgraded silently to outlet scope — never refused,
// because a rank-3 asking for the estate is a UI bug, not an attack.
function groupScope(req, res, next) {
  if (req.query.scope === 'group' && (req.ctx.rank || 0) >= 5) req.ctx.scope = 'group';
  next();
}

/* The guest portal holds no staff session. A QR carries a table token scoped
   to one outlet and one table, so a guest cannot post onto somebody else's
   bill by editing a URL. It grants rank 0: intent only, never money. */
function tableSession(req, res, next) {
  const t = req.get('x-table-token') || req.query.t || '';
  const claims = verifyTable(String(t));
  if (!claims || !claims.o) return res.status(401).json({ error: 'table token required' });
  req.guest = { outletId: claims.o, table: claims.tb || null, slug: claims.sl || null };
  next();
}

module.exports = { RANK, ROLE_KEY_BY_RANK, rankName, session, sameOutlet, atLeast, groupScope, tableSession };
