import { readGithubFile, writeGithubFile } from '../lib/github.js';

// Build the job record persisted for a freshly-evaluated job.
function buildJobRecord(job) {
  return {
    status: 'new',
    firstSeenAt: new Date().toISOString(),
    company: job.company || '',
    title: job.title || '',
    location: job.location || '',
    isRemote: job.isRemote || false,
    url: job.url || '',
    score: job.score ?? null,
    aiExposureRisk: job.aiExposureRisk || null,
    aiExposureRationale: job.aiExposureRationale || null,
    jobType: job.jobType || 'operating',
    whyFit: job.whyFit || [],
    watchOuts: job.watchOuts || [],
    recommendedAction: job.recommendedAction || '',
    oneLineSummary: job.oneLineSummary || '',
    companyDescription: job.companyDescription || '',
    description: (job.description || '').slice(0, 3000),
    fundingSnapshot: job.fundingSnapshot || null,
  };
}

// Persist newly-evaluated jobs into data/job-status.json.
//
// Returns the number of new jobs actually added. Concurrency-safe: the write goes
// through writeGithubFile's builder form, which re-reads the file on every attempt
// and re-adds only the missing job ids. So a status change the dashboard commits
// mid-scan (or another scan running concurrently) is preserved rather than erased
// by a stale whole-file overwrite. Existing jobs are NEVER overwritten — the owner
// may have actioned them.
export async function persistJobs(evaluatedJobs) {
  const githubToken = process.env.GH_TOKEN;
  const githubRepo = process.env.GH_REPO;

  if (!githubToken) {
    console.warn('[persist] GH_TOKEN not set — skipping job persistence');
    return 0;
  }

  const [owner, repo] = githubRepo.split('/');

  const candidates = evaluatedJobs.filter(job => job._fingerprint);
  if (candidates.length === 0) {
    console.log('[persist] No fingerprinted jobs to persist');
    return 0;
  }

  // Load once up front only to decide whether a write is even needed. If every
  // candidate already exists we skip the commit entirely (no empty no-op commit).
  // The actual write below re-reads fresh and re-checks, so this pre-read being
  // slightly stale is harmless.
  //
  // A genuine read failure (network error / GitHub 5xx) MUST propagate, not
  // return 0: the caller treats a non-throwing return as success and marks jobs
  // seen, so swallowing the error would lose jobs permanently. A genuinely absent
  // file is NOT a failure: readGithubFile resolves a 404 to { exists: false }
  // without throwing, so that path still starts from an empty job set below.
  let jobStatus;
  try {
    const { exists, content } = await readGithubFile(githubToken, owner, repo, 'data/job-status.json');
    jobStatus = exists ? JSON.parse(content) : { jobs: {} };
  } catch (err) {
    throw new Error(`Failed to load job-status.json: ${err.message}`);
  }
  if (!jobStatus.jobs) jobStatus.jobs = {};
  const anyNew = candidates.some(job => !jobStatus.jobs[job._fingerprint]);
  if (!anyNew) {
    console.log('[persist] No new jobs to persist');
    return 0;
  }

  // `added` is recomputed on each builder attempt so it reflects what was actually
  // written in the attempt that ultimately succeeded (a concurrent add of the same
  // job by another writer means it is no longer counted as newly added here).
  let added = 0;
  try {
    await writeGithubFile(
      githubToken, owner, repo, 'data/job-status.json',
      (current) => {
        const jobStatus = current ? JSON.parse(current) : { jobs: {} };
        if (!jobStatus.jobs) jobStatus.jobs = {};

        added = 0;
        for (const job of candidates) {
          const id = job._fingerprint;
          if (jobStatus.jobs[id]) continue; // Never overwrite — user may have actioned it
          jobStatus.jobs[id] = buildJobRecord(job);
          added++;
        }

        return JSON.stringify(jobStatus, null, 2);
      },
      'chore: persist scanned jobs [skip ci]',
      { logTag: 'persist' },
    );
  } catch (err) {
    // Re-throw so the caller (scanner/index.mjs) can gate markScored on success.
    throw new Error(`Failed to persist job-status.json: ${err.message}`);
  }

  console.log(`[persist] Persisted ${added} new jobs to job-status.json`);
  return added;
}
