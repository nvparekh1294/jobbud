// Shared GitHub read/write helpers.
//
// The GitHub file-read (with the >1 MB download_url fallback) and the multi-step
// Git Data API file-write were copy-pasted ~9 times across api/*.js and the
// scanner. This module is the single implementation. It is based on the two
// queue-*.js endpoints, which were the only copies that already retried safely
// when another commit landed on main during the write.
//
// IMPORTANT: this is a plain imported module, NOT an API route. Vercel bundles
// each api/*.js function separately and inlines whatever it imports, so every
// endpoint that imports from here gets its own bundled copy — exactly what we
// want. Do not turn this into a request handler.

const GITHUB_API = 'https://api.github.com';

// Bounded retry for READ fetches. GitHub occasionally answers a read with a
// transient 5xx (a 502 with an HTML error page) or drops the connection; today one
// such 502 on the builder's read threw straight through writeGithubFile to a
// user-visible 500 on a dashboard click. Retry twice with ~500ms / ~1500ms backoff
// on 5xx responses and network errors. A 404 (and every other 4xx) returns
// immediately — those are not transient. Returns the final Response; the caller
// still inspects res.ok / res.status exactly as before.
async function fetchReadWithRetry(url, opts, { retries = 2, backoffs = [500, 1500] } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 && res.status <= 599 && attempt < retries) {
        console.warn(`[github] read ${res.status} on ${url} (attempt ${attempt + 1}/${retries + 1}) — retrying`);
        await new Promise(r => setTimeout(r, backoffs[attempt] ?? 1500));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.warn(`[github] read network error on ${url} (attempt ${attempt + 1}/${retries + 1}): ${err.message} — retrying`);
        await new Promise(r => setTimeout(r, backoffs[attempt] ?? 1500));
        continue;
      }
      throw lastErr;
    }
  }
  // Unreachable in practice (loop returns or throws), but keeps the type honest.
  throw lastErr ?? new Error(`read failed: ${url}`);
}

// ── Read ──────────────────────────────────────────────────────────────────────

// Read a repo file via the Contents API, scoped to a branch. GitHub Actions sets
// GITHUB_REF_NAME to the run's branch, so a scan on plan/reliability-batch reads
// (and, via writeGithubFile, writes) THAT branch instead of the default branch.
// Without the ref, the Contents API always returns the default branch — the
// read/write split-brain bug on feature-branch runs (builder-retry re-reads,
// persistJobs' pre-read, and commitState's changed-check all read main while the
// write lands on the branch). Vercel does not set GITHUB_REF_NAME, so API routes
// fall back to 'main' exactly as before. Overridable via the `branch` option.
//
// GitHub returns content:"" with encoding:"none" for files larger than ~1 MB and
// only exposes the blob via metadata. Its download_url points at
// raw.githubusercontent.com, whose path (/{owner}/{repo}/{ref}/{path}) is
// AMBIGUOUS for slash-containing branch names like plan/reliability-batch. The
// ref-scoped metadata response carries the exact blob sha, so we fetch the blob by
// sha via the Git Data API — unambiguous and guaranteed to be the branch's version
// (job-status.json is ~6 MB, so this fallback runs on every real read of it).
//
// Returns { exists, content } where content is the raw file text (utf8).
// A 404 resolves to { exists: false, content: null }. Any other non-OK response
// throws — callers that want a soft default should use readGithubText().
export async function readGithubFile(
  githubToken, owner, repo, filePath,
  { branch = process.env.GITHUB_REF_NAME || 'main' } = {},
) {
  const authHeaders = { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' };
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetchReadWithRetry(url, { headers: authHeaders });
  if (res.status === 404) return { exists: false, content: null };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub GET ${filePath}@${branch} failed: ${res.status} — ${body.slice(0, 200)}`);
  }
  const data = await res.json();

  if (data.content) {
    return { exists: true, content: Buffer.from(data.content, 'base64').toString('utf8') };
  }
  // Large-file fallback: fetch the blob by the sha from the ref-scoped metadata,
  // via the Git Data API (supports blobs up to 100 MB). This keeps the read pinned
  // to the branch without depending on download_url's ambiguous raw-host path.
  if (data.sha) {
    const blobRes = await fetchReadWithRetry(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${data.sha}`, {
      headers: authHeaders,
    });
    if (!blobRes.ok) {
      const body = await blobRes.text().catch(() => '');
      throw new Error(`GitHub blob fetch for ${filePath}@${branch} (${data.sha}) failed: ${blobRes.status} — ${body.slice(0, 200)}`);
    }
    const blob = await blobRes.json();
    const content = blob.encoding === 'base64'
      ? Buffer.from(blob.content, 'base64').toString('utf8')
      : blob.content;
    return { exists: true, content };
  }
  throw new Error(`GitHub Contents API returned neither content nor sha for ${filePath}@${branch}`);
}

