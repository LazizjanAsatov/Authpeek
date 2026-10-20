import { openVault, checkClock, forgetClock } from './lib/codes.js';
import { NEVER } from './lib/vault.js';
import { encryptBackup, decryptBackup } from './lib/crypto.js';
import { toOtpauthUri } from './lib/otpauth.js';
import { DONATE_URL } from './lib/config.js';

const vault = openVault();
const $ = (sel) => document.querySelector(sel);

function setMsg(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

// ---------- settings ----------

const PRESETS = ['1', '5', '15', '30', '60', '240', '480', '1440', '0', String(NEVER)];

function showLockHint(minutes) {
  const hint = $('#lock-hint');
  hint.classList.toggle('warn', minutes === NEVER);
  if (minutes === NEVER) {
    hint.textContent =
      'Your codes open without a password on this computer, so anyone using this Chrome profile can see them. ' +
      'Your synced copy stays encrypted, and a new computer asks for the password once.';
  } else if (minutes === 0) {
    hint.textContent = 'You enter your password once each time Chrome starts.';
  } else {
    hint.textContent = 'Using AuthPeek, or a code being filled, restarts the timer.';
  }
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
  const minutes = Number(choice);
  showLockHint(minutes);
  await saveSetting({ lockMinutes: minutes });
}

async function onCustomLock() {
  // Hiding the box (another option was picked) fires a late change event; ignore it.
  if ($('#set-lock').value !== 'custom') return;
  const minutes = Math.round(Number($('#set-lock-custom').value));
  if (!(minutes >= 1 && minutes <= 10080)) {
    return setMsg($('#settings-msg'), 'Enter between 1 and 10080 minutes (7 days).', 'error');
  }
  showLockHint(minutes);
  await saveSetting({ lockMinutes: minutes });
}

async function saveSetting(patch) {
  await vault.saveSettings(patch);
  setMsg($('#settings-msg'), 'Saved.', 'ok');
  setTimeout(() => setMsg($('#settings-msg'), ''), 1500);
}

// ---------- lock state ----------

async function refreshLockState() {
  const unlocked = (await vault.isSetUp()) && (await vault.isUnlocked());
  $('#locked').hidden = unlocked;
  for (const id of ['#btn-download', '#btn-email', '#btn-copy', '#btn-restore', '#btn-export-links']) $(id).disabled = !unlocked;
  if (!unlocked) hideExport();
}

// ---------- backup ----------

function askPassword(error = '', intro = '') {
  if (intro) $('#confirm-intro').textContent = intro;
  const dialog = $('#pw-dialog');
  const input = $('#confirm-pw');
  input.value = '';
  setMsg($('#confirm-msg'), error, 'error');
  dialog.showModal();
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'ok' ? input.value : null);
    };
    dialog.addEventListener('close', onClose);
  });
}

// Asks for the AuthPeek password until it's right (or cancelled). Returns it, or null.
async function confirmPassword(intro) {
  let error = '';
  for (;;) {
    const pw = await askPassword(error, intro);
    if (pw == null) return null;
    try {
      await vault.unlock(pw); // checks the password
      return pw;
    } catch {
      error = 'Wrong password. Try again.';
    }
  }
}

async function makeBackup() {
  const pw = await confirmPassword('The backup is encrypted with your AuthPeek password.');
  if (pw == null) return null;
  const accounts = (await vault.listAccounts()).map(({ id, createdAt, ...rest }) => rest);
  return { text: await encryptBackup(pw, accounts), count: accounts.length };
}

// ---------- export as links ----------

async function onExportLinks() {
  const pw = await confirmPassword('The links include your secret keys, so AuthPeek checks it’s you first.');
  if (pw == null) return;
  const accounts = await vault.listAccounts();
  $('#export-text').value = accounts.map(toOtpauthUri).join('\n');
  $('#export-count').textContent = `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`;
  $('#export-panel').hidden = false;
  $('#export-text').focus();
  $('#export-text').select();
}

function hideExport() {
  $('#export-text').value = '';
  $('#export-panel').hidden = true;
  setMsg($('#export-msg'), '');
}

const backupName = () => `authpeek-backup-${new Date().toISOString().slice(0, 10)}.json`;

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function onDownload() {
  const backup = await makeBackup();
  if (!backup) return;
  download(backup.text, backupName());
  setMsg($('#backup-msg'), `Backup of ${backup.count} accounts downloaded.`, 'ok');
}

