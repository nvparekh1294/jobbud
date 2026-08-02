// Pins full package delivery without Google Drive: the ATS analysis reaches the
// user, the whole package can be downloaded as one self-contained file, and the
// Google Doc path still works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const html = readFileSync(join(ROOT, 'dashboard', 'index.html'), 'utf8');
const actionSrc = readFileSync(join(ROOT, 'api', 'action.js'), 'utf8');
const pkgSrc = readFileSync(join(ROOT, 'scanner', 'applicationPackage.mjs'), 'utf8');

// Brace-walk a top-level function body out of the dashboard source.
function extractFunction(source, name) {
  const startIdx = source.indexOf(`function ${name}`);
  if (startIdx === -1) return null;
  const braceStart = source.indexOf('{', startIdx);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return source.slice(startIdx, i + 1); }
  }
  return null;
}

// buildPackageHtml is pure string work, so it can be evaluated and exercised
// directly — this is a behavioural test, not a grep over source.
const src = extractFunction(html, 'buildPackageHtml');
assert.ok(src, 'buildPackageHtml not found in dashboard/index.html');
// eslint-disable-next-line no-new-func
const buildPackageHtml = new Function(`${src}; return buildPackageHtml;`)();

const CONTENT = {
  title: 'Application Package: Head of Ops at Acme Corp',
  resume: 'ALEX DOE\nAustin, TX | alex@example.com\n\n• Did the thing',
  applicationQuestions: [{ question: 'Why us?', answer: 'Because.' }],
  checklist: ['Check the salary band'],
  tailoringNotes: 'Led with operations bullets.',
  atsText: 'ATS & KEYWORD OPTIMIZATION\n\nATS SCORE ESTIMATE\nScore: 8/10\n\nSUGGESTED ADDITIONS\nSuggested: Ran the vendor consolidation\nWhy: Fills the cost-ownership gap.',
};

// ── The API now hands the ATS analysis back ───────────────────────────────────

test('api/action.js returns atsText in the dashboard package payload', () => {
  assert.match(actionSrc, /atsText: pkg\.atsText \|\| ''/);
  // It must sit in the same content object the dashboard renders.
  const contentBlock = actionSrc.slice(actionSrc.indexOf('content: {'), actionSrc.indexOf('});', actionSrc.indexOf('content: {')));
  for (const field of ['resume', 'applicationQuestions', 'checklist', 'tailoringNotes', 'atsText']) {
    assert.ok(contentBlock.includes(`${field}:`), `content payload is missing ${field}`);
  }
});

test('the Google Doc path is unchanged — atsText still goes into the doc', () => {
  assert.match(pkgSrc, /createGoogleDoc\(accessToken, docTitle, pkg\.resume \|\| '', atsText, draftQA\)/);
});

// ── The panel renders everything ──────────────────────────────────────────────

test('the package panel renders the ATS analysis', () => {
  const out = buildPackageHtml(CONTENT);
  assert.match(out, /ATS &amp; Keyword Analysis/);
  assert.ok(out.includes('Score: 8/10'));
  assert.ok(out.includes('SUGGESTED ADDITIONS'));
  // Framed as advisory, matching the hard rule in the generation prompt.
  assert.match(out, /Suggestions only/);
});

test('the panel omits the ATS section when no analysis came back', () => {
  const out = buildPackageHtml({ ...CONTENT, atsText: '' });
  assert.doesNotMatch(out, /ATS &amp; Keyword Analysis/);
  // Everything else still renders.
  assert.ok(out.includes('Did the thing'));
  assert.ok(out.includes('Why us?'));
});

test('the panel shows the full package alongside a Google Doc link', () => {
  const out = buildPackageHtml({ ...CONTENT, docUrl: 'https://docs.google.com/document/d/abc123/edit' });
  assert.ok(out.includes('https://docs.google.com/document/d/abc123/edit'));
  assert.match(out, /open the Google Doc/);
  // The Doc does not replace the panel — the analysis is still there.
  assert.ok(out.includes('Score: 8/10'));
});

test('a non-Docs docUrl is never rendered as a link', () => {
  const out = buildPackageHtml({ ...CONTENT, docUrl: 'javascript:alert(1)' });
  assert.doesNotMatch(out, /open the Google Doc/);
  assert.ok(!out.includes('javascript:alert(1)'));
});

