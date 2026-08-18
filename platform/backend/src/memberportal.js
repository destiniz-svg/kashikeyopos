'use strict';
/* The member portal — 04-MEMBER-PORTAL-SPEC.md, 08-BUILD-STAGES §23.
 *
 * "Where the QR portal is anonymous and table-bound, this is identified and
 * chain-wide: one member, many outlets."
 *
 * THERE IS NO SIGN-UP, and that is a rule rather than an omission. §1: "No
 * password. No account creation form: a member exists the first time a cashier
 * attaches a phone number to a sale, with consent recorded." A form on the open
 * internet that creates loyalty accounts creates loyalty fraud; a member is
 * somebody who was in the restaurant.
 *
 * SO A NUMBER WE DO NOT KNOW IS TOLD SO, PLAINLY. The alternative — accepting
 * every number and sending a code only to real members — is the textbook
 * defence against enumeration, and here it means a guest sitting with their
 * phone waiting for a message that is never coming. The thing being protected
 * is whether a phone number is a member of a restaurant's loyalty scheme; the
 * thing being spent is every non-member's first two minutes. This one is worth
 * the trade, and the rate limit below is what stops it being a bulk lookup.
 *
 * THE CODE IS DELIVERED BY WHATEVER IS CONFIGURED, AND OFTEN NOTHING IS. With
 * no SMS provider set this returns 503 and says which variable would fix it,
 * rather than pretending to send. That would make the portal unreachable, so
 * there is a second door that is not a workaround: a cashier with the member in
 * front of them issues the same code at the till and reads it out. It is rank-
 * gated, single-use, expires in minutes, and names in the audit trail who let
 * that person in.
 *
 * THE PHONE NEVER TAKES MONEY (the hard rule, and §3 again: "The till still
 * takes the payment: the portal posts intent"). Offering points writes the
 * offer onto the TICKET, where the cashier is already looking. Redeeming a
 * reward mints a voucher the till can accept. Neither moves a bill by one
 * laari on its own.
 */

const crypto = require('crypto');
const loyalty = require('./loyalty');

const money = (n) => Math.round(Number(n) * 100) / 100;
const pts = (n) => Math.round(Number(n) * 100) / 100;

const OTP_TTL_SECONDS = 300;
const SESSION_HOURS = 24 * 30;    // a loyalty card is not a banking app

/* +960 is the Maldives and the only country this runs in; a number is stored as
   the seven digits people actually give. Normalised on the way in so that
   "+960 777 9999", "7779999" and "960-7779999" are one member and not three. */
function normalisePhone(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  const local = digits.startsWith('960') && digits.length > 7 ? digits.slice(3) : digits;
  if (!/^\d{7}$/.test(local)) {
    throw Object.assign(new Error('that is not a Maldivian mobile number'), { status: 400 });
  }
  return local;
}

const maskPhone = (p) => (p && p.length === 7 ? '••• ' + p.slice(3) : '');

/** The stored form of a code. The code itself is never written down. */
function macFor(phone, code) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 chars');
  }
  return crypto.createHmac('sha256', secret)
    .update('otp:' + phone + ':' + String(code)).digest('hex');
}

/* Six digits, uniformly, from a cryptographic source. Math.random() would be
   guessable from a handful of previous codes, which is the one property a
   one-time code must not have. */
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const newVoucherCode = () => {
  /* Read aloud across a counter, so no O/0/I/1 to mishear. */
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY34789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
  return s.slice(0, 4) + '-' + s.slice(4);
};

/* ── who can send a code ─────────────────────────────────────────────────── */

/**
 * The SMS channel, if one is configured.
 *
 * Deliberately shaped like a provider lookup with no provider: nothing here
 * invents a channel, and nothing pretends a code was sent. When somebody wires
 * a gateway in, this is the one function that changes.
 */
function smsSender() {
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url) return null;
  return async function send(phone, text) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.SMS_API_KEY ? { authorization: 'Bearer ' + process.env.SMS_API_KEY } : {}),
      },
      body: JSON.stringify({ to: '+960' + phone, text }),
    });
    if (!r.ok) throw new Error('the message gateway refused: HTTP ' + r.status);
    return true;
  };
}

