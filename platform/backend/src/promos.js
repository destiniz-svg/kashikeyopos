'use strict';
/* Promotions — 02-POS-SPEC.md §2 (`promos`): "Codes, windows, caps. A promo the
 * guest sees is a promo the till charges." 08-BUILD-STAGES §16, whose
 * acceptance criterion is the whole design brief: "A promo quoted on the phone
 * is charged by the till, or refused with a reason — never quoted and then
 * silently dropped."
 *
 * SO THERE IS ONE EVALUATOR AND BOTH SIDES CALL IT. `quote()` is the only place
 * that decides what a code is worth, and it runs on the server for the phone
 * and for the till alike. The phone asking "what is SAVE20 worth on this
 * basket?" and the till settling that same basket get the same answer because
 * it is the same function reading the same row — not two implementations that
 * agree today. This build has already learned that lesson expensively once: see
 * packages/money, where three hand-written copies of the bill calculation
 * charged GST-exclusive at the counter for months with a green test suite.
 *
 * A REFUSAL ALWAYS CARRIES A REASON. "Not valid" is the answer that makes a
 * guest argue with a cashier who also cannot see why. Expired, wrong day, too
 * early, under the minimum, used up, members only, already used — each is a
 * different sentence, and the phone shows the same one the till would.
 *
 * NOTHING HERE TOUCHES MONEY DIRECTLY. It returns a discount in laari and the
 * caller applies it through the ONE bill calculation, so a promo cannot invent
 * an arithmetic of its own.
 */

const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const money = (n) => Math.round(Number(n) * 100) / 100;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (min) =>
  String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

/* ── the one evaluator ───────────────────────────────────────────────────── */

/**
 * What is this code worth on this basket, right now?
 *
 * p = { code, goodsLaari, memberId?, at? }
 * → { ok: true, promoId, code, name, discount (laari), … }
 * → { ok: false, reason }   ← always a sentence, never a boolean
 *
 * `goodsLaari` is the goods NET of tax and service — the same figure the bill
 * calculation discounts — so a promo can never quietly come off the tax.
 */
async function quote(c, p) {
  const code = String(p.code || '').trim().toUpperCase();
  if (!code) return { ok: false, reason: 'no code' };

  const q = await c.query('SELECT * FROM chain.promo WHERE code = $1', [code]);
  if (!q.rows.length) return { ok: false, reason: 'No promotion with that code.' };
  const r = q.rows[0];
  if (!r.active) return { ok: false, reason: 'That promotion has been stopped.' };

  const at = p.at ? new Date(p.at) : new Date();
  const day = at.toISOString().slice(0, 10);

  if (r.starts_on && day < r.starts_on.toISOString().slice(0, 10)) {
    return { ok: false, reason: 'That promotion has not started yet.' };
  }
  if (r.ends_on && day > r.ends_on.toISOString().slice(0, 10)) {
    return { ok: false, reason: 'That promotion has ended.' };
  }
  if (r.days && r.days.length && !r.days.includes(at.getUTCDay())) {
    return {
      ok: false,
      reason: 'That one runs on ' + r.days.map((d) => DAYS[d]).join(', ') + '.',
    };
  }
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  if (r.from_min !== null && r.to_min !== null
      && (minutes < r.from_min || minutes >= r.to_min)) {
    return {
      ok: false,
      reason: 'That one runs between ' + hhmm(r.from_min) + ' and ' + hhmm(r.to_min) + '.',
    };
  }

  if (r.members_only && !p.memberId) {
    return { ok: false, reason: 'That one is for members. Add the customer first.' };
  }

  const goods = Number(p.goodsLaari) || 0;
  const min = toLaari(r.min_spend);
  if (min > 0 && goods < min) {
    return {
      ok: false,
      reason: 'Spend ' + toMVR(min) + ' to use that one — this is ' + toMVR(goods) + '.',
    };
  }

  /* The caps are counted from the USE LEDGER, which is append-only. A counter
     column would drift the first time a sale failed after incrementing it. */
  if (r.max_uses !== null) {
    const used = await c.query(
      'SELECT count(*)::int AS n FROM chain.promo_use WHERE promo_id = $1', [r.id]);
    if (used.rows[0].n >= r.max_uses) {
      return { ok: false, reason: 'That promotion has been fully used.' };
    }
  }
  if (r.max_per_member !== null) {
    if (!p.memberId) {
      return { ok: false, reason: 'That one is limited per customer. Add the customer first.' };
    }
    const mine = await c.query(
      'SELECT count(*)::int AS n FROM chain.promo_use WHERE promo_id = $1 AND member_id = $2',
      [r.id, p.memberId]);
    if (mine.rows[0].n >= r.max_per_member) {
      return {
        ok: false,
        reason: r.max_per_member === 1
          ? 'They have used that one already.'
          : 'They have used that one ' + r.max_per_member + ' times already.',
      };
    }
  }

  /* Rounded once, here, from the goods figure itself. */
  let discount = r.kind === 'percent'
    ? Math.round(goods * Number(r.value) / 100)
    : toLaari(r.value);

  let capped = false;
  if (r.max_discount !== null && discount > toLaari(r.max_discount)) {
    discount = toLaari(r.max_discount);
    capped = true;
  }
  /* A discount can never exceed the goods. Without this, a 500 amount-off code
     on a 300 basket makes a negative bill and the guest is owed money for
     turning up. */
  if (discount > goods) { discount = goods; capped = true; }
  if (discount <= 0) return { ok: false, reason: 'That comes to nothing on this bill.' };

  return {
    ok: true,
    promoId: r.id, code: r.code, name: r.name,
    kind: r.kind, value: money(r.value),
    discount,
    discountMvr: money(discount / 100),
    capped,
    /* Said plainly when the cap bit, because "20% off" and 50.00 off a 400 bill
       are different promises and the guest was shown the first one. */
    note: capped && r.max_discount !== null
      ? 'Capped at ' + toMVR(toLaari(r.max_discount)) + '.' : undefined,
  };
}

