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
const { baseDomain } = require('../handle');

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
     subdomain. Sending someone back to the apex keeps a single sign-in and a
     single set of cookies, rather than one per store. */
  const apexOnly = (file) => (req, res) => {
    const base = baseDomain();
    if (req.storeHandle && base) {
      return res.redirect(308, 'https://' + base + req.originalUrl);
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
};
