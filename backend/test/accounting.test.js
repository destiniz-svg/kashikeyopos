'use strict';
/* Accounting Flow — §2 (`accounting`), 08-BUILD-STAGES §22.
 *
 * The books have been write-only. Seven modules post to them and not one screen
 * has ever opened one, so this file is mostly about the two things a ledger has
 * that a list of postings does not: you can read it, and a mistake in it is
 * answered rather than erased.
 *
 * It also pins the seam that matters most. §2 lists the trial balance and the
 * P&L under this module, and the tempting reading is "so build them here" —
 * which would be a second arithmetic beside the one in reports.js, agreeing
 * right up until the day it does not. The test for that is at the bottom: the
 * accounting screen's figures and the reports screen's figures are the same
 * request.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('the accounting flow', () => {
  let ctx, mgr, admin, today, opening;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
    today = new Date().toISOString().slice(0, 10);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || admin.token });
  const get = (p, token) => req('GET', p, undefined, token);

  /* ── opening a book that has never been opened ────────────────────────── */

  test('an outlet that has posted nothing has an empty ledger, not an error', async () => {
    const r = await get('/accounting/journals', mgr.token);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.journals, []);
    assert.deepEqual(r.json.sources, []);
    assert.ok(r.json.accounts.length > 20, 'but the chart is there to post against');
  });

  test('the chart comes with the ledger, so an entry names accounts not codes', async () => {
    const r = await get('/accounting/journals', mgr.token);
    const wages = r.json.accounts.find((a) => a.code === '6000');
    assert.equal(wages.name, 'Wages');
    assert.equal(wages.type, 'expense');
  });

  /* ── the opening position ─────────────────────────────────────────────── */

  test('a restaurant that existed before today can state its opening position',
    async () => {
      /* 10-NO-DEMO-DATA: "capture it as a dated opening journal, so the trial
         balance is right from day one and the first month's P&L is not
         nonsense." Without this there is no way in but seeding something
         plausible, which is what that document forbids. */
      const r = await req('POST', '/accounting/journal', {
        date: today, memo: 'Opening balances at handover',
        lines: [
          { account: '1000', dr: 5000 },
          { account: '1100', dr: 20000 },
          { account: '3000', cr: 25000 },
        ],
      });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.amount, 25000);
      assert.ok(r.json.no, 'and it has a voucher number');
      opening = r.json;
    });

  test('the entry is in the ledger, with both sides and who posted it', async () => {
    const r = await get('/accounting/journals', mgr.token);
    const j = r.json.journals.find((x) => x.id === opening.id);
    assert.ok(j, 'the ledger can be read');
    assert.equal(j.memo, 'Opening balances at handover');
    assert.equal(j.source, 'manual');
    assert.equal(j.by, 'General Manager');
    assert.equal(j.lines.length, 3);
    /* The size of an entry is one side of it. 25,000 in and 25,000 out is an
       entry of 25,000, not 50,000. */
    assert.equal(j.amount, 25000);
  });

  test('and the trial balance now says the same thing', async () => {
    const r = await get(`/reports/trial-balance?from=${today}&to=${today}`, mgr.token);
    const cash = r.json.accounts.find((a) => a.code === '1000');
    const equity = r.json.accounts.find((a) => a.code === '3000');
    assert.equal(cash.balance, 5000);
    assert.equal(equity.balance, 25000, 'signed by its own normal side');
    assert.equal(r.json.balanced, true);
  });

  /* ── what it refuses, and why each refusal is a sentence ──────────────── */

  test('an entry that does not balance is refused WITH THE DIFFERENCE', async () => {
    /* The deferred trigger would catch this at COMMIT and say "journal does not
       balance" with no figures. Out-by is what lets somebody find the line they
       mistyped. */
    const r = await req('POST', '/accounting/journal', {
      date: today, memo: 'Fat fingers',
      lines: [{ account: '1000', dr: 100 }, { account: '3000', cr: 90 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /out by 10\.00/);
  });

  test('an account that is not in the chart is named, not hidden in a key', async () => {
    const r = await req('POST', '/accounting/journal', {
      date: today, memo: 'Somewhere else',
      lines: [{ account: '9999', dr: 100 }, { account: '1000', cr: 100 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /no account 9999 in the chart/);
  });

  test('a line that is both a debit and a credit is neither', async () => {
    const r = await req('POST', '/accounting/journal', {
      date: today, memo: 'Both at once',
      lines: [{ account: '1000', dr: 100, cr: 100 }, { account: '3000', cr: 100 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not both and not neither/);
  });

  test('a negative belongs on the other side', async () => {
    const r = await req('POST', '/accounting/journal', {
      date: today, memo: 'Minus one hundred',
      lines: [{ account: '1000', dr: -100 }, { account: '3000', cr: -100 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /put it there/);
  });

  test('an entry with one side is not an entry', async () => {
    const r = await req('POST', '/accounting/journal', {
      date: today, memo: 'Half a thought', lines: [{ account: '1000', dr: 100 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /at least two sides/);
  });

  test('a memo that says nothing is refused — somebody reads it in a year', async () => {
    const r = await req('POST', '/accounting/journal', {
      date: today, memo: 'x',
      lines: [{ account: '1000', dr: 100 }, { account: '3000', cr: 100 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /say what this entry is for/);
  });

  /* ── a mistake is answered, never erased ──────────────────────────────── */

  test('reversing needs a reason', async () => {
    const r = await req('POST', `/accounting/journal/${opening.id}/reverse`, { reason: '' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /say why/);
  });

  test('a reversal is a NEW entry with the sides swapped, and both stay', async () => {
    const before = await get('/accounting/journals', mgr.token);
    const r = await req('POST', `/accounting/journal/${opening.id}/reverse`,
      { reason: 'the handover figures were restated' });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.message, /Both entries stay in the ledger/);

    const after = await get('/accounting/journals', mgr.token);
    assert.equal(after.json.journals.length, before.json.journals.length + 1,
      'one more entry, not one fewer');

    const undone = after.json.journals.find((x) => x.id === opening.id);
    assert.equal(undone.reversedBy, r.json.id, 'and the original says what undid it');

    const back = after.json.journals.find((x) => x.id === r.json.id);
    assert.equal(back.source, 'reversal');
    assert.match(back.memo, /Reversal of .* — the handover figures were restated/);
    /* Swapped: what was a debit to cash is now a credit to it. */
    const cash = back.lines.find((l) => l.account === '1000');
    assert.equal(cash.cr, 5000);
    assert.equal(cash.dr, 0);
  });

  test('and the two cancel, so the trial balance is back where it started', async () => {
    const r = await get(`/reports/trial-balance?from=${today}&to=${today}`, mgr.token);
    const cash = r.json.accounts.find((a) => a.code === '1000');
    assert.equal(cash ? cash.balance : 0, 0);
    assert.equal(r.json.balanced, true);
  });

  test('the same entry cannot be reversed twice', async () => {
    const r = await req('POST', `/accounting/journal/${opening.id}/reverse`,
      { reason: 'again' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already been reversed/);
  });

  test('a reversal cannot itself be reversed — post the original again', async () => {
    const all = await get('/accounting/journals', mgr.token);
    const back = all.json.journals.find((x) => x.source === 'reversal');
    const r = await req('POST', `/accounting/journal/${back.id}/reverse`,
      { reason: 'undo the undo' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /itself a reversal/);
  });

  /* ── reading it back ──────────────────────────────────────────────────── */

  test('the ledger filters by source and by text', async () => {
    const bySource = await get('/accounting/journals?source=reversal', mgr.token);
    assert.ok(bySource.json.journals.length >= 1);
    assert.ok(bySource.json.journals.every((j) => j.source === 'reversal'));

    const byText = await get('/accounting/journals?q=handover', mgr.token);
    assert.ok(byText.json.journals.length >= 1);
    assert.ok(byText.json.journals.every((j) => /handover/i.test(j.memo)));
  });

  test('the source filter offers what has actually been posted', async () => {
    const r = await get('/accounting/journals', mgr.token);
    const kinds = r.json.sources.map((s) => s.source);
    assert.ok(kinds.includes('manual'));
    assert.ok(kinds.includes('reversal'));
    assert.ok(!kinds.includes('payroll'), 'and nothing that has not');
  });

  test('paging walks backwards through time without repeating a row', async () => {
    const first = await get('/accounting/journals?limit=1', mgr.token);
    assert.equal(first.json.journals.length, 1);
    assert.ok(first.json.next, 'there is more');
    const second = await get(
      `/accounting/journals?limit=1&before=${encodeURIComponent(first.json.next)}`, mgr.token);
    assert.equal(second.json.journals.length, 1);
    assert.notEqual(second.json.journals[0].id, first.json.journals[0].id);
  });

  /* ── what leaves the building ─────────────────────────────────────────── */

  test('the export is a file, one row per POSTING', async () => {
    const r = await H.req('GET',
      `/api/outlet/${ctx.outletId}/accounting/export?kind=journal&from=${today}&to=${today}`,
      { token: mgr.token });
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers['content-type'], /text\/csv/);
    assert.match(r.headers['content-disposition'], /attachment; filename="journal-/);
    const lines = r.text.trim().split('\n');
    assert.equal(lines[0], 'Voucher,Date,Account,Account name,Debit,Credit,Memo,Source,Posted by');
    assert.equal(lines.length, 1 + 6, 'three lines each of two entries');
    assert.match(r.text, /Opening balances at handover/);
  });

  test('a memo that looks like a formula is not one when the file opens', async () => {
    /* =cmd|... in a CSV cell is how an export becomes a way to run something on
       an accountant's machine. */
    await req('POST', '/accounting/journal', {
      date: today, memo: '=SUM(A1:A9) reconciliation note',
      lines: [{ account: '1000', dr: 1 }, { account: '3000', cr: 1 }],
    });
    const r = await H.req('GET',
      `/api/outlet/${ctx.outletId}/accounting/export?kind=journal&from=${today}&to=${today}`,
      { token: mgr.token });
    /* Prefixed with an apostrophe, so the cell is text. (No quoting needed —
       there is no comma in it; the apostrophe is the whole defence.) */
    assert.match(r.text, /,'=SUM\(A1:A9\) reconciliation note,/);
  });

  test('an export without a period is refused — a file is read as the month it says',
    async () => {
      const r = await H.req('GET',
        `/api/outlet/${ctx.outletId}/accounting/export?kind=journal`, { token: mgr.token });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /needs a from and a to date/);
    });

  test('the trial balance export is the SAME arithmetic as the screen', async () => {
    const screen = await get(`/reports/trial-balance?from=${today}&to=${today}`, mgr.token);
    const file = await H.req('GET',
      `/api/outlet/${ctx.outletId}/accounting/export?kind=trial&from=${today}&to=${today}`,
      { token: mgr.token });
    assert.equal(file.status, 200, file.text);
    const total = file.text.trim().split('\n').pop();
    assert.equal(total, `,TOTAL,,${screen.json.totals.dr.toFixed(2)},`
      + `${screen.json.totals.cr.toFixed(2)},${screen.json.totals.difference.toFixed(2)}`);
  });

  test('nothing exports as something that is not a report', async () => {
    const r = await H.req('GET',
      `/api/outlet/${ctx.outletId}/accounting/export?kind=everything&from=${today}&to=${today}`,
      { token: mgr.token });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /nothing exports as everything/);
  });

  /* ── who may do what ──────────────────────────────────────────────────── */

  test('a manager reads the books; only an admin writes to them by hand', async () => {
    assert.equal((await get('/accounting/journals', mgr.token)).status, 200);
    const r = await req('POST', '/accounting/journal', {
      date: today, memo: 'A manager tries it',
      lines: [{ account: '1000', dr: 10 }, { account: '3000', cr: 10 }],
    }, mgr.token);
    assert.equal(r.status, 403, 'writing straight into the ledger is admin');
    assert.equal(
      (await get('/accounting/journals', mgr.token)).json.canPost, false,
      'and the screen is told, so it does not offer a button that will fail');
  });

  test('a till session reaches none of it', async () => {
    const till = await H.addStaff(ctx, 'Cashier', 2);
    assert.equal((await get('/accounting/journals', till.token)).status, 403);
    const r = await H.req('GET',
      `/api/outlet/${ctx.outletId}/accounting/export?kind=journal&from=${today}&to=${today}`,
      { token: till.token });
    assert.equal(r.status, 403);
  });

  /* ── the seam this module exists not to duplicate ─────────────────────── */

  test('every account code the code posts to EXISTS in a provisioned outlet',
    async () => {
      /* The provisioning trap in its purest form: a module posts to 6400, the
         chart seed never learned about it, and the first entry of its kind dies
         on a foreign key at the worst possible moment — a payroll run, a
         month-end, a shift closing. Cheap to check, and it checks the shipped
         source rather than a list somebody keeps up to date. */
      const fs = require('node:fs');
      const path = require('node:path');
      const dir = path.join(__dirname, '..', 'src');
      const used = new Set();
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of text.matchAll(/'([1-6]\d{3})'/g)) used.add(m[1]);
      }
      const chart = await H.q(ctx, 'SELECT code FROM account');
      const have = new Set(chart.rows.map((r) => r.code));
      const missing = [...used].filter((c) => !have.has(c)).sort();
      assert.deepEqual(missing, [], 'these are posted to but never seeded');
    });
});
