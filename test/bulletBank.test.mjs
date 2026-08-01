// Pins the bullet-bank redesign: the bank's BODY is the user's own resume
// language, AI-written content is quarantined in a flagged section at the
// bottom, and neither the prompt nor the package generator may blur the two.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBulletBankTags,
  splitBulletBank,
  FALLBACK_ROLE_TAGS,
  RESERVED_TAGS,
  AI_SUGGESTED_TAG,
} from '../lib/bulletBank.mjs';
import { buildBulletSourceBlocks, NO_RESUME_NOTE } from '../scanner/applicationPackage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const coachSrc = readFileSync(join(ROOT, 'api', 'coach.js'), 'utf8');
const pkgSrc = readFileSync(join(ROOT, 'scanner', 'applicationPackage.mjs'), 'utf8');
const example = readFileSync(join(ROOT, 'bullet-bank.md.example'), 'utf8');

// Isolate the bullet-bank prompt so assertions cannot accidentally match text
// from one of the other onboarding prompts in the same file.
function bulletBankPrompt() {
  const start = coachSrc.indexOf('const BULLET_BANK_SYSTEM');
  assert.notEqual(start, -1, 'BULLET_BANK_SYSTEM not found in api/coach.js');
  const end = coachSrc.indexOf('function buildOnboardingShared', start);
  return coachSrc.slice(start, end === -1 ? undefined : end);
}

// ── The prompt ────────────────────────────────────────────────────────────────

