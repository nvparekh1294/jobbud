// Guards the script inside the page buildPackageHtml GENERATES.
//
// test/dashboardScriptBlock.test.mjs guards dashboard/index.html itself. This
// file guards the other script — the one that only exists at runtime, written by
// a template literal, and therefore never seen by node --check or any linter.
//
// THE TRAP: buildPackageHtml returns a template literal that contains a full
// HTML page, including that page's own <script>. Any backslash escape inside
// that template is consumed when the TEMPLATE is evaluated, not when the
// generated page runs. `'<!DOCTYPE html>\n'` in the template therefore emits a
// real newline into the generated page, splitting the string literal across two
// lines: SyntaxError, no functions defined, and every Copy/Download button on
// the exported package silently does nothing. The escape has to be doubled.
//
// So this test builds a real package page and compiles its script for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');

// Pull the function's source straight out of the dashboard, so the test can
// never drift from the shipped implementation.
function extractBuildPackageHtml() {
  const start = html.indexOf('function buildPackageHtml');
  assert.notEqual(start, -1, 'buildPackageHtml not found in dashboard/index.html');
  const end = html.indexOf('// ── Role-type modal state', start);
  assert.notEqual(end, -1, 'the marker after buildPackageHtml moved — update this test');
  const src = html.slice(start, end);
  // The function is self-contained: it defines its own esc() and safeJson().
  return vm.runInNewContext(`(${src.trim().replace(/[\s;]+$/, '')})`, { console });
}

const SAMPLE = {
  title: 'Head of Ops <Acme & Co>',
  resume: 'JANE DOE\n• Ran a thing & shipped it <fast>\n• Cut spend by 18%',
  applicationQuestions: [{ question: 'Why us? <really>', answer: 'Because & so on' }],
  checklist: ['Verify the "title" matches', 'Attach a cover letter'],
  tailoringNotes: 'Emphasized ops; cut the finance section. 100% match on & keywords.',
  atsText: 'ATS & KEYWORD OPTIMIZATION\n\nMISSING KEYWORDS\nroadmap: add to Acme\n\nSUGGESTED ADDITIONS\nNone relevant to this role.',
  docUrl: '',
};

function generatedScriptBody(page) {
  // Anchor on the block's first statement, not on lastIndexOf('<script>') —
  // package content can legitimately contain the text "<script>" and would
  // otherwise be mistaken for the opening tag.
  const open = page.search(/<script>\s*var RESUME/);
  assert.notEqual(open, -1, 'the generated page has no <script> block');
  const body = page.slice(page.indexOf('>', open) + 1);
  // In the SOURCE the closing tag is written `<\/script>` so it cannot terminate
  // the dashboard's own block; `\/` is an identity escape, so what actually
  // reaches the generated page is a plain closing tag.
  const close = body.indexOf('</script>');
  assert.notEqual(close, -1, 'the generated page\'s script is never closed');
  return body.slice(0, close);
}

test('the generated package page ships a syntactically valid script', () => {
  const buildPackageHtml = extractBuildPackageHtml();
  const page = buildPackageHtml(SAMPLE);
  const body = generatedScriptBody(page);

  assert.doesNotThrow(
    () => new vm.Script(body, { filename: 'generated-package-page.js' }),
    'The script inside the generated package page does not compile. A backslash ' +
    'escape in buildPackageHtml\'s template literal was eaten at template ' +
    'evaluation time (most likely a single-backslash \\n that emitted a real ' +
    'newline). Double the backslash so the escape reaches the generated page.',
  );
});

test('the generated page still wires up its Copy and Download buttons', () => {
  const buildPackageHtml = extractBuildPackageHtml();
  const page = buildPackageHtml(SAMPLE);
  for (const handler of ['copyResume()', 'copyAll()', 'downloadPackage()']) {
    assert.ok(page.includes(`onclick="${handler}"`), `missing onclick="${handler}"`);
  }
  // A button whose handler never got defined is the exact silent failure this
  // file exists to catch, so check the definitions land too.
  const body = generatedScriptBody(page);
  for (const fn of ['function toast(', 'function copyText(', 'function copyResume(', 'function copyAll(', 'function downloadPackage(']) {
    assert.ok(body.includes(fn), `missing definition: ${fn}`);
  }
});

test('the generated script survives content with quotes, newlines, and markup', () => {
  const buildPackageHtml = extractBuildPackageHtml();
  const hostile = {
    ...SAMPLE,
    resume: 'Line one\nLine "two" with \'quotes\'\n</script><script>alert(1)</script>\nBackslash: C:\\Users\\x',
    atsText: 'Ends with a backslash \\\nAnd an HTML comment opener: <!-- oops -->',
  };
  const body = generatedScriptBody(buildPackageHtml(hostile));
  assert.doesNotThrow(() => new vm.Script(body, { filename: 'generated-package-page.js' }));
  // safeJson must have neutralized the injected closing tag rather than letting
  // it terminate the generated page's own script block.
  assert.ok(!body.includes('</script>'), 'a raw closing script tag reached the generated page');
});

test('no unescaped backslash escape hides elsewhere in the emitted script region', () => {
  // A source-level sweep, so a NEW single-backslash escape added to the template
  // is caught by name even if it happens not to break compilation.
  const fnStart = html.indexOf('function buildPackageHtml');
  const fnEnd = html.indexOf('// ── Role-type modal state', fnStart);
  const src = html.slice(fnStart, fnEnd);
  const open = src.lastIndexOf('<script>');
  const region = src.slice(open, src.indexOf('<\\/script>', open));

  // Every backslash in this region must be a doubled one (an escape meant for
  // the generated page) — the sole exception being the identity-escaped closing
  // tag, which is excluded from the slice above.
  const offenders = [];
  for (let i = 0; i < region.length; i++) {
    if (region[i] !== '\\') continue;
    if (region[i + 1] === '\\') { i++; continue; }   // a doubled backslash: fine
    offenders.push(region.slice(Math.max(0, i - 50), i + 20));
  }
  assert.deepEqual(
    offenders, [],
    'single backslash escape(s) in the emitted script region — these are consumed ' +
    'at template evaluation and never reach the generated page:\n' + offenders.join('\n---\n'),
  );
});
