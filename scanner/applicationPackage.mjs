// NOTE FOR MAINTAINERS: This file is sanitized for public release.
// When porting changes from a private instance, re-sanitize any
// hardcoded name, bio, or background references before committing.
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const GITHUB_API = 'https://api.github.com';
const GOOGLE_DOCS_API = 'https://docs.googleapis.com/v1/documents';
const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function readFileFromRepo(githubToken, owner, repo, filePath) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET ${filePath} failed: ${res.status}`);
  const data = await res.json();
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function callClaude(anthropicApiKey, articleDigest, bulletBank, job, roleTypes, additionalGuidance) {
  const roleTypeStr = roleTypes && roleTypes.length ? roleTypes.join(', ') : 'ops';

  const bulletBankIntro = `\nBULLET BANK: The following file contains every possible resume bullet tagged with role types and priorities. You MUST use bullets from this file verbatim -- do not rewrite, paraphrase, or combine any bullet.\n\n`;
  const bulletSelectionRules = `\n\nBULLET SELECTION RULES:\n1. Only select bullets tagged for the role types specified in the Role Type field in the job context\n2. For each theme, use only the [primary] tagged bullet. Use [alt] only if the JD specifically emphasizes that angle. Use [optional] only if the JD explicitly calls for that skill\n3. Never include two bullets on the same theme -- pick one per theme and discard the rest. Exception: for themes marked [allow-2], you may include up to 2 bullets if both are tagged for the selected role types AND they convey genuinely different information. Never include 2 bullets that overlap in meaning.\n4. Use every selected bullet verbatim -- do not change a single word\n5. Select 4-6 bullets per role section, prioritizing themes whose keywords appear in the job description\n6. Include Select Investment Experience section only if investing or corpdev is selected\n7. Use the Personal section version tagged for the primary role type -- investing version for investing roles, standard version for all others`;

  const guidanceSection = additionalGuidance && additionalGuidance.trim()
    ? `\nADDITIONAL GUIDANCE FROM USER: ${additionalGuidance.trim()}\nApply this guidance to further refine bullet selection and framing beyond the role type tags above.`
    : '';

  const resumeFormatAndClosing = `\nRESUME FORMAT RULES (First Round style, strictly 1 page):
1. Header: [YOUR NAME] (all caps), then single contact line: City, State | Phone | Email | LinkedIn
2. Professional summary: OMIT unless all required sections fit comfortably within 1 page. If included: 2 sentences max, role-specific. First: who the candidate is. Second: what they bring to THIS role. No generic language.
3. Section headers: PROFESSIONAL EXPERIENCE, EDUCATION, PERSONAL — all caps, no lines or dividers. NO SKILLS SECTION.
4. Company format: Company name in title case (never all caps) followed by a pipe and the role title, all on one line; "City, State | Dates" on the next line. Examples: "Acme Corp | Senior Director, Strategy" and "Beta Industries | VP of Operations". Company names must match their real-world casing — not all caps.
5. Bullets: Standard bullet (•) only — no dashes, no arrows, no other symbols. Lead with impact or action verb, never "responsible for." Use specific metrics where available.
6. Education: One line only — "[School Name] | [Degree] | [Honors if applicable]"
7. Personal: 4 lines max. Include any distinctive personal achievements or certifications relevant to the role type, drawn from article-digest.md. Omit anything irrelevant to the target role family.
8. Length: Strictly 1 page. If content exceeds 1 page, cut the least relevant bullets first based on the job description; never cut bullets from the candidate's current or most recent role.
9. ATS keywords: Incorporate exact phrases from the JD naturally into bullets -- integrate, do not stuff.
10. NEVER use double dashes ( -- ) anywhere in the resume. Use semicolons, hyphens, or restructure.
11. Never include anything marked sensitive or interview-prep-only.
12. Select Investment Experience: first output a single label line reading exactly "• Select Investment Experience" — title case, with the bullet glyph, no colon, NOT all caps, and NOT an all-caps section header. Then under it, output each deal as ONE bullet line that merges the deal header and the operating contribution into a single line, in this exact format: "• $[amount] [Series X] in [Company Name] ([brief description]): [operating contribution]". Use specific deals and contributions drawn verbatim from bullet-bank.md or article-digest.md — do not invent examples. One bullet per deal. Do NOT put the deal header on its own line, do NOT put the parenthetical company description on its own line, and do NOT output a separate operating bullet. No double dashes.

