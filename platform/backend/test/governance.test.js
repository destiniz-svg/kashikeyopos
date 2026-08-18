'use strict';
/* Settings, access and the audit log — 08-BUILD-STAGES §29.
 *
 * Three things worth pinning here, and none of them is "the screen renders":
 *
 *   · An outlet's service charge, rounding and tax rate have been settable by
 *     nothing but psql for the whole project, and `chain.tax_version` carried a
 *     write policy with no grant behind it — the third time in this build a
 *     policy and its grant were written in different files and only one of them
 *     arrived.
 *   · A tax rate cannot be backdated. A rate that took effect last Tuesday
 *     would restate every receipt printed since, including a period already
 *     filed with MIRA.
 *   · The audit trail is append-only because the role holds no UPDATE and no
 *     DELETE — and the export of it is itself in it.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe('settings, access and the trail', () => {
  let ctx, admin, mgr, cashier;

  before(async () => {
    ctx = await H.bootOutlet();
    admin = await H.addStaff(ctx, 'General Manager', 4);
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    cashier = await H.addStaff(ctx, 'A Cashier', 2);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || admin.token });
  const get = (p, token) => req('GET', p, undefined, token);

  /* ── settings ──────────────────────────────────────────────────────────── */

  describe('settings', () => {
    test('a manager may read them and a cashier may not', async () => {
      assert.equal((await get('/settings', mgr.token)).status, 200);
      assert.equal((await get('/settings', cashier.token)).status, 403);
    });

    test('they say which fields nobody in the app can change, and why', async () => {
      const r = await get('/settings');
      assert.deepEqual(r.json.fixed.fields, ['id', 'code', 'schema_name', 'db_role']);
      assert.match(r.json.fixed.why, /tenancy model/);
    });

    test('a manager may look but not change', async () => {
      const r = await get('/settings', mgr.token);
      assert.equal(r.json.canEdit, false);
      const w = await req('PUT', '/settings',
        { name: 'Sneaky', servicePct: 0, cashRoundLaari: 0, tables: 1 }, mgr.token);
      assert.equal(w.status, 403);
    });

    test('an admin changes the service charge and it takes', async () => {
      const r = await req('PUT', '/settings', {
        name: 'Renamed Outlet', tz: 'Indian/Maldives',
        servicePct: 12.5, cashRoundLaari: 5, tables: 20,
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.outlet.name, 'Renamed Outlet');
      assert.equal(r.json.outlet.servicePct, 12.5);
      assert.equal(r.json.outlet.cashRoundLaari, 5);
      assert.equal(r.json.outlet.tables, 20);
    });

    test('and the change is in the trail, with what it was before', async () => {
      const r = await get('/audit?action=outlet_settings');
      assert.ok(r.json.entries.length >= 1);
      const e = r.json.entries[0];
      assert.ok(e.before && e.after, 'an entry saying "settings changed" is a note, not a record');
      assert.notEqual(e.before.servicePct, e.after.servicePct);
    });

    test('nonsense is refused with a sentence, not a constraint violation', async () => {
      const base = { name: 'X', servicePct: 10, cashRoundLaari: 0, tables: 4 };
      assert.equal((await req('PUT', '/settings', { ...base, servicePct: 140 })).status, 400);
      assert.equal((await req('PUT', '/settings', { ...base, cashRoundLaari: 900 })).status, 400);
      assert.equal((await req('PUT', '/settings', { ...base, name: '   ' })).status, 400);
      assert.equal((await req('PUT', '/settings', { ...base, tables: -1 })).status, 400);
    });

    test('the outlet role cannot write chain.outlet directly, whatever it asks',
      async () => {
        /* The reason `set_outlet_settings` exists. `schema_name` and `db_role`
           on that row are what a connection is resolved through — a role that
           could write them could point its own outlet at another's schema, and
           RLS cannot help because a policy decides which ROWS you may write,
           never which COLUMNS. */
        await assert.rejects(
          () => H.q(ctx, "UPDATE chain.outlet SET schema_name = 'outlet_1' WHERE id = $1",
            [ctx.outletId]),
          /permission denied/);
      });
  });

  /* ── the tax rate ──────────────────────────────────────────────────────── */

  describe('the tax rate', () => {
    test('every version is shown, not just the live one', async () => {
      const r = await get('/settings');
      assert.ok(r.json.tax.length >= 1);
      assert.ok(r.json.tax.some((v) => v.live), 'nothing is charging anybody');
    });

    test('a new rate is ADDED with a date, and the old one stays a fact', async () => {
      const soon = plusDays(30);
      const r = await req('POST', '/settings/tax', { code: 'GGST', rate: 16, from: soon });
      assert.equal(r.status, 200, r.text);
      const v = r.json.tax.find((x) => String(x.from).slice(0, 10) === soon);
      assert.equal(v.rate, 16);
      assert.equal(v.scheduled, true, 'a rate for next month is not charging anybody yet');
      assert.equal(v.live, false);
      /* And the 8% that has been charging all along is untouched. */
      assert.ok(r.json.tax.some((x) => x.rate === 8),
        "the old rate is what those receipts were rung up at and it does not move");
    });

    test('it cannot be backdated', async () => {
      const r = await req('POST', '/settings/tax',
        { code: 'GGST', rate: 20, from: plusDays(-7) });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /restate receipts/);
    });

    test('today is allowed — that is a rate change, not a restatement', async () => {
      const r = await req('POST', '/settings/tax', { code: 'TGST', rate: 17, from: today() });
      assert.equal(r.status, 200, r.text);
    });

    test('a manager may not set one', async () => {
      const r = await req('POST', '/settings/tax',
        { code: 'GGST', rate: 1, from: plusDays(60) }, mgr.token);
      assert.equal(r.status, 403);
    });
  });

  /* ── access ────────────────────────────────────────────────────────────── */

  describe('access', () => {
    test('the ladder shows which rungs have nobody on them', async () => {
      const r = await get('/access', mgr.token);
      assert.equal(r.status, 200);
      assert.equal(r.json.ladder.length, 5);
      const owner = r.json.ladder.find((l) => l.rank === 5);
      assert.equal(owner.people, 0, 'this outlet has no owner, and that is worth seeing');
      assert.ok(r.json.ladder.find((l) => l.rank === 4).people >= 1);
    });

    test('it lists the sessions that are open right now', async () => {
      const r = await get('/access');
      assert.ok(r.json.sessions.length >= 3, 'four people signed in during this file');
      const mine = r.json.sessions.find((s) => s.isMine);
      assert.ok(mine, 'the caller cannot see their own session');
      assert.equal(mine.rankName, 'Admin');
    });

    test('ending one actually ends it — which is new', async () => {
      /* Until migration 031 `revoked_at` was written by nothing and read by
         nothing. This is the test that it means something. */
      const victim = await H.addStaff(ctx, 'Someone Leaving', 2);
      const list = await get('/access');
      const s = list.json.sessions.find((x) => x.staffName === 'Someone Leaving');
      assert.ok(s);

      const still = await H.req('GET', `/api/outlet/${ctx.outletId}/staff/me`,
        { token: victim.token });
      assert.equal(still.status, 200, 'they were signed in a moment ago');

      const end = await req('POST', `/access/sessions/${s.id}/end`, {}, mgr.token);
      assert.equal(end.status, 200, end.text);

      const after = await H.req('GET', `/api/outlet/${ctx.outletId}/staff/me`,
        { token: victim.token });
      assert.equal(after.status, 401, 'the token outlived the session');
    });

    test('ending a session twice says so rather than pretending', async () => {
      const list = await get('/access');
      const s = list.json.sessions.find((x) => !x.isMine);
      await req('POST', `/access/sessions/${s.id}/end`, {});
      const again = await req('POST', `/access/sessions/${s.id}/end`, {});
      assert.equal(again.status, 404);
    });

    test('a cashier cannot see who is signed in', async () => {
      assert.equal((await get('/access', cashier.token)).status, 403);
    });
  });

  /* ── the trail ─────────────────────────────────────────────────────────── */

  describe('the audit log', () => {
    test('it is append-only because the privilege does not exist', async () => {
      const r = await get('/audit');
      assert.equal(r.json.appendOnly.enforced, 'no grant');
      await assert.rejects(
        () => H.q(ctx, "UPDATE chain.audit SET action = 'tampered' WHERE outlet_id = $1",
          [ctx.outletId]), /permission denied/);
      await assert.rejects(
        () => H.q(ctx, 'DELETE FROM chain.audit WHERE outlet_id = $1', [ctx.outletId]),
        /permission denied/);
    });

    test('filters narrow it, and the day filter includes its own day', async () => {
      const all = await get('/audit');
      assert.ok(all.json.entries.length > 0);
      const one = await get('/audit?action=outlet_settings');
      assert.ok(one.json.entries.length > 0);
      assert.ok(one.json.entries.every((e) => e.action === 'outlet_settings'));
      /* `at <= '<today>'` means midnight — a day filter reading "today to
         today" would return nothing that happened during it. */
      const day = await get(`/audit?from=${today()}&to=${today()}`);
      assert.ok(day.json.entries.length > 0, 'the day filter excluded its own day');
    });

    test('a text search reaches the action, the entity and the id', async () => {
      const r = await get('/audit?text=settings');
      assert.ok(r.json.entries.length > 0);
    });

    test('it pages by cursor, not by offset', async () => {
      const first = await get('/audit?limit=2');
      assert.equal(first.json.entries.length, 2);
      assert.ok(first.json.nextBefore, 'nothing to continue from');
      const second = await get(`/audit?limit=2&before=${first.json.nextBefore}`);
      const ids = new Set(first.json.entries.map((e) => e.id));
      /* OFFSET into a list that is still being written to silently skips and
         repeats rows. On an audit trail a missing row is the whole problem. */
      assert.ok(second.json.entries.every((e) => !ids.has(e.id)),
        'a page repeated an entry the previous page already had');
    });

    test('the filter chips are built from what is actually there', async () => {
      const r = await get('/audit/facets');
      assert.ok(r.json.actions.some((a) => a.value === 'outlet_settings'));
      assert.ok(r.json.entities.some((e) => e.value === 'outlet'));
      assert.ok(r.json.actors.length >= 1);
      assert.ok(r.json.actors.every((a) => a.label));
    });

    test('the export is a file, and it is itself in the trail', async () => {
      const r = await get('/audit.csv');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /text\/csv/);
      assert.match(r.headers['content-disposition'], /filename="audit-log\.csv"/);
      assert.match(r.text.split('\n')[0], /^id,at,actor/);

      const back = await get('/audit?action=audit_export');
      assert.ok(back.json.entries.length >= 1,
        'a copy of the audit log left the building and the audit log does not know');
    });

    test('a name beginning with = cannot become a formula', async () => {
      /* An audit trail is exactly where somebody's own typed text lands in a
         cell of its own — the actor's NAME does, on every row they touched.
         `=`, `+`, `-` and `@` each open a formula in Excel, Sheets and
         LibreOffice, and a trail is the last file that should execute
         anything when an accountant opens it. */
      const awkward = await H.addStaff(ctx, '=cmd|calc', 3);
      const list = await get('/access');
      const victim = list.json.sessions.find((x) => !x.isMine);
      await H.req('POST',
        `/api/outlet/${ctx.outletId}/access/sessions/${victim.id}/end`,
        { body: {}, token: awkward.token });

      const r = await get('/audit.csv?action=session_end');
      assert.ok(r.text.includes('"\'=cmd|calc"'),
        'the actor name went into the CSV as a live formula');
    });

    test('a cashier cannot read the trail', async () => {
      assert.equal((await get('/audit', cashier.token)).status, 403);
      assert.equal((await get('/audit.csv', cashier.token)).status, 403);
    });
  });
});
