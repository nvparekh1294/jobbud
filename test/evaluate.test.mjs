import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyJobType, sanitizeLocation, wasScoredOrFiltered, mapWithConcurrency, evaluateJobs } from '../scanner/evaluate.mjs';
import { HAIKU_MODEL, SONNET_MODEL } from '../scanner/config.mjs';

// ── classifyJobType ───────────────────────────────────────────────────────────
test('classifyJobType marks a role as investing only when company AND title both signal it', () => {
  assert.equal(classifyJobType({ company: 'Sequoia Capital', title: 'Principal' }), 'investing');
});

test('classifyJobType treats an operating role at an investor as operating', () => {
  // Company signals investing, but the title (Head of Operations) does not.
  assert.equal(classifyJobType({ company: 'Sequoia Capital', title: 'Head of Operations' }), 'operating');
});

test('classifyJobType treats an investing-sounding title at a normal company as operating', () => {
  // Title has "partner" but the company is not an investor — a single signal is not enough.
  assert.equal(classifyJobType({ company: 'Acme Corp', title: 'Partner Manager' }), 'operating');
});

test('classifyJobType honors an explicit portalCategory=vc signal', () => {
  assert.equal(classifyJobType({ company: 'Acme', title: 'Investor', portalCategory: 'vc' }), 'investing');
});

test('classifyJobType edge case: empty job object defaults to operating', () => {
  assert.equal(classifyJobType({}), 'operating');
});

// ── sanitizeLocation ──────────────────────────────────────────────────────────
test('sanitizeLocation strips non-ASCII characters', () => {
  // The accented "ü" (U+00FC) is outside the \x20-\x7E ASCII range and is removed.
  assert.equal(sanitizeLocation('Zürich, Switzerland'), 'Zrich, Switzerland');
});

test('sanitizeLocation collapses runs of spaces to a single space', () => {
  assert.equal(sanitizeLocation('New   York,   NY'), 'New York, NY');
});

test('sanitizeLocation edge case: empty/undefined input returns empty string', () => {
  assert.equal(sanitizeLocation(''), '');
  assert.equal(sanitizeLocation(undefined), '');
});

// ── wasScoredOrFiltered ───────────────────────────────────────────────────────
// Guards the markScored set: a Stage-2 scoring FAILURE must be excluded (so it
// retries next run) while a Stage-1-filtered non-fit stays marked (never re-scored).
test('wasScoredOrFiltered excludes a Stage-2 scoring failure (score null, no stage1Filtered)', () => {
  const stage2Failed = { _fingerprint: 'fp-fail', score: null, evaluation: null, fundingSnapshot: null };
  assert.equal(wasScoredOrFiltered(stage2Failed), false);
});

test('wasScoredOrFiltered includes a Stage-1-filtered job (score null but stage1Filtered:true)', () => {
  const stage1Filtered = { _fingerprint: 'fp-filtered', score: null, evaluation: null, stage1Filtered: true };
  assert.equal(wasScoredOrFiltered(stage1Filtered), true);
});

test('wasScoredOrFiltered includes a successfully scored job', () => {
  assert.equal(wasScoredOrFiltered({ _fingerprint: 'fp-ok', score: 4.2 }), true);
  // A zero-adjacent score is still a real score, not a failure.
  assert.equal(wasScoredOrFiltered({ _fingerprint: 'fp-low', score: 0 }), true);
});

test('wasScoredOrFiltered partitions a mixed evaluated batch correctly', () => {
  const evaluated = [
    { _fingerprint: 'a', score: 4.5 },                                    // scored
    { _fingerprint: 'b', score: null, stage1Filtered: true },             // filtered
    { _fingerprint: 'c', score: null },                                   // Stage-2 failure
  ];
  const toMark = evaluated.filter(wasScoredOrFiltered).map(j => j._fingerprint);
  assert.deepEqual(toMark, ['a', 'b']);
  assert.ok(!toMark.includes('c'), 'Stage-2 failure must not be marked scored');
});

// ── fetch-stubbed integration tests ───────────────────────────────────────────
// evaluate.mjs uses global fetch for Anthropic calls, so we swap globalThis.fetch
// for a stub that returns canned Haiku/Sonnet responses and counts calls per
// model. The stub throws loudly on any non-Anthropic URL so an accidental live
// call (e.g. SerpAPI enrichment) fails the test instead of hitting the network.

