// Tests for onboarding progress surviving a reload. All of it lives as inline JS
// in dashboard/index.html, so the functions are extracted from source (same
// brace-walk as onboardingRefresh.test.mjs) and run against a stub DOM and a stub
// localStorage — no browser, no framework.
//
// What must hold:
//   - a run in progress is written through to localStorage and comes back whole;
//   - the snapshot reads textareas LIVE, so notes typed but never submitted survive;
//   - a storage failure never breaks the flow the user is in the middle of;
//   - stale (>24h), corrupt, and no-progress envelopes are discarded silently, so
//     a first-time user is never prompted;
//   - restoring rebuilds the chat exactly once, and never lands on a dead spinner;
//   - the run is cleared when it is saved, discarded, or finished — and kept when
//     the user merely exits mid-conversation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

// Extract a top-level `function name(...) { ... }` (async or not) by brace-walk.
// The parameter list is skipped first so a destructured param is not mistaken for
// the function body.
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
  'onboardingSnapshot',
  'onboardingStateHasProgress',
  'onboardingPersist',
  'onboardingClearPersisted',
  'onboardingLoadPersisted',
  'onboardingRebuildChat',
  'appendOnboardingMessage',
  'companyRowsCollect',
];

// Pulled from the dashboard rather than restated, so the tests cannot quietly
// pass against a key or a window the app no longer uses.
function extractConst(name) {
  const m = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(html);
  assert.ok(m, `dashboard is missing const ${name}`);
  return m[0];
}
const STORAGE_KEY = /const ONBOARDING_STATE_KEY\s*=\s*'([^']+)'/.exec(html)[1];
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_CONSTS = [extractConst('ONBOARDING_STATE_KEY'), extractConst('ONBOARDING_STATE_MAX_AGE_MS')].join('\n');

test('the storage key is namespaced and versioned, and the window is 24h', () => {
  assert.equal(STORAGE_KEY, 'jobbud_onboarding_v1');
  assert.match(extractConst('ONBOARDING_STATE_MAX_AGE_MS'), /24 \* 60 \* 60 \* 1000/);
});

// Minimal element stubs. Textareas carry .value; the chat pane records what was
// appended so a rebuild can be counted.
const textarea = (value = '') => ({ value });
const chatPane = () => {
  const el = {
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
    appendChild(node) { el.children.push(node); },
    set innerHTML(v) { if (!v) el.children.length = 0; },
    get innerHTML() { return el.children.map(c => c.textContent).join(''); },
  };
  return el;
};

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
  };
}

// Sandbox holding the real extracted functions plus the onboarding state they
// read. `rows` seeds the companies-step inputs that companyRowsCollect walks.
function makeSandbox({ storage = makeStorage(), state = {}, rows = [], now = null } = {}) {
  const els = {
    'onboarding-change-notes': textarea(state.notesDraft || ''),
    'onboarding-refresh-resume-input': textarea(state.refreshDraft || ''),
    'onboarding-gen-wrap': { style: { display: state.genReady ? '' : 'none' } },
    'onboarding-chat-messages': chatPane(),
  };
  const rowEls = rows.map(([name, url]) => ({
    querySelector: sel => ({ value: sel.includes('name') ? name : url }),
  }));
  const document = {
    getElementById: id => els[id] || null,
    querySelectorAll: () => rowEls,
    createElement: () => ({ className: '', textContent: '' }),
  };
  const quietConsole = { warn() {}, log() {}, error() {} };
  const body = HELPERS.map(n => extractFunction(html, n)).join('\n\n');

  // Date is injected rather than shadowed so the age check can be driven to an
  // exact moment; the extracted helpers only ever ask it for now().
  const clock = now ? { now: () => now } : Date;
  const factory = new Function('document', 'localStorage', 'console', 'Date', `
    ${STATE_CONSTS}
    let onboardingStep = ${JSON.stringify(state.step || 'input')};
    let onboardingIsRefresh = ${!!state.isRefresh};
    let onboardingResumeText = ${JSON.stringify(state.resumeText || '')};
    let onboardingTranscript = ${JSON.stringify(state.transcript || [])};
    let onboardingChatLog = ${JSON.stringify(state.chatLog || [])};
    let onboardingChangeNotes = ${JSON.stringify(state.changeNotes || '')};
    let onboardingExistingFiles = ${JSON.stringify(state.existingFiles || null)};
    let onboardingFoundRepoProfile = ${!!state.foundRepoProfile};
    let onboardingHasCustomPortals = ${!!state.hasCustomPortals};
    let onboardingPortalsYml = ${JSON.stringify(state.portalsYml || null)};
    let onboardingResult = ${JSON.stringify(state.result || null)};
    let onboardingSaved = ${!!state.saved};
    let onboardingDownloaded = ${JSON.stringify(state.downloaded || {})};
    ${body}
    return {
      snapshot: () => onboardingSnapshot(),
      hasProgress: s => onboardingStateHasProgress(s),
      persist: () => onboardingPersist(),
      clear: () => onboardingClearPersisted(),
      load: () => onboardingLoadPersisted(),
      appendMessage: (r, t) => appendOnboardingMessage(r, t),
      rebuildChat: () => { onboardingRebuildChat(); return onboardingChatLog; },
      chatLog: () => onboardingChatLog,
    };
  `);
  return { api: factory(document, storage, quietConsole, clock), storage, els };
}

