import { openVault, codeFor, codeToFill, displayName, typedUsername, correctedNow, checkClock } from './lib/codes.js';
import { driftMessage } from './lib/clock.js';
import { pickAccount, manualPickPatch } from './lib/identity.js';
import { matchesQuery, displayOrder } from './lib/search.js';
import { hostOf, siteForHost, accountsForHost, suggestedAccounts } from './lib/sites.js';
import { parseLinks, findOtpLinks, parseOtpauthUri, normalizeSecret, normalizeSteamSecret, toOtpauthUri } from './lib/otpauth.js';
import { codesForWindow, encodeShare, decodeShare, shareUrl, shareFragmentFromText, currentCode, isExpired } from './lib/share.js';
import { DONATE_URL } from './lib/config.js';
import { NEVER } from './lib/vault.js';
import { logoFor } from './lib/logos.js';
import { syncTheme } from './lib/theme.js';

const vault = openVault();
const $ = (sel) => document.querySelector(sel);

const state = {
  tab: null,
  host: null,
  pageHasField: false,
  hints: [], // usernames shown on the page
  typed: '', // username typed earlier in this tab's login
  accounts: [],
  codes: new Map(),
  query: '',
  editing: null,
  keyLinkHost: null, // site to link when adding a key found on its page
  freshIds: new Set(),
  sharing: null, // the account on the share view
  shareFrom: 'list', // where Back goes from the share view
  sharedFrom: 'list', // ...and from a share link someone sent
};

// ---------- views ----------

const currentView = () => document.querySelector('[data-view]:not([hidden])')?.dataset.view;

function show(view) {
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== view;
  // A share link opened from the unlock screen is viewed without unlocking.
  const unlocked = ['list', 'add', 'edit', 'share'].includes(view) || (view === 'shared' && state.sharedFrom !== 'unlock');
  $('#btn-add').hidden = !unlocked;
  $('#btn-lock').hidden = !unlocked;
  $('#timer').hidden = view !== 'list';
  if (view === 'unlock') showPassword(false);
  // The setup QR holds the secret key: it is gone as soon as the view is left.
  if (view !== 'share') hideShare();
  if (view !== 'shared') stopShared();
  const first = document.querySelector(`[data-view="${view}"] [autofocus]`);
  if (first) first.focus();
  else focusIfLost(document.querySelector(FIRST_CONTROL[view]));
}

// Where focus goes when the control it was on has just been hidden (the list and the share
// views place it themselves).
const FIRST_CONTROL = {
  add: '[data-tab][aria-selected="true"]',
  edit: '[data-view="edit"] .back',
};

// A focused control that is hidden or removed drops focus to <body>, and keyboard users lose
// their place. This puts it on `target` instead, and leaves focus alone when it is still visible.
function focusIfLost(target) {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected && active.checkVisibility()) return;
  target?.focus();
}

function goBack() {
  const view = currentView();
  if (view === 'share' && state.shareFrom === 'edit') return show('edit');
  if (view === 'shared' && state.sharedFrom !== 'list') return show(state.sharedFrom);
  return showList();
}

// Errors are alerts, so a screen reader speaks them even while focus stays in the field. A
// message below the fold would look like nothing happened, so it is scrolled into view.
function setMsg(el, text, kind = '') {
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = text;
  el.className = `msg ${kind}`;
  if (text) el.scrollIntoView({ block: 'nearest' });
}

// Speaks a short confirmation ("Copied") that is otherwise only seen.
function announce(text) {
  const box = $('#sr-status');
  box.textContent = '';
  setTimeout(() => (box.textContent = text), 50); // a change, even for the same words twice
}

// ---------- tab / page ----------