// Soft read: returns the file text, or '' if the file is missing OR the read
// fails for any reason. For optional files (CLAUDE.md, story-bank.md, radar.json)
// where a read failure should degrade gracefully rather than throw. Takes the same
// branch option as readGithubFile.
export async function readGithubText(
  githubToken, owner, repo, filePath,
  { branch = process.env.GITHUB_REF_NAME || 'main' } = {},
) {
  try {
    const { exists, content } = await readGithubFile(githubToken, owner, repo, filePath, { branch });
    return exists ? content : '';
  } catch (err) {
    console.warn(`[github] soft read ${filePath} failed: ${err.message}`);
    return '';
  }
}

// ── Seed-shape normalization ───────────────────────────────────────────────────
//
// Several files in data/ ship as the empty ARRAY `[]` while the code that reads
// them models an OBJECT document — job-status.json is { jobs: {} }, radar.json is
// { companies: {} }, mock-sessions.json is { sessions: [] }. CONTRIBUTING.md
// freezes those committed seeds (every deployed copy writes real data to the same
// paths, so an upstream edit lands as a merge conflict for every active user at
// once), and it explicitly says a shape change must be migrated in application
// code at read time. This is that migration.
//
// It matters because the naive `if (!doc.jobs) doc.jobs = {}` patch is silently
// destructive: assigning a named property to an ARRAY works in memory, but
// JSON.stringify serializes arrays by index and drops it. The write then
// re-serializes to the same `[]` it started from, GitHub turns the byte-identical
// blob into an empty commit, the endpoint reports success — and the data is gone
// on the next read. That is the radar.json bug, and job-status.json and
// mock-sessions.json had it on their fresh-install paths too.
//
// `emptyDoc` is the empty document for the file, e.g. { jobs: {} } or
// { sessions: [] }. Anything that is not a plain object is discarded outright for
// a fresh clone of emptyDoc — never patched in place. Each expected key is then
// checked against the container type emptyDoc declares (array vs object) and
// replaced if it disagrees. Unknown keys on a well-formed document are preserved.
export function normalizeJsonDoc(parsed, emptyDoc) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return structuredClone(emptyDoc);
  }
  for (const [key, empty] of Object.entries(emptyDoc)) {
    const current = parsed[key];
    const ok = Array.isArray(empty)
      ? Array.isArray(current)
      : (current !== null && typeof current === 'object' && !Array.isArray(current));
    if (!ok) parsed[key] = structuredClone(empty);
  }
  return parsed;
}

// ── Repo visibility guard ──────────────────────────────────────────────────────
//
// Personal files (CLAUDE.md, cv.md, bullet-bank.md, article-digest.md,
// config/profile.yml, story-bank.md) contain the user's real name, background,
// and stories. They must NEVER be committed to a PUBLIC repo, where they would be
// world-readable. Any write path that publishes personal content calls
// assertRepoPrivate() first; it fails CLOSED — if visibility cannot be
// determined, it throws rather than assuming private.

// Thrown when the target repo is public. Carries a stable `code` so API handlers
// can translate it into a clear, non-retryable refusal.
export class RepoPublicError extends Error {
  constructor(fullName) {
    super(`Repository ${fullName} is public. Personal files must not be committed to a public repository — make the repo private (or use the download buttons) and try again.`);
    this.name = 'RepoPublicError';
    this.code = 'REPO_PUBLIC';
  }
}

