// Tests for the typed GitHub write failure — lib/github.js GithubWriteError and
// the api/coach.js + api/memory.js handlers that translate it for the browser.
//
// THE BUG THIS COVERS. A user finished onboarding, pressed "Save to my repo",
// and got "Could not save your files. Please try again, or use the download
// buttons." — forever, on every retry. Four unrelated root causes (the token is
// read-only, the token is dead, the repo is invisible, the repo has no `main`)
// all arrived as that one sentence, and retrying could never fix any of them.
//
// So these tests are about MESSAGES as much as behaviour, in both directions:
//   • each cause must produce its own curated, actionable sentence, AND
//   • GitHub's raw response body must never reach the browser. A GitHub error
//     body can echo request content, so every response here is asserted against
//     a sentinel planted in the mock body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeGithubFile,
  getRepoInfo,
  GithubWriteError,
  RepoPublicError,
  classifyWriteFailure,
  isRateLimited,
  writeFailure,
  githubWriteErrorResponse,
} from '../lib/github.js';

// A body string no curated message could ever legitimately contain. If it shows
// up in an HTTP response, raw GitHub output is leaking to the user.
const SENTINEL = 'LEAKED-RAW-GITHUB-BODY-abc123';
const ghBody = (message) => JSON.stringify({ message, documentation_url: SENTINEL });

