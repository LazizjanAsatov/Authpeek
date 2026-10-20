// Shared helpers for turning a stored account into its current code.
import { decodeBase32 } from './base32.js';
import { generateTotp } from './totp.js';
import { createVault } from './vault.js';
import { TIME_URL, offsetFromTrace, usableOffset, shouldCheck } from './clock.js';

// ---------- clock correction (see clock.js) ----------
// The measured error of this computer's clock, kept in local storage and shared by the
// popup, the background and the settings page.
const NO_CLOCK = { offset: 0, checkedAt: 0 };
let clock = NO_CLOCK;
const storage = globalThis.chrome?.storage;
const clockReady = storage
  ? storage.local.get('clock').then((r) => (clock = r.clock || NO_CLOCK), () => {})
  : Promise.resolve();
storage?.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.clock) clock = changes.clock.newValue || NO_CLOCK;
});

// "Now" as the rest of the world sees it.
export const correctedNow = () => Date.now() + clock.offset;
export const clockOffset = async () => (await clockReady, clock.offset);

export async function checkClock({ force = false } = {}) {
  await clockReady;
  if (!force && !shouldCheck(clock.checkedAt, Date.now())) return clock;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const sentAt = Date.now();
    const text = await (await fetch(TIME_URL, { cache: 'no-store', credentials: 'omit', signal: abort.signal })).text();
    const offset = offsetFromTrace(text, sentAt, Date.now());
    if (offset !== null) {
      clock = { offset: usableOffset(offset), checkedAt: Date.now() };
      await storage.local.set({ clock });
    }
  } catch {
    // Offline or blocked: keep the last measurement.
  } finally {
    clearTimeout(timer);
  }
  return clock;
}

export async function forgetClock() {
  clock = NO_CLOCK;
  await storage.local.remove('clock');
}

export async function codeFor(account, timestamp) {
  await clockReady;
  return generateTotp({
    secret: decodeBase32(account.secret),
    digits: account.digits,
    period: account.period,
    algorithm: account.algorithm,
    encoder: account.encoder,
    timestamp: timestamp ?? correctedNow(),
  });
}

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