async function readTab() {
  [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.host = hostOf(state.tab?.url);
  if (!state.host) return;
  const reply = await chrome.tabs.sendMessage(state.tab.id, { type: 'otp:status' }).catch(() => null);
  state.pageHasField = Boolean(reply?.hasTarget);
  state.hints = reply?.hints || [];
  state.typed = await typedUsername(state.tab.id).catch(() => '');
}

function pickForPage() {
  const linked = accountsForHost(state.accounts, state.host);
  const others = state.accounts.filter((a) => !linked.includes(a));
  return { linked, ...pickAccount({ linked, others, hints: state.hints, typed: state.typed }) };
}

async function fillOnPage(account) {
  const { autoSubmit, clockCheck } = await vault.getSettings();
  const code = await codeToFill(account, { clockCheck });
  await navigator.clipboard.writeText(code).catch(() => {});
  if (!state.tab || !state.host) return { filled: false, linked: false };

  const reply = await chrome.tabs
    .sendMessage(state.tab.id, { type: 'otp:fill', code, name: displayName(account), autoSubmit })
    .catch(() => null);

  // Filling by hand teaches auto-fill: the site, and the username used to sign in.
  const patch = reply?.filled ? manualPickPatch(account, state.host, state.typed) : null;
  if (patch) await vault.updateAccount(account.id, patch);
  return { filled: Boolean(reply?.filled), linked: Boolean(patch?.sites), learned: Boolean(patch?.usernames) };
}

// ---------- codes list ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

// Fixed icons kept as <template>s in popup.html, so no markup is parsed at runtime.
const icon = (name) => document.getElementById(`icon-${name}`).content.cloneNode(true);

// Relative luminance of a brand colour ("24292F"), to tell the very light ones apart.
function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Black and near-black ("181717"), as opposed to a dark colour.
function isGrey(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

// "H" for Hyperion, "HR" for Hyperion Rapid Solutions.
function initials(name) {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  const first = (word) => [...word][0] || '';
  if (!words.length) return '?';
  return (words.length > 1 ? first(words[0]) + first(words[1]) : first(words[0])).toUpperCase();
}

// The brand mark in white on its colour; a very light colour would swallow white, so that mark
// is drawn in its own colour on a light tile. Near-black brands get a lifted ink tile, or in dark
// mode they would read as holes in the page. Services without a bundled logo get a monogram.
function tileFor(account) {
  const tile = document.createElement('div');
  tile.className = 'avatar';
  tile.setAttribute('aria-hidden', 'true');
  const logo = logoFor(account.issuer, account.sites);
  if (!logo) {
    const letters = initials(account.issuer || account.label);
    tile.classList.add('mono');
    if (letters.length > 1) tile.classList.add('two');
    tile.textContent = letters;
    return tile;
  }
  const light = luminance(logo.hex) > 0.6;
  const ink = luminance(logo.hex) < 0.02 && isGrey(logo.hex); // a deep navy keeps its colour
  tile.style.background = light ? 'var(--tile-light)' : ink ? 'var(--tile-ink)' : `#${logo.hex}`;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', logo.path);
  path.setAttribute('fill', light ? `#${logo.hex}` : '#fff');
  svg.append(path);
  tile.append(svg);
  tile.dataset.logo = logo.slug;
  return tile;
}

// "123 456" as nodes: two halves with a small gap (Steam Guard's 5 letters stay one block).
function codeNodes(code) {
  if (code.length === 5) return [code];
  const mid = Math.ceil(code.length / 2);
  const gap = document.createElement('span');
  gap.className = 'gap';
  return [code.slice(0, mid), gap, code.slice(mid)];
}

async function refreshCodes() {
  const now = correctedNow();
  await Promise.all(state.accounts.map(async (a) => state.codes.set(a.id, await codeFor(a, now))));
}

// What an account is called on screen: a link may carry neither a service nor an account name.
const nameOf = (a) => a.issuer || a.label || 'Account';

function visibleAccounts() {
  return displayOrder(state.accounts).filter((a) => matchesQuery(a, state.query));
}

function renderPage() {
  const box = $('#page');
  box.replaceChildren();
  if (!state.host || !state.accounts.length) return (box.hidden = true);

  const { linked, account: picked } = pickForPage();
  const suggested = linked.length ? [] : suggestedAccounts(state.accounts, state.host);
  if (!state.pageHasField && !linked.length) return (box.hidden = true);

  const head = document.createElement('p');
  head.className = 'page-head';
  const text = document.createElement('span');
  const site = document.createElement('b');
  site.textContent = siteForHost(state.host);
  text.append(state.pageHasField ? 'This page is asking for a code · ' : 'Linked to ', site);
  head.append(icon('globe'), text);
  box.append(head);

  // Several accounts on this site: the one matching the username comes first.
  const items = linked.length ? linked : suggested;
  if (picked) items.sort((a, b) => (b === picked) - (a === picked));
  if (state.pageHasField && linked.length > 1) {
    const note = document.createElement('p');
    note.className = 'page-head';
    note.textContent = picked
      ? `Signing in as ${state.typed || picked.label}.`
      : state.typed
        ? `Pick the account for ${state.typed}. AuthPeek will remember it.`
        : 'Pick the account you are signing in with.';
    box.append(note);
  }
  for (const a of items) {
    const row = document.createElement('div');
    row.className = 'page-item';
    const who = document.createElement('span');
    who.className = 'who';
    const name = document.createElement('b');
    name.textContent = nameOf(a);
    who.append(name);
    if (a.issuer && a.label) {
      const label = document.createElement('span');
      label.textContent = a.label;
      who.append(label);
    }
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.append(icon('fill'), 'Fill code');
    btn.addEventListener('click', () => fillAndClose(a, btn));
    row.append(tileFor(a), who, btn);
    box.append(row);
  }
  if (!items.length) {
    const hint = document.createElement('p');
    hint.className = 'page-head';
    hint.textContent = 'Choose Fill on an account below. It will be filled automatically here next time.';
    box.append(hint);
  }
  box.hidden = false;
}

function renderList() {
  const list = $('#list');
  list.replaceChildren();
  const accounts = visibleAccounts();
  $('#empty').hidden = state.accounts.length > 0;
  $('#search-wrap').hidden = state.accounts.length < 6 && !state.query;
  // The page banner says "Choose Fill on an account below", so Fill doesn't wait for a hover.
  list.classList.toggle('page-asks', state.pageHasField);
  if (state.query && !accounts.length) {
    const li = document.createElement('li');
    li.className = 'no-match';
    li.textContent = `No account matches “${state.query.trim()}”.`;
    list.append(li);
  }

  for (const a of accounts) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = `row${state.freshIds.has(a.id) ? ' fresh' : ''}`;
    row.dataset.id = a.id;
    row.dataset.period = String(a.period);

    const avatar = tileFor(a);

    const who = document.createElement('div');
    who.className = 'who';
    const issuer = document.createElement('div');
    issuer.className = 'issuer';
    const name = document.createElement('span');
    name.textContent = nameOf(a);
    issuer.append(name);
    if (a.pinned) {
      const pin = document.createElement('i');
      pin.className = 'pin';
      pin.title = 'Pinned';
      pin.setAttribute('role', 'img');
      pin.setAttribute('aria-label', 'Pinned');
      issuer.prepend(pin);
    }
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = a.issuer ? a.label : '';
    who.append(issuer, label);

    const code = document.createElement('div');
    code.className = a.encoder === 'steam' ? 'code alpha' : 'code';
    code.id = `code-${a.id}`;
    // Read out as one run of digits (the aria-label), not two numbers split by the gap.
    code.setAttribute('role', 'img');

    // A real button, so Enter and Space copy and a screen reader says what it does; the code
    // itself is its description.
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy';
    copyBtn.title = 'Click to copy';
    copyBtn.setAttribute('aria-label', `Copy code for ${displayName(a)}`);
    copyBtn.setAttribute('aria-describedby', code.id);
    copyBtn.append(code);
    copyBtn.addEventListener('click', () => copy(a, code));

    const hover = document.createElement('div');
    hover.className = 'row-hover';
    if (state.pageHasField) {
      const fill = document.createElement('button');
      fill.className = 'btn fill';
      fill.textContent = 'Fill';
      fill.setAttribute('aria-label', `Fill ${displayName(a)}`);
      fill.addEventListener('click', () => fillAndClose(a, fill));
      hover.append(fill);
    }
    const share = document.createElement('button');
    share.className = 'icon-btn share';
    share.setAttribute('aria-label', `Share ${displayName(a)}`);
    share.title = 'Share';
    share.append(icon('share'));
    share.addEventListener('click', () => openShare(a, 'list'));
    hover.append(share);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const more = document.createElement('button');
    more.className = 'icon-btn';
    more.setAttribute('aria-label', `Edit ${displayName(a)}`);
    more.title = 'Edit';
    more.append(icon('more'));
    more.addEventListener('click', () => openEdit(a));
    actions.append(more);

    row.append(avatar, who, copyBtn, hover, actions);
    li.append(row);
    list.append(li);
  }
  paintCodes();
}

function paintCodes() {
  const now = correctedNow();
  for (const row of document.querySelectorAll('.row')) {
    const code = row.querySelector('.code');
    if (code.classList.contains('copied')) continue;
    const value = state.codes.get(row.dataset.id) || '';
    const period = Number(row.dataset.period);
    // A new code fades in; the first paint just appears.
    const rolled = Boolean(code.dataset.value) && code.dataset.value !== value;
    code.dataset.value = value;
    code.replaceChildren(...codeNodes(value));
    code.setAttribute('aria-label', value);
    // Codes on their own timer (60 s) carry a seconds badge; 30-second ones share the bar.
    if (period !== 30) {
      const secs = period - (Math.floor(now / 1000) % period);
      const left = document.createElement('span');
      left.className = 'secs';
      left.textContent = `${secs}s`;
      code.append(left);
      code.setAttribute('aria-label', `${value}, ${secs} seconds left`);
      row.classList.toggle('expiring', secs <= 5);
    }
    if (rolled) {
      code.classList.remove('rolled');
      void code.offsetWidth; // restarts the fade
      code.classList.add('rolled');
    }
  }
}

// "Copied" is narrower than the code, so the cell keeps the code's width meanwhile: otherwise
// the name beside it would widen and snap back.
function showCopied(codeEl) {
  codeEl.style.minWidth = `${codeEl.getBoundingClientRect().width}px`; // not offsetWidth: it rounds
  codeEl.classList.remove('rolled');
  codeEl.classList.add('copied');
  codeEl.textContent = 'Copied';
  announce('Copied');
}

async function copy(account, codeEl) {
  await navigator.clipboard.writeText(state.codes.get(account.id) || '');
  showCopied(codeEl);
  codeEl.setAttribute('aria-label', 'Copied');
  setTimeout(() => {
    codeEl.classList.remove('copied');
    codeEl.style.minWidth = '';
    paintCodes();
  }, 1100);
}

async function fillAndClose(account, btn) {
  btn.disabled = true;
  const { filled, linked, learned } = await fillOnPage(account);
  if (filled) {
    btn.textContent = learned ? 'Filled · remembered' : linked ? 'Filled · linked' : 'Filled';
    announce(btn.textContent);
    setTimeout(() => window.close(), linked || learned ? 900 : 450);
  } else {
    btn.textContent = 'Copied';
    announce('Copied');
    btn.disabled = false;
  }
}

// One shared countdown for every 30-second code. With reduced motion the bar doesn't glide:
// it moves once a second instead.
let lastStep = -1;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function startTicker() {
  const bar = $('#timer i');
  const syncBar = () => (bar.style.animationDelay = `-${(correctedNow() / 1000) % 30}s`);
  syncBar();
  const tick = async () => {
    const now = correctedNow();
    const step = Math.floor(now / 1000);
    document.body.classList.toggle('expiring', 30 - (step % 30) <= 5);
    if (step !== lastStep) {
      lastStep = step;
      bar.style.transform = reducedMotion.matches ? `translateX(-${((step % 30) / 30) * 100}%)` : '';
      await refreshCodes();
      paintCodes();
    }
  };
  tick();
  setInterval(tick, 250);
}

// Firefox makes access to websites opt-in; without it nothing can be filled. (Chrome grants
// it at install, so this stays hidden there.)
const SITE_ACCESS = { origins: ['http://*/*', 'https://*/*'] };
async function showPermissionPrompt() {
  const granted = await chrome.permissions.contains(SITE_ACCESS).catch(() => true);
  $('#perm').hidden = granted;
}

async function showClockWarning() {
  if (!(await vault.getSettings()).clockCheck) return;
  const before = correctedNow();
  const { offset } = await checkClock();
  const text = driftMessage(offset);
  const box = $('#clock-warn');
  box.hidden = !text;
  if (!text) return;
  box.textContent = `${text} AuthPeek corrects its codes for this, but other apps may not. Turn on “Set time automatically” in your computer’s date and time settings.`;
  if (Math.abs(correctedNow() - before) > 1000) {
    lastStep = -1; // the correction changed which codes are current
    $('#timer i').style.animationDelay = `-${(correctedNow() / 1000) % 30}s`;
  }
}

// Coming back from an account's edit or share view, focus returns to that account's row.
function focusRow(id) {
  const row = document.querySelector(`.row[data-id="${id}"] .copy`) || document.querySelector('.row .copy');
  focusIfLost(row || $('#btn-add'));
}

let tickerStarted = false;
async function showList() {
  const from = currentView();
  state.accounts = await vault.listAccounts();
  await refreshCodes();
  show('list');
  renderPage();
  renderList();
  // On opening and unlocking focus stays on the page, where typing searches; coming back from
  // another view it goes to the account the user was on (or the one just added).
  if (['add', 'edit', 'share', 'shared'].includes(from)) {
    focusRow(from === 'share' ? state.sharing?.id : from === 'edit' ? state.editing?.id : [...state.freshIds][0]);
  }
  if (!tickerStarted) {
    tickerStarted = true;
    startTicker();
    showClockWarning();
    showPermissionPrompt();
  }
}

// ---------- add ----------

// Only the selected tab is a Tab stop; the arrow keys move between them (the ARIA tabs pattern).
function selectTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
    b.tabIndex = b.dataset.tab === name ? 0 : -1;
  }
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
  setMsg($('#add-msg'), '');
  state.keyLinkHost = null;
}