function res(status, body = '', headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() in lower ? lower[n.toLowerCase()] : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function withFetch(fn, run) {
  const real = global.fetch;
  global.fetch = fn;
  return run().finally(() => { global.fetch = real; });
}

// ── Rate limit vs. permissions refusal ────────────────────────────────────────
//
// Both arrive as 403. Telling a rate-limited user to reissue a perfectly good
// token is the wrong-advice failure worth avoiding, so the documented
// rate-limiting signals are checked first and win.

test('isRateLimited recognises a primary rate limit from x-ratelimit-remaining: 0', () => {
  assert.equal(isRateLimited(403, ghBody('API rate limit exceeded'), res(403, '', { 'x-ratelimit-remaining': '0' }).headers), true);
});

test('isRateLimited recognises a secondary rate limit from retry-after', () => {
  assert.equal(isRateLimited(403, ghBody('You have exceeded a secondary rate limit'), res(403, '', { 'retry-after': '60' }).headers), true);
});

test('isRateLimited treats 429 as a rate limit regardless of headers', () => {
  assert.equal(isRateLimited(429, '', undefined), true);
});

test('isRateLimited falls back to the body wording when headers are unavailable', () => {
  // Response doubles in the existing tests carry no `headers` at all. That must
  // read as "no signal", never throw.
  assert.equal(isRateLimited(403, ghBody('You have exceeded a secondary rate limit'), undefined), true);
  assert.equal(isRateLimited(403, ghBody('Resource not accessible by personal access token'), undefined), false);
  assert.equal(isRateLimited(403, '', { get: () => { throw new Error('no headers here'); } }), false);
});

test('a plain 403 with quota left is a PERMISSIONS refusal, not a rate limit', () => {
  const headers = res(403, '', { 'x-ratelimit-remaining': '4982' }).headers;
  assert.equal(isRateLimited(403, ghBody('Resource not accessible by personal access token'), headers), false);
  assert.equal(
    classifyWriteFailure('blob create', 403, ghBody('Resource not accessible by personal access token'), headers),
    'GH_WRITE_FORBIDDEN',
  );
});

// ── Status + step → code ──────────────────────────────────────────────────────

test('401 anywhere in the write chain is a dead token', () => {
  for (const step of ['repo get', 'ref get', 'commit get', 'blob create', 'tree create', 'commit create', 'ref patch']) {
    assert.equal(classifyWriteFailure(step, 401, ghBody('Bad credentials'), undefined), 'GH_TOKEN_INVALID', step);
  }
});

test('403 on any write step is a write-permission refusal', () => {
  for (const step of ['blob create', 'tree create', 'commit create', 'ref patch']) {
    assert.equal(classifyWriteFailure(step, 403, ghBody('Resource not accessible by personal access token'), undefined), 'GH_WRITE_FORBIDDEN', step);
  }
});

// ── A 403 on the REPO READ is not a write problem ─────────────────────────────
//
// `repo get` is GET /repos/{owner}/{repo} — the first call every guarded save
// makes, and a READ. GitHub answers 403 there when SAML/SSO has not been
// authorised for the token, when an org IP allow-list blocks the request, or when
// an org policy bans personal access tokens. All three are common on org-owned
// repos and none of them is "can read but can't write". Telling that user to set
// Contents: Read and write and redeploy is a confidently wrong cause: they do it,
// nothing changes, and the real reason stays invisible. The baseline here was a
// generic 500, which was at least honest.

test('a 403 on the REPO read never claims a write-permission problem', () => {
  const headers = res(403, '', { 'x-ratelimit-remaining': '4982' }).headers;
  const code = classifyWriteFailure('repo get', 403, ghBody('Resource protected by organization SAML enforcement'), headers);
  assert.notEqual(code, 'GH_WRITE_FORBIDDEN', 'the repo read has not tested write access at all');
  assert.equal(code, 'GH_REPO_UNREADABLE');
});

test('the unreadable-repo copy names SSO and does not assert one single cause', () => {
  const err = writeFailure('repo get', 403, ghBody('Resource protected by organization SAML enforcement'), undefined, 'd');
  assert.equal(err.code, 'GH_REPO_UNREADABLE');
  assert.match(err.userMessage, /read this repo/);
  assert.match(err.userMessage, /not about write permission/i);
  assert.match(err.fix, /SAML\/SSO/);
  assert.match(err.fix, /Configure SSO/);
  assert.match(err.fix, /IP allow-list/);
  // It must NOT hand out the read-only-token instruction, which is the wrong fix.
  assert.doesNotMatch(err.userMessage, /can read your repo but can't write/);
  assert.doesNotMatch(err.fix, /Contents: Read and write/);
});

test('a RATE LIMIT on the repo read still wins over the unreadable-repo cause', () => {
  // Both arrive as 403, and a rate limit is transient — sending that user off to
  // chase SSO settings would be the same class of mistake in a new place.
  const headers = res(403, '', { 'x-ratelimit-remaining': '0' }).headers;
  assert.equal(classifyWriteFailure('repo get', 403, ghBody('API rate limit exceeded'), headers), 'GH_RATE_LIMITED');
  assert.equal(classifyWriteFailure('repo get', 429, '', undefined), 'GH_RATE_LIMITED');
});

test('getRepoInfo surfaces an SSO-blocked repo as unreadable, and still fails CLOSED', async () => {
  await withFetch(async () => res(403, ghBody('Resource protected by organization SAML enforcement')), async () => {
    await assert.rejects(
      () => getRepoInfo('tok', 'acme', 'jobs'),
      (err) => err instanceof GithubWriteError
        && err.code === 'GH_REPO_UNREADABLE'
        && err.step === 'repo get',
    );
  });
});

test('an SSO-blocked save answers 403 with the unreadable-repo copy, not the read-only-token copy', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const mock = async (url) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return res(403, ghBody('Resource protected by organization SAML enforcement'), { 'x-ratelimit-remaining': '4900' });
    }
    throw new Error(`the save must stop at the repo read: ${url}`);
  };
  await withFetch(mock, async () => {
    const res_ = makeRes();
    await handler({
      method: 'POST', query: { action: 'save-onboarding' },
      headers: { 'x-dashboard-password': 'pw' }, body: { claudeMd: '# Alex Doe' },
    }, res_);
    assert.equal(res_.statusCode, 403);
    assert.equal(res_.body.code, 'GH_REPO_UNREADABLE');
    assert.match(res_.body.error, /Configure SSO/);
    assert.doesNotMatch(res_.body.error, /Contents: Read and write/);
    assert.ok(!JSON.stringify(res_.body).includes(SENTINEL));
  });
});

test('a 404 on the REF read is a missing branch, not a missing repo', () => {
  // writeGithubFile targets GITHUB_REF_NAME || 'main'. A repo whose default is
  // master has no `main`, so the ref read 404s and every save in the app fails.
  // Collapsing this into the repo-not-found message would send the user to check
  // GH_REPO, which is fine, and never mention the branch, which is not.
  assert.equal(classifyWriteFailure('ref get', 404, ghBody('Not Found'), undefined), 'GH_BRANCH_MISSING');
  assert.equal(classifyWriteFailure('ref patch', 404, ghBody('Not Found'), undefined), 'GH_BRANCH_MISSING');
});

