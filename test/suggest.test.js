import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MAX_AUTO_PER_SITE, WINDOW_MS } from '../extension/lib/attempts.js';

// otp-detect.js is a plain content script that sets globalThis.OtpDetect; run it in a sandbox.
const src = readFileSync(new URL('../extension/otp-detect.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const { filledWith, spacedCode, agoText, suggestText, networkText } = ctx.OtpDetect;

const input = (value, isConnected = true) => ({ value, isConnected });

test('filledWith: single field', () => {
  assert.equal(filledWith({ kind: 'single', input: input('123456') }, '123456'), true);
  assert.equal(filledWith({ kind: 'single', input: input('') }, '123456'), false); // site cleared it
  assert.equal(filledWith({ kind: 'single', input: input('123 456') }, '123456'), false); // reformatted
  assert.equal(filledWith({ kind: 'single', input: input('123456', false) }, '123456'), false); // re-rendered
});

test('filledWith: split boxes', () => {
  const boxes = (s, connected = true) => [...s].map((c) => input(c, connected));
  assert.equal(filledWith({ kind: 'split', inputs: boxes('123456') }, '123456'), true);
  assert.equal(filledWith({ kind: 'split', inputs: boxes('12345') }, '123456'), false);
  assert.equal(filledWith({ kind: 'split', inputs: [...boxes('12345'), input('6', false)] }, '123456'), false);
  assert.equal(filledWith({ kind: 'split', inputs: [] }, ''), false);
});

test('filledWith: bad input never says yes', () => {
  assert.equal(filledWith(null, '123456'), false);
  assert.equal(filledWith({ kind: 'single', input: input('') }, ''), false);
  assert.equal(filledWith({ kind: 'other' }, '123456'), false);
  assert.equal(filledWith({ kind: 'single', input: input('123456') }, 123456), false);
});

test('spacedCode puts a thin space in the middle', () => {
  assert.equal(spacedCode('123456'), '123 456');
  assert.equal(spacedCode('12345678'), '1234 5678');
  assert.equal(spacedCode('BCD9F'), 'BCD 9F');
  assert.equal(spacedCode('12'), '12');
  assert.equal(spacedCode(undefined), '');
});

test('agoText', () => {
  assert.equal(agoText(40_000), '40 s ago');
  assert.equal(agoText(0), '0 s ago');
  assert.equal(agoText(59_400), '59 s ago');
  assert.equal(agoText(3 * 60_000), '3 min ago');
  assert.equal(agoText(null), 'recently');
  assert.equal(agoText(-5), 'recently');
  assert.equal(agoText(NaN), 'recently');
});

test('suggestText: main line and the "new code" line', () => {
  const { main, next } = suggestText({ name: 'GitHub (alice)', agoMs: 40_000 });
  assert.equal(
    main,
    "AuthPeek filled a code for GitHub (alice) 40 s ago and won't fill again automatically, so the site " +
      "doesn't lock your account. If the code was rejected, the saved key may be out of date."
  );
  assert.equal(next, '');
  assert.equal(suggestText({ name: 'X', agoMs: 1000, nextIn: 12 }).next, "That's the code that was just used. A new one comes in 12 s.");
  assert.equal(suggestText({ name: 'X', nextIn: 0 }).next, '');
  assert.equal(suggestText({ name: 'X', nextIn: undefined }).next, '');
  assert.match(suggestText({}).main, /for this account recently/);
});

test('suggestText: the circuit breaker names no account and no time', () => {
  const { main, next } = suggestText({ name: 'GitHub (bob)', agoMs: 40_000, nextIn: 12, why: 'site-limit' });
  assert.equal(
    main,
    "AuthPeek already filled 3 codes on this site in the last 10 minutes and won't fill again automatically, " +
      "so the site doesn't lock your account."
  );
  assert.equal(next, '');
  assert.doesNotMatch(main, /bob|s ago/);
  // The content script can't import lib/attempts.js, so its words must match the real limits.
  assert.match(main, new RegExp(`filled ${MAX_AUTO_PER_SITE} codes on this site in the last ${WINDOW_MS / 60_000} minutes`));
});

test('suggestText: an unreadable record gets neutral words, never "0 s ago"', () => {
  const { main, next } = suggestText({ name: 'GitHub (bob)', agoMs: 0, why: 'unknown' });
  assert.doesNotMatch(main, /\d+ s ago|min ago|recently|bob/);
  assert.match(main, /won't fill a code on this site again automatically/);
  assert.equal(next, '');
});

test('networkText picks the words by reason; anything else is the neutral one', () => {
  assert.equal(networkText('not-listed'), "AuthPeek codes are off on this network. It isn't in your whitelisted IPs.");
  assert.equal(networkText('error'), "AuthPeek couldn't check this network, so codes are off for now.");
  assert.equal(networkText('rolled-back'), "AuthPeek's whitelist needs attention. Open AuthPeek settings.");
  for (const r of [undefined, null, '', 'locked', '__proto__', 'toString', 5]) assert.equal(networkText(r), networkText('error'), String(r));
});