// Fetch minimal repo metadata. Returns { private, fullName, permissions,
// defaultBranch }. Throws on any non-OK response (404, 403, 5xx) so an unknown
// repo is never treated as private.
//
// `permissions` is GitHub's own `{ admin, maintain, push, triage, pull }` object,
// which describes what the AUTHENTICATED TOKEN can do with this repo — passed
// through verbatim, or null when GitHub omitted it (it is only present on an
// authenticated request). It is the one signal available for answering "can this
// token write?" WITHOUT performing a write, which is why this call returns it
// instead of discarding it: api/health.js's github:write check reads it, and
// would otherwise have to repeat this exact GET. Never surface it to a browser
// raw — it is API metadata, and the health check turns it into curated prose.
export async function getRepoInfo(githubToken, owner, repo) {
  const res = await fetchReadWithRetry(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Still fails CLOSED — this throws exactly as before, so an undetermined
    // visibility can never be mistaken for private. It is only TYPED now, so the
    // "GH_REPO is wrong / the token can't see the repo" cause reaches the user
    // instead of becoming a generic 500. This is the first call every guarded
    // save makes, so it is where that cause usually surfaces.
    //
    // Both of this call's refusals are READ refusals and classifyWriteFailure
    // keeps them that way: 404 → GH_REPO_NOT_FOUND (wrong name, or outside a
    // fine-grained token's repository list), 403 → GH_REPO_UNREADABLE (SSO,
    // org IP allow-list, org PAT policy). Neither may report a write-permission
    // problem, because nothing about write permission has been tested yet.
    throw writeFailure(
      'repo get', res.status, body, res.headers,
      `GitHub GET repo ${owner}/${repo} failed: ${res.status} — ${body.slice(0, 200)}`,
    );
  }
  const data = await res.json();
  return {
    private: data.private === true,
    fullName: data.full_name || `${owner}/${repo}`,
    permissions: (data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions))
      ? data.permissions
      : null,
    defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : null,
  };
}

// Guard for personal-file writes. Throws RepoPublicError when the target repo is
// public, and rethrows any lookup error (fail closed — never write on an
// undetermined visibility). Returns the repo info when it is safe to proceed.
export async function assertRepoPrivate(githubToken, owner, repo) {
  const info = await getRepoInfo(githubToken, owner, repo);
  if (!info.private) throw new RepoPublicError(info.fullName);
  return info;
}

// ── Write failures, translated ────────────────────────────────────────────────
//
// WHY THIS EXISTS. Every failure point in writeGithubFile used to throw a bare
// Error with GitHub's raw response body interpolated into the message
// (`blob create failed: 403 — {"message":"Resource not accessible by personal
// access token",...}`). Every consumer caught that, logged it, and answered the
// browser with one unactionable generic string — api/coach.js's
// "Could not save your files. Please try again, or use the download buttons."
// forever, on every retry, with no way to learn that retrying could never work.
// Four different root causes (token invalid, token read-only, repo invisible,
// wrong default branch) all collapsed into that one sentence.
//
// So the failure points now throw a TYPED error carrying a stable `code` plus a
// curated `userMessage` and `fix` that API handlers can hand straight to the
// browser.
//
// SECURITY, non-negotiable: `userMessage` and `fix` are strings written HERE.
// GitHub's response body, the token, and response headers never appear in them —
// a GitHub error body can echo request content, and nothing from the wire is
// safe to render. The raw detail still goes into the Error's own `message`, which
// is exactly the text the old bare Error carried, so every existing
// server-side console.error keeps logging the same detail it always did.