function onTabsKey(e) {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const at = tabs.indexOf(document.activeElement);
  const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (at < 0 || to === undefined) return;
  e.preventDefault();
  const next = tabs[(to + tabs.length) % tabs.length];
  selectTab(next.dataset.tab);
  next.focus();
}

// "github" from "accounts.github.com": a starting name for a key found on a page.
function serviceNameFor(host) {
  const labels = siteForHost(host).split('.');
  const name = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// A key printed on the page has no service name, so fill the form and let the user check it.
function prefillFoundKey(keys) {
  selectTab('key');
  $('#key-secret').value = keys[0].replace(/(.{4})(?=.)/g, '$1 ');
  $('#key-issuer').value = state.host ? serviceNameFor(state.host) : '';
  $('#key-label').value = state.typed || '';
  state.keyLinkHost = state.host;
  const more = keys.length > 1 ? ` It showed ${keys.length} keys; this is the first.` : '';
  setMsg($('#add-msg'), `Found a setup key on this page. Check the name, then press Add account.${more}`, 'ok');
  $('#key-issuer').focus();
}

async function saveImported(accounts, { linkHost = null } = {}) {
  if (linkHost && accounts.length === 1) accounts = [{ ...accounts[0], sites: [siteForHost(linkHost)] }];
  const before = new Set(state.accounts.map((a) => a.id));
  const result = await vault.addAccounts(accounts);
  state.accounts = await vault.listAccounts();
  state.freshIds = new Set(state.accounts.filter((a) => !before.has(a.id)).map((a) => a.id));
  return result;
}

function describeImport({ added, duplicates }, { skipped = 0, batch = null, accounts = [], linkHost = null }) {
  const parts = [];
  if (added === 1 && accounts.length === 1) parts.push(`Added ${displayName(accounts[0])}.`);
  else if (added) parts.push(`Added ${added} accounts.`);
  if (added === 1 && linkHost) parts.push(`It will auto-fill on ${siteForHost(linkHost)}.`);
  if (duplicates) parts.push(`${duplicates} ${duplicates === 1 ? 'was' : 'were'} already saved.`);
  if (skipped) parts.push(`${skipped} counter-based ${skipped === 1 ? 'account isn’t' : 'accounts aren’t'} supported and ${skipped === 1 ? 'was' : 'were'} skipped.`);
  return parts.join(' ');
}

// Adds every account in `text`: what a QR code holds, or any text with otpauth:// links.
// A share link (pasted, typed or scanned) is for viewing, not adding, so it opens the shared view.
async function importText(text, { linkHost = null } = {}) {
  const fragment = shareFragmentFromText(text);
  if (fragment) return openShared(fragment, currentView());
  const parsed = parseLinks(text);
  if (!parsed.accounts.length) {
    if (parsed.failed.length === 1) throw new Error(`That link couldn’t be added: ${parsed.failed[0].error}.`);
    if (parsed.failed.length) throw new Error(`None of the ${parsed.failed.length} links could be added. First problem: ${parsed.failed[0].error}.`);
    throw new Error('Those links only had counter-based accounts, which AuthPeek doesn’t support.');
  }
  const result = await saveImported(parsed.accounts, { linkHost });
  let message = describeImport(result, { ...parsed, linkHost });
  if (parsed.failed.length) {
    const n = parsed.failed.length;
    message += ` ${n} ${n === 1 ? 'link' : 'links'} couldn’t be added (${parsed.failed[0].error}).`;
  }
  const moreBatches = parsed.batch && parsed.batch.size > 1 && parsed.batch.index < parsed.batch.size - 1;
  if (moreBatches) {
    setMsg(
      $('#add-msg'),
      `${message} That was QR code ${parsed.batch.index + 1} of ${parsed.batch.size}. Show the next one in Google Authenticator and scan again.`,
      'ok'
    );
    return;
  }
  await showList();
  flashListMessage(message);
}

function flashListMessage(text) {
  if (!text) return;
  const box = $('#page');
  const note = document.createElement('p');
  note.className = 'page-head';
  note.textContent = text;
  box.prepend(note);
  box.hidden = false;
  announce(text);
}

function decodeImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      for (const scale of [1, 0.5, 2]) {
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        if (w * h > 16e6 || w < 40) continue;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const found = globalThis.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
        if (found?.data) return resolve(found.data);
      }
      reject(new Error('No QR code found in the image. Make sure the whole code is visible and not cropped.'));
    };
    img.onerror = () => reject(new Error('That file could not be read as an image.'));
    img.src = src;
  });
}

