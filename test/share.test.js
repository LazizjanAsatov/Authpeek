import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTotp } from '../extension/lib/totp.js';
import { decodeBase32 } from '../extension/lib/base32.js';
import {
  codesForWindow, encodeShare, decodeShare, shareUrl, shareFragmentFromText, currentCode, isExpired,
} from '../extension/lib/share.js';

// The RFC 6238 key ("12345678901234567890") in base32, the way the vault stores it.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const github = { issuer: 'GitHub', label: 'me', secret: RFC_SECRET, digits: 6, period: 30, algorithm: 'SHA1' };
const steam = { ...github, issuer: 'Steam', label: 'gaben', digits: 5, encoder: 'steam' };

// An RFC vector time, 29 s into its 30 s step (the step started at 1111111080).
const T = 1_111_111_109_000;
const STEP = 1_111_111_080_000;

const totpAt = (account, timestamp) =>
  generateTotp({ ...account, secret: decodeBase32(account.secret), timestamp });

test('codesForWindow starts at the current step and lists the codes the account would show', async () => {
  const payload = await codesForWindow(github, T, 2);
  assert.equal(payload.v, 1);
  assert.equal(payload.name, 'GitHub (me)');
  assert.equal(payload.period, 30);
  assert.equal(payload.digits, 6);
  assert.equal(payload.start, STEP);
  // 29 s of the first step are gone, so a fifth code is needed to cover the full two minutes.
  assert.equal(payload.codes.length, 5);
  assert.equal(payload.codes[0], '081804'); // RFC 6238 vector at T=1111111109, 6 digits
  for (let i = 0; i < payload.codes.length; i++) {
    assert.equal(payload.codes[i], await totpAt(github, STEP + i * 30_000), `code ${i}`);
  }
  assert.ok(!('secret' in payload));
});

test('codesForWindow gives exactly minutes*60/period codes from an aligned start', async () => {
  for (const [period, minutes, count] of [
    [30, 2, 4], [30, 5, 10], [30, 10, 20],
    [60, 2, 2], [60, 5, 5], [60, 10, 10],
  ]) {
    const payload = await codesForWindow({ ...github, period }, STEP, minutes);
    assert.equal(payload.codes.length, count, `${minutes} min at ${period} s`);
    assert.equal(payload.period, period);
  }
});

test('codesForWindow handles Steam accounts', async () => {
  const payload = await codesForWindow(steam, T, 5);
  assert.equal(payload.digits, 5);
  assert.equal(payload.name, 'Steam (gaben)');
  assert.equal(payload.codes[0], 'PY4YB'); // known Steam value at T=1111111109
  for (const code of payload.codes) assert.match(code, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
  assert.equal(payload.codes[3], await totpAt(steam, STEP + 90_000));
});

test('codesForWindow names accounts the way the popup does', async () => {
  assert.equal((await codesForWindow({ ...github, label: '' }, T, 2)).name, 'GitHub');
  assert.equal((await codesForWindow({ ...github, issuer: '' }, T, 2)).name, 'me');
  assert.equal((await codesForWindow({ ...github, issuer: '', label: '' }, T, 2)).name, 'Account');
});

test('a share round-trips through the fragment and hides the codes', async () => {
  const payload = await codesForWindow(github, T, 5);
  const fragment = await encodeShare(payload);
  assert.match(fragment, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // base64url, no padding
  for (const code of payload.codes) assert.ok(!fragment.includes(code));
  assert.ok(!fragment.includes('GitHub'));
  assert.deepEqual(await decodeShare(fragment), payload);
  assert.notEqual(await encodeShare(payload), fragment); // fresh key and IV every time
});

test('shareUrl puts the fragment after the hash on the viewer page', async () => {
  const fragment = await encodeShare(await codesForWindow(github, T, 2));
  assert.equal(shareUrl(fragment), `https://lazizjanasatov.github.io/Authpeek/share#${fragment}`);
});

test('shareFragmentFromText finds the fragment in a pasted link or sentence', async () => {
  const fragment = await encodeShare(await codesForWindow(github, T, 2));
  const url = shareUrl(fragment);
  assert.equal(shareFragmentFromText(url), fragment);
  assert.equal(shareFragmentFromText(`Here is the code: ${url}. Hurry!`), fragment);
  assert.equal(shareFragmentFromText(`  ${fragment}\n`), fragment);
  assert.equal(shareFragmentFromText(url.replace('/share#', '/share.html#')), fragment);
});

test('shareFragmentFromText ignores otpauth links and ordinary text', () => {
  assert.equal(shareFragmentFromText('otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'), null);
  assert.equal(shareFragmentFromText('otpauth-migration://offline?data=CjEKCk'), null);
  assert.equal(shareFragmentFromText('upgrade to v1.2.3 today'), null);
  assert.equal(shareFragmentFromText(''), null);
  assert.equal(shareFragmentFromText(null), null);
});

test('decodeShare tells a wrong link from a damaged one', async () => {
  const fragment = await encodeShare(await codesForWindow(github, T, 2));
  const [, ct, key] = fragment.split('.');
  await assert.rejects(decodeShare('hello'), /not an AuthPeek share link/);
  await assert.rejects(decodeShare('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP'), /not an AuthPeek share link/);
  await assert.rejects(decodeShare(''), /not an AuthPeek share link/);
  await assert.rejects(decodeShare('v2.abc.def'), /not an AuthPeek share link/);
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  await assert.rejects(decodeShare(`v1.${flip(ct, 20)}.${key}`), /damaged/);
  await assert.rejects(decodeShare(`v1.${ct}.${flip(key, 3)}`), /damaged/);
  await assert.rejects(decodeShare(`v1.${ct}.${key.slice(0, -4)}`), /damaged/);
  await assert.rejects(decodeShare(`v1.${ct.slice(0, 20)}.${key}`), /damaged/);
  await assert.rejects(decodeShare('v1.AAAA.BBBB'), /damaged/);
  const other = await encodeShare(await codesForWindow(github, T, 2));
  await assert.rejects(decodeShare(`v1.${ct}.${other.split('.')[2]}`), /damaged/);
});

test('currentCode follows the clock through the window', async () => {
  const payload = await codesForWindow(github, STEP, 2); // 4 codes, 120 s
  assert.equal(currentCode(payload, STEP - 1), null);
  assert.deepEqual(currentCode(payload, STEP), { code: payload.codes[0], next: payload.codes[1], secondsLeft: 30 });
  assert.equal(currentCode(payload, STEP + 29_500).secondsLeft, 1);
  assert.equal(currentCode(payload, STEP + 30_000).code, payload.codes[1]);
  const last = currentCode(payload, STEP + 119_999);
  assert.equal(last.code, payload.codes[3]);
  assert.equal(last.next, null);
  assert.equal(last.secondsLeft, 1);
  assert.equal(currentCode(payload, STEP + 120_000), null);
});

test('isExpired flips exactly when the last code ends', async () => {
  const payload = await codesForWindow(github, STEP, 2);
  assert.equal(isExpired(payload, STEP - 60_000), false);
  assert.equal(isExpired(payload, STEP + 119_999), false);
  assert.equal(isExpired(payload, STEP + 120_000), true);
  const long = await codesForWindow({ ...github, period: 60 }, STEP, 10);
  assert.equal(isExpired(long, STEP + 600_000 - 1), false);
  assert.equal(isExpired(long, STEP + 600_000), true);
});
