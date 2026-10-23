import { openVault, checkClock, forgetClock } from './lib/codes.js';
import { NEVER } from './lib/vault.js';
import { encryptBackup, decryptBackup } from './lib/crypto.js';
import { toOtpauthUri } from './lib/otpauth.js';
import { DONATE_URL } from './lib/config.js';

const vault = openVault();
const $ = (sel) => document.querySelector(sel);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const today = () => new Date().toISOString().slice(0, 10);
// Only Firefox has getBrowserInfo, so this needs no user-agent sniffing.
const isFirefox = () => typeof chrome.runtime.getBrowserInfo === 'function';

function setMsg(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind} ${el.className.split(' ').filter((c) => c.startsWith('m-')).join(' ')}`;
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
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
function askPassword(title, intro, actionLabel) {
  return new Promise((resolve) => {
    const m = openModal(title, '#tpl-password');
    m.q('.m-intro').textContent = intro;
    const input = m.q('.m-pw');
    let result = null;
    m.button('Cancel');
    m.button(actionLabel, {
      primary: true,
      onClick: async (b) => {
        busy(b, 'Checking…');
        try {
          await vault.unlock(input.value);
          result = input.value;
          m.close();
        } catch {
          setMsg(m.q('.m-error'), 'That isn’t your AuthPeek password. Try again.', 'error');
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

async function loadSettings() {
  const s = await vault.getSettings();
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

async function onDownload() {
  const pw = await askPassword('Download backup', 'The file is encrypted with your AuthPeek password.', 'Download');
  if (pw == null) return;
  const { text, count } = await backupText(pw);
  saveFile(text, `authpeek-backup-${today()}.json`, 'application/json');
  toast(`Backup of ${plural(count, 'account')} downloaded.`);
}

async function onEmail() {
  const pw = await askPassword('Email backup to myself', 'AuthPeek downloads the encrypted file and opens a new email for you to attach it to.', 'Continue');
  if (pw == null) return;
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
  if (pw == null) return;
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
  if (pw == null) return;
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
$('#version').textContent = chrome.runtime.getManifest().version;
$('#set-autofill').addEventListener('change', (e) => vault.saveSettings({ autoFill: e.target.checked }));
$('#set-autosubmit').addEventListener('change', (e) => vault.saveSettings({ autoSubmit: e.target.checked }));
$('#set-clock').addEventListener('change', async (e) => {
  await vault.saveSettings({ clockCheck: e.target.checked });
  if (e.target.checked) await checkClock();
  else await forgetClock(); // stop correcting codes too
});
$('#set-lock').addEventListener('change', onLockChange);
$('#set-lock-custom').addEventListener('change', onCustomLock);
$('#link-shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  // Firefox refuses to open its own pages from an extension, so show the way there instead.
  if (isFirefox()) return toast('In Firefox: open Add-ons and themes (Ctrl+Shift+A), click the gear, then Manage Extension Shortcuts.');
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
$('#btn-download').addEventListener('click', onDownload);
$('#btn-email').addEventListener('click', onEmail);
$('#btn-copy').addEventListener('click', onCopy);
$('#btn-restore').addEventListener('click', onRestore);
$('#btn-export-links').addEventListener('click', onExportLinks);
$('#btn-change-pw').addEventListener('click', onChangePassword);
chrome.storage.session.onChanged.addListener(refreshLockState);

loadSettings();
refreshLockState();
followSections();
