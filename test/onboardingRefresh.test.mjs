// Tests for the dashboard's auto-detected refresh flow and the unsaved-files
// guard. Both live as inline JS in dashboard/index.html, so the functions are
// extracted from source (same brace-walk approach as memoryDashboard.test.mjs)
// and run against a stub DOM — no browser, no framework.
//
// What must hold:
//   - a repo that already has profile files puts onboarding in refresh mode no
//     matter which button opened it;
//   - a repo with none leaves the first-time flow exactly as it was;
//   - a failed get-assets degrades to the first-time flow without throwing;
//   - generated files that were neither saved nor fully downloaded are reported
//     as unsaved, so "Done" and beforeunload can warn instead of discarding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

// Extract a top-level `function name(...) { ... }` (async or not) by brace-walk.
// The parameter list is skipped first so a destructured param ({ checking = false })
// is not mistaken for the function body.
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

const HELPERS = [
  'onboardingRenderInputNotes',
  'onboardingProbeExistingProfile',
  'onboardingProfileProbeSettled',
  'onboardingHasUnsavedFiles',
];

const NOTE_IDS = [
  'onboarding-checking-note',
  'onboarding-found-note',
  'onboarding-refresh-note',
  'onboarding-input-default-note',
  'onboarding-card-existing',
];

// Build a sandbox holding the real extracted functions plus the onboarding state
// they read, wired to a stub document and an injected fetch.
function makeSandbox(fetchImpl) {
  const els = {};
  NOTE_IDS.forEach(id => { els[id] = { style: { display: 'none' } }; });
  const document = { getElementById: id => els[id] || null };
  const sessionStorage = { getItem: () => 'pw' };
  const quietConsole = { warn() {}, log() {}, error() {} };
  const body = HELPERS.map(n => extractFunction(html, n)).join('\n\n');

  const factory = new Function('document', 'sessionStorage', 'fetch', 'console', `
    let onboardingExistingFiles = null;
    let onboardingFoundRepoProfile = false;
    let onboardingIsRefresh = false;
    let onboardingProfileProbe = null;
    let onboardingResult = null;
    let onboardingSaved = false;
    let onboardingDownloaded = {};
    let onboardingAbandoned = false;
    ${body}
    return {
      // Mirrors what startOnboarding does on entry.
      enterOnboarding: async (isRefresh) => {
        onboardingIsRefresh = !!isRefresh;
        onboardingFoundRepoProfile = false;
        onboardingExistingFiles = null;
        onboardingRenderInputNotes({ checking: true });
        onboardingProfileProbe = onboardingProbeExistingProfile();
        await onboardingProfileProbeSettled();
        return { existingFiles: onboardingExistingFiles, isRefresh: onboardingIsRefresh };
      },
      // Stands in for the manual "existing files" card landing mid-probe.
      setManualFiles: (files) => { onboardingExistingFiles = files; },
      hasUnsaved: (result, saved, downloaded, abandoned = false) => {
        onboardingResult = result;
        onboardingSaved = saved;
        onboardingDownloaded = downloaded;
        onboardingAbandoned = abandoned;
        return onboardingHasUnsavedFiles();
      },
    };
  `);
  return { api: factory(document, sessionStorage, fetchImpl, quietConsole), els };
}

const visibleNotes = els => NOTE_IDS.filter(id => els[id].style.display === '');
const assetsRes = obj => async () => ({ ok: true, json: async () => obj });
const EMPTY_ASSETS = { claudeMd: '', storyBank: '', cvMd: '', bulletBankMd: '', articleDigestMd: '', profileYml: '' };

// ── Refresh auto-detection ────────────────────────────────────────────────────

test('a repo with profile files flips onboarding into refresh mode', async () => {
  const { api, els } = makeSandbox(assetsRes({
    ...EMPTY_ASSETS, claudeMd: '# Alex Doe', bulletBankMd: '## Ops\n- Cut spend 20%',
  }));
  // Opened with the "Get Started" button (isRefresh false) — detection must not
  // depend on which button was clicked.
  const state = await api.enterOnboarding(false);
  assert.equal(state.isRefresh, true);
  assert.equal(state.existingFiles.claudeMd, '# Alex Doe');
  assert.equal(state.existingFiles.bulletBankMd, '## Ops\n- Cut spend 20%');
  // Same shape as onboardingExistingFilesReady: absent files are null, not ''.
  assert.equal(state.existingFiles.cvMd, null);
  assert.equal(state.existingFiles.articleDigestMd, null);
  assert.equal(state.existingFiles.profileYml, null);
  assert.deepEqual(visibleNotes(els), ['onboarding-found-note', 'onboarding-card-existing']);
});

