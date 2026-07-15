// Unit test for lib/github.js writeGithubFile's field-safe builder form.
//
// This test proves the ACTUAL production helper:
// with global.fetch mocked to model GitHub's ref/sha optimistic concurrency, it
// forces a 422 (main moved under us) after the builder read, injects a concurrent
// writer's change, and asserts the retry re-reads and preserves BOTH changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeGithubFile, readGithubFile } from '../lib/github.js';

// Build a stateful GitHub mock over a single JSON file (data/job-status.json).
function makeMockGitHub(initialDoc) {
  const state = {
    doc: structuredClone(initialDoc),
    headSha: 'commit-0',
    patchAttempts: 0,
    blobs: new Map(),        // blobSha  -> content string
    treeBlob: new Map(),     // treeSha  -> blobSha
    commitBlob: new Map(),   // commitSha -> blobSha
    seq: 0,
    refPaths: [],            // every /git/ref(s)/heads/<branch> URL the writer hit
    contentsRefs: [],        // every ?ref= the Contents API was read with
  };

  const res = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  });

  async function fetchMock(url, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;

    // Read file via Contents API (records the branch ref it was scoped to)
    if (url.includes('/contents/')) {
      const ref = new URL(url).searchParams.get('ref');
      if (ref) state.contentsRefs.push(ref);
      const content = Buffer.from(JSON.stringify(state.doc)).toString('base64');
      return res({ content, encoding: 'base64' });
    }
    // Create blob
    if (url.endsWith('/git/blobs') && method === 'POST') {
      const sha = `blob-${++state.seq}`;
      state.blobs.set(sha, Buffer.from(body.content, 'base64').toString('utf8'));
      return res({ sha });
    }
    // Get HEAD ref (branch-generic: /git/ref/heads/<branch>)
    if (url.includes('/git/ref/heads/') && method === 'GET') {
      state.refPaths.push(url.slice(url.indexOf('/git/ref/heads/') + '/git/'.length));
      return res({ object: { sha: state.headSha } });
    }
    // Get commit -> tree
    if (url.includes('/git/commits/') && method === 'GET') {
      return res({ tree: { sha: `tree-of-${url.split('/').pop()}` } });
    }
    // Create tree
    if (url.endsWith('/git/trees') && method === 'POST') {
      const sha = `tree-${++state.seq}`;
      state.treeBlob.set(sha, body.tree[0].sha);
      return res({ sha });
    }
    // Create commit
    if (url.endsWith('/git/commits') && method === 'POST') {
      const sha = `commit-${++state.seq}`;
      state.commitBlob.set(sha, state.treeBlob.get(body.tree));
      return res({ sha });
    }
    // Advance ref (PATCH) (branch-generic: /git/refs/heads/<branch>)
    if (url.includes('/git/refs/heads/') && method === 'PATCH') {
      state.refPaths.push(url.slice(url.indexOf('/git/refs/heads/') + '/git/'.length));
      state.patchAttempts += 1;
      if (state.patchAttempts === 1) {
        // Simulate a concurrent writer landing between our read and this advance:
        // writer B sets job B's status, and HEAD moves — so our PATCH is a 422.
        state.doc.jobs.b.status = 'interviewing';
        state.headSha = 'commit-concurrent';
        return res('non-fast-forward', 422);
      }
      // Second attempt: apply our commit's blob content as the new file.
      const blobSha = state.commitBlob.get(body.sha);
      state.doc = JSON.parse(state.blobs.get(blobSha));
      state.headSha = body.sha;
      return res({ ref: 'refs/heads/main' });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }

  return { state, fetchMock };
}

test('writeGithubFile builder form preserves a concurrent change across a 422 retry', async () => {
  const { state, fetchMock } = makeMockGitHub({
    jobs: {
      a: { status: 'new', title: 'Role A' },
      b: { status: 'new', title: 'Role B' },
    },
  });

  const realFetch = global.fetch;
  global.fetch = fetchMock;
  try {
    // This writer only ever touches job A. It must not clobber job B's concurrent
    // change, even though its first read predates that change.
    await writeGithubFile(
      'tok', 'owner', 'repo', 'data/job-status.json',
      (current) => {
        const doc = current ? JSON.parse(current) : { jobs: {} };
        doc.jobs.a.status = 'applied';
        return JSON.stringify(doc, null, 2);
      },
      'test: update job A',
      { maxAttempts: 5 },
    );
  } finally {
    global.fetch = realFetch;
  }

  assert.equal(state.patchAttempts, 2, 'should retry exactly once after the 422');
  assert.equal(state.doc.jobs.a.status, 'applied', "this writer's change landed");
  assert.equal(state.doc.jobs.b.status, 'interviewing', "concurrent writer's change was preserved, not erased");
});

