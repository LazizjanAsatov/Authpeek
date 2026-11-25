import test from 'node:test';
import assert from 'node:assert/strict';
import {
  popupNotice, statusText, exportRefusal, addEntry, removeEntry, locksOutHere, isUrlEntry, alreadyFilledText,
  ALREADY_FILLED, LIST_LIMIT_TEXT, URL_ENTRY_WARNING, OLD_VERSIONS_STILL,
} from '../extension/lib/whitelist-ui.js';
import { MAX_ENTRIES, MAX_TEXT, validPolicy } from '../extension/lib/crypto.js';
import { MAX_AUTO_PER_SITE, WINDOW_MS } from '../extension/lib/attempts.js';

test('popupNotice: allowed shows nothing', () => {
  assert.equal(popupNotice({ allowed: true, reason: 'ok', ips: ['203.0.113.5'] }), null);
  assert.equal(popupNotice({ allowed: true, reason: 'off', ips: [] }), null);
});

test('popupNotice: not listed names the IP', () => {
  const n = popupNotice({ allowed: false, reason: 'not-listed', ips: ['198.51.100.7', '2001:db8::1'] });
  assert.match(n.text, /isn't in your whitelisted IPs/);
  assert.equal(n.detail, 'Your IP: 198.51.100.7, 2001:db8::1');
});

test('popupNotice: error, rolled back and unknown fail closed', () => {
  assert.match(popupNotice({ allowed: false, reason: 'error', ips: [] }).text, /Couldn't check your network/);
  assert.match(popupNotice({ allowed: false, reason: 'rolled-back' }).text, /changed without your password/);
  // There is no Save button: the way back is adding the entries again.
  assert.match(popupNotice({ allowed: false, reason: 'rolled-back' }).text, /add your entries again under Whitelisted IPs/);
  assert.doesNotMatch(popupNotice({ allowed: false, reason: 'rolled-back' }).text, /save/i);
  assert.match(popupNotice({ allowed: false, reason: 'locked' }).text, /locked/);
  assert.doesNotMatch(popupNotice({ allowed: false, reason: 'locked' }).text, /network/);
  assert.match(popupNotice(undefined).text, /Couldn't check/);
  assert.notEqual(popupNotice({ allowed: 'yes', reason: 'ok' }), null);
});

test('statusText covers every state', () => {
  assert.equal(statusText({ allowed: true, reason: 'off', ips: [] }), 'Off. Codes work on any network.');
  // With the list empty, settings looks the IP up itself and shows it.
  assert.equal(statusText({ allowed: true, reason: 'off', ips: ['203.0.113.5'] }), 'Off. Codes work on any network. Your IP: 203.0.113.5');
  assert.match(statusText({ allowed: false, reason: 'locked', ips: [] }), /^Locked/);
  assert.equal(statusText({ allowed: true, reason: 'ok', ips: ['203.0.113.5'] }), 'On a whitelisted network · 203.0.113.5');
  assert.equal(statusText({ allowed: true, reason: 'ok', ips: [] }), 'On a whitelisted network');
  assert.equal(statusText({ allowed: false, reason: 'not-listed', ips: ['198.51.100.7'] }), 'Not on a whitelisted network · 198.51.100.7');
  assert.match(statusText({ allowed: false, reason: 'error', ips: [] }), /Couldn't check/);
  assert.match(statusText({ allowed: false, reason: 'rolled-back', ips: [] }), /without your password/);
});

test('addEntry trims, keeps the note and refuses bad input', () => {
  const list = addEntry([], { value: ' 203.0.113.0/24 ', note: ' Office ' });
  assert.deepEqual(list, [{ value: '203.0.113.0/24', note: 'Office' }]);
  assert.throws(() => addEntry(list, { value: '203.0.113.0/24' }), /already on the list/);
  assert.throws(() => addEntry(list, { value: '192.168.1.1' }), /internal address/);
  assert.throws(() => addEntry(list, { value: 'http://intranet.example.com' }), /https/);
  assert.throws(() => addEntry(list, { value: '' }), /Type an IP/);
  assert.throws(() => addEntry(list, { value: '198.51.100.7', note: 'x'.repeat(201) }), /note/);
  assert.deepEqual(addEntry(list, { value: 'https://intranet.example.com' })[1], { value: 'https://intranet.example.com', note: '' });
});

test('addEntry stops at the limit', () => {
  const full = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ value: `198.51.100.${i}`, note: '' }));
  assert.throws(() => addEntry(full, { value: '203.0.113.9' }), new RegExp(`up to ${MAX_ENTRIES}`));
});

test('the limits come from crypto.js: what addEntry allows, validPolicy accepts, and the text says so', () => {
  let list = [];
  for (let i = 0; i < MAX_ENTRIES; i++) list = addEntry(list, { value: `198.51.100.${i}`, note: 'n'.repeat(MAX_TEXT) });
  assert.equal(validPolicy({ entries: list }), true);
  assert.equal(validPolicy({ entries: [...list, { value: '203.0.113.9', note: '' }] }), false);
  assert.throws(() => addEntry([], { value: '198.51.100.7', note: 'x'.repeat(MAX_TEXT + 1) }), /note/);
  assert.equal(LIST_LIMIT_TEXT, `The list couldn't be saved. It holds up to ${MAX_ENTRIES} entries of up to ${MAX_TEXT} characters.`);
});

test('isUrlEntry picks out https:// entries (they get the "opens from outside" warning)', () => {
  assert.equal(isUrlEntry('https://intranet.example.com'), true);
  assert.equal(isUrlEntry(' https://intranet.example.com/ping '), true);
  assert.equal(isUrlEntry('203.0.113.5'), false);
  assert.equal(isUrlEntry('https://203.0.113.5/'), false); // refused anyway
  assert.equal(isUrlEntry('garbage'), false);
  assert.match(URL_ENTRY_WARNING, /does NOT open from outside your network/);
  assert.match(OLD_VERSIONS_STILL, /older than 1.3 still/);
});

test('alreadyFilledText: per account, site limit, unreadable record', () => {
  const minutes = `${WINDOW_MS / 60_000} minutes`;
  assert.equal(alreadyFilledText({ ok: false, at: 5, step: 1 }), ALREADY_FILLED);
  assert.match(ALREADY_FILLED, new RegExp(`in the last ${minutes}`));
  assert.doesNotMatch(ALREADY_FILLED, /a moment ago/);
  assert.match(alreadyFilledText({ ok: false, why: 'site-limit' }), new RegExp(`${MAX_AUTO_PER_SITE} codes on this site in the last ${minutes}`));
  assert.doesNotMatch(alreadyFilledText({ ok: false, why: 'unknown' }), /ago|last/);
});

test('exportRefusal fails closed', () => {
  assert.equal(exportRefusal({ allowed: true, reason: 'off' }), null);
  assert.match(exportRefusal({ allowed: false, reason: 'rolled-back' }), /Add your entries again under Whitelisted IPs/);
  assert.match(exportRefusal({ allowed: false, reason: 'locked' }), /locked/);
  assert.equal(exportRefusal({ allowed: false, reason: 'not-listed' }), 'Not available: this network isn\'t in your whitelisted IPs.');
  assert.match(exportRefusal({ allowed: false, reason: 'error' }), /^Not available/);
  assert.match(exportRefusal({ allowed: false, reason: 'rolled-back' }), /^Not available/);
  assert.match(exportRefusal(undefined), /^Not available/);
});

test('removeEntry removes only that value', () => {
  const list = [{ value: 'a', note: '' }, { value: 'b', note: '' }];
  assert.deepEqual(removeEntry(list, 'a'), [{ value: 'b', note: '' }]);
});

test('locksOutHere warns only when it knows', () => {
  const office = [{ value: '203.0.113.0/24', note: '' }];
  assert.equal(locksOutHere(office, ['198.51.100.7']), true);
  assert.equal(locksOutHere(office, ['203.0.113.5']), false);
  assert.equal(locksOutHere(office, []), false);
  assert.equal(locksOutHere([], ['198.51.100.7']), false);
  assert.equal(locksOutHere([...office, { value: 'https://intranet.example.com', note: '' }], ['198.51.100.7']), false);
  // The first entry, with the IP from settings' own lookup: warns.
  assert.equal(locksOutHere(addEntry([], { value: '203.0.113.0/24' }), ['198.51.100.7']), true);
});

test('whitelist-ui no longer holds the gate keying helpers (moved to attempts.js)', async () => {
  const mod = await import('../extension/lib/whitelist-ui.js');
  assert.equal('fillSite' in mod, false);
  assert.equal('totpStep' in mod, false);
  assert.equal('MAX_ENTRIES' in mod, false); // defined once, in crypto.js
});
