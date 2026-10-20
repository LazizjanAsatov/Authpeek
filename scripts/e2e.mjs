// End-to-end check in real Chrome: loads the unpacked extension into a throwaway
// profile, drives the popup, and verifies auto-fill on local test pages.
//   node scripts/e2e.mjs [screenshotDir]
import puppeteer from 'puppeteer-core';
import QRCode from 'qrcode';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeBase32 } from '../extension/lib/base32.js';
import { createRequire } from 'node:module';
import { generateTotp } from '../extension/lib/totp.js';

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
const server = http.createServer((req, res) => {
  const body = pages[new URL(req.url, 'http://x').pathname];
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
let browser = await launch();

try {
  const worker = await waitForWorker(browser);
  const extId = new URL(worker.url()).host;
  check(Boolean(extId), 'extension loads and its service worker starts');

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
  await popup.type('#setup-pw', 'correct horse 42');
  await popup.type('#setup-pw2', 'correct horse 42');
  await popup.click('#form-setup button[type=submit]');
  await popup.waitForSelector('[data-view="list"]:not([hidden])', { timeout: 20000 });
  check(await popup.$eval('#empty', (e) => !e.hidden), 'after setup the empty list is shown');
  await popup.screenshot({ path: join(shots, '2-empty.png') });

  // Upload a QR image
  await popup.click('#btn-add');
  await popup.click('[data-tab="upload"]');
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
    row.querySelector('.row-actions .icon-btn').click();
  });
  await popup.waitForSelector('[data-view="edit"]:not([hidden])');
  await popup.click('#edit-pinned');
  await popup.click('#form-edit button[type=submit]');
  await popup.waitForSelector('[data-view="list"]:not([hidden])');
  const firstRow = await popup.evaluate(() => {
    const row = document.querySelector('.row');
    return { name: row.querySelector('.issuer').textContent, pinMark: Boolean(row.querySelector('.pin')) };
  });
  check(firstRow.name === 'Stripe' && firstRow.pinMark, `a pinned account moves to the top (${firstRow.name})`);

  // Clock 47 s slow: the popup warns and codes are corrected
  await popup.evaluate(() => chrome.storage.local.set({ clock: { offset: 47_000, checkedAt: Date.now() } }));
  await popup.reload();
  await popup.waitForSelector('[data-view="list"]:not([hidden])');
  await popup.waitForSelector('#clock-warn:not([hidden])', { timeout: 5000 }).catch(() => {});
  const warnText = await popup.$eval('#clock-warn', (e) => (e.hidden ? '' : e.textContent));
  check(/47 seconds slow/.test(warnText), `a wrong clock is reported (${warnText.slice(0, 50) || 'no warning'})`);
  await popup.screenshot({ path: join(shots, '3c-clock.png') });
  const correctedShown = await popup.evaluate(() => {
    const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.issuer').textContent === 'GitHub');
    return row.querySelector('.code').textContent.replace(/\D/g, '');
  });
  const corrected = await Promise.all([17_000, 47_000, 77_000].map((d) =>
    generateTotp({ secret: decodeBase32(ghSecret), timestamp: Date.now() + d })));
  check(corrected.includes(correctedShown), `codes are corrected for the clock (${correctedShown})`);
  await popup.evaluate(() => chrome.storage.local.set({ clock: { offset: 0, checkedAt: Date.now() } }));
  await popup.reload();
  await popup.waitForSelector('[data-view="list"]:not([hidden])');

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
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

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

  // Locked vault fills nothing
  await popup.bringToFront();
  await popup.click('#btn-lock');
  await popup.waitForSelector('[data-view="unlock"]:not([hidden])');
  await popup.screenshot({ path: join(shots, '7-locked.png') });
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

  // Settings page
  const options = await browser.newPage();
  await options.bringToFront();
  await options.setViewport({ width: 900, height: 1300 });
  await options.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForFunction(() => !document.querySelector('#btn-download').disabled, { timeout: 5000 }).catch(() => {});
  check(!(await options.$eval('#btn-download', (e) => e.disabled)), 'backup is available while unlocked');
  await options.screenshot({ path: join(shots, '8-options.png'), fullPage: true });

  // Export as links, behind the password
  await options.click('#btn-export-links');
  await options.waitForSelector('#pw-dialog[open]');
  await options.type('#confirm-pw', 'correct horse 42');
  await options.click('#confirm-ok');
  await options.waitForSelector('#export-panel:not([hidden])', { timeout: 15000 }).catch(() => {});
  const exported = await options.$eval('#export-text', (e) => e.value);
  const exportedCount = exported.split('\n').filter((l) => l.startsWith('otpauth://totp/')).length;
  const accountCount = await options.evaluate(async () => {
    const { openVault } = await import('./lib/codes.js');
    return (await openVault().listAccounts()).length;
  });
  check(exportedCount === accountCount && exported.includes('encoder=steam') && exported.includes('algorithm=SHA512'),
    `export lists every account as a link (${exportedCount} of ${accountCount})`);
  await options.click('#btn-export-hide');
  check((await options.$eval('#export-text', (e) => e.value)) === '', 'hiding the export clears it');

  // Encrypted data in sync storage contains no plain secrets
  const raw = await popup.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null)));
  check(!raw.includes(ghSecret) && raw.includes('acct:'), 'sync storage holds only encrypted accounts');

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
  await options.screenshot({ path: join(shots, '9-options-never.png'), clip: { x: 0, y: 120, width: 900, height: 420 } });
  await browser.close();

  browser = await launch();
  await waitForWorker(browser);
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