// Thrown by every failure point in the Git Data API write path. Mirrors
// RepoPublicError: a stable `code` for handlers to switch on, and prose fit to
// show a non-technical user.
export class GithubWriteError extends Error {
  constructor({ code, status, step, detail, userMessage, fix }) {
    // `detail` is the server-side sentence, raw body included — unchanged from
    // the bare Errors this replaces, so logs and log-scraping keep working.
    super(detail);
    this.name = 'GithubWriteError';
    this.code = code;                 // stable, e.g. 'GH_WRITE_FORBIDDEN'
    this.status = status ?? null;      // the HTTP status GitHub answered
    this.step = step ?? null;          // which call failed, e.g. 'blob create'
    this.userMessage = userMessage;    // curated — safe to send to a browser
    this.fix = fix || '';              // curated — safe to send to a browser
  }
}

// The canned copy, in one place so the wording is reviewable together. Each
// entry is plain English, names the exact setting, and says where to change it —
// the house style of api/health.js.
const WRITE_FAILURES = {
  GH_TOKEN_INVALID: {
    userMessage: 'GitHub rejected your access token: it is invalid or expired, so nothing could be saved.',
    fix: 'Create a new GitHub token with write access to your JobBud repo, paste it into GH_TOKEN in Vercel → Settings → Environment Variables, tick Production, and Redeploy.',
  },
  GH_WRITE_FORBIDDEN: {
    userMessage: "Your GitHub token can read your repo but can't write to it, so nothing could be saved. Retrying will not help until the token's permissions change.",
    fix: 'In GitHub → Settings → Developer settings → your token, give it **Contents: Read and write** for your jobbud repo (or use a classic token with the `repo` scope). Then update GH_TOKEN in Vercel → Settings → Environment Variables, tick Production, and Redeploy. Meanwhile the download buttons still work.',
  },
  GH_RATE_LIMITED: {
    userMessage: 'GitHub is temporarily rate-limiting this token, so the save was refused. Nothing is wrong with your setup.',
    fix: 'Wait a few minutes and try again. If it keeps happening, use the download buttons and save the files by hand.',
  },
  GH_BRANCH_MISSING: {
    userMessage: "JobBud writes to a branch called main, and your repo doesn't have one, so there was nowhere to save to.",
    fix: 'On GitHub, open your jobbud repo → Settings → General → Default branch and rename the default branch to main. (If you forked or created the repo with a different default, such as master, this is the fix.)',
  },
  GH_REPO_NOT_FOUND: {
    userMessage: "JobBud could not find the repo it is configured to save to — either the name is wrong, or this token can't see it.",
    fix: 'Check GH_REPO in Vercel → Settings → Environment Variables reads exactly yourname/your-repo, and that the token\'s repository access list includes that repo. Fix it, then Redeploy.',
  },
  // A 403 on `GET /repos/{owner}/{repo}` — the FIRST call every guarded save
  // makes — is a READ refusal, not a write-permission one: the token cannot see
  // the repo at all. GH_WRITE_FORBIDDEN used to claim this slot, which told the
  // user to set Contents: Read and write and redeploy; they would, nothing would
  // change, and the real cause stayed invisible. So this code deliberately lists
  // the possibilities instead of asserting one — a confidently wrong cause is
  // worse than an honest menu. SSO authorization leads because it is both the
  // most common cause on org-owned repos and the easiest to fix.
  GH_REPO_UNREADABLE: {
    userMessage: "GitHub refused to let your token read this repo at all, so nothing could be saved. This is not about write permission — something is blocking the token's access to the repo itself.",
    fix: 'The usual causes, most common first: (1) the repo belongs to an organisation that requires SAML/SSO and this token has not been authorised for it — open GitHub → Settings → Developer settings → your token and use "Configure SSO" to authorise that organisation; (2) the organisation has an IP allow-list that does not include the servers JobBud runs on, which an organisation owner has to widen; (3) an organisation policy blocks personal access tokens, which an organisation owner has to approve. After fixing it, Redeploy in Vercel. The download buttons still work meanwhile.',
  },
  GH_NOT_FOUND: {
    userMessage: 'GitHub could not find part of your repo that JobBud needed in order to save, so nothing was written.',
    fix: 'Open the ⚙ Setup Check in the dashboard header — it names the exact problem. If everything there passes, try again in a minute.',
  },
  GH_CONFLICT: {
    userMessage: 'Something else was writing to your repo at the same time, and JobBud gave up rather than overwrite it. Nothing was lost.',
    fix: 'Try again in a moment. If a scan is running, let it finish first.',
  },
  GH_WRITE_FAILED: {
    userMessage: 'GitHub refused the save and did not say why, so nothing was written.',
    fix: 'Open the ⚙ Setup Check in the dashboard header to see whether your token and repo are set up correctly, and try again in a minute. The download buttons still work.',
  },
};

