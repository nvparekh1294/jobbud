// NOTE FOR MAINTAINERS: This file is sanitized for public release.
// When porting changes from a private instance, re-sanitize any
// hardcoded name, bio, or background references before committing.

// Generates an interview prep Google Doc from an intake conversation.
// Follow scanner/applicationPackage.mjs for OAuth, callClaude, and Google Docs patterns.

import { SONNET_MODEL } from './config.mjs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const GOOGLE_DOCS_API   = 'https://docs.googleapis.com/v1/documents';
const GOOGLE_DRIVE_API  = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_TOKEN_URL  = 'https://oauth2.googleapis.com/token';

// Hardcoded folder for interview prep docs (separate from application packages)
const PREP_FOLDER_ID = '1qqv-ZYUzvso7_CZqBHVZ3tk0fR_cBAF5';

const STORY_BANK_MAX_CHARS = 8000;

// ── Google Docs formatting helpers (identical to applicationPackage.mjs) ───────

function pt(n) { return { magnitude: n, unit: 'PT' }; }

function rgb(r, g, b) {
  return { color: { rgbColor: { red: r, green: g, blue: b } } };
}

function paraReq(range, style, fields) {
  return { updateParagraphStyle: { range, paragraphStyle: style, fields } };
}

function textReq(range, style, fields) {
  return { updateTextStyle: { range, textStyle: style, fields } };
}

// ── OAuth (identical pattern to applicationPackage.mjs) ───────────────────────

async function getOAuthAccessToken() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn('[interviewPkg] OAuth env vars missing — skipping Google Doc creation');
    return null;
  }

  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[interviewPkg] OAuth token exchange failed: ${res.status} — ${body}`);
      return null;
    }
    const data = await res.json();
    return data.access_token;
  } catch (err) {
    console.warn(`[interviewPkg] getOAuthAccessToken error: ${err.message}`);
    return null;
  }
}

// ── Plain-text response parser ────────────────────────────────────────────────
// Splits Claude's plain-text output on section headers.
// Uses .includes() matching so "SECTION 1 — ROLE READ", "ROLE READ", etc. all work.

function parsePrepText(text) {
  const HEADER_MAP = [
    { marker: 'ROLE READ',                 key: 'roleRead'          },
    { marker: 'QUESTIONS AND PREPARATION', key: 'questionsAndPrep'  },
    { marker: 'GAP FLAGS',                 key: 'gapFlags'          },
    { marker: 'BACKGROUND PITCH',          key: 'backgroundPitch'   },
    { marker: 'COMPANY CONTEXT',           key: 'companyContext'    },
  ];

  const result = { roleRead: '', questionsAndPrep: '', gapFlags: '', backgroundPitch: '', companyContext: '' };
  let current = null;
  let buf = [];

  for (const line of text.split('\n')) {
    const upper = line.trim().toUpperCase();
    const match = HEADER_MAP.find(h => {
      if (!upper.includes(h.marker)) return false;
      // Guard 1: if a colon appears in the line BEFORE the marker, this is a labeled
      // content field (e.g. "Why this is a likely question: ...company context..."),
      // not a section header.
      const markerIdx = upper.indexOf(h.marker);
      const firstColon = upper.indexOf(':');
      if (firstColon >= 0 && firstColon < markerIdx) return false;
      // Guard 2: genuine section headers are short. Longest valid header is
      // "SECTION 2 — QUESTIONS AND PREPARATION" (38 chars). Cap at 60 to be safe.
      if (upper.length > 60) return false;
      return true;
    });
    if (match) {
      if (current) result[current] = buf.join('\n').trim();
      current = match.key;
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) result[current] = buf.join('\n').trim();

  return result;
}

// ── Markdown serialiser — used when Google Drive is not configured ────────────
function buildPrepMarkdown(parsed, jobData, companyResearch, radarContext) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const companyContext = parsed.companyContext
    || (radarContext && radarContext.trim() ? radarContext.trim() : companyResearch)
    || 'No company context available.';

  return [
    `# Interview Prep — ${jobData.title} at ${jobData.company}`,
    `_Generated ${dateStr}_`,
    '',
    '## Section 1 — Role Read',
    '',
    parsed.roleRead || '',
    '',
    '## Section 2 — Questions and Preparation',
    '',
    parsed.questionsAndPrep || '',
    '',
    '## Section 3 — Gap Flags',
    '',
    parsed.gapFlags || 'No gaps identified.',
    '',
    '## Section 4 — Background Pitch',
    '',
    parsed.backgroundPitch || '',
    '',
    '## Section 5 — Company Context',
    '',
    companyContext,
  ].join('\n');
}

