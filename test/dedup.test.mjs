import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, normalizeCompany, normalizeTitle, dedupAgainstSeen } from '../scanner/dedup.mjs';

// ── normalizeCompany ──────────────────────────────────────────────────────────
test('normalizeCompany strips leading article, legal suffix, and punctuation', () => {
  assert.equal(normalizeCompany('The Acme, Inc.'), 'acme');
});

test('normalizeCompany strips a trailing LLC suffix', () => {
  assert.equal(normalizeCompany('Acme LLC'), 'acme');
});

test('normalizeCompany leaves a plain name untouched (lowercased)', () => {
  assert.equal(normalizeCompany('OpenAI'), 'openai');
});

test('normalizeCompany edge case: empty string returns empty string', () => {
  assert.equal(normalizeCompany(''), '');
});

// ── normalizeTitle ────────────────────────────────────────────────────────────
test('normalizeTitle strips a seniority prefix', () => {
  assert.equal(normalizeTitle('Senior Product Manager'), 'product manager');
});

test('normalizeTitle normalizes & to "and" so variants match', () => {
  // "VP, Strategy & Ops" and "Strategy and Ops" should collapse to the same value
  assert.equal(normalizeTitle('VP, Strategy & Ops'), 'strategy and ops');
  assert.equal(normalizeTitle('Strategy and Ops'), 'strategy and ops');
});

test('normalizeTitle strips a multi-word "Head of" prefix', () => {
  assert.equal(normalizeTitle('Head of Operations'), 'operations');
});

test('normalizeTitle edge case: empty string returns empty string', () => {
  assert.equal(normalizeTitle(''), '');
});

// ── fingerprint ───────────────────────────────────────────────────────────────
test('fingerprint ignores location — same company+title, different location, same hash', () => {
  const a = fingerprint({ company: 'Acme', title: 'Product Manager', location: 'San Francisco, CA' });
  const b = fingerprint({ company: 'Acme', title: 'Product Manager', location: '' });
  assert.equal(a, b);
});

test('fingerprint treats normalized-equivalent company/title as duplicates', () => {
  const a = fingerprint({ company: 'The Acme, Inc.', title: 'Senior Product Manager' });
  const b = fingerprint({ company: 'Acme', title: 'Product Manager' });
  assert.equal(a, b);
});

test('fingerprint distinguishes genuinely different roles', () => {
  const a = fingerprint({ company: 'Acme', title: 'Product Manager' });
  const b = fingerprint({ company: 'Acme', title: 'Data Engineer' });
  assert.notEqual(a, b);
});

test('fingerprint edge case: missing company and title still returns a 32-char hex hash', () => {
  const fp = fingerprint({});
  assert.match(fp, /^[a-f0-9]{32}$/);
});

// ── dedupAgainstSeen: in-batch leak (TASK 3) ────────────────────────────────────
test('dedupAgainstSeen drops the second occurrence of the same job within one batch', () => {
  const jobs = [
    { company: 'Acme', title: 'Product Manager', url: 'https://a.example/1' },
    { company: 'Acme', title: 'Product Manager', url: 'https://a.example/2' }, // same fp
  ];
  const { unique } = dedupAgainstSeen(jobs, {});
  assert.equal(unique.length, 1, 'only one survives an in-batch duplicate');
});

test('dedupAgainstSeen still resurfaces a prior-run scored:false entry', () => {
  const fp = fingerprint({ company: 'Acme', title: 'Product Manager' });
  const seen = {
    [fp]: {
      seenAt: new Date().toISOString(),
      title: 'Product Manager',
      company: 'Acme',
      scored: false, // seen last run but never evaluated (capped) — must re-surface
    },
  };
  const { unique } = dedupAgainstSeen(
    [{ company: 'Acme', title: 'Product Manager', url: 'https://a.example/1' }],
    seen,
  );
  assert.equal(unique.length, 1, 'a prior-run scored:false entry is re-surfaced');
  assert.equal(unique[0]._fingerprint, fp);
});

test('dedupAgainstSeen still skips a prior-run scored:true entry', () => {
  const fp = fingerprint({ company: 'Acme', title: 'Product Manager' });
  const seen = { [fp]: { seenAt: new Date().toISOString(), title: 'Product Manager', company: 'Acme', scored: true } };
  const { unique } = dedupAgainstSeen(
    [{ company: 'Acme', title: 'Product Manager', url: 'https://a.example/1' }],
    seen,
  );
  assert.equal(unique.length, 0, 'an already-scored job is not re-surfaced');
});

test('dedupAgainstSeen: an in-batch repeat of a resurfaced scored:false entry is still dropped once', () => {
  const fp = fingerprint({ company: 'Acme', title: 'Product Manager' });
  const seen = { [fp]: { seenAt: new Date().toISOString(), title: 'Product Manager', company: 'Acme', scored: false } };
  const { unique } = dedupAgainstSeen(
    [
      { company: 'Acme', title: 'Product Manager', url: 'https://a.example/1' },
      { company: 'Acme', title: 'Product Manager', url: 'https://a.example/2' },
    ],
    seen,
  );
  assert.equal(unique.length, 1, 'the resurface survives once, its in-batch twin is dropped');
});
