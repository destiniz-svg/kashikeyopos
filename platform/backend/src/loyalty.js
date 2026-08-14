'use strict';
/* Loyalty & Rewards — 02-POS-SPEC.md §2 (`loyalty`): "Earn rate, tier ladder,
 * reward catalogue. Points are a liability (account 2200)."
 * 04-MEMBER-PORTAL-SPEC.md §6: "Points are a liability, not a discount.
 * Earning credits 2200; redeeming debits it. The P&L never sees a point."
 *
 * A POINT IS A PROMISE, AND A PROMISE IS A LIABILITY. Earning does not reduce
 * the sale — the guest paid full price. It accrues what the business has
 * undertaken to honour later: Dr 4095 Loyalty earned, Cr 2200. Redeeming then
 * settles that promise with no P&L consequence at all, because the cost was
 * taken when it was incurred. Treating points as a discount at redemption
 * instead would report every month's revenue as if the scheme were free and
 * then take the whole cost in whichever month people happened to spend.
 *
 * A ZERO EARN RATE MEANS THE SCHEME IS NOT RUNNING. There is no default, and
 * that is deliberate: a default would have every restaurant that installed this
 * quietly accruing a liability nobody agreed to.
 *
 * THE CONFIGURATION IS CHAIN-WIDE. A member earns at one branch and spends at
 * another; two branches on different earn rates would be two schemes sharing a
 * name.
 *
 * AND SO THE LIABILITY DOES NOT SIT WHERE THE POINTS DO. Earning at Malé
 * credits Malé's 2200; redeeming at Hulhumalé debits Hulhumalé's. A branch that
 * honours more than it issues carries a negative 2200, and that is not a bug —
 * it is what one set of books owing another looks like when each outlet keeps
 * its own. `stats()` reports both figures rather than one blended number,
 * because a single total would be nobody's balance.
 */

const { post: postJournal } = require('./journal');

const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const money = (n) => Math.round(Number(n) * 100) / 100;
const pts = (n) => Math.round(Number(n) * 100) / 100;

/* ── the scheme ──────────────────────────────────────────────────────────── */

async function config(c) {
  const q = await c.query('SELECT * FROM chain.loyalty LIMIT 1');
  const r = q.rows[0] || {};
  const tiers = Array.isArray(r.tiers) ? r.tiers : [];
  return {
    earnPerMvr: Number(r.earn_per_mvr || 0),
    pointValue: Number(r.point_value || 0),
    tiers: tiers.map((t) => ({ name: String(t.name), points: Number(t.points) }))
      .sort((a, b) => a.points - b.points),
    /* Both halves have to be set for the scheme to mean anything: a rate with
       no value accrues points worth nothing, and a value with no rate accrues
       nothing at all. Either alone is a scheme that is not running. */
    running: Number(r.earn_per_mvr || 0) > 0 && Number(r.point_value || 0) > 0,
    setAt: r.set_at || null,
  };
}

async function setConfig(c, p, ctx) {
  const earn = Number(p.earnPerMvr);
  const value = Number(p.pointValue);
  if (!(earn >= 0) || earn > 1000) {
    throw Object.assign(new Error('points per MVR, 0 to 1000'), { status: 400 });
  }
  if (!(value >= 0) || value > 1000) {
    throw Object.assign(new Error('what a point is worth, 0 to 1000 MVR'), { status: 400 });
  }
  const tiers = Array.isArray(p.tiers) ? p.tiers : [];
  const clean = [];
  for (const t of tiers) {
    const name = String(t.name || '').trim().slice(0, 40);
    const points = Number(t.points);
    if (!name) throw Object.assign(new Error('every tier needs a name'), { status: 400 });
    if (!Number.isFinite(points) || points < 0) {
      throw Object.assign(new Error(name + ' needs a threshold'), { status: 400 });
    }
    clean.push({ name, points });
  }
  clean.sort((a, b) => a.points - b.points);
  const names = new Set(clean.map((t) => t.name));
  if (names.size !== clean.length) {
    throw Object.assign(new Error('two tiers cannot share a name'), { status: 400 });
  }

  await c.query(
    'UPDATE chain.loyalty SET earn_per_mvr = $1, point_value = $2, tiers = $3::jsonb,'
    + ' set_by = $4, set_at = now()',
    [earn, value, JSON.stringify(clean), ctx.actor]);
  await c.query("SELECT chain.log('loyalty_config','loyalty',NULL,NULL,$1)",
    [JSON.stringify({ earn, value, tiers: clean.length })]);
  return config(c);
}

/** Where a points balance sits on the ladder, and how far the next rung is. */
function tierOf(cfg, points) {
  if (!cfg.tiers.length) return { name: null, next: null, toNext: 0 };
  let current = null;
  let next = null;
  for (const t of cfg.tiers) {
    if (points >= t.points) current = t;
    else { next = t; break; }
  }
  return {
    name: current ? current.name : null,
    next: next ? next.name : null,
    toNext: next ? pts(next.points - points) : 0,
  };
}

