const GITHUB_API = 'https://api.github.com';

// GET job-status.json — handles files > 1MB via download_url fallback
// (GitHub Contents API returns content:"" for files over 1MB)
async function getJobStatusFile(githubToken, owner, repo) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/data/job-status.json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return { content: { jobs: {} } };
  if (!res.ok) throw new Error(`GitHub GET job-status.json failed: ${res.status}`);
  const data = await res.json();

  let rawJson;
  if (data.content) {
    rawJson = Buffer.from(data.content, 'base64').toString('utf8');
    console.log('[persist] GET success (inline content)');
  } else if (data.download_url) {
    console.log('[persist] File exceeds GitHub Contents API limit — fetching via download_url');
    const rawRes = await fetch(data.download_url, {
      headers: { Authorization: `Bearer ${githubToken}` },
    });
    if (!rawRes.ok) throw new Error(`GitHub download_url fetch failed: ${rawRes.status}`);
    rawJson = await rawRes.text();
  } else {
    throw new Error('GitHub Contents API returned neither content nor download_url');
  }

  return { content: JSON.parse(rawJson) };
}

// PUT job-status.json via Git Data API — no file-size limit.
// The Contents API PUT endpoint rejects files > 1MB with a 422.
async function putJobStatusFile(githubToken, owner, repo, content) {
  const GITHUB_GIT = `${GITHUB_API}/repos/${owner}/${repo}/git`;
  const authHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  const contentBase64 = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');

  // Step 1 — create blob
  console.log('[persist] Git Data API: creating blob...');
  const blobRes = await fetch(`${GITHUB_GIT}/blobs`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
  });
  if (!blobRes.ok) throw new Error(`GitHub blob create failed: ${blobRes.status} — ${await blobRes.text()}`);
  const { sha: blobSha } = await blobRes.json();

  // Step 2 — get HEAD commit SHA
  const refRes = await fetch(`${GITHUB_GIT}/ref/heads/main`, { headers: authHeaders });
  if (!refRes.ok) throw new Error(`GitHub get ref failed: ${refRes.status}`);
  const { object: { sha: commitSha } } = await refRes.json();

  // Step 3 — get tree SHA from commit
  const commitRes = await fetch(`${GITHUB_GIT}/commits/${commitSha}`, { headers: authHeaders });
  if (!commitRes.ok) throw new Error(`GitHub get commit failed: ${commitRes.status}`);
  const { tree: { sha: treeSha } } = await commitRes.json();

  // Step 4 — create new tree with updated file
  const newTreeRes = await fetch(`${GITHUB_GIT}/trees`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      base_tree: treeSha,
      tree: [{ path: 'data/job-status.json', mode: '100644', type: 'blob', sha: blobSha }],
    }),
  });
  if (!newTreeRes.ok) throw new Error(`GitHub create tree failed: ${newTreeRes.status}`);
  const { sha: newTreeSha } = await newTreeRes.json();

  // Step 5 — create commit
  const newCommitRes = await fetch(`${GITHUB_GIT}/commits`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      message: 'chore: persist scanned jobs [skip ci]',
      tree: newTreeSha,
      parents: [commitSha],
    }),
  });
  if (!newCommitRes.ok) throw new Error(`GitHub create commit failed: ${newCommitRes.status}`);
  const { sha: newCommitSha } = await newCommitRes.json();

  // Step 6 — advance branch ref
  const updateRefRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, {
    method: 'PATCH', headers: authHeaders,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (!updateRefRes.ok) throw new Error(`GitHub update ref failed: ${updateRefRes.status}`);
  console.log('[persist] job-status.json updated via Git Data API');
}

export async function persistJobs(evaluatedJobs) {
  const githubToken = process.env.GH_TOKEN;
  const githubRepo = process.env.GH_REPO;

  if (!githubToken) {
    console.warn('[persist] GH_TOKEN not set — skipping job persistence');
    return;
  }

  const [owner, repo] = githubRepo.split('/');

  let jobStatus;
  try {
    ({ content: jobStatus } = await getJobStatusFile(githubToken, owner, repo));
  } catch (err) {
    console.error(`[persist] Failed to load job-status.json: ${err.message}`);
    return;
  }

  if (!jobStatus.jobs) jobStatus.jobs = {};

  let added = 0;
  for (const job of evaluatedJobs) {
    const id = job._fingerprint;
    if (!id) continue;
    if (jobStatus.jobs[id]) continue; // Never overwrite — user may have actioned it

    jobStatus.jobs[id] = {
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
    added++;
  }

  if (added === 0) {
    console.log('[persist] No new jobs to persist');
    return;
  }

  await putJobStatusFile(githubToken, owner, repo, jobStatus);
  console.log(`[persist] Persisted ${added} new jobs to job-status.json`);
}
