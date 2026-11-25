import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetCheck, netCheck, lookupIps } from '../extension/lib/netcheck.js';

const CF = 'https://www.cloudflare.com/cdn-cgi/trace';
const ONE = 'https://1.1.1.1/cdn-cgi/trace';
const INTERNAL = 'https://vpn.corp.example/ping';

const trace = (ip) => ({ status: 200, text: async () => `fl=1\nh=x\nip=${ip}\nts=1\n` });
const html = { status: 200, text: async () => '<html>captive portal</html>' };
const hang = (_url, opts) => new Promise((_, reject) => {
  opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
});

// routes: url -> response | (url, opts) => response/promise. Unknown URL throws.
function makeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = routes[url];
    if (r === undefined) throw new TypeError('network error');
    return typeof r === 'function' ? r(url, opts) : r;
  };
  fn.calls = calls;
  return fn;
}

function makeStorage() {
  const map = new Map();
  return {
    map,
    get: async (k) => (map.has(k) ? { [k]: map.get(k) } : {}),
    set: async (o) => { for (const [k, v] of Object.entries(o)) map.set(k, v); },
    remove: async (k) => { map.delete(k); },
  };
}

function setup(routes, extra = {}) {
  const fetch = makeFetch(routes);
  const storage = makeStorage();
  const clock = { t: 1_000_000 };
  const nc = createNetCheck({ fetch, storage, now: () => clock.t, ...extra });
  return { fetch, storage, clock, nc };
}

const E = (...values) => values.map((value) => ({ value, note: '' }));

test('no entries: off, allowed, no network calls', async () => {
  const { fetch, nc } = setup({});
  const r = await nc.check({ entries: [] });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'off');
  assert.equal(fetch.calls.length, 0);
});

test('matching public IP is ok', async () => {
  const { nc } = setup({ [CF]: trace('203.0.113.7'), [ONE]: trace('203.0.113.7') });
  const r = await nc.check({ entries: E('203.0.113.0/24') });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
  assert.deepEqual(r.ips, ['203.0.113.7']);
});

test('non-matching IP is not-listed and reports the IPs', async () => {
  const { nc } = setup({ [CF]: trace('198.51.100.9'), [ONE]: trace('198.51.100.9') });
  const r = await nc.check({ entries: E('203.0.113.0/24') });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'not-listed');
  assert.deepEqual(r.ips, ['198.51.100.9']);
});

test('IPs are distinct; one endpoint failing is enough', async () => {
  const { nc } = setup({ [CF]: trace('198.51.100.9') });
  const r = await nc.check({ entries: E('203.0.113.5') });
  assert.equal(r.reason, 'not-listed');
  assert.deepEqual(r.ips, ['198.51.100.9']);
});

test('both lookups throw: error, not allowed', async () => {
  const { nc } = setup({});
  const r = await nc.check({ entries: E('203.0.113.5') });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'error');
  assert.deepEqual(r.ips, []);
});

test('HTML body without ip= is an error', async () => {
  const { nc } = setup({ [CF]: html, [ONE]: html });
  const r = await nc.check({ entries: E('203.0.113.5') });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'error');
});

test('a private IP in a trace is not trusted', async () => {
  const { nc } = setup({ [CF]: trace('10.0.0.5'), [ONE]: trace('10.0.0.5') });
  const r = await nc.check({ entries: E('203.0.113.5') });
  assert.equal(r.reason, 'error');
  assert.deepEqual(r.ips, []);
});

test('reachable URL entry is ok even if IP does not match or lookups fail', async () => {
  const a = setup({ [CF]: trace('198.51.100.9'), [ONE]: trace('198.51.100.9'), [INTERNAL]: { status: 404, text: async () => '' } });
  const r1 = await a.nc.check({ entries: E('203.0.113.5', INTERNAL) });
  assert.equal(r1.allowed, true);
  assert.equal(r1.reason, 'ok');
  assert.deepEqual(r1.ips, ['198.51.100.9']);

  const b = setup({ [INTERNAL]: { status: 500, text: async () => '' } });
  const r2 = await b.nc.check({ entries: E(INTERNAL) });
  assert.equal(r2.allowed, true);
  assert.equal(r2.reason, 'ok');
});

