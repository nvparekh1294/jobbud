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

// Fetch minimal repo metadata. Returns { private, fullName }. Throws on any
// non-OK response (404, 403, 5xx) so an unknown repo is never treated as private.
export async function getRepoInfo(githubToken, owner, repo) {
  const res = await fetchReadWithRetry(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub GET repo ${owner}/${repo} failed: ${res.status} — ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { private: data.private === true, fullName: data.full_name || `${owner}/${repo}` };
}

// Guard for personal-file writes. Throws RepoPublicError when the target repo is
// public, and rethrows any lookup error (fail closed — never write on an
// undetermined visibility). Returns the repo info when it is safe to proceed.
export async function assertRepoPrivate(githubToken, owner, repo) {
  const info = await getRepoInfo(githubToken, owner, repo);
  if (!info.private) throw new RepoPublicError(info.fullName);
  return info;
}

// ── Write ─────────────────────────────────────────────────────────────────────

async function createBlob(GIT, authHeaders, contentString) {
  const contentBase64 = Buffer.from(contentString).toString('base64');
  const blobRes = await fetch(`${GIT}/blobs`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
  });
  if (!blobRes.ok) throw new Error(`blob create failed: ${blobRes.status} — ${await blobRes.text()}`);
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
export async function writeGithubFile(
  githubToken, owner, repo, filePath, contentOrBuilder, message,
  { maxAttempts = 5, logTag = 'github', branch = process.env.GITHUB_REF_NAME || 'main' } = {},
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
    if (!refRes.ok) throw new Error(`get ref failed: ${refRes.status} — ${await refRes.text()}`);
    const { object: { sha: commitSha } } = await refRes.json();

    const commitRes = await fetch(`${GIT}/commits/${commitSha}`, { headers: authHeaders });
    if (!commitRes.ok) throw new Error(`get commit failed: ${commitRes.status} — ${await commitRes.text()}`);
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
    if (!newTreeRes.ok) throw new Error(`create tree failed: ${newTreeRes.status} — ${await newTreeRes.text()}`);
    const { sha: newTreeSha } = await newTreeRes.json();

    const newCommitRes = await fetch(`${GIT}/commits`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ message, tree: newTreeSha, parents: [commitSha] }),
    });
    if (!newCommitRes.ok) throw new Error(`create commit failed: ${newCommitRes.status} — ${await newCommitRes.text()}`);
    const { sha: newCommitSha } = await newCommitRes.json();

    // Advance the branch ref, fast-forward only (no force). A moved HEAD is a 422.
    const updateRefRes = await fetch(`${GIT}/refs/heads/${branch}`, {
      method: 'PATCH', headers: authHeaders,
      body: JSON.stringify({ sha: newCommitSha }),
    });
    if (updateRefRes.ok) return newCommitSha;

    const body = await updateRefRes.text();
    if (updateRefRes.status !== 422 || attempt === maxAttempts) {
      throw new Error(`update ref failed after ${attempt} attempt(s): ${updateRefRes.status} — ${body}`);
    }
    console.log(`[${logTag}] ref moved (attempt ${attempt}), rebasing onto new HEAD`);
    await new Promise(resolve => setTimeout(resolve, 200 * attempt)); // small backoff
  }
}
