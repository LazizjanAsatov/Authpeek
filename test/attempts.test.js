import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAttempts, serialize, decideAutoFill, fillSite, totpStep, WINDOW_MS, MAX_AUTO_PER_SITE,
} from '../extension/lib/attempts.js';
import { linkedSiteFor } from '../extension/lib/sites.js';

// A chrome.storage-shaped area backed by a Map, and a clock the test moves by hand.
function setup() {
  const data = new Map();
  const storage = {
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) data.delete(k); },
  };
  const clock = { t: 1_000_000 };
  return { data, clock, attempts: createAttempts({ storage, now: () => clock.t }) };
}

test('constants', () => {
  assert.equal(WINDOW_MS, 600000);
  assert.equal(MAX_AUTO_PER_SITE, 3);
});

test('a site that rejects and reloads 20 times gets exactly one automatic fill', async () => {
  const { attempts, clock } = setup();
  let fills = 0;
  for (let i = 0; i < 20; i++) {
    const r = await attempts.canAutoFill('a1', 'example.com');
    if (r.ok) {
      fills++;
      await attempts.record('a1', 'example.com', { auto: true, step: 55 });
    }
    clock.t += 5000; // the page reloads a few seconds later
  }
  assert.equal(fills, 1);
});

test('refusal reports when and which step was filled', async () => {
  const { attempts, clock } = setup();
  await attempts.record('a1', 's.com', { auto: true, step: 7 });
  const at = clock.t;
  clock.t += 1000;
  assert.deepEqual(await attempts.canAutoFill('a1', 's.com'), { ok: false, at, step: 7 });
});

test('auto-fill is allowed again after the window passes', async () => {
  const { attempts, clock } = setup();
  await attempts.record('a1', 's.com', { auto: true, step: 1 });
  clock.t += WINDOW_MS - 1;
  assert.equal((await attempts.canAutoFill('a1', 's.com')).ok, false);
  clock.t += 2;
  assert.equal((await attempts.canAutoFill('a1', 's.com')).ok, true);
});

test('a manual fill also blocks auto-fill, and does not count toward the breaker', async () => {
  const { attempts, data } = setup();
  await attempts.record('a1', 's.com', { auto: false, step: 3 });
  assert.equal((await attempts.canAutoFill('a1', 's.com')).ok, false);
  assert.equal(data.has('autofills:s.com'), false);
});

test('another account on the same site is not blocked by the first', async () => {
  const { attempts } = setup();
  await attempts.record('a1', 's.com', { auto: true, step: 1 });
  assert.equal((await attempts.canAutoFill('a2', 's.com')).ok, true);
});

test('circuit breaker: three accounts auto-fill on one site, the fourth is refused', async () => {
  const { attempts, clock } = setup();
  for (const id of ['a1', 'a2', 'a3']) {
    assert.equal((await attempts.canAutoFill(id, 's.com')).ok, true);
    await attempts.record(id, 's.com', { auto: true, step: 1 });
    clock.t += 1000;
  }
  const r = await attempts.canAutoFill('a4', 's.com');
  assert.equal(r.ok, false);
  assert.equal(r.at, clock.t - 1000);
  assert.equal(r.step, null);
  assert.equal(r.why, 'site-limit'); // the card must not name a4 as filled
  // Other sites are unaffected.
  assert.equal((await attempts.canAutoFill('a4', 'other.com')).ok, true);
  // And the breaker lets go once the fills age out.
  clock.t += WINDOW_MS;
  assert.equal((await attempts.canAutoFill('a4', 's.com')).ok, true);
});

test('old autofill timestamps are pruned when recording', async () => {
  const { attempts, clock, data } = setup();
  await attempts.record('a1', 's.com', { auto: true, step: 1 });
  clock.t += WINDOW_MS + 1;
  await attempts.record('a2', 's.com', { auto: true, step: 2 });
  assert.deepEqual(data.get('autofills:s.com'), [clock.t]);
});

test('only the step number is stored, never a code', async () => {
  const { attempts, data } = setup();
  await attempts.record('a1', 's.com', { auto: true, step: 42 });
  assert.deepEqual(data.get('fill:a1|s.com'), { at: 1_000_000, step: 42 });
});

