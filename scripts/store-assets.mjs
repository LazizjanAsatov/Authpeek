// Builds the Chrome Web Store images by running the real extension with demo accounts
// against a sample sign-in page (fictional "Northwind"), then framing the captures.
//   node scripts/store-assets.mjs   → docs/store/*.png
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = resolve('docs/store');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'store demo password';

// ---------- sample sign-in pages ----------
const card = (inner) => `<!doctype html><html><head><title>Northwind</title><style>
  * { box-sizing: border-box; margin: 0; }
  body { min-height: 100vh; display: grid; place-items: center; background: #EEF1F5;
         font: 15px/1.5 "Segoe UI", system-ui, sans-serif; color: #18202C; }
  .card { width: 400px; padding: 36px 36px 32px; background: #fff; border-radius: 16px;
          box-shadow: 0 10px 40px rgb(24 32 44 / .10); }
  .logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; margin-bottom: 26px; }
  .logo i { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #3D5AFE, #00B0FF); }
  h1 { font-size: 22px; margin-bottom: 6px; }
  p { color: #5A6576; margin-bottom: 22px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; height: 46px; padding: 0 14px; border: 1px solid #CBD3DF; border-radius: 10px;
          font: 20px "Segoe UI", system-ui; letter-spacing: .12em; }
  .boxes { display: flex; gap: 10px; }
  .boxes input { width: 48px; height: 56px; text-align: center; padding: 0; font-size: 24px; letter-spacing: 0; }
  button { width: 100%; height: 46px; margin-top: 18px; border: 0; border-radius: 10px;
           background: #3D5AFE; color: #fff; font: 600 15px "Segoe UI", system-ui; }
  .who { font-weight: 600; color: #18202C; }
</style></head><body><form class="card" onsubmit="event.preventDefault()">
  <div class="logo"><i></i>Northwind</div>${inner}</form></body></html>`;