/* ── earning ─────────────────────────────────────────────────────────────── */

/**
 * Accrue points for a settled sale. Called from sale.js with the goods figure
 * NET of tax and service, because that is what the guest bought — earning on
 * the tax would have the business paying the member a share of the government's
 * money.
 *
 * Dr 4095 Loyalty earned (contra-income), Cr 2200 Loyalty liability.
 */
async function earn(c, p, ctx) {
  const cfg = await config(c);
  if (!cfg.running || !p.memberId) return null;

  const points = pts(Math.floor((p.goodsLaari / 100) * cfg.earnPerMvr * 100) / 100);
  if (!(points > 0)) return null;
  const value = Math.round(points * cfg.pointValue * 100);      // laari
  if (!(value > 0)) return null;

  await c.query(
    'INSERT INTO chain.point_entry (member_id, outlet_id, kind, points, value,'
    + " sale_id, by_staff) VALUES ($1,$2,'earn',$3,$4,$5,$6)",
    [p.memberId, ctx.outletId, points, toMVR(value), p.saleId || null, ctx.actor]);
  await c.query(
    'UPDATE chain.member SET points = points + $2 WHERE id = $1', [p.memberId, points]);

  await postJournal(c, {
    date: p.businessDate, memo: 'Points earned — ' + (p.docNo || ''),
    source: 'loyalty', sourceId: p.saleId || null,
    lines: [
      { account: '4095', dr: value, cr: 0 },
      { account: '2200', dr: 0, cr: value },
    ],
  }, ctx);

  return { points, value: money(value / 100) };
}

/* ── spending ────────────────────────────────────────────────────────────── */

/**
 * Can this member pay `amountL` with points? Checked BEFORE the sale exists,
 * for the same reason a house charge is: a refusal afterwards is a receipt for
 * a settlement that did not happen.
 */
async function checkPoints(c, memberId, amountL) {
  const cfg = await config(c);
  if (!cfg.running) {
    throw Object.assign(new Error(
      'the loyalty scheme is not running — an admin sets an earn rate and a'
      + ' point value before points can be spent'), { status: 409 });
  }
  const m = await c.query('SELECT id, name, phone, points FROM chain.member WHERE id = $1',
    [memberId]);
  if (!m.rows.length) {
    throw Object.assign(new Error('paying with points needs a member'), { status: 409 });
  }
  const have = Number(m.rows[0].points || 0);
  /* Rounded UP: spending 10.50 worth at 1 MVR a point costs 11 points, not
     10.5 of them. Rounding down would hand out a laari of free money on every
     redemption, which is small, systematic and impossible to reconcile. */
  const need = Math.ceil((amountL / 100) / cfg.pointValue * 100) / 100;
  if (have < need) {
    const who = m.rows[0].name || m.rows[0].phone;
    throw Object.assign(new Error(
      who + ' has ' + have + ' points, worth ' + toMVR(Math.round(have * cfg.pointValue * 100))
      + ' — this is ' + toMVR(amountL)), { status: 409 });
  }
  return { member: m.rows[0], have, need, cfg };
}

/** Record the spend. Called by sale.js once the sale exists; 2200 is debited
 *  by the sale's own journal, through the `points` tender. */
async function spend(c, p, ctx) {
  const { need } = await checkPoints(c, p.memberId, p.amount);
  await c.query(
    'INSERT INTO chain.point_entry (member_id, outlet_id, kind, points, value,'
    + " sale_id, by_staff) VALUES ($1,$2,'redeem',$3,$4,$5,$6)",
    [p.memberId, ctx.outletId, -need, toMVR(-p.amount), p.saleId || null, ctx.actor]);
  await c.query('UPDATE chain.member SET points = points - $2 WHERE id = $1',
    [p.memberId, need]);
  return { points: need, value: money(p.amount / 100) };
}

/* ── the catalogue ───────────────────────────────────────────────────────── */

async function rewards(c) {
  const q = await c.query('SELECT * FROM chain.reward ORDER BY active DESC, points');
  const cfg = await config(c);
  return q.rows.map((r) => ({
    id: r.id, name: r.name, points: r.points, value: money(r.value), active: r.active,
    /* What the points a reward costs are actually worth. A reward priced below
       that is being given away twice, and a reward priced far above it is one
       nobody will ever take — either way it is worth saying out loud. */
    pointsWorth: cfg.pointValue ? money(r.points * cfg.pointValue) : null,
  }));
}