test('unreachable URL entry does not allow', async () => {
  const { nc } = setup({ [CF]: trace('198.51.100.9') });
  const r = await nc.check({ entries: E(INTERNAL) });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'not-listed');
});

test('unreachable URL entry and no IP is error', async () => {
  const { nc } = setup({});
  const r = await nc.check({ entries: E(INTERNAL) });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'error');
});

test('fetch options are strict', async () => {
  const { fetch, nc } = setup({ [CF]: trace('203.0.113.7'), [ONE]: trace('203.0.113.7'), [INTERNAL]: html });
  await nc.check({ entries: E('203.0.113.7', INTERNAL) });
  assert.deepEqual(fetch.calls.map((c) => c.url).sort(), [CF, ONE, INTERNAL].sort());
  for (const { url, opts } of fetch.calls) {
    assert.equal(opts.cache, 'no-store');
    assert.equal(opts.credentials, 'omit');
    // The trace URLs must answer themselves; the internal probe never follows a redirect either.
    assert.equal(opts.redirect, url === INTERNAL ? 'manual' : 'error', url);
    assert.ok(opts.signal);
  }
});

test('an internal address that redirects (to /login or SSO) counts as reachable', async () => {
  // What fetch gives for redirect: 'manual': an opaque redirect, status 0, from the TLS-verified host.
  const opaque = (_url, opts) => {
    if (opts.redirect === 'error') throw new TypeError('redirect mode is error'); // what 'error' would do
    return { type: 'opaqueredirect', status: 0, text: async () => '' };
  };
  const { nc } = setup({ [CF]: trace('198.51.100.9'), [ONE]: trace('198.51.100.9'), [INTERNAL]: opaque });
  const r = await nc.check({ entries: E(INTERNAL) });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
});

test('a trace URL that redirects is not trusted', async () => {
  const redirecting = (_url, opts) => {
    if (opts.redirect === 'error') throw new TypeError('redirect mode is error');
    return trace('203.0.113.7');
  };
  const { nc } = setup({ [CF]: redirecting, [ONE]: redirecting });
  const r = await nc.check({ entries: E('203.0.113.7') });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'error');
});

test('lookupIps: one-off lookup of the public IPs, distinct, nothing cached', async () => {
  const { fetch, storage, nc } = setup({ [CF]: trace('203.0.113.7'), [ONE]: trace('203.0.113.7') });
  assert.deepEqual(await nc.lookupIps(), ['203.0.113.7']);
  assert.deepEqual(fetch.calls.map((c) => c.url).sort(), [CF, ONE].sort());
  for (const { opts } of fetch.calls) assert.equal(opts.redirect, 'error');
  assert.equal(storage.map.size, 0);
  const both = setup({ [CF]: trace('2001:db8::5'), [ONE]: trace('203.0.113.7') });
  assert.deepEqual(await both.nc.lookupIps(), ['2001:db8::5', '203.0.113.7']);
});

test('lookupIps fails closed to []', async () => {
  assert.deepEqual(await setup({}).nc.lookupIps(), []);
  assert.deepEqual(await setup({ [CF]: html, [ONE]: trace('10.0.0.5') }).nc.lookupIps(), []);
  const slow = setup({ [CF]: hang, [ONE]: hang }, { timeouts: { lookup: 10 } });
  assert.deepEqual(await slow.nc.lookupIps(), []);
  assert.deepEqual(await createNetCheck({ fetch: undefined }).lookupIps(), []);
});

test('hanging requests time out and fail closed', async () => {
  const { nc } = setup({ [CF]: hang, [ONE]: hang, [INTERNAL]: hang }, { timeouts: { lookup: 20, internal: 10 } });
  const r = await nc.check({ entries: E('203.0.113.5', INTERNAL) });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'error');
});

test('unparseable entries are ignored; all unparseable fails closed', async () => {
  const a = setup({ [CF]: trace('203.0.113.5'), [ONE]: trace('203.0.113.5') });
  const r1 = await a.nc.check({ entries: E('garbage', '203.0.113.5') });
  assert.equal(r1.reason, 'ok');

  const b = setup({ [CF]: trace('203.0.113.5'), [ONE]: trace('203.0.113.5') });
  const r2 = await b.nc.check({ entries: E('garbage', '10.0.0.1') });
  assert.equal(r2.allowed, false);
  assert.equal(r2.reason, 'error');
});