test('AI content is escaped, not interpolated, everywhere in the panel', () => {
  const nasty = '</pre><img src=x onerror=alert(1)>';
  const out = buildPackageHtml({
    ...CONTENT,
    atsText: nasty,
    resume: nasty,
    tailoringNotes: nasty,
    checklist: [nasty],
    applicationQuestions: [{ question: nasty, answer: nasty }],
  });
  // Check the rendered markup only. The same strings also appear inside the
  // page's <script> block as JS string literals, where the HTML parser does not
  // interpret them — that path is covered by the script-breakout test below.
  const markup = out.slice(0, out.indexOf('<script>'));
  assert.ok(!markup.includes('<img src=x'), 'raw markup survived into the panel');
  assert.ok(markup.includes('&lt;img src=x'));
});

test('AI content cannot break out of the embedded script block', () => {
  const out = buildPackageHtml({
    ...CONTENT,
    atsText: 'oops </script><script>alert(1)</script>',
    resume: '<!-- <script>alert(2)</script>',
  });
  const script = out.slice(out.indexOf('<script>') + 8);
  // Nothing in the script block may terminate it early, and `<!--` must not flip
  // the parser into script-double-escaped state.
  assert.ok(!script.slice(0, script.indexOf('<\\/script>')).includes('</script>'));
  assert.match(out, /<\\\/script>/);
  assert.ok(!script.includes('<!--'), 'raw <!-- reached the script block');
});

// ── Download ──────────────────────────────────────────────────────────────────

test('the panel offers a Download button backed by a client-side Blob', () => {
  const out = buildPackageHtml(CONTENT);
  assert.match(out, /onclick="downloadPackage\(\)"/);
  assert.match(out, /new Blob\(\[html\]/);
  assert.match(out, /URL\.createObjectURL/);
  assert.match(out, /a\.download = FILENAME \+ '\.html'/);
});

test('the downloaded file is self-contained: no external resources, scripts stripped', () => {
  const out = buildPackageHtml(CONTENT);
  // Nothing is fetched at render or open time.
  assert.doesNotMatch(out, /<link\b/);
  assert.doesNotMatch(out, /<script[^>]+src=/);
  assert.doesNotMatch(out, /https?:\/\/(?!docs\.google\.com)/);
  // The clone drops the toolbar and the scripts, so the saved file is static.
  assert.match(out, /clone\.querySelectorAll\('script,\.topbar,\.toast'\)/);
});

test('the download carries print CSS so print-to-PDF is clean', () => {
  const out = buildPackageHtml(CONTENT);
  assert.match(out, /@media print/);
  assert.match(out, /\.topbar,\.toast\{display:none !important\}/);
  assert.match(out, /break-inside:avoid/);
});

test('the download filename is derived safely from the package title', () => {
  const out = buildPackageHtml({ ...CONTENT, title: 'Ops @ Acme/Corp <script>' });
  const m = out.match(/var FILENAME = "([^"]*)"/);
  assert.ok(m, 'FILENAME not embedded');
  assert.doesNotMatch(m[1], /[/\\<>@]/);
});

test('Copy Full Package includes the ATS analysis', () => {
  const out = buildPackageHtml(CONTENT);
  const full = out.match(/var FULL\s+= (".*?");\n/s);
  assert.ok(full, 'FULL payload not embedded');
  const text = JSON.parse(full[1]);
  assert.match(text, /ATS & KEYWORD ANALYSIS/);
  assert.match(text, /Score: 8\/10/);
  assert.match(text, /TAILORING NOTES/);
  assert.match(text, /Why us\?/);
});

// ── The user's own pasted questions get their answers back ────────────────────
// Exactly the bug atsText had: draftQA was generated on every package and handed
// only to createGoogleDoc, so without Drive the user paid for answers to the
// questions THEY typed in and never saw them.

const DRAFT_QA = [{ question: 'Describe a time you led <a> change', answer: 'I led the migration.\nIt shipped early.' }];

test('generateAndSendPackage returns draftQA instead of only feeding it to Drive', () => {
  assert.match(pkgSrc, /return \{ pkg, docUrl, draftQA, resumeSource \};/);
});

test('api/action.js carries draftQA in the dashboard package payload', () => {
  assert.match(actionSrc, /const \{ pkg, docUrl, draftQA, resumeSource \} = await generateAndSendPackage/);
  const contentBlock = actionSrc.slice(actionSrc.indexOf('content: {'), actionSrc.indexOf('});', actionSrc.indexOf('content: {')));
  assert.ok(contentBlock.includes('draftQA:'), 'content payload is missing draftQA');
  assert.ok(contentBlock.includes('resumeSource:'), 'content payload is missing resumeSource');
});

