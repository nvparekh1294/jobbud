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

import { readGithubFile, writeGithubFile } from '../lib/github.js';

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

// ── Read job-status.json (handles the >1MB download_url case via the shared helper) ──
async function getJobStatus(githubToken, owner, repo) {
  const { exists, content } = await readGithubFile(githubToken, owner, repo, 'data/job-status.json');
  if (!exists) throw new Error('GitHub GET job-status.json failed: not found (404)');
  return JSON.parse(content);
}

// ── Handler ──────────────────────────────────────────────────────────────────
import { safeEqual } from '../lib/auth.mjs';

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
  if (!headerPw || !password || !safeEqual(headerPw, password)) {
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

    const commitSha = await writeGithubFile(
      githubToken, owner, repo,
      'linkedin-research/current_job.json',
      JSON.stringify(payload, null, 2) + '\n',
      `chore: queue LinkedIn research for ${payload.company} [skip ci]`,
      { logTag: 'queue-linkedin-research' },
    );

    console.log(`[queue-linkedin-research] wrote current_job.json for ${payload.company} (${commitSha})`);
    return res.status(200).json({ success: true, job: payload, commit: commitSha });
  } catch (err) {
    console.error('[queue-linkedin-research] Error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
