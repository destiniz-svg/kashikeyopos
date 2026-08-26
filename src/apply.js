'use strict';
/* ═══ REPLAY ════════════════════════════════════════════════════════════════
   One operation, one client-generated opId, applied exactly once.

   Every mutation in the terminal goes through `queue(op, label, entity)` — one
   seam, 115 kinds — and lands here. Two rules hold for all of them:

     · IDEMPOTENT. op_log's primary key is the client's own opId, generated
       before the network was touched. A reconnect that replays the outbox
       books nothing twice.
     · A CLOSED TICKET IS NEVER OVERWRITTEN. A late replay of an earlier edit
       finds the ticket closed and is recorded as superseded, not applied.

   A kind with no handler is still recorded, because the op log is the audit
   trail as well as the queue: an operation nobody modelled is a gap we want
   visible, not a write we silently dropped.
   ═══════════════════════════════════════════════════════════════════════ */

const RULES = require('../app/kashikeyo-rules.js');
const YIELD = require('../app/kashikeyo-yield.js');

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const r2 = (v) => Math.round(num(v) * 100) / 100;
const arr = (v) => (Array.isArray(v) ? v : []);

/* ── the sale: the one operation the whole product exists to get right ───── */
async function applySale(c, p, ctx) {
  // The receipt number is allocated HERE, on the server, under the series row
  // lock — never on the terminal, where two tills would mint the same one.
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['SALE']);

  // The books must square whatever the terminal computed. Recompute from the
  // components; if the terminal's own total disagrees, repair the row into a
  // consistent one and stamp the discrepancy — never reject, because a cashier
  // has already taken the money.
  const subtotal = r2(p.sub);
  const discount = r2(p.disc);
  const net = r2(subtotal - discount);
  const service = r2(p.svc);
  let tax = r2(p.tax);
  let rounding = r2(p.round);

  /* WHETHER THERE IS TAX AT ALL IS THE OUTLET'S FACT, NOT THE TILL'S.
     A terminal that has not caught up — deregistered this morning, bootstrapped
     last week — still sends a tax code and a rate. Believing it would record a
     GST liability for a business that holds no registration, which is a debt to
     MIRA that nobody owes and an amount collected under a registration that
     does not exist.

     So it is read from chain.outlet, and a sale that disagrees is REPAIRED, not
     rejected: a cashier has already taken the money. The over-collected amount
     does not vanish — it rides in `rounding`, which posts to 4900, the account
     that exists for differences somebody has to answer for. What the terminal
     claimed is stamped beside it. */
  const reg = await one(c, 'SELECT tax_code FROM chain.outlet WHERE id = $1',
    [ctx.outletId]);
  const outletCode = (reg && reg.tax_code) || 'NONE';
  const registered = outletCode !== 'NONE';
  const taxCode = registered ? (p.taxCode && p.taxCode !== 'NONE' ? p.taxCode : outletCode)
    : 'NONE';
  const taxRate = registered ? num(p.taxRate) : 0;

  let unregisteredAudit = null;
  if (!registered && tax !== 0) {
    unregisteredAudit = { charged: tax, code: p.taxCode || null,
      note: 'this outlet is not registered for GST; the terminal charged tax and'
        + ' it has been recorded as a difference, not as a liability' };
    rounding = r2(rounding + tax);
    tax = 0;
  }

  /* What the redemption covered. Parsed HERE, not in the loyalty block,
     because it changes what the guest was CHARGED — and the row, the receipt
     document and the tender leg all carry the charged figure. Leaving it out
     made the server's total disagree with the till's on every redemption, and
     postJournal's self-balancer then absorbed the difference as a fake "Cash
     rounding" debit — the redemption booked as a discount, invisibly, which is
     the precise misstatement the loyalty doctrine forbids. */
  const redeemed = r2(num(p.ptsValue));
  const total = r2(net + service + tax + rounding - redeemed);
  /* The tip rides OUTSIDE the bill's identity: sale.total is what the bill
     came to, the tip is what the guest added, and the payment rows carry the
     SUM — that is the note that physically entered the drawer, and the figure
     the drawer count reconciles against. So the till's claimed figure is
     total + tip, and the tie-check must say so: comparing it against the bare
     total stamped every tipped sale as "did not tie", and the journal's
     tender leg then overshot the credits by exactly the tip — which the old
     unlimited netting absorbed into 4900 as fake rounding. Tips were revenue
     nobody could pay out. */
  const tip = r2(p.tip);
  const claimed = r2(p.total);
  const tied = Math.abs(claimed - r2(total + tip)) > 0.005
    ? { claimed, computed: total, note: 'terminal total did not tie to its own components' }
    : null;
  /* THE OUTLET'S OWN RATE IS THE CHECK ON THE TILL'S TAX ARITHMETIC.
     The registration flag is already the outlet's fact, not the till's — but
     the RATE was taken on trust. A stale build carries yesterday's rate through
     a change, and a GST figure struck at the wrong rate ties its own total and
     hides — a mis-stated liability to MIRA. So when the till charged tax, the
     rate it implies is checked against the outlet's own effective-dated rate on
     the same base the till uses (net less any redemption, plus the service
     billed), and a WRONG rate is STAMPED — not rewritten, because a mid-day
     change is the till's to assert and an accountant's to reconcile.

     A sale that charged NO tax is left alone: a registered business has
     zero-rated and exempt supplies, and second-guessing every one would cry
     wolf until nobody reads the flag. What this catches is the rate applied
     WRONG, which has no honest explanation. */
  let taxAudit = null;
  if (registered && tax > 0.005) {
    const rateRow = await one(c,
      'SELECT rate FROM chain.tax_version WHERE outlet_id = $1 AND code = $2'
      + ' AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3)'
      + ' ORDER BY effective_from DESC LIMIT 1',
      [ctx.outletId, taxCode, p.bizDate || today(ctx)]);
    const rate = rateRow ? Number(rateRow.rate) : 0;
    if (rate > 0) {
      const denom = r2(Math.max(0, net - redeemed) + service);
      const expTax = r2(denom * rate / 100);
      // Tolerance scales with the bill: half a percent of the base absorbs the
      // laari-level rounding of a correct rate; a wrong rate is a whole
      // percentage point or more and clears it easily.
      const tol = Math.max(0.05, r2(denom * 0.005));
      if (denom > 0 && Math.abs(tax - expTax) > tol) {
        taxAudit = { charged: tax, expected: expTax, rate, code: taxCode,
          applied: r2(tax / denom * 100), base: denom,
          note: 'the terminal applied a tax rate that does not match this'
            + ' outlet’s own effective rate; the sale is recorded as charged'
            + ' and the difference is flagged for reconciliation' };
      }
    }
  }

  /* A credit tender draws down a house account that has a LIMIT, and the till's
     own pay screen blocks a charge past it. But an offline terminal charges
     against a stale balance — two of them can each believe there is headroom —
     so the outstanding balance is the SERVER's to keep, and an overrun is
     recorded rather than rejected: the sale already happened, and a sale is
     never thrown away. The member's balance moves here, under the same
     transaction as the sale, so it is right the moment the op applies. */
  let creditAudit = null;
  const creditCharged = r2(arr(p.payments)
    .filter((x) => (x.method || 'cash') === 'credit')
    .reduce((a, x) => a + num(x.amt), 0));
  if (p.member && creditCharged > 0) {
    const mrow = await one(c, 'SELECT credit_limit, credit_used FROM chain.member'
      + ' WHERE id = $1', [p.member]);
    const limit = r2((mrow && mrow.credit_limit) || 0);
    const wasUsed = r2((mrow && mrow.credit_used) || 0);
    const nowUsed = r2(wasUsed + creditCharged);
    await c.query('UPDATE chain.member SET credit_used = credit_used + $2'
      + ' WHERE id = $1', [p.member, creditCharged]);
    if (limit > 0 && nowUsed - limit > 0.005) {
      creditAudit = { limit, wasUsed, charged: creditCharged, nowUsed,
        over: r2(nowUsed - limit),
        note: 'this credit charge takes the customer past their limit; the sale'
          + ' is recorded and the overrun is flagged for a manager' };
      await log(c, 'credit_over_limit', 'member', p.member, null, creditAudit);
    }
  }

  // What the till claimed the sale cost. Kept so the flag below can name it;
  // it is no longer what anything is booked at.
  const cogsClaimed = r2(p.cogs);

  const sale = await one(c,
    'INSERT INTO sale (receipt_no, ticket_id, at, business_date, channel, covers,'
    + ' subtotal, discount, discount_code, discount_reason, discount_by, net,'
    + ' service, tax_code, tax_label, tax_rate, tax, rounding, total, pts,'
    + ' pts_value, tip, cogs,'
    + ' currency, fx_rate, fx_amount, member_id, customer_name, server_name,'
    + ' closed_by, device_id, client_total, server_audit)'
    + ' VALUES ($1,$2,coalesce($3, now()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'
    + ' $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)'
    + ' RETURNING id, receipt_no',
    [no.no, p.ticketId || null, p.at ? new Date(p.at) : null,
      p.bizDate || today(ctx), p.channel || 'dine_in', Math.max(1, num(p.covers) || 1),
      subtotal, discount, p.discCode || null, p.discReason || null,
      // An unregistered outlet must not have a tax LABEL invented for it: the
      // receipt would name a registration the business does not hold.
      p.discBy || null, net, service, taxCode,
      registered ? (p.taxLabel || 'GST') : '', taxRate, tax, rounding, total,
      Math.max(0, Math.trunc(num(p.pts))), redeemed, r2(p.tip),
      // Repaired below, once the stock has actually moved and the server knows
      // what it was worth. Inserting the till's claim here and correcting it
      // there means the row is never briefly wrong in a way a trigger could see.
      cogsClaimed, p.cur || 'MVR', num(p.rate) || 1, r2(p.fgn),
      p.member || null, p.customer || null, p.server || null,
      ctx.actor, ctx.deviceId, claimed, null]);

  for (const l of arr(p.sold)) {
    await c.query('INSERT INTO sale_line (sale_id, item_id, name, qty, unit_price,'
      + ' line_total, unit_cost, line_cost, addons, guest_ix)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [sale.id, l.id, l.name, num(l.qty), r2(l.price), r2(l.amount),
        num(l.unitCost), r2(l.cost), JSON.stringify(l.addons || []), num(l.guest)]);
  }

  for (const pay of arr(p.payments)) {
    await c.query('INSERT INTO payment (sale_id, method, amount, currency,'
      + ' fx_amount, fx_rate, tendered, change_given, tip, auth_ref, taken_by, device_id)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [sale.id, pay.method || 'cash', r2(pay.amt), pay.cur || 'MVR',
        pay.fgn ? r2(pay.fgn) : null, pay.rate ? num(pay.rate) : null,
        pay.tendered ? r2(pay.tendered) : null,
        pay.chg ? r2(pay.chg) : null, r2(pay.tip), pay.ref || null,
        ctx.actor, ctx.deviceId]);
  }

  /* Stock and COGS move at the moment of sale, not in a nightly batch — and
     what they cost is the SERVER's figure, at the weighted-average cost it
     maintains. That single change is what makes 1200 and the stock ledger the
     same number by construction: they are now fed by one figure instead of two
     client ones that nothing compared. */
  let stockValue = 0;
  const oversold = [];

  /* WHAT MOVED is the outlet's own recipe where the outlet can answer, and the
     till's expansion where it cannot. See deriveConsumption(): a partial
     answer never replaces a whole one, because under-deducting the shelf is
     worse than trusting the device. */
  const derived = await deriveConsumption(c, arr(p.sold));
  const supplied = arr(p.stockMoves);
  /* Where the outlet can answer, the outlet answers — including for a till
     that sent no moves at all, which is what an older build does: the recipe
     says stock left the shelf, so stock left the shelf. But a DIVERGENCE still
     needs two numbers, so nothing is flagged unless the till sent its own. */
  const useDerived = derived.complete && derived.moves.length > 0;
  const qtyOff = useDerived && supplied.length
    ? quantityGap(derived.moves, supplied) : [];

  // The till's own row for an ingredient, kept for the location it named —
  // which shelf a portion came off is a fact about the floor, not the recipe.
  const locOf = new Map();
  supplied.forEach((m) => { if (m.loc) locOf.set(String(m.ing), m.loc); });

  const moving = useDerived
    ? derived.moves.map((m) => ({ ing: m.ing, qty: m.qty, cost: 0, value: 0,
      loc: locOf.get(String(m.ing)) || null }))
    : supplied;

  for (const m of moving) {
    const mv = await moveStock(c, ctx, {
      ing: m.ing, qty: -Math.abs(num(m.qty)), cost: num(m.cost),
      value: r2(m.value), reason: 'sale', saleId: sale.id, loc: m.loc || null
    });
    if (!mv) continue;
    // Summing the ROUNDED move values, not rounding a sum: the journal has to
    // agree with the rows in stock_move to the laari, and those rows are what
    // they are. A tenth of a laari of drift per move, unchecked, is how a
    // valuation and a ledger part company over a year.
    stockValue = r2(stockValue + r2(mv.value));
    if (mv.short) oversold.push(mv.short);
  }

  /* A DIVERGENCE NEEDS TWO NUMBERS. An outlet with no recipes at all — a café
     that costs its menu at a flat percentage, which is a perfectly ordinary way
     to run one — sends a COGS estimate and NO stock moves, every sale, for
     ever. Comparing the two there flags every bill in the shop, and a flag that
     fires on every bill is one nobody reads by the second week. Same doctrine
     as the tax sweep: flag a wrong figure, never the absence of one.

     So the comparison only runs when the till actually moved stock. When it
     moved none there is nothing to reconcile — the GL and the stock ledger are
     both zero and agree — and the till's percentage estimate stays on the sale
     row as the margin figure it is, while the ledger books no cost of sales
     because no stock left the shelf. */
  const tracked = moving.length > 0;
  const cogsAudit = tracked && Math.abs(cogsClaimed - stockValue) > 0.05
    ? { cogs: cogsClaimed, stockValue,
      note: 'the till valued this sale differently from the stock it moved;'
        + ' the ledger is posted at the outlet\'s own weighted-average cost'
        + ' and the till\'s figure is kept here' }
    : null;
  const shortAudit = oversold.length
    ? { items: oversold,
      note: 'this sale took stock the books did not have — two terminals'
        + ' offline on the same portion, or a count that has not been done;'
        + ' the sale stands and the shortfall is named' }
    : null;

  /* Where stock IS tracked, what the sale cost is the value of what left the
     shelf, and the till's claim moves to server_audit to be answered for.
     Where it is not, the till's figure is the only costing the business has
     and overwriting it with zero would empty the food-cost card on every
     screen that reads it — a worse answer than the estimate. */
  if (tracked && Math.abs(cogsClaimed - stockValue) > 0.005) {
    await c.query('UPDATE sale SET cogs = $2 WHERE id = $1', [sale.id, stockValue]);
  }

  /* The till's expansion disagreed with the outlet's own recipe. The ledger
     is written from the recipe; what the device believed is kept here, by
     ingredient, so somebody can see WHICH one and by how much — a device
     carrying a stale menu names itself in the first bill it rings. */
  const qtyAudit = qtyOff.length
    ? { items: qtyOff,
      note: 'the till deducted different quantities from the recipe this'
        + ' outlet holds; the stock ledger is written from the recipe and the'
        + " till's figures are kept here — usually a device that has been"
        + ' offline across a recipe change' }
    : null;
  /* And the other direction: the server could not derive it at all. Not a
     divergence — there is nothing to diverge from — but it IS the reason the
     till's numbers were taken on trust, and that reason belongs on the row
     rather than nowhere. */
  const underived = supplied.length && !derived.complete && derived.reason
    ? { why: derived.reason, items: derived.unknown.length ? derived.unknown : undefined }
    : null;

  const audit = (tied || unregisteredAudit || creditAudit || taxAudit || cogsAudit
    || shortAudit || qtyAudit || underived)
    ? Object.assign({ at: new Date().toISOString() }, tied || {},
      unregisteredAudit ? { unregistered: unregisteredAudit } : {},
      taxAudit ? { tax_mismatch: taxAudit } : {},
      cogsAudit ? { cogs_mismatch: cogsAudit } : {},
      qtyAudit ? { qty_mismatch: qtyAudit } : {},
      underived ? { qty_underived: underived } : {},
      shortAudit ? { stock_short: shortAudit } : {},
      creditAudit ? { credit_over: creditAudit } : {})
    : null;
  if (audit) {
    await c.query('UPDATE sale SET server_audit = $2 WHERE id = $1',
      [sale.id, JSON.stringify(audit)]);
  }
  /* On the trail as well as on the row. A stale recipe on one device shows up
     as a stock discrepancy weeks later, on a count, with nothing to attribute
     it to; the trail is where somebody looks for "when did this start". */
  if (qtyAudit) {
    await log(c, 'recipe_drift', 'sale', sale.id, null,
      { receipt: sale.receipt_no, device: ctx.device || null, items: qtyOff });
  }

  /* The loyalty programme, read ONCE and before the journal is built,
     because two of its consequences are ledger lines: the release of what
     this redemption spends, and the accrual of what this visit earns. Earning
     stays on GOODS actually charged — net minus the redemption — never on
     tax, service, or the points just spent. */
  let earned = 0, earnedValue = 0;
  if (p.member) {
    const rate = await c.query("SELECT value FROM chain.setting WHERE key = 'loyalty'");
    const cfg = (rate.rows[0] || {}).value || {};
    const per = Number(cfg.pointsPer) || 10;
    const live = cfg.live !== false;
    const base = Math.max(0, r2(net - redeemed));
    earned = live ? Math.floor(base / per) : 0;
    /* What the granted points are WORTH, at the outlet's own published
       redemption rate — the figure the liability will one day be released at.
       A paused programme earns nothing and therefore accrues nothing. */
    earnedValue = earned > 0
      ? r2(earned / (Number(cfg.redeemPts) || 100) * (Number(cfg.redeemValue) || 25))
      : 0;
    await log(c, live ? 'points_earned' : 'points_paused', 'member', p.member, null,
      { sale: sale.receipt_no, net, redeemed, base, per, points: earned });
    if (earned > 0) {
      await c.query('UPDATE chain.member SET points = points + $2 WHERE id = $1',
        [p.member, earned]);
      // Recorded on the sale, so a void can give back exactly what was given
      // rather than recomputing against a rate that may have moved since.
      await c.query('UPDATE sale SET pts_earned = $2 WHERE id = $1', [sale.id, earned]);
    }
  }

  // The ledger legs. Derived from the sale that just happened, never keyed.
  await postJournal(c, ctx, saleJournal(p, {
    // The value of the stock that actually left the shelf, so 1200 and the
    // stock ledger cannot part company — not the till's claim, which is now
    // only evidence in server_audit.
    net, service, tax, rounding, total, tip, discount, cogs: stockValue,
    ptsValue: redeemed, earnedValue,
    payments: arr(p.payments), stock: arr(p.stockMoves), channel: p.channel
  }), 'sale', sale.id, p.bizDate || today(ctx), 'Sale ' + sale.receipt_no);

  // Close the bill this sale settled. A ticket opened offline reaches the
  // outlet as lines against a TABLE and has no server id on the device, so
  // resolve either way — otherwise the floor keeps showing an occupied table
  // whose money is already in the drawer.
  const closing = await ticketRef(c, p);
  if (closing) {
    await c.query("UPDATE ticket SET status = 'closed', closed_at = now(),"
      + " closed_by = $2 WHERE id = $1 AND status <> 'closed'", [closing, ctx.actor]);
    await c.query('UPDATE sale SET ticket_id = coalesce(ticket_id, $2) WHERE id = $1',
      [sale.id, closing]);
  }
  await c.query('INSERT INTO document (no, kind, business_date, amount, ref_id, by_staff)'
    + " VALUES ($1,'SALE',$2,$3,$4,$5) ON CONFLICT (no) DO NOTHING",
    [sale.receipt_no, p.bizDate || today(ctx), total, sale.id, ctx.actor]);

  await log(c, 'sale', 'sale', sale.id, null, { no: sale.receipt_no, total });
  return { saleId: sale.id, receiptNo: sale.receipt_no, total, repaired: !!audit };
}

