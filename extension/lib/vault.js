// Encrypted account storage.
//   sync storage (follows the user's Google account):
//     "meta"        salt, iterations and the encrypted password check ("check"). The check is the
//                   plain marker, or { v, rev, policy } once Whitelisted IPs was used: the whitelist
//                   and its revision live inside it, so they can't be changed without the key
//                   (see crypto.js sealCheck/readCheck)
//     "acct:<id>"   one AES-GCM encrypted account each (keeps every item far below the 8 KB limit)
//     "settings"    plain preferences
//   session storage (memory only, cleared when the browser closes):
//     "vaultKey", "lastActive"
//   local storage (this computer only, never synced):
//     "vaultKey"    only while lockMinutes is NEVER ("don't ask for my password")
//     "policyRev"   the highest whitelist revision this computer has seen; a lower one in meta
//                   means an old meta was put back (rolled back). Cleared when a new vault is set up.
// (Other modules keep their own session keys: the network check cache, fill records, typed usernames.)
import { createVaultMeta, unlockVaultMeta, readCheck, sealCheck, validPolicy, encryptJson, decryptJson, DEFAULT_ITERATIONS } from './crypto.js';

const DEFAULT_SETTINGS = { autoFill: true, autoSubmit: false, lockMinutes: 15, clockCheck: true, theme: 'system' };
const PREFIX = 'acct:';
// lockMinutes: > 0 lock after that many idle minutes, 0 when Chrome closes, NEVER keep unlocked.
export const NEVER = -1;

const newId = () => crypto.randomUUID();
const byName = (a, b) =>
  a.issuer.localeCompare(b.issuer, undefined, { sensitivity: 'base' }) ||
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });

export function createVault({ sync, session, local = null, iterations = DEFAULT_ITERATIONS, now = Date.now }) {
  async function getMeta() {
    return (await sync.get('meta')).meta || null;
  }

  async function getSettings() {
    return { ...DEFAULT_SETTINGS, ...(await sync.get('settings')).settings };
  }

  async function saveSettings(patch) {
    await sync.set({ settings: { ...(await getSettings()), ...patch } });
    if ('lockMinutes' in patch) {
      const { vaultKey } = await session.get('vaultKey');
      await rememberKey(patch.lockMinutes === NEVER ? vaultKey : null);
    }
  }

  async function rememberKey(key) {
    if (!local) return;
    if (key) await local.set({ vaultKey: key });
    else await local.remove('vaultKey');
  }

  async function startSession(key) {
    await session.set({ vaultKey: key, lastActive: now() });
    if ((await getSettings()).lockMinutes === NEVER) await rememberKey(key);
  }

  async function lock() {
    await session.remove(['vaultKey', 'lastActive']);
    await rememberKey(null);
  }

  // Highest policy revision this computer has seen (never synced). A lower one means an old
  // meta was put back. Raises the mark; with strict, throws when the check is older than it.
  async function noteRev(rev, strict = false) {
    if (!local) return rev;
    const mark = (await local.get('policyRev')).policyRev || 0;
    if (rev > mark) await local.set({ policyRev: rev });
    else if (rev < mark && strict) throw new Error('The Whitelisted IPs list was rolled back. Set it again.');
    return Math.max(rev, mark);
  }

  // setPolicy and changePassword rewrite meta, so they run one at a time.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function keyMatches(key) {
    try {
      await readCheck(key, await getMeta());
      return true;
    } catch {
      return false; // password was changed on another browser
    }
  }

  async function currentKey() {
    let { vaultKey, lastActive } = await session.get(['vaultKey', 'lastActive']);
    const { lockMinutes } = await getSettings();
    if (!vaultKey && lockMinutes === NEVER && local) {
      vaultKey = (await local.get('vaultKey')).vaultKey; // kept from before Chrome restarted
      if (vaultKey) {
        lastActive = now();
        await session.set({ vaultKey, lastActive });
      }
    }
    if (!vaultKey) return null;
    const idle = lockMinutes > 0 && now() - lastActive > lockMinutes * 60_000;
    if (idle || !(await keyMatches(vaultKey))) {
      await lock();
      return null;
    }
    return vaultKey;
  }

  // Restart the idle timer: the user did something, or a code went to a page.
  async function touch() {
    await session.set({ lastActive: now() });
  }

  // Lookups the user didn't ask for pass { touch: false }: a page that may not even be
  // linked must not keep the vault open.
  async function requireKey({ touch: bump = true } = {}) {
    const key = await currentKey();
    if (!key) throw new Error('Vault is locked');
    if (bump) await touch();
    return key;
  }

  async function readAll(key) {
    const items = await sync.get(null);
    const accounts = [];
    for (const [k, box] of Object.entries(items)) {
      if (!k.startsWith(PREFIX)) continue;
      try {
        accounts.push(await decryptJson(key, box));
      } catch {
        // Written under a different password (e.g. two computers set up before sync
        // caught up). Leave it in storage so it can still be recovered.
      }
    }
    return accounts.sort(byName);
  }

  async function writeAccounts(key, accounts) {
    const items = {};
    for (const a of accounts) items[PREFIX + a.id] = await encryptJson(key, a);
    await sync.set(items);
  }

  return {
    getSettings,
    saveSettings,
    lock,
    touch,

    async isSetUp() {
      return Boolean(await getMeta());
    },

    async isUnlocked() {
      return Boolean(await currentKey());
    },

    async setup(password) {
      if (await getMeta()) throw new Error('Vault already exists');
      const { meta, key } = await createVaultMeta(password, iterations);
      // A new vault starts at revision 0; a mark left by an earlier vault on this computer
      // would make it look rolled back (codes hidden, password change refused).
      await local?.remove('policyRev');
      await sync.set({ meta });
      await startSession(key);
    },

    async unlock(password) {
      const meta = await getMeta();
      if (!meta) throw new Error('Vault is not set up');
      const key = await unlockVaultMeta(password, meta);
      await noteRev((await readCheck(key, meta)).rev);
      await startSession(key);
    },

    async listAccounts(options) {
      return readAll(await requireKey(options));
    },

    async addAccounts(list) {
      const key = await requireKey();
      const existing = new Set((await readAll(key)).map((a) => a.secret));
      const fresh = [];
      let duplicates = 0;
      for (const a of list) {
        if (existing.has(a.secret)) {
          duplicates++;
          continue;
        }
        existing.add(a.secret);
        fresh.push({ sites: [], ...a, id: newId(), createdAt: now() });
      }
      await writeAccounts(key, fresh);
      return { added: fresh.length, duplicates };
    },

    async updateAccount(id, patch) {
      const key = await requireKey();
      const box = (await sync.get(PREFIX + id))[PREFIX + id];
      if (!box) throw new Error('Account not found');
      const account = await decryptJson(key, box);
      await writeAccounts(key, [{ ...account, ...patch, id }]);
    },

    async deleteAccount(id) {
      await requireKey();
      await sync.remove(PREFIX + id);
    },

    // Returns { entries, rev }: the whitelist and its revision (0 for a vault that never had one;
    // above 0 the check is in the form AuthPeek before 1.3 can't read, even with no entries).
    // touch: false reads without counting as use (the same rule as listAccounts), so a
    // background re-check (an open popup, a page asking for a code) never keeps the vault from
    // locking when idle; an idle vault locks here instead.
    async getPolicy({ touch = true } = {}) {
      const key = await requireKey({ touch });
      const { policy, rev } = await readCheck(key, await getMeta());
      await noteRev(rev, true);
      return { entries: policy.entries, rev };
    },

    // The whitelist lives inside the encrypted check, so it can't be edited or removed without the key.
    setPolicy: (password, policy) => serial(async () => {
      if (!validPolicy(policy)) throw new Error('Invalid policy');
      const meta = await getMeta();
      if (!meta) throw new Error('Vault is not set up');
      const key = await unlockVaultMeta(password, meta);
      const fresh = await getMeta(); // key derivation is slow; another computer may have synced since
      if (!fresh || fresh.salt !== meta.salt || fresh.iterations !== meta.iterations) {
        throw new Error('Your password changed on another computer. Try again.');
      }
      const rev = (await noteRev((await readCheck(key, fresh)).rev)) + 1;
      await sync.set({ meta: { ...fresh, check: await sealCheck(key, policy, rev) } });
      await noteRev(rev);
      await startSession(key);
    }),

    changePassword: (oldPassword, newPassword) => serial(async () => {
      const meta = await getMeta();
      const oldKey = await unlockVaultMeta(oldPassword, meta);
      const accounts = await readAll(oldKey);
      const { policy, rev: old } = await readCheck(oldKey, meta);
      const mark = await noteRev(old, true); // refuses a rolled-back meta instead of re-sealing it
      const rev = old === 0 ? 0 : mark + 1; // legacy vaults keep the plain check
      const created = await createVaultMeta(newPassword, iterations, policy, rev);
      const items = { meta: created.meta };
      for (const a of accounts) items[PREFIX + a.id] = await encryptJson(created.key, a);
      await sync.set(items);
      await noteRev(rev);
      await startSession(created.key);
    }),
  };
}