/** Record that it was honoured. Called by the sale, once the sale exists. */
async function record(c, p, ctx) {
  await c.query(
    'INSERT INTO chain.promo_use (promo_id, outlet_id, member_id, sale_id, amount,'
    + ' by_staff) VALUES ($1,$2,$3,$4,$5,$6)',
    [p.promoId, ctx.outletId, p.memberId || null, p.saleId || null,
      toMVR(p.discount), ctx.actor]);
}

/* ── the back office ─────────────────────────────────────────────────────── */

async function list(c) {
  const q = await c.query(
    'SELECT p.*, o.name AS outlet,'
    + '  (SELECT count(*)::int FROM chain.promo_use u WHERE u.promo_id = p.id) AS uses,'
    + '  (SELECT coalesce(sum(u.amount),0) FROM chain.promo_use u WHERE u.promo_id = p.id)'
    + '    AS given'
    + ' FROM chain.promo p LEFT JOIN chain.outlet o ON o.id = p.outlet_id'
    + ' ORDER BY p.active DESC, p.set_at DESC LIMIT 300');

  const today = new Date().toISOString().slice(0, 10);
  const rows = q.rows.map((r) => {
    const starts = r.starts_on ? r.starts_on.toISOString().slice(0, 10) : null;
    const ends = r.ends_on ? r.ends_on.toISOString().slice(0, 10) : null;
    const usedUp = r.max_uses !== null && Number(r.uses) >= r.max_uses;
    return {
      id: r.id, code: r.code, name: r.name, kind: r.kind, value: money(r.value),
      minSpend: money(r.min_spend),
      maxDiscount: r.max_discount === null ? null : money(r.max_discount),
      maxUses: r.max_uses, maxPerMember: r.max_per_member,
      startsOn: starts, endsOn: ends, days: r.days || [],
      fromMin: r.from_min, toMin: r.to_min,
      outlet: r.outlet || null, outletId: r.outlet_id,
      membersOnly: r.members_only, active: r.active,
      uses: Number(r.uses), given: money(r.given),
      /* Why it is not currently working, if it is not. A promo that quietly
         stopped applying three weeks ago is the thing an operator most needs
         told, and the thing a list of rows never says. */
      dormant: !r.active ? 'stopped'
        : usedUp ? 'fully used'
          : starts && today < starts ? 'starts ' + starts
            : ends && today > ends ? 'ended ' + ends
              : null,
    };
  });
  return {
    promos: rows,
    totals: {
      live: rows.filter((r) => r.active && !r.dormant).length,
      given: money(rows.reduce((s, r) => s + r.given, 0)),
      uses: rows.reduce((s, r) => s + r.uses, 0),
    },
  };
}