const pages = {
  '/code': card(`<h1>Two-step verification</h1>
    <p>Enter the 6-digit code from your authenticator app.</p>
    <label for="c">Verification code</label><input id="c" name="otp" autocomplete="one-time-code" inputmode="numeric">
    <button>Verify</button>`),
  '/code-who': card(`<h1>Two-step verification</h1>
    <p>Signed in as <span class="who">ops@northwind.example</span>. Enter the code from your app.</p>
    <div class="boxes">${[1, 2, 3, 4, 5, 6].map(() => '<input maxlength="1" inputmode="numeric">').join('')}</div>
    <button>Verify</button>`),
};
const server = http.createServer((req, res) => {
  const body = pages[new URL(req.url, 'http://x').pathname];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
  res.end(body || '');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---------- demo accounts ----------
const demo = [
  ['Northwind', 'alex@northwind.example', 'JBSWY3DPEHPK3PXP', ['localhost'], true],
  ['Northwind', 'ops@northwind.example', 'KRSXG5CTMVRXEZLU', ['localhost'], false],
  ['GitHub', 'alex-dev', 'GEZDGNBVGY3TQOJQ', [], false],
  ['Google', 'alex@gmail.com', 'MFRGGZDFMZTWQ2LK', [], false],
  ['Amazon Web Services', 'root', 'ONSWG4TFORZWK3TP', [], false],
  ['Stripe', 'billing@northwind.example', 'MZXW6YTBOI2DAMRT', [], false],
  ['Slack', 'alex', 'NBSWY3DPO5XXE3DE', [], false],
].map(([issuer, label, secret, sites, pinned]) => ({ issuer, label, secret, sites, pinned, digits: 6, period: 30, algorithm: 'SHA1' }));

const tmp = mkdtempSync(join(tmpdir(), 'authpeek-store-'));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, pipe: true,
  enableExtensions: [resolve('extension')], userDataDir: join(tmp, 'profile'),
  args: ['--no-first-run', '--no-default-browser-check'],
});
const captures = {};
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(sw.url()).host;

  const popup = await browser.newPage();
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await popup.setViewport({ width: 360, height: 560, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.evaluate(async (pw, accounts) => {
    const { openVault } = await import('./lib/codes.js');
    const vault = openVault();
    await vault.setup(pw);
    const { added } = await vault.addAccounts(accounts.map(({ pinned, ...a }) => a));
    for (const a of await vault.listAccounts()) {
      const src = accounts.find((x) => x.secret === a.secret);
      if (src.pinned) await vault.updateAccount(a.id, { pinned: true });
    }
    await chrome.storage.local.set({ clock: { offset: 0, checkedAt: Date.now() } });
    return added;
  }, PASSWORD, demo);
  await popup.reload();
  await popup.waitForSelector('[data-view="list"]:not([hidden])');
  await sleep(600);
  captures.list = await popup.screenshot({ encoding: 'base64' });

  await popup.click('#btn-add');
  await popup.click('[data-tab="link"]');
  await popup.$eval('#links', (el) => (el.value = 'otpauth://totp/Northwind:alex@northwind.example?secret=JBSWY3DPEHPK3PXP&issuer=Northwind'));
  captures.add = await popup.screenshot({ encoding: 'base64' });

  // Auto-fill: both Northwind accounts are linked, and the page says who is signing in
  const site = await browser.newPage();
  await site.setViewport({ width: 900, height: 600, deviceScaleFactor: 2 });
  await site.goto(`http://localhost:${port}/code-who`);
  await site.waitForFunction(() => [...document.querySelectorAll('input')].every((i) => i.value), { timeout: 8000 });
  await sleep(350);
  captures.autofill = await site.screenshot({ encoding: 'base64' });

  // Several accounts and no username: AuthPeek asks
  await site.goto(`http://localhost:${port}/code`);
  await sleep(1300);
  captures.choose = await site.screenshot({ encoding: 'base64' });

  const options = await browser.newPage();
  await options.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await options.setViewport({ width: 760, height: 760, deviceScaleFactor: 2 });
  await options.goto(`chrome-extension://${extId}/options.html`);
  await sleep(500);
  await options.evaluate(() => document.querySelectorAll('.block')[1].scrollIntoView());
  captures.settings = await options.screenshot({ encoding: 'base64' });
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ---------- frame the captures ----------
const icon = `data:image/png;base64,${readFileSync('extension/icons/icon128.png').toString('base64')}`;
const frame = `
  * { box-sizing: border-box; margin: 0; }
  body { width: 1280px; height: 800px; overflow: hidden; display: grid;
         grid-template-columns: 450px 1fr; align-items: center; gap: 60px; padding: 0 80px;
         background: #F1F4F6; color: #1A2130;
         font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; }
  .brand { display: flex; gap: 12px; align-items: center; font-size: 22px; font-weight: 650; margin-bottom: 36px; }
  .brand img { width: 40px; height: 40px; }
  h1 { font-size: 48px; line-height: 1.08; font-weight: 700; letter-spacing: -0.02em; }
  p { margin-top: 22px; font-size: 21px; line-height: 1.45; color: #4C5668; max-width: 30ch; }
  .bar { width: 120px; height: 5px; border-radius: 3px; background: #0E7C6B; margin-top: 34px; }
  .shot { justify-self: center; border-radius: 14px; overflow: hidden; background: #fff;
          box-shadow: 0 24px 60px rgb(26 33 48 / .18), 0 2px 6px rgb(26 33 48 / .08); }
  .shot img { display: block; }
`;
const slides = [
  ['1-codes', 'Your 2-step codes, right in Chrome',
    'The same codes as Google Authenticator, one click from any tab. Pin the ones you use most.', 'list', 360],
  ['2-autofill', 'Codes fill in by themselves',
    'On sites you’ve linked, the code goes in the moment the page asks: one box or six.', 'autofill', 630],
  ['3-accounts', 'Two accounts on one site? It picks the right one',
    'AuthPeek matches the username you signed in with. When it can’t tell, it asks instead of guessing.', 'choose', 630],
  ['4-add', 'Add accounts any way you have them',
    'Scan a QR code on the page, paste otpauth:// links, upload a screenshot or type the key. Google Authenticator exports come over in one scan.', 'add', 360],
  ['5-safe', 'Encrypted, synced and backed up',
    'Encrypted with your password before it syncs to your Google account. No servers, no tracking.', 'settings', 600],
];

const composer = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await composer.newPage();
for (const [name, title, text, key, width] of slides) {
  await page.setViewport({ width: 1280, height: 800 });
  await page.setContent(`<!doctype html><html><head><style>${frame}</style></head><body>
    <div><div class="brand"><img src="${icon}" alt="">AuthPeek</div><h1>${title}</h1><p>${text}</p><div class="bar"></div></div>
    <div class="shot"><img src="data:image/png;base64,${captures[key]}" width="${width}" alt=""></div>
  </body></html>`);
  await page.screenshot({ path: join(out, `screenshot-${name}.png`) });
}

await page.setViewport({ width: 440, height: 280 });
await page.setContent(`<!doctype html><html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 440px; height: 280px; padding: 34px 36px; background: #0E7C6B; color: #fff; overflow: hidden;
         font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
         display: flex; flex-direction: column; justify-content: space-between; }
  .top { display: flex; align-items: center; gap: 14px; }
  .top img { width: 56px; height: 56px; border-radius: 14px; box-shadow: 0 0 0 2px rgb(255 255 255 / .35); }
  .name { font-size: 34px; font-weight: 700; letter-spacing: -0.02em; }
  .line { font-size: 21px; line-height: 1.3; font-weight: 600; max-width: 22ch; }
  .code { font-size: 17px; opacity: .8; font-variant-numeric: tabular-nums; letter-spacing: .08em; }
</style></head><body>
  <div class="top"><img src="${icon}" alt=""><div class="name">AuthPeek</div></div>
  <div class="line">2-step codes in Chrome that fill themselves in.</div>
  <div class="code">482 913</div>
</body></html>`);
await page.screenshot({ path: join(out, 'promo-small-440x280.png') });
await composer.close();
console.log(`Store images written to ${out}`);
