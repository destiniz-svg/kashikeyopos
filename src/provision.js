'use strict';
/* Provisioning an outlet is the one operation that needs the owner connection,
   because it creates a schema and a login role. It is called from exactly two
   places: the onboarding route (first outlet) and the chain route that adds a
   branch — both behind rank 5. Nothing else imports this. */

const { owner, forget } = require('./db');
const { outletPassword } = require('./secrets');
const handle = require('./handle');

async function nextOutletId(client) {
  const q = await client.query('SELECT coalesce(max(id), 0) + 1 AS n FROM chain.outlet');
  return Number(q.rows[0].n);
}

/* Creates schema outlet_<id>, role outlet_<id>_app, the document series and
   the chart of accounts, then writes the outlet's own tax version — the rate
   in force at this outlet from the date it opened, which is what its receipts
   will quote for as long as it stands. */
async function provisionOutlet(opts) {
  const pool = owner();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = opts.id || await nextOutletId(client);
    const code = String(opts.code || ('KO' + id)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) throw Object.assign(new Error('outlet code required'), { status: 400 });
    if (!opts.name) throw Object.assign(new Error('outlet name required'), { status: 400 });

    /* An outlet cannot charge GST its company is not registered to collect —
       the database refuses it (migration 014). Settle that here so a business
       below the threshold gets an outlet rather than a constraint violation,
       and so `GGST` arriving from an old client is corrected rather than
       thrown back at somebody who never chose it. */
    const reg = await client.query('SELECT chain.gst_registered() AS on');
    const registered = !!reg.rows[0].on;
    const wantedTax = opts.taxCode || null;
    const taxCode = registered ? (wantedTax || 'GGST') : 'NONE';

    const schema = await client.query('SELECT chain.provision_outlet($1,$2,$3,$4) AS s',
      [id, code, opts.name, outletPassword(id)]).then((r) => r.rows[0].s);

    await client.query(
      'UPDATE chain.outlet SET kind = coalesce($2, kind), parent_id = $3,'
      + ' tax_code = $4, service_pct = coalesce($5, service_pct),'
      + ' address = $6, atoll = $7, phone = $8, tz = coalesce($9, tz),'
      + ' currency = coalesce($10, currency), day_start = coalesce($11, day_start),'
      + ' slug = $12 WHERE id = $1',
      [id, opts.kind || null, opts.parentId || null, taxCode,
        opts.servicePct == null ? null : Number(opts.servicePct),
        opts.address || null, opts.atoll || null, opts.phone || null,
        opts.tz || null, opts.currency || null, opts.dayStart || null,
        await claimHandle(client, opts, id)]);

    // The outlet's own tax version, effective from the day it opens. NONE is a
    // real answer: a business that is not GST-registered charges nothing, and
    // `0 || 8` silently turning that into 8% is a bug we refuse to ship.
    if (taxCode !== 'NONE') {
      const rate = opts.taxRate == null
        ? await currentStatutory(client, taxCode)
        : Number(opts.taxRate);
      await client.query(
        'INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from, authority_ref)'
        + ' VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [id, taxCode, rate, opts.taxFrom || new Date().toISOString().slice(0, 10),
          opts.taxRef || 'Outlet registration']);
    } else {
      await client.query(
        'INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from, authority_ref)'
        + " VALUES ($1,'NONE',0,$2,'Not registered for GST') ON CONFLICT DO NOTHING",
        [id, opts.taxFrom || new Date().toISOString().slice(0, 10)]);
    }

    await client.query('COMMIT');
    forget(id);
    return { id, code, schema, name: opts.name };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function currentStatutory(client, code) {
  const q = await client.query(
    'SELECT rate FROM chain.tax_version WHERE outlet_id IS NULL AND code = $1'
    + ' AND effective_from <= current_date'
    + ' AND (effective_to IS NULL OR effective_to >= current_date)'
    + ' ORDER BY effective_from DESC LIMIT 1', [code]);
  return q.rows.length ? Number(q.rows[0].rate) : 0;
}

/* The outlet's public address. A handle the business CHOSE is honoured or
   refused by name — never quietly swapped for a free one, because they are
   about to print it. A handle merely DERIVED from the business name is a
   suggestion, so it steps aside for one that is already taken. */
async function claimHandle(client, opts, id) {
  const chosen = opts.slug != null && String(opts.slug).trim() !== '';

  if (chosen) {
    // A chosen handle is lower-cased and trimmed and NOTHING else. Silently
    // reshaping "Sea House" into "sea-house" would refuse a handle they never
    // typed, or worse accept one — the panel does the shaping, in front of
    // them, and what arrives here is what they saw.
    const want = String(opts.slug).trim().toLowerCase();
    const shape = handle.shapeError(want);
    if (shape) throw Object.assign(new Error(shape), { status: 400 });
    const why = await client.query('SELECT chain.handle_why($1,$2) AS w', [want, id]);
    if (why.rows[0].w) {
      throw Object.assign(new Error(why.rows[0].w), { status: 409 });
    }
    return want;
  }

  const want = handle.normalise(opts.name);
  const tries = [want];
  for (let n = 2; n <= 9; n++) tries.push(want + '-' + n);
  tries.push(want + '-' + id, 'store-' + id);
  for (const t of tries) {
    if (!handle.ok(t)) continue;
    const free = await client.query('SELECT chain.handle_free($1,$2) AS f', [t, id]);
    if (free.rows[0].f) return t;
  }
  // 'store-<id>' is unique by construction, so reaching here means the id is
  // not what we were told it was. Say that rather than write a wrong address.
  throw Object.assign(new Error('could not settle on a store address for outlet ' + id),
    { status: 500 });
}

module.exports = { provisionOutlet, slugify: handle.normalise, claimHandle };