test('BULLET_BANK_SYSTEM demands verbatim resume wording in the body', () => {
  const p = bulletBankPrompt();
  assert.match(p, /taken VERBATIM from the user's resume/);
  assert.match(p, /Do not paraphrase/);
  // The rejected design: variant bullets were license to rewrite the resume.
  assert.doesNotMatch(p, /write 2-3 variant bullets/);
  assert.match(p, /Do not create variants/);
});

test('BULLET_BANK_SYSTEM confines AI writing to a flagged bottom section', () => {
  const p = bulletBankPrompt();
  assert.match(p, /## Suggested Additions \(AI-written — not from your resume\)/);
  assert.match(p, new RegExp(`\\[${AI_SUGGESTED_TAG}\\]`));
  assert.match(p, /"Why:"/);
  // The strengthen-the-writing requirements must be scoped to suggestions only.
  assert.match(p, /WHICH APPLY ONLY TO THIS SECTION, never to a resume bullet/);
  assert.match(p, /Never fabricate a metric/);
});

test('BULLET_BANK_SYSTEM specifies the machine-readable Tags: legend line', () => {
  const p = bulletBankPrompt();
  assert.match(p, /Tags: slug = Human readable label; slug = Human readable label/);
  assert.match(p, /parsed by the app/);
});

test('both onboarding paths share the single bullet-bank prompt', () => {
  const uses = coachSrc.match(/system: BULLET_BANK_SYSTEM\(updatePrefix\)/g) || [];
  assert.equal(uses.length, 2, 'fresh and update paths must both use BULLET_BANK_SYSTEM');
});

// ── Tag legend parsing ────────────────────────────────────────────────────────

test('parseBulletBankTags reads the canonical Tags: legend line', () => {
  const tags = parseBulletBankTags('## How to Use This File\n\nTags: ops = Business Operations; gtm = Go-To-Market\n');
  assert.deepEqual(tags, [
    { value: 'ops', label: 'Business Operations' },
    { value: 'gtm', label: 'Go-To-Market' },
  ]);
});

test('parseBulletBankTags tolerates bold and bullet decoration on the legend line', () => {
  const tags = parseBulletBankTags('- **Tags:** `ops` = Ops Lead; **finance** = Strategic Finance\n');
  assert.deepEqual(tags.map(t => t.value), ['ops', 'finance']);
  assert.equal(tags[0].label, 'Ops Lead');
});

test('parseBulletBankTags falls back to a legacy bullet-list legend', () => {
  const legacy = '## How to Use This File\n\n- `[ops]` = Business Operations, Chief of Staff\n- `[strategy]` = Strategy, Corp Dev\n';
  assert.deepEqual(parseBulletBankTags(legacy).map(t => t.value), ['ops', 'strategy']);
});

test('parseBulletBankTags never returns priority or ai-suggested tags as role types', () => {
  const withReserved = 'Tags: ops = Ops; primary = nope; ai-suggested = nope; alt = nope\n';
  assert.deepEqual(parseBulletBankTags(withReserved).map(t => t.value), ['ops']);
  for (const reserved of RESERVED_TAGS) {
    assert.ok(!FALLBACK_ROLE_TAGS.some(t => t.value === reserved));
  }
});

test('parseBulletBankTags ignores tags that appear only on bullets, and bad input', () => {
  // Inline bullet tags are noise — only the legend counts.
  assert.deepEqual(parseBulletBankTags('- Did a thing `[ops][primary]`\n'), []);
  assert.deepEqual(parseBulletBankTags(''), []);
  assert.deepEqual(parseBulletBankTags(null), []);
  assert.deepEqual(parseBulletBankTags('Tags: not a slug!! = x\n'), []);
});

test('parseBulletBankTags does not read the suggestions section', () => {
  const text = 'Tags: ops = Ops\n\n## Suggested Additions (AI-written)\n\nTags: sneaky = Nope\n';
  assert.deepEqual(parseBulletBankTags(text).map(t => t.value), ['ops']);
});

test('the shipped example parses into role tags with the new format', () => {
  const tags = parseBulletBankTags(example);
  assert.deepEqual(tags.map(t => t.value), ['ops', 'strategy', 'finance']);
});

// ── Body / suggestions split ──────────────────────────────────────────────────

test('splitBulletBank separates the suggestions section from the verbatim body', () => {
  const { body, suggestions, hasSuggestions } = splitBulletBank(example);
  assert.ok(hasSuggestions);
  assert.match(suggestions, /^## Suggested Additions/);
  assert.match(suggestions, new RegExp(`\\[${AI_SUGGESTED_TAG}\\]`));
  // The AI-written bullets must NOT remain in the body handed over as verbatim source.
  // No BULLET in the body may carry the flag (the file's format comment may name it).
  assert.doesNotMatch(body, /^\s*-.*\[ai-suggested\]/m, 'an ai-suggested bullet stayed in the body');
  assert.ok(!body.includes('vendor consolidation'), 'suggestion text leaked into the body');
  assert.match(body, /Redesigned the quarterly planning process/);
});

test('splitBulletBank passes a bank with no suggestions section through unchanged', () => {
  const plain = '# Bullet Bank\n\n- Did a thing `[ops][primary]`\n';
  const { body, suggestions, hasSuggestions } = splitBulletBank(plain);
  assert.equal(body, plain);
  assert.equal(suggestions, '');
  assert.equal(hasSuggestions, false);
});

test('the shipped example demonstrates the verbatim body + flagged suggestions format', () => {
  assert.match(example, /## Suggested Additions \(AI-written — not from your resume\)/);
  assert.match(example, /Why: /);
  assert.match(example, /^Tags: /m);
  assert.match(example, /VERBATIM from\s+your resume/);
});

// ── Package generation: ai-suggested never reaches the resume body ────────────

test('buildBulletSourceBlocks quarantines suggestions and bans them from the resume', () => {
  const { bankBody, suggestionsBlock, bulletSelectionRules, hasSuggestions } =
    buildBulletSourceBlocks(example, '');
  assert.ok(hasSuggestions);
  assert.doesNotMatch(bankBody, /^\s*-.*\[ai-suggested\]/m);
  assert.match(suggestionsBlock, /NEVER PUT THESE IN THE RESUME/);
  assert.match(suggestionsBlock, /BANNED from the "resume" field/);
  assert.match(bulletSelectionRules, new RegExp(`\\[${AI_SUGGESTED_TAG}\\][^\\n]*BANNED from the resume field`));
});

test('buildBulletSourceBlocks loads cv.md as the provenance check when present', () => {
  const cv = '# CV\n\n- Ran the thing and it went well, twice over, for three years running\n'.repeat(3);
  const { provenanceBlock, bulletSelectionRules, hasCv } = buildBulletSourceBlocks(example, cv);
  assert.equal(hasCv, true);
  assert.match(provenanceBlock, /RESUME OF RECORD \(cv\.md\)/);
  assert.ok(provenanceBlock.includes('Ran the thing'));
  assert.match(bulletSelectionRules, /PROVENANCE RULE/);
  assert.match(bulletSelectionRules, /traceable to the RESUME OF RECORD/);
  // An untraceable bank bullet gets identical treatment to an explicit flag.
  assert.match(bulletSelectionRules, new RegExp(`as if it were tagged \\[${AI_SUGGESTED_TAG}\\]`));
});

test('buildBulletSourceBlocks degrades honestly when cv.md is absent', () => {
  const { provenanceBlock, bulletSelectionRules, hasCv } = buildBulletSourceBlocks(example, '');
  assert.equal(hasCv, false);
  assert.equal(provenanceBlock, '');
  assert.match(bulletSelectionRules, /PROVENANCE NOTE/);
  assert.ok(bulletSelectionRules.includes(NO_RESUME_NOTE));
  assert.match(NO_RESUME_NOTE, /AI-drafted/);
});

test('generateAndSendPackage reads cv.md unconditionally, not only as a bank fallback', () => {
  assert.match(pkgSrc, /readFileFromRepo\(githubToken, owner, repo, 'cv\.md'\)\.catch\(\(\) => ''\)/);
  assert.match(pkgSrc, /callClaude\(anthropicApiKey, articleDigest, bulletBank, job, roleTypes, additionalGuidance, memoryBlock, cvMd\)/);
});

test('the package prompt routes banned bullets into an atsText suggestions area', () => {
  assert.match(pkgSrc, /SUGGESTED ADDITIONS/);
  assert.match(pkgSrc, /failed the provenance check/);
});

test('bullet selection rules no longer hardcode the original author role types', () => {
  const { bulletSelectionRules } = buildBulletSourceBlocks(example, '');
  assert.doesNotMatch(bulletSelectionRules, /only if investing or corpdev is selected/);
  assert.doesNotMatch(bulletSelectionRules, /investing version for investing roles/);
  assert.match(bulletSelectionRules, /The user defines their own role-type tags/);
});
