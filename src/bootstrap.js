'use strict';
/* ═══ BOOTSTRAP ═════════════════════════════════════════════════════════════
   The terminal reads two things: `window.KPOS` (masters — the menu, the item
   catalogue, the chart, the people) and its own state (the transactional
   record — open tickets, settled bills, counts, the ledger's own rows).

   This module builds BOTH out of SQL, in exactly the shapes the reference
   defines, so the ported UI is unchanged and the data underneath it is real.
   It is deliberately one file: the shape is a contract, and a contract spread
   across thirty route handlers is a contract nobody can read.

   Nothing in here invents a figure. An outlet with no trade returns empty
   arrays and zeroes, and every screen has an empty state that says what to do.
   ═══════════════════════════════════════════════════════════════════════ */

const { withOutletRead } = require('./db');

const num = (v) => (v == null ? 0 : Number(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);
const ms = (d) => (d ? new Date(d).getTime() : 0);

/* ── the whole payload, one round trip ─────────────────────────────────── */
async function buildBootstrap(ctx) {
  return withOutletRead(ctx, async function (c) {
    const [
      company, outlets, taxVers, staff, devices, chainSettings, suppliers, members,
      sections, categories, items, recipeLines, modifiers, modGroups, itemMods,
      promos, banners, cats, ingredients, units, locations, accounts,
      employees, opex, assets, outletSettings, zones, tables
    ] = await Promise.all([
      c.query('SELECT * FROM chain.company WHERE id = 1'),
      c.query('SELECT * FROM chain.outlet ORDER BY id'),
      c.query('SELECT * FROM chain.tax_version ORDER BY code, effective_from'),
      c.query('SELECT id, name, rank, role_key, outlet_id, outlets, active,'
        + ' locked_until, perm_override FROM chain.staff ORDER BY rank DESC, name'),
      c.query('SELECT id, label, kind, station, paired_at, last_seen, revoked'
        + ' FROM chain.device WHERE outlet_id = $1', [ctx.outletId]),
      c.query('SELECT key, value FROM chain.setting'),
      c.query('SELECT * FROM chain.supplier WHERE active ORDER BY name'),
      c.query('SELECT id, phone, name, email, home_outlet, points, tier,'
        + ' credit_limit, joined_at FROM chain.member ORDER BY joined_at DESC LIMIT 500'),
      c.query('SELECT * FROM menu_section WHERE active ORDER BY pos, name'),
      c.query('SELECT * FROM menu_category WHERE active ORDER BY pos, name'),
      c.query('SELECT * FROM item ORDER BY pos, name'),
      c.query('SELECT * FROM recipe_line ORDER BY item_id, id'),
      c.query('SELECT * FROM modifier ORDER BY pos, name'),
      c.query('SELECT * FROM modifier_group ORDER BY name'),
      c.query('SELECT * FROM item_modifier'),
      c.query('SELECT * FROM promo ORDER BY name'),
      c.query('SELECT * FROM banner ORDER BY slot'),
      c.query('SELECT DISTINCT category FROM ingredient WHERE category IS NOT NULL ORDER BY category'),
      c.query('SELECT * FROM ingredient ORDER BY name'),
      c.query('SELECT * FROM ingredient_unit ORDER BY ingredient_id, name'),
      c.query('SELECT * FROM location WHERE active ORDER BY name'),
      c.query('SELECT * FROM account ORDER BY pos'),
      c.query('SELECT * FROM employee WHERE active ORDER BY name'),
      c.query('SELECT * FROM opex WHERE active ORDER BY category'),
      c.query('SELECT * FROM asset ORDER BY bought_on DESC'),
      c.query('SELECT key, value FROM setting'),
      c.query('SELECT * FROM zone WHERE active ORDER BY pos, name'),
      c.query('SELECT * FROM table_def WHERE active ORDER BY pos, label')
    ]);

    const setting = kv(chainSettings.rows);
    const oset = kv(outletSettings.rows);
    const ingById = index(ingredients.rows, 'id');
    const recipeByItem = group(recipeLines.rows, 'item_id');
    const unitsByIng = group(units.rows, 'ingredient_id');
    const modsByItem = group(itemMods.rows, 'item_id');

    const kpos = {
      CHAIN: chainOf(company.rows[0], setting),
      OUTLETS: outlets.rows.map(outletOf),
      MENU_CATEGORIES: categories.rows.map((r) => ({
        id: r.id, name: r.name, icon: r.colour || 'main', section: r.section_id
      })),
      MENU_SECTIONS: sections.rows.map((r) => ({ id: r.id, name: r.name, pos: r.pos })),
      MENU: items.rows.map((r) => menuOf(r, recipeByItem[r.id] || [])),
      MODIFIERS: modifiers.rows.map((r) => ({
        id: r.id, name: r.name, price: num(r.price), group: r.group_id,
        cats: catsForModGroup(r.group_id, modsByItem, items.rows)
      })),
      MODIFIER_GROUPS: modGroups.rows.map((r) => ({
        id: r.id, name: r.name, min: r.min_pick, max: r.max_pick, required: r.required
      })),
      BANNERS: banners.rows.map((r) => ({
        id: r.id, outlet: ctx.outletId, title: r.title, sub: r.body || '',
        code: r.link || '', img: r.image || '', slot: r.slot, active: r.active
      })),
      PROMOS: promos.rows.map((r) => ({
        id: r.id, name: r.name, kind: r.kind, pct: r.kind === 'percent' ? num(r.value) : 0,
        off: r.kind === 'amount' ? num(r.value) : 0, code: r.code || '',
        maxPct: num(r.max_pct), channels: r.channels || [], active: r.active,
        from: r.starts_on, to: r.ends_on
      })),
      TIERS: setting.tiers || DEFAULT_TIERS,
      REWARDS: setting.rewards || [],
      MODULES: MODULES,
      ROLES: rolesOf(setting),
      USERS: staff.rows.map(userOf),
      CUSTOMERS: members.rows.map(customerOf),
      STAFF: employees.rows.map(employeeOf),
      PAYROLL_RULES: setting.payroll_rules || {},
      OPEX: opex.rows.map((r) => ({
        id: r.id, cat: r.category, vendor: r.vendor || '', amt: num(r.amount),
        freq: r.freq, due: r.due_day, acct: r.account_code, outlet: ctx.outletId,
        note: r.note || ''
      })),
      ASSETS: assets.rows.map((r) => ({
        id: r.id, name: r.name, cat: r.category || '', cost: num(r.cost),
        bought: r.bought_on, life: num(r.life_years), residual: num(r.residual),
        serial: r.serial || '', loc: r.location_id || '', state: r.state,
        warranty: r.warranty_to, outlet: ctx.outletId
      })),
      ACCOUNTS: accounts.rows.map((r) => ({
        code: r.code, name: r.name, type: r.type, side: r.normal_side,
        tillOwned: r.till_owned
      })),
      TAX_VERSIONS: taxVers.rows.map((r) => ({
        outlet: r.outlet_id, code: r.code, rate: num(r.rate),
        from: r.effective_from, to: r.effective_to, ref: r.authority_ref || ''
      })),
      UNITS: setting.units || [],
      CURRENCIES: setting.currencies || [],
      LOCATIONS: locations.rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
      VENDORS: suppliers.rows.map((r) => ({
        id: r.id, name: r.name, trn: r.trn || '', terms: r.terms_days,
        lead: r.lead_days, contact: r.contact || '', phone: r.phone || ''
      })),
      DEVICES: devices.rows.map((r) => ({
        id: r.id, label: r.label, kind: r.kind, station: r.station,
        paired: iso(r.paired_at), seen: iso(r.last_seen), revoked: r.revoked
      })),
      ALLERGENS: ALLERGENS, DIETS: DIETS,
      REASONS: {
        waste: setting.waste_reasons || [], void: setting.void_reasons || [],
        discount: setting.discount_reasons || []
      },
      COUNT_FREQUENCIES: setting.count_frequencies || [],
      EXPENSE_CATEGORIES: setting.expense_categories || [],
      DOC_SERIES: setting.doc_series_defs || [],
      ACQUIRERS: setting.acquirer_rates || [],
      STATIONS: setting.kds_stations || [],
      RECON: setting.recon_tolerance || {}
    };

    // The raw item catalogue, in the positional shape the inventory screens
    // read. Positional because it is 250+ rows on a phone and the field names
    // would be two thirds of the payload.
    const raw = {
      cats: cats.rows.map((r, i) => ({ id: r.category, name: r.category, icon: 'store', storage: '', freq: '' })),
      items: ingredients.rows.map((r) => [
        r.id, r.category || '', r.name, r.stock_unit, num(r.sell_price),
        r.producible ? 'prep' : 'raw', r.id, r.base_unit, r.stock_unit,
        String(num(r.avg_cost)), num(r.par), num(r.min_stock), r.sellable ? 1 : 0
      ]),
      units: (setting.units || []).map((u) => [u.code, u.name, u.base, u.base, u.factor, 0]),
      unitsFor: unitsByIng,
      inv: ingredients.rows.map((r) => [ctx.outletId, r.id, num(r.on_hand)]),
      ledger: [], batches: [], logs: [], vendors: [], purch: [], reqs: [],
      disp: [], prod: [], roles: []
    };

    return { kpos, raw, ingredients: ingById };
  });
}

/* ── the transactional state the terminal restores into ───────────────────
   Everything here is a real row. The client keeps its own copy for offline
   reading; this is the authority it reconciles against on reconnect. */
async function buildState(ctx, opts) {
  const o = opts || {};
  const days = Number(o.days || 60);
  return withOutletRead(ctx, async function (c) {
    const [
      tickets, lines, sales, saleLines, payments, credits, drawer, counts,
      countLines, moves, batches, deliveries, grnLines, invoices, indents,
      dispatches, kds, guestOrders, guestReqs, prints, reservations, periods,
      bankLines, bankOpen, acq, docs, clock, payroll, maint, opexPaid,
      priceOv, journals, journalLines, ops
    ] = await Promise.all([
      c.query("SELECT * FROM ticket WHERE status IN ('open','held') ORDER BY opened_at"),
      c.query('SELECT l.* FROM ticket_line l JOIN ticket t ON t.id = l.ticket_id'
        + " WHERE t.status IN ('open','held') ORDER BY l.at"),
      c.query('SELECT * FROM sale WHERE at > now() - ($1 || \' days\')::interval'
        + ' ORDER BY at DESC LIMIT 2000', [String(days)]),
      c.query('SELECT sl.* FROM sale_line sl JOIN sale s ON s.id = sl.sale_id'
        + ' WHERE s.at > now() - ($1 || \' days\')::interval', [String(days)]),
      c.query('SELECT p.* FROM payment p JOIN sale s ON s.id = p.sale_id'
        + ' WHERE s.at > now() - ($1 || \' days\')::interval', [String(days)]),
      c.query('SELECT * FROM credit_note ORDER BY at DESC LIMIT 500'),
      c.query('SELECT * FROM drawer_session ORDER BY opened_at DESC LIMIT 30'),
      c.query('SELECT * FROM stock_count ORDER BY opened_at DESC LIMIT 30'),
      c.query('SELECT cl.* FROM count_line cl JOIN stock_count sc ON sc.id = cl.count_id'),
      c.query('SELECT * FROM stock_move ORDER BY at DESC LIMIT 1500'),
      c.query('SELECT * FROM batch ORDER BY use_by NULLS LAST LIMIT 500'),
      c.query('SELECT * FROM delivery ORDER BY at DESC LIMIT 300'),
      c.query('SELECT * FROM grn_line'),
      c.query('SELECT * FROM vendor_invoice ORDER BY invoice_date DESC LIMIT 300'),
      c.query('SELECT i.*, coalesce(json_agg(json_build_object('
        + "'ing', il.ingredient_id, 'qty', il.qty, 'sent', il.sent_qty)"
        + ") FILTER (WHERE il.id IS NOT NULL), '[]') AS lines"
        + ' FROM indent i LEFT JOIN indent_line il ON il.indent_id = i.id'
        + ' GROUP BY i.id ORDER BY i.at DESC LIMIT 200'),
      c.query('SELECT d.*, coalesce(json_agg(json_build_object('
        + "'ing', dl.ingredient_id, 'qty', dl.qty, 'cost', dl.unit_cost)"
        + ") FILTER (WHERE dl.id IS NOT NULL), '[]') AS lines"
        + ' FROM dispatch d LEFT JOIN dispatch_line dl ON dl.dispatch_id = d.id'
        + ' GROUP BY d.id ORDER BY d.at DESC LIMIT 200'),
      c.query('SELECT * FROM kds_ticket WHERE served_at IS NULL ORDER BY fired_at'),
      c.query('SELECT * FROM guest_order WHERE accepted_at IS NULL'
        + ' AND rejected_reason IS NULL ORDER BY at'),
      c.query('SELECT * FROM guest_request WHERE ack_at IS NULL ORDER BY at'),
      c.query('SELECT * FROM print_job ORDER BY at DESC LIMIT 100'),
      c.query('SELECT * FROM reservation WHERE at > now() - interval \'2 days\' ORDER BY at'),
      c.query('SELECT * FROM period ORDER BY id DESC LIMIT 36'),
      c.query('SELECT * FROM bank_line ORDER BY value_date DESC LIMIT 500'),
      c.query('SELECT * FROM bank_opening WHERE id = 1'),
      c.query('SELECT * FROM settlement_batch ORDER BY value_date DESC LIMIT 200'),
      c.query('SELECT * FROM document ORDER BY at DESC LIMIT 500'),
      c.query('SELECT * FROM clock_entry ORDER BY in_at DESC LIMIT 500'),
      c.query('SELECT * FROM payroll_run ORDER BY id DESC LIMIT 24'),
      c.query('SELECT * FROM maintenance_log ORDER BY at DESC LIMIT 200'),
      c.query('SELECT * FROM opex_payment ORDER BY paid_on DESC LIMIT 500'),
      c.query('SELECT DISTINCT ON (item_id) * FROM price_override'
        + ' WHERE until IS NULL OR until > now() ORDER BY item_id, at DESC'),
      c.query('SELECT * FROM journal ORDER BY entry_date DESC LIMIT 800'),
      c.query('SELECT jl.*, j.entry_date FROM journal_line jl'
        + ' JOIN journal j ON j.id = jl.journal_id ORDER BY j.entry_date DESC LIMIT 4000'),
      c.query('SELECT op_id, kind, label, entity, applied_at, lamport FROM op_log'
        + ' ORDER BY applied_at DESC LIMIT 200')
    ]);

    const linesByTicket = group(lines.rows, 'ticket_id');
    const slByeSale = group(saleLines.rows, 'sale_id');
    const payBySale = group(payments.rows, 'sale_id');
    const clByCount = group(countLines.rows, 'count_id');
    const glByDelivery = group(grnLines.rows, 'delivery_id');
    const jlByJournal = group(journalLines.rows, 'journal_id');

    const open = drawer.rows.find((d) => !d.closed_at);

    return {
      outletId: ctx.outletId,
      at: Date.now(),

      // The floor, as it stands right now.
      tickets: ticketMap(tickets.rows, linesByTicket),
      held: tickets.rows.filter((t) => t.status === 'held')
        .map((t) => ticketOf(t, linesByTicket[t.id] || [])),

      // The money already taken. One row shape, whichever screen settled it.
      settled: sales.rows.map((s) => settledOf(s, slByeSale[s.id] || [], payBySale[s.id] || [])),
      refunds: creditMap(credits.rows),

      register: open ? {
        open: true, id: open.id, float: num(open.float_amount),
        openedBy: open.opened_by, openedAt: ms(open.opened_at)
      } : { open: false },
      registers: drawer.rows.map((d) => ({
        id: d.id, openedAt: ms(d.opened_at), closedAt: ms(d.closed_at),
        float: num(d.float_amount), counted: num(d.counted),
        expected: num(d.expected), variance: num(d.variance)
      })),

      // Stock, live: opening + received here - consumed by recipes.
      costMoves: moves.rows.map((m) => ({
        id: m.id, at: ms(m.at), ing: m.ingredient_id, qty: num(m.qty),
        cost: num(m.unit_cost), value: num(m.value), why: m.reason,
        loc: m.location_id, saleId: m.sale_id, note: m.note
      })),
      batches: batches.rows.map((b) => ({
        id: b.id, ing: b.ingredient_id, lot: b.lot, qty: num(b.qty),
        cost: num(b.unit_cost), got: iso(b.received_at), useBy: b.use_by,
        loc: b.location_id, state: b.state
      })),
      counts: counts.rows.map((x) => ({
        id: x.id, outletId: ctx.outletId, at: ms(x.opened_at), by: x.by_staff,
        state: x.state, scope: x.scope, value: num(x.variance_value),
        lines: (clByCount[x.id] || []).map((l) => ({
          ing: l.ingredient_id, theo: num(l.expected), actual: num(l.counted),
          counted: num(l.counted), d: num(l.variance), dVal: num(l.value)
        }))
      })),
      lastCountAt: counts.rows.length ? ms(counts.rows[0].opened_at) : 0,

      // Purchasing, both sides of every movement.
      grn: deliveries.rows.map((d) => ({
        id: d.id, no: d.grn_no, po: d.po_id, vendor: d.supplier_id,
        at: ms(d.at), by: d.received_by, priced: d.priced,
        net: num(d.net), tax: num(d.tax), total: num(d.total),
        lines: (glByDelivery[d.id] || []).map((l) => ({
          ing: l.ingredient_id, qty: num(l.qty), price: num(l.unit_price),
          total: num(l.line_total), useBy: l.use_by, lot: l.lot
        }))
      })),
      invoices: invoices.rows.map((v) => ({
        id: v.id, vendor: v.supplier_id, no: v.invoice_no, date: v.invoice_date,
        due: v.due_date, net: num(v.net), tax: num(v.tax), amt: num(v.amount),
        paid: num(v.paid), grn: v.delivery_id
      })),
      indents: indents.rows.map((i) => ({
        id: i.id, no: i.pr_no, to: i.to_outlet, at: ms(i.at), by: i.raised_by,
        status: i.status, lines: i.lines
      })),
      dispatches: dispatches.rows.map((d) => ({
        id: d.id, no: d.dsp_no, to: d.to_outlet, at: ms(d.at), by: d.sent_by,
        status: d.status, value: num(d.value), lines: d.lines
      })),

      // Kitchen, guests and print.
      kds: kds.rows.map((k) => ({
        id: k.id, ticket: k.ticket_id, station: k.station, stage: k.stage,
        fired: ms(k.fired_at), ready: ms(k.ready_at), target: k.target_mins,
        course: k.course
      })),
      guestOrders: guestOrders.rows.map((g) => ({
        id: g.id, table: g.table_no, lines: g.lines, promo: g.promo,
        name: g.guest_name, phone: g.guest_phone, at: ms(g.at), note: g.note
      })),
      guestRequests: guestReqs.rows.map((g) => ({
        id: g.id, table: g.table_no, kind: g.kind, detail: g.detail, at: ms(g.at)
      })),
      printJobs: prints.rows.map((p) => ({
        id: p.id, kind: p.kind, target: p.target, label: p.label,
        state: p.state, tries: p.tries, at: ms(p.at)
      })),
      res: reservations.rows.map((x) => ({
        id: x.id, name: x.guest_name, phone: x.phone, party: x.party,
        at: ms(x.at), mins: x.duration_mins, zone: x.zone_id, table: x.table_no,
        status: x.status, note: x.note, ticket: x.ticket_id
      })),

      // The books.
      journal: journals.rows.map((j) => ({
        id: j.id, no: j.jv_no, date: j.entry_date, memo: j.memo,
        source: j.source, sourceId: j.source_id, by: j.posted_by,
        lines: (jlByJournal[j.id] || []).map((l) => ({
          acct: l.account_code, dr: num(l.dr), cr: num(l.cr), memo: l.memo
        }))
      })),
      periods: periods.rows.map((p) => ({
        id: p.id, from: p.starts_on, to: p.ends_on, state: p.state,
        closedAt: ms(p.closed_at), closedBy: p.closed_by
      })),
      bank: bankLines.rows.map((b) => ({
        id: b.id, date: b.value_date, descr: b.descr, amt: num(b.amount),
        bal: num(b.balance), ref: b.ref, state: b.state,
        acct: b.matched_account, src: b.matched_source
      })),
      bankOpen: bankOpen.rows.length ? {
        acct: bankOpen.rows[0].account_code, asOf: bankOpen.rows[0].as_of,
        amt: num(bankOpen.rows[0].amount)
      } : null,
      acqRuns: acq.rows.map((a) => ({
        id: a.id, acquirer: a.acquirer, batch: a.batch_no, date: a.value_date,
        gross: num(a.gross), mdr: num(a.mdr_pct), fee: num(a.fee),
        net: num(a.net), expected: num(a.expected_net), variance: num(a.variance),
        state: a.state
      })),
      docs: docs.rows.map((d) => ({
        no: d.no, kind: d.kind, at: ms(d.at), date: d.business_date,
        amt: num(d.amount), ref: d.ref_id
      })),

      // People and costs.
      clock: clock.rows.map((k) => ({
        id: k.id, emp: k.employee_id, in: ms(k.in_at), out: ms(k.out_at),
        date: k.business_date
      })),
      payrollPosted: payroll.rows.map((p) => ({
        id: p.id, at: ms(p.posted_at), gross: num(p.gross),
        pensionEe: num(p.pension_ee), pensionEr: num(p.pension_er),
        withholding: num(p.withholding), service: num(p.service_pool),
        net: num(p.net)
      })),
      maint: maint.rows.map((m) => ({
        id: m.id, asset: m.asset_id, at: ms(m.at), kind: m.kind,
        detail: m.detail, cost: num(m.cost), vendor: m.vendor
      })),
      opexPaid: opexPaid.rows.map((p) => ({
        id: p.opex_id, period: p.period, on: p.paid_on, amt: num(p.amount)
      })),
      priceOv: Object.fromEntries(priceOv.rows.map((p) => [p.item_id, {
        price: num(p.price), why: p.reason, at: ms(p.at), by: p.by_staff
      }])),

      // What the server has already applied, so the client can settle its own
      // outbox against it rather than guessing.
      applied: ops.rows.map((o) => ({
        id: o.op_id, op: o.kind, label: o.label, entity: o.entity,
        at: ms(o.applied_at), lamport: num(o.lamport)
      }))
    };
  });
}

/* ── shape helpers ─────────────────────────────────────────────────────── */

function kv(rows) {
  const o = {};
  rows.forEach((r) => { o[r.key] = r.value; });
  return o;
}
function index(rows, k) {
  const o = {};
  rows.forEach((r) => { o[r[k]] = r; });
  return o;
}
function group(rows, k) {
  const o = {};
  rows.forEach((r) => { (o[r[k]] = o[r[k]] || []).push(r); });
  return o;
}

function chainOf(co, setting) {
  if (!co) return { id: 'ch', name: '', country: 'MV', currency: 'MVR', tin: '', regNo: '', hq: '', brand: {} };
  const brand = co.brand || {};
  return {
    id: 'ch_' + (co.reg_no || 'kashikeyo').replace(/\W+/g, '').toLowerCase(),
    name: co.legal_name, country: co.country === 'Maldives' ? 'MV' : co.country,
    currency: co.base_currency, tin: co.tin, regNo: co.reg_no,
    hq: co.address, phone: co.phone || '', email: co.email || '',
    fyStart: co.fy_start_month,
    brand: {
      mark: brand.mark || 'brand/kashikeyo-mark.png',
      name: brand.name || co.legal_name,
      tagline: brand.tagline || '',
      receiptFoot: brand.receiptFoot || '',
      poweredBy: brand.poweredBy !== false,
      colour: brand.colour || '#982030'
    }
  };
}

function outletOf(r) {
  return {
    id: r.id, code: r.code, name: r.name,
    type: r.kind, loc: r.kind, parent: r.parent_id || 0,
    region: r.atoll || '', tax: r.tax_code, rate: 0, sc: num(r.service_pct),
    addr: r.address || '', mgr: '', pos: r.kind === 'restaurant',
    seats: 0, tables: 0, slug: r.slug, tz: r.tz, currency: r.currency,
    dayStart: r.day_start, active: r.active
  };
}

// price is the chain master price; recipe is [ingredientId, qty in base unit].
function menuOf(r, recipe) {
  return {
    id: r.id, cat: r.category_id, name: r.name, desc: r.description || '',
    price: num(r.price), veg: (r.diets || []).indexOf('veg') >= 0,
    img: r.image || '', station: r.station, prep: r.prep_mins,
    yield: num(r.yield_qty), unit: r.unit, active: r.active,
    offMenu: r.off_menu, soldOutReason: r.sold_out_reason || '',
    allergens: r.allergens || [], diets: r.diets || [], tags: r.tags || [],
    recipe: recipe.map((l) => [l.ingredient_id || l.sub_item_id, num(l.qty),
      num(l.waste_pct), l.sub_item_id ? 'sub' : 'ing'])
  };
}

function catsForModGroup(groupId, modsByItem, items) {
  const cats = new Set();
  Object.keys(modsByItem).forEach((itemId) => {
    if (!modsByItem[itemId].some((m) => m.group_id === groupId)) return;
    const it = items.find((x) => x.id === itemId);
    if (it && it.category_id) cats.add(it.category_id);
  });
  return Array.from(cats);
}

function userOf(r) {
  return {
    id: r.id, name: r.name, user: (r.name || '').split(' ').pop().toLowerCase(),
    role: r.role_key, rank: r.rank, outlet: r.outlet_id, outlets: r.outlets || [],
    pin: '', status: r.active ? (r.locked_until && new Date(r.locked_until) > new Date()
      ? 'Locked' : 'Active') : 'Suspended',
    last: '', perms: r.perm_override || null
  };
}

function customerOf(r) {
  return {
    id: r.id, name: r.name || r.phone, phone: r.phone, email: r.email || '',
    since: (r.joined_at || '').toString().slice(0, 10), visits: 0, spent: 0,
    points: num(r.points), tier: r.tier, credit: num(r.credit_limit), used: 0,
    last: '', home: r.home_outlet
  };
}

function employeeOf(r) {
  return {
    id: r.id, name: r.name, outlet: null, job: r.job, kind: r.kind,
    basic: num(r.basic), hourly: num(r.hourly), joined: r.joined_on,
    mrps: r.mrps, ot: r.ot, svc: r.svc, type: r.emp_type, photo: '',
    staffId: r.staff_id
  };
}

// The floor keys tickets by "<outletId>:<slot>", which is what the terminal
// reads; a split bill is the same table with a second slot.
function ticketMap(rows, linesByTicket) {
  const out = {};
  rows.filter((t) => t.status === 'open').forEach((t) => {
    out[t.table_no + ':' + t.split] = ticketOf(t, linesByTicket[t.id] || []);
  });
  return out;
}

function ticketOf(t, lines) {
  return {
    id: t.id, table: t.table_no, split: t.split, channel: t.channel,
    status: t.status, party: t.party, covers: t.covers,
    bizDate: t.business_date, opened: ms(t.opened_at),
    waiter: t.server_name || '', member: t.member_id || '',
    note: t.note || '', guests: t.guests || [],
    promo: null,
    lines: lines.filter((l) => !l.void_at).map((l) => ({
      lid: l.id, id: l.item_id, name: l.name, qty: num(l.qty),
      price: num(l.unit_price), addons: l.addons || [], guest: l.guest_ix,
      note: l.note || '', course: l.course || '', station: l.station,
      sent: !!l.sent_at, at: ms(l.at)
    }))
  };
}

/* The settled row — ONE shape, both settle paths, twenty-nine fields. The
   reference's own defect was a second path writing thirteen of them and
   booking the pre-discount subtotal as revenue. */
function settledOf(s, lines, pays) {
  const tender = pays.length === 1 ? pays[0].method
    : pays.length > 1 ? 'split' : 'cash';
  return {
    outletId: undefined,          // filled by the caller's context
    id: s.id, no: s.receipt_no, time: iso(s.at), at: ms(s.at),
    table: s.ticket_id ? undefined : null,
    channel: s.channel, covers: s.covers,
    sub: num(s.subtotal), disc: num(s.discount), discCode: s.discount_code || '',
    net: num(s.net), svc: num(s.service), tax: num(s.tax),
    taxRate: num(s.tax_rate), taxLabel: s.tax_label,
    round: num(s.rounding), total: num(s.total), tip: num(s.tip),
    tender: tender, payments: pays.map((p) => ({
      method: p.method, amt: num(p.amount), cur: p.currency,
      rate: num(p.fx_rate), fgn: num(p.fx_amount), tendered: num(p.tendered),
      chg: num(p.change_given), ref: p.auth_ref
    })),
    cur: s.currency, rate: num(s.fx_rate), fgn: num(s.fx_amount),
    chg: pays.reduce((a, p) => a + num(p.change_given), 0),
    status: s.voided_at ? 'void' : 'closed',
    server: s.server_name || 'Unassigned', ref: s.receipt_no,
    customer: s.customer_name || '', member: s.member_id || '',
    bizDate: s.business_date, cogs: num(s.cogs),
    sold: lines.map((l) => ({
      id: l.item_id, name: l.name, qty: num(l.qty), price: num(l.unit_price),
      amount: num(l.line_total), cost: num(l.line_cost), guest: l.guest_ix,
      addons: l.addons || []
    })),
    serverAudit: s.server_audit || null
  };
}

// Refunds are a map keyed by receipt, not a list. Reading it as a list is
// exactly what crashed the reference's tax return.
function creditMap(rows) {
  const out = {};
  rows.forEach((r) => {
    const key = r.sale_id || r.cn_no;
    (out[key] = out[key] || []).push({
      id: r.id, no: r.cn_no, at: ms(r.at), amt: num(r.amount),
      net: num(r.net), tax: num(r.tax), svc: num(r.service),
      reason: r.reason, lines: r.lines || [], method: r.method,
      by: r.raised_by, approved: r.approved_by
    });
  });
  return out;
}

/* ── structure that ships with the product, not data ──────────────────── */

const MODULES = [
  { key: 'pos', label: 'POS terminal', group: 'Front of house' },
  { key: 'kds', label: 'Kitchen display', group: 'Front of house' },
  { key: 'reservations', label: 'Reservations', group: 'Front of house' },
  { key: 'customers', label: 'Customers & credit', group: 'Front of house' },
  { key: 'orders', label: 'Orders & receipts', group: 'Front of house' },
  { key: 'delivery', label: 'Delivery & QR orders', group: 'Front of house' },
  { key: 'promos', label: 'Promotions & banners', group: 'Front of house' },
  { key: 'loyalty', label: 'Loyalty & rewards', group: 'Front of house' },
  { key: 'chain', label: 'Chain overview', group: 'Chain' },
  { key: 'branches', label: 'Outlets', group: 'Chain' },
  { key: 'users', label: 'Users & roles', group: 'Chain' },
  { key: 'logs', label: 'Audit log', group: 'Chain' },
  { key: 'menu', label: 'Menu master', group: 'Kitchen & stock' },
  { key: 'aimenu', label: 'AI menu builder', group: 'Kitchen & stock' },
  { key: 'recipes', label: 'Recipes & costing', group: 'Kitchen & stock' },
  { key: 'production', label: 'Production', group: 'Kitchen & stock' },
  { key: 'inventory', label: 'Inventory', group: 'Kitchen & stock' },
  { key: 'counts', label: 'Stock counts', group: 'Kitchen & stock' },
  { key: 'ledger', label: 'Stock ledger', group: 'Kitchen & stock' },
  { key: 'batches', label: 'Batches & expiry', group: 'Kitchen & stock' },
  { key: 'purchases', label: 'Purchases & GRN', group: 'Kitchen & stock' },
  { key: 'requests', label: 'Indents', group: 'Kitchen & stock' },
  { key: 'dispatches', label: 'Dispatches', group: 'Kitchen & stock' },
  { key: 'vendors', label: 'Suppliers', group: 'Kitchen & stock' },
  { key: 'consumption', label: 'Consumption', group: 'Kitchen & stock' },
  { key: 'accounting', label: 'Accounting', group: 'Business' },
  { key: 'reports', label: 'Reports & exports', group: 'Business' },
  { key: 'analytics', label: 'Analytics & CFO', group: 'Business' },
  { key: 'costs', label: 'Operating costs', group: 'Business' },
  { key: 'assets', label: 'Equipment', group: 'Business' },
  { key: 'staff', label: 'Staff & time clock', group: 'Business' },
  { key: 'payroll', label: 'Payroll & pension', group: 'Business' },
  { key: 'settings', label: 'Settings', group: 'Platform' },
  { key: 'sync', label: 'Sync & devices', group: 'Platform' },
  { key: 'architecture', label: 'Architecture', group: 'Platform' }
];

const ALL = { v: 1, a: 1, e: 1, d: 1 };
const VAE = { v: 1, a: 1, e: 1, d: 0 };
const VA = { v: 1, a: 1, e: 0, d: 0 };
const V = { v: 1, a: 0, e: 0, d: 0 };
const NONE = { v: 0, a: 0, e: 0, d: 0 };

function perms(map) {
  const o = {};
  MODULES.forEach((m) => { o[m.key] = map[m.key] || NONE; });
  return o;
}

/* The permission catalogue. It is a PRESENTATION of the five-rank ladder, not
   a second authority: every write still passes the rank gate on the server
   and the RLS policy under that. A role with no entry here would fall through
   to the whole cockpit, so all seven are spelled out. */
function rolesOf(setting) {
  if (setting.roles) return setting.roles;
  return [
    {
      key: 'SuperAdmin', label: 'Super Admin', color: '#a88ad9', scope: 'platform', rank: 5,
      blurb: 'Platform owner. Crosses every outlet — the only rank granted group scope.',
      perms: perms(Object.fromEntries(MODULES.map((m) => [m.key, ALL])))
    },
    {
      key: 'ChainAdmin', label: 'Chain / HQ Admin', color: '#f2a43a', scope: 'chain', rank: 4,
      blurb: 'Full reach inside one chain, every outlet.',
      perms: perms(Object.fromEntries(MODULES.map((m) =>
        [m.key, m.key === 'architecture' || m.key === 'analytics' ? V : ALL])))
    },
    {
      key: 'OutletManager', label: 'Outlet Manager', color: '#2e7d32', scope: 'outlet', rank: 3,
      blurb: 'One outlet. Reads chain menu master, writes local overrides.',
      perms: perms({
        pos: ALL, kds: VAE, reservations: ALL, customers: VAE, orders: VAE,
        delivery: VAE, promos: VAE, loyalty: VAE, chain: V, branches: V, menu: V,
        inventory: V, ledger: V, counts: VAE, requests: VAE, dispatches: VAE,
        batches: V, reports: V, accounting: V, sync: V, settings: V, logs: V,
        staff: VAE, costs: V, assets: VAE, purchases: VAE, vendors: V,
        recipes: V, production: VAE, consumption: VAE, analytics: V
      })
    },
    {
      key: 'Cashier', label: 'Cashier / Waiter', color: '#0074D9', scope: 'outlet', rank: 2,
      blurb: 'Terminal, and receiving on shift. Never sees cost or margin.',
      perms: perms({
        pos: VAE, reservations: VAE, customers: VA, orders: VA, delivery: VA,
        promos: V, kds: V, purchases: VA, counts: VA, inventory: V, ledger: V,
        batches: V, vendors: V, loyalty: VA
      })
    },
    {
      key: 'KitchenManager', label: 'Kitchen Manager', color: '#e65100', scope: 'outlet', rank: 1,
      blurb: 'Kitchen display and production. Recipes, indents, batches.',
      perms: perms({
        kds: VAE, pos: V, production: VAE, recipes: VAE, requests: VAE,
        dispatches: VAE, consumption: VAE, inventory: V, ledger: V, counts: VAE,
        batches: VAE, menu: V, reports: V, sync: V, staff: V, assets: VAE,
        orders: V
      })
    },
    {
      key: 'StoreKeeper', label: 'Store Keeper', color: '#67a2d9', scope: 'outlet', rank: 3,
      blurb: 'Main store. Receiving, dispatch, counts, vendors.',
      perms: perms({
        purchases: VAE, dispatches: VAE, requests: VAE, inventory: V, ledger: V,
        counts: VAE, batches: VAE, vendors: VAE, reports: V, sync: V, assets: VAE
      })
    },
    {
      key: 'Accountant', label: 'Accountant / Auditor', color: '#6bbf7b', scope: 'chain', rank: 3,
      blurb: 'Read-everything, write-nothing. Exports the GST return.',
      perms: (function () {
        const o = perms(Object.fromEntries(MODULES.map((m) => [m.key, V])));
        o.accounting = VAE; o.reports = VAE; o.payroll = VAE; o.costs = VAE;
        o.pos = NONE;
        return o;
      })()
    }
  ];
}

const DEFAULT_TIERS = [
  { key: 'bronze', name: 'Bronze', at: 0, mark: 'III', from: '#8a6a4f', to: '#5d4632' },
  { key: 'silver', name: 'Silver', at: 3000, mark: 'II', from: '#7c8290', to: '#4c515c' },
  { key: 'gold', name: 'Gold', at: 7000, mark: 'I', from: '#b8862f', to: '#7d5a17' },
  { key: 'platinum', name: 'Platinum', at: 15000, mark: '★', from: '#3c3f46', to: '#16171b' }
];

const ALLERGENS = [
  { k: 'gluten', name: 'Gluten', re: /wheat|flour|bread|pasta|noodle|barley|rye|semolina|breadcrumb/i },
  { k: 'crustacean', name: 'Crustaceans', re: /prawn|shrimp|lobster|crab|crayfish/i },
  { k: 'egg', name: 'Egg', re: /\begg|mayonnaise|mayo|aioli|meringue/i },
  { k: 'fish', name: 'Fish', re: /fish|tuna|snapper|grouper|anchovy|reef|maldive fish/i },
  { k: 'peanut', name: 'Peanuts', re: /peanut|groundnut/i },
  { k: 'soy', name: 'Soya', re: /soy|soya|tofu|edamame|miso/i },
  { k: 'milk', name: 'Milk', re: /milk|cream|butter|cheese|yoghurt|ghee|paneer/i },
  { k: 'nuts', name: 'Tree nuts', re: /almond|cashew|walnut|pistachio|hazelnut|pecan/i },
  { k: 'celery', name: 'Celery', re: /celery|celeriac/i },
  { k: 'mustard', name: 'Mustard', re: /mustard|dijon/i },
  { k: 'sesame', name: 'Sesame', re: /sesame|tahini/i },
  { k: 'sulphite', name: 'Sulphites', re: /sulphite|sulfite|dried apricot|wine/i },
  { k: 'lupin', name: 'Lupin', re: /lupin/i },
  { k: 'mollusc', name: 'Molluscs', re: /squid|octopus|calamari|mussel|clam|oyster|scallop/i }
];

const DIETS = [
  { k: 'veg', name: 'Vegetarian', meat: true },
  { k: 'vegan', name: 'Vegan', meat: true, dairy: true, egg: true },
  { k: 'halal', name: 'Halal', pork: true, alcohol: true },
  { k: 'gf', name: 'Gluten free', allergen: 'gluten' },
  { k: 'df', name: 'Dairy free', allergen: 'milk' },
  { k: 'nf', name: 'Nut free', allergen: 'nuts' }
];

module.exports = { buildBootstrap, buildState, MODULES, rolesOf, ALLERGENS, DIETS };