async function setReward(c, p, ctx) {
  const name = String(p.name || '').trim().slice(0, 80);
  if (!name) throw Object.assign(new Error('a reward needs a name'), { status: 400 });
  const points = Number(p.points);
  if (!Number.isInteger(points) || points <= 0) {
    throw Object.assign(new Error('what does it cost in points?'), { status: 400 });
  }
  const value = toLaari(p.value || 0);
  if (!(value > 0)) {
    throw Object.assign(new Error('what is it worth in MVR?'), { status: 400 });
  }
  if (p.id) {
    const q = await c.query(
      'UPDATE chain.reward SET name = $2, points = $3, value = $4, active = $5,'
      + ' set_by = $6, set_at = now() WHERE id = $1 RETURNING id',
      [p.id, name, points, toMVR(value), p.active !== false, ctx.actor]);
    if (!q.rows.length) throw Object.assign(new Error('no such reward'), { status: 404 });
    return { id: p.id, name, points, value: money(value / 100) };
  }
  const q = await c.query(
    'INSERT INTO chain.reward (name, points, value, set_by) VALUES ($1,$2,$3,$4)'
    + ' RETURNING id', [name, points, toMVR(value), ctx.actor]);
  await c.query("SELECT chain.log('reward_set','reward',$1,NULL,$2)",
    [q.rows[0].id, JSON.stringify({ name, points, value: toMVR(value) })]);
  return { id: q.rows[0].id, name, points, value: money(value / 100) };
}

async function dropReward(c, id, ctx) {
  const q = await c.query('DELETE FROM chain.reward WHERE id = $1 RETURNING id', [id]);
  if (!q.rows.length) throw Object.assign(new Error('no such reward'), { status: 404 });
  await c.query("SELECT chain.log('reward_drop','reward',$1,NULL,NULL)", [id]);
  return { id, dropped: true };
}

/* ── what the scheme is doing ────────────────────────────────────────────── */

async function stats(c, outletId) {
  const cfg = await config(c);

  const total = await c.query(
    'SELECT coalesce(sum(points),0) AS points, count(*)::int AS members'
    + ' FROM chain.member WHERE points > 0');
  const here = await c.query(
    "SELECT coalesce(sum(points) FILTER (WHERE kind = 'earn'),0) AS earned,"
    + "  coalesce(-sum(points) FILTER (WHERE kind = 'redeem'),0) AS redeemed,"
    + "  coalesce(sum(value) FILTER (WHERE kind = 'earn'),0) AS earned_value"
    + ' FROM chain.point_entry WHERE outlet_id = $1', [outletId]);

  const outstanding = Number(total.rows[0].points || 0);
  const earned = Number(here.rows[0].earned || 0);
  const redeemed = Number(here.rows[0].redeemed || 0);

  /* The rungs, with how many members are standing on each. An empty ladder is
     not an error — it is a scheme with no tiers, which is a perfectly ordinary
     thing to run. */
  const ladder = [];
  for (const t of cfg.tiers) {
    const n = await c.query(
      'SELECT count(*)::int AS n FROM chain.member WHERE points >= $1', [t.points]);
    ladder.push({ name: t.name, points: t.points, members: n.rows[0].n });
  }

  return {
    config: cfg,
    outstanding: pts(outstanding),
    /* What it would cost to honour every point outstanding, right now. The
       figure a scheme is actually measured by, and the one nobody computes
       until somebody asks why 2200 keeps growing. */
    liability: money(outstanding * cfg.pointValue),
    members: total.rows[0].members,
    hereEarned: pts(earned),
    hereRedeemed: pts(redeemed),
    hereCost: money(Number(here.rows[0].earned_value || 0)),
    ladder,
  };
}

/** One member's points and where they stand. */
async function member(c, memberId) {
  const cfg = await config(c);
  const m = await c.query('SELECT * FROM chain.member WHERE id = $1', [memberId]);
  if (!m.rows.length) throw Object.assign(new Error('no such member'), { status: 404 });
  const points = Number(m.rows[0].points || 0);

  const q = await c.query(
    'SELECT p.*, o.name AS outlet, s.receipt_no FROM chain.point_entry p'
    + ' LEFT JOIN chain.outlet o ON o.id = p.outlet_id'
    + ' LEFT JOIN sale s ON s.id = p.sale_id'
    + ' WHERE p.member_id = $1 ORDER BY p.at DESC, p.id DESC LIMIT 100', [memberId]);

  return {
    points: pts(points),
    worth: money(points * cfg.pointValue),
    tier: tierOf(cfg, points),
    /* The outlet name resolves only for the branch in session — RLS sees to
       that — so an entry from elsewhere says "another outlet" rather than
       leaking which one. */
    entries: q.rows.map((r) => ({
      id: Number(r.id), at: r.at, kind: r.kind, points: pts(r.points),
      value: money(r.value), outlet: r.outlet || 'another outlet',
      docNo: r.receipt_no || null, note: r.note,
    })),
  };
}

module.exports = {
  config, setConfig, tierOf, earn, checkPoints, spend,
  rewards, setReward, dropReward, stats, member,
};
