import { openVault, checkClock, forgetClock } from './lib/codes.js';
import { NEVER } from './lib/vault.js';
import { encryptBackup, decryptBackup, MAX_TEXT } from './lib/crypto.js';
import { toOtpauthUri } from './lib/otpauth.js';
import { DONATE_URL, STORE_URL } from './lib/config.js';
import { THEMES, applyTheme, syncTheme } from './lib/theme.js';
import { networkAccess } from './lib/access.js';
import { netCheck, lookupIps } from './lib/netcheck.js';
import {
  statusText, exportRefusal, addEntry, removeEntry, locksOutHere, isUrlEntry, OLD_VERSIONS_WARNING, OLD_VERSIONS_NOTE,
  OLD_VERSIONS_STILL, URL_ENTRY_WARNING, LIST_LIMIT_TEXT,
} from './lib/whitelist-ui.js';

const vault = openVault();
const $ = (sel) => document.querySelector(sel);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const today = () => new Date().toISOString().slice(0, 10);

function setMsg(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind} ${el.className.split(' ').filter((c) => c.startsWith('m-')).join(' ')}`;
}

// While a modal is open everything outside it is inert and under its backdrop, so the toast
// moves into the dialog (the top layer) to be seen and read out; it goes back when it closes.
let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  const host = $('#modal').open ? $('#modal') : document.body;
  const moved = el.parentNode !== host;
  if (moved) host.append(el);
  // A live region that has just moved is only read out when its text changes after the move.
  el.textContent = moved ? '' : text;
  if (moved) setTimeout(() => (el.textContent = text), 50);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

function busy(button, label) {
  if (label) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function saveFile(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- modal ----------
// One <dialog> for every flow; each flow fills it from a <template> and adds its buttons.

function openModal(title, templateId) {
  const dialog = $('#modal');
  const body = $('#modal-body');
  const actions = $('#modal-actions');
  $('#modal-title').textContent = title;
  body.replaceChildren($(templateId).content.cloneNode(true));
  actions.replaceChildren();
  let onSubmit = null;
  const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
  $('#modal-form').onsubmit = async (e) => {
    e.preventDefault();
    if (onSubmit) await onSubmit();
  };
  const modal = {
    q: (sel) => body.querySelector(sel),
    closed,
    close: () => dialog.close(),
    // A secondary button (closes unless onClick is given), or the primary one (Enter submits).
    button(label, { primary = false, onClick = null } = {}) {
      const b = document.createElement('button');
      b.className = `btn${primary ? ' primary' : ''}`;
      b.textContent = label;
      if (primary) {
        b.type = 'submit';
        onSubmit = () => onClick(b);
      } else {
        b.type = 'button';
        b.addEventListener('click', () => (onClick ? onClick(b) : modal.close()));
      }
      actions.append(b);
      return b;
    },
  };
  dialog.showModal();
  return modal;
}

// Asks for the AuthPeek password (which also unlocks AuthPeek). Resolves to it, or null.
// `verify` replaces the unlock step (it must check the password itself, e.g. setPolicy);
// its errors other than a wrong password are shown in the dialog as they are.
function askPassword(title, intro, actionLabel, { warning = '', verify = (pw) => vault.unlock(pw) } = {}) {
  return new Promise((resolve) => {
    const m = openModal(title, '#tpl-password');
    m.q('.m-intro').textContent = intro;
    if (warning) {
      m.q('.m-warn').textContent = warning;
      m.q('.m-warn').hidden = false;
    }
    const input = m.q('.m-pw');
    let result = null;
    m.button('Cancel');
    m.button(actionLabel, {
      primary: true,
      onClick: async (b) => {
        // The modal skips the browser's own checks (a grey bubble in the wrong font), so this is ours.
        if (!input.value) return setMsg(m.q('.m-error'), 'Enter your AuthPeek password.', 'error');
        busy(b, 'Checking…');
        try {
          await verify(input.value);
          result = input.value;
          m.close();
        } catch (err) {
          const wrong = !err?.message || /wrong password/i.test(err.message);
          setMsg(m.q('.m-error'), wrong ? 'That isn’t your AuthPeek password. Try again.' : err.message, 'error');
          input.select();
        } finally {
          busy(b, null);
        }
      },
    });
    m.closed.then(() => resolve(result));
    input.focus();
  });
}

// Shows text with a Copy button. Copying happens on the user's own click, so it always works.
function showText({ title, intro, warning = '', text, extra = null, onDone = null }) {
  const m = openModal(title, '#tpl-text');
  m.q('.m-intro').textContent = intro;
  if (warning) {
    m.q('.m-warn').textContent = warning;
    m.q('.m-warn').hidden = false;
  }
  const area = m.q('.m-text');
  area.value = text;
  m.button('Done');
  if (extra) m.button(extra.label, { onClick: extra.onClick });
  m.button('Copy', {
    primary: true,
    onClick: async (b) => {
      await navigator.clipboard.writeText(area.value);
      b.textContent = 'Copied';
      toast(extra ? 'Copied. Paste it into the other app, then copy something else.' : 'Backup copied. Paste it into an email or note to yourself.');
    },
  });
  m.closed.then(() => {
    area.value = ''; // don't leave secrets in the page
    onDone?.();
  });
  area.focus();
  area.select();
}

// ---------- settings ----------

const PRESETS = ['1', '5', '15', '30', '60', '240', '480', '1440', '0', String(NEVER)];

function showLockHint(minutes) {
  const hint = $('#lock-hint');
  hint.classList.toggle('warn', minutes === NEVER);
  hint.textContent =
    minutes === NEVER
      ? 'Codes open without a password on this computer, so anyone using this Chrome profile can see them. Your synced copy stays encrypted.'
      : minutes === 0
        ? 'You enter your password once each time Chrome starts.'
        : 'Using AuthPeek, or a code being filled, restarts the timer.';
}

function showTheme(theme) {
  $(`#set-theme-${THEMES.includes(theme) ? theme : 'system'}`).checked = true;
}

