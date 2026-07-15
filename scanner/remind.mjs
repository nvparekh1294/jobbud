import { esc, safeUrl } from './html.mjs';
import { signActionToken } from '../lib/auth.mjs';

const GITHUB_REPO = process.env.GH_REPO;
const GITHUB_TOKEN = process.env.GH_TOKEN;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const VERCEL_URL = process.env.VERCEL_URL || 'http://localhost:3000';
const RECIPIENT_EMAIL = process.env.NOTIFICATION_EMAIL || '';

const MS_24H = 24 * 60 * 60 * 1000;
const MS_48H = 48 * 60 * 60 * 1000;
const MS_72H = 72 * 60 * 60 * 1000;
const MS_14D = 14 * 24 * 60 * 60 * 1000;
const MS_21D = 21 * 24 * 60 * 60 * 1000;

// Reminders only nag about "Act Now" jobs — score >= 4.0, the dashboard's
// primary Action Required tier. Lower-scored "Worth a Look" jobs (3.5–4.0) stay
// visible on the dashboard but are not nagged about. Jobs below the digest
// threshold never appeared at all, so the user had no chance to action them.
const MIN_SCORE_TO_REMIND = 4.0;

function actionUrl(jobId, status) {
  const ts = Math.floor(Date.now() / 1000);
  const token = signActionToken(jobId, status, ts);
  return `${VERCEL_URL}/api/action?jobId=${encodeURIComponent(jobId)}&status=${status}&token=${token}&ts=${ts}`;
}

function snoozeUrl(jobId) {
  const ts = Math.floor(Date.now() / 1000);
  const token = signActionToken(jobId, 'preparing', ts);
  return `${VERCEL_URL}/api/action?jobId=${encodeURIComponent(jobId)}&status=preparing&token=${token}&ts=${ts}&snooze=1`;
}

async function loadJobStatus() {
  const [owner, repo] = GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/data/job-status.json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return { content: { jobs: {} }, sha: null };
  if (!res.ok) throw new Error(`GitHub GET job-status.json failed: ${res.status}`);
  const data = await res.json();

  // GitHub Contents API returns content:"" for files > 1MB — fall back to download_url.
  let rawJson;
  if (data.content) {
    rawJson = Buffer.from(data.content, 'base64').toString('utf8');
    console.log('[remind] GET job-status.json: inline content');
  } else if (data.download_url) {
    console.log('[remind] GET job-status.json: file > 1MB, fetching via download_url');
    const rawRes = await fetch(data.download_url, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
    });
    if (!rawRes.ok) throw new Error(`GitHub download_url fetch failed: ${rawRes.status}`);
    rawJson = await rawRes.text();
  } else {
    throw new Error('GitHub Contents API returned neither content nor download_url');
  }

  return { content: JSON.parse(rawJson), sha: data.sha || null };
}

async function saveJobStatus(content, sha) {
  const [owner, repo] = GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/data/job-status.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'chore: auto-update job statuses [skip ci]',
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
      sha,
    }),
  });
  if (!res.ok) throw new Error(`GitHub PUT failed: ${res.status}`);
}

