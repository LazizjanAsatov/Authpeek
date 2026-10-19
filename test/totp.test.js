import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase32, encodeBase32 } from '../extension/lib/base32.js';
import { generateTotp, secondsRemaining } from '../extension/lib/totp.js';

const ascii = (s) => new TextEncoder().encode(s);

test('decodeBase32 decodes RFC 4648 text, ignoring case, spaces, dashes and padding', () => {
  const expected = ascii('12345678901234567890');
  assert.deepEqual(decodeBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), expected);
  assert.deepEqual(decodeBase32('gezd gnbv gy3t-qojq gezd gnbv gy3t qojq'), expected);
  assert.deepEqual(decodeBase32('MZXW6==='), ascii('foo'));
});

test('decodeBase32 rejects characters outside the alphabet', () => {
  assert.throws(() => decodeBase32('ABC1'), /invalid/i);
  assert.throws(() => decodeBase32(''), /empty/i);
});

test('encodeBase32 round-trips with decodeBase32', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 77, 13]);
  assert.deepEqual(decodeBase32(encodeBase32(bytes)), bytes);
  assert.equal(encodeBase32(ascii('foo')), 'MZXW6');
});

// RFC 6238 Appendix B test vectors (8 digits).
const vectors = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];
const secrets = {
  SHA1: ascii('12345678901234567890'),
  SHA256: ascii('12345678901234567890123456789012'),
  SHA512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
};

for (const [t, sha1, sha256, sha512] of vectors) {
  test(`generateTotp matches RFC 6238 vectors at T=${t}`, async () => {
    const timestamp = t * 1000;
    assert.equal(await generateTotp({ secret: secrets.SHA1, digits: 8, algorithm: 'SHA1', timestamp }), sha1);
    assert.equal(await generateTotp({ secret: secrets.SHA256, digits: 8, algorithm: 'SHA256', timestamp }), sha256);
    assert.equal(await generateTotp({ secret: secrets.SHA512, digits: 8, algorithm: 'SHA512', timestamp }), sha512);
  });
}

test('generateTotp defaults to 6 digits, SHA1, 30s period', async () => {
  assert.equal(await generateTotp({ secret: secrets.SHA1, timestamp: 59000 }), '287082');
});

test('secondsRemaining counts down within the period', () => {
  assert.equal(secondsRemaining(30, 0), 30);
  assert.equal(secondsRemaining(30, 1000), 29);
  assert.equal(secondsRemaining(30, 29500), 1);
  assert.equal(secondsRemaining(60, 30000), 30);
});