/**
 * Ask for a code.
 *
 * `issue` is the shared half: mint, store the mac, and let the caller decide
 * what happens to the digits — sent to the phone, or read out by a cashier.
 */
async function issueCode(c, phone, by, outletId) {
  const code = newCode();
  try {
    const q = await c.query('SELECT chain.otp_issue($1,$2,$3,$4,$5) AS expires',
      [phone, macFor(phone, code), OTP_TTL_SECONDS, by || null, outletId || null]);
    return { code, expiresAt: q.rows[0].expires };
  } catch (e) {
    if (/otp_cooldown/.test(e.message)) {
      throw Object.assign(new Error('a code was just sent — give it half a minute'),
        { status: 429 });
    }
    throw e;
  }
}

/** The member portal's own request-a-code, over whatever channel exists. */
async function requestCode(c, p) {
  const phone = normalisePhone(p.phone);
  /* Through the definer function: nobody is signed in yet, so this connection
     can read no member row at all — which is the correct amount of access for
     a request that has not proved anything. */
  const m = await c.query('SELECT chain.member_by_phone($1) AS id', [phone]);
  if (!m.rows[0].id) {
    throw Object.assign(new Error('We do not have that number. Ask a server to add you'
      + ' to the scheme next time you are in — it takes a moment and there is no form.'),
    { status: 404 });
  }
  const send = smsSender();
  if (!send) {
    throw Object.assign(new Error('Sign-in by text is not switched on for this chain.'
      + ' A server can sign you in at the counter instead.'), { status: 503 });
  }
  const { code, expiresAt } = await issueCode(c, phone, null, null);
  await send(phone, 'Your code is ' + code + '. It expires in five minutes.');
  return { sent: true, to: maskPhone(phone), expiresAt };
}

/** Verify, and mint the session. Returns null when the code is wrong. */
async function verifyCode(c, p) {
  const phone = normalisePhone(p.phone);
  const code = String(p.code || '').replace(/[^\d]/g, '');
  if (code.length !== 6) {
    throw Object.assign(new Error('a code is six digits'), { status: 400 });
  }
  const q = await c.query('SELECT chain.otp_verify($1,$2) AS member', [phone, macFor(phone, code)]);
  return q.rows[0].member || null;
}

/* ── the card ────────────────────────────────────────────────────────────── */

/**
 * §2: the member card, the tier, and the distance to the next one — "read from
 * the tier ladder in configuration — never a hardcoded threshold."
 */
async function me(c, memberId) {
  const m = await c.query(
    'SELECT id, name, phone, points, joined_at FROM chain.member WHERE id = $1', [memberId]);
  if (!m.rows.length) throw Object.assign(new Error('no such member'), { status: 404 });
  const r = m.rows[0];
  const cfg = await loyalty.config(c);
  const points = Number(r.points || 0);

  /* The rung and the distance to the next one come from `tierOf`, which the
     till already uses — not from a second walk along the same ladder written
     here. Two answers to "which tier is this member" is how a card says Gold
     and a receipt says Silver, and the ladder is configuration, so the two
     would drift the first time somebody edited it. */
  const tier = loyalty.tierOf(cfg, points);

  return {
    name: r.name || null,
    phone: maskPhone(r.phone),
    memberSince: r.joined_at,
    points: pts(points),
    /* What the points are worth in money, which is the only form in which a
       balance means anything to the person holding it. */
    worth: money(points * cfg.pointValue),
    /* { name, next, toNext } — the rung they are on, the one above it, and how
       far. A scheme with no tiers gives all three as null/0, which is a scheme
       with no tiers rather than an error. */
    tier,
    scheme: { earnPerMvr: cfg.earnPerMvr, pointValue: cfg.pointValue, running: cfg.earnPerMvr > 0 },
  };
}

/* ── the visits ──────────────────────────────────────────────────────────── */

