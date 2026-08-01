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
  quarantineAiSuggestedLines,
  FALLBACK_ROLE_TAGS,
  RESERVED_TAGS,
  AI_SUGGESTED_TAG,
} from '../lib/bulletBank.mjs';
import {
  buildBulletSourceBlocks,
  parsePackageResponse,
  NO_RESUME_NOTE,
} from '../scanner/applicationPackage.mjs';

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

// ── The heading a model actually emits ────────────────────────────────────────
// Every miss here has the same consequence: the whole AI-written section stays
// inside the text handed to the model as the user's own verbatim resume words.

const BODY = '## Acme Corp | Ops Lead\n\n- Ran the quarterly planning process for 40 people `[ops][primary]`\n';
const SUGGESTION = '\n- Cut vendor spend by 18% across three contracts `[ai-suggested]`\nWhy: shows procurement ownership.\n';

for (const [name, heading] of [
  ['the canonical hash heading',      '## Suggested Additions (AI-written — not from your resume)'],
  ['a bold line with no hash at all', '**Suggested Additions (AI-written)**'],
  ['a hash heading wrapped in bold',  '## **Suggested Additions**'],
  ['a reworded AI- prefixed heading', '## AI-Suggested Additions'],
  ['the singular form',               '## Suggested Addition'],
  ['a lone-asterisk emphasis form',   '*Suggested Additions*'],
]) {
  test(`splitBulletBank quarantines the AI section behind ${name}`, () => {
    const { body, suggestions, hasSuggestions } = splitBulletBank(`${BODY}\n${heading}\n${SUGGESTION}`);
    assert.equal(hasSuggestions, true, `heading not recognised: ${heading}`);
    assert.ok(suggestions.includes('vendor spend'), 'the AI bullet did not land in suggestions');
    assert.ok(!body.includes('vendor spend'), 'the AI bullet stayed in the verbatim body');
    assert.ok(body.includes('quarterly planning'), 'a real resume bullet was lost from the body');
  });
}

test('splitBulletBank handles CRLF line endings', () => {
  const crlf = `${BODY}\n## Suggested Additions (AI-written)\n${SUGGESTION}`.replace(/\n/g, '\r\n');
  const { body, suggestions, hasSuggestions } = splitBulletBank(crlf);
  assert.equal(hasSuggestions, true);
  assert.ok(suggestions.includes('vendor spend'));
  assert.ok(!body.includes('vendor spend'));
  assert.ok(body.includes('quarterly planning'));
});

test('splitBulletBank does not treat ordinary prose as the suggestions heading', () => {
  const prose = '# Bullet Bank\n\nSuggested Additions are advisory only.\n\n- A real bullet `[ops]`\n';
  const { hasSuggestions, body } = splitBulletBank(prose);
  assert.equal(hasSuggestions, false);
  assert.equal(body, prose);
});

test('splitBulletBank ends the suggestions section at the next same-level heading', () => {
  const notLast = [
    BODY,
    '## Suggested Additions (AI-written)',
    SUGGESTION,
    '### A sub-heading inside the suggestions',
    '- Another AI idea `[ai-suggested]`',
    '',
    '## Beta Industries | Strategy Associate',
    '',
    '- Built the competitive teardown that reset pricing `[strategy][primary]`',
    '',
  ].join('\n');
  const { body, suggestions } = splitBulletBank(notLast);
  // The company section after the suggestions must survive as verbatim body.
  assert.ok(body.includes('competitive teardown'), 'a real resume bullet was swallowed by the suggestions slice');
  assert.ok(body.includes('quarterly planning'));
  assert.ok(!suggestions.includes('competitive teardown'));
  // A deeper heading inside the section is part of the section, not its end.
  assert.ok(suggestions.includes('Another AI idea'));
  assert.ok(suggestions.includes('vendor spend'));
});

test('the line-level [ai-suggested] gate catches what the headings miss', () => {
  // Heading the split cannot possibly recognise — the tag is the backstop.
  const weird = `${BODY}\n=== Things You Could Add ===\n${SUGGESTION}`;
  assert.equal(splitBulletBank(weird).hasSuggestions, false, 'precondition: the heading is unrecognised');

  const { bankBody, suggestionsBlock, hasSuggestions } = buildBulletSourceBlocks(weird, '');
  assert.equal(hasSuggestions, true);
  assert.ok(!bankBody.includes('vendor spend'), 'an [ai-suggested] bullet stayed in the verbatim body');
  assert.ok(!bankBody.includes('shows procurement ownership'), 'the Why: line stayed behind with the body');
  assert.ok(suggestionsBlock.includes('vendor spend'));
  assert.ok(suggestionsBlock.includes('shows procurement ownership'));
  assert.ok(bankBody.includes('quarterly planning'));
});

test('quarantineAiSuggestedLines leaves a clean body untouched', () => {
  const { kept, moved } = quarantineAiSuggestedLines(BODY);
  assert.equal(kept, BODY);
  assert.equal(moved, '');
});

// ── Tag legend: bold variants ─────────────────────────────────────────────────

test('parseBulletBankTags reads Tags with the colon outside the bold markers', () => {
  const tags = parseBulletBankTags('**Tags**: ops = Business Operations; gtm = Go-To-Market\n');
  assert.deepEqual(tags.map(t => t.value), ['ops', 'gtm']);
  assert.equal(tags[0].label, 'Business Operations');
});

test('parseBulletBankTags still reads the plain and fully-bolded forms', () => {
  assert.deepEqual(parseBulletBankTags('Tags: ops = Ops\n').map(t => t.value), ['ops']);
  assert.deepEqual(parseBulletBankTags('**Tags:** ops = Ops\n').map(t => t.value), ['ops']);
});

