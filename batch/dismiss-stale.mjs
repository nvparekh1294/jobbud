/**
 * batch/dismiss-stale.mjs — one-time bulk-dismiss script
 *
 * Marks as rejected_by_me any job that meets BOTH:
 *   1. firstSeenAt is older than 14 days
 *   2. No action has ever been taken (status is absent, empty, or 'new')
 *
 * Jobs with any explicit action status — saved, preparing, applied,
 * interviewing, offer, rejected_by_me, rejected_by_them, ghosted — are
 * NEVER touched, regardless of age.
 *
 * Usage:
 *   GH_TOKEN=<pat> GH_REPO=your-github-username/jobbud node batch/dismiss-stale.mjs
 *   Add --dry-run to preview without writing.
 *
 * Writes back via the Git Data API (blob → tree → commit), the same
 * pattern used by persistJobs.mjs, so there is no 1 MB file-size limit.
 */

const IS_DRY_RUN = process.argv.includes('--dry-run');
const GITHUB_TOKEN = process.env.GH_TOKEN;
const GITHUB_REPO  = process.env.GH_REPO;
if (!GITHUB_REPO) {
  console.error('GH_REPO environment variable is required');
  process.exit(1);
}
const GITHUB_API   = 'https://api.github.com';
const MS_14D       = 14 * 24 * 60 * 60 * 1000;

if (!GITHUB_TOKEN) {
  console.error('[dismiss-stale] GH_TOKEN env var is required');
  process.exit(1);
}

const [owner, repo] = GITHUB_REPO.split('/');

// ── Step 1: Load job-status.json ─────────────────────────────────────────────
// Mirrors the download_url fallback in persistJobs.mjs for files > 1 MB.

async function loadJobStatus() {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/data/job-status.json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);
  const data = await res.json();

  let rawJson;
  if (data.content) {
    rawJson = Buffer.from(data.content, 'base64').toString('utf8');
    console.log('[dismiss-stale] Loaded job-status.json (inline)');
  } else if (data.download_url) {
    console.log('[dismiss-stale] File > 1 MB — fetching via download_url');
    const raw = await fetch(data.download_url, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
    });
    if (!raw.ok) throw new Error(`download_url fetch failed: ${raw.status}`);
    rawJson = await raw.text();
  } else {
    throw new Error('GitHub API returned neither content nor download_url');
  }

  return JSON.parse(rawJson);
}

// ── Step 2: Write via Git Data API (blob → tree → commit → ref) ──────────────

async function saveJobStatus(content) {
  const GITHUB_GIT = `${GITHUB_API}/repos/${owner}/${repo}/git`;
  const authHeaders = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  const contentBase64 = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');

  // 1 — create blob
  console.log('[dismiss-stale] Creating blob...');
  const blobRes = await fetch(`${GITHUB_GIT}/blobs`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
  });
  if (!blobRes.ok) throw new Error(`Blob create failed: ${blobRes.status} — ${await blobRes.text()}`);
  const { sha: blobSha } = await blobRes.json();

  // 2 — get HEAD commit SHA
  const refRes = await fetch(`${GITHUB_GIT}/ref/heads/main`, { headers: authHeaders });
  if (!refRes.ok) throw new Error(`Get ref failed: ${refRes.status}`);
  const { object: { sha: commitSha } } = await refRes.json();

  // 3 — get tree SHA from commit
  const commitRes = await fetch(`${GITHUB_GIT}/commits/${commitSha}`, { headers: authHeaders });
  if (!commitRes.ok) throw new Error(`Get commit failed: ${commitRes.status}`);
  const { tree: { sha: treeSha } } = await commitRes.json();

  // 4 — create new tree with updated file
  const newTreeRes = await fetch(`${GITHUB_GIT}/trees`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      base_tree: treeSha,
      tree: [{ path: 'data/job-status.json', mode: '100644', type: 'blob', sha: blobSha }],
    }),
  });
  if (!newTreeRes.ok) throw new Error(`Create tree failed: ${newTreeRes.status}`);
  const { sha: newTreeSha } = await newTreeRes.json();

  // 5 — create commit
  const newCommitRes = await fetch(`${GITHUB_GIT}/commits`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      message: 'chore: bulk-dismiss stale unactioned jobs [skip ci]',
      tree: newTreeSha,
      parents: [commitSha],
    }),
  });
  if (!newCommitRes.ok) throw new Error(`Create commit failed: ${newCommitRes.status}`);
  const { sha: newCommitSha } = await newCommitRes.json();

  // 6 — advance branch ref
  const updateRefRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, {
    method: 'PATCH', headers: authHeaders,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (!updateRefRes.ok) throw new Error(`Update ref failed: ${updateRefRes.status}`);
  console.log(`[dismiss-stale] Written via Git Data API (commit: ${newCommitSha})`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const jobStatus = await loadJobStatus();
const jobs = jobStatus.jobs || {};
const now  = Date.now();

const dismissed = [];
const skipped   = [];

for (const [id, job] of Object.entries(jobs)) {
  // Condition 2: must have NO action taken
  const hasAction = job.status && job.status !== 'new';
  if (hasAction) {
    skipped.push({ id, company: job.company, title: job.title, status: job.status });
    continue;
  }

  // Condition 1: must be older than 14 days
  const firstSeen = new Date(job.firstSeenAt).getTime();
  if (!firstSeen || isNaN(firstSeen) || (now - firstSeen) <= MS_14D) continue;

  dismissed.push({ id, company: job.company, title: job.title, firstSeenAt: job.firstSeenAt });

  if (!IS_DRY_RUN) {
    jobs[id].status          = 'rejected_by_me';
    jobs[id].statusUpdatedAt = new Date().toISOString();
    if (!jobs[id].statusHistory) jobs[id].statusHistory = [];
    jobs[id].statusHistory.push({
      status: 'rejected_by_me',
      timestamp: new Date().toISOString(),
      reason: 'bulk-dismissed: >14 days old, no action taken',
    });
  }
}

console.log(`\n[dismiss-stale] Total jobs: ${Object.keys(jobs).length}`);
console.log(`[dismiss-stale] Jobs with existing action status (untouched): ${skipped.length}`);
console.log(`[dismiss-stale] Jobs to dismiss (>14 days, no action): ${dismissed.length}`);

if (dismissed.length === 0) {
  console.log('[dismiss-stale] Nothing to do.');
  process.exit(0);
}

console.log('\nJobs being dismissed:');
for (const j of dismissed) {
  const ageD = Math.floor((now - new Date(j.firstSeenAt).getTime()) / (1000 * 60 * 60 * 24));
  console.log(`  [${ageD}d old] ${j.company} — ${j.title}`);
}

if (IS_DRY_RUN) {
  console.log('\n[dismiss-stale] DRY RUN — no changes written.');
} else {
  console.log('\n[dismiss-stale] Writing...');
  await saveJobStatus(jobStatus);
  console.log(`[dismiss-stale] Done — ${dismissed.length} job(s) dismissed.`);
}
