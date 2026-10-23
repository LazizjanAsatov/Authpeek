import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { LOGOS, logoFor } from '../extension/lib/logos.js';

test('logoFor finds GitHub by issuer', () => {
  const logo = logoFor('GitHub', []);
  assert.equal(logo.slug, 'github');
  assert.equal(logo.title, 'GitHub');
  assert.ok(logo.path.length > 0);
});

test('logoFor is forgiving about case, spacing and punctuation in the issuer', () => {
  assert.equal(logoFor('git hub', []).slug, 'github');
  assert.equal(logoFor('Epic Games', []).slug, 'epicgames');
  assert.equal(logoFor('Battle.net', []).slug, 'battledotnet');
  assert.equal(logoFor('Apple ID', []).slug, 'apple');
});

test('logoFor finds a logo by alias', () => {
  assert.equal(logoFor('GH', []).slug, 'github');
  assert.equal(logoFor('Twitter', []).slug, 'x');
  assert.equal(logoFor('Blizzard', []).slug, 'battledotnet');
  assert.equal(logoFor('Gmail', []).slug, 'google');
  assert.equal(logoFor('Google Account', []).slug, 'google');
});

test('logoFor falls back to the linked sites, most specific host first', () => {
  assert.equal(logoFor('My work login', ['accounts.google.com']).slug, 'google');
  assert.equal(logoFor('mail', ['mail.proton.me']).slug, 'protonmail');
  assert.equal(logoFor('shopping', ['www.ebay.co.uk']).slug, 'ebay');
  assert.equal(logoFor('', ['example.org', 'github.com']).slug, 'github');
  assert.equal(logoFor('', ['twitter.com']).slug, 'x');
});

test('the issuer wins over the linked sites', () => {
  assert.equal(logoFor('Stripe', ['github.com']).slug, 'stripe');
});

// Their owners asked Simple Icons to stop distributing these, so they aren't bundled.
test('brands whose owners withdrew their logo get the monogram', () => {
  for (const name of ['Amazon Web Services', 'AWS', 'Microsoft', 'Slack', 'LinkedIn', 'Xbox']) {
    assert.equal(logoFor(name, []), null, name);
  }
  assert.equal(logoFor('root', ['aws.amazon.com']), null);
});

test('logoFor returns null for unknown services', () => {
  assert.equal(logoFor('Hyperion Rapid Solutions', []), null);
  assert.equal(logoFor('Hyperion Rapid Solutions', ['hyperion.example']), null);
  assert.equal(logoFor('', []), null);
  assert.equal(logoFor(undefined, undefined), null);
});

test('every logo has a title, a non-empty path and a 6-hex colour', () => {
  const slugs = Object.keys(LOGOS);
  assert.ok(slugs.length >= 100, `only ${slugs.length} logos bundled`);
  for (const slug of slugs) {
    const { title, path, hex } = LOGOS[slug];
    assert.match(slug, /^[a-z0-9]+$/, `slug ${slug}`);
    assert.ok(typeof title === 'string' && title.length > 0, `${slug} has no title`);
    assert.ok(typeof path === 'string' && path.length > 0, `${slug} has no path`);
    assert.match(path, /^[MmZzLlHhVvCcSsQqTtAa0-9 .,-]+$/, `${slug} path has unexpected characters`);
    assert.match(hex, /^[0-9A-F]{6}$/, `${slug} colour is ${hex}`);
  }
});

test('the logo table cannot be changed at runtime', () => {
  assert.ok(Object.isFrozen(LOGOS));
  assert.ok(Object.isFrozen(LOGOS.github));
});

// The popup imports this file on every open, so it has to stay small.
test('logos.js stays under 250 KB', () => {
  const { size } = statSync(new URL('../extension/lib/logos.js', import.meta.url));
  assert.ok(size < 250 * 1024, `logos.js is ${size} bytes`);
});
