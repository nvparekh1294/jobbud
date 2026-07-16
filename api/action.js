import { generateAndSendPackage } from '../scanner/applicationPackage.mjs';
import { esc } from '../scanner/html.mjs';
import { readGithubFile, writeGithubFile } from '../lib/github.js';
import { safeEqual, verifyActionToken, actionTokenSecret, actionKeySource, actionKeyFingerprint } from '../lib/auth.mjs';

const VALID_STATUSES = [
  'saved',
  'preparing',
  'applied',
  'interviewing',
  'offer',
  'rejected_by_me',
  'rejected_by_them',
  'ghosted',
  'withdrew',
  'position_closed',
  // Pseudo-status: logs an outreach contact onto the job WITHOUT changing its
  // real status (handled specially below — see the reached_out_logged branch).
  'reached_out_logged',
];

const STATUS_MESSAGES = {
  saved: (company, title) => `
    <h1>✓ Saved!</h1>
    <p><strong>${title}</strong> at <strong>${company}</strong> has been saved to your pipeline.</p>
    <p>When you're ready, click <strong>Prepare to Apply</strong> in the digest to generate your tailored package.</p>
  `,
  preparing: (company, title) => `
    <h1>📋 Preparing...</h1>
    <p>Generating your tailored resume and application package for <strong>${title}</strong> at <strong>${company}</strong>.</p>
    <p>You'll receive an email with your package shortly.</p>
  `,
  applied: (company, title) => `
    <h1>🚀 Applied!</h1>
    <p>Logged your application to <strong>${title}</strong> at <strong>${company}</strong>.</p>
    <p>JobBud will follow up in <strong>21 days</strong> if you haven't heard back.</p>
  `,
  interviewing: (company, title) => `
    <h1>🎯 Interview logged!</h1>
    <p><strong>${title}</strong> at <strong>${company}</strong> is now in the Interview stage.</p>
    <p>Good luck — let JobBud know how it goes.</p>
  `,
  offer: (company, title) => `
    <h1>🎉 Offer received!</h1>
    <p>Congratulations on the offer for <strong>${title}</strong> at <strong>${company}</strong>!</p>
    <p>This has been logged in your pipeline.</p>
  `,
  rejected_by_me: (company, title) => `
    <h1>👋 Passed</h1>
    <p>You've passed on <strong>${title}</strong> at <strong>${company}</strong>.</p>
    <p>This job has been archived and won't appear in future digests.</p>
  `,
  rejected_by_them: (company, title) => `
    <h1>📭 Rejection logged</h1>
    <p>Logged rejection for <strong>${title}</strong> at <strong>${company}</strong>.</p>
    <p>Onwards — JobBud will keep surfacing better fits.</p>
  `,
  ghosted: (company, title) => `
    <h1>👻 Marked as ghosted</h1>
    <p><strong>${title}</strong> at <strong>${company}</strong> has been marked as ghosted.</p>
    <p>This has been moved to your archive.</p>
  `,
  withdrew: (company, title) => `
    <h1>🚪 Withdrew</h1>
    <p>You've withdrawn from <strong>${title}</strong> at <strong>${company}</strong>.</p>
    <p>This has been moved to your archive — it is not counted as a rejection.</p>
  `,
  position_closed: (company, title) => `
    <h1>🔒 Position closed</h1>
    <p><strong>${title}</strong> at <strong>${company}</strong> was taken down or filled before you applied.</p>
    <p>This has been moved to your archive — it is not counted as a rejection.</p>
  `,
};

const SNOOZE_MESSAGE = (company, title) => `
  <h1>⏰ Snoozed 24h</h1>
  <p>Got it. JobBud will nudge you tomorrow about <strong>${title}</strong> at <strong>${company}</strong>.</p>
`;

// Email-action tokens carry a Unix timestamp (seconds) so they can expire.
// Signing/verification — the 72h expiry, future-ts rejection, widened digest,
// constant-time compare, and the dedicated ACTION_TOKEN_SECRET (falling back to
// DASHBOARD_PASSWORD) — live in ../lib/auth.mjs so the generators that mint tokens
// and this verifier can never drift apart.

async function getJobStatus(githubToken, owner, repo) {
  const { exists, content } = await readGithubFile(githubToken, owner, repo, 'data/job-status.json');
  if (!exists) throw new Error('GitHub GET failed: data/job-status.json not found (404)');
  return { content: JSON.parse(content) };
}

