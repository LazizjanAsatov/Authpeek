import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, siteForHost, siteMatches, accountsForHost, suggestedAccounts } from '../extension/lib/sites.js';

test('hostOf returns the lowercase hostname of web pages only', () => {
  assert.equal(hostOf('https://GitHub.com/login?x=1'), 'github.com');
  assert.equal(hostOf('http://localhost:3000/'), 'localhost');
  assert.equal(hostOf('chrome://extensions'), null);
  assert.equal(hostOf('not a url'), null);
});

test('siteForHost drops a leading www', () => {
  assert.equal(siteForHost('www.stripe.com'), 'stripe.com');
  assert.equal(siteForHost('dashboard.stripe.com'), 'dashboard.stripe.com');
});

test('siteMatches allows the exact host and its subdomains, never lookalikes', () => {
  assert.equal(siteMatches('github.com', 'github.com'), true);
  assert.equal(siteMatches('github.com', 'www.github.com'), true);
  assert.equal(siteMatches('github.com', 'evilgithub.com'), false);
  assert.equal(siteMatches('github.com', 'github.com.evil.io'), false);
});

const accounts = [
  { id: 'a', issuer: 'GitHub', label: 'me', sites: ['github.com'] },
  { id: 'b', issuer: 'Stripe', label: 'ops', sites: [] },
  { id: 'c', issuer: 'Amazon Web Services', label: 'root', sites: [] },
];

test('accountsForHost returns only accounts linked to the site', () => {
  assert.deepEqual(accountsForHost(accounts, 'github.com').map((a) => a.id), ['a']);
  assert.deepEqual(accountsForHost(accounts, 'dashboard.stripe.com'), []);
});

test('suggestedAccounts guesses unlinked accounts from the issuer name', () => {
  assert.deepEqual(suggestedAccounts(accounts, 'dashboard.stripe.com').map((a) => a.id), ['b']);
  assert.deepEqual(suggestedAccounts(accounts, 'example.com'), []);
});
