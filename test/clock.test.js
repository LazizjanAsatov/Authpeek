import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsetFromTrace, usableOffset, driftMessage } from '../extension/lib/clock.js';

const trace = (ts) => `fl=151f81\nh=www.cloudflare.com\nip=1.2.3.4\nts=${ts}\nvisit_scheme=https\n`;

test('offsetFromTrace compares the server time with the middle of the request', () => {
  // Sent at 1000.0 s, answered at 1000.4 s, server said 1047.2 s → our clock is 47 s slow.
  assert.equal(offsetFromTrace(trace('1047.200'), 1_000_000, 1_000_400), 47_000);
  assert.equal(offsetFromTrace(trace('953.200'), 1_000_000, 1_000_400), -47_000);
});

test('offsetFromTrace gives null for an unexpected answer', () => {
  assert.equal(offsetFromTrace('<html>blocked</html>', 0, 1), null);
});

test('tiny differences are treated as no difference', () => {
  assert.equal(usableOffset(1_400), 0);
  assert.equal(usableOffset(-1_900), 0);
  assert.equal(usableOffset(2_500), 2_500);
});

test('driftMessage warns from 15 seconds off, in plain words', () => {
  assert.equal(driftMessage(14_000), null);
  assert.equal(driftMessage(-47_000), 'Your computer’s clock is 47 seconds fast.');
  assert.equal(driftMessage(47_000), 'Your computer’s clock is 47 seconds slow.');
  assert.equal(driftMessage(3 * 60_000 + 5_000), 'Your computer’s clock is 3 minutes slow.');
});
