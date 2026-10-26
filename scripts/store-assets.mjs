// Builds the Chrome Web Store images and the README/site screenshots by running the real
// extension with demo accounts against a sample sign-in page (fictional "Northwind"), then
// framing the captures.
//   node scripts/store-assets.mjs   → docs/store/*.png, docs/screenshots/*.png
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { inflateSync, deflateSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = resolve('docs/store');
const docShots = resolve('docs/screenshots');
mkdirSync(out, { recursive: true });
mkdirSync(docShots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Throwaway password for the demo vault used only while taking screenshots. Not a secret.
const PASSWORD = 'store demo password';
// The sample site gets a real-looking name: Chrome resolves it to the local server below.
const SITE = 'northwind.example';

// ---------- sample sign-in pages ----------
const card = (inner, layout = 'center') => `<!doctype html><html><head><title>Northwind</title><style>
  * { box-sizing: border-box; margin: 0; }
  body { min-height: 100vh; display: grid; place-items: center; background: #EEF1F5;
         font: 15px/1.5 "Segoe UI", system-ui, sans-serif; color: #18202C; }
  body.left { place-items: center start; padding-left: 72px; }
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
</style></head><body class="${layout}"><form class="card" onsubmit="event.preventDefault()">
  <div class="logo"><i></i>Northwind</div>${inner}</form></body></html>`;

const pages = {
  '/verify': card(`<h1>Two-step verification</h1>
    <p>Enter the 6-digit code from your authenticator app.</p>
    <label for="c">Verification code</label><input id="c" name="otp" autocomplete="one-time-code" inputmode="numeric">
    <button>Verify</button>`, 'left'),
  '/signin/verify': card(`<h1>Two-step verification</h1>
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
// Northwind has no bundled logo, so it shows the monogram; the rest show their real logos.
// Its usernames are short so both fit on one line in the page banner.
const demo = [
  ['Northwind', 'alex', 'JBSWY3DPEHPK3PXP', [SITE], { pinned: true }],
  ['Northwind', 'ops', 'KRSXG5CTMVRXEZLU', [SITE]],
  ['GitHub', 'alex-dev', 'GEZDGNBVGY3TQOJQ', []],
  ['Google', 'alex@gmail.com', 'MFRGGZDFMZTWQ2LK', []],
  ['Stripe', 'billing@northwind.example', 'MZXW6YTBOI2DAMRT', []],
  ['Dropbox', 'alex@northwind.example', 'ONSWG4TFORZWK3TP', []],
  ['Steam', 'alexplays', 'NBSWY3DPO5XXE3DE', [], { encoder: 'steam', digits: 5 }],
  ['Discord', 'alex#0420', 'OBQXG43XN5ZGIZLS', []],
].map(([issuer, label, secret, sites, extra]) => ({ issuer, label, secret, sites, digits: 6, period: 30, algorithm: 'SHA1', ...extra }));

// The popup as Chrome shows it: a fixed 600 px tall.
async function popupShot(page) {
  const height = await page.evaluate(() => Math.min(600, Math.ceil(document.body.getBoundingClientRect().height)));
  return page.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: 360, height } });
}

// Capture early in a 30-second window, so codes aren't shown in "about to expire" amber.
async function freshWindow() {
  while ((Date.now() / 1000) % 30 > 3) await sleep(250);
  await sleep(600);
}

const tmp = mkdtempSync(join(tmpdir(), 'authpeek-store-'));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, pipe: true,
  enableExtensions: [resolve('extension')], userDataDir: join(tmp, 'profile'),
  args: [
    '--no-first-run', '--no-default-browser-check',
    `--host-resolver-rules=MAP ${SITE} 127.0.0.1:${port}`,
    '--disable-features=HttpsUpgrades',
  ],
});
const captures = {};
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(sw.url()).host;

  const popup = await browser.newPage();
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await popup.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.evaluate(async (pw, accounts) => {
    const { openVault } = await import('./lib/codes.js');
    const vault = openVault();
    await vault.setup(pw);
    await vault.addAccounts(accounts);
    // The share notice is shown once; the screenshot is of the link itself.
    await chrome.storage.local.set({ shareNoticeSeen: true });
  }, PASSWORD, demo);
  await popup.reload();
  // The welcome page opens on install; a tab in the background never finishes a click.
  await popup.bringToFront();
  await popup.waitForSelector('[data-view="list"]:not([hidden])');
  await popup.evaluate(() => document.fonts.ready);
  await freshWindow();
  captures.list = await popupShot(popup);

  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await sleep(400);
  captures.listDark = await popupShot(popup);
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // Share: a link for GitHub's codes over the next five minutes
  await popup.evaluate(() => [...document.querySelectorAll('.row')]
    .find((row) => row.querySelector('.issuer').textContent === 'GitHub')
    .querySelector('.share').click());
  await popup.waitForSelector('[data-view="share"]:not([hidden])');
  await popup.click('#btn-share-create');
  await popup.waitForSelector('#share-result:not([hidden])');
  await popup.evaluate(() => document.activeElement?.blur());
  await sleep(300);
  captures.share = await popupShot(popup);

  await popup.click('[data-view="share"] .back');
  await popup.click('#btn-add');
  await popup.click('[data-tab="link"]');
  await popup.$eval('#links', (el) => (el.value = 'otpauth://totp/Northwind:alex@northwind.example?secret=JBSWY3DPEHPK3PXP&issuer=Northwind'));
  await popup.evaluate(() => document.activeElement?.blur());
  captures.add = await popupShot(popup);

  // Auto-fill: both Northwind accounts are linked, and the page says who is signing in
  const site = await browser.newPage();
  await site.setViewport({ width: 900, height: 640, deviceScaleFactor: 2 });
  await site.goto(`http://${SITE}/signin/verify`);
  await site.waitForFunction(() => [...document.querySelectorAll('input')].every((i) => i.value), { timeout: 8000 });
  await sleep(350);
  captures.autofill = await site.screenshot({ encoding: 'base64' });
  await site.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  await sleep(200);
  writeOpaque(join(docShots, 'autofill.png'), await site.screenshot());

  // Several accounts and no username: AuthPeek asks. The popup is opened as a tab here, so it
  // is pointed at the sign-in tab, as if the toolbar icon had been clicked there.
  await site.setViewport({ width: 900, height: 640, deviceScaleFactor: 2 });
  await site.goto(`http://${SITE}/verify`);
  await sleep(4200); // the in-page notice has faded: the popup is what this shot is about
  captures.choose = await site.screenshot({ encoding: 'base64' });

  const picker = await browser.newPage();
  await picker.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await picker.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
  await picker.evaluateOnNewDocument((site) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q?.active
      ? (await query({})).filter((t) => t.url?.startsWith(`http://${site}/`))
      : query(q));
  }, SITE);
  await picker.goto(`chrome-extension://${extId}/popup.html`);
  await picker.waitForSelector('#page:not([hidden]) .page-item');
  await picker.evaluate(() => document.fonts.ready);
  await freshWindow();
  captures.picker = await popupShot(picker);

  const options = await browser.newPage();
  await options.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await options.setViewport({ width: 840, height: 690, deviceScaleFactor: 2 });
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.evaluate(() => document.fonts.ready);
  await sleep(500);
  await options.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    const top = document.querySelector('#security').getBoundingClientRect().top + scrollY;
    scrollTo(0, top - 64); // just under the sticky top bar, which blurs what is behind it
  });
  await sleep(300);
  captures.settings = await options.screenshot({ encoding: 'base64' });

  // The same section in the narrow layout, for the site's card: readable at card width.
  await options.setViewport({ width: 520, height: 420, deviceScaleFactor: 2 });
  await sleep(300);
  await options.evaluate(() => {
    const top = document.querySelector('#security').getBoundingClientRect().top + scrollY;
    scrollTo(0, top - 72);
  });
  await sleep(300);
  captures.settingsCard = await options.screenshot({ encoding: 'base64' });

  await options.setViewport({ width: 900, height: 720, deviceScaleFactor: 1 });
  await options.evaluate(() => scrollTo(0, 0));
  await sleep(300);
  writeOpaque(join(docShots, 'settings.png'), await options.screenshot({ fullPage: true }));
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ---------- opaque PNGs ----------
// The store rejects images with an alpha channel, and Chrome writes RGBA. This drops the
// channel (every pixel is already opaque) and writes plain 24-bit RGB.
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