test('a 404 on the REPO read is a wrong name or an invisible repo', () => {
  assert.equal(classifyWriteFailure('repo get', 404, ghBody('Not Found'), undefined), 'GH_REPO_NOT_FOUND');
});

test('a 404 elsewhere stays generic rather than guessing', () => {
  assert.equal(classifyWriteFailure('tree create', 404, ghBody('Not Found'), undefined), 'GH_NOT_FOUND');
});

test('422 on the ref PATCH is concurrency, 409 is concurrency anywhere, and 5xx is the unknown fallback', () => {
  assert.equal(classifyWriteFailure('ref patch', 422, '', undefined), 'GH_CONFLICT');
  assert.equal(classifyWriteFailure('ref patch', 409, '', undefined), 'GH_CONFLICT');
  // A 409 from any step genuinely is a conflict.
  for (const step of ['repo get', 'ref get', 'commit get', 'blob create', 'tree create', 'commit create']) {
    assert.equal(classifyWriteFailure(step, 409, '', undefined), 'GH_CONFLICT', step);
  }
  assert.equal(classifyWriteFailure('tree create', 500, '', undefined), 'GH_WRITE_FAILED');
  assert.equal(classifyWriteFailure('tree create', 502, '', undefined), 'GH_WRITE_FAILED');
});

// ── 422 means "HEAD moved" ONLY on the ref PATCH ──────────────────────────────
//
// POST /git/blobs, /git/trees and /git/commits answer 422 for genuine validation
// failures: a malformed path component, an oversized blob, a bad encoding. Those
// used to be reported as "Something else was writing to your repo at the same
// time… Nothing was lost. Try again in a moment." with HTTP 503 — a wrong cause
// plus false hope, on a write that will fail identically forever. The baseline
// gave a generic 500, which was at least honest.

test('a 422 from blob, tree or commit creation is NOT reported as a concurrency conflict', () => {
  for (const step of ['blob create', 'tree create', 'commit create']) {
    const code = classifyWriteFailure(step, 422, ghBody('path contains a malformed path component'), undefined);
    assert.notEqual(code, 'GH_CONFLICT', `${step} 422 is a validation failure, not a conflict`);
    assert.equal(code, 'GH_WRITE_FAILED', step);
  }
});

test('a 422 on a READ step is not a conflict either', () => {
  for (const step of ['repo get', 'ref get', 'commit get']) {
    assert.equal(classifyWriteFailure(step, 422, '', undefined), 'GH_WRITE_FAILED', step);
  }
});

test('a validation 422 promises no retry and answers 500, not 503', () => {
  const err = writeFailure('tree create', 422, ghBody('path contains a malformed path component'), undefined, 'd');
  assert.equal(err.code, 'GH_WRITE_FAILED');
  // The false hope that used to ship with this: it must be gone.
  assert.doesNotMatch(err.userMessage, /Nothing was lost/);
  assert.doesNotMatch(err.userMessage, /same time/);
  assert.doesNotMatch(err.fix, /Try again in a moment/);
  // 503 said "this is transient, come back later" about a permanent failure.
  assert.equal(githubWriteErrorResponse(err).status, 500);
});

test('a tree-create 422 reaches the browser as the generic refusal, end to end', async () => {
  await withFetch(chainFailingAt('tree create', 422, ghBody('path contains a malformed path component')), async () => {
    await assert.rejects(
      () => writeGithubFile('tok', 'acme', 'jobs', 'cv.md', 'body', 'msg', { maxAttempts: 1 }),
      (err) => err instanceof GithubWriteError
        && err.code === 'GH_WRITE_FAILED'
        && err.step === 'tree create',
    );
  });
});

// ── The error object ──────────────────────────────────────────────────────────

