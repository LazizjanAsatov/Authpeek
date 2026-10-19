// Shared helpers for turning a stored account into its current code.
import { decodeBase32 } from './base32.js';
import { generateTotp } from './totp.js';
import { createVault } from './vault.js';

export const codeFor = (account, timestamp = Date.now()) =>
  generateTotp({
    secret: decodeBase32(account.secret),
    digits: account.digits,
    period: account.period,
    algorithm: account.algorithm,
    timestamp,
  });

export const displayName = (a) => (a.issuer && a.label ? `${a.issuer} (${a.label})` : a.issuer || a.label || 'Account');

export const openVault = () => createVault({ sync: chrome.storage.sync, session: chrome.storage.session, local: chrome.storage.local });

// The username typed earlier in a tab's login (memory only, cleared when Chrome closes),
// used to tell apart several accounts on the same site.
const TYPED_TTL = 15 * 60_000;
const typedKey = (tabId) => `typed:${tabId}`;

export const rememberTyped = (tabId, value) =>
  chrome.storage.session.set({ [typedKey(tabId)]: { value, at: Date.now() } });

export async function typedUsername(tabId) {
  const entry = (await chrome.storage.session.get(typedKey(tabId)))[typedKey(tabId)];
  return entry && Date.now() - entry.at < TYPED_TTL ? entry.value : '';
}

export const forgetTyped = (tabId) => chrome.storage.session.remove(typedKey(tabId));
