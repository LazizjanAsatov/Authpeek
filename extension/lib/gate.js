// The background's decision on "may this page get a code, and may it be filled by itself?".
// Kept free of chrome.* (everything is injected) so the security gate is unit-tested
// (test/gate.test.js). Order, for every path:
//   set up? → (automatic and "Fill codes automatically" off → off) → unlocked?
//   → linked account for this host? (none: automatic → 'none', manual → 'choose')
//   → Whitelisted IPs (fails closed) → account pick → automatic: one fill per account+site
//   per 10 minutes (lib/attempts.js), else a suggestion.
// Content scripts can never choose the manual rules: only `otp:fill-suggested` (the card's
// trusted click) is manual, and it never asks for Verify to be pressed.
// Idle timer: looking (the account list, the whitelist) never counts as use, so a page with a
// code field can't keep the vault unlocked. Only a code that is about to go into a page
// restarts the timer (vault.touch()); a suggestion doesn't, until the user takes it.
import { hostOf, accountsForHost } from './sites.js';
import { pickAccount } from './identity.js';
import { displayName } from './codes.js';
import { decideAutoFill as realDecide, fillSite, totpStep } from './attempts.js';

// Only these fields ever go to a page's content script.
const PAGE_FIELDS = ['code', 'name', 'autoSubmit', 'nextIn', 'agoMs', 'count', 'why'];
// Why codes are off on this network, as a page may hear it (it picks the toast's words).
const NETWORK_REASONS = ['not-listed', 'error', 'rolled-back'];
export function pageReply(r) {
  const out = { status: r?.status ?? 'error' };
  for (const k of PAGE_FIELDS) if (r?.[k] !== undefined && r[k] !== null) out[k] = r[k];
  if (out.status === 'network') out.reason = NETWORK_REASONS.includes(r?.reason) ? r.reason : 'error';
  return out;
}

export const cleanHints = (h) =>
  Array.isArray(h) ? h.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 20) : [];

// The `otp:fill` message for a 'fill' result. `host` is the host the code was resolved for;
// the content script refuses to fill when its own frame is on another host.
export const fillMessage = (r) => ({
  type: 'otp:fill',
  code: r.code,
  name: r.name,
  autoSubmit: !!r.autoSubmit,
  host: r.host,
});

// The `otp:status` question for the frame at `url`. Only a frame on that host answers, so the
// field and the usernames it reports belong to the page the code will be resolved for.
export const statusMessage = (url) => ({ type: 'otp:status', host: hostOf(url) });

// The step a code belongs to and the seconds left in it, from one timestamp.
export function stepInfo(nowMs, period) {
  const p = Number(period) || 30;
  return { step: totpStep(nowMs, p), secondsLeft: p - (Math.floor(nowMs / 1000) % p) };
}

// How long the background waits for the card's "filled" confirmation (otp:card-filled).
const CARD_CONFIRM_MS = 60_000;