// ── Company research via web search ──────────────────────────────────────────
// Runs before the main prep doc call. Non-fatal — always returns a string.

async function fetchCompanyResearch(anthropicKey, companyName, companyUrl, jobDescription) {
  const start = Date.now();

  const researchCall = (async () => {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a research assistant. Search the web and return a concise company briefing. Be factual and specific. Only include information you can verify from search results.',
        messages: [{
          role: 'user',
          content: `Research ${companyName} and provide a concise briefing covering:
1. What the company does and their core product/service
2. Company stage, size, and funding (if available)
3. Their target customers and market
4. Recent news, launches, or milestones (last 12 months if available)
5. Leadership team (CEO and any other key executives)
6. Culture signals or notable company values

Company URL: ${companyUrl || 'not provided'}

Here is additional context from their job description:
${(jobDescription || '').slice(0, 1000)}

Return a 200-300 word briefing. Be specific and factual. If you cannot find information on a specific point, skip it rather than guessing.`,
        }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Company research API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    // Web search responses may contain tool_use blocks (search calls) interspersed
    // with text blocks (the assistant's written content). Extract only text blocks.
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    const researchText = textBlocks.map(b => b.text).join('\n').trim();

    // Extract URLs from tool_result blocks (web search results)
    const sourceUrls = [];
    for (const block of (data.content || [])) {
      if (block.type === 'tool_result') {
        const content = Array.isArray(block.content) ? block.content : [];
        for (const item of content) {
          if (item.type === 'text') {
            try {
              const results = JSON.parse(item.text);
              if (Array.isArray(results)) {
                results.forEach(r => { if (r.url) sourceUrls.push(r.url); });
              }
            } catch { /* not JSON, skip */ }
          }
          // Some tool_result blocks have url directly on the item
          if (item.url) sourceUrls.push(item.url);
        }
      }
    }

    if (sourceUrls.length === 0) return researchText;

    const uniqueUrls = [...new Set(sourceUrls)].slice(0, 8);
    return researchText + '\n\nSOURCE URLS (use these for citations in Section 5):\n'
      + uniqueUrls.map((u, i) => `[${i+1}] ${u}`).join('\n');
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Company research timeout after 30s')), 30000)
  );

  try {
    const result = await Promise.race([researchCall, timeoutPromise]);
    const elapsed = Date.now() - start;
    console.log(`[interviewPkg] Company research completed in ${elapsed}ms`);
    return result || 'Company research returned no content.';
  } catch (err) {
    const elapsed = Date.now() - start;
    console.warn(`[interviewPkg] Company research failed after ${elapsed}ms: ${err.message}`);
    return 'Company research unavailable -- refer to job description and company website for context.';
  }
}

// ── Claude call for generating all prep sections ──────────────────────────────

async function callClaudeForPrep(anthropicKey, jobData, context, conversationHistory, companyResearch) {
  const truncatedStoryBank = context.storyBank && context.storyBank.length > STORY_BANK_MAX_CHARS
    ? (console.warn(`[interviewPkg] Story bank truncated from ${context.storyBank.length} to ${STORY_BANK_MAX_CHARS} chars`),
       context.storyBank.slice(0, STORY_BANK_MAX_CHARS) + '\n[Story bank truncated for length]')
    : (context.storyBank || 'No stories yet.');

  const transcriptText = conversationHistory.map(m =>
    `${m.role === 'user' ? 'User' : 'Coach'}: ${m.content}`
  ).join('\n\n');

  // Stable blocks: cached across all prep doc calls (same CLAUDE.md, story bank, bullet bank).
  // Variable content (JD, company, transcript) goes in the user message — not cached.
  const systemBlocks = [
    {
      type: 'text',
      text: 'You are JobBud generating an interview prep package for the user.\n\nWrite each section in plain text starting with its exact header on its own line. Do not use JSON. Do not use markdown code fences.',
    },
    {
      type: 'text',
      text: `USER BACKGROUND:\n${context.claudeMd || 'No profile provided.'}`,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `STORY BANK (STAR interview stories):\n${truncatedStoryBank}`,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `BULLET BANK HIGHLIGHTS (resume talking points — first 2000 chars):\n${(context.bulletBank || '').slice(0, 2000)}`,
      cache_control: { type: 'ephemeral' },
    },
  ];

  // Variable per session: JD, company research, transcript, and section format instructions.
  const userPrompt = `Generate a full interview prep package for ${jobData.title} at ${jobData.company}.

JOB DESCRIPTION:
${jobData.jobDescription || 'No job description provided.'}

COMPANY RESEARCH:
${companyResearch || 'No company research available.'}

INTAKE CONVERSATION TRANSCRIPT:
${transcriptText || '(No intake conversation — generate based on available context.)'}

Write exactly five sections. Start each section with its header on its own line in uppercase, exactly as shown. Nothing else on the header line.

ROLE READ
Write 2 paragraphs maximum analyzing what this role is actually testing for. Use the JD, company research, and intake conversation. Direct and specific — not generic.

QUESTIONS AND PREPARATION
List the 8 most likely interview questions ranked by probability. For each question write exactly these five labeled lines, then a blank line before the next question:
Q: [the interview question]
Competency: [one of: leadership, analytical, ambiguity, stakeholder, conflict, failure, building, scaling, speed, strategy, personal, accomplishment, collaboration, management]
Why this is a likely question: [one sentence specific to this role and company]
Story/Experience: [title of best-fit story from the story bank — or if no story exists, name the most relevant experience from CLAUDE.md or bullet bank; only write GAP if there is genuinely no relevant experience anywhere in any provided context]
Key points to cover:
- [point 1 — draw from story bank details if a story was named, otherwise synthesize from CLAUDE.md, bullet bank, and intake conversation]
- [point 2]
- [point 3 — up to 5 bullets total]

IMPORTANT: Before writing Story/Experience and Key points, review ALL provided context (story bank, CLAUDE.md, bullet bank). Use the story bank for narrative structure; use background files to add specific metrics and details even when a story exists. Only mark GAP if you have checked all sources and found nothing relevant.

GAP FLAGS
Identify requirements explicitly stated in the job description where the user has NO direct experience, even accounting for all context provided. Be honest and specific. Do not rationalize gaps away.

A gap exists when the JD requires something the user has not done:
- Carried a sales quota or owned a revenue number
- Managed a team of direct reports
- Held a specific technical credential or degree
- Worked in a specific industry they have no exposure to
- Done a specific function (e.g. fundraising, product management) with no adjacent experience

For each genuine gap, write three lines then a blank line:
Competency/Requirement: [what the JD explicitly requires]
Gap: [what is missing from their background — be direct]
How to address: [one honest sentence on how to acknowledge or reframe this in the interview]

If there are truly no gaps relative to the stated JD requirements, write exactly: No material gaps identified relative to stated requirements.
Do not write this unless you have checked every explicit JD requirement against her background.

BACKGROUND PITCH
Write 2 paragraphs maximum in first person. A tailored "walk me through your background" arc for this specific role. Draw on the user's actual experience as described in their background. Land on why this role is the logical next step. Rules: never use em dashes; no co-developed/co-led; no banned words (transformative, accelerate, leverage, seamless, robust, pioneering, holistic); confident declarative language.

COMPANY CONTEXT
Write 3 bullet points maximum of key facts to know and reference in the interview. Draw from the company research above. Be specific — funding stage, product, recent milestones, leadership names. After each bullet point, cite the source in brackets — the publication name, website, or URL where this information was found. Format: [Source: name or URL]. If a specific source cannot be identified, write [Source: company website] or [Source: job description] as appropriate. Never omit a source.`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 6000,
      system: systemBlocks,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  console.log('[interviewPkg] Claude token usage:', JSON.stringify(data.usage));
  const text = data.content?.[0]?.text || '';
  const parsed = parsePrepText(text);
  console.log(`[interviewPkg] Parsed ${(parsed.questionsAndPrep.match(/^Q:/gm) || []).length} questions`);
  return parsed;
}

// ── Google Doc builder ────────────────────────────────────────────────────────

function buildPrepDocRequests(parsed, jobData, dateStr, companyResearch, radarContext) {
  const FONT    = 'Calibri';
  const TITLE_PT  = 14;
  const HEADER_PT = 11;
  const BODY_PT   = 11;
  // Amber matching applicationPackage.mjs exactly
  const AMBER = { red: 1.0, green: 0.976, blue: 0.867 };
  const amberShading = { shading: { backgroundColor: { color: { rgbColor: AMBER } } } };

  // Build segments: {type, text, inGap}
  const segments = [];
  let inGap = false;

  function addLine(type, text) {
    segments.push({ type, text: text + '\n', inGap });
  }

  function addMultiline(type, content) {
    for (const raw of (content || '').split('\n')) {
      const line = raw.trim();
      if (line) addLine(type, line);
      else      addLine('blank', '');
    }
  }

  // ── Build document structure ───────────────────────────────────────────────

  addLine('title', `Interview Prep — ${jobData.title} at ${jobData.company}`);
  addLine('subtitle', dateStr);
  addLine('blank', '');

  // Section 1
  addLine('section_header', 'SECTION 1 — ROLE READ');
  addLine('blank', '');
  addMultiline('body', parsed.roleRead || '');
  addLine('blank', '');

  // Section 2 — Questions and Preparation (merged from Likely Questions + Story Mapping)
  addLine('section_header', 'SECTION 2 — QUESTIONS AND PREPARATION');
  addLine('blank', '');
  addMultiline('field', parsed.questionsAndPrep || '');
  addLine('blank', '');

  // Section 3 — Gap Flags (amber)
  inGap = true;
  addLine('section_header', 'SECTION 3 — GAP FLAGS');
  addLine('blank', '');
  addMultiline('field', parsed.gapFlags || 'No gaps identified.');
  addLine('blank', '');
  inGap = false;

  // Section 4
  addLine('section_header', 'SECTION 4 — BACKGROUND PITCH');
  addLine('blank', '');
  addMultiline('body', parsed.backgroundPitch || '');
  addLine('blank', '');

  // Section 5 — Company Context
  // Prefer radarContext (contact-level detail); fall back to companyResearch when radar is empty.
  const companyContextContent = parsed.companyContext
    || (radarContext && radarContext.trim() ? radarContext.trim() : companyResearch)
    || 'No company context available. Research recent news, funding, and leadership before the interview.';
  addLine('section_header', 'SECTION 5 — COMPANY CONTEXT');
  addLine('blank', '');
  addMultiline('body', companyContextContent);

  // ── Assign character indices (Google Docs starts at 1) ────────────────────
  const fullText = segments.map(s => s.text).join('');
  let charIdx = 1;
  for (const seg of segments) {
    seg.start = charIdx;
    seg.end   = charIdx + seg.text.length;
    charIdx  += seg.text.length;
  }

  // ── Build batchUpdate requests ────────────────────────────────────────────
  const requests = [];

  requests.push({ insertText: { location: { index: 1 }, text: fullText } });

  requests.push({
    updateDocumentStyle: {
      documentStyle: {
        marginTop:    pt(54),
        marginBottom: pt(54),
        marginLeft:   pt(72),
        marginRight:  pt(72),
      },
      fields: 'marginTop,marginBottom,marginLeft,marginRight',
    },
  });

  const base = { lineSpacing: 120, spaceAbove: pt(0), spaceBelow: pt(0) };

  for (const seg of segments) {
    const paraRange = { startIndex: seg.start, endIndex: seg.end };
    const textEnd   = seg.end - 1;
    const textRange = { startIndex: seg.start, endIndex: textEnd > seg.start ? textEnd : seg.end };

    const gapParaStyle  = seg.inGap ? { ...amberShading } : {};
    const gapParaFields = seg.inGap ? ',shading' : '';

    if (seg.type === 'blank') {
      requests.push(paraReq(paraRange,
        { ...base, alignment: 'START', ...gapParaStyle },
        `alignment,lineSpacing,spaceAbove,spaceBelow${gapParaFields}`));
      continue;
    }

    switch (seg.type) {
      case 'title':
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'START', spaceBelow: pt(2) },
          'alignment,lineSpacing,spaceAbove,spaceBelow'));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(TITLE_PT), bold: true },
          'weightedFontFamily,fontSize,bold'));
        break;

      case 'subtitle':
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'START', spaceBelow: pt(12) },
          'alignment,lineSpacing,spaceAbove,spaceBelow'));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(BODY_PT - 1),
          foregroundColor: rgb(0.45, 0.45, 0.45),
        }, 'weightedFontFamily,fontSize,foregroundColor'));
        break;

      case 'section_header': {
        const hStyle = {
          ...base,
          alignment: 'START',
          spaceAbove: pt(16),
          spaceBelow: pt(4),
          borderBottom: {
            color: seg.inGap ? rgb(0.6, 0.4, 0) : rgb(0, 0, 0),
            width: pt(0.5),
            padding: pt(2),
            dashStyle: 'SOLID',
          },
          ...gapParaStyle,
        };
        const hFields = `alignment,lineSpacing,spaceAbove,spaceBelow,borderBottom${gapParaFields}`;
        requests.push(paraReq(paraRange, hStyle, hFields));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(HEADER_PT),
          bold: true,
          ...(seg.inGap ? { foregroundColor: rgb(0.45, 0.25, 0) } : {}),
        }, seg.inGap ? 'weightedFontFamily,fontSize,bold,foregroundColor' : 'weightedFontFamily,fontSize,bold'));
        break;
      }

      case 'question':
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'START', spaceAbove: pt(4), ...gapParaStyle },
          `alignment,lineSpacing,spaceAbove,spaceBelow${gapParaFields}`));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: true },
          'weightedFontFamily,fontSize,bold'));
        break;

      case 'field': {
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'START', ...gapParaStyle },
          `alignment,lineSpacing,spaceAbove,spaceBelow${gapParaFields}`));
        const colonIdx = seg.text.indexOf(':');
        if (colonIdx > 0) {
          requests.push(textReq(
            { startIndex: seg.start, endIndex: seg.start + colonIdx + 1 },
            { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: true },
            'weightedFontFamily,fontSize,bold'));
          const afterColon = seg.start + colonIdx + 1;
          if (afterColon < textEnd) {
            requests.push(textReq(
              { startIndex: afterColon, endIndex: textEnd },
              { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false },
              'weightedFontFamily,fontSize,bold'));
          }
        } else {
          requests.push(textReq(textRange,
            { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false },
            'weightedFontFamily,fontSize,bold'));
        }
        break;
      }

      case 'body':
      default:
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'START', ...gapParaStyle },
          `alignment,lineSpacing,spaceAbove,spaceBelow${gapParaFields}`));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false },
          'weightedFontFamily,fontSize,bold'));
        break;
    }
  }

  return requests;
}