// Did GitHub refuse this because of a rate limit rather than permissions? Both
// arrive as 403 (or 429), and sending a rate-limited user off to reissue a
// perfectly good token is the mistake worth avoiding — so the signals GitHub
// documents for rate limiting are checked FIRST, and only a 403 that shows none
// of them is read as a permissions refusal.
//
// Primary limit: x-ratelimit-remaining: 0. Secondary limit: a retry-after header
// and/or a body that says so. 429 is always a rate limit. Headers are read
// defensively — a Response-like object without a usable `headers` is normal in
// tests and must not throw.
export function isRateLimited(status, body, headers) {
  if (status === 429) return true;
  const get = (name) => {
    try { return headers && typeof headers.get === 'function' ? headers.get(name) : null; }
    catch (_) { return null; }
  };
  if (String(get('x-ratelimit-remaining') ?? '').trim() === '0') return true;
  if (get('retry-after')) return true;
  return /rate limit|abuse detection|too many requests/i.test(String(body || ''));
}

// Classify a non-OK write response into one of the codes above. Pure, so every
// branch is unit-tested directly.
//
// `step` is the call that failed — one of: 'repo get', 'ref get', 'commit get',
// 'blob create', 'tree create', 'commit create', 'ref patch'. It is what makes a
// 404 answerable: a 404 on `ref get` means the BRANCH is missing (the repo was
// reachable a moment earlier), while a 404 on `repo get` means the repo itself is
// not visible to this token. Collapsing those two would send half the affected
// users to rename a branch that is fine.
export function classifyWriteFailure(step, status, body, headers) {
  if (status === 401) return 'GH_TOKEN_INVALID';
  if (status === 403 || status === 429) {
    if (isRateLimited(status, body, headers)) return 'GH_RATE_LIMITED';
    // `repo get` is a READ. A 403 there means the token cannot see the repo
    // (SAML/SSO not authorised, an org IP allow-list, an org PAT policy) — not
    // that it can read but not write. Claiming the write-permission cause here
    // sent org users to change Contents: Read and write, which changes nothing.
    if (step === 'repo get') return 'GH_REPO_UNREADABLE';
    return 'GH_WRITE_FORBIDDEN';
  }
  if (status === 404) {
    if (step === 'ref get' || step === 'ref patch') return 'GH_BRANCH_MISSING';
    if (step === 'repo get') return 'GH_REPO_NOT_FOUND';
    return 'GH_NOT_FOUND';
  }
  // 409 is a conflict wherever it comes from. 422 is a conflict ONLY on
  // `ref patch`, where it is GitHub's "the ref you based this on has moved" —
  // the signal the retry loop in writeGithubFile rebases on, and a real
  // concurrency answer once the attempts run out.
  //
  // POST /git/blobs, /git/trees and /git/commits also answer 422, but for
  // genuine validation failures: a malformed path component, an oversized blob,
  // a bad encoding. Those used to be reported as "Something else was writing to
  // your repo at the same time… Nothing was lost. Try again in a moment." with
  // HTTP 503 — a wrong cause plus false hope, on a write that will fail
  // identically forever. They fall through to GH_WRITE_FAILED, which says
  // GitHub refused and did not say why: the honest answer, and the baseline's.
  if (status === 409) return 'GH_CONFLICT';
  if (status === 422 && step === 'ref patch') return 'GH_CONFLICT';
  return 'GH_WRITE_FAILED';
}

// Build the typed error for a failed write call. `detail` is the server-side
// sentence and is the ONLY place the raw body appears.
export function writeFailure(step, status, body, headers, detail) {
  const code = classifyWriteFailure(step, status, body, headers);
  const { userMessage, fix } = WRITE_FAILURES[code] || WRITE_FAILURES.GH_WRITE_FAILED;
  return new GithubWriteError({ code, status, step, detail, userMessage, fix });
}

