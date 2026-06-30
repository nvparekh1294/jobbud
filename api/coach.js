// Consolidated Coach tab API: replaces api/claude-md.js, api/story-bank.js,
// api/interview.js, api/interview-save.js, and api/interview-prep.js.
// Route by GET/POST + ?action query param.

import { generateInterviewPrepDoc } from '../scanner/interviewPackage.mjs';

const SONNET_MODEL    = 'claude-sonnet-4-6';
const GITHUB_API_BASE = 'https://api.github.com';

// ── Auth ─────────────────────────────────────────────────────────────────────

function checkAuth(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  const headerPw = req.headers['x-dashboard-password'];
  return !!(password && headerPw && headerPw === password);
}

// ── System prompts (verbatim from api/interview.js) ───────────────────────────

const AUTHORING_SYSTEM = (claudeMd) => `You are a senior interview coach helping the user prepare STAR-format behavioural stories for interviews.

Here is the user's background and profile:
<profile>
${claudeMd || 'No profile provided.'}
</profile>

YOUR JOB:
Guide the user through building one strong STAR-format interview story. Ask focused, one-at-a-time questions to draw out the full detail. Do not rush — a weak story with thin answers is useless. Push for specifics: numbers, timelines, who else was involved, what they actually did (not "we").

STAR FORMAT (each field is required):
- **Situation:** 1-2 sentences of context — what was the problem or moment?
- **Action:** 3-5 sentences, first person, past tense, specific to what THEY did (not the team)
- **Result:** Outcome, quantified where possible
- **30-second version:** A tight distillation for screening calls (optional but valuable)

ALSO tag with:
- Competencies: [leadership] [analytical] [ambiguity] [stakeholder] [conflict] [failure] [building] [scaling] [speed] [strategy] [personal] [accomplishment] [collaboration] [management]
- Role types: [ops] [ceo-office] [corpdev] [strat-fin] [vc]

CONVERSATION RULES:
1. Start by asking what story or situation the user wants to work on.
2. Ask ONE question at a time. Wait for their answer before moving on.
3. DO NOT produce a draft until you have asked at least 3 questions AND have enough to fill every STAR section properly. If the answers are still thin, ask follow-up questions.
4. When you have everything you need, tell them you're ready to draft and ask if they want any changes before you write it.
5. When producing the final draft, wrap it EXACTLY like this — no other content inside the tags:

[STORY_DRAFT_START]
### [Story Title]
**Competencies:** [tag] [tag]
**Role types:** [ops] [ceo-office]

**Situation:** ...
**Action:** ...
**Result:** ...

**30-second version:** ...
[STORY_DRAFT_END]

After the closing tag, add 1-2 sentences asking if they want to adjust anything or save the story.

TONE: Direct, warm, like a smart colleague who has done 500 interview prep sessions. Not a cheerleader, not robotic. If an answer is vague, say so and ask for specifics. If a metric sounds weak, push for a better one.

RESUME RULES (from the user's profile — apply to the draft):
- Never use em dashes. Use semicolons, colons, or periods instead.
- Every bullet starts with a strong action verb.
- No "co-developed", "co-led" — they led.
- No "potential" to weaken metrics.
- Banned words: transformative, accelerate, leverage, seamless, robust, pioneering, holistic.
- Confident, declarative language.`;

const PREP_INTAKE_SYSTEM = (ctx) => `You are a career coach helping the user prepare for a specific job interview. You have their background, story bank, and the job description below. Your job is to gather context you cannot infer from these materials through exactly 3 focused questions, then signal readiness.

<user_background>
${ctx.claudeMd || 'No profile provided.'}
</user_background>

<story_bank>
${ctx.storyBank || 'No stories yet.'}
</story_bank>

<job_description>
${ctx.jobDescription || 'No job description provided.'}
</job_description>

<company_context>
${ctx.radarContext || ''}
</company_context>

Ask these three questions conversationally, one at a time:
1. What round is this interview and what format (phone screen, panel, case study, etc.)?
2. What do you know about why this role is open or what problem the hiring manager is trying to solve?
3. Is there anything specific you are nervous about or want to make sure you nail?

After receiving answers to all three, output ONLY this exact string on its own line with no surrounding text:
[PREP_READY]
Then on the next line: "I have what I need. Ready to generate your prep doc?"

Rules:
- Ask exactly one question at a time
- Do not output [PREP_READY] until all three questions have been answered substantively
- If an answer is too brief or vague, ask one targeted follow-up before moving to the next question
- Do not add any text on the same line as [PREP_READY]`;

// ── GitHub file helpers (verbatim from api/interview-prep.js) ─────────────────

function normalizeCompanyName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(inc|llc|ltd|corp|co)\b\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readGithubFile(githubToken, owner, repo, path) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return '';
  if (!res.ok) {
    console.warn(`[coach] GitHub read ${path} failed: ${res.status}`);
    return '';
  }
  const data = await res.json();
  if (data.content) {
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  if (data.download_url) {
    const rawRes = await fetch(data.download_url, {
      headers: { Authorization: `Bearer ${githubToken}` },
    });
    if (!rawRes.ok) {
      console.warn(`[coach] download_url fetch for ${path} failed: ${rawRes.status}`);
      return '';
    }
    return rawRes.text();
  }
  return '';
}

async function readRadar(githubToken, owner, repo) {
  const raw = await readGithubFile(githubToken, owner, repo, 'data/radar.json');
  if (!raw) return { companies: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.companies || typeof parsed.companies !== 'object') parsed.companies = {};
    return parsed;
  } catch (e) {
    console.warn(`[coach] radar.json parse error: ${e.message}`);
    return { companies: {} };
  }
}

function serializeRadarContext(company) {
  const lines = [];
  if (company.description) lines.push(`About: ${company.description}`);
  if (company.why) lines.push(`Why on radar: ${company.why}`);
  if (Array.isArray(company.contacts) && company.contacts.length > 0) {
    lines.push('Contacts:');
    for (const c of company.contacts) {
      if (c.name || c.role) {
        lines.push(`  - ${c.name || 'Unknown'}${c.role ? `, ${c.role}` : ''}${c.contactStatus ? ` (${c.contactStatus})` : ''}`);
      }
    }
  }
  if (company.linkedinResearch) {
    const lr = company.linkedinResearch;
    if (typeof lr === 'string') {
      lines.push(`LinkedIn Research: ${lr}`);
    } else if (lr.summary) {
      lines.push(`LinkedIn Research: ${lr.summary}`);
    }
  }
  return lines.join('\n');
}

function matchRadarCompany(radarData, companyName) {
  const normJob = normalizeCompanyName(companyName);
  if (!normJob) return null;

  const entries = Object.values(radarData.companies || {});

  for (const company of entries) {
    if (normalizeCompanyName(company.company) === normJob) return company;
  }

  for (const company of entries) {
    const normRadar = normalizeCompanyName(company.company);
    if (normRadar && (normRadar.includes(normJob) || normJob.includes(normRadar))) {
      return company;
    }
  }

  return null;
}