/* The posting rules, in one place, so the trial balance is a consequence of
   the design rather than something anybody has to remember to keep true. */
function saleJournal(p, T) {
  const lines = [];
  const dr = (acct, amt, memo) => { if (r2(amt) > 0) lines.push({ acct, dr: r2(amt), memo }); };
  const cr = (acct, amt, memo) => { if (r2(amt) > 0) lines.push({ acct, cr: r2(amt), memo }); };

  // Tender. Each method lands on its own account, because "cash" and "card
  // money that arrives on Tuesday" are not the same asset.
  const byMethod = {};
  T.payments.forEach((x) => {
    const m = x.method || 'cash';
    byMethod[m] = r2((byMethod[m] || 0) + num(x.amt));
  });
  // The contract with the till: a payment's `amt` is what the guest handed
  // over for bill AND tip, excluding change — the figure the drawer holds.
  if (!T.payments.length) byMethod.cash = r2(T.total + T.tip);
  Object.keys(byMethod).forEach((m) => {
    dr(tenderAccount(m), byMethod[m], 'Tender · ' + m);
  });

  cr(T.channel === 'delivery' ? '4100' : '4000', T.net + T.discount, 'Revenue');
  dr('4200', T.discount, 'Discount given');
  cr('2300', T.service, 'Service charge payable');
  cr('2200', T.tax, 'Output tax');
  if (T.rounding > 0) cr('4900', T.rounding, 'Cash rounding');
  if (T.rounding < 0) dr('4900', -T.rounding, 'Cash rounding');
  /* POINTS ARE A LIABILITY, NOT A DISCOUNT. Redeeming releases 2350 — money
     the business already owed the guest — while revenue stays the full goods
     figure. And what this visit EARNS is accrued the moment it is granted:
     the expense belongs to tonight's sale, not to the future visit that
     spends it. Both accounts are till-owned; only this function writes them,
     which is what lets the liability tie to the member balances at all. */
  dr('2350', T.ptsValue, 'Loyalty points redeemed');
  /* The tip was never the restaurant's money. It is held for the team — a
     liability from the moment it lands — and paying it out is a manual
     journal against 2450, which is why 2450 is NOT till-owned. Without this
     leg, card tips made every settlement advice exceed the receivable by the
     day's tips, and cash tips made every drawer count read over. */
  cr('2450', T.tip, 'Tips held for staff');
  if (T.earnedValue > 0) {
    dr('6550', T.earnedValue, 'Loyalty points earned');
    cr('2350', T.earnedValue, 'Loyalty points earned');
  }
  if (T.cogs > 0) { dr('5000', T.cogs, 'Cost of sales'); cr('1200', T.cogs, 'Stock consumed'); }
  return lines;
}

/* ── the ledger ─────────────────────────────────────────────────────────── */
async function postJournal(c, ctx, lines, source, sourceId, date, memo) {
  const clean = arr(lines).filter((l) => r2(l.dr) > 0 || r2(l.cr) > 0);
  if (!clean.length) return null;
  const drs = clean.reduce((a, l) => a + r2(l.dr), 0);
  const crs = clean.reduce((a, l) => a + r2(l.cr), 0);
  if (Math.abs(drs - crs) > 0.005) {
    const d = r2(crs - drs);
    /* A few laari of float dust is what this netting exists for. A LARGER gap
       is a component bug, and absorbing one silently is how a whole feature's
       money hid inside "Cash rounding" for months — every points redemption
       landed here, labelled Rounding, on card sales that round to nothing.

       So the gap is capped. A non-sale journal that misses by more than five
       laari REFUSES — under the sync handler that is one op failing on its
       own, not a batch. A SALE still posts whatever happens, because the
       cashier has already taken the money — but the absorption is stamped in
       the audit trail with the gap it swallowed, so it is a finding, not a
       hiding place. */
    if (Math.abs(d) > 0.05 && source !== 'sale') {
      throw Object.assign(new Error('journal out of balance by ' + d
        + ' — refusing rather than absorbing a component bug into Rounding'),
      { status: 422 });
    }
    if (Math.abs(d) > 0.05) {
      await log(c, 'journal_imbalance', source, sourceId ? String(sourceId) : null,
        null, { gap: d, memo: memo || source });
    }
    clean.push(d > 0
      ? { acct: '4900', dr: d, memo: Math.abs(d) > 0.05 ? 'IMBALANCE absorbed — investigate' : 'Rounding' }
      : { acct: '4900', cr: -d, memo: Math.abs(d) > 0.05 ? 'IMBALANCE absorbed — investigate' : 'Rounding' });
  }
  // Resolve the entry date ONCE, on the outlet's clock, so the period this
  // opens and the period the row lands in can never be different months.
  const entryDate = date || today(ctx);
  await ensurePeriodOpen(c, entryDate);
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['JV']);
  const j = await one(c, 'INSERT INTO journal (jv_no, entry_date, memo, source,'
    + ' source_id, posted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [no.no, entryDate, memo || source, source, sourceId ? String(sourceId) : null, ctx.actor]);
  for (const l of clean) {
    await c.query('INSERT INTO journal_line (journal_id, account_code, dr, cr, memo)'
      + ' VALUES ($1,$2,$3,$4,$5)', [j.id, l.acct, r2(l.dr), r2(l.cr), l.memo || null]);
  }
  return j.id;   // the deferred trigger refuses an unbalanced entry at COMMIT
}

async function ensurePeriodOpen(c, date) {
  // No date given means "now" — and now is the OUTLET's now, because the
  // transaction's timezone was set to its own. Asking the database is the one
  // clock that cannot disagree with the row about to be written.
  const d = date || (await one(c, 'SELECT current_date::text AS d')).d;
  const id = String(d).slice(0, 7);
  const q = await c.query('SELECT state FROM period WHERE id = $1', [id]);
  if (!q.rows.length) {
    await c.query("INSERT INTO period (id, starts_on, ends_on) VALUES ($1,"
      + " ($1 || '-01')::date, (date_trunc('month',($1 || '-01')::date)"
      + " + interval '1 month - 1 day')::date) ON CONFLICT DO NOTHING", [id]);
    return;
  }
  if (q.rows[0].state === 'closed') {
    throw Object.assign(new Error('Period ' + id + ' is closed — reopen it to post into it'),
      { status: 409 });
  }
}

/* ── stock: the immutable signed ledger, plus its cached balance ───────────
   Returns what the move actually cost and where it left the shelf, because
   two things upstream need those and used to guess at them: the journal, which
   must credit 1200 with the value the stock ledger really carries, and the
   sale, which has to say out loud when it sold something that was not there. */
/* ═══ WHAT THE RECIPE SAYS LEFT THE SHELF ══════════════════════════════════
   The server already decides what a consumed portion is WORTH — `moveStock()`
   re-values a sale move at the outlet's own weighted-average cost. What it
   still took on trust was HOW MUCH: the quantities came from the till's own
   recipe expansion, computed against whatever menu that browser was holding.

   A device that has been offline across a recipe change deducts yesterday's
   recipe for ever, silently, and the only symptom is a stock ledger that
   drifts a little every service. Nothing on any screen compares the two,
   because until now there was only one of them.

   So the expansion is re-derived here, from the outlet's own `recipe_line`,
   its own batches and its own measured yields — and it is derived by exactly
   the rule the till uses, out of exactly the same shipped table
   (app/kashikeyo-yield.js), because a check computed from a different table is
   a second opinion rather than a check.

   Three things this deliberately does NOT do:

     · it does not reject. The money is taken and the food is gone; the same
       repair-and-flag doctrine as tax and COGS applies;
     · it does not fire where there is nothing to compare. A dish the outlet
       has no recipe for moves no stock on either side — the till costs it at
       a flat percentage and deducts nothing — so the two agree at zero and
       there is no divergence to report. Flag a wrong figure, never the
       absence of one;
     · it does not replace an INCOMPLETE derivation. If any sold item is one
       this outlet has never heard of, the server cannot know what it
       consumed, and overwriting the till's answer with a partial one would
       under-deduct the shelf. The till's figures stand and the gap is named.

   The recursion is bounded at twelve levels, like the declaration walk. A
   recipe cycle — a sauce whose batch draws on itself — is a data error
   somebody made, and an unbounded `UNION ALL` on it does not error, it hangs. */
const DERIVE_DEPTH = 12;

async function deriveConsumption(c, sold) {
  const lines = arr(sold).filter((s) => s && s.id != null && num(s.qty) > 0);
  if (!lines.length) return { complete: false, moves: [], unknown: [], reason: 'nothing sold' };

  const ids = lines.map((s) => String(s.id));
  const qtys = lines.map((s) => num(s.qty));

  /* An id the outlet's own catalogue does not carry. Not necessarily a fault —
     a till that created a dish offline has not pushed it yet — but it makes
     the derivation partial, and a partial derivation must not be believed. */
  const known = await c.query('SELECT id FROM item WHERE id = ANY($1)', [ids]);
  const have = new Set(known.rows.map((r) => String(r.id)));
  const unknown = [...new Set(ids.filter((i) => !have.has(i)))];
  if (unknown.length) {
    return { complete: false, moves: [], unknown,
      reason: 'sold an item this outlet does not carry' };
  }

  /* The walk, in the database, because a batch drawing on a batch is a join
     and not a round trip. `mult` is how many of the component's own units one
     unit of the thing being sold needs; a batch divides by what it actually
     YIELDS (its output net of reduction loss), which is why 4 litres of stock
     that boils down to 3.28 makes a millilitre cost more than the inputs over
     four. */
  const walk = await c.query(
    'WITH RECURSIVE want(item_id, mult, depth) AS ('
    + '  SELECT s.id, s.q, 0'
    + '    FROM unnest($1::text[], $2::numeric[]) AS s(id, q)'
    + '  UNION ALL'
    + '  SELECT rl.sub_item_id,'
    + '         w.mult * (rl.qty / (b.yield_qty * (1 - b.loss_pct))),'
    + '         w.depth + 1'
    + '    FROM want w'
    + '    JOIN recipe_line rl ON rl.item_id = w.item_id'
    + '     AND rl.sub_item_id IS NOT NULL'
    + '    JOIN item b ON b.id = rl.sub_item_id'
    + '   WHERE w.depth < $3'
    + '     AND b.yield_qty IS NOT NULL AND b.yield_qty > 0'
    + '     AND b.loss_pct < 1'
    + ') SELECT rl.ingredient_id AS ing, ing.name AS name,'
    + '         ing.yield_pct AS y, ing.waste_pct AS w,'
    + '         sum(w2.mult * rl.qty) AS net,'
    + '         max(w2.depth) AS deepest'
    + '    FROM want w2'
    + '    JOIN recipe_line rl ON rl.item_id = w2.item_id'
    + '     AND rl.ingredient_id IS NOT NULL'
    + '    JOIN ingredient ing ON ing.id = rl.ingredient_id'
    + '   GROUP BY 1, 2, 3, 4',
    [ids, qtys, DERIVE_DEPTH]);

  /* NET is what reaches the plate; GROSS is what leaves the shelf to get it
     there. Deducting net would leave the trimmings on the books for ever. */
  const moves = walk.rows.map((r) => {
    const a = YIELD.assess(r.name, { y: r.y, w: r.w });
    return { ing: String(r.ing), name: r.name,
      net: Number(r.net), qty: YIELD.grossQty(a, Number(r.net)) };
  }).filter((m) => m.qty > 0);

  const deepest = walk.rows.reduce((a, r) => Math.max(a, Number(r.deepest || 0)), 0);
  if (deepest >= DERIVE_DEPTH) {
    // The frontier was still moving when the cap stopped it, so what came back
    // is a floor rather than the answer — and a floor must not overwrite the
    // till's figure. Same rule as a truncated declaration.
    return { complete: false, moves, unknown: [],
      reason: 'the recipe nests deeper than ' + DERIVE_DEPTH + ' levels' };
  }
  return { complete: true, moves, unknown: [], reason: null };
}

/* Two expansions compared as quantities rather than as lists: an ingredient in
   one and not the other is a difference of its whole quantity. The tolerance
   is relative, because a recipe measured in grams and one measured in litres
   cannot share an absolute one, with an absolute floor so a rounding tail on a
   pinch of saffron does not read as a divergence. */
function quantityGap(derived, supplied) {
  const bag = new Map();
  derived.forEach((m) => bag.set(String(m.ing),
    { ing: String(m.ing), name: m.name, want: m.qty, sent: 0 }));
  supplied.forEach((m) => {
    const k = String(m.ing);
    if (!bag.has(k)) bag.set(k, { ing: k, name: null, want: 0, sent: 0 });
    bag.get(k).sent += Math.abs(num(m.qty));
  });
  const off = [];
  bag.forEach((v) => {
    const scale = Math.max(v.want, v.sent);
    const gap = Math.abs(v.want - v.sent);
    if (gap > 0.0005 && gap > scale * 0.005) {
      off.push({ ing: v.ing, name: v.name,
        recipe: Math.round(v.want * 1e4) / 1e4,
        till: Math.round(v.sent * 1e4) / 1e4 });
    }
  });
  return off;
}

