import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOtpauthUri, parseMigrationUri, parseQrText } from '../extension/lib/otpauth.js';

test('parseOtpauthUri reads issuer, account and parameters', () => {
  const acct = parseOtpauthUri(
    'otpauth://totp/GitHub:alice%40example.com?secret=jbswy3dpehpk3pxp&issuer=GitHub&digits=8&period=60&algorithm=SHA256'
  );
  assert.deepEqual(acct, {
    issuer: 'GitHub',
    label: 'alice@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    digits: 8,
    period: 60,
    algorithm: 'SHA256',
  });
});

test('parseOtpauthUri falls back to the label prefix for issuer and to defaults', () => {
  const acct = parseOtpauthUri('otpauth://totp/Stripe%3Abob?secret=JBSWY3DPEHPK3PXP');
  assert.equal(acct.issuer, 'Stripe');
  assert.equal(acct.label, 'bob');
  assert.equal(acct.digits, 6);
  assert.equal(acct.period, 30);
  assert.equal(acct.algorithm, 'SHA1');
});

test('parseOtpauthUri handles a label with no issuer', () => {
  const acct = parseOtpauthUri('otpauth://totp/bob@example.com?secret=JBSWY3DPEHPK3PXP');
  assert.equal(acct.issuer, '');
  assert.equal(acct.label, 'bob@example.com');
});

test('parseOtpauthUri rejects counter-based, missing and invalid secrets', () => {
  assert.throws(() => parseOtpauthUri('otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1'), /time-based/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/X?issuer=X'), /secret/i);
  assert.throws(() => parseOtpauthUri('otpauth://totp/X?secret=not*base32'), /invalid/i);
  assert.throws(() => parseOtpauthUri('https://example.com'), /otpauth/);
});

// Minimal protobuf encoder for building Google Authenticator export payloads.
function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return out;
}
const field = (num, bytes) => [...varint((num << 3) | 2), ...varint(bytes.length), ...bytes];
const intField = (num, n) => [...varint(num << 3), ...varint(n)];
const str = (s) => [...new TextEncoder().encode(s)];

function otpParams({ secret, name, issuer, algorithm = 1, digits = 1, type = 2 }) {
  return [
    ...field(1, secret), ...field(2, str(name)), ...field(3, str(issuer)),
    ...intField(4, algorithm), ...intField(5, digits), ...intField(6, type),
  ];
}
function migrationUri(params, { batchSize = 1, batchIndex = 0 } = {}) {
  const payload = [
    ...params.flatMap((p) => field(1, otpParams(p))),
    ...intField(2, 1), ...intField(3, batchSize), ...intField(4, batchIndex), ...intField(5, 12345),
  ];
  const b64 = Buffer.from(payload).toString('base64');
  return `otpauth-migration://offline?data=${encodeURIComponent(b64)}`;
}

const helloSecret = [...Buffer.from('Hello!\xde\xad\xbe\xef', 'latin1')]; // JBSWY3DPEHPK3PXP

test('parseMigrationUri reads every account from a Google Authenticator export', () => {
  const result = parseMigrationUri(migrationUri([
    { secret: helloSecret, name: 'Google:alice@gmail.com', issuer: 'Google' },
    { secret: helloSecret, name: 'bob', issuer: 'AWS', algorithm: 2, digits: 2 },
  ], { batchSize: 2, batchIndex: 0 }));

  assert.equal(result.skipped, 0);
  assert.deepEqual(result.batch, { index: 0, size: 2 });
  assert.deepEqual(result.accounts, [
    { issuer: 'Google', label: 'alice@gmail.com', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' },
    { issuer: 'AWS', label: 'bob', secret: 'JBSWY3DPEHPK3PXP', digits: 8, period: 30, algorithm: 'SHA256' },
  ]);
});

test('parseMigrationUri skips counter-based accounts and counts them', () => {
  const result = parseMigrationUri(migrationUri([
    { secret: helloSecret, name: 'old', issuer: 'Bank', type: 1 },
    { secret: helloSecret, name: 'new', issuer: 'Bank' },
  ]));
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].label, 'new');
  assert.equal(result.skipped, 1);
});

test('parseQrText accepts both URI kinds and rejects anything else', () => {
  assert.equal(parseQrText('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP').accounts.length, 1);
  assert.equal(parseQrText(migrationUri([{ secret: helloSecret, name: 'x', issuer: 'Y' }])).accounts.length, 1);
  assert.throws(() => parseQrText('https://example.com'), /not an authenticator/i);
});