test('a brand-new repo leaves the first-time flow untouched', async () => {
  const { api, els } = makeSandbox(assetsRes(EMPTY_ASSETS));
  const state = await api.enterOnboarding(false);
  assert.equal(state.isRefresh, false);
  assert.equal(state.existingFiles, null);
  assert.deepEqual(visibleNotes(els), ['onboarding-input-default-note']);
});

test('whitespace-only files do not count as an existing profile', async () => {
  const { api } = makeSandbox(assetsRes({ ...EMPTY_ASSETS, claudeMd: '   \n\n' }));
  const state = await api.enterOnboarding(false);
  assert.equal(state.existingFiles, null);
  assert.equal(state.isRefresh, false);
});

test('a failed get-assets falls back to the first-time flow without throwing', async () => {
  const { api, els } = makeSandbox(async () => { throw new Error('network down'); });
  const state = await api.enterOnboarding(false);
  assert.equal(state.existingFiles, null);
  assert.equal(state.isRefresh, false);
  assert.deepEqual(visibleNotes(els), ['onboarding-input-default-note']);
});

test('a non-OK get-assets response falls back to the first-time flow', async () => {
  const { api } = makeSandbox(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const state = await api.enterOnboarding(false);
  assert.equal(state.existingFiles, null);
});

test('a slow probe never overwrites a manual existing-files upload', async () => {
  // The manual card is the documented override (used when the repo fetch fails
  // or the user wants different files). A probe that resolves late must lose.
  let release;
  const gate = new Promise(r => { release = r; });
  const { api, els } = makeSandbox(async () => {
    await gate;
    return { ok: true, json: async () => ({ ...EMPTY_ASSETS, claudeMd: '# From the repo' }) };
  });
  const entering = api.enterOnboarding(true);
  api.setManualFiles({
    claudeMd: '# Hand uploaded', cvMd: null, bulletBankMd: null,
    articleDigestMd: null, profileYml: null,
  });
  release();
  const state = await entering;
  assert.equal(state.existingFiles.claudeMd, '# Hand uploaded');
  // ...and we must not tell the user we "found" a profile they uploaded themselves.
  assert.ok(!visibleNotes(els).includes('onboarding-found-note'));
});

test('manual refresh mode on an empty repo does not claim a profile was found', async () => {
  const { api, els } = makeSandbox(assetsRes(EMPTY_ASSETS));
  await api.enterOnboarding(true); // opened via the Onboarding sub-tab
  assert.deepEqual(visibleNotes(els), ['onboarding-refresh-note', 'onboarding-card-existing']);
});

// ── Unsaved-files guard ───────────────────────────────────────────────────────

const GENERATED = {
  claudeMd: '# Alex', cvMd: '# CV', bulletBankMd: '- bullet',
  articleDigestMd: '## Role Context', profileYml: '',
};

test('unsaved-files guard tracks save, download, and discard', async () => {
  const { api } = makeSandbox(assetsRes(EMPTY_ASSETS));
  assert.equal(api.hasUnsaved(null, false, {}), false, 'nothing generated yet');
  assert.equal(api.hasUnsaved(GENERATED, false, {}), true, 'generated but untouched');
  assert.equal(api.hasUnsaved(GENERATED, true, {}), false, 'committed to the repo');
  assert.equal(api.hasUnsaved(GENERATED, false, { claudeMd: true }), true, 'only partly downloaded');
  assert.equal(
    api.hasUnsaved(GENERATED, false, {
      claudeMd: true, cvMd: true, bulletBankMd: true, articleDigestMd: true,
    }),
    false,
    'every non-empty file downloaded — an empty profileYml must not block this',
  );
  // A generation still in flight when the user leaves will assign
  // onboardingResult afterwards; without the abandon flag that silently re-arms
  // the beforeunload prompt for the rest of the session.
  assert.equal(api.hasUnsaved(GENERATED, false, {}, true), false, 'explicitly abandoned');
});

// ── Wiring that cannot be exercised from the extracted helpers ────────────────

test('resume upload routes a returning user to refresh-notes, not the conversation', () => {
  const upload = extractFunction(html, 'onboardingProcessFile');
  assert.match(upload, /await onboardingProfileProbeSettled\(\)/);
  assert.match(upload, /if \(onboardingExistingFiles\) \{[\s\S]*onboardingGoToRefreshNotes\(\)/);
  assert.match(upload, /onboardingStartConversation\(\)/); // new-user path still there
});

test('paste routes a returning user to refresh-notes too', () => {
  const paste = extractFunction(html, 'onboardingSubmitPaste');
  assert.match(paste, /await onboardingProfileProbeSettled\(\)/);
  assert.match(paste, /onboardingGoToRefreshNotes\(\)/);
});

test('entering refresh-notes from a new resume does not clobber the parsed text', () => {
  const go = extractFunction(html, 'onboardingGoToRefreshNotes');
  assert.doesNotMatch(go, /onboardingResumeText\s*=/);
  // The refresh-notes generate step only overwrites it when the paste box has content.
  const fromNotes = extractFunction(html, 'onboardingStartGenerateFromNotes');
  assert.match(fromNotes, /if \(resumeEl && resumeEl\.value\.trim\(\)\) \{\s*onboardingResumeText = resumeEl\.value\.trim\(\);/);
});

test('the sequential update path sends both the new resume and the existing files', () => {
  const seq = extractFunction(html, 'onboardingGenerateSequential');
  assert.match(seq, /resumeText: onboardingResumeText/);
  assert.match(seq, /existingFiles: onboardingExistingFiles/);
  // bullet-bank.md is generated unconditionally and never accepted empty.
  assert.match(seq, /action=generate-bulletbank/);
  assert.match(seq, /if \(!bulletBankMd\.trim\(\)\)/);
});

// ── Copy ──────────────────────────────────────────────────────────────────────

test('no onboarding copy describes bullet-bank.md as optional', () => {
  // Applications are written from bullet-bank.md (scanner/applicationPackage.mjs
  // reads it first, cv.md only as a fallback), so calling it optional teaches the
  // user to commit cv.md alone and silently keep applying off the old resume.
  //
  // A same-line check is too weak: the original offender was "One optional step:"
  // on its own line directly ABOVE the bullet-bank paragraph, which reads as one
  // sentence but hides from a line-by-line grep. Slide a window over the file so
  // "optional" near a bullet-bank mention is caught however it is wrapped.
  const WINDOW = 3;
  const lines = html.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const block = lines.slice(i, i + WINDOW).join(' ');
    if (/optional/i.test(block) && /bullet.?bank/i.test(block)) {
      hits.push(`line ${i + 1}: ${block.replace(/\s+/g, ' ').trim().slice(0, 180)}`);
    }
  }
  assert.deepEqual(hits, [], `bullet-bank.md still described as optional:\n${hits.join('\n')}`);
});

test('the download step says all five files must be committed together', () => {
  assert.match(html, /Updating an existing profile\? Commit all five\./);
  assert.match(html, /applications are written from <strong>bullet-bank\.md<\/strong>, not cv\.md/);
  assert.match(html, /leaves every future application running on your old resume/);
});

test('the input step tells a returning user we already found their profile', () => {
  assert.match(html, /We found your existing profile — we'll just ask what's changed\./);
});

test('Done warns before discarding, and beforeunload covers the same condition', () => {
  const done = extractFunction(html, 'onboardingDone');
  assert.match(done, /onboardingHasUnsavedFiles\(\)/);
  assert.match(done, /onboardingShowDiscardConfirm\('unsaved'\)/);
  assert.match(html, /onboardingGenerationInProgress \|\| onboardingHasUnsavedFiles\(\)/);
  assert.match(html, /onclick="onboardingDiscardAnyway\(\)"/);
  assert.match(html, /onclick="onboardingSaveFromConfirm\(\)"/);
});

test('Exit runs the same unsaved-files guard as Done', () => {
  // Exit is rendered on every step including download. Leaving it bare discarded
  // generated files silently and left onboardingResult set, so the beforeunload
  // prompt then fired for the rest of the session with no way to clear it.
  const exit = extractFunction(html, 'exitOnboarding');
  assert.match(exit, /onboardingDone\(\)/);
  assert.doesNotMatch(exit, /switchCoachView/);
});

test('leaving mid-generation warns instead of silently losing the profile', () => {
  // onboardingResult is still null while generating, so the unsaved check alone
  // waves the user out — and the run lands ~90s later on a hidden view.
  const done = extractFunction(html, 'onboardingDone');
  assert.match(done, /if \(onboardingGenerationInProgress\) \{[\s\S]*onboardingShowDiscardConfirm\('generating'\)/);
  // The generating branch must come first, or the unsaved check short-circuits it.
  assert.ok(
    done.indexOf('onboardingGenerationInProgress') < done.indexOf('onboardingHasUnsavedFiles'),
    'generation check must precede the unsaved-files check',
  );
  // Leaving anyway disarms the prompt so a late-landing result cannot re-arm it.
  assert.match(extractFunction(html, 'onboardingDiscardAnyway'), /onboardingAbandoned = true/);
  assert.match(extractFunction(html, 'onboardingHasUnsavedFiles'), /if \(onboardingAbandoned\) return false;/);
  assert.match(extractFunction(html, 'startOnboarding'), /onboardingAbandoned = false;/);
});

test('the leave confirmation renders outside the step panels', () => {
  // Exit is on every step, so a confirm nested inside onboarding-step-download
  // would be invisible when it fires during generating.
  const stepDownloadIdx = html.indexOf('id="onboarding-step-download"');
  const confirmIdx = html.indexOf('id="onboarding-discard-confirm"');
  const viewEndIdx = html.indexOf('id="view-memory"');
  assert.ok(stepDownloadIdx > 0 && confirmIdx > stepDownloadIdx && confirmIdx < viewEndIdx);
  // The download step closes before the confirm block starts.
  const between = html.slice(stepDownloadIdx, confirmIdx);
  assert.match(between, /Done — Go to Dashboard/);
  // Mode-specific copy and controls.
  assert.match(html, /id="onboarding-discard-confirm-msg"/);
  assert.match(html, /id="onboarding-confirm-stay-btn"/);
  const show = extractFunction(html, 'onboardingShowDiscardConfirm');
  assert.match(show, /Your profile is still generating — leaving now will lose it\./);
  assert.match(show, /generating \? 'Leave anyway' : 'Discard anyway'/);
});

test('generation failure returns a conversation user to their conversation', () => {
  const helper = extractFunction(html, 'onboardingGenFallbackStep');
  assert.match(helper, /onboardingTranscript\.some\(m => m\.content !== '__init__'\)/);
  assert.match(helper, /return 'conversation';/);
  assert.match(helper, /onboardingExistingFiles \? 'refresh-notes' : 'conversation'/);
});

test('startOnboarding clears the refresh-notes inputs from a previous run', () => {
  // Stale textarea content is invisible (the resume pane starts collapsed) but
  // onboardingStartGenerateFromNotes prefers it over the freshly parsed resume.
  const start = extractFunction(html, 'startOnboarding');
  assert.match(start, /getElementById\('onboarding-change-notes'\)/);
  assert.match(start, /getElementById\('onboarding-refresh-resume-input'\)/);
  assert.match(start, /getElementById\('onboarding-resume-paste-pane'\)/);
  assert.equal((start.match(/\.value = '';/g) || []).length, 2, 'both textareas cleared');
});

test('every generation failure returns the refresh user to refresh-notes', () => {
  const seq = extractFunction(html, 'onboardingGenerateSequential');
  // No bare fallback left: the refresh path never opened a conversation, so
  // landing there strands the change notes on a screen the user has not seen.
  assert.doesNotMatch(seq, /switchOnboardingStep\('conversation'\)/);
  const fallbacks = (seq.match(/switchOnboardingStep\(onboardingGenFallbackStep\(\)\)/g) || []).length;
  assert.equal(fallbacks, 6, 'four per-file errors + the empty-bullet-bank guard + the outer catch');
  const helper = extractFunction(html, 'onboardingGenFallbackStep');
  assert.match(helper, /onboardingExistingFiles \? 'refresh-notes' : 'conversation'/);
});
