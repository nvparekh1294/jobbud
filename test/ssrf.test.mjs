import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, isBlockedHostname, assertPublicHttpUrl } from '../lib/ssrf.mjs';

// ── isPrivateIp ───────────────────────────────────────────────────────────────
test('isPrivateIp flags loopback, private, link-local, and metadata IPv4', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test('isPrivateIp allows public IPv4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('isPrivateIp flags IPv6 loopback, ULA, link-local, and mapped-private', () => {
  for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test('isPrivateIp edge case: a non-IP string is treated as private (fail closed)', () => {
  assert.equal(isPrivateIp('not-an-ip'), true);
  assert.equal(isPrivateIp(''), true);
});

// ── isBlockedHostname ─────────────────────────────────────────────────────────
test('isBlockedHostname blocks localhost and internal suffixes', () => {
  for (const h of ['localhost', 'db.localhost', 'foo.internal', 'printer.local', 'metadata.google.internal']) {
    assert.equal(isBlockedHostname(h), true, h);
  }
});

test('isBlockedHostname blocks private IP literals, including bracketed IPv6', () => {
  assert.equal(isBlockedHostname('127.0.0.1'), true);
  assert.equal(isBlockedHostname('[::1]'), true);
});

test('isBlockedHostname allows normal public hostnames', () => {
  for (const h of ['jobs.example.com', 'boards.greenhouse.io', 'example.co.uk']) {
    assert.equal(isBlockedHostname(h), false, h);
  }
});

// ── assertPublicHttpUrl (synchronous rejection paths — no DNS/network) ─────────
test('assertPublicHttpUrl rejects non-http protocols', async () => {
  await assert.rejects(assertPublicHttpUrl('file:///etc/passwd'), /http and https/);
  await assert.rejects(assertPublicHttpUrl('ftp://example.com'), /http and https/);
});

test('assertPublicHttpUrl rejects an internal host before any fetch', async () => {
  await assert.rejects(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'), /not allowed/);
  await assert.rejects(assertPublicHttpUrl('http://localhost:3000/admin'), /not allowed/);
  await assert.rejects(assertPublicHttpUrl('http://[::1]/'), /not allowed/);
});

test('assertPublicHttpUrl rejects a malformed URL', async () => {
  await assert.rejects(assertPublicHttpUrl('not a url'), /Invalid URL/);
});