test('the panel renders pasted-form answers and labels both question streams', () => {
  const out = buildPackageHtml({ ...CONTENT, draftQA: DRAFT_QA });
  assert.ok(out.includes('From your application form'));
  assert.ok(out.includes('Found in the job description'));
  assert.ok(out.includes('I led the migration.'), 'the pasted question\'s answer never rendered');
  assert.ok(out.includes('Why us?'), 'the JD-derived questions were lost');
  // Same escaping as everywhere else in the panel. Check the rendered markup
  // only — the raw text also appears in the page's <script> as a JS string
  // literal, where the HTML parser does not interpret it.
  const markup = out.slice(0, out.indexOf('<script>'));
  assert.ok(markup.includes('&lt;a&gt; change'));
  assert.ok(!markup.includes('<a> change'), 'raw markup survived into the panel');
  // The pasted-form stream comes first — the user asked for those by name.
  assert.ok(out.indexOf('From your application form') < out.indexOf('Found in the job description'));
});

test('the panel labels nothing when only one question stream exists', () => {
  const jdOnly = buildPackageHtml(CONTENT);
  assert.ok(!jdOnly.includes('From your application form'));
  assert.ok(jdOnly.includes('Found in the job description'));

  const formOnly = buildPackageHtml({ ...CONTENT, applicationQuestions: [], draftQA: DRAFT_QA });
  assert.ok(formOnly.includes('From your application form'));
  assert.ok(!formOnly.includes('Found in the job description'));

  const neither = buildPackageHtml({ ...CONTENT, applicationQuestions: [], draftQA: [] });
  assert.doesNotMatch(neither, /Application Questions/);
});

test('Copy Full Package and the download include the pasted-form answers', () => {
  const out = buildPackageHtml({ ...CONTENT, draftQA: DRAFT_QA });
  const full = out.match(/var FULL\s+= (".*?");\n/s);
  assert.ok(full, 'FULL payload not embedded');
  const text = JSON.parse(full[1]);
  assert.match(text, /\[From your application form\]/);
  assert.match(text, /\[Found in the job description\]/);
  assert.match(text, /I led the migration\./);
  assert.match(text, /Why us\?/);
});

// ── The ATS note tells the truth about where the resume came from ─────────────

test('the ATS note names the real resume source in all three modes', () => {
  const note = c => buildPackageHtml({ ...CONTENT, ...c }).match(/<p class="ats-note">([^<]*)<\/p>/)[1];

  assert.equal(note({ resumeSource: 'bank' }),
    'Suggestions only — the resume above uses your bullet bank verbatim. Nothing here has been applied.');
  assert.equal(note({ resumeSource: 'cv' }),
    'Suggestions only — the resume above uses your resume&#x27;s own wording. Nothing here has been applied.'
      .replace('&#x27;', "'"));
  assert.equal(note({ resumeSource: 'ai-drafted' }),
    'No resume on file — this draft is AI-written; treat every line as a suggestion to verify. Nothing here has been applied.');
});

test('the ATS note never claims the bullet bank was used when it was not', () => {
  for (const resumeSource of ['cv', 'ai-drafted', undefined, 'something-new']) {
    const out = buildPackageHtml({ ...CONTENT, resumeSource });
    assert.ok(!out.includes('uses your bullet bank verbatim'),
      `resumeSource=${resumeSource} still claims the bullet bank was used verbatim`);
  }
});

test('an unrecognized resumeSource falls back to a claim that is true in every mode', () => {
  const out = buildPackageHtml({ ...CONTENT, resumeSource: 'not-a-mode' });
  assert.ok(out.includes('Suggestions only — nothing here has been applied to the resume above.'));
});

test('generateAndSendPackage derives resumeSource from the real bank/cv decision', () => {
  assert.match(pkgSrc, /const resumeSource = \(hadOwnBank && usableBank\) \? 'bank' : \(hasCv \? 'cv' : 'ai-drafted'\);/);
});

// ── AI-drafted suggestions carry an accuracy warning ─────────────────────────

const ACCURACY = /AI-drafted from your conversation, not from your resume — they may not be 100% accurate/;

test('the panel warns that Suggested Additions are AI-drafted and need checking', () => {
  const out = buildPackageHtml(CONTENT);
  assert.match(out, ACCURACY);
  assert.match(out, /Review and edit each one for accuracy before using it anywhere/);
});

test('the warning rides along in Copy Full Package and the download', () => {
  const out = buildPackageHtml(CONTENT);
  const text = JSON.parse(out.match(/var FULL\s+= (".*?");\n/s)[1]);
  assert.match(text, ACCURACY);
});

