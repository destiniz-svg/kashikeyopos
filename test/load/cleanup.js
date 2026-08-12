#!/usr/bin/env node
/* Remove the synthetic orgs the capacity harness creates.
 *
 * WHY IT IS NOT ONE DELETE STATEMENT
 * ----------------------------------
 * `DELETE FROM orgs WHERE email LIKE '%@loadtest.invalid'` does not work.
 * `entities` references `orgs(id)` WITHOUT `ON DELETE CASCADE`, and most
 * org-scoped tables (ops, stock_moves, activity_log, …) carry a bare `org_id`
 * column with no foreign key at all. The statement fails on a foreign-key
 * violation, and even if it did not, the un-keyed tables would be orphaned.
 *
 * So the org's rows are removed from every table that has an `org_id` column —
 * discovered from information_schema rather than hard-coded, so a table added
 * later cannot be silently missed — and the org row last.
 *
 * SAFETY
 * ------
 *  - It only ever matches `%@loadtest.invalid`. `.invalid` is reserved by
 *    RFC 2606 and can never be a real address, so no live merchant can collide
 *    with the pattern however the harness is run.
 *  - It is a DRY RUN unless CLEANUP_CONFIRM=yes. The dry run prints the exact
 *    orgs and row counts it would remove, so the decision is made on evidence.
 *  - It prints the database it is connected to before touching anything.
 *  - It refuses to run against a database whose name looks like production.
 *
 * Connects with DATABASE_URL. Inside Railway that can be a variable reference
 * (${{Postgres.DATABASE_URL}}), so no credential is ever handled by a person.
 *
 *   DATABASE_URL=... node test/load/cleanup.js               # dry run
 *   DATABASE_URL=... CLEANUP_CONFIRM=yes node test/load/cleanup.js
 */
"use strict";
const { Client } = require("pg");

const PATTERN = "%@loadtest.invalid";
const CONFIRMED = process.env.CLEANUP_CONFIRM === "yes";

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }

  const client = new Client({ connectionString: url, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
  await client.connect();

  const who = (await client.query("SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS host")).rows[0];
  console.log(`connected  db=${who.db} user=${who.usr} host=${who.host || "(local)"}`);
  console.log(`mode       ${CONFIRMED ? "DELETE (CLEANUP_CONFIRM=yes)" : "DRY RUN — nothing will be removed"}`);

  /* A courtesy guard, not a guarantee: read the target before you run it. */
  if (/prod/i.test(String(who.db))) {
    console.error("refusing: database name looks like production — " + who.db);
    process.exit(3);
  }

  /* Connecting successfully is not the same as connecting to the right place.
     A Railway `${{Postgres.DATABASE_URL}}` reference resolves to whichever
     Postgres service you named, and a project can have more than one — so this
     says which database it actually landed in rather than failing with a bare
     "relation orgs does not exist". */
  if (!(await client.query("SELECT to_regclass('public.orgs') AS t")).rows[0].t) {
    console.error(`\nNo public.orgs in database '${who.db}' — this is not the app's database.`);
    const schemas = (await client.query(
      `SELECT table_schema, count(*)::int AS n FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog','information_schema')
        GROUP BY 1 ORDER BY 2 DESC`)).rows;
    console.error("schemas here: " + (schemas.map((s) => `${s.table_schema} (${s.n} tables)`).join(", ") || "none"));
    console.error("Point DATABASE_URL at the database the app writes to — inside Railway,");
    console.error("a reference to the app service's own DATABASE_URL is the reliable way.");
    process.exit(4);
  }

  const orgs = (await client.query("SELECT id, email FROM orgs WHERE email LIKE $1 ORDER BY created_at", [PATTERN])).rows;
  console.log(`matched    ${orgs.length} org(s) against '${PATTERN}'`);
  if (!orgs.length) { console.log("nothing to do"); await client.end(); return; }
  for (const o of orgs.slice(0, 10)) console.log(`             ${o.email}`);
  if (orgs.length > 10) console.log(`             … and ${orgs.length - 10} more`);

  const ids = orgs.map((o) => o.id);

  /* Every table carrying an org_id, discovered rather than listed, so a table
     added after this was written cannot be quietly left behind. */
  const tables = (await client.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'org_id' AND table_name <> 'orgs'
      ORDER BY table_name`)).rows.map((r) => r.table_name);

  let total = 0;
  const counted = [];
  for (const t of tables) {
    const n = Number((await client.query(`SELECT count(*)::bigint AS n FROM "${t}" WHERE org_id = ANY($1)`, [ids])).rows[0].n);
    if (n > 0) { counted.push([t, n]); total += n; }
  }
  console.log(`\nrows carrying those orgs (${tables.length} tables scanned):`);
  for (const [t, n] of counted) console.log(`  ${t.padEnd(24)} ${n.toLocaleString()}`);
  console.log(`  ${"TOTAL".padEnd(24)} ${total.toLocaleString()}  + ${orgs.length} org row(s)`);

  if (!CONFIRMED) {
    console.log("\ndry run complete — set CLEANUP_CONFIRM=yes to remove the above");
    await client.end();
    return;
  }

  /* One transaction: a half-deleted org is worse than an untouched one. */
  await client.query("BEGIN");
  try {
    for (const [t] of counted) {
      const r = await client.query(`DELETE FROM "${t}" WHERE org_id = ANY($1)`, [ids]);
      console.log(`deleted    ${String(r.rowCount).padStart(8)} from ${t}`);
    }
    const r = await client.query("DELETE FROM orgs WHERE id = ANY($1)", [ids]);
    console.log(`deleted    ${String(r.rowCount).padStart(8)} from orgs`);
    await client.query("COMMIT");
    console.log("\nCOMMITTED");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("ROLLED BACK — " + (e && e.message));
    process.exitCode = 1;
  }

  const left = (await client.query("SELECT count(*)::int AS n FROM orgs WHERE email LIKE $1", [PATTERN])).rows[0].n;
  console.log(`remaining  ${left} loadtest org(s)`);
  await client.end();
})().catch((e) => { console.error("cleanup failed:", (e && e.message) || e); process.exit(1); });
