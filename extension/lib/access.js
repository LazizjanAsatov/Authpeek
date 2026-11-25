// One answer to "may AuthPeek show or fill codes right now?" for the background, popup and
// settings page: the vault's whitelist (Whitelisted IPs) checked against the live network.
// Anything unexpected (a rolled-back or unreadable whitelist, a failed lookup) means no.
import { netCheck } from './netcheck.js';
import { exportRefusal } from './whitelist-ui.js';

// Returns { allowed, reason, ips, entries, rev }, reason one of
//   'off' | 'ok' | 'not-listed' | 'error' | 'rolled-back' | 'locked'.
// The vault must be unlocked (the whitelist is inside the encrypted check record); when it
// isn't, the reason is 'locked' so callers can ask for the password instead of blaming the
// network. rev is the whitelist's revision (0 for a vault that never had one; see vault.js).
// touch: false reads the whitelist without counting as use of the vault (see vault.getPolicy),
// so a repeating check can't keep the vault from locking when idle.
export async function networkAccess(vault, { force = false, touch = true, check = netCheck } = {}) {
  let entries;
  let rev;
  try {
    ({ entries, rev } = await vault.getPolicy({ touch }));
  } catch (err) {
    const message = err?.message || '';
    const reason = /rolled back/i.test(message) ? 'rolled-back' : /vault is locked/i.test(message) ? 'locked' : 'error';
    return { allowed: false, reason, ips: [], entries: [], rev: 0 };
  }
  rev = Number.isInteger(rev) && rev > 0 ? rev : 0;
  try {
    const result = await check.check({ entries, force });
    return { allowed: result.allowed === true, reason: result.reason, ips: result.ips || [], entries, rev };
  } catch {
    return { allowed: false, reason: 'error', ips: [], entries, rev };
  }
}

// Exports (backups, otpauth:// links, a setup QR code, and share links, which hand out codes)
// only on a whitelisted network. `make` runs only when the check allows it; otherwise (not
// listed, rolled back, locked, the check failed) nothing is made and `refused` holds the words
// to show. Returns { value, access } or { refused, access }; `access` is the networkAccess result.
export async function exportGate(vault, make, options = {}) {
  const access = await networkAccess(vault, options);
  const refused = exportRefusal(access);
  if (refused) return { refused, access };
  return { value: await make(), access };
}