async function moveStock(c, ctx, m) {
  if (!m.ing) return null;
  const qty = num(m.qty);
  if (!qty && m.reason !== 'audit') return null;

  /* WHAT A CONSUMED PORTION IS WORTH IS THE SERVER'S ANSWER, NOT THE TILL'S.
     Stock leaving on a sale is valued at the weighted-average cost this server
     maintains — the same figure `avg_cost` is re-averaged to on every delivery.
     The till sent its own `value`, computed against whatever costs its last
     bootstrap happened to carry, and the ledger booked the till's number while
     the stock ledger carried it too: two client figures with nothing checking
     either. A till that has been offline across a price rise valued the whole
     evening at last week's cost.

     Only a SALE is re-valued. A delivery's value is what the invoice says, a
     write-off's is what somebody decided to write off, and a count variance is
     valued by the count — those are facts the till was told, not estimates it
     made. A sale's is the only one nobody was ever told. */
  let value = r2(m.value);
  if (qty < 0 && m.reason === 'sale') {
    const cost = await one(c, 'SELECT avg_cost, name FROM ingredient WHERE id = $1', [m.ing]);
    if (cost) value = r2(Math.abs(qty) * num(cost.avg_cost));
  }

  const row = await one(c,
    'INSERT INTO stock_move (ingredient_id, qty, unit_cost, value, reason,'
    + ' location_id, sale_id, batch_id, note, business_date, by_staff, device_id)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10, current_date),$11,$12)'
    + ' RETURNING id',
    [m.ing, qty, num(m.cost), value, m.reason, m.loc || null,
      m.saleId || null, m.batchId || null, m.note || null, m.date || null,
      ctx.actor, ctx.deviceId]);
  // The cache follows the ledger, never the other way round.
  const after = await one(c, 'UPDATE ingredient SET on_hand = on_hand + $2'
    + ' WHERE id = $1 RETURNING on_hand, name', [m.ing, qty]);
  // Receiving re-averages the cost. Weighted, so a big cheap delivery moves it
  // more than a small expensive one — which is what a plate actually costs.
  if (qty > 0 && num(m.cost) > 0 && (m.reason === 'purchase' || m.reason === 'produce')) {
    await c.query(
      'UPDATE ingredient SET avg_cost = CASE WHEN on_hand <= 0 THEN $2 ELSE'
      + ' ((greatest(on_hand - $3, 0) * avg_cost) + ($3 * $2))'
      + ' / nullif(greatest(on_hand - $3, 0) + $3, 0) END WHERE id = $1',
      [m.ing, num(m.cost), qty]);
  }
  /* SELLING WHAT IS NOT THERE. Two tills offline at the same counter can each
     sell the last portion, and on replay the second one drove `on_hand`
     negative with nothing said: no block, no warning, no trail. Blocking is
     the wrong answer — the food left the kitchen and the money is in the
     drawer — so the move is recorded and the SHORTFALL is named, here, where
     every path through stock passes. What a manager needs is not a refusal
     three hours later; it is to be told which ingredient the books now believe
     they have less than none of. */
  const left = after ? num(after.on_hand) : 0;
  const short = left < -0.0001
    ? { ing: m.ing, name: (after && after.name) || '', onHand: r2(left), took: r2(qty) }
    : null;
  if (short) {
    await log(c, 'stock_negative', 'ingredient', m.ing, null,
      Object.assign({ reason: m.reason }, short));
  }
  return { id: row.id, value: value, short: short };
}

/* ── the handler table ──────────────────────────────────────────────────── */
const H = {};

// ═══ SERVICE ═══════════════════════════════════════════════════════════════
H.open_register = async (c, p, ctx) => {
  const q = await c.query('SELECT id FROM drawer_session WHERE closed_at IS NULL');
  if (q.rows.length) return { id: q.rows[0].id, already: true };
  const d = await one(c, 'INSERT INTO drawer_session (opened_by, float_amount, device_id)'
    + ' VALUES ($1,$2,$3) RETURNING id', [ctx.actor, r2(p.float), ctx.deviceId]);
  await log(c, 'open_register', 'drawer', d.id, null, { float: r2(p.float) });
  return { id: d.id };
};

H.close_register = async (c, p, ctx) => {
  const open = await c.query('SELECT id, float_amount, opened_at FROM drawer_session'
    + ' WHERE closed_at IS NULL LIMIT 1');
  if (!open.rows.length) return { closed: false, why: 'no open register' };
  const d = open.rows[0];
  const takings = await one(c,
    "SELECT coalesce(sum(p.amount),0) AS cash FROM payment p JOIN sale s ON s.id = p.sale_id"
    + " WHERE p.method = 'cash' AND p.at >= $1", [d.opened_at]);
  const expected = r2(num(d.float_amount) + num(takings.cash));
  const counted = r2(p.counted);
  const variance = r2(counted - expected);
  await c.query('UPDATE drawer_session SET closed_at = now(), closed_by = $2,'
    + ' counted = $3, expected = $4, variance = $5, note = $6 WHERE id = $1',
    [d.id, ctx.actor, counted, expected, variance, p.note || null]);
  // A drawer that is short is a real cost, and it belongs in the books the day
  // it happened — not in a note nobody reads.
  if (Math.abs(variance) >= 0.01) {
    await postJournal(c, ctx, variance < 0
      ? [{ acct: '6300', dr: -variance, memo: 'Cash short' }, { acct: '1010', cr: -variance }]
      : [{ acct: '1010', dr: variance }, { acct: '4900', cr: variance, memo: 'Cash over' }],
    'drawer', d.id, today(ctx), 'Drawer variance');
  }
  await log(c, 'close_register', 'drawer', d.id, null, { expected, counted, variance });
  return { id: d.id, expected, counted, variance };
};

H.sale = applySale;
H.split_payment = applySale;

/* A line on an open ticket. `lid` is the id the TILL gave it, which is what
   makes this idempotent: the same line arriving twice — a retry, a replay from
   an outbox that came back after an outage — updates the quantity rather than
   ordering the dish again. A line with no client id is still accepted, because
   an older terminal must not be refused mid-service. */
H.add_line = async (c, p, ctx) => {
  if (!p.item) return { skipped: 'no item' };
  const t = await ticketFor(c, ctx, p);
  if (!t) return { skipped: 'ticket closed' };
  const cols = [t.id, p.item, p.name || p.item, num(p.qty) || 1, r2(p.price),
    JSON.stringify(p.addons || []), num(p.guest), p.note || null,
    p.course || null, p.station || null, ctx.actor, ctx.deviceId, p.lid || null];
  const l = await one(c, 'INSERT INTO ticket_line (ticket_id, item_id, name, qty,'
    + ' unit_price, addons, guest_ix, note, course, station, by_staff, device_id,'
    + ' client_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)'
    + ' ON CONFLICT (ticket_id, client_id) WHERE client_id IS NOT NULL'
    + ' DO UPDATE SET qty = excluded.qty, note = excluded.note,'
    + ' guest_ix = excluded.guest_ix, course = excluded.course'
    + ' RETURNING id', cols);
  return { ticketId: t.id, lineId: l.id };
};

// Resolve a line the till named, either by server id or by the id it gave.
async function lineOf(c, p) {
  if (p.lineId) return p.lineId;
  if (!p.lid) return null;
  const q = await one(c, 'SELECT l.id FROM ticket_line l JOIN ticket t ON t.id = l.ticket_id'
    + " WHERE l.client_id = $1 AND t.status <> 'closed'"
    + ' ORDER BY l.at DESC LIMIT 1', [p.lid]);
  return q ? q.id : null;
};

H.void_line = async (c, p, ctx) => {
  const id = await lineOf(c, p);
  if (!id) return { skipped: 'no such line' };
  await c.query('UPDATE ticket_line SET void_at = now(), void_by = $2, void_reason = $3'
    + ' WHERE id = $1 AND void_at IS NULL', [id, ctx.actor, p.reason || 'Voided']);
  await log(c, 'void_line', 'ticket_line', id, null, { reason: p.reason });
  return { ok: true };
};

H.line_note = async (c, p) => {
  const id = await lineOf(c, p);
  if (!id) return { skipped: 'no such line' };
  await c.query('UPDATE ticket_line SET note = $2 WHERE id = $1', [id, p.note || null]);
  return { ok: true };
};

/* An open ticket, named the way the terminal can name it. A till holds a
   TABLE, not a server id: the ticket was opened offline, or on the tablet in
   somebody else's hand. Every ticket operation therefore resolves by id when
   there is one and by table otherwise, so an outlet's open bills are the
   outlet's — visible at the counter, on the tablet and on the pass alike. */
async function ticketRef(c, p) {
  if (p.ticketId) return p.ticketId;
  if (p.table == null) return null;
  const t = await one(c, "SELECT id FROM ticket WHERE table_no = $1 AND split = $2"
    + " AND status <> 'closed' ORDER BY opened_at DESC LIMIT 1",
  [String(p.table), num(p.split)]);
  return t ? t.id : null;
}

H.move_table = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  const q = await c.query("UPDATE ticket SET table_no = $2 WHERE id = $1"
    + " AND status = 'open' RETURNING id", [id, String(p.to)]);
  if (!q.rows.length) return { skipped: 'ticket closed' };
  await log(c, 'move_table', 'ticket', id, { table: p.from }, { table: p.to });
  return { ok: true };
};

H.park_bill = async (c, p, ctx) => {
  const t = await ticketFor(c, ctx, p);
  if (!t) return { skipped: 'ticket closed' };
  await c.query("UPDATE ticket SET status = 'held' WHERE id = $1", [t.id]);
  return { ticketId: t.id };
};

H.resume_bill = async (c, p) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no held ticket' };
  await c.query("UPDATE ticket SET status = 'open' WHERE id = $1 AND status = 'held'", [id]);
  return { ok: true };
};

H.close_ticket = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  await c.query("UPDATE ticket SET status = 'closed', closed_at = now(), closed_by = $2"
    + " WHERE id = $1 AND status <> 'closed'", [id, ctx.actor]);
  return { ok: true };
};

H.ticket_status = async (c, p) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  await c.query('UPDATE ticket SET note = coalesce($2, note) WHERE id = $1',
    [id, p.note || null]);
  return { ok: true };
};

H.table_status = async (c, p) => {
  await c.query('UPDATE table_def SET status = $2 WHERE id = $1',
    [String(p.table), p.status || 'free']);
  return { ok: true };
};

H.table_update = async (c, p) => {
  await c.query('INSERT INTO table_def (id, label, zone_id, seats, pos, shape, active)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,coalesce($7,true))'
    + ' ON CONFLICT (id) DO UPDATE SET label = excluded.label,'
    + ' zone_id = excluded.zone_id, seats = excluded.seats, pos = excluded.pos,'
    + ' shape = excluded.shape, active = excluded.active',
    [String(p.id), p.label || String(p.id), p.zone || null, num(p.seats) || 4,
      num(p.pos), p.shape || 'square', p.active]);
  return { ok: true };
};

H.zones_update = async (c, p) => {
  for (const z of arr(p.zones)) {
    await c.query('INSERT INTO zone (id, name, pos, active) VALUES ($1,$2,$3,true)'
      + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, pos = excluded.pos',
      [String(z.id), z.name, num(z.pos)]);
  }
  return { zones: arr(p.zones).length };
};

H.covers_update = async (c, p) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  await c.query('UPDATE ticket SET party = $2, covers = greatest($2, covers)'
    + ' WHERE id = $1', [id, Math.max(1, num(p.party) || 1)]);
  return { ok: true };
};

H.guest_add = async (c, p) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  await c.query("UPDATE ticket SET guests = coalesce(guests,'[]'::jsonb) || $2::jsonb"
    + ' WHERE id = $1', [id, JSON.stringify([p.guest || {}])]);
  return { ok: true };
};

H.price_override = async (c, p, ctx) => {
  await c.query('INSERT INTO price_override (item_id, price, reason, by_staff, until)'
    + ' VALUES ($1,$2,$3,$4,$5)',
    [p.item, r2(p.price), p.reason || 'Override', ctx.actor, p.until || null]);
  await log(c, 'price_override', 'item', p.item, { price: p.from }, { price: r2(p.price) });
  return { ok: true };
};

// ═══ REFUNDS ═══════════════════════════════════════════════════════════════
// A refund is a REVERSING DOCUMENT with its own series, never an edit.
H.refund = async (c, p, ctx) => {
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['CN']);
  const net = r2(p.net), tax = r2(p.tax), svc = r2(p.svc);
  const amount = r2(p.amt != null ? p.amt : net + tax + svc);
  const cn = await one(c, 'INSERT INTO credit_note (cn_no, sale_id, business_date,'
    + ' lines, net, tax, service, amount, method, reason, raised_by, approved_by)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
    [no.no, p.saleId || null, p.bizDate || today(ctx), JSON.stringify(p.lines || []),
      net, tax, svc, amount, p.method || 'cash', p.reason || 'Refund',
      ctx.actor, p.approvedBy || ctx.actor]);

  const tenderAcct = tenderAccount(p.method);
  await postJournal(c, ctx, [
    { acct: '4000', dr: net, memo: 'Revenue reversed' },
    { acct: '2200', dr: tax, memo: 'Output tax reversed' },
    { acct: '2300', dr: svc, memo: 'Service charge reversed' },
    { acct: tenderAcct, cr: amount, memo: 'Refund paid' }
  ], 'refund', cn.id, p.bizDate || today(ctx), 'Credit note ' + no.no);

  /* Stock only comes back if it was actually returned to the kitchen — that is
     the operator's call, and the refund form asks it plainly ("Untouched —
     return to stock" against "Consumed or discarded"). What was missing was
     the consequence: answering "untouched" queued a stock_return op carrying NO
     payload, which resolved to a stock adjustment of nothing. The operator said
     the food came back, the screen agreed, and the shelf count never moved.

     So the return is derived HERE, from the sale's own stock_move rows — what
     actually left the shelf, at the cost it left at — rather than from a list
     the till would have to compose correctly. An explicit list still wins if a
     caller sends one: a partial refund knows better than the whole sale does. */
  const supplied = arr(p.stockMoves);
  if (supplied.length) {
    for (const m of supplied) {
      await moveStock(c, ctx, { ing: m.ing, qty: Math.abs(num(m.qty)), cost: num(m.cost),
        value: r2(m.value), reason: 'refund' });
    }
  } else if (p.restock && p.saleId) {
    const moves = await c.query('SELECT ingredient_id, qty, unit_cost, value,'
      + ' location_id FROM stock_move WHERE sale_id = $1 AND reason = $2',
    [p.saleId, 'sale']);
    for (const m of moves.rows) {
      await moveStock(c, ctx, { ing: m.ingredient_id, qty: Math.abs(num(m.qty)),
        cost: num(m.unit_cost), value: r2(Math.abs(num(m.value))), reason: 'refund',
        saleId: p.saleId, loc: m.location_id });
    }
  }
  await c.query('INSERT INTO document (no, kind, business_date, amount, ref_id, by_staff)'
    + " VALUES ($1,'CN',$2,$3,$4,$5) ON CONFLICT (no) DO NOTHING",
    [no.no, p.bizDate || today(ctx), amount, cn.id, ctx.actor]);
  await log(c, 'refund', 'credit_note', cn.id, null, { no: no.no, amount });
  return { creditNoteId: cn.id, no: no.no, amount };
};
H.credit_note = H.refund;

/* ═══ VOIDING A SETTLED SALE ══════════════════════════════════════════════════
   The columns were there from the first migration and five readers trusted
   them; nothing ever wrote them, so "void" on a paid sale was a line in the
   audit trail and nothing else — the revenue stayed recognised, the stock
   stayed consumed, the points stayed granted.

   What makes this reversal trustworthy is that NONE of it is taken from the
   till. The journal is the sale's own legs with debit and credit swapped, so
   it balances by construction and cannot invent a figure. The stock is the
   sale's own `stock_move` rows negated, so exactly what left the shelf comes
   back — the client-trust gap that the refund path still carries. The loyalty
   is what the sale recorded it spent and granted.

   A void is not an edit: the sale row stays, marked, and the reversal is its
   own journal. Replaying it is a no-op (the second pass finds it already
   void), which matters because this arrives through the same outbox as
   everything else. */
