// Writes linkedin-research/current_job.json into the repo via the Git Data API.
//
// Why this exists: the dashboard used to hand the user a shell command that did
//   echo '{...json...}' > ~/linkedin-research/current_job.json && cd ... && claude ...
// macOS flags that pattern (echo + embedded JSON + `>` redirect + `&&` chaining)
// as "Possible Malware, Paste Blocked". Instead, the dashboard calls this endpoint
// to write the job file directly, and the pasted command becomes a plain
//   cd ~/linkedin-research && claude ...
//
// The file is committed to the repo at linkedin-research/current_job.json so a
// clone of the repo (e.g. ~/linkedin-research) gets it on `git pull`, and the
// LinkedIn research agent reads it instead of asking the user to fill placeholders.

const GITHUB_API = 'https://api.github.com';

// This function does a heavy read (job-status.json is now ~2MB and served via the
// slow Contents API download_url path) followed by a 6-request Git Data API write.
// Without an explicit budget it runs on Vercel's short default and times out before
// the write lands — which is why writes stopped landing once job-status.json grew
// past 1MB, while the lighter radar-research endpoint (tiny radar.json read) keeps
// working. Give it the same headroom as the other Git-writing endpoints in
// vercel.json (action.js: 120, add-job.js: 60). Vercel honors this per-function.
export const maxDuration = 60;

// roleTypes → human-readable function for the research agent. Mirrors the mapping
// the dashboard used to apply client-side before the JSON moved server-side.
const RESEARCH_FUNCTION_MAP = {
  'ops':        'Strategy & Operations / Business Operations',
  'corpdev':    'Corporate Development',
  'stratfin':   'Strategic Finance',
  'ceo-office': 'Chief of Staff / General Management',
};

// First roleType that has a mapping wins; '' if none.
function researchFunction(job) {
  for (const rt of (job.roleTypes || [])) {
    if (RESEARCH_FUNCTION_MAP[rt]) return RESEARCH_FUNCTION_MAP[rt];
  }
  return '';
}

// Best-guess LinkedIn company slug from the company name (same rule as the dashboard).
function researchSlug(company) {
  return (company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
}

// ── Read job-status.json (handles the >1MB download_url case like the rest of the codebase) ──
async function getJobStatus(githubToken, owner, repo) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/data/job-status.json`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub GET job-status.json failed: ${res.status}`);
  const data = await res.json();

  let rawJson;
  if (data.content) {
    rawJson = Buffer.from(data.content, 'base64').toString('utf8');
  } else if (data.download_url) {
    const rawRes = await fetch(data.download_url, {
      headers: { Authorization: `Bearer ${githubToken}` },
    });
    if (!rawRes.ok) throw new Error(`GitHub download_url fetch failed: ${rawRes.status}`);
    rawJson = await rawRes.text();
  } else {
    throw new Error('GitHub Contents API returned neither content nor download_url');
  }
  return JSON.parse(rawJson);
}

