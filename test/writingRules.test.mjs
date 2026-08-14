import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ANTI_AI_WRITING_RULES } from '../lib/writingRules.mjs';

// These tests exist so a future refactor cannot silently drop the anti-AI
// writing rules from one of the four generation paths. Prompt construction in
// those modules is not exported (it is inlined in functions that call the
// Anthropic API), so the call sites are checked at the source level. Each file
// must (a) import the shared constant, (b) interpolate it INSIDE the specific
// prompt template named below — not in a comment or some dead string — and
// (c) still wire that template into the request actually sent to the API.
// (b) and (c) together are what make this more than a text search: the
// interpolation has to sit on a live code path to pass.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(root + rel, 'utf8');

const CALL_SITES = [
  {
    file: 'api/outreach.js',
    specifier: '../lib/writingRules.mjs',
    // The rules go into the systemPrompt template...
    template: 'const systemPrompt =',
    // ...and systemPrompt is what the request sends as its system prompt.
    reaches: [/system:\s*systemPrompt\b/],
  },
  {
    file: 'api/coach.js',
    specifier: '../lib/writingRules.mjs',
    template: 'const AUTHORING_SYSTEM =',
    // AUTHORING_SYSTEM -> baseSystem -> systemPrompt -> system field.
    reaches: [
      /baseSystem\s*=[\s\S]{0,500}?AUTHORING_SYSTEM\(/,
      /const systemPrompt = memoryPrefix \+ baseSystem/,
      /system:\s*\[\{[^\]]*text:\s*systemPrompt/,
    ],
  },
  {
    file: 'scanner/interviewPackage.mjs',
    specifier: '../lib/writingRules.mjs',
    template: 'const userPrompt =',
    reaches: [/content:\s*userPrompt\b/],
  },
  {
    file: 'scanner/applicationPackage.mjs',
    specifier: '../lib/writingRules.mjs',
    // The rules are appended to resumeFormatAndClosing, which is interpolated
    // into the trailing (uncached) system block.
    template: 'const resumeFormatAndClosing =',
    reaches: [/\$\{resumeFormatAndClosing\}/, /system:\s*systemPrompt\b/],
  },
];

// Returns the raw source of the template literal a named declaration is
// assigned to, so assertions can be scoped to that one template.
function templateLiteralFor(src, declMarker) {
  const declAt = src.indexOf(declMarker);
  assert.notEqual(declAt, -1, `could not find declaration: ${declMarker}`);
  const open = src.indexOf('`', declAt);
  assert.notEqual(open, -1, `no template literal after: ${declMarker}`);
  let depth = 0;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '$' && src[i + 1] === '{') { depth++; i++; continue; }
    if (c === '}' && depth > 0) { depth--; continue; }
    if (c === '`' && depth === 0) return src.slice(open + 1, i);
  }
  assert.fail(`unterminated template literal after: ${declMarker}`);
}

// ── The shared block itself ──────────────────────────────────────────────────

test('writingRules exports a non-empty string constant', () => {
  assert.equal(typeof ANTI_AI_WRITING_RULES, 'string');
  assert.ok(ANTI_AI_WRITING_RULES.length > 500);
});

test('shared block carries all four rule sections', () => {
  for (const section of ['VOICE:', 'BANNED WORDS', 'BANNED PHRASES', 'BANNED FORMATTING']) {
    assert.ok(ANTI_AI_WRITING_RULES.includes(section), `missing section: ${section}`);
  }
});

test('shared block bans every word from the merged outreach and coach lists', () => {
  const words = [
    'leverage', 'synergy', 'innovative', 'align', 'foster', 'showcase', 'enhance',
    'streamline', 'elevate', 'empower', 'transformative', 'seamless', 'robust',
    'dynamic', 'pivotal', 'crucial', 'underscore', 'highlight',
    'accelerate', 'pioneering', 'holistic',
  ];
  const bannedLine = ANTI_AI_WRITING_RULES.split('BANNED WORDS')[1].split('BANNED PHRASES')[0];
  for (const w of words) {
    assert.ok(bannedLine.includes(w), `banned-words line is missing: ${w}`);
  }
});

