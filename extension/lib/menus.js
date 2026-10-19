// Right-click menu on text boxes: "AuthPeek ▸ Fill code for this site / <each account>".
import { displayName } from './codes.js';

export const ROOT = 'authpeek-root';
export const FILL_SITE = 'authpeek-fill-site';
export const UNLOCK = 'authpeek-unlock';
const ACCOUNT_PREFIX = 'authpeek-acct:';

export const accountMenuId = (account) => ACCOUNT_PREFIX + account.id;
export const accountIdFromMenu = (menuId) =>
  String(menuId).startsWith(ACCOUNT_PREFIX) ? String(menuId).slice(ACCOUNT_PREFIX.length) : null;

export function menuItems({ unlocked, accounts }) {
  const items = [{ id: ROOT, title: 'AuthPeek' }];
  if (!unlocked) return [...items, { id: UNLOCK, parentId: ROOT, title: 'Unlock AuthPeek…' }];
  items.push({ id: FILL_SITE, parentId: ROOT, title: 'Fill code for this site' });
  if (!accounts.length) return items;
  items.push({ id: 'authpeek-sep', parentId: ROOT, type: 'separator' });
  for (const a of accounts) items.push({ id: accountMenuId(a), parentId: ROOT, title: displayName(a) });
  return items;
}
