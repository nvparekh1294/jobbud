import { esc, safeUrl } from './html.mjs';
import { readGithubFile } from '../lib/github.js';
import { signActionToken } from '../lib/auth.mjs';
import { fingerprint } from './dedup.mjs';

// Build the set of dedup fingerprints the owner has ENGAGED with in
// data/job-status.json, so the digest never re-emails a job already in flight —
// while still delivering genuinely-new jobs from the current run.
//
// CRITICAL ordering fact: the scanner calls persistJobs(evaluated) BEFORE
// sendDigest, and persistJobs writes every new job into job-status.json with
// status:'new'. If we treated every fingerprint-keyed record as "tracked", the
// digest would re-read the file, see this run's own just-persisted jobs, and drop
// all of them → every production digest would say "0 new matches". So a plain
// fingerprint-keyed record only counts as tracked once the owner has TOUCHED it:
// its status exists and is anything other than 'new' (saved, preparing, applied,
// interviewing, offer, rejected_by_me, rejected_by_them, position_closed, ghosted,
// withdrew, …). Untouched status:'new' records — including this run's own — are
// left out so they can reach the email. (Re-emailing previous runs' still-'new'
// jobs is prevented upstream by seen-jobs dedup, so excluding them here is safe.)
//
// `manual::…` keys are owner-ADDED (not a fingerprint), so they are tracked
// unconditionally regardless of status; each is matched by recomputing the
// fingerprint from its stored company+title (same normalization dedup uses).
export function buildTrackedFingerprintSet(jobStatusDoc) {
  const records = (jobStatusDoc && jobStatusDoc.jobs) || {};
  const set = new Set();
  for (const [key, rec] of Object.entries(records)) {
    if (key.startsWith('manual::')) {
      if (rec && (rec.company || rec.title)) {
        set.add(fingerprint({ company: rec.company, title: rec.title }));
      }
    } else if (rec && rec.status && rec.status !== 'new') {
      // Owner-engaged auto-persisted job — tracked, so it isn't re-emailed.
      set.add(key);
    }
    // else: untouched status:'new' (or status-less) record — not tracked, so a
    // genuinely-new job from this run still reaches the digest.
  }
  return set;
}

// Drop any job whose dedup fingerprint is already tracked in the dashboard.
export function dropTrackedJobs(jobs, trackedSet) {
  const kept = jobs.filter(j => !trackedSet.has(j._fingerprint));
  return { kept, dropped: jobs.length - kept.length };
}

// Load the dashboard's tracked-fingerprint set. Returns null when it can't be
// loaded (no token/repo, read failure) so the caller can fail open and still send.
async function loadTrackedFingerprintSet() {
  const githubToken = process.env.GH_TOKEN;
  const githubRepo = process.env.GH_REPO;
  if (!githubToken || !githubRepo) {
    console.warn('[notify] GH_TOKEN/GH_REPO not set — cannot load dashboard state, sending digest unfiltered');
    return null;
  }
  const [owner, repo] = githubRepo.split('/');
  // readGithubFile follows the >1MB download_url fallback (job-status.json can be large).
  const { exists, content } = await readGithubFile(githubToken, owner, repo, 'data/job-status.json');
  if (!exists) return new Set();
  return buildTrackedFingerprintSet(JSON.parse(content));
}

// Normalize a possibly-bare or scheme-prefixed VERCEL_URL into an absolute https
// base (same scheme fragility fixed in api/action.js's htmlPage). A bare
// hostname would otherwise produce a relative-looking, broken link in an email.
function actionBaseUrl() {
  const raw = process.env.VERCEL_URL || '';
  if (!raw) return 'http://localhost:3000';
  return 'https://' + raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function sanitizeLocation(str) {
  if (!str) return '';
  // Strip non-ASCII characters (emoji, non-Latin scripts, etc.)
  return str.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

function actionUrl(jobId, status) {
  const base = actionBaseUrl();
  const ts = Math.floor(Date.now() / 1000);
  const token = signActionToken(jobId, status, ts);
  return `${base}/api/action?jobId=${encodeURIComponent(jobId)}&status=${status}&token=${token}&ts=${ts}`;
}

export async function sendDigest(jobs, config) {
  // Drop jobs already tracked in the dashboard (any non-'new' status, or simply
  // already persisted) so a re-scan never re-emails an "Apply now" for a job the
  // owner has already saved/applied/rejected. Freshly-evaluated jobs never carry
  // a `.status`, which is why the in-email status filter alone is a no-op — the
  // authoritative signal lives in data/job-status.json, so we consult it here.
  // Fail open: if the dashboard state can't be read, send the digest unfiltered
  // rather than crash the scan at its last step.
  try {
    const trackedSet = await loadTrackedFingerprintSet();
    if (trackedSet) {
      const { kept, dropped } = dropTrackedJobs(jobs, trackedSet);
      if (dropped > 0) {
        console.log(`[notify] Dashboard filter: dropped ${dropped} job(s) already tracked in job-status.json`);
      }
      jobs = kept;
    }
  } catch (err) {
    console.warn(`[notify] Dashboard filter failed (${err.message}) — sending digest unfiltered`);
  }

  if (!config.sendgridApiKey) {
    console.warn('SendGrid API key not set -- printing digest to console');
    console.log(buildTextDigest(jobs));
    return;
  }

  const { subject, html, text } = buildEmail(jobs, config);

  console.log(`[notify] HTML length: ${html.length} chars, text length: ${text.length} chars`);
  if (html.length < 500) {
    console.warn('[notify] WARNING: HTML under 500 chars — possible template rendering failure');
    console.warn('[notify] HTML preview:', html.slice(0, 400));
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.sendgridApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: config.recipientEmail }] }],
      from: { email: process.env.SENDGRID_FROM_EMAIL || '', name: 'JobBud' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`SendGrid failed: ${await response.text()}`);
  }
}

