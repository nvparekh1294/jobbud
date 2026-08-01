// Guards for the dashboard's fail-loudly wiring.
//
// The failures these pin are all ones a real user hit: a dashboard that opened
// and then 401'd every request because the stored password was stale; a Radar
// that said "Failed to load companies." when the actual cause was a dead token;
// a watch list that said "Close this and try again" for a problem no amount of
// trying again would fix.
//
// These assert against dashboard/index.html as source text, the same way
// memoryDashboard and watchList do — the repo test suite stays dependency-free.
// So they pin the wiring (the gate verifies before unlocking, each failure path
// asks healthSentence for its area) rather than exercising the DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

// ── The gate verifies before it unlocks ───────────────────────────────────────

test('the gate verifies a password against /api/health before unlocking', () => {
  assert.match(html, /async function verifyAndUnlock\(pw, staleMessage\)/);
  // The verify step must come BEFORE unlock, not after.
  const fn = html.slice(html.indexOf('async function verifyAndUnlock'));
  const body = fn.slice(0, fn.indexOf('\n  let driveConfigured'));
  assert.ok(body.indexOf('await fetchHealth(pw)') < body.indexOf('unlock(pw)'),
    'verifyAndUnlock unlocks before it verifies');
  assert.match(body, /const auth = health\.checks\.find\(c => c\.check === 'auth'\)/);
});

