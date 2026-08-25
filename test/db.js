'use strict';
/* A fresh database per run. The CI path is a COLD Postgres — a suite that only
   passes against a database somebody warmed up by hand is a suite that will
   pass right up until the deploy. */

const { Client } = require('pg');

function configured() {
  return !!(process.env.DATABASE_URL || process.env.PGHOST);
}

async function freshDatabase(name) {
  const admin = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGADMINDB || 'postgres'
  });
  await admin.connect();
  // Roles are cluster-wide, not per-database: a re-run has to drop the outlet
  // roles the previous run created or provisioning fails on the password.
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity'
    + ' WHERE datname = $1 AND pid <> pg_backend_pid()', [name]).catch(() => {});
  await admin.query('DROP DATABASE IF EXISTS ' + ident(name));
  await admin.query('CREATE DATABASE ' + ident(name));
  await admin.end();
  process.env.PGDATABASE = name;
  delete process.env.DATABASE_URL;
  return name;
}

async function dropOutletRoles() {
  const admin = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE
  });
  await admin.connect();
  const q = await admin.query(
    "SELECT rolname FROM pg_roles WHERE rolname ~ '^outlet_[0-9]+_app$'");
  for (const r of q.rows) {
    await admin.query('DROP OWNED BY ' + ident(r.rolname)).catch(() => {});
    await admin.query('DROP ROLE IF EXISTS ' + ident(r.rolname)).catch(() => {});
  }
  await admin.end();
}

function ident(s) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) throw new Error('bad identifier');
  return '"' + s + '"';
}

// The three secrets the server refuses to start without.
function secrets() {
  process.env.OUTLET_ROLE_SECRET = process.env.OUTLET_ROLE_SECRET
    || 'test-outlet-role-secret-at-least-32-chars';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET
    || 'test-session-secret-at-least-32-characters';
  process.env.PORTAL_SECRET = process.env.PORTAL_SECRET
    || 'test-portal-secret-at-least-32-characters!';
  process.env.NODE_ENV = 'test';
  // The whole suite arrives from one loopback address, which is exactly what
  // the rate limiter exists to refuse. Scaled up here; the limiter's own test
  // sets the scale to 1 around its assertions. Production ignores this knob.
  process.env.RATE_LIMIT_SCALE = process.env.RATE_LIMIT_SCALE || '100';
}

/* The registry is a database of its own, so a suite that exercises accounts
   needs one. Named, never inferred: src/db.js refuses to guess which database
   is the registry, because guessing would make a business database its own on
   a misconfigured deploy and nothing would say so. */
async function freshControl(name) {
  const admin = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGADMINDB || 'postgres'
  });
  await admin.connect();
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity'
    + ' WHERE datname = $1 AND pid <> pg_backend_pid()', [name]).catch(() => {});
  await admin.query('DROP DATABASE IF EXISTS ' + ident(name));
  await admin.query('CREATE DATABASE ' + ident(name));
  await admin.end();
  process.env.CONTROL_DB = name;
  return name;
}

/* A cold CLUSTER, not just a cold database: the tenancy tests create business
   databases of their own, and a re-run has to sweep the ones the last run left
   or CREATE DATABASE fails on a name that is already taken. */
async function dropBusinessDatabases() {
  const admin = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGADMINDB || 'postgres'
  });
  await admin.connect();
  const q = await admin.query(
    "SELECT datname FROM pg_database WHERE datname LIKE 'kashikeyo\\_biz\\_%'");
  for (const r of q.rows) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity'
      + ' WHERE datname = $1 AND pid <> pg_backend_pid()', [r.datname]).catch(() => {});
    await admin.query('DROP DATABASE IF EXISTS ' + ident(r.datname)).catch(() => {});
  }
  await admin.end();
  return q.rows.length;
}

module.exports = { configured, freshDatabase, freshControl, dropOutletRoles,
  dropBusinessDatabases, secrets };