// ── Google OAuth (same pattern as interviewPackage.mjs) ──────────────────────

async function getOAuthAccessToken() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch (err) {
    console.warn(`[coach] getOAuthAccessToken error: ${err.message}`);
    return null;
  }
}

// ── Write job-status.json via Git Data API ─────────────────────────────────────

async function writeJobStatus(githubToken, owner, repo, content) {
  const GITHUB_API  = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
  const GITHUB_GIT  = `${GITHUB_API}/git`;
  const authHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  const contentBase64 = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');

  const blobRes = await fetch(`${GITHUB_GIT}/blobs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
  });
  if (!blobRes.ok) throw new Error(`Blob create failed: ${blobRes.status}`);
  const { sha: blobSha } = await blobRes.json();

  const refRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, { headers: authHeaders });
  if (!refRes.ok) throw new Error(`Get ref failed: ${refRes.status}`);
  const { object: { sha: commitSha } } = await refRes.json();

  const commitRes = await fetch(`${GITHUB_GIT}/commits/${commitSha}`, { headers: authHeaders });
  if (!commitRes.ok) throw new Error(`Get commit failed: ${commitRes.status}`);
  const { tree: { sha: treeSha } } = await commitRes.json();

  const newTreeRes = await fetch(`${GITHUB_GIT}/trees`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      base_tree: treeSha,
      tree: [{ path: 'data/job-status.json', mode: '100644', type: 'blob', sha: blobSha }],
    }),
  });
  if (!newTreeRes.ok) throw new Error(`Create tree failed: ${newTreeRes.status}`);
  const { sha: newTreeSha } = await newTreeRes.json();

  const newCommitRes = await fetch(`${GITHUB_GIT}/commits`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      message: 'chore: update job status [skip ci]',
      tree: newTreeSha,
      parents: [commitSha],
    }),
  });
  if (!newCommitRes.ok) throw new Error(`Create commit failed: ${newCommitRes.status}`);
  const { sha: newCommitSha } = await newCommitRes.json();

  const updateRefRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (!updateRefRes.ok) throw new Error(`Advance ref failed: ${updateRefRes.status}`);
}

// ── Route: GET ?action=get-assets ─────────────────────────────────────────────
// Replaces api/claude-md.js + api/story-bank.js in a single round trip.
// Returns { claudeMd: string, storyBank: string }.

async function handleGetAssets(req, res, githubToken, owner, repo) {
  try {
    const [claudeMd, storyBank] = await Promise.all([
      readGithubFile(githubToken, owner, repo, 'CLAUDE.md'),
      readGithubFile(githubToken, owner, repo, 'story-bank.md'),
    ]);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ claudeMd, storyBank });
  } catch (err) {
    console.error('[coach] get-assets error:', err);
    return res.status(200).json({ claudeMd: '', storyBank: '' });
  }
}

// ── Route: POST ?action=chat ──────────────────────────────────────────────────
// Replaces api/interview.js exactly.

async function handleChat(req, res) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { messages = [], mode = 'authoring', context = {}, systemContext = '' } = req.body || {};

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }
  if (messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required and must not be empty' });
  }

  // Map the synthetic __init__ trigger to a neutral prompt; Anthropic requires
  // real content but the system prompt already instructs the model to open with
  // its first question, so 'Hello' is sufficient to get it started.
  const messagesForApi = messages.map(m =>
    m.role === 'user' && m.content === '__init__'
      ? { role: 'user', content: 'Hello' }
      : m
  );

  const systemPrompt = mode === 'authoring'
    ? AUTHORING_SYSTEM(context.claudeMd || '')
    : mode === 'prep-intake'
    ? PREP_INTAKE_SYSTEM(context)
    : mode === 'onboarding' && systemContext
    ? systemContext
    : AUTHORING_SYSTEM(context.claudeMd || '');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: messagesForApi,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[coach] Anthropic error ${response.status}:`, errText);
      return res.status(502).json({ error: `Anthropic API error: ${response.status}` });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text ?? '';

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('[coach] chat error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Route: POST ?action=save-story ────────────────────────────────────────────
// Replaces api/interview-save.js exactly (6-step git write pattern).

async function handleSaveStory(req, res, githubToken, owner, repo) {
  const { storyMarkdown } = req.body || {};
  if (!storyMarkdown || typeof storyMarkdown !== 'string' || !storyMarkdown.trim()) {
    return res.status(400).json({ error: 'storyMarkdown is required' });
  }

  const GITHUB_API  = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
  const GITHUB_GIT  = `${GITHUB_API}/git`;
  const authHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  try {
    // ── Read current story-bank.md ────────────────────────────────────────
    const contentsRes = await fetch(`${GITHUB_API}/contents/story-bank.md`, {
      headers: authHeaders,
    });

    let existingContent = '';

    if (contentsRes.ok) {
      const data = await contentsRes.json();
      if (data.content) {
        existingContent = Buffer.from(data.content, 'base64').toString('utf8');
      } else if (data.download_url) {
        const rawRes = await fetch(data.download_url, {
          headers: { Authorization: `Bearer ${githubToken}` },
        });
        if (rawRes.ok) {
          existingContent = await rawRes.text();
        }
      }
    } else if (contentsRes.status !== 404) {
      const text = await contentsRes.text();
      return res.status(contentsRes.status).json({
        status: contentsRes.status,
        message: `Failed to read story-bank.md: ${text}`,
      });
    }

    const separator = existingContent && !existingContent.endsWith('\n\n') ? '\n\n' : '';
    const updatedContent = existingContent + separator + storyMarkdown.trim() + '\n';

    // ── Step 1: Create blob ───────────────────────────────────────────────
    const blobRes = await fetch(`${GITHUB_GIT}/blobs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ content: updatedContent, encoding: 'utf-8' }),
    });
    if (!blobRes.ok) {
      const msg = await blobRes.text();
      return res.status(blobRes.status).json({ status: blobRes.status, message: `Blob creation failed: ${msg}` });
    }
    const { sha: blobSha } = await blobRes.json();

    // ── Step 2: Get HEAD commit SHA ───────────────────────────────────────
    const refRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, { headers: authHeaders });
    if (!refRes.ok) {
      const msg = await refRes.text();
      return res.status(refRes.status).json({ status: refRes.status, message: `Failed to get branch ref: ${msg}` });
    }
    const { object: { sha: commitSha } } = await refRes.json();

    // ── Step 3: Get tree SHA from commit ──────────────────────────────────
    const commitRes = await fetch(`${GITHUB_GIT}/commits/${commitSha}`, { headers: authHeaders });
    if (!commitRes.ok) {
      const msg = await commitRes.text();
      return res.status(commitRes.status).json({ status: commitRes.status, message: `Failed to get commit: ${msg}` });
    }
    const { tree: { sha: treeSha } } = await commitRes.json();

    // ── Step 4: Create new tree ───────────────────────────────────────────
    const newTreeRes = await fetch(`${GITHUB_GIT}/trees`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        base_tree: treeSha,
        tree: [{ path: 'story-bank.md', mode: '100644', type: 'blob', sha: blobSha }],
      }),
    });
    if (!newTreeRes.ok) {
      const msg = await newTreeRes.text();
      return res.status(newTreeRes.status).json({ status: newTreeRes.status, message: `Tree creation failed: ${msg}` });
    }
    const { sha: newTreeSha } = await newTreeRes.json();

    // ── Step 5: Create commit ─────────────────────────────────────────────
    const newCommitRes = await fetch(`${GITHUB_GIT}/commits`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        message: 'feat: add interview story [skip ci]',
        tree: newTreeSha,
        parents: [commitSha],
      }),
    });
    if (!newCommitRes.ok) {
      const msg = await newCommitRes.text();
      return res.status(newCommitRes.status).json({ status: newCommitRes.status, message: `Commit creation failed: ${msg}` });
    }
    const { sha: newCommitSha } = await newCommitRes.json();

    // ── Step 6: Advance branch ref ────────────────────────────────────────
    const updateRefRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ sha: newCommitSha }),
    });
    if (!updateRefRes.ok) {
      const msg = await updateRefRes.text();
      return res.status(updateRefRes.status).json({ status: updateRefRes.status, message: `Failed to advance ref: ${msg}` });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[coach] save-story error:', err);
    return res.status(500).json({ status: 500, message: err.message });
  }
}

// ── Shared: write updated story-bank.md via Git Data API ─────────────────────

async function writeStoryBankContent(githubToken, owner, repo, updatedContent, commitMessage) {
  const GITHUB_API  = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
  const GITHUB_GIT  = `${GITHUB_API}/git`;
  const authHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  const blobRes = await fetch(`${GITHUB_GIT}/blobs`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ content: updatedContent, encoding: 'utf-8' }),
  });
  if (!blobRes.ok) throw new Error(`Blob create failed: ${blobRes.status}`);
  const { sha: blobSha } = await blobRes.json();

  const refRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, { headers: authHeaders });
  if (!refRes.ok) throw new Error(`Get ref failed: ${refRes.status}`);
  const { object: { sha: commitSha } } = await refRes.json();

  const commitRes = await fetch(`${GITHUB_GIT}/commits/${commitSha}`, { headers: authHeaders });
  if (!commitRes.ok) throw new Error(`Get commit failed: ${commitRes.status}`);
  const { tree: { sha: treeSha } } = await commitRes.json();

  const newTreeRes = await fetch(`${GITHUB_GIT}/trees`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      base_tree: treeSha,
      tree: [{ path: 'story-bank.md', mode: '100644', type: 'blob', sha: blobSha }],
    }),
  });
  if (!newTreeRes.ok) throw new Error(`Create tree failed: ${newTreeRes.status}`);
  const { sha: newTreeSha } = await newTreeRes.json();

  const newCommitRes = await fetch(`${GITHUB_GIT}/commits`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ message: commitMessage, tree: newTreeSha, parents: [commitSha] }),
  });
  if (!newCommitRes.ok) throw new Error(`Create commit failed: ${newCommitRes.status}`);
  const { sha: newCommitSha } = await newCommitRes.json();

  const updateRefRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, {
    method: 'PATCH', headers: authHeaders,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (!updateRefRes.ok) throw new Error(`Advance ref failed: ${updateRefRes.status}`);
}

// ── Shared: parse story blocks from story-bank.md content ────────────────────

function parseStoryBlocks(content) {
  const boundary = content.indexOf('\n### ');
  if (boundary === -1) return { header: content, blocks: [] };
  const header = content.slice(0, boundary);
  const storiesText = content.slice(boundary + 1); // starts with "### "
  const blocks = storiesText.split(/\n(?=### )/);  // each block starts with "### Title\n..."
  return { header, blocks };
}

function findStoryBlock(blocks, storyId) {
  return blocks.findIndex(block => {
    const firstLine = block.split('\n')[0];
    return firstLine.replace(/^###\s+/, '').trim() === storyId;
  });
}

// ── Route: POST ?action=delete-story ─────────────────────────────────────────

async function handleDeleteStory(req, res, githubToken, owner, repo) {
  const { storyId } = req.body || {};
  if (!storyId || typeof storyId !== 'string') {
    return res.status(400).json({ error: 'storyId is required' });
  }

  try {
    const existing = await readGithubFile(githubToken, owner, repo, 'story-bank.md');
    const { header, blocks } = parseStoryBlocks(existing);
    const targetIdx = findStoryBlock(blocks, storyId);
    if (targetIdx === -1) {
      return res.status(200).json({ success: false, error: 'Story not found' });
    }

    blocks.splice(targetIdx, 1);
    const updated = blocks.length
      ? header + '\n' + blocks.join('\n')
      : header + '\n';

    await writeStoryBankContent(githubToken, owner, repo, updated, 'chore: delete interview story [skip ci]');
    console.log(`[coach] action=delete-story storyId=${storyId}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[coach] delete-story error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Route: POST ?action=update-story ─────────────────────────────────────────

async function handleUpdateStory(req, res, githubToken, owner, repo) {
  const { storyId, content } = req.body || {};
  if (!storyId || typeof storyId !== 'string') {
    return res.status(400).json({ error: 'storyId is required' });
  }
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  try {
    const existing = await readGithubFile(githubToken, owner, repo, 'story-bank.md');
    const { header, blocks } = parseStoryBlocks(existing);
    const targetIdx = findStoryBlock(blocks, storyId);
    if (targetIdx === -1) {
      return res.status(200).json({ success: false, error: 'Story not found' });
    }

    blocks[targetIdx] = content.trim() + '\n';
    const updated = header + '\n' + blocks.join('\n');

    await writeStoryBankContent(githubToken, owner, repo, updated, 'chore: update interview story [skip ci]');
    console.log(`[coach] action=update-story storyId=${storyId}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[coach] update-story error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Route: POST ?action=generate-prep ────────────────────────────────────────
// Replaces api/interview-prep.js exactly.

async function handleGeneratePrep(req, res, githubToken, owner, repo) {
  const { jobData, conversationHistory = [], jobId } = req.body || {};

  if (!jobData || !jobData.title || !jobData.company) {
    return res.status(400).json({ error: 'jobData.title and jobData.company are required' });
  }

  try {
    const [claudeMd, storyBank, bulletBank, radarData] = await Promise.all([
      readGithubFile(githubToken, owner, repo, 'CLAUDE.md'),
      readGithubFile(githubToken, owner, repo, 'story-bank.md'),
      readGithubFile(githubToken, owner, repo, 'bullet-bank.md'),
      readRadar(githubToken, owner, repo),
    ]);

    const matched = matchRadarCompany(radarData, jobData.company);
    const radarContext = matched ? serializeRadarContext(matched) : '';
    if (matched) {
      console.log(`[coach] generate-prep radar match: ${matched.company}`);
    } else {
      console.log(`[coach] generate-prep no radar match for: ${jobData.company}`);
    }

    const context = { claudeMd, storyBank, bulletBank, radarContext };

    const { docUrl, docId } = await generateInterviewPrepDoc(jobData, context, conversationHistory);

    console.log(`[coach] generate-prep doc created: ${docId}`);

    if (jobId && docUrl) {
      try {
        const statusRaw = await readGithubFile(githubToken, owner, repo, 'data/job-status.json');
        if (statusRaw) {
          const status = JSON.parse(statusRaw);
          if (status.jobs?.[jobId]) {
            status.jobs[jobId].prepDocUrl = docUrl;
            await writeJobStatus(githubToken, owner, repo, status);
            console.log(`[coach] generate-prep persisted prepDocUrl for jobId=${jobId}`);
          }
        }
      } catch (persistErr) {
        console.warn(`[coach] generate-prep failed to persist prepDocUrl: ${persistErr.message}`);
      }
    }

    return res.status(200).json({ docUrl, markdown, driveConfigured: !!docUrl });
  } catch (err) {
    console.error('[coach] generate-prep error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Route: POST ?action=mock-start ───────────────────────────────────────────

async function handleMockStart(req, res, githubToken, owner, repo) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { jobContext, prepDocUrl } = req.body || {};

  try {
    const [claudeMd, storyBank] = await Promise.all([
      readGithubFile(githubToken, owner, repo, 'CLAUDE.md'),
      readGithubFile(githubToken, owner, repo, 'story-bank.md'),
    ]);

    const roleDesc = jobContext
      ? `${jobContext.role || 'the role'}${jobContext.level ? ` (${jobContext.level})` : ''} at ${jobContext.company || 'the company'}`
      : 'a senior Director/VP-level strategy and operations role';

    const jdBlock = jobContext?.jobDescription
      ? `\n\nJOB DESCRIPTION (for question calibration):\n${jobContext.jobDescription.slice(0, 2000)}`
      : '';

    // ── Attempt hybrid path if prepDocUrl provided ──────────────────────────
    console.log(`[coach] mock-start prepDocUrl=${prepDocUrl ? prepDocUrl.slice(0, 80) : '(none)'}`);
    if (prepDocUrl) {
      try {
        const docIdMatch = prepDocUrl.match(/\/document\/d\/([^/]+)/);
        const docId = docIdMatch?.[1];
        if (!docId) throw new Error('Could not extract doc ID from prepDocUrl');

        const accessToken = await getOAuthAccessToken();
        if (!accessToken) throw new Error('OAuth token unavailable');

        const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        console.log(`[coach] mock-start prep doc fetch: status=${docRes.status} ok=${docRes.ok} docId=${docId}`);
        if (!docRes.ok) throw new Error(`Docs API error: ${docRes.status}`);
        const doc = await docRes.json();

        // Extract text lines from Google Docs body
        const lines = [];
        for (const el of (doc.body?.content || [])) {
          if (el.paragraph) {
            let text = '';
            for (const run of (el.paragraph.elements || [])) {
              if (run.textRun?.content) text += run.textRun.content;
            }
            const trimmed = text.replace(/\n$/, '').trim();
            if (trimmed) lines.push(trimmed);
          }
        }

        // Find "Q:" lines after "QUESTIONS AND PREPARATION" section header
        let inSection = false;
        const allPrepQuestions = [];
        for (const line of lines) {
          if (!inSection && line.toUpperCase().includes('QUESTIONS AND PREPARATION')) {
            inSection = true;
            continue;
          }
          if (inSection && /^SECTION\s+[3-9]/i.test(line)) break;
          if (inSection && line.startsWith('Q:')) {
            const q = line.slice(2).trim();
            if (q) allPrepQuestions.push(q);
          }
        }

        console.log(`[coach] mock-start doc lines=${lines.length} prepQuestionsExtracted=${allPrepQuestions.length}`);
        if (allPrepQuestions.length < 3) throw new Error(`Only found ${allPrepQuestions.length} prep questions`);

        // Sample 3 randomly
        const pool = [...allPrepQuestions];
        const sampled = [];
        while (sampled.length < 3 && pool.length > 0) {
          const idx = Math.floor(Math.random() * pool.length);
          sampled.push(pool.splice(idx, 1)[0]);
        }

        // Generate 2 fresh + 1 curveball via Anthropic
        const hybridPrompt = `You are a senior hiring manager interviewing for ${roleDesc}.

CANDIDATE BACKGROUND:
${claudeMd || 'No profile provided.'}

STORY BANK (candidate's prepared stories):
${storyBank || 'No stories yet.'}${jdBlock}

The candidate has already prepared these 3 questions from their prep doc (positions 1–3 in the session):
1. ${sampled[0]}
2. ${sampled[1]}
3. ${sampled[2]}

Generate exactly 3 more questions to complete the 6-question mock session (positions 4, 5, 6):
- 2 behavioral/competency questions that do NOT overlap with the prep-doc questions above
- 1 curveball question (may be at any of positions 4, 5, or 6)

Curveball rules:
- NOT a standard behavioral question
- Tests an unexpected dimension: strategic thinking under ambiguity, self-awareness, unconventional framing, or resilience
- Assigned a real competency label such as "Self-Awareness", "Resilience", or "Strategic Thinking" — do NOT use "Curveball" as the competency

Output a JSON array of exactly 3 items — no preamble, no code fences. Schema:
[{ "id": 4, "text": "...", "competency": "...", "source": "fresh" }, ...]
Use "source": "fresh" for behavioral questions and "source": "curveball" for the curveball.`;

        const hybridRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: SONNET_MODEL,
            max_tokens: 500,
            system: hybridPrompt,
            messages: [{ role: 'user', content: 'Generate the 3 questions now.' }],
          }),
        });
        if (!hybridRes.ok) throw new Error(`Anthropic error: ${hybridRes.status}`);

        const hybridData = await hybridRes.json();
        const hybridText = (hybridData.content?.[0]?.text ?? '').trim();
        const hybridClean = hybridText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
        const freshQuestions = JSON.parse(hybridClean);
        if (!Array.isArray(freshQuestions) || freshQuestions.length !== 3) throw new Error('Expected array of 3');

        const questions = [
          { id: 1, text: sampled[0], competency: 'Behavioral', source: 'prep' },
          { id: 2, text: sampled[1], competency: 'Behavioral', source: 'prep' },
          { id: 3, text: sampled[2], competency: 'Behavioral', source: 'prep' },
          ...freshQuestions,
        ];

        const hybridBySource = questions.reduce((acc, q) => { acc[q.source] = (acc[q.source] || 0) + 1; return acc; }, {});
        console.log(`[coach] action=mock-start hybrid questions=${questions.length} prepQuestions=${sampled.length} sources: prep=${hybridBySource.prep||0} fresh=${hybridBySource.fresh||0} curveball=${hybridBySource.curveball||0}`);
        return res.status(200).json({ questions });
      } catch (hybridErr) {
        console.warn(`[coach] mock-start hybrid failed, falling back to fresh: ${hybridErr.message}`);
      }
    }

    // ── Full fresh generation (default or fallback) ──────────────────────────
    const systemPrompt = `You are a senior hiring manager interviewing for ${roleDesc}.

CANDIDATE BACKGROUND:
${claudeMd || 'No profile provided.'}

STORY BANK (candidate's prepared stories):
${storyBank || 'No stories yet.'}${jdBlock}

Generate exactly 6 interview questions: ${jobContext ? '5 behavioral/competency questions tailored to this role and company' : '5 Director/VP-level behavioral questions for strategy and operations roles'}, plus 1 curveball question.

Curveball rules:
- NOT a standard behavioral question
- Tests an unexpected dimension: strategic thinking under ambiguity, self-awareness, unconventional framing, or resilience
- Feels like a question a sharp interviewer uses to catch a well-prepped candidate off-guard
- Assigned a real competency label such as "Self-Awareness", "Resilience", or "Strategic Thinking" — do NOT use "Curveball" as the competency
- Must be placed at position 4, 5, or 6 (never positions 1, 2, or 3)

Question quality standard: specific, not generic. "Tell me about a time you restructured a team mid-execution with no budget change" beats "Tell me about a challenge."

Output a JSON array only — no preamble, no explanation, no markdown code fences. Schema:
[{ "id": 1, "text": "...", "competency": "...", "source": "fresh" }, ...]
Use "source": "fresh" for behavioral/competency questions and "source": "curveball" for the curveball question.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Generate the 6 interview questions now.' }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[coach] mock-start Anthropic error ${response.status}:`, errText);
      return res.status(502).json({ error: `Anthropic API error: ${response.status}` });
    }

    const data = await response.json();
    const text = (data.content?.[0]?.text ?? '').trim();

    let questions;
    try {
      const clean = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      questions = JSON.parse(clean);
      if (!Array.isArray(questions)) throw new Error('Expected array');
    } catch (parseErr) {
      console.error('[coach] mock-start parse error:', parseErr.message, 'raw:', text.slice(0, 300));
      return res.status(500).json({ error: 'Failed to parse questions from model output' });
    }

    const freshBySource = questions.reduce((acc, q) => { const s = q.source || 'untagged'; acc[s] = (acc[s] || 0) + 1; return acc; }, {});
    console.log(`[coach] action=mock-start questions=${questions.length} jobContext=${!!jobContext} sources: prep=0 fresh=${freshBySource.fresh||0} curveball=${freshBySource.curveball||0} untagged=${freshBySource.untagged||0}`);
    return res.status(200).json({ questions });
  } catch (err) {
    console.error('[coach] mock-start error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Route: POST ?action=mock-feedback ────────────────────────────────────────

async function handleMockFeedback(req, res, githubToken, owner, repo) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { question, answer, competency, jobContext } = req.body || {};

  if (!question || !answer) {
    return res.status(400).json({ error: 'question and answer are required' });
  }

  try {
    const [claudeMd, storyBank] = await Promise.all([
      readGithubFile(githubToken, owner, repo, 'CLAUDE.md'),
      readGithubFile(githubToken, owner, repo, 'story-bank.md'),
    ]);

    const systemBlocks = [
      {
        type: 'text',
        text: 'You are an experienced executive interview coach evaluating interview answers. Be direct and specific — not "good start", but name exactly what worked and exactly what did not. Evaluate on: STAR structure, specificity (numbers/outcomes where present), relevance to competency, executive presence.',
      },
      {
        type: 'text',
        text: `CANDIDATE BACKGROUND:\n${claudeMd || 'No profile provided.'}`,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: `STORY BANK (candidate's prepared stories):\n${storyBank || 'No stories yet.'}`,
        cache_control: { type: 'ephemeral' },
      },
    ];

    const roleCtx = jobContext?.role && jobContext?.company
      ? `\nRole context: ${jobContext.role} at ${jobContext.company}`
      : '';

    const userPrompt = `Question: ${question}
Competency: ${competency || 'General'}${roleCtx}

Candidate's answer:
${answer}

Provide direct, specific feedback. "sharpen" must be 1-2 actionable items max. "suggestion" is one concrete rewrite of the weakest sentence or the clearest gap in the answer.

Output JSON only — no preamble, no code fences:
{
  "strengths": ["...", "..."],
  "sharpen": ["..."],
  "suggestion": "...",
  "starCheck": "strong" | "partial" | "missing"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 600,
        system: systemBlocks,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[coach] mock-feedback Anthropic error ${response.status}:`, errText);
      return res.status(502).json({ error: `Anthropic API error: ${response.status}` });
    }

    const data = await response.json();
    const text = (data.content?.[0]?.text ?? '').trim();

    let feedback;
    try {
      const clean = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      feedback = JSON.parse(clean);
    } catch (parseErr) {
      console.error('[coach] mock-feedback parse error:', parseErr.message, 'raw:', text.slice(0, 300));
      return res.status(500).json({ error: 'Failed to parse feedback from model output' });
    }

    console.log(`[coach] action=mock-feedback starCheck=${feedback.starCheck}`);
    return res.status(200).json(feedback);
  } catch (err) {
    console.error('[coach] mock-feedback error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Route: POST ?action=parse-resume ─────────────────────────────────────────

async function handleParseResume(req, res) {
  const { fileData, mimeType } = req.body || {};
  console.log(`[coach] action=parse-resume mimeType=${mimeType}`);

  if (!fileData || !mimeType) {
    return res.status(400).json({ error: 'fileData and mimeType are required' });
  }

  try {
    const buffer = Buffer.from(fileData, 'base64');
    console.log(`[coach] parse-resume buffer bytes=${buffer.length} hasContent=${buffer.length > 0}`);
    let text = '';

    if (mimeType === 'application/pdf') {
      try {
        const { default: pdfParse } = await import('pdf-parse');
        const result = await pdfParse(buffer);
        text = result.text;
      } catch (parseErr) {
        console.error(`[coach] parse-resume PDF error: ${parseErr.message}`);
        return res.status(200).json({ error: 'Could not parse file. Try pasting your resume instead.' });
      }
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      try {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        text = result.value;
      } catch (parseErr) {
        console.error(`[coach] parse-resume DOCX error: ${parseErr.message}`);
        return res.status(200).json({ error: 'Could not parse file. Try pasting your resume instead.' });
      }
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Upload a PDF or DOCX.' });
    }

    return res.status(200).json({ text });
  } catch (err) {
    console.error('[coach] parse-resume error:', err);
    return res.status(200).json({ error: 'Could not parse file. Try pasting your resume instead.' });
  }
}

// ── Route: POST ?action=generate-onboarding ───────────────────────────────────

async function handleGenerateOnboarding(req, res) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { resumeText = '', transcript = [], existingFiles = null } = req.body || {};
  console.log(`[coach] action=generate-onboarding resumeLength=${resumeText.length} transcriptTurns=${transcript.length} hasExistingFiles=${!!existingFiles}`);

  const transcriptText = transcript
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  const resumeBlock = resumeText
    ? `RESUME:\n${resumeText}`
    : '(No resume provided — synthesize from conversation only.)';

  const existingClaudeMdBlock = existingFiles?.claudeMd
    ? `EXISTING CLAUDE.md:\n${existingFiles.claudeMd.slice(0, 3000)}\n\n`
    : null;
  const existingCvMdBlock = existingFiles?.cvMd
    ? `EXISTING cv.md:\n${existingFiles.cvMd.slice(0, 3000)}\n\n`
    : null;
  const existingBulletBankBlock = existingFiles?.bulletBankMd
    ? `EXISTING bullet-bank.md:\n${existingFiles.bulletBankMd.slice(0, 3000)}\n\n`
    : null;
  const existingArticleDigestBlock = existingFiles?.articleDigestMd
    ? `EXISTING article-digest.md:\n${existingFiles.articleDigestMd.slice(0, 3000)}\n\n`
    : null;

  const updatePrefix = existingFiles
    ? `CRITICAL INSTRUCTION: You are UPDATING an existing file, not generating from scratch. The existing file content is the ground truth — treat it as fully accurate and complete. Your job is to:
1. PRESERVE all existing content exactly as-is unless the new conversation or resume explicitly contradicts or adds to it
2. INCORPORATE any new information from the conversation or resume into the appropriate sections
3. OUTPUT the complete updated file — not a summary, not a diff, not a description of changes. The full file, start to finish.
If the conversation provides no new information relevant to a section, reproduce that section exactly from the existing file.
Do NOT treat absence of information in the conversation as a signal to clear or placeholder-ize existing content.

`
    : '';

  try {
    const baseContent = `${resumeBlock}\n\nCONVERSATION:\n${transcriptText || '(No conversation yet.)'}`;

    const [claudeMdData, cvMdData, bulletBankData] = await Promise.all([
      // Call 1 — generate CLAUDE.md (uses only existing CLAUDE.md for reference)
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: 4000,
          system: `${updatePrefix}You are generating a CLAUDE.md background file for a job search automation system. This file will be read by AI on every resume and outreach generation call. It must be factual, specific, and grounded only in what the user has told you. Do not invent credentials, company names, dates, or accomplishments. If information is missing, leave a placeholder like [ADD: years at company] rather than guessing.

Generate a CLAUDE.md with these sections:
- Professional Background (current role, previous roles with dates)
- Target Roles (titles, seniority, locations, salary if provided)
- Key Constraints (things to never mention, framing rules)
- Languages
- Additional Context (anything else relevant)`,
          messages: [{ role: 'user', content: existingClaudeMdBlock ? `EXISTING FILE FOR REFERENCE:\n${existingClaudeMdBlock}\n\n${baseContent}` : baseContent }],
        }),
      }).then(async r => { if (!r.ok) throw new Error(`Anthropic error ${r.status}: ${await r.text()}`); return r.json(); }),

      // Call 2 — generate cv.md (uses only existing cv.md for reference)
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: 4000,
          system: `${updatePrefix}Convert the provided resume into clean markdown format. Preserve all dates, titles, companies, and bullet points verbatim. Do not add, remove, or rewrite any content. Format only.`,
          messages: [{
            role: 'user',
            content: existingCvMdBlock
              ? `EXISTING FILE FOR REFERENCE:\n${existingCvMdBlock}\n\n${resumeText ? resumeText : `Synthesize a resume outline from this conversation:\n${transcriptText}`}`
              : resumeText
                ? resumeText
                : `Synthesize a resume outline from this conversation:\n${transcriptText}`,
          }],
        }),
      }).then(async r => { if (!r.ok) throw new Error(`Anthropic error ${r.status}: ${await r.text()}`); return r.json(); }),

      // Call 3 — generate bullet-bank.md (uses only existing bullet-bank.md for reference)
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: 4000,
          system: `${updatePrefix}You are generating a bullet-bank.md file for a job search automation system. This file is a curated library of strong, metric-backed achievement bullets the AI selects from verbatim when generating tailored resumes and outreach messages.

FORMAT — organize by company, then by theme within each company:

1. Define role-type tags based on the user's stated target roles (e.g. [ops], [strategy], [finance], [product], [sales] — choose tags that match what THIS user is targeting, not a fixed list)
2. Group bullets under each company by theme (e.g. 'Theme: Cross-Functional Leadership', 'Theme: Financial Planning')
3. Tag each bullet with the role types it applies to, plus a priority: [primary] (strongest, most broadly applicable phrasing for this theme), [alt] (use if primary doesn't fit the JD), [optional] (only if the JD specifically calls for it)
4. Where the same achievement could be framed multiple ways for different role types, write 2-3 variant bullets for that theme rather than one generic version
5. At the top of the file, include a short 'How to Use This File' section defining the role-type tags you chose and explaining the priority system, so the user understands the format

REQUIREMENTS for each bullet:
- Start with a strong action verb
- Include a specific metric or outcome where possible
- Written in past tense
- 1-2 lines maximum
- Never fabricate metrics — use a placeholder like [ADD: specific number] if the user mentioned an achievement but not the number

If the input is thin (short resume, brief conversation), still use this format, but produce fewer bullets and fewer variants per theme rather than padding with weak or repetitive content. A sparse file in the correct format is better than a rich file with fabricated content.

Output clean markdown starting with # Bullet Bank. No preamble.`,
          messages: [{ role: 'user', content: existingBulletBankBlock ? `EXISTING FILE FOR REFERENCE:\n${existingBulletBankBlock}\n\n${baseContent}` : baseContent }],
        }),
      }).then(async r => { if (!r.ok) throw new Error(`Anthropic error ${r.status}: ${await r.text()}`); return r.json(); }),
    ]);

    const claudeMd = claudeMdData.content?.[0]?.text ?? '';
    const cvMd = cvMdData.content?.[0]?.text ?? '';
    const bulletBankMd = bulletBankData.content?.[0]?.text ?? '';

    // Call 4 — generate article-digest.md (runs after parallel batch; uses claudeMd + only existing article-digest.md)
    const articleDigestRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 4000,
        system: `${updatePrefix}You are generating a starter article-digest.md background file for a job search automation system. This file provides rich career context beyond the resume. It will be read by AI on every application package and outreach generation call to produce more tailored, accurate output.

Generate a markdown file with these four sections:

## Role Context
For each role mentioned, expand beyond the resume bullets to capture: what the user actually did day-to-day, what made the role unusual or significant, any context that would help an AI write about this role more accurately. Use only what the user provided — add placeholders like [ADD: more context about this role] for gaps.

## Key Proof Points
Extract the strongest metrics and achievements. For each, add a brief note on when to use it (e.g. "use for ops roles", "use for finance roles", "use for all roles"). If a metric was mentioned but not quantified, note it as [ADD: specific number].

## Tailoring Guidance
Based on the user's target roles, provide specific guidance on what to emphasize for each role type they are targeting. What should lead? What should be de-emphasized? What framing works best?

## Rules
List any constraints the user mentioned — things the AI should never say, fabricate, or misrepresent. Include any sensitivities about gaps, pivots, or role framing. If none were mentioned, add a placeholder section with instructions for the user to fill in.

Be specific and grounded only in what the user told you. Use placeholders for missing information rather than inventing details. Output clean markdown starting with # Background File. No preamble.`,
        messages: [{
          role: 'user',
          content: existingArticleDigestBlock
            ? `EXISTING FILE FOR REFERENCE:\n${existingArticleDigestBlock}\n\n${baseContent}\n\nGENERATED PROFILE:\n${claudeMd}`
            : `${baseContent}\n\nGENERATED PROFILE:\n${claudeMd}`,
        }],
      }),
    });
    if (!articleDigestRes.ok) {
      const errText = await articleDigestRes.text();
      throw new Error(`Anthropic error ${articleDigestRes.status}: ${errText}`);
    }
    const articleDigestData = await articleDigestRes.json();
    const articleDigestMd = articleDigestData.content?.[0]?.text ?? '';

    return res.status(200).json({ claudeMd, cvMd, bulletBankMd, articleDigestMd });
  } catch (err) {
    console.error('[coach] generate-onboarding error:', err);
    return res.status(200).json({ error: 'Generation failed. Please try again.' });
  }
}

