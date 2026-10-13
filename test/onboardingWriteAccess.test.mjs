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
  // It must come before the early return for the resume prompt, so a user
  // resuming a saved run is warned too.
  assert.ok(
    start.indexOf('onboardingProbeWriteAccess()') < start.indexOf('onboardingShowResumePrompt'),
    'the probe must also cover the resume-prompt path',
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
  assert.ok(m, 'the warning div must exist in the input step');
  assert.match(m[1], /display:none/);
  assert.equal(m[2].trim(), '', 'it must ship empty — no hardcoded accusation');
  // Inside the first onboarding screen, where someone entering the flow sees it.
  const stepStart = html.indexOf('<div id="onboarding-step-input">');
  assert.ok(stepStart !== -1);
  assert.ok(html.indexOf('<div id="onboarding-write-warning"') > stepStart);
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
