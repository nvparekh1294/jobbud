// Tests for HOW a failed save is delivered to the user.
//
// THE BUG THIS COVERS. lib/github.js learned to say WHY a repo write failed, and
// the dashboard then handed those sentences to `showToast`:
//
//     showToast(d.error || 'Could not save to your repo. ...');
//
// `showToast` defaults to 3000ms. `.toast` is `position:fixed; left:50%;
// transform:translateX(-50%)`, has no max-width, and sets `pointer-events:none`.
// The GH_WRITE_FORBIDDEN string is ~450 characters containing two GitHub
// navigation paths and three Vercel steps. So the user this whole diagnostic
// exists for was finally told why their save failed — and then given three
// seconds to memorise an instruction they could not select, could not copy, and
// could not scroll.
//
// The server-side work was right; the channel could not carry it. So the typed
// failures now render into PERSISTENT, SELECTABLE inline elements beside the
// button that failed, with the cause and the steps as separate parts. Toasts
// keep the short success and confirmation lines.
//
// WHAT THESE TESTS PROTECT:
//   - the long typed failures never go out on a toast, at ANY call site;
//   - every such site has a persistent inline element, next to its own button;
//   - that element is selectable (no pointer-events:none) and ships empty;
//   - the cause and the fix render as distinct nodes, as text and not markup;
//   - the short success/confirmation toasts are left alone.
//
// The logic is inline JS in dashboard/index.html, so renderSaveFailure is
// extracted from source and executed against stub DOM — same brace-walk as the
// other dashboard tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFailure, githubWriteErrorResponse } from '../lib/github.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

