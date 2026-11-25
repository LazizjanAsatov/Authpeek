import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIp, parseEntry, isPrivate, inRange, ipFromTrace, isAllowed,
} from '../extension/lib/networks.js';

const ip = (s) => parseIp(s);
const matches = (entry, addr) => inRange(ip(addr), parseEntry(entry));

test('parseIp reads IPv4 and IPv6, rejects garbage', () => {
  assert.deepEqual(ip('203.0.113.5'), { family: 4, bytes: Uint8Array.from([203, 0, 113, 5]) });
  assert.equal(ip('2001:db8::1').family, 6);
  assert.equal(ip('2001:db8::1').bytes.length, 16);
  assert.equal(ip('256.1.1.1'), null);
  assert.equal(ip('1.2.3'), null);
  assert.equal(ip('hello'), null);
  assert.equal(ip('1::2::3'), null);
  assert.equal(ip(''), null);
});

test('IPv4-mapped IPv6 is treated as IPv4', () => {
  assert.equal(ip('::ffff:203.0.113.5').family, 4);
  assert.deepEqual(ip('::ffff:203.0.113.5').bytes, ip('203.0.113.5').bytes);
});

test('IPv4 CIDR matching', () => {
  assert.equal(matches('203.0.113.0/24', '203.0.113.200'), true);
  assert.equal(matches('203.0.113.0/24', '203.0.114.1'), false);
  assert.equal(matches('203.0.113.0/25', '203.0.113.200'), false);
});

test('IPv6 CIDR matching', () => {
  assert.equal(matches('2001:DB8::/48', '2001:db8:0:ffff::1'), true);
  assert.equal(matches('2001:DB8::/48', '2001:db8:1::1'), false);
});

test('mapped IPv6 address matches an IPv4 range', () => {
  assert.equal(matches('203.0.113.0/24', '::ffff:203.0.113.5'), true);
});

test('families never cross-match', () => {
  assert.equal(matches('2001:db8::/32', '203.0.113.5'), false);
  assert.equal(matches('203.0.113.0/24', '2001:db8::1'), false);
});

test('single IP becomes /32 or /128', () => {
  assert.equal(parseEntry('203.0.113.5').prefix, 32);
  assert.equal(parseEntry('2001:db8::1').prefix, 128);
  assert.equal(matches('203.0.113.5', '203.0.113.5'), true);
  assert.equal(matches('203.0.113.5', '203.0.113.6'), false);
});

test('parseEntry returns a range entry with the original text', () => {
  const e = parseEntry('  203.0.113.0/24 ');
  assert.equal(e.kind, 'range');
  assert.equal(e.family, 4);
  assert.equal(e.prefix, 24);
  assert.equal(e.text, '203.0.113.0/24');
});

