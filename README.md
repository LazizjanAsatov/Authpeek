# AuthPeek

A Chrome extension that works like Google Authenticator inside your browser, and fills
verification codes into login pages for you.

- **Add accounts** by scanning a QR code or setup link on the page, uploading or pasting a
  screenshot, pasting `otpauth://` links (one or many, anywhere in the popup), or typing the
  secret key. Moving from Google Authenticator: in the app choose
  *Transfer accounts → Export*, then scan each QR code it shows.
- **Auto-fill** on sites you've linked to an account, including pages that split the code
  into separate boxes. Filling an account by hand on a site links it for next time.
  Scanning a site's own setup QR code links that site automatically.
- **Several accounts on one site**: AuthPeek picks the account matching the username you
  typed on the sign-in step (remembered per tab, in memory, for 15 minutes) or one shown on
  the code page. If it can't tell, it asks instead of guessing, and remembers your choice
  for that username.
- **Safe sync**: accounts are encrypted with your password (PBKDF2 + AES-256-GCM) and then
  saved to Chrome sync, so they follow your Google account to other computers.
- **Backups**: download, email to yourself, or copy an encrypted backup from Settings.
- **Scan this page** looks for a QR code, then an `otpauth://` link, then a key printed for
  manual entry (filled into the form for you to check).
- **Right-click any text box → AuthPeek** to fill the code for this site or any account.
  A hand pick links the site and remembers the username, like the popup.
- **Search** by typing anywhere in the popup: service, account, linked sites, usernames, or
  initials ("aws"). Enter copies (or fills) the top match; Esc clears.
- Shortcut **Alt+Shift+O** fills the code on the current page.

## Install for development

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder.
3. Pin AuthPeek from the puzzle-piece menu and click it to create your password.

## Before publishing

- Put your Buy Me a Coffee username in [extension/lib/config.js](extension/lib/config.js).
- Build the upload zip: `npm run package` creates `dist/authpeek.zip`.
- Store listing text and the permission justifications are in [docs/store-listing.md](docs/store-listing.md).
  The privacy policy is [extension/privacy.html](extension/privacy.html); host a copy
  somewhere public (e.g. GitHub Pages) for the store's privacy-policy URL.

## Tests

```bash
npm test
```

Covers TOTP against the RFC 6238 vectors, base32, `otpauth://` and Google Authenticator
export parsing, encryption, the sync vault (locking, password change across browsers),
site matching, and code-field detection and filling on sample pages.

## How it fits together

| File | Job |
| --- | --- |
| `extension/lib/totp.js`, `base32.js` | Code generation |
| `extension/lib/otpauth.js` | Reads QR contents, including Google Authenticator exports |
| `extension/lib/crypto.js` | Password-based encryption for the vault and backups |
| `extension/lib/vault.js` | Encrypted accounts in `chrome.storage.sync`; unlock key in `chrome.storage.session` |
| `extension/lib/sites.js` | Which account belongs to which site |
| `extension/lib/identity.js` | Which of a site's accounts is signing in, by username |
| `extension/lib/search.js` | Popup search |
| `extension/lib/menus.js` | Right-click menu items |
| `extension/otp-detect.js` | Finds and fills code fields (content script, no Chrome APIs) |
| `extension/content.js` | Watches pages and asks the background for a code |
| `extension/background.js` | Hands codes only to frames whose site is linked; shortcut |
| `extension/popup.*` | Codes list, add/scan, edit |
| `extension/options.*` | Settings, backup, restore, password |

Auto-fill never uses a guess: a code is only given to a page whose address matches a site
you linked (exact host or its subdomains), which protects against look-alike phishing pages.
