// Builds the Firefox version into dist/firefox from the same source.
// Firefox differences handled here (code is shared; Firefox supports the chrome.* API):
//  - background runs as a module script, not a service worker
//  - add-on ID and the data-collection statement Mozilla requires
//  - host access is declared so the user can grant it (it's opt-in on Firefox; the popup asks)
//  - the settings page opens in a tab via options_ui
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = resolve('extension');
const out = resolve('dist/firefox');
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

const manifest = JSON.parse(readFileSync(resolve(src, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
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
console.log(`Firefox build written to ${out}`);