// ── Shared onboarding helpers ────────────────────────────────────────────────

function buildOnboardingShared(req) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const { resumeText = '', transcriptText = '', existingFiles = null } = req.body || {};
  const resumeBlock = resumeText ? `RESUME:\n${resumeText}\n\n` : '';
  const baseContent = resumeBlock + `CONVERSATION:\n${transcriptText || '(No conversation yet.)'}`;
  const updatePrefix = existingFiles
    ? `CRITICAL INSTRUCTION: You are UPDATING an existing file, not generating from scratch. The existing file content is the ground truth — treat it as fully accurate and complete. Your job is to:
1. PRESERVE all existing content exactly as-is unless the new conversation or resume explicitly contradicts or adds to it
2. INCORPORATE any new information from the conversation or resume into the appropriate sections
3. OUTPUT the complete updated file — not a summary, not a diff, not a description of changes. The full file, start to finish.
If the conversation provides no new information relevant to a section, reproduce that section exactly from the existing file.
Do NOT treat absence of information in the conversation as a signal to clear or placeholder-ize existing content.

`
    : '';
  return { anthropicKey, baseContent, resumeText, transcriptText, existingFiles, updatePrefix };
}

async function anthropicFetch(anthropicKey, payload) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Route: POST ?action=generate-claude ──────────────────────────────────────

