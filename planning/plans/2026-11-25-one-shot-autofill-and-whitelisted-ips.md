# One-shot auto-fill and Whitelisted IPs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-fill tries a code once per account+site and then only suggests it; codes are available only on whitelisted networks.

**Architecture:** Two new pure modules (`lib/attempts.js`, `lib/networks.js`) plus a chrome-facing checker (`lib/netcheck.js`) hold all decisions and are unit-tested with Node's test runner. The background worker is the single gate for every automatic and right-click/shortcut fill; popup and options consult the same modules. The whitelist lives inside the vault's encrypted password-check record so it can't be edited without the key.

**Tech Stack:** Chrome MV3, plain ES modules, no build step, no dependencies. Tests: `node --test` (Node 24, ESM auto-detected).

**Spec:** `docs/superpowers/specs/2026-11-25-one-shot-autofill-and-whitelisted-ips-design.md`

## Global Constraints

- No new dependencies, no build step, no new permissions in `manifest.json`. Version → `1.2.0`.
- Auto-fill window: **10 minutes** per account+site. Circuit breaker: **3** automatic fills per site per 10 minutes.
- Network result cache: **30 s**, in `chrome.storage.session` only. Lookup timeout **4 s**; internal URL timeout **1.5 s**.
- IP lookup endpoints: `https://www.cloudflare.com/cdn-cgi/trace`, `https://1.1.1.1/cdn-cgi/trace`. No other third party.
- Network check **fails closed**: any error → codes unavailable.
- Private/reserved IPs (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `100.64/10`, `::1`, `fc00::/7`, `fe80::/10`) are refused as entries. Internal networks only as `https://` URLs.
- Every whitelist change needs the AuthPeek password.
- UI name: "Whitelisted IPs". Copy style matches the existing app: plain, second person, no jargon.
- The suggestion card reacts only to `event.isTrusted` clicks; its Fill never presses Verify.
- Codes are never written to storage (attempt records hold the TOTP step number, not the code).

## Review Focus

- IPv6 written in any valid form (`::`-compressed, uppercase, `::ffff:1.2.3.4`) must match the same range → tests in Task 1.
- Trace response without `ip=` (HTML error page, captive portal) must count as a failed check, not "allowed" → test in Task 3.
- Page reloads inside the same 30 s code window → the card must say a new code comes in N s instead of offering the rejected code as new → test in Task 4.
- Two frames reporting a code field at the same moment → exactly one automatic fill → test in Task 4 (`serialize`).
- A 1.1.2 vault (check is a plain string) must still unlock, and turning the whitelist off must write the plain-string check back so older AuthPeek copies can unlock again → tests in Task 2.

---

### Task 1: Test harness and `lib/networks.js`

**Files:**
- Create: `lib/networks.js`, `tests/networks.test.mjs`

**Interfaces:**
- Produces:
  - `parseIp(text: string) -> { family: 4|6, bytes: Uint8Array } | null`
  - `parseEntry(text: string) -> { kind: 'range', family, bytes, prefix, text } | { kind: 'url', url: string, text }` — throws `Error` with user-facing message for private IP, `http://`, bad prefix, garbage.
  - `isPrivate(ip: {family, bytes}) -> boolean`
  - `inRange(ip, range) -> boolean`
  - `ipFromTrace(text: string) -> string | null` (reads the `ip=` line)
  - `isAllowed({ entries: Entry[], publicIps: string[], internalOk: boolean }) -> boolean` (empty entries → `true`)

- [ ] **Step 1: Write failing tests** — `parseEntry('203.0.113.0/24')` matches `203.0.113.200` and not `203.0.114.1`; `parseEntry('2001:DB8::/48')` matches `2001:db8:0:ffff::1`; `::ffff:203.0.113.5` matches `203.0.113.0/24`; single IP = /32 or /128; `parseEntry('192.168.1.1')` throws /internal/; `parseEntry('http://x')` throws /https/; `parseEntry('https://intranet.example.com')` → `kind:'url'`; `/33` on IPv4 throws; `ipFromTrace('fl=1\nip=198.51.100.7\nts=1')==='198.51.100.7'`; `ipFromTrace('<html>')===null`; `isAllowed({entries:[], publicIps:[], internalOk:false})===true`; `isAllowed` true when any public IP in any range, true when internalOk and a url entry exists, false otherwise.
- [ ] **Step 2: Run** `node --test tests/` → FAIL (module missing).
- [ ] **Step 3: Implement `lib/networks.js`.** IPv6 parser handles one `::`, embedded dotted IPv4 tail; normalize `::ffff:a.b.c.d` to IPv4 before matching.
- [ ] **Step 4: Run** `node --test tests/` → PASS.