test('writeGithubFile string form writes verbatim content', async () => {
  const { state, fetchMock } = makeMockGitHub({ jobs: {} });
  const realFetch = global.fetch;
  global.fetch = fetchMock;
  try {
    // No conflict this run (single writer) — but force the mock's first-PATCH 422
    // path to be skipped by pre-advancing patchAttempts so the string form commits.
    state.patchAttempts = 1;
    await writeGithubFile(
      'tok', 'owner', 'repo', 'data/radar.json',
      JSON.stringify({ companies: { x: 1 } }, null, 2),
      'test: write radar',
    );
  } finally {
    global.fetch = realFetch;
  }
  assert.deepEqual(state.doc, { companies: { x: 1 } });
});

// ── writeGithubFile targets the run's branch, not a hardcoded main ───────
test('writeGithubFile writes to the branch from the option / GITHUB_REF_NAME', async () => {
  const { state, fetchMock } = makeMockGitHub({ jobs: {} });
  const realFetch = global.fetch;
  global.fetch = fetchMock;
  try {
    state.patchAttempts = 1; // skip the forced-422 branch so the write commits once
    await writeGithubFile(
      'tok', 'owner', 'repo', 'data/seen-jobs.json',
      JSON.stringify({ ok: true }),
      'test: write on a feature branch',
      { branch: 'plan/reliability-batch' },
    );
  } finally {
    global.fetch = realFetch;
  }
  // Both the GET (ref/heads) and PATCH (refs/heads) must carry the branch.
  assert.ok(
    state.refPaths.some(p => p === 'ref/heads/plan/reliability-batch'),
    `GET ref should target the branch; saw ${JSON.stringify(state.refPaths)}`,
  );
  assert.ok(
    state.refPaths.some(p => p === 'refs/heads/plan/reliability-batch'),
    `PATCH ref should target the branch; saw ${JSON.stringify(state.refPaths)}`,
  );
  assert.ok(
    !state.refPaths.some(p => p.endsWith('/main')),
    'nothing should touch main when a branch is given',
  );
});

test('writeGithubFile defaults to main when no branch is set', async () => {
  const savedRef = process.env.GITHUB_REF_NAME;
  delete process.env.GITHUB_REF_NAME;
  const { state, fetchMock } = makeMockGitHub({ jobs: {} });
  const realFetch = global.fetch;
  global.fetch = fetchMock;
  try {
    state.patchAttempts = 1;
    await writeGithubFile(
      'tok', 'owner', 'repo', 'data/radar.json',
      JSON.stringify({ ok: true }),
      'test: default branch',
    );
  } finally {
    global.fetch = realFetch;
    if (savedRef !== undefined) process.env.GITHUB_REF_NAME = savedRef;
  }
  assert.ok(state.refPaths.includes('ref/heads/main'));
  assert.ok(state.refPaths.includes('refs/heads/main'));
});

// ── The builder re-read is scoped to the write branch ───────
// A 422 forces the builder to re-read job-status.json before retrying. Every such
// re-read must hit the WRITE branch's ref, never main — otherwise the branch write
// gets rebased on top of the default branch's content (read/write split-brain).
test('writeGithubFile builder re-reads the SAME branch it writes across a 422 retry', async () => {
  const { state, fetchMock } = makeMockGitHub({
    jobs: {
      a: { status: 'new', title: 'Role A' },
      b: { status: 'new', title: 'Role B' },
    },
  });
  const realFetch = global.fetch;
  global.fetch = fetchMock;
  try {
    await writeGithubFile(
      'tok', 'owner', 'repo', 'data/job-status.json',
      (current) => {
        const doc = current ? JSON.parse(current) : { jobs: {} };
        doc.jobs.a.status = 'applied';
        return JSON.stringify(doc, null, 2);
      },
      'test: update job A on a feature branch',
      { branch: 'plan/reliability-batch' },
    );
  } finally {
    global.fetch = realFetch;
  }

  assert.equal(state.patchAttempts, 2, 'should retry once after the 422');
  // Anchored reads: the builder reads content ?ref=<commit sha> — the
  // exact tip the WRITE branch's ref returned each attempt ('commit-0', then
  // 'commit-concurrent' after the 422), never the branch name resolved against main.
  // One read per attempt (2 attempts). This still proves the split-brain guarantee:
  // the anchoring sha derives from the write branch's own ref, so no read can fall
  // back to the default branch's content.
  assert.ok(state.contentsRefs.length >= 2, `expected >=2 anchored reads, saw ${JSON.stringify(state.contentsRefs)}`);
  const anchoredShas = new Set(['commit-0', 'commit-concurrent']);
  assert.ok(
    state.contentsRefs.every(r => anchoredShas.has(r)),
    `every builder read must be anchored to a commit sha from the write branch's ref; saw ${JSON.stringify(state.contentsRefs)}`,
  );
  assert.ok(!state.contentsRefs.some(r => r === 'main'), 'no builder read may resolve against main');
  assert.ok(state.refPaths.some(p => p === 'ref/heads/plan/reliability-batch'));
  assert.ok(!state.refPaths.some(p => p.endsWith('/main')), 'nothing should touch main');
  assert.equal(state.doc.jobs.a.status, 'applied', "this writer's change landed");
  assert.equal(state.doc.jobs.b.status, 'interviewing', "concurrent change preserved");
});

