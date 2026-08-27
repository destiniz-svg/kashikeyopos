'use strict';
/* ═══ THE HARNESS ═══════════════════════════════════════════════════════════
   Not a checklist. This is the sweep that drove the reference build and found
   seven real defects in it, three of which were unreachable by clicking.

   It loads the terminal's logic class with no DOM, renders every module and
   every sub-tab, opens every modal kind, and then CALLS EVERY FUNCTION the
   vals objects expose — every action, every row `go`, every card link, every
   toggle, every form save — with a synthetic event.

   A button that throws is not a cosmetic issue. It is a dead end, and the
   product principles forbid one.
   ═══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'app');

/* ── a browser, to the extent the logic class needs one ─────────────────── */
function makeWindow() {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    key: (i) => Object.keys(store)[i] || null,
    get length() { return Object.keys(store).length; }
  };
  const listeners = {};
  const win = {
    localStorage,
    sessionStorage: localStorage,
    navigator: { onLine: true, userAgent: 'harness', language: 'en-GB' },
    location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (e) => { (listeners[e && e.type] || []).forEach((f) => { try { f(e); } catch (x) {} }); return true; },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    setTimeout, clearTimeout, setInterval, clearInterval,
    innerWidth: 1440, innerHeight: 900,
    devicePixelRatio: 1,
    crypto: require('crypto').webcrypto || require('crypto'),
    /* THREE GLOBALS THE PHOTOGRAPH PATH ACTUALLY USES. A dish's image persists
       as a data URL and is rendered from a blob: URL, because a data URL
       carries `image/jpeg;base64` and the semicolon ends any inline style
       declaration it is concatenated into. Without these the shipped
       photoUrl() falls into its own catch and returns "" — which reads as "no
       photograph" and would let that whole path go unexercised here.
       Node has all three; they are simply not on the stub window. */
    atob: (b) => Buffer.from(String(b), 'base64').toString('binary'),
    btoa: (b) => Buffer.from(String(b), 'binary').toString('base64'),
    Blob: Blob,
    URL: URL,
    Image: class Image { set src(v) { this._src = v; } get src() { return this._src; } },
    FileReader: class FileReader { readAsDataURL() {} },
    Event: class Event { constructor(t) { this.type = t; } },
    CustomEvent: class CustomEvent { constructor(t, o) { this.type = t; this.detail = (o || {}).detail; } },
    console
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.document = {
    documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, removeAttribute() {}, classList: { add() {}, remove() {}, toggle() {} } },
    body: { style: {}, classList: { add() {}, remove() {} }, appendChild() {}, removeChild() {} },
    head: { appendChild() {}, removeChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {}, click() {}, classList: { add() {}, remove() {} } }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: win.addEventListener,
    removeEventListener: () => {},
    readyState: 'complete',
    hidden: false
  };
  return win;
}

