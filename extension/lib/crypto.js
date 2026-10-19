// Password-based encryption for the vault and for backup files.
// PBKDF2-SHA256 derives a 256-bit key; AES-GCM encrypts (and detects tampering).
export const DEFAULT_ITERATIONS = 600000;
// Internal marker from before the AuthPeek rename. Never change it: existing vaults depend on it.
const CHECK_VALUE = 'otp-autofill-vault';
const BACKUP_FORMATS = ['authpeek-backup', 'otp-autofill-backup'];

export const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return toB64(bits);
}

const aesKey = (key, usage) => crypto.subtle.importKey('raw', fromB64(key), 'AES-GCM', false, [usage]);

export async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(key, 'encrypt'), data);
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJson(key, box) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(box.iv) }, await aesKey(key, 'decrypt'), fromB64(box.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// The vault "meta" is stored next to the encrypted accounts. It holds the salt and
// a known value encrypted with the key, so a wrong password is detected immediately.
export async function createVaultMeta(password, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, iterations);
  const meta = { salt: toB64(salt), iterations, check: await encryptJson(key, CHECK_VALUE) };
  return { meta, key };
}

export async function unlockVaultMeta(password, meta) {
  const key = await deriveKey(password, fromB64(meta.salt), meta.iterations);
  try {
    if ((await decryptJson(key, meta.check)) === CHECK_VALUE) return key;
  } catch {
    // fall through
  }
  throw new Error('Wrong password');
}

export async function encryptBackup(password, accounts, iterations = DEFAULT_ITERATIONS) {
  const { meta, key } = await createVaultMeta(password, iterations);
  const box = await encryptJson(key, accounts);
  return JSON.stringify({
    format: BACKUP_FORMATS[0], version: 1, createdAt: new Date().toISOString(),
    salt: meta.salt, iterations, check: meta.check, ...box,
  }, null, 2);
}

export async function decryptBackup(password, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!BACKUP_FORMATS.includes(parsed?.format)) throw new Error('This file is not an AuthPeek backup');
  const key = await unlockVaultMeta(password, parsed);
  return decryptJson(key, parsed);
}
