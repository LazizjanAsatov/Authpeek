// TOTP (RFC 6238) on top of Web Crypto HMAC. Works in the extension and in Node.
const HASHES = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

// Steam Guard: same TOTP, but 5 characters from Steam's own alphabet instead of digits.
const STEAM_CHARS = '23456789BCDFGHJKMNPQRTVWXY';

export async function generateTotp({
  secret, digits = 6, period = 30, algorithm = 'SHA1', timestamp = Date.now(), encoder = null,
}) {
  const hash = HASHES[algorithm];
  if (!hash) throw new Error(`Unsupported algorithm ${algorithm}`);

  const counter = Math.floor(timestamp / 1000 / period);
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));

  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  if (encoder === 'steam') {
    let rest = binary;
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += STEAM_CHARS[rest % STEAM_CHARS.length];
      rest = Math.floor(rest / STEAM_CHARS.length);
    }
    return code;
  }
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function secondsRemaining(period = 30, timestamp = Date.now()) {
  return period - (Math.floor(timestamp / 1000) % period);
}