// The HTTP status an API handler should answer for each code. A token or
// permission problem is the caller's configuration, not a server fault, so it is
// 403; the two genuinely transient ones are 503, which says "try later" honestly;
// everything else keeps the 500 these paths answered before.
const WRITE_HTTP_STATUS = {
  GH_TOKEN_INVALID: 403,
  GH_WRITE_FORBIDDEN: 403,
  GH_REPO_UNREADABLE: 403,
  GH_RATE_LIMITED: 503,
  GH_CONFLICT: 503,
};

// Turn a caught GithubWriteError into the JSON body and status an API handler
// sends to the browser. Returns null for anything that is not one of ours, so
// callers keep their own generic fallback for genuinely unknown errors.
//
// SECURITY: the body is assembled from `userMessage` and `fix` ONLY — both canned
// strings from WRITE_FAILURES above. err.message (which carries GitHub's raw
// response body) and err.status are deliberately NOT included. Callers must keep
// logging err server-side; that is where the detail belongs.
export function githubWriteErrorResponse(err) {
  if (!(err instanceof GithubWriteError)) return null;
  return {
    status: WRITE_HTTP_STATUS[err.code] ?? 500,
    body: {
      error: [err.userMessage, err.fix].filter(Boolean).join(' '),
      // `message` duplicates `error` because the Story Bank save in
      // dashboard/index.html reads data.message while every other caller reads
      // data.error. Sending both means one curated sentence reaches the user
      // wherever the save was started from.
      message: [err.userMessage, err.fix].filter(Boolean).join(' '),
      code: err.code,
      fix: err.fix,
    },
  };
}

// Read a non-OK response's body for the server-side detail, tolerating a body
// that cannot be read at all.
async function failureBody(res) {
  try { return await res.text(); } catch (_) { return ''; }
}

// Throw the typed error for a non-OK response, preserving the exact detail text
// the bare Errors used to carry (`${prefix}: ${status} — ${body}`) so existing
// log output is unchanged.
async function throwWriteFailure(step, res, prefix) {
  const body = await failureBody(res);
  throw writeFailure(step, res.status, body, res.headers, `${prefix}: ${res.status} — ${body}`);
}

// ── Write ─────────────────────────────────────────────────────────────────────

async function createBlob(GIT, authHeaders, contentString) {
  const contentBase64 = Buffer.from(contentString).toString('base64');
  const blobRes = await fetch(`${GIT}/blobs`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
  });
  if (!blobRes.ok) await throwWriteFailure('blob create', blobRes, 'blob create failed');
  const { sha } = await blobRes.json();
  return sha;
}