test('GithubWriteError keeps the raw detail on .message for the server log', () => {
  const err = writeFailure('blob create', 403, ghBody('Resource not accessible by personal access token'), undefined,
    `blob create failed: 403 — ${ghBody('Resource not accessible by personal access token')}`);
  assert.ok(err instanceof GithubWriteError);
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'GH_WRITE_FORBIDDEN');
  assert.equal(err.status, 403);
  assert.equal(err.step, 'blob create');
  // The detail is what the bare Errors carried, so existing console.error output
  // and any log scraping keep working unchanged.
  assert.match(err.message, /blob create failed: 403/);
  assert.ok(err.message.includes(SENTINEL), 'the server-side detail SHOULD keep the raw body');
  // ...and the curated copy is separate, and clean.
  assert.ok(!err.userMessage.includes(SENTINEL));
  assert.ok(!err.fix.includes(SENTINEL));
});

test('every code has curated user copy that names a setting and a place to change it', () => {
  const codes = ['GH_TOKEN_INVALID', 'GH_WRITE_FORBIDDEN', 'GH_RATE_LIMITED', 'GH_BRANCH_MISSING',
    'GH_REPO_NOT_FOUND', 'GH_REPO_UNREADABLE', 'GH_NOT_FOUND', 'GH_CONFLICT', 'GH_WRITE_FAILED'];
  const seen = new Set();
  for (const code of codes) {
    // Drive each code through a status/step that produces it.
    const byCode = {
      GH_TOKEN_INVALID: ['blob create', 401, '', undefined],
      GH_WRITE_FORBIDDEN: ['blob create', 403, ghBody('Resource not accessible by personal access token'), undefined],
      GH_RATE_LIMITED: ['blob create', 429, '', undefined],
      GH_BRANCH_MISSING: ['ref get', 404, '', undefined],
      GH_REPO_NOT_FOUND: ['repo get', 404, '', undefined],
      GH_REPO_UNREADABLE: ['repo get', 403, ghBody('Resource protected by organization SAML enforcement'), undefined],
      GH_NOT_FOUND: ['tree create', 404, '', undefined],
      GH_CONFLICT: ['ref patch', 422, '', undefined],
      GH_WRITE_FAILED: ['tree create', 500, '', undefined],
    };
    const err = writeFailure(...byCode[code], 'detail');
    assert.equal(err.code, code);
    assert.ok(err.userMessage.length > 30, `${code} needs a real sentence`);
    assert.ok(err.fix.length > 20, `${code} needs a real fix`);
    assert.ok(!seen.has(err.userMessage), `${code} must not reuse another code's message`);
    seen.add(err.userMessage);
  }
});

