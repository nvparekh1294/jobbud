import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeEqual,
  signActionToken,
  verifyActionToken,
  actionTokenSecret,
  actionKeySource,
  actionKeyFingerprint,
  ACTION_TOKEN_DIGEST_LEN,
  ACTION_TOKEN_MAX_AGE_SECONDS,
} from '../lib/auth.mjs';

const SECRET = 'test-secret-value';

// ── safeEqual ─────────────────────────────────────────────────────────────────
test('safeEqual returns true only for identical strings', () => {
  assert.equal(safeEqual('abc123', 'abc123'), true);
  assert.equal(safeEqual('abc123', 'abc124'), false);
});

test('safeEqual returns false for unequal-length inputs without throwing', () => {
  assert.equal(safeEqual('short', 'longer-value'), false);
  assert.equal(safeEqual('', 'x'), false);
});

test('safeEqual edge case: non-string inputs are false, never throw', () => {
  assert.equal(safeEqual(undefined, 'x'), false);
  assert.equal(safeEqual('x', null), false);
  assert.equal(safeEqual(123, 123), false);
});

// ── signActionToken ───────────────────────────────────────────────────────────
test('signActionToken produces the widened digest length', () => {
  const tok = signActionToken('job1', 'applied', 1700000000, SECRET);
  assert.equal(tok.length, ACTION_TOKEN_DIGEST_LEN);
  assert.equal(ACTION_TOKEN_DIGEST_LEN, 32);
});

test('signActionToken is deterministic and secret-dependent', () => {
  const a = signActionToken('job1', 'applied', 1700000000, SECRET);
  const b = signActionToken('job1', 'applied', 1700000000, SECRET);
  const c = signActionToken('job1', 'applied', 1700000000, 'other-secret');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ── verifyActionToken (generator/verifier round-trip) ─────────────────────────
test('verifyActionToken accepts a freshly signed token', () => {
  const ts = Math.floor(Date.now() / 1000);
  const tok = signActionToken('job1', 'applied', ts, SECRET);
  assert.equal(verifyActionToken('job1', 'applied', tok, ts, SECRET), true);
});

test('verifyActionToken rejects a tampered status', () => {
  const ts = Math.floor(Date.now() / 1000);
  const tok = signActionToken('job1', 'applied', ts, SECRET);
  assert.equal(verifyActionToken('job1', 'rejected_by_me', tok, ts, SECRET), false);
});

test('verifyActionToken rejects expired and future-dated timestamps', () => {
  const now = Math.floor(Date.now() / 1000);
  const expiredTs = now - ACTION_TOKEN_MAX_AGE_SECONDS - 60;
  const futureTs = now + 3600;
  assert.equal(
    verifyActionToken('job1', 'applied', signActionToken('job1', 'applied', expiredTs, SECRET), expiredTs, SECRET),
    false,
  );
  assert.equal(
    verifyActionToken('job1', 'applied', signActionToken('job1', 'applied', futureTs, SECRET), futureTs, SECRET),
    false,
  );
});

test('verifyActionToken edge case: non-numeric ts is rejected', () => {
  assert.equal(verifyActionToken('job1', 'applied', 'anything', 'not-a-number', SECRET), false);
});

// ── actionTokenSecret resolution ──────────────────────────────────────────────
test('actionTokenSecret prefers ACTION_TOKEN_SECRET, falls back to DASHBOARD_PASSWORD', () => {
  const savedSecret = process.env.ACTION_TOKEN_SECRET;
  const savedPw = process.env.DASHBOARD_PASSWORD;
  try {
    process.env.ACTION_TOKEN_SECRET = 'dedicated';
    process.env.DASHBOARD_PASSWORD = 'dash';
    assert.equal(actionTokenSecret(), 'dedicated');
    delete process.env.ACTION_TOKEN_SECRET;
    assert.equal(actionTokenSecret(), 'dash');
  } finally {
    if (savedSecret === undefined) delete process.env.ACTION_TOKEN_SECRET;
    else process.env.ACTION_TOKEN_SECRET = savedSecret;
    if (savedPw === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = savedPw;
  }
});

// ── actionKeySource (which env var supplies the key) ──────────────────────────
// Each case saves/restores the two env vars so tests don't leak state into siblings.
function withKeyEnv(secretVal, pwVal, fn) {
  const savedSecret = process.env.ACTION_TOKEN_SECRET;
  const savedPw = process.env.DASHBOARD_PASSWORD;
  try {
    if (secretVal === undefined) delete process.env.ACTION_TOKEN_SECRET;
    else process.env.ACTION_TOKEN_SECRET = secretVal;
    if (pwVal === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = pwVal;
    return fn();
  } finally {
    if (savedSecret === undefined) delete process.env.ACTION_TOKEN_SECRET;
    else process.env.ACTION_TOKEN_SECRET = savedSecret;
    if (savedPw === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = savedPw;
  }
}

test('actionKeySource detects all three cases: dedicated, fallback, missing', () => {
  withKeyEnv('dedicated', 'dash', () => assert.equal(actionKeySource(), 'ACTION_TOKEN_SECRET'));
  withKeyEnv(undefined, 'dash', () => assert.equal(actionKeySource(), 'DASHBOARD_PASSWORD (fallback)'));
  withKeyEnv(undefined, undefined, () => assert.equal(actionKeySource(), 'MISSING'));
});

// ── actionKeyFingerprint (non-reversible key probe) ───────────────────────────
test('actionKeyFingerprint is a deterministic 8-hex fingerprint for a fixed secret', () => {
  withKeyEnv('fixed-secret', undefined, () => {
    const a = actionKeyFingerprint();
    const b = actionKeyFingerprint();
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{8}$/);
  });
});

test('actionKeyFingerprint differs across secrets', () => {
  const fpA = withKeyEnv('secret-a', undefined, () => actionKeyFingerprint());
  const fpB = withKeyEnv('secret-b', undefined, () => actionKeyFingerprint());
  assert.notEqual(fpA, fpB);
});

test('actionKeyFingerprint never equals or contains the secret', () => {
  const secret = 'super-sensitive-secret-value';
  withKeyEnv(secret, undefined, () => {
    const fp = actionKeyFingerprint();
    assert.notEqual(fp, secret);
    assert.equal(secret.includes(fp), false);
    assert.equal(fp.includes(secret), false);
  });
});

test('actionKeyFingerprint returns "none" when no secret is configured', () => {
  withKeyEnv(undefined, undefined, () => assert.equal(actionKeyFingerprint(), 'none'));
});

test('actionKeyFingerprint uses the fallback secret when only DASHBOARD_PASSWORD is set', () => {
  // Fingerprint must track whichever secret actionTokenSecret() resolves, so a
  // fallback-sourced key still produces a stable, comparable fingerprint.
  const viaFallback = withKeyEnv(undefined, 'the-key', () => actionKeyFingerprint());
  const viaDedicated = withKeyEnv('the-key', undefined, () => actionKeyFingerprint());
  assert.equal(viaFallback, viaDedicated);
  assert.match(viaFallback, /^[0-9a-f]{8}$/);
});
