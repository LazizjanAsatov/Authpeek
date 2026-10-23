// The viewer's copy of the share-link logic, for lazizjanasatov.github.io/Authpeek/share.
// A plain script on purpose: this page works from file:// and imports nothing from the
// extension. The original is extension/lib/share.js; test/share-viewer.test.js runs both on
// the same links, so a change in one has to be made in the other.
(() => {
  'use strict';

  const FRAGMENT = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

  const fromB64url = (text) => {
    const std = text.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(std.padEnd(Math.ceil(std.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  };

  // Whoever makes a link controls everything in it (the key travels with it), so accept only
  // what AuthPeek itself writes: short codes of digits and Steam letters, a plain name, sane numbers.
  const CODE = /^[0-9A-Z]{5,10}$/;
  const isValidPayload = (p) =>
    p?.v === 1 && Array.isArray(p.codes) && p.codes.length > 0 && p.codes.length <= 1200 &&
    p.codes.every((c) => typeof c === 'string' && CODE.test(c)) &&
    typeof p.name === 'string' && p.name.length <= 200 &&
    Number.isInteger(p.period) && p.period > 0 && p.period <= 3600 && Number.isFinite(p.start);

  // "v1.<iv+ciphertext>.<key>", both base64url, AES-256-GCM with a 12-byte IV in front.
  async function decodeShare(fragment) {
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
      throw new Error('This link is damaged');
    }
  }

  // The code to show at nowMs, the one after it, and the seconds until it changes.
  function currentCode(payload, nowMs) {
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

  const isExpired = (payload, nowMs) => nowMs >= payload.start + payload.codes.length * payload.period * 1000;

  window.AuthPeekShare = { decodeShare, currentCode, isExpired };
})();