async function handleGenerateClaude(req, res) {
  const { anthropicKey, baseContent, existingFiles, updatePrefix } = buildOnboardingShared(req);
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  console.log('[coach] action=generate-claude');
  try {
    const existingBlock = existingFiles?.claudeMd
      ? `EXISTING CLAUDE.md:\n${existingFiles.claudeMd}\n\n`
      : null;
    const userContent = existingBlock ? `${existingBlock}${baseContent}` : baseContent;
    const data = await anthropicFetch(anthropicKey, {
      model: SONNET_MODEL,
      max_tokens: 4000,
      system: `${updatePrefix}You are generating a CLAUDE.md background file for a job search automation system. This file will be read by AI on every resume and outreach generation call. It must be factual, specific, and grounded only in what the user has told you. Do not invent credentials, company names, dates, or accomplishments. If information is missing, leave a placeholder like [ADD: years at company] rather than guessing.

Generate a CLAUDE.md with these sections:
- Professional Background (current role, previous roles with dates)
- Target Roles (titles, seniority, locations, salary if provided)
- Key Constraints (things to never mention, framing rules)
- Languages
- Additional Context (anything else relevant)`,
      messages: [{ role: 'user', content: userContent }],
    });
    return res.status(200).json({ claudeMd: data.content?.[0]?.text ?? '' });
  } catch (err) {
    console.error('[coach] generate-claude error:', err);
    return res.status(200).json({ error: err.message });
  }
}

