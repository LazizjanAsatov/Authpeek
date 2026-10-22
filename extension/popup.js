import { openVault, codeFor, codeToFill, displayName, typedUsername, correctedNow, checkClock } from './lib/codes.js';
import { driftMessage } from './lib/clock.js';
import { pickAccount, manualPickPatch } from './lib/identity.js';
import { matchesQuery, displayOrder } from './lib/search.js';
import { hostOf, siteForHost, accountsForHost, suggestedAccounts } from './lib/sites.js';
import { parseLinks, findOtpLinks, parseOtpauthUri, normalizeSecret, normalizeSteamSecret } from './lib/otpauth.js';
import { DONATE_URL } from './lib/config.js';
import { NEVER } from './lib/vault.js';

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
};

// ---------- views ----------

function show(view) {
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== view;
  const unlocked = ['list', 'add', 'edit'].includes(view);
  $('#btn-add').hidden = !unlocked;
  $('#btn-lock').hidden = !unlocked;
  $('#timer').hidden = view !== 'list';
  document.querySelector(`[data-view="${view}"] [autofocus]`)?.focus();
}

function setMsg(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind}`;
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

const AVATAR_COLORS = ['#0E7C6B', '#3E5BA9', '#9A4F96', '#B5562E', '#2F7D9B', '#4F7D2E', '#A23E5A', '#4B5563'];
function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
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
  const site = document.createElement('b');
  site.textContent = siteForHost(state.host);
  head.append(state.pageHasField ? 'This page is asking for a code · ' : 'Linked to ', site);
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
    who.textContent = displayName(a);
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = 'Fill code';
    btn.addEventListener('click', () => fillAndClose(a, btn));
    row.append(who, btn);
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
    row.tabIndex = 0;
    row.title = 'Click to copy';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = avatarColor(a.issuer || a.label);
    avatar.textContent = (a.issuer || a.label || '?').trim().charAt(0).toUpperCase();

    const who = document.createElement('div');
    who.className = 'who';
    const issuer = document.createElement('div');
    issuer.className = 'issuer';
    issuer.textContent = a.issuer || a.label;
    if (a.pinned) {
      const pin = document.createElement('span');
      pin.className = 'pin';
      pin.title = 'Pinned';
      pin.setAttribute('aria-label', 'Pinned');
      issuer.prepend(pin);
    }
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = a.issuer ? a.label : '';
    who.append(issuer, label);

    const code = document.createElement('div');
    code.className = 'code';

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (state.pageHasField) {
      const fill = document.createElement('button');
      fill.className = 'btn fill';
      fill.textContent = 'Fill';
      fill.addEventListener('click', (e) => {
        e.stopPropagation();
        fillAndClose(a, fill);
      });
      actions.append(fill);
    }
    const more = document.createElement('button');
    more.className = 'icon-btn';
    more.setAttribute('aria-label', `Edit ${displayName(a)}`);
    more.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openEdit(a);
    });
    actions.append(more);

    row.append(avatar, who, code, actions);
    row.addEventListener('click', () => copy(a, code));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === row) copy(a, code);
    });
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
    code.replaceChildren(...codeNodes(value));
    if (period !== 30) {
      const left = document.createElement('small');
      left.textContent = `${period - (Math.floor(now / 1000) % period)}s`;
      code.append(left);
    }
  }
}

async function copy(account, codeEl) {
  await navigator.clipboard.writeText(state.codes.get(account.id) || '');
  codeEl.classList.add('copied');
  codeEl.textContent = 'Copied';
  setTimeout(() => {
    codeEl.classList.remove('copied');
    paintCodes();
  }, 1100);
}

async function fillAndClose(account, btn) {
  btn.disabled = true;
  const { filled, linked, learned } = await fillOnPage(account);
  if (filled) {
    btn.textContent = learned ? 'Filled · remembered' : linked ? 'Filled · linked' : 'Filled';
    setTimeout(() => window.close(), linked || learned ? 900 : 450);
  } else {
    btn.textContent = 'Copied';
    btn.disabled = false;
  }
}

// One shared countdown for every 30-second code.
let lastStep = -1;
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

let tickerStarted = false;
async function showList() {
  state.accounts = await vault.listAccounts();
  await refreshCodes();
  show('list');
  renderPage();
  renderList();
  if (!tickerStarted) {
    tickerStarted = true;
    startTicker();
    showClockWarning();
    showPermissionPrompt();
  }
}

// ---------- add ----------

function selectTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
  setMsg($('#add-msg'), '');
  state.keyLinkHost = null;
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
async function importText(text, { linkHost = null } = {}) {
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
  try {
    if (findOtpLinks(raw).length) return await importText(raw);
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
    setMsg($('#add-msg'), message, 'error');
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
  await vault.updateAccount(a.id, { issuer: $('#edit-issuer').value.trim(), label: $('#edit-label').value.trim(), sites: a.sites, usernames: a.usernames, pinned: $('#edit-pinned').checked });
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

// ---------- setup / unlock ----------

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

// ---------- wiring ----------

function wire() {
  $('#donate').href = DONATE_URL;
  $('#form-setup').addEventListener('submit', onSetup);
  $('#form-unlock').addEventListener('submit', onUnlock);
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
  for (const back of document.querySelectorAll('.back')) back.addEventListener('click', showList);

  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));
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
  // Paste a QR screenshot or otpauth:// link anywhere on the codes or add screen.
  document.addEventListener('paste', (e) => {
    const onList = !$('[data-view="list"]').hidden;
    if ($('[data-view="add"]').hidden && !onList) return;
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    const text = e.clipboardData?.getData('text') || '';
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
    const hasLink = findOtpLinks(e.target.value).length > 0;
    $('#key-issuer').required = !hasLink;
    clearTimeout(linkTimer);
    if (!hasLink) return;
    linkTimer = setTimeout(() => {
      const text = e.target.value;
      e.target.value = '';
      $('#key-issuer').required = true;
      importText(text).catch((err) => setMsg($('#add-msg'), err.message, 'error'));
    }, 700);
  });

  // Type anywhere on the codes screen to search; Enter uses the top match, Esc clears.
  const search = $('#search');
  document.addEventListener('keydown', (e) => {
    if ($('[data-view="list"]').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = e.target.closest?.('input, textarea, select, button');
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
    } else if (e.key === 'Enter') {
      const top = visibleAccounts()[0];
      if (!top) return;
      if (state.pageHasField) fillOnPage(top).then(({ filled }) => filled && window.close());
      else copy(top, document.querySelector(`.row[data-id="${top.id}"] .code`));
    }
  });
  search.addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
  });
}

async function init() {
  wire();
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
