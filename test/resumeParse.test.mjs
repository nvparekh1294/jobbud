import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExtractedTextEmpty, EMPTY_RESUME_ERROR } from '../lib/resumeParse.mjs';

// ── isExtractedTextEmpty: the parse-resume empty-extraction guard ─────────────
test('isExtractedTextEmpty is true for an empty string (scanned/image PDF case)', () => {
  assert.equal(isExtractedTextEmpty(''), true);
});

test('isExtractedTextEmpty is true for whitespace-only text', () => {
  assert.equal(isExtractedTextEmpty('   \n\t  \r\n'), true);
});

test('isExtractedTextEmpty is true for null or undefined', () => {
  assert.equal(isExtractedTextEmpty(null), true);
  assert.equal(isExtractedTextEmpty(undefined), true);
});

test('isExtractedTextEmpty is false when there is real text', () => {
  assert.equal(isExtractedTextEmpty('Alex Doe\nSenior Director'), false);
});

test('isExtractedTextEmpty is false when text has surrounding whitespace but real content', () => {
  assert.equal(isExtractedTextEmpty('   hello   '), false);
});

// ── EMPTY_RESUME_ERROR: user-facing message the client surfaces ───────────────
test('EMPTY_RESUME_ERROR guides the user toward a text-based PDF or pasting', () => {
  assert.match(EMPTY_RESUME_ERROR, /scanned or image-based PDF/);
  assert.match(EMPTY_RESUME_ERROR, /paste your resume/);
});