test("the read-only-token copy says retrying won't help and points at Contents: Read and write", () => {
  const err = writeFailure('blob create', 403, ghBody('Resource not accessible by personal access token'), undefined, 'd');
  assert.match(err.userMessage, /can read your repo but can't write/);
  assert.match(err.userMessage, /Retrying will not help/);
  assert.match(err.fix, /Contents: Read and write/);
  assert.match(err.fix, /Redeploy/);
  assert.match(err.fix, /download buttons/);
});

test('the missing-branch copy names main and says where to rename the default branch', () => {
  const err = writeFailure('ref get', 404, '', undefined, 'd');
  assert.match(err.userMessage, /branch called main/);
  assert.match(err.fix, /Default branch/);
  assert.match(err.fix, /master/);
});

// ── githubWriteErrorResponse ──────────────────────────────────────────────────

test('githubWriteErrorResponse ignores anything that is not a GithubWriteError', () => {
  assert.equal(githubWriteErrorResponse(new Error('boom')), null);
  assert.equal(githubWriteErrorResponse(new RepoPublicError('acme/jobs')), null);
  assert.equal(githubWriteErrorResponse(null), null);
  assert.equal(githubWriteErrorResponse(undefined), null);
});

test('githubWriteErrorResponse sends ONLY curated copy, never the raw body or status', () => {
  const err = writeFailure('blob create', 403, ghBody('Resource not accessible by personal access token'), undefined,
    `blob create failed: 403 — ${ghBody('Resource not accessible by personal access token')}`);
  const out = githubWriteErrorResponse(err);
  assert.equal(out.status, 403);
  assert.deepEqual(Object.keys(out.body).sort(), ['code', 'error', 'fix', 'message', 'userMessage']);
  assert.equal(out.body.code, 'GH_WRITE_FORBIDDEN');
  // `message` mirrors `error` because the Story Bank client reads data.message.
  assert.equal(out.body.message, out.body.error);
  // The cause and the steps are also sent apart, for the inline panel that
  // renders them as two parts; together they reconstruct the joined string.
  assert.equal(out.body.error, `${out.body.userMessage} ${out.body.fix}`);
  assert.ok(!out.body.userMessage.includes(out.body.fix), 'userMessage is the cause alone');
  const serialized = JSON.stringify(out.body);
  assert.ok(!serialized.includes(SENTINEL), 'raw GitHub body must never reach the browser');
  assert.ok(!serialized.includes('Resource not accessible'), 'GitHub wording must never reach the browser');
  assert.ok(!serialized.includes('blob create'), 'internal step names must never reach the browser');
});

test('githubWriteErrorResponse maps config faults to 403 and transient ones to 503', () => {
  const statusFor = (step, status, body) => githubWriteErrorResponse(writeFailure(step, status, body, undefined, 'd')).status;
  assert.equal(statusFor('blob create', 401, ''), 403);
  assert.equal(statusFor('blob create', 403, ghBody('Resource not accessible by personal access token')), 403);
  assert.equal(statusFor('blob create', 429, ''), 503);
  assert.equal(statusFor('ref patch', 422, ''), 503);
  // A missing branch and an invisible repo are caller configuration too — they
  // were left out of the status table by oversight and answered 500, which
  // contradicted the comment sitting right above them.
  assert.equal(statusFor('ref get', 404, ''), 403);
  assert.equal(statusFor('repo get', 404, ''), 403);
  assert.equal(statusFor('repo get', 403, ghBody('Resource protected by organization SAML enforcement')), 403);
  // Everything JobBud genuinely cannot name keeps the 500 these paths answered.
  assert.equal(statusFor('tree create', 500, ''), 500);
  assert.equal(statusFor('tree create', 422, ''), 500);
  assert.equal(statusFor('tree create', 404, ''), 500);
});

test('every code that names a setting the user must change answers 403, not 500', () => {
  // The rule the table encodes: if the fix is in GitHub or Vercel, it is the
  // caller's configuration and the status should say so.
  const configFaults = {
    GH_TOKEN_INVALID: ['blob create', 401, ''],
    GH_WRITE_FORBIDDEN: ['blob create', 403, ghBody('Resource not accessible by personal access token')],
    GH_REPO_UNREADABLE: ['repo get', 403, ghBody('Resource protected by organization SAML enforcement')],
    GH_REPO_NOT_FOUND: ['repo get', 404, ''],
    GH_BRANCH_MISSING: ['ref get', 404, ''],
  };
  for (const [code, args] of Object.entries(configFaults)) {
    const out = githubWriteErrorResponse(writeFailure(...args, undefined, 'd'));
    assert.equal(out.body.code, code);
    assert.equal(out.status, 403, `${code} is a configuration fault and must answer 403`);
  }
});

// ── Thrown from every failure point in writeGithubFile ────────────────────────

// Serve a healthy write chain, then fail exactly one step with `status`.
function chainFailingAt(failStep, status, body = ghBody('Resource not accessible by personal access token')) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const fail = (step) => (step === failStep ? res(status, body) : null);
    if (url.includes('/contents/')) {
      return res(200, JSON.stringify({ content: Buffer.from('x', 'utf8').toString('base64'), sha: 's' }));
    }
    if (url.endsWith('/git/blobs') && method === 'POST') return fail('blob create') || res(200, JSON.stringify({ sha: 'b1' }));
    if (url.includes('/git/ref/heads/')) return fail('ref get') || res(200, JSON.stringify({ object: { sha: 'c0' } }));
    if (url.includes('/git/commits/')) return fail('commit get') || res(200, JSON.stringify({ tree: { sha: 't0' } }));
    if (url.endsWith('/git/trees') && method === 'POST') return fail('tree create') || res(200, JSON.stringify({ sha: 't1' }));
    if (url.endsWith('/git/commits') && method === 'POST') return fail('commit create') || res(200, JSON.stringify({ sha: 'c1' }));
    if (url.includes('/git/refs/heads/')) return fail('ref patch') || res(200, JSON.stringify({ object: { sha: 'c1' } }));
    return res(500, 'unexpected');
  };
}