// Field-safe update of a single job in job-status.json.
// `applyChange(job)` mutates only the target job's fields. The write goes through
// writeGithubFile's builder form, which re-reads the file on every attempt and
// re-applies applyChange on top of the current data — so a concurrent status
// change to a DIFFERENT job (from the scanner or another dashboard action) is
// preserved rather than erased by a stale whole-file overwrite.
async function updateJobStatus(githubToken, owner, repo, jobId, applyChange) {
  await writeGithubFile(
    githubToken, owner, repo, 'data/job-status.json',
    (current) => {
      const doc = current ? JSON.parse(current) : { jobs: {} };
      if (!doc.jobs) doc.jobs = {};
      if (!doc.jobs[jobId]) doc.jobs[jobId] = {};
      applyChange(doc.jobs[jobId]);
      return JSON.stringify(doc, null, 2);
    },
    'chore: update job status [skip ci]',
    { logTag: 'action' },
  );
}

function htmlPage(title, body, isError = false) {
  // VERCEL_URL may be a bare hostname (Vercel's system var) or already include a
  // scheme (if set manually). Normalize to an absolute https URL; fall back to a
  // relative /dashboard link when it's unset so the anchor never points at a bad host.
  const rawHost = (process.env.VERCEL_URL || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const dashboardHref = rawHost ? `https://${rawHost}/dashboard` : '/dashboard';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JobBud — ${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f9f9f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: white; border-radius: 12px; padding: 40px 48px; max-width: 480px; width: 100%; box-shadow: 0 2px 16px rgba(0,0,0,0.08); text-align: center; }
    h1 { font-size: 28px; margin-bottom: 16px; color: ${isError ? '#dc2626' : '#111'}; }
    p { font-size: 15px; color: #555; line-height: 1.6; margin-bottom: 10px; }
    a { display: inline-block; margin-top: 20px; padding: 10px 24px; background: #111; color: white; text-decoration: none; border-radius: 8px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
    <a href="${dashboardHref}" style="display:inline-block;margin-top:12px;padding:10px 24px;background:#1a1a1a;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;">Back to Dashboard</a>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  // /api/action is a state-changing endpoint reached by GET (email action links).
  // Mark every response uncacheable so a click always hits the handler and mutates
  // state, and so a confirmation page is never re-served from cache. Set once at the
  // top so ALL paths inherit it — the 403/400 guards, the JSON dashboard responses,
  // and the htmlPage confirmations.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  const { jobId, status, token, ts, snooze } = req.query;

  const password = process.env.DASHBOARD_PASSWORD;
  const githubToken = process.env.GH_TOKEN;
  const githubRepo = process.env.GH_REPO;

  if (!githubRepo) {
    return res.status(500).send(htmlPage('Error', '<h1>⚠ Not configured</h1><p>This action is temporarily unavailable. Please try again later.</p>', true));
  }

  const [owner, repo] = githubRepo.split('/');

  // Env-var diagnostics — visible in Vercel function logs
  console.log('[action] GH_TOKEN present:', !!githubToken);
  console.log('[action] GH_REPO:', githubRepo);
  console.log('[action] DASHBOARD_PASSWORD present:', !!password);
  console.log('[action] ANTHROPIC_API_KEY present:', !!process.env.ANTHROPIC_API_KEY);
  console.log('[action] SENDGRID_API_KEY present:', !!process.env.SENDGRID_API_KEY);
  console.log('[action] jobId:', jobId, '| status:', status);

  // ── Auth ────────────────────────────────────────────────────────────────────
  // Two valid auth paths:
  //   1. X-Dashboard-Password header (dashboard fetch() calls) — no HMAC needed
  //   2. ?token= query param HMAC (email action links) — requires token in URL
  const headerPw = req.headers['x-dashboard-password'];
  const isDashboardAuth = !!(headerPw && password && safeEqual(headerPw, password));
  console.log('[action] auth method:', isDashboardAuth ? 'X-Dashboard-Password' : 'HMAC token');

  // ── Authorize FIRST — before validating or echoing any request parameter ────
  // For the email-link path, the token signs jobId+status, so a missing or
  // tampered param simply fails verification and returns Unauthorized. Tokens
  // expire after 72h and are signed with ACTION_TOKEN_SECRET (falls back to
  // DASHBOARD_PASSWORD); verification is constant-time.
  if (!isDashboardAuth) {
    if (!token || !actionTokenSecret() || !verifyActionToken(jobId, status, token, ts)) {
      // Log the verify-side key source + fingerprint (never the token or secret) so a
      // mint/verify key desync — the silent failure mode of a half-applied secret
      // rotation — is diagnosable by diffing this against the scanner's startup line.
      console.error(`action-token key: source=${actionKeySource()} fp=${actionKeyFingerprint()} jobId=${jobId}`);
      return res.status(403).send(htmlPage('Error', '<h1>⛔ Unauthorized</h1><p>This link is invalid or has expired.</p>', true));
    }
  }

  // ── Validate parameters only after auth is confirmed ────────────────────────
  if (!jobId || !status) {
    return res.status(400).send(htmlPage('Error', '<h1>⚠ Missing parameters</h1><p>This link is incomplete.</p>', true));
  }

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).send(htmlPage('Error', `<h1>⚠ Invalid status</h1><p>"${esc(status)}" is not a valid status.</p>`, true));
  }

  try {
    const { content } = await getJobStatus(githubToken, owner, repo);

    if (!content.jobs) content.jobs = {};
    if (!content.jobs[jobId]) content.jobs[jobId] = {};

    const job = content.jobs[jobId];
    const company = job.company || 'Unknown company';
    const title = job.title || 'Unknown role';
    // HTML-encoded copies for use in response markup. Keep the raw company/title
    // for non-HTML uses (email/package subject line, log messages) where encoding
    // would corrupt the value.
    const companyHtml = esc(company);
    const titleHtml = esc(title);
    const previousStatus = job.status;

    // ── Snooze handling (status=preparing&snooze=1) ──────────────────────────
    if (status === 'preparing' && snooze === '1') {
      const nowIso = new Date().toISOString();
      const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await updateJobStatus(githubToken, owner, repo, jobId, (j) => {
        j.snoozedUntil = snoozedUntil;
        j.statusUpdatedAt = nowIso;
        if (!j.statusHistory) j.statusHistory = [];
        j.statusHistory.push({ status: 'snoozed_preparing', timestamp: nowIso });
      });
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(htmlPage('Snoozed', SNOOZE_MESSAGE(companyHtml, titleHtml)));
    }

    // ── Reached-out logging (status=reached_out_logged) ──────────────────────
    // Appends a contact to job.outreachContacts WITHOUT changing the job's real
    // status — the job stays Applied / Preparing. Posted by the dashboard's
    // "Reached Out" modal with the contact details in the JSON body.
    if (status === 'reached_out_logged') {
      const b = (req.body && typeof req.body === 'object') ? req.body : {};
      const nowIso = new Date().toISOString();
      const contact = {
        name:          typeof b.name === 'string' ? b.name : '',
        role:          typeof b.role === 'string' ? b.role : '',
        dateContacted: typeof b.dateContacted === 'string' ? b.dateContacted : '',
        replyReceived: !!b.replyReceived,
        replyDate:     (b.replyReceived && typeof b.replyDate === 'string') ? b.replyDate : '',
        notes:         typeof b.notes === 'string' ? b.notes : '',
        loggedAt:      nowIso,
      };
      let savedOutreachContacts = [];
      await updateJobStatus(githubToken, owner, repo, jobId, (j) => {
        if (!Array.isArray(j.outreachContacts)) j.outreachContacts = [];
        j.outreachContacts.push(contact);
        j.lastOutreachAt = nowIso;
        if (!j.statusHistory) j.statusHistory = [];
        j.statusHistory.push({ status: 'reached_out_logged', timestamp: nowIso });
        savedOutreachContacts = j.outreachContacts;
      });

      const wantJson = (req.headers['accept'] || '').includes('application/json');
      if (wantJson) {
        return res.status(200).json({ success: true, outreachContacts: savedOutreachContacts });
      }
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(htmlPage('Logged', `<h1>📬 Logged</h1><p>Outreach to <strong>${esc(contact.name || 'a contact')}</strong> at <strong>${companyHtml}</strong> has been saved.</p>`));
    }

    // ── Normal status update ────────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const applyStatusChange = (j) => {
      j.status = status;
      j.statusUpdatedAt = nowIso;
      // Status-specific timestamps
      if (status === 'preparing') j.preparedAt = nowIso;
      if (status === 'applied') j.appliedAt = nowIso;
      if (!j.statusHistory) j.statusHistory = [];
      j.statusHistory.push({ status, timestamp: nowIso });
    };
    // Apply to the in-memory copy too, so the 'preparing' path below hands the
    // updated job to generateAndSendPackage.
    applyStatusChange(job);
    await updateJobStatus(githubToken, owner, repo, jobId, applyStatusChange);

    // ── Non-preparing statuses: GitHub write is the ONLY side effect ─────────
    // reject, save, applied, interviewing, offer, ghosted → return here, done.
    // generateAndSendPackage must NEVER be reached from any of these paths.
    if (status !== 'preparing') {
      const messageFn = STATUS_MESSAGES[status];
      const body = messageFn ? messageFn(companyHtml, titleHtml) : `<h1>✓ Updated</h1><p>Status set to <strong>${esc(status)}</strong>.</p>`;
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(htmlPage('Done', body));
    }

    // ── Only 'preparing' reaches this point ──────────────────────────────────
    // Dashboard calls (wantJson) always regenerate so the user can retry after
    // a failure (e.g. expired OAuth token). Email/browser links skip if the job
    // is already preparing to avoid accidental duplicate packages.
    const wantJson = (req.headers['accept'] || '').includes('application/json');
    if (previousStatus !== 'preparing' || wantJson) {

      // Read role-type modal selections from POST body (dashboard path)
      let roleTypes = [];
      let additionalGuidance = '';
      let applicationQuestions = '';
      let jobDescription = '';
      if (req.body && typeof req.body === 'object') {
        roleTypes = Array.isArray(req.body.roleTypes) ? req.body.roleTypes : [];
        additionalGuidance = typeof req.body.additionalGuidance === 'string' ? req.body.additionalGuidance : '';
        applicationQuestions = typeof req.body.applicationQuestions === 'string' ? req.body.applicationQuestions : '';
        jobDescription = typeof req.body.jobDescription === 'string' ? req.body.jobDescription : '';
      }
      if (jobDescription) job.description = jobDescription;
      console.log('[action] roleTypes:', roleTypes, '| additionalGuidance length:', additionalGuidance.length, '| applicationQuestions length:', applicationQuestions.length, '| jobDescription length:', jobDescription.length);

      if (wantJson) {
        // Dashboard path: run synchronously, return full package content as JSON.
        try {
          const { pkg, docUrl } = await generateAndSendPackage(job, jobId, { roleTypes, additionalGuidance, applicationQuestions });

          // Persist docUrl (and the possibly-updated description) back to
          // job-status.json as a second, field-safe commit so the dashboard can
          // link to the Google Doc from the applied status indicator.
          if (docUrl) {
            try {
              await updateJobStatus(githubToken, owner, repo, jobId, (j) => {
                j.docUrl = docUrl;
                if (jobDescription) j.description = jobDescription;
              });
              console.log(`[action] docUrl persisted for ${jobId}`);
            } catch (writeErr) {
              // Non-fatal — doc was created, URL just won't show on the dashboard
              console.error(`[action] Failed to persist docUrl for ${jobId}: ${writeErr.message}`);
            }
          }

          return res.status(200).json({
            success: true,
            docUrl: docUrl || null,
            content: {
              title: `Application Package: ${title} at ${company}`,
              resume: pkg.resume || '',
              applicationQuestions: pkg.applicationQuestions || [],
              checklist: pkg.checklist || [],
              tailoringNotes: pkg.tailoringNotes || '',
            },
          });
        } catch (err) {
          console.error(`[action] Application package failed for ${company}: ${err.message}`);
          return res.status(500).json({ success: false, error: 'Something went wrong generating the application package. Please try again.' });
        }
      } else {
        // Email / browser path: fire and forget, respond immediately
        generateAndSendPackage(job, jobId, { roleTypes, additionalGuidance, applicationQuestions }).catch(err => {
          console.error(`[action] Application package failed for ${company}: ${err.message}`);
        });
      }
    }

    const messageFn = STATUS_MESSAGES[status];
    const body = messageFn ? messageFn(companyHtml, titleHtml) : `<h1>✓ Updated</h1><p>Status set to <strong>${esc(status)}</strong>.</p>`;

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(htmlPage('Done', body));

  } catch (err) {
    console.error('Action handler error:', err);
    return res.status(500).send(htmlPage('Error', `<h1>⚠ Something went wrong</h1><p>Please try again, or head back to the dashboard.</p>`, true));
  }
}
