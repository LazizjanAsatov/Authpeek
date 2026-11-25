// "Whitelisted IPs", live part: asks the network where this computer is and compares it with
// the user's list. It fails closed: if we can't prove we're on a listed network, the answer is no.
import { parseEntry, ipFromTrace, isAllowed, parseIp, isPrivate } from './networks.js';

export const TRACE_URLS = ['https://www.cloudflare.com/cdn-cgi/trace', 'https://1.1.1.1/cdn-cgi/trace'];
const LOOKUP_TIMEOUT = 4000;
const INTERNAL_TIMEOUT = 1500;
const CACHE_MS = 30_000;
const CACHE_KEY = 'netcheck';

// Stable for the same set of entries, whatever their order or notes.
const listKeyOf = (entries) => entries.map((e) => String(e?.value ?? '')).sort().join('\n');

const validCache = (c) =>
  c && typeof c.listKey === 'string' && Number.isFinite(c.at) && c.result &&
  typeof c.result.allowed === 'boolean' && Array.isArray(c.result.ips);

export function createNetCheck({ fetch, storage, now = Date.now, timeouts = {} } = {}) {
  const lookupMs = timeouts.lookup ?? LOOKUP_TIMEOUT;
  const internalMs = timeouts.internal ?? INTERNAL_TIMEOUT;

  // Resolves with whatever `read` returns, or null on any failure or timeout.
  // redirect: the trace URLs must answer themselves ('error'); see `reachable` for 'manual'.
  async function request(url, ms, read, redirect = 'error') {
    if (typeof fetch !== 'function') return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ms);
    try {
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect, signal: abort.signal });
      return { value: await read(res) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const publicIp = async (url) => {
    const r = await request(url, lookupMs, (res) => res.text());
    const ip = r && ipFromTrace(r.value);
    // A private address here would be a captive portal or a proxy talking, not the internet.
    return ip && !isPrivate(parseIp(ip)) ? ip : null;
  };

  // Any answer at all (even an error page) proves we can reach it; failing TLS or timing out doesn't.
  // A redirect (an intranet sending you to /login or SSO) is an answer too: with 'manual' it comes
  // back as an opaque redirect from the TLS-verified host, and it is never followed.
  const reachable = async (url) => (await request(url, internalMs, async () => true, 'manual')) !== null;

  // This computer's public IPs (distinct), or [] when none could be found. Nothing is cached.
  async function lookupIps() {
    try {
      const found = await Promise.all(TRACE_URLS.map(publicIp));
      return [...new Set(found.filter(Boolean))];
    } catch {
      return [];
    }
  }

  async function readCache() {
    try {
      const got = await storage?.get(CACHE_KEY);
      const c = got?.[CACHE_KEY];
      return validCache(c) ? c : null;
    } catch {
      return null;
    }
  }

  async function writeCache(value) {
    try {
      await storage?.set({ [CACHE_KEY]: value });
    } catch { /* no cache is fine */ }
  }

  async function check({ entries = [], force = false } = {}) {
    const checkedAt = now();
    if (!entries.length) return { allowed: true, ips: [], reason: 'off', checkedAt };

    const listKey = listKeyOf(entries);
    if (!force) {
      const c = await readCache();
      if (c && c.listKey === listKey && c.at <= checkedAt && checkedAt - c.at < CACHE_MS) return c.result;
    }

    const parsed = [];
    for (const e of entries) {
      try { parsed.push(parseEntry(e?.value)); } catch { /* validated when saved; ignore */ }
    }
    // A list we can't read at all must never look like "no list".
    if (!parsed.length) return { allowed: false, ips: [], reason: 'error', checkedAt };

    const [ips, probes] = await Promise.all([
      lookupIps(),
      Promise.all(parsed.filter((e) => e.kind === 'url').map((e) => reachable(e.url))),
    ]);
    const internalOk = probes.some(Boolean);

    const allowed = isAllowed({ entries: parsed, publicIps: ips, internalOk });
    const reason = allowed ? 'ok' : ips.length ? 'not-listed' : 'error';
    const result = { allowed, ips, reason, checkedAt };
    // Failures are not remembered: a flaky moment shouldn't lock the user out for 30 s.
    if (reason !== 'error') await writeCache({ result, listKey, at: checkedAt });
    return result;
  }

  async function forget() {
    try {
      await storage?.remove(CACHE_KEY);
    } catch { /* nothing to forget */ }
  }

  return { check, forget, lookupIps };
}

// Created on first use so importing this file in Node (tests) never touches chrome.* or fetch.
let instance;
const lazy = () =>
  (instance ??= createNetCheck({
    fetch: globalThis.fetch?.bind(globalThis),
    storage: globalThis.chrome?.storage?.session,
  }));

export const netCheck = {
  check: (opts) => lazy().check(opts),
  forget: () => lazy().forget(),
  lookupIps: () => lazy().lookupIps(),
};

// A one-off lookup of this computer's public IPs (the trace URLs), for Settings while the list
// is empty: check() makes no request then. Fails closed to [].
export const lookupIps = () => netCheck.lookupIps();