test('every failure point in writeGithubFile throws the typed error', async () => {
  for (const step of ['blob create', 'ref get', 'commit get', 'tree create', 'commit create', 'ref patch']) {
    await withFetch(chainFailingAt(step, 403), async () => {
      await assert.rejects(
        () => writeGithubFile('tok', 'acme', 'jobs', 'cv.md', 'body', 'msg', { maxAttempts: 1 }),
        (err) => {
          assert.ok(err instanceof GithubWriteError, `${step} threw ${err.name}, not GithubWriteError`);
          assert.equal(err.code, 'GH_WRITE_FORBIDDEN', step);
          assert.equal(err.step, step);
          return true;
        },
        step,
      );
    });
  }
});

test('a 404 on the ref read surfaces as the missing-branch error end to end', async () => {
  await withFetch(chainFailingAt('ref get', 404, ghBody('Not Found')), async () => {
    await assert.rejects(
      () => writeGithubFile('tok', 'acme', 'jobs', 'cv.md', 'body', 'msg', { maxAttempts: 1 }),
      (err) => err.code === 'GH_BRANCH_MISSING' && /branch called main/.test(err.userMessage),
    );
  });
});

test('getRepoInfo throws the typed repo-not-found error and still fails CLOSED', async () => {
  await withFetch(async () => res(404, ghBody('Not Found')), async () => {
    await assert.rejects(
      () => getRepoInfo('tok', 'acme', 'gone'),
      (err) => err instanceof GithubWriteError && err.code === 'GH_REPO_NOT_FOUND' && err.step === 'repo get',
    );
  });
});

test('the 422 fast-forward retry still works and is NOT reported as an error', async () => {
  // The blob→tree→commit→ref algorithm must be untouched: 422 means HEAD moved
  // and is the loop's signal to rebase, not a failure.
  let patches = 0;
  const fetchMock = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url.endsWith('/git/blobs') && method === 'POST') return res(200, JSON.stringify({ sha: 'b1' }));
    if (url.includes('/git/ref/heads/')) return res(200, JSON.stringify({ object: { sha: `c${patches}` } }));
    if (url.includes('/git/commits/')) return res(200, JSON.stringify({ tree: { sha: `t${patches}` } }));
    if (url.endsWith('/git/trees') && method === 'POST') return res(200, JSON.stringify({ sha: `new-t${patches}` }));
    if (url.endsWith('/git/commits') && method === 'POST') return res(200, JSON.stringify({ sha: 'c-new' }));
    if (url.includes('/git/refs/heads/')) {
      patches++;
      return patches === 1 ? res(422, 'ref moved') : res(200, JSON.stringify({ object: { sha: 'c-new' } }));
    }
    return res(500, 'unexpected');
  };
  await withFetch(fetchMock, async () => {
    const sha = await writeGithubFile('tok', 'acme', 'jobs', 'cv.md', 'body', 'msg', { maxAttempts: 3 });
    assert.equal(sha, 'c-new');
    assert.equal(patches, 2, 'the first 422 must be retried, not thrown');
  });
});

test('422 that outlives maxAttempts becomes the concurrency error, not a generic one', async () => {
  await withFetch(chainFailingAt('ref patch', 422, 'ref moved'), async () => {
    await assert.rejects(
      () => writeGithubFile('tok', 'acme', 'jobs', 'cv.md', 'body', 'msg', { maxAttempts: 1 }),
      (err) => err instanceof GithubWriteError && err.code === 'GH_CONFLICT',
    );
  });
});

// ── The API handlers ──────────────────────────────────────────────────────────

const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(obj) { this.body = obj; return this; },
});

function baseEnv() {
  process.env.DASHBOARD_PASSWORD = 'pw';
  process.env.GH_TOKEN = 'tok';
  process.env.GH_REPO = 'acme/jobs';
  process.env.ANTHROPIC_API_KEY = 'k';
}