test('shared block bans the key phrases and formatting tics', () => {
  for (const phrase of [
    'serves as', 'stands as', 'represents a', 'plays a role in', 'helps to',
    'aims to', 'seeks to', 'Furthermore', 'Additionally', 'Moreover',
    'I hope this message finds you well', 'I wanted to reach out',
    'I am very passionate about', 'would love to connect',
  ]) {
    assert.ok(ANTI_AI_WRITING_RULES.includes(phrase), `missing banned phrase: ${phrase}`);
  }
  assert.ok(ANTI_AI_WRITING_RULES.includes('No em dashes'));
  assert.ok(ANTI_AI_WRITING_RULES.includes('double dashes'));
  assert.ok(ANTI_AI_WRITING_RULES.includes('three parallel items'));
});

test('shared block stays generic — no person-specific or employer-specific content', () => {
  for (const leak of ['Nikita', 'Parekh', 'Goldman', 'Turing', 'Georgetown', 'runway', 'CareerOps']) {
    assert.ok(
      !ANTI_AI_WRITING_RULES.includes(leak),
      `shared writing rules must not mention "${leak}"`,
    );
  }
  // The block ships verbatim to the public repo, so it must also be free of
  // gendered pronouns for the user and of personal-detail tells. Word
  // boundaries keep innocent substrings (e.g. "sheet", "there") from matching.
  for (const [pattern, label] of [
    [/\bshe\b/i, 'she'],
    [/\bher(s|self)?\b/i, 'her'],
    [/\bPADI\b/i, 'PADI'],
    [/dollar savings/i, 'dollar savings'],
  ]) {
    assert.ok(
      !pattern.test(ANTI_AI_WRITING_RULES),
      `shared writing rules must not mention "${label}"`,
    );
  }
});

// ── The four call sites ──────────────────────────────────────────────────────

for (const { file, specifier, template, reaches } of CALL_SITES) {
  test(`${file} imports the shared writing rules`, () => {
    const src = read(file);
    const importRe = new RegExp(
      `import\\s*\\{[^}]*ANTI_AI_WRITING_RULES[^}]*\\}\\s*from\\s*['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    );
    assert.match(src, importRe);
  });

  test(`${file} interpolates the shared writing rules into a live prompt`, () => {
    const src = read(file);
    assert.ok(
      src.includes('${ANTI_AI_WRITING_RULES}'),
      `${file} imports the constant but never injects it into a prompt template`,
    );

    const body = templateLiteralFor(src, template);
    assert.ok(
      body.includes('${ANTI_AI_WRITING_RULES}'),
      `${file} injects the rules somewhere, but not inside the template declared by "${template}"`,
    );

    for (const re of reaches) {
      assert.match(
        src,
        re,
        `${file}: the template declared by "${template}" no longer reaches the API call (missing ${re})`,
      );
    }
  });
}

// ── Regression guards for what the centralisation replaced ───────────────────

test('outreach no longer keeps its own inline banned-words list', () => {
  const src = read('api/outreach.js');
  assert.ok(!src.includes('leverage, synergy, innovative'));
});

test('coach no longer keeps its own seven-word banned list', () => {
  const src = read('api/coach.js');
  assert.ok(!src.includes('transformative, accelerate, leverage, seamless, robust, pioneering, holistic'));
});

test('interview prep no longer keeps its own inline banned list', () => {
  const src = read('scanner/interviewPackage.mjs');
  assert.ok(!src.includes('no banned words (transformative'));
});

test('resume format rules ban em dashes explicitly, not just double dashes', () => {
  const src = read('scanner/applicationPackage.mjs');
  assert.match(src, /NEVER use double dashes \( -- \) or em dashes/);
});

test('applicationPackage keeps its cache breakpoint structure intact', () => {
  const src = read('scanner/applicationPackage.mjs');
  // Bullet bank block still carries the cache breakpoint, and the writing rules
  // were appended to the trailing (uncached) block via resumeFormatAndClosing.
  // v1.2 split the AI-suggested section out of the bank, so the cached text is
  // now bankBody (the verbatim-source half) rather than the whole bulletBank.
  assert.ok(src.includes("text: bankBody,"));
  assert.match(src, /text: bankBody,\s*\n\s*cache_control: \{ type: 'ephemeral' \}/);
  assert.ok(src.includes('${bulletSelectionRules}${guidanceSection}${resumeFormatAndClosing}'));
});

test('applicationPackage scopes the conversational VOICE rules away from the resume body', () => {
  const src = read('scanner/applicationPackage.mjs');
  // Bans apply everywhere including the resume; contractions/first person are
  // for prose outputs only.
  assert.match(src, /BANNED WORDS, BANNED PHRASES, and BANNED FORMATTING rules below apply everywhere/);
  assert.match(src, /VOICE rules[\s\S]{0,200}?application-question answers/);
});
