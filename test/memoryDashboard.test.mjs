import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleMemoryBlock, REMEMBER_COMMAND_RE } from '../lib/memory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH = join(__dirname, '..', 'dashboard', 'index.html');
const html = readFileSync(DASH, 'utf8');

// Extract a top-level `function name(...) { ... }` body from source via brace-walk.
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

// Extract inline <script> blocks (skip external src / non-JS types).
function inlineScripts(source) {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(source))) {
    const attrs = m[1] || '';
    if (/\bsrc=/.test(attrs)) continue;
    if (/type=/.test(attrs) && !/text\/javascript|module/.test(attrs)) continue;
    out.push(m[2]);
  }
  return out;
}

// ── Syntax check on the extracted dashboard script (DOM/UI parts) ─────────────
test('dashboard inline script parses without syntax errors (node --check)', () => {
  const scripts = inlineScripts(html);
  assert.ok(scripts.length >= 1, 'expected at least one inline script block');
  const dir = mkdtempSync(join(tmpdir(), 'jobbud-dash-'));
  scripts.forEach((code, i) => {
    const f = join(dir, `script_${i}.js`);
    writeFileSync(f, code);
    // Throws (failing the test) if node cannot parse the extracted script.
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  });
});

// ── Memory feature is wired into the dashboard ────────────────────────────────
test('dashboard exposes the Memory tab and view', () => {
  assert.match(html, /data-view="memory"/);
  assert.match(html, /id="view-memory"/);
  assert.match(html, /What JobBud knows about you/);
  assert.match(html, /id="memory-text-profile"/);
  assert.match(html, /id="memory-text-voice"/);
  assert.match(html, /id="memory-text-stories"/);
});

test('dashboard wires the memory read path into coach chat', () => {
  // memory loaded once at coach activation and passed on chat calls
  assert.match(html, /loadMemory\(\)/);
  assert.match(html, /assembleMemoryBlockClient/);
  assert.match(html, /memory: conversationMemory/);
  assert.match(html, /\/api\/memory\?action=get-memory/);
});

test('dashboard wires the memory write path (remember + save + onboarding seed)', () => {
  assert.match(html, /\/api\/memory\?action=update-memory/);
  assert.match(html, /\/api\/memory\?action=save-memory/);
  assert.match(html, /function fireMemoryUpdate/);
  assert.match(html, /rememberLastMessage/);
  assert.match(html, /fireMemoryUpdate\('onboarding'/);
  assert.match(html, /Remember this/);
});

test('dashboard reads a per-conversation memory snapshot (cache stability)', () => {
  // conversation snapshots at start; send functions read the snapshot, not live value
  assert.match(html, /conversationMemory = memoryContext/);
  assert.match(html, /memory: conversationMemory/);
});

// ── Parity: the inlined client mirror must match lib/memory.mjs exactly ────────
// Static HTML can't import the .mjs module, so assembleMemoryBlockClient and the
// remember-regex are hand-mirrored. These tests fail CI if the two ever drift.
test('inlined assembleMemoryBlockClient produces byte-identical output to lib assembleMemoryBlock', () => {
  const src = extractFunction(html, 'assembleMemoryBlockClient');
  assert.ok(src, 'assembleMemoryBlockClient must be present in the dashboard');
  // eslint-disable-next-line no-new-func
  const clientFn = new Function(`${src}\nreturn assembleMemoryBlockClient;`)();

  const fixtures = [
    {},
    { profile: '', voice: '', stories: '' },
    { profile: '- ex-Goldman; Turing exec', voice: '', stories: '- Saved $2M' },
    { profile: '- a', voice: '- b — why: keeps it tight', stories: '- c\n- d' },
  ];
  for (const f of fixtures) {
    assert.equal(clientFn(f), assembleMemoryBlock(f), `mismatch for ${JSON.stringify(f)}`);
  }
});

test('inlined remember-regex is byte-identical to lib REMEMBER_COMMAND_RE', () => {
  const m = html.match(/text\.match\((\/\^\(\?:remember[\s\S]*?\/i)\)/);
  assert.ok(m, 'remember regex literal must be present in sendCoachMessage');
  assert.equal(m[1], REMEMBER_COMMAND_RE.toString());
});
