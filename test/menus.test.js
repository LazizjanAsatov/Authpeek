import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuItems, ROOT, FILL_SITE, UNLOCK, accountMenuId, accountIdFromMenu } from '../extension/lib/menus.js';

const gh = { id: 'g1', issuer: 'GitHub', label: 'alice' };
const aws = { id: 'a1', issuer: 'AWS', label: '' };

test('locked: the menu only offers to unlock', () => {
  assert.deepEqual(menuItems({ unlocked: false, accounts: [] }), [
    { id: ROOT, title: 'AuthPeek' },
    { id: UNLOCK, parentId: ROOT, title: 'Unlock AuthPeek…' },
  ]);
});

test('unlocked: fill for this site, then every account by name', () => {
  assert.deepEqual(menuItems({ unlocked: true, accounts: [gh, aws] }), [
    { id: ROOT, title: 'AuthPeek' },
    { id: FILL_SITE, parentId: ROOT, title: 'Fill code for this site' },
    { id: 'authpeek-sep', parentId: ROOT, type: 'separator' },
    { id: accountMenuId(gh), parentId: ROOT, title: 'GitHub (alice)' },
    { id: accountMenuId(aws), parentId: ROOT, title: 'AWS' },
  ]);
});

test('unlocked with no accounts: just the fill item', () => {
  assert.deepEqual(menuItems({ unlocked: true, accounts: [] }).map((i) => i.id), [ROOT, FILL_SITE]);
});

test('menu ids map back to account ids', () => {
  assert.equal(accountIdFromMenu(accountMenuId(gh)), 'g1');
  assert.equal(accountIdFromMenu(FILL_SITE), null);
});
