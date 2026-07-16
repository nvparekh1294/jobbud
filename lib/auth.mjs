// Shared auth helpers: constant-time credential comparison and email-action
// token signing/verification. Imported by both the Vercel API functions (api/*.js)
// and the scanner generators (scanner/*.mjs) so signing and verification never
// drift apart. Vercel bundles each function separately, so this MUST stay a plain
// imported module, never an API route.

import crypto from 'crypto';

// Constant-time string comparison. Returns false for non-strings or
// unequal-length inputs (which crypto.timingSafeEqual would otherwise throw on),
// and only reaches timingSafeEqual for equal-length buffers. Comparing lengths
// first leaks length but not content — acceptable for fixed-length secrets/tokens.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Email-action tokens expire 72h after issue. The ts travels in the URL so we can
// re-derive the HMAC and reject anything older than this or dated in the future.
export const ACTION_TOKEN_MAX_AGE_SECONDS = 72 * 60 * 60;

// Widened HMAC digest length for action tokens (previously 16 hex chars / 64 bits).
export const ACTION_TOKEN_DIGEST_LEN = 32; // 128 bits

// Secret used to sign email-action links. Prefer a dedicated ACTION_TOKEN_SECRET
// so action links no longer reuse the dashboard password; fall back to
// DASHBOARD_PASSWORD so the feature keeps working until the new var is set.
export function actionTokenSecret() {
  return process.env.ACTION_TOKEN_SECRET || process.env.DASHBOARD_PASSWORD || '';
}

// Sign an email-action token over jobId+status+ts. Generators and the verifier
// both call this so the digest length and update string stay identical.
export function signActionToken(jobId, status, ts, secret = actionTokenSecret()) {
  return crypto
    .createHmac('sha256', secret)
    .update(String(jobId) + String(status) + String(ts))
    .digest('hex')
    .slice(0, ACTION_TOKEN_DIGEST_LEN);
}

// Verify an email-action token: ts must be numeric and within the age window
// (not expired, not future-dated), and the HMAC must match in constant time.
export function verifyActionToken(jobId, status, token, ts, secret = actionTokenSecret()) {
  if (!ts || !/^\d+$/.test(String(ts))) return false;
  const tsNum = parseInt(String(ts), 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - tsNum;
  if (ageSeconds < 0 || ageSeconds > ACTION_TOKEN_MAX_AGE_SECONDS) return false;
  const expected = signActionToken(jobId, status, tsNum, secret);
  return safeEqual(String(token), expected);
}

// Which env var currently supplies the action-token key, for diagnostics only.
// Returns the source NAME, never the value: "ACTION_TOKEN_SECRET" when the
// dedicated var is set, "DASHBOARD_PASSWORD (fallback)" when only the fallback is
// set, or "MISSING" when neither is configured. Logging this on both the mint side
// (GitHub Actions) and verify side (Vercel) makes a half-applied secret rotation —
// where the two stores disagree on which var holds the key — visible at a glance.
export function actionKeySource() {
  if (process.env.ACTION_TOKEN_SECRET) return 'ACTION_TOKEN_SECRET';
  if (process.env.DASHBOARD_PASSWORD) return 'DASHBOARD_PASSWORD (fallback)';
  return 'MISSING';
}

// Non-reversible 8-hex-char fingerprint of the active action-token key. Computed as
// the first 8 hex chars of HMAC-SHA256(secret, "jobbud-key-probe"): it changes iff
// the secret changes, cannot be reversed to the secret, and never equals or contains
// the secret — so it is safe to print in CI/function logs. Comparing the mint-side
// and verify-side fingerprints pinpoints a key desync in seconds. Returns "none"
// when no secret is configured.
export function actionKeyFingerprint() {
  const secret = actionTokenSecret();
  if (!secret) return 'none';
  return crypto
    .createHmac('sha256', secret)
    .update('jobbud-key-probe')
    .digest('hex')
    .slice(0, 8);
}