/**
 * §4: "Real visit history read from settled sales — date, outlet, covers, total,
 * points earned. No fabricated history: a new member sees an empty state that
 * says what will appear here after their first visit."
 *
 * Read from `chain.member_visit`, which is the member-visible PROJECTION of a
 * settled sale — written by the outlet that served it. The sale itself, its
 * lines, its tender and its staff stay in that outlet's schema, where this
 * session holds no grant. §6: "their visits stay in the outlet that served
 * them."
 */
async function visits(c, memberId, limit) {
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  const q = await c.query(
    'SELECT v.at, v.covers, v.total, v.points, o.name AS outlet'
    + ' FROM chain.member_visit v LEFT JOIN chain.outlet o ON o.id = v.outlet_id'
    + ' WHERE v.member_id = $1 ORDER BY v.at DESC LIMIT $2', [memberId, n]);
  const rows = q.rows.map((r) => ({
    at: r.at, outlet: r.outlet || 'another outlet', covers: r.covers,
    total: money(r.total), points: pts(r.points),
  }));
  return {
    visits: rows,
    totals: {
      visits: rows.length,
      spent: money(rows.reduce((a, r) => a + r.total, 0)),
      earned: pts(rows.reduce((a, r) => a + r.points, 0)),
    },
  };
}

/* ── the rewards ─────────────────────────────────────────────────────────── */

async function catalogue(c, memberId) {
  const m = await c.query('SELECT points FROM chain.member WHERE id = $1', [memberId]);
  const have = Number((m.rows[0] || {}).points || 0);
  const r = await c.query(
    'SELECT id, name, points, value FROM chain.reward WHERE active ORDER BY points');
  const v = await c.query(
    'SELECT id, code, name, value, points, issued_at, expires_at, redeemed_at,'
    + ' redeemed_outlet FROM chain.voucher WHERE member_id = $1'
    + ' ORDER BY redeemed_at NULLS FIRST, issued_at DESC LIMIT 50', [memberId]);

  return {
    points: pts(have),
    rewards: r.rows.map((x) => ({
      id: x.id, name: x.name, points: pts(x.points), value: money(x.value),
      affordable: have >= Number(x.points),
      /* How many points short, so the screen can say "820 more" instead of
         greying a row out and leaving somebody to do the subtraction. */
      short: have >= Number(x.points) ? 0 : pts(Number(x.points) - have),
    })),
    vouchers: v.rows.map((x) => ({
      id: x.id, code: x.code, name: x.name, value: money(x.value), points: pts(x.points),
      issuedAt: x.issued_at, expiresAt: x.expires_at,
      redeemedAt: x.redeemed_at,
      /* Expired is not the same as spent, and a member reading their own
         wallet needs to know which happened. */
      state: x.redeemed_at ? 'used'
        : (x.expires_at && new Date(x.expires_at) < new Date()) ? 'expired' : 'ready',
    })),
  };
}

/**
 * §5: "Redeeming creates a voucher the till can accept; it does not discount
 * anything on the phone."
 *
 * The whole thing happens inside chain.redeem_reward — points off, entry
 * written, voucher minted — because a phone that loses its connection between
 * any two of those leaves a member whose points are gone and who has nothing to
 * show for them.
 */
async function redeem(c, memberId, p) {
  const rewardId = String(p.rewardId || '');
  if (!rewardId) throw Object.assign(new Error('which reward?'), { status: 400 });
  const days = Number(process.env.VOUCHER_DAYS || 90);
  try {
    const q = await c.query('SELECT * FROM chain.redeem_reward($1,$2,$3,$4)',
      [memberId, rewardId, newVoucherCode(), days]);
    const v = q.rows[0];
    return {
      id: v.id, code: v.code, name: v.name,
      value: money(v.value), points: pts(v.points), expiresAt: v.expires_at,
      message: 'Show ' + v.code + ' at the counter. It comes off the bill there,'
        + ' not here.',
    };
  } catch (e) {
    if (/not_enough_points/.test(e.message)) {
      throw Object.assign(new Error('not enough points for that yet'), { status: 409 });
    }
    if (/no_such_reward/.test(e.message)) {
      throw Object.assign(new Error('that reward is no longer offered'), { status: 404 });
    }
    throw e;
  }
}

