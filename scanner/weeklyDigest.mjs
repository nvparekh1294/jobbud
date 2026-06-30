// scanner/weeklyDigest.mjs
import { sendWeeklyTelegram } from './telegram.mjs';
// Runs every Monday at 9am UTC via .github/workflows/scan.yml
// Sends a weekly pipeline summary email with funnel stats, activity trends,
// stale-saved nudges, and at-risk applied jobs.

const GITHUB_REPO = process.env.GH_REPO;
const GITHUB_TOKEN = process.env.GH_TOKEN;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const RECIPIENT_EMAIL = process.env.NOTIFICATION_EMAIL || '';

const MS_DAY  = 24 * 60 * 60 * 1000;
const MS_5D   =  5 * MS_DAY;
const MS_7D   =  7 * MS_DAY;
const MS_14D  = 14 * MS_DAY;

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function loadJobStatus() {
  const [owner, repo] = GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/data/job-status.json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return { jobs: {} };
  if (!res.ok) throw new Error(`GitHub GET job-status.json failed: ${res.status} — ${await res.text()}`);
  const data = await res.json();

  // GitHub Contents API returns content:"" for files > 1MB — fall back to download_url.
  let rawJson;
  if (data.content) {
    rawJson = Buffer.from(data.content, 'base64').toString('utf8');
    console.log('[weeklyDigest] GET job-status.json: inline content');
  } else if (data.download_url) {
    console.log('[weeklyDigest] GET job-status.json: file > 1MB, fetching via download_url');
    const rawRes = await fetch(data.download_url, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
    });
    if (!rawRes.ok) throw new Error(`GitHub download_url fetch failed: ${rawRes.status}`);
    rawJson = await rawRes.text();
  } else {
    throw new Error('GitHub Contents API returned neither content nor download_url');
  }

  return JSON.parse(rawJson);
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendEmail(subject, html, text) {
  if (!SENDGRID_API_KEY) {
    console.log('[weeklyDigest] No SendGrid key — printing to console');
    console.log(subject);
    console.log(text);
    return;
  }
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: RECIPIENT_EMAIL }] }],
      from: { email: process.env.SENDGRID_FROM_EMAIL || '', name: 'JobBud' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
  });
  if (!res.ok) throw new Error(`SendGrid failed: ${await res.text()}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function trend(thisWeek, lastWeek) {
  if (lastWeek === 0) return thisWeek > 0 ? ' (↑ new)' : '';
  const delta = thisWeek - lastWeek;
  if (delta > 0) return ` (↑ ${delta} vs last week)`;
  if (delta < 0) return ` (↓ ${Math.abs(delta)} vs last week)`;
  return ' (same as last week)';
}

function daysSince(isoStr) {
  if (!isoStr) return null;
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / MS_DAY);
}

function appliedCard(id, job) {
  const days = daysSince(job.appliedAt || job.statusUpdatedAt);
  return `
    <div style="border:1px solid #e8e8e8;border-left:3px solid #dc2626;border-radius:8px;padding:12px 18px;margin-bottom:8px;">
      <div style="font-size:14px;font-weight:600">${job.company} — ${job.title}</div>
      <div style="font-size:12px;color:#888;margin-top:2px">Applied ${days != null ? `${days} days ago` : 'unknown date'} · No response yet</div>
    </div>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runWeeklyDigest() {
  console.log('[weeklyDigest] Starting...');

  if (!GITHUB_TOKEN) {
    console.warn('[weeklyDigest] GH_TOKEN not set — skipping');
    return;
  }

  const content = await loadJobStatus();
  const jobs = content.jobs || {};
  const now = Date.now();
  const all = Object.entries(jobs);

  // ── Funnel counts ───────────────────────────────────────────────────────────
  const count = (status) => all.filter(([, j]) => j.status === status).length;
  const counts = {
    new:              all.filter(([, j]) => !j.status || j.status === 'new').length,
    saved:            count('saved'),
    preparing:        count('preparing'),
    applied:          count('applied'),
    interviewing:     count('interviewing'),
    offer:            count('offer'),
    ghosted:          count('ghosted'),
    rejected_by_them: count('rejected_by_them'),
  };

  // ── Conversion rates ────────────────────────────────────────────────────────
  const appliedTotal   = counts.applied + counts.interviewing + counts.offer + counts.ghosted + counts.rejected_by_them;
  const interviewTotal = counts.interviewing + counts.offer;
  const preparedTotal  = counts.preparing + appliedTotal;
  const rate = (n, d) => d > 0 ? `${Math.round((n / d) * 100)}%` : '—';

  // ── Activity: this week vs last week ────────────────────────────────────────
  const addedThisWeek = all.filter(([, j]) => {
    if (!j.firstSeenAt) return false;
    return now - new Date(j.firstSeenAt).getTime() < MS_7D;
  }).length;

  const addedLastWeek = all.filter(([, j]) => {
    if (!j.firstSeenAt) return false;
    const age = now - new Date(j.firstSeenAt).getTime();
    return age >= MS_7D && age < 2 * MS_7D;
  }).length;

  // ── Stale saved: saved > 5 days, no action ──────────────────────────────────
  const staleSaved = all.filter(([, j]) => {
    if (j.status !== 'saved') return false;
    const savedAt = new Date(j.statusUpdatedAt || j.firstSeenAt).getTime();
    return now - savedAt > MS_5D;
  }).sort(([, a], [, b]) => {
    const aAge = now - new Date(a.statusUpdatedAt || a.firstSeenAt).getTime();
    const bAge = now - new Date(b.statusUpdatedAt || b.firstSeenAt).getTime();
    return bAge - aAge; // oldest first
  });

  // ── At risk: applied > 14 days ──────────────────────────────────────────────
  const atRisk = all.filter(([, j]) => {
    if (j.status !== 'applied') return false;
    const appliedAt = new Date(j.appliedAt || j.statusUpdatedAt || j.firstSeenAt).getTime();
    return now - appliedAt > MS_14D;
  });

  // ── Build email ─────────────────────────────────────────────────────────────
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = `JobBud Weekly Pipeline — ${dateStr}`;

  const section = (label, body) =>
    `<div style="padding:20px 28px;border-bottom:1px solid #f0f0f0">
      <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888;margin:0 0 12px">${label}</p>
      ${body}
    </div>`;

  const table = (rows) =>
    `<table style="width:100%;border-collapse:collapse">
      ${rows.map(([l, v, note]) =>
        `<tr>
          <td style="padding:7px 0;font-size:13px;border-bottom:1px solid #f5f5f5;color:#444">${l}</td>
          <td style="padding:7px 0;font-size:13px;border-bottom:1px solid #f5f5f5;text-align:right;font-weight:700">${v}${note ? `<span style="font-size:11px;color:#9ca3af;font-weight:400"> ${note}</span>` : ''}</td>
        </tr>`
      ).join('')}
    </table>`;

  // Resolve card HTML for stale saved (async due to crypto import)
  const crypto = await import('crypto');
  const VERCEL_URL = process.env.VERCEL_URL || 'http://localhost:3000';
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
  const tok = (id, status, ts) => crypto.default
    .createHmac('sha256', DASHBOARD_PASSWORD)
    .update(id + status + ts).digest('hex').slice(0, 16);
  const actionUrl = (id, status) => {
    const ts = Math.floor(Date.now() / 1000);
    return `${VERCEL_URL}/api/action?jobId=${encodeURIComponent(id)}&status=${status}&token=${tok(id, status, ts)}&ts=${ts}`;
  };

  const staleSavedHtml = staleSaved.map(([id, job]) => {
    const days = daysSince(job.statusUpdatedAt || job.firstSeenAt);
    return `
      <div style="border:1px solid #e8e8e8;border-left:3px solid #f59e0b;border-radius:8px;padding:14px 18px;margin-bottom:10px;">
        <div style="font-size:14px;font-weight:600;margin-bottom:2px;">
          <a href="${job.url || '#'}" style="color:#111;text-decoration:none">${job.title}</a>
        </div>
        <div style="font-size:12px;color:#888;margin-bottom:10px">${job.company}${days != null ? ` · Saved ${days} days ago` : ''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <a href="${actionUrl(id, 'preparing')}" style="display:inline-block;padding:6px 14px;background:#111;color:white;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Prepare to Apply</a>
          <a href="${actionUrl(id, 'rejected_by_me')}" style="display:inline-block;padding:6px 14px;background:#fef2f2;color:#dc2626;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Pass</a>
        </div>
      </div>`;
  }).join('');

  const atRiskHtml = atRisk.map(([id, job]) => {
    const days = daysSince(job.appliedAt || job.statusUpdatedAt);
    return `
      <div style="border:1px solid #e8e8e8;border-left:3px solid #dc2626;border-radius:8px;padding:12px 18px;margin-bottom:8px;">
        <div style="font-size:14px;font-weight:600">${job.company} — ${job.title}</div>
        <div style="font-size:12px;color:#888;margin-top:2px">Applied ${days != null ? `${days} days ago` : 'unknown date'} · Consider following up</div>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;padding:0">
    <div style="background:#0f0f0f;color:white;padding:20px 28px">
      <h1 style="margin:0;font-size:18px">Weekly Pipeline</h1>
      <p style="margin:4px 0 0;font-size:12px;color:#888">${dateStr}</p>
    </div>

    ${section('📊 Pipeline', table([
      ['New / Unactioned',  counts.new],
      ['Saved',             counts.saved],
      ['Preparing',         counts.preparing],
      ['Applied',           counts.applied],
      ['Interviewing',      counts.interviewing],
      ['Offers',            counts.offer],
      ['Ghosted',           counts.ghosted],
      ['Rejected by them',  counts.rejected_by_them],
    ]))}

    ${section('📈 Activity', table([
      ['New jobs this week', addedThisWeek, trend(addedThisWeek, addedLastWeek)],
      ['New jobs last week', addedLastWeek],
    ]) + table([
      ['Saved → Prepared',   rate(preparedTotal,  preparedTotal + counts.saved)],
      ['Prepared → Applied', rate(appliedTotal,   preparedTotal)],
      ['Applied → Interview',rate(interviewTotal, appliedTotal)],
      ['Interview → Offer',  rate(counts.offer,   interviewTotal)],
    ]))}

    ${staleSaved.length ? section(
      `⏰ Saved 5+ Days — Time to Decide (${staleSaved.length})`,
      `<p style="font-size:13px;color:#555;margin:0 0 14px">These roles have been sitting saved for over 5 days. Prepare to apply or pass.</p>${staleSavedHtml}`
    ) : ''}

    ${atRisk.length ? section(
      `⚠ Applied 14+ Days — No Response (${atRisk.length})`,
      `<p style="font-size:13px;color:#555;margin:0 0 14px">These applications are getting stale. Consider a follow-up or flag as ghosted.</p>${atRiskHtml}`
    ) : ''}

    <div style="padding:16px 28px;font-size:12px;color:#9ca3af">JobBud · Weekly summary</div>
  </body></html>`;

  const textLines = [
    `JOBBUD WEEKLY PIPELINE — ${dateStr}`,
    '',
    'PIPELINE:',
    `  New / Unactioned: ${counts.new}`,
    `  Saved: ${counts.saved}`,
    `  Preparing: ${counts.preparing}`,
    `  Applied: ${counts.applied}`,
    `  Interviewing: ${counts.interviewing}`,
    `  Offers: ${counts.offer}`,
    `  Ghosted: ${counts.ghosted}`,
    `  Rejected by them: ${counts.rejected_by_them}`,
    '',
    'ACTIVITY:',
    `  New jobs this week: ${addedThisWeek}${trend(addedThisWeek, addedLastWeek)}`,
    `  New jobs last week: ${addedLastWeek}`,
    '',
    'CONVERSION RATES:',
    `  Saved → Prepared: ${rate(preparedTotal, preparedTotal + counts.saved)}`,
    `  Prepared → Applied: ${rate(appliedTotal, preparedTotal)}`,
    `  Applied → Interview: ${rate(interviewTotal, appliedTotal)}`,
    `  Interview → Offer: ${rate(counts.offer, interviewTotal)}`,
  ];

  if (staleSaved.length) {
    textLines.push('', `SAVED 5+ DAYS (${staleSaved.length}):`,
      ...staleSaved.map(([, j]) => `  ${j.company} — ${j.title} (${daysSince(j.statusUpdatedAt || j.firstSeenAt)} days)`));
  }

  if (atRisk.length) {
    textLines.push('', `APPLIED 14+ DAYS — NO RESPONSE (${atRisk.length}):`,
      ...atRisk.map(([, j]) => `  ${j.company} — ${j.title} (${daysSince(j.appliedAt || j.statusUpdatedAt)} days)`));
  }

  await sendEmail(subject, html, textLines.join('\n'));
  console.log(`[weeklyDigest] Sent — ${staleSaved.length} stale saved, ${atRisk.length} at-risk applied`);

  // Telegram weekly summary
  try {
    const appliedPlusBeyond = counts.applied + counts.interviewing + counts.offer + counts.ghosted + counts.rejected_by_them;
    const interviewPlusBeyond = counts.interviewing + counts.offer;
    const responseRate = appliedPlusBeyond > 0 ? Math.round((interviewPlusBeyond / appliedPlusBeyond) * 100) : null;
    await sendWeeklyTelegram({
      counts,
      staleSavedCount: staleSaved.length,
      responseRate,
    });
  } catch (err) {
    console.warn(`[weeklyDigest] Telegram notify failed: ${err.message}`);
  }
}

// Run when called directly — never exit 1 so the workflow step doesn't fail
const isMain = process.argv[1] && process.argv[1].includes('weeklyDigest');
if (isMain) {
  runWeeklyDigest().catch(err => {
    console.error('[weeklyDigest] Fatal:', err);
    // Intentionally no process.exit(1) — weekly digest is a best-effort step
  });
}
