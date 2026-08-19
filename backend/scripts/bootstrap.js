'use strict';
/* First-run bootstrap: the outlet and the owner who can sign in.
 *
 * WHY THIS EXISTS. A cloud deployment has no shell. The runbook's
 * `railway run npm run provision:outlet -- ...` assumes somebody can open a
 * terminal against the running environment, and on a hosted deploy driven from
 * a browser nobody can — so a freshly deployed system came up correct, healthy
 * and impossible to sign into, with no way in from anywhere.
 *
 * IT IS CONFIGURATION, NOT DEMO DATA (10-NO-DEMO-DATA.md). Nothing is baked in:
 * with the variables unset this prints one line and does nothing at all, which
 * is the normal state of every environment that was bootstrapped long ago.
 *
 *   BOOTSTRAP_OUTLET       "<id>:<CODE>:<Name>"   e.g. 1:SEP-01:Sephora Café
 *   BOOTSTRAP_OWNER        "<Name>:<pin>"         e.g. Owner:4821
 *
 * IT RUNS ON EVERY BOOT, so it is written to be safe on every boot.
 * `chain.provision_outlet` is idempotent by construction. The owner is seeded
 * ONLY when the outlet has no staff whatsoever — so it cannot quietly mint a
 * second sign-in beside a real one, and a deploy can never duplicate a PIN.
 * That one condition also makes this the documented way back in after the last
 * account with access is lost: empty the outlet's staff, redeploy, sign in.
 *
 * It runs AFTER migrations, from the image's start command, because everything
 * here calls functions the migrations create.
 */
const { owner, shutdown } = require('../src/db');
const { outletPassword, hashPin, pinLookup } = require('../src/secrets');

function parse(spec, parts) {
  /* Split from the LEFT exactly as many times as there are leading fields, so
     the last field keeps any colon it contains — a store called "Sephora: The
     Cafe" is a name, not a parse error. */
  const out = [];
  let rest = String(spec);
  for (let i = 0; i < parts - 1; i++) {
    const at = rest.indexOf(':');
    if (at < 0) return null;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  out.push(rest);
  return out.every((x) => x.trim()) ? out.map((x) => x.trim()) : null;
}

(async function () {
  const outletSpec = process.env.BOOTSTRAP_OUTLET;
  if (!outletSpec) { console.log('bootstrap: nothing configured, skipping'); return; }

  const parsedOutlet = parse(outletSpec, 3);
  if (!parsedOutlet) throw new Error('BOOTSTRAP_OUTLET must be "<id>:<CODE>:<Name>"');
  const [rawId, code, name] = parsedOutlet;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('BOOTSTRAP_OUTLET id must be a positive integer');

  const c = await owner().connect();
  try {
    await c.query('BEGIN');
    const s = await c.query('SELECT chain.provision_outlet($1,$2,$3,$4) AS schema',
      [id, code, name, outletPassword(id)]);
    const schema = s.rows[0].schema;
    await c.query('SELECT chain.seed_chart($1)', [schema]);
    await c.query('GRANT EXECUTE ON FUNCTION chain.estate_day(date) TO kashikeyo_report');
    console.log('bootstrap: outlet ' + id + ' (' + code + ') ready as ' + schema);

    const ownerSpec = process.env.BOOTSTRAP_OWNER;
    if (ownerSpec) {
      const parsedOwner = parse(ownerSpec, 2);
      if (!parsedOwner) throw new Error('BOOTSTRAP_OWNER must be "<Name>:<pin>"');
      const [who, pin] = parsedOwner;
      if (!/^\d{4,8}$/.test(pin)) throw new Error('BOOTSTRAP_OWNER pin must be 4-8 digits');

      /* The whole idempotency rule, in one row lock: seed only into an outlet
         with nobody in it. */
      const existing = await c.query(
        'SELECT count(*)::int AS n FROM chain.staff WHERE outlet_id = $1', [id]);
      if (existing.rows[0].n > 0) {
        console.log('bootstrap: outlet ' + id + ' already has staff, leaving them alone');
      } else {
        const { hash, salt } = hashPin(pin);
        await c.query(
          'INSERT INTO chain.staff (name, rank, outlet_id, pin_hash, pin_salt, pin_lookup)'
          + ' VALUES ($1,5,$2,$3,$4,$5)',
          [who, id, hash, salt, pinLookup(id, pin)]);
        console.log('bootstrap: seeded ' + who + ' at rank 5 (Owner) for outlet ' + id);
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK'); throw e;
  } finally { c.release(); await shutdown(); }
})().catch(function (e) { console.error('bootstrap failed: ' + e.message); process.exit(1); });