async function onThemeChange(e) {
  applyTheme(e.target.value); // straight away, before sync storage answers
  await vault.saveSettings({ theme: e.target.value });
}

async function loadSettings() {
  const s = await vault.getSettings();
  showTheme(s.theme);
  $('#set-autofill').checked = s.autoFill;
  $('#set-autosubmit').checked = s.autoSubmit;
  $('#set-clock').checked = s.clockCheck;
  const preset = PRESETS.includes(String(s.lockMinutes));
  $('#set-lock').value = preset ? String(s.lockMinutes) : 'custom';
  $('#lock-custom').hidden = preset;
  if (!preset) $('#set-lock-custom').value = s.lockMinutes;
  showLockHint(s.lockMinutes);
}

async function onLockChange() {
  const choice = $('#set-lock').value;
  $('#lock-custom').hidden = choice !== 'custom';
  if (choice === 'custom') {
    const input = $('#set-lock-custom');
    if (!input.value) input.value = 10;
    input.focus();
    return onCustomLock();
  }
  showLockHint(Number(choice));
  await vault.saveSettings({ lockMinutes: Number(choice) });
}

async function onCustomLock() {
  // Hiding the box (another option was picked) fires a late change event; ignore it.
  if ($('#set-lock').value !== 'custom') return;
  const minutes = Math.round(Number($('#set-lock-custom').value));
  if (!(minutes >= 1 && minutes <= 10080)) return toast('Enter between 1 and 10080 minutes (7 days).');
  showLockHint(minutes);
  await vault.saveSettings({ lockMinutes: minutes });
}

async function refreshLockState() {
  const setUp = await vault.isSetUp();
  const open = setUp && (await vault.isUnlocked());
  $('#lockstate').classList.toggle('open', open);
  $('#lockstate-text').textContent = !setUp ? 'Not set up' : open ? 'Unlocked' : 'Locked';
}

// ---------- backup ----------

async function backupText(password) {
  const accounts = (await vault.listAccounts()).map(({ id, createdAt, ...rest }) => rest);
  return { text: await encryptBackup(password, accounts), count: accounts.length };
}

// Backups and exports only on a whitelisted network. Asked after the password step,
// because the whitelist can only be read once AuthPeek is unlocked.
async function exportAllowed() {
  const refusal = exportRefusal(await networkAccess(vault));
  if (refusal) toast(refusal);
  return !refusal;
}

