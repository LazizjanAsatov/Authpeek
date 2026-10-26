// End-to-end check in real Chrome: loads the unpacked extension into a throwaway
// profile, drives the popup, and verifies auto-fill on local test pages.
//   node scripts/e2e.mjs [screenshotDir]
import puppeteer from 'puppeteer-core';
import QRCode from 'qrcode';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeBase32 } from '../extension/lib/base32.js';
import { createRequire } from 'node:module';
import { generateTotp } from '../extension/lib/totp.js';
import { TIME_URL } from '../extension/lib/clock.js';
import { codesForWindow, encodeShare, shareUrl } from '../extension/lib/share.js';

const steamTotp = createRequire(import.meta.url)('steam-totp');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = resolve('extension');
const shots = resolve(process.argv[2] || 'dist/e2e');
mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (ok, name) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codesAround = async (secret) => {
  const now = Date.now();
  const s = decodeBase32(secret);
  return Promise.all([now - 30000, now, now + 30000].map((t) => generateTotp({ secret: s, timestamp: t })));
};

// ---------- local test pages ----------
const pages = {
  '/menu': '<!doctype html><title>Dashboard</title><body><ul><li id="m" tabindex="0" value="3">Menu item</li></ul><progress id="p" tabindex="0" value="40" max="100"></progress><input id="i"></body>',
  '/setup-key': '<!doctype html><title>Set up 2FA</title><body><p>Can&apos;t scan the QR code? Enter this key in your authenticator app:</p><p><code>KRSX G5CT MVRX EZLU</code></p></body>',
  '/notes': '<!doctype html><title>Notes</title><body><input name="memo" id="memo" placeholder="Anything"><input name="other" id="other"></body>',
  '/setup-link': '<!doctype html><title>Set up 2FA</title><body><p>Can&apos;t scan? <a href="otpauth://totp/LinkCo:setup?secret=MFRGGZDFMZTWQ2LK&amp;issuer=LinkCo">Open in your authenticator</a></p></body>',
  '/signin': `<!doctype html><title>Sign in</title><body style="font:16px system-ui;padding:40px">
    <h2>Sign in</h2>
    <form action="/single" method="get">
      <label>Email <input type="email" name="email"></label>
      <button>Next</button>
    </form></body>`,
  '/single-who': `<!doctype html><title>Verify</title><body style="font:16px system-ui;padding:40px">
    <h2>Two-step verification</h2><p>Signed in as ops@example.com</p>
    <form><input id="c" name="otp" autocomplete="one-time-code"><button>Verify</button></form></body>`,
  '/single': `<!doctype html><title>Sign in</title><body style="font:16px system-ui;padding:40px">
    <h2>Two-step verification</h2>
    <form onsubmit="event.preventDefault();document.title='submitted'">
      <label for="c">Enter the 6-digit code from your authenticator app</label><br>
      <input id="c" name="otp" autocomplete="one-time-code" inputmode="numeric" style="font-size:22px;margin:10px 0">
      <button>Verify</button>
    </form></body>`,
  '/split': `<!doctype html><title>Verify</title><body style="font:16px system-ui;padding:40px">
    <h2>Enter your code</h2><div id="slot"></div>
    <script>
      setTimeout(() => {
        const wrap = document.createElement('div');
        for (let i = 0; i < 6; i++) {
          const cell = document.createElement('div'); cell.style.display = 'inline-block';
          const box = document.createElement('input'); box.maxLength = 1; box.size = 1;
          box.style.cssText = 'width:36px;height:44px;font-size:22px;text-align:center;margin:4px';
          box.addEventListener('input', () => box.dataset.seen = box.value);
          cell.append(box); wrap.append(cell);
        }
        document.getElementById('slot').append(wrap);
      }, 800);
    </script></body>`,
};
// The share link viewer, straight from the Pages folder, as GitHub Pages would serve it. Its
// stylesheet bundles Inter from docs/fonts, so that file is served too.
const docsFiles = {
  '/share.html': ['share.html', 'text/html'],
  '/share.js': ['share.js', 'text/javascript'],
  '/common.css': ['common.css', 'text/css'],
  '/fonts/Inter-Variable.woff2': ['fonts/Inter-Variable.woff2', 'font/woff2'],
};
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (docsFiles[path]) {
    const [file, type] = docsFiles[path];
    res.writeHead(200, { 'content-type': type });
    return res.end(readFileSync(resolve('docs', file)));
  }
  const body = pages[path];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
  res.end(body || 'not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---------- QR images ----------
const tmp = mkdtempSync(join(tmpdir(), 'otp-e2e-'));
const ghSecret = 'JBSWY3DPEHPK3PXP';
const ghQr = join(tmp, 'github.png');
await QRCode.toFile(ghQr, `otpauth://totp/GitHub:alice%40example.com?secret=${ghSecret}&issuer=GitHub`, { width: 300 });

function field(num, bytes) {
  const out = [];
  let tag = (num << 3) | 2;
  while (tag > 127) { out.push((tag & 127) | 128); tag >>>= 7; }
  out.push(tag);
  let len = bytes.length;
  while (len > 127) { out.push((len & 127) | 128); len >>>= 7; }
  out.push(len);
  return [...out, ...bytes];
}
const enc = (s) => [...Buffer.from(s)];
const exportParams = (secret, name, issuer) =>
  field(1, [...field(1, [...decodeBase32(secret)]), ...field(2, enc(name)), ...field(3, enc(issuer)), 0x20, 1, 0x28, 1, 0x30, 2]);
const migration = [
  ...exportParams('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'root', 'Amazon Web Services'),
  ...exportParams('MFRGGZDFMZTWQ2LK', 'me@gmail.com', 'Google'),
  ...exportParams('ONSWG4TFORZWK3TP', 'team', 'Dropbox'),
];
const migQr = join(tmp, 'migration.png');
await QRCode.toFile(migQr, `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(migration).toString('base64'))}`, { width: 360 });

// ---------- browser ----------
const launch = () =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: [EXT],
    userDataDir: join(tmp, 'profile'), // same profile on every launch, like a real Chrome restart
    args: ['--no-first-run', '--no-default-browser-check'],
  });
const waitForWorker = (b) =>
  b.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
const isWelcome = (t) => t.url().endsWith('/welcome.html');
// Resolves to the welcome tab if one opens within `ms`, or null.
const welcomeOpens = (b, ms) => b.waitForTarget(isWelcome, { timeout: ms }).catch(() => null);
let browser = await launch();

