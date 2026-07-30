// Seed-shape contract for the committed stubs in data/.
//
// CONTRIBUTING.md freezes these files upstream: every deployed copy of JobBud
// writes real data to the same paths, so an upstream edit lands as a merge
// conflict for every active user at once. A seed whose shape disagrees with its
// reader therefore CANNOT be fixed by editing the seed — the migration has to
// happen at read time. This test pins both halves of that contract:
//
//   1. what each seed actually parses to (so a future seed edit is caught), and
//   2. that the reader-side normalization turns it into the document model the
//      readers actually use.
//
// The bug this guards against is not cosmetic. `if (!doc.jobs) doc.jobs = {}`
// applied to a parsed ARRAY looks fine in memory, but JSON.stringify serializes
// arrays by index and drops the property, so the write re-serializes to the same
// `[]`, GitHub turns the byte-identical blob into an empty commit, and the data is
// gone on the next read. radar.json, job-status.json and mock-sessions.json all
// had this on their fresh-install paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeJsonDoc } from '../lib/github.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data');

// One entry per committed seed. `seed` is the shape the file parses to today;
// `model` is the empty document its readers expect (null = the seed shape IS the
// model, no normalization needed).
const SEEDS = [
  {
    file: 'job-status.json',
    seed: 'array',
    // Readers: api/jobs.js, api/action.js, api/add-job.js, api/coach.js,
    // api/outreach.js, api/queue-linkedin-research.js, scanner/persistJobs.mjs,
    // scanner/remind.mjs, scanner/notify.mjs, scanner/weeklyDigest.mjs,
    // batch/dismiss-stale.mjs — all read doc.jobs[<fingerprint>].
    model: { jobs: {} },
  },
  {
    file: 'radar.json',
    seed: 'array',
    // Readers: api/radar.js, api/coach.js, scanner/radarSource.mjs —
    // all read doc.companies[<id>].
    model: { companies: {} },
  },
  {
    file: 'mock-sessions.json',
    seed: 'array',
    // Reader: api/coach.js get/save-mock-session — reads doc.sessions[].
    model: { sessions: [] },
  },
  {
    file: 'seen-jobs.json',
    seed: 'array',
    // Reader: scanner/dedup.mjs loadSeen — expects a bare { <fingerprint>: entry }
    // MAP, not a wrapper document. It rebuilds a fresh object via Object.entries()
    // during the 90-day prune, so the array seed is already normalized away and
    // nothing is ever patched onto the array. No shared model to assert.
    model: null,
  },
  {
    file: 'company-cache.json',
    seed: 'object',
    // Reader: scanner/enrich.mjs loadCache — expects a bare
    // { <company>: fundingData } map. The `{}` seed already matches.
    model: null,
  },
  // data/api-usage.json is referenced by scanner/quota.mjs and committed back by
  // scanner/commitState.mjs, but it is NOT shipped as a seed — loadUsage() catches
  // the missing-file read and starts from {}. Asserted absent below so that adding
  // it later forces a deliberate shape decision here.
];

for (const { file, seed, model } of SEEDS) {
  test(`data/${file} parses to the ${seed} shape its readers expect`, () => {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
    if (seed === 'array') {
      assert.ok(Array.isArray(parsed), `data/${file} should still be the committed [] stub`);
      assert.equal(parsed.length, 0, 'seed stubs must stay empty');
    } else {
      assert.equal(Array.isArray(parsed), false);
      assert.equal(typeof parsed, 'object');
      assert.deepEqual(parsed, {}, 'seed stubs must stay empty');
    }

    if (!model) return;

    // The read-time migration must produce the document model, and that model must
    // survive the exact serialize/parse round trip every write performs.
    const doc = normalizeJsonDoc(parsed, model);
    assert.equal(Array.isArray(doc), false, `normalized data/${file} must not be an array`);
    for (const key of Object.keys(model)) {
      assert.ok(key in doc, `normalized data/${file} must expose .${key}`);
      assert.equal(
        Array.isArray(doc[key]), Array.isArray(model[key]),
        `.${key} must be a ${Array.isArray(model[key]) ? 'array' : 'object'}`,
      );
    }
    const roundTripped = JSON.parse(JSON.stringify(doc, null, 2) + '\n');
    assert.deepEqual(roundTripped, model, `data/${file} must round-trip as its document model, not as []`);
  });
}

test('data/api-usage.json is not a committed seed (scanner/quota.mjs starts from {})', () => {
  assert.equal(
    fs.existsSync(path.join(dataDir, 'api-usage.json')), false,
    'api-usage.json was added to data/ — decide its shape and add it to SEEDS above',
  );
});

test('the SEEDS table covers every file committed in data/', () => {
  const onDisk = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).sort();
  const covered = SEEDS.map(s => s.file).sort();
  assert.deepEqual(onDisk, covered, 'a data/*.json seed is missing a shape assertion');
});

// The destructive pattern, pinned directly: a named property assigned to a parsed
// array does not survive JSON.stringify. This is why normalization must REPLACE
// the array rather than patch it.
test('assigning a key to a parsed array is silently dropped by JSON.stringify', () => {
  const arr = JSON.parse('[]');
  arr.jobs = { 'fp-1': { status: 'new' } };
  assert.equal(JSON.stringify(arr), '[]', 'the in-memory property is real but unserializable');
  assert.equal(JSON.parse(JSON.stringify(arr)).jobs, undefined);

  // normalizeJsonDoc avoids it by discarding the array entirely.
  const doc = normalizeJsonDoc(JSON.parse('[]'), { jobs: {} });
  doc.jobs['fp-1'] = { status: 'new' };
  assert.equal(JSON.parse(JSON.stringify(doc)).jobs['fp-1'].status, 'new');
});

test('normalizeJsonDoc preserves a well-formed document and its unknown keys', () => {
  const doc = normalizeJsonDoc(
    { jobs: { a: { status: 'applied' } }, schemaVersion: 3 },
    { jobs: {} },
  );
  assert.equal(doc.jobs.a.status, 'applied');
  assert.equal(doc.schemaVersion, 3);
});

test('normalizeJsonDoc replaces a key whose container type is wrong', () => {
  assert.deepEqual(normalizeJsonDoc({ jobs: [] }, { jobs: {} }).jobs, {});
  assert.deepEqual(normalizeJsonDoc({ sessions: {} }, { sessions: [] }).sessions, []);
  assert.deepEqual(normalizeJsonDoc({ jobs: null }, { jobs: {} }).jobs, {});
});