export function createGate({
  vault,
  networkAccess, // (vault, { touch }) -> { allowed, reason }
  attempts, // createAttempts(...)
  codeNow, // async (account, settings) -> { code, step, secondsLeft }
  typedUsername = async () => '',
  decideAutoFill = realDecide,
  now = Date.now,
  runtimeId,
  badge = () => {}, // (tabId, status)
}) {
  // { ok } or { ok: false, reason }; anything unexpected fails closed.
  async function networkCheck() {
    try {
      const access = await networkAccess(vault, { touch: false }); // looking isn't use
      return access?.allowed === true ? { ok: true } : { ok: false, reason: access?.reason };
    } catch {
      return { ok: false, reason: 'error' };
    }
  }

  // The refusal for a failed network check. The vault locking between the two checks is
  // reported as 'locked' (it isn't the network's fault).
  const networkRefusal = ({ reason }) =>
    reason === 'locked'
      ? { status: 'locked' }
      : { status: 'network', reason: NETWORK_REASONS.includes(reason) ? reason : 'error' };

  // `url` is the URL of the frame that will receive the code, from Chrome (never the page).
  async function resolveForUrl(url, { tabId, hints = [], auto = false } = {}) {
    const host = hostOf(url);
    if (!host || !(await vault.isSetUp())) return { status: 'none' };

    const settings = await vault.getSettings();
    if (auto === true && !settings.autoFill) return { status: 'off' };
    if (!(await vault.isUnlocked())) return { status: 'locked' };

    const accounts = await vault.listAccounts({ touch: false }); // just looking: the site may not be linked
    const linked = accountsForHost(accounts, host);
    // Unlinked sites learn nothing (no network lookup, no badge, no toast).
    if (!linked.length) return auto === true ? { status: 'none' } : { status: 'choose', count: 0 };

    const net = await networkCheck();
    if (!net.ok) return networkRefusal(net);

    const others = accounts.filter((a) => !linked.includes(a));
    const { account } = pickAccount({ linked, others, hints, typed: await typedUsername(tabId) });
    if (!account) return { status: 'choose', count: linked.length };

    const { code, step, secondsLeft } = await codeNow(account, settings);
    const name = displayName(account);
    const result = { status: 'fill', code, name, autoSubmit: !!settings.autoSubmit, account, host, step };
    if (auto !== true) {
      await vault.touch(); // a code going to a page counts as using the vault
      return result;
    }

    // Check and record as one serialized step per site; any failure means no automatic fill.
    let decision;
    try {
      decision = await decideAutoFill(attempts, account.id, fillSite(account, host), step);
    } catch {
      decision = null;
    }
    if (decision?.ok === true) {
      await vault.touch();
      return result;
    }

    // Why it was refused picks the card's words: this account's own fill here (with how long
    // ago), the site's circuit breaker (any account), or a record that can't be read (no time).
    const why = decision?.why === 'site-limit'
      ? 'site-limit'
      : decision?.why === 'unknown' || !Number.isFinite(decision?.at) ? 'unknown' : undefined;
    return {
      status: 'suggest',
      code,
      name,
      why,
      agoMs: why ? null : Math.max(0, now() - decision.at),
      // Same step as the code already tried: it would just be rejected again.
      nextIn: !why && decision.step === step ? secondsLeft : undefined,
    };
  }

  // A hand-picked account (right-click ▸ account): only the network gate applies.
  async function resolveAccount(account, url) {
    const host = hostOf(url);
    if (!host || !account) return { status: 'none' };
    if (!(await vault.isUnlocked())) return { status: 'locked' };
    const net = await networkCheck();
    if (!net.ok) return networkRefusal(net);
    const settings = await vault.getSettings();
    const { code, step } = await codeNow(account, settings);
    await vault.touch();
    return { status: 'fill', code, name: displayName(account), autoSubmit: !!settings.autoSubmit, account, host, step };
  }

  // A manual fill counts too: it blocks the next automatic fill on this site for 10 minutes.
  async function recordManual(result) {
    if (result?.status !== 'fill' || !result.host || !result.account) return;
    try {
      await attempts.record(result.account.id, fillSite(result.account, result.host), { auto: false, step: result.step });
    } catch {
      // Storage unavailable: the fill already happened; nothing more to do.
    }
  }

  // The card's Fill is recorded only once the page says it filled (otp:card-filled), so a
  // click that found no code box doesn't block the next code. One per tab and frame.
  const pendingCards = new Map();
  const cardKey = (sender) => `${sender.tab.id}|${sender.frameId ?? 0}`;
  function rememberCard(sender, result) {
    const t = now();
    for (const [k, p] of pendingCards) if (t - p.at > CARD_CONFIRM_MS) pendingCards.delete(k);
    pendingCards.set(cardKey(sender), { result, at: t });
  }
  function takeCard(sender, host) {
    const key = cardKey(sender);
    const pending = pendingCards.get(key);
    pendingCards.delete(key);
    if (!pending || now() - pending.at > CARD_CONFIRM_MS) return null;
    // The frame must still be on the host the code was resolved for, and say so.
    const want = pending.result.host;
    return typeof host === 'string' && host === want && hostOf(sender.url) === want ? pending.result : null;
  }

  // Messages from content scripts. Returns a promise of the reply, or null when the message
  // isn't one this handles (or isn't from our own content script).
  function onContentMessage(msg, sender) {
    if (!sender || sender.id !== runtimeId || !sender.tab) return null;
    const tabId = sender.tab.id;

    if (msg?.type === 'otp:found') {
      // Any `force` or other option in the message is ignored.
      return resolveForUrl(sender.url, { tabId, hints: cleanHints(msg.hints), auto: true }).then(
        (r) => (badge(tabId, r.status), pageReply(r)),
        () => ({ status: 'error' })
      );
    }
    if (msg?.type === 'otp:fill-suggested') {
      return resolveForUrl(sender.url, { tabId, hints: cleanHints(msg.hints), auto: false }).then(
        (r) => {
          if (r.status !== 'fill') {
            badge(tabId, r.status);
            return pageReply(r);
          }
          // The '!' badge stays, and nothing is recorded, until the page confirms the fill.
          rememberCard(sender, r);
          return { status: 'fill', code: r.code, name: r.name };
        },
        () => ({ status: 'error' })
      );
    }
    if (msg?.type === 'otp:card-filled') {
      const result = takeCard(sender, msg.host);
      if (!result) return Promise.resolve(null);
      badge(tabId, 'fill');
      return recordManual(result).then(() => null);
    }
    if (msg?.type === 'otp:card-closed') {
      badge(tabId, 'card-closed');
      return Promise.resolve(null);
    }
    return null;
  }

  return { resolveForUrl, resolveAccount, recordManual, onContentMessage };
}