// ── Route: POST ?action=generate-cv ──────────────────────────────────────────

async function handleGenerateCv(req, res) {
  const { anthropicKey, resumeText, transcriptText, existingFiles, updatePrefix } = buildOnboardingShared(req);
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  console.log('[coach] action=generate-cv');
  try {
    const existingBlock = existingFiles?.cvMd
      ? `EXISTING cv.md:\n${existingFiles.cvMd}\n\n`
      : null;
    const userContent = existingBlock
      ? `${existingBlock}${resumeText ? `RESUME:\n${resumeText}` : `Synthesize from:\n${transcriptText}`}`
      : resumeText
        ? resumeText
        : `Synthesize a resume outline from this conversation:\n${transcriptText}`;
    const data = await anthropicFetch(anthropicKey, {
      model: SONNET_MODEL,
      max_tokens: 4000,
      system: `${updatePrefix}Convert the provided resume into clean markdown format. Preserve all dates, titles, companies, and bullet points verbatim. Do not add, remove, or rewrite any content. Format only.`,
      messages: [{ role: 'user', content: userContent }],
    });
    return res.status(200).json({ cvMd: data.content?.[0]?.text ?? '' });
  } catch (err) {
    console.error('[coach] generate-cv error:', err);
    return res.status(200).json({ error: err.message });
  }
}

