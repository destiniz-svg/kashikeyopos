'use strict';
/* Sync & Devices — 08-BUILD-STAGES §28.
 *
 * `chain.device` had existed since the first migration and had never held a
 * row. Sign-in took `deviceId` from the request body and stamped it into the
 * session and the JWT unchecked — no such row need have existed, it need not
 * have belonged to this outlet, and `revoked` was a column nothing ever read.
 * The tests below are mostly about that column meaning something.
 *
 * The other half is the diagnostics, and the thing worth testing there is what
 * the screen REFUSES to claim: the server cannot see a till's outbox, and the
 * payload has to say so rather than report a confident zero.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('devices', () => {
  let ctx, mgr, cashier;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    cashier = await H.addStaff(ctx, 'A Cashier', 2);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || mgr.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const claim = (body, outlet) =>
    H.req('POST', `/api/outlet/${outlet || ctx.outletId}/devices/claim`, { body });

  test('an outlet with no devices says so rather than erroring', async () => {
    const r = await get('/devices');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.devices, []);
    assert.equal(r.json.paired, 0);
    /* The honest one. A zero here would be a lie the screen tells confidently. */
    assert.equal(r.json.outbox.known, false);
    assert.match(r.json.outbox.why, /cannot count what has not reached it/);
  });

  test('a cashier may look, and may not add', async () => {
    assert.equal((await get('/devices', cashier.token)).status, 200);
    assert.equal(
      (await req('POST', '/devices', { label: 'Sneaky', kind: 'till' }, cashier.token)).status,
      403);
  });

  test('a device needs a label and a kind that exists', async () => {
    assert.equal((await req('POST', '/devices', { label: '', kind: 'till' })).status, 400);
    assert.equal((await req('POST', '/devices', { label: 'X', kind: 'toaster' })).status, 400);
  });

  describe('pairing', () => {
    let device;

    before(async () => {
      const r = await req('POST', '/devices', { label: 'Front counter', kind: 'till' });
      assert.equal(r.status, 201, r.text);
      device = r.json;
    });

    test('a new device arrives with a code somebody can read aloud', () => {
      assert.match(device.code, /^[A-HJ-NP-Z2-9]{6}$/,
        'no I, O, 0 or 1 — it gets read across a kitchen');
      assert.ok(device.expires, 'a code that never expires is a password');
    });

    test('the wrong code is refused, and says nothing about why', async () => {
      const r = await claim({ code: 'ZZZZZZ' });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'that pairing code is not valid here');
    });

    test("another outlet's code is not valid here either", async () => {
      /* Same message, deliberately: expired, revoked, elsewhere and never
         existed must be indistinguishable from outside. */
      const other = await H.bootOutlet();
      try {
        const r = await claim({ code: device.code }, other.outletId);
        assert.equal(r.status, 400);
        assert.equal(r.json.error, 'that pairing code is not valid here');
      } finally { /* the other outlet's server is the same process */ }
    });

    test('claiming it returns the device id and needs no session', async () => {
      const r = await claim({ code: device.code, platform: 'test-runner', appVersion: '1.0.0' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.id, device.id, 'the record IS the identifier — there is no second one');
      assert.equal(r.json.label, 'Front counter');
    });

    test('a pairing code is single use', async () => {
      const again = await claim({ code: device.code });
      assert.equal(again.status, 400);
    });

    test('and the list now shows it paired, with what it said it is', async () => {
      const r = await get('/devices');
      const d = r.json.devices.find((x) => x.id === device.id);
      assert.ok(d.pairedAt);
      assert.equal(d.platform, 'test-runner');
      assert.equal(d.appVersion, '1.0.0');
      assert.equal(d.pairCode, null, 'a spent code is not left on the screen');
      assert.equal(r.json.paired, 1);
    });

    test('signing in on it binds the session to it', async () => {
      const r = await H.req('POST', '/api/auth/pin',
        { body: { outletId: ctx.outletId, pin: mgr.pin, deviceId: device.id } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.device, { id: device.id, label: 'Front counter' });
    });

    test('an UNKNOWN device id is not an error — an unpaired till still works', async () => {
      const r = await H.req('POST', '/api/auth/pin',
        { body: { outletId: ctx.outletId, pin: mgr.pin, deviceId: H.uuid() } });
      assert.equal(r.status, 200, 'refusing this would strand a new machine mid-service');
      assert.equal(r.json.device, null, 'and it is bound to nothing');
    });

    test('the ops it sends are attributable to it', async () => {
      const s = await H.req('POST', '/api/auth/pin',
        { body: { outletId: ctx.outletId, pin: mgr.pin, deviceId: device.id } });
      await H.req('POST', `/api/outlet/${ctx.outletId}/sync/push`, {
        token: s.json.token,
        body: { ops: [{ opId: H.uuid(), kind: 'drawer_open', at: Date.now(),
          payload: { float: 0 } }] },
      });
      const r = await get('/devices');
      const d = r.json.devices.find((x) => x.id === device.id);
      assert.ok(d.ops >= 1, 'every op_log row carried a null device before this');
      assert.ok(d.lastOpAt);
      assert.equal(typeof d.clockOffsetSecs, 'number');
    });

    test('revoking it ends the sessions it is holding', async () => {
      const live = await H.req('POST', '/api/auth/pin',
        { body: { outletId: ctx.outletId, pin: cashier.pin, deviceId: device.id } });
      assert.equal(live.status, 200);

      const r = await req('POST', `/devices/${device.id}/revoke`);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.sessionsEnded >= 1,
        'a till lost at 19:00 must not keep selling until its token expires');

      /* The session it was holding is dead NOW, not at midnight. */
      const after = await H.req('GET', `/api/outlet/${ctx.outletId}/devices`,
        { token: live.json.token });
      assert.equal(after.status, 401);
    });

    test('and it cannot sign in again — with a message about the DEVICE', async () => {
      const r = await H.req('POST', '/api/auth/pin',
        { body: { outletId: ctx.outletId, pin: mgr.pin, deviceId: device.id } });
      assert.equal(r.status, 403);
      assert.match(r.json.error, /revoked/);
      /* Not "PIN not recognised". A cashier retyping a correct PIN until they
         are locked out is what that message would cause. */
      assert.doesNotMatch(r.json.error, /PIN/);
    });

    test('restoring it makes it pair again rather than walk back in', async () => {
      const r = await req('POST', `/devices/${device.id}/restore`);
      assert.equal(r.status, 200, r.text);
      assert.match(r.json.code, /^[A-HJ-NP-Z2-9]{6}$/);
      const list = await get('/devices');
      const d = list.json.devices.find((x) => x.id === device.id);
      assert.equal(d.revoked, false);
      assert.equal(d.pairedAt, null, 'restored is not paired — somebody types the code');
    });

    test('a revoked device is refused BEFORE it is restored, not after', async () => {
      /* Ordering matters: the previous test restored it, so it signs in again
         and the refusal above was about the revocation, not about the id. */
      const r = await H.req('POST', '/api/auth/pin',
        { body: { outletId: ctx.outletId, pin: mgr.pin, deviceId: device.id } });
      assert.equal(r.status, 200);
    });

    test('renaming it is a manager act and shows on the list', async () => {
      assert.equal(
        (await req('PATCH', `/devices/${device.id}`, { label: 'Nope' }, cashier.token)).status,
        403);
      await req('PATCH', `/devices/${device.id}`, { label: 'Back counter', note: 'by the pass' });
      const list = await get('/devices');
      const d = list.json.devices.find((x) => x.id === device.id);
      assert.equal(d.label, 'Back counter');
      assert.equal(d.note, 'by the pass');
    });

    test('every one of those acts is in the audit trail', async () => {
      const r = await H.asOwner(ctx,
        "SELECT action FROM chain.audit WHERE entity = 'device' AND outlet_id = $1",
        [ctx.outletId]);
      const actions = new Set(r.rows.map((x) => x.action));
      for (const a of ['device_add', 'device_revoke', 'device_restore', 'device_rename']) {
        assert.ok(actions.has(a), a + ' left no trace');
      }
    });
  });
});
