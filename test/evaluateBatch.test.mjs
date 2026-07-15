import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateJobs, wasScoredOrFiltered } from '../scanner/evaluate.mjs';
import { HAIKU_MODEL, SONNET_MODEL } from '../scanner/config.mjs';

// ── Batch-path integration tests ──────────────────────────────────────────────
// These exercise evaluateJobsBatch via evaluateJobs with USE_BATCH_API=true and a
// fully MOCKED Message Batches lifecycle: create → in_progress → ended → JSONL
// results. The stub routes on the batch endpoints and asserts every non-Anthropic
// fetch throws (so enrichCompany, which no-ops without a serpApiKey, never hits the
// network). node --test isolates each file in its own process, so setting
// USE_BATCH_API here can never leak into the synchronous evaluate.test.mjs run.

const BATCH_BASE = 'https://api.anthropic.com/v1/messages/batches';

function makeJob(i, source = 'portal') {
  return {
    title: `Chief of Staff ${i}`,
    company: `Company${i}`,          // avoids enrich.mjs public/stealth signals
    location: 'Remote',
    description: 'A senior operations role at a growing AI company with cross-functional ownership and strategy scope.',
    url: `https://example.com/job/${i}`,
    source,
  };
}

async function makeTmpCachePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobbud-batch-'));
  return { dir, cachePath: path.join(dir, 'company-cache.json') };
}

