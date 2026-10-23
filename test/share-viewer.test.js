import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  codesForWindow, encodeShare, decodeShare, currentCode, isExpired,
} from '../extension/lib/share.js';

// The GitHub Pages viewer has its own copy of the decode logic (a plain script, so the site
// stays standalone). This runs that copy the way a browser would and checks it agrees with
// the extension's library on the same links.
const source = readFileSync(new URL('../docs/share.js', import.meta.url), 'utf8');

function loadViewer() {
  const window = { crypto, TextEncoder, TextDecoder, atob, btoa };
  window.window = window;
  vm.runInContext(source, vm.createContext(window));
  return window.AuthPeekShare;
}

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const github = { issuer: 'GitHub', label: 'me', secret: RFC_SECRET, digits: 6, period: 30, algorithm: 'SHA1' };
const steam = { ...github, issuer: 'Steam', label: 'gaben', digits: 5, encoder: 'steam' };
const T = 1_111_111_109_000;

test('the viewer exposes the same three functions as a plain script', () => {
  const viewer = loadViewer();
  assert.equal(typeof viewer.decodeShare, 'function');
  assert.equal(typeof viewer.currentCode, 'function');
  assert.equal(typeof viewer.isExpired, 'function');
  assert.ok(!source.includes('import '), 'docs/share.js must stay a classic script');
  assert.ok(!source.includes('export '), 'docs/share.js must stay a classic script');
});

for (const [name, account, minutes] of [['a GitHub account', github, 5], ['a Steam account', steam, 2]]) {
  test(`the viewer decodes ${name} exactly like the extension`, async () => {
    const viewer = loadViewer();
    const payload = await codesForWindow(account, T, minutes);
    const fragment = await encodeShare(payload);
    // Objects made inside the vm have that realm's prototypes; JSON strips that difference.
    const theirs = JSON.parse(JSON.stringify(await viewer.decodeShare(fragment)));
    assert.deepEqual(theirs, await decodeShare(fragment));
    assert.deepEqual(theirs, payload);

    const end = payload.start + payload.codes.length * payload.period * 1000;
    for (const now of [payload.start - 1, payload.start, payload.start + 29_500, T, end - 1, end, end + 60_000]) {
      const shown = viewer.currentCode(theirs, now);
      assert.deepEqual(shown && JSON.parse(JSON.stringify(shown)), currentCode(payload, now), `currentCode at ${now}`);
      assert.equal(viewer.isExpired(theirs, now), isExpired(payload, now), `isExpired at ${now}`);
    }
  });
}

test('the viewer reports the same errors as the extension', async () => {
  const viewer = loadViewer();
  const fragment = await encodeShare(await codesForWindow(github, T, 2));
  const [, ct, key] = fragment.split('.');
  for (const bad of ['hello', '', 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', `v1.${ct}.${key.slice(0, -4)}`, `v1.${ct.slice(0, 20)}.${key}`]) {
    const [mine, theirs] = await Promise.all([
      decodeShare(bad).then(() => null, (e) => e.message),
      viewer.decodeShare(bad).then(() => null, (e) => e.message),
    ]);
    assert.ok(mine, `extension should reject ${JSON.stringify(bad)}`);
    assert.equal(theirs, mine, JSON.stringify(bad));
  }
});

// A link's maker controls its whole payload, so the viewer must refuse anything AuthPeek wouldn't write.
test('both decoders refuse links that carry markup or nonsense instead of codes', async () => {
  const viewer = loadViewer();
  const base = { v: 1, name: 'GitHub (alice)', period: 30, digits: 6, start: 0, codes: ['492817', '115204'] };
  const bad = [
    { ...base, codes: ['492817', '<img src=x onerror=alert(1)>'] },
    { ...base, codes: [] },
    { ...base, codes: [492817] },
    { ...base, name: 'x'.repeat(201) },
    { ...base, period: 0 },
    { ...base, period: 1.5 },
    { ...base, start: 'soon' },
  ];
  for (const payload of bad) {
    const fragment = await encodeShare(payload);
    await assert.rejects(decodeShare(fragment), /damaged/, JSON.stringify(payload).slice(0, 60));
    await assert.rejects(viewer.decodeShare(fragment), /damaged/, JSON.stringify(payload).slice(0, 60));
  }
  // The viewer runs in its own realm, so compare through JSON like the tests above.
  assert.deepEqual(JSON.parse(JSON.stringify(await viewer.decodeShare(await encodeShare(base)))), base);
});