// Private repo (so the visibility guard passes), then a 403 on the blob create —
// i.e. exactly the reported bug: a token that can read but not write.
function readOnlyTokenMock({ storyContent = null } = {}) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return res(200, JSON.stringify({
        private: true, full_name: 'acme/jobs', default_branch: 'main',
        permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
      }));
    }
    if (url.includes('/contents/')) {
      if (storyContent === null) return res(404, ghBody('Not Found'));
      return res(200, JSON.stringify({ content: Buffer.from(storyContent, 'utf8').toString('base64'), sha: 's' }));
    }
    if (url.endsWith('/git/blobs') && method === 'POST') {
      return res(403, ghBody('Resource not accessible by personal access token'), { 'x-ratelimit-remaining': '4900' });
    }
    if (url.includes('/git/ref/heads/')) return res(200, JSON.stringify({ object: { sha: 'c0' } }));
    if (url.includes('/git/commits/')) return res(200, JSON.stringify({ tree: { sha: 't0' } }));
    return res(500, 'unexpected');
  };
}

test('save-onboarding names the read-only token instead of "please try again"', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  await withFetch(readOnlyTokenMock(), async () => {
    const res_ = makeRes();
    await handler({
      method: 'POST',
      query: { action: 'save-onboarding' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { claudeMd: '# Alex Doe' },
    }, res_);
    assert.equal(res_.statusCode, 403);
    assert.equal(res_.body.code, 'GH_WRITE_FORBIDDEN');
    assert.match(res_.body.error, /can read your repo but can't write/);
    assert.match(res_.body.error, /Contents: Read and write/);
    // The sentence it replaces must be gone.
    assert.doesNotMatch(res_.body.error, /Please try again/);
    assert.ok(!JSON.stringify(res_.body).includes(SENTINEL));
  });
});

test('save-memory names the read-only token instead of "Something went wrong"', async () => {
  baseEnv();
  const { default: handler } = await import('../api/memory.js');
  await withFetch(readOnlyTokenMock(), async () => {
    const res_ = makeRes();
    await handler({
      method: 'POST',
      query: { action: 'save-memory' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { file: 'profile', content: 'I want ops roles.' },
    }, res_);
    assert.equal(res_.statusCode, 403);
    assert.equal(res_.body.code, 'GH_WRITE_FORBIDDEN');
    assert.doesNotMatch(res_.body.error, /Something went wrong/);
    assert.ok(!JSON.stringify(res_.body).includes(SENTINEL));
  });
});

test('save-story sends the curated sentence on BOTH error and message', async () => {
  // The Story Bank client reads data.message; everything else reads data.error.
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  await withFetch(readOnlyTokenMock(), async () => {
    const res_ = makeRes();
    await handler({
      method: 'POST',
      query: { action: 'save-story' },
      headers: { 'x-dashboard-password': 'pw' },
      body: { storyMarkdown: '### A story\nBody.' },
    }, res_);
    assert.equal(res_.statusCode, 403);
    assert.match(res_.body.message, /can read your repo but can't write/);
    assert.equal(res_.body.message, res_.body.error);
  });
});

test('update-story and delete-story translate it too', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const stories = '# Story Bank\n\n### A story\nBody.\n';
  for (const [action, body] of [
    ['update-story', { storyId: 'A story', content: '### A story\nRevised.' }],
    ['delete-story', { storyId: 'A story' }],
  ]) {
    await withFetch(readOnlyTokenMock({ storyContent: stories }), async () => {
      const res_ = makeRes();
      await handler({ method: 'POST', query: { action }, headers: { 'x-dashboard-password': 'pw' }, body }, res_);
      assert.equal(res_.body.code, 'GH_WRITE_FORBIDDEN', action);
      assert.match(res_.body.error, /can't write/, action);
    });
  }
});

test('a dead token reads as a dead token, not as a permissions problem', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const mock = async (url, opts = {}) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return res(200, JSON.stringify({ private: true, full_name: 'acme/jobs' }));
    if (url.includes('/contents/')) return res(404, ghBody('Not Found'));
    if ((opts.method || 'GET') === 'POST') return res(401, ghBody('Bad credentials'));
    if (url.includes('/git/ref/heads/')) return res(200, JSON.stringify({ object: { sha: 'c0' } }));
    if (url.includes('/git/commits/')) return res(200, JSON.stringify({ tree: { sha: 't0' } }));
    return res(500, 'unexpected');
  };
  await withFetch(mock, async () => {
    const res_ = makeRes();
    await handler({
      method: 'POST', query: { action: 'save-onboarding' },
      headers: { 'x-dashboard-password': 'pw' }, body: { claudeMd: '# Alex Doe' },
    }, res_);
    assert.equal(res_.body.code, 'GH_TOKEN_INVALID');
    assert.match(res_.body.error, /invalid or expired/);
  });
});

test('a repo with no main branch says so, rather than blaming the token', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const mock = async (url, opts = {}) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return res(200, JSON.stringify({ private: true, full_name: 'acme/jobs', default_branch: 'master' }));
    }
    if (url.includes('/contents/')) return res(404, ghBody('Not Found'));
    if (url.endsWith('/git/blobs') && (opts.method || 'GET') === 'POST') return res(200, JSON.stringify({ sha: 'b1' }));
    if (url.includes('/git/ref/heads/')) return res(404, ghBody('Not Found'));
    return res(500, 'unexpected');
  };
  await withFetch(mock, async () => {
    const res_ = makeRes();
    await handler({
      method: 'POST', query: { action: 'save-onboarding' },
      headers: { 'x-dashboard-password': 'pw' }, body: { claudeMd: '# Alex Doe' },
    }, res_);
    assert.equal(res_.body.code, 'GH_BRANCH_MISSING');
    assert.match(res_.body.error, /branch called main/);
    assert.doesNotMatch(res_.body.error, /token/i);
  });
});

