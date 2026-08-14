// The package score is measured, not guessed.
//
// It used to be a number the model invented ("ATS SCORE ESTIMATE — Score:
// 7/10"). It clustered on 6-7 regardless of input, no real ATS works that way,
// and a staging package scored 6/10 on a resume that still said [YOUR NAME].
// The score now comes from two things this code checks itself — how many of the
// JD's key terms literally appear in the resume, and whether any bracketed
// placeholders remain — and it is shown with its arithmetic visible.
//
// These tests pin the arithmetic, so a regression cannot quietly restore a
// number nobody can defend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLooseJson,
  parseDraftQAResponse,
  parsePackageResponse,
  findPlaceholders,
  computeKeywordCoverage,
  computePackageScore,
  placeholderGateLine,
  finalizePackage,
} from '../scanner/applicationPackage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgSrc = readFileSync(join(__dirname, '..', 'scanner', 'applicationPackage.mjs'), 'utf8');

// ── Tolerating a model that will not just answer in JSON ─────────────────────
// The draft-Q&A call failed on EVERY staging run with `Unexpected token 'I'`:
// the model opened with a sentence of prose despite being told to return JSON
// only, JSON.parse threw on the first character, and the user saw nothing.

const QA = [{ question: 'Q1', answer: 'A1' }];

test('parseDraftQAResponse survives prose before the JSON', () => {
  const raw = 'I will draft these for you.\n\n{"draftResponses":[{"question":"Q1","answer":"A1"}]}';
  assert.deepEqual(parseDraftQAResponse(raw), QA);
});

test('parseDraftQAResponse salvages a reply whose opening brace is missing', () => {
  // Not a shape we expect under structured outputs — a backstop for a reply
  // that arrives structurally damaged. The array carve-out still finds it.
  assert.deepEqual(parseDraftQAResponse('"draftResponses":[{"question":"Q1","answer":"A1"}]}'), QA);
});

test('parseDraftQAResponse strips markdown fences', () => {
  assert.deepEqual(parseDraftQAResponse('```json\n{"draftResponses":[{"question":"Q1","answer":"A1"}]}\n```'), QA);
});

test('parseDraftQAResponse accepts a bare top-level array', () => {
  assert.deepEqual(parseDraftQAResponse('[{"question":"Q1","answer":"A1"}]'), QA);
  // Even wrapped in prose on both sides.
  assert.deepEqual(parseDraftQAResponse('Sure! [{"question":"Q1","answer":"A1"}] Hope that helps.'), QA);
});

test('parseDraftQAResponse returns null — not [] — when nothing parses', () => {
  // null is "could not parse", which the caller logs. An empty array would be
  // indistinguishable from a model that legitimately had nothing to say.
  assert.equal(parseDraftQAResponse('I am unable to help with that request.'), null);
  assert.equal(parseDraftQAResponse(''), null);
  assert.equal(parseDraftQAResponse(null), null);
});

test('parseDraftQAResponse drops junk entries but keeps usable ones', () => {
  const raw = '{"draftResponses":[{"question":"Q1","answer":"A1"},null,"nope",{"question":"","answer":""}]}';
  assert.deepEqual(parseDraftQAResponse(raw), QA);
});

test('callClaudeDraftQA logs the reply shape when it cannot parse', () => {
  // The old log said only "Unexpected token 'I'", which told the next debugging
  // session nothing about what actually came back.
  assert.match(pkgSrc, /could not parse the model reply\. First 120 characters: \$\{text\.slice\(0, 120\)\}/);
});

