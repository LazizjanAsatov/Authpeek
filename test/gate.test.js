import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, pageReply, fillMessage, statusMessage, stepInfo, cleanHints } from '../extension/lib/gate.js';
import { createAttempts } from '../extension/lib/attempts.js';

const RID = 'authpeek-id';
const GH = { id: 'a1', issuer: 'GitHub', label: 'alice', sites: ['github.com'], period: 30, secret: 'SECRET' };

function memStorage() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) data.delete(k); },
  };
}

// Everything the gate uses, with switches and a log of what was called.
function setup({ accounts = [GH], settings = {}, unlocked = true, setUp = true, net = { allowed: true, reason: 'ok' } } = {}) {
  const calls = { network: 0, badges: [], touches: 0, listOptions: [], networkOptions: [], codeSettings: [] };
  const clock = { t: 1_700_000_000_000 };
  const storage = memStorage();
  const attempts = createAttempts({ storage, now: () => clock.t });
  const env = { net, unlocked };
  const vault = {
    isSetUp: async () => setUp,
    isUnlocked: async () => env.unlocked,
    getSettings: async () => ({ autoFill: true, autoSubmit: true, ...settings }),
    listAccounts: async (options) => (calls.listOptions.push(options), accounts),
    touch: async () => void calls.touches++,
  };
  const gate = createGate({
    vault,
    attempts,
    networkAccess: async (_vault, options) => {
      calls.network++;
      calls.networkOptions.push(options);
      if (env.net instanceof Error) throw env.net;
      return env.net;
    },
    codeNow: async (_account, s) => (calls.codeSettings.push(s), { code: '123456', ...stepInfo(clock.t, 30) }),
    now: () => clock.t,
    runtimeId: RID,
    badge: (tabId, status) => calls.badges.push([tabId, status]),
  });
  return { gate, calls, clock, storage, env };
}

const sender = (url = 'https://github.com/login', frameId = 0) => ({ id: RID, tab: { id: 7 }, url, frameId });
const found = (g, extra = {}, url) => g.onContentMessage({ type: 'otp:found', hints: [], ...extra }, sender(url));

test('automatic: first otp:found fills, second one only suggests (the loop fix)', async () => {
  const { gate, clock } = setup();
  const first = await found(gate);
  assert.equal(first.status, 'fill');
  assert.equal(first.code, '123456');
  assert.equal(first.autoSubmit, true);

  clock.t += 40_000; // the site rejected it and reloaded
  const second = await found(gate);
  assert.equal(second.status, 'suggest');
  assert.equal(second.agoMs, 40_000);
  assert.equal(second.nextIn, undefined); // a new step by now
  assert.equal(second.autoSubmit, undefined);
});

test('suggest says when the next code comes if the same code would be tried again', async () => {
  const { gate, clock } = setup();
  clock.t = 30_000 * 1000 * 1000 + 5_000; // 5 s into a step
  await found(gate);
  clock.t += 3_000;
  const r = await found(gate);
  assert.equal(r.status, 'suggest');
  assert.equal(r.nextIn, 22);
});

test('concurrent otp:found from two frames: only one fills', async () => {
  const { gate } = setup();
  const replies = await Promise.all([found(gate), found(gate), found(gate)]);
  assert.deepEqual(replies.map((r) => r.status).sort(), ['fill', 'suggest', 'suggest']);
});

test('force in a content message is ignored', async () => {
  const { gate } = setup({ settings: { autoFill: false } });
  assert.equal((await found(gate, { force: true, auto: false })).status, 'off');
  // and a prior automatic fill can't be bypassed either
  const g2 = setup().gate;
  await found(g2);
  assert.equal((await found(g2, { force: true })).status, 'suggest');
});

test('gate order: set up, off, locked, unlinked, network, pick', async () => {
  assert.equal((await found(setup({ setUp: false }).gate)).status, 'none');
  assert.equal((await found(setup({ settings: { autoFill: false }, unlocked: false }).gate)).status, 'off');
  assert.equal((await found(setup({ unlocked: false }).gate)).status, 'locked');

  // Unlinked site: 'none' without any network lookup (the site learns nothing).
  const off = setup({ net: { allowed: false, reason: 'not-listed' } });
  assert.equal((await found(off.gate, {}, 'https://evil.example/2fa')).status, 'none');
  assert.equal(off.calls.network, 0);
  assert.deepEqual(off.calls.badges, [[7, 'none']]);

  // Linked site off-network: 'network', before the account pick and without a code.
  const r = await found(off.gate);
  assert.deepEqual(r, { status: 'network', reason: 'not-listed' });
  assert.equal(off.calls.network, 1);

  // Several accounts and nothing to tell them apart: choose (after the network gate).
  const two = setup({ accounts: [GH, { ...GH, id: 'a2', label: 'bob' }] });
  assert.deepEqual(await found(two.gate), { status: 'choose', count: 2 });
});

