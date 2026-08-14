'use strict';
// Usage: npm run -s exec -- node scripts/seed-staff.js 3 "Aishath" 3 4821
// Ranks: 1 Kitchen, 2 Till, 3 Manager, 4 Admin, 5 Owner.
const { owner, shutdown } = require('../src/db');
const { hashPin, pinLookup } = require('../src/secrets');

(async function () {
  const [outletId, name, rank, pin] = process.argv.slice(2);
  if (!outletId || !name || !rank || !pin) {
    console.error('usage: seed-staff <outletId> <name> <rank 1-5> <pin>'); process.exit(2);
  }
  const { hash, salt } = hashPin(pin);
  const c = await owner().connect();
  try {
    await c.query('INSERT INTO chain.staff (name, rank, outlet_id, pin_hash, pin_salt, pin_lookup)'
      + ' VALUES ($1,$2,$3,$4,$5,$6)',
      [name, Number(rank), Number(outletId), hash, salt,
       pinLookup(Number(outletId), pin)]);
    console.log('added ' + name + ' at rank ' + rank);
  } finally { c.release(); await shutdown(); }
})().catch(function (e) { console.error(e.message); process.exit(1); });
