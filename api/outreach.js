// NOTE FOR MAINTAINERS: This file is sanitized for public release.
// When porting changes from a private instance, re-sanitize any
// hardcoded name, bio, or background references before committing.
import { safeEqual } from '../lib/auth.mjs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const GITHUB_API = 'https://api.github.com';

// ── GitHub helpers ─────────────────────────────────────────────────────────

async function readFileFromRepo(githubToken, owner, repo, filePath) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET ${filePath} failed: ${res.status}`);
  const data = await res.json();
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function getJobStatus(githubToken, owner, repo) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/data/job-status.json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET job-status.json failed: ${res.status}`);
  const data = await res.json();

  let rawJson;
  if (data.content) {
    rawJson = Buffer.from(data.content, 'base64').toString('utf8');
  } else if (data.download_url) {
    const rawRes = await fetch(data.download_url, {
      headers: { Authorization: `Bearer ${githubToken}` },
    });
    if (!rawRes.ok) throw new Error(`GitHub download_url fetch failed: ${rawRes.status}`);
    rawJson = await rawRes.text();
  } else {
    throw new Error('GitHub Contents API returned neither content nor download_url');
  }
  return JSON.parse(rawJson);
}

// ── Outreach type labels ───────────────────────────────────────────────────

const OUTREACH_TYPE_LABELS = {
  warm_intro:          'Warm intro — asking someone I know to introduce me',
  known_contact:       'Someone I know at the company — reaching out directly',
  cold_recruiter:      'Cold outreach to recruiter',
  cold_functional:     'Cold outreach to functional team member',
  cold_ceo:            'Cold outreach to CEO/founder',
  investor_connection: 'Investor connection — relationship-building with an investor',
};

// ── Per-type structure + rules ──────────────────────────────────────────────
// Each outreach type has its own goal, structure, and special rules. Returned
// block is injected into the system prompt so the model writes to one shape.
function typeGuidance(outreachType, company, isEmail) {
  const co = company || 'the company';
  switch (outreachType) {
    case 'warm_intro':
      return `TYPE — WARM INTRO. You are writing TO a mutual connection the user already knows, asking them to introduce the user to someone at ${co}. The recipient is NOT the person at the company.
Goal: make the intro easy to say yes to. The mutual connection should be able to forward a line of this almost verbatim.
Structure, roughly one sentence each:
1. State the ask directly: what you want them to do.
2. Who the target person is and why they're relevant.
3. Why the user's background fits, specific, pulled from their experience in the USER BACKGROUND section. Not generic.
4. An easy out, e.g. "totally understand if it's not the right ask."
Hard rules: do NOT mention that they already applied. Do NOT write a cover letter. Use the mutual connection's name and relationship from the user's context to make the ask personal, not generic.`;

    case 'known_contact':
      return `TYPE — KNOWN CONTACT. The recipient works at ${co} and is a 1st-degree connection. More warmth allowed than cold outreach.
Structure:
1. Reference the role directly and that they applied or is interested.
2. One specific, genuinely interesting thing about the company or team, pulled from the job description or web research. Not vague enthusiasm.
3. A soft ask: not "can you refer me" but "would love your take on the team" or "how things are going."
If the user's context shows a strong relationship (former colleague, friend), be more casual and more direct about the application.`;

    case 'cold_recruiter':
      return `TYPE — COLD RECRUITER. Writing to a recruiter at ${co}. Make their job easy.
Structure:
1. Name the specific role they applied for. Don't make them guess.
2. Two specific credentials: actual evidence from the USER BACKGROUND section, not "experience in strategy."
3. One-line ask: happy to share more, or a quick call if useful.
Always mention the application. ${isEmail ? 'Email: up to 150 words.' : 'LinkedIn DM: 3 sentences max.'}`;

    case 'cold_functional':
      return `TYPE — COLD FUNCTIONAL PEER. Writing to a peer on the team at ${co}. This is the highest-effort type. The goal is genuine curiosity, NOT a job ask. Do NOT mention the application.
Structure:
1. A specific observation about what they're building, or a challenge ${co} is visibly tackling, pulled from the job description or web research. If nothing specific is available, do NOT fabricate; ask a genuine question about the function instead.
2. Why the user's background is relevant to that specific thing: what they've actually done, not their title.
3. The ask: a 20-minute conversation to learn how the team operates.
If you can't find anything specific about this person or their work, put this literal placeholder in the message rather than writing something generic: [add something specific about their work here before sending].`;

    case 'cold_ceo':
      return `TYPE — COLD CEO / FOUNDER. Writing to the CEO or founder of ${co}. Shortest and most direct. Establish the trade: what's in it for them.
Structure:
1. One sentence of competency with proof, a specific claim grounded in the USER BACKGROUND section. Not "I have 8 years of experience."
2. One sentence on why ${co} specifically is interesting, something real from web research or the job description. No vague enthusiasm.
3. The ask: one soft, specific line. A conversation, not a job.
${isEmail ? '' : 'IMPORTANT: for a CEO or founder, email is strongly preferred over a LinkedIn DM. In personalizationNote, tell the user to send this by email if they can find the address.'}`;

    case 'investor_connection':
      return `TYPE — INVESTOR CONNECTION. Writing to an investor (VC, angel, or growth-equity partner). The goal is to build a relationship with someone who could connect the user to their portfolio or network. This is NOT a job ask. Never mention applying for a role.
Structure:
1. Establish credibility with specific, relevant background from the USER BACKGROUND section. One sentence, real, not a list.
2. One genuine observation about this investor's portfolio or thesis, pulled from web research or the context provided. If you have nothing specific, ask a real question about their focus rather than inventing one.
3. A soft ask for a conversation. Not about a specific job. "Would value 20 minutes to compare notes" or similar.
Hard rules: never mention applying for a role. Under 150 words regardless of platform. No flattery.`;

    default:
      return '';
  }
}

