/**
 * api/add-job.js — manual job entry: scrape, score, and persist
 *
 * POST { mode: 'scrape', url }
 *   Attempts a server-side HTML fetch + JSON-LD / og: meta extraction.
 *   Returns { ok: true, title, company, location, isRemote, description }
 *           { ok: false, error } on block / JS-render / timeout — client shows fallback form.
 *
 * POST { mode: 'add', url?, title, company, location?, description, forceAdd? }
 *   Validates, checks for duplicate URL, runs Stage 1 Haiku + Stage 2 Sonnet,
 *   writes to job-status.json via Git Data API, returns score + job object.
 *   If URL already exists and forceAdd is not true, returns { alreadyExists: true }.
 *
 * Auth: X-Dashboard-Password header required on all requests.
 * Job objects written with source: 'manual' so the dashboard renders them separately.
 */

import { haikuHardFilter, sonnetScore, classifyJobType, sanitizeLocation } from '../scanner/evaluate.mjs';
import { readGithubFile, writeGithubFile } from '../lib/github.js';
import { safeEqual } from '../lib/auth.mjs';

const GITHUB_API = 'https://api.github.com';

// ── HTML scraping helpers ─────────────────────────────────────────────────────
// Greenhouse, Lever, Ashby, Workday, and many career pages embed JSON-LD JobPosting.
// LinkedIn and heavily JS-rendered portals block server-side fetches — expected.

function stripHtml(html) {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n').trim();
}

function extractFromJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      let data = JSON.parse(m[1]);
      if (Array.isArray(data['@graph'])) {
        data = data['@graph'].find(n => n['@type'] === 'JobPosting') || {};
      }
      if (data['@type'] !== 'JobPosting') continue;

      const title = (data.title || '').trim();
      if (!title) continue;

      const company = (data.hiringOrganization?.name || '').trim();

      const locArr = Array.isArray(data.jobLocation) ? data.jobLocation : [data.jobLocation];
      const addr = locArr[0]?.address || {};
      const location = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
        .filter(Boolean).join(', ');
      const isRemote = data.jobLocationType === 'TELECOMMUTE'
        || locArr.some(l => l?.jobLocationType === 'TELECOMMUTE')
        || /remote/i.test(location);

      const description = stripHtml(data.description || '').slice(0, 5000);
      return { title, company, location, isRemote, description };
    } catch {}
  }
  return null;
}

function extractFromMeta(html) {
  const meta = prop => {
    const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${prop}["'][^>]+content=["']([^"']*?)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+(?:name|property)=["']${prop}["']`, 'i'));
    return m ? m[1].trim() : '';
  };
  const h1m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = meta('og:title') || (h1m ? stripHtml(h1m[1]).trim() : '');
  if (!title) return null;
  return { title, company: meta('og:site_name'), location: '', isRemote: false, description: meta('og:description') };
}

async function scrapeJobPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return extractFromJsonLd(html) || extractFromMeta(html);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── GitHub read/write (mirrors scanner/persistJobs.mjs) ───────────────────────

async function loadJobStatus(githubToken, owner, repo) {
  const { exists, content } = await readGithubFile(githubToken, owner, repo, 'data/job-status.json');
  if (!exists) return { jobs: {} };
  return JSON.parse(content);
}

// Field-safe add: re-read job-status.json on every attempt and set only THIS entry,
// so a concurrent status change to a different job (dashboard or scanner) is
// preserved rather than erased by a stale whole-file overwrite.
async function addJobRecord(githubToken, owner, repo, fingerprint, jobRecord) {
  const commitSha = await writeGithubFile(
    githubToken, owner, repo, 'data/job-status.json',
    (current) => {
      const doc = current ? JSON.parse(current) : { jobs: {} };
      if (!doc.jobs) doc.jobs = {};
      doc.jobs[fingerprint] = jobRecord; // add/replace only this job
      return JSON.stringify(doc, null, 2);
    },
    'chore: add manual job entry [skip ci]',
    { logTag: 'add-job' },
  );
  console.log(`[add-job] job-status.json updated (commit: ${commitSha})`);
}

// ── Stable fingerprint for manual entries ────────────────────────────────────

