# One-shot auto-fill and whitelisted IPs — design

Date: 2026-11-25 · planned as AuthPeek 1.1.2 → 1.2.0; shipped in 1.3.0, merged onto GitHub main 1.2.0 (see planning/release-1.3-notes.md). "Before 1.2" below means "before 1.3" in the shipped version.

## Intent

1. **Stop the lockout loop.** Today a rejected code makes AuthPeek fill (and, with "Press Verify", submit) the same code over and over until the site locks the account. Auto-fill must try once; after that it only *suggests* the code.
2. **Whitelisted IPs.** Codes should only be available when the computer is on a trusted network (office / VPN). Used by the owner and a trusted team who all know the vault password, so this is a guardrail against using codes from the wrong network, not protection against someone determined who knows the password (decided: option A, enforcement inside the extension; no server).

## Root cause of the loop

`content.js` remembers "already asked" in a `WeakSet` of input elements (`asked`). That memory is per element and per page load. When a site rejects a code it either reloads the page (new content script, empty memory) or re-renders the input (new element). Either way `scan()` treats it as a new field, the background answers `fill` again (it keeps no history), and the code is filled again. With "Press Verify" on it is submitted again; many sites also submit by themselves when the last digit is typed, so even with "Press Verify" off every refill is another failed attempt.

So the limit must apply to the **fill**, and live somewhere a reload or re-render can't reset: the background, backed by `chrome.storage.session`.

## Goals / non-goals / anti-goals

- Goal: at most one automatic fill per account per site per 10 minutes, across reloads, re-renders, frames and tabs.
- Goal: after that, a clear in-page suggestion the user can act on with one click.
- Goal: with whitelisted IPs set, no code is shown, copied, filled or exported off those networks.
- Non-goal: stopping someone who knows the vault password and is determined (they can export keys from an allowed network, or edit the extension).
- Anti-goal: any automatic path that can submit codes repeatedly. Anti-goal: the IP check failing *open* (showing codes when the check can't run).

## Approaches considered

Loop fix:
- (chosen) Attempt record in the background, keyed by account + site, in `chrome.storage.session`; decisions serialized so two frames can't both fill.
- Only gate the Verify press — rejected: sites that submit on the last digit still loop.
- Per-tab record — rejected: loops that open a fresh tab/popup window escape it; account+site is stricter and simpler.

Whitelisted IPs:
- (chosen) **A.** Check inside the extension, using the public IP from Cloudflare's trace endpoint (already used for the clock check).
- B. Code server that holds the keys and checks the caller's IP — real enforcement, rejected for now: only the owner and trusted people use it.

## Design — one-shot auto-fill

- New `lib/attempts.js` (pure, injectable storage/clock, unit-tested), window 10 minutes:
  - `createAttempts({storage, now})` → `canAutoFill(accountId, site)` (`{ok: true}`, or a refusal `{ok: false, at, step, why}`: no `why` = this account was filled here at `at`; `why: 'site-limit'` = the circuit breaker; `why: 'unknown'` = an unreadable record, `at: null`) and `record(accountId, site, {auto, step})` (only the TOTP step is stored, never a code).
  - `decideAutoFill(attempts, accountId, site, step)`: check and record one automatic fill as a single step.
  - `fillSite(account, host)` / `totpStep(ms, period)`: the site and step a fill is recorded under.
- **Every** fill is recorded: automatic, popup, right-click, Alt+Shift+O.
- Background `otp:found` (automatic path): if the chosen account was filled on this site in the last 10 minutes, answer `suggest` (with code and name) instead of `fill`. The decision and the record are one step (`decideAutoFill`), serialized **per site** (not per tab): an in-memory chain plus a Web Lock (`navigator.locks`) that every extension page shares, so two frames, two quick scans, or the popup and the background can't both fill.
- If the page re-renders the code field while the answer is on its way, the content script fills the newly detected code field (never just the focused box) instead of dropping a fill that was already counted.
- Content script on `suggest`: a card in the corner (same closed-shadow style as the toast, stays until closed):
  *"AuthPeek filled a code for GitHub (alice) 40 s ago and won't fill again automatically, so the site doesn't lock your account. If the code was rejected, the saved key may be out of date."* — buttons **Fill 123 456** and **×**. The card's Fill never presses Verify. If the code is the same one already tried, the Fill button is disabled with a countdown ("A new one comes in N s") and then reads **Fill the new code**.
  - When the circuit breaker refused (any account on the site), the card names no account and no time: *"AuthPeek already filled 3 codes on this site in the last 10 minutes and won't fill again automatically, so the site doesn't lock your account."* An unreadable record gets neutral words without a time.
- The card's Fill is recorded only after the page confirms it filled (`otp:card-filled`, carrying the frame's host; the background checks it against the pending fill for that tab and frame). A click that finds no code box records nothing.
- Badge `!` (amber) while a suggestion is showing; it clears when the card's fill is confirmed or the card is closed.
- Manual fills (popup, menu, shortcut) always work — one click is one attempt.
- Popup: the automatic fill after unlocking counts as automatic: it goes through the same `decideAutoFill` (popup and background share `chrome.storage.session` and the Web Lock), so it respects the record and counts toward the circuit breaker. When the record blocks it, the "This page is asking for a code" box shows its own line: *"AuthPeek already filled a code here in the last 10 minutes, so it won't fill again by itself. If the site rejected it, the saved key may be out of date."* (or the site-limit version).
- "Press Verify" only presses if, 300 ms later, the field still holds AuthPeek's code **and** since the fill the page fired no `beforeunload`/`pagehide` and no `submit` on the field's form (capture-phase listeners, only for those 300 ms). This avoids a double submit when the site already submitted by itself, including a full-page `form.submit()` that keeps the field's value until unload.
- The popup and the background ask only frames on the page's host about a code field (`otp:status` carries the host, the same rule as `otp:fill`), so a third-party iframe can't make the popup offer a Fill that would be refused.