test('the draft-QA request asks the API to guarantee the JSON shape', () => {
  // Structured outputs replace the prose-preamble problem at the source. The
  // schema must satisfy the API's rules: additionalProperties:false and
  // required on every object.
  const body = pkgSrc.slice(pkgSrc.indexOf('async function callClaudeDraftQA'));
  assert.match(body, /output_config: \{\s*format: \{\s*type: 'json_schema',\s*schema: \{/);
  assert.match(body, /draftResponses: \{\s*type: 'array'/);
  assert.match(body, /required: \['question', 'answer'\],\s*additionalProperties: false,/);
  assert.match(body, /required: \['draftResponses'\],\s*additionalProperties: false,/);
});

test('the draft-QA request does NOT use assistant prefill', () => {
  // Prefill returns HTTP 400 on this model generation — it was the previous
  // fix for the prose-preamble failure and must not come back.
  const body = pkgSrc.slice(
    pkgSrc.indexOf('async function callClaudeDraftQA'),
    pkgSrc.indexOf('export async function generateAndSendPackage'),
  );
  assert.ok(!/role: 'assistant'/.test(body), 'an assistant prefill turn is back in the request');
  // Every turn in the request is a user turn, so messages necessarily ends on one.
  const roles = [...body.matchAll(/role: '(\w+)'/g)].map(m => m[1]);
  assert.ok(roles.length > 0, 'no message turns found');
  assert.deepEqual([...new Set(roles)], ['user'], `unexpected roles: ${roles.join(', ')}`);
});

test('parseLooseJson carves the payload out of surrounding prose', () => {
  assert.deepEqual(parseLooseJson('Here you go: {"a":1} — enjoy'), { a: 1 });
  assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLooseJson('[1,2]'), [1, 2]);
  assert.equal(parseLooseJson('no json here'), undefined);
  assert.equal(parseLooseJson(''), undefined);
});

// The main package parse would have choked on exactly the same pattern.
test('parsePackageResponse also tolerates a prose prefix', () => {
  const data = { stop_reason: 'end_turn', content: [{ text: 'Here is the package:\n{"resume":"done"}' }] };
  assert.deepEqual(parsePackageResponse(data), { resume: 'done' });
});

test('parsePackageResponse still throws on truncation, before anything else', () => {
  const truncated = { stop_reason: 'max_tokens', content: [{ text: '{"resume":"half a jso' }] };
  assert.throws(() => parsePackageResponse(truncated), /cut off before it finished/);
});

test('parsePackageResponse reports the reply shape when nothing parses', () => {
  const junk = { stop_reason: 'end_turn', content: [{ text: 'I cannot help with that.' }] };
  assert.throws(() => parsePackageResponse(junk), /no parseable JSON.*I cannot help with that\./s);
});

// ── Placeholder detection ────────────────────────────────────────────────────

test('findPlaceholders finds the bracketed tokens a draft must not ship with', () => {
  const resume = [
    '[YOUR NAME]',
    'Austin, TX | [Phone] | alex@example.com',
    '• Cut spend by [ADD: specific number]% across [X] contracts',
    '[School Name] | BS Economics',
  ].join('\n');
  assert.deepEqual(findPlaceholders(resume), [
    '[YOUR NAME]', '[Phone]', '[ADD: specific number]', '[X]', '[School Name]',
  ]);
});

// A one-character placeholder is the most common AI-drafting tell of all, and
// an unfilled [X]% is exactly the not-submittable case.
test('single-character placeholders are caught', () => {
  assert.deepEqual(findPlaceholders('Grew revenue [X]% in one year'), ['[X]']);
  assert.deepEqual(findPlaceholders('Led [N] teams across [Y] regions'), ['[N]', '[Y]']);
});

test('findPlaceholders dedupes case-insensitively, keeping first appearance', () => {
  const found = findPlaceholders('[Your Name] did a thing\nlater, [YOUR NAME] again\nand [Your Name]');
  assert.deepEqual(found, ['[Your Name]']);
});

test('findPlaceholders leaves a clean resume alone', () => {
  const clean = 'ALEX DOE\nAustin, TX | alex@example.com\n\n• Cut spend by 18% across 14 contracts';
  assert.deepEqual(findPlaceholders(clean), []);
  assert.deepEqual(findPlaceholders(''), []);
  assert.deepEqual(findPlaceholders(null), []);
});

test('findPlaceholders will not swallow a paragraph or match an empty pair', () => {
  // Needs 1-60 chars and no newline, so an empty [] is ignored, a single
  // character counts, and an unclosed bracket cannot run across lines.
  assert.deepEqual(findPlaceholders('[] and [a]'), ['[a]']);
  assert.deepEqual(findPlaceholders('[open\nclosed]'), []);
  assert.deepEqual(findPlaceholders(`[${'z'.repeat(61)}]`), []);
  assert.deepEqual(findPlaceholders(`[${'z'.repeat(60)}]`), [`[${'z'.repeat(60)}]`]);
});

// ── Keyword coverage ─────────────────────────────────────────────────────────

const RESUME = 'ALEX DOE\n• Ran Stakeholder Management across SQL pipelines and demand forecasting';

test('computeKeywordCoverage matches exact phrases, case-insensitively', () => {
  const c = computeKeywordCoverage(RESUME, ['stakeholder management', 'SQL', 'Demand Forecasting', 'kubernetes']);
  assert.deepEqual(c.present, ['stakeholder management', 'SQL', 'Demand Forecasting']);
  assert.deepEqual(c.missing, ['kubernetes']);
  assert.equal(c.total, 4);
});

test('computeKeywordCoverage does not credit a paraphrase', () => {
  // "forecasting demand" is not "demand forecasting" — a keyword filter would
  // not have matched it either, and a generous check would rebuild the fiction.
  const c = computeKeywordCoverage('I did forecasting of demand', ['demand forecasting']);
  assert.deepEqual(c.present, []);
  assert.deepEqual(c.missing, ['demand forecasting']);
});

// Raw substring matching inflated the score with matches no human would accept.
// Every one of these was reported "Present:" and paid out points.
test('a term is not credited just for hiding inside a longer word', () => {
  const resume = 'Wrote detailed plans in MySQL for our React app';
  const c = computeKeywordCoverage(resume, ['AI', 'SQL', 'R', 'React']);
  assert.deepEqual(c.present, ['React'], 'a substring-only match was credited');
  assert.deepEqual(c.missing, ['AI', 'SQL', 'R']);
});

test('a term with edge punctuation still matches literally', () => {
  // \b is defined against word characters, so it misbehaves at a '+' or a
  // leading '.' — those terms fall back to containment.
  const resume = 'Built services in C++ and .NET Core';
  const c = computeKeywordCoverage(resume, ['C++', '.NET']);
  assert.deepEqual(c.present, ['C++', '.NET']);
  assert.deepEqual(c.missing, []);
});

test('regex metacharacters in a term are matched literally, never as a pattern', () => {
  const c = computeKeywordCoverage('I know C++ well', ['C..', 'C++']);
  assert.deepEqual(c.present, ['C++'], 'a metacharacter was interpreted as a pattern');
  assert.deepEqual(c.missing, ['C..']);
});

test('multi-word and hyphenated phrases anchor on both ends', () => {
  const resume = 'Owned post-sales execution for the enterprise tier';
  assert.deepEqual(computeKeywordCoverage(resume, ['post-sales execution']).present, ['post-sales execution']);
  // A phrase that only overlaps the text is still missing.
  assert.deepEqual(computeKeywordCoverage(resume, ['sales execution planning']).present, []);
  // But a shorter phrase that IS wholly present, on boundaries, matches.
  assert.deepEqual(computeKeywordCoverage(resume, ['post-sales']).present, ['post-sales']);
  // Not credited when it is only part of a longer word.
  assert.deepEqual(computeKeywordCoverage('presales work', ['sales']).present, []);
});

test('a term carrying an embedded newline cannot forge a heading', () => {
  // Left as-is, the newline would break the coverage block onto a new line
  // where an ALL-CAPS fragment reads as a section heading — enough to forge a
  // "NOT SUBMITTABLE YET" banner out of a keyword in the Google Doc renderer.
  const c = computeKeywordCoverage('we do sql work', ['SQL\nNOT SUBMITTABLE YET', 'x\t\t y']);
  assert.ok(c.present.concat(c.missing).every(t => !/[\n\r\t]/.test(t)), 'a term kept its newline/tab');
  assert.deepEqual(c.missing, ['SQL NOT SUBMITTABLE YET', 'x y']);

  const out = finalizePackage({
    resume: 'ALEX DOE',
    atsText: 'ATS & KEYWORD OPTIMIZATION',
    keyTerms: ['SQL\nNOT SUBMITTABLE YET', 'a', 'b', 'c', 'd'],
  });
  // The forgery vector is a LINE that reads as an ALL-CAPS heading. With the
  // whitespace collapsed the phrase stays inline inside "Missing: ...", where
  // it is plainly a keyword and no renderer will promote it to a heading. This
  // resume is clean, so no line may begin the gate banner.
  assert.ok(
    !out.atsText.split('\n').some(l => l.trimStart().startsWith('NOT SUBMITTABLE YET')),
    'a keyword forged the gate banner onto its own line',
  );
  assert.match(out.atsText, /Missing: .*SQL NOT SUBMITTABLE YET/);
});

test('computeKeywordCoverage dedupes terms and ignores junk entries', () => {
  const c = computeKeywordCoverage(RESUME, ['SQL', 'sql', '  ', null, undefined, 'SQL']);
  assert.deepEqual(c.present, ['SQL']);
  assert.equal(c.total, 1);
});

test('computeKeywordCoverage tolerates a missing or non-array term list', () => {
  for (const terms of [undefined, null, 'SQL', {}]) {
    const c = computeKeywordCoverage(RESUME, terms);
    assert.deepEqual(c, { present: [], missing: [], total: 0 });
  }
});

// ── The formula ──────────────────────────────────────────────────────────────

const cov = (present, total) => ({ present: new Array(present).fill('t'), missing: [], total });

test('a complete resume covering every term scores 10/10', () => {
  const s = computePackageScore(cov(12, 12), []);
  assert.deepEqual(s, { keyword: 7, completeness: 3, total: 10, scorable: true });
});

test("the owner's staging case — 9 of 14 terms, placeholders left — scores 4.5/10", () => {
  const s = computePackageScore(cov(9, 14), ['[YOUR NAME]']);
  assert.equal(s.keyword, 4.5);        // 7 × 9/14 = 4.5 exactly
  assert.equal(s.completeness, 0);
  assert.equal(s.total, 4.5);
});

test('a clean resume matching no terms still scores 3/10 for being finished', () => {
  const s = computePackageScore(cov(0, 12), []);
  assert.deepEqual(s, { keyword: 0, completeness: 3, total: 3, scorable: true });
});

test('completeness is all-or-nothing — one placeholder costs all 3 points', () => {
  assert.equal(computePackageScore(cov(12, 12), ['[X]']).total, 7);
  assert.equal(computePackageScore(cov(12, 12), ['[X]', '[Y]', '[Z]']).completeness, 0);
});

test('the keyword component rounds to the nearest half point', () => {
  assert.equal(computePackageScore(cov(5, 12), []).keyword, 3);     // 2.916 → 3
  assert.equal(computePackageScore(cov(1, 10), []).keyword, 0.5);   // 0.7   → 0.5
  assert.equal(computePackageScore(cov(7, 10), []).keyword, 5);     // 4.9   → 5
  assert.equal(computePackageScore(cov(1, 3), []).keyword, 2.5);    // 2.333 → 2.5
});

test('with no key terms to measure there is no score to show', () => {
  const s = computePackageScore(cov(0, 0), []);
  assert.equal(s.scorable, false);
  assert.equal(s.keyword, 0);
});

test('too few terms is not a measurement — under five, nothing is scorable', () => {
  // A one-term list whose term happens to appear would otherwise read
  // "SCORE: 10/10", the exact overconfident number this replaced.
  for (const n of [1, 2, 3, 4]) assert.equal(computePackageScore(cov(n, n), []).scorable, false, `${n} terms`);
  assert.equal(computePackageScore(cov(5, 5), []).scorable, true);
});

test('a four-term list shows no score, but the placeholder gate still fires', () => {
  const out = finalizePackage({
    resume: 'ALEX DOE covering sql and hiring and budgeting and roadmap\n[School Name] | BS',
    atsText: 'ATS & KEYWORD OPTIMIZATION',
    checklist: ['Check the salary band'],
    keyTerms: ['sql', 'hiring', 'budgeting', 'roadmap'],
  });
  assert.ok(!out.atsText.includes('SCORE:'), 'scored a four-term list');
  assert.ok(!out.atsText.includes('KEYWORD COVERAGE'));
  // The gate does not depend on key terms, so it is unaffected.
  assert.ok(out.atsText.startsWith('NOT SUBMITTABLE YET'));
  assert.match(out.checklist[0], /\[School Name\]/);
});

// ── Assembly ─────────────────────────────────────────────────────────────────

// Five terms: the minimum the scorer will put a number on.
const TERMS = ['stakeholder management', 'SQL', 'demand forecasting', 'kubernetes', 'terraform'];
const MODEL_ATS = 'ATS & KEYWORD OPTIMIZATION\n\nMISSING KEYWORDS\nkubernetes: add to Acme';

test('a draft with placeholders leads with the gate, then the score, then coverage', () => {
  const out = finalizePackage({
    resume: `${RESUME}\n[School Name] | BS`,
    atsText: MODEL_ATS,
    checklist: ['Check the salary band'],
    keyTerms: TERMS,
  });

  const gate = out.atsText.indexOf('NOT SUBMITTABLE YET');
  const score = out.atsText.indexOf('SCORE:');
  const coverage = out.atsText.indexOf('KEYWORD COVERAGE');
  const model = out.atsText.indexOf('ATS & KEYWORD OPTIMIZATION');
  assert.ok(gate === 0, 'the gate must lead the section');
  assert.ok(gate < score && score < coverage && coverage < model, 'blocks out of order');

  assert.match(out.atsText, /This draft still contains 1 placeholder that must be replaced before applying: \[School Name\]/);
  assert.match(out.atsText, /SCORE: 4\/10/);                                      // 7×3/5=4.2→4, +0
  assert.match(out.atsText, /Keyword match: 4\/7 \(3 of 5 key JD terms present\)/);
  assert.match(out.atsText, /Completeness: 0\/3 — 1 placeholder still to fill in/);
  assert.match(out.atsText, /Fix the placeholders and add the missing terms below to raise this\./);
  assert.match(out.atsText, /3 of 5 key JD terms present in the resume\./);
  assert.match(out.atsText, /Present: stakeholder management, SQL, demand forecasting/);
  assert.match(out.atsText, /Missing: kubernetes, terraform/);
  // The model's own analysis survives underneath.
  assert.ok(out.atsText.includes('kubernetes: add to Acme'));
});

test('the placeholder gate becomes the FIRST checklist item, in the same words', () => {
  const out = finalizePackage({
    resume: '[YOUR NAME]\n[School Name]',
    atsText: MODEL_ATS,
    checklist: ['Check the salary band', 'Tailor the intro'],
    keyTerms: TERMS,
  });
  assert.equal(out.checklist[0], placeholderGateLine(['[YOUR NAME]', '[School Name]']));
  assert.match(out.checklist[0], /2 placeholders that must be replaced before applying/);
  assert.deepEqual(out.checklist.slice(1), ['Check the salary band', 'Tailor the intro']);
  // The identical sentence appears in the ATS gate.
  assert.ok(out.atsText.includes(out.checklist[0]));
});

test('a clean, fully covered draft gets no gate and a perfect visible score', () => {
  const out = finalizePackage({
    resume: RESUME + ' and kubernetes and terraform',
    atsText: MODEL_ATS,
    checklist: ['Check the salary band'],
    keyTerms: TERMS,
  });
  assert.ok(!out.atsText.includes('NOT SUBMITTABLE YET'));
  assert.match(out.atsText, /SCORE: 10\/10/);
  assert.match(out.atsText, /Completeness: 3\/3 — no placeholders left in the draft/);
  // No "raise this" nudge when there is nothing left to raise.
  assert.ok(!out.atsText.includes('to raise this'));
  assert.deepEqual(out.checklist, ['Check the salary band']);
  assert.deepEqual(out.placeholders, []);
});

test('finalizePackage degrades quietly when the model returned no key terms', () => {
  const out = finalizePackage({ resume: RESUME, atsText: MODEL_ATS, checklist: [] });
  assert.ok(!out.atsText.includes('SCORE:'), 'a score was shown with nothing to measure');
  assert.ok(!out.atsText.includes('KEYWORD COVERAGE'));
  assert.ok(out.atsText.startsWith('ATS & KEYWORD OPTIMIZATION'));
});

test('finalizePackage is idempotent — a second call changes nothing', () => {
  const raw = {
    resume: `${RESUME}\n[School Name] | BS`,
    atsText: MODEL_ATS,
    checklist: ['Check the salary band'],
    keyTerms: TERMS,
  };
  const once = finalizePackage(raw);
  const twice = finalizePackage(once);
  assert.deepEqual(twice, once);
  // Specifically: the gate is not prepended again and the blocks are not restacked.
  assert.equal(twice.atsText, once.atsText);
  assert.equal((twice.atsText.match(/NOT SUBMITTABLE YET/g) || []).length, 1);
  assert.equal((twice.atsText.match(/SCORE:/g) || []).length, 1);
  assert.deepEqual(twice.checklist, once.checklist);
});

test('finalizePackage survives a malformed package object', () => {
  const out = finalizePackage({});
  assert.equal(typeof out.atsText, 'string');
  assert.deepEqual(out.checklist, []);
  assert.deepEqual(out.placeholders, []);
});

// ── The prompt no longer asks for a number ───────────────────────────────────

test('the atsText schema no longer contains the invented ATS score', () => {
  assert.ok(!pkgSrc.includes('ATS SCORE ESTIMATE'), 'the ATS SCORE ESTIMATE block is still in the prompt');
  assert.ok(!pkgSrc.includes('Score: [X/10]'), 'the model is still asked for an X/10');
  assert.ok(!/provide an ATS score/.test(pkgSrc), 'the instructions still ask for a score');
});

test('the schema asks for a qualitative FIT READ with no numbers of any kind', () => {
  assert.match(pkgSrc, /FIT READ/);
  assert.match(pkgSrc, /Do NOT include a numeric score, a rating, a letter grade, a percentage/);
  assert.match(pkgSrc, /Do NOT rate, score, or grade the resume anywhere in atsText/);
});

test('the model supplies key terms as a parseable field, not as prose', () => {
  // A JSON array alongside atsText — no scraping of the analysis text.
  assert.match(pkgSrc, /"keyTerms": \["<exact phrase from the job description>"/);
  assert.match(pkgSrc, /For keyTerms: return 10-15 of the job description's most important terms/);
  assert.match(pkgSrc, /checked against the resume in code, literally and case-insensitively/);
});

test('the generator measures the package before delivering it', () => {
  assert.match(pkgSrc, /const pkg = finalizePackage\(rawPkg\);/);
  // Everything downstream reads pkg.atsText / pkg.checklist, so the panel, the
  // plain-text copy, the download and the Google Doc all inherit the blocks.
  assert.match(pkgSrc, /createGoogleDoc\(accessToken, docTitle, pkg\.resume \|\| '', atsText, draftQA\)/);
  assert.match(pkgSrc, /const atsText = pkg\.atsText \|\| '';/);
});