// ── Route: POST ?action=generate-bulletbank ───────────────────────────────────

async function handleGenerateBulletBank(req, res) {
  const { anthropicKey, baseContent, existingFiles, updatePrefix } = buildOnboardingShared(req);
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  console.log('[coach] action=generate-bulletbank');
  try {
    const existingBlock = existingFiles?.bulletBankMd
      ? `EXISTING bullet-bank.md:\n${existingFiles.bulletBankMd}\n\n`
      : null;
    const userContent = existingBlock ? `${existingBlock}${baseContent}` : baseContent;
    const data = await anthropicFetch(anthropicKey, {
      model: SONNET_MODEL,
      max_tokens: 4000,
      system: `${updatePrefix}You are generating a bullet-bank.md file for a job search automation system. This file is a curated library of strong, metric-backed achievement bullets drawn from the user's career. The AI uses these bullets when generating tailored resumes and outreach messages.

Extract and rewrite the strongest achievement bullets from the resume and conversation. Requirements for each bullet:
- Start with a strong action verb
- Include a specific metric or outcome where possible
- Written in past tense
- 1-2 lines maximum
- Never fabricate metrics — use placeholders like [X%] if the user mentioned an achievement but not the specific number

Organize bullets into sections by competency area. Aim for 15-25 bullets total across 3-5 sections. Common section names: Strategy & Operations, Leadership & Team Building, Analysis & Insight, Financial Impact, Product & Growth. Use whatever section names best fit this user's background.

If the resume is thin or the conversation short, produce fewer bullets rather than padding with weak ones. Quality over quantity.

Output the file in clean markdown. No preamble, no explanation — just the bullet bank content starting with # Bullet Bank.`,
      messages: [{ role: 'user', content: userContent }],
    });
    return res.status(200).json({ bulletBankMd: data.content?.[0]?.text ?? '' });
  } catch (err) {
    console.error('[coach] generate-bulletbank error:', err.message);
    console.error('[coach] generate-bulletbank error stack:', err.stack);
    return res.status(200).json({ error: err.message });
  }
}