async function importImageFile(file) {
  if (!file?.type.startsWith('image/')) return setMsg($('#add-msg'), 'Choose an image file (PNG or JPG).', 'error');
  const url = URL.createObjectURL(file);
  try {
    await importText(await decodeImage(url));
  } catch (err) {
    setMsg($('#add-msg'), err.message, 'error');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function scanPage() {
  const btn = $('#btn-scan');
  btn.disabled = true;
  setMsg($('#add-msg'), 'Looking for a QR code or setup link…');
  try {
    const shot = await chrome.tabs.captureVisibleTab(state.tab?.windowId, { format: 'png' }).catch(() => {
      throw new Error('Chrome doesn’t allow scanning this page. Take a screenshot and use Image instead.');
    });
    let text = await decodeImage(shot).catch(() => null);
    if (!text && state.tab?.id) {
      // No QR code in view: setup pages often also carry the otpauth:// link itself.
      const reply = await chrome.tabs.sendMessage(state.tab.id, { type: 'otp:links' }).catch(() => null);
      text = reply?.links?.join('\n') || null;
      if (!text && reply?.keys?.length) return prefillFoundKey(reply.keys);
    }
    if (!text) throw new Error('No QR code, setup link or key found on this page. Scroll so the whole QR code is visible, then scan again.');
    await importText(text, { linkHost: state.host });
  } catch (err) {
    setMsg($('#add-msg'), err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function addFromLinks() {
  const box = $('#links');
  if (!box.value.trim()) return setMsg($('#add-msg'), 'Paste an otpauth:// link first.', 'error');
  try {
    await importText(box.value);
    box.value = '';
  } catch (err) {
    setMsg($('#add-msg'), err.message, 'error');
  }
}

async function addFromKey(e) {
  e.preventDefault();
  const raw = $('#key-secret').value.trim();
  const msg = $('#add-msg');
  try {
    if (findOtpLinks(raw).length || shareFragmentFromText(raw)) return await importText(raw);
    // The form skips the browser's own checks (a grey bubble in the wrong font), so these are ours.
    if (!$('#key-issuer').value.trim()) return setMsg(msg, 'Enter the service name, for example GitHub.', 'error');
    if (!raw) return setMsg(msg, 'Enter the secret key.', 'error');
    const steam = $('#key-type').value === 'steam';
    const account = steam
      ? { issuer: $('#key-issuer').value.trim(), label: $('#key-label').value.trim(), secret: normalizeSteamSecret(raw),
          digits: 5, period: 30, algorithm: 'SHA1', encoder: 'steam' }
      : {
          issuer: $('#key-issuer').value.trim(),
          label: $('#key-label').value.trim(),
          secret: normalizeSecret(raw),
          digits: Number($('#key-digits').value),
          period: Number($('#key-period').value),
          algorithm: $('#key-algo').value,
        };
    if (!steam) {
      parseOtpauthUri(`otpauth://totp/x?secret=${account.secret}&digits=${account.digits}&period=${account.period}&algorithm=${account.algorithm}`);
    }
    const linkHost = state.keyLinkHost; // set when the key came from scanning this site's page
    const result = await saveImported([account], { linkHost });
    $('#form-key').reset();
    await showList();
    flashListMessage(describeImport(result, { accounts: [account], linkHost }));
  } catch (err) {
    const message = /invalid character/i.test(err.message)
      ? 'That secret key has characters authenticator keys never use. Keys only contain the letters A–Z and the digits 2–7.'
      : err.message;
    setMsg(msg, message, 'error');
  }
}

// ---------- edit ----------

function renderEditSites() {
  const a = state.editing;
  const chips = $('#edit-sites');
  chips.replaceChildren();
  for (const site of a.sites) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(site);
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', `Stop auto-fill on ${site}`);
    x.textContent = '×';
    x.addEventListener('click', () => {
      a.sites = a.sites.filter((s) => s !== site);
      renderEditSites();
    });
    chip.append(x);
    chips.append(chip);
  }
  $('#edit-sites-empty').hidden = a.sites.length > 0;
  const linkBtn = $('#btn-link-site');
  const site = state.host && siteForHost(state.host);
  linkBtn.hidden = !site || a.sites.includes(site);
  if (site) linkBtn.textContent = `Auto-fill on ${site}`;
}

function renderEditUsernames() {
  const a = state.editing;
  const chips = $('#edit-usernames');
  chips.replaceChildren();
  for (const name of a.usernames) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(name);
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', `Forget ${name}`);
    x.textContent = '×';
    x.addEventListener('click', () => {
      a.usernames = a.usernames.filter((u) => u !== name);
      renderEditUsernames();
    });
    chip.append(x);
    chips.append(chip);
  }
  $('#edit-usernames-field').hidden = a.usernames.length === 0;
}

function openEdit(account) {
  state.editing = { ...account, sites: [...(account.sites || [])], usernames: [...(account.usernames || [])] };
  $('#edit-issuer').value = account.issuer;
  $('#edit-label').value = account.label;
  setMsg($('#edit-msg'), '');
  const del = $('#btn-delete');
  del.classList.remove('armed');
  del.textContent = 'Delete account';
  renderEditSites();
  renderEditUsernames();
  $('#edit-pinned').checked = Boolean(account.pinned);
  show('edit');
}

async function saveEdit(e) {
  e.preventDefault();
  const a = state.editing;
  const issuer = $('#edit-issuer').value.trim();
  const label = $('#edit-label').value.trim();
  // Many links have no issuer, so either name will do; the list needs one of them.
  if (!issuer && !label) return setMsg($('#edit-msg'), 'Enter a service or an account name.', 'error');
  await vault.updateAccount(a.id, { issuer, label, sites: a.sites, usernames: a.usernames, pinned: $('#edit-pinned').checked });
  await showList();
}

async function deleteEditing() {
  const del = $('#btn-delete');
  if (!del.classList.contains('armed')) {
    del.classList.add('armed');
    del.textContent = 'Click again to delete';
    return;
  }
  await vault.deleteAccount(state.editing.id);
  await showList();
  flashListMessage(`Deleted ${displayName(state.editing)}. If the site still has 2-step verification on, you’ll need another way to sign in.`);
}

// ---------- share ----------

// "14:05" in the user's own clock format.
const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const shortName = (a) => a.issuer || a.label || 'this account';

// A QR code drawn module by module in whole device pixels, so it stays crisp. Always black on
// white with the 4-module quiet zone around it: scanners want dark on light, whatever the theme.
function drawQr(canvas, text, size = 200) {
  const qrcode = globalThis.qrcode;
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const ratio = window.devicePixelRatio || 1;
  const cell = Math.max(2, Math.round((size * ratio) / (count + 8)));
  const px = (count + 8) * cell;
  canvas.width = canvas.height = px;
  canvas.style.width = canvas.style.height = `${px / ratio}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) if (qr.isDark(r, c)) ctx.fillRect((c + 4) * cell, (r + 4) * cell, cell, cell);
  }
}

// Setting the size wipes a canvas's pixels.
function clearQr(canvas) {
  canvas.width = canvas.height = 0;
  canvas.style.width = canvas.style.height = '';
}

function setLabel(btn, text) {
  btn.querySelector('span').textContent = text;
}

function flashLabel(btn, text, back) {
  setLabel(btn, text);
  setTimeout(() => setLabel(btn, back), 1100);
}

// Runs on every view change, so nothing from the share view (above all the setup QR) outlives it.
function hideShare() {
  $('#share-result').hidden = true;
  $('#share-link').value = '';
  $('#btn-share-create').classList.add('primary');
  $('#btn-share-create').textContent = 'Create link';
  $('#share-qr-box').hidden = true;
  clearQr($('#share-qr'));
  setLabel($('#btn-share-qr'), 'Show QR');
  $('#btn-share-qr').setAttribute('aria-expanded', 'false');
  setMsg($('#share-msg'), '');
  toggleSetupQr(false);
}

function renderShareAccount(account) {
  const box = $('#share-acct');
  const who = document.createElement('div');
  who.className = 'who';
  const issuer = document.createElement('div');
  issuer.className = 'issuer';
  const name = document.createElement('span'); // a span, so a long name ends in "…" as in the list
  name.textContent = nameOf(account);
  issuer.append(name);
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = account.issuer ? account.label : '';
  who.append(issuer, label);
  box.replaceChildren(tileFor(account), who);
}

async function openShare(account, from) {
  state.sharing = account;
  state.shareFrom = from;
  renderShareAccount(account);
  $('#share-min-5').checked = true;
  show('share');
  const { shareNoticeSeen } = await chrome.storage.local.get('shareNoticeSeen').catch(() => ({}));
  $('#share-notice').hidden = Boolean(shareNoticeSeen);
  (shareNoticeSeen ? $('#btn-share-create') : $('#share-notice-ok')).focus();
}

async function dismissShareNotice() {
  $('#share-notice').hidden = true;
  $('#btn-share-create').focus();
  await chrome.storage.local.set({ shareNoticeSeen: true });
}

// Works from the account already in memory: no vault call, so the idle timer is left alone.
async function createShareLink(e) {
  e.preventDefault();
  const account = state.sharing;
  const minutes = Number(document.querySelector('[name="share-minutes"]:checked').value);
  const payload = await codesForWindow(account, correctedNow(), minutes);
  const url = shareUrl(await encodeShare(payload));
  if (currentView() !== 'share' || state.sharing !== account) return;
  const end = payload.start + payload.codes.length * payload.period * 1000;
  $('#share-link').value = url;
  $('#share-until').textContent =
    `Anyone with this link can see ${shortName(account)}’s codes until ${clockTime(end)}. The link doesn’t contain your secret key.`;
  $('#btn-share-native').hidden = typeof navigator.share !== 'function';
  setMsg($('#share-msg'), '');
  $('#share-result').hidden = false;
  // Copy link is the next step now, so Create steps back.
  $('#btn-share-create').classList.remove('primary');
  $('#btn-share-create').textContent = 'Create a new link';
  if (!$('#share-qr-box').hidden) toggleShareQr(); // the old link's QR goes
  $('#btn-share-copy').focus();
}

async function copyShareLink() {
  const btn = $('#btn-share-copy');
  await navigator.clipboard.writeText($('#share-link').value);
  flashLabel(btn, 'Copied', 'Copy link');
  announce('Link copied'); // a new label on the focused button isn't reliably read out
}

function toggleShareQr() {
  const box = $('#share-qr-box');
  const open = box.hidden;
  if (open) {
    try {
      drawQr($('#share-qr'), $('#share-link').value);
    } catch {
      // Only for codes that change every second or two: too many of them for one QR code.
      return setMsg($('#share-msg'), 'This link is too long for a QR code. Use Copy link instead.', 'error');
    }
  } else {
    clearQr($('#share-qr'));
  }
  box.hidden = !open;
  if (open) reveal(box);
  setLabel($('#btn-share-qr'), open ? 'Hide QR' : 'Show QR');
  $('#btn-share-qr').setAttribute('aria-expanded', String(open));
}

// A QR code half under the footer can't be scanned, so it is scrolled fully into view.
function reveal(el) {
  el.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

async function shareNatively() {
  if (typeof navigator.share !== 'function') return; // checked here too: support can differ per window
  try {
    await navigator.share({ title: `${shortName(state.sharing)} codes`, url: $('#share-link').value });
  } catch (err) {
    if (err.name !== 'AbortError') setMsg($('#share-msg'), 'Sharing isn’t available here. Use Copy link instead.', 'error');
  }
}

// The otpauth:// link with the secret key, drawn only while the user asks to see it. Being
// unlocked is not enough (with "Never ask" anyone at the computer is): like Export as links in
// settings, it checks the password first, every time.
function toggleSetupQr(open) {
  $('#setup-qr-box').hidden = !open;
  $('#form-setup-qr').hidden = open;
  $('#setup-qr-pw').value = '';
  setMsg($('#setup-qr-msg'), '');
  if (open) {
    drawQr($('#setup-qr'), toOtpauthUri(state.sharing));
    reveal($('#setup-qr-box'));
  } else {
    clearQr($('#setup-qr'));
  }
}

async function showSetupQr(e) {
  e.preventDefault();
  const input = $('#setup-qr-pw');
  const msg = $('#setup-qr-msg');
  if (!input.value) return setMsg(msg, 'Enter your AuthPeek password.', 'error');
  const account = state.sharing;
  setMsg(msg, 'Checking…');
  try {
    await vault.unlock(input.value);
  } catch {
    setMsg(msg, 'That isn’t your AuthPeek password. Try again.', 'error');
    return input.select();
  }
  if (currentView() !== 'share' || state.sharing !== account) return; // left while checking
  toggleSetupQr(true);
  $('#btn-setup-copy').focus({ preventScroll: true }); // the whole QR is scrolled to instead
}

function hideSetupQr() {
  toggleSetupQr(false);
  $('#setup-qr-pw').focus();
}

async function copySetupLink() {
  await navigator.clipboard.writeText(toOtpauthUri(state.sharing));
  flashLabel($('#btn-setup-copy'), 'Copied', 'Copy setup link');
  announce('Setup link copied');
}

// ---------- shared codes (a link someone sent) ----------

const shared = { payload: null, timer: null, shown: '' };

function stopShared() {
  clearInterval(shared.timer);
  shared.timer = null;
  shared.payload = null;
  shared.shown = '';
}

// `kind` picks the glyph: a clock for codes outside their time, a warning for a bad link.
// While the codes aren't valid yet this runs on every tick, so the same words are left alone
// (or they would be read out again). Copy may just have been hidden: focus then goes to Back.
function sharedState(text, kind, hint = 'Ask the person who shared it to send a new link.') {
  $('#shared-card').hidden = true;
  $('#shared-state').hidden = false;
  $('#shared-state').dataset.kind = kind;
  if ($('#shared-state-text').textContent !== text) $('#shared-state-text').textContent = text;
  $('#shared-state-hint').textContent = hint;
  focusIfLost($('[data-view="shared"] .back'));
}

// "Next: 123 456" with the code in bold, grouped like the list.
function nextLine(code) {
  const box = $('#shared-next');
  if (!code) return (box.textContent = 'Last code in this link');
  const b = document.createElement('b');
  b.append(...codeNodes(code));
  box.replaceChildren('Next: ', b);
}

function tickShared() {
  const payload = shared.payload;
  if (!payload) return;
  const now = correctedNow();
  if (isExpired(payload, now)) {
    stopShared();
    return sharedState('These codes have expired.', 'time');
  }
  const current = currentCode(payload, now);
  // Still ticking: the codes appear by themselves once their time comes.
  if (!current) {
    return sharedState(`These codes start at ${clockTime(payload.start)} — check your computer’s clock.`, 'time',
      'They appear here by themselves once their time comes.');
  }
  $('#shared-state').hidden = true;
  $('#shared-card').hidden = false;
  const code = $('#shared-code');
  if (current.code !== shared.shown && !code.classList.contains('copied')) {
    const rolled = Boolean(shared.shown);
    shared.shown = current.code;
    code.replaceChildren(...codeNodes(current.code));
    code.setAttribute('aria-label', current.code);
    nextLine(current.next);
    if (rolled) {
      code.classList.remove('rolled');
      void code.offsetWidth; // restarts the fade
      code.classList.add('rolled');
    }
  }
  const stepMs = payload.period * 1000;
  $('#shared-fill').style.transform = `scaleX(${1 - ((now - payload.start) % stepMs) / stepMs})`;
  $('#shared-left').textContent = `${current.secondsLeft}s left`;
  $('#shared-card').classList.toggle('expiring', current.secondsLeft <= 5);
}

async function openShared(fragment, from) {
  stopShared();
  state.sharedFrom = from;
  $('#shared-card').hidden = true;
  $('#shared-state').hidden = true;
  $('#shared-state-text').textContent = ''; // so a second bad link is read out too
  show('shared');
  let payload;
  try {
    payload = await decodeShare(fragment);
  } catch (err) {
    sharedState(`${err.message}.`, 'link');
    return $('[data-view="shared"] .back').focus();
  }
  if (currentView() !== 'shared') return;
  shared.payload = payload;
  $('#shared-name').textContent = payload.name;
  const end = payload.start + payload.codes.length * payload.period * 1000;
  $('#shared-expires').textContent = `Expires at ${clockTime(end)}`;
  tickShared();
  shared.timer = setInterval(tickShared, 250);
  ($('#shared-card').hidden ? $('[data-view="shared"] .back') : $('#shared-copy')).focus();
}

async function copyShared() {
  const code = $('#shared-code');
  await navigator.clipboard.writeText(shared.shown);
  showCopied(code);
  setTimeout(() => {
    code.classList.remove('copied');
    code.style.minWidth = '';
    if (!shared.shown) return;
    code.replaceChildren(...codeNodes(shared.shown));
  }, 1100);
}

// ---------- setup / unlock ----------

function showPassword(on) {
  $('#unlock-pw').type = on ? 'text' : 'password';
  $('#unlock-show').setAttribute('aria-pressed', String(on));
}

async function afterUnlock() {
  await showList();
  // The page was waiting for a code: fill it straight away when the choice is obvious.
  if (state.pageHasField && state.host) {
    const { account } = pickForPage();
    if (account) {
      const { filled } = await fillOnPage(account);
      if (filled) setTimeout(() => window.close(), 350);
    }
  }
}

async function onSetup(e) {
  e.preventDefault();
  const pw = $('#setup-pw').value;
  const msg = $('#setup-msg');
  if (pw.length < 8) return setMsg(msg, 'Use at least 8 characters.', 'error');
  if (pw !== $('#setup-pw2').value) return setMsg(msg, 'The passwords don’t match.', 'error');
  setMsg(msg, 'Creating your vault…');
  await vault.setup(pw);
  await afterUnlock();
}

async function onUnlock(e) {
  e.preventDefault();
  const msg = $('#unlock-msg');
  // The forms skip the browser's own checks (a grey bubble in the wrong font), so this is ours.
  if (!$('#unlock-pw').value) return setMsg(msg, 'Enter your password.', 'error');
  setMsg(msg, 'Unlocking…');
  try {
    await vault.unlock($('#unlock-pw').value);
    if ($('#unlock-remember').checked) await vault.saveSettings({ lockMinutes: NEVER });
    await afterUnlock();
  } catch {
    setMsg(msg, 'Wrong password. Try again.', 'error');
    $('#unlock-pw').select();
  }
}

// ---------- search ----------

function announceMatches() {
  const query = state.query.trim();
  if (!query || currentView() !== 'list') return;
  const n = visibleAccounts().length;
  announce(n ? `${n} ${n === 1 ? 'account matches' : 'accounts match'}` : `No account matches “${query}”.`);
}

// ---------- wiring ----------

function wire() {
  $('#donate').href = DONATE_URL;
  $('#form-setup').addEventListener('submit', onSetup);
  $('#form-unlock').addEventListener('submit', onUnlock);
  $('#unlock-show').addEventListener('click', () => {
    showPassword($('#unlock-pw').type === 'password');
    $('#unlock-pw').focus();
  });
  $('#form-key').addEventListener('submit', addFromKey);
  $('#form-edit').addEventListener('submit', saveEdit);
  $('#btn-delete').addEventListener('click', deleteEditing);
  $('#btn-link-site').addEventListener('click', () => {
    state.editing.sites.push(siteForHost(state.host));
    renderEditSites();
  });

  const openAdd = () => {
    selectTab('scan');
    show('add');
  };
  $('#btn-add').addEventListener('click', openAdd);
  $('#btn-add-first').addEventListener('click', openAdd);
  $('#btn-lock').addEventListener('click', async () => {
    await vault.lock();
    show('unlock');
  });
  const openSettings = (e) => {
    e?.preventDefault();
    chrome.runtime.openOptionsPage();
  };
  $('#btn-settings').addEventListener('click', openSettings);
  $('#link-settings').addEventListener('click', openSettings);
  for (const back of document.querySelectorAll('.back')) back.addEventListener('click', goBack);
  // Esc on the share views goes back instead of closing the popup.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !['share', 'shared'].includes(currentView())) return;
    e.preventDefault();
    goBack();
  });

  $('#btn-share-edit').addEventListener('click', () => {
    openShare(state.accounts.find((a) => a.id === state.editing.id) || state.editing, 'edit');
  });
  $('#share-notice-ok').addEventListener('click', dismissShareNotice);
  $('#form-share').addEventListener('submit', createShareLink);
  $('#share-link').addEventListener('focus', (e) => e.target.select());
  $('#btn-share-copy').addEventListener('click', copyShareLink);
  $('#btn-share-qr').addEventListener('click', toggleShareQr);
  $('#btn-share-native').addEventListener('click', shareNatively);
  $('#form-setup-qr').addEventListener('submit', showSetupQr);
  $('#btn-setup-hide').addEventListener('click', hideSetupQr);
  $('#btn-setup-copy').addEventListener('click', copySetupLink);
  $('#shared-copy').addEventListener('click', copyShared);

  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));
  $('.tabs').addEventListener('keydown', onTabsKey);
  $('#btn-scan').addEventListener('click', scanPage);
  $('#file').addEventListener('change', (e) => importImageFile(e.target.files[0]));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    importImageFile(e.dataTransfer.files[0]);
  });
  // Paste a QR screenshot or otpauth:// link anywhere on the codes or add screen. A share link
  // opens the shared view, from the unlock screen too (viewing one needs no password); it is
  // checked first so it never gets an otpauth error.
  document.addEventListener('paste', (e) => {
    const view = currentView();
    if (!['list', 'add', 'unlock'].includes(view)) return;
    const onList = view === 'list';
    const text = e.clipboardData?.getData('text') || '';
    const fragment = shareFragmentFromText(text);
    if (fragment) {
      e.preventDefault();
      return openShared(fragment, view);
    }
    if (view === 'unlock') return;
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      if (onList) show('add');
      selectTab('upload');
      importImageFile(file);
    } else if (findOtpLinks(text).length) {
      e.preventDefault();
      if (onList) show('add');
      selectTab('link');
      $('#links').value = text;
      addFromLinks();
    }
  });
  $('#btn-links').addEventListener('click', addFromLinks);
  $('#btn-perm').addEventListener('click', async () => {
    const granted = await chrome.permissions.request(SITE_ACCESS).catch(() => false);
    $('#perm').hidden = granted;
    if (granted) flashListMessage('Done. Reload any open sign-in pages and codes will fill.');
  });
  const syncKeyType = () => ($('#key-standard').hidden = $('#key-type').value === 'steam');
  $('#key-type').addEventListener('change', syncKeyType);
  $('#key-issuer').addEventListener('input', (e) => {
    if (e.target.value.trim().toLowerCase() === 'steam') {
      $('#key-type').value = 'steam';
      syncKeyType();
    }
  });
  $('#form-key').addEventListener('reset', () => setTimeout(syncKeyType));
  // A link typed or dropped into the secret key box is added once it stops changing,
  // and Service isn't needed for it (the link names the service).
  let linkTimer = null;
  $('#key-secret').addEventListener('input', (e) => {
    const hasLink = findOtpLinks(e.target.value).length > 0 || Boolean(shareFragmentFromText(e.target.value));
    clearTimeout(linkTimer);
    if (!hasLink) return;
    linkTimer = setTimeout(() => {
      const text = e.target.value;
      e.target.value = '';
      importText(text).catch((err) => setMsg($('#add-msg'), err.message, 'error'));
    }, 700);
  });

  // Type anywhere on the codes screen to search; Enter uses the top match, Esc clears.
  const search = $('#search');
  document.addEventListener('keydown', (e) => {
    if ($('[data-view="list"]').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    // Letters typed on a row's buttons search too; they mean nothing to a button.
    const typing = e.target.closest?.('input, textarea, select');
    if (e.key.length === 1 && e.key !== ' ' && !typing) {
      $('#search-wrap').hidden = false;
      search.focus(); // the key press then lands in the search box
    }
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault(); // clear the search instead of closing the popup
      search.value = '';
      state.query = '';
      renderList();
      focusIfLost(document.querySelector('.row .copy')); // the box hides again with a short list
    } else if (e.key === 'Enter') {
      const top = visibleAccounts()[0];
      if (!top) return;
      if (state.pageHasField) fillOnPage(top).then(({ filled }) => filled && window.close());
      else copy(top, document.querySelector(`.row[data-id="${top.id}"] .code`));
    }
  });
  let searchSaid = null;
  search.addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
    // Emptied with a short list, the box hides again: focus mustn't go with it.
    if (!state.query) focusIfLost(document.querySelector('.row .copy') || $('#btn-add'));
    // What matched is read out once typing pauses, not on every key.
    clearTimeout(searchSaid);
    searchSaid = setTimeout(announceMatches, 400);
  });
}

async function init() {
  wire();
  syncTheme(vault); // theme-boot.js already applied the last choice; this follows changes
  // Accounts synced from another computer can arrive while the setup screen is open.
  chrome.storage.sync.onChanged.addListener((changes) => {
    if (changes.meta?.newValue && !$('[data-view="setup"]').hidden) {
      $('#unlock-lead').textContent = 'Your accounts from your other computer are here. Enter the password you made there.';
      show('unlock');
    }
  });
  await readTab().catch(() => {});
  if (!(await vault.isSetUp())) return show('setup');
  if (!(await vault.isUnlocked())) {
    if (state.pageHasField) $('#unlock-lead').textContent = 'This page is asking for a code. Unlock to fill it in.';
    return show('unlock');
  }
  await showList();
}

init();