async function onDownload() {
  const pw = await askPassword('Download backup', 'The file is encrypted with your AuthPeek password.', 'Download');
  if (pw == null || !(await exportAllowed())) return;
  const { text, count } = await backupText(pw);
  saveFile(text, `authpeek-backup-${today()}.json`, 'application/json');
  toast(`Backup of ${plural(count, 'account')} downloaded.`);
}

async function onEmail() {
  const pw = await askPassword('Email backup to myself', 'AuthPeek downloads the encrypted file and opens a new email for you to attach it to.', 'Continue');
  if (pw == null || !(await exportAllowed())) return;
  const { text } = await backupText(pw);
  const name = `authpeek-backup-${today()}.json`;
  saveFile(text, name, 'application/json');
  const body =
    `Attach ${name} from your Downloads folder and send this email to yourself.\n\n` +
    `To restore: AuthPeek settings > Backup > Restore, choose the file and enter your AuthPeek password.`;
  window.open(`mailto:?subject=${encodeURIComponent('AuthPeek backup')}&body=${encodeURIComponent(body)}`);
  toast(`Downloaded ${name}. Attach it to the email that just opened.`);
}

async function onCopy() {
  const pw = await askPassword('Backup as text', 'The text is encrypted with your AuthPeek password.', 'Show backup');
  if (pw == null || !(await exportAllowed())) return;
  const { text, count } = await backupText(pw);
  showText({
    title: 'Backup as text',
    intro: `${plural(count, 'account')}, encrypted. Paste it into an email or note to yourself; to restore, paste it back under Restore.`,
    text,
  });
}

// ---------- move to another app ----------

async function onExportLinks() {
  const pw = await askPassword('Export as links', 'The links contain your secret keys, so AuthPeek checks it’s you first.', 'Show links');
  if (pw == null || !(await exportAllowed())) return;
  const accounts = await vault.listAccounts();
  const text = accounts.map(toOtpauthUri).join('\n');
  showText({
    title: 'Export as links',
    intro: `${plural(accounts.length, 'account')} as otpauth:// links. Paste them into the other app.`,
    warning: 'Anyone who sees these links can make your codes. Don’t email them or keep them in notes.',
    text,
    extra: {
      label: 'Download .txt',
      onClick: () => {
        saveFile(`${text}\n`, `authpeek-links-${today()}.txt`, 'text/plain');
        toast('Saved. The file isn’t encrypted: delete it once your accounts are moved.');
      },
    },
  });
}

// ---------- restore ----------

function onRestore() {
  const m = openModal('Restore from backup', '#tpl-restore');
  const drop = m.q('.m-drop');
  const fileInput = m.q('.m-file');
  const pasteBox = m.q('.m-text');
  const pw = m.q('.m-pw');
  const current = m.q('.m-current');
  let fileText = '';

  const chooseFile = async (file) => {
    if (!file) return;
    fileText = await file.text();
    drop.classList.add('chosen');
    m.q('.m-drop-title').textContent = file.name;
    m.q('.m-drop-sub').textContent = 'Choose a different file';
    pw.focus();
  };
  fileInput.addEventListener('change', () => chooseFile(fileInput.files[0]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    chooseFile(e.dataTransfer.files[0]);
  });
  m.q('.m-switch').addEventListener('click', (e) => {
    const pasting = pasteBox.hidden;
    pasteBox.hidden = !pasting;
    drop.hidden = pasting;
    e.target.textContent = pasting ? 'Choose a backup file instead' : 'Paste backup text instead';
    (pasting ? pasteBox : pw).focus();
  });

  m.button('Cancel');
  m.button('Restore', {
    primary: true,
    onClick: async (b) => {
      const error = (text) => setMsg(m.q('.m-error'), text, 'error');
      const text = pasteBox.hidden ? fileText : pasteBox.value.trim();
      if (!text) return error(pasteBox.hidden ? 'Choose your backup file first.' : 'Paste the backup text first.');
      if (!pw.value) return error('Enter the password the backup was made with.');
      busy(b, 'Restoring…');
      try {
        let accounts;
        try {
          accounts = await decryptBackup(pw.value, text);
        } catch (err) {
          return error(/wrong password/i.test(err.message) ? 'That password doesn’t open this backup.' : err.message);
        }
        // Adding accounts needs AuthPeek unlocked (or set up, on a fresh install).
        if (!(await vault.isSetUp())) {
          await vault.setup(pw.value);
        } else if (!(await vault.isUnlocked())) {
          const currentPw = current.hidden ? pw.value : m.q('.m-current-pw').value;
          try {
            await vault.unlock(currentPw);
          } catch {
            if (current.hidden) {
              current.hidden = false;
              m.q('.m-current-pw').focus();
              return error('Enter your current AuthPeek password as well.');
            }
            return error('That isn’t your current AuthPeek password.');
          }
        }
        const { added, duplicates } = await vault.addAccounts(accounts.map(({ id, createdAt, ...rest }) => rest));
        m.close();
        const skipped = duplicates ? ` ${plural(duplicates, 'account')} you already had ${duplicates === 1 ? 'was' : 'were'} skipped.` : '';
        toast(`Restored ${plural(added, 'account')}.${skipped}`);
      } finally {
        busy(b, null);
      }
    },
  });
}

