// Popup search: every word must appear in the account's service, name, linked sites or
// learned usernames, or spell the initials of the service ("aws" → Amazon Web Services).

function initials(text) {
  const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 1 ? words.map((w) => w[0]).join('') : '';
}

export function matchesQuery(account, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [account.issuer, account.label, ...(account.sites || []), ...(account.usernames || [])]
    .join(' ')
    .toLowerCase();
  const acronym = initials(account.issuer);
  return words.every((w) => haystack.includes(w) || (acronym && acronym.startsWith(w) && w.length > 1));
}