// Write a single file via the Git Data API: blob → tree → commit → advance ref.
// Works for files of any size (the Contents API PUT rejects files > 1 MB with 422).
//
// `contentOrBuilder` is either:
//   • a string — written verbatim (the caller serialized it exactly how it wants,
//     including any trailing newline). On a ref-advance conflict (HTTP 422 — main
//     moved under us mid-write) the SAME blob is re-committed onto the new HEAD.
//     Correct for INDEPENDENT payloads that are not a mutation of shared state
//     (e.g. current_job.json, current_company.json).
//   • a function (current) => string|Promise<string> — the field-safe path
//     `current` is the freshly-read file text, or null if absent.
//     The builder runs on EVERY attempt (including after a 422), so a concurrent
//     writer's change is re-read and THIS operation's own field change is
//     re-applied on top of it — never a whole-file overwrite from a stale
//     snapshot. Use this for shared mutable state like data/job-status.json.
//
// Both paths are bounded to `maxAttempts`. Returns the new commit SHA.
//
// NO-OP GUARD (`allowNoop`, default false). If the new tree comes back identical
// to the base tree, the content being written is byte-identical to what is already
// committed, and creating the commit would produce a real but EMPTY commit
// ("0 files changed"). Every empty-commit write observed in production was silent
// data loss — most recently the radar.json array-seed bug, where a mutation applied
// to a parsed array was dropped by JSON.stringify, the endpoint reported success,
// and the company vanished on the next read. So by default this throws instead of
// committing: a write that changes nothing is a bug, not a success.
//
// Callers for which an identical write is a legitimate, idempotent operation (a
// re-queued research payload, a Save clicked twice, a scanner state file that did
// not change this run) pass { allowNoop: true }. There the no-op is treated as
// success without a commit and the CURRENT head sha is returned.
//
// `allowNoop` also accepts a FUNCTION, evaluated only if a no-op actually happens.
// That lets a caller stay strict for the case it considers a bug while still
// tolerating the case it considers benign, instead of disabling the guard wholesale
// (scanner/persistJobs.mjs: `() => added === 0` — a builder that added nothing is
// normal under concurrency, but a builder that says it added jobs and still changed
// nothing is exactly the silent-loss bug this guard exists to catch).
//
// One case is always treated as success regardless of allowNoop: a no-op on
// attempt >= 2, i.e. after a 422 ref conflict. Reaching that point means a
// concurrent writer advanced HEAD and the freshly-rebuilt content now matches the
// commit that landed — our change IS in the file, written by someone else. That is
// a converged write, not lost data.
export async function writeGithubFile(
  githubToken, owner, repo, filePath, contentOrBuilder, message,
  { maxAttempts = 5, logTag = 'github', branch = process.env.GITHUB_REF_NAME || 'main', allowNoop = false } = {},
) {
  // Resolve the target branch. GitHub Actions sets GITHUB_REF_NAME to the run's
  // branch, so a scan running on plan/reliability-batch reads AND writes that
  // branch instead of hardcoding main (the read/write split-brain bug: state
  // commits and job persistence were landing on main while state was read from
  // the branch). Vercel does not set GITHUB_REF_NAME (verified: no such env var
  // in vercel.json and no reference anywhere in the code), so API routes fall
  // back to 'main' exactly as before. Overridable via the `branch` option.
  const GIT = `${GITHUB_API}/repos/${owner}/${repo}/git`;
  const authHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  const isBuilder = typeof contentOrBuilder === 'function';

  // String content is content-addressed and HEAD-independent, so its blob is
  // created once up front and reused across retries. The builder path rebuilds the
  // blob each attempt because its content depends on the current file.
  let blobSha = null;
  if (!isBuilder) {
    blobSha = await createBlob(GIT, authHeaders, contentOrBuilder);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Anchor the ENTIRE attempt to one HEAD commit. Read the ref FIRST, capture its
    // commit sha, and derive everything else — the content read, the base tree, and
    // the new commit's parent — from THAT exact sha.
    //
    // This ordering closes the lost-update race. Previously the
    // builder read the file (Contents API @ branch, always the latest) BEFORE
    // reading the ref. A commit landing in that window — or the Contents API lagging
    // behind a just-advanced ref — produced a blob built from STALE content whose
    // parent was nonetheless the *new* HEAD (read moments later), so the PATCH
    // fast-forwarded cleanly (no 422) and silently clobbered the interleaving change.
    // Two production reverts (b1b77b3→5ba56b7, da480b6→283fd03) were this bug.
    // With the read pinned to the ref's commit sha, any commit that lands after this
    // point cannot be our parent, so the final PATCH fails 422 and we retry with a
    // fresh anchored read that re-applies this change on top of the other one.
    const refRes = await fetch(`${GIT}/ref/heads/${branch}`, { headers: authHeaders });
    // A 404 here is the wrong-default-branch failure: the branch this writes to is
    // hardcoded to GITHUB_REF_NAME || 'main', so a repo whose default is master
    // (or anything else) has no `main` for the ref to resolve, and every save in
    // the app fails. 'ref get' is what lets that 404 be named as a missing BRANCH
    // rather than a missing repo.
    if (!refRes.ok) await throwWriteFailure('ref get', refRes, 'get ref failed');
    const { object: { sha: commitSha } } = await refRes.json();

    const commitRes = await fetch(`${GIT}/commits/${commitSha}`, { headers: authHeaders });
    if (!commitRes.ok) await throwWriteFailure('commit get', commitRes, 'get commit failed');
    const { tree: { sha: treeSha } } = await commitRes.json();

    if (isBuilder) {
      // Read the file content AT the anchored commit sha (not the moving branch ref).
      // commitSha is immutable, so this read cannot lag or race a concurrent writer:
      // it is exactly the content of the parent we are about to commit onto. The
      // builder runs on this anchored content and re-applies THIS operation's change,
      // so after a 422 retry a concurrent writer's change is re-read and preserved
      // rather than overwritten from a stale snapshot. Because the sha derives from
      // the write branch's own ref, the read also never falls back to the default
      // branch's content (the split-brain guarantee). readGithubFile's >1 MB fallback
      // resolves the blob sha from this commit-scoped metadata, keeping the large
      // job-status.json read pinned to the same commit too.
      const { exists, content: current } = await readGithubFile(githubToken, owner, repo, filePath, { branch: commitSha });
      const rebuilt = await contentOrBuilder(exists ? current : null);
      blobSha = await createBlob(GIT, authHeaders, rebuilt);
    }

    const newTreeRes = await fetch(`${GIT}/trees`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        base_tree: treeSha,
        tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blobSha }],
      }),
    });
    if (!newTreeRes.ok) await throwWriteFailure('tree create', newTreeRes, 'create tree failed');
    const { sha: newTreeSha } = await newTreeRes.json();

    // Git trees are content-addressed: an identical sha means the write changes
    // nothing. Stop here rather than creating an empty commit — see the allowNoop
    // note on this function.
    if (newTreeSha === treeSha) {
      // Evaluate the predicate form only now, when a no-op has actually occurred.
      if (typeof allowNoop === 'function' ? allowNoop() : allowNoop) {
        console.log(`[${logTag}] ${filePath} already matches the committed content — skipping empty commit`);
        return commitSha;
      }
      // A no-op on a retry means a concurrent writer already landed this exact
      // content between our attempts. The change is in the file — converged, not lost.
      if (attempt > 1) {
        console.log(
          `[${logTag}] ${filePath} already matches after the ref conflict on attempt ${attempt} — a concurrent writer landed the same content; treating as success`,
        );
        return commitSha;
      }
      console.warn(
        `[${logTag}] refusing empty commit for ${filePath}: the new tree (${newTreeSha}) is identical to the base tree at ${commitSha}, so this write would change nothing`,
      );
      throw new Error(
        `write produced no change to ${filePath} — refusing to create an empty commit (this usually means data was lost in serialization)`,
      );
    }

    const newCommitRes = await fetch(`${GIT}/commits`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ message, tree: newTreeSha, parents: [commitSha] }),
    });
    if (!newCommitRes.ok) await throwWriteFailure('commit create', newCommitRes, 'create commit failed');
    const { sha: newCommitSha } = await newCommitRes.json();

    // Advance the branch ref, fast-forward only (no force). A moved HEAD is a 422.
    const updateRefRes = await fetch(`${GIT}/refs/heads/${branch}`, {
      method: 'PATCH', headers: authHeaders,
      body: JSON.stringify({ sha: newCommitSha }),
    });
    if (updateRefRes.ok) return newCommitSha;

    const body = await failureBody(updateRefRes);
    // The 422 fast-forward retry is UNCHANGED — only the throw is typed. 422 here
    // means HEAD moved under us, which is the loop's normal signal to rebase; it
    // becomes an error only once the attempts run out.
    if (updateRefRes.status !== 422 || attempt === maxAttempts) {
      throw writeFailure(
        'ref patch', updateRefRes.status, body, updateRefRes.headers,
        `update ref failed after ${attempt} attempt(s): ${updateRefRes.status} — ${body}`,
      );
    }
    console.log(`[${logTag}] ref moved (attempt ${attempt}), rebasing onto new HEAD`);
    await new Promise(resolve => setTimeout(resolve, 200 * attempt)); // small backoff
  }
}
