// Guards the dashboard's inline <script> block against the HTML script-data
// escape trap.
//
// WHY THIS TEST EXISTS: node --check, eslint, and every grep in CI read the file
// as JavaScript. A browser does not — it first runs the HTML tokenizer, and the
// tokenizer has three script-content states, not one. A literal `<!--` anywhere
// inside a script block switches it to "script data escaped"; a literal `<script`
// after that switches it to "script data double escaped"; and in that state a
// real `</script>` no longer ends the block, it only steps back one level. The
// dashboard's package-export template legitimately contains a literal `<script>`
// tag, so any stray `<!--` before it silently swallows the rest of the file —
// the parser hits EOF inside the script element, flags it "already started", and
// the ENTIRE dashboard JS never executes. Nothing else in the toolchain notices.
//
// So this test tokenizes the real file the way a browser does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML_PATH = new URL('../dashboard/index.html', import.meta.url);

const isAlpha = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDelim = c => c === '\t' || c === '\n' || c === '\f' || c === ' ' || c === '/' || c === '>';

// Minimal WHATWG script-data tokenizer. Starts just after a `<script ...>` open
// tag and returns the index at which the block's end tag is consumed, or -1 if
// the block runs to EOF (i.e. the script would never execute).
function scriptBlockEnd(html, start) {
  let state = 'data', buf = '';
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    switch (state) {
      // ── script data ────────────────────────────────────────────────────────
      case 'data':
        if (c === '<') state = 'lt';
        break;
      case 'lt':
        if (c === '/') { buf = ''; state = 'endTag'; }
        else if (c === '!') state = 'escStart';
        else { state = 'data'; i--; }
        break;
      case 'endTag':
        if (isAlpha(c)) buf += c.toLowerCase();
        else if (isDelim(c) && buf === 'script') return i;
        else { state = 'data'; i--; }
        break;
      case 'escStart':   state = c === '-' ? 'escStartDash' : (i--, 'data'); break;
      case 'escStartDash': state = c === '-' ? 'escDashDash' : (i--, 'data'); break;

      // ── script data escaped ────────────────────────────────────────────────
      case 'esc':
        if (c === '-') state = 'escDash';
        else if (c === '<') state = 'escLt';
        break;
      case 'escDash':
        if (c === '-') state = 'escDashDash';
        else if (c === '<') state = 'escLt';
        else state = 'esc';
        break;
      case 'escDashDash':
        if (c === '-') state = 'escDashDash';
        else if (c === '<') state = 'escLt';
        else if (c === '>') state = 'data';
        else state = 'esc';
        break;
      case 'escLt':
        if (c === '/') { buf = ''; state = 'escEndTag'; }
        else if (isAlpha(c)) { buf = c.toLowerCase(); state = 'dblEscStart'; }
        else { state = 'esc'; i--; }
        break;
      case 'escEndTag':
        // An end tag IS honoured in the escaped state — it is only the
        // double-escaped state that neutralizes </script>.
        if (isAlpha(c)) buf += c.toLowerCase();
        else if (isDelim(c) && buf === 'script') return i;
        else { state = 'esc'; i--; }
        break;
      case 'dblEscStart':
        if (isAlpha(c)) buf += c.toLowerCase();
        else if (isDelim(c)) { state = buf === 'script' ? 'dbl' : 'esc'; i--; }
        else { state = 'esc'; i--; }
        break;

      // ── script data double escaped ─────────────────────────────────────────
      case 'dbl':
        if (c === '-') state = 'dblDash';
        else if (c === '<') state = 'dblLt';
        break;
      case 'dblDash':
        if (c === '-') state = 'dblDashDash';
        else if (c === '<') state = 'dblLt';
        else state = 'dbl';
        break;
      case 'dblDashDash':
        if (c === '-') state = 'dblDashDash';
        else if (c === '<') state = 'dblLt';
        else if (c === '>') state = 'data';
        else state = 'dbl';
        break;
      case 'dblLt':
        if (c === '/') { buf = ''; state = 'dblEscEnd'; }
        else { state = 'dbl'; i--; }
        break;
      case 'dblEscEnd':
        if (isAlpha(c)) buf += c.toLowerCase();
        else if (isDelim(c)) { state = buf === 'script' ? 'esc' : 'dbl'; i--; }
        else { state = 'dbl'; i--; }
        break;
    }
  }
  return -1;
}

test('the dashboard\'s main inline script block closes before EOF (HTML-tokenized)', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const open = html.match(/<script(?:\s[^>]*)?>/i);
  assert.ok(open, 'dashboard/index.html should contain an inline <script> block');
  const end = scriptBlockEnd(html, open.index + open[0].length);
  assert.notEqual(
    end, -1,
    'The dashboard script block runs to EOF under the HTML script-data tokenizer. ' +
    'A literal `<!--` inside the script flipped it into the escaped/double-escaped ' +
    'states, so the closing </script> no longer terminates it and NO dashboard JS ' +
    'executes in a real browser. Remove the literal `<!--` (e.g. write it as ' +
    "'<!' + '--' or /<!\\x2D\\x2D/).",
  );
});

test('no literal `<!--` survives inside the dashboard script block', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const open = html.match(/<script(?:\s[^>]*)?>/i);
  const bodyStart = open.index + open[0].length;
  const end = scriptBlockEnd(html, bodyStart);
  const body = html.slice(bodyStart, end === -1 ? html.length : end);
  const idx = body.indexOf('<!--');
  assert.equal(
    idx, -1,
    idx === -1 ? '' : `literal \`<!--\` at offset ${idx}: ...${body.slice(Math.max(0, idx - 60), idx + 60)}...`,
  );
});

// Sanity checks on the tokenizer itself, so a future refactor cannot make the
// guard above pass by accident.
test('the tokenizer reproduces the double-escape trap and the clean case', () => {
  const trap = '<script>var s = "<!--"; var t = "<script>"; <\\/script>\n</script>\n';
  assert.equal(scriptBlockEnd(trap, trap.indexOf('>') + 1), -1);

  const clean = '<script>var s = "x"; var t = "<script>"; <\\/script>\n</script>\n';
  assert.notEqual(scriptBlockEnd(clean, clean.indexOf('>') + 1), -1);
});
