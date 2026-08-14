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
    let onboardingIsRefresh = false;
    let onboardingProfileProbe = null;
    let onboardingResult = null;
    let onboardingSaved = false;
    let onboardingDownloaded = {};
    ${body}
    return {
      // Mirrors what startOnboarding does on entry.
      enterOnboarding: async (isRefresh) => {
        onboardingIsRefresh = !!isRefresh;
        onboardingRenderInputNotes({ checking: true });
        onboardingProfileProbe = onboardingProbeExistingProfile();
        await onboardingProfileProbeSettled();
        return { existingFiles: onboardingExistingFiles, isRefresh: onboardingIsRefresh };
      },
      hasUnsaved: (result, saved, downloaded) => {
        onboardingResult = result;
        onboardingSaved = saved;
        onboardingDownloaded = downloaded;
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
  const optionalLines = html
    .split('\n')
    .filter(l => /optional/i.test(l) && /bullet.?bank/i.test(l));
  assert.deepEqual(optionalLines, [], `bullet-bank.md still described as optional:\n${optionalLines.join('\n')}`);
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
  assert.match(done, /onboardingShowDiscardConfirm\(\)/);
  assert.match(html, /onboardingGenerationInProgress \|\| onboardingHasUnsavedFiles\(\)/);
  assert.match(html, /onclick="onboardingDiscardAnyway\(\)"/);
  assert.match(html, /onclick="onboardingSaveFromConfirm\(\)"/);
});