test('a rate-limited save says to wait, not to reissue the token', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const mock = async (url, opts = {}) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return res(200, JSON.stringify({ private: true, full_name: 'acme/jobs' }));
    if (url.includes('/contents/')) return res(404, ghBody('Not Found'));
    if (url.endsWith('/git/blobs') && (opts.method || 'GET') === 'POST') {
      return res(403, ghBody('API rate limit exceeded'), { 'x-ratelimit-remaining': '0' });
    }
    if (url.includes('/git/ref/heads/')) return res(200, JSON.stringify({ object: { sha: 'c0' } }));
    if (url.includes('/git/commits/')) return res(200, JSON.stringify({ tree: { sha: 't0' } }));
    return res(500, 'unexpected');
  };
  await withFetch(mock, async () => {
    const res_ = makeRes();
    await handler({
      method: 'POST', query: { action: 'save-onboarding' },
      headers: { 'x-dashboard-password': 'pw' }, body: { claudeMd: '# Alex Doe' },
    }, res_);
    assert.equal(res_.statusCode, 503);
    assert.equal(res_.body.code, 'GH_RATE_LIMITED');
    assert.match(res_.body.error, /Wait a few minutes/);
    assert.doesNotMatch(res_.body.error, /Contents: Read and write/);
  });
});

// ── The public-repo refusal is UNCHANGED ──────────────────────────────────────
//
// This behaviour is load-bearing (personal files must never land in a public
// repo) and its response shape is relied on elsewhere. Pinned here so the new
// translation layer cannot quietly take it over: RepoPublicError is deliberately
// NOT a GithubWriteError, and githubWriteErrorResponse returns null for it.

test('a PUBLIC repo still answers 403 with code REPO_PUBLIC and the original message', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const mock = async (url) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return res(200, JSON.stringify({ private: false, full_name: 'acme/jobs' }));
    throw new Error(`nothing else may be called: ${url}`);
  };
  await withFetch(mock, async () => {
    const res_ = makeRes();
    await handler({
      method: 'POST', query: { action: 'save-onboarding' },
      headers: { 'x-dashboard-password': 'pw' }, body: { claudeMd: '# Alex Doe' },
    }, res_);
    assert.equal(res_.statusCode, 403);
    assert.equal(res_.body.code, 'REPO_PUBLIC');
    assert.match(res_.body.error, /is public/);
    assert.match(res_.body.error, /make the repo private/);
    // Exactly the two keys it has always carried — no new fields, no translation.
    assert.deepEqual(Object.keys(res_.body).sort(), ['code', 'error']);
  });
});

test('RepoPublicError is not a GithubWriteError and is never translated', () => {
  const err = new RepoPublicError('acme/jobs');
  assert.ok(!(err instanceof GithubWriteError));
  assert.equal(err.code, 'REPO_PUBLIC');
  assert.equal(githubWriteErrorResponse(err), null);
});
