import { esc, safeUrl } from './html.mjs';
import { signActionToken } from '../lib/auth.mjs';

function sanitizeLocation(str) {
  if (!str) return '';
  // Strip non-ASCII characters (emoji, non-Latin scripts, etc.)
  return str.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

function actionUrl(jobId, status) {
  const base = process.env.VERCEL_URL || 'http://localhost:3000';
  const ts = Math.floor(Date.now() / 1000);
  const token = signActionToken(jobId, status, ts);
  return `${base}/api/action?jobId=${encodeURIComponent(jobId)}&status=${status}&token=${token}&ts=${ts}`;
}

export async function sendDigest(jobs, config) {
  if (!config.sendgridApiKey) {
    console.warn('SendGrid API key not set -- printing digest to console');
    console.log(buildTextDigest(jobs));
    return;
  }

  const { subject, html, text } = buildEmail(jobs);

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

function buildEmail(jobs) {
  // Filter out jobs that already have a non-'new' status in the pipeline
  // (saved, preparing, applied, etc.) so they aren't re-emailed on re-scan.
  const beforeStatusFilter = jobs.length;
  jobs = jobs.filter(j => !j.status || j.status === 'new');
  if (jobs.length < beforeStatusFilter) {
    console.log(`[notify] Status filter: removed ${beforeStatusFilter - jobs.length} job(s) with non-'new' pipeline status`);
  }

  jobs = dedupByTitle(jobs);
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = `JobBud — ${jobs.length} new match${jobs.length !== 1 ? 'es' : ''} · ${dateStr}`;

  // Score distribution debug
  console.log('[notify] Score distribution before section filtering:');
  jobs.forEach(j => console.log(`  ${j.score?.toFixed(2) ?? 'null'} | ${j.jobType ?? 'unknown'} | ${j.company} — ${j.title}`));

  // Buckets recalibrated alongside the two-stage scorer (June 2026):
  // Apply Now >=4.5, Worth a Look 3.8-4.4. Raised from the old >=4.0 / 3.5-3.9
  // because the recalibrated rubric spreads scores higher and the old floor put
  // ~39 jobs in Apply Now. Target Apply Now volume is ~5-8 per scan.
  const bucket1 = jobs.filter(j => j.score >= 4.5);
  const bucket2 = jobs.filter(j => j.score >= 3.8 && j.score < 4.5);
  const bucket3 = jobs.filter(j => j.score >= 3.0 && j.score < 3.8);
  const bucketBelow = jobs.filter(j => j.score < 3.0);
  console.log(`[notify] Score buckets — >=4.5: ${bucket1.length} | 3.8-4.4: ${bucket2.length} | 3.0-3.79: ${bucket3.length} | <3.0: ${bucketBelow.length}`);

  console.log(`[notify] Score buckets: ${bucket1.length} jobs >=4.5, ${bucket2.length} jobs 3.8-4.4, ${bucket3.length} jobs 3.0-3.79, ${bucketBelow.length} jobs below 3.0`);
  console.log(`[notify] minScoreToIncludeInDigest used for filtering upstream: jobs passed in already filtered`);

  const topJobs = bucket1;
  const reviewJobs = bucket2;
  const investingJobs = jobs.filter(j => j.jobType === 'investing' && j.score >= 3.5);

  console.log(`[notify] Sections — Apply Now: ${topJobs.length}, Worth a Look: ${reviewJobs.length}, Investing: ${investingJobs.length}`);

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
  .card.investing { border-left: 3px solid #6366f1; }
  .title { font-size: 16px; font-weight: 600; margin: 0 0 2px; }
  .title a { color: #1a1a1a; text-decoration: none; }
  .meta { font-size: 13px; color: #666; margin: 0 0 4px; }
  .company-desc { font-size: 12px; color: #9ca3af; margin: 0 0 10px; font-style: italic; }
  .funding { font-size: 12px; color: #6366f1; margin-bottom: 8px; }
  .score { display: inline-block; font-weight: 700; font-size: 13px; padding: 2px 8px; border-radius: 4px; margin-right: 8px; background: #f0fdf4; color: #16a34a; }
  .score.amber { background: #fffbeb; color: #d97706; }
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
  ${investingJobs.length ? `<div class="section"><p class="label">🟣 Investing Roles (${investingJobs.length})</p>${investingJobs.map(j => card(j, 'investing')).join('')}</div>` : ''}
  <div class="footer">JobBud · Automated job digest</div>
</body></html>`;

  return { subject, html, text: buildTextDigest(jobs) };
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
  const scoreClass = type === 'investing' ? 'purple' : type === 'review' ? 'amber' : '';
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

function buildTextDigest(jobs) {
  const lines = [`JOBBUD DIGEST — ${new Date().toLocaleString()}\n`, `${jobs.length} new matches\n`, '='.repeat(60)];
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