const envelope = storage => JSON.parse(storage.data[STORAGE_KEY]);

// ── Snapshot ──────────────────────────────────────────────────────────────────

test('the snapshot carries the whole run, not just the chat', () => {
  const { api } = makeSandbox({ state: {
    step: 'download',
    isRefresh: true,
    resumeText: 'Alex Doe, operator',
    transcript: [{ role: 'user', content: '__init__' }, { role: 'user', content: 'Ops roles' }],
    chatLog: [{ role: 'assistant', text: 'What are you going for?' }],
    changeNotes: 'New role at Ramp',
    existingFiles: { claudeMd: '# Alex', cvMd: null },
    foundRepoProfile: true,
    hasCustomPortals: true,
    portalsYml: '# Generated by JobBud onboarding',
    result: { claudeMd: '# Alex', cvMd: '# CV' },
    saved: false,
    downloaded: { claudeMd: true },
  } });
  const s = api.snapshot();
  assert.equal(s.step, 'download');
  assert.equal(s.isRefresh, true);
  assert.equal(s.resumeText, 'Alex Doe, operator');
  assert.equal(s.transcript.length, 2);
  assert.equal(s.chatLog.length, 1);
  assert.equal(s.changeNotes, 'New role at Ramp');
  assert.equal(s.existingFiles.claudeMd, '# Alex');
  assert.equal(s.foundRepoProfile, true);
  assert.equal(s.hasCustomPortals, true);
  assert.equal(s.portalsYml, '# Generated by JobBud onboarding');
  assert.deepEqual(s.result, { claudeMd: '# Alex', cvMd: '# CV' });
  assert.equal(s.saved, false);
  assert.deepEqual(s.downloaded, { claudeMd: true });
  // The whole thing has to survive a round trip through JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('unsubmitted change notes are read live from the textarea', () => {
  // onboardingChangeNotes is only assigned when the user submits the step, so a
  // reload while they are still typing is exactly the case that must not lose it.
  const { api } = makeSandbox({ state: {
    step: 'refresh-notes', resumeText: 'x', changeNotes: '', notesDraft: 'Left Turing in June',
    refreshDraft: 'PASTED RESUME',
  } });
  const s = api.snapshot();
  assert.equal(s.changeNotes, 'Left Turing in June');
  assert.equal(s.refreshResumeDraft, 'PASTED RESUME');
});

test('a submitted note wins over a stale textarea', () => {
  const { api } = makeSandbox({ state: {
    step: 'companies', resumeText: 'x', changeNotes: 'submitted', notesDraft: 'stale',
  } });
  assert.equal(api.snapshot().changeNotes, 'submitted');
});

test('companies rows are captured on the companies step and nowhere else', () => {
  const rows = [['Anthropic', 'https://boards.greenhouse.io/anthropic'], ['Ramp', 'https://jobs.ashbyhq.com/ramp']];
  const on = makeSandbox({ state: { step: 'companies', resumeText: 'x' }, rows });
  assert.deepEqual(on.api.snapshot().companies, [
    { name: 'Anthropic', careers_url: 'https://boards.greenhouse.io/anthropic' },
    { name: 'Ramp',      careers_url: 'https://jobs.ashbyhq.com/ramp' },
  ]);
  // Off the step the rows belong to a panel the user is not editing.
  const off = makeSandbox({ state: { step: 'conversation', resumeText: 'x' }, rows });
  assert.deepEqual(off.api.snapshot().companies, []);
});