function normKey(company, title) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return `${norm(company)}::${norm(title)}`;
}

// Keep only the highest-scoring entry when two jobs share the same
// normalized company+title (same job surfaced by multiple sources).
function dedupByTitle(jobs) {
  const before = jobs.length;
  const seen = new Map();
  for (const job of jobs) {
    const key = normKey(job.company, job.title);
    const existing = seen.get(key);
    if (!existing || (job.score || 0) > (existing.score || 0)) {
      seen.set(key, job);
    }
  }
  const result = Array.from(seen.values());
  console.log(`[notify] Dedup: ${before} jobs in → ${result.length} after dedup (${before - result.length} duplicate(s) removed by company+title)`);
  return result;
}

export function buildEmail(jobs, config = {}) {
  // Filter out jobs that already have a non-'new' status in the pipeline
  // (saved, preparing, applied, etc.) so they aren't re-emailed on re-scan.
  const beforeStatusFilter = jobs.length;
  jobs = jobs.filter(j => !j.status || j.status === 'new');
  if (jobs.length < beforeStatusFilter) {
    console.log(`[notify] Status filter: removed ${beforeStatusFilter - jobs.length} job(s) with non-'new' pipeline status`);
  }

  jobs = dedupByTitle(jobs);

  // Cap the emailed list at config.maxJobsPerDigest (highest scores first).
  // Everything above the cap still lives in the dashboard; the email notes how
  // many were held back so the digest stays skimmable instead of a 700-row wall.
  const cap = Number.isFinite(config.maxJobsPerDigest) ? config.maxJobsPerDigest : 20;
  jobs = [...jobs].sort((a, b) => (b.score || 0) - (a.score || 0));
  const totalMatches = jobs.length;
  let truncatedCount = 0;
  if (jobs.length > cap) {
    truncatedCount = jobs.length - cap;
    jobs = jobs.slice(0, cap);
    console.log(`[notify] Digest cap: ${totalMatches} matches → showing top ${cap} by score (${truncatedCount} held back, visible in the dashboard)`);
  }
  const moreNote = truncatedCount > 0
    ? `+${truncatedCount} more match${truncatedCount !== 1 ? 'es' : ''} in the dashboard`
    : '';

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = `JobBud — ${jobs.length} new match${jobs.length !== 1 ? 'es' : ''} · ${dateStr}`;

  // Score distribution debug
  console.log('[notify] Score distribution before section filtering:');
  jobs.forEach(j => console.log(`  ${j.score?.toFixed(2) ?? 'null'} | ${j.jobType ?? 'unknown'} | ${j.company} — ${j.title}`));

  // Buckets recalibrated alongside the two-stage scorer (June 2026):
  // Apply Now >=4.5, Worth a Look 3.8-4.4. Raised from the old >=4.0 / 3.5-3.9
  // because the recalibrated rubric spreads scores higher and the old floor put
  // too many jobs in Apply Now. Target Apply Now volume is ~5-8 per scan.
  // Assign each job to exactly ONE section so the number of rendered cards
  // always equals the subject/header count. Investing roles get their own
  // section (score floor aligned to 3.0 so none fall into a dead zone); the
  // remaining jobs partition by score into Apply Now / Worth a Look / On the
  // Radar. A final safety net sweeps up anything not yet placed (e.g. a score
  // that slips past the bucket boundaries) into On the Radar so no job that
  // counts in the subject is silently dropped from the body.
  const assigned = new Set();

  const investingJobs = jobs.filter(j => j.jobType === 'investing' && j.score >= 3.0);
  investingJobs.forEach(j => assigned.add(j));

  const topJobs = jobs.filter(j => !assigned.has(j) && j.score >= 4.5);
  topJobs.forEach(j => assigned.add(j));

  const reviewJobs = jobs.filter(j => !assigned.has(j) && j.score >= 3.8 && j.score < 4.5);
  reviewJobs.forEach(j => assigned.add(j));

  const radarByScore = jobs.filter(j => !assigned.has(j) && j.score >= 3.0 && j.score < 3.8);
  radarByScore.forEach(j => assigned.add(j));

  // Safety net: any job the buckets above missed still gets a card.
  const leftover = jobs.filter(j => !assigned.has(j));
  leftover.forEach(j => assigned.add(j));

  const radarJobs = [...radarByScore, ...leftover];

  console.log(`[notify] Sections — Apply Now: ${topJobs.length}, Worth a Look: ${reviewJobs.length}, On the Radar: ${radarJobs.length}, Investing: ${investingJobs.length}`);

  const html = `<!DOCTYPE html>
<html>
<head><style>
  body { font-family: -apple-system, sans-serif; max-width: 680px; margin: 0 auto; color: #1a1a1a; }
  .header { background: #0f0f0f; color: white; padding: 24px 32px; }
  .header h1 { margin: 0; font-size: 20px; }
  .header p { margin: 4px 0 0; font-size: 13px; color: #888; }
  .section { padding: 24px 32px; border-bottom: 1px solid #f0f0f0; }
  .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin: 0 0 16px; }
  .card { border: 1px solid #e8e8e8; border-radius: 8px; padding: 16px 20px; margin-bottom: 12px; }
  .card.top { border-left: 3px solid #22c55e; }
  .card.review { border-left: 3px solid #f59e0b; }
  .card.radar { border-left: 3px solid #3b82f6; }
  .card.investing { border-left: 3px solid #6366f1; }
  .title { font-size: 16px; font-weight: 600; margin: 0 0 2px; }
  .title a { color: #1a1a1a; text-decoration: none; }
  .meta { font-size: 13px; color: #666; margin: 0 0 4px; }
  .company-desc { font-size: 12px; color: #9ca3af; margin: 0 0 10px; font-style: italic; }
  .funding { font-size: 12px; color: #6366f1; margin-bottom: 8px; }
  .score { display: inline-block; font-weight: 700; font-size: 13px; padding: 2px 8px; border-radius: 4px; margin-right: 8px; background: #f0fdf4; color: #16a34a; }
  .score.amber { background: #fffbeb; color: #d97706; }
  .score.blue { background: #eff6ff; color: #2563eb; }
  .score.purple { background: #f5f3ff; color: #7c3aed; }
  .reasons { margin: 10px 0 0; padding: 0; list-style: none; }
  .reasons li { font-size: 13px; color: #444; padding: 2px 0; }
  .reasons li::before { content: "✓ "; color: #22c55e; }
  .watchout { font-size: 12px; color: #9ca3af; margin-top: 8px; }
  .ai-exposure { font-size: 12px; margin-top: 6px; color: #6b7280; }
  .action-btns { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { display: inline-block; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; }
  .btn-save { background: #eff6ff; color: #2563eb; }
  .btn-apply { background: #0f0f0f; color: white; }
  .btn-reject { background: #fef2f2; color: #dc2626; }
  .btn-disabled { background: #f3f4f6; color: #9ca3af; cursor: default; }
  .footer { padding: 20px 32px; font-size: 12px; color: #9ca3af; }
</style></head>
<body>
  <div class="header">
    <h1>JobBud Digest</h1>
    <p>${dateStr} · ${jobs.length} new match${jobs.length !== 1 ? 'es' : ''}</p>
  </div>
  ${topJobs.length ? `<div class="section"><p class="label">🟢 Apply Now (${topJobs.length})</p>${topJobs.map(j => card(j, 'top')).join('')}</div>` : ''}
  ${reviewJobs.length ? `<div class="section"><p class="label">🟡 Worth a Look (${reviewJobs.length})</p>${reviewJobs.map(j => card(j, 'review')).join('')}</div>` : ''}
  ${radarJobs.length ? `<div class="section"><p class="label">🔵 On the Radar (${radarJobs.length})</p>${radarJobs.map(j => card(j, 'radar')).join('')}</div>` : ''}
  ${investingJobs.length ? `<div class="section"><p class="label">🟣 Investing Roles (${investingJobs.length})</p>${investingJobs.map(j => card(j, 'investing')).join('')}</div>` : ''}
  ${moreNote ? `<div class="section"><p class="label" style="color:#6b7280">${esc(moreNote)}</p></div>` : ''}
  <div class="footer">JobBud · Automated job digest</div>
</body></html>`;

  return { subject, html, text: buildTextDigest(jobs, moreNote) };
}