test('private and reserved addresses are refused', () => {
  for (const t of ['192.168.1.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '127.0.0.1',
    '169.254.1.1', '100.64.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '192.168.0.0/16']) {
    assert.throws(() => parseEntry(t), /internal/, t);
  }
  assert.doesNotThrow(() => parseEntry('172.32.0.1'));
  assert.doesNotThrow(() => parseEntry('100.128.0.1'));
});

test('isPrivate', () => {
  assert.equal(isPrivate(ip('10.1.2.3')), true);
  assert.equal(isPrivate(ip('8.8.8.8')), false);
  assert.equal(isPrivate(ip('::ffff:192.168.1.1')), true);
  assert.equal(isPrivate(ip('2001:db8::1')), false);
});

test('bad prefixes and garbage are refused', () => {
  assert.throws(() => parseEntry('203.0.113.0/33'), Error);
  assert.throws(() => parseEntry('2001:db8::/129'), Error);
  assert.throws(() => parseEntry('203.0.113.0/-1'), Error);
  assert.throws(() => parseEntry('203.0.113.0/x'), Error);
  assert.throws(() => parseEntry('not an ip'), Error);
  assert.throws(() => parseEntry(''), Error);
  assert.throws(() => parseEntry('ftp://example.com'), Error);
});

test('http:// is refused, https:// becomes a url entry', () => {
  assert.throws(() => parseEntry('http://x'), /https/);
  const e = parseEntry('https://intranet.example.com');
  assert.equal(e.kind, 'url');
  assert.equal(e.url, 'https://intranet.example.com/');
  assert.equal(e.text, 'https://intranet.example.com');
  assert.equal(parseEntry('https://intranet.example.com/ping').url, 'https://intranet.example.com/ping');
  assert.throws(() => parseEntry('https://192.168.1.5/'), /IP address/);
  assert.throws(() => parseEntry('https://'), Error);
});

test('ipFromTrace reads the ip= line', () => {
  assert.equal(ipFromTrace('fl=1\nip=198.51.100.7\nts=1'), '198.51.100.7');
  assert.equal(ipFromTrace('fl=1\r\nip=2001:db8::1\r\nts=1'), '2001:db8::1');
  assert.equal(ipFromTrace('<html>'), null);
  assert.equal(ipFromTrace('ip=not-an-ip'), null);
  assert.equal(ipFromTrace(undefined), null);
});

test('isAllowed', () => {
  const range = parseEntry('203.0.113.0/24');
  const url = parseEntry('https://intranet.example.com');
  assert.equal(isAllowed({ entries: [], publicIps: [], internalOk: false }), true);
  assert.equal(isAllowed({ entries: [range], publicIps: ['203.0.113.9'], internalOk: false }), true);
  assert.equal(isAllowed({ entries: [range], publicIps: ['198.51.100.1', '203.0.113.9'], internalOk: false }), true);
  assert.equal(isAllowed({ entries: [range], publicIps: ['198.51.100.1'], internalOk: false }), false);
  assert.equal(isAllowed({ entries: [range], publicIps: [], internalOk: false }), false);
  assert.equal(isAllowed({ entries: [range, url], publicIps: [], internalOk: true }), true);
  // internalOk only counts when a url entry exists
  assert.equal(isAllowed({ entries: [range], publicIps: [], internalOk: true }), false);
  assert.equal(isAllowed({ entries: [range], publicIps: ['not-an-ip'], internalOk: false }), false);
});

test('url entries: credentials, localhost and private IPv6 hosts are refused', () => {
  assert.throws(() => parseEntry('https://user:pw@intranet.example.com/x'), /password/);
  assert.throws(() => parseEntry('https://user@intranet.example.com/'), Error);
  assert.throws(() => parseEntry('https://localhost/'), /internal/);
  assert.throws(() => parseEntry('https://app.localhost:8443/x'), /internal/);
  assert.throws(() => parseEntry('https://LOCALHOST/'), /internal/);
  assert.throws(() => parseEntry('https://[::1]/'), /IP address/);
  assert.throws(() => parseEntry('https://[fd12::1]/'), /IP address/);
  assert.throws(() => parseEntry('https://127.0.0.1:8443/'), /IP address/);
});

test('url entries: any IP host is refused, public or private, however it is spelled', () => {
  // Only a name on your own domain lets TLS prove the server is yours.
  for (const t of ['https://1.1.1.1', 'https://203.0.113.5/ping', 'https://[2001:db8::1]/', 'https://[::ffff:203.0.113.5]/',
    'https://8.8.8.8:8443/x', 'https://0x7f.1/', 'https://2130706433/', 'https://3405803781/', 'https://203.0.113.5./',
    'https://10.0.0.1/', 'https://[fe80::1]/']) {
    assert.throws(() => parseEntry(t), /uses an IP address/, t);
  }
  // Names, including single-label intranet names, are fine.
  assert.equal(parseEntry('https://intranet/').kind, 'url');
  assert.equal(parseEntry('https://vpn.corp.example:8443/health').kind, 'url');
  assert.equal(parseEntry('https://1.example.com/').kind, 'url');
});

test('inRange fails closed on malformed ranges', () => {
  const a = ip('8.8.8.8');
  const good = parseEntry('8.8.8.0/24');
  assert.equal(inRange(a, { ...good, prefix: undefined }), false);
  assert.equal(inRange(a, { ...good, prefix: -8 }), false);
  assert.equal(inRange(a, { ...good, prefix: 33 }), false);
  assert.equal(inRange(a, { ...good, prefix: 1.5 }), false);
  assert.equal(inRange(a, { ...good, bytes: new Uint8Array(3) }), false);
  assert.equal(inRange(a, { ...good, bytes: undefined }), false);
  assert.equal(inRange(a, undefined), false);
  assert.equal(inRange(null, good), false);
  assert.equal(inRange(a, good), true);
});

test('/0 matches the whole family (inRange only; parseEntry refuses it)', () => {
  const r4 = { family: 4, bytes: ip('8.8.8.8').bytes, prefix: 0 };
  const r6 = { family: 6, bytes: ip('2001:db8::').bytes, prefix: 0 };
  assert.equal(inRange(ip('8.8.8.8'), r4), true);
  assert.equal(inRange(ip('2001:db8::1'), r4), false);
  assert.equal(inRange(ip('2001:db8::1'), r6), true);
});

test('malformed IPv6 and leading zeros are not IPs', () => {
  for (const t of ['1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', ':1:2:3:4:5:6:7', '1:::2', '12345::1',
    'g::1', '::ffff:1.2.3', '1.2.3.04', '01.2.3.4', ' ', '1.2.3.4.5']) {
    assert.equal(ip(t), null, t);
  }
  assert.notEqual(ip('1:2:3:4:5:6:7:8'), null);
  assert.notEqual(ip('::'), null);
  assert.throws(() => parseEntry('010.1.1.1'), Error);
});

test('private range boundaries', () => {
  for (const t of ['172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0',
    '169.253.255.255', '192.167.255.255', '192.169.0.0', '11.0.0.0', '9.255.255.255', '128.0.0.1']) {
    assert.doesNotThrow(() => parseEntry(t), t);
  }
  for (const t of ['172.16.0.0', '172.31.255.255', '100.64.0.0', '100.127.255.255',
    '10.255.255.255', '127.255.255.255', '169.254.255.255', 'fe80::', 'febf::1', 'fdff::1']) {
    assert.throws(() => parseEntry(t), /internal/, t);
  }
  assert.doesNotThrow(() => parseEntry('fec0::1'));
  assert.doesNotThrow(() => parseEntry('fe00::1'));
});

test('url entries: trailing-dot localhost and private hosts are refused', () => {
  for (const t of ['https://localhost./', 'https://a.localhost./', 'https://LOCALHOST.:443/']) {
    assert.throws(() => parseEntry(t), /internal/, t);
  }
  assert.throws(() => parseEntry('https://192.168.1.5./'), /IP address/);
});

test('ranges that are too broad are refused', () => {
  assert.throws(() => parseEntry('8.8.8.8/0'), /too broad/);
  assert.throws(() => parseEntry('8.8.8.8/7'), /too broad/);
  assert.throws(() => parseEntry('2001:db8::/1'), /too broad/);
  assert.throws(() => parseEntry('2001:db8::/15'), /too broad/);
  assert.doesNotThrow(() => parseEntry('8.8.8.8/8'));
  assert.doesNotThrow(() => parseEntry('2001:db8::/16'));
});
