# Deploy checklist

Everything below the "You do" lines needs an account only you can create. The rest is ready.

## Before each release

```bash
npm test && npm run e2e
```

```bash
npm run package && npm run package:firefox
```

- Bump `version` in `extension/manifest.json` and `package.json` together (they must match).
- Commit, then tag: `git tag v1.1.0`.
- Uploads: `dist/authpeek.zip` (Chrome / Edge) and `dist/authpeek-firefox.zip` (Firefox).

## Privacy policy URL (both stores ask for one)

Live at **https://lazizjanasatov.github.io/Authpeek/privacy.html** (GitHub Pages, served from
the `docs` folder of the public repository https://github.com/LazizjanAsatov/Authpeek).
Use that address in both store forms. After changing `extension/privacy.html`, copy it to
`docs/` again and push; Pages updates within a minute or two.

## Chrome Web Store

**You do:** register at https://chrome.google.com/webstore/devconsole (one-time $5 fee), then
"New item" and upload `dist/authpeek.zip`.

Fill in from `docs/store-listing.md`:
- Store listing: name, summary, description, category (Productivity), language.
- Graphic assets: icon `extension/icons/icon128.png`, screenshots
  `docs/store/screenshot-1-codes.png` … `screenshot-5-safe.png` (1280×800, in that order),
  small promo tile `docs/store/promo-small-440x280.png`, marquee promo tile
  `docs/store/promo-marquee-1400x560.png` (optional). All are 24-bit PNG with no transparency.
- Privacy tab: single purpose, one justification per permission (`storage`, `contextMenus`,
  `activeTab`, host permissions), the data-usage disclosures, and the privacy policy URL.
- Distribution: public, all regions.

Review usually takes 1–3 days; the host-permission request can make it a few days longer.
Reviewers may ask why the extension runs on all sites: the answer is in the host-permission
justification (login pages can be on any site).

## Firefox Add-ons (addons.mozilla.org)

**You do:** sign in at https://addons.mozilla.org/developers/ (free), "Submit a New Add-on",
"On this site", upload `dist/authpeek-firefox.zip`.

- Same name, summary, description and images as Chrome.
- Add-on ID is already in the manifest (`lazizjannsl12@gmail.com`); minimum Firefox 142.
- Data collection: none (declared in the manifest).
- If asked for source code: the zip *is* the source (no build step); `extension/vendor/jsQR.js`
  is the unmodified jsQR 1.4.0 release.
- Not yet run in a real Firefox on this machine. Before uploading, load `dist/firefox` once via
  `about:debugging` → Load Temporary Add-on and sign in somewhere with a code.

## Microsoft Edge (optional)

Edge installs Chrome extensions directly from the Chrome Web Store. A separate Edge Add-ons
listing (https://partner.microsoft.com/dashboard/microsoftedge) is free and takes the same
`dist/authpeek.zip` and listing text, if you want to appear in Edge's own store.

## After publishing

- Install from the store on a second computer and confirm: create password → accounts appear
  (sync) → unlock → a code fills on a linked site.
- Keep `docs/store-listing.md` the source of truth for listing text; update both stores together.
- Users' old vaults keep working across versions: the encryption format and the storage keys are
  fixed (see the comment on `CHECK_VALUE` in `extension/lib/crypto.js`). Never change them.