/* ── the bill ────────────────────────────────────────────────────────────── */

/**
 * §3: "Shows the member's open ticket at whichever outlet they are sitting in."
 *
 * A member session cannot read a ticket — it holds no grant on any outlet
 * schema, by design. So the API asks on their behalf, over the outlet's own
 * connection, for a ticket that NAMES this member. Which outlet: whichever one
 * has such a ticket, which is a question with an answer only if a cashier
 * attached them to it. Nobody has to tell the phone where it is.
 *
 * `openOutlets` is passed in rather than looked up here so the caller decides
 * how wide to search; a chain of six is six small queries and a chain of six
 * hundred would need a different answer.
 */
function billFinder(withOutlet) {
  return async function bill(memberId, outlets) {
    for (const o of outlets) {
      const found = await withOutlet({ outletId: o.id, rank: 0, scope: 'outlet' },
        async function (c) {
          const t = await c.query(
            'SELECT id, table_no, covers, opened_at, points_offered, points_offered_at'
            + " FROM ticket WHERE member_id = $1 AND status = 'open'"
            + ' ORDER BY opened_at DESC LIMIT 1', [memberId]);
          if (!t.rows.length) return null;
          const tk = t.rows[0];
          const lines = await c.query(
            'SELECT l.name, l.qty, l.unit_price, l.sent_at IS NOT NULL AS sent'
            + ' FROM ticket_line l WHERE l.ticket_id = $1 AND l.void_at IS NULL'
            + ' ORDER BY l.id', [tk.id]);
          return {
            outlet: { id: o.id, name: o.name },
            ticketId: tk.id, table: tk.table_no, covers: tk.covers, openedAt: tk.opened_at,
            lines: lines.rows.map((l) => ({
              name: l.name, qty: Number(l.qty), price: money(l.unit_price),
              amount: money(Number(l.qty) * Number(l.unit_price)), sent: l.sent,
            })),
            pointsOffered: tk.points_offered === null ? null : pts(tk.points_offered),
            offeredAt: tk.points_offered_at,
          };
        });
      if (found) {
        found.goods = money(found.lines.reduce((a, l) => a + l.amount, 0));
        return found;
      }
    }
    return null;
  };
}

/**
 * Offer points against the open bill.
 *
 * This is an INTENT and the wording everywhere says so. It writes the offer
 * onto the ticket the cashier is already looking at; the till converts and
 * takes it, or does not. A phone that could reduce a bill by itself would be a
 * phone that can pay, and the first rule of this build is that it cannot.
 */
function offerPoints(withOutlet) {
  return async function offer(memberId, outletId, ticketId, points, config) {
    const want = Number(points);
    if (!(want > 0)) {
      throw Object.assign(new Error('how many points?'), { status: 400 });
    }
    return withOutlet({ outletId: Number(outletId), rank: 0, scope: 'outlet' },
      async function (c) {
        const m = await c.query('SELECT points FROM chain.member WHERE id = $1', [memberId]);
        if (!m.rows.length) throw Object.assign(new Error('no such member'), { status: 404 });
        const have = Number(m.rows[0].points || 0);
        if (want > have) {
          throw Object.assign(new Error('you have ' + pts(have) + ' points'), { status: 409 });
        }
        const t = await c.query(
          'UPDATE ticket SET points_offered = $3, points_offered_at = now()'
          + " WHERE id = $1 AND member_id = $2 AND status = 'open' RETURNING id",
          [ticketId, memberId, want]);
        if (!t.rows.length) {
          throw Object.assign(new Error('that bill is not open in your name'), { status: 409 });
        }
        return {
          points: pts(want),
          worth: money(want * config.pointValue),
          message: 'Offered. The cashier will take it off when you pay — nothing has'
            + ' been charged or deducted yet.',
        };
      });
  };
}

module.exports = {
  normalisePhone, maskPhone, macFor, issueCode, requestCode, verifyCode,
  me, visits, catalogue, redeem, billFinder, offerPoints,
  smsSender, SESSION_HOURS, OTP_TTL_SECONDS,
};