CRITICAL ACCURACY RULE: Use bullets verbatim from the Bullet Bank. Do not rewrite, paraphrase, or combine bullets. Do not invent facts, metrics, companies, or credentials not present in the source files.

Respond with valid JSON only — no markdown fences.`;

  const systemPrompt = bulletBank ? [
    {
      type: 'text',
      text: `You are JobBud, generating a tailored application package for the user.
${bulletBankIntro}`,
    },
    {
      type: 'text',
      text: bulletBank,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `${bulletSelectionRules}${guidanceSection}${resumeFormatAndClosing}`,
    },
  ] : `You are JobBud, generating a tailored application package for the user.
${guidanceSection}${resumeFormatAndClosing}`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 5500,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Role: ${job.title}
Company: ${job.company}
Role Type: ${roleTypeStr}
---
Generate a full application package for this role.

JOB DESCRIPTION:
${job.description || 'No description available.'}

USER'S ARTICLE DIGEST (for application questions only — do NOT use for resume bullets; bullets must come from the Bullet Bank verbatim):
${articleDigest.slice(0, 3000)}

Respond with exactly this JSON:
{
  "resume": "<full tailored resume in plain text, formatted with standard bullet points and consistent spacing>",
  "applicationQuestions": [
    {"question": "<question text>", "answer": "<draft answer>"}
  ],
  "checklist": [
    "<checklist item>"
  ],
  "tailoringNotes": "<2-3 sentences on what was emphasized, what was cut, which JD keywords were matched, and which role type bullets were prioritized>",
  "atsText": "<ATS & KEYWORD OPTIMIZATION section as plain text — use exactly the structure below>\n\nATS & KEYWORD OPTIMIZATION\n\nMISSING KEYWORDS\n[keyword or phrase]: [which role section to add it to, and in what context]\n\nSUGGESTED BULLET EDITS\nOriginal: [exact existing bullet text starting with •]\nSuggested: [replacement bullet — same facts, slightly different wording to incorporate a missing keyword]\nWhy: [one sentence explaining the keyword or phrasing benefit]\n\nATS SCORE ESTIMATE\nScore: [X/10]\n[2-3 sentences: why this score, the resume's top ATS strengths, and the most important remaining gaps]"
}

For applicationQuestions: scan the job description for explicit application questions (e.g., "Why do you want to work here?", "Describe a time when...", etc.). If none found, return an empty array.
For checklist: include 5-8 items specific to THIS role — things to verify, customize, or prepare before submitting.
For atsText: list 5-8 missing JD keywords not present in the resume, suggest 2-3 bullet edits maximum where a keyword fits naturally, and provide an ATS score 1-10. Never invent facts, change metrics, or alter company names. Keep bullet meaning identical — only rephrase to absorb a missing keyword.`,
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  console.log('[tokenUsage callClaude]', JSON.stringify(data.usage));
  const text = data.content?.[0]?.text || '';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ── Google Docs helpers ───────────────────────────────────────────────────────
// Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN

async function getOAuthAccessToken() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.log('[appPkg] OAuth env vars missing (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN) — skipping Google Docs');
    console.log('[appPkg]   GOOGLE_CLIENT_ID present:', !!clientId);
    console.log('[appPkg]   GOOGLE_CLIENT_SECRET present:', !!clientSecret);
    console.log('[appPkg]   GOOGLE_REFRESH_TOKEN present:', !!refreshToken);
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
      console.warn(`[appPkg] OAuth token exchange failed: ${res.status} — ${body}`);
      return null;
    }
    const data = await res.json();
    console.log('[appPkg] OAuth access token obtained');
    return data.access_token;
  } catch (err) {
    console.warn(`[appPkg] getOAuthAccessToken error: ${err.message}`);
    return null;
  }
}


// ── Google Docs formatting helpers ───────────────────────────────────────────

// Dimension object (used for font size, margins, indents, spacing)
function pt(n) { return { magnitude: n, unit: 'PT' }; }

// OptionalColor wrapping an RGB value (0–1 float range)
function rgb(r, g, b) {
  return { color: { rgbColor: { red: r, green: g, blue: b } } };
}

function paraReq(range, style, fields) {
  return { updateParagraphStyle: { range, paragraphStyle: style, fields } };
}