H.void_sale = async (c, p, ctx) => {
  const sale = await one(c,
    'SELECT id, receipt_no, business_date, member_id, pts, pts_value, pts_earned,'
    + ' total, voided_at FROM sale WHERE id = $1::uuid OR receipt_no = $2 LIMIT 1',
    [/^[0-9a-f-]{36}$/i.test(String(p.saleId || '')) ? p.saleId : null,
      String(p.no || p.receiptNo || '')]);
  if (!sale) return { skipped: 'no such sale' };
  if (sale.voided_at) return { skipped: 'already void', saleId: sale.id };
  if (!p.reason || !String(p.reason).trim()) {
    throw Object.assign(new Error('A void needs a written reason'), { status: 400 });
  }

  await c.query('UPDATE sale SET voided_at = now(), voided_by = $2 WHERE id = $1',
    [sale.id, ctx.actor]);

  /* The ledger, reversed from itself. Every leg of the sale's own entry with
     the sides swapped — including the rounding and the loyalty legs — so the
     reversal is exact and balanced without anything being recomputed. */
  const legs = await c.query('SELECT l.account_code, l.dr, l.cr FROM journal j'
    + ' JOIN journal_line l ON l.journal_id = j.id'
    + " WHERE j.source = 'sale' AND j.source_id = $1", [String(sale.id)]);
  const reversal = legs.rows.map((l) => ({
    acct: l.account_code, dr: r2(l.cr), cr: r2(l.dr),
    memo: 'Void of ' + sale.receipt_no
  }));
  const journalId = reversal.length
    ? await postJournal(c, ctx, reversal, 'void', sale.id,
      p.bizDate || today(ctx), 'Void of sale ' + sale.receipt_no + ' · ' + p.reason)
    : null;

  /* The stock, returned from the ledger's own rows rather than from a list the
     till composed. Whatever the sale consumed comes back, at the cost it left
     at, against the same location. */
  const moves = await c.query('SELECT ingredient_id, qty, unit_cost, value,'
    + ' location_id FROM stock_move WHERE sale_id = $1 AND reason = $2',
  [sale.id, 'sale']);
  for (const m of moves.rows) {
    await moveStock(c, ctx, { ing: m.ingredient_id, qty: -num(m.qty),
      cost: num(m.unit_cost), value: r2(-num(m.value)), reason: 'void',
      saleId: sale.id, loc: m.location_id, date: p.bizDate || null });
  }

  /* Loyalty, both directions: the points the visit granted are taken back and
     the points it spent are handed back. A sale written before the outlet
     recorded what it granted carries 0 earned, and the stamp says so rather
     than guessing at a rate. */
  let loyalty = null;
  if (sale.member_id) {
    const earned = Math.max(0, Math.trunc(num(sale.pts_earned)));
    const spent = Math.max(0, Math.trunc(num(sale.pts)));
    if (earned || spent) {
      await c.query('UPDATE chain.member SET points = greatest(0, points - $2 + $3)'
        + ' WHERE id = $1', [sale.member_id, earned, spent]);
    }
    loyalty = { earnedTakenBack: earned, spentGivenBack: spent };
  }

  /* Customer credit: a voided credit sale is no longer owed. */
  let credit = null;
  if (sale.member_id) {
    const onAccount = await one(c, "SELECT coalesce(sum(amount), 0)::numeric AS amt"
      + " FROM payment WHERE sale_id = $1 AND method = 'credit'", [sale.id]);
    const owed = r2(num(onAccount && onAccount.amt));
    if (owed > 0) {
      await c.query('UPDATE chain.member SET credit_used ='
        + ' greatest(0, credit_used - $2) WHERE id = $1', [sale.member_id, owed]);
      credit = { released: owed };
    }
  }

  await log(c, 'void_sale', 'sale', sale.id, { total: sale.total },
    { no: sale.receipt_no, reason: p.reason, journalId,
      stockReturned: moves.rows.length, loyalty, credit,
      earnUnknown: sale.member_id && !num(sale.pts_earned) ? true : undefined });
  return { saleId: sale.id, no: sale.receipt_no, journalId,
    stockReturned: moves.rows.length };
};


H.credit_reverse = async (c, p, ctx) => {
  await log(c, 'credit_reverse', 'credit_note', p.id, null, { reason: p.reason });
  return { ok: true };
};

// ═══ STOCK ═════════════════════════════════════════════════════════════════
H.stock_adjust = async (c, p, ctx) => {
  // An equipment failure writes off VALUE with no single item to move — the
  // journal legs are the truth there, and forcing an item row would invent
  // one. With an item, the movement and the money travel together as ever.
  const mv = p.ing ? await moveStock(c, ctx, {
    ing: p.ing, qty: num(p.qty), cost: num(p.cost), value: r2(p.value),
    reason: p.reason === 'waste' ? 'waste' : 'manual', note: p.note, loc: p.loc
  }) : null;
  const id = mv && mv.id;
  if (r2(p.value)) {
    await postJournal(c, ctx, [
      { acct: '5100', dr: Math.abs(r2(p.value)), memo: p.note || 'Stock adjustment' },
      { acct: '1200', cr: Math.abs(r2(p.value)) }
    ], 'stock', id, today(ctx), 'Stock adjustment');
  }
  return { moveId: id };
};
H.stock_writeoff = H.stock_adjust;
H.stock_return = H.stock_adjust;

H.transfer = async (c, p, ctx) => {
  await moveStock(c, ctx, { ing: p.ing, qty: -Math.abs(num(p.qty)), cost: num(p.cost),
    value: r2(p.value), reason: 'transfer', loc: p.from, note: 'to ' + (p.to || '') });
  await moveStock(c, ctx, { ing: p.ing, qty: Math.abs(num(p.qty)), cost: num(p.cost),
    value: r2(p.value), reason: 'transfer', loc: p.to, note: 'from ' + (p.from || '') });
  return { ok: true };
};

H.count_open = async (c, p, ctx) => {
  const q = await one(c, 'INSERT INTO stock_count (by_staff, scope, categories,'
    + ' location_id) VALUES ($1,$2,$3,$4) RETURNING id',
    [ctx.actor, p.scope || 'all', arr(p.cats), p.loc || null]);
  return { countId: q.id };
};

H.count_post = async (c, p, ctx) => {
  const id = p.countId || (await one(c, 'INSERT INTO stock_count (by_staff, scope)'
    + ' VALUES ($1,$2) RETURNING id', [ctx.actor, p.scope || 'all'])).id;
  let value = 0;
  for (const l of arr(p.lines)) {
    const variance = r2(num(l.actual) - num(l.theo));
    const lineValue = r2(variance * num(l.cost));
    value = r2(value + lineValue);
    await c.query('INSERT INTO count_line (count_id, ingredient_id, expected,'
      + ' counted, variance, value) VALUES ($1,$2,$3,$4,$5,$6)'
      + ' ON CONFLICT (count_id, ingredient_id) DO UPDATE SET counted = excluded.counted,'
      + ' variance = excluded.variance, value = excluded.value',
      [id, l.ing, num(l.theo), num(l.actual), variance, lineValue]);
    // A count posts a MOVE, it does not overwrite a balance: the ledger stays
    // the story of what happened, and the variance is visible for ever.
    if (Math.abs(variance) > 0.0001) {
      await moveStock(c, ctx, { ing: l.ing, qty: variance, cost: num(l.cost),
        value: lineValue, reason: 'audit', note: 'Stock count' });
    }
  }
  await c.query("UPDATE stock_count SET closed_at = now(), state = 'posted',"
    + ' variance_value = $2, approved_by = $3, approved_at = now() WHERE id = $1',
    [id, value, ctx.actor]);
  if (Math.abs(value) >= 0.01) {
    await postJournal(c, ctx, value < 0
      ? [{ acct: '5100', dr: -value, memo: 'Count variance' }, { acct: '1200', cr: -value }]
      : [{ acct: '1200', dr: value }, { acct: '5100', cr: value, memo: 'Count variance' }],
    'count', id, today(ctx), 'Stock count variance');
  }
  await log(c, 'count_post', 'stock_count', id, null, { value, lines: arr(p.lines).length });
  return { countId: id, value };
};

H.consume_recipe = async (c, p, ctx) => {
  for (const m of arr(p.moves)) {
    await moveStock(c, ctx, { ing: m.ing, qty: -Math.abs(num(m.qty)), cost: num(m.cost),
      value: r2(m.value), reason: 'prep', note: p.note });
  }
  return { moves: arr(p.moves).length };
};

H.produce = async (c, p, ctx) => {
  let cost = 0;
  for (const m of arr(p.components)) {
    cost = r2(cost + r2(m.value));
    await moveStock(c, ctx, { ing: m.ing, qty: -Math.abs(num(m.qty)), cost: num(m.cost),
      value: r2(m.value), reason: 'prep', note: 'batch of ' + (p.ing || '') });
  }
  const qty = Math.abs(num(p.qty)) || 1;
  const unit = r2(cost / qty);
  const b = await one(c, 'INSERT INTO production_batch (ingredient_id, qty, unit_cost,'
    + ' by_staff, device_id, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [p.ing, qty, unit, ctx.actor, ctx.deviceId, p.note || null]);
  await moveStock(c, ctx, { ing: p.ing, qty: qty, cost: unit, value: cost,
    reason: 'produce', note: 'production batch' });
  return { batchId: b.id, unitCost: unit };
};

H.par_set = async (c, p) => {
  await c.query('UPDATE ingredient SET par = $2, min_stock = coalesce($3, min_stock)'
    + ' WHERE id = $1', [p.ing, num(p.par), p.min == null ? null : num(p.min)]);
  return { ok: true };
};

H.recipe_recost = async (c, p) => ({ items: arr(p.items).length });
H.recost_items = H.recipe_recost;
/* A YIELD IS AN OUTLET FACT, NOT A DEVICE ONE. It decides how much stock every
   sale deducts, and it used to be written into one browser's local state while
   this op carried no payload at all — so the trail recorded a yield of zero
   against no ingredient, and the till beside the one that measured went on
   deducting a figure guessed from the ingredient's name.

   Refused rather than half-recorded: a yield of 0, or above 1, is not a
   measurement, and writing it would make every dish using that ingredient cost
   something absurd. The old handler would have taken either silently. */
H.yield_test = async (c, p, ctx) => {
  if (!p.ing) return { skipped: 'a yield belongs to an ingredient' };
  const y = num(p.y), w = num(p.w);
  if (!(y > 0 && y <= 1)) {
    throw Object.assign(new Error('A yield is what a kilo as purchased actually'
      + ' plates — between 1% and 100%, not ' + p.y), { status: 400 });
  }
  if (!(w >= 0 && w < 1)) {
    throw Object.assign(new Error('Trim loss is a fraction of what is left,'
      + ' below 100% — not ' + p.w), { status: 400 });
  }
  const was = await one(c, 'SELECT yield_pct, waste_pct, name FROM ingredient'
    + ' WHERE id = $1', [p.ing]);
  if (!was) return { skipped: 'no such ingredient' };
  await c.query('UPDATE ingredient SET yield_pct = $2, waste_pct = $3,'
    + ' yield_by = $4, yield_at = now() WHERE id = $1',
  [p.ing, y, w, p.why || null]);
  await log(c, 'yield_test', 'ingredient', p.ing,
    { yield: was.yield_pct == null ? null : num(was.yield_pct),
      waste: was.waste_pct == null ? null : num(was.waste_pct) },
    { name: was.name, yield: y, waste: w, usable: r2(y * (1 - w) * 100),
      why: p.why || null, by: ctx.actor });
  return { ing: p.ing, yield: y, waste: w };
};

// ═══ PURCHASING ════════════════════════════════════════════════════════════
H.grn_receive = async (c, p, ctx) => {
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['GRN']);
  const d = await one(c, 'INSERT INTO delivery (grn_no, po_id, supplier_id,'
    + ' business_date, received_by, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [no.no, p.po || null, p.vendor, p.bizDate || today(ctx), ctx.actor, p.note || null]);
  for (const l of arr(p.lines)) {
    await c.query('INSERT INTO grn_line (delivery_id, ingredient_id, qty, unit,'
      + ' unit_price, line_total, use_by, lot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [d.id, l.ing, num(l.qty), l.unit || null, num(l.price), r2(l.total),
        l.useBy || null, l.lot || null]);
    if (l.useBy || l.lot) {
      await c.query('INSERT INTO batch (ingredient_id, lot, qty, unit_cost, use_by,'
        + ' location_id, delivery_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [l.ing, l.lot || null, num(l.qty), num(l.price), l.useBy || null,
          l.loc || null, d.id]);
    }
    await moveStock(c, ctx, { ing: l.ing, qty: Math.abs(num(l.qty)), cost: num(l.price),
      value: r2(l.total), reason: 'purchase', loc: l.loc, date: p.bizDate });
  }
  await c.query('INSERT INTO document (no, kind, business_date, ref_id, by_staff)'
    + " VALUES ($1,'GRN',$2,$3,$4) ON CONFLICT (no) DO NOTHING",
    [no.no, p.bizDate || today(ctx), d.id, ctx.actor]);
  await log(c, 'grn_receive', 'delivery', d.id, null, { no: no.no, lines: arr(p.lines).length });
  return { deliveryId: d.id, no: no.no };
};

// Pricing a delivery is what claims the input tax. A signed-for delivery
// nobody priced is a credit being left on the table, and the return says so.
H.grn_priced = async (c, p, ctx) => {
  const net = r2(p.net), tax = r2(p.tax), total = r2(net + tax);
  await c.query('UPDATE delivery SET priced = true, priced_at = now(), priced_by = $2,'
    + ' net = $3, tax = $4, total = $5 WHERE id = $1',
    [p.deliveryId, ctx.actor, net, tax, total]);
  const sup = p.invoiceNo ? await supplierIdOf(c, p.vendor, p.vendorName) : null;
  if (p.invoiceNo && sup) {
    await c.query('INSERT INTO vendor_invoice (supplier_id, invoice_no, invoice_date,'
      + ' due_date, net, tax, amount, delivery_id, approved_by)'
      + " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)"
      + ' ON CONFLICT (supplier_id, invoice_no) DO UPDATE SET net = excluded.net,'
      + ' tax = excluded.tax, amount = excluded.amount',
      [sup, p.invoiceNo, p.date || today(ctx),
        p.due || addDays(p.date || today(ctx), num(p.terms) || 30),
        net, tax, total, p.deliveryId, ctx.actor]);
  }
  await postJournal(c, ctx, [
    { acct: '1200', dr: net, memo: 'Stock received' },
    { acct: '2200', dr: tax, memo: 'Input tax' },
    { acct: '2100', cr: total, memo: 'Supplier payable' }
  ], 'delivery', p.deliveryId, p.date || today(ctx), 'Supplier invoice ' + (p.invoiceNo || ''));
  await log(c, 'grn_priced', 'delivery', p.deliveryId, null, { net, tax });
  return { ok: true, total };
};

/* A supplier as the LEDGER must know one: a uuid on chain.supplier. Tills
   hold seed-era numeric ids and names; a payment op that fed either straight
   into a uuid column died on the cast — the same disease member_upsert had,
   and the same cure: resolve what the till sent, or create the real row from
   the name it has always had. */
async function supplierIdOf(c, id, name) {
  if (id && UUID.test(String(id))) return String(id);
  const nm = String(name || '').trim();
  if (!nm) return null;
  const q = await c.query('SELECT id FROM chain.supplier WHERE name = $1 LIMIT 1', [nm]);
  if (q.rows.length) return q.rows[0].id;
  const ins = await one(c, 'INSERT INTO chain.supplier (name) VALUES ($1) RETURNING id', [nm]);
  return ins.id;
}