function buildFingerprint(url, company, title) {
  const norm = s => (s || '').toLowerCase().replace(/\W+/g, '').slice(0, 40);
  if (url) {
    try {
      const u = new URL(url);
      const slug = u.pathname.replace(/\/$/, '').split('/').pop().slice(0, 40) || norm(title);
      return `manual::${norm(u.hostname)}::${slug}`;
    } catch {}
  }
  return `manual::${norm(company)}::${norm(title)}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Auth — same pattern as api/jobs.js
  const password = process.env.DASHBOARD_PASSWORD;
  const headerPw = req.headers['x-dashboard-password'];
  if (!password || !headerPw || !safeEqual(headerPw, password)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const { mode } = body;

  // ── Scrape mode: fetch URL server-side and extract fields ─────────────────
  if (mode === 'scrape') {
    const { url } = body;
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
    try {
      const fields = await scrapeJobPage(url);
      if (!fields?.title) {
        return res.status(200).json({ ok: false, error: 'Could not extract job fields (page may be JS-rendered or require login)' });
      }
      return res.status(200).json({ ok: true, ...fields });
    } catch (err) {
      console.error('[add-job] scrape error:', err);
      return res.status(200).json({ ok: false, error: 'Could not fetch the job page. Please try again or paste the details manually.' });
    }
  }

  // ── Add mode: validate, score, and persist ────────────────────────────────
  if (mode !== 'add') {
    return res.status(400).json({ error: 'mode must be "scrape" or "add"' });
  }

  const { url, title, company, location, description, forceAdd } = body;
  if (!title?.trim())       return res.status(400).json({ error: 'title is required' });
  if (!company?.trim())     return res.status(400).json({ error: 'company is required' });
  if (!description?.trim()) return res.status(400).json({ error: 'description is required for scoring' });

  const githubToken = process.env.GH_TOKEN;
  const githubRepo  = process.env.GH_REPO;
  if (!githubToken) return res.status(500).json({ error: 'GH_TOKEN not configured' });

  const [owner, repo] = githubRepo.split('/');
  let jobStatus;
  try {
    jobStatus = await loadJobStatus(githubToken, owner, repo);
  } catch (err) {
    console.error('[add-job] Failed to load job-status.json:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
  if (!jobStatus.jobs) jobStatus.jobs = {};

  // Duplicate URL check
  if (url) {
    const dup = Object.entries(jobStatus.jobs).find(([, j]) => j.url && j.url === url);
    if (dup && !forceAdd) {
      const [dupId, dupJob] = dup;
      return res.status(200).json({
        alreadyExists: true,
        existingFingerprint: dupId,
        existingJob: { title: dupJob.title, company: dupJob.company, status: dupJob.status, score: dupJob.score },
      });
    }
  }

  // Build job object for scoring
  const job = {
    title:    title.trim(),
    company:  company.trim(),
    location: sanitizeLocation(location || ''),
    isRemote: /remote/i.test(location || ''),
    url:      url || null,
    description: description.trim(),
    source: 'manual',
    portalCategory: null,
  };

  const scoringConfig = { anthropicApiKey: process.env.ANTHROPIC_API_KEY };

  // Stage 1 — Haiku hard filter (fail-open: always pass to Stage 2 for manual jobs)
  let stage1Filtered = false;
  let stage1Reason   = '';
  if (scoringConfig.anthropicApiKey) {
    const s1 = await haikuHardFilter(job, scoringConfig);
    if (!s1.pass) {
      stage1Filtered = true;
      stage1Reason   = s1.reason;
      console.log(`[add-job] Stage 1 flagged (${s1.reasonCategory}): ${s1.reason} — scoring anyway (manual entry)`);
    }
  }

  // Stage 2 — Sonnet full scoring
  // Always score manual entries regardless of Stage 1 — user explicitly added this job.
  let scoreObj = {};
  if (scoringConfig.anthropicApiKey) {
    try {
      const { scoreObj: s2 } = await sonnetScore(job, scoringConfig);
      scoreObj = s2;
      console.log(`[add-job] Stage 2 score: ${s2.score} | ${s2.recommendedAction}`);
    } catch (err) {
      console.error(`[add-job] Stage 2 failed: ${err.message}`);
    }
  }

  // Persist
  const fingerprint = buildFingerprint(url, company, title);
  const jobRecord = {
    status:    'new',
    firstSeenAt: new Date().toISOString(),
    source:    'manual',
    company:   job.company,
    title:     job.title,
    location:  job.location,
    isRemote:  job.isRemote,
    url:       job.url,
    score:             scoreObj.score          ?? null,
    aiExposureRisk:    scoreObj.aiExposureRisk || null,
    aiExposureRationale: scoreObj.aiExposureRationale || null,
    jobType:           scoreObj.jobType        || classifyJobType(job),
    whyFit:            scoreObj.whyFit         || [],
    watchOuts:         scoreObj.watchOuts      || [],
    recommendedAction: scoreObj.recommendedAction || '',
    seniority:         scoreObj.seniority      || 'unclear',
    oneLineSummary:    scoreObj.oneLineSummary || '',
    companyDescription: scoreObj.companyDescription || '',
    description:       description.trim().slice(0, 3000),
    fundingSnapshot:   null,
  };

  try {
    await addJobRecord(githubToken, owner, repo, fingerprint, jobRecord);
  } catch (err) {
    console.error('[add-job] Failed to write job-status.json:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  return res.status(200).json({
    ok:             true,
    fingerprint,
    score:          jobRecord.score,
    stage1Filtered,
    stage1Reason,
    job:            jobRecord,
  });
}
