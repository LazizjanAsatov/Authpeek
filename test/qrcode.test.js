import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The popup loads this with a <script> tag, like vendor/jsQR.js, so it has to define a global.
const source = readFileSync(new URL('../extension/vendor/qrcode.js', import.meta.url), 'utf8');

function loadQrcode() {
  const window = {};
  window.window = window;
  vm.runInContext(source, vm.createContext(window));
  return window.qrcode;
}

test('qrcode.js is a classic script that defines a global qrcode function', () => {
  const qrcode = loadQrcode();
  assert.equal(typeof qrcode, 'function');
  assert.ok(!source.includes('import '), 'must stay a classic script');
});

test('qrcode renders an otpauth link to a module matrix', () => {
  const qrcode = loadQrcode();
  const qr = qrcode(0, 'M'); // type 0 = pick the smallest version that fits
  qr.addData('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP');
  qr.make();
  const size = qr.getModuleCount();
  assert.ok(size >= 21 && size % 4 === 1, `module count ${size}`);
  // The finder pattern in the top-left corner: a dark 7x7 ring with a dark 3x3 centre.
  assert.equal(qr.isDark(0, 0), true);
  assert.equal(qr.isDark(1, 1), false);
  assert.equal(qr.isDark(3, 3), true);
  assert.equal(qr.isDark(7, 7), false); // the quiet separator beside the finder
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (qr.isDark(r, c)) dark++;
  assert.ok(dark > 0 && dark < size * size);
});