test('network check fails closed (throws, error, rolled back)', async () => {
  for (const net of [new Error('boom'), { allowed: false, reason: 'error' }, { allowed: false, reason: 'rolled-back' }, {}]) {
    const { gate } = setup({ net });
    assert.equal((await found(gate)).status, 'network');
    assert.equal((await gate.resolveForUrl('https://github.com/', { auto: false })).status, 'network');
  }
});

test('network gate on every path', async () => {
  const s = setup({ net: { allowed: false, reason: 'not-listed' } });
  // otp:found (automatic)
  assert.equal((await found(s.gate)).status, 'network');
  // otp:fill-suggested (card)
  const card = await s.gate.onContentMessage({ type: 'otp:fill-suggested' }, sender());
  assert.deepEqual(card, { status: 'network', reason: 'not-listed' });
  // FILL_SITE menu and Alt+Shift+O use the manual resolve
  assert.equal((await s.gate.resolveForUrl('https://github.com/', { auto: false })).status, 'network');
  // hand-picked account menu item
  assert.deepEqual(await s.gate.resolveAccount(GH, 'https://anything.example/'), { status: 'network', reason: 'not-listed' });
  assert.equal(s.calls.network, 4);
  // nothing was recorded
  assert.equal(s.storage.data.size, 0);
});

test('manual paths always fill and record; the record blocks the next automatic fill', async () => {
  const s = setup();
  const r = await s.gate.resolveForUrl('https://gist.github.com/x', { auto: false });
  assert.equal(r.status, 'fill');
  await s.gate.recordManual(r);
  assert.ok(s.storage.data.has('fill:a1|github.com')); // keyed by the linked site
  assert.equal(s.storage.data.has('autofills:github.com'), false); // manual isn't counted by the breaker
  assert.equal((await found(s.gate)).status, 'suggest');
  // a manual fill right after still works
  assert.equal((await s.gate.resolveForUrl('https://github.com/', { auto: false })).status, 'fill');
});

test('otp:fill-suggested: fresh code, never auto-submit, recorded only once the page confirms', async () => {
  const s = setup();
  await found(s.gate);
  s.calls.badges.length = 0;
  const before = structuredClone(s.storage.data.get('fill:a1|github.com'));
  s.clock.t += 5_000;
  const r = await s.gate.onContentMessage({ type: 'otp:fill-suggested', autoSubmit: true }, sender());
  assert.deepEqual(r, { status: 'fill', code: '123456', name: 'GitHub (alice)' });
  // Not recorded yet, and the '!' badge stays while the card is still up.
  assert.deepEqual(s.storage.data.get('fill:a1|github.com'), before);
  assert.deepEqual(s.calls.badges, []);
  // The page filled it: now it is recorded and the badge cleared.
  assert.equal(await s.gate.onContentMessage({ type: 'otp:card-filled', host: 'github.com' }, sender()), null);
  assert.equal(s.storage.data.get('fill:a1|github.com').at, s.clock.t);
  assert.deepEqual(s.calls.badges, [[7, 'fill']]);
  // A second confirmation (nothing pending any more) does nothing.
  s.clock.t += 1_000;
  await s.gate.onContentMessage({ type: 'otp:card-filled', host: 'github.com' }, sender());
  assert.equal(s.storage.data.get('fill:a1|github.com').at, s.clock.t - 1_000);
  // several accounts: choose
  const two = setup({ accounts: [GH, { ...GH, id: 'a2', label: 'bob' }] });
  assert.deepEqual(await two.gate.onContentMessage({ type: 'otp:fill-suggested' }, sender()), { status: 'choose', count: 2 });
});

test('attempt storage failure means suggest, not fill', async () => {
  const s = setup();
  s.storage.get = async () => { throw new Error('storage gone'); };
  assert.equal((await found(s.gate)).status, 'suggest');
});

test('messages not from our own content script are ignored', () => {
  const { gate } = setup();
  assert.equal(gate.onContentMessage({ type: 'otp:found' }, { id: 'other', tab: { id: 1 }, url: 'https://github.com/' }), null);
  assert.equal(gate.onContentMessage({ type: 'otp:found' }, { id: RID, url: 'https://github.com/' }), null); // no tab
  assert.equal(gate.onContentMessage({ type: 'otp:other' }, sender()), null);
});