### Task 2: Whitelist inside the vault check record

**Files:**
- Modify: `lib/crypto.js` (`createVaultMeta`, `unlockVaultMeta`), `lib/vault.js`
- Create: `tests/vault-policy.test.mjs` (in-memory fake of `chrome.storage` areas: `get/set/remove`, `iterations: 1000`)

**Interfaces:**
- Produces (on the vault object): `getPolicy() -> Promise<{ entries: {value, note}[] }>` (requires unlocked; legacy → `{entries: []}`); `setPolicy(password: string, policy) -> Promise<void>` (verifies password, re-encrypts `meta.check` with the same salt/key).
- Check record format: legacy string `'otp-autofill-vault'`, or object `{ v: 'otp-autofill-vault', policy }` when entries exist. Empty entries → write the plain string back.

- [ ] **Step 1: Write failing tests** — fresh vault `getPolicy()` → `{entries:[]}`; `setPolicy(pw, {entries:[{value:'203.0.113.0/24', note:'Office'}]})` then `lock()` + `unlock(pw)` + `getPolicy()` returns it; `setPolicy('wrong', …)` rejects /wrong password/; after `changePassword` the policy survives; setting empty entries makes `meta.check` decrypt to the plain string; tampering `meta.check.ct` (flip a char) makes `unlock` reject.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `unlockVaultMeta` accepts string or `{v}`; `changePassword` reads policy with the old key and writes it under the new one.
- [ ] **Step 4: Run** → PASS.

### Task 3: `lib/netcheck.js` (live check, cache, fail closed)

**Files:**
- Create: `lib/netcheck.js`, `tests/netcheck.test.mjs`

**Interfaces:**
- Consumes: Task 1 `parseEntry`, `ipFromTrace`, `isAllowed`.
- Produces: `createNetCheck({ fetch, storage, now }) -> { check({ entries, force? }) -> Promise<{ allowed: boolean, ips: string[], reason: 'off'|'ok'|'not-listed'|'error', checkedAt }>, forget() }` and `netCheck` default instance bound to `globalThis.fetch` / `chrome.storage.session`. Cache key `netcheck`, keyed also by a hash of the entry list so edits invalidate it.

- [ ] **Step 1: Write failing tests** with a fake fetch — no entries → `{allowed:true, reason:'off'}` and no fetch call; matching IP → `ok`; non-matching → `not-listed` with `ips`; both endpoints throw → `error`, `allowed:false`; HTML body with no `ip=` → `error`; url entry answering (any status) → `ok` even if IP doesn't match; second call within 30 s uses cache (fetch count unchanged); `force:true` bypasses cache; changed entries bypass cache.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Fetch options `{ cache:'no-store', credentials:'omit', signal }`; both trace endpoints and URL entries in parallel with `Promise.allSettled`.
- [ ] **Step 4: Run** → PASS.

### Task 4: `lib/attempts.js` (the loop guard) and `linkedSiteFor`

