import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase32 } from '../extension/lib/base32.js';
import { generateTotp } from '../extension/lib/totp.js';

// codes.js keeps its clock correction in chrome.storage.local and measures it with fetch.
// Here `realTime` is what the phone goes by, and this computer's clock is `clockError` ms off.
const WINDOW = Date.UTC(2026, 9, 22, 9, 0, 0); // the start of a 30-second code window
let realTime = WINDOW;
let clockError = 0;
let requests = 0;
let slowNetwork = false;
Date.now = () => realTime + clockError;

const stored = {};
const listeners = [];
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { return key in stored ? { [key]: structuredClone(stored[key]) } : {}; },
      async set(items) {
        for (const [k, v] of Object.entries(items)) {
          const oldValue = stored[k];
          stored[k] = structuredClone(v);
          for (const fn of listeners) fn({ [k]: { oldValue, newValue: structuredClone(v) } }, 'local');
        }
      },
      async remove(key) { delete stored[key]; },
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  },
};
// Cloudflare's trace answer, or a request that hangs until it is given up on.
globalThis.fetch = (url, { signal }) => {
  requests++;
  if (slowNetwork) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  return Promise.resolve({ text: async () => `fl=1\nts=${(realTime / 1000).toFixed(3)}\nvisit_scheme=https\n` });
};

const { codeFor, codeToFill, checkClock } = await import('../extension/lib/codes.js');

const account = { secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' };
const phoneCode = () => generateTotp({ secret: decodeBase32(account.secret), timestamp: realTime });
// 25 seconds into a window, so a correction that is 12 s too big shows the next window's code.
const hoursLater = (hours) => WINDOW + hours * 3_600_000 + 25_000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a clock fixed after it was measured is noticed the next time codes are shown', async () => {
  realTime = hoursLater(0);
  clockError = -12_000; // 12 seconds slow
  await checkClock();
  assert.equal(await codeFor(account), await phoneCode());

  // Windows syncs the time; an hour later the popup opens and checks again.
  clockError = 0;
  realTime = hoursLater(1);
  await checkClock();
  assert.equal(await codeFor(account), await phoneCode());
});

test('a code about to be filled is worked out after a fresh clock check', async () => {
  realTime = hoursLater(2);
  clockError = -12_000;
  await checkClock();

  // The clock gets fixed, then a page asks for a code before the popup is opened again.
  clockError = 0;
  realTime = hoursLater(3);
  assert.equal(await codeToFill(account, { clockCheck: true }), await phoneCode());
});

test('with the clock check off, filling a code makes no request', async () => {
  const before = requests;
  await codeToFill(account, { clockCheck: false });
  assert.equal(requests, before);
});

test('checks started together share one request', async () => {
  const before = requests;
  await Promise.all([checkClock(), checkClock(), codeToFill(account, { clockCheck: true })]);
  assert.equal(requests - before, 1);
});

test('a slow network holds a fill up for at most 1.5 seconds, then the last measurement is used', async (t) => {
  realTime = hoursLater(4);
  clockError = -12_000;
  await checkClock();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  slowNetwork = true;
  let code = null;
  const fill = codeToFill(account, { clockCheck: true }).then((c) => (code = c));
  await settle();
  t.mock.timers.tick(1_499);
  await settle();
  assert.equal(code, null);
  t.mock.timers.tick(1);
  await fill;
  assert.equal(code, await phoneCode());

  t.mock.timers.tick(5_000); // the request is given up on
  await settle();
  slowNetwork = false;
});
