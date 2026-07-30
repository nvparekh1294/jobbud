// Two UI bugs reported against the Radar, pinned so they cannot come back.
//
// 1. "On your radar" suggestions for companies with no link told the user to
//    "Add their careers page link on the Radar card first". That was a dead end
//    AND wrong: the Radar card's url field is the company HOMEPAGE (its
//    placeholder is https://anthropic.com), so following the instruction would
//    have put the wrong URL on the watch list.
// 2. Every radar overlay shared z-index 200, so the Edit form — opened FROM the
//    detail view — was painted over by the detail overlay that comes later in
//    the DOM. The button looked dead.
//
// Asserted against source, as elsewhere in this suite; the interactive walk ran
// under jsdom against this same file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

const suggestionFn = () => {
  const fn = html.slice(html.indexOf('function watchListRenderSuggestions'));
  return fn.slice(0, fn.indexOf('\n  // Save: same two steps'));
};

// ── 1. Inline careers-link input on the suggestion row ────────────────────────

test('the dead-end "add it on the Radar card first" note is gone', () => {
  assert.doesNotMatch(html, /Add their careers page link on the Radar card first/);
});

test("the Radar card's url really is a homepage, which is why the note was wrong", () => {
  // If this placeholder ever becomes a careers URL, the premise of this fix
  // changes and the comment in watchListRenderSuggestions needs revisiting.
  assert.match(html, /id="rc-url"[^>]*placeholder="https:\/\/anthropic\.com"/);
});

test('a suggestion with no link offers an inline careers-link input', () => {
  const body = suggestionFn();
  assert.match(body, /input\.className = 'wl-sug-url'/);
  assert.match(body, /input\.placeholder = 'Careers page link — https:\/\/…'/);
  assert.match(body, /input\.setAttribute\('aria-label'/);
});

test('Add stays disabled until the typed link is http(s)', () => {
  const body = suggestionFn();
  assert.match(body, /const valid = \(\) => \/\^https\?:\\\/\\\/\/i\.test\(input\.value\.trim\(\)\)/);
  assert.match(body, /const sync = \(\) => \{ btn\.disabled = !valid\(\); \}/);
  assert.match(body, /input\.addEventListener\('input', sync\)/);
  // sync() runs once at build time so the button starts disabled, not enabled.
  assert.match(body, /sync\(\);/);
  // And the click itself re-checks, so a programmatic click cannot slip through.
  assert.match(body, /btn\.onclick = \(\) => \{ if \(valid\(\)\) accept\(input\.value\.trim\(\)\); \}/);
});

test('an accepted inline link goes through the same path as a manual row', () => {
  const body = suggestionFn();
  // One accept() for both branches — the linked one-click case and the typed
  // case land in watchListAddRow, which is what saveWatchList() reads and what
  // generate-portals then runs job-board detection over.
  assert.match(body, /const accept = \(careersUrl\) => \{\s*\n\s*watchListAddRow\(name, careersUrl\);/);
  assert.equal((body.match(/watchListAddRow\(/g) || []).length, 1, 'accept() should be the only caller');
  assert.match(body, /btn\.onclick = \(\) => accept\(url\)/);
});

test('the suggestion row keeps its textContent/XSS discipline', () => {
  const body = suggestionFn();
  assert.match(body, /nameEl\.textContent = name;/);
  // The only innerHTML in this function is the unconditional list reset.
  assert.equal((body.match(/innerHTML/g) || []).length, 1);
  assert.match(body, /list\.innerHTML = '';/);
});

// ── 2. Edit from the detail view ──────────────────────────────────────────────

test('opening Edit from the detail view closes the detail view first', () => {
  const fn = html.slice(html.indexOf('function editCompanyFromDetail'));
  const body = fn.slice(0, fn.indexOf('\n  // ── Contact add/edit form'));
  assert.match(body, /closeCompanyDetail\(\);/);
  assert.ok(
    body.indexOf('closeCompanyDetail()') < body.indexOf("getElementById('radar-add-overlay').classList.add('open')"),
    'the detail overlay must be closed before the edit form is opened',
  );
});

test('the add/edit overlay also outranks the other radar overlays on z-index', () => {
  const shared = Number((html.match(/#radar-add-overlay, #radar-detail-overlay[^}]*z-index: (\d+)/) || [])[1]);
  const add = Number((html.match(/#radar-add-overlay \{ z-index: (\d+); \}/) || [])[1]);
  assert.ok(Number.isFinite(shared) && Number.isFinite(add), 'both z-index rules must exist');
  assert.ok(add > shared, `#radar-add-overlay (${add}) must beat the shared radar overlay z-index (${shared})`);
});
