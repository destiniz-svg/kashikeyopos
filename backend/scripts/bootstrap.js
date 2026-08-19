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
 * IT RUNS ON EVERY BOOT, so it is written to be safe on every boot, and it is
 * DECLARATIVE: it states that this named owner exists, at rank 5, with this
 * PIN. Absent, they are created; present with a different PIN, the PIN is reset
 * and the change is logged; present and identical, nothing happens.
 *
 * It reconciles rather than only inserting because insert-only could not repair
 * itself. A first PIN seeded wrong is an account nobody can sign into, and
 * "empty the outlet's staff and redeploy" needs the database access this script
 * exists precisely because nobody has. Matching is by NAME within the outlet and
 * an ambiguous name changes nothing, so it cannot mint a second sign-in beside a
 * real one — `staff(outlet_id, pin_lookup)` is not unique, so two staff sharing
 * a PIN would make sign-in resolve to an arbitrary one of them.
 *
 * Because it is declarative, leaving BOOTSTRAP_OWNER set means a redeploy
 * restores that PIN over one changed in the app. Clear it once you are in — it
 * is a credential sitting in an environment variable either way.
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
      /* EXACTLY FOUR. The lock screen draws four dots and submits on the
         fourth digit, so a longer PIN is not a stricter one — it is an account
         that cannot be signed into at all, and the till gives no hint why.
         This accepted 4-8 and that is exactly how one got created. */
      if (!/^\d{4}$/.test(pin)) {
        throw new Error('BOOTSTRAP_OWNER pin must be exactly 4 digits — the till'
          + ' submits on the fourth, so anything longer can never be entered');
      }

      const lookup = pinLookup(id, pin);
      const match = await c.query(
        'SELECT id, pin_lookup FROM chain.staff WHERE outlet_id = $1 AND name = $2'
        + ' FOR UPDATE', [id, who]);

      if (match.rows.length > 1) {
        /* Refused rather than guessed at. Picking one of them would reset a PIN
           belonging to somebody this script cannot identify. */
        console.log('bootstrap: outlet ' + id + ' has ' + match.rows.length
          + ' staff named "' + who + '" — too ambiguous to touch, leaving them alone');
      } else if (!match.rows.length) {
        const { hash, salt } = hashPin(pin);
        await c.query(
          'INSERT INTO chain.staff (name, rank, outlet_id, pin_hash, pin_salt, pin_lookup)'
          + ' VALUES ($1,5,$2,$3,$4,$5)',
          [who, id, hash, salt, lookup]);
        console.log('bootstrap: seeded ' + who + ' at rank 5 (Owner) for outlet ' + id);
      } else if (match.rows[0].pin_lookup === lookup) {
        console.log('bootstrap: ' + who + ' already signs in with this PIN, nothing to do');
      } else {
        /* Said out loud, every time. A PIN changing under somebody is the kind
           of thing that must never happen silently. */
        const { hash, salt } = hashPin(pin);
        await c.query(
          'UPDATE chain.staff SET rank = 5, active = true, pin_hash = $2, pin_salt = $3,'
          + ' pin_lookup = $4 WHERE id = $1',
          [match.rows[0].id, hash, salt, lookup]);
        console.log('bootstrap: RESET the PIN for ' + who + ' at outlet ' + id
          + ' to match BOOTSTRAP_OWNER');
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK'); throw e;
  } finally { c.release(); await shutdown(); }
})().catch(function (e) { console.error('bootstrap failed: ' + e.message); process.exit(1); });