// Pull the model's JSON out of a response that may also contain web_search tool
// blocks. Collect every text block, strip fences, then parse (falling back to the
// first {...} match).
function extractJson(content) {
  const text = (content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .replace(/```json|```/g, '')
    .trim();
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('Claude returned invalid JSON');
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const password       = process.env.DASHBOARD_PASSWORD;
  const githubToken    = process.env.GH_TOKEN;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const githubRepo     = process.env.GH_REPO;
  const [owner, repo]  = githubRepo.split('/');

  console.log('[outreach] GH_TOKEN present:', !!githubToken);
  console.log('[outreach] ANTHROPIC_API_KEY present:', !!anthropicApiKey);

  // Auth — X-Dashboard-Password header only (dashboard-initiated call)
  const headerPw = req.headers['x-dashboard-password'];
  if (!headerPw || !password || !safeEqual(headerPw, password)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (!anthropicApiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (!githubToken)     return res.status(500).json({ error: 'GH_TOKEN not set' });

  const { jobId, outreachType, platform, additionalContext, radarContext } = req.body || {};
  // Radar outreach carries the company context inline (there is no job in
  // job-status.json). These fields are ignored for ordinary job outreach.
  const radarCompany     = (req.body && req.body.company) || '';
  const radarDescription = (req.body && req.body.companyDescription) || '';
  const radarWhy         = (req.body && req.body.why) || '';
  const isRadar = radarContext === true;

  // jobId is required for ordinary job outreach; radar outreach uses company context instead.
  if ((!jobId && !isRadar) || !outreachType || !platform) {
    return res.status(400).json({ error: 'Missing required fields: jobId (or radarContext), outreachType, platform' });
  }
  if (isRadar && !radarCompany) {
    return res.status(400).json({ error: 'radarContext requires a company name' });
  }

  if (!OUTREACH_TYPE_LABELS[outreachType]) {
    return res.status(400).json({ error: `Invalid outreachType: ${outreachType}` });
  }

  if (!['linkedin', 'email'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be "linkedin" or "email"' });
  }

  try {
    // Fetch supporting files (and the job, for ordinary outreach) in parallel.
    // Radar outreach skips job-status.json: there is no posting, the company
    // context comes from the request body.
    const [jobData, bulletBank, articleDigest] = await Promise.all([
      isRadar ? Promise.resolve(null) : getJobStatus(githubToken, owner, repo),
      readFileFromRepo(githubToken, owner, repo, 'bullet-bank.md')
        .catch(() => readFileFromRepo(githubToken, owner, repo, 'cv.md')
        .catch(() => '')),
      readFileFromRepo(githubToken, owner, repo, 'article-digest.md').catch(() => ''),
    ]);

    let job;
    if (isRadar) {
      // Synthetic job built from the Radar entry. No title/role — this is
      // relationship outreach, not a job application. `why` and the company
      // description stand in for the job description as context.
      job = {
        company:            radarCompany,
        title:              '',
        description:        '',
        companyDescription: radarDescription,
        why:                radarWhy,
      };
    } else {
      job = jobData.jobs?.[jobId];
      if (!job) return res.status(404).json({ error: 'Job not found' });
    }

    console.log(`[outreach] Generating for ${job.company} — ${job.title} | type: ${outreachType} | platform: ${platform}`);

    const isEmail = platform === 'email';
    const outreachLabel = OUTREACH_TYPE_LABELS[outreachType];

    // ── Context assembly ────────────────────────────────────────────────────
    // Job description IS stored in job-status.json under `description` (capped at
    // 3000 chars by the scanner / add-job). It's absent for ~43% of jobs (e.g.
    // Greenhouse listings store empty descriptions).
    // For Radar outreach the "job description" slot is filled by the user's reason
    // for interest plus the company description — there is no posting to mine.
    const jobDescription = isRadar
      ? [radarWhy ? `Why the user is interested: ${radarWhy}` : '', radarDescription ? `About the company: ${radarDescription}` : ''].filter(Boolean).join('\n\n').trim()
      : (job.description || '').trim();
    const hasJD = jobDescription.length > 0;
    if (!hasJD) console.log(`[outreach] No ${isRadar ? 'company context' : 'job description'} for ${jobId || radarCompany} — relying on web research + reasoning fields`);

    // ATS analysis is NOT currently stored on the job object. We read job.atsAnalysis
    // so this flows through automatically once the pipeline starts saving it.
    const atsAnalysis = typeof job.atsAnalysis === 'string' ? job.atsAnalysis.trim() : '';
    if (!atsAnalysis) console.log(`[outreach] No ATS analysis on job ${jobId} (field not yet stored by the pipeline)`);

    // Score reasoning the scanner already saves — gives the model a real angle.
    const reasoningLines = [
      job.oneLineSummary ? `Summary: ${job.oneLineSummary}` : '',
      Array.isArray(job.whyFit) && job.whyFit.length ? `Why it fits: ${job.whyFit.join('; ')}` : '',
      Array.isArray(job.watchOuts) && job.watchOuts.length ? `Watch-outs: ${job.watchOuts.join('; ')}` : '',
      job.companyDescription ? `Company: ${job.companyDescription}` : '',
      job.fundingSnapshot ? `Funding: ${job.fundingSnapshot}` : '',
    ].filter(Boolean).join('\n');

    // Radar outreach has no open role behind it. This modifier overrides the
    // per-type structures so the message reads as genuine interest and
    // relationship building, never as a job application.
    const radarModifier = isRadar ? `
NO OPEN ROLE — RELATIONSHIP OUTREACH:
This message is NOT about a job. There is no posting and no application. The user is reaching out to ${job.company || 'this company'} out of genuine interest to build a relationship.
- Do NOT mention applying, a role, a job, an opening, a position, or a referral.
- Do NOT ask to be considered for anything or hint at wanting a job.
- The point is a real connection: shared interest, a thoughtful observation, an offer to compare notes or learn more.
- The ask, if any, is a short conversation between peers — never a career favor.
- Ground it in why this company or person genuinely interests them (from the context below) and one real, specific detail.
Wherever a per-type rule below assumes there is a job or application, ignore that part and follow this modifier instead.
` : '';

    const systemPrompt = `You draft outreach messages on behalf of the user. Their background is provided below. ${isRadar ? 'They are reaching out to build a relationship — there is no open role.' : 'They are reaching out about a job.'}

Write the way a sharp, busy person writes. The message should read like the user typed it themselves in two minutes. It should not read like it was generated.

VOICE:
- Direct and specific. Short sentences. Vary the rhythm so it never sounds mechanical.
- Use contractions: I'm, don't, it's, you're. Active voice. First person.
- One specific, real detail about the role or company beats any general claim about fit. If you don't have a real detail, stay plain. Do not invent one.
- Confident, not eager. Never desperate, never flattering.

LENGTH:
- ${isEmail ? 'Email: under 200 words.' : 'LinkedIn DM: under 100 words.'} Shorter wins. If the point is made, stop. The per-type rules below may set a tighter limit; follow the tighter one.

BANNED WORDS — never use:
leverage, synergy, innovative, align, foster, showcase, enhance, streamline, elevate, empower, transformative, seamless, robust, dynamic, pivotal, crucial, underscore, highlight.

BANNED PHRASES — never use:
"serves as", "stands as", "represents a", "plays a role in", "helps to", "aims to", "seeks to", "Furthermore", "Additionally", "Moreover", "That said", "With that in mind", "I hope this message finds you well", "I wanted to reach out", "I am very passionate about", "would love to connect".

BANNED FORMATTING:
- No em dashes. Use commas, periods, or parentheses.
- No sentence that announces what the message is about to do ("I'm writing to", "I wanted to introduce myself", "Quick note to").
- No resume summary. No bulleted accomplishments.
- Do not use three parallel items. If one thing is the point, say one thing.

${typeGuidance(outreachType, job.company, isEmail)}
${radarModifier}
OVERRIDE RULE: if the user gives additional context about the relationship or why this company interests them, that overrides any guess you would make. Never contradict what they wrote.

USER BACKGROUND (use it to pick one real, specific credential; do not copy verbatim or list):
${bulletBank.slice(0, 3000)}

COMPANY / NARRATIVE CONTEXT:
${articleDigest.slice(0, 2000)}

Respond with valid JSON only. No markdown fences.`;

    const userPrompt = `Draft a ${isEmail ? 'email' : 'LinkedIn DM'} for the user.

${isRadar ? 'CONTEXT: Relationship outreach — there is no open role or application.' : `ROLE: ${job.title || 'Unknown role'}`}
COMPANY: ${job.company || 'Unknown company'}
OUTREACH TYPE: ${outreachLabel} (${outreachType})
PLATFORM: ${isEmail ? 'Email' : 'LinkedIn DM'}
${additionalContext ? `CONTEXT FROM USER (authoritative — overrides your guesses): ${additionalContext}` : ''}

RESEARCH FIRST: run up to 3 web searches for recent ${job.company || 'company'} news from the last 6 months — funding, product launches, notable hires, press. Use targeted queries like "${job.company || 'company'} news 2025" and "${job.company || 'company'} ${job.companyDescription ? job.companyDescription.split(/[.,]/)[0] : 'product'} recent". Ground the message in anything real you find. If you find nothing useful, write without it. Never fabricate news.

${reasoningLines ? `WHY THIS ROLE SCORED WELL (internal context — do not quote, use to pick a real angle):\n${reasoningLines}\n` : ''}
${atsAnalysis ? `ATS ANALYSIS:\n${atsAnalysis.slice(0, 1500)}\n` : ''}
${isRadar ? 'COMPANY CONTEXT (mine for one specific, real detail; this replaces a job description — there is no posting):' : 'JOB DESCRIPTION (mine for one specific, real detail to reference):'}
${hasJD ? jobDescription.slice(0, 3000) : (isRadar ? 'No company context provided. Lean on web research.' : 'No job description stored for this posting. Lean on web research and the reasoning context above.')}

Follow the per-type structure and the bans in the system prompt.

Respond with exactly this JSON:
{
  ${isEmail ? '"subject": "<specific, role-relevant subject line in sentence case; sounds like a person wrote it, not a template>",\n  ' : ''}"message": "<the message body>",
  "personalizationNote": "<one sentence on what to verify or customize before sending>"
}`;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        // Server-side web search, capped at 3 runs, for recent company news.
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Claude API HTTP ${response.status}: ${body}`);
    }

    const claudeData = await response.json();
    const parsed = extractJson(claudeData.content);

    console.log(`[outreach] Draft complete for ${job.company} — ${job.title}`);

    return res.status(200).json({
      subject:             parsed.subject             || null,
      message:             parsed.message             || '',
      personalizationNote: parsed.personalizationNote || '',
    });

  } catch (err) {
    console.error('[outreach] Error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
