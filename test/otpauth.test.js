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

import { parseLinks } from '../extension/lib/otpauth.js';

const hyperion =
  'otpauth://totp/Hyperion%20Rapid%20Solutions:neurohaven?secret=JXR5ZD22TMGXBTJ3BKBIZLBBRUTAYJKPMVNS67QQ2VGYAVBRICNA&issuer=Hyperion%20Rapid%20Solutions&algorithm=SHA512&digits=6&period=30';

test('parseLinks reads every setting from a pasted otpauth link', () => {
  const { accounts, failed } = parseLinks(hyperion);
  assert.deepEqual(failed, []);
  assert.deepEqual(accounts, [{
    issuer: 'Hyperion Rapid Solutions',
    label: 'neurohaven',
    secret: 'JXR5ZD22TMGXBTJ3BKBIZLBBRUTAYJKPMVNS67QQ2VGYAVBRICNA',
    digits: 6,
    period: 30,
    algorithm: 'SHA512',
  }]);
});

test('parseLinks finds several links mixed into other text', () => {
  const text = `Here are the keys:
  1) ${hyperion}.
  2) "otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP&issuer=GitHub", and
  3) <a href="otpauth://totp/Stripe:ops?secret=GEZDGNBVGY3TQOJQ&amp;issuer=Stripe">setup</a>`;
  const { accounts, failed } = parseLinks(text);
  assert.deepEqual(failed, []);
  assert.deepEqual(accounts.map((a) => a.issuer), ['Hyperion Rapid Solutions', 'GitHub', 'Stripe']);
  assert.equal(accounts[0].algorithm, 'SHA512');
});

test('parseLinks keeps the good links when one is broken', () => {
  const text = `otpauth://totp/A:x?secret=JBSWY3DPEHPK3PXP\notpauth://totp/B:y?secret=bad*key\notpauth://hotp/C:z?secret=JBSWY3DPEHPK3PXP`;
  const { accounts, failed } = parseLinks(text);
  assert.deepEqual(accounts.map((a) => a.issuer), ['A']);
  assert.equal(failed.length, 2);
  assert.match(failed[0].error, /invalid/i);
  assert.match(failed[1].error, /time-based/);
});

test('parseLinks also takes Google Authenticator export links', () => {
  const uri = 'otpauth-migration://offline?data=' + encodeURIComponent(
    Buffer.from([10, 20, 10, 6, 72, 101, 108, 108, 111, 33, 18, 1, 120, 26, 1, 89, 32, 1, 40, 1, 48, 2]).toString('base64'));
  const { accounts } = parseLinks(`exported: ${uri}`);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].issuer, 'Y');
});

test('parseLinks says so when the text has no link', () => {
  assert.throws(() => parseLinks('just some words'), /no otpauth/i);
});