async function save(c, p, ctx) {
  const code = String(p.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,24}$/.test(code)) {
    throw Object.assign(new Error(
      'a code of 2 to 24 letters and digits — no spaces, so it survives being'
      + ' read out over a telephone'), { status: 400 });
  }
  const name = String(p.name || '').trim().slice(0, 80) || code;
  const kind = p.kind === 'amount' ? 'amount' : 'percent';
  const value = Number(p.value);
  if (!(value > 0)) throw Object.assign(new Error('what is it worth?'), { status: 400 });
  if (kind === 'percent' && value > 100) {
    throw Object.assign(new Error('a percentage above 100 is not a discount'), { status: 400 });
  }

  const days = Array.isArray(p.days)
    ? [...new Set(p.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [];
  const fromMin = p.fromMin === null || p.fromMin === undefined || p.fromMin === ''
    ? null : Number(p.fromMin);
  const toMin = p.toMin === null || p.toMin === undefined || p.toMin === ''
    ? null : Number(p.toMin);
  if ((fromMin === null) !== (toMin === null)) {
    throw Object.assign(new Error('a time window needs both ends'), { status: 400 });
  }
  if (fromMin !== null && !(fromMin >= 0 && toMin <= 1440 && fromMin < toMin)) {
    throw Object.assign(new Error('the window has to start before it ends'), { status: 400 });
  }
  if (p.startsOn && p.endsOn && String(p.startsOn) > String(p.endsOn)) {
    throw Object.assign(new Error('it cannot end before it starts'), { status: 400 });
  }

  const args = [
    code, name, kind, value,
    toMVR(toLaari(p.minSpend || 0)),
    p.maxDiscount ? toMVR(toLaari(p.maxDiscount)) : null,
    p.maxUses ? Number(p.maxUses) : null,
    p.maxPerMember ? Number(p.maxPerMember) : null,
    p.startsOn || null, p.endsOn || null, days, fromMin, toMin,
    p.outletId ? Number(p.outletId) : null,
    !!p.membersOnly, p.active !== false, ctx.actor,
  ];

  if (p.id) {
    const q = await c.query(
      'UPDATE chain.promo SET code=$1, name=$2, kind=$3, value=$4, min_spend=$5,'
      + ' max_discount=$6, max_uses=$7, max_per_member=$8, starts_on=$9, ends_on=$10,'
      + ' days=$11, from_min=$12, to_min=$13, outlet_id=$14, members_only=$15,'
      + ' active=$16, set_by=$17, set_at=now() WHERE id=$18 RETURNING id',
      [...args, p.id]);
    if (!q.rows.length) throw Object.assign(new Error('no such promotion'), { status: 404 });
    await c.query("SELECT chain.log('promo_save','promo',$1,NULL,$2)",
      [p.id, JSON.stringify({ code, kind, value })]);
    return { id: p.id, code };
  }

  const dup = await c.query('SELECT id FROM chain.promo WHERE code = $1', [code]);
  if (dup.rows.length) {
    throw Object.assign(new Error(code + ' is already a promotion.'), { status: 409 });
  }
  const q = await c.query(
    'INSERT INTO chain.promo (code, name, kind, value, min_spend, max_discount,'
    + ' max_uses, max_per_member, starts_on, ends_on, days, from_min, to_min,'
    + ' outlet_id, members_only, active, set_by)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11,$12,$13,$14,$15,$16,$17)'
    + ' RETURNING id', args);
  await c.query("SELECT chain.log('promo_add','promo',$1,NULL,$2)",
    [q.rows[0].id, JSON.stringify({ code, kind, value })]);
  return { id: q.rows[0].id, code };
}

async function stop(c, id, ctx) {
  const q = await c.query(
    'UPDATE chain.promo SET active = false WHERE id = $1 RETURNING id, code', [id]);
  if (!q.rows.length) throw Object.assign(new Error('no such promotion'), { status: 404 });
  await c.query("SELECT chain.log('promo_stop','promo',$1,NULL,NULL)", [id]);
  return { id, code: q.rows[0].code, active: false };
}

/** Where one promotion has actually been used. */
async function uses(c, id) {
  const q = await c.query(
    'SELECT u.*, o.name AS outlet, m.name AS member, m.phone, s.receipt_no'
    + ' FROM chain.promo_use u'
    + ' LEFT JOIN chain.outlet o ON o.id = u.outlet_id'
    + ' LEFT JOIN chain.member m ON m.id = u.member_id'
    + ' LEFT JOIN sale s ON s.id = u.sale_id'
    + ' WHERE u.promo_id = $1 ORDER BY u.at DESC LIMIT 200', [id]);
  return q.rows.map((r) => ({
    id: Number(r.id), at: r.at, amount: money(r.amount),
    outlet: r.outlet || 'another outlet',
    member: r.member || r.phone || null,
    docNo: r.receipt_no || null,
  }));
}

module.exports = { quote, record, list, save, stop, uses };
