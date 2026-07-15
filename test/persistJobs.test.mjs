// Unit test for scanner/persistJobs.mjs's failure-vs-empty invariant:
// "if a persist fails, affected jobs are not marked seen".
//
// The caller (scanner/index.mjs) treats any non-throwing return from persistJobs
// as success and marks the jobs seen. So the initial up-front read MUST propagate
// a genuine read failure (network error / GitHub 5xx) as a throw — returning 0
// would mark jobs seen while nothing was saved, losing them permanently. A file
// that is genuinely absent (404 → { exists: false }) is NOT a failure: persistJobs
// must start from an empty set and proceed to write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistJobs } from '../scanner/persistJobs.mjs';

const res = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
});

test('persistJobs throws (does not return success) when the initial read fails', async () => {
  const prevToken = process.env.GH_TOKEN;
  const prevRepo = process.env.GH_REPO;
  const prevRef = process.env.GITHUB_REF_NAME;
  const realFetch = global.fetch;
  process.env.GH_TOKEN = 'tok';
  process.env.GH_REPO = 'test-owner/test-repo';
  // persistJobs doesn't pass a branch option, so it defaults to
  // GITHUB_REF_NAME || 'main'. In GitHub Actions pull_request runs,
  // GITHUB_REF_NAME is auto-set to e.g. "5/merge" — delete it so this test's
  // target branch is deterministic regardless of environment.
  delete process.env.GITHUB_REF_NAME;
  // Every read of the file is a GitHub 5xx — a genuine read failure, not a 404.
  global.fetch = async (url) => {
    if (url.includes('/contents/')) return res('upstream is down', 503);
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    await assert.rejects(
      () => persistJobs([{ _fingerprint: 'abc', title: 'Role A', company: 'Co' }]),
      /Failed to load job-status\.json/,
      'a read failure must propagate as a throw, never resolve as success',
    );
  } finally {
    global.fetch = realFetch;
    if (prevToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevToken;
    if (prevRepo === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = prevRepo;
    if (prevRef === undefined) delete process.env.GITHUB_REF_NAME; else process.env.GITHUB_REF_NAME = prevRef;
  }
});

test('persistJobs treats a genuine 404 as start-from-empty and persists, not as a failure', async () => {
  const prevToken = process.env.GH_TOKEN;
  const prevRepo = process.env.GH_REPO;
  const prevRef = process.env.GITHUB_REF_NAME;
  const realFetch = global.fetch;
  process.env.GH_TOKEN = 'tok';
  process.env.GH_REPO = 'test-owner/test-repo';
  // This test's fetch mock only recognizes heads/main URLs — persistJobs must
  // target the default branch, so GITHUB_REF_NAME must be unset here. See the
  // comment on the sibling test above for why.
  delete process.env.GITHUB_REF_NAME;

  // Stateful mock: the file 404s (absent), and the write path (blob→tree→commit→
  // advance ref) succeeds first try. Proves 404 is not conflated with a read error.
  let headSha = 'commit-0';
  let seq = 0;
  const treeBlob = new Map();
  const commitBlob = new Map();
  const blobs = new Map();
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (url.includes('/contents/')) return res('not found', 404);
    if (url.endsWith('/git/blobs') && method === 'POST') {
      const sha = `blob-${++seq}`;
      blobs.set(sha, Buffer.from(body.content, 'base64').toString('utf8'));
      return res({ sha });
    }
    if (url.includes('/git/ref/heads/main') && method === 'GET') return res({ object: { sha: headSha } });
    if (url.includes('/git/commits/') && method === 'GET') return res({ tree: { sha: `tree-of-${url.split('/').pop()}` } });
    if (url.endsWith('/git/trees') && method === 'POST') {
      const sha = `tree-${++seq}`;
      treeBlob.set(sha, body.tree[0].sha);
      return res({ sha });
    }
    if (url.endsWith('/git/commits') && method === 'POST') {
      const sha = `commit-${++seq}`;
      commitBlob.set(sha, treeBlob.get(body.tree));
      return res({ sha });
    }
    if (url.includes('/git/refs/heads/main') && method === 'PATCH') {
      headSha = body.sha;
      return res({ ref: 'refs/heads/main' });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  try {
    const added = await persistJobs([{ _fingerprint: 'abc', title: 'Role A', company: 'Co' }]);
    assert.equal(added, 1, 'a genuinely absent file starts from empty and the job is persisted');
  } finally {
    global.fetch = realFetch;
    if (prevToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevToken;
    if (prevRepo === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = prevRepo;
    if (prevRef === undefined) delete process.env.GITHUB_REF_NAME; else process.env.GITHUB_REF_NAME = prevRef;
  }
});
