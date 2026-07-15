// Writes linkedin-research/current_company.json into the repo via the Git Data API.
//
// Radar analogue of api/queue-linkedin-research.js (which writes current_job.json
// for the job pipeline). The Radar version carries the company-level context the
// research agent needs when there's no specific job posting: why the user is
// interested and who she wants to reach (contactPriority).
//
// The file is committed to the repo so a clone (e.g. ~/linkedin-research) gets it
// on `git pull`, and the LinkedIn research agent reads it from there.

import { readGithubFile, writeGithubFile } from '../lib/github.js';

const RADAR_PATH = 'data/radar.json';

// Give the read + 6-request Git Data API write room to finish on Vercel's runtime,
// matching the other Git-writing endpoints (queue-linkedin-research 60, action.js
// 120, add-job.js 60 in vercel.json). radar.json is small today, but the write
// round-trips alone are worth the headroom and keep the two queue endpoints aligned.
export const maxDuration = 60;

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── Read radar.json (handles the >1MB download_url case via the shared helper) ──
async function readRadar(githubToken, owner, repo) {
  const { exists, content } = await readGithubFile(githubToken, owner, repo, RADAR_PATH);
  if (!exists) return { companies: {} };
  const parsed = JSON.parse(content);
  if (!parsed.companies || typeof parsed.companies !== 'object') parsed.companies = {};
  return parsed;
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

  const headerPw = req.headers['x-dashboard-password'];
  if (!headerPw || !password || !safeEqual(headerPw, password)) {
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

    const commitSha = await writeGithubFile(
      githubToken, owner, repo,
      'linkedin-research/current_company.json',
      JSON.stringify(payload, null, 2) + '\n',
      `chore: queue radar research for ${payload.company} [skip ci]`,
      { logTag: 'queue-radar-research' },
    );

    console.log(`[queue-radar-research] wrote current_company.json for ${payload.company} (${commitSha})`);
    return res.status(200).json({ success: true, company: payload, commit: commitSha });
  } catch (err) {
    console.error('[queue-radar-research] Error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