## Design — whitelisted IPs

- Settings → new section **Whitelisted IPs**. Empty list = feature off (today's behaviour).
- Entries: public IPv4 / IPv6 addresses and ranges (`203.0.113.7`, `203.0.113.0/24`, `2001:db8::/48`), each with an optional note ("Office", "VPN"); at most 50 entries of up to 200 characters (defined once, in `lib/crypto.js`). **Refused** with an explanation (see next point): private and reserved addresses `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `::`, `::1`, `fc00::/7`, `fe80::/10`; and ranges broader than /8 (IPv4) or /16 (IPv6), which would allow almost any network.
- **Internal network check (secure form only):** the extension can't read the computer's own LAN IP, and "does 10.0.0.1 answer?" is worthless as security — every home router answers on 10.0.0.1 / 192.168.1.1. So internal networks are proven with an **HTTPS address on your own domain with a valid certificate that only resolves inside the network** (e.g. `https://intranet.company.com`). TLS proves it's really your server. `http://`, `localhost`, and **any IP address as the host** (public or private, however it is spelled) are refused: only a name on your own domain lets the certificate prove the server's identity. Adding an https:// address shows a warning before the password step, also in the section's explainer: *"Only add an address that does NOT open from outside your network (from home, or on mobile data). If it opens anywhere, codes will show anywhere."*
- Public IP check: `https://www.cloudflare.com/cdn-cgi/trace` (IPv6 or IPv4, whichever the browser uses) and `https://1.1.1.1/cdn-cgi/trace` (IPv4), both HTTPS. On the network if **any** current public IP matches, or the internal HTTPS address answers. Any answer counts, a redirect too (an intranet root that sends you to /login or SSO): the internal probe uses `redirect: 'manual'`, so the redirect comes back opaque from the TLS-verified host and is never followed. The trace URLs use `redirect: 'error'`.
- Result cached 30 s in `chrome.storage.session` (memory only); every fill re-checks if older. The popup re-checks on open and has "Check again". When off-network the popup doesn't even compute codes.
- **Fails closed:** if the check can't run (offline, blocked, bad certificate), codes stay hidden with "Couldn't check your network". The page's toast is picked by the reason: not listed → *"AuthPeek codes are off on this network. It isn't in your whitelisted IPs."*; check failed → *"AuthPeek couldn't check this network, so codes are off for now."*; rolled back → *"AuthPeek's whitelist needs attention. Open AuthPeek settings."*
- A locked vault is reported as locked (`reason: 'locked'`), not as a network problem: the popup goes to the password screen (on Fill, Check again and its periodic re-check), and settings shows the list as locked.
- Enforced in: popup list (codes replaced by a notice showing the current IP), copy, popup fill, auto-fill, right-click fill, shortcut, Export as links, all backups. Restore stays allowed (it only adds accounts).
- **Tamper-resistant storage:** the list is stored inside the vault's encrypted, authenticated password-check record (`meta.check`), not in plain settings. Editing or deleting it without the vault key breaks unlocking instead of silently turning the whitelist off. It syncs with the vault, so every computer gets the same list. A password change carries it over. Backups don't include it (a backup holds the accounts only): restoring onto a fresh install starts with no whitelist, and restoring into an existing vault keeps that vault's list. Each computer remembers the highest list revision it has seen (local `policyRev`) to notice an older meta being put back; setting up a new vault clears that mark.
- Once the list has been used, the vault's check stays in the form AuthPeek before 1.2 can't read, even after the list is turned off. Settings keeps the "older versions can't unlock" note while the revision is above 0, and the turn-off dialogs say older versions still can't unlock.
- **Any change to the list needs the AuthPeek password** (add, remove, turn off), like Export already does. "Add my current IP" fills in the detected IP: while the list is empty the check makes no request, so Settings does a one-off lookup (the same trace URLs, nothing stored; the open Settings page reuses it for 30 s; `[]` on failure) when the section shows an empty list and on "Check again"; the warning that a new entry would hide codes on this computer then works for the first entry too. Turning it off needs the password too. When the list was rolled back, "Turn off…" is shown as well, so one password prompt saves a fresh, empty list.
- Lock-out recovery: settings always open; with the password you can add the new IP.
- Privacy policy: new paragraph — the IP request, when it happens (including the one-off lookup in Settings while the list is empty), that the IP is compared on the computer and only cached in memory.

## Security hardening found while reviewing (goal: a secure extension)

Fixed with this work:
- The suggestion card's buttons only react to real user clicks (`event.isTrusted`), so the page can't press "Fill" by script.
- The background ignores `force` coming from content scripts (today a content-script message can bypass "Fill codes automatically" being off).
- A global circuit breaker on top of the per-account record: at most 3 automatic fills per site per 10 minutes across everything, whatever happens.

Status: user approved IP methods 1 (public IP via Cloudflare) and 2 (internal HTTPS address). The three items below were not answered, so they are **out of scope** for this build and offered as a follow-up.

Proposed, needs your yes (each changes current behaviour):
1. **No automatic fill on `http://` pages** (codes would travel unencrypted); manual fill still possible. Localhost exempt.
2. **Filling by hand no longer links the site silently.** Today one manual fill on a look-alike phishing page links it, and from then on AuthPeek auto-fills there. Instead: "Fill" fills once; linking is a separate explicit "Always fill on site.com" choice.
3. **Exact-host linking for shared-content domains** (e.g. `sites.google.com`, `*.blogspot.com` user pages under a linked parent domain) — linked site matches subdomains only when the user linked the parent on purpose.

## Testing

- `node --test` unit tests (no new dependencies): `lib/attempts.js` (reproduces the loop: second automatic request within 10 min → `suggest`; concurrent requests → one fill), `lib/networks.js` (parsing, CIDR v4/v6, private-range detection, trace parsing, fail-closed decision).
- Manual QA in Chrome with a local test page that rejects every code and re-renders / reloads (branded Chrome no longer loads unpacked extensions from the command line, so loading the unpacked folder is a manual step).

## Calls made by the builder (check these)

- 10-minute window; keyed by account + site, not per tab.
- The suggestion card's Fill never auto-presses Verify.
- Whitelist changes need the password; list syncs across computers.
- Fail closed when the IP can't be checked.
- Internal addresses are reachability checks, not the machine's own IP.
- Name in the UI: "Whitelisted IPs". Version bump to 1.2.0.