function extractFunction(source, name) {
  const startIdx = source.search(new RegExp(`(async )?function ${name}\\b`));
  assert.notEqual(startIdx, -1, `dashboard is missing function ${name}`);
  const parenStart = source.indexOf('(', startIdx);
  let parenDepth = 0, i = parenStart;
  for (; i < source.length; i++) {
    if (source[i] === '(') parenDepth++;
    else if (source[i] === ')') { parenDepth--; if (parenDepth === 0) break; }
  }
  const braceStart = source.indexOf('{', i);
  let depth = 0;
  for (let j = braceStart; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(startIdx, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Element stub recording what was rendered into it, child by child.
function stubEl() {
  const el = {
    className: '',
    style: { display: 'none' },
    children: [],
    appendChild(node) { el.children.push(node); return node; },
    set textContent(v) { if (!v) el.children.length = 0; },
    get textContent() { return el.children.map(c => c.textContent).join('\n'); },
  };
  return el;
}

// renderSaveFailure + clearSaveFailure, running against the stub DOM.
function sandbox() {
  const el = stubEl();
  const document = {
    getElementById: () => el,
    createElement: () => ({ className: '', textContent: '' }),
  };
  const body = [
    extractFunction(html, 'renderSaveFailure'),
    extractFunction(html, 'clearSaveFailure'),
  ].join('\n\n');
  const factory = new Function('document', `
    ${body}
    return {
      render: (data, fallback) => renderSaveFailure(document.getElementById('x'), data, fallback),
      clear: () => clearSaveFailure(document.getElementById('x')),
    };
  `);
  return { api: factory(document), el };
}

// The real GH_WRITE_FORBIDDEN body, straight from lib/github.js — no hand-copied
// prose, so this test keeps tracking the copy if it is reworded.
const FORBIDDEN = githubWriteErrorResponse(
  writeFailure('blob create', 403, '{"message":"Resource not accessible by personal access token"}', undefined, 'detail'),
).body;

// ── The thing that made a toast the wrong channel ─────────────────────────────

test('the typed write failure really is far too long for a 3-second toast', () => {
  // Not an assertion about the dashboard — it is the premise everything below
  // rests on, pinned so a future shortening of the copy is a visible decision.
  assert.ok(FORBIDDEN.error.length > 300, `expected a long instruction, got ${FORBIDDEN.error.length} chars`);
  assert.match(FORBIDDEN.fix, /Vercel/);
  assert.match(FORBIDDEN.fix, /GitHub/);
});

test('the toast is still a 3-second, unselectable, unbounded strip', () => {
  // The reason the long failures had to leave it. If any of this changes, the
  // decision below is worth revisiting rather than silently inheriting.
  const toastCss = /\.toast\{([^}]*)\}/.exec(html);
  assert.ok(toastCss, '.toast rule not found');
  assert.match(toastCss[1], /pointer-events:none/);
  assert.doesNotMatch(toastCss[1], /max-width/);
  assert.match(extractFunction(html, 'showToast'), /duration === undefined\) \? 3000/);
});

// ── renderSaveFailure ─────────────────────────────────────────────────────────

test('the cause and the fix render as two distinct nodes', () => {
  const { api, el } = sandbox();
  api.render(FORBIDDEN, 'fallback');
  assert.equal(el.children.length, 2, 'cause + fix');
  assert.equal(el.children[0].textContent, FORBIDDEN.userMessage);
  assert.equal(el.children[1].textContent, FORBIDDEN.fix);
  // The fix line reuses the Setup Check panel's own class rather than inventing
  // a visual language for this panel.
  assert.equal(el.children[1].className, 'setup-fix');
});

test('the panel is shown, and shown with an explicit display value', () => {
  // Several of these elements are hidden by a CSS rule (.wl-error), not an
  // inline style, so clearing the inline value would leave them invisible.
  const { api, el } = sandbox();
  api.render(FORBIDDEN, 'fallback');
  assert.equal(el.style.display, 'block');
});

test('it stays rendered — nothing schedules its removal', () => {
  const render = extractFunction(html, 'renderSaveFailure');
  assert.doesNotMatch(render, /setTimeout|setInterval/, 'the notice must not time out');
  assert.doesNotMatch(render, /showToast/, 'it must not also fire a toast');
});

test('a body with only the joined `error` (an older deployment) renders once, not twice', () => {
  const { api, el } = sandbox();
  api.render({ error: `${FORBIDDEN.userMessage} ${FORBIDDEN.fix}`, fix: FORBIDDEN.fix }, 'fallback');
  assert.equal(el.children.length, 1, 'the fix is already inside error — do not repeat it underneath');
  assert.match(el.children[0].textContent, /Contents: Read and write/);
});

test('a body with no usable text falls back, and a null body does too', () => {
  for (const data of [null, undefined, {}, 'not an object', 42]) {
    const { api, el } = sandbox();
    api.render(data, 'Could not save. Use the download buttons instead.');
    assert.equal(el.children.length, 1, JSON.stringify(data));
    assert.equal(el.children[0].textContent, 'Could not save. Use the download buttons instead.');
    assert.equal(el.style.display, 'block');
  }
});

test('a plain {message} body (the Story Bank shape) still renders', () => {
  const { api, el } = sandbox();
  api.render({ message: 'Save failed.' }, 'fallback');
  assert.equal(el.children[0].textContent, 'Save failed.');
});

test('clearSaveFailure empties and hides it, so a stale reason never outlives a retry', () => {
  const { api, el } = sandbox();
  api.render(FORBIDDEN, 'fallback');
  api.clear();
  assert.equal(el.children.length, 0);
  assert.equal(el.style.display, 'none');
});

test('a missing element is a no-op in both directions, not a crash', () => {
  const body = [
    extractFunction(html, 'renderSaveFailure'),
    extractFunction(html, 'clearSaveFailure'),
  ].join('\n\n');
  const factory = new Function(`
    ${body}
    return {
      render: () => renderSaveFailure(null, { error: 'x' }, 'f'),
      clear: () => clearSaveFailure(null),
    };
  `);
  const api = factory();
  assert.doesNotThrow(api.render);
  assert.doesNotThrow(api.clear);
});

test("the server's sentences are rendered as DATA, never as markup", () => {
  const render = extractFunction(html, 'renderSaveFailure');
  assert.match(render, /msg\.textContent = cause/);
  assert.match(render, /fix\.textContent = d\.fix/);
  assert.doesNotMatch(render, /innerHTML\s*=/);
  assert.doesNotMatch(render, /insertAdjacentHTML|outerHTML\s*=/);
});

// ── Every call site that can receive a typed failure ──────────────────────────
//
// The contract per site: a persistent element that ships empty and hidden, and a
// handler that routes the response body into it rather than into showToast.

const SITES = [
  {
    what: 'onboarding "Save to my repo"',
    fn: 'onboardingSaveToRepo',
    elementId: 'onboarding-save-error',
    renders: /showSaveFailureAt\(errorId,/,
    // Where the button is. The notice has to be next to it, not somewhere else.
    nearButtonId: 'onboarding-save-repo-btn',
  },
  {
    what: 'the leave-confirmation "Save to my repo"',
    fn: 'onboardingSaveToRepo',
    elementId: 'onboarding-confirm-save-error',
    renders: /showSaveFailureAt\(errorId,/,
    nearButtonId: 'onboarding-confirm-save-btn',
  },
  {
    what: 'the Memory tab Save',
    fn: 'saveMemoryFile',
    elementId: 'memory-error-profile',
    renders: /showSaveFailureAt\(errorId,/,
    nearButtonId: null,
  },
  {
    what: 'the Story Bank draft Save',
    fn: 'saveStory',
    elementId: 'draft-save-error',
    renders: /showSaveFailureAt\('draft-save-error',/,
    nearButtonId: 'draft-save-btn',
  },
  {
    what: 'the story delete',
    fn: 'executeDeleteStory',
    elementId: 'story-delete-error',
    renders: /showSaveFailureAt\('story-delete-error',/,
    nearButtonId: null,
  },
  {
    what: 'the story edit modal Save',
    fn: 'saveEditedStory',
    elementId: 'story-edit-error',
    renders: /renderSaveFailure\(errorEl,/,
    nearButtonId: 'story-edit-save-btn',
  },
  {
    what: 'the watch-list Save',
    fn: 'saveWatchList',
    elementId: 'wl-error',
    renders: /watchListShowSaveFailure\(saved,/,
    nearButtonId: 'wl-save-btn',
  },
  {
    what: 'Apply to search profile',
    fn: 'applyMemoryToProfile',
    elementId: 'apply-profile-result',
    renders: /renderSaveFailure\(result,/,
    nearButtonId: 'apply-profile-btn',
  },
  {
    // api/coach.js wired githubWriteErrorResponse into save-mock-session, but the
    // client did `if (!res.ok) throw new Error(...)` and never read the body —
    // so every curated sentence was written server-side and discarded.
    what: 'the mock-session save',
    fn: 'saveMockSession',
    elementId: 'mock-save-error',
    renders: /showSaveFailureAt\('mock-save-error',/,
    nearButtonId: null,
  },
];

for (const site of SITES) {
  test(`${site.what}: its notice element exists, ships EMPTY, and starts hidden`, () => {
    const re = new RegExp(`<div[^>]*id="${site.elementId}"[^>]*>([\\s\\S]*?)</div>`);
    const m = re.exec(html);
    assert.ok(m, `no element with id ${site.elementId}`);
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    // Hidden to start with, by an inline style or by its own CSS rule
    // (#wl-error predates this and is hidden by `.wl-error { display: none }`).
    const hiddenInline = /display:\s*none/.test(tag);
    const hiddenByCss = new RegExp(`\\.${site.elementId}\\s*\\{[^}]*display:\\s*none`).test(html)
      || /\.wl-error\s*\{[^}]*display:\s*none/.test(html) && site.elementId === 'wl-error';
    assert.ok(hiddenInline || hiddenByCss, `${site.elementId} must start hidden`);
    assert.equal(m[1].trim(), '', 'it must ship empty — no hardcoded accusation');
  });

  test(`${site.what}: the handler renders into it instead of calling showToast with the body`, () => {
    const fn = extractFunction(html, site.fn);
    // It writes the failure into the inline element...
    assert.match(fn, site.renders, `${site.fn} must render the failure inline`);
    // ...and never hands a response body to a toast. `d.error`, `data.error`,
    // `data.message` and friends inside a showToast() call are exactly the bug.
    const toastCalls = fn.match(/showToast\([^;]*/g) || [];
    for (const call of toastCalls) {
      assert.doesNotMatch(
        call,
        /\b[a-z]+\.(error|message|fix|userMessage)\b/,
        `${site.fn} routes a response body through a toast: ${call.slice(0, 120)}`,
      );
    }
  });

  if (site.nearButtonId) {
    test(`${site.what}: the notice sits with its own button, not elsewhere in the page`, () => {
      // Same enclosing step/panel/modal: no step panel or modal boundary between
      // the button and the notice, in either order.
      const btnIdx = html.indexOf(`id="${site.nearButtonId}"`);
      const elIdx = html.indexOf(`id="${site.elementId}"`);
      assert.ok(btnIdx !== -1 && elIdx !== -1);
      const between = html.slice(Math.min(btnIdx, elIdx), Math.max(btnIdx, elIdx));
      assert.doesNotMatch(
        between,
        /id="onboarding-step-|class="story-modal-overlay"|class="view"/,
        `${site.elementId} is separated from ${site.nearButtonId} by a panel boundary`,
      );
    });
  }
}

// ── Selectability: the point of the whole change ──────────────────────────────

test('no save-failure panel is unselectable or clipped the way the toast was', () => {
  const rule = /\.save-failure\s*\{([^}]*)\}/.exec(html);
  assert.ok(rule, '.save-failure rule not found');
  assert.doesNotMatch(rule[1], /pointer-events\s*:\s*none/, 'the text must be selectable to be copied');
  assert.match(rule[1], /user-select\s*:\s*text/);
  // Wide enough to read, bounded so a long fix does not run the page off-screen.
  assert.match(rule[1], /max-width/);
  assert.match(rule[1], /overflow-y\s*:\s*auto/);
});

test('every save-failure element carries the shared class, so none of them can drift', () => {
  for (const id of ['onboarding-save-error', 'onboarding-confirm-save-error', 'memory-error-profile',
    'memory-error-voice', 'memory-error-stories', 'draft-save-error', 'story-delete-error',
    'story-edit-error', 'wl-error', 'apply-profile-result', 'mock-save-error',
    'onboarding-write-warning']) {
    const m = new RegExp(`<div[^>]*\\bid="${id}"[^>]*>`).exec(html);
    assert.ok(m, `no div with id ${id}`);
    assert.match(m[0], /class="[^"]*\bsave-failure\b/, `${id} is missing the save-failure class`);
  }
});

// ── The mock-session save read its response body ──────────────────────────────

test('saveMockSession reads the response body instead of throwing the status away', () => {
  const fn = extractFunction(html, 'saveMockSession');
  assert.match(fn, /await res\.json\(\)/, 'the curated sentence lives in the body');
  // The exact line that made the server-side wiring dead code.
  assert.doesNotMatch(fn, /if \(!res\.ok\) throw new Error\(`HTTP \$\{res\.status\}`\)/);
  // The short status line in the 12px button-row span is still there; only the
  // long reason moved to its own block.
  assert.match(fn, /saveEl\.textContent = 'Session saved'/);
});

// ── Short confirmations stay on toasts ────────────────────────────────────────

test('the SHORT success and confirmation lines are still toasts', () => {
  // The fix is about long instructions, not about abolishing toasts. These are
  // the cases a 3-second strip suits, and they must not have been swept up.
  assert.match(extractFunction(html, 'onboardingSaveToRepo'), /showToast\(`Saved to your repo/);
  assert.match(extractFunction(html, 'saveStory'), /showToast\('Story saved!'\)/);
  assert.match(extractFunction(html, 'saveMemoryFile'), /showToast\('Memory saved/);
  assert.match(extractFunction(html, 'saveWatchList'), /showToast\(`✓ Watch list saved/);
});

test('a nothing-to-save click is still a toast, because it is one short sentence', () => {
  assert.match(extractFunction(html, 'onboardingSaveToRepo'), /showToast\('No content to save/);
});

// ── The two Save buttons never both show the same notice ──────────────────────

test('onboardingSaveToRepo targets ONE of the two notices, and clears both first', () => {
  const fn = extractFunction(html, 'onboardingSaveToRepo');
  // Which one depends on the button the user pressed, since the leave
  // confirmation can be open on top of the download step.
  assert.match(fn, /opts && opts\.from === 'confirm'/);
  assert.match(fn, /ONBOARDING_SAVE_ERROR_IDS\.forEach\(clearSaveFailureAt\)/);
  assert.match(extractFunction(html, 'onboardingSaveFromConfirm'), /onboardingSaveToRepo\(\{ from: 'confirm' \}\)/);
});

test('the leave confirmation stays OPEN when its save fails', () => {
  // Leaving would discard the very files the user just tried to keep.
  const fn = extractFunction(html, 'onboardingSaveFromConfirm');
  assert.match(fn, /if \(onboardingSaved\) onboardingLeaveOnboarding\(\)/);
});

// ── The server sends the two parts apart ──────────────────────────────────────

test('githubWriteErrorResponse sends userMessage and fix separately for the two-part render', () => {
  assert.equal(typeof FORBIDDEN.userMessage, 'string');
  assert.equal(typeof FORBIDDEN.fix, 'string');
  assert.ok(FORBIDDEN.userMessage.length > 20);
  assert.ok(FORBIDDEN.fix.length > 20);
  // And the joined form is still there for anything with room for one string.
  assert.equal(FORBIDDEN.error, `${FORBIDDEN.userMessage} ${FORBIDDEN.fix}`);
});

// ── A failure panel must not outlive the attempt that produced it ─────────────
//
// Persistence was the whole point of moving these off toasts — but a panel that
// persists has to be taken DOWN deliberately, and there were two places where
// nothing ever did.
//
// Both are executed against stub DOM rather than pattern-matched on source, so
// what is asserted is "the panel is actually hidden and empty afterwards", not
// "the file mentions a clear call somewhere".

// A save-failure element as it sits AFTER a failed attempt: displayed, with the
// cause and the fix rendered into it.
function populatedFailureEl(cause, fix) {
  const kids = [{ className: '', textContent: cause || 'Your GitHub token can read your repo but cannot write to it.' }];
  if (fix !== null) kids.push({ className: 'setup-fix', textContent: fix || 'Give the token Contents: Read and write.' });
  const el = {
    className: 'setup-check bad save-failure',
    style: { display: 'block' },
    children: kids,
    appendChild(node) { el.children.push(node); return node; },
    set textContent(v) { if (!v) el.children.length = 0; },
    get textContent() { return el.children.map(c => c.textContent).join('\n'); },
  };
  return el;
}

test('RESUMING a run clears the previous attempt\'s save failure', () => {
  // THE BUG. A save fails on the download step, leaving #onboarding-save-error
  // populated. The user clicks "Done" — which preserves the DOM, and keeps the
  // persisted run, because only a SUCCESSFUL save calls onboardingClearPersisted.
  // They reopen onboarding and choose Resume, which restores them to the step the
  // run was saved on: the download step, with the dead failure still on it. If
  // they fixed their token in between, the dashboard is now asserting a write
  // failure about a token that works — the exact mis-diagnosis this whole change
  // exists to remove.
  //
  // onboardingFreshStart already cleared these; the resume path never did.

  // Read the real ids out of the dashboard so this test tracks the constant
  // instead of a copy of it.
  const idsSrc = /const ONBOARDING_SAVE_ERROR_IDS = \[([^\]]+)\]/.exec(html);
  assert.ok(idsSrc, 'ONBOARDING_SAVE_ERROR_IDS not found in the dashboard');
  const IDS = idsSrc[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  // Both the download step's notice and the leave-confirmation's, matching what
  // onboardingSaveToRepo clears at the start of every attempt.
  assert.deepEqual(IDS, ['onboarding-save-error', 'onboarding-confirm-save-error']);

  const panels = {};
  IDS.forEach(id => { panels[id] = populatedFailureEl(); });
  // Sanity: they start as a failed attempt leaves them.
  IDS.forEach(id => {
    assert.equal(panels[id].style.display, 'block');
    assert.ok(panels[id].textContent.length > 0);
  });

  // Every other element the restore touches is an inert stub; the clear path
  // itself runs for real.
  const other = () => ({ style: { display: '' }, value: '', textContent: '', innerHTML: '', disabled: false });
  const document = {
    getElementById: (id) => (panels[id] !== undefined ? panels[id] : other()),
    createElement: () => ({ className: '', textContent: '', style: {}, appendChild() {} }),
  };

  const body = [
    extractFunction(html, 'clearSaveFailure'),
    extractFunction(html, 'clearSaveFailureAt'),
    extractFunction(html, 'onboardingResumeSaved'),
  ].join('\n\n');

  const factory = new Function('document', 'ONBOARDING_SAVE_ERROR_IDS', 'savedState', `
    'use strict';
    const ONBOARDING_STEPS = ['input', 'conversation', 'refresh-notes', 'companies',
      'generating', 'bulletbank', 'bulletbankchat', 'download'];
    let onboardingPendingRestore = savedState;
    let onboardingPendingIsRefresh = false;
    let onboardingIsRefresh = false, onboardingResumeText = '', onboardingTranscript = [];
    let onboardingChatLog = [], onboardingChangeNotes = '', onboardingExistingFiles = null;
    let onboardingFoundRepoProfile = false, onboardingHasCustomPortals = false;
    let onboardingPortalsYml = null, onboardingResult = null, onboardingSaved = false;
    let onboardingDownloaded = {}, onboardingLoading = false;
    let onboardingGenerationInProgress = false, onboardingAbandoned = false;
    let onboardingProfileProbe = null;
    const onboardingHideResumePrompt = () => {};
    const onboardingHideDiscardConfirm = () => {};
    const onboardingFreshStart = () => { throw new Error('freshStart must not run: a saved state was supplied'); };
    const onboardingRebuildChat = () => {};
    const onboardingRestoreCompanies = () => {};
    const onboardingRenderInputNotes = () => {};
    const onboardingRenderWriteNotice = () => {};
    const onboardingGenFallbackStep = () => 'download';
    const switchOnboardingStep = () => {};
    const switchCoachView = () => {};
    const onboardingProbeExistingProfile = () => null;
    ${body}
    return () => onboardingResumeSaved();
  `);

  // The decisive case: the run was saved ON the download step, which is both
  // where the failed save happened and where the dead panel lives.
  factory(document, IDS, { step: 'download', result: { 'config/profile.yml': 'x' } })();

  for (const id of IDS) {
    assert.equal(panels[id].style.display, 'none',
      `#${id} is still displayed after a resume — the previous attempt's failure is being shown again`);
    assert.equal(panels[id].textContent, '',
      `#${id} still holds the previous attempt's reason after a resume`);
  }
});