try {
  const worker = await waitForWorker(browser);
  const extId = new URL(worker.url()).host;
  check(Boolean(extId), 'extension loads and its service worker starts');

  // A first install opens the welcome page in its own tab. Closed right after, so the
  // steps below only ever see tabs they opened themselves.
  const welcomeTarget = await welcomeOpens(browser, 10000);
  check(Boolean(welcomeTarget), 'a first install opens the welcome page');
  if (welcomeTarget) {
    const welcome = await welcomeTarget.page();
    const welcomeErrors = [];
    welcome.on('pageerror', (e) => welcomeErrors.push(e.message));
    welcome.on('console', (m) => m.type() === 'error' && welcomeErrors.push(m.text()));
    await welcome.setViewport({ width: 375, height: 800 });
    await welcome.reload({ waitUntil: 'load' }); // it loaded before the listeners were attached
    const shown = await welcome.evaluate(() => ({
      title: document.querySelector('h1')?.textContent.trim(),
      steps: document.querySelectorAll('.step').length,
      fits: document.documentElement.scrollWidth <= innerWidth,
    }));
    check(shown.title === 'AuthPeek is ready' && shown.steps === 3, `the welcome page shows its heading and 3 steps (${shown.title}, ${shown.steps})`);
    check(shown.fits, 'the welcome page fits a 375 px screen without sideways scrolling');
    await welcome.screenshot({ path: join(shots, '0-welcome.png'), fullPage: true });
    const settingsOpens = browser.waitForTarget((t) => t.url().endsWith('/options.html'), { timeout: 5000 }).catch(() => null);
    await welcome.click('#btn-settings');
    const settingsTarget = await settingsOpens;
    check(Boolean(settingsTarget), 'Open settings on the welcome page opens the settings');
    await (await settingsTarget?.page())?.close();
    check(welcomeErrors.length === 0, `no errors on the welcome page${welcomeErrors.length ? ': ' + welcomeErrors.join(' | ') : ''}`);
    await welcome.close();
  }

  // The shortcut and the right-click menu run without a toolbar click, so they need host
  // permissions to see which site a tab is on (activeTab only covers the popup).
  const urlProbe = await browser.newPage();
  await urlProbe.goto(`http://localhost:${port}/single`);
  const seenUrl = await (await waitForWorker(browser)).worker().then((w) => w.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => t.url || '').find((u) => u.startsWith('http://localhost')) || '(no url)';
  }));
  check(seenUrl.startsWith('http://localhost'), `the background can read a tab's address without a toolbar click (${seenUrl})`);
  await urlProbe.close();

  const popup = await browser.newPage();
  const errors = [];
  popup.on('pageerror', (e) => errors.push(e.message));
  popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await popup.setViewport({ width: 360, height: 600 });
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await popup.goto(`chrome-extension://${extId}/popup.html`);

  // First run
  await popup.waitForSelector('[data-view="setup"]:not([hidden])');
  await popup.screenshot({ path: join(shots, '1-setup.png') });
  // Too short: AuthPeek's own message, not the browser's grey validation bubble
  await popup.type('#setup-pw', 'short');
  await popup.click('#form-setup button[type=submit]');
  check((await popup.$eval('#setup-msg', (e) => e.textContent)) === 'Use at least 8 characters.', 'a short password gets AuthPeek’s own message');
  await popup.$eval('#setup-pw', (e) => (e.value = ''));
  await popup.type('#setup-pw', 'correct horse 42');
  await popup.type('#setup-pw2', 'correct horse 42');
  await popup.click('#form-setup button[type=submit]');
  await popup.waitForSelector('[data-view="list"]:not([hidden])', { timeout: 20000 });
  check(await popup.$eval('#empty', (e) => !e.hidden), 'after setup the empty list is shown');
  await popup.screenshot({ path: join(shots, '2-empty.png') });

  // Upload a QR image
  await popup.click('#btn-add');
  await popup.click('[data-tab="upload"]');
  check(await popup.$eval('#file', (f) => (f.focus(), document.activeElement === f)), 'the Image tab’s file chooser can be reached with the keyboard');
  await (await popup.$('#file')).uploadFile(ghQr);
  await popup.waitForFunction(() => [...document.querySelectorAll('.row .issuer')].some((e) => e.textContent === 'GitHub'), { timeout: 10000 });
  check(true, 'uploading a QR screenshot adds the account');

  // Google Authenticator transfer QR
  await popup.click('#btn-add');
  await popup.click('[data-tab="upload"]');
  await (await popup.$('#file')).uploadFile(migQr);
  await popup.waitForFunction(() => document.querySelectorAll('.row').length === 4, { timeout: 10000 });
  check(true, 'Google Authenticator transfer QR adds all 3 accounts');

  // Typed key
  await popup.click('#btn-add');
  await popup.click('[data-tab="key"]');
  await popup.screenshot({ path: join(shots, '2b-add-key.png') });
  // An empty Service gets AuthPeek's own message, not the browser's grey bubble
  await popup.type('#key-secret', 'jbsw y3dp ehpk 3pxq');
  await popup.click('#form-key button[type=submit]');
  await popup.waitForFunction(() => document.querySelector('#add-msg').textContent, { timeout: 3000 }).catch(() => {});
  const noService = await popup.$eval('#add-msg', (e) => `${e.getAttribute('role')}: ${e.textContent}`);
  check(noService === 'alert: Enter the service name, for example GitHub.', `adding a key without a service says so (${noService})`);
  await popup.$eval('#key-secret', (e) => (e.value = ''));
  await popup.type('#key-issuer', 'Stripe');
  await popup.type('#key-label', 'ops@example.com');
  await popup.type('#key-secret', 'not a key!');
  await popup.click('#form-key button[type=submit]');
  await popup.waitForFunction(() => document.querySelector('#add-msg').textContent.includes('A–Z'));
  check(true, 'an invalid key shows a helpful error');
  await popup.$eval('#key-secret', (e) => (e.value = ''));
  await popup.type('#key-secret', 'jbsw y3dp ehpk 3pxq');
  await popup.click('#form-key button[type=submit]');
  await popup.waitForFunction(() => document.querySelectorAll('.row').length === 5, { timeout: 10000 });
  check(true, 'typing a secret key adds the account');

  // Paste link tab: the user's own SHA512 link, plus a second link in surrounding text
  const hyperion = 'otpauth://totp/Hyperion%20Rapid%20Solutions:neurohaven?secret=JXR5ZD22TMGXBTJ3BKBIZLBBRUTAYJKPMVNS67QQ2VGYAVBRICNA&issuer=Hyperion%20Rapid%20Solutions&algorithm=SHA512&digits=6&period=30';
  await popup.click('#btn-add');
  await popup.focus('[data-tab="scan"]');
  await popup.keyboard.press('ArrowRight');
  const arrowed = await popup.evaluate(() => `${document.activeElement.dataset.tab}:${document.activeElement.getAttribute('aria-selected')}`);
  check(arrowed === 'link:true', `the arrow keys move between the Add tabs (${arrowed})`);
  await popup.click('[data-tab="link"]');
  await popup.$eval('#links', (el, v) => (el.value = v), 'Keys for the team:\n' + hyperion + '\nand otpauth://totp/Paste:second?secret=ONSWG4TFORZWK3TQ&issuer=Paste.');
  await popup.click('#btn-links');
  await popup.waitForFunction(() => document.querySelectorAll('.row').length === 7, { timeout: 10000 }).catch(() => {});
  const hyperionCode = await popup.evaluate(() => {
    const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.issuer').textContent === 'Hyperion Rapid Solutions');
    return row ? row.querySelector('.code').textContent.replace(/\D/g, '') : '';
  });
  const hyperionExpected = await Promise.all([-30000, 0, 30000].map((d) =>
    generateTotp({ secret: decodeBase32('JXR5ZD22TMGXBTJ3BKBIZLBBRUTAYJKPMVNS67QQ2VGYAVBRICNA'), algorithm: 'SHA512', timestamp: Date.now() + d })));
  check(hyperionExpected.includes(hyperionCode), `pasting links adds them all, with SHA512 codes right (${hyperionCode || 'missing'})`);

  // A real paste anywhere on the codes screen
  await popup.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'otpauth://totp/Clipboard:me?secret=MZXW6YTBOI======&issuer=Clipboard');
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  check(
    await popup.waitForFunction(() => [...document.querySelectorAll('.row .issuer')].some((e) => e.textContent === 'Clipboard'), { timeout: 10000 }).then(() => true, () => false),
    'pasting a link anywhere on the codes screen adds it'
  );

  // A link typed into the Secret key box, with Service left empty
  await popup.click('#btn-add');
  await popup.click('[data-tab="key"]');
  await popup.type('#key-secret', 'otpauth://totp/Typed:me?secret=KRUGKIDROVUWG2ZA&issuer=Typed');
  check(
    await popup.waitForFunction(() => [...document.querySelectorAll('.row .issuer')].some((e) => e.textContent === 'Typed'), { timeout: 10000 }).then(() => true, () => false),
    'a link in the Secret key box is added without filling Service'
  );

  // Scan's fallback: a setup page that has a link but no QR code
  const setupTab = await browser.newPage();
  await setupTab.goto(`http://localhost:${port}/setup-link`);
  await sleep(500);
  const pageLinks = await popup.evaluate(async () => {
    const found = [];
    for (const t of await chrome.tabs.query({})) {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'otp:links' }).catch(() => null);
      if (r?.links) found.push(...r.links);
    }
    return found;
  });
  check(pageLinks.some((l) => l.includes('LinkCo')), 'scanning a page finds its otpauth:// link when there is no QR code');
  await setupTab.close();
  await popup.bringToFront();
  await popup.reload();
  await popup.waitForSelector('[data-view="list"]:not([hidden])');

  // Setup key printed on the page, for people who can't scan
  const keyTab = await browser.newPage();
  await keyTab.goto(`http://localhost:${port}/setup-key`);
  await sleep(500);
  const pageKeys = await popup.evaluate(async () => {
    const found = [];
    for (const t of await chrome.tabs.query({})) {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'otp:links' }).catch(() => null);
      if (r?.keys) found.push(...r.keys);
    }
    return found;
  });
  check(pageKeys.includes('KRSXG5CTMVRXEZLU'), `scanning finds a key printed on the page (${pageKeys.join(', ') || 'none'})`);
  await keyTab.close();

  // Type anywhere to search
  await popup.bringToFront();
  await popup.focus('body');
  await popup.keyboard.type('hyp');
  await sleep(200);
  const shownAfterSearch = await popup.evaluate(() => [...document.querySelectorAll('.row .issuer')].map((e) => e.textContent));
  check(shownAfterSearch.length === 1 && shownAfterSearch[0] === 'Hyperion Rapid Solutions', `typing filters the list (${shownAfterSearch.join(', ')})`);
  await popup.keyboard.press('Escape');
  await sleep(200);
  check((await popup.$$('.row')).length > 1 && (await popup.$eval('#search', (e) => e.value)) === '', 'Esc clears the search');
  // What a search found is read out once typing pauses
  await popup.keyboard.type('zzz');
  await popup.waitForFunction(() => document.querySelector('#sr-status').textContent.includes('zzz'), { timeout: 3000 }).catch(() => {});
  const noMatchSaid = await popup.$eval('#sr-status', (e) => e.textContent);
  check(noMatchSaid === 'No account matches “zzz”.', `a search with no match is read out (${noMatchSaid})`);
  await popup.keyboard.press('Escape');
  await sleep(200);
  await popup.keyboard.type('aws');
  await sleep(200);
  const aws = await popup.evaluate(() => [...document.querySelectorAll('.row .issuer')].map((e) => e.textContent));
  check(aws.length === 1 && aws[0] === 'Amazon Web Services', `initials find the account ("aws" → ${aws.join(', ')})`);
  await popup.keyboard.press('Escape');

  // Right-click menu
  const menuOk = await (await waitForWorker(browser)).worker().then((w) =>
    w.evaluate(() => chrome.contextMenus.update('authpeek-fill-site', {}).then(() => true, () => false)));
  check(menuOk, 'the right-click menu is there while unlocked');
  const notes = await browser.newPage();
  await notes.goto(`http://localhost:${port}/notes`);
  await sleep(400);
  await notes.click('#memo', { button: 'right' });
  await notes.keyboard.press('Escape');
  const ghId = await popup.evaluate(async () => {
    const { openVault } = await import('./lib/codes.js');
    return (await openVault().listAccounts()).find((a) => a.issuer === 'GitHub').id;
  });
  // What the menu click does: the background sends the code to the right-clicked box.
  const notesTabId = await popup.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  await popup.evaluate(async (tabId) => {
    const { openVault, codeFor } = await import('./lib/codes.js');
    const gh = (await openVault().listAccounts()).find((a) => a.issuer === 'GitHub');
    await chrome.tabs.sendMessage(tabId, { type: 'otp:fill', useContextTarget: true, code: await codeFor(gh), name: 'GitHub' });
  }, notesTabId);
  const memo = await notes.$eval('#memo', (e) => e.value);
  const other = await notes.$eval('#other', (e) => e.value);
  check((await codesAround(ghSecret)).includes(memo) && other === '', `right-click fills the box you clicked (${memo || 'empty'})`);
  await notes.close();
  void ghId;

  // Steam Guard account typed in by hand, using Steam's base64 shared_secret
  const steamBytes = Buffer.from('0123456789abcdefghij');
  await popup.click('#btn-add');
  await popup.click('[data-tab="key"]');
  await popup.type('#key-issuer', 'Steam');
  await popup.type('#key-label', 'gaben');
  await popup.type('#key-secret', steamBytes.toString('base64'));
  await popup.click('#form-key button[type=submit]');
  await popup.waitForFunction(() => [...document.querySelectorAll('.row .issuer')].some((e) => e.textContent === 'Steam'), { timeout: 10000 }).catch(() => {});
  const steamShown = await popup.evaluate(() => {
    const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.issuer').textContent === 'Steam');
    return row ? row.querySelector('.code').textContent.trim() : '';
  });
  const nowS = Math.floor(Date.now() / 1000);
  const steamExpected = [-30, 0, 30].map((d) => steamTotp.getAuthCode(steamBytes.toString('base64'), d));
  check(steamExpected.includes(steamShown), `Steam Guard codes match Steam's (${steamShown || 'missing'})`);
  void nowS;

  // Pin an account to the top
  await popup.evaluate(() => {
    const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.issuer').textContent.endsWith('Stripe'));
    row.querySelector('.row-actions [aria-label^="Edit"]').click();
  });
  await popup.waitForSelector('[data-view="edit"]:not([hidden])');
  const editFocus = await popup.evaluate(() => document.activeElement.matches('[data-view="edit"] .back'));
  // With neither name the edit form explains itself instead of the browser's grey bubble
  const names = await popup.evaluate(() => {
    const kept = [document.querySelector('#edit-issuer').value, document.querySelector('#edit-label').value];
    document.querySelector('#edit-issuer').value = '';
    document.querySelector('#edit-label').value = '';
    return kept;
  });
  await popup.click('#form-edit button[type=submit]');
  await sleep(200);
  const noName = await popup.$eval('#edit-msg', (e) => e.textContent);
  check(noName === 'Enter a service or an account name.' && !(await popup.$eval('[data-view="edit"]', (e) => e.hidden)),
    `saving an account with no name says so and stays on Edit (${noName})`);
  await popup.evaluate(([issuer, label]) => {
    document.querySelector('#edit-issuer').value = issuer;
    document.querySelector('#edit-label').value = label;
  }, names);
  await popup.click('#edit-pinned');
  await popup.click('#form-edit button[type=submit]');
  await popup.waitForSelector('[data-view="list"]:not([hidden])');
  const savedFocus = await popup.evaluate(() => document.activeElement.closest('.row')?.querySelector('.issuer').textContent);
  check(editFocus && savedFocus === 'Stripe', `focus moves into Edit, and back to the account's row after Save (${savedFocus})`);
  const firstRow = await popup.evaluate(() => {
    const row = document.querySelector('.row');
    return { name: row.querySelector('.issuer').textContent, pinMark: Boolean(row.querySelector('.pin')) };
  });
  check(firstRow.name === 'Stripe' && firstRow.pinMark, `a pinned account moves to the top (${firstRow.name})`);

  // Known services show their bundled logo; unknown ones a monogram of their initials
  const tiles = await popup.evaluate(() => {
    const tile = (name) => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.issuer').textContent === name)?.querySelector('.avatar');
    const gh = tile('GitHub');
    const hy = tile('Hyperion Rapid Solutions');
    return { ghLogo: Boolean(gh?.querySelector('svg path')), ghSlug: gh?.dataset.logo, hyMono: Boolean(hy?.classList.contains('mono') && !hy.querySelector('svg')), hyText: hy?.textContent };
  });
  check(tiles.ghLogo && tiles.ghSlug === 'github', `the GitHub row shows the GitHub logo (${tiles.ghSlug || 'none'})`);
  check(tiles.hyMono && tiles.hyText === 'HR', `an unknown service shows a monogram (${tiles.hyText || 'none'})`);

  // ---------- Share ----------
  // jsQR (loaded in the popup) reads a canvas back, to prove the QR holds exactly the text.
  const readCanvasQr = (sel) => popup.$eval(sel, (c) => {
    if (!c.width) return '';
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return globalThis.jsQR(data, c.width, c.height)?.data || '';
  });
  const pasteOnPopup = (text) => popup.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, text);
  const sharedView = '[data-view="shared"]:not([hidden])';
  const sharedCode = () => popup.$eval('#shared-code', (e) => e.textContent.replace(/\D/g, ''));

  // The row's Share button shows on hover; the first visit explains sharing once.
  const ghRow = `.row[data-id="${ghId}"]`;
  await popup.hover(ghRow);
  await popup.click(`${ghRow} .share`);
  await popup.waitForSelector('[data-view="share"]:not([hidden])');
  await sleep(200);
  check(!(await popup.$eval('#share-notice', (e) => e.hidden)), 'the first Share shows how sharing works');
  await popup.click('#share-notice-ok');
  const noticeSeen = await popup.evaluate(async () => (await chrome.storage.local.get('shareNoticeSeen')).shareNoticeSeen);
  check(noticeSeen === true && (await popup.$eval('#share-notice', (e) => e.hidden)), 'Got it hides the notice and remembers it');

  // (a) 2 minutes, then Enter on Create link
  await popup.click('#share-min-2');
  await popup.focus('#btn-share-create');
  await popup.keyboard.press('Enter');
  await popup.waitForFunction(() => document.querySelector('#share-link').value, { timeout: 5000 }).catch(() => {});
  const shareLink = await popup.$eval('#share-link', (e) => e.value);
  check(shareLink.startsWith('https://lazizjanasatov.github.io/Authpeek/share#') && !shareLink.includes(ghSecret),
    `Create link makes a share link without the secret (${shareLink.slice(0, 52)}…)`);
  const until = await popup.$eval('#share-until', (e) => e.textContent);
  check(/^Anyone with this link can see GitHub’s codes until .+\. The link doesn’t contain your secret key\.$/.test(until), `the share view says who can see the codes and until when (${until})`);
  const fragment = shareLink.slice(shareLink.indexOf('#') + 1);
  const window2 = await popup.evaluate(async (f) => {
    const { decodeShare } = await import('./lib/share.js');
    return (await decodeShare(f)).codes.length;
  }, fragment);
  check(window2 === 4 || window2 === 5, `a 2-minute link carries 2 minutes of codes (${window2})`);
  await popup.click('#btn-share-qr');
  check((await readCanvasQr('#share-qr')) === shareLink, 'Show QR draws the share link as a QR code');

  // (d) The setup QR asks for the password first, every time; it holds exactly the otpauth://
  // link, and goes away with the view
  await popup.type('#setup-qr-pw', 'not my password');
  await popup.click('#btn-setup-qr');
  await popup.waitForFunction(() => /isn’t your AuthPeek password/.test(document.querySelector('#setup-qr-msg').textContent), { timeout: 10000 }).catch(() => {});
  const refused = await popup.evaluate(() => ({
    msg: document.querySelector('#setup-qr-msg').textContent,
    hidden: document.querySelector('#setup-qr-box').hidden,
    width: document.querySelector('#setup-qr').width,
  }));
  check(/isn’t your AuthPeek password/.test(refused.msg) && refused.hidden && refused.width === 0, `a wrong password shows an error and no setup QR code (${refused.msg})`);
  await popup.$eval('#setup-qr-pw', (e) => (e.value = ''));
  await popup.type('#setup-qr-pw', 'correct horse 42');
  await popup.click('#btn-setup-qr');
  await popup.waitForSelector('#setup-qr-box:not([hidden])', { timeout: 10000 }).catch(() => {});
  const setupQr = await readCanvasQr('#setup-qr');
  const ghUri = await popup.evaluate(async () => {
    const { openVault } = await import('./lib/codes.js');
    const { toOtpauthUri } = await import('./lib/otpauth.js');
    return toOtpauthUri((await openVault().listAccounts()).find((a) => a.issuer === 'GitHub'));
  });
  check(setupQr === ghUri, `Show setup QR code draws the account's otpauth:// link (${setupQr.slice(0, 40) || 'nothing'}…)`);
  await popup.keyboard.press('Escape');
  await popup.waitForSelector('[data-view="list"]:not([hidden])', { timeout: 5000 }).catch(() => {});
  const leftShare = await popup.evaluate(() => ({
    list: !document.querySelector('[data-view="list"]').hidden,
    setup: document.querySelector('#setup-qr').width,
    hidden: document.querySelector('#setup-qr-box').hidden,
  }));
  check(leftShare.list && leftShare.setup === 0 && leftShare.hidden, 'Esc goes back and the setup QR is cleared');

  // (b) The viewer page shows the code and asks for nothing but its own files
  const viewer = await browser.newPage();
  const viewerRequests = [];
  viewer.on('request', (req) => !req.url().startsWith('data:') && viewerRequests.push(req.url()));
  await viewer.goto(`http://localhost:${port}/share.html#${fragment}`);
  await viewer.waitForFunction(() => /\d/.test(document.getElementById('code')?.textContent || ''), { timeout: 5000 }).catch(() => {});
  const viewerCode = await viewer.$eval('#code', (e) => e.textContent.replace(/\D/g, ''));
  check((await codesAround(ghSecret)).includes(viewerCode), `the share page shows the GitHub code (${viewerCode || 'nothing'})`);
  await sleep(500);
  const ownFiles = ['/share.html', '/share.js', '/common.css', '/fonts/Inter-Variable.woff2'].map((p) => `http://localhost:${port}${p}`);
  const strays = viewerRequests.filter((u) => !ownFiles.includes(u.split('#')[0]));
  check(strays.length === 0, `the share page requests only its own files${strays.length ? ': ' + strays.join(', ') : ''}`);

  // (f) Opened on a clock a minute behind, the page says the link isn't valid yet, and once the
  // time comes (here: the clock is put right) it shows the code without a reload.
  const early = await browser.newPage();
  await early.evaluateOnNewDocument(() => {
    const realNow = Date.now.bind(Date);
    window.behindMs = 60_000;
    Date.now = () => realNow() - window.behindMs;
  });
  await early.goto(`http://localhost:${port}/share.html#${fragment}`);
  await sleep(500);
  const earlyText = await early.$eval('#stateCard', (e) => (e.hidden ? '' : e.textContent));
  await early.evaluate(() => (window.behindMs = 0));
  await early.waitForFunction(() => /\d/.test(document.getElementById('code').textContent), { timeout: 3000 }).catch(() => {});
  const lateCode = await early.$eval('#code', (e) => e.textContent.replace(/\D/g, ''));
  check(/not valid yet/.test(earlyText) && (await codesAround(ghSecret)).includes(lateCode),
    `a link that isn't valid yet shows its code by itself once its time comes (${lateCode || 'nothing'})`);
  await early.close();

  // (c) The same link pasted on the codes screen opens the shared view with the same code
  await popup.bringToFront();
  await pasteOnPopup(`Here you go: ${shareLink}`);
  await popup.waitForSelector(sharedView, { timeout: 5000 }).catch(() => {});
  await popup.waitForFunction(() => /\d/.test(document.querySelector('#shared-code').textContent), { timeout: 5000 }).catch(() => {});
  let [inPopup, onPage] = await Promise.all([sharedCode(), viewer.$eval('#code', (e) => e.textContent.replace(/\D/g, ''))]);
  if (inPopup !== onPage) {
    await sleep(600); // read across a code change; the next reading settles it
    [inPopup, onPage] = await Promise.all([sharedCode(), viewer.$eval('#code', (e) => e.textContent.replace(/\D/g, ''))]);
  }
  check(inPopup === onPage && (await codesAround(ghSecret)).includes(inPopup), `a pasted share link shows the same code in the popup (${inPopup || 'nothing'})`);
  check(/^Expires at /.test(await popup.$eval('#shared-expires', (e) => e.textContent)), 'the shared view says when the codes expire');
  await viewer.close();
  await popup.keyboard.press('Escape');
  await popup.waitForSelector('[data-view="list"]:not([hidden])', { timeout: 5000 }).catch(() => {});

  // (e) A tampered link says so
  const at = fragment.indexOf('.', 3) - 10;
  const tampered = fragment.slice(0, at) + (fragment[at] === 'A' ? 'B' : 'A') + fragment.slice(at + 1);
  await pasteOnPopup(tampered);
  await popup.waitForFunction(() => document.querySelector('#shared-state-text').textContent, { timeout: 5000 }).catch(() => {});
  check((await popup.$eval('#shared-state-text', (e) => e.textContent)) === 'This link is damaged.', 'a tampered share link shows "This link is damaged."');
  await popup.click('[data-view="shared"] .back');
  await popup.waitForSelector('[data-view="list"]:not([hidden])');

  // On the web viewer a damaged link gets the warning sign, and doesn't claim it was decrypted
  const damaged = await browser.newPage();
  await damaged.goto(`http://localhost:${port}/share.html#${tampered}`);
  await damaged.waitForSelector('#stateCard:not([hidden])', { timeout: 5000 }).catch(() => {});
  const damagedPage = await damaged.evaluate(() => ({
    kind: document.querySelector('#stateCard').dataset.kind,
    decrypted: !document.querySelector('#decrypted').hidden,
    role: document.querySelector('#state').getAttribute('role'),
  }));
  check(damagedPage.kind === 'link' && !damagedPage.decrypted && damagedPage.role === 'status',
    `the share page marks a damaged link as a link problem (${JSON.stringify(damagedPage)})`);
  await damaged.close();

  // Codes that run out while Copy has focus leave focus on Back, not on the page
  const shortLink = await popup.evaluate(async () => {
    const { encodeShare, shareUrl } = await import('./lib/share.js');
    const start = Math.floor(Date.now() / 1000) * 1000;
    return shareUrl(await encodeShare({ v: 1, name: 'Fast', period: 1, digits: 6, start, codes: ['111111', '222222', '333333'] }));
  });
  await pasteOnPopup(shortLink);
  await popup.waitForSelector('#shared-card:not([hidden])', { timeout: 3000 }).catch(() => {});
  const copyFocused = await popup.evaluate(() => document.activeElement?.id);
  await popup.waitForFunction(() => /expired/.test(document.querySelector('#shared-state-text').textContent), { timeout: 6000 }).catch(() => {});
  const afterExpiry = await popup.evaluate(() => document.activeElement.matches('[data-view="shared"] .back'));
  check(copyFocused === 'shared-copy' && afterExpiry, `when shared codes expire, focus moves from Copy to Back (${copyFocused})`);
  await popup.click('[data-view="shared"] .back');
  await popup.waitForSelector('[data-view="list"]:not([hidden])');

  // From the edit view, Share opens the same view and Back returns to the edit view
  await popup.hover(ghRow);
  await popup.click(`${ghRow} [aria-label^="Edit"]`);
  await popup.waitForSelector('[data-view="edit"]:not([hidden])');
  await popup.click('#btn-share-edit');
  await popup.waitForSelector('[data-view="share"]:not([hidden])');
  await popup.click('[data-view="share"] .back');
  check(await popup.waitForSelector('[data-view="edit"]:not([hidden])', { timeout: 3000 }).then(() => true, () => false), 'Share from the edit view goes back to the edit view');
  await popup.click('[data-view="edit"] .back');
  await popup.waitForSelector('[data-view="list"]:not([hidden])');

  // Clock 47 s slow: the popup measures it when it opens, warns, and corrects codes.
  // Cloudflare's time answer is faked here: `ahead` ms ahead of this computer's clock.
  const timeAnswer = (ahead) => (req) =>
    req.url() === TIME_URL
      ? req.respond({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' },
          body: `ts=${((Date.now() + ahead) / 1000).toFixed(3)}\n` })
      : req.continue();
  // The GitHub code, once the popup shows the one for `ahead` ms from now (±2 s). Codes are
  // repainted on the popup's next tick after a measurement, so this waits up to 3 s for it.
  async function githubCodeFor(ahead) {
    let shown = '';
    for (let tries = 0; tries < 30; tries++) {
      shown = await popup.evaluate(() => {
        const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.issuer').textContent === 'GitHub');
        return row.querySelector('.code').textContent.replace(/\D/g, '');
      });
      const expected = await Promise.all([ahead - 2_000, ahead, ahead + 2_000].map((d) =>
        generateTotp({ secret: decodeBase32(ghSecret), timestamp: Date.now() + d })));
      if (expected.includes(shown)) return { shown, ok: true };
      await sleep(100);
    }
    return { shown, ok: false };
  }
  const answer47Ahead = timeAnswer(47_000);
  await popup.setRequestInterception(true);
  popup.on('request', answer47Ahead);
  await popup.reload();
  await popup.waitForSelector('[data-view="list"]:not([hidden])');
  await popup.waitForSelector('#clock-warn:not([hidden])', { timeout: 5000 }).catch(() => {});
  const warnText = await popup.$eval('#clock-warn', (e) => (e.hidden ? '' : e.textContent));
  check(/47 seconds slow/.test(warnText), `a wrong clock is reported (${warnText.slice(0, 50) || 'no warning'})`);
  const corrected = await githubCodeFor(47_000);
  check(corrected.ok, `codes are corrected for the clock (${corrected.shown})`);
  await popup.screenshot({ path: join(shots, '3c-clock.png') });

  // The clock gets fixed: the next time the popup opens it measures again and drops the correction.
  popup.off('request', answer47Ahead);
  const answerOnTime = timeAnswer(0);
  popup.on('request', answerOnTime);
  await popup.reload();
  await popup.waitForSelector('[data-view="list"]:not([hidden])');
  const fixed = await githubCodeFor(0);
  check(fixed.ok, `a clock fixed since the last check is noticed when the popup opens (${fixed.shown})`);
  popup.off('request', answerOnTime);
  await popup.setRequestInterception(false);

  // Codes shown match an independent calculation
  const shown = await popup.$eval('.row[data-id] .code', () => {
    const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.issuer').textContent === 'GitHub');
    return row.querySelector('.code').textContent.replace(/\D/g, '');
  });
  check((await codesAround(ghSecret)).includes(shown), `GitHub code in popup (${shown}) matches RFC TOTP`);

  // Link GitHub to the local test site (as if filled once by hand there)
  await popup.evaluate(async () => {
    const { openVault } = await import('./lib/codes.js');
    const vault = openVault();
    const gh = (await vault.listAccounts()).find((a) => a.issuer === 'GitHub');
    await vault.updateAccount(gh.id, { sites: ['localhost'] });
  });
  await popup.reload();
  await popup.waitForSelector('[data-view="list"]:not([hidden])');
  await sleep(300);
  await popup.screenshot({ path: join(shots, '3-list.png') });
  check(await popup.$eval('#perm', (e) => e.hidden), 'Chrome needs no extra "Allow on websites" step');
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await sleep(100);
  await popup.screenshot({ path: join(shots, '4-list-dark.png') });
  const ghTileDark = await popup.$eval(`${ghRow} .avatar`, (e) => getComputedStyle(e).backgroundColor);
  check(ghTileDark === 'rgb(47, 54, 61)', `in dark mode GitHub's near-black tile is lifted off the page (${ghTileDark})`);
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // A page that asks for a code, with a long username in its banner. The popup is opened as a
  // tab here, so it is pointed at the sign-in tab, as if the toolbar icon had been clicked there.
  const setGithubLabel = (label) => popup.evaluate(async (l) => {
    const { openVault } = await import('./lib/codes.js');
    const vault = openVault();
    const gh = (await vault.listAccounts()).find((a) => a.issuer === 'GitHub');
    await vault.updateAccount(gh.id, { label: l });
  }, label);
  await setGithubLabel('alexandra.northwind-operations@example.com');
  const signTab = await browser.newPage();
  await signTab.goto(`http://localhost:${port}/single`);
  await sleep(500);
  const banner = await browser.newPage();
  banner.on('pageerror', (e) => errors.push(e.message));
  await banner.setViewport({ width: 360, height: 600 });
  await banner.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await banner.evaluateOnNewDocument((url) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q?.active ? (await query({})).filter((t) => t.url === url) : query(q));
  }, `http://localhost:${port}/single`);
  await banner.goto(`chrome-extension://${extId}/popup.html`);
  await banner.waitForSelector('#page:not([hidden]) .page-item', { timeout: 8000 }).catch(() => {});
  const fits = await banner.evaluate(() => {
    const btn = document.querySelector('.page-item .btn');
    return btn ? btn.getBoundingClientRect().right <= document.documentElement.clientWidth : false;
  });
  check(fits, 'with a long username in the page banner, Fill code stays inside the popup');
  await banner.screenshot({ path: join(shots, '4c-banner.png') });

  // Hovering a row shows Fill and Share without moving anything; neither does copying.
  const layout = () => banner.evaluate(() => [...document.querySelectorAll('.row')]
    .map((r) => `${r.querySelector('.copy').getBoundingClientRect().left}/${r.querySelector('.who').getBoundingClientRect().width}`).join(' '));
  const atRest = await layout();
  // The banner asks to "Choose Fill on an account below", so Fill shows without a hover
  const restFill = await banner.$eval(`${ghRow} .row-hover`, (e) => ({
    fill: e.querySelector('.fill') ? getComputedStyle(e).opacity : 'none',
    share: getComputedStyle(e.querySelector('.share')).opacity,
  }));
  check(restFill.fill === '1' && restFill.share === '0', `on a page asking for a code, Fill shows on every row at rest (fill ${restFill.fill}, share ${restFill.share})`);
  await banner.hover(ghRow);
  await sleep(250);
  const hovered = await layout();
  const fillShown = await banner.$eval(`${ghRow} .row-hover`, (e) => getComputedStyle(e).opacity === '1' && Boolean(e.querySelector('.fill')));
  await banner.screenshot({ path: join(shots, '4d-banner-hover.png') });
  check(fillShown && hovered === atRest, 'hovering a row shows Fill and Share and moves nothing in the list');
  const clipCdp = await browser.target().createCDPSession();
  await clipCdp.send('Browser.grantPermissions', { origin: `chrome-extension://${extId}`, permissions: ['clipboardReadWrite'] });
  await banner.bringToFront();
  await banner.click(`${ghRow} .copy`);
  await banner.waitForSelector(`${ghRow} .code.copied`, { timeout: 3000 }).catch(() => {});
  const copiedLayout = await layout();
  const copiedShown = await banner.$eval(`${ghRow} .code`, (e) => e.classList.contains('copied'));
  check(copiedShown && copiedLayout === atRest, `copying a code shows "Copied" without resizing the row${copiedShown ? '' : ' (not copied)'}${copiedLayout === atRest ? '' : ` (${atRest} became ${copiedLayout})`}`);
  await banner.close();
  await signTab.close();
  await setGithubLabel('alice@example.com');
  await popup.bringToFront();

  // Auto-fill: single field
  const login = await browser.newPage();
  await login.setViewport({ width: 900, height: 600 });
  await login.goto(`http://localhost:${port}/single`);
  await login.waitForFunction(() => document.getElementById('c').value.length === 6, { timeout: 8000 }).catch(() => {});
  const filled = await login.$eval('#c', (e) => e.value);
  check((await codesAround(ghSecret)).includes(filled), `auto-fills the code on a linked site (${filled || 'empty'})`);
  await sleep(250);
  await login.screenshot({ path: join(shots, '5-autofill.png') });
  check((await login.title()) !== 'submitted', 'does not submit unless that setting is on');

  // Auto-fill: split boxes that appear late
  await login.goto(`http://localhost:${port}/split`);
  await login
    .waitForFunction(() => [...document.querySelectorAll('input')].map((i) => i.value).join('').length === 6, { timeout: 8000 })
    .catch(() => {});
  const split = await login.$$eval('input', (els) => els.map((e) => e.value).join(''));
  const seen = await login.$$eval('input', (els) => els.map((e) => e.dataset.seen || '').join(''));
  check((await codesAround(ghSecret)).includes(split) && seen === split, `fills six separate boxes that appear late (${split || 'empty'})`);
  await login.screenshot({ path: join(shots, '6-split.png') });

  // Phishing protection: same page on an unlinked host
  await login.goto(`http://127.0.0.1:${port}/single`);
  await sleep(2000);
  check((await login.$eval('#c', (e) => e.value)) === '', 'never fills on a site that is not linked');

  // Two accounts on the same site: the username decides
  const opsSecret = 'JBSWY3DPEHPK3PXQ';
  await popup.evaluate(async () => {
    const { openVault } = await import('./lib/codes.js');
    const vault = openVault();
    const stripe = (await vault.listAccounts()).find((a) => a.issuer === 'Stripe');
    await vault.updateAccount(stripe.id, { sites: ['localhost'] });
  });
  const signInAs = async (email, { expectFill = true } = {}) => {
    const tab = await browser.newPage();
    await tab.goto(`http://localhost:${port}/signin`);
    await tab.type('input[name=email]', email);
    await Promise.all([tab.waitForNavigation(), tab.keyboard.press('Enter')]);
    if (expectFill) await tab.waitForFunction(() => document.getElementById('c').value.length === 6, { timeout: 5000 }).catch(() => {});
    else await sleep(1500);
    const value = await tab.$eval('#c', (e) => e.value);
    return { tab, value };
  };
  let r = await signInAs('ops@example.com');
  check((await codesAround(opsSecret)).includes(r.value), `two accounts on one site: signing in as ops@ fills ops's code (${r.value || 'empty'})`);
  await r.tab.close();
  r = await signInAs('Alice@Example.com');
  check((await codesAround(ghSecret)).includes(r.value), `two accounts on one site: signing in as alice@ fills alice's code (${r.value || 'empty'})`);
  await r.tab.close();
  r = await signInAs('nobody@example.com', { expectFill: false });
  await r.tab.screenshot({ path: join(shots, '6b-choose-notice.png') });
  check(r.value === '', 'two accounts on one site: an unknown username fills nothing');
  await r.tab.close();
  const direct = await browser.newPage();
  await direct.goto(`http://localhost:${port}/single`);
  await sleep(1500);
  check((await direct.$eval('#c', (e) => e.value)) === '', 'two accounts on one site: no username at all fills nothing');
  await direct.goto(`http://localhost:${port}/single-who`);
  await direct.waitForFunction(() => document.getElementById('c').value.length === 6, { timeout: 5000 }).catch(() => {});
  const who = await direct.$eval('#c', (e) => e.value);
  check((await codesAround(opsSecret)).includes(who), `two accounts on one site: "Signed in as ops@" on the page picks ops (${who || 'empty'})`);
  await direct.close();
  await popup.evaluate(async () => {
    const { openVault } = await import('./lib/codes.js');
    const vault = openVault();
    const stripe = (await vault.listAccounts()).find((a) => a.issuer === 'Stripe');
    await vault.updateAccount(stripe.id, { sites: [] });
  });

  // Clicking around a page must not throw: some elements (list items, progress bars) have a
  // number as their value, not text
  const dash = await browser.newPage();
  const dashCdp = await dash.createCDPSession();
  const dashErrors = [];
  dashCdp.on('Runtime.exceptionThrown', (e) => dashErrors.push(e.exceptionDetails.exception?.description?.split('\n')[0] || e.exceptionDetails.text));
  await dashCdp.send('Runtime.enable');
  await dash.goto(`http://localhost:${port}/menu`);
  await sleep(500);
  for (const sel of ['#m', '#i', '#p', '#i']) await dash.focus(sel);
  await sleep(500);
  check(dashErrors.length === 0, `clicking around a page causes no errors${dashErrors.length ? ': ' + dashErrors.join(' | ') : ''}`);
  await dash.close();

  // Locked vault fills nothing
  await popup.bringToFront();
  await popup.click('#btn-lock');
  await popup.waitForSelector('[data-view="unlock"]:not([hidden])');
  await popup.screenshot({ path: join(shots, '7-locked.png') });
  await popup.type('#unlock-pw', 'peek');
  await popup.click('#unlock-show');
  const shownType = await popup.$eval('#unlock-pw', (e) => e.type);
  await popup.click('#unlock-show');
  const hiddenType = await popup.$eval('#unlock-pw', (e) => e.type);
  check(shownType === 'text' && hiddenType === 'password', `the eye button shows and hides the password (${shownType}, then ${hiddenType})`);
  await popup.$eval('#unlock-pw', (e) => (e.value = ''));

  // Viewing a share link needs no password: pasted on the unlock screen, it opens the shared view
  const freshLink = shareUrl(await encodeShare(await codesForWindow({ issuer: 'GitHub', label: 'alice@example.com', secret: ghSecret, digits: 6, period: 30, algorithm: 'SHA1' }, Date.now(), 5)));
  await pasteOnPopup(freshLink);
  await popup.waitForSelector(sharedView, { timeout: 5000 }).catch(() => {});
  await popup.waitForFunction(() => /\d/.test(document.querySelector('#shared-code').textContent), { timeout: 5000 }).catch(() => {});
  const lockedShared = await popup.evaluate(() => ({ add: document.querySelector('#btn-add').hidden, lock: document.querySelector('#btn-lock').hidden }));
  check((await codesAround(ghSecret)).includes(await sharedCode()) && lockedShared.add && lockedShared.lock, 'a share link pasted while locked shows its codes, and nothing else unlocks');
  await popup.keyboard.press('Escape');
  check(await popup.waitForSelector('[data-view="unlock"]:not([hidden])', { timeout: 3000 }).then(() => true, () => false), 'Esc from the shared view goes back to the unlock screen');
  await login.goto(`http://localhost:${port}/single`);
  await sleep(2000);
  check((await login.$eval('#c', (e) => e.value)) === '', 'a locked vault fills nothing');

  // Wrong then right password
  await popup.type('#unlock-pw', 'nope');
  await popup.click('#form-unlock button[type=submit]');
  await popup.waitForFunction(() => document.querySelector('#unlock-msg').textContent.startsWith('Wrong'), { timeout: 10000 });
  await popup.$eval('#unlock-pw', (e) => (e.value = ''));
  await popup.type('#unlock-pw', 'correct horse 42');
  await popup.click('#form-unlock button[type=submit]');
  await popup.waitForSelector('[data-view="list"]:not([hidden])', { timeout: 10000 });
  check(true, 'wrong password is refused, right password unlocks');

  // Settings page. Everything must work while AuthPeek is LOCKED: each action asks for the
  // password in a modal (which also unlocks), instead of being switched off.
  // Throwaway password for this run's temporary vault (deleted with the test profile). Not a secret.
  const PW = 'correct horse 42';
  const dlDir = join(tmp, 'downloads');
  mkdirSync(dlDir, { recursive: true });
  const browserCdp = await browser.target().createCDPSession();
  await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  const waitForDownload = async (prefix) => {
    for (let i = 0; i < 40; i++) {
      const hit = readdirSync(dlDir).find((f) => f.startsWith(prefix) && !f.endsWith('.crdownload'));
      if (hit) return join(dlDir, hit);
      await sleep(250);
    }
    return null;
  };
  const clearToast = () => options.evaluate(() => {
    const t = document.querySelector('#toast');
    t.classList.remove('show');
    t.textContent = '';
  });
  const toastText = async (page) => {
    await page.waitForFunction(() => {
      const t = document.querySelector('#toast');
      return t.classList.contains('show') && t.textContent;
    }, { timeout: 20000 }).catch(() => {});
    return page.$eval('#toast', (e) => e.textContent);
  };
  const modalClosed = () => options.waitForFunction(() => !document.querySelector('#modal').open, { timeout: 20000 }).catch(() => {});
  const lockNow = () => popup.evaluate(async () => {
    const { openVault } = await import('./lib/codes.js');
    await openVault().lock();
  });

  await lockNow();
  const options = await browser.newPage();
  await options.bringToFront();
  await options.setViewport({ width: 1100, height: 900 });
  await options.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await options.goto(`chrome-extension://${extId}/options.html`);
  // Smooth scrolling would move buttons while puppeteer is clicking them.
  await options.evaluate(() => (document.documentElement.style.scrollBehavior = 'auto'));
  await sleep(500);
  const lockedState = await options.$eval('#lockstate-text', (e) => e.textContent);
  const anyDisabled = await options.evaluate(() => [...document.querySelectorAll('main button')].some((b) => b.disabled));
  check(lockedState === 'Locked' && !anyDisabled, `settings buttons stay usable while locked (${lockedState})`);
  await options.screenshot({ path: join(shots, '8-options.png'), fullPage: true });

  const passwordModal = async (buttonSel, password = PW) => {
    await clearToast();
    await options.click(buttonSel);
    await options.waitForSelector('#modal[open] .m-pw');
    await options.type('#modal .m-pw', password);
    await options.keyboard.press('Enter');
  };
  const modalTitle = () => options.$eval('#modal', (d) => (d.open ? d.querySelector('#modal-title').textContent : ''));

  // A wrong password keeps the modal open with a message; Esc closes it
  await passwordModal('#btn-download', 'not my password');
  await options.waitForFunction(() => document.querySelector('#modal .m-error')?.textContent.length > 0, { timeout: 10000 }).catch(() => {});
  const wrongMsg = await options.$eval('#modal .m-error', (e) => e.textContent);
  await options.screenshot({ path: join(shots, '8b-password-modal.png') });
  await options.keyboard.press('Escape');
  await sleep(200);
  check(/isn’t your AuthPeek password/.test(wrongMsg) && !(await modalTitle()), 'a wrong password says so and Esc closes the modal');

  // Download backup
  await passwordModal('#btn-download');
  const backupFile = await waitForDownload('authpeek-backup-');
  const backupJson = backupFile ? readFileSync(backupFile, 'utf8') : '';
  check(backupJson.includes('"authpeek-backup"') && !backupJson.includes(ghSecret), 'Download saves an encrypted backup file, even when locked');
  check(/downloaded/i.test(await toastText(options)), 'a notice confirms the download');

  // Backup as text: shown in a modal, copied on the user's click
  await lockNow();
  await passwordModal('#btn-copy');
  await options.waitForFunction(() => document.querySelector('#modal-title')?.textContent === 'Backup as text' && document.querySelector('#modal .m-text')?.value, { timeout: 15000 }).catch(() => {});
  const shownBackup = await options.$eval('#modal .m-text', (e) => e.value);
  await browserCdp.send('Browser.grantPermissions', { origin: `chrome-extension://${extId}`, permissions: ['clipboardReadWrite'] });
  await options.click('#modal-actions .btn.primary');
  await sleep(300);
  const clip = (await options.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  await options.screenshot({ path: join(shots, '8c-backup-text.png') });
  check(shownBackup.includes('"authpeek-backup"') && clip === shownBackup, 'Backup as text shows the backup and Copy puts it on the clipboard');
  check(await options.$eval('#toast', (t) => t.parentNode === document.querySelector('#modal')), 'a notice raised in a modal shows above the backdrop, inside the modal');
  await options.click('#modal-actions .btn:not(.primary)'); // Done
  await modalClosed();
  await sleep(100);
  check(!(await modalTitle()) && (await options.$eval('#modal .m-text', (e) => e.value)) === '', 'closing the backup text clears it from the page');

  // Export as links
  await lockNow();
  await passwordModal('#btn-export-links');
  await options.waitForFunction(() => document.querySelector('#modal-title')?.textContent === 'Export as links' && document.querySelector('#modal .m-text')?.value, { timeout: 15000 }).catch(() => {});
  const exported = await options.$eval('#modal .m-text', (e) => e.value);
  const exportedCount = exported.split('\n').filter((l) => l.startsWith('otpauth://totp/')).length;
  const accountCount = await options.evaluate(async () => {
    const { openVault } = await import('./lib/codes.js');
    return (await openVault().listAccounts()).length;
  });
  check(exportedCount === accountCount && exported.includes('encoder=steam') && exported.includes('algorithm=SHA512'),
    `export lists every account as a link (${exportedCount} of ${accountCount})`);
  await options.evaluate(() => [...document.querySelectorAll('#modal-actions .btn')].find((b) => b.textContent === 'Download .txt').click());
  const linksFile = await waitForDownload('authpeek-links-');
  check(Boolean(linksFile) && readFileSync(linksFile, 'utf8').trim() === exported, 'export links can be downloaded as a .txt file');
  await options.click('#modal-actions .btn'); // Done
  await modalClosed();
  check(!(await modalTitle()), 'export closes with Done');

  // Restore from the downloaded file, while locked: everything is already there, so all skipped
  await lockNow();
  await options.click('#btn-restore');
  await options.waitForSelector('#modal[open] .m-file');
  check(await options.$eval('#modal .m-file', (f) => (f.focus(), document.activeElement === f)), 'the restore file chooser can be reached with the keyboard');
  await (await options.$('#modal .m-file')).uploadFile(backupFile);
  await options.waitForFunction(() => document.querySelector('#modal .m-drop').classList.contains('chosen'));
  await options.type('#modal .m-pw', PW);
  await options.screenshot({ path: join(shots, '8d-restore.png') });
  await clearToast();
  await options.keyboard.press('Enter');
  const restoreToast = await toastText(options);
  await modalClosed();
  check(/Restored 0 accounts\. \d+ accounts you already had were skipped/.test(restoreToast), `restore from a file works while locked (${restoreToast})`);

  // Restore from pasted text with the wrong password: clear message, modal stays
  await options.click('#btn-restore');
  await options.waitForSelector('#modal[open] .m-switch');
  await options.click('#modal .m-switch');
  await options.$eval('#modal .m-text', (e, v) => (e.value = v), backupJson);
  await options.type('#modal .m-pw', 'wrong one');
  await options.keyboard.press('Enter');
  await options.waitForFunction(() => document.querySelector('#modal .m-error')?.textContent.length > 0, { timeout: 15000 }).catch(() => {});
  check(/doesn’t open this backup/.test(await options.$eval('#modal .m-error', (e) => e.textContent)), 'restoring pasted text with the wrong password explains why');
  await options.keyboard.press('Escape');
  await modalClosed();

  // A short new password gets AuthPeek's own message, not the browser's grey bubble
  await options.$eval('#btn-change-pw', (e) => e.scrollIntoView({ block: 'center' }));
  await options.click('#btn-change-pw');
  await options.waitForSelector('#modal[open] .m-old');
  await options.type('#modal .m-old', PW);
  await options.type('#modal .m-new', 'short');
  await options.keyboard.press('Enter');
  await options.waitForFunction(() => document.querySelector('#modal .m-error')?.textContent, { timeout: 3000 }).catch(() => {});
  const shortMsg = await options.$eval('#modal .m-error', (e) => e.textContent);
  check(shortMsg === 'Use at least 8 characters.', `a short new password is explained in the modal (${shortMsg})`);
  await options.keyboard.press('Escape');
  await options.waitForFunction(() => !document.querySelector('#modal').open, { timeout: 5000 }).catch(() => {});

  // Change password, then back
  for (const [from, to] of [[PW, 'brand new password 7'], ['brand new password 7', PW]]) {
    await clearToast();
    // The button can sit just under the sticky top bar, where a click lands on the bar instead.
    await options.$eval('#btn-change-pw', (e) => e.scrollIntoView({ block: 'center' }));
    await options.click('#btn-change-pw');
    await options.waitForSelector('#modal[open] .m-old');
    await options.type('#modal .m-old', from);
    await options.type('#modal .m-new', to);
    await options.type('#modal .m-new2', to);
    await options.keyboard.press('Enter');
    await options.waitForFunction(() => !document.querySelector('#modal').open, { timeout: 20000 }).catch(() => {});
  }
  check(/Password changed/.test(await toastText(options)), 'changing the password works from its modal');

  // Encrypted data in sync storage contains no plain secrets
  const raw = await popup.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null)));
  check(!raw.includes(ghSecret) && raw.includes('acct:'), 'sync storage holds only encrypted accounts');

  // Theme: the choice in settings reaches the popup's <html> (System leaves it to the computer)
  const popupTheme = async () => {
    await popup.reload();
    await popup.waitForSelector('[data-view]:not([hidden])');
    return popup.evaluate(() => document.documentElement.dataset.theme || 'system');
  };
  const themes = [];
  for (const theme of ['dark', 'light', 'system']) {
    await options.bringToFront();
    await options.click(`#set-theme-${theme}`);
    await options.waitForFunction((t) => (document.documentElement.dataset.theme || 'system') === t, { timeout: 5000 }, theme).catch(() => {});
    await sleep(300);
    if (theme === 'dark') await options.screenshot({ path: join(shots, '8e-options-dark.png') });
    await popup.bringToFront();
    themes.push(await popupTheme());
    if (theme === 'dark') await popup.screenshot({ path: join(shots, '4b-list-dark-setting.png') });
  }
  check(themes.join() === 'dark,light,system', `the theme setting reaches the popup (${themes.join(', ')})`);

  check(errors.length === 0, `no errors in the popup${errors.length ? ': ' + errors.join(' | ') : ''}`);

  // Custom lock time
  await options.bringToFront();
  await options.select('#set-lock', 'custom');
  await options.$eval('#set-lock-custom', (e) => (e.value = ''));
  await options.type('#set-lock-custom', '45');
  await options.$eval('#set-lock-custom', (e) => e.dispatchEvent(new Event('change')));
  await sleep(300);
  const custom = await options.evaluate(async () => (await chrome.storage.sync.get('settings')).settings.lockMinutes);
  check(custom === 45, `a custom lock time is saved (${custom} minutes)`);

  // "Never": no password, even after Chrome restarts
  await options.select('#set-lock', '-1');
  await options.waitForFunction(() => document.querySelector('#lock-hint').classList.contains('warn'));
  await sleep(300);
  await (await options.$('#security')).screenshot({ path: join(shots, '9-options-never.png') });
  await browser.close();

  browser = await launch();
  await waitForWorker(browser);
  check(!(await welcomeOpens(browser, 3000)), 'a Chrome restart does not open the welcome page again');
  const fresh = await browser.newPage();
  await fresh.goto(`http://localhost:${port}/single`);
  await fresh.waitForFunction(() => document.getElementById('c').value.length === 6, { timeout: 8000 }).catch(() => {});
  const afterRestart = await fresh.$eval('#c', (e) => e.value);
  check((await codesAround(ghSecret)).includes(afterRestart), `with "Never", a code fills right after Chrome restarts (${afterRestart || 'empty'})`);
  const popup2 = await browser.newPage();
  await popup2.goto(`chrome-extension://${extId}/popup.html`);
  check(
    await popup2.waitForSelector('[data-view="list"]:not([hidden])', { timeout: 8000 }).then(() => true, () => false),
    'with "Never", the popup opens straight to the codes'
  );

  // An AuthPeek update wipes Chrome's memory-only storage (where the unlock key normally
  // lives) and keeps local + sync storage. "Never" must survive that. (chrome.runtime.reload()
  // can't be used here: in this test browser it switches the extension off for good.)
  await popup2.evaluate(() => chrome.storage.session.clear());
  const afterUpdate = await browser.newPage();
  await afterUpdate.goto(`http://localhost:${port}/single`);
  await afterUpdate.waitForFunction(() => document.getElementById('c').value.length === 6, { timeout: 8000 }).catch(() => {});
  const updatedFill = await afterUpdate.$eval('#c', (e) => e.value);
  check((await codesAround(ghSecret)).includes(updatedFill), `with "Never", codes still fill after an AuthPeek update (${updatedFill || 'empty'})`);

  // Back to asking: the next restart wants the password again
  await popup2.evaluate(async () => {
    const { openVault } = await import('./lib/codes.js');
    await openVault().saveSettings({ lockMinutes: 15 });
  });
  await browser.close();
  browser = await launch();
  await waitForWorker(browser);
  check(!(await welcomeOpens(browser, 3000)), 'a second restart does not open the welcome page either');
  const popup3 = await browser.newPage();
  await popup3.goto(`chrome-extension://${extId}/popup.html`);
  check(
    await popup3.waitForSelector('[data-view="unlock"]:not([hidden])', { timeout: 8000 }).then(() => true, () => false),
    'switching back to a lock time asks for the password after a restart'
  );
  await popup3.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await popup3.setViewport({ width: 360, height: 420 });
  await popup3.screenshot({ path: join(shots, '10-unlock.png') });

  // Reloading AuthPeek must not leave errors in tabs that were already open
  const open = await browser.newPage();
  const cdp = await open.createCDPSession();
  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (e) => pageErrors.push(e.exceptionDetails.exception?.description?.split('\n')[0] || e.exceptionDetails.text));
  await cdp.send('Runtime.enable');
  await open.goto(`http://localhost:${port}/signin`);
  await sleep(800);
  const sw = await (await waitForWorker(browser)).worker();
  await sw.evaluate('chrome.runtime.reload()').catch(() => {});
  await sleep(1500);
  await open.type('input[name=email]', 'bob@example.com');
  await open.keyboard.press('Tab');
  await open.evaluate(() => document.body.append(document.createElement('div')));
  await sleep(1000);
  check(pageErrors.length === 0, `reloading AuthPeek leaves no errors in open tabs${pageErrors.length ? ': ' + pageErrors.join(' | ') : ''}`);
  check(!browser.targets().some(isWelcome), 'reloading AuthPeek does not open the welcome page');
} catch (err) {
  failures++;
  console.error('FAIL ', err.message);
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
console.log(`Screenshots: ${shots}`);
process.exit(failures ? 1 : 0);