// ── Write a single file via the Git Data API: blob → tree → commit → advance ref ──
// Same pattern as putJobStatus in api/action.js, generalised to an arbitrary path.
async function commitFile(githubToken, owner, repo, filePath, contentString, message) {
  const GIT = `${GITHUB_API}/repos/${owner}/${repo}/git`;
  const authHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  const contentBase64 = Buffer.from(contentString).toString('base64');

  // 1 — create blob (content-addressed, independent of HEAD, so done once up front)
  const blobRes = await fetch(`${GIT}/blobs`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
  });
  if (!blobRes.ok) throw new Error(`blob create failed: ${blobRes.status} — ${await blobRes.text()}`);
  const { sha: blobSha } = await blobRes.json();

  // Steps 2–6 are anchored to the current HEAD. The scanner commits to main
  // frequently, so HEAD can move between reading it (step 2) and advancing the ref
  // (step 6), which makes the non-force PATCH a non-fast-forward (HTTP 422). When
  // that happens we simply re-read the new HEAD and rebuild on top of it — our blob
  // is unchanged, so this rebases the same file write onto the latest main. Only the
  // race (422) is retried; any other failure throws immediately.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 2 — HEAD commit SHA
    const refRes = await fetch(`${GIT}/ref/heads/main`, { headers: authHeaders });
    if (!refRes.ok) throw new Error(`get ref failed: ${refRes.status} — ${await refRes.text()}`);
    const { object: { sha: commitSha } } = await refRes.json();

    // 3 — tree SHA from commit
    const commitRes = await fetch(`${GIT}/commits/${commitSha}`, { headers: authHeaders });
    if (!commitRes.ok) throw new Error(`get commit failed: ${commitRes.status} — ${await commitRes.text()}`);
    const { tree: { sha: treeSha } } = await commitRes.json();

    // 4 — new tree with the file added/updated
    const newTreeRes = await fetch(`${GIT}/trees`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        base_tree: treeSha,
        tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blobSha }],
      }),
    });
    if (!newTreeRes.ok) throw new Error(`create tree failed: ${newTreeRes.status} — ${await newTreeRes.text()}`);
    const { sha: newTreeSha } = await newTreeRes.json();

    // 5 — commit
    const newCommitRes = await fetch(`${GIT}/commits`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ message, tree: newTreeSha, parents: [commitSha] }),
    });
    if (!newCommitRes.ok) throw new Error(`create commit failed: ${newCommitRes.status} — ${await newCommitRes.text()}`);
    const { sha: newCommitSha } = await newCommitRes.json();

    // 6 — advance branch ref (fast-forward only; no force, so a moved HEAD is rejected)
    const updateRefRes = await fetch(`${GIT}/refs/heads/main`, {
      method: 'PATCH', headers: authHeaders,
      body: JSON.stringify({ sha: newCommitSha }),
    });
    if (updateRefRes.ok) return newCommitSha;

    // 422 == non-fast-forward: main moved under us. Re-read HEAD and retry.
    const body = await updateRefRes.text();
    if (updateRefRes.status !== 422 || attempt === MAX_ATTEMPTS) {
      throw new Error(`update ref failed after ${attempt} attempt(s): ${updateRefRes.status} — ${body}`);
    }
    console.log(`[queue-linkedin-research] ref moved (attempt ${attempt}), rebasing onto new HEAD`);
    await new Promise(resolve => setTimeout(resolve, 200 * attempt)); // small backoff
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const password    = process.env.DASHBOARD_PASSWORD;
  const githubToken = process.env.GH_TOKEN;
  const githubRepo  = process.env.GH_REPO;
  const [owner, repo] = githubRepo.split('/');

  // Auth — same X-Dashboard-Password header check as the other dashboard endpoints.
  const headerPw = req.headers['x-dashboard-password'];
  if (!headerPw || !password || headerPw !== password) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!githubToken) return res.status(500).json({ error: 'GH_TOKEN not set' });

  const { jobId, slug } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'Missing required field: jobId' });

  try {
    const jobData = await getJobStatus(githubToken, owner, repo);
    const job = jobData.jobs?.[jobId];
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Use the user-corrected slug from the modal if provided; otherwise best-guess it.
    const finalSlug = (typeof slug === 'string' && slug.trim())
      ? slug.trim()
      : researchSlug(job.company);

    const payload = {
      company:     job.company || '',
      slug:        finalSlug,
      jobTitle:    job.title || '',
      jobFunction: researchFunction(job),
      jobId,
    };

    const commitSha = await commitFile(
      githubToken, owner, repo,
      'linkedin-research/current_job.json',
      JSON.stringify(payload, null, 2) + '\n',
      `chore: queue LinkedIn research for ${payload.company} [skip ci]`,
    );

    console.log(`[queue-linkedin-research] wrote current_job.json for ${payload.company} (${commitSha})`);
    return res.status(200).json({ success: true, job: payload, commit: commitSha });
  } catch (err) {
    console.error('[queue-linkedin-research] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
