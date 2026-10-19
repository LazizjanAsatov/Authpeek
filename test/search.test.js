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
