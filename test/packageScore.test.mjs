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
  findPlaceholders,
  computeKeywordCoverage,
  computePackageScore,
  placeholderGateLine,
  finalizePackage,
} from '../scanner/applicationPackage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgSrc = readFileSync(join(__dirname, '..', 'scanner', 'applicationPackage.mjs'), 'utf8');

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

// ── Assembly ─────────────────────────────────────────────────────────────────

const TERMS = ['stakeholder management', 'SQL', 'demand forecasting', 'kubernetes'];
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
  assert.match(out.atsText, /SCORE: 5\.5\/10/);                                   // 7×3/4=5.25→5.5, +0
  assert.match(out.atsText, /Keyword match: 5\.5\/7 \(3 of 4 key JD terms present\)/);
  assert.match(out.atsText, /Completeness: 0\/3 — 1 placeholder still to fill in/);
  assert.match(out.atsText, /Fix the placeholders and add the missing terms below to raise this\./);
  assert.match(out.atsText, /3 of 4 key JD terms present in the resume\./);
  assert.match(out.atsText, /Present: stakeholder management, SQL, demand forecasting/);
  assert.match(out.atsText, /Missing: kubernetes/);
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
    resume: RESUME + ' and kubernetes',
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
