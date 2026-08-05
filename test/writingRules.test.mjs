import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ANTI_AI_WRITING_RULES } from '../lib/writingRules.mjs';

// These tests exist so a future refactor cannot silently drop the anti-AI
// writing rules from one of the four generation paths. Prompt construction in
// those modules is not exported (it is inlined in functions that call the
// Anthropic API), so the call sites are checked at the source level: each file
// must import the shared constant AND interpolate it into a prompt.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(root + rel, 'utf8');

const CALL_SITES = [
  ['api/outreach.js', '../lib/writingRules.mjs'],
  ['api/coach.js', '../lib/writingRules.mjs'],
  ['scanner/interviewPackage.mjs', '../lib/writingRules.mjs'],
  ['scanner/applicationPackage.mjs', '../lib/writingRules.mjs'],
];

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
});

// ── The four call sites ──────────────────────────────────────────────────────

for (const [file, specifier] of CALL_SITES) {
  test(`${file} imports the shared writing rules`, () => {
    const src = read(file);
    const importRe = new RegExp(
      `import\\s*\\{[^}]*ANTI_AI_WRITING_RULES[^}]*\\}\\s*from\\s*['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    );
    assert.match(src, importRe);
  });

  test(`${file} interpolates the shared writing rules into a prompt`, () => {
    const src = read(file);
    assert.ok(
      src.includes('${ANTI_AI_WRITING_RULES}'),
      `${file} imports the constant but never injects it into a prompt template`,
    );
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
  assert.ok(src.includes("text: bulletBank,"));
  assert.match(src, /text: bulletBank,\s*\n\s*cache_control: \{ type: 'ephemeral' \}/);
  assert.ok(src.includes('${bulletSelectionRules}${guidanceSection}${resumeFormatAndClosing}'));
});