H.vendor_payment = async (c, p, ctx) => {
  const amt = r2(p.amt);
  /* Devices that queued this op before it carried a payload may still replay
     it bare. A zero-amount payment against no supplier is not a payment — it
     is a row that breaks the ageing report — so it is recorded as skipped
     rather than minted. */
  if (!(amt > 0)) return { skipped: 'a payment needs an amount' };
  const sup = await supplierIdOf(c, p.vendor, p.vendorName);
  if (!sup) return { skipped: 'a payment needs a supplier' };
  const v = await one(c, 'INSERT INTO vendor_payment (supplier_id, invoice_id, amount,'
    + ' method, ref, by_staff) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [sup, p.invoiceId || null, amt, p.method || 'transfer', p.ref || null, ctx.actor]);
  if (p.invoiceId) {
    await c.query('UPDATE vendor_invoice SET paid = paid + $2 WHERE id = $1',
      [p.invoiceId, amt]);
  }
  await postJournal(c, ctx, [
    { acct: '2100', dr: amt, memo: 'Supplier paid' },
    { acct: p.method === 'cash' ? '1010' : '1020', cr: amt }
  ], 'vendor_payment', v.id, today(ctx), 'Supplier payment');
  return { paymentId: v.id };
};
H.payment_run = H.vendor_payment;

H.indent = async (c, p, ctx) => {
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['PR']);
  const i = await one(c, 'INSERT INTO indent (pr_no, to_outlet, needed_by, raised_by,'
    + ' note) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [no.no, p.to || null, p.needed || null, ctx.actor, p.note || null]);
  for (const l of arr(p.lines)) {
    await c.query('INSERT INTO indent_line (indent_id, ingredient_id, qty)'
      + ' VALUES ($1,$2,$3)', [i.id, l.ing, num(l.qty)]);
  }
  return { indentId: i.id, no: no.no };
};

H.dispatch = async (c, p, ctx) => {
  const no = await one(c, 'SELECT chain.next_doc_no($1) AS no', ['DSP']);
  let value = 0;
  const d = await one(c, 'INSERT INTO dispatch (dsp_no, indent_id, to_outlet, sent_by)'
    + ' VALUES ($1,$2,$3,$4) RETURNING id',
    [no.no, p.indentId || null, p.to || null, ctx.actor]);
  for (const l of arr(p.lines)) {
    value = r2(value + num(l.qty) * num(l.cost));
    await c.query('INSERT INTO dispatch_line (dispatch_id, ingredient_id, qty, unit_cost)'
      + ' VALUES ($1,$2,$3,$4)', [d.id, l.ing, num(l.qty), num(l.cost)]);
    await moveStock(c, ctx, { ing: l.ing, qty: -Math.abs(num(l.qty)), cost: num(l.cost),
      value: r2(num(l.qty) * num(l.cost)), reason: 'transfer', note: 'dispatch ' + no.no });
  }
  await c.query('UPDATE dispatch SET value = $2 WHERE id = $1', [d.id, value]);
  if (p.indentId) await c.query("UPDATE indent SET status = 'fulfilled' WHERE id = $1", [p.indentId]);
  return { dispatchId: d.id, no: no.no, value };
};

// The floor moving an order by hand: a waiter marks it served, a manager drags
// a wrong rung back. This used to update `dispatch` — a stock transfer between
// outlets, an entirely different noun — with an id the op does not carry, so it
// silently changed nothing and the till's status was never anybody else's.
//
// Ready or later means the kitchen is done with it, so the pass agrees; earlier
// puts the food back up, because dragging a stage backwards is a real
// correction and half of it is worse than neither.
H.fulfil_stage = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  const rung = Math.max(0, Math.min(3, num(p.stage)));
  if (rung >= RUNG.READY) {
    await c.query('UPDATE ticket_line SET ready_at = now(), ready_by = $2'
      + ' WHERE ticket_id = $1 AND sent_at IS NOT NULL AND ready_at IS NULL',
    [id, ctx.actor]);
  } else {
    await c.query('UPDATE ticket_line SET ready_at = NULL, ready_by = NULL'
      + ' WHERE ticket_id = $1 AND ready_at IS NOT NULL', [id]);
  }
  await setRung(c, id, rung, ctx);
  await log(c, 'fulfil_stage', 'ticket', id, null, { stage: rung });
  return { ticketId: id, stage: rung };
};

// ═══ THE BOOKS ═════════════════════════════════════════════════════════════
// A manual journal REFUSES the accounts the till owns and requires a memo. A
// manual entry without a reason is unauditable, and a hand-keyed cash line is
// how a ledger stops reconciling to the POS.
H.post_journal = async (c, p, ctx) => {
  if (!p.memo || !String(p.memo).trim()) {
    throw Object.assign(new Error('A manual journal needs a memo'), { status: 400 });
  }
  const codes = arr(p.lines).map((l) => l.acct);
  const owned = await c.query('SELECT code, name FROM account WHERE code = ANY($1)'
    + ' AND till_owned', [codes]);
  if (owned.rows.length) {
    throw Object.assign(new Error('The till owns ' + owned.rows.map((x) =>
      x.code + ' ' + x.name).join(', ') + ' — post through the operation that moves it'),
    { status: 403 });
  }
  const id = await postJournal(c, ctx, p.lines, 'manual', null, p.date || today(ctx), p.memo);
  await log(c, 'post_journal', 'journal', id, null, { memo: p.memo });
  return { journalId: id };
};

H.period_close = async (c, p, ctx) => {
  await c.query("INSERT INTO period (id, starts_on, ends_on, state, closed_at, closed_by)"
    + " VALUES ($1, ($1 || '-01')::date, (date_trunc('month',($1 || '-01')::date)"
    + " + interval '1 month - 1 day')::date, 'closed', now(), $2)"
    + " ON CONFLICT (id) DO UPDATE SET state = 'closed', closed_at = now(), closed_by = $2",
  [p.period, ctx.actor]);
  await log(c, 'period_close', 'period', p.period, null, null);
  return { period: p.period };
};

H.period_reopen = async (c, p, ctx) => {
  await c.query("UPDATE period SET state = 'open', reopened_at = now(), reopened_by = $2"
    + ' WHERE id = $1', [p.period, ctx.actor]);
  await log(c, 'period_reopen', 'period', p.period, null, { why: p.why });
  return { period: p.period };
};

H.bank_import = async (c, p, ctx) => {
  let n = 0;
  for (const l of arr(p.lines)) {
    await c.query('INSERT INTO bank_line (value_date, descr, amount, balance, ref)'
      + ' VALUES ($1,$2,$3,$4,$5)',
      [l.date, l.descr, r2(l.amt), l.bal == null ? null : r2(l.bal), l.ref || null]);
    n++;
  }
  await log(c, 'bank_import', 'bank_line', null, null, { lines: n });
  return { imported: n };
};

// Three outcomes, never two: an exact hit clears itself, a near miss becomes a
// proposal a human accepts or rejects, and anything else stays unexplained.
H.bank_match = async (c, p, ctx) => {
  await c.query('UPDATE bank_line SET state = $2, matched_account = $3,'
    + ' matched_source = $4, matched_id = $5, matched_at = now(), matched_by = $6'
    + ' WHERE id = $1',
    [p.id, p.state || 'proposed', p.acct || null, p.src || null,
      p.ref || null, ctx.actor]);
  return { ok: true };
};

H.bank_match_accept = async (c, p, ctx) => {
  const l = await one(c, 'SELECT * FROM bank_line WHERE id = $1', [p.id]);
  if (!l) return { skipped: 'no such line' };
  await c.query("UPDATE bank_line SET state = 'cleared', matched_at = now(),"
    + ' matched_by = $2, matched_account = coalesce($3, matched_account) WHERE id = $1',
  [p.id, ctx.actor, p.acct || null]);
  // A charge nobody booked is proposed to 5600 Bank & card charges — not to
  // 6300 Administration, which overstates office cost and hides the cost of
  // taking cards.
  if (p.post) {
    const acct = p.acct || (num(l.amount) < 0 ? '5600' : '4900');
    const amt = Math.abs(r2(l.amount));
    await postJournal(c, ctx, num(l.amount) < 0
      ? [{ acct: acct, dr: amt, memo: l.descr }, { acct: '1020', cr: amt }]
      : [{ acct: '1020', dr: amt }, { acct: acct, cr: amt, memo: l.descr }],
    'bank', l.id, l.value_date, 'Bank: ' + l.descr);
  }
  return { ok: true };
};
H.bank_clear_manual = H.bank_match_accept;
H.bank_recon = async (c, p) => ({ ok: true, at: Date.now() });

H.bank_opening = async (c, p, ctx) => {
  await c.query('INSERT INTO bank_opening (id, account_code, as_of, amount, set_by)'
    + ' VALUES (1,$1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET account_code = $1,'
    + ' as_of = $2, amount = $3, set_by = $4, set_at = now()',
    [p.acct || '1020', p.asOf || today(ctx), r2(p.amt), ctx.actor]);
  return { ok: true };
};

// Card settlement matches batch by batch at the contract rate; more than
// MVR 1 off expected net is flagged Short paid, not cleared.
H.acq_match = async (c, p, ctx) => {
  const gross = r2(p.gross), mdr = num(p.mdr);
  const fee = r2(gross * mdr / 100);
  const expected = r2(gross - fee);
  const net = p.net == null ? expected : r2(p.net);
  const variance = r2(net - expected);
  const state = Math.abs(variance) <= 1 ? 'matched' : 'short';
  // The net BEFORE this file: the correction delta must be measured against
  // what was previously booked, and the upsert below overwrites it.
  const before = await c.query('SELECT net FROM settlement_batch'
    + ' WHERE acquirer = $1 AND batch_no = $2', [p.acquirer, p.batch]);
  const priorNet = before.rows.length ? r2(before.rows[0].net) : null;
  const b = await one(c, 'INSERT INTO settlement_batch (acquirer, batch_no, value_date,'
    + ' gross, mdr_pct, fee, net, expected_net, variance, state, matched_at, matched_by)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11)'
    + ' ON CONFLICT (acquirer, batch_no) DO UPDATE SET net = excluded.net,'
    + ' variance = excluded.variance, state = excluded.state RETURNING id',
    [p.acquirer, p.batch, p.date || today(ctx), gross, mdr, fee, net, expected,
      variance, state, ctx.actor]);
  /* The entry books what actually happened, matched or short: the bank paid
     `net`, the receivable clears at `gross`, and the whole deduction — fee
     plus any shortfall — is the cost of taking cards. Booking only when
     |variance| ≤ 1 left every short batch OFF the books entirely, with a
     dead client-side write-off button pointing at a till-owned account.

     Once. A re-match of a batch whose entry exists posts only the DELTA of a
     corrected net (a corrected advice file is a corrected payment, not a
     licence to restate the original) — and nothing at all when unchanged,
     so replays and the legacy repair button stay no-ops. */
  const prior = await c.query('SELECT id FROM journal'
    + " WHERE source = 'settlement' AND source_id = $1 LIMIT 1", [String(b.id)]);
  if (!prior.rows.length) {
    const ded = r2(gross - net);
    const lines = [{ acct: '1020', dr: net, memo: 'Card settlement' }];
    if (ded > 0) lines.push({ acct: '5600', dr: ded, memo: 'Merchant fee & shortfall' });
    if (ded < 0) lines.push({ acct: '5600', cr: -ded, memo: 'Acquirer overpayment' });
    lines.push({ acct: '1030', cr: gross, memo: 'Card receivable cleared' });
    await postJournal(c, ctx, lines, 'settlement', b.id,
      p.date || today(ctx), 'Card batch ' + p.batch);
  } else {
    const delta = r2(net - (priorNet == null ? net : priorNet));
    if (Math.abs(delta) > 0.005) {
      await postJournal(c, ctx, delta > 0
        ? [{ acct: '1020', dr: delta, memo: 'Corrected settlement' },
          { acct: '5600', cr: delta, memo: 'Deduction reduced' }]
        : [{ acct: '5600', dr: -delta, memo: 'Deduction increased' },
          { acct: '1020', cr: -delta, memo: 'Corrected settlement' }],
      'settlement', b.id, p.date || today(ctx), 'Card batch ' + p.batch + ' corrected');
    }
  }
  return { batchId: b.id, state, variance, fee };
};

H.acq_reopen = async (c, p) => {
  // By server id when the caller holds one; by the acquirer's own batch key
  // when the till does. It used to accept only p.id, which no till has —
  // every reopen updated zero rows and reported ok.
  const q = p.id
    ? await c.query("UPDATE settlement_batch SET state = 'reopened' WHERE id = $1"
      + ' RETURNING id', [p.id])
    : await c.query("UPDATE settlement_batch SET state = 'reopened'"
      + ' WHERE acquirer = $1 AND batch_no = $2 RETURNING id',
    [p.acquirer || '', p.batch || '']);
  return q.rows.length ? { ok: true } : { skipped: 'no such batch' };
};

H.mdr_set = async (c, p, ctx) => setSetting(c, ctx, 'acquirer_rates_outlet', p.rates || p);
H.channel_rates = async (c, p, ctx) => setSetting(c, ctx, 'channel_rates', p.rates || p);
H.fx_rates = async (c, p, ctx) => setSetting(c, ctx, 'fx_rates', p.rates || p);

H.tax_version = async (c, p, ctx) => {
  await c.query('INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from,'
    + ' authority_ref) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [ctx.outletId, p.code, num(p.rate), p.from || today(ctx), p.ref || 'Rate change']);
  await log(c, 'tax_version', 'tax_version', p.code, null, { rate: num(p.rate), from: p.from });
  return { ok: true };
};

// ═══ PEOPLE AND COSTS ══════════════════════════════════════════════════════
H.clock_in = async (c, p, ctx) => {
  const q = await one(c, 'INSERT INTO clock_entry (employee_id, in_at, business_date,'
    + ' by_staff, device_id) VALUES ($1, coalesce($2, now()), coalesce($3, current_date),'
    + ' $4,$5) RETURNING id',
    [p.emp, p.at ? new Date(p.at) : null, p.bizDate || null, ctx.actor, ctx.deviceId]);
  return { clockId: q.id };
};

H.clock_out = async (c, p) => {
  await c.query('UPDATE clock_entry SET out_at = coalesce($2, now()) WHERE id = $1'
    + ' AND out_at IS NULL', [p.clockId, p.at ? new Date(p.at) : null]);
  return { ok: true };
};

// Employer pension is its OWN expense, taken from wages, not netted into them.
H.post_payroll = async (c, p, ctx) => {
  const gross = r2(p.gross), ee = r2(p.pensionEe), er = r2(p.pensionEr);
  const wht = r2(p.withholding), svc = r2(p.service);
  const net = r2(gross - ee - wht + svc);
  await c.query('INSERT INTO payroll_run (id, posted_at, posted_by, gross, pension_ee,'
    + ' pension_er, withholding, service_pool, net) VALUES ($1, now(), $2,$3,$4,$5,$6,$7,$8)'
    + ' ON CONFLICT (id) DO UPDATE SET posted_at = now(), posted_by = $2, gross = $3,'
    + ' pension_ee = $4, pension_er = $5, withholding = $6, service_pool = $7, net = $8',
    [p.period, ctx.actor, gross, ee, er, wht, svc, net]);
  for (const l of arr(p.lines)) {
    await c.query('INSERT INTO payroll_line (run_id, employee_id, hours, ot_hours,'
      + ' basic, ot_pay, service, pension_ee, pension_er, withholding, net)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [p.period, l.emp, num(l.hours), num(l.ot), r2(l.basic), r2(l.otPay),
        r2(l.service), r2(l.pensionEe), r2(l.pensionEr), r2(l.wht), r2(l.net)]);
  }
  const j = await postJournal(c, ctx, [
    { acct: '5300', dr: gross, memo: 'Wages' },
    { acct: '5310', dr: er, memo: 'Employer pension' },
    { acct: '2500', cr: r2(ee + er), memo: 'MRPS payable' },
    { acct: '2600', cr: wht, memo: 'Withholding payable' },
    { acct: '2300', dr: svc, memo: 'Service charge distributed' },
    /* 2400, not 2450. Net wages used to be credited to "Tips payable to
       staff", so the tips account carried the whole payroll and neither
       figure could ever be reconciled — the tip float in the drawer against
       a balance that included every salary in the company. */
    { acct: '2400', cr: net, memo: 'Net pay owed' }
  ], 'payroll', p.period, p.date || today(ctx), 'Payroll ' + p.period);
  await c.query('UPDATE payroll_run SET journal_id = $2 WHERE id = $1', [p.period, j]);
  await log(c, 'post_payroll', 'payroll_run', p.period, null, { gross, net });
  return { period: p.period, net, journalId: j };
};

H.opex_insert = async (c, p, ctx) => {
  await c.query('INSERT INTO opex (id, category, vendor, amount, freq, due_day,'
    + ' account_code, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)'
    + ' ON CONFLICT (id) DO UPDATE SET category = excluded.category,'
    + ' vendor = excluded.vendor, amount = excluded.amount, freq = excluded.freq,'
    + ' due_day = excluded.due_day, account_code = excluded.account_code',
    [p.id || slug(p.cat), p.cat, p.vendor || null, r2(p.amt), p.freq || 'monthly',
      num(p.due) || 1, p.acct || '6300', p.note || null]);
  return { ok: true };
};

H.opex_pay = async (c, p, ctx) => {
  const amt = r2(p.amt);
  const j = await postJournal(c, ctx, [
    { acct: p.acct || '6300', dr: amt, memo: p.cat || 'Operating cost' },
    { acct: p.method === 'cash' ? '1010' : '1020', cr: amt }
  ], 'opex', p.id, p.on || today(ctx), 'Operating cost · ' + (p.cat || ''));
  await c.query('INSERT INTO opex_payment (opex_id, period, paid_on, amount, by_staff,'
    + ' journal_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (opex_id, period) DO NOTHING',
    [p.id, p.period || String(today(ctx)).slice(0, 7), p.on || today(ctx), amt, ctx.actor, j]);
  return { ok: true };
};

H.asset_insert = async (c, p, ctx) => {
  await c.query('INSERT INTO asset (id, name, category, cost, bought_on, life_years,'
    + ' residual, serial, location_id, warranty_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, cost = excluded.cost,'
    + ' life_years = excluded.life_years, residual = excluded.residual',
    [p.id || slug(p.name), p.name, p.cat || null, r2(p.cost), p.bought || today(ctx),
      num(p.life) || 5, r2(p.residual), p.serial || null, p.loc || null,
      p.warranty || null]);
  await postJournal(c, ctx, [
    { acct: '1500', dr: r2(p.cost), memo: 'Equipment ' + p.name },
    { acct: p.method === 'cash' ? '1010' : '2100', cr: r2(p.cost) }
  ], 'asset', p.id || slug(p.name), p.bought || today(ctx), 'Equipment purchase');
  return { ok: true };
};

