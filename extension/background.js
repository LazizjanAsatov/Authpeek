// Service worker: answers content scripts that found a code field, and handles the
// keyboard shortcut and the right-click menu. The decisions themselves live in
// lib/gate.js (tested): codes only go to sites the user linked, only on a whitelisted
// network (when Whitelisted IPs is on), and an automatic fill happens at most once per
// account and site in 10 minutes, so a site that rejects a code and reloads can't make
// AuthPeek lock the account.
import { manualPickPatch } from './lib/identity.js';
import { menuItems, FILL_SITE, UNLOCK, accountIdFromMenu } from './lib/menus.js';
import { codeFor, fillMoment, openVault, rememberTyped, typedUsername, forgetTyped } from './lib/codes.js';
import { createAttempts } from './lib/attempts.js';
import { networkAccess } from './lib/access.js';
import { createGate, cleanHints, fillMessage, statusMessage, stepInfo } from './lib/gate.js';

const vault = openVault();
// Session storage: survives page reloads and service-worker restarts, gone when Chrome closes.
// Content scripts can't read it (default access level), so a page can't reset it.
const attempts = createAttempts({ storage: chrome.storage.session, now: () => Date.now() });

const AMBER = '#D98C0B';
const GREY = '#6B7280';

function badge(tabId, text, color = AMBER) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function badgeFor(tabId, status) {
  if (status === 'locked') badge(tabId, '•••');
  else if (status === 'choose') badge(tabId, '?');
  else if (status === 'suggest') badge(tabId, '!', AMBER);
  else if (status === 'network') badge(tabId, 'IP', GREY);
  else if (status === 'fill' || status === 'card-closed') badge(tabId, '');
}

// The code for `account` right now, the TOTP step it belongs to (what attempt records hold
// instead of the code) and the seconds until the next one, all from one timestamp. With
// "Check my computer's clock" on, the clock is measured first (at most a moment's wait).
async function codeNow(account, settings) {
  const ts = await fillMoment(settings ?? (await vault.getSettings()));
  return { code: await codeFor(account, ts), ...stepInfo(ts, account.period) };
}

const gate = createGate({
  vault,
  networkAccess: (v, options) => networkAccess(v, options),
  attempts,
  codeNow,
  typedUsername,
  runtimeId: chrome.runtime.id,
  badge: badgeFor,
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;

  if (msg?.type === 'otp:username') {
    if (typeof msg.value === 'string' && msg.value.trim()) rememberTyped(sender.tab.id, msg.value.trim().slice(0, 200));
    return false;
  }

  // otp:found (automatic), otp:fill-suggested (the card's trusted click), otp:card-filled
  // (the card's fill happened), otp:card-closed.
  const reply = gate.onContentMessage(msg, sender);
  if (!reply) return false;
  reply.then((r) => sendResponse(r ?? undefined), () => sendResponse({ status: 'error' }));
  return true; // async response
});

// A new page load clears the badge.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') badge(tabId, '');
});
chrome.tabs.onRemoved.addListener((tabId) => forgetTyped(tabId));

// ---------- right-click menu ----------

async function rebuildMenus() {
  const unlocked = (await vault.isSetUp()) && (await vault.isUnlocked());
  // Runs whenever the worker wakes, so it must not count as activity.
  const accounts = unlocked ? await vault.listAccounts({ touch: false }) : [];
  await chrome.contextMenus.removeAll();
  for (const item of menuItems({ unlocked, accounts })) {
    chrome.contextMenus.create({ contexts: ['editable'], ...item }, () => void chrome.runtime.lastError);
  }
}
let menuTimer = null;
const scheduleMenus = () => {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => rebuildMenus().catch(() => {}), 250);
};
chrome.runtime.onInstalled.addListener(scheduleMenus);
chrome.runtime.onStartup.addListener(scheduleMenus);

// A first install gets the welcome page once; updates and browser restarts don't. The flag
// covers browsers that load the extension afresh on every start (test runs, --load-extension),
// which report each start as an install. Uninstalling clears local storage, so a real
// reinstall still gets the page.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  if ((await chrome.storage.local.get('welcomed')).welcomed) return;
  await chrome.storage.local.set({ welcomed: true });
  chrome.tabs.create({ url: 'welcome.html' }).catch(() => {});
});
// Account names appear in the menu only while unlocked; follow locking and edits.
chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if (area === 'session' && keys.includes('vaultKey')) scheduleMenus();
  if (area === 'sync' && keys.some((k) => k === 'meta' || k.startsWith('acct:'))) scheduleMenus();
});
scheduleMenus();

// Every fill message names the host the code was resolved for; the content script in that
// frame refuses it if it is on another host (the frame navigated, or it's the wrong frame).
const sendFill = (tabId, frameId, result, extra = {}) =>
  chrome.tabs.sendMessage(tabId, { ...fillMessage(result), ...extra }, { frameId }).catch(() => null);

const openPopup = () => chrome.action.openPopup().catch(() => {});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === UNLOCK || !(await vault.isUnlocked())) return openPopup();

  const frameId = info.frameId ?? 0;
  // The URL of the frame that was right-clicked (the one that will get the code).
  const url = frameId ? info.frameUrl : info.frameUrl || info.pageUrl || tab.url;

  if (info.menuItemId === FILL_SITE) {
    const status = await chrome.tabs.sendMessage(tab.id, statusMessage(url), { frameId }).catch(() => null);
    const result = await gate
      .resolveForUrl(url, { tabId: tab.id, hints: cleanHints(status?.hints) })
      .catch(() => ({ status: 'error' }));
    if (result.status === 'fill') {
      const reply = await sendFill(tab.id, frameId, result, { useContextTarget: true });
      if (reply?.filled) await gate.recordManual(result);
      return;
    }
    badgeFor(tab.id, result.status);
    return openPopup(); // not linked, several accounts, off-network...: the popup explains
  }

  const account = (await vault.listAccounts()).find((a) => a.id === accountIdFromMenu(info.menuItemId));
  if (!account) return;
  const result = await gate.resolveAccount(account, url).catch(() => ({ status: 'error' }));
  if (result.status !== 'fill') {
    badgeFor(tab.id, result.status);
    return openPopup();
  }
  const reply = await sendFill(tab.id, frameId, result, { useContextTarget: true });
  if (!reply?.filled) return;
  await gate.recordManual(result);
  // A hand pick teaches auto-fill, same as choosing in the popup.
  const patch = manualPickPatch(account, result.host, await typedUsername(tab.id));
  if (patch) await vault.updateAccount(account.id, patch);
});

// Alt+Shift+O: fill the right account's code in the top frame, or open the popup.
// Only frame 0 is asked and filled: an embedded (possibly third-party) frame never gets a
// code resolved for the top page's site.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-code' || !tab?.id) return;
  const status = await chrome.tabs.sendMessage(tab.id, statusMessage(tab.url), { frameId: 0 }).catch(() => null);
  const result = await gate
    .resolveForUrl(tab.url, { tabId: tab.id, hints: cleanHints(status?.hints) })
    .catch(() => ({ status: 'error' }));
  if (result.status === 'fill') {
    // The top frame fills its detected field, or the focused box; no box -> not filled.
    const reply = await sendFill(tab.id, 0, result);
    if (reply?.filled) return gate.recordManual(result);
  } else {
    badgeFor(tab.id, result.status);
  }
  openPopup();
});
