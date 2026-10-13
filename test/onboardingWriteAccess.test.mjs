// Tests for the write-access warning shown when ONBOARDING OPENS.
//
// WHY IT EXISTS. Onboarding ends in "Save to my repo". If the GitHub token can
// read the repo but not write to it, that button fails — after the user has
// answered the interview questions and spent five AI generations getting there.
// The fact was knowable before they typed anything, so now it is checked at the
// door.
//
// WHAT THESE TESTS PROTECT is mostly the negative space, because a diagnostic
// that breaks the flow it was added to is worse than the bug:
//   - it must NOT gate or block onboarding;
//   - it must NOT add an awaited call to the entry path;
//   - any failure (network, auth, old deployment, unreadable body) must leave
//     onboarding behaving exactly as it did before;
//   - an UNKNOWN answer must stay silent — never warn a user whose setup is fine.
//
// The logic is inline JS in dashboard/index.html, so it is extracted from source
// and executed against stub DOM, same brace-walk as the other onboarding tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Element stub recording what was rendered into it.
function noticeEl() {
  const el = {
    className: '',
    style: { display: 'none' },
    children: [],
    appendChild(node) { el.children.push(node); },
    set textContent(v) { if (!v) el.children.length = 0; },
    get textContent() { return el.children.map(c => c.textContent).join(' '); },
  };
  return el;
}

// Run the two extracted functions with `fetchHealth` stubbed to `health`.
// `health` is either a payload to resolve, or an Error to reject with.
function makeSandbox(health) {
  const el = noticeEl();
  const document = {
    getElementById: id => (id === 'onboarding-write-warning' ? el : null),
    createElement: () => ({ className: '', textContent: '' }),
  };
  const fetchHealth = async () => {
    if (health instanceof Error) throw health;
    return health;
  };
  const body = [
    extractFunction(html, 'onboardingRenderWriteNotice'),
    extractFunction(html, 'onboardingProbeWriteAccess'),
  ].join('\n\n');

  const factory = new Function('document', 'fetchHealth', 'storedPassword', `
    let onboardingWriteNotice = null;
    ${body}
    return {
      probe: () => onboardingProbeWriteAccess(),
      render: () => onboardingRenderWriteNotice(),
      notice: () => onboardingWriteNotice,
    };
  `);
  return { api: factory(document, fetchHealth, () => 'pw'), el };
}

const checkRow = (over = {}) => ({
  check: 'github:write', ok: false, informational: false,
  message: "Your GitHub token can read your repo but can't write to it, so Save buttons will fail.",
  fix: 'Give it Contents: Read and write, then Redeploy.',
  ...over,
});

// ── It warns when, and only when, there is something real to say ──────────────

