// Remembers what AuthPeek already filled, so a site that rejects a code and reloads
// can never trigger the same fill again (and lock the account). Kept in session
// storage (the background and the popup share it), so a page reload cannot reset it.
// Only the TOTP step number is stored, never a code.
import { linkedSiteFor, siteForHost } from './sites.js';

export const WINDOW_MS = 10 * 60_000;
export const MAX_AUTO_PER_SITE = 3;

// The site and TOTP step a fill is recorded under.
export const fillSite = (account, host) => linkedSiteFor(account, host) || siteForHost(host);
export const totpStep = (nowMs, period) => Math.floor(nowMs / 1000 / (Number(period) || 30));

const fillKey = (accountId, site) => `fill:${accountId}|${site}`;
const autoKey = (site) => `autofills:${site}`;

// Stored values come from storage, so treat them as untrusted: anything unreadable
// blocks auto-fill instead of waving it through (fail closed).
const isTime = (t) => typeof t === 'number' && Number.isFinite(t);
// A future time (the clock moved back) counts as recent, so it blocks rather than expires.
const isRecent = (t, at) => !isTime(t) || at - t < WINDOW_MS;

// A refusal is { ok: false, at, step, why }:
//   no why        this account was filled here at `at` (step `step`, null if unknown)
//   'site-limit'  the circuit breaker: MAX_AUTO_PER_SITE automatic fills on this site, any account
//   'unknown'     the stored record is unreadable; there is no time to show (`at` is null)
export function createAttempts({ storage, now }) {
  return {
    async canAutoFill(accountId, site) {
      const fk = fillKey(accountId, site);
      const ak = autoKey(site);
      const got = await storage.get([fk, ak]);
      const t = now();
      // Any fill of this account here, manual or automatic, blocks another automatic one.
      if (fk in got) {
        const last = got[fk];
        if (!last || !isTime(last.at)) return { ok: false, at: null, step: null, why: 'unknown' };
        if (isRecent(last.at, t)) return { ok: false, at: last.at, step: last.step ?? null };
      }
      // Circuit breaker: too many automatic fills on one site, whichever account.
      // The refusal carries no step, even when the latest fill's step is known.
      if (ak in got) {
        const list = got[ak];
        if (!Array.isArray(list)) return { ok: false, at: null, step: null, why: 'unknown' };
        const autos = list.filter((x) => isRecent(x, t));
        if (autos.length >= MAX_AUTO_PER_SITE) {
          const times = autos.filter(isTime);
          return { ok: false, at: times.length ? Math.max(...times) : null, step: null, why: 'site-limit' };
        }
      }
      return { ok: true };
    },

    async record(accountId, site, { auto, step }) {
      const at = now();
      await storage.set({ [fillKey(accountId, site)]: { at, step } });
      if (auto) {
        const ak = autoKey(site);
        const old = (await storage.get(ak))[ak];
        // Malformed leftovers are overwritten with a clean list.
        const list = Array.isArray(old) ? old.filter((x) => isTime(x) && isRecent(x, at)) : [];
        list.push(at);
        await storage.set({ [ak]: list });
      }
    },
  };
}

// One-at-a-time per key, so "check, then record" cannot interleave with another request.
const chains = new Map();

// Callers that touch the breaker (autofills:<site>) MUST key by site ('site:<site>'): two
// accounts on one site under different keys would both read the same list and undercount.
// Use decideAutoFill so the key cannot be chosen wrongly.
export function serialize(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run even if the previous call failed
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

// Check and record one automatic fill as a single step, per site. The in-memory chain only
// covers one JavaScript context, so the step also holds a Web Lock (navigator.locks), which
// every page of the extension shares: the popup's fill after unlocking and a background fill
// can't both pass at the same moment.
export function decideAutoFill(attempts, accountId, site, step, { locks = globalThis.navigator?.locks } = {}) {
  const decide = async () => {
    const r = await attempts.canAutoFill(accountId, site);
    if (r.ok) await attempts.record(accountId, site, { auto: true, step });
    return r;
  };
  return serialize('site:' + site, () =>
    typeof locks?.request === 'function' ? locks.request('authpeek-autofill:' + site, decide) : decide()
  );
}