function textReq(range, style, fields) {
  return { updateTextStyle: { range, textStyle: style, fields } };
}

// Build the application questions text block to append after the ATS section.
// Format:  section header → Q: [question] → [answer text]
function formatDraftQABlock(draftQA) {
  if (!draftQA || draftQA.length === 0) return '';
  const lines = ['APPLICATION QUESTIONS (draft responses)', ''];
  for (const qa of draftQA) {
    lines.push(`Q: ${(qa.question || '').replace(/\r?\n/g, ' ').trim()}`);
    lines.push('');
    lines.push((qa.answer || '').replace(/\r?\n/g, ' ').trim());
    lines.push('');
  }
  return lines.join('\n');
}

// Classify a resume line into a formatting type.
// nonBlankCount: how many non-blank lines have been seen so far (1-based, inclusive).
// currentSection: the last ALL-CAPS section header seen (e.g. 'EDUCATION').
// inATSSection: true once the ATS advisory block begins.
// inAppQSection: true once the application questions block begins.
function classifyResumeLine(trimmed, nonBlankCount, currentSection, inATSSection, inAppQSection) {
  // Application questions block — once triggered, all lines use app_q classifiers
  if (inAppQSection) {
    if (trimmed.startsWith('Q:')) return 'app_q_question';
    return 'app_q_body';
  }

  // Application questions section header trigger (has lowercase, won't hit all-caps check)
  if (trimmed === 'APPLICATION QUESTIONS (draft responses)') return 'app_q_main_header';

  // ATS advisory block — once triggered, all subsequent lines use ATS classifiers
  if (inATSSection) {
    const isAllCaps = trimmed === trimmed.toUpperCase() && /[A-Z]{3,}/.test(trimmed) && !trimmed.includes('@');
    if (isAllCaps) return 'ats_subheader';
    // Inline label: short word/phrase before a colon within the first 30 chars
    const colonPos = trimmed.indexOf(':');
    if (colonPos > 0 && colonPos <= 30) return 'ats_inline_label';
    return 'ats_body';
  }

  // ATS section header trigger — NOT all-caps so it won't match the section_header branch
  if (trimmed === 'SUGGESTED EDITS (not part of resume)') return 'ats_main_header';

  // One-page overflow warning — detected by prefix, always first non-blank line
  if (trimmed.startsWith('⚠ WARNING:')) return 'warning';

  if (nonBlankCount === 1) return 'name';
  if (nonBlankCount === 2) return 'contact';
  // "Select Investment Experience" label — match any casing, with an optional
  // leading bullet glyph or trailing colon, BEFORE the bullet and all-caps
  // section-header checks. This guarantees it renders as an italic bullet and
  // never as a bold section header with a horizontal rule.
  if (trimmed.replace(/^•\s*/, '').replace(/:\s*$/, '').trim().toLowerCase() === 'select investment experience') {
    return 'investment_label';
  }
  if (trimmed.startsWith('•')) {
    // An investment deal bullet ("• $40M Series A in ...") sits one indent level
    // deeper than a normal role bullet — classify it as a deal sub-bullet.
    if (/^•\s*\$/.test(trimmed)) return 'deal_header';
    return 'bullet';   // •
  }
  if (trimmed.startsWith('$')) return 'deal_header';   // legacy deal header without a bullet glyph
  if (/^(Interests|Global Experience|Languages|Community|Angel):/.test(trimmed)) return 'personal_line';

  // All-caps lines with at least 3 letters and no @ = section header
  const isAllCaps = trimmed === trimmed.toUpperCase() && /[A-Z]{3,}/.test(trimmed) && !trimmed.includes('@');
  if (isAllCaps) return 'section_header';

  // In EDUCATION / PERSONAL sections the next non-blank lines are body text —
  // even if they contain | (e.g. the education line).
  if (currentSection === 'EDUCATION' || currentSection === 'PERSONAL') return 'body';

  // Lines with | but no date/month/Present are role titles;
  // lines with | and a year/month are location-date lines.
  if (trimmed.includes('|')) {
    const hasDate = /\b(20\d{2}|19\d{2}|January|February|March|April|May|June|July|August|September|October|November|December|Present)\b/.test(trimmed);
    return hasDate ? 'location_date' : 'role_title';
  }

  return 'body';
}

