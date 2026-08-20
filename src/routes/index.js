'use strict';
const express = require('express');
const { session, groupScope } = require('../auth');

const r = express.Router();

// Anonymous or self-authenticating.
// The account plane sits above every outlet and authenticates on its own.
r.use('/account', require('./account'));
r.use('/auth', require('./auth'));
r.use('/onboarding', require('./onboarding'));
r.use('/g', require('./guest'));

// Everything below needs a staff session.
r.use(session, groupScope);
r.use('/outlet/:outletId', require('./outlet'));
r.use('/outlet/:outletId/sync', require('./sync'));
r.use('/estate', require('./estate'));

module.exports = r;
