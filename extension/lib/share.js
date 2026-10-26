// Sharing a few minutes of codes without the secret. The codes themselves are computed ahead,
// encrypted under a one-off key, and both travel in the link's fragment, which browsers never
// send to the server (RFC 3986 section 3.5). Pure functions; the viewer page has its own copy
// of the decode half (docs/share.js), kept in step by test/share-viewer.test.js.
import { decodeBase32 } from './base32.js';
import { generateTotp } from './totp.js';
import { toB64, fromB64 } from './crypto.js';

export const SHARE_PAGE = 'https://lazizjanasatov.github.io/Authpeek/share';

// Same as displayName in codes.js, which can't be imported here (it touches chrome.storage).
const displayName = (a) => (a.issuer && a.label ? `${a.issuer} (${a.label})` : a.issuer || a.label || 'Account');

// Both decoders refuse a name longer than this (in UTF-16 units, what .length counts), and
// nothing limits how long an issuer or label can be, so a long one is cut here, on whole
// characters so an emoji is never split in half.
const NAME_MAX = 200;
function clipName(name) {
  if (name.length <= NAME_MAX) return name;
  let out = '';
  for (const ch of name) {
    if (out.length + ch.length > NAME_MAX - 1) break;
    out += ch;
  }
  return `${out}…`;
}

// Every code the account shows from the step `startMs` falls in until `minutes` later. The
// first step may be nearly over, so there can be one code more than minutes*60/period.
export async function codesForWindow(account, startMs, minutes) {
  const period = account.period || 30;
  const digits = account.encoder === 'steam' ? 5 : account.digits || 6;
  const secret = decodeBase32(account.secret);
  const stepMs = period * 1000;
  const start = Math.floor(startMs / stepMs) * stepMs;
  const end = startMs + minutes * 60_000;
  const codes = [];
  for (let t = start; t < end; t += stepMs) {
    codes.push(await generateTotp({
      secret, digits, period, algorithm: account.algorithm, encoder: account.encoder, timestamp: t,
    }));
  }
  return { v: 1, name: clipName(displayName(account)), period, digits, start, codes };
}

// The fragment is base64url (RFC 4648 section 5) so it survives URLs and chat apps unescaped.
const toB64url = (bytes) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text) =>
  fromB64(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));

const FRAGMENT = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

// "v1.<iv+ciphertext>.<key>": a fresh AES-256-GCM key each time, nothing derived from a password.
export async function encodeShare(payload) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const box = new Uint8Array(iv.length + ct.length);
  box.set(iv);
  box.set(ct, iv.length);
  return `v1.${toB64url(box)}.${toB64url(raw)}`;
}

// Whoever makes a link controls everything in it (the key travels with it), so accept only
// what AuthPeek itself writes: short codes of digits and Steam letters, a plain name, sane numbers.
const CODE = /^[0-9A-Z]{5,10}$/;
const isValidPayload = (p) =>
  p?.v === 1 && Array.isArray(p.codes) && p.codes.length > 0 && p.codes.length <= 1200 &&
  p.codes.every((c) => typeof c === 'string' && CODE.test(c)) &&
  typeof p.name === 'string' && p.name.length <= 200 &&
  Number.isInteger(p.period) && p.period > 0 && p.period <= 3600 && Number.isFinite(p.start);

export async function decodeShare(fragment) {
  const match = FRAGMENT.exec(String(fragment || '').trim());
  if (!match) throw new Error('This link is not an AuthPeek share link');
  try {
    const box = fromB64url(match[1]);
    const key = await crypto.subtle.importKey('raw', fromB64url(match[2]), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.subarray(0, 12) }, key, box.subarray(12));
    const payload = JSON.parse(new TextDecoder().decode(plain));
    if (!isValidPayload(payload)) throw new Error();
    return payload;
  } catch {
    // A truncated paste, a flipped character, or a key that doesn't fit: all look the same from here.
    throw new Error('This link is damaged');
  }
}

export const shareUrl = (fragment) => `${SHARE_PAGE}#${fragment}`;

// The fragment in a pasted link (or a bare fragment), or null. A bare fragment has to look
// complete (12-byte IV + 16-byte tag at least, 32-byte key) so "v1.2.3" in a sentence is not one.
const IN_LINK = /https?:\/\/lazizjanasatov\.github\.io\/Authpeek\/share(?:\.html)?\/?#(v1\.[A-Za-z0-9_.-]+)/i;
const BARE = /(?<![A-Za-z0-9_.-])(v1\.[A-Za-z0-9_-]{38,}\.[A-Za-z0-9_-]{43})(?![A-Za-z0-9_.-])/;
export function shareFragmentFromText(text) {
  const s = String(text || '');
  const match = IN_LINK.exec(s) || BARE.exec(s);
  return match ? match[1].replace(/\.+$/, '') : null;
}

// The code to show at `nowMs`, with the one after it and the seconds until it changes, or null
// outside the shared window.
export function currentCode(payload, nowMs) {
  const stepMs = payload.period * 1000;
  const index = Math.floor((nowMs - payload.start) / stepMs);
  if (index < 0 || index >= payload.codes.length) return null;
  const stepEnd = payload.start + (index + 1) * stepMs;
  return {
    code: payload.codes[index],
    next: payload.codes[index + 1] ?? null,
    secondsLeft: Math.ceil((stepEnd - nowMs) / 1000),
  };
}

export const isExpired = (payload, nowMs) => nowMs >= payload.start + payload.codes.length * payload.period * 1000;