// ---------- password ----------

function onChangePassword() {
  const m = openModal('Change password', '#tpl-change');
  m.button('Cancel');
  m.button('Change password', {
    primary: true,
    onClick: async (b) => {
      const error = (text) => setMsg(m.q('.m-error'), text, 'error');
      const next = m.q('.m-new').value;
      if (!m.q('.m-old').value) return error('Enter your current password.');
      if (next.length < 8) return error('Use at least 8 characters.');
      if (next !== m.q('.m-new2').value) return error('The new passwords don’t match.');
      busy(b, 'Re-encrypting…');
      try {
        await vault.changePassword(m.q('.m-old').value, next);
        m.close();
        toast('Password changed. Your other computers will ask for the new one.');
      } catch (err) {
        error(/wrong password/i.test(err.message) ? 'Your current password is wrong.' : err.message);
      } finally {
        busy(b, null);
      }
    },
  });
  m.q('.m-old').focus();
}

// ---------- whitelisted IPs ----------
// The list lives inside the vault, so it can only be read while unlocked, and every change
// is saved with the password (vault.setPolicy checks it).

// entries null: not known (locked). rev: the list's revision (above 0 once it was ever used).
// mine: this computer's IPs from the one-off lookup made while the list is empty.
const wl = { entries: null, ips: [], rev: 0, render: 0, mine: null };
const MINE_MS = 30_000; // like the network check's cache

function renderEntries(entries) {
  const list = $('#wl-list');
  list.replaceChildren();
  for (const e of entries) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'wl-entry';
    const value = document.createElement('b');
    value.textContent = e.value;
    text.append(value);
    if (e.note) {
      const note = document.createElement('small');
      note.textContent = e.note;
      text.append(note);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'wl-remove';
    x.textContent = '×';
    x.setAttribute('aria-label', `Remove ${e.value}`);
    x.title = 'Remove';
    x.addEventListener('click', () => onRemoveEntry(e.value));
    li.append(text, x);
    list.append(li);
  }
}

function showWhitelistLocked(setUp) {
  wl.entries = null;
  wl.ips = [];
  wl.rev = 0;
  $('#btn-wl-unlock').hidden = !setUp;
  $('#btn-wl-check').hidden = true;
  $('#wl-list-row').hidden = true;
  $('#wl-old').hidden = true;
  $('#btn-wl-mine').hidden = true;
  const status = $('#wl-status');
  status.classList.remove('warn');
  status.textContent = setUp
    ? 'Locked. Unlock to see this list. Adding to it also unlocks AuthPeek.'
    : 'Set up AuthPeek in its popup first.';
}

function showWhitelist(access) {
  wl.entries = access.entries;
  wl.ips = access.ips;
  wl.rev = access.rev;
  const status = $('#wl-status');
  status.textContent = statusText(access);
  status.classList.toggle('warn', !access.allowed);
  renderEntries(access.entries);
  // The list and "Turn off…": while there are entries, and while the list was rolled back
  // (turning it off then saves a fresh, empty list with one password).
  $('#wl-list-row').hidden = access.entries.length === 0 && access.reason !== 'rolled-back';
  // Once the list was used (rev above 0), AuthPeek before 1.3 can't unlock, even with it empty.
  $('#wl-old').textContent = OLD_VERSIONS_NOTE;
  $('#wl-old').hidden = !(access.rev > 0);
  const mine = access.ips[0];
  $('#btn-wl-mine').hidden = !mine || access.entries.some((e) => e.value === mine);
}

