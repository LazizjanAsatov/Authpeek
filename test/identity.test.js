import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAccount, learnUsername } from '../extension/lib/identity.js';

const alice = { id: 'a', issuer: 'Acme', label: 'alice@acme.com', sites: ['acme.com'] };
const bob = { id: 'b', issuer: 'Acme', label: 'bob@acme.com', sites: ['acme.com'] };
const work = { id: 'w', issuer: 'Acme', label: 'Work account', sites: ['acme.com'] };
const carol = { id: 'c', issuer: 'Acme', label: 'carol', sites: [] }; // in AuthPeek, not linked to the site

const pick = (o) => pickAccount({ linked: [], others: [], hints: [], typed: '', ...o });

test('two linked accounts: the username you typed picks one', () => {
  assert.equal(pick({ linked: [alice, bob], typed: 'bob@acme.com' }).account?.id, 'b');
  assert.equal(pick({ linked: [alice, bob], typed: 'Alice@Acme.com ' }).account?.id, 'a');
});

test('two linked accounts: a username shown on the code page picks one', () => {
  assert.equal(pick({ linked: [alice, bob], hints: ['Signed in', 'bob@acme.com'] }).account?.id, 'b');
});

test('a username matches the part of an email before the @', () => {
  assert.equal(pick({ linked: [alice, bob], typed: 'bob' }).account?.id, 'b');
  assert.equal(pick({ linked: [{ ...alice, label: 'alice' }, bob], typed: 'alice@acme.com' }).account?.id, 'a');
});

test('usernames learned from earlier picks are matched too', () => {
  const learned = { ...work, usernames: ['a.smith'] };
  assert.equal(pick({ linked: [learned, bob], typed: 'A.Smith' }).account?.id, 'w');
});

test('two linked accounts and nothing to go on: ask instead of guessing', () => {
  assert.equal(pick({ linked: [alice, bob] }).account, undefined);
  assert.equal(pick({ linked: [alice, bob], typed: 'dave' }).account, undefined);
});

test('a username matching two accounts is not a decision', () => {
  assert.equal(pick({ linked: [alice, { ...bob, usernames: ['alice'] }], typed: 'alice' }).account, undefined);
});

test('one linked account and no username: fill it as before', () => {
  assert.equal(pick({ linked: [alice] }).account?.id, 'a');
});

test('one linked account but signing in as another saved account: ask', () => {
  assert.equal(pick({ linked: [alice], others: [carol], typed: 'carol' }).account, undefined);
});

test('one linked account with a known username, signing in as someone else: ask', () => {
  assert.equal(pick({ linked: [alice], typed: 'dave@acme.com' }).account, undefined);
});

test('one linked account whose name says nothing about the username: fill it', () => {
  assert.equal(pick({ linked: [work], typed: 'dave@acme.com' }).account?.id, 'w');
});

test('learnUsername adds a new username and skips one already known', () => {
  assert.deepEqual(learnUsername(work, 'A.Smith '), ['a.smith']);
  assert.equal(learnUsername(alice, 'alice'), null); // already matches the email label
  assert.equal(learnUsername({ ...work, usernames: ['a.smith'] }, 'a.smith'), null);
  assert.equal(learnUsername(work, '  '), null);
});