// ── Route: POST ?action=generate-articledigest ────────────────────────────────

async function handleGenerateArticleDigest(req, res) {
  const { anthropicKey, baseContent, existingFiles, updatePrefix } = buildOnboardingShared(req);
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  console.log('[coach] action=generate-articledigest');
  try {
    const { claudeMd = '' } = req.body || {};
    const existingBlock = existingFiles?.articleDigestMd
      ? `EXISTING article-digest.md:\n${existingFiles.articleDigestMd}\n\n`
      : null;
    const userContent = existingBlock
      ? `${existingBlock}${baseContent}\n\nGENERATED PROFILE:\n${claudeMd}`
      : `${baseContent}\n\nGENERATED PROFILE:\n${claudeMd}`;
    const data = await anthropicFetch(anthropicKey, {
      model: SONNET_MODEL,
      max_tokens: 4000,
      system: `${updatePrefix}You are generating a starter article-digest.md background file for a job search automation system. This file provides rich career context beyond the resume. It will be read by AI on every application package and outreach generation call to produce more tailored, accurate output.

Generate a markdown file with these four sections:

## Role Context
For each role mentioned, expand beyond the resume bullets to capture: what the user actually did day-to-day, what made the role unusual or significant, any context that would help an AI write about this role more accurately. Use only what the user provided — add placeholders like [ADD: more context about this role] for gaps.

## Key Proof Points
Extract the strongest metrics and achievements. For each, add a brief note on when to use it (e.g. "use for ops roles", "use for finance roles", "use for all roles"). If a metric was mentioned but not quantified, note it as [ADD: specific number].

## Tailoring Guidance
Based on the user's target roles, provide specific guidance on what to emphasize for each role type they are targeting. What should lead? What should be de-emphasized? What framing works best?

## Rules
List any constraints the user mentioned — things the AI should never say, fabricate, or misrepresent. Include any sensitivities about gaps, pivots, or role framing. If none were mentioned, add a placeholder section with instructions for the user to fill in.

Be specific and grounded only in what the user told you. Use placeholders for missing information rather than inventing details. Output clean markdown starting with # Background File. No preamble.`,
      messages: [{ role: 'user', content: userContent }],
    });
    return res.status(200).json({ articleDigestMd: data.content?.[0]?.text ?? '' });
  } catch (err) {
    console.error('[coach] generate-articledigest error:', err);
    return res.status(200).json({ error: err.message });
  }
}