// This computer's public IPs while the list is empty (the check makes no request then), so
// "Add my current IP" and the lock-out warning work for the first entry. Remembered on this
// page for 30 s; Check again (force) looks again. [] when the lookup fails.
async function myIps(force) {
  if (!force && wl.mine && Date.now() - wl.mine.at < MINE_MS) return wl.mine.ips;
  const ips = await lookupIps();
  wl.mine = { ips, at: Date.now() };
  return ips;
}

async function renderWhitelist({ force = false } = {}) {
  const run = ++wl.render; // a newer render wins over a slower older one
  const status = $('#wl-status');
  const setUp = await vault.isSetUp();
  const open = setUp && (await vault.isUnlocked());
  if (run !== wl.render) return;
  $('#form-wl').hidden = !setUp;
  if (!open) return showWhitelistLocked(setUp);
  $('#btn-wl-unlock').hidden = true;
  $('#btn-wl-check').hidden = false;
  if (force) status.textContent = 'Checking…';
  // Showing the section isn't use of the vault (it runs on load and on sync changes); only
  // Check again, which the user pressed, restarts the idle timer.
  const access = await networkAccess(vault, { force, touch: force });
  if (run !== wl.render) return;
  if (access.reason === 'locked') return showWhitelistLocked(true); // it locked in the meantime
  showWhitelist(access);
  if (access.reason !== 'off') return;
  const ips = await myIps(force);
  if (run !== wl.render || !ips.length) return;
  showWhitelist({ ...access, ips });
}

// The list as saved right now (a rolled-back list is replaced, so it counts as empty).
async function savedEntries() {
  try {
    return (await vault.getPolicy()).entries;
  } catch (err) {
    if (/rolled back/i.test(err?.message || '')) return [];
    throw err;
  }
}

// Asks for the password, then saves change(savedEntries). Resolves true when saved.
async function saveWhitelist({ title, intro, action, warning = '', change }) {
  const pw = await askPassword(title, intro, action, {
    warning,
    verify: async (password) => {
      if (!(await vault.isUnlocked())) await vault.unlock(password); // needed to read the list
      const entries = change(await savedEntries()); // fresh: another computer may have changed it
      try {
        await vault.setPolicy(password, { entries });
      } catch (err) {
        if (/invalid policy/i.test(err?.message || '')) throw new Error(LIST_LIMIT_TEXT);
        throw err;
      }
    },
  });
  if (pw == null) return false;
  await netCheck.forget(); // the next check must use the new list
  await renderWhitelist();
  return true;
}

async function onAddEntry(e) {
  e.preventDefault();
  const error = $('#wl-error');
  const value = $('#wl-value').value;
  const note = $('#wl-note').value;
  let next;
  try {
    next = addEntry(wl.entries || [], { value, note });
  } catch (err) {
    setMsg(error, err.message, 'error');
    return $('#wl-value').focus();
  }
  setMsg(error, '');
  const warnings = [];
  // An https:// address that also opens from outside would make every network "whitelisted".
  if (isUrlEntry(value)) warnings.push(URL_ENTRY_WARNING);
  if (!(wl.rev > 0)) warnings.push(OLD_VERSIONS_WARNING); // the first time the list is used
  if (wl.entries && locksOutHere(next, wl.ips)) {
    warnings.push(`This computer's IP (${wl.ips.join(', ')}) isn't on the list, so codes will be hidden here once you save.`);
  }
  const saved = await saveWhitelist({
    title: 'Add to Whitelisted IPs',
    intro: `Add ${value.trim()}? Codes will only be shown, filled, shared and exported on the networks in this list.`,
    action: 'Add',
    warning: warnings.join(' '),
    change: (entries) => addEntry(entries, { value, note }),
  });
  if (!saved) return;
  $('#form-wl').reset();
  toast(`Added ${value.trim()} to your whitelisted IPs.`);
}

async function onRemoveEntry(value) {
  const last = (wl.entries || []).length <= 1;
  const saved = await saveWhitelist({
    title: 'Remove from Whitelisted IPs',
    intro: last
      ? `Remove ${value}? It's the only entry, so this turns Whitelisted IPs off and codes work on any network. ${OLD_VERSIONS_STILL}`
      : `Remove ${value}? Codes will no longer be available on that network.`,
    action: 'Remove',
    change: (entries) => removeEntry(entries, value),
  });
  if (saved) toast(last ? 'Whitelisted IPs is off.' : `Removed ${value}.`);
}

