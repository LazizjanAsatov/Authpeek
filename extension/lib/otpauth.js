// Parses what authenticator QR codes contain:
//   otpauth://totp/Issuer:account?secret=...          (one account)
//   otpauth-migration://offline?data=...              (Google Authenticator "Transfer accounts")
import { decodeBase32, encodeBase32 } from './base32.js';

const ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'];

export function normalizeSecret(secret) {
  const clean = String(secret || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean) throw new Error('Missing secret key');
  decodeBase32(clean); // throws on invalid characters
  return clean;
}

function splitLabel(rawLabel) {
  const label = rawLabel.trim();
  const colon = label.indexOf(':');
  if (colon === -1) return { prefix: '', name: label };
  return { prefix: label.slice(0, colon).trim(), name: label.slice(colon + 1).trim() };
}

export function parseOtpauthUri(uri) {
  const match = /^otpauth:\/\/([^/]+)\/([^?]*)(?:\?(.*))?$/i.exec(String(uri).trim());
  if (!match) throw new Error('Not an otpauth:// link');
  const [, type, rawLabel, query = ''] = match;
  if (type.toLowerCase() !== 'totp') throw new Error('Only time-based (TOTP) codes are supported');

  const params = new URLSearchParams(query);
  const { prefix, name } = splitLabel(decodeURIComponent(rawLabel));
  const algorithm = (params.get('algorithm') || 'SHA1').toUpperCase();
  const digits = Number(params.get('digits') || 6);
  const period = Number(params.get('period') || 30);

  if (!ALGORITHMS.includes(algorithm)) throw new Error(`Unsupported algorithm ${algorithm}`);
  if (![6, 7, 8].includes(digits)) throw new Error(`Unsupported digit count ${digits}`);
  if (!(period > 0)) throw new Error(`Invalid period ${period}`);

  return {
    issuer: (params.get('issuer') || prefix).trim(),
    label: name,
    secret: normalizeSecret(params.get('secret')),
    digits,
    period,
    algorithm,
  };
}

// --- Google Authenticator export (protobuf) ---

function readProto(bytes) {
  const fields = [];
  let pos = 0;
  const varint = () => {
    let result = 0;
    let scale = 1;
    for (;;) {
      if (pos >= bytes.length) throw new Error('Corrupt export data');
      const b = bytes[pos++];
      result += (b & 127) * scale;
      if (b < 128) return result;
      scale *= 128;
    }
  };
  while (pos < bytes.length) {
    const tag = varint();
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) fields.push({ num, value: varint() });
    else if (wire === 2) {
      const len = varint();
      fields.push({ num, value: bytes.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error('Corrupt export data');
  }
  return fields;
}

function base64ToBytes(b64) {
  const std = b64.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function parseMigrationUri(uri) {
  const match = /^otpauth-migration:\/\/offline\?(.*)$/i.exec(String(uri).trim());
  if (!match) throw new Error('Not a Google Authenticator export link');
  const data = new URLSearchParams(match[1]).get('data');
  if (!data) throw new Error('Export link has no data');

  const text = new TextDecoder();
  const accounts = [];
  let skipped = 0;
  const batch = { index: 0, size: 1 };

  for (const f of readProto(base64ToBytes(data))) {
    if (f.num === 3) batch.size = f.value;
    if (f.num === 4) batch.index = f.value;
    if (f.num !== 1) continue;

    const p = { secret: null, name: '', issuer: '', algorithm: 1, digits: 1, type: 2 };
    for (const g of readProto(f.value)) {
      if (g.num === 1) p.secret = g.value;
      else if (g.num === 2) p.name = text.decode(g.value);
      else if (g.num === 3) p.issuer = text.decode(g.value);
      else if (g.num === 4) p.algorithm = g.value;
      else if (g.num === 5) p.digits = g.value;
      else if (g.num === 6) p.type = g.value;
    }
    const algorithm = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' }[p.algorithm];
    if (p.type === 1 || !algorithm || !p.secret?.length) {
      skipped++;
      continue;
    }
    const { prefix, name } = splitLabel(p.name);
    accounts.push({
      issuer: p.issuer || prefix,
      label: name,
      secret: encodeBase32(p.secret),
      digits: p.digits === 2 ? 8 : 6,
      period: 30,
      algorithm,
    });
  }
  return { accounts, skipped, batch };
}

export function parseQrText(text) {
  const t = String(text).trim();
  if (/^otpauth-migration:/i.test(t)) return parseMigrationUri(t);
  if (/^otpauth:/i.test(t)) return { accounts: [parseOtpauthUri(t)], skipped: 0, batch: null };
  throw new Error('This QR code is not an authenticator code');
}