**Files:**
- Create: `lib/attempts.js`, `tests/attempts.test.mjs`
- Modify: `lib/sites.js` — add `linkedSiteFor(account, host) -> string | null` (the account's linked site that matches `host`).

**Interfaces:**
- Produces: `createAttempts({ storage, now }) -> { canAutoFill(accountId, site) -> Promise<{ ok: true } | { ok: false, at: number, step: number }>, record(accountId, site, { auto: boolean, step: number }) -> Promise<void> }`; `serialize(key: string, fn: () => Promise<T>) -> Promise<T>` (per-key promise chain); `WINDOW_MS = 600000`, `MAX_AUTO_PER_SITE = 3`. Storage keys: `fill:<accountId>|<site>` → `{at, step}`; `autofills:<site>` → `number[]`.

- [ ] **Step 1: Write failing tests (this is the loop reproduction)** — simulate a site that rejects and reloads 20 times: loop calling `canAutoFill` → `record(auto)` only when ok → exactly **1** fill; after 10 min + 1 ms `canAutoFill` ok again; a manual `record(auto:false)` also blocks auto; breaker: 3 different accounts on one site auto-fill, 4th is refused; `serialize` with two concurrent decide-and-record calls → one ok; `linkedSiteFor({sites:['github.com']}, 'gist.github.com')==='github.com'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.

### Task 5: Background gate

**Files:**
- Modify: `background.js`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces messages: `otp:found` → `{status:'fill'|'suggest'|'network'|'locked'|'choose'|'off'|'none', code?, name?, autoSubmit?, nextIn?}`; new `otp:fill-suggested` (from the card) → `{status:'fill', code, name}` or `{status:'network'}`. `nextIn` = seconds until a new code when the current step equals the recorded step.

- [ ] **Step 1:** `resolveForUrl` gets `{ auto }` instead of `force`; drop `msg.force`. Order: set up → (auto && !autoFill → off) → locked → network check (`getPolicy` + `netCheck.check`) → account pick → if auto: `serialize('site:'+site, canAutoFill→record)` → `fill` or `suggest`. Manual paths (`FILL_SITE`, account menu items, shortcut, `otp:fill-suggested`) record with `auto:false` after a successful fill and never get `suggest`.
- [ ] **Step 2:** Badges: `suggest` → `'!'` amber, `network` → `'IP'` grey (`#6B7280`).
- [ ] **Step 3: Verify** `node --test tests/` still PASS and `node --check background.js` (ESM syntax) passes.

### Task 6: Content script — suggestion card and safe submit

**Files:**
- Modify: `content.js`, `otp-detect.js` (`submitTarget` unchanged; add `filledWith(target, code) -> boolean`)

- [ ] **Step 1:** On `suggest`: card (closed shadow root, `role="dialog"`, stays until ×) with copy from the spec; button "Fill 123 456" sends `otp:fill-suggested`, fills reply code with no submit, then closes. Handlers ignore events where `!e.isTrusted`. If `nextIn` is set, line: "That's the code that was just used. A new one comes in N s." and the button refreshes when it changes.
- [ ] **Step 2:** On `network`: toast "AuthPeek codes are off on this network. It isn't in your whitelisted IPs." (once per page).
- [ ] **Step 3:** `fill()` auto-submit: after 300 ms press Verify only if `filledWith(target, code)`.
- [ ] **Step 4: Verify** `node --check content.js otp-detect.js`.

### Task 7: Popup

**Files:**
- Modify: `popup.js`, `popup.html`, `popup.css`

- [ ] **Step 1:** In `showList`, before computing codes: `getPolicy` + `netCheck.check`. If not allowed: render a notice ("Codes are hidden. This network isn't in your whitelisted IPs." + current IPs, or "Couldn't check your network." on `error`) with "Check again" (`force:true`) and "Settings"; skip `refreshCodes`, Fill buttons and copy.
- [ ] **Step 2:** `fillOnPage` records `attempts.record(account.id, site, {auto:false, step})` after a fill; `afterUnlock` auto-fill only if `canAutoFill` ok; page box shows the warning line when it isn't.

### Task 8: Settings, privacy, version

**Files:**
- Modify: `options.html`, `options.js`, `options.css`, `privacy.html`, `manifest.json`

- [ ] **Step 1:** New section `#whitelist` "Whitelisted IPs" between Auto-fill and Security (nav link too): status line (current IPs + allowed/not), list of entries with note and remove ×, add field (IP, range or `https://` address) + note + "Add my current IP"; every change goes through `askPassword` then `vault.setPolicy`. Parse errors from `parseEntry` shown inline. Warning when the list becomes non-empty: "Update AuthPeek on your other computers to 1.2 first. Older versions can't unlock while whitelisted IPs are on."
- [ ] **Step 2:** `onDownload`, `onEmail`, `onCopy`, `onExportLinks` refuse with a toast when the network check isn't allowed.
- [ ] **Step 3:** privacy.html: version 1.2, new paragraph under "The one request it makes" (rename "The requests it makes"): when whitelisted IPs are set, AuthPeek asks Cloudflare for this computer's public IP when showing or filling codes (at most every 30 s), compares it on the computer, keeps it only in memory; internal addresses are contacted directly. manifest `1.2.0`.

### Task 9: Verification

**Files:**
- Create: `tests/qa/serve.mjs` (local server on `http://localhost:8765`: `/loop` = OTP form that always rejects and re-renders by full reload; `/spa` = same with JS re-render; `/digits` = 6 boxes that auto-submit on the 6th digit).

- [ ] **Step 1:** `node --test tests/` → all PASS.
- [ ] **Step 2:** User loads the unpacked folder in Chrome (branded Chrome ignores `--load-extension`), links a test account to `localhost`, turns on "Press Verify". Expected on each page: one fill, then the card; server log shows exactly 1 POST.
- [ ] **Step 3:** Whitelist: add current IP → codes show; replace with `198.51.100.0/24` → popup hides codes, auto-fill toasts, export refused; offline → "Couldn't check your network".
- [ ] **Step 4:** Fresh reviewer pass over all changed files (security-reviewer role).

Note: the folder isn't a git repository, so there are no commit steps.