async function onClearWhitelist() {
  const saved = await saveWhitelist({
    title: 'Turn off Whitelisted IPs',
    intro: `This removes every entry. Codes, share links, backups and exports will work on any network again. ${OLD_VERSIONS_STILL}`,
    action: 'Turn off',
    change: () => [],
  });
  if (saved) toast('Whitelisted IPs is off.');
}

// ---------- section list ----------

function followSections() {
  const links = new Map([...document.querySelectorAll('.side a')].map((a) => [a.getAttribute('href').slice(1), a]));
  const mark = (id) => links.forEach((a, key) => a.classList.toggle('active', key === id));
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) mark(visible[0].target.id);
    },
    { rootMargin: '-80px 0px -55% 0px' }
  );
  for (const id of links.keys()) observer.observe(document.getElementById(id));
  mark('autofill');
}

// ---------- wiring ----------

$('#donate').href = DONATE_URL;
// The Rate row only appears once the store listing exists.
if (STORE_URL) {
  $('#rate-link').href = `${STORE_URL}/reviews`;
  $('#rate-row').hidden = false;
}
$('#version').textContent = chrome.runtime.getManifest().version;
$('#set-autofill').addEventListener('change', (e) => vault.saveSettings({ autoFill: e.target.checked }));
$('#set-autosubmit').addEventListener('change', (e) => vault.saveSettings({ autoSubmit: e.target.checked }));
$('#set-clock').addEventListener('change', async (e) => {
  await vault.saveSettings({ clockCheck: e.target.checked });
  if (e.target.checked) await checkClock();
  else await forgetClock(); // stop correcting codes too
});
$('#set-lock').addEventListener('change', onLockChange);
for (const radio of document.querySelectorAll('input[name="theme"]')) radio.addEventListener('change', onThemeChange);
// A theme picked on another computer (or in another settings tab) moves the control too.
chrome.storage.sync.onChanged.addListener((changes) => {
  if (changes.settings?.newValue) showTheme(changes.settings.newValue.theme);
});
$('#set-lock-custom').addEventListener('change', onCustomLock);
$('#link-shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
$('#btn-download').addEventListener('click', onDownload);
$('#btn-email').addEventListener('click', onEmail);
$('#btn-copy').addEventListener('click', onCopy);
$('#btn-restore').addEventListener('click', onRestore);
$('#btn-export-links').addEventListener('click', onExportLinks);
$('#btn-change-pw').addEventListener('click', onChangePassword);
$('#modal').addEventListener('close', () => {
  if ($('#toast').parentNode !== document.body) document.body.append($('#toast'));
});
$('#form-wl').addEventListener('submit', onAddEntry);
$('#wl-value').maxLength = MAX_TEXT;
$('#wl-note').maxLength = MAX_TEXT;
$('#wl-value').addEventListener('input', () => setMsg($('#wl-error'), ''));
$('#btn-wl-clear').addEventListener('click', onClearWhitelist);
$('#btn-wl-check').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  busy(btn, 'Checking…');
  try {
    await renderWhitelist({ force: true });
  } finally {
    busy(btn, null);
  }
});
$('#btn-wl-unlock').addEventListener('click', async () => {
  const pw = await askPassword('Unlock AuthPeek', 'Enter your password to see your whitelisted IPs.', 'Unlock');
  if (pw != null) await renderWhitelist();
});
$('#btn-wl-mine').addEventListener('click', () => {
  $('#wl-value').value = wl.ips[0] || '';
  setMsg($('#wl-error'), '');
  $('#wl-note').focus();
});
chrome.storage.session.onChanged.addListener(refreshLockState);
// Only locking/unlocking matters here; other session keys (activity time, the network
// cache) change on every check and would loop.
chrome.storage.session.onChanged.addListener((changes) => {
  if ('vaultKey' in changes) renderWhitelist();
});
chrome.storage.sync.onChanged.addListener((changes) => {
  if ('meta' in changes) renderWhitelist(); // the list changed on another computer
});

syncTheme(vault);
loadSettings();
refreshLockState();
renderWhitelist();
followSections();