test('second call within 30 s uses the cache', async () => {
  const { fetch, storage, clock, nc } = setup({ [CF]: trace('203.0.113.7'), [ONE]: trace('203.0.113.7') });
  const entries = E('203.0.113.7');
  const first = await nc.check({ entries });
  const n = fetch.calls.length;
  clock.t += 29_999;
  const second = await nc.check({ entries });
  assert.equal(fetch.calls.length, n);
  assert.deepEqual(second, first);
  assert.ok(storage.map.has('netcheck'));
  clock.t += 2;
  await nc.check({ entries });
  assert.ok(fetch.calls.length > n);
});

test('force, changed entries, and a clock moved back bypass the cache', async () => {
  const { fetch, clock, nc } = setup({ [CF]: trace('203.0.113.7'), [ONE]: trace('203.0.113.7') });
  await nc.check({ entries: E('203.0.113.7') });
  let n = fetch.calls.length;
  await nc.check({ entries: E('203.0.113.7'), force: true });
  assert.ok(fetch.calls.length > n);
  n = fetch.calls.length;
  await nc.check({ entries: E('203.0.113.7', '198.51.100.1') });
  assert.ok(fetch.calls.length > n);
  n = fetch.calls.length;
  clock.t -= 5_000;
  await nc.check({ entries: E('203.0.113.7', '198.51.100.1') });
  assert.ok(fetch.calls.length > n);
});

test('entry order and notes do not change the cache key', async () => {
  const { fetch, nc } = setup({ [CF]: trace('203.0.113.7'), [ONE]: trace('203.0.113.7') });
  await nc.check({ entries: [{ value: '203.0.113.7', note: 'a' }, { value: '198.51.100.1', note: '' }] });
  const n = fetch.calls.length;
  await nc.check({ entries: [{ value: '198.51.100.1', note: 'b' }, { value: '203.0.113.7', note: '' }] });
  assert.equal(fetch.calls.length, n);
});

test('errors are not cached', async () => {
  const { fetch, nc } = setup({});
  await nc.check({ entries: E('203.0.113.5') });
  const n = fetch.calls.length;
  await nc.check({ entries: E('203.0.113.5') });
  assert.ok(fetch.calls.length > n);
});

test('forget removes the cache', async () => {
  const { fetch, storage, nc } = setup({ [CF]: trace('203.0.113.7'), [ONE]: trace('203.0.113.7') });
  await nc.check({ entries: E('203.0.113.7') });
  await nc.forget();
  assert.equal(storage.map.has('netcheck'), false);
  const n = fetch.calls.length;
  await nc.check({ entries: E('203.0.113.7') });
  assert.ok(fetch.calls.length > n);
});

test('works without storage, and with broken storage', async () => {
  const fetch = makeFetch({ [CF]: trace('203.0.113.7'), [ONE]: trace('203.0.113.7') });
  const none = createNetCheck({ fetch, storage: null, now: () => 5 });
  assert.equal((await none.check({ entries: E('203.0.113.7') })).reason, 'ok');
  await none.forget();

  const broken = { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('x'); }, remove: async () => { throw new Error('x'); } };
  const b = createNetCheck({ fetch, storage: broken, now: () => 5 });
  assert.equal((await b.check({ entries: E('203.0.113.7') })).reason, 'ok');
  await b.forget();
});

test('malformed cache contents are ignored', async () => {
  const { fetch, storage, nc } = setup({ [CF]: trace('203.0.113.7'), [ONE]: trace('203.0.113.7') });
  storage.map.set('netcheck', { result: { allowed: true, reason: 'ok', ips: [] }, listKey: 'nope', at: 'x' });
  const r = await nc.check({ entries: E('198.51.100.1') });
  assert.equal(r.allowed, false);
  assert.ok(fetch.calls.length > 0);
});

test('default instance exists and importing did not throw', () => {
  assert.equal(typeof netCheck.check, 'function');
  assert.equal(typeof netCheck.forget, 'function');
  assert.equal(typeof netCheck.lookupIps, 'function');
  assert.equal(typeof lookupIps, 'function');
});
