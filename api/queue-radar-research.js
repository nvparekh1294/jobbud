// Writes linkedin-research/current_company.json into the repo via the Git Data API.
//
// Radar analogue of api/queue-linkedin-research.js (which writes current_job.json
// for the job pipeline). The Radar version carries the company-level context the
// research agent needs when there's no specific job posting: why the user is
// interested and who she wants to reach (contactPriority).
//
// The file is committed to the repo so a clone (e.g. ~/linkedin-research) gets it
// on `git pull`, and the LinkedIn research agent reads it from there.

const GITHUB_API = 'https://api.github.com';
const RADAR_PATH = 'data/radar.json';

// Give the read + 6-request Git Data API write room to finish on Vercel's runtime,
// matching the other Git-writing endpoints (queue-linkedin-research 60, action.js
// 120, add-job.js 60 in vercel.json). radar.json is small today, but the write
// round-trips alone are worth the headroom and keep the two queue endpoints aligned.
export const maxDuration = 60;

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── Read radar.json (handles the >1MB download_url case like the rest of the codebase) ──
async function readRadar(githubToken, owner, repo) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${RADAR_PATH}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return { companies: {} };
  if (!res.ok) throw new Error(`GitHub GET ${RADAR_PATH} failed: ${res.status}`);
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
  const parsed = JSON.parse(rawJson);
  if (!parsed.companies || typeof parsed.companies !== 'object') parsed.companies = {};
  return parsed;
}

// ── Write a single file via the Git Data API: blob → tree → commit → advance ref ──
// Same pattern as commitFile in api/queue-linkedin-research.js.
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
  // that happens we re-read the new HEAD and rebuild on top of it — the blob is
  // unchanged, so this rebases the same file write onto latest main. Only the race
  // (422) is retried; any other failure throws immediately.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const refRes = await fetch(`${GIT}/ref/heads/main`, { headers: authHeaders });
    if (!refRes.ok) throw new Error(`get ref failed: ${refRes.status} — ${await refRes.text()}`);
    const { object: { sha: commitSha } } = await refRes.json();

    const commitRes = await fetch(`${GIT}/commits/${commitSha}`, { headers: authHeaders });
    if (!commitRes.ok) throw new Error(`get commit failed: ${commitRes.status} — ${await commitRes.text()}`);
    const { tree: { sha: treeSha } } = await commitRes.json();

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
    console.log(`[queue-radar-research] ref moved (attempt ${attempt}), rebasing onto new HEAD`);
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

  const headerPw = req.headers['x-dashboard-password'];
  if (!headerPw || !password || headerPw !== password) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!githubToken) return res.status(500).json({ error: 'GH_TOKEN not set' });

  const { companyId, slug } = req.body || {};
  if (!companyId) return res.status(400).json({ error: 'Missing required field: companyId' });

  try {
    const radar = await readRadar(githubToken, owner, repo);
    const company = radar.companies?.[companyId];
    if (!company) return res.status(404).json({ error: 'Company not found' });

    // Prefer the user-corrected slug from the modal; otherwise the stored/derived one.
    const finalSlug = (typeof slug === 'string' && slug.trim())
      ? slugify(slug)
      : (company.slug || slugify(company.company));

    const payload = {
      company:         company.company || '',
      slug:            finalSlug,
      why:             company.why || '',
      contactPriority: Array.isArray(company.contactPriority) ? company.contactPriority : [],
      companyId,
    };

    const commitSha = await commitFile(
      githubToken, owner, repo,
      'linkedin-research/current_company.json',
      JSON.stringify(payload, null, 2) + '\n',
      `chore: queue radar research for ${payload.company} [skip ci]`,
    );

    console.log(`[queue-radar-research] wrote current_company.json for ${payload.company} (${commitSha})`);
    return res.status(200).json({ success: true, company: payload, commit: commitSha });
  } catch (err) {
    console.error('[queue-radar-research] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
