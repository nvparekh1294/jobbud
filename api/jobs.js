// Vercel serverless function — serves job-status.json from the private GitHub repo.
// The dashboard fetches /api/jobs instead of raw.githubusercontent.com so it works
// even though the repo is private.

import { safeEqual } from '../lib/auth.mjs';
import { normalizeJsonDoc, readGithubText } from '../lib/github.js';
import { parseBulletBankTags, FALLBACK_ROLE_TAGS } from '../lib/bulletBank.mjs';

export default async function handler(req, res) {
  const password = process.env.DASHBOARD_PASSWORD;

  // ── Config probe — called by the frontend on load, before the gate is answered.
  // No auth needed: it reveals which optional integrations are wired up, not any data.
  //
  // It used to also return `passwordRequired`, and the frontend used it to skip the
  // gate entirely when no password was set — straight into a dashboard where every
  // request 401'd, because the auth below fails closed. The gate is now
  // unconditional and /api/health explains an unset DASHBOARD_PASSWORD properly, so
  // nothing reads that field any more; publishing it would only invite the shortcut
  // back. The probe stays because the Drive flag still has to be known pre-unlock.
  if (req.query.config === 'true') {
    return res.status(200).json({
      driveConfigured: !!process.env.GOOGLE_CLIENT_ID,
    });
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  // Fail closed: require the password unconditionally. If DASHBOARD_PASSWORD is
  // unset (a misconfigured install) or the header is missing/wrong, return 401
  // rather than serving private job data openly. The ?config=true probe above
  // stays open so the frontend can still decide whether to show the gate.
  const headerPw = req.headers['x-dashboard-password'];
  if (!password || !headerPw || !safeEqual(headerPw, password)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const githubToken = process.env.GH_TOKEN;
  const githubRepo  = process.env.GH_REPO;

  if (!githubToken) {
    return res.status(500).json({ error: 'GH_TOKEN not configured' });
  }

  if (!githubRepo) {
    return res.status(500).json({ error: 'GH_REPO not configured' });
  }

  const [owner, repo] = githubRepo.split('/');

  // ── Role-type tags for the Generate Package modal ──────────────────────────
  // The modal used to ship a hardcoded list of the original author's five
  // categories, so every user filtered their bullets against tags that did not
  // exist in their own bank — the selection silently matched nothing. The tags
  // are the user's, defined in their bullet-bank.md legend, so we read them from
  // there. Soft-read + defensive parse: a missing or unparseable bank yields the
  // generic fallback set rather than an error, and the dashboard says where the
  // real ones will come from.
  if (req.query.resource === 'role-tags') {
    const bank = await readGithubText(githubToken, owner, repo, 'bullet-bank.md');
    const tags = parseBulletBankTags(bank);
    const source = tags.length ? 'bullet-bank' : 'fallback';
    console.log(`[jobs] resource=role-tags source=${source} count=${tags.length || FALLBACK_ROLE_TAGS.length}`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      tags: tags.length ? tags : FALLBACK_ROLE_TAGS,
      source,
    });
  }

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
    // The committed seed is the array `[]`; the dashboard reads `data.jobs`, so
    // normalize to the { jobs: {} } model rather than serving a bare array.
    jobs = normalizeJsonDoc(JSON.parse(rawJson), { jobs: {} });
  } catch (err) {
    console.error('[jobs] Failed to parse job-status.json:', err.message);
    // Match the other failure paths above — an empty document, not a bare array.
    return res.status(200).json({ jobs: {} });
  }

  // No CDN caching — status changes must be visible immediately on next load.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(jobs);
}