test('a failing github:write check renders the message, the fix, and a way forward', async () => {
  const { api, el } = makeSandbox({ checks: [checkRow()] });
  await api.probe();
  assert.equal(el.style.display, '');
  assert.match(el.textContent, /can read your repo but can't write/);
  assert.match(el.textContent, /Contents: Read and write/);
  // The reassurance the health endpoint cannot know: the flow still works.
  assert.match(el.textContent, /carry on with onboarding/);
  assert.match(el.textContent, /Download buttons/);
  assert.equal(el.children.length, 3, 'message + fix + carry-on');
});

test('a PASSING github:write check says nothing at all', async () => {
  const { api, el } = makeSandbox({ checks: [checkRow({ ok: true })] });
  await api.probe();
  assert.equal(el.style.display, 'none');
  assert.equal(el.children.length, 0);
  assert.equal(api.notice(), null);
});

test('an INFORMATIONAL (unknown) github:write check says nothing', async () => {
  // api/health.js reports informational: true when GitHub gave no usable answer
  // about the token's permissions. Warning on that would mean telling users with
  // perfectly good setups that their token is broken.
  const { api, el } = makeSandbox({ checks: [checkRow({ ok: true, informational: true })] });
  await api.probe();
  assert.equal(el.style.display, 'none');
  assert.equal(api.notice(), null);
});

test('an informational check that is also ok:false still says nothing', async () => {
  // Belt and braces: `informational` alone must be enough to silence it.
  const { api, el } = makeSandbox({ checks: [checkRow({ ok: false, informational: true })] });
  await api.probe();
  assert.equal(el.style.display, 'none');
});

test('other failing checks are ignored — only github:write speaks here', async () => {
  const { api, el } = makeSandbox({ checks: [
    { check: 'env:ANTHROPIC_API_KEY', ok: false, informational: false, message: 'Key missing.', fix: 'Add it.' },
    checkRow({ ok: true }),
  ] });
  await api.probe();
  assert.equal(el.style.display, 'none', 'an unrelated failure must not become a write warning');
});

// ── It fails soft, every way it can fail ──────────────────────────────────────

test('a rejected health request leaves onboarding untouched and silent', async () => {
  const { api, el } = makeSandbox(new Error('NetworkError: Failed to fetch'));
  await assert.doesNotReject(() => api.probe(), 'the probe must never throw at its caller');
  assert.equal(el.style.display, 'none');
  assert.equal(api.notice(), null);
});

test('a response with no checks array is treated as no answer', async () => {
  for (const payload of [{}, { checks: null }, { ok: false }]) {
    const { api, el } = makeSandbox(payload);
    await assert.doesNotReject(() => api.probe());
    assert.equal(el.style.display, 'none', JSON.stringify(payload));
  }
});

test('a deployment with no github:write check at all stays silent', async () => {
  // An older /api/health predates this check. Absent is not failing.
  const { api, el } = makeSandbox({ checks: [{ check: 'github:repo', ok: true, informational: false, message: 'Fine.' }] });
  await api.probe();
  assert.equal(el.style.display, 'none');
});

test('a wrong-password health response (one failed auth check) stays silent', async () => {
  const { api, el } = makeSandbox({ ok: false, checks: [
    { check: 'auth', ok: false, informational: false, message: "That password doesn't match.", fix: 'Check it.' },
  ] });
  await api.probe();
  assert.equal(el.style.display, 'none');
});

test('a notice is cleared, not left stale, when a later probe comes back clean', async () => {
  const { api, el } = makeSandbox({ checks: [checkRow()] });
  await api.probe();
  assert.equal(el.style.display, '');
  // Re-render after the state is reset is what onboardingFreshStart relies on.
  const fixed = makeSandbox({ checks: [checkRow({ ok: true })] });
  await fixed.api.probe();
  assert.equal(fixed.el.style.display, 'none');
  assert.equal(fixed.el.children.length, 0);
});

test('render with no element present is a no-op rather than a crash', () => {
  const body = [
    extractFunction(html, 'onboardingRenderWriteNotice'),
  ].join('\n');
  const factory = new Function('document', `
    let onboardingWriteNotice = { message: 'x', fix: 'y' };
    ${body}
    return () => onboardingRenderWriteNotice();
  `);
  const run = factory({ getElementById: () => null, createElement: () => ({}) });
  assert.doesNotThrow(run);
});

// ── It must not gate, block, or slow the entry path ───────────────────────────

test('the probe is fired from startOnboarding and NOT awaited', () => {
  const start = extractFunction(html, 'startOnboarding');
  assert.match(start, /onboardingProbeWriteAccess\(\);/, 'the probe must run when onboarding is entered');
  assert.doesNotMatch(start, /await onboardingProbeWriteAccess/, 'awaiting it would stall the entry path');
  // It must come before the early return for the resume prompt, so the probe
  // RUNS on that path too. Whether the result is ever SEEN is a different
  // question, and the "visible on a resumed run" tests below are the ones that
  // answer it — this assertion on its own used to be the only coverage of the
  // resume path, and it passed happily while the notice was never displayed.
  assert.ok(
    start.indexOf('onboardingProbeWriteAccess()') < start.indexOf('onboardingShowResumePrompt'),
    'the probe must also run on the resume-prompt path',
  );
});

test('startOnboarding is still synchronous — the entry path gained no await', () => {
  assert.match(html, /\n  function startOnboarding\(isRefresh\) \{/);
  assert.doesNotMatch(html, /async function startOnboarding/);
});

test('nothing in the probe or the notice disables, hides, or returns early from a step', () => {
  const probe = extractFunction(html, 'onboardingProbeWriteAccess');
  const render = extractFunction(html, 'onboardingRenderWriteNotice');
  for (const [name, src] of [['probe', probe], ['render', render]]) {
    assert.doesNotMatch(src, /\.disabled\s*=/, `${name} must not disable any control`);
    assert.doesNotMatch(src, /switchOnboardingStep|switchCoachView/, `${name} must not move the user`);
    assert.doesNotMatch(src, /showToast|alert\(|confirm\(/, `${name} must not interrupt the user`);
  }
  // The only element either one touches is its own notice div.
  assert.deepEqual(
    [...render.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
    ['onboarding-write-warning'],
  );
});

test('the probe swallows every error itself rather than relying on its caller', () => {
  const probe = extractFunction(html, 'onboardingProbeWriteAccess');
  assert.match(probe, /try \{/);
  assert.match(probe, /catch \(_\) \{/);
  // The whole await is inside the try.
  assert.ok(probe.indexOf('try {') < probe.indexOf('await fetchHealth'));
  assert.ok(probe.indexOf('await fetchHealth') < probe.indexOf('catch (_)'));
});

test('the notice reuses /api/health rather than a new endpoint', () => {
  const probe = extractFunction(html, 'onboardingProbeWriteAccess');
  assert.match(probe, /fetchHealth\(/);
  assert.doesNotMatch(probe, /fetch\(['"]\/api\//, 'no bespoke endpoint call');
});

test('the warning markup exists, starts hidden, and is empty until the probe answers', () => {
  const m = /<div id="onboarding-write-warning"([^>]*)>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(m, 'the warning div must exist');
  assert.match(m[1], /display:none/);
  assert.equal(m[2].trim(), '', 'it must ship empty — no hardcoded accusation');
});

// ── It has to be visible on the step the user is actually ON ─────────────────
//
// THE BUG. The notice lived INSIDE #onboarding-step-input. onboardingResumeSaved
// restores to the step the run was SAVED on — conversation, companies,
// download — and switchOnboardingStep hides every other panel. So on a resumed
// run the probe fired, onboardingRenderWriteNotice() set display on the element,
// and nothing appeared, because its parent panel was hidden. The user CLOSEST to
// the save button was the one guaranteed never to be warned.
//
// The test that was supposed to cover this asserted only that
// onboardingProbeWriteAccess() was CALLED before the resume prompt. It passed
// throughout. Ordering is not visibility, so these assert visibility.

test('the notice lives OUTSIDE the step panels, like the discard confirmation', () => {
  // #onboarding-discard-confirm is outside the panels for exactly this reason:
  // it belongs to the view, not to one step.
  const noticeIdx = html.indexOf('<div id="onboarding-write-warning"');
  assert.notEqual(noticeIdx, -1);
  const viewIdx = html.indexOf('<div id="coach-onboarding-view"');
  assert.notEqual(viewIdx, -1);
  assert.ok(noticeIdx > viewIdx, 'it must be inside the onboarding view');

  // No step panel may enclose it. Walk the panels and check the notice is not
  // between a panel's opening tag and the start of the next one.
  const ONBOARDING_STEPS = ['input', 'conversation', 'refresh-notes', 'companies',
    'generating', 'bulletbank', 'bulletbankchat', 'download'];
  const panelStarts = ONBOARDING_STEPS.map(s => {
    const i = html.indexOf(`<div id="onboarding-step-${s}"`);
    assert.notEqual(i, -1, `step panel ${s} not found`);
    return { s, i };
  }).sort((a, b) => a.i - b.i);
  // Everything from the first panel to the last panel's end is step territory.
  assert.ok(
    noticeIdx < panelStarts[0].i,
    `the notice sits inside/after the step panels (first panel: ${panelStarts[0].s})`,
  );
});

test('the notice is above the resume prompt, so it shows while that prompt is up', () => {
  // onboardingShowResumePrompt hides every step panel and shows only
  // #onboarding-resume-confirm — the notice must not be inside that either.
  const noticeIdx = html.indexOf('<div id="onboarding-write-warning"');
  const resumeIdx = html.indexOf('<div id="onboarding-resume-confirm"');
  assert.notEqual(resumeIdx, -1);
  assert.ok(noticeIdx < resumeIdx, 'the notice must precede, not nest inside, the resume prompt');
});

test('a RESUMED run on a non-input step actually DISPLAYS the notice', () => {
  // The real failure, reproduced: render the notice, then run the step switch a
  // resume performs, and assert the notice is still displayed afterwards.
  // Parent visibility is modelled, which is the thing the old test could not see.
  const body = [
    extractFunction(html, 'onboardingRenderWriteNotice'),
    extractFunction(html, 'switchOnboardingStep'),
  ].join('\n\n');

  const ONBOARDING_STEPS = ['input', 'conversation', 'refresh-notes', 'companies',
    'generating', 'bulletbank', 'bulletbankchat', 'download'];

  // Which panel, if any, encloses the notice in the real markup.
  const noticeIdx = html.indexOf('<div id="onboarding-write-warning"');
  let enclosing = null;
  for (const s of ONBOARDING_STEPS) {
    const open = html.indexOf(`<div id="onboarding-step-${s}"`);
    if (open === -1 || open > noticeIdx) continue;
    // Walk div depth from the panel's opening tag to the notice; depth > 0 means
    // the notice is still inside that panel.
    const seg = html.slice(open, noticeIdx);
    let depth = 0;
    for (const tok of seg.match(/<div\b|<\/div>/g) || []) depth += tok === '</div>' ? -1 : 1;
    if (depth > 0) enclosing = s;
  }

  for (const restored of ['conversation', 'companies', 'download', 'bulletbank']) {
    const notice = { style: { display: 'none' }, children: [], className: '',
      appendChild(n) { this.children.push(n); },
      set textContent(v) { if (!v) this.children.length = 0; },
      get textContent() { return this.children.map(c => c.textContent).join(' '); } };
    const panels = {};
    ONBOARDING_STEPS.forEach(s => { panels[s] = { style: { display: '' } }; });

    const document = {
      getElementById: (id) => {
        if (id === 'onboarding-write-warning') return notice;
        const m = /^onboarding-step-(.+)$/.exec(id);
        if (m && panels[m[1]]) return panels[m[1]];
        return null;
      },
      createElement: () => ({ className: '', textContent: '' }),
    };

    const factory = new Function('document', 'ONBOARDING_STEPS', `
      'use strict';
      let onboardingWriteNotice = { message: 'Your token cannot write.', fix: 'Fix it in Vercel.' };
      // The bits of the real switchOnboardingStep that are not about panel
      // visibility, stubbed so the panel-hiding behaviour runs for real.
      let onboardingStep = null;
      let onboardingResult = null;
      const onboardingHideDiscardConfirm = () => {};
      const onboardingPersist = () => {};
      ${body}
      return {
        render: () => onboardingRenderWriteNotice(),
        step: (s) => switchOnboardingStep(s),
      };
    `);
    const api = factory(document, ONBOARDING_STEPS);

    // What a resume does: restore the saved step, then re-assert the notice.
    api.step(restored);
    api.render();

    assert.equal(notice.style.display, '', `notice hidden on resumed step ${restored}`);
    assert.ok(notice.children.length >= 2, `notice empty on resumed step ${restored}`);
    // And the decisive part: whatever panel encloses it (if any) must not be the
    // one switchOnboardingStep just hid.
    const parentVisible = enclosing === null || panels[enclosing].style.display === '';
    assert.ok(
      parentVisible,
      `the notice is inside #onboarding-step-${enclosing}, which is hidden when the run resumes on "${restored}" — it would render into an invisible panel`,
    );
  }
});

test('onboardingResumeSaved re-asserts the notice, as onboardingFreshStart does', () => {
  // The probe may have answered while the resume prompt was on screen; without
  // this the DOM keeps whatever it had rather than the current state.
  const resume = extractFunction(html, 'onboardingResumeSaved');
  assert.match(resume, /onboardingRenderWriteNotice\(\)/,
    'a resumed run must re-render the notice against current state');
  assert.match(extractFunction(html, 'onboardingFreshStart'), /onboardingRenderWriteNotice\(\)/);
});

test('the server\'s sentences are rendered as DATA, never as markup', () => {
  const render = extractFunction(html, 'onboardingRenderWriteNotice');
  assert.match(render, /textContent = onboardingWriteNotice\.message/);
  assert.match(render, /textContent = onboardingWriteNotice\.fix/);
  // Match an ASSIGNMENT, not the bare word — the function's own comment explains
  // why innerHTML is avoided, and a substring test would flag that comment.
  assert.doesNotMatch(render, /innerHTML\s*=/, 'health messages must never be injected as HTML');
  assert.doesNotMatch(render, /insertAdjacentHTML|outerHTML\s*=/);
});