test('card-closed clears the badge', async () => {
  const s = setup();
  await s.gate.onContentMessage({ type: 'otp:card-closed' }, sender());
  assert.deepEqual(s.calls.badges, [[7, 'card-closed']]);
});

test('pageReply never leaks internal fields', async () => {
  const { gate } = setup();
  const internal = await gate.resolveForUrl('https://github.com/', { auto: false });
  assert.ok(internal.account && internal.host && Number.isFinite(internal.step));
  const out = pageReply({ ...internal, reason: 'not-listed', secret: 'x' });
  assert.deepEqual(Object.keys(out).sort(), ['autoSubmit', 'code', 'name', 'status']);
  const reply = await found(setup().gate);
  for (const k of ['account', 'host', 'step', 'reason', 'secret']) assert.equal(k in reply, false);
});

test('fillMessage names the host the code is for', async () => {
  const { gate } = setup();
  const r = await gate.resolveForUrl('https://gist.github.com/x', { auto: false });
  assert.deepEqual(fillMessage(r), { type: 'otp:fill', code: '123456', name: 'GitHub (alice)', autoSubmit: true, host: 'gist.github.com' });
});

test('helpers', () => {
  assert.deepEqual(stepInfo(65_000, 30), { step: 2, secondsLeft: 25 });
  assert.deepEqual(stepInfo(65_000, undefined), { step: 2, secondsLeft: 25 });
  assert.deepEqual(cleanHints(['a', 1, 'b'.repeat(300)]).map((h) => h.length), [1, 200]);
  assert.deepEqual(cleanHints('x'), []);
});

test('otp:card-filled is ignored unless it matches a pending card fill from the same tab, frame and host', async () => {
  const s = setup();
  const ask = (snd = sender()) => s.gate.onContentMessage({ type: 'otp:fill-suggested' }, snd);
  const confirm = (host, snd = sender()) => s.gate.onContentMessage({ type: 'otp:card-filled', host }, snd);
  const recorded = () => s.storage.data.has('fill:a1|github.com');

  await confirm('github.com'); // nothing pending
  await ask();
  await confirm('evil.example'); // wrong host (and the pending one is used up)
  await confirm('github.com');
  await ask();
  await confirm('github.com', sender('https://github.com/login', 3)); // another frame
  await ask();
  await confirm('github.com', sender('https://evil.example/')); // the frame navigated away
  await ask();
  await confirm(undefined);
  await ask();
  s.clock.t += 61_000; // too late
  await confirm('github.com');
  assert.equal(recorded(), false);
  assert.equal(s.calls.badges.some(([, st]) => st === 'fill'), false);
  // Not our own content script: not even handled.
  const foreign = { id: 'x', tab: { id: 7 }, url: 'https://github.com/' };
  assert.equal(s.gate.onContentMessage({ type: 'otp:card-filled', host: 'github.com' }, foreign), null);

  await ask();
  await confirm('github.com');
  assert.equal(recorded(), true);
});

test('the card failing (no code box) leaves the next card able to fill the same code', async () => {
  const s = setup();
  s.clock.t = 30_000 * 1000 * 1000 + 5_000; // 5 s into a step
  await found(s.gate); // automatic fill, recorded with this step
  s.clock.t += 31_000; // next step
  await s.gate.onContentMessage({ type: 'otp:fill-suggested' }, sender()); // no confirmation follows
  const r = await found(s.gate);
  assert.equal(r.status, 'suggest');
  assert.equal(r.nextIn, undefined); // not "the code that was just used"
});

test('suggest: the circuit breaker says so and names no time; unreadable records name no time', async () => {
  const s = setup();
  s.storage.data.set('autofills:github.com', [s.clock.t - 3000, s.clock.t - 2000, s.clock.t - 1000]);
  const r = await found(s.gate);
  assert.equal(r.status, 'suggest');
  assert.equal(r.why, 'site-limit');
  assert.equal('agoMs' in r, false);
  assert.equal('nextIn' in r, false);

  const m = setup();
  m.storage.data.set('fill:a1|github.com', { at: 'x', step: 1 });
  const r2 = await found(m.gate);
  assert.deepEqual([r2.status, r2.why, 'agoMs' in r2], ['suggest', 'unknown', false]);

  const broken = setup();
  broken.storage.get = async () => { throw new Error('storage gone'); };
  const r3 = await found(broken.gate);
  assert.deepEqual([r3.status, r3.why, 'agoMs' in r3], ['suggest', 'unknown', false]);

  // This account's own fill: the time, and no why.
  const own = setup();
  await found(own.gate);
  own.clock.t += 40_000;
  const r4 = await found(own.gate);
  assert.deepEqual([r4.why, r4.agoMs], [undefined, 40_000]);
});

