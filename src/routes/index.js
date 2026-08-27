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
/* A DOCUMENT SOMEBODY WAS HANDED — a receipt or a statement, read from the
   link in a message. Public by design and above the session middleware for
   the same reason the guest portal is: whoever opens it has no account here
   and never will, and a receipt that asks for a sign-in is a receipt nobody
   opens. The token in the link is the whole credential and the doorman inside
   is what stops anybody walking the space. */
r.use('/doc', require('./doc'));
// The platform door authenticates with its own key, or does not exist at all.
r.use('/platform', require('./platform'));

// Everything below needs a staff session.
r.use(session, groupScope);
r.use('/outlet/:outletId', require('./outlet'));
r.use('/outlet/:outletId/sync', require('./sync'));
r.use('/estate', require('./estate'));

module.exports = r;
