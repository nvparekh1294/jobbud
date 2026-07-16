import { esc, safeUrl } from './html.mjs';
import { readGithubFile, writeGithubFile } from '../lib/github.js';
import { signActionToken, actionKeySource, actionKeyFingerprint } from '../lib/auth.mjs';

const GITHUB_REPO = process.env.GH_REPO;
const GITHUB_TOKEN = process.env.GH_TOKEN;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const VERCEL_URL = process.env.VERCEL_URL || 'http://localhost:3000';
const RECIPIENT_EMAIL = process.env.NOTIFICATION_EMAIL || '';

const MS_20H = 20 * 60 * 60 * 1000;
const MS_24H = 24 * 60 * 60 * 1000;
const MS_48H = 48 * 60 * 60 * 1000;
const MS_72H = 72 * 60 * 60 * 1000;
const MS_14D = 14 * 24 * 60 * 60 * 1000;
const MS_21D = 21 * 24 * 60 * 60 * 1000;

// Per-job, per-nudge-type dedup (same statusHistory-marker style the preparing
// nudges already use). These nudges are meant to RE-nudge across days — they are
// NOT once-only — so instead of an "already nudged ever?" check we enforce a
// minimum 20h re-send interval. That preserves the intended cadence (a job can be
// re-nudged on subsequent days while it stays in the qualifying window) while
// preventing the double-send that happens when a manual dispatch and the daily
// cron run a few hours apart. Marker status strings: `nudged_<type>`.
function nudgeDue(job, markerStatus, now) {
  const marks = (job.statusHistory || [])
    .filter(h => h.status === markerStatus)
    .map(h => new Date(h.timestamp).getTime())
    .filter(t => !isNaN(t));
  if (marks.length === 0) return true;
  return (now - Math.max(...marks)) >= MS_20H;
}

function markNudged(job, markerStatus, nowIso) {
  job.statusHistory = job.statusHistory || [];
  job.statusHistory.push({ status: markerStatus, timestamp: nowIso });
}

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
  const { exists, content } = await readGithubFile(GITHUB_TOKEN, owner, repo, 'data/job-status.json');
  // This snapshot only DRIVES the run's decisions (which jobs to nudge/ghost). It is
  // never written back: saveJobStatus re-reads the current file and replays the
  // run's recorded mutations, so a stale snapshot cannot clobber concurrent writes.
  if (!exists) return { content: { jobs: {} } };
  return { content: JSON.parse(content) };
}

// The save goes through writeGithubFile's BUILDER form, never the string form. The
// old string form serialized the ENTIRE multi-megabyte document from the snapshot
// loaded once at run start, so (a) a 422 retry re-committed the same stale blob, and
// (b) even without a 422, any dashboard action committed between remind's load and
// its save was silently reverted — the same lost-update class the shared GitHub
// client closes in lib/github.js, live in the reminder path (which runs while the
// owner reads the nudge emails, the highest-collision window in the system).
//
// Instead of writing the snapshot, the run keeps a log of the SPECIFIC per-job
// mutations it makes (ghosted flags, nudge markers) as replayable closures. The
// builder callback re-reads the current file content — anchored to the write ref's
// commit sha — and re-applies ONLY those mutations on top of it, so a concurrent
// writer's change is preserved on every attempt. Same field-safe pattern as
// api/action.js's updateJobStatus.
let pendingMutations = []; // [{ id, mutate(job) }] — this run's not-yet-persisted changes

// Apply a mutation to the in-memory job (so the rest of the run sees it) AND record
// it for replay inside saveJobStatus's builder. `mutate` must be re-applicable to a
// freshly-read copy of the job: the builder runs it once per write attempt.
function applyAndRecord(id, job, mutate) {
  mutate(job);
  pendingMutations.push({ id, mutate });
}

