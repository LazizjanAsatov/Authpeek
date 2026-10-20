// Encrypted account storage.
//   sync storage (follows the user's Google account):
//     "meta"        salt + password check
//     "acct:<id>"   one AES-GCM encrypted account each (keeps every item far below the 8 KB limit)
//     "settings"    plain preferences
//   session storage (memory only, cleared when the browser closes):
//     "vaultKey", "lastActive"
//   local storage (this computer only, never synced):
//     "vaultKey"    only while lockMinutes is NEVER ("don't ask for my password")
import { createVaultMeta, unlockVaultMeta, encryptJson, decryptJson, DEFAULT_ITERATIONS } from './crypto.js';

const DEFAULT_SETTINGS = { autoFill: true, autoSubmit: false, lockMinutes: 15, clockCheck: true };
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

  async function keyMatches(key) {
    try {
      await decryptJson(key, (await getMeta()).check);
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

  async function requireKey() {
    const key = await currentKey();
    if (!key) throw new Error('Vault is locked');
    await session.set({ lastActive: now() });
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

    async isSetUp() {
      return Boolean(await getMeta());
    },

    async isUnlocked() {
      return Boolean(await currentKey());
    },

    async setup(password) {
      if (await getMeta()) throw new Error('Vault already exists');
      const { meta, key } = await createVaultMeta(password, iterations);
      await sync.set({ meta });
      await startSession(key);
    },

    async unlock(password) {
      const meta = await getMeta();
      if (!meta) throw new Error('Vault is not set up');
      await startSession(await unlockVaultMeta(password, meta));
    },

    async listAccounts() {
      return readAll(await requireKey());
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

    async changePassword(oldPassword, newPassword) {
      const meta = await getMeta();
      const oldKey = await unlockVaultMeta(oldPassword, meta);
      const accounts = await readAll(oldKey);
      const created = await createVaultMeta(newPassword, iterations);
      const items = { meta: created.meta };
      for (const a of accounts) items[PREFIX + a.id] = await encryptJson(created.key, a);
      await sync.set(items);
      await startSession(created.key);
    },
  };
}
