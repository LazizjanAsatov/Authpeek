// Picks which account a code page is for when a site has more than one, using the
// username typed earlier in the login and any usernames shown on the code page.
import { accountsForHost, siteForHost } from './sites.js';

const normalize = (s) => String(s || '').trim().toLowerCase();

// A label like "alice@acme.com" or "alice" says who the account is; "Work account" doesn't.
const looksLikeUsername = (s) => s.length >= 2 && !/\s/.test(s);

function accountIds(account) {
  const ids = new Set();
  const label = normalize(account.label);
  if (looksLikeUsername(label)) ids.add(label);
  for (const u of account.usernames || []) if (normalize(u)) ids.add(normalize(u));
  return [...ids];
}

function sameId(a, b) {
  if (a === b) return true;
  const localPart = (s) => (s.includes('@') ? s.slice(0, s.indexOf('@')) : null);
  return localPart(a) === b || localPart(b) === a;
}

const matches = (account, hints) => accountIds(account).some((id) => hints.some((h) => sameId(id, h)));

// linked: accounts linked to this site. others: every other saved account.
// typed: username typed earlier in this tab. hints: usernames found on the code page.
// Returns { account } when the choice is clear, {} when the user should pick.
export function pickAccount({ linked, others = [], hints = [], typed = '' }) {
  const typedId = normalize(typed);
  const all = [...hints.map(normalize), typedId].filter(Boolean);

  const byName = linked.filter((a) => matches(a, all));
  if (byName.length === 1) return { account: byName[0] };
  if (byName.length > 1 || linked.length !== 1) return {};

  const only = linked[0];
  if (others.some((a) => matches(a, all))) return {}; // signing in as a different saved account
  if (typedId && accountIds(only).length) return {}; // its username is known and isn't this one
  return { account: only };
}

// Username to remember after the user picked `account` by hand, or null if nothing new.
export function learnUsername(account, typed) {
  const id = normalize(typed);
  if (!id || matches(account, [id])) return null;
  return [...(account.usernames || []), id];
}

// What to save after the user filled `account` by hand on `host` (popup or right-click):
// link the site and remember the username, so next time it fills by itself.
export function manualPickPatch(account, host, typed) {
  const patch = {};
  if (host && !accountsForHost([account], host).length) patch.sites = [...(account.sites || []), siteForHost(host)];
  const usernames = learnUsername(account, typed);
  if (usernames) patch.usernames = usernames;
  return Object.keys(patch).length ? patch : null;
}