async function saveJobStatus() {
  if (pendingMutations.length === 0) return;
  const [owner, repo] = GITHUB_REPO.split('/');
  const toPersist = pendingMutations.slice();
  await writeGithubFile(
    GITHUB_TOKEN, owner, repo, 'data/job-status.json',
    (current) => {
      const doc = current ? JSON.parse(current) : { jobs: {} };
      if (!doc.jobs) doc.jobs = {};
      for (const { id, mutate } of toPersist) {
        if (!doc.jobs[id]) doc.jobs[id] = {};
        mutate(doc.jobs[id]);
      }
      return JSON.stringify(doc, null, 2);
    },
    'chore: auto-update job statuses [skip ci]',
    { logTag: 'remind' },
  );
  // Persisted — drop exactly what this save wrote. On throw the log is kept, so a
  // later save in the same run retries these mutations alongside its own.
  pendingMutations = pendingMutations.filter(m => !toPersist.includes(m));
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
  // Action-token key diagnostics — logged once per run so a mint/verify key desync
  // can be diffed against the Vercel logs.
  console.log(`action-token key: source=${actionKeySource()} fp=${actionKeyFingerprint()}`);

  if (!GITHUB_TOKEN) {
    console.warn('[remind] GH_TOKEN not set — skipping');
    return;
  }

  const { content } = await loadJobStatus();
  const jobs = content.jobs || {};
  const now = Date.now();
  let dirty = false;
  // Fresh mutation log per run — a stale log from a previous invocation in the same
  // process (e.g. tests) must never replay into this run's saves.
  pendingMutations = [];

  // ── 1. Auto-flag ghosted: applied > 21 days with no movement ────────────
  const newlyGhosted = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (job.status !== 'applied') continue;
    const updatedAt = new Date(job.appliedAt || job.statusUpdatedAt || job.firstSeenAt).getTime();
    if (now - updatedAt > MS_21D) {
      const ghostedIso = new Date().toISOString();
      applyAndRecord(id, job, (j) => {
        j.status = 'ghosted';
        j.statusUpdatedAt = ghostedIso;
        if (!j.statusHistory) j.statusHistory = [];
        j.statusHistory.push({ status: 'ghosted', timestamp: ghostedIso, reason: 'auto-flagged after 21 days' });
      });
      newlyGhosted.push(job);
      dirty = true;
      console.log(`[remind] Auto-ghosted: ${job.company} — ${job.title}`);
    }
  }

  // Weekly pipeline summary is handled by scanner/weeklyDigest.mjs on its
  // own Monday 9am UTC cron — not triggered here.

  if (dirty) {
    try {
      await saveJobStatus();
      console.log('[remind] Saved status updates');
      dirty = false; // persisted — only re-save if a later section marks a change
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
        const stamp48 = new Date().toISOString();
        applyAndRecord(id, job, (j) => markNudged(j, 'nudged_preparing_48h', stamp48));
        dirty = true;
        console.log(`[remind] Queued 48h preparing nudge: ${job.company} — ${job.title}`);
      }
    } else if (age > MS_24H) {
      // 24h nudge — only once
      const alreadyNudged24 = job.statusHistory?.some(h => h.status === 'nudged_preparing_24h');
      if (!alreadyNudged24) {
        nudgeItems.push({ id, job, nudgeType: 'preparing_24h', sinceTs: preparedAt });
        const stamp24 = new Date().toISOString();
        applyAndRecord(id, job, (j) => markNudged(j, 'nudged_preparing_24h', stamp24));
        dirty = true;
        console.log(`[remind] Queued 24h preparing nudge: ${job.company} — ${job.title}`);
      }
    }
  }

  if (dirty) {
    try {
      await saveJobStatus();
      dirty = false; // persisted — sections 5–8 below re-set dirty only if they mark
    } catch (err) {
      console.warn(`[remind] saveJobStatus (preparing nudges) failed: ${err.message}`);
    }
  }

  // ── 5. Unactioned new jobs > 24h ─────────────────────────────────────────
  // Dedup: skip any job nudged with this type in the last 20h (see nudgeDue). The
  // job stays eligible across days while it sits in the 24–72h window, but never
  // gets a second 24h email inside 20h.
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
    return ageHours > 24 && ageHours <= 72;
  })
    .filter(([, j]) => nudgeDue(j, 'nudged_unactioned_24h', now))
    .sort(([, a], [, b]) => (b.score || 0) - (a.score || 0));   // highest score first

  // ── 6. Escalating nag: unactioned new jobs > 72h ─────────────────────────
  // Staleness cutoff: exclude jobs older than 14 days that are ALSO completely
  // unactioned. At that age with no action they're acknowledged noise — nagging
  // indefinitely adds no value. Jobs with ANY explicit action status (saved,
  // applied, rejected, etc.) are never excluded here, regardless of age.
  // Dedup: same 20h re-send floor — the 72h nag re-fires on later days, never
  // twice inside 20h.
  const unactioned72h = Object.entries(jobs).filter(([, j]) => {
    if (j.status && j.status !== 'new') return false;
    // Same score gate as section 5 — only nag about digest-visible jobs.
    if (j.score === null || j.score === undefined || j.score < MIN_SCORE_TO_REMIND) return false;
    const seen = new Date(j.firstSeenAt).getTime();
    const age = now - seen;
    if (age > MS_14D) return false;  // both old AND unactioned — skip
    return age > MS_72H;
  })
    .filter(([, j]) => nudgeDue(j, 'nudged_unactioned_72h', now))
    .sort(([, a], [, b]) => (b.score || 0) - (a.score || 0));   // highest score first

  // ── 7. Saved but not preparing > 24h (collect for digest) ────────────────
  // Dedup: 20h floor via nudgeDue, keyed to the saved_24h marker.
  const savedOver24h = Object.entries(jobs).filter(([, j]) => {
    if (j.status !== 'saved') return false;
    const savedAt = new Date(j.savedAt || j.statusUpdatedAt || j.firstSeenAt).getTime();
    if (!savedAt || (now - savedAt) <= 23 * 60 * 60 * 1000) return false;
    return now - savedAt > MS_24H && now - savedAt <= MS_48H;
  }).filter(([, j]) => nudgeDue(j, 'nudged_saved_24h', now));

  for (const [id, job] of savedOver24h) {
    const savedAt = new Date(job.savedAt || job.statusUpdatedAt || job.firstSeenAt).getTime();
    nudgeItems.push({ id, job, nudgeType: 'saved_24h', sinceTs: savedAt });
    console.log(`[remind] Queued 24h saved nudge: ${job.company} — ${job.title}`);
  }

  // ── 8. Saved but not preparing > 48h (collect for digest) ───────────────
  // Dedup: 20h floor via nudgeDue, keyed to the saved_48h marker.
  const savedOver48h = Object.entries(jobs).filter(([, j]) => {
    if (j.status !== 'saved') return false;
    const savedAt = new Date(j.statusUpdatedAt || j.firstSeenAt).getTime();
    return now - savedAt > MS_48H;
  }).filter(([, j]) => nudgeDue(j, 'nudged_saved_48h', now));

  for (const [id, job] of savedOver48h) {
    const savedAt = new Date(job.statusUpdatedAt || job.firstSeenAt).getTime();
    nudgeItems.push({ id, job, nudgeType: 'saved_48h', sinceTs: savedAt });
    console.log(`[remind] Queued 48h saved nudge: ${job.company} — ${job.title}`);
  }

  // ── Record nudge markers BEFORE any send, then persist ────────────────────
  // Mirrors the preparing-nudge ordering (mark → save → send): a job selected in
  // any of sections 5–8 gets its `nudged_<type>` marker now, so a re-run within
  // 20h (manual dispatch + daily cron) filters it out above and sends nothing.
  const nudgeNowIso = new Date().toISOString();
  for (const [id, job] of unactioned24h) { applyAndRecord(id, job, (j) => markNudged(j, 'nudged_unactioned_24h', nudgeNowIso)); dirty = true; }
  for (const [id, job] of unactioned72h) { applyAndRecord(id, job, (j) => markNudged(j, 'nudged_unactioned_72h', nudgeNowIso)); dirty = true; }
  for (const [id, job] of savedOver24h)  { applyAndRecord(id, job, (j) => markNudged(j, 'nudged_saved_24h', nudgeNowIso));      dirty = true; }
  for (const [id, job] of savedOver48h)  { applyAndRecord(id, job, (j) => markNudged(j, 'nudged_saved_48h', nudgeNowIso));      dirty = true; }

  if (dirty) {
    try {
      await saveJobStatus();
      dirty = false;
      console.log('[remind] Saved nudge markers');
    } catch (err) {
      console.warn(`[remind] saveJobStatus (nudge markers) failed: ${err.message}`);
    }
  }

  // ── Sends (after markers are persisted) ───────────────────────────────────
  if (unactioned24h.length > 0) {
    const cards = unactioned24h.map(([id, job]) => miniCard(id, job)).join('');
    await sendEmail(
      `JobBud — ${unactioned24h.length} job${unactioned24h.length > 1 ? 's' : ''} waiting for a decision`,
      wrap(`<p>These jobs were surfaced more than 24 hours ago and haven't been actioned yet.</p>${cards}`, '⏰ Unactioned Jobs'),
      `REMINDER — ${unactioned24h.length} unactioned jobs:\n\n${unactioned24h.map(([, j]) => `${j.company} — ${j.title}\n${j.url}`).join('\n\n')}`
    );
    console.log(`[remind] Sent 24h reminder for ${unactioned24h.length} jobs`);
  }

  if (unactioned72h.length > 0) {
    const cards = unactioned72h.map(([id, job]) => miniCard(id, job)).join('');
    await sendEmail(
      `🚨 JobBud — ${unactioned72h.length} job${unactioned72h.length > 1 ? 's' : ''} waiting 72h+ — act now`,
      wrap(`<p><strong>These jobs have been sitting unactioned for over 72 hours.</strong> Older postings attract more competition.</p>${cards}`, '🚨 Action Overdue'),
      `OVERDUE — ${unactioned72h.length} jobs waiting 72h+:\n\n${unactioned72h.map(([, j]) => `${j.company} — ${j.title}\n${j.url}`).join('\n\n')}`
    );
    console.log(`[remind] Sent 72h nag for ${unactioned72h.length} jobs`);
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
