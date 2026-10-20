# Chrome Web Store listing

## Name
AuthPeek – Authenticator & Code Autofill

## Summary (132 characters max)
Your 2-step verification codes in Chrome. Scan QR codes, auto-fill codes on login pages, and sync them encrypted.

## Description
AuthPeek is an authenticator that lives in your browser. It makes the same 6-digit codes as Google Authenticator, and fills them into login pages for you.

Add accounts
• Scan the QR code on a site's 2-step verification setup page
• Upload or paste a screenshot of a QR code
• Type in the secret key, paste otpauth:// links, or let it find the key printed on a setup page
• Move everything over from Google Authenticator with its Transfer accounts QR codes

Auto-fill
• On sites you've linked, the code is filled the moment the page asks for it
• Works with single code boxes and with codes split into separate boxes
• Optional: press Verify for you
• Shortcut: Alt+Shift+O, or right-click any box and choose AuthPeek
• Type to search: by service, account, site or initials ("aws")
• Pin the accounts you use most
• Steam Guard codes too

Safe by design
• Your accounts are encrypted with your password (AES-256) before they're saved
• They sync to your other computers through your Google account, still encrypted
• Codes are only filled on sites you've linked, never on look-alike pages
• You choose when it asks for your password: after a few minutes, when Chrome starts, or never
• Encrypted backups you can download or email to yourself
• Warns you, and corrects its codes, if your computer's clock is off
• Move to another app any time: export as standard otpauth:// links
• No servers, no tracking, no ads

## Category
Productivity

## Single purpose
Generate time-based one-time passwords (2-step verification codes) and fill them into login forms.

## Permission justifications
- **storage**: Saves the user's encrypted accounts and settings (sync storage) and keeps the unlock key in memory while unlocked (session storage). If the user turns off password prompts, the key is kept in local storage on that computer only.
- **contextMenus**: Adds "AuthPeek" to the right-click menu of editable fields so the user can fill a code into a chosen field.
- **activeTab**: Captures the visible tab only when the user clicks "Scan this page" in the popup, to read a 2FA setup QR code. The capture is decoded locally and discarded.
- **Host permissions (http/https)**: Runs the content script that detects verification-code fields on login pages so the code can be filled automatically, and lets the keyboard shortcut and right-click menu read the current tab's address to pick the account linked to that site. Only form fields are inspected; no page content is collected or transmitted.

## Data usage disclosures
- Collects: authentication information (2FA secret keys) — stored encrypted in the user's own Chrome sync storage only; not transmitted to the developer.
- Not sold, not used for unrelated purposes, not used for creditworthiness.

## Images (ready in docs/store/)
Regenerate with `npm run store-assets` (runs the real extension with demo accounts).
- screenshot-1-codes.png … screenshot-5-safe.png: 1280×800 screenshots, in this order
- promo-small-440x280.png: small promo tile
- promo-marquee-1400x560.png: marquee promo tile (optional; used if the store features AuthPeek)
- Store icon: extension/icons/icon128.png

## Firefox (addons.mozilla.org)
- Upload dist/authpeek-firefox.zip (`npm run package:firefox`); validated with web-ext lint, 0 warnings.
- Add-on ID: authpeek@dns-pay.com. Minimum Firefox 142 (desktop and Android).
- Same description and images as Chrome. Data collection: none.
