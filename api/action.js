import crypto from 'crypto';
import { generateAndSendPackage } from '../scanner/applicationPackage.mjs';

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

// Email action tokens carry a Unix timestamp (seconds) so they can expire.
// The token signs jobId+status+ts; the ts travels in the URL so we can both
// re-derive the HMAC and reject anything older than 72 hours.
const TOKEN_MAX_AGE_SECONDS = 72 * 60 * 60; // 72 hours

function verifyToken(jobId, status, token, ts, password) {
  // ts must be present and numeric
  if (!ts || !/^\d+$/.test(String(ts))) return false;
  const tsNum = parseInt(String(ts), 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - tsNum;
  // Reject expired tokens and tokens dated in the future (clock skew / tampering)
  if (ageSeconds < 0 || ageSeconds > TOKEN_MAX_AGE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', password)
    .update(jobId + status + tsNum)
    .digest('hex')
    .slice(0, 16);
  return token === expected;
}

async function getJobStatus(githubToken, owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/data/job-status.json`;
  console.log(`[action] GET ${url}`);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
    },
  });
  console.log(`[action] GET response status: ${res.status}`);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[action] GET failed body: ${body}`);
    throw new Error(`GitHub GET failed: ${res.status} — ${body}`);
  }
  const data = await res.json();

  // GitHub Contents API returns content:"" for files > 1 MB; use download_url instead.
  let rawJson;
  if (data.content) {
    rawJson = Buffer.from(data.content, 'base64').toString('utf8');
    console.log(`[action] GET success (inline content)`);
  } else if (data.download_url) {
    console.log(`[action] File exceeds GitHub Contents API limit — fetching via download_url`);
    const rawRes = await fetch(data.download_url, {
      headers: { Authorization: `Bearer ${githubToken}` },
    });
    if (!rawRes.ok) {
      const body = await rawRes.text();
      console.error(`[action] download_url fetch failed: ${rawRes.status} — ${body}`);
      throw new Error(`GitHub download_url fetch failed: ${rawRes.status} — ${body}`);
    }
    rawJson = await rawRes.text();
    console.log(`[action] GET success (download_url)`);
  } else {
    throw new Error('GitHub Contents API returned neither content nor download_url');
  }

  const content = JSON.parse(rawJson);
  return { content };
}