test('the Generate button state is captured so a restore does not hide it', () => {
  assert.equal(makeSandbox({ state: { genReady: true } }).api.snapshot().genReady, true);
  assert.equal(makeSandbox({ state: { genReady: false } }).api.snapshot().genReady, false);
});

// ── Progress predicate (what gates the prompt) ────────────────────────────────

test('only real progress counts as progress', () => {
  const { api } = makeSandbox();
  assert.equal(api.hasProgress(null), false);
  assert.equal(api.hasProgress({}), false);
  // Opening onboarding and leaving is not progress — prompting about it is noise.
  assert.equal(api.hasProgress({ transcript: [{ role: 'user', content: '__init__' }] }), false);
  assert.equal(api.hasProgress({ resumeText: '   \n' }), false);
  // Any one of the three is enough.
  assert.equal(api.hasProgress({ transcript: [{ role: 'user', content: 'Ops roles' }] }), true);
  assert.equal(api.hasProgress({ resumeText: 'Alex Doe' }), true);
  assert.equal(api.hasProgress({ result: { claudeMd: '# Alex' } }), true);
});

// ── Write-through and read-back ───────────────────────────────────────────────

test('a persisted run comes back whole', () => {
  const storage = makeStorage();
  const { api } = makeSandbox({ storage, state: {
    step: 'conversation',
    resumeText: 'Alex Doe',
    transcript: [{ role: 'user', content: '__init__' }, { role: 'user', content: 'Ops roles' }],
    chatLog: [{ role: 'assistant', text: 'What are you going for?' }, { role: 'user', text: 'Ops roles' }],
  } });
  api.persist();
  const env = envelope(storage);
  assert.ok(Number.isFinite(env.savedAt));
  assert.equal(env.state.step, 'conversation');
  const loaded = api.load();
  assert.equal(loaded.resumeText, 'Alex Doe');
  assert.equal(loaded.chatLog.length, 2);
  assert.equal(loaded.transcript[1].content, 'Ops roles');
});

test('a storage failure is swallowed, not thrown at the user', () => {
  const full = makeStorage();
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  const { api } = makeSandbox({ storage: full, state: { resumeText: 'Alex Doe' } });
  assert.doesNotThrow(() => api.persist());
  // And an unreadable store degrades to "nothing saved" rather than exploding.
  const blocked = makeStorage();
  blocked.getItem = () => { throw new Error('SecurityError'); };
  const b = makeSandbox({ storage: blocked });
  assert.equal(b.api.load(), null);
});

