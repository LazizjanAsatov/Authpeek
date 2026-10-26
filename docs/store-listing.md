# Chrome Web Store listing (1.2.0)

The name and summary live in `extension/manifest.json` (`name`, `description`), so changing them means
uploading a new version. Copy the two strings below into the manifest verbatim.

## Name (75 characters max)
AuthPeek – 2FA Authenticator & Code Autofill

44 characters.

## Summary (132 characters max)
Authenticator for Chrome: generates 2FA codes and fills them into login pages. Encrypted sync across your browsers, no servers.

127 characters.

## Description
AuthPeek is an open-source authenticator for Chrome. It generates the same 6-digit 2FA codes as Google Authenticator™ and fills them into login pages for you, so you sign in without reaching for your phone. Your accounts are encrypted with your password before they are saved, and AuthPeek has no servers: nothing is sent to the developer.

Add accounts
• Scan the QR on a site's 2-step verification setup page, or upload a screenshot of it
• Paste otpauth:// links or type the secret key
• Import from Google Authenticator™ with its Transfer accounts QR

Auto-fill
• On linked sites the field is filled the moment the page asks, whether it is one box or six
• Two accounts on one site? AuthPeek picks the one matching the username you signed in with, or asks
• Shortcut Alt+Shift+O, or right-click any box and choose AuthPeek
• Type to search by service, account, site or initials ("aws"); pin the ones you use most
• Steam Guard supported

Share and move
• Share a one-time code with someone for a few minutes: an encrypted link, no server, your secret key never included
• Move an account to your phone or another app with a standard otpauth:// QR
• Export everything as otpauth:// links whenever you want to leave

Safe by design
• AES-256 encryption with your password, which is never stored
• Syncs to your other computers through your Google account, still encrypted
• Fills only on the sites you linked, never on look-alike pages
• You choose when it locks: after a few minutes, when Chrome starts, or never
• Encrypted backups you can download or email to yourself
• Checks the clock and corrects for a computer whose time is off
• Light, dark or system theme. No servers, no tracking, no ads

Google Authenticator is a trademark of Google LLC. AuthPeek is not affiliated with Google.

### Keyword count
"code"/"codes" in the description above: 2 (the Spam FAQ says keep a keyword under 5). Name + summary +
description together: 4. Re-count after any edit:

```bash
node -e "const t=require('fs').readFileSync('docs/store-listing.md','utf8');const d=t.split('## Description')[1].split('### Keyword count')[0];console.log((d.match(/\bcodes?\b/gi)||[]).length)"
```

## Category
Privacy & Security. (Productivity, used in 1.0–1.1, was retired as a category in 2023; Authenticator, 2FAS and
Bitwarden all sit in Privacy & Security.)

## Single purpose
Generate time-based one-time passwords (2-step verification codes) and fill them into login forms.

## Permission justifications
- **storage**: Saves the user's encrypted accounts and settings (sync storage) and keeps the unlock key in memory while unlocked (session storage). If the user turns off password prompts, the key is kept in local storage on that computer only.
- **contextMenus**: Adds "AuthPeek" to the right-click menu of editable fields so the user can fill a code into a chosen field.
- **activeTab**: Captures the visible tab only when the user clicks "Scan this page" in the popup, to read a 2FA setup QR code. The capture is decoded locally and discarded.
- **Host permissions (http/https)**: Runs the content script that detects verification-code fields on login pages so the code can be filled automatically, and lets the keyboard shortcut and right-click menu read the current tab's address to pick the account linked to that site. Only form fields are inspected; no page content is collected or transmitted.

## Data usage disclosures
- Collects: authentication information (2FA secret keys) — stored encrypted in the user's own Chrome sync storage only; not transmitted to the developer.
- Share links: the codes for the chosen minutes are encrypted with a random key and both travel in the URL fragment, which browsers never send to the server. Nothing is transmitted to the developer; the viewer page at lazizjanasatov.github.io makes no network request after it loads.
- Not sold, not used for unrelated purposes, not used for creditworthiness.