// Undoes PNG's per-row filters (8-bit samples, no interlacing: what Chrome writes).
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = up[i];
      const c = i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 255;
    }
  }
  return pixels;
}

function toRgb(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const [depth, type, , , interlace] = png.subarray(24, 29);
  if (type === 2) return png;
  if (type !== 6 || depth !== 8 || interlace) throw new Error(`Unexpected PNG (type ${type}, depth ${depth})`);
  const idat = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += len + 12;
  }
  const rgba = unfilter(inflateSync(Buffer.concat(idat)), width, height, 4);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgba.copy(rows, y * (width * 3 + 1) + 1 + x * 3, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeOpaque(path, png) {
  writeFileSync(path, toRgb(png));
}

// ---------- frame the captures ----------
const dataUrl = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`;
const icon = dataUrl('extension/icons/icon128.png', 'image/png');
const shot = (key) => `data:image/png;base64,${captures[key]}`;
const fonts = `@font-face { font-family: 'Inter'; src: url(${dataUrl('extension/fonts/Inter-Variable.woff2', 'font/woff2')}) format('woff2'); font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; font-feature-settings: 'cv11', 'ss01'; -webkit-font-smoothing: antialiased; }`;

const frame = `${fonts}
  body { width: 1280px; height: 800px; overflow: hidden; display: grid;
         grid-template-columns: 400px 1fr; align-items: center; gap: 56px; padding: 0 72px;
         background: #F3F5F7; color: #141A24; }
  .brand { display: flex; gap: 12px; align-items: center; font-size: 21px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 34px; }
  .brand img { width: 40px; height: 40px; }
  h1 { font-size: 44px; line-height: 1.1; font-weight: 700; letter-spacing: -0.03em; }
  p { margin-top: 22px; font-size: 19px; line-height: 1.5; color: #4A5466; max-width: 32ch; }
  .bar { width: 96px; height: 4px; border-radius: 2px; background: #0E7C6B; margin-top: 34px; }
  .stage { position: relative; justify-self: center; }
  .pop { border-radius: 12px; overflow: hidden; background: #fff;
         box-shadow: 0 28px 70px -14px rgb(10 14 20 / .30), 0 0 0 1px rgb(10 14 20 / .06); }
  .pop img { display: block; }
  .pair { width: 680px; height: 640px; }
  .pair .pop { position: absolute; }
  .pair .back { right: 0; top: 70px; }
  .pair .front { left: 0; top: 0; }
  .tag { position: absolute; right: 18px; bottom: 6px; display: flex; gap: 8px; align-items: center;
         font-size: 15px; font-weight: 600; color: #0B6B5C; }
  .tag i { width: 8px; height: 8px; border-radius: 50%; background: #0E7C6B; box-shadow: 0 0 0 3px #E6F3F0; }
  .win { position: relative; width: 704px; border-radius: 12px; overflow: visible; background: #fff;
         box-shadow: 0 28px 70px -14px rgb(10 14 20 / .26), 0 0 0 1px rgb(10 14 20 / .07); }
  .chrome { height: 44px; display: flex; align-items: center; gap: 12px; padding: 0 12px;
            background: #fff; border-radius: 12px 12px 0 0; box-shadow: inset 0 -1px 0 #E6E9EF; }
  .chrome svg { width: 16px; height: 16px; color: #6B7484; flex: none; }
  .omni { flex: 1; height: 30px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
          border-radius: 15px; background: #F1F3F6; font-size: 13.5px; color: #3E4757; }
  .omni span { color: #8A93A3; }
  .ext { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; }
  .ext.on { background: #E6F3F0; }
  .ext img { width: 18px; height: 18px; }
  .page { display: block; width: 704px; border-radius: 0 0 12px 12px; }
  .win .pop { position: absolute; right: 8px; top: 48px; }
`;

const back = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>';
const forward = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const reload = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/></svg>';

const popupHtml = (key, width, cls = '') => `<div class="pop ${cls}"><img src="${shot(key)}" width="${width}" alt=""></div>`;

// A plain browser window around the sample site, with the popup open under the toolbar icon.
const windowHtml = (key, path, popupKey) => `<div class="stage"><div class="win">
  <div class="chrome">${back}${forward}${reload}
    <div class="omni">${SITE}<span>${path}</span></div>
    <div class="ext${popupKey ? ' on' : ''}"><img src="${icon}" alt=""></div>
  </div>
  <img class="page" src="${shot(key)}" alt="">
  ${popupKey ? popupHtml(popupKey, 290) : ''}
</div></div>`;

const slides = [
  ['1-codes', 'Your 2-step codes, right in Chrome',
    'The same codes as Google Authenticator, one click from any tab. Pin the ones you use most, or share a code for a few minutes with a link.',
    `<div class="stage pair">${popupHtml('share', 320, 'back')}${popupHtml('list', 360, 'front')}
      <div class="tag"><i></i>Share codes as a link that expires</div></div>`],
  ['2-autofill', 'Codes fill in by themselves',
    'On sites you’ve linked, the code goes in the moment the page asks: one box or six.',
    windowHtml('autofill', '/signin/verify')],
  ['3-accounts', 'Two accounts on one site? It picks the right one',
    'AuthPeek matches the username you signed in with. When it can’t tell, it asks instead of guessing.',
    windowHtml('choose', '/verify', 'picker')],
  ['4-add', 'Add accounts any way you have them',
    'Scan a QR code on the page, paste otpauth:// links, upload a screenshot or type the key. Google Authenticator exports come over in one scan.',
    `<div class="stage">${popupHtml('add', 360)}</div>`],
  ['5-safe', 'Encrypted, synced and backed up',
    'Encrypted with your password before it syncs to your Google account. No servers, no tracking.',
    `<div class="stage"><div class="pop"><img src="${shot('settings')}" width="700" alt=""></div></div>`],
];

const composer = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await composer.newPage();

async function render(width, height, html, file, scale = 1) {
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  writeOpaque(file, await page.screenshot({ clip: { x: 0, y: 0, width, height } }));
}

for (const [name, title, text, art] of slides) {
  await render(1280, 800, `<style>${frame}</style>
    <div><div class="brand"><img src="${icon}" alt="">AuthPeek</div><h1>${title}</h1><p>${text}</p><div class="bar"></div></div>
    ${art}`, join(out, `screenshot-${name}.png`));
}

// The site's "What it does" cards: the bare captures at 2x, with no slide frame or headline
// of their own (the card has the caption).
for (const [key, file] of [['list', 'popup-codes.png'], ['picker', 'popup-accounts.png'], ['add', 'popup-add.png'], ['settingsCard', 'settings-security.png']]) {
  writeOpaque(join(docShots, file), Buffer.from(captures[key], 'base64'));
}

// README and site copies of the popup, at the size Chrome shows it
for (const [key, file] of [['list', 'popup-light.png'], ['listDark', 'popup-dark.png']]) {
  await render(360, 600, `<style>* { margin: 0; } body { background: ${key === 'listDark' ? '#12161D' : '#F7F8FA'}; }
    img { display: block; width: 360px; }</style><img src="${shot(key)}" alt="">`, join(docShots, file));
}

await render(440, 280, `<style>${fonts}
  body { width: 440px; height: 280px; padding: 32px 34px; background: #0E7C6B; color: #fff; overflow: hidden;
         display: flex; flex-direction: column; justify-content: space-between; }
  .top { display: flex; align-items: center; gap: 14px; }
  .top img { width: 52px; height: 52px; border-radius: 13px; box-shadow: 0 0 0 2px rgb(255 255 255 / .35); }
  .name { font-size: 30px; font-weight: 700; letter-spacing: -0.03em; }
  .line { font-size: 21px; line-height: 1.3; font-weight: 600; letter-spacing: -0.015em; max-width: 21ch; }
  .code { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 600; opacity: .85;
          font-variant-numeric: tabular-nums slashed-zero; font-feature-settings: 'cv11'; letter-spacing: .06em; }
  .code i { width: 64px; height: 3px; border-radius: 2px; background: linear-gradient(90deg, #fff 70%, rgb(255 255 255 / .3) 70%); }
</style>
  <div class="top"><img src="${icon}" alt=""><div class="name">AuthPeek</div></div>
  <div class="line">2-step codes in Chrome that fill themselves in.</div>
  <div class="code">482 913<i></i></div>`, join(out, 'promo-small-440x280.png'));

// Marquee promo tile (1400×560): used when the store features the extension
await render(1400, 560, `<style>${fonts}
  body { width: 1400px; height: 560px; overflow: hidden; background: #0E7C6B; color: #fff;
         display: grid; grid-template-columns: 1fr 440px; align-items: center; padding: 0 96px; gap: 72px; }
  .top { display: flex; align-items: center; gap: 18px; margin-bottom: 34px; }
  .top img { width: 64px; height: 64px; border-radius: 16px; box-shadow: 0 0 0 2px rgb(255 255 255 / .35); }
  .name { font-size: 38px; font-weight: 700; letter-spacing: -0.03em; }
  h1 { font-size: 52px; line-height: 1.08; font-weight: 700; letter-spacing: -0.035em; max-width: 15ch; }
  p { margin-top: 22px; font-size: 21px; line-height: 1.5; opacity: .86; max-width: 40ch; }
  .shot { align-self: end; height: 500px; border-radius: 14px 14px 0 0; overflow: hidden; background: #fff;
          box-shadow: 0 -10px 50px rgb(0 0 0 / .25); }
  .shot img { display: block; width: 440px; }
</style>
  <div>
    <div class="top"><img src="${icon}" alt=""><div class="name">AuthPeek</div></div>
    <h1>2-step codes that fill themselves in</h1>
    <p>An authenticator in Chrome: encrypted, synced with your Google account, no servers. Share a code with a link that expires.</p>
  </div>
  <div class="shot"><img src="${shot('list')}" alt=""></div>`, join(out, 'promo-marquee-1400x560.png'));

await composer.close();
console.log(`Store images written to ${out}, README screenshots to ${docShots}`);