// Write job-status.json via the Git Data API — works for files of any size.
// The Contents API PUT endpoint rejects files > 1 MB with a 422, so we bypass
// it entirely: create a blob, build a new tree, create a commit, update the ref.
async function putJobStatus(githubToken, owner, repo, content) {
  const GITHUB_GIT = `https://api.github.com/repos/${owner}/${repo}/git`;
  const authHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  const contentBase64 = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');

  // Step 1 — create blob
  console.log(`[action] Git Data API: creating blob...`);
  const blobRes = await fetch(`${GITHUB_GIT}/blobs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
  });
  if (!blobRes.ok) {
    const body = await blobRes.text();
    console.error(`[action] blob create failed: ${blobRes.status} — ${body}`);
    throw new Error(`GitHub blob create failed: ${blobRes.status} — ${body}`);
  }
  const { sha: blobSha } = await blobRes.json();
  console.log(`[action] blob created: ${blobSha}`);

  // Step 2 — get HEAD commit SHA
  const refRes = await fetch(`${GITHUB_GIT}/ref/heads/main`, { headers: authHeaders });
  if (!refRes.ok) {
    const body = await refRes.text();
    console.error(`[action] get ref failed: ${refRes.status} — ${body}`);
    throw new Error(`GitHub get ref failed: ${refRes.status} — ${body}`);
  }
  const { object: { sha: commitSha } } = await refRes.json();
  console.log(`[action] HEAD commit: ${commitSha}`);

  // Step 3 — get tree SHA from commit
  const commitRes = await fetch(`${GITHUB_GIT}/commits/${commitSha}`, { headers: authHeaders });
  if (!commitRes.ok) {
    const body = await commitRes.text();
    console.error(`[action] get commit failed: ${commitRes.status} — ${body}`);
    throw new Error(`GitHub get commit failed: ${commitRes.status} — ${body}`);
  }
  const { tree: { sha: treeSha } } = await commitRes.json();
  console.log(`[action] current tree: ${treeSha}`);

  // Step 4 — create new tree with updated file
  const newTreeRes = await fetch(`${GITHUB_GIT}/trees`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      base_tree: treeSha,
      tree: [{ path: 'data/job-status.json', mode: '100644', type: 'blob', sha: blobSha }],
    }),
  });
  if (!newTreeRes.ok) {
    const body = await newTreeRes.text();
    console.error(`[action] create tree failed: ${newTreeRes.status} — ${body}`);
    throw new Error(`GitHub create tree failed: ${newTreeRes.status} — ${body}`);
  }
  const { sha: newTreeSha } = await newTreeRes.json();
  console.log(`[action] new tree: ${newTreeSha}`);

  // Step 5 — create commit
  const newCommitRes = await fetch(`${GITHUB_GIT}/commits`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      message: 'chore: update job status [skip ci]',
      tree: newTreeSha,
      parents: [commitSha],
    }),
  });
  if (!newCommitRes.ok) {
    const body = await newCommitRes.text();
    console.error(`[action] create commit failed: ${newCommitRes.status} — ${body}`);
    throw new Error(`GitHub create commit failed: ${newCommitRes.status} — ${body}`);
  }
  const { sha: newCommitSha } = await newCommitRes.json();
  console.log(`[action] new commit: ${newCommitSha}`);

  // Step 6 — advance branch ref
  const updateRefRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (!updateRefRes.ok) {
    const body = await updateRefRes.text();
    console.error(`[action] update ref failed: ${updateRefRes.status} — ${body}`);
    throw new Error(`GitHub update ref failed: ${updateRefRes.status} — ${body}`);
  }
  console.log(`[action] job-status.json updated via Git Data API`);
}

function htmlPage(title, body, isError = false) {
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
    <a href="${process.env.VERCEL_URL || ''}/dashboard" style="display:inline-block;margin-top:12px;padding:10px 24px;background:#1a1a1a;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;">Back to Dashboard</a>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  const { jobId, status, token, ts, snooze } = req.query;

  const password = process.env.DASHBOARD_PASSWORD;
  const githubToken = process.env.GH_TOKEN;
  const githubRepo = process.env.GH_REPO ;
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
  const isDashboardAuth = !!(headerPw && password && headerPw === password);
  console.log('[action] auth method:', isDashboardAuth ? 'X-Dashboard-Password' : 'HMAC token');

  if (!jobId || !status) {
    return res.status(400).send(htmlPage('Error', '<h1>⚠ Missing parameters</h1><p>This link is incomplete.</p>', true));
  }

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).send(htmlPage('Error', `<h1>⚠ Invalid status</h1><p>"${status}" is not a valid status.</p>`, true));
  }

  if (!isDashboardAuth) {
    // Fall back to HMAC token validation (email links). Tokens expire after 72h.
    if (!token || !password || !verifyToken(jobId, status, token, ts, password)) {
      return res.status(403).send(htmlPage('Error', '<h1>⛔ Unauthorized</h1><p>This link is invalid or has expired.</p>', true));
    }
  }

  try {
    const { content } = await getJobStatus(githubToken, owner, repo);

    if (!content.jobs) content.jobs = {};
    if (!content.jobs[jobId]) content.jobs[jobId] = {};

    const job = content.jobs[jobId];
    const company = job.company || 'Unknown company';
    const title = job.title || 'Unknown role';
    const previousStatus = job.status;

    // ── Snooze handling (status=preparing&snooze=1) ──────────────────────────
    if (status === 'preparing' && snooze === '1') {
      job.snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      job.statusUpdatedAt = new Date().toISOString();
      if (!job.statusHistory) job.statusHistory = [];
      job.statusHistory.push({ status: 'snoozed_preparing', timestamp: new Date().toISOString() });

      await putJobStatus(githubToken, owner, repo, content);
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(htmlPage('Snoozed', SNOOZE_MESSAGE(company, title)));
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
      if (!Array.isArray(job.outreachContacts)) job.outreachContacts = [];
      job.outreachContacts.push(contact);
      job.lastOutreachAt = nowIso;
      if (!job.statusHistory) job.statusHistory = [];
      job.statusHistory.push({ status: 'reached_out_logged', timestamp: nowIso });

      await putJobStatus(githubToken, owner, repo, content);

      const wantJson = (req.headers['accept'] || '').includes('application/json');
      if (wantJson) {
        return res.status(200).json({ success: true, outreachContacts: job.outreachContacts });
      }
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(htmlPage('Logged', `<h1>📬 Logged</h1><p>Outreach to <strong>${contact.name || 'a contact'}</strong> at <strong>${company}</strong> has been saved.</p>`));
    }

    // ── Normal status update ────────────────────────────────────────────────
    job.status = status;
    job.statusUpdatedAt = new Date().toISOString();

    // Add status-specific timestamps
    if (status === 'preparing') job.preparedAt = new Date().toISOString();
    if (status === 'applied') job.appliedAt = new Date().toISOString();

    if (!job.statusHistory) job.statusHistory = [];
    job.statusHistory.push({ status, timestamp: new Date().toISOString() });

    await putJobStatus(githubToken, owner, repo, content);

    // ── Non-preparing statuses: GitHub write is the ONLY side effect ─────────
    // reject, save, applied, interviewing, offer, ghosted → return here, done.
    // generateAndSendPackage must NEVER be reached from any of these paths.
    if (status !== 'preparing') {
      const messageFn = STATUS_MESSAGES[status];
      const body = messageFn ? messageFn(company, title) : `<h1>✓ Updated</h1><p>Status set to <strong>${status}</strong>.</p>`;
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
      if (req.body && typeof req.body === 'object') {
        roleTypes = Array.isArray(req.body.roleTypes) ? req.body.roleTypes : [];
        additionalGuidance = typeof req.body.additionalGuidance === 'string' ? req.body.additionalGuidance : '';
        applicationQuestions = typeof req.body.applicationQuestions === 'string' ? req.body.applicationQuestions : '';
      }
      console.log('[action] roleTypes:', roleTypes, '| additionalGuidance length:', additionalGuidance.length, '| applicationQuestions length:', applicationQuestions.length);

      if (wantJson) {
        // Dashboard path: run synchronously, return full package content as JSON.
        try {
          const { pkg, docUrl } = await generateAndSendPackage(job, jobId, { roleTypes, additionalGuidance, applicationQuestions });

          // Persist docUrl back to job-status.json so the dashboard can link to the
          // Google Doc from the applied status indicator. The content object is still
          // in memory from the earlier read; we write it as a second commit here.
          if (docUrl) {
            content.jobs[jobId].docUrl = docUrl;
            try {
              await putJobStatus(githubToken, owner, repo, content);
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
          return res.status(500).json({ success: false, error: err.message });
        }
      } else {
        // Email / browser path: fire and forget, respond immediately
        generateAndSendPackage(job, jobId, { roleTypes, additionalGuidance, applicationQuestions }).catch(err => {
          console.error(`[action] Application package failed for ${company}: ${err.message}`);
        });
      }
    }

    const messageFn = STATUS_MESSAGES[status];
    const body = messageFn ? messageFn(company, title) : `<h1>✓ Updated</h1><p>Status set to <strong>${status}</strong>.</p>`;

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(htmlPage('Done', body));

  } catch (err) {
    console.error('Action handler error:', err);
    return res.status(500).send(htmlPage('Error', `<h1>⚠ Something went wrong</h1><p>${err.message}</p>`, true));
  }
}