function makeAnthropicStub(counts) {
  return async (url, init) => {
    if (typeof url !== 'string' || !url.startsWith('https://api.anthropic.com')) {
      throw new Error(`Unexpected non-Anthropic fetch in test: ${url}`);
    }
    const body = JSON.parse(init.body);
    if (body.model === HAIKU_MODEL) {
      counts.haiku++;
      return {
        ok: true,
        async json() {
          return {
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ text: JSON.stringify({ pass: true, confidence: 0.9, reasonCategory: 'none', reason: 'fit' }) }],
          };
        },
      };
    }
    if (body.model === SONNET_MODEL) {
      counts.sonnet++;
      return {
        ok: true,
        async json() {
          return {
            usage: { input_tokens: 20, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            content: [{ text: JSON.stringify({
              score: 4.2,
              whyFit: ['cross-functional ownership'],
              watchOuts: ['stage unclear'],
              recommendedAction: 'Apply now',
              seniority: 'good fit',
              jobType: 'operating',
              oneLineSummary: 'A senior ops role.',
              companyDescription: 'A growing AI company.',
              aiExposureRisk: 'low',
              aiExposureRationale: 'Judgment-heavy, cross-functional work.',
            }) }],
          };
        },
      };
    }
    throw new Error(`Unexpected model in test: ${body.model}`);
  };
}

function makeJob(i, source) {
  return {
    title: `Chief of Staff ${i}`,
    company: `Company${i}`,           // avoids enrich.mjs public/stealth signals
    location: 'Remote',
    description: 'A senior operations role at a growing AI company with cross-functional ownership and strategy scope.',
    url: `https://example.com/job/${i}`,
    source,
  };
}

// companyCachePath points at a fresh OS-tmpdir file (NEVER the repo's data/ dir)
// so enrichCompany's read-modify-write can no-op cheaply (no serpApiKey → writes
// null and returns) without touching real project data or the network.
async function makeTmpCachePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobbud-eval-'));
  return { dir, cachePath: path.join(dir, 'company-cache.json') };
}

// Test A ── mapWithConcurrency bounds in-flight calls and preserves input order.
test('mapWithConcurrency runs at most `limit` calls in flight and returns results in input order', async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;
  const results = await mapWithConcurrency(items, 4, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return item * 10;
  });
  assert.equal(maxInFlight, 4, `expected max 4 concurrent, saw ${maxInFlight}`);
  assert.deepEqual(results, items.map(i => i * 10), 'results preserve input order');
});

// Test B (E4 proof) ── the Stage 2 cap bounds the COMBINED portal+API stream.
test('evaluateJobs caps Stage 2 across BOTH portal and API sources', async () => {
  const original = globalThis.fetch;
  const counts = { haiku: 0, sonnet: 0 };
  globalThis.fetch = makeAnthropicStub(counts);
  const { dir, cachePath } = await makeTmpCachePath();
  try {
    const jobs = [
      ...Array.from({ length: 4 }, (_, i) => makeJob(i, 'portal')),
      ...Array.from({ length: 4 }, (_, i) => makeJob(i + 4, 'api')),
    ];
    const config = { anthropicApiKey: 'test-key', maxJobsToEvaluate: 3, companyCachePath: cachePath };
    const results = await evaluateJobs(jobs, config);
    assert.equal(counts.haiku, 8, 'Stage 1 Haiku runs on all 8 jobs (uncapped)');
    assert.equal(counts.sonnet, 3, 'Stage 2 Sonnet is capped at 3 across both sources');
    assert.equal(results.length, 3, 'only the 3 scored passers are returned; deferred passers retry next run');
  } finally {
    globalThis.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Test C ── a big portal-only sweep cannot blow past the cap.
test('evaluateJobs caps Stage 2 for a large portal-only sweep', async () => {
  const original = globalThis.fetch;
  const counts = { haiku: 0, sonnet: 0 };
  globalThis.fetch = makeAnthropicStub(counts);
  const { dir, cachePath } = await makeTmpCachePath();
  try {
    const jobs = Array.from({ length: 10 }, (_, i) => makeJob(i, 'portal'));
    const config = { anthropicApiKey: 'test-key', maxJobsToEvaluate: 4, companyCachePath: cachePath };
    const results = await evaluateJobs(jobs, config);
    assert.equal(counts.haiku, 10, 'Stage 1 Haiku runs on all 10 portal jobs');
    assert.equal(counts.sonnet, 4, 'Stage 2 Sonnet is capped at 4');
    assert.equal(results.length, 4, 'only the 4 scored passers are returned');
  } finally {
    globalThis.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
