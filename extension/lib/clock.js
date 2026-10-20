// Codes depend on the computer's clock. If it's off by more than ~30 seconds every code is
// rejected, and nothing says why. AuthPeek compares with Cloudflare's public time endpoint
// (no data sent, just a request), corrects its own codes, and warns.

export const TIME_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const CHECK_EVERY = 12 * 3_600_000;

// Our clock's error in ms: server time minus local time at the middle of the request.
export function offsetFromTrace(text, sentAt, receivedAt) {
  const m = /^ts=(\d+(?:\.\d+)?)$/m.exec(String(text));
  if (!m) return null;
  return Math.round(Number(m[1]) * 1000 - (sentAt + receivedAt) / 2);
}

// Differences under 2 seconds are measurement noise.
export const usableOffset = (offset) => (Math.abs(offset) < 2_000 ? 0 : offset);

export function driftMessage(offset) {
  const ms = Math.abs(offset);
  if (ms < 15_000) return null;
  const amount = ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
  return `Your computer’s clock is ${amount} ${offset > 0 ? 'slow' : 'fast'}.`;
}

export const shouldCheck = (checkedAt, now) => !checkedAt || now - checkedAt >= CHECK_EVERY;