test('the generation prompt tells the model each suggestion is an unverified draft', () => {
  // In the atsText structure the model copies...
  assert.match(pkgSrc, /These are AI-drafted from what you described in conversation, not taken from your resume\. Treat each as a draft/);
  // ...and in the instructions that govern the block.
  assert.match(pkgSrc, /Every entry here is a DRAFT, not a fact on file/);
  assert.match(pkgSrc, /never present these as verified/);
});

test('the bullet-bank file itself carries the accuracy warning', () => {
  const coachSrc = readFileSync(join(ROOT, 'api', 'coach.js'), 'utf8');
  const start = coachSrc.indexOf('const BULLET_BANK_SYSTEM');
  const prompt = coachSrc.slice(start, coachSrc.indexOf('function buildOnboardingShared', start));
  assert.match(prompt, /may not be 100% accurate/);
  assert.match(prompt, /Review and edit each one before using it anywhere/);
});

// ── The resume is typeset, not dumped into a <pre> ───────────────────────────
// The classification rules mirror classifyResumeLine in
// scanner/applicationPackage.mjs, which is what formats the Google Doc. These
// tests pin the panel to the same structure so the two cannot drift apart
// unnoticed.

const TYPESET_RESUME = [
  'ALEX DOE',
  'Austin, TX | 512-555-0100 | alex@example.com | linkedin.com/in/alexdoe',
  '',
  'PROFESSIONAL EXPERIENCE',
  '',
  'Acme Corp | Senior Operations Manager',
  'Austin, TX | 2021 - Present',
  '• Redesigned the quarterly planning process across 6 teams, cutting cycle time 40%',
  '• Built the vendor scorecard that consolidated 14 contracts into 4',
  '',
  'Beta Industries | Strategy Associate',
  'New York, NY | March 2018 - 2021',
  '• Led the competitive teardown that reset pricing for the enterprise tier',
  '',
  '• Select Investment Experience',
  '• $40M Series B in Northwind Robotics (warehouse automation): built the diligence model',
  '',
  'EDUCATION',
  'State University | BS Economics | magna cum laude',
  '',
  'PERSONAL',
  'Interests: distance swimming, hand-built espresso',
  'Languages: English, Portuguese',
].join('\n');

const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The rendered resume block only — not the <script>, where the same text also
// appears verbatim as a JS string literal.
function resumeBlock(out) {
  const start = out.indexOf('<div id="resume"');
  assert.notEqual(start, -1, 'the typeset resume block is missing');
  return out.slice(start, out.indexOf('</section>', start));
}

test('the typeset resume keeps every line of the plain text, in order', () => {
  const block = resumeBlock(buildPackageHtml({ ...CONTENT, resume: TYPESET_RESUME }));
  let cursor = -1;
  for (const raw of TYPESET_RESUME.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // The • glyph becomes the list marker that CSS draws back in. The verbatim
    // text, glyph and all, still reaches the clipboard through RESUME — pinned
    // by the Copy Resume test below.
    const expected = escHtml(line.replace(/^•\s*/, ''));
    const at = block.indexOf(expected, cursor);
    assert.notEqual(at, -1, `line missing from the typeset resume: ${line}`);
    assert.ok(at > cursor, `line rendered out of order: ${line}`);
    cursor = at;
  }
});

test('the typeset resume uses real document structure, not a monospace dump', () => {
  const block = resumeBlock(buildPackageHtml({ ...CONTENT, resume: TYPESET_RESUME }));
  assert.ok(!block.includes('<pre'), 'the resume is still rendered as preformatted text');

  // Name in a header element, contact line muted beneath it.
  assert.match(block, /<h1 class="r-name">ALEX DOE<\/h1>/);
  assert.match(block, /<p class="r-contact">Austin, TX \| 512-555-0100/);

  // ALL-CAPS lines are section headings.
  for (const s of ['PROFESSIONAL EXPERIENCE', 'EDUCATION', 'PERSONAL']) {
    assert.ok(block.includes(`<h3 class="r-section">${s}</h3>`), `${s} did not render as a section heading`);
  }

  // "Company | Role" is bold, "City, State | Dates" is the muted line beneath.
  assert.match(block, /<p class="r-role">Acme Corp \| Senior Operations Manager<\/p>\n<p class="r-meta">Austin, TX \| 2021 - Present<\/p>/);
  assert.match(block, /<p class="r-role">Beta Industries \| Strategy Associate<\/p>\n<p class="r-meta">New York, NY \| March 2018 - 2021<\/p>/);

  // Bullets are a real list.
  assert.match(block, /<ul class="r-bullets">/);
  assert.match(block, /<li>Redesigned the quarterly planning process across 6 teams, cutting cycle time 40%<\/li>/);

  // The Select Investment Experience LABEL is a label, never a section header
  // or a bullet; the deal beneath it is a sub-bullet.
  assert.match(block, /<p class="r-invest">Select Investment Experience<\/p>/);
  assert.ok(!block.includes('<h3 class="r-section">• Select Investment Experience'));
  assert.match(block, /<li class="r-deal">\$40M Series B in Northwind Robotics/);

  // A line with pipes inside EDUCATION is body text, not a role title — the
  // sibling classifier's currentSection rule.
  assert.match(block, /<p class="r-body">State University \| BS Economics \| magna cum laude<\/p>/);
  assert.match(block, /<p class="r-personal">Interests: distance swimming/);
});

