// Vercel serverless function — serves job-status.json from the private GitHub repo.
// The dashboard fetches /api/jobs instead of raw.githubusercontent.com so it works
// even though the repo is private.

export default async function handler(req, res) {
  const password = process.env.DASHBOARD_PASSWORD;

  // ── Config probe — called by the frontend on load to decide whether to show the gate.
  // No auth needed: it only reveals whether a password is required, not any data.
  if (req.query.config === 'true') {
    return res.status(200).json({
      passwordRequired: !!password,
      driveConfigured: !!process.env.GOOGLE_CLIENT_ID,
    });
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  // Only enforced when DASHBOARD_PASSWORD is set. If unset, the dashboard is
  // intentionally open (e.g. a self-hosted instance with no sensitive data).
  const headerPw = req.headers['x-dashboard-password'];
  if (password && (!headerPw || headerPw !== password)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const githubToken = process.env.GH_TOKEN;
  const githubRepo  = process.env.GH_REPO;

  if (!githubToken) {
    return res.status(500).json({ error: 'GH_TOKEN not configured' });
  }

  const [owner, repo] = githubRepo.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/data/job-status.json`;

  const ghRes = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!ghRes.ok) {
    return res.status(ghRes.status).json({ error: `GitHub API returned ${ghRes.status}` });
  }

  const data = await ghRes.json();

  // GitHub Contents API returns content: "" for files > 1MB and sets download_url instead.
  // job-status.json is ~1.5MB so we must use the raw download URL in that case.
  let rawJson;
  if (data.content) {
    rawJson = Buffer.from(data.content, 'base64').toString('utf8');
  } else if (data.download_url) {
    console.log('[jobs] File exceeds GitHub Contents API limit — fetching via download_url');
    const rawRes = await fetch(data.download_url, {
      headers: { Authorization: `Bearer ${githubToken}` },
    });
    if (!rawRes.ok) {
      console.error(`[jobs] download_url fetch failed: ${rawRes.status}`);
      return res.status(200).json({ jobs: {} });
    }
    rawJson = await rawRes.text();
  } else {
    console.error('[jobs] GitHub response had neither content nor download_url');
    return res.status(200).json({ jobs: {} });
  }

  let jobs;
  try {
    jobs = JSON.parse(rawJson);
  } catch (err) {
    console.error('[jobs] Failed to parse job-status.json:', err.message);
    return res.status(200).json([]);
  }

  // No CDN caching — status changes must be visible immediately on next load.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(jobs);
}
