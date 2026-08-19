'use strict';
/* Vouchers — 04-MEMBER-PORTAL-SPEC.md §5: "Redeeming creates a voucher the till
 * can accept; it does not discount anything on the phone."
 *
 * THE TILL HALF OF THE PROMISE. A member turns points into a voucher on their
 * phone and walks in holding a code; if nothing at the counter takes it, the
 * points are gone and the scheme has quietly stolen from them. So a voucher is
 * a TENDER — the cashier types the code where they would type a card — and it
 * settles against 2200 exactly as the points tender does.
 *
 * REDEEMING POSTED NOTHING, AND THAT IS WHY THIS DOES. Points are a liability
 * from the moment they are earned. Turning them into a voucher changes the
 * shape of the promise, not whether it is owed, so no journal is written then;
 * the liability is released here, when the voucher is actually taken against a
 * bill. Posting at redemption instead would release a liability the business
 * still owes, and a member with a drawer full of unspent vouchers would appear
 * to have been paid.
 *
 * ONE VOUCHER, ONE BILL. The row is claimed with the guard in the WHERE clause
 * rather than in a read-then-write, so two terminals presented with the same
 * code at the same moment cannot both take it.
 */

const money = (n) => Math.round(Number(n) * 100) / 100;
const toLaari = (mvr) => Math.round(Number(mvr) * 100);

const clean = (code) => String(code || '').trim().toUpperCase().replace(/\s+/g, '');

/** What a code is worth, and whether it can be taken at all. Read-only. */
async function look(c, code) {
  const q = await c.query(
    'SELECT v.*, m.name AS member_name FROM chain.voucher v'
    + ' LEFT JOIN chain.member m ON m.id = v.member_id WHERE v.code = $1', [clean(code)]);
  if (!q.rows.length) {
    throw Object.assign(new Error('no voucher with that code'), { status: 404 });
  }
  const v = q.rows[0];
  const expired = v.expires_at && new Date(v.expires_at) < new Date();
  return {
    code: v.code, name: v.name, value: money(v.value), points: Number(v.points),
    member: v.member_name || null, memberId: v.member_id,
    issuedAt: v.issued_at, expiresAt: v.expires_at,
    redeemedAt: v.redeemed_at,
    /* Three states, not one boolean: "already used" and "expired" send a
       cashier to two different conversations. */
    state: v.redeemed_at ? 'used' : expired ? 'expired' : 'ready',
    usable: !v.redeemed_at && !expired,
  };
}

/**
 * Check before the sale exists, for the same reason a house charge is checked
 * first: a refusal afterwards is a receipt for a settlement that did not
 * happen.
 */
async function check(c, code, amountL) {
  const v = await look(c, code);
  if (v.state === 'used') {
    throw Object.assign(new Error('that voucher has already been used'), { status: 409 });
  }
  if (v.state === 'expired') {
    throw Object.assign(new Error('that voucher expired on '
      + String(v.expiresAt).slice(0, 10)), { status: 409 });
  }
  if (amountL > toLaari(v.value)) {
    throw Object.assign(new Error('that voucher is worth ' + v.value.toFixed(2)
      + ' — it cannot cover ' + (amountL / 100).toFixed(2)), { status: 409 });
  }
  return v;
}

/**
 * Take it. Claimed with the guard in the WHERE clause so two terminals cannot
 * both succeed, and NOT reversible here — a voucher taken in error is a matter
 * for a refund, which has its own document and its own approval.
 */
async function take(c, code, saleId, ctx) {
  const q = await c.query(
    'UPDATE chain.voucher SET redeemed_at = now(), redeemed_outlet = $2,'
    + ' redeemed_sale = $3 WHERE code = $1 AND redeemed_at IS NULL RETURNING *',
    [clean(code), ctx.outletId, saleId]);
  if (!q.rows.length) {
    throw Object.assign(new Error('that voucher has already been used'), { status: 409 });
  }
  await c.query("SELECT chain.log('voucher_taken','voucher',$1,NULL,$2)",
    [q.rows[0].id, JSON.stringify({ code: clean(code), value: q.rows[0].value, saleId })]);
  return { code: clean(code), value: money(q.rows[0].value) };
}

module.exports = { look, check, take, clean };