H.asset_update = async (c, p) => {
  await c.query('UPDATE asset SET state = coalesce($2, state), disposed_on = $3,'
    + ' disposed_value = $4 WHERE id = $1',
    [p.id, p.state || null, p.disposedOn || null,
      p.disposedValue == null ? null : r2(p.disposedValue)]);
  return { ok: true };
};

H.maintenance_log = async (c, p, ctx) => {
  const cost = r2(p.cost);
  const j = cost ? await postJournal(c, ctx, [
    { acct: '5400', dr: cost, memo: p.detail || 'Repair' },
    { acct: p.method === 'cash' ? '1010' : '2100', cr: cost }
  ], 'maintenance', p.asset, p.on || today(ctx), 'Repairs & maintenance') : null;
  await c.query('INSERT INTO maintenance_log (asset_id, kind, detail, cost, vendor,'
    + ' by_staff, journal_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [p.asset, p.kind || 'repair', p.detail || '', cost, p.vendor || null, ctx.actor, j]);
  return { ok: true };
};

H.depreciate = async (c, p, ctx) => {
  const amt = r2(p.amount);
  if (!amt) return { skipped: 'nothing to depreciate' };
  const j = await postJournal(c, ctx, [
    { acct: '5500', dr: amt, memo: 'Depreciation ' + p.period },
    { acct: '1510', cr: amt }
  ], 'depreciation', p.period, p.date || today(ctx), 'Depreciation ' + p.period);
  await c.query('INSERT INTO depreciation_run (period, posted_by, amount, journal_id)'
    + ' VALUES ($1,$2,$3,$4) ON CONFLICT (period) DO NOTHING', [p.period, ctx.actor, amt, j]);
  return { period: p.period, amount: amt };
};

// ═══ MENU AND MASTERS ══════════════════════════════════════════════════════
H.menu_section_insert = async (c, p) => {
  await c.query('INSERT INTO menu_section (id, name, pos, colour) VALUES ($1,$2,$3,$4)'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, pos = excluded.pos',
    [p.id || slug(p.name), p.name, num(p.pos), p.colour || null]);
  return { ok: true };
};
H.menu_section_update = H.menu_section_insert;

H.menu_section_reorder = async (c, p) => {
  for (const [i, id] of arr(p.order).entries()) {
    await c.query('UPDATE menu_section SET pos = $2 WHERE id = $1', [id, i]);
  }
  return { ok: true };
};

H.menu_category_insert = async (c, p) => {
  await c.query('INSERT INTO menu_category (id, name, section_id, pos, colour)'
    + ' VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name = excluded.name,'
    + ' section_id = excluded.section_id, pos = excluded.pos',
    [p.id || slug(p.name), p.name, p.section || null, num(p.pos), p.colour || null]);
  return { ok: true };
};
H.category_insert = H.menu_category_insert;

H.dish_upsert = async (c, p, ctx) => {
  const id = p.id || slug(p.name);
  await c.query('INSERT INTO item (id, name, category_id, station, price, yield_qty,'
    + ' unit, prep_mins, description, image, allergens, diets, tags, active, off_menu,'
    + ' sold_out_reason, pos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'
    + ' coalesce($14,true), coalesce($15,false), $16, $17)'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name,'
    + ' category_id = excluded.category_id, station = excluded.station,'
    + ' price = excluded.price, yield_qty = excluded.yield_qty, unit = excluded.unit,'
    + ' prep_mins = excluded.prep_mins, description = excluded.description,'
    + ' image = excluded.image, allergens = excluded.allergens, diets = excluded.diets,'
    + ' tags = excluded.tags, active = excluded.active,'
    /* Preserved when the caller is SILENT about it. off_menu is a standing
       menu decision, and `excluded.off_menu` (coalesced to false at insert)
       meant any save that did not mention it — a bulk import, an older build —
       quietly put a hidden dish back on the menu. A caller that means to show
       it again says false; saying nothing is not the same as saying false.
       sold_out_reason is the opposite by nature: null IS "back on sale". */
    + ' off_menu = coalesce($15, item.off_menu),'
    + ' sold_out_reason = excluded.sold_out_reason',
    [id, p.name, p.cat || null, p.station || 'main', r2(p.price), num(p.yield) || 1,
      p.unit || 'plate', num(p.prep) || 12, p.desc || null, p.img || null,
      arr(p.allergens), arr(p.diets), arr(p.tags), p.active, p.offMenu,
      p.soldOutReason || null, num(p.pos)]);
  if (Array.isArray(p.recipe)) await writeRecipe(c, id, p.recipe);
  await publishDeclaration(c, id);
  await log(c, 'dish_upsert', 'item', id, null, { name: p.name, price: r2(p.price) });
  return { itemId: id };
};
H.menu_import = async (c, p, ctx) => {
  let n = 0;
  for (const d of arr(p.dishes)) { await H.dish_upsert(c, d, ctx); n++; }
  await log(c, 'menu_import', 'item', null, null, { dishes: n });
  return { imported: n };
};
H.ai_menu_draft = async (c, p, ctx) => {
  await log(c, 'ai_menu_draft', 'item', null, null, { dishes: arr(p.dishes).length });
  return { drafted: arr(p.dishes).length };
};

/* ── a batch the kitchen makes, and the dishes that draw on it ─────────────
   A sub-recipe IS AN ITEM. The schema has said so since 003 — `recipe_line`'s
   component is either an `ingredient_id` or a `sub_item_id REFERENCES item(id)`
   — but nothing ever wrote one, so `sub_item_id` was a foreign key with no
   possible referent and a dish drawing on a batch could not be stored at all.

   Meanwhile the terminal carried its own parallel model: three batches
   hard-coded into the source with ingredient ids from an old seed, plus
   whatever an operator had edited into THIS browser's local state. So a
   kitchen costing its curry base was costing it for itself, on one device,
   and the op that was meant to record it had no handler and no payload.

   Written as an item because that is what makes the rest of the model work:
   the declaration walk already recurses through `sub_item_id`, the allergens
   of a batch reach every dish that uses it, and `yield_qty` is where the
   batch's OUTPUT belongs. Off-menu, so it never appears on the till's grid —
   nobody orders a litre of fish stock.

   The output is stored net of reduction: a 4-litre batch that loses 18% to
   evaporation yields 3.28 litres, and a dish drawing 200ml draws 200/3280 of
   the batch's cost. Keeping the loss separately as well is what lets the
   costing screen say WHY a litre of stock costs more than its inputs over
   four. */
H.subrecipe_add = async (c, p, ctx) => {
  if (!p || !p.id || !p.name) return { skipped: 'a batch needs a name' };
  const batch = num(p.batch);
  const loss = Math.min(0.8, Math.max(0, num(p.loss)));
  if (!(batch > 0)) {
    throw Object.assign(new Error('A batch size is what a gram of it is costed'
      + ' against — it cannot be ' + p.batch), { status: 400 });
  }
  const lines = arr(p.lines).filter((l) => l && l.ing && num(l.qty) > 0);
  if (!lines.length) return { skipped: 'a batch needs at least one ingredient' };

  const yielded = r2(batch * (1 - loss));
  await c.query(
    'INSERT INTO item (id, name, price, yield_qty, unit, off_menu, is_batch,'
    + ' loss_pct, description) VALUES ($1,$2,0,$3,$4,true,true,$5,$6)'
    + ' ON CONFLICT (id) DO UPDATE SET name = $2, yield_qty = $3, unit = $4,'
    + ' off_menu = true, is_batch = true, loss_pct = $5, description = $6',
    [p.id, p.name, yielded || batch, p.unit || 'g', loss, p.note || null]);
  await writeRecipe(c, p.id, lines.map((l) => ({ ing: l.ing, qty: num(l.qty) })));
  // A batch has allergens of its own, and every dish drawing on it inherits
  // them — the walk already recurses, it just never had a batch to recurse into.
  await publishDeclaration(c, p.id);
  const users = await c.query('SELECT DISTINCT item_id FROM recipe_line'
    + ' WHERE sub_item_id = $1', [p.id]);
  for (const u of users.rows) await publishDeclaration(c, u.item_id);
  await log(c, 'subrecipe_upsert', 'item', p.id, null,
    { name: p.name, batch: batch, loss: loss, yielded: yielded,
      unit: p.unit || 'g', inputs: lines.length, dishes: users.rows.length });
  return { id: p.id, yielded: yielded, inputs: lines.length };
};
H.subrecipe_update = H.subrecipe_add;

H.recipe_update = async (c, p) => {
  await writeRecipe(c, p.item, arr(p.lines));
  await publishDeclaration(c, p.item);
  return { lines: arr(p.lines).length };
};

async function writeRecipe(c, itemId, lines) {
  await c.query('DELETE FROM recipe_line WHERE item_id = $1', [itemId]);
  for (const l of lines) {
    const ing = Array.isArray(l) ? l[0] : l.ing;
    const qty = Array.isArray(l) ? l[1] : l.qty;
    const waste = Array.isArray(l) ? l[2] : l.waste;
    const isSub = Array.isArray(l) ? l[3] === 'sub' : !!l.sub;
    if (!ing || !num(qty)) continue;
    await c.query('INSERT INTO recipe_line (item_id, ingredient_id, sub_item_id, qty,'
      + ' waste_pct) VALUES ($1,$2,$3,$4,$5)',
    [itemId, isSub ? null : ing, isSub ? ing : null, num(qty), num(waste)]);
  }
}

/* ── what a dish declares ─────────────────────────────────────────────────
   A GUEST PHONE HOLDS NO RECIPE — a recipe is a cost sheet, and a costing on
   a customer's device is a leak. So the allergen and diet declaration is
   worked out HERE, from the recipe rows, using the same rule table the
   browser loads (app/kashikeyo-rules.js), and published onto the item. The
   phone reads the answer, never the ingredients.

   Sub-recipes are expanded: a sauce made of a sauce still declares what is in
   both. Depth is bounded because a recipe that references itself is a bug the
   kitchen should not be able to turn into a hang. ───────────────────────── */
async function publishDeclaration(c, itemId) {
  const parts = [];
  const add = {};
  let frontier = [itemId];
  const seen = new Set([itemId]);
  /* THE CAP WAS FOUR, AND IT FAILED SILENTLY. `seen` already makes a cycle
     terminate, so the depth limit was never about safety — and a fifth level
     of sub-recipe simply stopped being walked. Its ingredients were dropped
     from the declaration, which is not a smaller answer but a WRONG one: a
     dish whose deepest component is a reef fish came out claiming Vegetarian,
     and the only symptom was a badge nobody could argue with.

     Twelve, because a real kitchen nests three at the outside and a stock that
     goes twelve deep is a data error worth hearing about. And if the frontier
     is STILL not empty at twelve, nothing is published: the previous
     declaration stands and the truncation goes on the trail. A partial
     declaration replacing a complete one is strictly worse than no update. */
  const MAX_DEPTH = 12;
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const q = await c.query(
      'SELECT r.item_id, r.sub_item_id, i.name, i.category, i.allergens'
      + ' FROM recipe_line r LEFT JOIN ingredient i ON i.id = r.ingredient_id'
      + ' WHERE r.item_id = ANY($1::text[])', [frontier]);
    const next = [];
    q.rows.forEach((row) => {
      if (row.sub_item_id) {
        if (!seen.has(row.sub_item_id)) { seen.add(row.sub_item_id); next.push(row.sub_item_id); }
        return;
      }
      if (!row.name) return;
      parts.push({ name: row.name, cat: row.category });
      // An ingredient may carry a declaration of its own — a supplier's "may
      // contain". It is added, never subtracted.
      (row.allergens || []).forEach((k) => { add[k] = 1; });
    });
    frontier = next;
  }
  if (frontier.length) {
    await log(c, 'declaration_truncated', 'item', itemId, null, {
      depth: MAX_DEPTH, unwalked: frontier.length,
      note: 'this dish nests deeper than the expansion walks, so what it'
        + ' contains cannot be stated in full; the declaration it already'
        + ' carried is left alone rather than replaced with a partial one'
    });
    return { truncated: true };
  }
  const declared = Object.keys(add);
  const allergens = RULES.allergenKeys(parts, declared);
  const diets = RULES.dietKeys(parts, declared);
  await c.query('UPDATE item SET allergens = $2, diets = $3 WHERE id = $1',
    [itemId, allergens, diets]);
  return { allergens, diets };
}

// An ingredient's name, category or own declaration changed: every dish that
// uses it says something different now.
async function republishUsing(c, ingredientId) {
  const q = await c.query('SELECT DISTINCT item_id FROM recipe_line'
    + ' WHERE ingredient_id = $1', [ingredientId]);
  for (const row of q.rows) await publishDeclaration(c, row.item_id);
}

/* ── THE OWNER ASKING TO BE PUT ON A PLAN ──────────────────────────────────
   The consequence of this is not in this database at all: it is the seller
   opening Mission Control and either extending the trial or converting the
   install. So this handler grants nothing — a plan a customer can award
   themselves is not a plan — and does exactly two things.

   It records the ASK where the till can read it back, so the control can say
   "you asked on the 3rd" rather than offering to ask again as though the first
   one went nowhere. That is `chain.setting`, because the trail is INSERT-only
   from an outlet by design and a screen cannot render a row it may not read.

   And it puts the event on the trail as well, which is the copy that survives:
   settings hold the LATEST ask, the trail holds every one of them, and a
   support call six weeks later needs the second.

   The platform door reads the setting back on its summary, so the seller sees
   the request without the install ever having to reach out to anything. */
const PLAN_WANTS = ['monthly', 'yearly', 'permanent', 'talk'];

H.plan_request = async (c, p, ctx) => {
  // An unrecognised choice is recorded as "talk" rather than refused: the
  // customer has asked either way, and losing the ask over a vocabulary
  // mismatch would be the worst possible outcome of pressing this button.
  const want = PLAN_WANTS.includes(String(p.want)) ? String(p.want) : 'talk';
  const row = {
    at: new Date().toISOString(),
    by: String(p.by || '').slice(0, 80) || null,
    want: want,
    note: String(p.note || '').slice(0, 600)
  };
  await c.query("INSERT INTO chain.setting (key, value) VALUES ('plan_request', $1)"
    + ' ON CONFLICT (key) DO UPDATE SET value = $1', [JSON.stringify(row)]);
  await log(c, 'plan_request', 'install', null, null, row);
  return { asked: true, want: want };
};

H.item_upsert = async (c, p) => {
  const id = p.id || slug(p.name);
  await c.query('INSERT INTO ingredient (id, name, category, base_unit, stock_unit,'
    + ' stock_factor, avg_cost, par, min_stock, location_id, supplier_id, count_freq,'
    + ' allergens, sellable, sell_price, producible)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14,false),$15,'
    + ' coalesce($16,false)) ON CONFLICT (id) DO UPDATE SET name = excluded.name,'
    + ' category = excluded.category, base_unit = excluded.base_unit,'
    + ' stock_unit = excluded.stock_unit, stock_factor = excluded.stock_factor,'
    + ' par = excluded.par, min_stock = excluded.min_stock,'
    + ' location_id = excluded.location_id, supplier_id = excluded.supplier_id,'
    + ' count_freq = excluded.count_freq, allergens = excluded.allergens,'
    + ' sellable = excluded.sellable, sell_price = excluded.sell_price,'
    + ' producible = excluded.producible',
    [id, p.name, p.cat || null, p.base || 'g', p.stock || p.base || 'g',
      num(p.factor) || 1, num(p.cost), p.par == null ? null : num(p.par),
      p.min == null ? null : num(p.min), p.loc || null, p.vendor || null,
      p.freq || 'weekly', arr(p.allergens), p.sellable,
      p.sellPrice == null ? null : r2(p.sellPrice), p.producible]);
  await republishUsing(c, id);
  return { ingredientId: id };
};

H.modifier_update = async (c, p) => {
  if (p.group) {
    await c.query('INSERT INTO modifier_group (id, name, min_pick, max_pick, required)'
      + ' VALUES ($1,$2,$3,$4,coalesce($5,false)) ON CONFLICT (id) DO UPDATE'
      + ' SET name = excluded.name, min_pick = excluded.min_pick,'
      + ' max_pick = excluded.max_pick, required = excluded.required',
      [p.group, p.groupName || p.group, num(p.min), num(p.max) || 1, p.required]);
  }
  if (p.id) {
    await c.query('INSERT INTO modifier (id, group_id, name, price, pos)'
      + ' VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name = excluded.name,'
      + ' price = excluded.price, pos = excluded.pos',
      [p.id, p.group, p.name, r2(p.price), num(p.pos)]);
  }
  for (const item of arr(p.items)) {
    await c.query('INSERT INTO item_modifier (item_id, group_id) VALUES ($1,$2)'
      + ' ON CONFLICT DO NOTHING', [item, p.group]);
  }
  return { ok: true };
};

