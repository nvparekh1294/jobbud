import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResumeLine, countResumeLines } from '../scanner/applicationPackage.mjs';

// Signature: classifyResumeLine(trimmed, nonBlankCount, currentSection, inATSSection, inAppQSection)

// ── classifyResumeLine: resume body ───────────────────────────────────────────
test('classifyResumeLine tags the first two non-blank lines as name and contact', () => {
  assert.equal(classifyResumeLine('ALEX DOE', 1, null, false, false), 'name');
  assert.equal(classifyResumeLine('Austin, TX | alex@example.com', 2, null, false, false), 'contact');
});

test('classifyResumeLine distinguishes a normal bullet from a deal ($) bullet', () => {
  assert.equal(classifyResumeLine('• Led a team of five', 5, 'EXPERIENCE', false, false), 'bullet');
  assert.equal(classifyResumeLine('• $40M Series A in Acme', 6, 'PERSONAL', false, false), 'deal_header');
});

test('classifyResumeLine tags all-caps lines as section headers', () => {
  assert.equal(classifyResumeLine('PROFESSIONAL EXPERIENCE', 4, null, false, false), 'section_header');
});

test('classifyResumeLine separates role titles from location-date lines by date presence', () => {
  assert.equal(classifyResumeLine('Acme Corp | Senior Director, Strategy', 5, null, false, false), 'role_title');
  assert.equal(classifyResumeLine('Austin, TX | September 2025 – Present', 6, null, false, false), 'location_date');
});

// ── classifyResumeLine: sub-sections ──────────────────────────────────────────
test('classifyResumeLine routes application-questions lines once that block is active', () => {
  assert.equal(classifyResumeLine('Q: Why this company?', 20, null, false, true), 'app_q_question');
  assert.equal(classifyResumeLine('Because the mission fits.', 21, null, false, true), 'app_q_body');
});

test('classifyResumeLine routes ATS advisory lines once that block is active', () => {
  assert.equal(classifyResumeLine('KEYWORDS', 30, null, true, false), 'ats_subheader');
  assert.equal(classifyResumeLine('Match rate: 80%', 31, null, true, false), 'ats_inline_label');
  assert.equal(classifyResumeLine('some plain advisory text', 32, null, true, false), 'ats_body');
});

test('classifyResumeLine edge case: a ⚠ warning line wins even at non-blank line 1', () => {
  assert.equal(classifyResumeLine('⚠ WARNING: Resume may exceed one page', 1, null, false, false), 'warning');
});

// ── countResumeLines ──────────────────────────────────────────────────────────
test('countResumeLines counts only non-blank lines', () => {
  assert.equal(countResumeLines('alpha\n\nbeta\n   \ngamma'), 3);
});

test('countResumeLines ignores a trailing newline', () => {
  assert.equal(countResumeLines('one\ntwo\n'), 2);
});

test('countResumeLines edge case: empty string is zero lines', () => {
  assert.equal(countResumeLines(''), 0);
});
