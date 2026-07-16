import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, safeUrl } from '../scanner/html.mjs';

// ── esc ───────────────────────────────────────────────────────────────────────
test('esc encodes all five HTML-significant characters', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
});

test('esc neutralizes a script-tag payload', () => {
  const out = esc('<script>alert(1)</script>');
  assert.ok(!out.includes('<') && !out.includes('>'));
});

test('esc coerces null/undefined to an empty string', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('esc leaves plain text untouched', () => {
  assert.equal(esc('Head of Operations'), 'Head of Operations');
});

// ── safeUrl ───────────────────────────────────────────────────────────────────
test('safeUrl keeps an http(s) URL and encodes its ampersands', () => {
  assert.equal(safeUrl('https://jobs.example.com?a=1&b=2'), 'https://jobs.example.com?a=1&amp;b=2');
  assert.equal(safeUrl('http://x.co'), 'http://x.co');
});

test('safeUrl rejects javascript:, data:, and relative URLs', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('data:text/html,<script>'), '#');
  assert.equal(safeUrl('/dashboard'), '#');
});

test('safeUrl edge case: a quote in the URL cannot break out of the attribute', () => {
  const out = safeUrl('https://x.co" onmouseover="alert(1)');
  assert.ok(!out.includes('"'));
});

test('safeUrl edge case: null/undefined returns #', () => {
  assert.equal(safeUrl(null), '#');
  assert.equal(safeUrl(undefined), '#');
});