test('network refusals carry a page-safe reason; a vault that locked meanwhile is "locked"', async () => {
  for (const [net, want] of [
    [{ allowed: false, reason: 'not-listed' }, 'not-listed'],
    [{ allowed: false, reason: 'error' }, 'error'],
    [{ allowed: false, reason: 'rolled-back' }, 'rolled-back'],
    [{ allowed: false, reason: 'something-else' }, 'error'],
    [{ allowed: false }, 'error'],
    [new Error('boom'), 'error'],
  ]) {
    const { gate } = setup({ net });
    assert.deepEqual(await found(gate), { status: 'network', reason: want });
  }
  const { gate } = setup({ net: { allowed: false, reason: 'locked' } });
  assert.deepEqual(await found(gate), { status: 'locked' });
  assert.deepEqual(await gate.resolveAccount(GH, 'https://github.com/'), { status: 'locked' });
});

test('pageReply: reason only for network, why only from the gate', () => {
  assert.deepEqual(pageReply({ status: 'network', reason: 'not-listed' }), { status: 'network', reason: 'not-listed' });
  assert.deepEqual(pageReply({ status: 'network', reason: '__proto__' }), { status: 'network', reason: 'error' });
  assert.deepEqual(pageReply({ status: 'network' }), { status: 'network', reason: 'error' });
  assert.equal('reason' in pageReply({ status: 'fill', code: '1', reason: 'not-listed' }), false);
  assert.deepEqual(pageReply({ status: 'suggest', code: '1', name: 'n', why: 'site-limit', agoMs: null }), {
    status: 'suggest', code: '1', name: 'n', why: 'site-limit',
  });
});

test('statusMessage names the frame host, so only that frame answers', () => {
  assert.deepEqual(statusMessage('https://Gist.GitHub.com/x'), { type: 'otp:status', host: 'gist.github.com' });
  assert.deepEqual(statusMessage('chrome://extensions'), { type: 'otp:status', host: null });
  assert.deepEqual(statusMessage(undefined), { type: 'otp:status', host: null });
});

test('fillMessage takes no options (autoSubmit comes from the result)', () => {
  assert.equal(fillMessage.length, 1);
  assert.equal(fillMessage({ code: '1', name: 'n', host: 'h', autoSubmit: 0 }).autoSubmit, false);
});

// Main's 1.2 rule, kept by the gate: only real use restarts the idle timer. Looking (the account
// list, the whitelist) passes touch: false; only a code going into a page calls vault.touch().
test('idle timer: an automatic fill touches once, a suggestion and an unlinked page never do', async () => {
  const { gate, calls, clock } = setup();
  await found(gate);
  assert.equal(calls.touches, 1); // the fill
  assert.ok(calls.listOptions.every((o) => o?.touch === false));
  assert.ok(calls.networkOptions.every((o) => o?.touch === false));

  clock.t += 40_000;
  assert.equal((await found(gate)).status, 'suggest');
  assert.equal(calls.touches, 1); // the suggestion is not use until the user takes it

  assert.equal((await found(gate, {}, 'https://unlinked.example/')).status, 'none');
  assert.equal(calls.touches, 1);
});

test('idle timer: a refused network check does not touch', async () => {
  const { gate, calls } = setup({ net: { allowed: false, reason: 'not-listed' } });
  await found(gate);
  assert.equal(calls.touches, 0);
});

test('idle timer: the card, the shortcut and a hand-picked account touch when a code goes out', async () => {
  const { gate, calls } = setup();
  await gate.onContentMessage({ type: 'otp:fill-suggested', hints: [] }, sender());
  assert.equal(calls.touches, 1);
  await gate.resolveForUrl('https://github.com/login', { tabId: 7 });
  assert.equal(calls.touches, 2);
  await gate.resolveAccount(GH, 'https://github.com/');
  assert.equal(calls.touches, 3);
});

test('codeNow gets the settings, so the clock can be checked before a fill', async () => {
  const { gate, calls } = setup({ settings: { clockCheck: true } });
  await found(gate);
  await gate.resolveAccount(GH, 'https://github.com/');
  assert.equal(calls.codeSettings.length, 2);
  assert.ok(calls.codeSettings.every((s) => s?.clockCheck === true));
});