// Parse resumeText (and optional atsText) line-by-line and return a batchUpdate
// requests array that:
//   1. Inserts all text at document index 1
//   2. Sets document margins
//   3. Applies First Round–style formatting to resume lines
//   4. Applies amber-shaded ATS advisory formatting to atsText lines
// Count non-blank lines in a text string (used for one-page overflow check)
function countResumeLines(text) {
  return text.split('\n').filter(l => l.trim().length > 0).length;
}

function buildResumeRequests(resumeText, atsText = '', draftQA = []) {
  const FONT = 'Helvetica Neue';
  const BODY_PT = 9;       // all body text, bullets, role titles, location lines
  const NAME_PT = 11;      // name header
  const SPACER_PT = 2;     // blank spacer lines — minimal height
  // Light amber background for the ATS advisory section (0–1 float range)
  const AMBER = { red: 1.0, green: 0.976, blue: 0.867 };

  // ── Clean double dashes from resume text (replace ' -- ' with '; ')
  const cleanedResume = resumeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/ -- /g, '; ');

  // ── One-page overflow check: warn if resume exceeds ~65 non-blank lines
  const lineCount = countResumeLines(cleanedResume);
  const warningPrefix = lineCount > 65
    ? `⚠ WARNING: Resume may exceed one page (${lineCount} lines). Consider removing lower-priority bullets.\n\n`
    : '';

  // Combine warning prefix + cleaned resume, then append ATS advisory block when provided
  let combined = warningPrefix + cleanedResume;
  if (atsText && atsText.trim()) {
    const atsNorm = atsText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    combined = combined.trimEnd() + '\n\nSUGGESTED EDITS (not part of resume)\n\n' + atsNorm + '\n';
  }
  // Append application questions section when draft Q&A was generated
  if (draftQA && draftQA.length > 0) {
    const qaBlock = formatDraftQABlock(draftQA);
    combined = combined.trimEnd() + '\n\n' + qaBlock;
  }

  // Normalise line endings; ensure text ends with a newline so every line
  // in the split array has a consistent +1 character (\n) to account for.
  const text = combined.endsWith('\n') ? combined : combined + '\n';
  const lines = text.split('\n');

  // --- First pass: compute character positions and classify each line -------
  let charIdx = 1;      // Google Docs character indices start at 1
  let nonBlankCount = 0;
  let currentSection = null;
  let inATSSection = false;
  let inAppQSection = false;

  const segments = lines.map((line, i) => {
    // All elements except the last already have their \n counted in `text`;
    // the last element is always '' (empty string after the trailing \n).
    const lineText = i < lines.length - 1 ? line + '\n' : line;
    const start = charIdx;
    const end   = charIdx + lineText.length;
    charIdx += lineText.length;

    const trimmed = line.trim();
    // Blank lines in shaded sections keep their background colour
    if (!trimmed) {
      const blankType = inAppQSection ? 'app_q_blank' : inATSSection ? 'ats_blank' : 'blank';
      return { type: blankType, text: line, start, end };
    }

    nonBlankCount++;
    const type = classifyResumeLine(trimmed, nonBlankCount, currentSection, inATSSection, inAppQSection);
    if (type === 'section_header') currentSection = trimmed;
    if (type === 'ats_main_header') inATSSection = true;
    if (type === 'app_q_main_header') inAppQSection = true;
    return { type, text: line, start, end };
  });

  // --- Build requests -------------------------------------------------------
  const requests = [];

  // 1. Insert the full resume text at the start of the empty document
  requests.push({
    insertText: { location: { index: 1 }, text },
  });

  // 2. Document margins (pt: top/bottom 36, left/right 43.2)
  requests.push({
    updateDocumentStyle: {
      documentStyle: {
        marginTop:    pt(36),
        marginBottom: pt(36),
        marginLeft:   pt(43.2),
        marginRight:  pt(43.2),
      },
      fields: 'marginTop,marginBottom,marginLeft,marginRight',
    },
  });

  // 3. Per-line paragraph + text style
  const base = { lineSpacing: 100, spaceAbove: pt(0), spaceBelow: pt(0) };
  // Helper: amber paragraph style combined with other props
  const amberShading = { shading: { backgroundColor: { color: { rgbColor: AMBER } } } };

  for (const seg of segments) {
    if (seg.type === 'blank') {
      // Shrink spacer blank lines to SPACER_PT so they consume minimal vertical space
      requests.push(textReq(
        { startIndex: seg.start, endIndex: seg.end },
        { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(SPACER_PT) },
        'weightedFontFamily,fontSize'));
      continue;
    }

    // ATS blank lines — apply amber shading only (no text to style)
    if (seg.type === 'ats_blank') {
      const paraRange = { startIndex: seg.start, endIndex: seg.end };
      requests.push(paraReq(paraRange,
        { ...base, alignment: 'START', ...amberShading },
        'alignment,lineSpacing,spaceAbove,spaceBelow,shading'));
      continue;
    }

    // paraRange includes the trailing \n (paragraph mark).
    // textRange excludes it so the paragraph mark itself is not styled.
    const paraRange = { startIndex: seg.start, endIndex: seg.end };
    const textEnd   = seg.end - 1;
    const textRange = { startIndex: seg.start, endIndex: textEnd > seg.start ? textEnd : seg.end };

    switch (seg.type) {

      case 'warning':
        // One-page overflow warning — red text, centered, small top margin
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'CENTER', spaceBelow: pt(4) },
          'alignment,lineSpacing,spaceAbove,spaceBelow'));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(BODY_PT),
          bold: true,
          foregroundColor: rgb(0.8, 0, 0),
        }, 'weightedFontFamily,fontSize,bold,foregroundColor'));
        break;

      case 'name':
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'CENTER' },
          'alignment,lineSpacing,spaceAbove,spaceBelow'));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(NAME_PT), bold: true },
          'weightedFontFamily,fontSize,bold'));
        break;

      case 'contact':
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'CENTER' },
          'alignment,lineSpacing,spaceAbove,spaceBelow'));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false },
          'weightedFontFamily,fontSize,bold'));
        break;

      case 'section_header':
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          spaceAbove: pt(6),
          borderBottom: {
            color: rgb(0, 0, 0),
            width: pt(0.5),
            padding: pt(1),
            dashStyle: 'SOLID',
          },
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,borderBottom'));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: true },
          'weightedFontFamily,fontSize,bold'));
        break;

      case 'role_title':
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'START', spaceAbove: pt(5) },
          'alignment,lineSpacing,spaceAbove,spaceBelow'));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: true },
          'weightedFontFamily,fontSize,bold'));
        break;

      case 'location_date':
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'START' },
          'alignment,lineSpacing,spaceAbove,spaceBelow'));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(BODY_PT),
          bold: false,
          foregroundColor: rgb(0.333, 0.333, 0.333),
        }, 'weightedFontFamily,fontSize,bold,foregroundColor'));
        break;

      case 'bullet':
        // indentFirstLine = 18pt (bullet •), indentStart = 27pt (text wrap)
        // This creates a 9pt hanging indent.
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          indentFirstLine: pt(18),
          indentStart: pt(27),
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,indentFirstLine,indentStart'));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false },
          'weightedFontFamily,fontSize,bold'));
        break;

      case 'investment_label':
        // Rendered as an italicised bullet at the same hanging-indent level as
        // other role bullets — not as a standalone section header above the deals.
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          indentFirstLine: pt(18),
          indentStart: pt(27),
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,indentFirstLine,indentStart'));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false, italic: true },
          'weightedFontFamily,fontSize,bold,italic'));
        break;

      case 'deal_header':
        // Sub-bullet indented one level deeper than investment_label so individual
        // deals sit visually underneath "Select Investment Experience".
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          spaceAbove: pt(2),
          indentFirstLine: pt(27),
          indentStart: pt(36),
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,indentFirstLine,indentStart'));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false },
          'weightedFontFamily,fontSize,bold'));
        break;

      case 'personal_line': {
        requests.push(paraReq(paraRange,
          { ...base, alignment: 'START' },
          'alignment,lineSpacing,spaceAbove,spaceBelow'));
        const colonIdx = seg.text.indexOf(':');
        if (colonIdx > 0) {
          // Bold the label up to and including the colon
          requests.push(textReq(
            { startIndex: seg.start, endIndex: seg.start + colonIdx + 1 },
            { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: true },
            'weightedFontFamily,fontSize,bold'));
          // Normal weight for the value after the colon
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
          { ...base, alignment: 'START' },
          'alignment,lineSpacing,spaceAbove,spaceBelow'));
        requests.push(textReq(textRange,
          { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false },
          'weightedFontFamily,fontSize,bold'));
        break;

      // ── ATS advisory section ──────────────────────────────────────────────

      case 'ats_main_header':
        // "SUGGESTED EDITS (not part of resume)" — bold italic, amber bg, top border
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          spaceAbove: pt(14),
          borderTop: {
            color: rgb(0.6, 0.4, 0),
            width: pt(1),
            padding: pt(3),
            dashStyle: 'SOLID',
          },
          ...amberShading,
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,borderTop,shading'));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(BODY_PT),
          bold: true,
          italic: true,
          foregroundColor: rgb(0.45, 0.25, 0),
        }, 'weightedFontFamily,fontSize,bold,italic,foregroundColor'));
        break;

      case 'ats_subheader':
        // All-caps headers inside the ATS block (e.g. "MISSING KEYWORDS")
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          spaceAbove: pt(7),
          ...amberShading,
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,shading'));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(BODY_PT),
          bold: true,
          italic: false,
          foregroundColor: rgb(0, 0, 0),
        }, 'weightedFontFamily,fontSize,bold,italic,foregroundColor'));
        break;

      case 'ats_inline_label': {
        // Lines like "Original:", "Suggested:", "Why:", "Score:", "keyword: suggestion"
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          ...amberShading,
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,shading'));
        const colonIdx = seg.text.indexOf(':');
        if (colonIdx > 0) {
          // Bold up to and including the colon
          requests.push(textReq(
            { startIndex: seg.start, endIndex: seg.start + colonIdx + 1 },
            { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: true, italic: false },
            'weightedFontFamily,fontSize,bold,italic'));
          // Normal for the value after the colon
          const afterColon = seg.start + colonIdx + 1;
          if (afterColon < textEnd) {
            requests.push(textReq(
              { startIndex: afterColon, endIndex: textEnd },
              { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false, italic: false },
              'weightedFontFamily,fontSize,bold,italic'));
          }
        } else {
          requests.push(textReq(textRange,
            { weightedFontFamily: { fontFamily: FONT }, fontSize: pt(BODY_PT), bold: false, italic: false },
            'weightedFontFamily,fontSize,bold,italic'));
        }
        break;
      }

      case 'ats_body':
        // Regular advisory text — amber bg, normal weight
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          ...amberShading,
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,shading'));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(BODY_PT),
          bold: false,
          italic: false,
          foregroundColor: rgb(0, 0, 0),
        }, 'weightedFontFamily,fontSize,bold,italic,foregroundColor'));
        break;

      // ── Application questions section ─────────────────────────────────────
      // Light blue background throughout, distinct from the amber ATS section.

      case 'app_q_blank': {
        const BLUE_BG = { red: 0.863, green: 0.929, blue: 0.976 };
        const blueShading = { shading: { backgroundColor: { color: { rgbColor: BLUE_BG } } } };
        requests.push(paraReq(
          { startIndex: seg.start, endIndex: seg.end },
          { ...base, alignment: 'START', ...blueShading },
          'alignment,lineSpacing,spaceAbove,spaceBelow,shading'));
        break;
      }

      case 'app_q_main_header': {
        const BLUE_BG = { red: 0.863, green: 0.929, blue: 0.976 };
        const blueShading = { shading: { backgroundColor: { color: { rgbColor: BLUE_BG } } } };
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          spaceAbove: pt(14),
          borderTop: {
            color: rgb(0.15, 0.40, 0.75),
            width: pt(1),
            padding: pt(3),
            dashStyle: 'SOLID',
          },
          ...blueShading,
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,borderTop,shading'));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(BODY_PT),
          bold: true,
          italic: true,
          foregroundColor: rgb(0.10, 0.28, 0.60),
        }, 'weightedFontFamily,fontSize,bold,italic,foregroundColor'));
        break;
      }

      case 'app_q_question': {
        const BLUE_BG = { red: 0.863, green: 0.929, blue: 0.976 };
        const blueShading = { shading: { backgroundColor: { color: { rgbColor: BLUE_BG } } } };
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          spaceAbove: pt(6),
          ...blueShading,
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,shading'));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(BODY_PT),
          bold: true,
          italic: false,
          foregroundColor: rgb(0, 0, 0),
        }, 'weightedFontFamily,fontSize,bold,italic,foregroundColor'));
        break;
      }

      case 'app_q_body': {
        const BLUE_BG = { red: 0.863, green: 0.929, blue: 0.976 };
        const blueShading = { shading: { backgroundColor: { color: { rgbColor: BLUE_BG } } } };
        requests.push(paraReq(paraRange, {
          ...base,
          alignment: 'START',
          ...blueShading,
        }, 'alignment,lineSpacing,spaceAbove,spaceBelow,shading'));
        requests.push(textReq(textRange, {
          weightedFontFamily: { fontFamily: FONT },
          fontSize: pt(BODY_PT),
          bold: false,
          italic: true,
          foregroundColor: rgb(0.18, 0.18, 0.18),
        }, 'weightedFontFamily,fontSize,bold,italic,foregroundColor'));
        break;
      }
    }
  }

  return requests;
}