/* ── load the logic class exactly as the runtime does ───────────────────── */
function loadLogic(opts) {
  const o = opts || {};
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const i = html.indexOf('<script type="text/x-dc"');
  const j = html.indexOf('>', i) + 1;
  const k = html.lastIndexOf('</script>');
  const src = html.slice(j, k);

  const win = makeWindow();
  const ctx = vm.createContext(win);

  // The structure the app ships with, and then whatever this test wants live.
  vm.runInContext(fs.readFileSync(path.join(APP, 'kashikeyo-raw.js'), 'utf8'), ctx);
  // The rule table loads first in the browser, so it loads first here too.
  vm.runInContext(fs.readFileSync(path.join(APP, 'kashikeyo-rules.js'), 'utf8'), ctx);
  // The shipped yield table, which the SERVER loads too — see kashikeyo-yield.js.
  vm.runInContext(fs.readFileSync(path.join(APP, 'kashikeyo-yield.js'), 'utf8'), ctx);
  // And the invitation's copy, which the server composes from the same file.
  vm.runInContext(fs.readFileSync(path.join(APP, 'kashikeyo-invite.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(APP, 'kashikeyo-data.js'), 'utf8'), ctx);
  if (o.kpos) vm.runInContext('Object.assign(window.KPOS, ' + JSON.stringify(o.kpos) + ')', ctx);
  if (o.raw) vm.runInContext('Object.assign(window.KPOS_RAW, ' + JSON.stringify(o.raw) + ')', ctx);
  if (o.real) vm.runInContext('window.KPOS_REAL = ' + JSON.stringify(o.real), ctx);

  // The base class and the two globals the logic closes over.
  const React = {
    createRef: () => ({ current: null }),
    createElement: () => ({}),
    Fragment: 'fragment'
  };
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(u, cb) {
      const patch = typeof u === 'function' ? u(this.state) : u;
      Object.assign(this.state, patch);
      if (cb) cb();
    }
    forceUpdate() {}
    componentDidMount() {}
    componentDidUpdate() {}
    componentWillUnmount() {}
    renderVals() { return {}; }
  }

  const fn = vm.runInContext(
    '(function (DCLogic, StreamableLogic, React) {' + src
    + '\n;return (typeof Component!=="undefined"&&Component)||undefined;})',
    ctx);
  const Component = fn(DCLogic, DCLogic, React);
  if (!Component) throw new Error('the terminal exposed no Component class');
  return { Component, win, ctx };
}

/* ── an instance, with the host stubbed out ─────────────────────────────── */
function makeInstance(opts) {
  const o = opts || {};
  const { Component, win } = loadLogic(o);
  const F = new Component(o.props || {});
  F.__toasts = [];
  F.toast = (t, tone) => F.__toasts.push({ t, tone });
  F.downloadCsv = () => {};
  F.printJob = () => {};
  F.state.ready = true;
  F.state.roleKey = o.role || 'SuperAdmin';
  F.state.session = o.session === null ? null
    : (o.session || { id: 'u_harness', user: 'harness', name: 'Audit', role: F.state.roleKey, outlet: F.state.outletId, outlets: [] });
  if (o.outletId) F.state.outletId = o.outletId;
  F.__win = win;
  return F;
}

/* ── 1 · every module, every sub-tab, every handler ─────────────────────── */
const GENERATORS = [
  'g_site', 'g_staff', 'g_payroll', 'g_costs', 'g_assets', 'g_chain',
  'g_branches', 'g_menu', 'g_users', 'g_logs', 'g_inventory', 'g_ledger',
  'g_counts', 'g_purchases', 'g_requests', 'g_dispatches', 'g_production',
  'g_recipes', 'g_batches', 'g_vendors', 'g_loyalty', 'g_promos', 'g_orders',
  'g_delivery', 'g_customers', 'g_reservations', 'g_sync', 'g_aimenu',
  'g_accounting', 'g_reports', 'g_settings', 'g_today', 'g_start',
  'g_architecture'
];

const MODAL_KINDS = [
  'lock', 'pay', 'note', 'qr', 'conflict', 'kot', 'actions', 'switch', 'perm',
  'move', 'zones', 'periodPick', 'bankRow', 'delorder', 'ticket', 'receipt',
  'z', 'settled', 'creditNote', 'count', 'form', 'guest', 'held', 'dishb',
  'menuio', 'outlet', 'recipeb', 'resv', 'catb', 'info', 'outletDetail',
  'user', 'customer', 'dish', 'share'
];

const FORMS = [
  'category', 'chain', 'company', 'outletProfile', 'taxProfile',
  'pin', 'terminal', 'item', 'recipe', 'adjust', 'refund',
  'journal', 'regopen', 'yield', 'subrecipe', 'acqFile', 'mdr', 'taxVersion',
  'fxrates', 'regclose', 'brand', 'staffedit', 'clockin', 'opex', 'asset',
  'breakdown', 'outlet', 'dish', 'outletPrice', 'pinFor', 'bankImport',
  'bankOpening', 'user', 'earnRate', 'tier', 'rewardEdit', 'settleCredit',
  'resetStore', 'covers', 'cust', 'res', 'grnPrice', 'indent', 'dispatch',
  'prodbatch', 'pairKds', 'channelRates', 'discount', 'banner', 'vendor',
  'storeAddress', 'aiResult', 'processor', 'invite', 'printerConn', 'plan',
  // Where an emailed receipt or statement goes when the customer has no
  // address on file yet. Typed once, saved onto the customer, used now.
  'docEmail', 'setupFile',
  /* Four COMPUTED form specs the sweep never saw. They are written as
     `name: (function () { ... })()` rather than as object literals, and the
     wiring test's extractor matched only `name: {` — so they existed, opened
     from real screens, and were excused from every sweep this harness does.
     Found when the extractor was widened to match the KEY rather than one
     shape of value. */
  'addon', 'tableEdit', 'zoneEdit', 'grn'
];

// The message alone names the symptom; the frame names the line. A harness
// that reports "undefined is not an object" and nothing else costs more time
// than it saves.
function stackOf(e) {
  if (!process.env.HARNESS_STACKS) return '';
  return '\n      ' + String(e.stack || '').split('\n').slice(1, 4).join('\n      ');
}

const EV = {
  target: { value: '1', checked: true, files: [], dataset: {} },
  currentTarget: { value: '1', dataset: {} },
  preventDefault() {}, stopPropagation() {},
  key: 'Enter', clientX: 10, clientY: 10
};

function sweep(F, gens) {
  const errs = [];
  let fired = 0, tabs = 0, rendered = 0;
  const seen = new WeakSet();

  const invoke = (v, where, depth) => {
    if (v == null || depth > 5) return;
    if (typeof v === 'function') {
      fired++;
      try { v(EV); } catch (e) { errs.push(where + ' :: ' + e.message + stackOf(e)); }
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.slice(0, 40).forEach((x, i) => invoke(x, where + '[' + i + ']', depth + 1));
      return;
    }
    Object.keys(v).forEach((k) => {
      if (/Style$|^style$/.test(k)) return;   // style strings hold no handlers
      invoke(v[k], where + '.' + k, depth + 1);
    });
  };

  /* A handler is allowed to change the screen — that is what handlers do. The
     sweep therefore re-reads the tab strip each time and puts the view modes
     back between modules, so one module's "switch to add-ons" does not make
     the next module look broken. */
  const MODES = ['menuMode', 'menuSort', 'pane', 'statsMode', 'counting'];
  const modes = () => MODES.reduce((a, k) => { a[k] = F.state[k]; return a; }, {});
  const restore = (m) => MODES.forEach((k) => { F.state[k] = m[k]; });

  (gens || GENERATORS).forEach((g) => {
    if (typeof F[g] !== 'function') { errs.push(g + ' :: not defined'); return; }
    const snap = JSON.stringify(F.state.tab || {});
    const mode0 = modes();
    let base;
    try { base = F[g](); rendered++; }
    catch (e) { errs.push(g + ' BASE :: ' + e.message + stackOf(e)); return; }
    const n = (base.tabs || []).length;
    for (let i = 0; i < Math.max(1, n); i++) {
      try {
        if (n) {
          restore(mode0);
          const b = F[g]();
          if (b.tabs && b.tabs[i] && b.tabs[i].pick) b.tabs[i].pick();
        }
        tabs++;
        invoke(F[g](), g + '#' + i, 0);
      } catch (e) { errs.push(g + '#' + i + ' :: ' + e.message + stackOf(e)); }
    }
    try { F.state.tab = JSON.parse(snap); } catch (e) { F.state.tab = {}; }
    restore(mode0);
  });
  return { rendered, tabs, fired, errs };
}

/* ── 2 · every modal kind, seeded well enough to render ─────────────────── */
function modalSeed(F) {
  const K = F.__win.KPOS || {};
  const dish = (K.MENU || [])[0] || { id: 'x', name: 'Dish', price: 0, cat: '' };
  const user = (K.USERS || [])[0] || { id: 'u', name: 'Someone', role: 'Cashier' };
  const cust = (K.CUSTOMERS || [])[0] || { id: 'c', name: 'Guest', phone: '' };
  const acct = (K.ACCOUNTS || [])[0] || { code: '1010', name: 'Cash' };
  return {
    lock: { who: user.user },
    pay: { tender: 'cash', given: '100' },
    note: { idx: 0, val: 'note' },
    qr: { table: 1 },
    conflict: { id: 'op_1' },
    kot: { slot: 1 },
    actions: { slot: 1 },
    switch: {},
    perm: { role: 'Cashier', mod: 'pos' },
    move: { from: 1 },
    zones: {},
    periodPick: {},
    bankRow: { row: { id: 'b1', date: F.today(), descr: 'Line', amt: -100, state: 'unexplained' } },
    delorder: { ord: { no: 'DL-1', channel: 'delivery', tender: 'card', sold: [], net: 0, svc: 0, tax: 0, total: 0 } },
    ticket: { slot: 1, tender: 'cash' },
    receipt: { ord: { no: 'R-1', channel: 'dine_in', tender: 'cash', sold: [], net: 0, svc: 0, tax: 0, total: 0 } },
    z: {},
    settled: { snap: { no: 'R-1', time: '12:00', table: 'T01', tender: 'cash', lines: [], sold: [], T: F.totals(F.blankTicket()), given: 0, change: 0, server: '', split: '' } },
    creditNote: { row: { no: 'CN-1', amt: 0 } },
    count: {},
    form: { form: 'item', vals: {} },
    guest: { slot: 1, idx: 0 },
    held: {},
    dishb: { dish: dish },
    menuio: {},
    outlet: { id: F.state.outletId },
    recipeb: { dish: dish },
    resv: { r: { t: '19:00', name: 'Guest', party: 2, status: 'pending' } },
    catb: { cat: (K.MENU_CATEGORIES || [])[0] || { id: 'c', name: 'Cat' } },
    info: { title: 'Info', sub: '', rows: [] },
    outletDetail: { id: F.state.outletId },
    user: { user: user },
    customer: { cust: cust },
    dish: { dish: dish, acct: acct }
  };
}

function sweepModals(F, kinds) {
  const errs = [];
  const seed = modalSeed(F);
  let rendered = 0, fired = 0;
  const seen = new WeakSet();
  const invoke = (v, where, depth) => {
    if (v == null || depth > 4) return;
    if (typeof v === 'function') {
      fired++;
      try { v(EV); } catch (e) { errs.push(where + ' :: ' + e.message); }
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 25).forEach((x, i) => invoke(x, where + '[' + i + ']', depth + 1));
    Object.keys(v).forEach((k) => { if (!/Style$|^style$/.test(k)) invoke(v[k], where + '.' + k, depth + 1); });
  };
  (kinds || MODAL_KINDS).forEach((k) => {
    const m = Object.assign({ kind: k }, seed[k] || {});
    try {
      F.state.modal = m;
      const vals = F.modalVals ? F.modalVals(m) : (F.overlayVals ? F.overlayVals() : null);
      rendered++;
      invoke(vals, 'modal:' + k, 0);
    } catch (e) {
      errs.push('modal:' + k + ' :: ' + e.message);
    } finally {
      F.state.modal = null;
    }
  });
  return { rendered, fired, errs };
}

/* ── 3 · every form spec ────────────────────────────────────────────────── */
function sweepForms(F, names) {
  const errs = [];
  let rendered = 0;
  (names || FORMS).forEach((n) => {
    try {
      const spec = F.formSpec(n, {});
      if (!spec) { errs.push('form:' + n + ' :: no spec'); return; }
      rendered++;
      // A form's foot is not decoration: it states the consequence of saving.
      if (!spec.title) errs.push('form:' + n + ' :: no title');
    } catch (e) { errs.push('form:' + n + ' :: ' + e.message); }
  });
  return { rendered, errs };
}

module.exports = {
  loadLogic, makeInstance, sweep, sweepModals, sweepForms,
  GENERATORS, MODAL_KINDS, FORMS, EV
};
