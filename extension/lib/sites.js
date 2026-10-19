// Which accounts belong to which website.
// Auto-fill only ever uses sites the user explicitly linked; issuer-name guesses are
// shown as suggestions in the popup, never filled automatically (phishing protection).

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export const siteForHost = (host) => host.replace(/^www\./, '');

export function siteMatches(site, host) {
  return host === site || host.endsWith(`.${site}`);
}

export function accountsForHost(accounts, host) {
  return accounts.filter((a) => (a.sites || []).some((s) => siteMatches(s, host)));
}

function issuerTokens(issuer) {
  const words = String(issuer || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = new Set();
  if (words.length) tokens.add(words.join(''));
  if (words[0]?.length >= 3) tokens.add(words[0]);
  return tokens;
}

export function suggestedAccounts(accounts, host) {
  const labels = new Set(host.split(/[.-]/));
  const linked = new Set(accountsForHost(accounts, host).map((a) => a.id));
  return accounts.filter((a) => !linked.has(a.id) && [...issuerTokens(a.issuer)].some((t) => labels.has(t)));
}
