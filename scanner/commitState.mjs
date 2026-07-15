// Commit durable scanner state back to the repo.
//
// seen-jobs.json (dedup history), company-cache.json (enrichment cache) and
// api-usage.json (quota tracking) used to persist ONLY through the GitHub Actions
// cache. The cache can be evicted at any time; when seen-jobs is lost, dedup
// resets and every job is re-evaluated (real AI cost) and re-sent in the digest.
//
// These three files are git-tracked, so `actions/checkout` restores them at the
// start of every run — but nothing committed the scanner's in-run writes back, so
// the repo copy drifted and the cache became the de-facto (evictable) source of
// truth. This script makes the COMMITTED copy the source of truth: after the scan,
// it writes each locally-updated state file back to the repo via the shared Git
// Data API helper. Next run's checkout then starts from fresh, durable state — no
// cache required.
//
// Best-effort: a failure here never fails the workflow (the scan already did its
// real work). Unchanged files are skipped so we don't create empty commits.

import fs from 'node:fs';
import { readGithubFile, writeGithubFile } from '../lib/github.js';

const STATE_FILES = [
  'data/seen-jobs.json',
  'data/company-cache.json',
  'data/api-usage.json',
];

async function main() {
  const githubToken = process.env.GH_TOKEN;
  const githubRepo = process.env.GH_REPO;
  if (!githubToken) {
    console.warn('[commit-state] GH_TOKEN not set — skipping state commit');
    return;
  }
  const [owner, repo] = githubRepo.split('/');

  for (const path of STATE_FILES) {
    if (!fs.existsSync(path)) {
      console.log(`[commit-state] ${path} absent locally — nothing to commit`);
      continue;
    }
    const local = fs.readFileSync(path, 'utf8');

    // Skip if the repo copy already matches — avoids empty no-op commits.
    let remote = null;
    try {
      const { exists, content } = await readGithubFile(githubToken, owner, repo, path);
      remote = exists ? content : null;
    } catch (err) {
      console.warn(`[commit-state] read ${path} failed (will still try to write): ${err.message}`);
    }
    if (remote !== null && remote === local) {
      console.log(`[commit-state] ${path} unchanged — skip`);
      continue;
    }

    try {
      const commitSha = await writeGithubFile(
        githubToken, owner, repo, path, local,
        `chore: persist scanner state (${path.split('/').pop()}) [skip ci]`,
        { logTag: 'commit-state' },
      );
      console.log(`[commit-state] committed ${path} (${commitSha})`);
    } catch (err) {
      console.error(`[commit-state] commit ${path} failed: ${err.message}`);
    }
  }
}

// Never exit non-zero — this is a best-effort persistence step.
main().catch(err => {
  console.error('[commit-state] Failed:', err);
});
