// Service worker: answers content scripts that found a code field, and handles the
// keyboard shortcut. Codes are only handed to pages whose site the user linked.
import { hostOf, accountsForHost } from './lib/sites.js';
import { pickAccount, manualPickPatch } from './lib/identity.js';
import { menuItems, FILL_SITE, UNLOCK, accountIdFromMenu } from './lib/menus.js';
import { codeToFill, displayName, openVault, rememberTyped, typedUsername, forgetTyped } from './lib/codes.js';

const vault = openVault();

function badge(tabId, text, color = '#D98C0B') {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text });
  if (text) chrome.action.setBadgeBackgroundColor({ tabId, color });
}

// Decide what a page asking for a code should get. `url` is the URL of the frame
// that holds the field, taken from Chrome (never from the page's own message).
// When several accounts are linked, the username typed in this tab and usernames
// shown on the page decide; if they can't, the user is asked.
async function resolveForUrl(url, { tabId, hints = [], force = false } = {}) {
  const host = hostOf(url);
  if (!host || !(await vault.isSetUp())) return { status: 'none' };

  const settings = await vault.getSettings();
  if (!settings.autoFill && !force) return { status: 'off' };
  if (!(await vault.isUnlocked())) return { status: 'locked' };

  const accounts = await vault.listAccounts();
  const linked = accountsForHost(accounts, host);
  if (!linked.length) return { status: 'choose', count: 0 };

  const others = accounts.filter((a) => !linked.includes(a));
  const { account } = pickAccount({ linked, others, hints, typed: await typedUsername(tabId) });
  if (!account) return { status: 'choose', count: linked.length };

  return { status: 'fill', code: await codeToFill(account, settings), name: displayName(account), autoSubmit: settings.autoSubmit };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  const tabId = sender.tab.id;

  if (msg?.type === 'otp:username') {
    if (typeof msg.value === 'string' && msg.value.trim()) rememberTyped(tabId, msg.value.trim().slice(0, 200));
    return false;
  }
  if (msg?.type !== 'otp:found') return false;

  const hints = Array.isArray(msg.hints) ? msg.hints.filter((h) => typeof h === 'string').slice(0, 20) : [];
  resolveForUrl(sender.url, { tabId, hints, force: msg.force })
    .then((result) => {
      if (result.status === 'locked') badge(tabId, '•••');
      else if (result.status === 'choose') badge(tabId, '?');
      else if (result.status === 'fill') badge(tabId, '');
      sendResponse(result);
    })
    .catch((err) => sendResponse({ status: 'error', message: err.message }));
  return true; // async response
});

// A new page load clears the "this page wants a code" badge.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') badge(tabId, '');
});
chrome.tabs.onRemoved.addListener((tabId) => forgetTyped(tabId));

// ---------- right-click menu ----------

async function rebuildMenus() {
  const unlocked = (await vault.isSetUp()) && (await vault.isUnlocked());
  const accounts = unlocked ? await vault.listAccounts() : [];
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
// Account names appear in the menu only while unlocked; follow locking and edits.
chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if (area === 'session' && keys.includes('vaultKey')) scheduleMenus();
  if (area === 'sync' && keys.some((k) => k === 'meta' || k.startsWith('acct:'))) scheduleMenus();
});
scheduleMenus();

const sendFill = (tabId, frameId, payload) =>
  chrome.tabs.sendMessage(tabId, { type: 'otp:fill', useContextTarget: true, ...payload }, { frameId }).catch(() => null);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const openPopup = () => chrome.action.openPopup().catch(() => {});
  if (info.menuItemId === UNLOCK || !(await vault.isUnlocked())) return openPopup();

  const frameId = info.frameId ?? 0;
  const url = info.frameUrl || info.pageUrl || tab.url;

  if (info.menuItemId === FILL_SITE) {
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'otp:status' }, { frameId }).catch(() => null);
    const result = await resolveForUrl(url, { tabId: tab.id, hints: status?.hints, force: true });
    if (result.status === 'fill') return sendFill(tab.id, frameId, result);
    return openPopup(); // not linked, or several accounts and no way to tell: let the user pick
  }

  const account = (await vault.listAccounts()).find((a) => a.id === accountIdFromMenu(info.menuItemId));
  if (!account) return;
  const { autoSubmit, clockCheck } = await vault.getSettings();
  const reply = await sendFill(tab.id, frameId, { code: await codeToFill(account, { clockCheck }), name: displayName(account), autoSubmit });
  // A hand pick teaches auto-fill, same as choosing in the popup.
  const patch = reply?.filled && manualPickPatch(account, hostOf(url), await typedUsername(tab.id));
  if (patch) await vault.updateAccount(account.id, patch);
});

// Alt+Shift+O: fill the right account's code, or open the popup to pick one.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-code' || !tab?.id) return;
  const status = await chrome.tabs.sendMessage(tab.id, { type: 'otp:status' }).catch(() => null);
  const result = await resolveForUrl(tab.url, { tabId: tab.id, hints: status?.hints, force: true }).catch(() => ({
    status: 'error',
  }));
  if (result.status === 'fill') {
    const reply = await chrome.tabs
      .sendMessage(tab.id, { type: 'otp:fill', code: result.code, name: result.name, autoSubmit: result.autoSubmit })
      .catch(() => null);
    if (reply?.filled) return;
  }
  chrome.action.openPopup().catch(() => {});
});
