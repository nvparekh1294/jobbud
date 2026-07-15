// Tests for the repo-visibility guard that stops personal files from being
// committed to a PUBLIC repo. Covers both the low-level lib/github.js helper and
// the two API save paths that must enforce it: coach save-onboarding and
// coach save-story. global.fetch is mocked per-test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRepoPrivate, getRepoInfo, RepoPublicError } from '../lib/github.js';

const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

function withFetch(fn, run) {
  const real = global.fetch;
  global.fetch = fn;
  return run().finally(() => { global.fetch = real; });
}

// ── lib/github.js helper ──────────────────────────────────────────────────────
test('getRepoInfo reports private:true for a private repo', async () => {
  await withFetch(
    async (url) => {
      assert.ok(url.endsWith('/repos/acme/jobs'));
      return jsonRes({ private: true, full_name: 'acme/jobs' });
    },
    async () => {
      const info = await getRepoInfo('tok', 'acme', 'jobs');
      assert.equal(info.private, true);
      assert.equal(info.fullName, 'acme/jobs');
    },
  );
});

test('assertRepoPrivate resolves for a private repo', async () => {
  await withFetch(
    async () => jsonRes({ private: true, full_name: 'acme/jobs' }),
    async () => {
      const info = await assertRepoPrivate('tok', 'acme', 'jobs');
      assert.equal(info.private, true);
    },
  );
});

test('assertRepoPrivate throws RepoPublicError for a public repo', async () => {
  await withFetch(
    async () => jsonRes({ private: false, full_name: 'acme/jobs' }),
    async () => {
      await assert.rejects(
        () => assertRepoPrivate('tok', 'acme', 'jobs'),
        (err) => err instanceof RepoPublicError && err.code === 'REPO_PUBLIC',
      );
    },
  );
});

test('assertRepoPrivate fails closed when visibility cannot be determined', async () => {
  await withFetch(
    async () => jsonRes({ message: 'Not Found' }, 404),
    async () => {
      await assert.rejects(() => assertRepoPrivate('tok', 'acme', 'gone'));
    },
  );
});

// ── coach save paths ──────────────────────────────────────────────────────────
// A tiny res double that records status + json body.
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

const baseEnv = () => {
  process.env.DASHBOARD_PASSWORD = 'pw';
  process.env.GH_TOKEN = 'tok';
  process.env.GH_REPO = 'acme/jobs';
  process.env.ANTHROPIC_API_KEY = 'k';
};

// Route a GitHub mock by repo-info vs. git-write endpoints. Records writes.
// storyContent (optional) is served (base64) for the story-bank Contents read so
// delete/update paths can locate an existing story; default is "file absent".
function makeGithubMock({ isPrivate, storyContent = null }) {
  const writes = [];
  const fetchMock = async (url, opts = {}) => {
    // Repo info lookup: GET /repos/{owner}/{repo} (no trailing path segment)
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return jsonRes({ private: isPrivate, full_name: 'acme/jobs' });
    }
    // Contents API read (story-bank pre-read)
    if (url.includes('/contents/')) {
      if (storyContent === null) return jsonRes({ message: 'Not Found' }, 404);
      return jsonRes({ content: Buffer.from(storyContent, 'utf8').toString('base64'), sha: 'blob0' });
    }
    // Git Data API write chain
    if (url.includes('/git/ref/heads/')) return jsonRes({ object: { sha: 'c0' } });
    if (url.includes('/git/commits/c0')) return jsonRes({ tree: { sha: 't0' } });
    if (url.endsWith('/git/blobs')) return jsonRes({ sha: 'b1' });
    if (url.endsWith('/git/trees')) { writes.push('tree'); return jsonRes({ sha: 't1' }); }
    if (url.endsWith('/git/commits')) return jsonRes({ sha: 'c1' });
    if (url.includes('/git/refs/heads/')) return jsonRes({ object: { sha: 'c1' } });
    return jsonRes({}, 500);
  };
  return { fetchMock, writes };
}

test('save-onboarding writes to a PRIVATE repo', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock, writes } = makeGithubMock({ isPrivate: true });
  await withFetch(fetchMock, async () => {
    const req = {
      method: 'POST',
      query: { action: 'save-onboarding' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { claudeMd: '# Alex Doe', profileYml: '# JobBud Profile\nname: Alex Doe' },
    };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.saved, ['CLAUDE.md', 'config/profile.yml']);
    assert.equal(writes.length, 2); // one tree write per file committed
  });
});

test('save-onboarding REFUSES a PUBLIC repo and writes nothing', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock, writes } = makeGithubMock({ isPrivate: false });
  await withFetch(fetchMock, async () => {
    const req = {
      method: 'POST',
      query: { action: 'save-onboarding' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { claudeMd: '# Alex Doe', profileYml: '# JobBud Profile' },
    };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'REPO_PUBLIC');
    assert.equal(writes.length, 0); // nothing committed
  });
});

test('save-story REFUSES a PUBLIC repo and writes nothing', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock, writes } = makeGithubMock({ isPrivate: false });
  await withFetch(fetchMock, async () => {
    const req = {
      method: 'POST',
      query: { action: 'save-story' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { storyMarkdown: '### A story\nBody.' },
    };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'REPO_PUBLIC');
    assert.equal(writes.length, 0);
  });
});

test('save-story writes to a PRIVATE repo', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock, writes } = makeGithubMock({ isPrivate: true });
  await withFetch(fetchMock, async () => {
    const req = {
      method: 'POST',
      query: { action: 'save-story' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { storyMarkdown: '### A story\nBody.' },
    };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(writes.length, 1);
  });
});

// ── delete-story / update-story enforce the same guard ────────────────────────
// Both write story-bank.md via writeStoryBankContent, the single guarded choke
// point. On a PUBLIC repo they must refuse with zero writes. Existing content is
// served so the target story is found and the write path is actually reached.
const EXISTING_STORIES = '# Story Bank\n\n### A story\nBody.\n';

test('delete-story REFUSES a PUBLIC repo and writes nothing', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock, writes } = makeGithubMock({ isPrivate: false, storyContent: EXISTING_STORIES });
  await withFetch(fetchMock, async () => {
    const req = {
      method: 'POST',
      query: { action: 'delete-story' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { storyId: 'A story' },
    };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'REPO_PUBLIC');
    assert.equal(writes.length, 0);
  });
});

test('delete-story writes to a PRIVATE repo', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock, writes } = makeGithubMock({ isPrivate: true, storyContent: EXISTING_STORIES });
  await withFetch(fetchMock, async () => {
    const req = {
      method: 'POST',
      query: { action: 'delete-story' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { storyId: 'A story' },
    };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(writes.length, 1);
  });
});

test('update-story REFUSES a PUBLIC repo and writes nothing', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock, writes } = makeGithubMock({ isPrivate: false, storyContent: EXISTING_STORIES });
  await withFetch(fetchMock, async () => {
    const req = {
      method: 'POST',
      query: { action: 'update-story' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { storyId: 'A story', content: '### A story\nRevised body.' },
    };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'REPO_PUBLIC');
    assert.equal(writes.length, 0);
  });
});

test('update-story writes to a PRIVATE repo', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock, writes } = makeGithubMock({ isPrivate: true, storyContent: EXISTING_STORIES });
  await withFetch(fetchMock, async () => {
    const req = {
      method: 'POST',
      query: { action: 'update-story' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { storyId: 'A story', content: '### A story\nRevised body.' },
    };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(writes.length, 1);
  });
});
