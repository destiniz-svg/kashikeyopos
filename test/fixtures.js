'use strict';
/* A live outlet, in exactly the shape /api/outlet/:id/bootstrap returns.
   Written by hand rather than dumped from a database so the UI tests state
   what they depend on, and so a change to the bootstrap contract breaks them
   loudly instead of quietly passing on stale JSON. */

const ING = [
  // id, category, name, stockUnit, costPerStockUnit, kind, code, baseUnit,
  // stockUnit, costPerBaseUnit, par, minStock, sellable
  ['ing_fish', 'Seafood', 'Reef fish', 'kg', 180, 'raw', 'ing_fish', 'g', 'kg', '0.18', 20000, 5000, 0],
  ['ing_rice', 'Dry', 'Basmati rice', 'kg', 32, 'raw', 'ing_rice', 'g', 'kg', '0.032', 50000, 10000, 0],
  ['ing_oil', 'Dry', 'Sunflower oil', 'l', 28, 'raw', 'ing_oil', 'ml', 'l', '0.028', 10000, 2000, 0]
];

function outlet(id) {
  return {
    id: id, code: 'OUT' + id, name: 'Test Outlet ' + id, type: 'restaurant',
    loc: 'restaurant', parent: 0, region: '', tax: 'GGST', rate: 8, sc: 10,
    addr: '', mgr: '', pos: true,
    seats: 12, tables: 3,
    zones: [{ id: 'main', name: 'Main floor', pos: 0 }],
    floor: [
      { id: 'T01', label: 'T01', zone: 'main', seats: 4, pos: 0, shape: 'square', status: 'free' },
      { id: 'T02', label: 'T02', zone: 'main', seats: 2, pos: 1, shape: 'square', status: 'free' },
      { id: 'T03', label: 'T03', zone: 'main', seats: 6, pos: 2, shape: 'square', status: 'free' }
    ],
    slug: 'test-outlet-' + id, tz: 'Indian/Maldives', currency: 'MVR',
    dayStart: '04:00', phone: '', active: true
  };
}

function kpos(opts) {
  const o = opts || {};
  const id = o.outletId || 1;
  return {
    CHAIN: {
      id: 'ch_test', name: 'Test Trading Pvt Ltd', country: 'MV', currency: 'MVR',
      tin: 'T1000001GST501', regNo: 'C-0001/2026', hq: 'Test address',
      phone: '', email: '',
      brand: { mark: 'brand/kashikeyo-mark.png', name: 'Test Trading', tagline: '', receiptFoot: '', poweredBy: true, colour: '#982030' }
    },
    OUTLETS: [outlet(id)],
    MENU_SECTIONS: [{ id: 'food', name: 'Food', pos: 0 }],
    MENU_CATEGORIES: [
      { id: 'mains', name: 'Mains', icon: 'main', section: 'food' },
      { id: 'sides', name: 'Sides', icon: 'side', section: 'food' }
    ],
    MENU: [
      {
        id: 'm1', cat: 'mains', name: 'Grilled Reef Fish', desc: '', price: 185,
        veg: false, img: '', station: 'grill', prep: 14, yield: 1, unit: 'plate',
        active: true, offMenu: false, soldOutReason: '',
        allergens: [], diets: [], tags: [],
        recipe: [['ing_fish', 200, 4, 'ing'], ['ing_oil', 15, 0, 'ing']]
      },
      {
        id: 'm2', cat: 'sides', name: 'Garlic Rice', desc: '', price: 45,
        veg: true, img: '', station: 'main', prep: 8, yield: 1, unit: 'plate',
        active: true, offMenu: false, soldOutReason: '',
        allergens: [], diets: [], tags: [],
        recipe: [['ing_rice', 120, 2, 'ing'], ['ing_oil', 10, 0, 'ing']]
      }
    ],
    USERS: [
      { id: 'u_owner', name: 'Test Owner', user: 'owner', role: 'SuperAdmin', rank: 5, outlet: id, outlets: [], pin: '', status: 'Active', last: '' },
      { id: 'u_mgr', name: 'Test Manager', user: 'manager', role: 'OutletManager', rank: 3, outlet: id, outlets: [], pin: '', status: 'Active', last: '' },
      { id: 'u_till', name: 'Test Cashier', user: 'cashier', role: 'Cashier', rank: 2, outlet: id, outlets: [], pin: '', status: 'Active', last: '' },
      { id: 'u_kit', name: 'Test Chef', user: 'chef', role: 'KitchenManager', rank: 1, outlet: id, outlets: [], pin: '', status: 'Active', last: '' }
    ],
    STAFF: [
      { id: 'e1', name: 'Test Cashier', outlet: id, job: 'Cashier', kind: 'local', basic: 8200, hourly: 47, joined: '2026-01-02', mrps: true, ot: true, svc: true, type: 'fulltime', photo: '' }
    ],
    CUSTOMERS: [],
    LOCATIONS: [
      { id: 'kitchen', name: 'Kitchen', kind: 'kitchen' },
      { id: 'dry', name: 'Dry store', kind: 'store' }
    ],
    VENDORS: [{ id: 'v1', name: 'Test Supplies', trn: '', terms: 30, lead: 2, contact: '', phone: '' }],
    DEVICES: [{ id: 'd1', label: 'POS-1', kind: 'till', station: null, paired: null, seen: null, revoked: false }],
    OPEX: [], ASSETS: [], MODIFIERS: [], MODIFIER_GROUPS: [], BANNERS: [], PROMOS: [],
    REWARDS: []
  };
}

function raw(opts) {
  const o = opts || {};
  const id = o.outletId || 1;
  const onHand = o.onHand || { ing_fish: 10000, ing_rice: 20000, ing_oil: 5000 };
  return {
    cats: [{ id: 'Seafood', name: 'Seafood', icon: 'store', storage: '', freq: '' },
      { id: 'Dry', name: 'Dry', icon: 'store', storage: '', freq: '' }],
    items: ING,
    units: [['g', 'gram', 'g', 'g', 1, 0], ['kg', 'kilogram', 'g', 'g', 1000, 0],
      ['ml', 'millilitre', 'ml', 'ml', 1, 0], ['l', 'litre', 'ml', 'ml', 1000, 0]],
    inv: Object.keys(onHand).map((k) => [id, k, onHand[k]]),
    ledger: [], batches: [], logs: [], vendors: [], purch: [], reqs: [],
    disp: [], prod: [], roles: []
  };
}

function real(opts) {
  const o = opts || {};
  const id = o.outletId || 1;
  return {
    session: { outletId: id, rank: o.rank || 5, actor: 'u_owner', name: 'Test Owner', roleKey: 'SuperAdmin', deviceId: 'd1' },
    state: Object.assign({
      outletId: id, tickets: {}, held: [], settled: [], refunds: {},
      register: { open: true, float: 1000, openedBy: 'u_owner', openedAt: Date.now() },
      costMoves: [], batches: [], counts: [], lastCountAt: 0,
      grn: [], invoices: [], indents: [], dispatches: [],
      kds: [], guestOrders: [], guestRequests: [], printJobs: [], res: [],
      journal: [], periods: [], bank: [], bankOpen: null, acqRuns: [], docs: [],
      clock: [], payrollPosted: [], maint: [], opexPaid: [], priceOv: {}, applied: []
    }, o.state || {}),
    at: Date.now()
  };
}

module.exports = { kpos, raw, real, outlet, ING };
