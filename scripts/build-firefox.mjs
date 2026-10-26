// Builds the Firefox version into dist/firefox from the same source.
// Firefox differences handled here (code is shared; Firefox supports the chrome.* API):
//  - background runs as a module script, not a service worker
//  - add-on ID and the data-collection statement Mozilla requires
//  - host access is declared so the user can grant it (it's opt-in on Firefox; the popup asks)
//  - the settings page opens in a tab via options_ui
//  - the few UI strings that name Chrome or Google sync say Firefox instead
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = resolve('extension');
const out = resolve('dist/firefox');
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

const manifest = JSON.parse(readFileSync(resolve(src, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
manifest.description = manifest.description.replace('for Chrome', 'for Firefox');
manifest.background = { scripts: ['background.js'], type: 'module' };
manifest.host_permissions = ['http://*/*', 'https://*/*'];
manifest.options_ui = { page: manifest.options_page, open_in_tab: true };
delete manifest.options_page;
manifest.browser_specific_settings = {
  gecko: {
    id: 'lazizjannsl12@gmail.com', // permanent once submitted to addons.mozilla.org
    strict_min_version: '142.0', // first version with data_collection_permissions on desktop and Android
    data_collection_permissions: { required: ['none'] },
  },
};
writeFileSync(resolve(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Words that name Chrome or Google where Firefox users have Firefox and Firefox Sync. A phrase
// that has gone from the source stops the build, so a reworded string isn't left unswapped.
const wording = [
  ['popup.html', 'before they sync to your Google account', 'before they sync with Firefox Sync'],
  ['popup.html', 'Give Chrome sync a minute', 'Give Firefox Sync a minute'],
  ['popup.js', 'Chrome doesn’t allow scanning this page', 'Firefox doesn’t allow scanning this page'],
  ['options.html', 'Each time Chrome starts', 'Each time Firefox starts'],
  ['options.html', 'to every Chrome signed in to your Google account', 'to every Firefox signed in to your Mozilla account'],
  ['options.js', 'anyone using this Chrome profile', 'anyone using this Firefox profile'],
  ['options.js', 'each time Chrome starts', 'each time Firefox starts'],
];
for (const [file, from, to] of wording) {
  const path = resolve(out, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`build-firefox: "${from}" is no longer in ${file}`);
  writeFileSync(path, text.replaceAll(from, to));
}
console.log(`Firefox build written to ${out}`);