// ── Mock session persistence ─────────────────────────────────────────────────

async function writeMockSessions(githubToken, owner, repo, content) {
  const GITHUB_API  = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
  const GITHUB_GIT  = `${GITHUB_API}/git`;
  const authHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  const contentBase64 = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');

  const blobRes = await fetch(`${GITHUB_GIT}/blobs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
  });
  if (!blobRes.ok) throw new Error(`Blob create failed: ${blobRes.status}`);
  const { sha: blobSha } = await blobRes.json();

  const refRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, { headers: authHeaders });
  if (!refRes.ok) throw new Error(`Get ref failed: ${refRes.status}`);
  const { object: { sha: commitSha } } = await refRes.json();

  const commitRes = await fetch(`${GITHUB_GIT}/commits/${commitSha}`, { headers: authHeaders });
  if (!commitRes.ok) throw new Error(`Get commit failed: ${commitRes.status}`);
  const { tree: { sha: treeSha } } = await commitRes.json();

  const newTreeRes = await fetch(`${GITHUB_GIT}/trees`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      base_tree: treeSha,
      tree: [{ path: 'data/mock-sessions.json', mode: '100644', type: 'blob', sha: blobSha }],
    }),
  });
  if (!newTreeRes.ok) throw new Error(`Create tree failed: ${newTreeRes.status}`);
  const { sha: newTreeSha } = await newTreeRes.json();

  const newCommitRes = await fetch(`${GITHUB_GIT}/commits`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      message: 'chore: save mock interview session [skip ci]',
      tree: newTreeSha,
      parents: [commitSha],
    }),
  });
  if (!newCommitRes.ok) throw new Error(`Create commit failed: ${newCommitRes.status}`);
  const { sha: newCommitSha } = await newCommitRes.json();

  const updateRefRes = await fetch(`${GITHUB_GIT}/refs/heads/main`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (!updateRefRes.ok) throw new Error(`Advance ref failed: ${updateRefRes.status}`);
}

async function handleGetMockSessions(req, res, githubToken, owner, repo) {
  try {
    const raw = await readGithubFile(githubToken, owner, repo, 'data/mock-sessions.json');
    const data = raw ? JSON.parse(raw) : { sessions: [] };
    console.log(`[coach] action=get-mock-sessions count=${(data.sessions || []).length}`);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function handleSaveMockSession(req, res, githubToken, owner, repo) {
  try {
    const { session } = req.body || {};
    if (!session || !session.id) return res.status(400).json({ error: 'session with id is required' });

    const raw = await readGithubFile(githubToken, owner, repo, 'data/mock-sessions.json');
    const data = raw ? JSON.parse(raw) : { sessions: [] };
    data.sessions = [session, ...(data.sessions || [])].slice(0, 20);

    await writeMockSessions(githubToken, owner, repo, data);
    console.log(`[coach] action=save-mock-session sessionId=${session.id}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action } = req.query;
  console.log(`[coach] action=${action} method=${req.method}`);

  const githubToken = process.env.GH_TOKEN;
  const githubRepo  = process.env.GH_REPO;

  if (!githubToken) {
    return res.status(500).json({ error: 'GH_TOKEN not configured' });
  }
  if (!githubRepo) {
    return res.status(500).json({ error: 'GH_REPO not configured' });
  }

  const [owner, repo] = githubRepo.split('/');

  try {
    if (req.method === 'GET'  && action === 'get-assets')          return handleGetAssets(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'chat')                return handleChat(req, res);
    if (req.method === 'POST' && action === 'save-story')          return handleSaveStory(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'delete-story')        return handleDeleteStory(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'update-story')        return handleUpdateStory(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'generate-prep')       return handleGeneratePrep(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'mock-start')          return handleMockStart(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'mock-feedback')       return handleMockFeedback(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'parse-resume')        return handleParseResume(req, res);
    if (req.method === 'POST' && action === 'generate-onboarding')    return handleGenerateOnboarding(req, res);
    if (req.method === 'POST' && action === 'generate-claude')         return handleGenerateClaude(req, res);
    if (req.method === 'POST' && action === 'generate-cv')             return handleGenerateCv(req, res);
    if (req.method === 'POST' && action === 'generate-bulletbank')     return handleGenerateBulletBank(req, res);
    if (req.method === 'POST' && action === 'generate-articledigest')  return handleGenerateArticleDigest(req, res);
    if (req.method === 'GET'  && action === 'get-mock-sessions')       return handleGetMockSessions(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'save-mock-session')   return handleSaveMockSession(req, res, githubToken, owner, repo);
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error(`[coach] uncaught error for action=${action}:`, err);
    return res.status(500).json({ error: err.message });
  }
}
