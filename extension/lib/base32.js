// RFC 4648 base32, the encoding authenticator apps use for secret keys.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input) {
  const clean = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean) throw new Error('Secret key is empty');

  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v === -1) throw new Error(`Invalid character "${ch}" in secret key`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

export function encodeBase32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