test('serialize makes check-and-record atomic: two concurrent decisions give one fill', async () => {
  const { attempts } = setup();
  const decide = () => serialize('site:x', async () => {
    const r = await attempts.canAutoFill('a1', 'x.com');
    if (r.ok) await attempts.record('a1', 'x.com', { auto: true, step: 1 });
    return r.ok;
  });
  const results = await Promise.all([decide(), decide()]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('serialize keeps going after a rejected call and returns its result', async () => {
  const order = [];
  const a = serialize('k', async () => { order.push('a'); throw new Error('boom'); });
  const b = serialize('k', async () => { order.push('b'); return 5; });
  await assert.rejects(a, /boom/);
  assert.equal(await b, 5);
  assert.deepEqual(order, ['a', 'b']);
});

test('linkedSiteFor returns the linked site that matches the host', () => {
  assert.equal(linkedSiteFor({ sites: ['github.com'] }, 'gist.github.com'), 'github.com');
  assert.equal(linkedSiteFor({ sites: ['github.com'] }, 'github.com'), 'github.com');
  assert.equal(linkedSiteFor({ sites: ['github.com'] }, 'evilgithub.com'), null);
  assert.equal(linkedSiteFor({}, 'github.com'), null);
});

test('a malformed account record blocks instead of letting the fill through', async () => {
  for (const bad of [{ at: undefined, step: 1 }, { at: 'x', step: 1 }, { at: NaN, step: 1 }, null, 'junk', {}]) {
    const { attempts, data, clock } = setup();
    data.set('fill:a1|s.com', bad);
    // No time to show ("0 s ago" would be made up), and a reason the card can word neutrally.
    assert.deepEqual(await attempts.canAutoFill('a1', 's.com'), { ok: false, at: null, step: null, why: 'unknown' });
    assert.ok(clock.t > 0);
  }
});

test('a record stamped in the future (clock moved back) still blocks', async () => {
  const { attempts, data, clock } = setup();
  data.set('fill:a1|s.com', { at: clock.t + 3_600_000, step: 9 });
  assert.equal((await attempts.canAutoFill('a1', 's.com')).ok, false);
  data.set('autofills:s.com', [clock.t + 1, clock.t + 2, clock.t + 3]);
  assert.equal((await attempts.canAutoFill('a2', 's.com')).ok, false);
});

test('malformed breaker storage counts as full', async () => {
  for (const bad of ['x', 5, {}, null, { length: 0 }]) {
    const { attempts, data } = setup();
    data.set('autofills:s.com', bad);
    assert.deepEqual(await attempts.canAutoFill('a1', 's.com'), { ok: false, at: null, step: null, why: 'unknown' });
  }
});

test('non-numeric breaker entries count as recent fills', async () => {
  const { attempts, data } = setup();
  data.set('autofills:s.com', [undefined, 'x', null]);
  assert.deepEqual(await attempts.canAutoFill('a1', 's.com'), { ok: false, at: null, step: null, why: 'site-limit' });
});

test('record overwrites malformed stored values with good ones', async () => {
  const { attempts, data, clock } = setup();
  data.set('fill:a1|s.com', { at: 'x' });
  data.set('autofills:s.com', 'junk');
  await attempts.record('a1', 's.com', { auto: true, step: 4 });
  assert.deepEqual(data.get('fill:a1|s.com'), { at: clock.t, step: 4 });
  assert.deepEqual(data.get('autofills:s.com'), [clock.t]);
});

test('decideAutoFill: two different accounts racing with the breaker at 2 allow only one more', async () => {
  const { attempts, data, clock } = setup();
  data.set('autofills:s.com', [clock.t - 2000, clock.t - 1000]);
  const results = await Promise.all([
    decideAutoFill(attempts, 'a1', 's.com', 1),
    decideAutoFill(attempts, 'a2', 's.com', 1),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(data.get('autofills:s.com').length, 3);
});

test('fillSite prefers the linked site, totpStep uses the period', () => {
  assert.equal(fillSite({ sites: ['github.com'] }, 'gist.github.com'), 'github.com');
  assert.equal(fillSite({ sites: [] }, 'www.example.com'), 'example.com');
  assert.equal(totpStep(90_000, 30), 3);
  assert.equal(totpStep(90_000, 60), 1);
  assert.equal(totpStep(90_000, undefined), 3);
});

test('decideAutoFill holds a Web Lock per site, shared by every extension page', async () => {
  const { attempts } = setup();
  const names = [];
  const locks = { request: async (name, fn) => { names.push(name); return fn(); } };
  assert.equal((await decideAutoFill(attempts, 'a1', 's.com', 1, { locks })).ok, true);
  assert.equal((await decideAutoFill(attempts, 'a1', 's.com', 1, { locks })).ok, false);
  assert.deepEqual(names, ['authpeek-autofill:s.com', 'authpeek-autofill:s.com']);
});

test('decideAutoFill without Web Locks still decides (in-memory chain only)', async () => {
  const { attempts } = setup();
  const results = await Promise.all([
    decideAutoFill(attempts, 'a1', 'x.com', 1, { locks: null }),
    decideAutoFill(attempts, 'a1', 'x.com', 1, { locks: null }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test('decideAutoFill with the real navigator.locks: two concurrent decisions give one fill', async () => {
  if (typeof globalThis.navigator?.locks?.request !== 'function') return; // older Node
  const { attempts: a } = setup();
  const results = await Promise.all([
    decideAutoFill(a, 'a1', 'race.com', 1),
    decideAutoFill(a, 'a1', 'race.com', 1),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});
