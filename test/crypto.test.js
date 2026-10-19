import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVaultMeta, unlockVaultMeta, encryptJson, decryptJson, encryptBackup, decryptBackup,
} from '../extension/lib/crypto.js';

const FAST = 1000; // keep PBKDF2 cheap in tests

test('a vault created with a password unlocks with the same password', async () => {
  const { meta, key } = await createVaultMeta('correct horse', FAST);
  const again = await unlockVaultMeta('correct horse', meta);
  assert.deepEqual(again, key);
  assert.equal(meta.iterations, FAST);
});

test('unlocking with the wrong password fails', async () => {
  const { meta } = await createVaultMeta('correct horse', FAST);
  await assert.rejects(unlockVaultMeta('wrong', meta), /wrong password/i);
});

test('encryptJson output hides the data and decrypts back', async () => {
  const { key } = await createVaultMeta('pw', FAST);
  const box = await encryptJson(key, { secret: 'JBSWY3DPEHPK3PXP' });
  assert.ok(!JSON.stringify(box).includes('JBSWY3DPEHPK3PXP'));
  assert.deepEqual(await decryptJson(key, box), { secret: 'JBSWY3DPEHPK3PXP' });
});

test('encryptJson uses a fresh IV each time', async () => {
  const { key } = await createVaultMeta('pw', FAST);
  const a = await encryptJson(key, { x: 1 });
  const b = await encryptJson(key, { x: 1 });
  assert.notEqual(a.iv, b.iv);
});

test('decryptJson rejects tampered data', async () => {
  const { key } = await createVaultMeta('pw', FAST);
  const box = await encryptJson(key, { x: 1 });
  const flipped = box.ct[0] === 'A' ? 'B' + box.ct.slice(1) : 'A' + box.ct.slice(1);
  await assert.rejects(decryptJson(key, { ...box, ct: flipped }));
});

test('backups round-trip with the password and fail without it', async () => {
  const accounts = [{ issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP' }];
  const text = await encryptBackup('backup pw', accounts, FAST);
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, 'authpeek-backup');
  assert.ok(!text.includes('JBSWY3DPEHPK3PXP'));
  assert.deepEqual(await decryptBackup('backup pw', text), accounts);
  await assert.rejects(decryptBackup('nope', text), /wrong password/i);
  await assert.rejects(decryptBackup('backup pw', '{"hello":1}'), /not an AuthPeek backup/i);
});

test('backups made before the AuthPeek rename still restore', async () => {
  const accounts = [{ issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP' }];
  const old = JSON.parse(await encryptBackup('pw', accounts, FAST));
  old.format = 'otp-autofill-backup';
  assert.deepEqual(await decryptBackup('pw', JSON.stringify(old)), accounts);
});
