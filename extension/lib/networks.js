// "Whitelisted IPs": decides whether this computer's public IP is on the user's list.
// Pure functions only (no chrome.* and no network calls) so they run in Chrome and in Node tests.

function parseV4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    // No leading zeros: "010" is read as octal by some tools, so don't guess.
    if (!/^(0|[1-9]\d{0,2})$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseV6(text) {
  if (!text.includes(':')) return null;
  let tail = [];
  let body = text;
  // An embedded IPv4 tail (::ffff:1.2.3.4) takes the place of the last two groups.
  const lastColon = body.lastIndexOf(':');
  if (body.slice(lastColon + 1).includes('.')) {
    const v4 = parseV4(body.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    body = body.slice(0, lastColon + 1) + '0:0';
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s) => (s === '' ? [] : s.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const all = [...head, ...rest];
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  if (halves.length === 1 ? head.length !== 8 : all.length > 7) return null;
  const groups = halves.length === 1
    ? head
    : [...head, ...Array(8 - all.length).fill('0'), ...rest];
  const values = groups.map((g) => parseInt(g, 16));
  if (tail.length) { values[6] = tail[0]; values[7] = tail[1]; }
  const bytes = new Uint8Array(16);
  values.forEach((v, i) => { bytes[i * 2] = v >> 8; bytes[i * 2 + 1] = v & 255; });
  return bytes;
}

export function parseIp(text) {
  const s = String(text ?? '').trim();
  const v4 = parseV4(s);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseV6(s);
  if (!v6) return null;
  // ::ffff:a.b.c.d is just IPv4 in disguise; match it as IPv4.
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 255 && v6[11] === 255;
  return mapped ? { family: 4, bytes: v6.slice(12) } : { family: 6, bytes: v6 };
}

function bitsMatch(a, b, prefix) {
  const full = prefix >> 3;
  for (let i = 0; i < full; i++) if (a[i] !== b[i]) return false;
  const rem = prefix & 7;
  if (!rem) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (a[full] & mask) === (b[full] & mask);
}

export function inRange(ip, range) {
  // A malformed range must match nothing (fail closed), never everything.
  if (!ip || !range || ip.family !== range.family) return false;
  const size = range.family === 4 ? 4 : range.family === 6 ? 16 : 0;
  if (!size || ip.bytes?.length !== size || range.bytes?.length !== size) return false;
  if (!Number.isInteger(range.prefix) || range.prefix < 0 || range.prefix > size * 8) return false;
  return bitsMatch(ip.bytes, range.bytes, range.prefix);
}

// Addresses that only mean something on one network. Chrome can't show us this computer's
// internal IP, so listing these would never match anything.
const PRIVATE = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '::/128', '::1/128', 'fc00::/7', 'fe80::/10',
].map((c) => {
  const [addr, prefix] = c.split('/');
  return { ...parseIp(addr), prefix: Number(prefix) };
});

export function isPrivate(ip) {
  return PRIVATE.some((r) => inRange(ip, r));
}

const internalMessage = (text) =>
  `${text} is an internal address. Chrome doesn't let AuthPeek see this computer's internal IP, ` +
  `so add your office's public IP, or an https:// address that only works inside your network.`;

function parseUrlEntry(text) {
  if (/^http:\/\//i.test(text)) {
    throw new Error('Only https:// addresses can be used. Plain http:// can be faked on the network, so it can\'t prove where you are.');
  }
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`"${text}" isn't a valid address.`);
  }
  if (u.protocol !== 'https:' || !u.hostname) {
    throw new Error('Only https:// addresses can be used.');
  }
  if (u.username || u.password) {
    throw new Error('Leave the username and password out of the address. They would be saved in plain view.');
  }
  // "localhost." (trailing dot) is the same host to Chrome, so strip dots before checking.
  // The URL parser has already turned other IPv4 spellings (0x7f.1, 2130706433) into a.b.c.d.
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  // A server on this computer is always reachable, so it proves nothing about the network.
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error(internalMessage(text));
  // Any IP, public or private: only a name on your own domain lets TLS prove it's your server
  // (a private IP is the same on every network, so whoever answers there "proves" the network).
  if (parseIp(host)) {
    throw new Error(
      `${text} uses an IP address. Use your server's name instead, like https://intranet.example.com, ` +
      'so its certificate proves it\'s really your server.'
    );
  }
  return { kind: 'url', url: u.origin + u.pathname + u.search, text };
}

export function parseEntry(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('Type an IP address, a range like 203.0.113.0/24, or an https:// address.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return parseUrlEntry(text);

  const slash = text.indexOf('/');
  const addr = slash === -1 ? text : text.slice(0, slash);
  const ip = parseIp(addr);
  if (!ip) throw new Error(`"${text}" isn't an IP address. Use something like 203.0.113.5 or 203.0.113.0/24.`);

  let prefix = ip.family === 4 ? 32 : 128;
  if (slash !== -1) {
    const p = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) throw new Error(`"${p}" isn't a valid range size in "${text}".`);
    prefix = Number(p);
    // "::ffff:1.2.3.0/120" is an IPv4 range written the IPv6 way.
    if (ip.family === 4 && addr.includes(':')) prefix -= 96;
    if (prefix < 0 || prefix > ip.bytes.length * 8) {
      throw new Error(`The range size in "${text}" is too big. IPv${ip.family} ranges go up to /${ip.bytes.length * 8}.`);
    }
  }
  if (isPrivate(ip)) throw new Error(internalMessage(text));
  // A huge range would allow almost any network while the status still says "whitelisted".
  if (prefix < (ip.family === 4 ? 8 : 16)) {
    throw new Error('That range is too broad — it would allow almost any network. Use your office or VPN range, like 203.0.113.0/24.');
  }
  return { kind: 'range', family: ip.family, bytes: ip.bytes, prefix, text };
}

// Cloudflare's /cdn-cgi/trace answers with "key=value" lines, one of which is ip=...
export function ipFromTrace(text) {
  const m = /^ip=(.+?)\s*$/m.exec(String(text ?? ''));
  return m && parseIp(m[1]) ? m[1] : null;
}

// No entries means the feature is off, so everything is allowed.
// internalOk is the result of probing the user's https:// entries from the browser.
export function isAllowed({ entries, publicIps, internalOk }) {
  if (!entries.length) return true;
  const ips = publicIps.map(parseIp).filter(Boolean);
  const ranges = entries.filter((e) => e.kind === 'range');
  if (ips.some((ip) => ranges.some((r) => inRange(ip, r)))) return true;
  return Boolean(internalOk) && entries.some((e) => e.kind === 'url');
}
