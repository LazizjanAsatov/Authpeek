# Deploy checklist

Everything below the "You do" lines needs an account only you can create. The rest is ready.

## Before each release

```bash
npm test && npm run e2e
```

```bash
npm run package
```

- Bump `version` in `extension/manifest.json` and `package.json` together (they must match).
- Commit, then tag: `git tag v1.3.0`.
- Upload: `dist/authpeek.zip` (Chrome Web Store, and Edge Add-ons if you list there).
- The store name and summary come from the manifest's `name` and `description`, so changing either one
  (as 1.2.0 did) means uploading a new version; they can't be edited in the dashboard alone.

## Privacy policy URL (the store asks for one)

Live at **https://lazizjanasatov.github.io/Authpeek/privacy.html** (GitHub Pages, served from
the `docs` folder of the public repository https://github.com/LazizjanAsatov/Authpeek).
Use that address in the store form. The terms of use are next to it, at
**https://lazizjanasatov.github.io/Authpeek/terms.html**. After changing `extension/privacy.html` or
`extension/terms.html`, copy the text to the `docs/` copy of the same page (those keep the site's own
inline styling instead of `legal.css`) and push; Pages updates within a minute or two.

## Chrome Web Store

**You do:** register at https://chrome.google.com/webstore/devconsole (one-time $5 fee), then
"New item" and upload `dist/authpeek.zip`.

Fill in from `docs/store-listing.md`:
- Store listing: name, summary, description, category (Privacy & Security; Productivity no longer
  exists), language.
- Graphic assets: icon `extension/icons/icon128.png`, screenshots
  `docs/store/screenshot-1-codes.png` … `screenshot-5-safe.png` (1280×800, in that order),
  small promo tile `docs/store/promo-small-440x280.png`, marquee promo tile
  `docs/store/promo-marquee-1400x560.png` (optional). All are 24-bit PNG with no transparency.
- Privacy tab: single purpose, one justification per permission (`storage`, `contextMenus`,
  `activeTab`, host permissions), the data-usage disclosures, and the privacy policy URL.
- Distribution: public, all regions.

**Search Console (once, same Google account as the dashboard):** add a URL-prefix property for
`https://lazizjanasatov.github.io/Authpeek/`, verify it with the HTML-tag method (the placeholder is in
`docs/index.html`'s `<head>`), submit `sitemap.xml`, then pick the site as **Official URL** in the Store
listing tab. Steps in `docs/store-listing.md`. Once the item is live, put its URL in `STORE_URL`
(`extension/lib/config.js`), in the Install sections of `README.md` and `docs/index.html`, and as
`installUrl` in the JSON-LD block of `docs/index.html`.

Review usually takes 1–3 days; the host-permission request can make it a few days longer.
Reviewers may ask why the extension runs on all sites: the answer is in the host-permission
justification (login pages can be on any site).

## Microsoft Edge (optional)

Edge installs Chrome extensions directly from the Chrome Web Store. A separate Edge Add-ons
listing (https://partner.microsoft.com/dashboard/microsoftedge) is free and takes the same
`dist/authpeek.zip` and listing text, if you want to appear in Edge's own store.

## After publishing

- Install from the store on a second computer and confirm: create password → accounts appear
  (sync) → unlock → a code fills on a linked site.
- Keep `docs/store-listing.md` the source of truth for listing text; if you also list on Edge Add-ons, update both together.
- Users' old vaults keep working across versions: the encryption format and the storage keys are
  fixed (see the comment on `CHECK_VALUE` in `extension/lib/crypto.js`). Never change them.
- One exception, on purpose: once Whitelisted IPs (1.3) has been used, the vault's password check holds
  the list, and AuthPeek 1.2 and older can no longer unlock that vault. Settings warns before the first
  entry is saved; tell people who use AuthPeek on several computers to update them all first.