// Canned successful message bodies (mirror the shapes evaluate.mjs parses).
function s1PassMsg(confidence = 0.9) {
  return {
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ text: JSON.stringify({ pass: true, confidence, reasonCategory: 'none', reason: 'fit' }) }],
  };
}
function s1FailMsg() {
  return {
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ text: JSON.stringify({ pass: false, confidence: 0.1, reasonCategory: 'industry', reason: 'clear non-fit' }) }],
  };
}
function s2ScoreMsg(score = 4.2) {
  return {
    usage: { input_tokens: 20, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 15 },
    content: [{ text: JSON.stringify({
      score,
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
}

// Build a stub over the full batch lifecycle.
//   resultsByStage: { s1: Map<custom_id, resultObj>, s2: Map<custom_id, resultObj> }
//   pollsUntilEnded: GET-status calls returning in_progress before 'ended'
//   neverEnd: keep returning in_progress forever (timeout test)
//   reverseResults: emit JSONL lines in reverse to prove custom_id (not positional) keying
//   spy: records created counts / poll counts / whether results were fetched
function makeBatchStub({ resultsByStage, pollsUntilEnded = 2, neverEnd = false, reverseResults = false, spy }) {
  const pollCounts = {};
  return async (url, init) => {
    if (typeof url !== 'string' || !url.startsWith('https://api.anthropic.com')) {
      throw new Error(`Unexpected non-Anthropic fetch in batch test: ${url}`);
    }
    const method = (init?.method || 'GET').toUpperCase();

    // Create
    if (url === BATCH_BASE && method === 'POST') {
      const body = JSON.parse(init.body);
      const stage = body.requests[0].params.model === HAIKU_MODEL ? 's1'
                  : body.requests[0].params.model === SONNET_MODEL ? 's2'
                  : 'unknown';
      spy.created[stage] = body.requests.length;
      spy.customIds[stage] = body.requests.map(r => r.custom_id);
      return { ok: true, async json() { return { id: `batch_${stage}`, processing_status: 'in_progress', request_counts: { processing: body.requests.length, succeeded: 0, errored: 0 } }; } };
    }

    // Results (must be checked before the status GET since it's a longer path)
    const resultsMatch = url.match(new RegExp(`^${BATCH_BASE}/(batch_s1|batch_s2)/results$`));
    if (resultsMatch && method === 'GET') {
      const stage = resultsMatch[1] === 'batch_s1' ? 's1' : 's2';
      spy.resultsFetched[stage] = true;
      const map = resultsByStage[stage] || new Map();
      let lines = [...map.values()].map(o => JSON.stringify(o));
      if (reverseResults) lines = lines.reverse();
      const text = lines.join('\n') + '\n';
      return { ok: true, async text() { return text; } };
    }

    // Poll status
    const statusMatch = url.match(new RegExp(`^${BATCH_BASE}/(batch_s1|batch_s2)$`));
    if (statusMatch && method === 'GET') {
      const id = statusMatch[1];
      pollCounts[id] = (pollCounts[id] || 0) + 1;
      spy.pollCounts[id] = pollCounts[id];
      const ended = !neverEnd && pollCounts[id] >= pollsUntilEnded;
      return { ok: true, async json() { return { id, processing_status: ended ? 'ended' : 'in_progress', request_counts: {} }; } };
    }

    throw new Error(`Unexpected batch URL/method in test: ${method} ${url}`);
  };
}

function makeSpy() {
  return { created: {}, customIds: {}, resultsFetched: {}, pollCounts: {} };
}

function resMap(entries) {
  // entries: [[custom_id, type, message?]]
  return new Map(entries.map(([id, type, message]) => [id, { custom_id: id, result: message ? { type, message } : { type } }]));
}

const POLL_FAST = { batchPollInitialMs: 1, batchPollMaxIntervalMs: 1, batchPollBackoff: 1, batchPollHardTimeoutMs: 5000 };

async function withBatchEnv(fn) {
  const prev = process.env.USE_BATCH_API;
  process.env.USE_BATCH_API = 'true';
  const originalFetch = globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    if (prev === undefined) delete process.env.USE_BATCH_API;
    else process.env.USE_BATCH_API = prev;
  }
}

// Test 1 ── happy path: create → in_progress → ended, JSONL parsed, results keyed
// by custom_id even when returned OUT OF ORDER.
test('evaluateJobsBatch: full lifecycle scores all passers, keying results by custom_id (out of order)', async () => {
  await withBatchEnv(async () => {
    const { dir, cachePath } = await makeTmpCachePath();
    const spy = makeSpy();
    const jobs = Array.from({ length: 4 }, (_, i) => makeJob(i));
    const resultsByStage = {
      s1: resMap([
        ['s1-0', 'succeeded', s1PassMsg()],
        ['s1-1', 'succeeded', s1PassMsg()],
        ['s1-2', 'succeeded', s1PassMsg()],
        ['s1-3', 'succeeded', s1PassMsg()],
      ]),
      s2: resMap([
        ['s2-0', 'succeeded', s2ScoreMsg(4.5)],
        ['s2-1', 'succeeded', s2ScoreMsg(3.9)],
        ['s2-2', 'succeeded', s2ScoreMsg(4.1)],
        ['s2-3', 'succeeded', s2ScoreMsg(4.7)],
      ]),
    };
    globalThis.fetch = makeBatchStub({ resultsByStage, pollsUntilEnded: 2, reverseResults: true, spy });
    try {
      const config = { anthropicApiKey: 'test-key', maxJobsToEvaluate: 10, companyCachePath: cachePath, ...POLL_FAST };
      const results = await evaluateJobs(jobs, config);

      assert.equal(spy.created.s1, 4, 'Stage 1 batch submitted all 4 candidates');
      assert.equal(spy.created.s2, 4, 'Stage 2 batch submitted all 4 passers');
      assert.deepEqual(spy.customIds.s1, ['s1-0', 's1-1', 's1-2', 's1-3']);
      assert.equal(spy.resultsFetched.s1, true);
      assert.equal(spy.resultsFetched.s2, true);
      assert.ok(spy.pollCounts.batch_s1 >= 2, 'polled Stage 1 through in_progress → ended');
      assert.equal(results.length, 4, 'all 4 jobs returned');
      // Sorted by score desc; out-of-order JSONL still mapped correctly by custom_id.
      assert.deepEqual(results.map(r => r.score), [4.7, 4.5, 4.1, 3.9]);
      assert.ok(results.every(r => wasScoredOrFiltered(r)), 'all scored jobs mark as scored');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// Test 2 ── Stage 1 batch fail-open: an errored/missing Stage-1 item passes through
// to Stage 2 rather than dropping the job (byte-identical to sync fail-open).
test('evaluateJobsBatch: Stage 1 errored item fails OPEN (passes to Stage 2)', async () => {
  await withBatchEnv(async () => {
    const { dir, cachePath } = await makeTmpCachePath();
    const spy = makeSpy();
    const jobs = Array.from({ length: 3 }, (_, i) => makeJob(i));
    const resultsByStage = {
      s1: resMap([
        ['s1-0', 'succeeded', s1PassMsg()],
        ['s1-1', 'errored'],              // no message → fail open
        // s1-2 intentionally MISSING from results → also fail open
      ]),
      s2: resMap([
        ['s2-0', 'succeeded', s2ScoreMsg()],
        ['s2-1', 'succeeded', s2ScoreMsg()],
        ['s2-2', 'succeeded', s2ScoreMsg()],
      ]),
    };
    globalThis.fetch = makeBatchStub({ resultsByStage, spy });
    try {
      const config = { anthropicApiKey: 'test-key', maxJobsToEvaluate: 10, companyCachePath: cachePath, ...POLL_FAST };
      const results = await evaluateJobs(jobs, config);
      assert.equal(spy.created.s2, 3, 'all 3 jobs (incl. errored + missing Stage-1) reach Stage 2');
      assert.equal(results.length, 3);
      assert.ok(results.every(r => r.score === 4.2), 'all fail-open jobs got scored');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// Test 3 ── Stage 2 batch per-item error: an errored Stage-2 item comes back with
// score null and NO stage1Filtered marker → wasScoredOrFiltered false → retries.
test('evaluateJobsBatch: Stage 2 errored item yields a score-null retry (not marked scored)', async () => {
  await withBatchEnv(async () => {
    const { dir, cachePath } = await makeTmpCachePath();
    const spy = makeSpy();
    const jobs = Array.from({ length: 3 }, (_, i) => makeJob(i));
    const resultsByStage = {
      s1: resMap([
        ['s1-0', 'succeeded', s1PassMsg()],
        ['s1-1', 'succeeded', s1PassMsg()],
        ['s1-2', 'succeeded', s1PassMsg()],
      ]),
      s2: resMap([
        ['s2-0', 'succeeded', s2ScoreMsg()],
        ['s2-1', 'expired'],            // per-item failure → score null
        ['s2-2', 'succeeded', s2ScoreMsg()],
      ]),
    };
    globalThis.fetch = makeBatchStub({ resultsByStage, spy });
    try {
      const config = { anthropicApiKey: 'test-key', maxJobsToEvaluate: 10, companyCachePath: cachePath, ...POLL_FAST };
      const results = await evaluateJobs(jobs, config);
      assert.equal(results.length, 3);
      const failures = results.filter(r => r.score === null);
      assert.equal(failures.length, 1, 'exactly one Stage-2 failure');
      assert.equal(failures[0].stage1Filtered, undefined, 'Stage-2 failure carries no stage1Filtered marker');
      assert.equal(wasScoredOrFiltered(failures[0]), false, 'Stage-2 failure is NOT marked scored → retries next run');
      assert.equal(results.filter(r => r.score === 4.2).length, 2, 'the other two scored normally');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// Test 4 ── Stage 1 batch also filters clear non-fits; filtered jobs come back
// score null but stage1Filtered:true (marked scored, excluded from digest).
test('evaluateJobsBatch: Stage 1 filtered non-fit is marked scored (stage1Filtered:true)', async () => {
  await withBatchEnv(async () => {
    const { dir, cachePath } = await makeTmpCachePath();
    const spy = makeSpy();
    const jobs = Array.from({ length: 3 }, (_, i) => makeJob(i));
    const resultsByStage = {
      s1: resMap([
        ['s1-0', 'succeeded', s1PassMsg()],
        ['s1-1', 'succeeded', s1FailMsg()],   // clear non-fit → filtered
        ['s1-2', 'succeeded', s1PassMsg()],
      ]),
      s2: resMap([
        ['s2-0', 'succeeded', s2ScoreMsg()],
        ['s2-1', 'succeeded', s2ScoreMsg()],   // only 2 passers reach Stage 2
      ]),
    };
    globalThis.fetch = makeBatchStub({ resultsByStage, spy });
    try {
      const config = { anthropicApiKey: 'test-key', maxJobsToEvaluate: 10, companyCachePath: cachePath, ...POLL_FAST };
      const results = await evaluateJobs(jobs, config);
      assert.equal(spy.created.s2, 2, 'only the 2 passers reach Stage 2');
      const filtered = results.filter(r => r.stage1Filtered === true);
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].score, null);
      assert.equal(wasScoredOrFiltered(filtered[0]), true, 'Stage-1 filtered job IS marked scored');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// Test 5 ── the Stage 2 cap bounds the Sonnet batch; deferred passers are dropped
// from this run (retried next run because never marked scored).
test('evaluateJobsBatch: Stage 2 cap bounds the Sonnet batch size', async () => {
  await withBatchEnv(async () => {
    const { dir, cachePath } = await makeTmpCachePath();
    const spy = makeSpy();
    const jobs = Array.from({ length: 5 }, (_, i) => makeJob(i));
    // Distinct confidences so the cap deterministically keeps the top 2.
    const confs = [0.5, 0.95, 0.6, 0.9, 0.55];
    const resultsByStage = {
      s1: resMap(confs.map((c, i) => [`s1-${i}`, 'succeeded', s1PassMsg(c)])),
      s2: resMap([
        ['s2-0', 'succeeded', s2ScoreMsg(4.5)],
        ['s2-1', 'succeeded', s2ScoreMsg(4.6)],
      ]),
    };
    globalThis.fetch = makeBatchStub({ resultsByStage, spy });
    try {
      const config = { anthropicApiKey: 'test-key', maxJobsToEvaluate: 2, companyCachePath: cachePath, ...POLL_FAST };
      const results = await evaluateJobs(jobs, config);
      assert.equal(spy.created.s1, 5, 'Stage 1 batch runs on all 5 (uncapped)');
      assert.equal(spy.created.s2, 2, 'Stage 2 Sonnet batch capped at 2');
      assert.equal(results.length, 2, 'only the 2 scored passers returned; deferred retry next run');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// Test 6 ── timeout path: a batch that never ends throws past the hard timeout,
// leaving state UNTOUCHED (results endpoint never fetched, evaluateJobs rejects).
test('evaluateJobsBatch: hard-timeout throws and never fetches results (no state committed)', async () => {
  await withBatchEnv(async () => {
    const { dir, cachePath } = await makeTmpCachePath();
    const spy = makeSpy();
    const jobs = Array.from({ length: 2 }, (_, i) => makeJob(i));
    globalThis.fetch = makeBatchStub({ resultsByStage: {}, neverEnd: true, spy });
    try {
      const config = {
        anthropicApiKey: 'test-key', maxJobsToEvaluate: 10, companyCachePath: cachePath,
        batchPollInitialMs: 1, batchPollMaxIntervalMs: 1, batchPollBackoff: 1, batchPollHardTimeoutMs: 15,
      };
      await assert.rejects(
        () => evaluateJobs(jobs, config),
        /hard timeout/,
        'batch that never ends rejects with a hard-timeout error',
      );
      assert.notEqual(spy.resultsFetched.s1, true, 'results are never fetched on timeout');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
