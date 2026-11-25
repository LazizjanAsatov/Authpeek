# AuthPeek 1.3.0 release

Status (25 November 2026): **merged onto 1.2.0, built and tested locally. Not committed, not submitted to the Chrome Web Store.** AuthPeek is Chrome-only: the Firefox build from 1.2.0 was removed.

1.3.0 = GitHub main 1.2.0 (redesign, share links, welcome page, theme, bundled logos and Inter, Chrome 127) + the one-shot auto-fill and Whitelisted IPs work (design: `planning/specs/2026-11-25-one-shot-autofill-and-whitelisted-ips-design.md`, written when it was planned as 1.2.0 on top of 1.1.2).

## Build

```
npm test                 # 296 unit tests
npm run e2e              # 116 checks in real Chrome (puppeteer-core, throwaway profile)
npm run package          # dist/authpeek.zip
```

- Manifest: MV3, version 1.3.0, minimum Chrome 127. Permissions unchanged from 1.2.0: `storage`, `activeTab`, `contextMenus`, host access `http://*/*`, `https://*/*`.

## Checks run

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 296/296 pass |
| End-to-end (`npm run e2e`, Chrome 158) | 116/116 pass, including: a second automatic request on the same site within 10 minutes only shows the suggestion card; the card's Fill fills once and doesn't press Verify; a fill with no host or another site's host is refused by the page; off the whitelisted networks the popup hides codes, copy and share, a linked site gets nothing (badge `IP`), the edit view has no Share, and Create link and the setup QR code are refused; a share link made on a whitelisted network leaves the screen once the 30-second re-check says no, and Copy link / Show QR then do nothing; with "Fill codes automatically" off, unlocking in the popup fills nothing by itself |
| Package (`npm run package`) | `dist/authpeek.zip`, 53 files |
| Earlier, on the 1.1.2-based build (same feature code) | Full browser QA with the local QA server: reload page, redraw page, auto-submit page: 1 attempt each, then the card. Card: disabled during the used code, then fills the new code without submitting. Cross-site iframe: no fill, no badge. Off-network: nothing filled, codes hidden, all four exports refused. 1.1.2 on the same page: 29 attempts in 10 s |
| Not tested | A real intranet `https://` address (Chrome's Local Network Access rules may block it; codes would stay hidden, not leak). Press Verify on a slow self-submitting site. |

## Before submitting

- [ ] Commit the merge, push, and let GitHub Pages publish `docs/privacy.html` and `docs/terms.html`.
- [ ] Take real screenshots (1280×800) if the store should show the suggestion card or Settings → Whitelisted IPs (`npm run store-assets` makes the existing five).
- [ ] Paste "What's new in 1.3" from `docs/store-listing.md` and update the data-use form and permission justifications from it.
- [ ] Tell people who use AuthPeek on several computers to update them all to 1.3 before turning on Whitelisted IPs (1.2 and older can't unlock once it has been used).

## What's new in 1.3

- Auto-fill never loops anymore: if a site rejects a code, AuthPeek won't keep filling it and lock your account. It fills once per account and site in 10 minutes (at most 3 times per site), then shows the code as a suggestion you can fill with one click.
- Whitelisted IPs: show, fill, copy, share and export codes only on networks you list: your office, your VPN, or an internal address. Every change needs your password; if the check can't run, codes stay hidden.
- Auto-fill, the popup, the right-click menu and the keyboard shortcut only fill the site the code was picked for, never an embedded frame from another site.
- Share links count as an export: with Whitelisted IPs on, they (and the setup QR code) are only made on a whitelisted network.
- Rewritten privacy policy and new terms of use.

## Permission justifications (dashboard)

- **Host access (all http/https sites):** AuthPeek has to notice a verification-code box on whichever sign-in pages the user links to an account, and fill the code there. The set of sites is chosen by the user and can't be known in advance. It also fetches Cloudflare's public trace endpoint for the clock check and the optional Whitelisted IPs check.
- **storage:** encrypted accounts, encrypted whitelist and settings (sync); short-lived in-memory state (session); clock offset, whitelist revision and a few flags (local).
- **contextMenus:** "AuthPeek ▸ Fill code" in the right-click menu of text boxes.
- **activeTab:** "Scan this page" captures the visible tab to read a QR code, only when the user clicks it.
- **Remote code:** none. All code is in the package.

## Data-use declarations (dashboard)

- Collected: authentication information (TOTP secret keys and account names the user adds), stored encrypted with the user's password in the browser's sync storage. Website content: form fields and email addresses on pages with a code box, used on the spot to pick the account; not stored or sent.
- Share links: the codes for the chosen minutes and the account name, encrypted with a random key; both travel in the URL fragment, which browsers never send to a server.
- Not sold, not transferred to third parties, not used for unrelated purposes, not used for creditworthiness or lending.
- No server of the developer receives any data. Requests to Cloudflare carry no user data beyond what any web request does (IP address).

## Reviewer instructions

1. Install, open the popup, create a password.
2. Add an account: + → Enter key → Service "Test", secret `JBSWY3DPEHPK3PXP`.
3. Open any page with a one-time-code field, open the popup and press Fill; or link the site (⋮ → Auto-fill on this site → Save changes) and reload to see automatic fill. Reload again within 10 minutes to see the suggestion card instead of a second fill.
4. Whitelisted IPs is optional (Settings → Whitelisted IPs); with an empty list codes work everywhere.

## Rollback

Store updates go through review, so a rollback is a new reviewed version. Vaults that used Whitelisted IPs need 1.3 or later; vaults that never used it stay readable by 1.2 and 1.1.x.