// ── The builder read is anchored to the ref's commit sha ────────
// The lost-update race that silently reverted two real rejects: a concurrent writer
// (B) commits and advances HEAD, but a content read scoped to the moving BRANCH ref
// returns stale (pre-B) content — no 422 fires because the eventual parent IS the new
// HEAD, so B's change is fast-forwarded away. Anchoring the read to the exact commit
// sha the ref returned reads B's content and preserves it. This test would FAIL under
// the old read-then-ref ordering: the stale branch read would drop b:interviewing.
test('writeGithubFile anchors the builder read to the ref commit — survives a stale branch read (silent-clobber guard)', async () => {
  // Content AT the true HEAD commit (what an anchored ?ref=<sha> read must return).
  const contentAtCommit = {
    'commit-B': { jobs: { a: { status: 'new' }, b: { status: 'interviewing' } } },
  };
  // What a lagging read-by-BRANCH would return — pre-B, missing b:interviewing.
  const staleBranchDoc = { jobs: { a: { status: 'new' }, b: { status: 'new' } } };

  const state = {
    headSha: 'commit-B', patchAttempts: 0, finalDoc: null, contentsRefs: [],
    blobs: new Map(), treeBlob: new Map(), commitBlob: new Map(), seq: 0,
  };
  const res = (obj, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => obj, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  });

  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (url.includes('/contents/')) {
      const ref = new URL(url).searchParams.get('ref');
      state.contentsRefs.push(ref);
      // Anchored (commit-sha) reads get the true content; a branch-name read is stale.
      const doc = contentAtCommit[ref] || staleBranchDoc;
      return res({ content: Buffer.from(JSON.stringify(doc)).toString('base64'), encoding: 'base64' });
    }
    if (url.endsWith('/git/blobs') && method === 'POST') {
      const sha = `blob-${++state.seq}`;
      state.blobs.set(sha, Buffer.from(body.content, 'base64').toString('utf8'));
      return res({ sha });
    }
    if (url.includes('/git/ref/heads/') && method === 'GET') return res({ object: { sha: state.headSha } });
    if (url.includes('/git/commits/') && method === 'GET') return res({ tree: { sha: `tree-of-${url.split('/').pop()}` } });
    if (url.endsWith('/git/trees') && method === 'POST') {
      const sha = `tree-${++state.seq}`;
      state.treeBlob.set(sha, body.tree[0].sha);
      return res({ sha });
    }
    if (url.endsWith('/git/commits') && method === 'POST') {
      const sha = `commit-${++state.seq}`;
      state.commitBlob.set(sha, state.treeBlob.get(body.tree));
      return res({ sha });
    }
    if (url.includes('/git/refs/heads/') && method === 'PATCH') {
      state.patchAttempts += 1;
      state.finalDoc = JSON.parse(state.blobs.get(state.commitBlob.get(body.sha)));
      state.headSha = body.sha;
      return res({ ref: 'refs/heads/main' });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  try {
    await writeGithubFile(
      'tok', 'owner', 'repo', 'data/job-status.json',
      (current) => {
        const doc = current ? JSON.parse(current) : { jobs: {} };
        doc.jobs.a.status = 'applied';
        return JSON.stringify(doc, null, 2);
      },
      'test: update job A while B already committed',
      { maxAttempts: 5 },
    );
  } finally {
    global.fetch = realFetch;
  }

  // The clobber path never triggers a 422 — that is exactly what made it silent.
  assert.equal(state.patchAttempts, 1, 'the silent-clobber path is a clean fast-forward, no 422');
  // The read must be anchored to the ref's commit sha, never a bare branch name.
  assert.ok(state.contentsRefs.length >= 1, `expected an anchored read, saw ${JSON.stringify(state.contentsRefs)}`);
  assert.ok(
    state.contentsRefs.every(r => r === 'commit-B'),
    `builder read must use the ref's commit sha, not the branch; saw ${JSON.stringify(state.contentsRefs)}`,
  );
  assert.equal(state.finalDoc.jobs.a.status, 'applied', "this writer's change landed");
  assert.equal(
    state.finalDoc.jobs.b.status, 'interviewing',
    "concurrent writer's change survived via the anchored read — not clobbered by a stale branch read",
  );
});

