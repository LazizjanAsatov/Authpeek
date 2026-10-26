import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVault } from '../extension/lib/vault.js';

// Same shape as chrome.storage.sync / chrome.storage.session (promise API).
function memoryArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const list = keys == null ? [...data.keys()] : [].concat(keys);
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) data.delete(k); },
  };
}

const github = { issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' };
const stripe = { issuer: 'Stripe', label: 'ops', secret: 'GEZDGNBVGY3TQOJQ', digits: 6, period: 30, algorithm: 'SHA1' };

function setup() {
  const sync = memoryArea();
  const session = memoryArea();
  const local = memoryArea();
  return { sync, session, local, vault: createVault({ sync, session, local, iterations: 1000 }) };
}

// Chrome restarting: session memory is wiped, sync and local storage survive.
const restart = ({ sync, local }) => createVault({ sync, session: memoryArea(), local, iterations: 1000 });

test('a new vault is not set up and is locked', async () => {
  const { vault } = setup();
  assert.equal(await vault.isSetUp(), false);
  assert.equal(await vault.isUnlocked(), false);
});

test('setup creates the vault and leaves it unlocked', async () => {
  const { vault } = setup();
  await vault.setup('pw');
  assert.equal(await vault.isSetUp(), true);
  assert.equal(await vault.isUnlocked(), true);
});

test('accounts are stored encrypted in sync storage and read back when unlocked', async () => {
  const { vault, sync } = setup();
  await vault.setup('pw');
  const result = await vault.addAccounts([github, stripe]);
  assert.equal(result.added, 2);

  const raw = JSON.stringify([...sync.data.entries()]);
  assert.ok(!raw.includes(github.secret), 'secret must not be stored in plain text');

  const list = await vault.listAccounts();
  assert.deepEqual(list.map((a) => a.issuer), ['GitHub', 'Stripe']);
  assert.ok(list.every((a) => a.id && Array.isArray(a.sites)));
});

test('adding the same secret twice is reported as a duplicate', async () => {
  const { vault } = setup();
  await vault.setup('pw');
  await vault.addAccounts([github]);
  const result = await vault.addAccounts([github, stripe]);
  assert.deepEqual(result, { added: 1, duplicates: 1 });
});

test('a locked vault refuses to list accounts until unlocked with the right password', async () => {
  const { vault } = setup();
  await vault.setup('pw');
  await vault.addAccounts([github]);
  await vault.lock();
  await assert.rejects(vault.listAccounts(), /locked/i);
  await assert.rejects(vault.unlock('bad'), /wrong password/i);
  await vault.unlock('pw');
  assert.equal((await vault.listAccounts()).length, 1);
});

test('a second browser sharing the sync storage unlocks with the same password', async () => {
  const { vault, sync } = setup();
  await vault.setup('pw');
  await vault.addAccounts([github]);

  const otherBrowser = createVault({ sync, session: memoryArea(), iterations: 1000 });
  assert.equal(await otherBrowser.isSetUp(), true);
  await otherBrowser.unlock('pw');
  assert.equal((await otherBrowser.listAccounts())[0].issuer, 'GitHub');
});

test('updateAccount and deleteAccount change stored accounts', async () => {
  const { vault } = setup();
  await vault.setup('pw');
  await vault.addAccounts([github, stripe]);
  const [gh] = await vault.listAccounts();

  await vault.updateAccount(gh.id, { sites: ['github.com'], issuer: 'GitHub Inc' });
  let list = await vault.listAccounts();
  assert.deepEqual(list.find((a) => a.id === gh.id).sites, ['github.com']);
  assert.equal(list.find((a) => a.id === gh.id).issuer, 'GitHub Inc');

  await vault.deleteAccount(gh.id);
  list = await vault.listAccounts();
  assert.deepEqual(list.map((a) => a.issuer), ['Stripe']);
});

test('changePassword re-encrypts so only the new password works', async () => {
  const { vault } = setup();
  await vault.setup('old');
  await vault.addAccounts([github]);
  await assert.rejects(vault.changePassword('wrong', 'new'), /wrong password/i);
  await vault.changePassword('old', 'new');
  await vault.lock();
  await assert.rejects(vault.unlock('old'), /wrong password/i);
  await vault.unlock('new');
  assert.equal((await vault.listAccounts())[0].secret, github.secret);
});

test('the vault locks itself after the idle timeout', async () => {
  let clock = 0;
  const vault = createVault({ sync: memoryArea(), session: memoryArea(), iterations: 1000, now: () => clock });
  await vault.setup('pw');
  await vault.saveSettings({ lockMinutes: 5 });
  clock = 4 * 60_000;
  assert.equal(await vault.isUnlocked(), true);
  await vault.listAccounts(); // activity resets the idle timer
  clock = 8 * 60_000;
  assert.equal(await vault.isUnlocked(), true);
  clock = 14 * 60_000;
  assert.equal(await vault.isUnlocked(), false);
});

test('a lookup that is only looking does not restart the idle timer', async () => {
  let clock = 0;
  const vault = createVault({ sync: memoryArea(), session: memoryArea(), iterations: 1000, now: () => clock });
  await vault.setup('pw');
  await vault.saveSettings({ lockMinutes: 5 });
  clock = 4 * 60_000;
  await vault.listAccounts({ touch: false }); // a page asked, but it may not even be linked
  clock = 8 * 60_000;
  assert.equal(await vault.isUnlocked(), false);
});

test('touch() restarts the idle timer', async () => {
  let clock = 0;
  const vault = createVault({ sync: memoryArea(), session: memoryArea(), iterations: 1000, now: () => clock });
  await vault.setup('pw');
  await vault.saveSettings({ lockMinutes: 5 });
  clock = 4 * 60_000;
  await vault.touch(); // a code was filled
  clock = 8 * 60_000;
  assert.equal(await vault.isUnlocked(), true);
  clock = 14 * 60_000;
  assert.equal(await vault.isUnlocked(), false);
});

test('lockMinutes 0 keeps the vault unlocked until the browser closes', async () => {
  let clock = 0;
  const vault = createVault({ sync: memoryArea(), session: memoryArea(), iterations: 1000, now: () => clock });
  await vault.setup('pw');
  await vault.saveSettings({ lockMinutes: 0 });
  clock = 1e9;
  assert.equal(await vault.isUnlocked(), true);
});

test('a password change on another browser locks this one instead of failing', async () => {
  const { vault, sync } = setup();
  await vault.setup('old');
  await vault.addAccounts([github]);

  const otherBrowser = createVault({ sync, session: memoryArea(), iterations: 1000 });
  await otherBrowser.unlock('old');
  await otherBrowser.changePassword('old', 'new');

  await assert.rejects(vault.listAccounts(), /locked/i);
  assert.equal(await vault.isUnlocked(), false);
  await vault.unlock('new');
  assert.equal((await vault.listAccounts()).length, 1);
});

test('an entry that cannot be decrypted is skipped and kept, not fatal', async () => {
  const { vault, sync } = setup();
  await vault.setup('pw');
  await vault.addAccounts([github]);
  sync.data.set('acct:from-a-colliding-vault', { iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAA' });

  const list = await vault.listAccounts();
  assert.deepEqual(list.map((a) => a.issuer), ['GitHub']);
  assert.ok(sync.data.has('acct:from-a-colliding-vault'), 'unreadable data must not be deleted');
});

test('without "never ask" the key is not kept on disk and a restart locks', async () => {
  const env = setup();
  await env.vault.setup('pw');
  assert.equal(env.local.data.size, 0);
  assert.equal(await restart(env).isUnlocked(), false);
});

test('with "never ask" the vault stays unlocked after Chrome restarts', async () => {
  const env = setup();
  await env.vault.setup('pw');
  await env.vault.addAccounts([github]);
  await env.vault.saveSettings({ lockMinutes: -1 });

  const after = restart(env);
  assert.equal(await after.isUnlocked(), true);
  assert.equal((await after.listAccounts())[0].issuer, 'GitHub');
});

test('"never ask" ignores the idle timeout', async () => {
  let clock = 0;
  const env = setup();
  const vault = createVault({ sync: env.sync, session: env.session, local: env.local, iterations: 1000, now: () => clock });
  await vault.setup('pw');
  await vault.saveSettings({ lockMinutes: -1 });
  clock = 1e12;
  assert.equal(await vault.isUnlocked(), true);
});

test('another computer with "never ask" still needs the password once', async () => {
  const env = setup();
  await env.vault.setup('pw');
  await env.vault.saveSettings({ lockMinutes: -1 });

  const other = createVault({ sync: env.sync, session: memoryArea(), local: memoryArea(), iterations: 1000 });
  assert.equal(await other.isUnlocked(), false);
  await other.unlock('pw');
  assert.equal(await other.isUnlocked(), true);
});

test('turning "never ask" off forgets the saved key', async () => {
  const env = setup();
  await env.vault.setup('pw');
  await env.vault.saveSettings({ lockMinutes: -1 });
  await env.vault.saveSettings({ lockMinutes: 15 });
  assert.equal(env.local.data.size, 0);
  assert.equal(await restart(env).isUnlocked(), false);
});

test('locking by hand forgets the saved key until the next unlock', async () => {
  const env = setup();
  await env.vault.setup('pw');
  await env.vault.saveSettings({ lockMinutes: -1 });
  await env.vault.lock();
  assert.equal(await env.vault.isUnlocked(), false);
  assert.equal(await restart(env).isUnlocked(), false);

  await env.vault.unlock('pw');
  assert.equal(await restart(env).isUnlocked(), true);
});

test('a password change elsewhere also invalidates a saved "never ask" key', async () => {
  const env = setup();
  await env.vault.setup('old');
  await env.vault.saveSettings({ lockMinutes: -1 });
  const other = createVault({ sync: env.sync, session: memoryArea(), local: memoryArea(), iterations: 1000 });
  await other.unlock('old');
  await other.changePassword('old', 'new');

  const after = restart(env);
  assert.equal(await after.isUnlocked(), false);
  assert.equal(env.local.data.size, 0);
});

test('settings have defaults and can be changed', async () => {
  const { vault } = setup();
  assert.deepEqual(await vault.getSettings(), { autoFill: true, autoSubmit: false, lockMinutes: 15, clockCheck: true, theme: 'system' });
  await vault.saveSettings({ autoSubmit: true });
  assert.equal((await vault.getSettings()).autoSubmit, true);
});

test('the theme follows the system until one is chosen', async () => {
  const { vault } = setup();
  assert.equal((await vault.getSettings()).theme, 'system');
  await vault.saveSettings({ theme: 'dark' });
  assert.equal((await vault.getSettings()).theme, 'dark');
  // Settings saved before there was a theme still read as System.
  const { sync, vault: older } = setup();
  await sync.set({ settings: { autoFill: false } });
  assert.equal((await older.getSettings()).theme, 'system');
});