test('a password that fails the auth check is never written to sessionStorage', () => {
  const fn = html.slice(html.indexOf('async function verifyAndUnlock'));
  const body = fn.slice(0, fn.indexOf('\n  let driveConfigured'));
  // Both failure branches (auth rejected, endpoint unreachable) must clear it.
  assert.equal((body.match(/sessionStorage\.removeItem\('co_pw'\)/g) || []).length, 2);
  assert.ok(!/sessionStorage\.setItem/.test(body), 'verifyAndUnlock must not store the password itself');
  // unlock() is the only writer, and it only runs after the auth check passed.
  assert.match(html, /function unlock\(pw\) \{\s*\n\s*sessionStorage\.setItem\('co_pw', pw\)/);
});

test('the click handler goes through verification, never straight to unlock', () => {
  assert.match(html, /getElementById\('pw-btn'\)\.addEventListener\('click', \(\) => \{[\s\S]{0,140}verifyAndUnlock\(pw\)/);
  assert.doesNotMatch(html, /if \(pw\) unlock\(pw\);/);
});

test('a stored password is verified on load, with its own stale wording', () => {
  assert.match(html, /const storedPw = sessionStorage\.getItem\('co_pw'\);/);
  assert.match(html, /verifyAndUnlock\(\s*\n?\s*storedPw,/);
  assert.match(html, /Your saved password no longer matches — enter the current one\./);
});

test('the boot path shows the gate before it awaits anything', () => {
  // #gate and #app both start hidden, so an await before showGate() is a blank
  // white page. Verifying a stored password costs a config probe plus the health
  // check's GitHub round-trips — seconds of white on every load.
  const boot = html.slice(html.indexOf('  (async () => {'));
  const body = boot.slice(0, boot.indexOf("getElementById('pw-btn').addEventListener"));
  assert.ok(body.indexOf("showGate('')") < body.indexOf('await fetch('),
    'the boot path awaits before it puts the gate on screen');
  // ...and the wait is accounted for, rather than looking like a hung gate.
  assert.match(body, /if \(storedPw !== null\) gatePending\(true\)/);
  assert.ok(body.indexOf('gatePending(true)') < body.indexOf('await fetch('),
    'the pending state is set after the await it is meant to cover');
  assert.match(html, /id="pw-pending"/);
});

test('an unset DASHBOARD_PASSWORD no longer skips the gate into a dead dashboard', () => {
  // The old line unlocked with an empty password whenever the config probe said
  // none was required — straight into a dashboard where api/jobs.js, which fails
  // closed, 401'd every single request.
  assert.doesNotMatch(html, /if \(!cfg\.passwordRequired\) \{ unlock\(''\); return; \}/);
});

test('the gate can show a reason, and one exists for an unreachable server', () => {
  assert.match(html, /id="pw-error"/);
  assert.match(html, /function showGate\(message\)/);
  assert.match(html, /Could not reach the server to check your password\./);
});

// ── Banner and panel ──────────────────────────────────────────────────────────

test('the banner counts failing checks and is dismissible', () => {
  assert.match(html, /Setup needs attention \(\$\{failures\.length\}\)/);
  assert.match(html, /id="setup-banner-dismiss"/);
  assert.match(html, /function dismissSetupBanner\(\)/);
  assert.match(html, /_setupBannerDismissed/);
});

test('informational checks can never raise the banner', () => {
  assert.match(html, /function healthFailures\(\)[\s\S]{0,400}filter\(c => !c\.ok && !c\.informational\)/);
});

test('the panel lists each failing check with its message and its fix', () => {
  const fn = html.slice(html.indexOf('function renderSetupPanel'));
  const body = fn.slice(0, fn.indexOf('\n  function openSetupPanel'));
  assert.match(body, /msg\.textContent = c\.message/);
  assert.match(body, /fix\.textContent = c\.fix/);
  // XSS discipline: a health message is data, never markup.
  assert.doesNotMatch(body, /innerHTML\s*\+?=\s*[^']*c\./);
  assert.match(body, /noteEl\.textContent = \(_health && _health\.note\)/);
});

test('the setup panel has a re-run button and is reachable when nothing is wrong', () => {
  assert.match(html, /id="setup-rerun-btn" onclick="rerunSetupCheck\(\)">Run setup check</);
  assert.match(html, /async function rerunSetupCheck\(\)/);
  // The banner only appears on failure, so the header button is the always-on
  // way in — a healthy user can still ask.
  assert.match(html, /id="setup-btn"[^>]*onclick="openSetupPanel\(\)"/);
});

test('a setup check that cannot even run says so rather than reporting healthy', () => {
  const fn = html.slice(html.indexOf('async function rerunSetupCheck'));
  const body = fn.slice(0, fn.indexOf('\n  // ── Password gate'));
  assert.match(body, /Could not reach the setup check itself, so nothing could be verified\./);
  assert.match(body, /ok: false/);
});

// ── Load-error paths quote the health sentence ────────────────────────────────

test('the health sentence is chosen most-specific-first per area', () => {
  assert.match(html, /const HEALTH_PRIORITY = \{/);
  for (const [area, first] of [['radar', 'data:data/radar.json'], ['jobs', 'data:data/job-status.json'], ['watchlist', 'github:repo']]) {
    assert.match(html, new RegExp(`${area}:\\s*\\[\\s*'${first.replace(/[/.]/g, m => '\\' + m)}'`),
      `${area} does not start from its most specific check`);
  }
  // Every priority list ends at auth, so a stale password is always explicable.
  assert.equal((html.match(/'auth'\],/g) || []).length, 3);
});

test('an unrelated failure is never offered as the cause of an area failure', () => {
  // ANTHROPIC_API_KEY is Coach-only. Falling back to "the first failure of any
  // kind" made an unset key the stated reason a Radar load failed, sending the
  // user to fix something that was never involved. Say nothing instead — every
  // caller already has a generic line pointing at the setup panel.
  const fn = html.slice(html.indexOf('async function healthSentence'));
  const body = fn.slice(0, fn.indexOf('\n  function renderSetupState'));
  assert.doesNotMatch(body, /healthFailures\(\)/);
  assert.match(body, /HEALTH_PRIORITY\[area\]/);
  assert.match(body, /\n\s*return '';\n\s*\}/);
});

test('Radar quotes the health sentence and keeps the generic line as a fallback only', () => {
  const fn = html.slice(html.indexOf('async function loadRadar'));
  const body = fn.slice(0, fn.indexOf('\n  // Thin wrapper over /api/radar'));
  assert.match(body, /const sentence = await healthSentence\('radar'\)/);
  assert.match(body, /loadingEl\.textContent = sentence\s*\n?\s*\|\|/);
  assert.doesNotMatch(body, /Failed to load companies\./);
});

test('the watch list quotes the health sentence instead of "try again"', () => {
  const fn = html.slice(html.indexOf('async function openWatchList'));
  const body = fn.slice(0, fn.indexOf('\n  // Prefer the Radar we already have'));
  assert.match(body, /const sentence = await healthSentence\('watchlist'\)/);
  assert.doesNotMatch(body, /Could not load your watch list\. Close this and try again\./);
});

test('a failed job load now says something on screen, not only in the console', () => {
  const fn = html.slice(html.indexOf('async function loadData'));
  const body = fn.slice(0, fn.indexOf("\n  document.getElementById('refresh-btn')"));
  assert.match(body, /const sentence = await healthSentence\('jobs'\)/);
  assert.match(body, /errEl\.textContent = text/);
  assert.match(body, /errEl\.style\.display = 'block'/);
  // ...and it clears itself on the next successful load.
  assert.match(body, /errEl\.style\.display = 'none'/);
  assert.match(html, /id="jobs-error"/);
});

test('every load-error fallback points the user at the setup check', () => {
  for (const m of html.matchAll(/Open the ⚙ setup check in the header to find out why\./g)) assert.ok(m);
  assert.equal((html.match(/Open the ⚙ setup check in the header to find out why\./g) || []).length, 3,
    'expected the last-resort sentence on all three load paths (jobs, radar, watch list)');
});

test('the setup overlay sits above every other overlay', () => {
  const setupZ = Number((html.match(/#setup-overlay \{[^}]*z-index: (\d+)/) || [])[1]);
  const radarZ = Number((html.match(/#radar-add-overlay, #radar-detail-overlay[^}]*z-index: (\d+)/) || [])[1]);
  assert.ok(setupZ > radarZ, `setup overlay z-index ${setupZ} must beat the radar overlays' ${radarZ}`);
});