test('clearing removes the key', () => {
  const storage = makeStorage();
  const { api } = makeSandbox({ storage, state: { resumeText: 'Alex Doe' } });
  api.persist();
  assert.ok(storage.data[STORAGE_KEY]);
  api.clear();
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

// ── What the prompt is gated on ───────────────────────────────────────────────

test('nothing saved means no prompt and no work', () => {
  const { api, storage } = makeSandbox();
  assert.equal(api.load(), null);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('a run older than 24h is discarded silently', () => {
  const now = 1_800_000_000_000;
  const stale = { savedAt: now - DAY_MS - 1000, state: { resumeText: 'Alex Doe' } };
  const storage = makeStorage({ [STORAGE_KEY]: JSON.stringify(stale) });
  const { api } = makeSandbox({ storage, now });
  assert.equal(api.load(), null, 'stale state must not be offered back');
  assert.equal(storage.getItem(STORAGE_KEY), null, 'and must not linger');
  // Just inside the window is still offered.
  const fresh = { savedAt: now - DAY_MS + 1000, state: { resumeText: 'Alex Doe' } };
  const storage2 = makeStorage({ [STORAGE_KEY]: JSON.stringify(fresh) });
  const b = makeSandbox({ storage: storage2, now });
  assert.equal(b.api.load().resumeText, 'Alex Doe');
});

test('a saved run with no real progress is discarded, not offered', () => {
  const storage = makeStorage({ [STORAGE_KEY]: JSON.stringify({
    savedAt: Date.now(), state: { step: 'input', transcript: [{ role: 'user', content: '__init__' }] },
  }) });
  const { api } = makeSandbox({ storage });
  assert.equal(api.load(), null);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('a corrupt or shapeless envelope never wedges onboarding', () => {
  for (const raw of ['not json at all', '{"state":{"resumeText":"x"}}', '{"savedAt":123}', 'null']) {
    const storage = makeStorage({ [STORAGE_KEY]: raw });
    const { api } = makeSandbox({ storage });
    assert.equal(api.load(), null, `should reject ${raw}`);
    assert.equal(storage.getItem(STORAGE_KEY), null, `should clear ${raw}`);
  }
});

// ── Restore ───────────────────────────────────────────────────────────────────

test('rebuilding the chat replays every message exactly once', () => {
  // The opening assistant question is rendered but deliberately never entered in
  // onboardingTranscript, so the log — not the transcript — is what rebuilds it.
  const log = [
    { role: 'assistant', text: 'What roles are you going for?' },
    { role: 'user', text: 'Ops roles' },
    { role: 'assistant', text: 'At what level?' },
  ];
  const { api, els } = makeSandbox({ state: { chatLog: log } });
  const after = api.rebuildChat();
  assert.deepEqual(after, log, 'the log must be rebuilt, not doubled');
  assert.equal(els['onboarding-chat-messages'].children.length, 3);
  assert.deepEqual(
    els['onboarding-chat-messages'].children.map(c => c.textContent),
    ['What roles are you going for?', 'Ops roles', 'At what level?'],
  );
});

test('every rendered message is recorded, including the opening question', () => {
  const { api } = makeSandbox();
  api.appendMessage('assistant', 'What roles are you going for?');
  api.appendMessage('user', 'Ops roles');
  assert.deepEqual(api.chatLog(), [
    { role: 'assistant', text: 'What roles are you going for?' },
    { role: 'user', text: 'Ops roles' },
  ]);
});

test('a run interrupted mid-generation resumes somewhere actionable', () => {
  // The request died with the page, so the generating step is a spinner that will
  // never finish. onboardingGenFallbackStep already knows where such a user
  // belongs (their conversation, or refresh-notes).
  const restore = extractFunction(html, 'onboardingResumeSaved');
  assert.match(restore, /if \(step === 'generating'\) step = onboardingGenFallbackStep\(\);/);
  // And nothing is left looking in-flight.
  assert.match(restore, /onboardingGenerationInProgress = false;/);
  assert.match(restore, /onboardingLoading = false;/);
  assert.match(restore, /onboardingAbandoned = false;/);
});

test('restoring re-runs the probe without clobbering the restored files', () => {
  const restore = extractFunction(html, 'onboardingResumeSaved');
  assert.match(restore, /onboardingExistingFiles = state\.existingFiles \|\| null;/);
  // Probe last, and the round-2 guard inside it is what protects the restore.
  assert.match(restore, /onboardingProfileProbe = onboardingProbeExistingProfile\(\);/);
  assert.match(extractFunction(html, 'onboardingProbeExistingProfile'), /if \(onboardingExistingFiles\) return;/);
  // Rows come back on the companies step, always in the edit phase — the review
  // phase shows ATS results from a call this page never made.
  assert.match(restore, /if \(step === 'companies'\) onboardingRestoreCompanies\(state\.companies\);/);
  assert.match(extractFunction(html, 'onboardingRestoreCompanies'), /onboardingCompaniesEdit\(\);/);
});

test('a restored conversation gets the chrome startConversation would have set', () => {
  // A restore never passes through onboardingStartConversation, so the context
  // line and the send button have to be put back by hand.
  const restore = extractFunction(html, 'onboardingResumeSaved');
  assert.match(restore, /onboarding-conv-context/);
  assert.match(restore, /sendBtn\.disabled = false;/);
  assert.match(restore, /genWrap\.style\.display = state\.genReady \? '' : 'none';/);
  // Textarea drafts are DOM, not globals.
  assert.match(restore, /notesEl\.value = state\.changeNotes \|\| '';/);
  assert.match(restore, /refreshResumeEl\.value = state\.refreshResumeDraft \|\| '';/);
});

// ── Prompt wiring and clearing sites ──────────────────────────────────────────

test('the prompt is offered before the reset that would destroy the run', () => {
  const start = extractFunction(html, 'startOnboarding');
  // The load must come first, and the reset must be behind the early return.
  assert.ok(start.indexOf('onboardingLoadPersisted()') < start.indexOf('onboardingFreshStart'));
  assert.match(start, /if \(saved\) \{[\s\S]*onboardingShowResumePrompt\(\)[\s\S]*return;/);
  // startOnboarding itself must not reset anything — that is what freshStart is for.
  assert.doesNotMatch(start, /onboardingTranscript = \[\]/);
  assert.match(extractFunction(html, 'onboardingFreshStart'), /onboardingTranscript = \[\];/);
  // The prompt hides the step panels rather than sitting on top of the old run.
  assert.match(extractFunction(html, 'onboardingShowResumePrompt'), /ONBOARDING_STEPS\.forEach/);
  assert.match(html, /id="onboarding-resume-confirm"/);
  assert.match(html, /onclick="onboardingResumeSaved\(\)"/);
  assert.match(html, /onclick="onboardingStartOver\(\)"/);
  assert.match(html, /You have onboarding progress from earlier — pick up where you left off\?/);
});

test('Start over throws the saved run away rather than leaving it to re-prompt', () => {
  const startOver = extractFunction(html, 'onboardingStartOver');
  assert.match(startOver, /onboardingClearPersisted\(\);/);
  assert.match(startOver, /onboardingFreshStart\(onboardingPendingIsRefresh\);/);
});

test('the run is cleared once it is safely somewhere, and kept when it is not', () => {
  // Saved to the repo: the goal of the run is met.
  assert.match(extractFunction(html, 'onboardingSaveToRepo'), /onboardingSaved = true;[\s\S]*onboardingClearPersisted\(\);/);
  // Explicitly discarded.
  assert.match(extractFunction(html, 'onboardingDiscardAnyway'), /onboardingClearPersisted\(\);/);
  // Done: cleared when finished or empty, kept otherwise. Exit mid-conversation
  // reaches this same branch and must land on persist.
  const done = extractFunction(html, 'onboardingDone');
  assert.match(done, /if \(onboardingResult \|\| !onboardingStateHasProgress\(onboardingSnapshot\(\)\)\) \{\s*\n\s*onboardingClearPersisted\(\);\s*\n\s*\} else \{\s*\n\s*onboardingPersist\(\);/);
  // Exiting while the prompt is still up decides nothing — the saved run stays.
  assert.match(done, /if \(onboardingPendingRestore\) \{[\s\S]*onboardingLeaveOnboarding\(\);\s*\n\s*return;/);
  assert.ok(done.indexOf('onboardingPendingRestore') < done.indexOf('onboardingClearPersisted'));
});

test('the write-through points cover every place progress is created', () => {
  const at = name => extractFunction(html, name);
  // A step transition is the catch-all, and it is what saves unsubmitted notes.
  assert.match(at('switchOnboardingStep'), /onboardingPersist\(\);\s*\n\s*\}$/);
  // The answer the user just typed, saved before the request goes out.
  assert.match(at('sendOnboardingMessage'), /onboardingTranscript\.push\(\{ role: 'user', content: text \}\);[\s\S]{0,200}onboardingPersist\(\);/);
  // The parsed resume, the built watch-list, and both generation results.
  assert.match(at('onboardingProcessFile'), /onboardingResumeText = data\.text \|\| '';\s*\n[\s\S]{0,120}onboardingPersist\(\);/);
  assert.match(at('onboardingSubmitPaste'), /onboardingResumeText = text;\s*\n\s*onboardingPersist\(\);/);
  assert.match(at('onboardingCompaniesContinue'), /onboardingPortalsYml = data\.portalsYml \|\| null;[\s\S]{0,200}onboardingPersist\(\);/);
  assert.match(at('onboardingGenerateSingle'), /onboardingResult = data;[\s\S]{0,200}onboardingPersist\(\);/);
  assert.match(at('onboardingGenerateSequential'), /onboardingResult = \{ claudeMd[\s\S]{0,500}onboardingPersist\(\);/);
  assert.match(at('onboardingDownload'), /onboardingDownloaded\[key\] = true;\s*\n\s*onboardingPersist\(\);/);
});
