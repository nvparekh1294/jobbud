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

test('a password that fails the auth check is never written to storage', () => {
  const fn = html.slice(html.indexOf('async function verifyAndUnlock'));
  const body = fn.slice(0, fn.indexOf('\n  let driveConfigured'));
  // Both failure branches (auth rejected, endpoint unreachable) must clear it.
  assert.equal((body.match(/forgetPassword\(\)/g) || []).length, 2);
  assert.ok(!/rememberPassword|setItem/.test(body), 'verifyAndUnlock must not store the password itself');
  // unlock() is the only writer, and it only runs after the auth check passed.
  assert.match(html, /function unlock\(pw\) \{\s*\n\s*rememberPassword\(pw\);/);
});

test('the submit handler goes through verification, never straight to unlock', () => {
  assert.match(html, /getElementById\('pw-form'\)\.addEventListener\('submit', e => \{[\s\S]{0,200}verifyAndUnlock\(pw\)/);
  assert.doesNotMatch(html, /if \(pw\) unlock\(pw\);/);
});

test('a stored password is verified on load, with its own stale wording', () => {
  assert.match(html, /const storedPw = storedPassword\(\);/);
  assert.match(html, /verifyAndUnlock\(\s*\n?\s*storedPw,/);
  assert.match(html, /Your saved password no longer matches — enter the current one\./);
});

test('the boot path shows the gate before it awaits anything', () => {
  // #gate and #app both start hidden, so an await before showGate() is a blank
  // white page. Verifying a stored password costs a config probe plus the health
  // check's GitHub round-trips — seconds of white on every load.
  const boot = html.slice(html.indexOf('  (async () => {'));
  const body = boot.slice(0, boot.indexOf("getElementById('pw-form').addEventListener"));
  assert.ok(body.length > 0, 'the boot block could not be isolated');
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

test('overlapping health runs share one request', () => {
  // unlock() starts loadData() and loadRadar() together; when setup is broken
  // both fail and both ask healthSentence, which would otherwise fire two
  // identical /api/health runs, each with its own GitHub round-trips.
  const fn = html.slice(html.indexOf('async function fetchHealth'));
  const body = fn.slice(0, fn.indexOf('\n  function healthCheck'));
  assert.match(body, /if \(_healthInFlight && _healthInFlight\.pw === pw\) return _healthInFlight\.promise/);
  // and the handle is released on settle, so ⚙ Run setup check is never stale
  assert.match(body, /finally \{[\s\S]{0,160}_healthInFlight = null/);
});

test('the ⚙ setup button survives on mobile, because the error text points at it', () => {
  const mobile = html.slice(html.indexOf('#refresh-btn { display: none; }') - 400,
                            html.indexOf('#refresh-btn { display: none; }') + 60);
  assert.doesNotMatch(mobile, /#setup-btn \{ display: none/);
  // it is styled as a sibling of #refresh-btn rather than left unstyled
  assert.match(html, /#refresh-btn, #setup-btn \{/);
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
  // The server's note is still rendered verbatim — now alongside the
  // "Last checked at …" stamp, and still as text rather than markup.
  assert.match(body, /const note = \(_health && _health\.note\) \|\| '';/);
  assert.match(body, /noteEl\.textContent = \[stamp, note\]/);
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

// ── The setup-check button says it is working ─────────────────────────────────
//
// Live staging: the owner pressed "Run setup check" and asked "does the button
// do anything?". The button label did change, but the RESULTS area — the part
// being watched — sat unchanged through several seconds of GitHub round-trips,
// and a re-run that found the same things redrew identical text.

test('a run in flight disables the button and renames it', () => {
  const fn = html.slice(html.indexOf('async function rerunSetupCheck'));
  const body = fn.slice(0, fn.indexOf('\n  // ── Password gate'));
  assert.match(body, /btn\.disabled = true; btn\.textContent = 'Checking…'/);
  assert.match(body, /btn\.disabled = false; btn\.textContent = 'Run setup check'/);
  // Restoring it must be unconditional, so a thrown check cannot strand the
  // button disabled forever.
  assert.ok(body.indexOf('} finally {') < body.indexOf("btn.textContent = 'Run setup check'"),
    'the button is restored outside the finally block');
});

test('the results area itself says a check is running, and re-renders when done', () => {
  const fn = html.slice(html.indexOf('async function rerunSetupCheck'));
  const body = fn.slice(0, fn.indexOf('\n  // ── Password gate'));
  assert.match(body, /_healthRunning = true;\s*\n\s*renderSetupPanel\(\)/);
  assert.match(body, /_healthRunning = false;/);
  assert.match(body, /renderSetupState\(\);/);
  // The panel honours the flag rather than leaving the stale results up.
  const panel = html.slice(html.indexOf('function renderSetupPanel'));
  assert.match(panel.slice(0, 900), /if \(_healthRunning\)/);
  assert.match(panel.slice(0, 900), /Running the setup check…/);
});

test('a second click cannot start a second run', () => {
  const fn = html.slice(html.indexOf('async function rerunSetupCheck'));
  assert.match(fn.slice(0, 200), /if \(_healthRunning\) return;/);
});

test('a finished run is stamped, so an unchanged result still visibly changed', () => {
  assert.match(html, /_healthRanAt = new Date\(\)\.toLocaleTimeString/);
  assert.match(html, /Last checked at \$\{_healthRanAt\}\./);
});

// ── The saved login ───────────────────────────────────────────────────────────
//
// The password used to live in sessionStorage: gone the moment the browser
// closed, and never offered to the browser's own password manager, so there was
// nothing to retype it from either. It now persists in localStorage behind the
// same verified gate, and the gate is the shape a browser recognises as a login.

test('the gate is a real form with a password input the browser can save', () => {
  assert.match(html, /<form id="pw-form"/);
  assert.match(html, /<input type="password" id="pw-input"[^>]*autocomplete="current-password"/);
  assert.match(html, /<button type="submit" id="pw-btn"/);
  // A submitted form is what triggers the save prompt; the old click/keydown
  // pair never submitted anything.
  assert.doesNotMatch(html, /getElementById\('pw-btn'\)\.addEventListener\('click'/);
  assert.doesNotMatch(html, /getElementById\('pw-input'\)\.addEventListener\('keydown'/);
  // ...and the submit must not actually navigate away.
  const handler = html.slice(html.indexOf("getElementById('pw-form').addEventListener"));
  assert.match(handler.slice(0, 200), /e\.preventDefault\(\)/);
});

test('the password persists in localStorage, and a session-era one migrates', () => {
  const fn = html.slice(html.indexOf('function storedPassword()'));
  const body = fn.slice(0, fn.indexOf('\n  function rememberPassword'));
  assert.match(body, /localStorage\.getItem\(PW_KEY\)/);
  // The one-time fallback read, then the write that promotes it.
  assert.match(body, /sessionStorage\.getItem\(PW_KEY\)/);
  assert.match(body, /localStorage\.setItem\(PW_KEY, legacy\)/);
  assert.match(body, /sessionStorage\.removeItem\(PW_KEY\)/);
  assert.match(html, /function rememberPassword\(pw\) \{ localStorage\.setItem\(PW_KEY, pw\); \}/);
});

test('every password read goes through the helper — no direct storage reads left', () => {
  const reads = html.match(/sessionStorage\.getItem\('co_pw'\)/g) || [];
  assert.equal(reads.length, 0, 'a sessionStorage read of co_pw survived the move to localStorage');
  assert.ok((html.match(/storedPassword\(\) \|\| ''/g) || []).length > 30,
    'the request call sites should all read through storedPassword()');
});

test('logging out clears both vaults and returns to the gate', () => {
  const fn = html.slice(html.indexOf('function logOut()'));
  const body = fn.slice(0, fn.indexOf('\n  function showGate'));
  assert.match(body, /forgetPassword\(\)/);
  assert.match(body, /showGate\(''\)/);
  assert.match(body, /getElementById\('app'\)\.style\.display = 'none'/);
  // Stale health from the previous session must not leak into the next one.
  assert.match(body, /_health = null/);
  // forgetPassword clears the session-era copy too, or a logged-out browser
  // would silently log itself back in on the next load.
  const forget = html.slice(html.indexOf('function forgetPassword()'));
  const forgetBody = forget.slice(0, forget.indexOf('\n  function unlock'));
  assert.match(forgetBody, /localStorage\.removeItem\(PW_KEY\)/);
  assert.match(forgetBody, /sessionStorage\.removeItem\(PW_KEY\)/);
  assert.match(html, /id="logout-btn"[^>]*onclick="logOut\(\)"/);
});

test('persistence did not weaken the verified gate', () => {
  // The stored password is still re-verified on every load before anything
  // unlocks — that check is the whole reason keeping it around is safe.
  const boot = html.slice(html.indexOf('  (async () => {'));
  const body = boot.slice(0, boot.indexOf("getElementById('pw-form').addEventListener"));
  assert.match(body, /if \(storedPw !== null\) \{\s*\n\s*await verifyAndUnlock\(/);
  assert.match(body, /Your saved password no longer matches — enter the current one\./);
});
