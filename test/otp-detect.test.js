import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../extension/otp-detect.js', import.meta.url), 'utf8');

// Loads a page and runs the content-script helper inside it, like Chrome would.
function page(body) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { runScripts: 'outside-only' });
  dom.window.eval(source);
  return { window: dom.window, document: dom.window.document, detect: dom.window.OtpDetect };
}

test('finds a field marked autocomplete="one-time-code"', () => {
  const { document, detect } = page('<input id="x" autocomplete="one-time-code">');
  const t = detect.findOtpTarget(document);
  assert.equal(t.kind, 'single');
  assert.equal(t.input.id, 'x');
});

test('finds fields named or labelled like a verification code', () => {
  for (const html of [
    '<input id="x" name="otp">',
    '<input id="x" name="totpPin" type="tel">',
    '<input id="x" placeholder="6-digit code">',
    '<input id="x" aria-label="Authentication code">',
    '<label for="x">Two-factor code</label><input id="x">',
    '<label>Enter the code from your authenticator app <input id="x" inputmode="numeric"></label>',
  ]) {
    const { document, detect } = page(html);
    assert.equal(detect.findOtpTarget(document)?.input?.id, 'x', html);
  }
});

test('ignores ordinary login fields and other kinds of codes', () => {
  for (const html of [
    '<input type="email" name="email"><input type="password" name="password">',
    '<input name="zip_code" placeholder="Zip code" maxlength="6">',
    '<input name="promo" placeholder="Promo code">',
    '<input type="hidden" name="csrf_token" value="abc">',
    '<input name="otp" style="display:none">',
    '<input name="otp" disabled>',
    '<input type="search" placeholder="Search code">',
  ]) {
    const { document, detect } = page(html);
    assert.equal(detect.findOtpTarget(document), null, html);
  }
});

test('finds six one-character boxes as a split code field, in order', () => {
  const boxes = [1, 2, 3, 4, 5, 6].map((n) => `<div class="cell"><input id="d${n}" maxlength="1" inputmode="numeric"></div>`).join('');
  const { document, detect } = page(`<form><input type="email"><div class="otp">${boxes}</div></form>`);
  const t = detect.findOtpTarget(document);
  assert.equal(t.kind, 'split');
  assert.deepEqual(Array.from(t.inputs, (i) => i.id), ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
});

test('fills a single field so frameworks see an input event', () => {
  const { document, detect } = page('<input id="x" autocomplete="one-time-code">');
  const input = document.getElementById('x');
  let seen = null;
  input.addEventListener('input', () => { seen = input.value; });
  detect.fillTarget(detect.findOtpTarget(document), '123456');
  assert.equal(input.value, '123456');
  assert.equal(seen, '123456');
});

test('fills split boxes one digit each', () => {
  const boxes = [1, 2, 3, 4, 5, 6].map((n) => `<input id="d${n}" maxlength="1">`).join('');
  const { document, detect } = page(`<div>${boxes}</div>`);
  detect.fillTarget(detect.findOtpTarget(document), '987654');
  assert.deepEqual([...document.querySelectorAll('input')].map((i) => i.value), ['9', '8', '7', '6', '5', '4']);
});

test('skips a code field that already has a value', () => {
  const { document, detect } = page('<input name="otp" value="111111">');
  assert.equal(detect.findOtpTarget(document), null);
});

test('submitTarget submits the surrounding form', () => {
  const { document, detect, window } = page('<form id="f"><input name="otp"><button>Verify</button></form>');
  let submitted = false;
  document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); submitted = true; });
  const t = detect.findOtpTarget(document);
  detect.fillTarget(t, '123456');
  detect.submitTarget(t);
  assert.equal(submitted, true);
  window.close();
});

test('isUsernameField recognises username and email boxes only', () => {
  const { document, detect } = page(`
    <input id="email" type="email">
    <input id="login" name="login">
    <input id="user" autocomplete="username">
    <input id="pw" type="password" name="password">
    <input id="otp" name="otp">
    <input id="q" type="search" name="user_search">
    <input id="city" name="city">`);
  const yes = ['email', 'login', 'user'];
  for (const id of ['email', 'login', 'user', 'pw', 'otp', 'q', 'city']) {
    assert.equal(detect.isUsernameField(document.getElementById(id)), yes.includes(id), id);
  }
});

test('findIdentityHints reads usernames carried on the code page', () => {
  const { document, detect } = page(`
    <form>
      <input type="hidden" name="username" value="alice@acme.com">
      <input type="hidden" name="csrf_token" value="zzz">
      <input type="password" name="password" value="secret">
      <input name="otp">
    </form>
    <p>Signed in as <b>bob@acme.com</b>. Not you? Contact help@acme.com</p>`);
  const hints = Array.from(detect.findIdentityHints(document));
  assert.ok(hints.includes('alice@acme.com'));
  assert.ok(hints.includes('bob@acme.com'));
  assert.ok(!hints.includes('zzz'));
  assert.ok(!hints.includes('secret'));
});