test('an unclassifiable line becomes a plain paragraph rather than vanishing', () => {
  const odd = 'ALEX DOE\ncontact line here\n\njust some prose that fits no rule at all\n';
  const block = resumeBlock(buildPackageHtml({ ...CONTENT, resume: odd }));
  assert.match(block, /<p class="r-body">just some prose that fits no rule at all<\/p>/);
});

test('Copy Resume still copies the PLAIN text, glyphs and line breaks intact', () => {
  const out = buildPackageHtml({ ...CONTENT, resume: TYPESET_RESUME });
  const m = out.match(/var RESUME\s+= (".*?");\n/s);
  assert.ok(m, 'RESUME payload not embedded');
  assert.equal(JSON.parse(m[1]), TYPESET_RESUME);
  // The button is still wired to the plain payload, not to the typeset markup.
  assert.match(out, /onclick="copyResume\(\)"/);
  assert.match(out, /function copyResume\(\)\{copyText\(RESUME\)\}/);
});

test('hostile resume content is escaped in the typeset view', () => {
  const nasty = '</div><img src=x onerror=alert(1)>\n"quoted" & <b>bold</b>\n• </ul><script>alert(2)</script>';
  const block = resumeBlock(buildPackageHtml({ ...CONTENT, resume: nasty }));
  assert.ok(!block.includes('<img src=x'), 'raw markup survived into the typeset resume');
  assert.ok(!block.includes('<b>bold</b>'));
  assert.ok(!block.includes('<script>alert(2)'));
  assert.ok(block.includes('&lt;img src=x'));
  assert.ok(block.includes('&lt;b&gt;bold&lt;/b&gt;'));
  // Only the renderer's own tags remain.
  assert.match(block, /<li>&lt;\/ul&gt;&lt;script&gt;alert\(2\)/);
});

test('print CSS turns the resume section into a resume page', () => {
  const out = buildPackageHtml({ ...CONTENT, resume: TYPESET_RESUME });
  const print = out.slice(out.indexOf('@media print'), out.indexOf('</style>'));
  assert.match(print, /@page\{margin:0\.5in\}/);
  assert.match(print, /section\.resume\{[^}]*page-break-after:always/);   // its own page
  assert.match(print, /section\.resume h2\{display:none\}/);              // no card label
  assert.match(print, /\.r-doc\{font-family:Georgia/);                    // serif document face
  assert.match(print, /\.r-name\{font-size:19pt/);                        // name prominent
  // The other sections keep the treatment they already had.
  assert.match(print, /section\{border:none;border-radius:0/);
  assert.match(print, /\.topbar,\.toast\{display:none !important\}/);
});

test('the panel renderer points at its sibling so the two stay in step', () => {
  const fn = extractFunction(html, 'buildPackageHtml');
  assert.match(fn, /SIBLING: scanner\/applicationPackage\.mjs/);
  assert.match(fn, /classifyResumeLine/);
});

// ── The panel is no longer bypassed when Drive is configured ──────────────────

test('submitRoleModal renders the panel even when a Google Doc was created', () => {
  const fn = extractFunction(html, 'submitRoleModal');
  assert.ok(fn);
  assert.match(fn, /buildPackageHtml\(\{ \.\.\.data\.content, docUrl: data\.docUrl \|\| '' \}\)/);
  // The old behaviour — redirect straight to Drive whenever a doc exists — is gone.
  assert.doesNotMatch(fn, /if \(data\.docUrl && pkgWin\) \{\s*pkgWin\.location\.href/);
});
