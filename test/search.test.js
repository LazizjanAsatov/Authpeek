import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery } from '../extension/lib/search.js';

const acct = {
  issuer: 'Hyperion Rapid Solutions',
  label: 'neurohaven',
  sites: ['gate.dns-pay.com'],
  usernames: ['n.haven'],
};

test('an empty search matches everything', () => {
  assert.equal(matchesQuery(acct, ''), true);
  assert.equal(matchesQuery(acct, '   '), true);
});

test('matches service and account name, ignoring case', () => {
  assert.equal(matchesQuery(acct, 'hyper'), true);
  assert.equal(matchesQuery(acct, 'NEURO'), true);
  assert.equal(matchesQuery(acct, 'github'), false);
});

test('matches linked sites and learned usernames', () => {
  assert.equal(matchesQuery(acct, 'dns-pay'), true);
  assert.equal(matchesQuery(acct, 'n.haven'), true);
});

test('every word must match somewhere', () => {
  assert.equal(matchesQuery(acct, 'rapid neuro'), true);
  assert.equal(matchesQuery(acct, 'rapid github'), false);
});

test('matches the start of words in initials-style searches', () => {
  assert.equal(matchesQuery(acct, 'hrs'), true); // Hyperion Rapid Solutions
  assert.equal(matchesQuery({ issuer: 'Amazon Web Services', label: 'root' }, 'aws'), true);
  assert.equal(matchesQuery({ issuer: 'GitHub', label: 'me' }, 'gh'), false);
});

import { displayOrder } from '../extension/lib/search.js';

test('pinned accounts come first, each group keeping its order', () => {
  const list = [
    { id: 'a', issuer: 'Amazon' },
    { id: 'b', issuer: 'Bank', pinned: true },
    { id: 'c', issuer: 'Cloud' },
    { id: 'd', issuer: 'Dropbox', pinned: true },
  ];
  assert.deepEqual(displayOrder(list).map((x) => x.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(list.map((x) => x.id), ['a', 'b', 'c', 'd'], 'input is not changed');
});
