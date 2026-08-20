/* The raw item catalogue, in the positional shape the inventory screens read.
   Positional because it is hundreds of rows on a phone and the field names
   would be two thirds of the payload.

   It ships EMPTY. Every row here is trade — an ingredient somebody bought, a
   balance somebody counted — and belongs to one outlet's own database. The API
   client replaces this object at sign-in with that outlet's own catalogue.

   items:   [id, category, name, stockUnit, sellPrice, kind, code, baseUnit,
             stockUnit, avgCost, par, minStock, sellable]
   inv:     [outletId, itemId, onHand]
   ledger:  [outletId, itemId, movement, in, out, balance]
   batches: [id, outletId, itemId, source, received, useBy, qty, left, state] */
window.KPOS_RAW = {
  cats: [], items: [], units: [], inv: [], ledger: [], batches: [],
  logs: [], vendors: [], purch: [], reqs: [], disp: [], prod: [], roles: []
};