## Reviews and ratings — what the policy allows
Sources: https://developer.chrome.com/docs/webstore/spam-faq, https://developer.chrome.com/docs/webstore/program-policies/policies,
https://developer.chrome.com/docs/webstore/support-users.

- Rating or reviewing your own extension: **no**. The Spam FAQ answers "Can I review or rate my own extension?" with no.
- Reviews from friends, family, colleagues, other developers you work with: **no**. The same FAQ counts "ratings and
  reviews coming from other developers or users that are affiliated with the publisher" as manipulation, and the
  Program Policies say manipulating reviews or ratings gets the publisher banned. Do not ask anyone you know.
- Incentives (discounts, features, anything in exchange for a review or an install): **no**.
- Testimonials or quoted reviews in the description, or claims like "top rated" / "featured": **no**.
- A plain "Rate AuthPeek" link for genuine users: **yes**. Google's own support page shows the direct link:
  append `/reviews` to the item URL, i.e. `https://chromewebstore.google.com/detail/<item-id>/reviews`. The
  settings page shows this link once `STORE_URL` in `extension/lib/config.js` is set; no reward attached, ever.
- Where reviews live: Developer Dashboard → the item → **Analytics → Ratings** (the Rating tab) for counts and the
  histogram; the public reviews are at the `/reviews` URL above. Turn on **Account settings → Notifications →
  "Item review completed"** to get an email per review. Replies to reviews are allowed (they show a Developer badge);
  reviews can't be deleted by the publisher.
- Why a review may not show: the public reviews page filters to the store UI language. Open the `/reviews` page and set
  **Language → All languages** (the menu has exactly two options), or append `?hl=<locale>`. Reviews can also be held
  for moderation for a few days, and the header rating is recomputed periodically, so it lags.

## Search Console verification (verified publisher URL)
Sources: https://developer.chrome.com/docs/webstore/cws-dashboard-listing, https://support.google.com/webmasters/answer/9008080.

1. In https://search.google.com/search-console add a **URL-prefix** property for
   `https://lazizjanasatov.github.io/Authpeek/` (a Domain property needs a DNS record, which github.io can't give us;
   the HTML-tag method works only for URL-prefix properties).
2. Pick the **HTML tag** method, copy the `<meta name="google-site-verification" ...>` tag into the `<head>` of
   `docs/index.html` (there is a commented placeholder for it), push, wait for Pages to update, then click Verify.
   Use the same Google account that owns the Developer Dashboard.
3. In the Developer Dashboard → the item → **Store listing** tab, choose that site from the **Official URL**
   pull-down (it lists only sites verified as yours). The listing then shows the linked official URL under the title.
4. While in Search Console: Sitemaps → submit `https://lazizjanasatov.github.io/Authpeek/sitemap.xml`, then URL
   inspection → Request indexing for `/` and `/privacy.html`.

## Images (ready in docs/store/)
Regenerate with `npm run store-assets` (runs the real extension with demo accounts).
- screenshot-1-codes.png … screenshot-5-safe.png: 1280×800 screenshots, in this order
- promo-small-440x280.png: small promo tile
- promo-marquee-1400x560.png: marquee promo tile (optional; used if the store features AuthPeek)
- Store icon: extension/icons/icon128.png

## Firefox (addons.mozilla.org)
- Upload dist/authpeek-firefox.zip (`npm run package:firefox`); validated with web-ext lint, 0 warnings.
- Add-on ID: lazizjannsl12@gmail.com. Minimum Firefox 142 (desktop and Android).
- Same images as Chrome. Description: the Chrome one with the changes below. Data collection: none.

### Firefox description differences
Paste the Chrome description with these changes, so the listing matches the Firefox build:
- "open-source authenticator for Chrome" becomes "open-source authenticator for Firefox".
- The sync line becomes "Syncs to your other computers through Firefox Sync, still encrypted".
- "when Chrome starts" becomes "when Firefox starts".
- Add to the end of that list: "Chrome sync and Firefox Sync are separate: to use AuthPeek in both, restore a backup in the other browser."