// ── Google Doc creation ───────────────────────────────────────────────────────

async function createPrepDoc(accessToken, title, requests) {
  console.log(`[interviewPkg] Creating Google Doc: "${title}" in folder ${PREP_FOLDER_ID}`);

  const createRes = await fetch(GOOGLE_DRIVE_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      parents: [PREP_FOLDER_ID],
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Drive create failed: ${createRes.status} — ${body}`);
  }

  const { id: docId } = await createRes.json();
  console.log(`[interviewPkg] Doc created: ${docId}`);

  const batchRes = await fetch(`${GOOGLE_DOCS_API}/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });

  if (!batchRes.ok) {
    const body = await batchRes.text();
    throw new Error(`Docs batchUpdate failed: ${batchRes.status} — ${body}`);
  }

  console.log(`[interviewPkg] Doc formatted (${requests.length} requests)`);
  return { docId, docUrl: `https://docs.google.com/document/d/${docId}/edit` };
}

// ── Public export ─────────────────────────────────────────────────────────────

export async function generateInterviewPrepDoc(jobData, context, conversationHistory) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');

  console.log(`[interviewPkg] Generating prep doc for ${jobData.title} at ${jobData.company}`);

  // Phase 1: Company research via web search (30s budget; non-fatal — always returns a string).
  const companyResearch = await fetchCompanyResearch(
    anthropicKey,
    jobData.company,
    jobData.url || '',
    jobData.jobDescription || ''
  );

  // Phase 2: Main prep doc generation with 110s timeout.
  const claudeCall = callClaudeForPrep(anthropicKey, jobData, context, conversationHistory, companyResearch);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Claude API timeout after 110s')), 110000)
  );
  const parsed = await Promise.race([claudeCall, timeoutPromise]);

  // Build Google Doc date string
  const dateStr = new Date().toISOString().slice(0, 10);
  const docTitle = `Interview Prep — ${jobData.title} at ${jobData.company} — ${dateStr}`;

  const requests = buildPrepDocRequests(parsed, jobData, dateStr, companyResearch, context.radarContext || '');

  const markdown = buildPrepMarkdown(parsed, jobData, companyResearch, context.radarContext || '');

  const accessToken = await getOAuthAccessToken();
  if (!accessToken) {
    // Drive not configured — return markdown only so the frontend can offer a download
    console.log('[interviewPkg] Google OAuth not configured — returning markdown only (no Drive doc)');
    return { docUrl: null, docId: null, markdown };
  }

  const driveResult = await createPrepDoc(accessToken, docTitle, requests);
  return { ...driveResult, markdown };
}
