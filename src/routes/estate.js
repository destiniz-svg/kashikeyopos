'use strict';
/* The ONE cross-outlet read in the system. Aggregates only, rank 5 only,
   through a read-only role that can execute the aggregate function and nothing
   else, and stamped in the audit trail as group scope. */
const express = require('express');
const { withEstate, withOutlet } = require('../db');
const { atLeast } = require('../auth');

const r = express.Router();

r.get('/day', atLeast('owner'), async function (req, res, next) {
  // The asking outlet's local date, not the container's. An estate roll-up
  // taken at 21:00 Malé under UTC reported yesterday to every owner on it.
  const date = String(req.query.date || new Intl.DateTimeFormat('en-CA',
    { timeZone: req.ctx.tz || 'Indian/Maldives' }).format(new Date())).slice(0, 10);
  try {
    const rows = await withEstate(req.ctx, (c) =>
      c.query('SELECT * FROM chain.estate_day($1)', [date]).then((q) => q.rows));
    // Audited as group scope, in the asking outlet's own trail, so a
    // cross-outlet read is never invisible to the outlets it read.
    await withOutlet(Object.assign({}, req.ctx, { scope: 'group' }), (c) =>
      c.query("SELECT chain.log('estate_read','outlet',NULL,NULL,$1)",
        [JSON.stringify({ date, outlets: rows.length })]));
    res.set('cache-control', 'no-store').json({ date, outlets: rows });
  } catch (e) { next(e); }
});

module.exports = r;
