import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVault } from '../extension/lib/vault.js';
import { decryptJson, encryptJson, unlockVaultMeta } from '../extension/lib/crypto.js';

function fakeArea() {
  const map = new Map();
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    map,
    async get(keys) {
      const out = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of map) out[k] = copy(v);
      } else {
        for (const k of Array.isArray(keys) ? keys : [keys]) if (map.has(k)) out[k] = copy(map.get(k));
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, copy(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

async function newVault(password = 'pw-one', wrapSync = (a) => a) {
  const sync = fakeArea();
  const vault = createVault({ sync: wrapSync(sync), session: fakeArea(), local: fakeArea(), iterations: 1000 });
  await vault.setup(password);
  return { vault, sync };
}

const policy = { entries: [{ value: '203.0.113.0/24', note: 'Office' }] };

test('fresh vault has an empty policy at revision 0', async () => {
  const { vault } = await newVault();
  assert.deepEqual(await vault.getPolicy(), { entries: [], rev: 0 });
});

test('policy survives lock and unlock', async () => {
  const { vault } = await newVault();
  await vault.setPolicy('pw-one', policy);
  await vault.lock();
  await vault.unlock('pw-one');
  assert.deepEqual(await vault.getPolicy(), { ...policy, rev: 1 });
  assert.equal(await vault.isUnlocked(), true);
});

test('setPolicy rejects a wrong password and changes nothing', async () => {
  const { vault } = await newVault();
  await assert.rejects(() => vault.setPolicy('wrong', policy), /wrong password/i);
  assert.deepEqual(await vault.getPolicy(), { entries: [], rev: 0 });
});

test('setPolicy rejects non-array entries', async () => {
  const { vault } = await newVault();
  await assert.rejects(() => vault.setPolicy('pw-one', { entries: 'x' }), Error);
});

test('getPolicy requires an unlocked vault', async () => {
  const { vault } = await newVault();
  await vault.lock();
  await assert.rejects(() => vault.getPolicy(), /locked/i);
});

test('policy survives a password change', async () => {
  const { vault } = await newVault();
  await vault.setPolicy('pw-one', policy);
  await vault.changePassword('pw-one', 'pw-two');
  await vault.lock();
  await vault.unlock('pw-two');
  assert.deepEqual(await vault.getPolicy(), { ...policy, rev: 2 });
});

test('disabling keeps the object form and bumps rev, and getPolicy reports that rev', async () => {
  const { vault, sync } = await newVault();
  await vault.setPolicy('pw-one', policy);
  await vault.setPolicy('pw-one', { entries: [] });
  const { meta } = await sync.get('meta');
  const key = await vaultKey(sync);
  assert.deepEqual(await decryptJson(key, meta.check), { v: 'otp-autofill-vault', rev: 2, policy: { entries: [] } });
  // Empty, but still the form AuthPeek before 1.3 can't read: settings keeps its note while rev > 0.
  assert.deepEqual(await vault.getPolicy(), { entries: [], rev: 2 });
});

test('non-empty policy stores the object form with rev', async () => {
  const { vault, sync } = await newVault();
  await vault.setPolicy('pw-one', policy);
  const { meta } = await sync.get('meta');
  assert.deepEqual(await decryptJson(await vaultKey(sync), meta.check), { v: 'otp-autofill-vault', rev: 1, policy });
});

test('rollback to the plain check is detected', async () => {
  const { vault, sync } = await newVault();
  const old = (await sync.get('meta')).meta;
  await vault.setPolicy('pw-one', policy);
  await sync.set({ meta: old });
  await assert.rejects(() => vault.getPolicy(), /rolled back/i);
});

test('rollback to an older object is detected', async () => {
  const { vault, sync } = await newVault();
  await vault.setPolicy('pw-one', policy);
  const old = (await sync.get('meta')).meta;
  await vault.setPolicy('pw-one', { entries: [] });
  await sync.set({ meta: old });
  await assert.rejects(() => vault.getPolicy(), /rolled back/i);
});

test('meta changed during setPolicy is refused', async () => {
  let armed = false;
  let reads = 0;
  const wrap = (area) => ({
    ...area,
    async get(keys) {
      const out = await area.get(keys);
      if (armed && keys === 'meta' && ++reads >= 2) out.meta = { ...out.meta, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' };
      return out;
    },
  });
  const { vault } = await newVault('pw-one', wrap);
  armed = true;
  await assert.rejects(() => vault.setPolicy('pw-one', policy), /changed/i);
});

test('concurrent setPolicy calls both land', async () => {
  const { vault, sync } = await newVault();
  const second = { entries: [{ value: '198.51.100.7', note: 'Home' }] };
  await Promise.all([vault.setPolicy('pw-one', policy), vault.setPolicy('pw-one', second)]);
  assert.deepEqual(await vault.getPolicy(), { ...second, rev: 2 });
  const { meta } = await sync.get('meta');
  assert.equal((await decryptJson(await vaultKey(sync), meta.check)).rev, 2);
});

test('invalid policies are rejected', async () => {
  const { vault } = await newVault();
  const many = { entries: Array.from({ length: 51 }, (_, i) => ({ value: '203.0.113.' + i, note: '' })) };
  await assert.rejects(() => vault.setPolicy('pw-one', many), /invalid policy/i);
  await assert.rejects(() => vault.setPolicy('pw-one', { entries: [{ value: 'x'.repeat(201), note: '' }] }), /invalid policy/i);
  await assert.rejects(() => vault.setPolicy('pw-one', { entries: [{ value: 'a' }] }), /invalid policy/i);
});

test('changePassword refuses a rolled-back meta and leaves it unchanged', async () => {
  const { vault, sync } = await newVault();
  const old = (await sync.get('meta')).meta;
  await vault.setPolicy('pw-one', policy);
  await sync.set({ meta: old });
  await assert.rejects(() => vault.changePassword('pw-one', 'pw-two'), /rolled back/i);
  assert.deepEqual((await sync.get('meta')).meta, old);
});

test('changePassword on a legacy vault keeps the plain check', async () => {
  const { vault, sync } = await newVault();
  await vault.changePassword('pw-one', 'pw-two');
  const { meta } = await sync.get('meta');
  assert.equal(await decryptJson(await unlockVaultMeta('pw-two', meta), meta.check), 'otp-autofill-vault');
});

test('a legacy vault (plain check string) unlocks with an empty policy', async () => {
  const { vault, sync } = await newVault();
  const { meta } = await sync.get('meta');
  meta.check = await encryptJson(await vaultKey(sync), 'otp-autofill-vault');
  await sync.set({ meta });
  await vault.lock();
  await vault.unlock('pw-one');
  assert.deepEqual(await vault.getPolicy(), { entries: [], rev: 0 });
});

test('tampering with meta.check breaks unlock', async () => {
  const { vault, sync } = await newVault();
  await vault.setPolicy('pw-one', policy);
  await vault.lock();
  const { meta } = await sync.get('meta');
  const ct = meta.check.ct;
  meta.check.ct = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
  await sync.set({ meta });
  await assert.rejects(() => vault.unlock('pw-one'), /wrong password/i);
});

async function vaultKey(sync) {
  return unlockVaultMeta('pw-one', (await sync.get('meta')).meta);
}

test('getPolicy({ touch: false }) reads without counting as use, so the idle lock still fires', async () => {
  let t = 1_000_000;
  const session = fakeArea();
  const vault = createVault({ sync: fakeArea(), session, local: fakeArea(), iterations: 1000, now: () => t });
  await vault.setup('pw-one'); // lockMinutes defaults to 15
  const started = (await session.get('lastActive')).lastActive;

  t += 10 * 60_000;
  assert.deepEqual(await vault.getPolicy({ touch: false }), { entries: [], rev: 0 });
  assert.equal((await session.get('lastActive')).lastActive, started);

  t += 6 * 60_000; // 16 minutes after the last real use
  await assert.rejects(vault.getPolicy({ touch: false }), /locked/i);
  assert.equal(await vault.isUnlocked(), false);
});

test('getPolicy() still counts as use by default', async () => {
  let t = 1_000_000;
  const session = fakeArea();
  const vault = createVault({ sync: fakeArea(), session, local: fakeArea(), iterations: 1000, now: () => t });
  await vault.setup('pw-one');
  t += 10 * 60_000;
  await vault.getPolicy();
  assert.equal((await session.get('lastActive')).lastActive, t);
  t += 6 * 60_000;
  assert.deepEqual(await vault.getPolicy({ touch: false }), { entries: [], rev: 0 });
});

test('a new vault does not inherit an earlier vault rollback mark on this computer', async () => {
  const sync = fakeArea();
  const local = fakeArea();
  const vault = createVault({ sync, session: fakeArea(), local, iterations: 1000 });
  await vault.setup('pw-one');
  await vault.setPolicy('pw-one', policy);
  await vault.setPolicy('pw-one', { entries: [] }); // the mark is now 2
  assert.equal((await local.get('policyRev')).policyRev, 2);

  sync.map.clear(); // sync data cleared (or the vault recreated)
  await vault.lock();
  await vault.setup('pw-new');
  assert.deepEqual(await vault.getPolicy(), { entries: [], rev: 0 }); // not "rolled back"
  await vault.changePassword('pw-new', 'pw-newer'); // not refused

  // Rollback detection still works for the new vault.
  const old = (await sync.get('meta')).meta;
  await vault.setPolicy('pw-newer', policy);
  await sync.set({ meta: old });
  await assert.rejects(() => vault.getPolicy(), /rolled back/i);
});