async function createGoogleDoc(accessToken, title, resumeText, atsText = '', draftQA = []) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  console.log(`[appPkg] Creating Google Doc: "${title}" | folderId: ${folderId || '(none)'}`);

  // Step 1: Create an empty Google Doc via Drive API.
  // parents is omitted when folderId is not set — doc lands in root My Drive.
  const fileMetadata = {
    name: title,
    mimeType: 'application/vnd.google-apps.document',
    ...(folderId ? { parents: [folderId] } : {}),
  };

  const createRes = await fetch(GOOGLE_DRIVE_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fileMetadata),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Drive create failed: ${createRes.status} — ${body}`);
  }

  const { id: docId } = await createRes.json();
  console.log(`[appPkg] Doc created with id: ${docId}`);

  // Step 2: Insert text + apply First Round resume formatting + ATS advisory + Q&A section
  const requests = buildResumeRequests(resumeText, atsText, draftQA);
  console.log(`[appPkg] Sending batchUpdate with ${requests.length} requests`);

  const batchRes = await fetch(`${GOOGLE_DOCS_API}/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });

  if (!batchRes.ok) {
    const body = await batchRes.text();
    throw new Error(`Docs batchUpdate failed: ${batchRes.status} — ${body}`);
  }

  console.log(`[appPkg] Formatting applied (${requests.length} requests)`);
  return `https://docs.google.com/document/d/${docId}/edit`;
}

