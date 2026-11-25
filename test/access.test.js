import test from 'node:test';
import assert from 'node:assert/strict';
import { networkAccess, exportGate } from '../extension/lib/access.js';
import { EXPORT_REFUSED } from '../extension/lib/whitelist-ui.js';
import { codesForWindow, encodeShare, shareUrl } from '../extension/lib/share.js';

const vaultWith = (getPolicy) => ({ getPolicy });
const checker = (result) => ({ check: async () => result });

test('no whitelist: allowed', async () => {
  const r = await networkAccess(vaultWith(async () => ({ entries: [] })), {
    check: checker({ allowed: true, reason: 'off', ips: [] }),
  });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'off');
});

test('rolled-back whitelist fails closed', async () => {
  const r = await networkAccess(vaultWith(async () => { throw new Error('Whitelist was rolled back'); }), {
    check: checker({ allowed: true, reason: 'ok', ips: [] }),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'rolled-back');
});

test('a locked vault is reported as locked, not as a network problem', async () => {
  let checked = false;
  const r = await networkAccess(vaultWith(async () => { throw new Error('Vault is locked'); }), {
    check: { check: async () => { checked = true; return { allowed: true, reason: 'off', ips: [] }; } },
  });
  assert.deepEqual([r.allowed, r.reason, r.rev], [false, 'locked', 0]);
  assert.equal(checked, false); // no network lookup without the list
});

test('another policy error fails closed as error', async () => {
  const r = await networkAccess(vaultWith(async () => { throw new Error('Wrong password'); }));
  assert.deepEqual([r.allowed, r.reason], [false, 'error']);
});

test('rev comes through from getPolicy (0 when missing or odd)', async () => {
  const off = checker({ allowed: true, reason: 'off', ips: [] });
  assert.equal((await networkAccess(vaultWith(async () => ({ entries: [], rev: 3 })), { check: off })).rev, 3);
  assert.equal((await networkAccess(vaultWith(async () => ({ entries: [] })), { check: off })).rev, 0);
  assert.equal((await networkAccess(vaultWith(async () => ({ entries: [], rev: 'x' })), { check: off })).rev, 0);
  const boom = { check: async () => { throw new Error('boom'); } };
  assert.equal((await networkAccess(vaultWith(async () => ({ entries: [], rev: 2 })), { check: boom })).rev, 2);
});

test('checker throwing fails closed', async () => {
  const r = await networkAccess(vaultWith(async () => ({ entries: [{ value: '203.0.113.0/24', note: '' }] })), {
    check: { check: async () => { throw new Error('boom'); } },
  });
  assert.deepEqual([r.allowed, r.reason], [false, 'error']);
});

test('only a literal true allows', async () => {
  const r = await networkAccess(vaultWith(async () => ({ entries: [{ value: '203.0.113.0/24', note: '' }] })), {
    check: checker({ allowed: 'yes', reason: 'ok', ips: ['203.0.113.9'] }),
  });
  assert.equal(r.allowed, false);
});

test('touch is passed through to getPolicy (default true)', async () => {
  const seen = [];
  const vault = { getPolicy: async (opts) => { seen.push(opts); return { entries: [] }; } };
  const check = checker({ allowed: true, reason: 'off', ips: [] });
  await networkAccess(vault, { check });
  await networkAccess(vault, { touch: false, check });
  assert.deepEqual(seen, [{ touch: true }, { touch: false }]);
});

// Share links hand out codes, so the popup makes them through exportGate, like backups.
const ACCOUNT = { issuer: 'GitHub', label: 'alice', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' };
const makeShare = (calls) => async () => {
  calls.made++;
  const payload = await codesForWindow(ACCOUNT, 1_700_000_000_000, 5);
  return { payload, url: shareUrl(await encodeShare(payload)) };
};

test('share gate: on a whitelisted network (or with no list) the link is made', async () => {
  for (const result of [{ allowed: true, reason: 'off', ips: [] }, { allowed: true, reason: 'ok', ips: ['203.0.113.9'] }]) {
    const calls = { made: 0 };
    const r = await exportGate(vaultWith(async () => ({ entries: [] })), makeShare(calls), { check: checker(result) });
    assert.equal(calls.made, 1);
    assert.equal(r.refused, undefined);
    assert.match(r.value.url, /#v1\./);
  }
});

test('share gate: off the list, rolled back, locked or failed, nothing is made and the export words are used', async () => {
  const cases = [
    [vaultWith(async () => ({ entries: [{ value: '203.0.113.0/24', note: '' }] })), checker({ allowed: false, reason: 'not-listed', ips: ['198.51.100.1'] }), EXPORT_REFUSED],
    [vaultWith(async () => { throw new Error('The Whitelisted IPs list was rolled back. Set it again.'); }), checker({ allowed: true, reason: 'ok', ips: [] }), /changed without your password/],
    [vaultWith(async () => { throw new Error('Vault is locked'); }), checker({ allowed: true, reason: 'off', ips: [] }), /AuthPeek is locked/],
    [vaultWith(async () => ({ entries: [{ value: '203.0.113.0/24', note: '' }] })), { check: async () => { throw new Error('offline'); } }, /couldn't check your network/],
    [vaultWith(async () => ({ entries: [{ value: '203.0.113.0/24', note: '' }] })), checker({ allowed: 'yes', reason: 'ok', ips: [] }), /couldn't check your network/],
  ];
  for (const [vault, check, words] of cases) {
    const calls = { made: 0 };
    const r = await exportGate(vault, makeShare(calls), { check });
    assert.equal(calls.made, 0);
    assert.equal(r.value, undefined);
    if (typeof words === 'string') assert.equal(r.refused, words);
    else assert.match(r.refused, words);
    assert.equal(r.access.allowed, false);
  }
});

test('share gate: touch is passed through, so making a link can leave the idle timer alone', async () => {
  const seen = [];
  const vault = { getPolicy: async (opts) => { seen.push(opts); return { entries: [] }; } };
  await exportGate(vault, async () => 1, { touch: false, check: checker({ allowed: true, reason: 'off', ips: [] }) });
  assert.deepEqual(seen, [{ touch: false }]);
});
