'use strict';
/* ═══ WHY A MESSAGE DID NOT GO ══════════════════════════════════════════════
   A provisioned install sat on "Check your email" saying "No email is
   configured on this install yet" while RESEND_API_KEY and EMAIL_FROM were
   both set on the service. Three different situations were being rendered as
   one word — no transport, a dangling ${{reference}}, and a transport that
   ANSWERED AND REFUSED — and only the first of the three matches that
   sentence. For the other two it points whoever reads it at variables that are
   already correct.
   ═══════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const email = require('../src/email');

function withEnv(vars, fn) {
  const before = {};
  Object.keys(vars).forEach((k) => { before[k] = process.env[k]; process.env[k] = vars[k]; });
  return Promise.resolve().then(fn).finally(() => {
    Object.keys(before).forEach((k) => {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    });
    email._reset();
  });
}

test('an install with no transport says so, and nothing stronger', () =>
  withEnv({ RESEND_API_KEY: '', EMAIL_FROM: '' }, () => {
    const h = email.health();
    assert.strictEqual(h.ok, false);
    assert.match(h.reason, /no email transport is configured/);
  }));

test('a dangling platform reference is named as one, not as a missing setting', () =>
  withEnv({ RESEND_API_KEY: '${{kashikeyopos.RESEND_API_KEY}}',
    EMAIL_FROM: 'KashikeyoPOS <hello@example.mv>' }, () => {
    const h = email.health();
    assert.strictEqual(h.ok, false);
    assert.match(h.reason, /unresolved platform reference/,
      'the service name inside the braces is a five-second fix; "no key" is an afternoon');
    assert.doesNotMatch(h.reason, /no email transport is configured/);
  }));

/* A KEY ARRIVES WITH WHATEVER WAS AROUND IT. Pasted into a dashboard, copied
   out of a terminal, read off a page — a trailing newline or a stray space is
   the ordinary case, not the exotic one. Untrimmed it is not even a 401: a
   header value containing a newline makes fetch throw before the request is
   built, and the error talks about headers rather than about the key, which
   sends whoever reads it nowhere near the cause. */
test('a credential is what it is, not what it is surrounded by', async () =>
  withEnv({ RESEND_API_KEY: '  re_not_a_real_key\n',
    EMAIL_FROM: ' KashikeyoPOS <hello@example.mv> ' }, async () => {
    assert.strictEqual(email.health().ok, true,
      'whitespace around a key does not make an install unconfigured');

    const real = global.fetch;
    let sent = null;
    global.fetch = async (url, opts) => {
      sent = opts;
      return { status: 200, ok: true, headers: { get: () => null },
        text: async () => '{"id":"eml_1"}' };
    };
    try {
      await email.send({ to: 'a@b.mv', subject: 'x', text: 'y' });
    } finally { global.fetch = real; }

    assert.strictEqual(sent.headers.authorization, 'Bearer re_not_a_real_key',
      'and the header carries the key alone — a newline in a header value'
      + ' throws before the request is even built');
    assert.strictEqual(JSON.parse(sent.body).from, 'KashikeyoPOS <hello@example.mv>',
      'the From address the same way');
  }));

test('a transport that answered and refused is reported as a refusal', () =>
  withEnv({ RESEND_API_KEY: 're_not_a_real_key', EMAIL_FROM: 'x@example.mv' }, async () => {
    assert.strictEqual(email.health().ok, true, 'configured, and nothing tried yet');

    const real = global.fetch;
    global.fetch = async () => ({ status: 401, ok: false, headers: { get: () => null },
      text: async () => '{"message":"API key is invalid"}' });
    try {
      await assert.rejects(() => email.send({ to: 'a@b.mv', subject: 'x', text: 'y' }),
        /refused this install: 401/);
    } finally { global.fetch = real; }

    const h = email.health();
    assert.strictEqual(h.ok, false);
    assert.match(h.reason, /401/, "the transport's own answer, not our guess at it");
    assert.doesNotMatch(h.reason, /not configured|no email transport/,
      'the variables are set — saying otherwise sends somebody to check them for nothing');

    /* TWO AUDIENCES, AND THEY ARE NOT THE SAME SENTENCE. `reason` is what an
       anonymous caller is answered — /signup and /code are open to the
       internet, so a stranger typing any address into the form used to be
       handed the provider's own JSON, naming the transport and quoting its
       error word for word. That is the rule this build already keeps for the
       database and had not kept for the mail provider. `detail` is what the
       operator needs, and it goes where an operator looks: the trail, the log
       and the boot line. */
    assert.doesNotMatch(h.reason, /API key is invalid/,
      "the provider's own words are not owed to whoever POSTed an address");
    assert.doesNotMatch(h.reason, /\{|\}/, 'and its JSON even less so');
    assert.match(h.detail, /API key is invalid/,
      'but nothing is lost — the operator still gets the transport verbatim');
    assert.match(h.detail, /401/);
  }));

test('a refusal is install-wide, so reporting it tells nobody about anybody', () =>
  withEnv({ RESEND_API_KEY: 're_not_a_real_key', EMAIL_FROM: 'x@example.mv' }, async () => {
    const real = global.fetch;
    global.fetch = async () => ({ status: 403, ok: false, headers: { get: () => null },
      text: async () => '{"message":"domain is not verified"}' });
    try {
      await email.send({ to: 'known@example.mv', subject: 'x', text: 'y' }).catch(() => {});
    } finally { global.fetch = real; }

    /* health() is asked without naming an address, which is the whole point:
       /signup and /code can both answer with it and stay byte-identical
       whether or not the address is a customer here. */
    const a = email.health(), b = email.health();
    assert.deepStrictEqual(a, b);
    assert.match(a.reason, /refused this install \(HTTP 403\)/,
      'the class and the status, which is what the person waiting can act on');
    assert.match(a.detail, /domain is not verified/,
      'and the reason itself, for whoever runs the install');
  }));

test('a send that succeeds clears the install back to healthy', () =>
  withEnv({ RESEND_API_KEY: 're_not_a_real_key', EMAIL_FROM: 'x@example.mv' }, async () => {
    const real = global.fetch;
    global.fetch = async () => ({ status: 500, ok: false, headers: { get: () => null },
      text: async () => 'upstream had a moment' });
    try { await email.send({ to: 'a@b.mv', subject: 'x', text: 'y' }).catch(() => {}); }
    finally { global.fetch = real; }
    assert.strictEqual(email.health().ok, false, 'a bad minute is remembered');

    global.fetch = async () => ({ status: 200, ok: true, headers: { get: () => null },
      text: async () => '{"id":"eml_1"}' });
    try {
      const out = await email.send({ to: 'a@b.mv', subject: 'x', text: 'y' });
      assert.strictEqual(out.sent, true);
    } finally { global.fetch = real; }
    assert.strictEqual(email.health().ok, true, 'and not held against it afterwards');
  }));
