// Refreshes the logo table in extension/lib/logos.js from Simple Icons (CC0 1.0).
// Only the block between the @generated markers is rewritten; the matching code around it is
// hand-written. Run with `node scripts/build-logos.mjs`; no npm packages, just fetch().
// Simple Icons removes an icon when its trademark owner asks (Amazon, Microsoft, Slack, LinkedIn,
// Nintendo, Xbox, Heroku, OpenAI, Salesforce, Twilio, Oracle, Adobe, IBM, Canva, ...). We respect
// that and don't fetch them from older releases: those accounts get the monogram instead.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CDN = 'https://cdn.simpleicons.org';
const OUT = resolve('extension/lib/logos.js');
const BUDGET = 250 * 1024; // the popup imports this file on every open
const START = '// @generated-start';
const END = '// @generated-end';

// Services people most often have 2FA on. Order does not matter; the table is sorted.
// Names must be Simple Icons slugs (see https://simpleicons.org): lowercase, no punctuation,
// "." spelled "dot" (battledotnet, bookingdotcom).
const SLUGS = `
  github google apple facebook instagram x discord steam dropbox
  stripe paypal coinbase binance kraken cloudflare namecheap godaddy reddit twitch epicgames
  playstation shopify digitalocean vercel netlify gitlab bitbucket atlassian jira
  notion figma zoom protonmail proton 1password bitwarden lastpass okta auth0 wordpress
  mailchimp sendgrid hetzner ovh linode vultr npm pypi rubygems docker anthropic
  huggingface telegram whatsapp signal tiktok snapchat pinterest tumblr mastodon bluesky ubisoft ea
  battledotnet riotgames rockstargames patreon kofi buymeacoffee substack medium wise revolut n26
  robinhood etrade ebay etsy aliexpress squarespace wix hostinger bluehost mega box icloud evernote
  trello asana basecamp hubspot zendesk intercom freshdesk cloudinary backblaze tailscale
  nordvpn expressvpn mullvad protonvpn pihole homeassistant synology qnap ubiquiti plex jellyfin
  spotify soundcloud netflix disneyplus hulu uber airbnb bookingdotcom expedia
  yahoo zoho fastmail tuta googlecloud firebase supabase mongodb porkbun
  stackoverflow hackerone sentry datadog pagerduty jetbrains youtube roblox
  gogdotcom humblebundle itchdotio unity kickstarter venmo cashapp klarna bybit okx kucoin ledger
  trezor metamask teamviewer anydesk dashlane keeper nordpass yubico nextcloud gitea codeberg mozilla
  brave sourceforge proxmox truenas wikipedia dribbble behance vimeo kick
`.split(/\s+/).filter(Boolean);

// The CDN puts the brand colour on the <svg> as fill.
function parseSvg(slug, svg) {
  const fill = svg.match(/ fill="#([0-9A-Fa-f]{6})"/)?.[1];
  const title = svg.match(/<title>(.*?)<\/title>/)?.[1];
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  if (!fill || !title || paths.length !== 1) return { slug, error: 'unexpected SVG shape' };
  return { slug, title: decodeEntities(title), hex: fill.toUpperCase(), path: paths[0] };
}

async function fetchIcon(slug) {
  const res = await fetch(`${CDN}/${slug}`);
  if (!res.ok) return { slug, error: `HTTP ${res.status}` };
  return parseSvg(slug, await res.text());
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// A few at a time: the CDN is happy with it and the output stays deterministic (sorted later).
async function fetchAll(slugs, parallel = 8) {
  const results = [];
  for (let i = 0; i < slugs.length; i += parallel) {
    results.push(...(await Promise.all(slugs.slice(i, i + parallel).map(fetchIcon))));
  }
  return results;
}

const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
// A slug like 1password cannot be a bare object key.
const key = (slug) => (/^[a-z]/.test(slug) ? slug : quote(slug));

async function main() {
  const unique = [...new Set(SLUGS)].sort();
  const pkg = await (await fetch('https://cdn.jsdelivr.net/npm/simple-icons/package.json')).json();
  const results = await fetchAll(unique);
  const icons = results.filter((r) => !r.error);
  for (const r of results.filter((r) => r.error)) console.warn(`skipped ${r.slug}: ${r.error}`);

  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    START,
    `// Simple Icons ${pkg.version} via ${CDN}, fetched ${date} by scripts/build-logos.mjs.`,
    '// Do not edit by hand.',
    'export const LOGOS = Object.freeze({',
    ...icons.map((i) => `  ${key(i.slug)}: Object.freeze({ title: ${quote(i.title)}, hex: '${i.hex}', path: '${i.path}' }),`),
    '});',
    END,
  ];

  const current = readFileSync(OUT, 'utf8');
  const from = current.indexOf(START);
  const to = current.indexOf(END);
  if (from < 0 || to < from) throw new Error(`${OUT} has no ${START} / ${END} block to fill`);
  const next = current.slice(0, from) + lines.join('\n') + current.slice(to + END.length);
  writeFileSync(OUT, next);

  const size = Buffer.byteLength(next);
  console.log(`${icons.length} logos written to ${OUT} (${(size / 1024).toFixed(1)} KB)`);
  const big = icons.filter((i) => i.path.length > 2048).sort((a, b) => b.path.length - a.path.length);
  console.log(`paths over 2 KB: ${big.map((i) => `${i.slug} ${i.path.length}`).join(', ') || 'none'}`);
  if (size > BUDGET) {
    console.error(`logos.js is over the ${BUDGET / 1024} KB budget; drop the least common slugs from SLUGS`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