function fundingLine(snapshot) {
  // Suppress bad, skipped, or unreliable data
  if (!snapshot || snapshot.skip || snapshot.unreliable) return '';
  const parts = [snapshot.round, snapshot.amount, snapshot.investors?.join(', ')].filter(Boolean);
  if (!parts.length) return '';
  const text = esc(`💰 ${parts.join(' · ')}`);
  return snapshot.sourceUrl
    ? `<div class="funding"><a href="${safeUrl(snapshot.sourceUrl)}" style="color:#6366f1;text-decoration:none">${text}</a></div>`
    : `<div class="funding">${text}</div>`;
}

function card(job, type) {
  const jobId = job._fingerprint || '';
  const scoreClass = type === 'investing' ? 'purple' : type === 'review' ? 'amber' : type === 'radar' ? 'blue' : '';
  const viewRoleBtn = job.url
    ? `<a href="${safeUrl(job.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-apply">View Role →</a>`
    : `<span class="btn btn-disabled">URL not available</span>`;

  return `<div class="card ${type}">
    <div class="title"><a href="${safeUrl(job.url)}">${esc(job.title)}</a></div>
    <div class="meta">${esc(job.company)} · ${esc(sanitizeLocation(job.location))}${job.isRemote ? ' · Remote' : ''}</div>
    ${job.companyDescription ? `<div class="company-desc">${esc(job.companyDescription)}</div>` : ''}
    ${fundingLine(job.fundingSnapshot)}
    <span class="score ${scoreClass}">${job.score?.toFixed(1)}/5.0</span>
    <span style="font-size:12px;color:#666">${esc(job.recommendedAction || '')}</span>
    ${job.whyFit?.length ? `<ul class="reasons">${job.whyFit.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${job.watchOuts?.length ? `<div class="watchout">⚠ ${esc(job.watchOuts[0])}</div>` : ''}
    ${job.aiExposureRisk ? `<div class="ai-exposure">
      ${{ low: '🟢', medium: '🟡', high: '🔴' }[job.aiExposureRisk] || '⚪'}
      AI exposure: <strong>${esc(job.aiExposureRisk)}</strong> — ${esc(job.aiExposureRationale || '')}
    </div>` : ''}
    <div style="margin-top:14px">${viewRoleBtn}</div>
    <div class="action-btns">
      <a href="${actionUrl(jobId, 'saved')}" class="btn btn-save">Save</a>
      <a href="${actionUrl(jobId, 'preparing')}" class="btn btn-apply">Prepare to Apply</a>
      <a href="${actionUrl(jobId, 'rejected_by_me')}" class="btn btn-reject">Reject</a>
    </div>
  </div>`;
}

function buildTextDigest(jobs, moreNote = '') {
  const lines = [`JOBBUD DIGEST — ${new Date().toLocaleString()}\n`, `${jobs.length} new matches\n`, '='.repeat(60)];
  if (moreNote) lines.push(moreNote, '');
  for (const job of jobs) {
    const jobId = job._fingerprint || '';
    lines.push(`\n${job.company} — ${job.title}`);
    lines.push(`Score: ${job.score?.toFixed(1)}/5.0 | ${job.recommendedAction}`);
    lines.push(`${sanitizeLocation(job.location)}${job.isRemote ? ' (Remote)' : ''} | ${job.url || 'URL not available'}`);
    if (job.companyDescription) lines.push(`About: ${job.companyDescription}`);
    if (job.fundingSnapshot) {
      const f = job.fundingSnapshot;
      const parts = [f.round, f.amount, f.investors?.join(', ')].filter(Boolean);
      if (parts.length) lines.push(`Funding: ${parts.join(' · ')}`);
    }
    if (job.whyFit?.length) lines.push(`Why: ${job.whyFit.join('; ')}`);
    if (job.watchOuts?.length) lines.push(`Watch out: ${job.watchOuts[0]}`);
    lines.push(`Save: ${actionUrl(jobId, 'saved')}`);
    lines.push(`Prepare to Apply: ${actionUrl(jobId, 'preparing')}`);
    lines.push(`Reject: ${actionUrl(jobId, 'rejected_by_me')}`);
    lines.push('-'.repeat(40));
  }
  return lines.join('\n');
}