async function onEmail() {
  const backup = await makeBackup();
  if (!backup) return;
  const name = backupName();
  download(backup.text, name);
  const body =
    `Attach ${name} from your Downloads folder to this email and send it to yourself.\n\n` +
    `The file is encrypted with your AuthPeek password. To restore it, open AuthPeek settings, ` +
    `choose Restore, pick the file and enter that password.`;
  window.open(`mailto:?subject=${encodeURIComponent('AuthPeek backup')}&body=${encodeURIComponent(body)}`);
  setMsg($('#backup-msg'), `Downloaded ${name}. Attach it to the email that just opened.`, 'ok');
}

async function onCopy() {
  const backup = await makeBackup();
  if (!backup) return;
  await navigator.clipboard.writeText(backup.text);
  setMsg($('#backup-msg'), 'Backup copied. Paste it into an email to yourself.', 'ok');
}

// ---------- restore ----------

async function onRestore() {
  const msg = $('#restore-msg');
  const file = $('#restore-file').files[0];
  const text = file ? await file.text() : $('#restore-text').value.trim();
  if (!text) return setMsg(msg, 'Choose a backup file or paste the backup text.', 'error');
  try {
    const accounts = await decryptBackup($('#restore-pw').value, text);
    const { added, duplicates } = await vault.addAccounts(accounts.map(({ id, createdAt, ...rest }) => rest));
    const extra = duplicates ? ` ${duplicates} you already had ${duplicates === 1 ? 'was' : 'were'} skipped.` : '';
    setMsg(msg, `Restored ${added} ${added === 1 ? 'account' : 'accounts'}.${extra}`, 'ok');
    $('#restore-file').value = '';
    $('#restore-text').value = '';
    $('#restore-pw').value = '';
  } catch (err) {
    setMsg(msg, /wrong password/i.test(err.message) ? 'Wrong password for this backup.' : err.message, 'error');
  }
}

// ---------- password ----------

async function onChangePassword(e) {
  e.preventDefault();
  const msg = $('#pw-msg');
  const next = $('#pw-new').value;
  if (next.length < 8) return setMsg(msg, 'Use at least 8 characters.', 'error');
  if (next !== $('#pw-new2').value) return setMsg(msg, 'The new passwords don’t match.', 'error');
  setMsg(msg, 'Re-encrypting your accounts…');
  try {
    await vault.changePassword($('#pw-old').value, next);
    e.target.reset();
    setMsg(msg, 'Password changed. Your other computers will ask for the new one.', 'ok');
  } catch (err) {
    setMsg(msg, /wrong password/i.test(err.message) ? 'Current password is wrong.' : err.message, 'error');
  }
}

// ---------- wiring ----------

$('#donate').href = DONATE_URL;
$('#version').textContent = `Version ${chrome.runtime.getManifest().version}`;
$('#set-autofill').addEventListener('change', (e) => saveSetting({ autoFill: e.target.checked }));
$('#set-autosubmit').addEventListener('change', (e) => saveSetting({ autoSubmit: e.target.checked }));
$('#set-clock').addEventListener('change', async (e) => {
  await saveSetting({ clockCheck: e.target.checked });
  if (e.target.checked) await checkClock({ force: true });
  else await forgetClock(); // stop correcting codes too
});
$('#set-lock').addEventListener('change', onLockChange);
$('#set-lock-custom').addEventListener('change', onCustomLock);
$('#link-shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
$('#btn-download').addEventListener('click', onDownload);
$('#btn-email').addEventListener('click', onEmail);
$('#btn-copy').addEventListener('click', onCopy);
$('#btn-export-links').addEventListener('click', onExportLinks);
$('#btn-export-hide').addEventListener('click', hideExport);
$('#btn-export-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#export-text').value);
  setMsg($('#export-msg'), 'Copied. Paste it into the other app, then clear your clipboard.', 'ok');
});
$('#btn-export-save').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([$('#export-text').value + '\n'], { type: 'text/plain' }));
  const name = `authpeek-links-${new Date().toISOString().slice(0, 10)}.txt`;
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setMsg($('#export-msg'), `Saved ${name}. It isn’t encrypted: delete it once you’ve moved your accounts.`, 'ok');
});
$('#btn-restore').addEventListener('click', onRestore);
$('#form-pw').addEventListener('submit', onChangePassword);
chrome.storage.session.onChanged.addListener(refreshLockState);

loadSettings();
refreshLockState();
