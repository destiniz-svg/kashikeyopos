'use strict';
/* Which HTML file answers which URL. Kept out of server.js so the routing
   table is one readable list rather than a scatter of app.get() calls. */
const path = require('path');

module.exports = function (app, APP) {
  const send = (file) => (req, res) => {
    res.set('cache-control', 'no-cache');
    res.sendFile(path.join(APP, file));
  };

  // The terminal: POS, kitchen, back office. One app, gated by rank.
  app.get('/', send('index.html'));
  app.get('/pos', send('index.html'));
  app.get('/kds', send('index.html'));
  app.get('/admin', send('index.html'));
  app.get('/onboarding', send('index.html'));

  // The guest portals. A QR resolves to /g/<slug>?t=<table>.
  app.get('/g/:slug', send('guest.html'));
  app.get('/m/:slug', send('member.html'));
  app.get('/member', send('member.html'));
};
