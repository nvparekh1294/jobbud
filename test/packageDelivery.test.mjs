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

// ── The panel is no longer bypassed when Drive is configured ──────────────────

test('submitRoleModal renders the panel even when a Google Doc was created', () => {
  const fn = extractFunction(html, 'submitRoleModal');
  assert.ok(fn);
  assert.match(fn, /buildPackageHtml\(\{ \.\.\.data\.content, docUrl: data\.docUrl \|\| '' \}\)/);
  // The old behaviour — redirect straight to Drive whenever a doc exists — is gone.
  assert.doesNotMatch(fn, /if \(data\.docUrl && pkgWin\) \{\s*pkgWin\.location\.href/);
});
