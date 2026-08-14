// Tests for coach get-assets, the single read the dashboard uses to tell a
// RETURNING user (repo already holds profile files) from a brand-new one.
// It must return all five durable profile files plus the story bank, degrade to
// '' per file, and never break the two-key shape older callers destructure.
// global.fetch is mocked per-test against the GitHub Contents API.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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

// A tiny res double that records status, headers and json body.
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

const baseEnv = () => {
  process.env.DASHBOARD_PASSWORD = 'pw';
  process.env.GH_TOKEN = 'tok';
  process.env.GH_REPO = 'acme/jobs';
};

// Serve the Contents API from a { 'path': content } map. Paths absent from the
// map 404 (file missing); paths mapped to the FAIL sentinel return a hard error
// status so the soft-read path is exercised. Records every path requested.
const FAIL = Symbol('read failure');

function makeContentsMock(files) {
  const requested = [];
  const fetchMock = async (url) => {
    const m = /\/contents\/(.+?)\?/.exec(url);
    if (!m) return jsonRes({ message: 'Not Found' }, 404);
    const path = decodeURIComponent(m[1]);
    requested.push(path);
    const content = files[path];
    if (content === undefined) return jsonRes({ message: 'Not Found' }, 404);
    // 403 (not 5xx) so the read fails without burning the retry backoffs.
    if (content === FAIL) return jsonRes({ message: 'Forbidden' }, 403);
    return jsonRes({ content: Buffer.from(content, 'utf8').toString('base64'), sha: 'blob0' });
  };
  return { fetchMock, requested };
}

const getAssetsReq = () => ({
  method: 'GET',
  query: { action: 'get-assets' },
  headers: { 'x-dashboard-password': 'pw' },
});

const ALL_FILES = {
  'CLAUDE.md':          '# Alex Doe',
  'story-bank.md':      '# Story Bank\n\n### A story\nBody.',
  'cv.md':              '# Alex Doe — CV',
  'bullet-bank.md':     '## Ops\n- Cut spend 20%',
  'article-digest.md':  '## Role Context\nDetail.',
  'config/profile.yml': 'name: Alex Doe',
};

test('get-assets returns all five profile files plus the story bank', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock, requested } = makeContentsMock(ALL_FILES);
  await withFetch(fetchMock, async () => {
    const res = makeRes();
    await handler(getAssetsReq(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      claudeMd:        '# Alex Doe',
      storyBank:       '# Story Bank\n\n### A story\nBody.',
      cvMd:            '# Alex Doe — CV',
      bulletBankMd:    '## Ops\n- Cut spend 20%',
      articleDigestMd: '## Role Context\nDetail.',
      profileYml:      'name: Alex Doe',
    });
    // Every durable profile file is actually read (nothing quietly dropped).
    assert.deepEqual(
      [...requested].sort(),
      ['CLAUDE.md', 'article-digest.md', 'bullet-bank.md', 'config/profile.yml', 'cv.md', 'story-bank.md'],
    );
  });
});

test('get-assets keeps the legacy { claudeMd, storyBank } shape intact', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock } = makeContentsMock(ALL_FILES);
  await withFetch(fetchMock, async () => {
    const res = makeRes();
    await handler(getAssetsReq(), res);
    // The old caller (loadStories) destructures exactly these two.
    const { claudeMd, storyBank } = res.body;
    assert.equal(claudeMd, '# Alex Doe');
    assert.equal(storyBank, '# Story Bank\n\n### A story\nBody.');
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

test('get-assets returns empty strings for a brand-new repo with no profile files', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock } = makeContentsMock({});
  await withFetch(fetchMock, async () => {
    const res = makeRes();
    await handler(getAssetsReq(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      claudeMd: '', storyBank: '', cvMd: '', bulletBankMd: '', articleDigestMd: '', profileYml: '',
    });
  });
});

test('get-assets degrades per file — one unreadable file does not blank the others', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock } = makeContentsMock({ ...ALL_FILES, 'bullet-bank.md': FAIL });
  await withFetch(fetchMock, async () => {
    const res = makeRes();
    await handler(getAssetsReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.bulletBankMd, '');
    assert.equal(res.body.claudeMd, '# Alex Doe');
    assert.equal(res.body.cvMd, '# Alex Doe — CV');
    assert.equal(res.body.profileYml, 'name: Alex Doe');
  });
});

test('get-assets returns partial profiles (cv.md present, bullet-bank.md missing)', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { fetchMock } = makeContentsMock({ 'CLAUDE.md': '# Alex Doe', 'cv.md': '# CV' });
  await withFetch(fetchMock, async () => {
    const res = makeRes();
    await handler(getAssetsReq(), res);
    assert.equal(res.body.claudeMd, '# Alex Doe');
    assert.equal(res.body.cvMd, '# CV');
    assert.equal(res.body.bulletBankMd, '');
    assert.equal(res.body.articleDigestMd, '');
    assert.equal(res.body.profileYml, '');
    assert.equal(res.body.storyBank, '');
  });
});