// ── Application question helpers ─────────────────────────────────────────────

// Parse raw textarea input into individual question strings.
// Handles numbered prefixes (1. / 1) / Q1. / Question 1: / (1)),
// blank-line-separated blocks, and plain newline lists.
function parseApplicationQuestions(raw) {
  if (!raw || !raw.trim()) return [];
  const text = raw.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Try numbered prefixes first
  const numberedSplit = text.split(/\n(?=\s*(?:\d+[.):]|Q\d+[.:]|Question\s+\d+[.:]|\(\d+\)))/i);
  if (numberedSplit.length > 1) {
    return numberedSplit
      .map(s => s.replace(/^\s*(?:\d+[.):]|Q\d+[.:]|Question\s+\d+[.:]|\(\d+\))\s*/i, '').trim())
      .filter(q => q.length > 5);
  }

  // Try blank-line separation
  const blankSplit = text.split(/\n\s*\n/).map(s => s.trim()).filter(q => q.length > 5);
  if (blankSplit.length > 1) return blankSplit;

  // Fall back to single newlines
  return text.split('\n').map(s => s.trim()).filter(q => q.length > 5);
}

// Generate draft responses for application questions using a single Sonnet call.
// Returns [{question, answer}] in the same order as the input.
// Errors are non-fatal — returns an empty array so the package still generates.
async function callClaudeDraftQA(anthropicApiKey, job, articleDigest, questions) {
  const questionList = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are JobBud, drafting application question responses for the user applying to ${job.title} at ${job.company}.

USER BACKGROUND — use this as your only source of facts. Do not invent credentials, metrics, or experience not listed here:
${articleDigest.slice(0, 2500)}

Write draft responses that:
- Are in first person ("I", "my")
- Draw specifically on the user's actual experience as described in the USER BACKGROUND above
- Are tailored to the company and role
- Are 2–4 sentences — concise and direct, not padded
- Are clearly labelled as drafts for the user to review and edit

Respond with valid JSON only — no markdown fences.`,
      messages: [{
        role: 'user',
        content: `Draft responses for these application questions for ${job.title} at ${job.company}.

JOB CONTEXT:
${(job.description || '').slice(0, 1000)}

QUESTIONS:
${questionList}

Respond with exactly this JSON:
{
  "draftResponses": [
    {"question": "<question text verbatim>", "answer": "<draft response, 2-4 sentences, first person>"}
  ]
}

Return one entry per question in the same order as the input list.`,
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  console.log('[tokenUsage callClaudeDraftQA]', JSON.stringify(data.usage));
  const text = data.content?.[0]?.text || '';
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  return Array.isArray(parsed.draftResponses) ? parsed.draftResponses : [];
}

export async function generateAndSendPackage(job, jobId, options = {}) {
  const { roleTypes = [], additionalGuidance = '', applicationQuestions: rawApplicationQuestions = '' } = options;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const githubToken = process.env.GH_TOKEN;
  const githubRepo = process.env.GH_REPO;
  const [owner, repo] = githubRepo.split('/');

  if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!githubToken) throw new Error('GH_TOKEN not set');

  console.log(`[appPkg] Generating package for ${job.company} — ${job.title}`);
  console.log('[appPkg] roleTypes:', roleTypes, '| additionalGuidance length:', additionalGuidance.length);
  console.log('[appPkg] GOOGLE_DRIVE_FOLDER_ID:', process.env.GOOGLE_DRIVE_FOLDER_ID || 'NOT SET');

  // Read source files from the repo in parallel
  const [articleDigest, bulletBankRaw] = await Promise.all([
    readFileFromRepo(githubToken, owner, repo, 'article-digest.md').catch(() => ''),
    readFileFromRepo(githubToken, owner, repo, 'bullet-bank.md').catch(() => null),
  ]);

  let bulletBank = bulletBankRaw;
  if (!bulletBank || bulletBank.length < 50) {
    console.log('[appPkg] bullet-bank.md not found or empty — falling back to cv.md');
    bulletBank = await readFileFromRepo(githubToken, owner, repo, 'cv.md').catch(() => null);
    if (bulletBank) console.log(`[appPkg] cv.md fallback loaded (${bulletBank.length} chars)`);
  } else {
    console.log(`[appPkg] bullet-bank.md loaded (${bulletBank.length} chars)`);
  }

  // Generate package + ATS analysis in a single Claude call
  const pkg = await callClaude(anthropicApiKey, articleDigest, bulletBank, job, roleTypes, additionalGuidance);

  // Extract ATS text from the same response (no second API call needed)
  const atsText = pkg.atsText || '';
  if (atsText) {
    console.log(`[appPkg] ATS analysis included in package (${atsText.length} chars)`);
  } else {
    console.warn('[appPkg] No ATS text returned — Google Doc will be created without it');
  }

  // Generate draft responses for application questions, if any were pasted in.
  // This is a separate Sonnet call — non-fatal if it fails.
  let draftQA = [];
  const parsedQuestions = parseApplicationQuestions(rawApplicationQuestions);
  if (parsedQuestions.length > 0) {
    console.log(`[appPkg] Generating draft responses for ${parsedQuestions.length} application question(s)`);
    try {
      draftQA = await callClaudeDraftQA(anthropicApiKey, job, articleDigest, parsedQuestions);
      console.log(`[appPkg] Draft Q&A generated (${draftQA.length} response(s))`);
    } catch (err) {
      console.warn(`[appPkg] Draft Q&A generation failed — omitting from doc: ${err.message}`);
      draftQA = [];
    }
  }

  // Create Google Doc via OAuth
  let docUrl = null;
  try {
    const accessToken = await getOAuthAccessToken();
    if (accessToken) {
      const docTitle = `${job.title} at ${job.company} — Application Package`;
      console.log(`[appPkg] Calling createGoogleDoc: "${docTitle}"`);
      docUrl = await createGoogleDoc(accessToken, docTitle, pkg.resume || '', atsText, draftQA);
      console.log(`[appPkg] Google Doc created: ${docUrl}`);
    }
  } catch (err) {
    console.warn(`[appPkg] Google Doc creation failed: ${err.message}`);
  }

  console.log(`[appPkg] Package ready for ${job.company} — ${job.title}`);
  return { pkg, docUrl };
}
