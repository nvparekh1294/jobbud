import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAts } from '../lib/atsDetect.js';

// ── Ashby ─────────────────────────────────────────────────────────────────────
test('detectAts recognises an Ashby board and pulls the slug', () => {
  assert.deepEqual(detectAts('https://jobs.ashbyhq.com/openai'), {
    ats: 'ashby',
    ats_id: 'openai',
    careers_url: 'https://jobs.ashbyhq.com/openai',
  });
});

test('detectAts keeps a hyphenated Ashby slug', () => {
  assert.equal(detectAts('https://jobs.ashbyhq.com/rhoda-ai').ats_id, 'rhoda-ai');
});

// ── Greenhouse ──────────────────────────────────────────────────────────────
test('detectAts recognises boards.greenhouse.io', () => {
  assert.deepEqual(detectAts('https://boards.greenhouse.io/databricks'), {
    ats: 'greenhouse',
    ats_id: 'databricks',
    careers_url: 'https://boards.greenhouse.io/databricks',
  });
});

test('detectAts recognises job-boards.greenhouse.io', () => {
  const result = detectAts('https://job-boards.greenhouse.io/acme');
  assert.equal(result.ats, 'greenhouse');
  assert.equal(result.ats_id, 'acme');
});

test('detectAts recognises the boards-api.greenhouse.io REST form', () => {
  const result = detectAts('https://boards-api.greenhouse.io/v1/boards/anthropic/jobs');
  assert.equal(result.ats, 'greenhouse');
  assert.equal(result.ats_id, 'anthropic');
});

test('detectAts pulls the slug from the greenhouse embed ?for= param', () => {
  const result = detectAts('https://boards.greenhouse.io/embed/job_board?for=databricks');
  assert.equal(result.ats, 'greenhouse');
  assert.equal(result.ats_id, 'databricks');
});

test('detectAts falls back to custom for a greenhouse embed with no ?for=', () => {
  // No board slug anywhere → the scanner would 404 on ats_id 'embed'; custom is safe.
  const result = detectAts('https://boards.greenhouse.io/embed/job_board');
  assert.equal(result.ats, 'custom');
  assert.equal(result.ats_id, undefined);
  assert.equal(result.careers_url, 'https://boards.greenhouse.io/embed/job_board');
});

// ── Lever ─────────────────────────────────────────────────────────────────────
test('detectAts recognises a Lever board', () => {
  assert.deepEqual(detectAts('https://jobs.lever.co/acme'), {
    ats: 'lever',
    ats_id: 'acme',
    careers_url: 'https://jobs.lever.co/acme',
  });
});

// ── Workday ───────────────────────────────────────────────────────────────────
test('detectAts parses a Workday tenant and site with a locale segment', () => {
  assert.deepEqual(detectAts('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite'), {
    ats: 'workday',
    workday_tenant: 'nvidia',
    workday_site: 'NVIDIAExternalCareerSite',
    careers_url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite',
  });
});

test('detectAts parses a Workday site with no locale segment', () => {
  const result = detectAts('https://acme.wd1.myworkdayjobs.com/AcmeCareers');
  assert.equal(result.ats, 'workday');
  assert.equal(result.workday_tenant, 'acme');
  assert.equal(result.workday_site, 'AcmeCareers');
});

// ── Custom fallback ───────────────────────────────────────────────────────────
test('detectAts falls back to custom for an unrecognised host', () => {
  assert.deepEqual(detectAts('https://www.rippling.com/careers'), {
    ats: 'custom',
    careers_url: 'https://www.rippling.com/careers',
  });
});

test('detectAts custom fallback carries no ats_id', () => {
  const result = detectAts('https://careers.creandum.com/jobs');
  assert.equal(result.ats, 'custom');
  assert.equal(result.ats_id, undefined);
});

// ── Messy / tolerant inputs ───────────────────────────────────────────────────
test('detectAts tolerates a missing scheme', () => {
  assert.equal(detectAts('jobs.ashbyhq.com/menlo').ats, 'ashby');
  assert.equal(detectAts('jobs.ashbyhq.com/menlo').ats_id, 'menlo');
});

test('detectAts tolerates http vs https', () => {
  assert.equal(detectAts('http://jobs.lever.co/acme').ats, 'lever');
});

test('detectAts tolerates trailing slashes', () => {
  assert.equal(detectAts('https://jobs.ashbyhq.com/ramp/').ats_id, 'ramp');
});

test('detectAts tolerates query strings and does not fold them into the slug', () => {
  const result = detectAts('https://jobs.ashbyhq.com/sunday?utm_source=x&ref=y');
  assert.equal(result.ats, 'ashby');
  assert.equal(result.ats_id, 'sunday');
});

test('detectAts is case-insensitive on the host', () => {
  assert.equal(detectAts('https://Jobs.AshbyHQ.com/openai').ats, 'ashby');
});

test('detectAts returns custom with an empty careers_url for empty input', () => {
  assert.deepEqual(detectAts(''), { ats: 'custom', careers_url: '' });
  assert.deepEqual(detectAts(null), { ats: 'custom', careers_url: '' });
});

test('detectAts treats an Ashby host with no slug as custom', () => {
  // No board slug → nothing for the scanner to fetch; custom is the safe fallback.
  assert.equal(detectAts('https://jobs.ashbyhq.com').ats, 'custom');
});
