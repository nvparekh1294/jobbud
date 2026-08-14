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
import crypto from 'node:crypto';
import handler, { readRadar, normalizeRadar } from '../api/radar.js';

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

// ── The write path must not 500 on a benign unchanged save ───────────────────
//
// writeGithubFile refuses no-op writes by default, because an empty commit is how
// the array-seed bug hid. But radar has genuinely idempotent saves: the edit modal
// re-submits every field, re-picking the status a company already has changes
// nothing, and lastActivity is date-only so a same-day no-change save is
// byte-identical. Those must return 200. Radar's real bug is prevented upstream,
// at the read site, by normalizeRadar — not by this guard.
//
// The GitHub fake below is CONTENT-ADDRESSED like the real Git Data API: the tree
// sha derives from the blob sha, which derives from a hash of the content. So an
// unchanged write really does produce newTreeSha === treeSha and really does
// exercise the no-op path — nothing about the no-op is stubbed out.
function makeContentAddressedGitHub(initialFile) {
  const state = { file: initialFile, headSha: 'commit-0', commits: { 'commit-0': null }, blobs: new Map() };
  const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
  const res = (obj, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => obj, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  });

  // The tree of a commit is the tree of the single file it contains.
  state.commits['commit-0'] = `tree-${sha(initialFile)}`;

  async function fetchMock(url, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (url.includes('/contents/')) {
      return res({ content: Buffer.from(state.file).toString('base64'), encoding: 'base64' });
    }
    if (url.endsWith('/git/blobs') && method === 'POST') {
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      const blobSha = `blob-${sha(content)}`;
      state.blobs.set(blobSha, content);
      return res({ sha: blobSha });
    }
    if (url.includes('/git/ref/heads/') && method === 'GET') return res({ object: { sha: state.headSha } });
    if (url.includes('/git/commits/') && method === 'GET') {
      return res({ tree: { sha: state.commits[url.split('/').pop()] } });
    }
    if (url.endsWith('/git/trees') && method === 'POST') {
      // One file in the tree, so the tree sha is a pure function of its blob —
      // identical content in means the identical tree sha out.
      return res({ sha: `tree-${state.blobs.get(body.tree[0].sha) !== undefined ? sha(state.blobs.get(body.tree[0].sha)) : body.tree[0].sha}` });
    }
    if (url.endsWith('/git/commits') && method === 'POST') {
      const commitSha = `commit-${sha(body.tree + body.message)}`;
      state.commits[commitSha] = body.tree;
      return res({ sha: commitSha });
    }
    if (url.includes('/git/refs/heads/') && method === 'PATCH') {
      state.headSha = body.sha;
      // Resolve the committed tree back to the blob content it names.
      for (const content of state.blobs.values()) {
        if (`tree-${sha(content)}` === state.commits[body.sha]) { state.file = content; break; }
      }
      return res({ ref: 'refs/heads/main' });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }
  return { state, fetchMock };
}

function makeRes() {
  const out = { statusCode: null, body: null, headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; },
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    send(payload) { out.body = payload; return this; },
  };
}

async function callRadar({ action, body }, fetchMock) {
  const saved = {
    pw: process.env.DASHBOARD_PASSWORD, tok: process.env.GH_TOKEN,
    repo: process.env.GH_REPO, ref: process.env.GITHUB_REF_NAME,
  };
  process.env.DASHBOARD_PASSWORD = 'pw';
  process.env.GH_TOKEN = 'tok';
  process.env.GH_REPO = 'owner/repo';
  delete process.env.GITHUB_REF_NAME;
  const realFetch = global.fetch;
  global.fetch = fetchMock;
  const res = makeRes();
  try {
    await handler(
      { method: 'POST', headers: { 'x-dashboard-password': 'pw' }, query: { action }, body },
      res,
    );
  } finally {
    global.fetch = realFetch;
    for (const [k, v] of [['DASHBOARD_PASSWORD', saved.pw], ['GH_TOKEN', saved.tok], ['GH_REPO', saved.repo], ['GITHUB_REF_NAME', saved.ref]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return res.out;
}

test('radar add on the `[]` seed persists through the real write path', async () => {
  const { state, fetchMock } = makeContentAddressedGitHub('[]');
  const added = await callRadar({ action: 'add', body: { company: 'Acme', url: 'https://acme.example' } }, fetchMock);

  assert.equal(added.statusCode, 200, `add should succeed; got ${JSON.stringify(added.body)}`);
  // The committed file is a real document now, not the array seed it started as.
  const committed = JSON.parse(state.file);
  assert.equal(Array.isArray(committed), false);
  assert.equal(Object.values(committed.companies)[0].company, 'Acme', 'the company actually landed in the repo');
});

test('radar update with unchanged fields on the same day returns 200, not 500', async () => {
  const { state, fetchMock } = makeContentAddressedGitHub('[]');
  const added = await callRadar({ action: 'add', body: { company: 'Acme', status: 'researching' } }, fetchMock);
  assert.equal(added.statusCode, 200);
  const id = added.body.company.id;
  const fileAfterAdd = state.file;

  // Exactly what the edit modal posts when nothing was edited: every field
  // re-submitted with its current value. lastActivity is date-only, so on the same
  // day this serializes byte-for-byte identically -> a genuine no-op write.
  const unchanged = await callRadar({
    action: 'update',
    body: { companyId: id, company: 'Acme', status: 'researching' },
  }, fetchMock);

  assert.equal(
    unchanged.statusCode, 200,
    `an unchanged same-day save must not error; got ${unchanged.statusCode} ${JSON.stringify(unchanged.body)}`,
  );
  assert.equal(unchanged.body.success, true);
  assert.equal(state.file, fileAfterAdd, 'nothing changed in the repo, and nothing was corrupted');

  // Re-picking the status the company already has is the same benign no-op.
  const restatus = await callRadar({ action: 'update', body: { companyId: id, status: 'researching' } }, fetchMock);
  assert.equal(restatus.statusCode, 200, 're-selecting the current status must not error');
});

test('radar update with a real change still commits', async () => {
  const { state, fetchMock } = makeContentAddressedGitHub('[]');
  const added = await callRadar({ action: 'add', body: { company: 'Acme' } }, fetchMock);
  const id = added.body.company.id;

  const changed = await callRadar({ action: 'update', body: { companyId: id, status: 'contacted' } }, fetchMock);
  assert.equal(changed.statusCode, 200);
  assert.equal(JSON.parse(state.file).companies[id].status, 'contacted', 'the real change landed');
});