H.promo_upsert = async (c, p) => {
  await c.query('INSERT INTO promo (id, name, kind, value, code, max_pct, channels,'
    + ' starts_on, ends_on, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,true))'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind,'
    + ' value = excluded.value, code = excluded.code, max_pct = excluded.max_pct,'
    + ' channels = excluded.channels, active = excluded.active',
    [p.id || slug(p.name), p.name, p.kind || 'percent', num(p.value || p.pct),
      p.code || null, num(p.maxPct) || 100, arr(p.channels), p.from || null,
      p.to || null, p.active]);
  return { ok: true };
};
H.promo_clamped = async (c, p, ctx) => {
  await log(c, 'promo_clamped', 'promo', p.id, { asked: num(p.asked) }, { given: num(p.given) });
  return { ok: true };
};

H.banner_upsert = async (c, p) => {
  await c.query('INSERT INTO banner (id, slot, title, body, image, link, starts_on,'
    + ' ends_on, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,true))'
    + ' ON CONFLICT (id) DO UPDATE SET slot = excluded.slot, title = excluded.title,'
    + ' body = excluded.body, image = excluded.image, link = excluded.link,'
    + ' active = excluded.active',
    [p.id || slug(p.title), p.slot || 'hero', p.title, p.sub || null, p.img || null,
      p.code || null, p.from || null, p.to || null, p.active]);
  return { ok: true };
};
H.qr_banner_slot = H.banner_upsert;

H.vendor_upsert = async (c, p) => {
  const q = await one(c, 'INSERT INTO chain.supplier (name, trn, contact, phone, email,'
    + ' terms_days, lead_days) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [p.name, p.trn || null, p.contact || null, p.phone || null, p.email || null,
      num(p.terms) || 30, num(p.lead) || 2]);
  return { vendorId: q.id };
};

// ═══ KITCHEN ═══════════════════════════════════════════════════════════════
H.fire_course = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  // The till names its own lines; resolve them to the outlet's before the pass
  // is told which ones it is cooking.
  let ids = arr(p.lineIds);
  if (!ids.length && arr(p.lids).length && id) {
    const q = await c.query('SELECT id FROM ticket_line WHERE ticket_id = $1'
      + ' AND client_id = ANY($2::text[])', [id, arr(p.lids)]);
    ids = q.rows.map((r) => r.id);
  }
  const k = await one(c, 'INSERT INTO kds_ticket (ticket_id, line_ids, station, course,'
    + ' target_mins, by_staff) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [id, ids, p.station || 'main', p.course || null,
      num(p.target) || 12, ctx.actor]);
  if (ids.length) {
    await c.query('UPDATE ticket_line SET sent_at = now() WHERE id = ANY($1)'
      + ' AND sent_at IS NULL', [ids]);
  }
  // A later course reopens an order the pass had already finished. Leaving the
  // rung at Ready tells the guest their food has arrived while it is being
  // cooked, so firing always puts the order back in the kitchen.
  if (id) await setRung(c, id, RUNG.KITCHEN, ctx);
  return { kdsId: k.id, lines: ids.length };
};

// ── Where an order is ───────────────────────────────────────────────────────
// Four rungs, the same four the guest's tracker shows. The pass moves it by
// finishing food; the floor moves it by hand. Both write here, so a kitchen
// that has finished a table cannot leave the orders list saying "Open".
const RUNG = { TAKING: 0, KITCHEN: 1, READY: 2, SERVED: 3 };

async function setRung(c, ticketId, n, ctx) {
  const rung = Math.max(0, Math.min(3, num(n)));
  await c.query('UPDATE ticket SET stage = $2, stage_at = now(), stage_by = $3'
    + " WHERE id = $1 AND status <> 'closed'", [ticketId, rung, ctx.actor]);
  return rung;
}

// The rung the PASS implies. Nothing fired means nobody has started, and a
// ticket with food still up is in the kitchen whatever a stale device thinks.
// "Served" is never inferred: carrying the plates is a person's act, not the
// absence of one, and inferring it would tell a guest their food arrived while
// it sat under the lamp.
async function rungFromPass(c, ticketId) {
  const r = await one(c, 'SELECT count(*) FILTER (WHERE sent_at IS NOT NULL) AS fired,'
    + ' count(*) FILTER (WHERE sent_at IS NOT NULL AND ready_at IS NULL) AS cooking'
    + ' FROM ticket_line WHERE ticket_id = $1 AND void_at IS NULL', [ticketId]);
  if (!r || !num(r.fired)) return RUNG.TAKING;
  return num(r.cooking) ? RUNG.KITCHEN : RUNG.READY;
}

// Which of a ticket's lines an op is talking about. The till names its lines,
// so a bump sent from a tablet that has never seen a server id still lands on
// the right plate. No `lids` at all means the whole ticket.
async function linesOf(c, ticketId, p) {
  const lids = arr(p.lids).concat(p.lid ? [p.lid] : []).filter(Boolean);
  if (!lids.length) return null;
  const q = await c.query('SELECT id FROM ticket_line WHERE ticket_id = $1'
    + ' AND (client_id = ANY($2::text[]) OR id::text = ANY($2::text[]))',
  [ticketId, lids.map(String)]);
  return q.rows.map((r) => r.id);
}

H.kds_bump = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  const ids = await linesOf(c, id, p);
  // A line comes back up at the pass. `sent_at IS NOT NULL` is not a filter for
  // tidiness — the constraint refuses a line finished before it was fired, and
  // a device replaying an old bump must not abort the batch over it.
  const q = await c.query('UPDATE ticket_line SET ready_at = now(), ready_by = $2'
    + ' WHERE ticket_id = $1 AND sent_at IS NOT NULL AND ready_at IS NULL'
    + (ids ? ' AND id = ANY($3)' : ''),
  ids ? [id, ctx.actor, ids] : [id, ctx.actor]);
  if (p.kdsId) {
    await c.query("UPDATE kds_ticket SET stage = 'Ready', ready_at = now(),"
      + ' bumped_by = $2 WHERE id = $1', [p.kdsId, ctx.actor]);
  }
  const rung = await setRung(c, id, await rungFromPass(c, id), ctx);
  return { ticketId: id, bumped: q.rowCount, stage: rung };
};

// The expeditor calls the whole table away. Same write, no line filter.
H.kds_bump_all = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  const q = await c.query('UPDATE ticket_line SET ready_at = now(), ready_by = $2'
    + ' WHERE ticket_id = $1 AND sent_at IS NOT NULL AND ready_at IS NULL', [id, ctx.actor]);
  await c.query("UPDATE kds_ticket SET stage = 'Served', served_at = now(),"
    + ' bumped_by = $2 WHERE ticket_id = $1 AND served_at IS NULL', [id, ctx.actor]);
  const rung = await setRung(c, id, await rungFromPass(c, id), ctx);
  return { ticketId: id, bumped: q.rowCount, stage: rung };
};

// A bump undone. The plate goes back on the screen and the order goes back to
// the kitchen, because the guest was told Ready and it was not.
H.kds_recall = async (c, p, ctx) => {
  const id = await ticketRef(c, p);
  if (!id) return { skipped: 'no open ticket' };
  const ids = await linesOf(c, id, p);
  const q = await c.query('UPDATE ticket_line SET ready_at = NULL, ready_by = NULL'
    + ' WHERE ticket_id = $1 AND ready_at IS NOT NULL' + (ids ? ' AND id = ANY($2)' : ''),
  ids ? [id, ids] : [id]);
  await c.query("UPDATE kds_ticket SET stage = 'Recalled', served_at = NULL,"
    + ' ready_at = NULL, bumped_by = $2 WHERE ticket_id = $1', [id, ctx.actor]);
  const rung = await setRung(c, id, await rungFromPass(c, id), ctx);
  await log(c, 'kds_recall', 'ticket', id, null, { lines: q.rowCount });
  return { ticketId: id, recalled: q.rowCount, stage: rung };
};

H.kds_station = async (c, p) => {
  await c.query('UPDATE kds_ticket SET station = $2 WHERE id = $1', [p.id, p.station]);
  return { ok: true };
};

// ═══ RESERVATIONS AND GUESTS ═══════════════════════════════════════════════
H.reservation_insert = async (c, p, ctx) => {
  const q = await one(c, 'INSERT INTO reservation (guest_name, phone, member_id, party,'
    + ' at, duration_mins, zone_id, table_no, note, made_by) VALUES'
    + ' ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
    [p.name, p.phone || null, p.member || null, Math.max(1, num(p.party) || 1),
      new Date(p.at), num(p.mins) || 90, p.zone || null, p.table || null,
      p.note || null, ctx.actor]);
  return { reservationId: q.id };
};
H.reservation_ = async (c, p) => {
  await c.query('UPDATE reservation SET status = $2 WHERE id = $1',
    [p.id, p.status || 'confirmed']);
  return { ok: true };
};

// A booking's guest name, phone and kitchen note arrive on the ticket without
// anyone re-keying them. That is the whole point of holding the booking.
H.seat_reservation = async (c, p, ctx) => {
  const rv = await one(c, 'SELECT * FROM reservation WHERE id = $1', [p.id]);
  if (!rv) return { skipped: 'no such reservation' };
  const t = await openTicket(c, ctx, {
    table: p.table || rv.table_no, split: 0, party: rv.party,
    server: p.server, member: rv.member_id, note: rv.note,
    guests: [{ name: rv.guest_name, type: 'reservation', phone: rv.phone }]
  });
  await c.query("UPDATE reservation SET status = 'seated', seated_at = now(),"
    + ' seated_by = $2, ticket_id = $3, table_no = $4 WHERE id = $1',
  [p.id, ctx.actor, t.id, p.table || rv.table_no]);
  return { ticketId: t.id };
};

H.seat_walkin = async (c, p, ctx) => {
  const t = await openTicket(c, ctx, {
    table: p.table, split: num(p.split), party: num(p.party) || 1,
    server: p.server, channel: p.channel
  });
  return { ticketId: t.id };
};

H.qr_order = async (c, p, ctx) => {
  await c.query('UPDATE guest_order SET accepted_at = now(), accepted_by = $2,'
    + ' ticket_id = $3, rejected_reason = $4 WHERE id = $1 AND accepted_at IS NULL',
    [p.id, ctx.actor, p.ticketId || null, p.reject || null]);
  return { ok: true };
};
H.qr_pay_intent = async (c, p, ctx) => {
  await log(c, 'qr_pay_intent', 'guest_order', p.id, null, { amount: r2(p.amt) });
  return { ok: true };
};
H.flag_ack = async (c, p, ctx) => {
  await c.query('UPDATE guest_request SET ack_at = now(), ack_by = $2 WHERE id = $1',
    [p.id, ctx.actor]);
  return { ok: true };
};

// ═══ THE CUSTOMER ══════════════════════════════════════════════════════════
// A member is born at the counter: a waiter takes a name and a number. Until
// this existed the till's "Add customer" form queued a kind with no handler and
// no payload, so `applyOp` recorded it as unmodelled and returned success —
// the toast said the customer was created, the row lived in one browser's
// local overrides, and `chain.member` stayed empty for ever. Which meant
// nobody could ever sign in to the member portal, because the code function
// only updates a member who already exists.
//
// Keyed on the phone, which is UNIQUE and is what the guest types to sign in.
// The upsert is what makes it idempotent under replay: the same customer sent
// twice is one customer, not a duplicate-key failure that aborts the batch.
//
// Points are NOT settable here. They are awarded by the outlet from its own
// earn rate, and a terminal that could post them could mint them.
/* THE ROW THE TILL IS EDITING, when it knows which one. This keyed on phone
   alone, and `ON CONFLICT (phone)` meant correcting a mistyped number did not
   rename the customer — it CREATED A SECOND ONE and left the first behind,
   with the visits, the points and the credit balance on whichever of the two
   the next sale happened to reach. The screen said "updated".

   The phone is still the identity and still unique. It is now changeable by a
   till that names the row it means, and refused BY NAME when the new number is
   already somebody else's — because two customers cannot share a number any
   more than they can share an address. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

H.member_upsert = async (c, p, ctx) => {
  const phone = String(p.phone || '').trim();
  if (!phone) return { skipped: 'a member is named by phone number' };
  // An email is a SECOND way into a card (migration 018), so it is unique and
  // the refusal has to name the customer already holding it. The index would
  // refuse this anyway; a bare 23505 tells a waiter nothing they can act on,
  // and the address they typed is almost always a typo for their own.
  // Lower-cased on the way in, because that is how it is read on the way out:
  // both sign-in functions resolve with `lower(email)`, and so does the unique
  // index. Storing the shift key a waiter happened to be holding would leave
  // the record and the lookup that uses it spelling the address differently.
  const email = String(p.email || '').trim().toLowerCase() || null;
  if (email) {
    const taken = await c.query('SELECT name, phone FROM chain.member'
      + ' WHERE lower(email) = lower($1) AND phone <> $2', [email, phone]);
    if (taken.rows.length) {
      const t = taken.rows[0];
      return { refused: email + ' is already on ' + (t.name || t.phone)
        + '\u2019s record \u2014 an address can only sign one customer in' };
    }
  }
  // A row the outlet already issued an id for is EDITED, never re-inserted.
  // Ids the till made up for itself (a customer created offline) are not uuids
  // and fall through to the upsert below, which is what creates them.
  const id = String(p.id || '').trim();
  if (id && UUID.test(id)) {
    const mine = await c.query('SELECT id FROM chain.member WHERE id = $1', [id]);
    if (mine.rows.length) {
      const clash = await c.query('SELECT name, phone FROM chain.member'
        + ' WHERE phone = $1 AND id <> $2', [phone, id]);
      if (clash.rows.length) {
        const t = clash.rows[0];
        return { refused: phone + ' is already ' + (t.name || 'another customer')
          + '\u2019s number \u2014 two customers cannot share one' };
      }
      // No tier: it is derived from points against the published ladder every
      // time it is asked for (migration 019), so a till sending one would be
      // sending a figure nothing reads and everything disagrees with.
      const u = await one(c, 'UPDATE chain.member SET phone = $2,'
        + ' name = coalesce($3, name), email = $4,'
        + ' credit_limit = $5, notes = coalesce($6, notes)'
        + ' WHERE id = $1 RETURNING id', [id, phone, p.name || null, email,
        num(p.credit), p.note || null]);
      await log(c, 'member_upsert', 'member', u.id, null,
        { phone: phone, created: false });
      return { memberId: u.id, created: false };
    }
  }

  const q = await one(c, 'INSERT INTO chain.member (phone, name, email,'
    + ' credit_limit, home_outlet, notes) VALUES ($1,$2,$3,$4,$5,$6)'
    + ' ON CONFLICT (phone) DO UPDATE SET'
    + '   name = coalesce(excluded.name, chain.member.name),'
    + '   email = coalesce(nullif(excluded.email, $7), chain.member.email),'
    + '   credit_limit = excluded.credit_limit,'
    + '   notes = coalesce(nullif(excluded.notes, $7), chain.member.notes)'
    + ' RETURNING id, (xmax = 0) AS created',
  [phone, p.name || null, email,
    num(p.credit), ctx.outletId, p.note || null, '']);
  await log(c, 'member_upsert', 'member', q.id, null,
    { phone: phone, created: q.created });
  return { memberId: q.id, created: q.created };
};

H.loyalty_update = async (c, p, ctx) => {
  if (p.member && p.points != null) {
    // Points move; the tier follows from them wherever it is read. It used to
    // be written here too, which is how a member could hold a tier their
    // balance had not earned and nobody could say which was right.
    const before = await one(c, 'SELECT points FROM chain.member WHERE id = $1',
      [p.member]);
    const after = await one(c, 'UPDATE chain.member SET points = greatest(0, points + $2)'
      + ' WHERE id = $1 RETURNING points', [p.member, num(p.points)]);
    /* AND THE LIABILITY MOVES WITH THEM. 2350 is what the outstanding points
       are WORTH, and it used to be fed by the sale path alone: a manager
       granting a goodwill hundred points, or docking a disputed award, changed
       what the business owes its customers and left the account saying
       otherwise. 2350 could only tie to the member balances as long as nobody
       used this screen — which is not a guarantee, it is a hope.

       Booked at the same published redemption rate the sale path accrues at,
       and by the same clamp: `greatest(0, ...)` means the points actually
       moved are not always the points asked for, so the accrual follows the
       BALANCE, never the request. */
    const moved = Math.trunc(num(after && after.points)) - Math.trunc(num(before && before.points));
    if (moved !== 0) {
      const cfg = await c.query("SELECT value FROM chain.setting WHERE key = 'loyalty'");
      const v = (cfg.rows[0] || {}).value || {};
      const worth = r2(Math.abs(moved) / (Number(v.redeemPts) || 100)
        * (Number(v.redeemValue) || 25));
      if (worth > 0) {
        await postJournal(c, ctx, moved > 0
          ? [{ acct: '6550', dr: worth, memo: 'Points granted by hand' },
            { acct: '2350', cr: worth }]
          : [{ acct: '2350', dr: worth, memo: 'Points withdrawn by hand' },
            { acct: '6550', cr: worth }],
        'loyalty', p.member, today(ctx),
        'Points adjusted by hand \u00b7 ' + (moved > 0 ? '+' : '') + moved);
      }
      await log(c, 'points_adjusted', 'member', p.member,
        { points: Math.trunc(num(before && before.points)) },
        { points: Math.trunc(num(after && after.points)), moved, worth, why: p.why || null });
    }
  }
  if (p.rules) await setSetting(c, ctx, 'loyalty_rules', p.rules);
  return { ok: true };
};
H.earn_rate = async (c, p, ctx) => setSetting(c, ctx, 'loyalty_earn', p);