// The >1 MB fallback must stay pinned to the branch: use the blob sha from the
// ref-scoped metadata via the Git Data API, NOT the ambiguous raw download_url.
test('readGithubFile large-file fallback fetches the blob by sha from the ref-scoped metadata', async () => {
  const bigContent = JSON.stringify({ jobs: { z: { status: 'new' } } });
  const blobSha = 'blob-sha-abc123';
  const seen = { contentsRef: null, blobUrl: null, usedDownloadUrl: false };

  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const res = (obj, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => obj, text: async () => JSON.stringify(obj),
    });
    if (url.includes('raw.githubusercontent.com')) { seen.usedDownloadUrl = true; return res('nope', 500); }
    if (url.includes('/contents/')) {
      seen.contentsRef = new URL(url).searchParams.get('ref');
      // >1 MB response shape: empty content, encoding "none", blob sha present,
      // plus a (deliberately wrong-branch) download_url the code must ignore.
      return res({
        content: '', encoding: 'none', sha: blobSha, size: 6_000_000,
        download_url: 'https://raw.githubusercontent.com/o/r/main/data/job-status.json',
      });
    }
    if (url.includes(`/git/blobs/${blobSha}`)) {
      seen.blobUrl = url;
      return res({ content: Buffer.from(bigContent).toString('base64'), encoding: 'base64', sha: blobSha });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const { exists, content } = await readGithubFile(
      'tok', 'owner', 'repo', 'data/job-status.json',
      { branch: 'plan/reliability-batch' },
    );
    assert.equal(exists, true);
    assert.equal(content, bigContent, 'returns the full blob content');
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(seen.contentsRef, 'plan/reliability-batch', 'metadata read must be ref-scoped to the branch');
  assert.ok(seen.blobUrl && seen.blobUrl.endsWith(`/git/blobs/${blobSha}`), `fallback must fetch the sha from the ref-scoped response; saw ${seen.blobUrl}`);
  assert.equal(seen.usedDownloadUrl, false, 'the ambiguous raw download_url must NOT be used');
});

// ── Transient 5xx on a read is retried, not thrown to the user ──
// A GitHub 502 (HTML error page) on the builder's read used to throw straight to a
// user-visible 500. readGithubFile now retries reads on 5xx / network errors.
test('readGithubFile retries a transient 502 on the read, then succeeds', async () => {
  const doc = JSON.stringify({ jobs: { z: { status: 'new' } } });
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const res = (obj, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => obj, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
    });
    if (url.includes('/contents/')) {
      calls += 1;
      // First read 502s (HTML error body); the retry succeeds.
      if (calls === 1) return res('<html>502 Bad Gateway</html>', 502);
      return res({ content: Buffer.from(doc).toString('base64'), encoding: 'base64' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const { exists, content } = await readGithubFile('tok', 'owner', 'repo', 'data/job-status.json', { branch: 'main' });
    assert.equal(exists, true);
    assert.equal(content, doc, 'returns the content from the successful retry');
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(calls, 2, 'the 502 was retried exactly once before succeeding');
});

// A 404 is not transient — it must resolve immediately with no retry.
test('readGithubFile does NOT retry a 404 (immediate not-found)', async () => {
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  try {
    const { exists, content } = await readGithubFile('tok', 'owner', 'repo', 'data/missing.json', { branch: 'main' });
    assert.equal(exists, false);
    assert.equal(content, null);
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(calls, 1, '404 must not be retried');
});