test('parseBulletBankTags ignores a legend hiding under a bold suggestions heading', () => {
  const text = 'Tags: ops = Ops\n\n**Suggested Additions (AI-written)**\n\nTags: sneaky = Nope\n';
  assert.deepEqual(parseBulletBankTags(text).map(t => t.value), ['ops']);
});

// ── A bank with headers but no bullets is not a bank ──────────────────────────

test('buildBulletSourceBlocks reports a bulletless bank as unusable', () => {
  // What a no-resume onboarding produces: the prompt routes everything the user
  // described into Suggested Additions, leaving bare company headers behind.
  const emptyBank = '# Bullet Bank\n\n## Acme Corp | Ops Lead\n\n## Suggested Additions (AI-written)\n' + SUGGESTION;
  const { usableBank, hasSuggestions } = buildBulletSourceBlocks(emptyBank, '');
  assert.equal(usableBank, false);
  assert.equal(hasSuggestions, true);
});

test('buildBulletSourceBlocks reports a bank with real bullets as usable', () => {
  assert.equal(buildBulletSourceBlocks(example, '').usableBank, true);
});

test('callClaude routes an unusable bank to the no-bank path', () => {
  assert.match(pkgSrc, /const useBank = !!bulletBank && usableBank;/);
  assert.match(pkgSrc, /const systemPrompt = useBank \?/);
});

// ── The disclosure reaches the prompt with no bank at all ─────────────────────

test('the no-bank prompt branches carry the provenance/disclosure text', () => {
  // Without this the disclosure was wired only into the bank-present branch, so
  // a user with neither a bank nor a cv.md was never told the wording was AI's.
  const noBankProvenance = pkgSrc.match(/const noBankProvenance = ([^\n]+)/);
  assert.ok(noBankProvenance, 'noBankProvenance is not assembled');
  assert.match(noBankProvenance[1], /provenanceBlock.*provenanceRules/);
  // Both no-bank branches (memory-prefixed array form, and the plain string
  // form) must interpolate it.
  const uses = pkgSrc.match(/\$\{noBankProvenance\}/g) || [];
  assert.equal(uses.length, 2, 'both no-bank prompt branches must include the disclosure');
});

test('provenanceRules is exported separately so the no-bank branch can use it', () => {
  const { provenanceRules } = buildBulletSourceBlocks('', '');
  assert.ok(provenanceRules.includes(NO_RESUME_NOTE));
  const withCv = buildBulletSourceBlocks('', 'x'.repeat(60));
  assert.match(withCv.provenanceRules, /PROVENANCE RULE/);
});

// ── cv.md is not shipped twice ────────────────────────────────────────────────

test('when cv.md IS the bank, it is not also sent as a second provenance copy', () => {
  const cv = '# CV\n\n## Acme Corp | Ops Lead\n\n- Ran the quarterly planning process for 40 people\n';
  const { provenanceBlock, hasCv } = buildBulletSourceBlocks(cv, cv);
  assert.equal(hasCv, true);
  assert.match(provenanceBlock, /RESUME OF RECORD/);
  assert.ok(!provenanceBlock.includes('quarterly planning'), 'cv.md was sent a second time');
  assert.ok(provenanceBlock.length < 400, 'the duplicate-suppressing block should be short');
});

test('a distinct cv.md is still shipped in full as the provenance source', () => {
  const cv = '# CV\n\n- Ran the quarterly planning process for 40 people, twice over\n'.repeat(3);
  const { provenanceBlock } = buildBulletSourceBlocks(example, cv);
  assert.ok(provenanceBlock.includes('quarterly planning'));
});

test('the cv.md log threshold matches the hasCv threshold', () => {
  assert.match(pkgSrc, /if \(cvMd\.trim\(\)\.length >= 50\) \{/);
});

// ── Truncation guard ──────────────────────────────────────────────────────────

test('parsePackageResponse refuses a reply cut off at the token limit', () => {
  const truncated = { stop_reason: 'max_tokens', content: [{ text: '{"resume":"half a jso' }] };
  assert.throws(() => parsePackageResponse(truncated), /cut off before it finished/);
});

test('parsePackageResponse parses a complete reply, fences and all', () => {
  const ok = { stop_reason: 'end_turn', content: [{ text: '```json\n{"resume":"done"}\n```' }] };
  assert.deepEqual(parsePackageResponse(ok), { resume: 'done' });
});

test('max_tokens leaves headroom for the enlarged atsText', () => {
  const m = pkgSrc.match(/max_tokens: (\d+),\n\s*system: systemPrompt/);
  assert.ok(m, 'could not find the package generation max_tokens');
  assert.ok(Number(m[1]) >= 7000, `max_tokens is ${m[1]}, too tight for the current atsText spec`);
});

// ── Failed generation is a failure, not a 200 ────────────────────────────────

test('apply-memory-to-profile returns 502 when nothing usable was generated', () => {
  const i = coachSrc.indexOf('generation returned no usable YAML');
  assert.notEqual(i, -1);
  assert.match(coachSrc.slice(i, i + 400), /res\.status\(502\)\.json\(\{ error:/);
});

test('bullet selection rules no longer hardcode the original author role types', () => {
  const { bulletSelectionRules } = buildBulletSourceBlocks(example, '');
  assert.doesNotMatch(bulletSelectionRules, /only if investing or corpdev is selected/);
  assert.doesNotMatch(bulletSelectionRules, /investing version for investing roles/);
  assert.match(bulletSelectionRules, /The user defines their own role-type tags/);
});