/* ═══ THE PROGRAMME IS THE OUTLET'S, NOT ONE BROWSER'S ═══════════════════
   The bootstrap has always published `TIERS` and `REWARDS` from chain.setting
   and NOTHING has ever written either, so every store on every install read
   the shipped ladder and an empty catalogue for ever. The till filled the gap
   with a hard-coded programme of its own — four demo rewards carrying invented
   redemption counts, and a second tier ladder disagreeing with the published
   one — and its editors wrote a local object no other terminal could see.

   Same three-source shape a measured yield and a saved batch already follow:
   the outlet's answer is the answer, this terminal's un-synced edit is a
   holding pen, and the shipped figures are the estimate underneath. This is
   the write that empties the pen.

   chain.setting, not the outlet's own — the ladder, the catalogue and what a
   point is worth are chain-wide, which is the same reason chain.member holds
   the points. Its RLS policy requires rank 4: a programme any manager can
   re-price is not a programme, and the till gates the same rung. */
H.loyalty_programme = async (c, p, ctx) => {
  const wrote = [];
  const put = async (key, value) => {
    await c.query('INSERT INTO chain.setting (key, value) VALUES ($1, $2)'
      + ' ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
    wrote.push(key);
  };
  if (p.rates) {
    // Every rate above zero, or a point is worth nothing and the catalogue
    // prices itself at nothing with it.
    const e = Number(p.rates.pointsPer), q = Number(p.rates.redeemPts), w = Number(p.rates.redeemValue);
    if (!(e > 0 && q > 0 && w > 0)) return { skipped: 'a rate at or below zero is not a programme' };
    await put('loyalty', { pointsPer: e, redeemPts: q, redeemValue: w, live: p.rates.live !== false });
  }
  if (Array.isArray(p.tiers)) {
    const tiers = p.tiers.slice(0, 8)
      .map((t) => ({ key: String(t.key || t.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '') || null,
        name: String(t.name || '').slice(0, 40), at: Math.max(0, Math.trunc(Number(t.at) || 0)),
        spend: Math.max(0, Number(t.spend) || 0), perk: String(t.perk || '').slice(0, 120),
        mark: String(t.mark || '').slice(0, 4), from: t.from || null, to: t.to || null }))
      .filter((t) => t.key && t.name)
      .sort((a, b) => a.at - b.at);
    if (!tiers.length) return { skipped: 'a ladder with no rungs is not a ladder' };
    await put('tiers', tiers);
  }
  if (Array.isArray(p.rewards)) {
    await put('rewards', p.rewards.slice(0, 40).map((r) => ({
      id: String(r.id || '').slice(0, 40) || null, name: String(r.name || '').slice(0, 80),
      cost: Math.max(1, Math.trunc(Number(r.cost) || 0)), tier: String(r.tier || '').slice(0, 40),
      active: r.active !== false
    })).filter((r) => r.id && r.name));
  }
  if (!wrote.length) return { skipped: 'nothing to change' };
  await log(c, 'loyalty_programme', 'setting', wrote.join(','), null, { wrote: wrote });
  return { ok: true, wrote: wrote };
};
H.settle_credit = async (c, p, ctx) => {
  const amt = r2(p.amt);
  if (!(amt > 0)) return { skipped: 'a settlement needs an amount' };
  // The tender's OWN account: cash to the drawer, card to the card
  // receivable, anything else to the bank. Card settlements used to land in
  // 1020 directly, as if the acquirer paid instantly and free.
  const acct = p.method === 'cash' ? '1010' : p.method === 'card' ? '1030' : '1020';
  await postJournal(c, ctx, [
    { acct: acct, dr: amt, memo: 'Credit settled' + (p.ref ? ' · ' + p.ref : '') },
    { acct: '1040', cr: amt }
  ], 'credit', p.member, today(ctx), 'Customer credit settled');
  // The outstanding balance falls by what was paid, floored at zero — a
  // settlement can never drive the account into credit the customer is owed.
  if (p.member) {
    await c.query('UPDATE chain.member SET credit_used = greatest(0, credit_used - $2)'
      + ' WHERE id = $1', [p.member, amt]);
  }
  await log(c, 'settle_credit', 'member', p.member, null,
    { amt, method: p.method || 'transfer', ref: p.ref || null });
  return { ok: true };
};

// ═══ PRINT AND DEVICES ═════════════════════════════════════════════════════
H.print_job = async (c, p, ctx) => {
  const q = await one(c, 'INSERT INTO print_job (kind, target, label, meta, by_staff,'
    + ' device_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [p.kind || 'receipt', p.target || 'counter', p.label || '',
      JSON.stringify(p.meta || {}), ctx.actor, ctx.deviceId]);
  return { jobId: q.id };
};
H.print_retry = async (c, p) => {
  await c.query("UPDATE print_job SET state = 'queued', tries = tries + 1 WHERE id = $1",
    [p.id]);
  return { ok: true };
};
H.print_failed = async (c, p) => {
  await c.query("UPDATE print_job SET state = 'failed', tries = tries + 1 WHERE id = $1",
    [p.id]);
  return { ok: true };
};
H.print_abandoned = async (c, p) => {
  await c.query("UPDATE print_job SET state = 'abandoned' WHERE id = $1", [p.id]);
  return { ok: true };
};
H.printer_state = async (c, p, ctx) => setSetting(c, ctx, 'printers', p.printers || p);
H.pair_kds = async (c, p, ctx) => {
  await c.query('UPDATE chain.device SET station = $2, paired_at = now(),'
    + ' pair_code = NULL WHERE id = $1 AND outlet_id = $3',
    [p.id, p.station || 'main', ctx.outletId]);
  return { ok: true };
};

// ═══ CONFIGURATION ═════════════════════════════════════════════════════════
H.setting_change = async (c, p, ctx) => setSetting(c, ctx, p.key, p.value);
H.terminal_update = async (c, p, ctx) => setSetting(c, ctx, 'terminal', p);
H.brand_update = async (c, p, ctx) => {
  await c.query("UPDATE chain.company SET brand = coalesce(brand,'{}'::jsonb) || $1::jsonb,"
    + ' updated_at = now() WHERE id = 1', [JSON.stringify(p.brand || p)]);
  await log(c, 'brand_update', 'company', '1', null, p.brand || p);
  return { ok: true };
};
H.company_update = async (c, p, ctx) => {
  await c.query('UPDATE chain.company SET legal_name = coalesce($1, legal_name),'
    + ' reg_no = coalesce($2, reg_no), tin = coalesce($3, tin),'
    + ' address = coalesce($4, address), phone = $5, email = $6, updated_at = now()'
    + ' WHERE id = 1',
    [p.name || null, p.regNo || null, p.tin || null, p.hq || p.address || null,
      p.phone || null, p.email || null]);
  await log(c, 'company_update', 'company', '1', null, p);
  return { ok: true };
};
H.chain_update = H.company_update;

H.outlet_update = async (c, p, ctx) => {
  await c.query('UPDATE chain.outlet SET name = coalesce($2, name),'
    + ' service_pct = coalesce($3, service_pct), address = coalesce($4, address),'
    + ' phone = coalesce($5, phone), day_start = coalesce($6, day_start),'
    + ' active = coalesce($7, active) WHERE id = $1',
    [ctx.outletId, p.name || null, p.sc == null ? null : num(p.sc),
      p.addr || null, p.phone || null, p.dayStart || null,
      p.active == null ? null : !!p.active]);
  await log(c, 'outlet_update', 'outlet', String(ctx.outletId), null, p);
  return { ok: true };
};

H.location_upsert = async (c, p) => {
  await c.query('INSERT INTO location (id, name, kind) VALUES ($1,$2,$3)'
    + ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind',
    [p.id || slug(p.name), p.name, p.kind || 'store']);
  return { ok: true };
};

H.employee_upsert = async (c, p) => {
  await c.query('INSERT INTO employee (id, staff_id, name, job, kind, basic, hourly,'
    + ' joined_on, mrps, ot, svc, emp_type, phone, id_no)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,false),coalesce($10,true),'
    + ' coalesce($11,true),$12,$13,$14) ON CONFLICT (id) DO UPDATE SET'
    + ' name = excluded.name, job = excluded.job, kind = excluded.kind,'
    + ' basic = excluded.basic, hourly = excluded.hourly, mrps = excluded.mrps,'
    + ' ot = excluded.ot, svc = excluded.svc, emp_type = excluded.emp_type',
    [p.id || slug(p.name), p.staffId || null, p.name, p.job || '', p.kind || 'local',
      r2(p.basic), r2(p.hourly), p.joined || null, p.mrps, p.ot, p.svc,
      p.type || 'fulltime', p.phone || null, p.idNo || null]);
  return { ok: true };
};
H.staffedit = H.employee_upsert;

// ═══ AUDIT-ONLY KINDS ══════════════════════════════════════════════════════
// These change nothing in a table; the record IS the point. They are listed
// explicitly rather than swept into the default so that "not modelled yet" and
// "deliberately audit-only" stay distinguishable.
const AUDIT_ONLY = [
  'access_change', 'act_as', 'auto_lock', 'backup_create', 'backup_run',
  'cfo_query', 'device_deregister', 'device_diagnostics', 'device_lock',
  'device_paired', 'device_replay', 'grn_query', 'outlet_switch_denied',
  // The rename itself happened over HTTP, at rank 5, behind a refusal the
  // operator saw. What reaches the outbox is the record of it.
  'outlet_handle_change',
  // Same for registering, or coming off the register: the consequence lands in
  // chain.company and every outlet's rate history inside one transaction, and
  // this is the record that it was asked for.
  'gst_registration',
  // A device giving up on a parked op is a decision worth a permanent record:
  // WHAT was discarded, WHY the server refused it, and WHO decided. The op it
  // names was never applied — that is the point — so there is nothing to undo.
  'op_discarded',
  /* A discount's CONSEQUENCE rides on the sale — `disc` is a column on it, and
     the journal's discount leg is derived from that. These two are the moment
     it was applied and the moment it was taken off again, which is what a
     manager asking "who discounted table six, and when" needs and the sale row
     cannot say. Audit-only by design, and now by declaration: they were
     invisible to the contract test until it learned to read a ternary. */
  'discount_applied', 'discount_cleared',
  /* A guest asking for the bill is already a row in guest_request, and a member
     arriving at the counter is already in the portal's own trail. These record
     that THIS TERMINAL announced it to the floor — which is the fact a shift
     dispute turns on, and a fact no other row holds. Acknowledging the request
     is a separate op with a separate consequence. */
  'guest_signal', 'member_signal',
  'password_reset', 'permission_change', 'permission_reset', 'pin_failed',
  'pin_lockout', 'pin_reset', 'restore_run', 'revoke_sessions', 'sign_in',
  'sign_in_refused', 'sign_out', 'stock_query', 'store_reset', 'vendor_query',
  'void_refused'
];
AUDIT_ONLY.forEach((k) => {
  H[k] = async (c, p, ctx) => {
    await log(c, k, p && p.entity ? p.entity : null,
      p && p.id ? String(p.id) : null, null, p || null);
    return { audited: true };
  };
});

/* Where a tender LANDS. One definition, because a sale and the credit note
   that reverses it must debit and credit the same account or the receivable
   never clears.

   `qr` used to fall through to 1010 Cash — a hosted-gateway payment counted as
   money in the drawer, so the drawer read a surplus that was never there and
   the gateway's receivable was never raised at all. Transfer fell the same way
   on the refund side. Anything an intermediary is holding is a receivable
   until they pay it:

     cash                    1010  in the drawer, now
     card · wallet · qr      1030  card settlement receivable
     transfer                1020  bank, no intermediary
     credit                  1040  customer credit receivable                */
function tenderAccount(method) {
  const m = String(method || 'cash');
  if (m === 'card' || m === 'wallet' || m === 'qr') return '1030';
  if (m === 'credit') return '1040';
  if (m === 'transfer') return '1020';
  return '1010';
}

/* ── plumbing ───────────────────────────────────────────────────────────── */

async function one(c, sql, params) {
  const q = await c.query(sql, params || []);
  return q.rows[0] || null;
}

function log(c, action, entity, id, before, after) {
  return c.query('SELECT chain.log($1,$2,$3,$4,$5)',
    [action, entity, id == null ? null : String(id),
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

async function setSetting(c, ctx, key, value) {
  await c.query('INSERT INTO setting (key, value, updated_by) VALUES ($1,$2,$3)'
    + ' ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(),'
    + ' updated_by = excluded.updated_by',
    [String(key), JSON.stringify(value == null ? null : value), ctx.actor]);
  await log(c, 'setting_change', 'setting', key, null, { key });
  return { ok: true };
}

// A closed ticket is never reopened by a late replay.
async function ticketFor(c, ctx, p) {
  if (p.ticketId) {
    const t = await one(c, "SELECT id FROM ticket WHERE id = $1 AND status <> 'closed'",
      [p.ticketId]);
    return t;
  }
  return openTicket(c, ctx, p);
}

async function openTicket(c, ctx, p) {
  const table = p.table == null ? null : String(p.table);
  const split = num(p.split);
  if (table) {
    const has = await one(c, "SELECT id FROM ticket WHERE table_no = $1 AND split = $2"
      + " AND status = 'open'", [table, split]);
    if (has) {
      if (p.party) {
        await c.query('UPDATE ticket SET party = greatest(party, $2),'
          + ' covers = greatest(covers, $2) WHERE id = $1', [has.id, num(p.party)]);
      }
      return has;
    }
  }
  return one(c, 'INSERT INTO ticket (table_no, split, channel, covers, party,'
    + ' business_date, opened_by, device_id, server_name, member_id, note, guests)'
    + ' VALUES ($1,$2,$3,$4,$5, coalesce($6, current_date), $7,$8,$9,$10,$11,$12)'
    + ' RETURNING id',
  [table, split, p.channel || 'dine_in', Math.max(1, num(p.party) || 1),
    num(p.party), p.bizDate || null, ctx.actor, ctx.deviceId, p.server || null,
    p.member || null, p.note || null, JSON.stringify(p.guests || [])]);
}

/* The outlet's local date, never UTC. `toISOString()` here filed every
   document after 19:00 Malé time under yesterday — the single highest-blast-
   radius defect in the build, because a business date is what a GST return,
   a Z read and a document series are all keyed by.

   `ctx.tz` is stamped by `setContext`, which is also what the transaction's
   own `current_date` is set to, so the two clocks cannot drift apart. en-CA
   because it formats as YYYY-MM-DD, which is the shape every column wants. */
function today(ctx) {
  const tz = (ctx && ctx.tz) || 'Indian/Maldives';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
}
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 40) || 'x' + Date.now().toString(36);
}

/* ── the entry point ────────────────────────────────────────────────────── */
async function applyOp(c, op, ctx) {
  const fn = H[op.kind];
  if (!fn) return { recorded: true, unmodelled: op.kind };
  return fn(c, op.payload || {}, ctx) || {};
}

module.exports = { applyOp, postJournal, moveStock, publishDeclaration,
  // Exported so a test can run the server's expansion against the TILL's,
  // on the same outlet, and prove the two cannot drift apart.
  deriveConsumption, quantityGap,
  // ONE day-key. The bootstrap needs the outlet's own date to say how many
  // days are left on a trial, and a second copy of this would be a second
  // answer to "what day is it here" — which is the defect migration 016 was
  // written to end.
  today,
  HANDLERS: H, AUDIT_ONLY };
