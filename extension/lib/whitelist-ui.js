// Words for the popup and the settings page: "Whitelisted IPs" (status lines, notices, list
// edits) and the popup's "already filled" line for auto-fill. Pure functions only (no chrome.*
// and no network calls) so they run in Node tests. The gate's keying helpers (fillSite,
// totpStep) live in attempts.js, not here.
import { parseEntry, isAllowed } from './networks.js';
import { MAX_ENTRIES, MAX_TEXT } from './crypto.js';
import { WINDOW_MS, MAX_AUTO_PER_SITE } from './attempts.js';

const WINDOW_TEXT = `${WINDOW_MS / 60_000} minutes`;

export const OLD_VERSIONS_WARNING =
  'Update AuthPeek on your other computers to 1.3 first. Once Whitelisted IPs has been used, older versions can\'t unlock.';
export const OLD_VERSIONS_NOTE = 'Computers with AuthPeek older than 1.3 can\'t unlock this vault.';
// Turning the list off doesn't make the vault readable by 1.1.x again (the check stays in the new form).
export const OLD_VERSIONS_STILL = 'Computers with AuthPeek older than 1.3 still won\'t be able to unlock this vault.';
export const EXPORT_REFUSED = 'Not available: this network isn\'t in your whitelisted IPs.';
// Shown before the password step when an https:// address is added, and in the section's explainer.
export const URL_ENTRY_WARNING =
  'Only add an address that does NOT open from outside your network (from home, or on mobile data). ' +
  'If it opens anywhere, codes will show anywhere.';
export const LIST_LIMIT_TEXT =
  `The list couldn't be saved. It holds up to ${MAX_ENTRIES} entries of up to ${MAX_TEXT} characters.`;
export const ALREADY_FILLED =
  `AuthPeek already filled a code here in the last ${WINDOW_TEXT}, so it won't fill again by itself. ` +
  'If the site rejected it, the saved key may be out of date.';

// The popup's line for a refused automatic fill (a refusal from attempts.canAutoFill).
export function alreadyFilledText(refusal) {
  if (refusal?.why === 'site-limit') {
    return `AuthPeek already filled ${MAX_AUTO_PER_SITE} codes on this site in the last ${WINDOW_TEXT}, so it won't fill again by itself.`;
  }
  if (refusal?.why === 'unknown') return 'AuthPeek won\'t fill a code on this site by itself for now.';
  return ALREADY_FILLED;
}

const ROLLED_BACK = 'Your whitelist was changed without your password';
const ADD_AGAIN = 'add your entries again under Whitelisted IPs';

// Why an export or backup was refused (null when it may go ahead).
export function exportRefusal(access) {
  if (access?.allowed === true) return null;
  if (access?.reason === 'not-listed') return EXPORT_REFUSED;
  // Shown in Settings itself, so no "open Settings".
  if (access?.reason === 'rolled-back') return `Not available: ${ROLLED_BACK.toLowerCase()}. Add your entries again under Whitelisted IPs.`;
  if (access?.reason === 'locked') return 'Not available: AuthPeek is locked. Unlock it and try again.';
  return 'Not available: AuthPeek couldn\'t check your network.';
}

const ipList = (ips) => (Array.isArray(ips) ? ips.filter((ip) => typeof ip === 'string' && ip) : []);

// The popup's notice when codes are hidden; null when codes may be shown.
export function popupNotice(access) {
  if (access?.allowed === true) return null;
  const ips = ipList(access?.ips);
  switch (access?.reason) {
    case 'not-listed':
      return {
        text: 'Codes are hidden. This network isn\'t in your whitelisted IPs.',
        detail: ips.length ? `Your IP: ${ips.join(', ')}` : '',
      };
    case 'rolled-back':
      return { text: `${ROLLED_BACK}, so codes are hidden. Open Settings and ${ADD_AGAIN}.`, detail: '' };
    case 'locked':
      return { text: 'AuthPeek is locked. Unlock it to see your codes.', detail: '' };
    default:
      // 'error' and anything unexpected: fail closed.
      return { text: 'Couldn\'t check your network, so codes are hidden.', detail: '' };
  }
}

// The status line in Settings > Whitelisted IPs.
export function statusText(access) {
  const ips = ipList(access?.ips).join(', ');
  if (access?.allowed === true && access.reason === 'off') {
    return ips ? `Off. Codes work on any network. Your IP: ${ips}` : 'Off. Codes work on any network.';
  }
  if (access?.allowed === true) return ips ? `On a whitelisted network · ${ips}` : 'On a whitelisted network';
  if (access?.reason === 'not-listed') return ips ? `Not on a whitelisted network · ${ips}` : 'Not on a whitelisted network';
  if (access?.reason === 'rolled-back') return `${ROLLED_BACK}. Add your entries again, or turn it off.`;
  if (access?.reason === 'locked') return 'Locked. Unlock to see this list.';
  return 'Couldn\'t check your network, so codes are hidden.';
}

const sameValue = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// The list after adding one entry. Throws an Error with a message to show the user.
export function addEntry(entries, { value, note = '' }) {
  const text = String(value ?? '').trim();
  const memo = String(note ?? '').trim();
  parseEntry(text); // throws a user-facing message for anything invalid or internal
  if (text.length > MAX_TEXT) throw new Error(`Keep the address under ${MAX_TEXT} characters.`);
  if (memo.length > MAX_TEXT) throw new Error(`Keep the note under ${MAX_TEXT} characters.`);
  if (entries.some((e) => sameValue(e.value, text))) throw new Error(`${text} is already on the list.`);
  if (entries.length >= MAX_ENTRIES) throw new Error(`The list can hold up to ${MAX_ENTRIES} entries. Remove one first.`);
  return [...entries, { value: text, note: memo }];
}

export const removeEntry = (entries, value) => entries.filter((e) => e.value !== value);

// True for a valid https:// entry (it needs URL_ENTRY_WARNING before it is saved).
export function isUrlEntry(value) {
  try {
    return parseEntry(value).kind === 'url';
  } catch {
    return false;
  }
}

// True when we know this computer's IP and the new list would not include it, so codes
// would be hidden here right after saving. Unknown (an https:// entry, or no IP) is false.
export function locksOutHere(entries, ips) {
  const known = ipList(ips);
  if (!entries.length || !known.length) return false;
  const parsed = [];
  for (const e of entries) {
    try { parsed.push(parseEntry(e.value)); } catch { /* ignored, as in the check */ }
  }
  if (parsed.some((p) => p.kind === 'url')) return false;
  return !isAllowed({ entries: parsed, publicIps: known, internalOk: false });
}