async function sendEmail(subject, html, text) {
  if (!SENDGRID_API_KEY) {
    console.log('[remind] No SendGrid key — printing to console');
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

function miniCard(id, job) {
  return `
    <div style="border:1px solid #e8e8e8;border-radius:8px;padding:14px 18px;margin-bottom:10px;">
      <div style="font-size:15px;font-weight:600;margin-bottom:2px;">
        <a href="${safeUrl(job.url)}" style="color:#111;text-decoration:none">${esc(job.title)}</a>
      </div>
      <div style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:4px">Score: ${typeof job.score === 'number' ? job.score.toFixed(1) : '—'}</div>
      <div style="font-size:12px;color:#888;margin-bottom:10px">${esc(job.company)} · ${esc(job.location || '')}${job.isRemote ? ' · Remote' : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a href="${actionUrl(id, 'saved')}" style="display:inline-block;padding:6px 14px;background:#eff6ff;color:#2563eb;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Save</a>
        <a href="${actionUrl(id, 'preparing')}" style="display:inline-block;padding:6px 14px;background:#111;color:white;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Prepare to Apply</a>
        <a href="${actionUrl(id, 'rejected_by_me')}" style="display:inline-block;padding:6px 14px;background:#fef2f2;color:#dc2626;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Reject</a>
      </div>
    </div>`;
}

function preparingCard(id, job) {
  return `
    <div style="border:1px solid #e8e8e8;border-left:3px solid #2563eb;border-radius:8px;padding:14px 18px;margin-bottom:10px;">
      <div style="font-size:15px;font-weight:600;margin-bottom:2px;">
        <a href="${safeUrl(job.url)}" style="color:#111;text-decoration:none">${esc(job.title)}</a>
      </div>
      <div style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:4px">Score: ${typeof job.score === 'number' ? job.score.toFixed(1) : '—'}</div>
      <div style="font-size:12px;color:#888;margin-bottom:10px">${esc(job.company)} · Started preparing ${new Date(job.preparedAt || job.statusUpdatedAt).toLocaleDateString()}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a href="${actionUrl(id, 'applied')}" style="display:inline-block;padding:6px 14px;background:#111;color:white;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">✓ I've Applied</a>
        <a href="${snoozeUrl(id)}" style="display:inline-block;padding:6px 14px;background:#eff6ff;color:#2563eb;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Snooze 24h</a>
        <a href="${actionUrl(id, 'rejected_by_me')}" style="display:inline-block;padding:6px 14px;background:#fef2f2;color:#dc2626;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Skip</a>
      </div>
    </div>`;
}

function wrap(body, title) {
  return `<!DOCTYPE html><html><head><style>
    body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a; padding: 24px; }
    h2 { font-size: 18px; margin-bottom: 8px; }
    p { font-size: 14px; color: #555; margin-bottom: 20px; }
  </style></head><body><h2>${title}</h2>${body}</body></html>`;
}

// Weekly summary moved to scanner/weeklyDigest.mjs (runs on its own Monday 9am cron).

async function _unused_sendWeeklySummary(jobs, content, sha) {
  const all = Object.values(jobs);
  const counts = {
    new: all.filter(j => !j.status || j.status === 'new').length,
    saved: all.filter(j => j.status === 'saved').length,
    preparing: all.filter(j => j.status === 'preparing').length,
    applied: all.filter(j => j.status === 'applied').length,
    interviewing: all.filter(j => j.status === 'interviewing').length,
    offer: all.filter(j => j.status === 'offer').length,
    ghosted: all.filter(j => j.status === 'ghosted').length,
    rejected_by_them: all.filter(j => j.status === 'rejected_by_them').length,
  };

  // Funnel conversion rates
  const appliedPlus = counts.applied + counts.interviewing + counts.offer + counts.ghosted + counts.rejected_by_them;
  const interviewingPlus = counts.interviewing + counts.offer;
  const preparedPlus = counts.preparing + appliedPlus;

  const savedToPrep = preparedPlus + counts.saved > 0 ? Math.round((preparedPlus / (preparedPlus + counts.saved)) * 100) : 0;
  const prepToApplied = preparedPlus > 0 ? Math.round((appliedPlus / preparedPlus) * 100) : 0;
  const appliedToInterview = appliedPlus > 0 ? Math.round((interviewingPlus / appliedPlus) * 100) : 0;
  const interviewToOffer = interviewingPlus > 0 ? Math.round((counts.offer / interviewingPlus) * 100) : 0;

  // At-risk: applied > 14 days, no movement
  const atRisk = Object.entries(jobs).filter(([, j]) => {
    if (j.status !== 'applied') return false;
    return Date.now() - new Date(j.appliedAt || j.statusUpdatedAt).getTime() > 14 * 24 * 60 * 60 * 1000;
  });

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = `JobBud Weekly Pipeline — ${dateStr}`;

  const funnelRows = [
    ['New / Unactioned', counts.new],
    ['Saved', counts.saved],
    ['Preparing', counts.preparing],
    ['Applied', counts.applied],
    ['Interviewing', counts.interviewing],
    ['Offers', counts.offer],
    ['Ghosted', counts.ghosted],
    ['Rejected by them', counts.rejected_by_them],
  ];

  const conversionRows = [
    ['Saved → Prepared', `${savedToPrep}%`],
    ['Prepared → Applied', `${prepToApplied}%`],
    ['Applied → Interview', `${appliedToInterview}%`],
    ['Interview → Offer', `${interviewToOffer}%`],
  ];

  const atRiskHtml = atRisk.length
    ? `<div style="margin-top:20px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:10px">⚠ At Risk (14+ days, no response)</div>
      ${atRisk.map(([, j]) => `<div style="font-size:13px;padding:6px 0;border-bottom:1px solid #f0f0f0"><strong>${j.company}</strong> — ${j.title}</div>`).join('')}</div>`
    : '';

  const html = `<!DOCTYPE html><html><head><style>
    body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a; }
    .header { background: #0f0f0f; color: white; padding: 20px 28px; }
    .header h1 { margin: 0; font-size: 18px; }
    .header p { margin: 4px 0 0; font-size: 12px; color: #888; }
    .section { padding: 20px 28px; border-bottom: 1px solid #f0f0f0; }
    .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 7px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5; }
    td:last-child { text-align: right; font-weight: 600; }
    .footer { padding: 16px 28px; font-size: 12px; color: #9ca3af; }
  </style></head><body>
    <div class="header"><h1>Weekly Pipeline</h1><p>${dateStr}</p></div>
    <div class="section">
      <p class="label">Funnel</p>
      <table>${funnelRows.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('')}</table>
    </div>
    <div class="section">
      <p class="label">Conversion Rates</p>
      <table>${conversionRows.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('')}</table>
      ${atRiskHtml}
    </div>
    <div class="footer">JobBud · Weekly summary</div>
  </body></html>`;

  const text = [
    `JOBBUD WEEKLY PIPELINE — ${dateStr}`,
    '',
    'FUNNEL:',
    ...funnelRows.map(([l, v]) => `  ${l}: ${v}`),
    '',
    'CONVERSION RATES:',
    ...conversionRows.map(([l, v]) => `  ${l}: ${v}`),
    atRisk.length ? `\nAT RISK (14+ days):\n${atRisk.map(([, j]) => `  ${j.company} — ${j.title}`).join('\n')}` : '',
  ].join('\n');

  await sendEmail(subject, html, text);
  console.log('[remind] Sent weekly pipeline summary');

  // Mark as sent so we don't resend today
  content.lastWeeklySummaryAt = new Date().toISOString();
}

async function sendNudgeDigest(nudgeItems) {
  const now = Date.now();
  const n = nudgeItems.length;

  const GROUP_DEFS = [
    { nudgeType: 'preparing_48h', htmlLabel: '🚨 Final nudge — preparing for 48+ hours',    textLabel: 'FINAL NUDGE — PREPARING 48+ HOURS' },
    { nudgeType: 'preparing_24h', htmlLabel: '⏰ Have you submitted? — preparing 24+ hours', textLabel: 'HAVE YOU SUBMITTED? — PREPARING 24+ HOURS' },
    { nudgeType: 'saved_48h',     htmlLabel: '🚨 Saved 48+ hours — prepare or pass',         textLabel: 'SAVED 48+ HOURS — PREPARE OR PASS' },
    { nudgeType: 'saved_24h',     htmlLabel: '⏳ Saved 24+ hours — ready to prepare?',       textLabel: 'SAVED 24+ HOURS — READY TO PREPARE?' },
  ];

  const groups = GROUP_DEFS
    .map(def => ({ ...def, items: nudgeItems.filter(x => x.nudgeType === def.nudgeType) }))
    .filter(g => g.items.length > 0);

  const dashboardUrl = `${VERCEL_URL}/dashboard`;

  const itemHtml = ({ id, job, nudgeType, sinceTs }) => {
    const days = Math.floor((now - sinceTs) / MS_24H);
    const isPreparing = nudgeType.startsWith('preparing');
    const btns = isPreparing
      ? `<a href="${actionUrl(id, 'applied')}" style="display:inline-block;padding:6px 14px;background:#111;color:white;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">✓ I've Applied</a>
         <a href="${snoozeUrl(id)}" style="display:inline-block;padding:6px 14px;background:#eff6ff;color:#2563eb;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Snooze 24h</a>
         <a href="${actionUrl(id, 'rejected_by_me')}" style="display:inline-block;padding:6px 14px;background:#fef2f2;color:#dc2626;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Skip</a>`
      : `<a href="${actionUrl(id, 'preparing')}" style="display:inline-block;padding:6px 14px;background:#111;color:white;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Prepare to Apply</a>
         <a href="${actionUrl(id, 'rejected_by_me')}" style="display:inline-block;padding:6px 14px;background:#fef2f2;color:#dc2626;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">Pass</a>`;
    return `
      <div style="border:1px solid #e8e8e8;border-radius:8px;padding:14px 18px;margin-bottom:10px;">
        <div style="font-size:15px;font-weight:600;margin-bottom:2px;">
          ${job.url ? `<a href="${safeUrl(job.url)}" style="color:#111;text-decoration:none">${esc(job.title)}</a>` : esc(job.title)}
        </div>
        <div style="font-size:12px;color:#888;margin-bottom:10px">${esc(job.company)} · ${days} day${days !== 1 ? 's' : ''} since last action</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${btns}</div>
      </div>`;
  };

  const groupsHtml = groups.map(g =>
    `<div style="margin-bottom:24px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:12px">${g.htmlLabel}</div>
      ${g.items.map(itemHtml).join('')}
    </div>`
  ).join('');

  const html = wrap(
    `<p>${n} job${n !== 1 ? 's' : ''} in your pipeline need${n === 1 ? 's' : ''} attention.</p>
    ${groupsHtml}
    <div style="margin-top:24px;border-top:1px solid #f0f0f0;padding-top:16px">
      <a href="${dashboardUrl}" style="display:inline-block;padding:10px 20px;background:#0f0f0f;color:white;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">Open Dashboard →</a>
    </div>`,
    `⚠ ${n} job${n !== 1 ? 's' : ''} need${n === 1 ? 's' : ''} your attention`
  );

  const textLines = [`JOBBUD — ${n} JOB${n !== 1 ? 'S' : ''} NEED YOUR ATTENTION`, ''];
  for (const g of groups) {
    textLines.push(g.textLabel);
    for (const { job, sinceTs } of g.items) {
      const days = Math.floor((now - sinceTs) / MS_24H);
      textLines.push(`• ${job.company} — ${job.title} (${days}d)`);
      if (job.url) textLines.push(`  ${job.url}`);
    }
    textLines.push('');
  }
  textLines.push(`Open Dashboard: ${dashboardUrl}`);

  const subject = `JobBud: ${n} job${n !== 1 ? 's' : ''} need${n === 1 ? 's' : ''} your attention`;
  await sendEmail(subject, html, textLines.join('\n'));
  console.log(`[remind] Sent nudge digest: ${n} item(s) across ${groups.length} group(s)`);
}

export async function runReminders() {
  console.log('[remind] Starting reminder check...');

  if (!GITHUB_TOKEN) {
    console.warn('[remind] GH_TOKEN not set — skipping');
    return;
  }

  const { content, sha } = await loadJobStatus();
  const jobs = content.jobs || {};
  const now = Date.now();
  let dirty = false;

  // ── 1. Auto-flag ghosted: applied > 21 days with no movement ────────────
  const newlyGhosted = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (job.status !== 'applied') continue;
    const updatedAt = new Date(job.appliedAt || job.statusUpdatedAt || job.firstSeenAt).getTime();
    if (now - updatedAt > MS_21D) {
      jobs[id].status = 'ghosted';
      jobs[id].statusUpdatedAt = new Date().toISOString();
      if (!jobs[id].statusHistory) jobs[id].statusHistory = [];
      jobs[id].statusHistory.push({ status: 'ghosted', timestamp: new Date().toISOString(), reason: 'auto-flagged after 21 days' });
      newlyGhosted.push(job);
      dirty = true;
      console.log(`[remind] Auto-ghosted: ${job.company} — ${job.title}`);
    }
  }

  // Weekly pipeline summary is handled by scanner/weeklyDigest.mjs on its
  // own Monday 9am UTC cron — not triggered here.

  if (dirty) {
    try {
      await saveJobStatus(content, sha);
      console.log('[remind] Saved status updates');
    } catch (err) {
      console.warn(`[remind] saveJobStatus failed (status updates not persisted): ${err.message}`);
      dirty = false; // prevent second save attempt below from also failing
    }
  }

  // ── 3. Notify newly ghosted jobs ─────────────────────────────────────────
  if (newlyGhosted.length > 0) {
    await sendEmail(
      `JobBud — ${newlyGhosted.length} job${newlyGhosted.length > 1 ? 's' : ''} auto-flagged as ghosted`,
      wrap(`<p>These applications haven't moved in 21+ days and have been marked as ghosted:</p>${newlyGhosted.map(j => `<div style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px"><strong>${j.company}</strong> — ${j.title}</div>`).join('')}`, '👻 Ghosted'),
      `AUTO-GHOSTED\n\n${newlyGhosted.map(j => `• ${j.company} — ${j.title}`).join('\n')}`
    );
  }

  const nudgeItems = [];

  // ── 4. Preparing reminders (collect for digest) ───────────────────────────────
  for (const [id, job] of Object.entries(jobs)) {
    if (job.status !== 'preparing') continue;

    // Skip if snoozed
    if (job.snoozedUntil && now < new Date(job.snoozedUntil).getTime()) continue;

    const preparedAt = new Date(job.preparedAt || job.statusUpdatedAt || job.firstSeenAt).getTime();
    const age = now - preparedAt;

    if (age > MS_48H) {
      // 48h+ final nudge — only once (check statusHistory)
      const alreadyNudged48 = job.statusHistory?.some(h => h.status === 'nudged_preparing_48h');
      if (!alreadyNudged48) {
        nudgeItems.push({ id, job, nudgeType: 'preparing_48h', sinceTs: preparedAt });
        job.statusHistory = job.statusHistory || [];
        job.statusHistory.push({ status: 'nudged_preparing_48h', timestamp: new Date().toISOString() });
        dirty = true;
        console.log(`[remind] Queued 48h preparing nudge: ${job.company} — ${job.title}`);
      }
    } else if (age > MS_24H) {
      // 24h nudge — only once
      const alreadyNudged24 = job.statusHistory?.some(h => h.status === 'nudged_preparing_24h');
      if (!alreadyNudged24) {
        nudgeItems.push({ id, job, nudgeType: 'preparing_24h', sinceTs: preparedAt });
        job.statusHistory = job.statusHistory || [];
        job.statusHistory.push({ status: 'nudged_preparing_24h', timestamp: new Date().toISOString() });
        dirty = true;
        console.log(`[remind] Queued 24h preparing nudge: ${job.company} — ${job.title}`);
      }
    }
  }

  if (dirty) {
    try {
      await saveJobStatus(content, sha);
    } catch (err) {
      console.warn(`[remind] saveJobStatus (preparing nudges) failed: ${err.message}`);
    }
  }

  // ── 5. Unactioned new jobs > 24h ─────────────────────────────────────────
  const unactioned24h = Object.entries(jobs).filter(([, j]) => {
    if (j.status && j.status !== 'new') return false;
    // Only nag about jobs that actually appeared in the digest. A job below
    // the score threshold was never shown, so the user had no chance to act.
    if (j.score === null || j.score === undefined || j.score < MIN_SCORE_TO_REMIND) return false;
    // Use firstSeenAt only — statusUpdatedAt is updated on every write and
    // would make jobs appear younger than they are, suppressing reminders.
    const addedAt = new Date(j.firstSeenAt).getTime();
    if (!addedAt || isNaN(addedAt)) return false;
    const ageHours = (now - addedAt) / (1000 * 60 * 60);
    console.log(`[remind] unactioned job age: ${ageHours.toFixed(1)}h — ${j.company} — ${j.title}`);
    return ageHours > 24 && ageHours <= 72;
  }).sort(([, a], [, b]) => (b.score || 0) - (a.score || 0));   // highest score first

  if (unactioned24h.length > 0) {
    const cards = unactioned24h.map(([id, job]) => miniCard(id, job)).join('');
    await sendEmail(
      `JobBud — ${unactioned24h.length} job${unactioned24h.length > 1 ? 's' : ''} waiting for a decision`,
      wrap(`<p>These jobs were surfaced more than 24 hours ago and haven't been actioned yet.</p>${cards}`, '⏰ Unactioned Jobs'),
      `REMINDER — ${unactioned24h.length} unactioned jobs:\n\n${unactioned24h.map(([, j]) => `${j.company} — ${j.title}\n${j.url}`).join('\n\n')}`
    );
    console.log(`[remind] Sent 24h reminder for ${unactioned24h.length} jobs`);
  }

  // ── 6. Escalating nag: unactioned new jobs > 72h ─────────────────────────
  // Staleness cutoff: exclude jobs older than 14 days that are ALSO completely
  // unactioned. At that age with no action they're acknowledged noise — nagging
  // indefinitely adds no value. Jobs with ANY explicit action status (saved,
  // applied, rejected, etc.) are never excluded here, regardless of age.
  const unactioned72h = Object.entries(jobs).filter(([, j]) => {
    if (j.status && j.status !== 'new') return false;
    // Same score gate as section 5 — only nag about digest-visible jobs.
    if (j.score === null || j.score === undefined || j.score < MIN_SCORE_TO_REMIND) return false;
    const seen = new Date(j.firstSeenAt).getTime();
    const age = now - seen;
    if (age > MS_14D) return false;  // both old AND unactioned — skip
    return age > MS_72H;
  }).sort(([, a], [, b]) => (b.score || 0) - (a.score || 0));   // highest score first

  if (unactioned72h.length > 0) {
    const cards = unactioned72h.map(([id, job]) => miniCard(id, job)).join('');
    await sendEmail(
      `🚨 JobBud — ${unactioned72h.length} job${unactioned72h.length > 1 ? 's' : ''} waiting 72h+ — act now`,
      wrap(`<p><strong>These jobs have been sitting unactioned for over 72 hours.</strong> Older postings attract more competition.</p>${cards}`, '🚨 Action Overdue'),
      `OVERDUE — ${unactioned72h.length} jobs waiting 72h+:\n\n${unactioned72h.map(([, j]) => `${j.company} — ${j.title}\n${j.url}`).join('\n\n')}`
    );
    console.log(`[remind] Sent 72h nag for ${unactioned72h.length} jobs`);
  }

  // ── 7. Saved but not preparing > 24h (collect for digest) ────────────────
  const savedOver24h = Object.entries(jobs).filter(([, j]) => {
    if (j.status !== 'saved') return false;
    const savedAt = new Date(j.savedAt || j.statusUpdatedAt || j.firstSeenAt).getTime();
    if (!savedAt || (now - savedAt) <= 23 * 60 * 60 * 1000) return false;
    return now - savedAt > MS_24H && now - savedAt <= MS_48H;
  });

  for (const [id, job] of savedOver24h) {
    const savedAt = new Date(job.savedAt || job.statusUpdatedAt || job.firstSeenAt).getTime();
    nudgeItems.push({ id, job, nudgeType: 'saved_24h', sinceTs: savedAt });
    console.log(`[remind] Queued 24h saved nudge: ${job.company} — ${job.title}`);
  }

  // ── 8. Saved but not preparing > 48h (collect for digest) ───────────────
  const savedOver48h = Object.entries(jobs).filter(([, j]) => {
    if (j.status !== 'saved') return false;
    const savedAt = new Date(j.statusUpdatedAt || j.firstSeenAt).getTime();
    return now - savedAt > MS_48H;
  });

  for (const [id, job] of savedOver48h) {
    const savedAt = new Date(job.statusUpdatedAt || job.firstSeenAt).getTime();
    nudgeItems.push({ id, job, nudgeType: 'saved_48h', sinceTs: savedAt });
    console.log(`[remind] Queued 48h saved nudge: ${job.company} — ${job.title}`);
  }

  // ── Send consolidated nudge digest ───────────────────────────────────────
  if (nudgeItems.length > 0) {
    await sendNudgeDigest(nudgeItems);
  }

  console.log('[remind] Reminder check complete.');
}

// Run if called directly — never exit 1 so the workflow step doesn't fail
runReminders().catch(err => {
  console.error('[remind] Failed:', err);
  // Intentionally no process.exit(1) — remind is a best-effort step
});
