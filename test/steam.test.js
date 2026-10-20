import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateTotp } from '../extension/lib/totp.js';
import { decodeBase32, encodeBase32 } from '../extension/lib/base32.js';
import { parseOtpauthUri, toOtpauthUri, normalizeSteamSecret } from '../extension/lib/otpauth.js';

const steamTotp = createRequire(import.meta.url)('steam-totp'); // independent implementation
const rfcSecret = new TextEncoder().encode('12345678901234567890');

test('Steam codes match known values', async () => {
  assert.equal(await generateTotp({ secret: rfcSecret, encoder: 'steam', timestamp: 59_000 }), 'PV9M4');
  assert.equal(await generateTotp({ secret: rfcSecret, encoder: 'steam', timestamp: 1_111_111_109_000 }), 'PY4YB');
});

test('Steam codes match the steam-totp library for random keys and times', async () => {
  for (let i = 0; i < 25; i++) {
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const t = Math.floor(Math.random() * 2e9);
    const expected = steamTotp.getAuthCode(Buffer.from(secret).toString('base64'), t - Math.floor(Date.now() / 1000));
    assert.equal(await generateTotp({ secret, encoder: 'steam', timestamp: t * 1000 }), expected, `t=${t}`);
  }
});

test('a Steam link becomes a Steam account, by issuer or by encoder', () => {
  const byIssuer = parseOtpauthUri('otpauth://totp/Steam:gaben?secret=JBSWY3DPEHPK3PXP&issuer=Steam');
  assert.equal(byIssuer.encoder, 'steam');
  assert.equal(byIssuer.digits, 5);
  const byEncoder = parseOtpauthUri('otpauth://totp/Valve:gaben?secret=JBSWY3DPEHPK3PXP&encoder=steam');
  assert.equal(byEncoder.encoder, 'steam');
  assert.equal(parseOtpauthUri('otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP').encoder, undefined);
});

test('Steam accounts export with encoder=steam and come back the same', () => {
  const acct = parseOtpauthUri('otpauth://totp/Steam:gaben?secret=JBSWY3DPEHPK3PXP&issuer=Steam');
  const uri = toOtpauthUri(acct);
  assert.match(uri, /encoder=steam/);
  assert.deepEqual(parseOtpauthUri(uri), acct);
});

test("Steam's base64 shared_secret is accepted and converted", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  assert.equal(normalizeSteamSecret(Buffer.from(bytes).toString('base64')), encodeBase32(bytes));
  assert.equal(normalizeSteamSecret('JBSW Y3DP EHPK 3PXP'), 'JBSWY3DPEHPK3PXP'); // already base32
  assert.deepEqual(decodeBase32(normalizeSteamSecret(Buffer.from(bytes).toString('base64'))), bytes);
  assert.throws(() => normalizeSteamSecret('not a key!'), /invalid|secret/i);
});

test('a Steam base64 key that only uses base32 letters is still read as base64', () => {
  // Every character here is also valid base32, so it used to be misread (wrong codes, no error).
  const b64 = 'TyfIvpGZAoV7CHZkmhObmvrJBhQ=';
  const bytes = Buffer.from(b64, 'base64');
  assert.equal(normalizeSteamSecret(b64), encodeBase32(bytes));
  assert.equal(normalizeSteamSecret(b64.replace('=', '')), encodeBase32(bytes)); // padding dropped
});

test('ordinary base32 keys still pass through, in either case', () => {
  assert.equal(normalizeSteamSecret('JBSWY3DPEHPK3PXP'), 'JBSWY3DPEHPK3PXP');
  assert.equal(normalizeSteamSecret('jbsw y3dp ehpk 3pxp'), 'JBSWY3DPEHPK3PXP');
  assert.equal(normalizeSteamSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});
