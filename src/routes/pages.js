'use strict';
/* Which HTML file answers which URL. Kept out of server.js so the routing
   table is one readable list rather than a scatter of app.get() calls.

   There are TWO kinds of address here, and the difference is the hostname:

     kashikeyopos.com              the business's own software — the till, the
                                   back office, the front door, onboarding
     <handle>.kashikeyopos.com     ONE store's public face — the QR ordering
                                   portal a guest scans at the table, and the
                                   customer card they collect points on

   A store's guests should never be one mistyped path away from its till, and a
   printed QR should carry the store's own address rather than a path on
   somebody else's. So the host decides first, and the path decides after. */
const path = require('path');
const { baseDomain, appHost } = require('../handle');

module.exports = function (app, APP) {
  const send = (file) => (req, res) => {
    res.set('cache-control', 'no-cache');
    res.sendFile(path.join(APP, file));
  };

  // `req.storeHandle` is resolved in server.js, before anything routes on it.
  // On a store's address, serve the store's page; on the apex, the apex's.
  const byHost = (storeFile, apexFile) => (req, res) =>
    send(req.storeHandle ? storeFile : apexFile)(req, res);

  /* The business's own software has one home, and it is not a store's
     subdomain. Sending someone back there keeps a single sign-in and a
     single set of cookies, rather than one per store. That home is the host
     of PUBLIC_URL (app.kashikeyopos.com in production — the apex belongs to
     the product's website now), falling back to the base domain for a deploy
     whose PUBLIC_URL still sits on the apex. */
  const apexOnly = (file) => (req, res) => {
    const home = appHost() || baseDomain();
    if (req.storeHandle && home) {
      return res.redirect(308, 'https://' + home + req.originalUrl);
    }
    return send(file)(req, res);
  };

  // The terminal: POS, kitchen, back office. One app, gated by rank.
  app.get('/', byHost('guest.html', 'index.html'));
  app.get('/pos', apexOnly('index.html'));
  app.get('/kds', apexOnly('index.html'));
  app.get('/admin', apexOnly('index.html'));
  // An empty install lands here, not on the floor.
  app.get('/onboarding', apexOnly('onboarding.html'));

  /* The front door: where a business signs up before it has an outlet, a menu
     or a till. The terminal at "/" decides for itself whether to send someone
     here — it is the page that knows whether this install is set up and
     whether this browser holds an account. */
  app.get('/account', apexOnly('account.html'));
  app.get('/signin', apexOnly('account.html'));
  app.get('/signup', apexOnly('account.html'));

  /* The guest portals. A QR resolves to https://<handle>.kashikeyopos.com/?t=7
     and the card to /member on the same address. The path forms below still
     answer everywhere, because they are printed on things: a QR card made
     before a store took its handle has to keep working for as long as it is
     stuck to the table. */
  app.get('/g/:slug', send('guest.html'));
  app.get('/m/:slug', send('member.html'));
  app.get('/member', send('member.html'));
  app.get('/card', send('member.html'));

  /* Where an invitation lands. The token is in the PATH, because a path is the
     one part of an address a click-wrapper does not rewrite and a reader
     cannot confuse with somebody else's query parameter.

     It answers on a store's own subdomain and on the apex alike: a link is
     printed into a message and outlives whatever we knew about hostnames the
     day it was composed. The page reads the token itself and posts it — this
     route only decides which app answers. */
  app.get('/join/:token', send('member.html'));

  /* WHERE A SHARED DOCUMENT LANDS. A receipt at /r/<token> and an account
     statement at /st/<token> — one page, told apart by what the token
     resolves to. It answers on a store's own subdomain and on the apex alike,
     for the same reason /join does: the link is composed into a message and
     outlives whatever we knew about hostnames the day it was sent.

     No credential beyond the token, deliberately. A guest who is handed their
     receipt on WhatsApp has no account here and never will, and asking them to
     sign in to read what they already paid for is how a receipt link becomes a
     receipt nobody opens. */
  app.get('/r/:token', send('doc.html'));
  app.get('/st/:token', send('doc.html'));
};
