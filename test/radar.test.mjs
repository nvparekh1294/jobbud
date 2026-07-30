// Regression test for the "added company vanishes on refresh" bug.
//
// data/radar.json ships as the array `[]`, but api/radar.js models the radar as
// an OBJECT { companies: {...} }. The old readRadar assigned `parsed.companies = {}`
// onto the parsed ARRAY. That assignment is legal in memory but JSON.stringify
// serializes arrays by index and DROPS every non-index property, so the write
// re-serialized to the identical `[]`. GitHub's Git Data API then produced an empty
// commit, the endpoint returned success, the UI rendered the company, and the next
// read handed back `[]` — the company was gone. Radar never persisted for any fresh
// install.
//
// The proof below is the exact round trip: read '[]' -> add a company -> serialize
// -> parse. The company MUST survive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRadar, normalizeRadar } from '../api/radar.js';

// Mock the GitHub Contents API to return `content` as the body of data/radar.json.
async function readRadarWithContent(content) {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/contents/data/radar.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
        text: async () => content,
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    return await readRadar('tok', 'owner', 'repo');
  } finally {
    global.fetch = realFetch;
  }
}

test('readRadar on the `[]` seed survives a full add -> serialize -> parse round trip', async () => {
  const radar = await readRadarWithContent('[]');

  // The array seed must be discarded outright, never patched in place.
  assert.equal(Array.isArray(radar), false, 'readRadar must not return an array');
  assert.deepEqual(radar, { companies: {} });

  // Exactly what the ?action=add path does.
  radar.companies['id-1'] = { id: 'id-1', company: 'Acme', contacts: [] };

  // Exactly what writeRadar serializes.
  const serialized = JSON.stringify(radar, null, 2) + '\n';

  // Before the fix this was the literal "[]\n" — a byte-identical blob, an empty
  // commit, and a company that vanished on the next read.
  assert.notEqual(serialized.trim(), '[]', 'the write must not re-serialize to the empty array seed');

  const roundTripped = JSON.parse(serialized);
  assert.ok(roundTripped.companies, 'companies survived serialization');
  assert.equal(roundTripped.companies['id-1'].company, 'Acme', 'the added company survived the round trip');
});

test('readRadar preserves a well-formed existing radar object', async () => {
  const existing = { companies: { 'id-9': { id: 'id-9', company: 'Initech' } }, note: 'keep me' };
  const radar = await readRadarWithContent(JSON.stringify(existing));
  assert.equal(radar.companies['id-9'].company, 'Initech');
  assert.equal(radar.note, 'keep me', 'unknown top-level keys are preserved');
});

test('readRadar returns an empty model when radar.json does not exist yet', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  try {
    assert.deepEqual(await readRadar('tok', 'owner', 'repo'), { companies: {} });
  } finally {
    global.fetch = realFetch;
  }
});

test('normalizeRadar discards every non-plain-object shape', () => {
  for (const bad of [[], [1, 2, 3], null, 'a string', 42, true]) {
    const out = normalizeRadar(bad);
    assert.deepEqual(out, { companies: {} }, `input ${JSON.stringify(bad)} must yield a fresh empty model`);
    assert.equal(Array.isArray(out), false);
    // The returned object must be writable and serialize back with its data intact.
    out.companies.x = { id: 'x' };
    assert.equal(JSON.parse(JSON.stringify(out)).companies.x.id, 'x');
  }
});

test('normalizeRadar replaces a companies value that is an array', () => {
  const out = normalizeRadar({ companies: [] });
  assert.deepEqual(out.companies, {});
  out.companies.y = { id: 'y' };
  assert.equal(JSON.parse(JSON.stringify(out)).companies.y.id, 'y');
});
