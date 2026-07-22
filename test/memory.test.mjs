import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_KEYS,
  MEMORY_PATHS,
  MEMORY_CAPS,
  MEMORY_TOTAL_CAP,
  estimateTokens,
  isMemoryEmpty,
  assembleMemoryBlock,
  capMemoryContent,
  capMemoryFiles,
  buildDistillationUserPrompt,
  parseMemoryUpdateResponse,
  parseRememberCommand,
  resolveMemoryWrites,
  MEMORY_DISTILL_SYSTEM,
} from '../lib/memory.mjs';

// ── constants ────────────────────────────────────────────────────────────────
test('MEMORY_CAPS sum equals the hard total cap (~10k tokens)', () => {
  const sum = MEMORY_KEYS.reduce((a, k) => a + MEMORY_CAPS[k], 0);
  assert.equal(sum, MEMORY_TOTAL_CAP);
});

test('MEMORY_PATHS point at data/memory/*.md', () => {
  assert.equal(MEMORY_PATHS.profile, 'data/memory/profile.md');
  assert.equal(MEMORY_PATHS.voice, 'data/memory/voice.md');
  assert.equal(MEMORY_PATHS.stories, 'data/memory/stories.md');
});

// ── estimateTokens ─────────────────────────────────────────────────────────────
test('estimateTokens is 0 for empty/non-string', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens is ceil(chars/4)', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

// ── isMemoryEmpty ──────────────────────────────────────────────────────────────
test('isMemoryEmpty true for absent/empty/whitespace files', () => {
  assert.equal(isMemoryEmpty(), true);
  assert.equal(isMemoryEmpty({}), true);
  assert.equal(isMemoryEmpty({ profile: '', voice: '   ', stories: '\n\t' }), true);
});

test('isMemoryEmpty false when any file has content', () => {
  assert.equal(isMemoryEmpty({ profile: '- fact' }), false);
  assert.equal(isMemoryEmpty({ voice: '- rule' }), false);
});

// ── assembleMemoryBlock ────────────────────────────────────────────────────────
test('assembleMemoryBlock returns empty string for the new-user case (graceful absence)', () => {
  assert.equal(assembleMemoryBlock(), '');
  assert.equal(assembleMemoryBlock({ profile: '', voice: '', stories: '' }), '');
});

test('assembleMemoryBlock wraps content and includes only non-empty sections', () => {
  const out = assembleMemoryBlock({ profile: '- ex-Goldman', voice: '', stories: '- Saved $2M' });
  assert.match(out, /^<user_memory>/);
  assert.match(out, /<\/user_memory>$/);
  assert.match(out, /## Profile/);
  assert.ok(out.includes('- ex-Goldman'));
  assert.match(out, /## Stories/);
  assert.ok(out.includes('- Saved $2M'));
  // voice was empty, so its section is omitted
  assert.ok(!out.includes('## Voice'));
});

test('assembleMemoryBlock is deterministic / byte-stable (cache safety)', () => {
  const files = { profile: '- a', voice: '- b — why: x', stories: '- c' };
  assert.equal(assembleMemoryBlock(files), assembleMemoryBlock({ ...files }));
});

// ── capMemoryContent / capMemoryFiles ──────────────────────────────────────────
test('capMemoryContent leaves under-budget content untouched', () => {
  const c = '- one\n- two\n';
  assert.equal(capMemoryContent(c, 1000), c);
});

test('capMemoryContent trims to whole trailing lines when over budget', () => {
  // 10 lines of ~10 chars each = ~100 chars ≈ 25 tokens; cap at 5 tokens (~20 chars)
  const lines = Array.from({ length: 10 }, (_, i) => `- bullet ${i}`);
  const capped = capMemoryContent(lines.join('\n') + '\n', 5);
  assert.ok(estimateTokens(capped) <= 5);
  // never splits a line mid-word: every retained line is a complete original line
  for (const l of capped.split('\n').filter(Boolean)) {
    assert.ok(lines.includes(l), `line "${l}" should be an intact original line`);
  }
});

test('capMemoryContent handles empty / non-string', () => {
  assert.equal(capMemoryContent('', 100), '');
  assert.equal(capMemoryContent(null, 100), '');
});

test('capMemoryContent NEVER returns empty for non-empty input (no silent deletion)', () => {
  // A single entry far bigger than the whole budget must still yield non-empty,
  // valid markdown — capping to '' would silently delete the user's memory.
  const huge = '- ' + 'x'.repeat(40000);
  const capped = capMemoryContent(huge + '\n', 5);
  assert.ok(capped.trim().length > 0, 'must not cap a huge single entry to empty');
  assert.ok(capped.startsWith('- '), 'keeps the first entry, at an entry boundary');
  assert.ok(capped.endsWith('\n'));
});

test('capMemoryFiles enforces each per-file cap', () => {
  const big = '- ' + 'x'.repeat(50000) + '\n';
  const out = capMemoryFiles({ profile: big, voice: big, stories: big });
  assert.ok(estimateTokens(out.profile) <= MEMORY_CAPS.profile);
  assert.ok(estimateTokens(out.voice) <= MEMORY_CAPS.voice);
  assert.ok(estimateTokens(out.stories) <= MEMORY_CAPS.stories);
  const total = MEMORY_KEYS.reduce((a, k) => a + estimateTokens(out[k]), 0);
  assert.ok(total <= MEMORY_TOTAL_CAP);
});

// ── buildDistillationUserPrompt ────────────────────────────────────────────────
test('buildDistillationUserPrompt embeds event type, payload, and current files', () => {
  const p = buildDistillationUserPrompt('user-note', 'I prefer remote-only roles', {
    profile: '- ex-Goldman', voice: '', stories: '',
  });
  assert.match(p, /EVENT TYPE: user-note/);
  assert.ok(p.includes('I prefer remote-only roles'));
  assert.ok(p.includes('- ex-Goldman'));
  // empty files render as the (empty) sentinel
  assert.ok(p.includes('# voice.md\n(empty)'));
});

test('buildDistillationUserPrompt serializes object payloads as JSON', () => {
  const p = buildDistillationUserPrompt('edit', { before: 'co-led', after: 'led' }, {});
  assert.ok(p.includes('"before": "co-led"'));
  assert.ok(p.includes('"after": "led"'));
});

test('MEMORY_DISTILL_SYSTEM forbids invention and mandates merge/supersede + JSON', () => {
  assert.match(MEMORY_DISTILL_SYSTEM, /NEVER invent facts/);
  assert.match(MEMORY_DISTILL_SYSTEM, /MERGE and SUPERSEDE/);
  assert.match(MEMORY_DISTILL_SYSTEM, /Return ONLY a JSON object/);
  assert.match(MEMORY_DISTILL_SYSTEM, /NEVER store secrets/);
});

// ── parseMemoryUpdateResponse ──────────────────────────────────────────────────
test('parseMemoryUpdateResponse parses a clean JSON object', () => {
  const out = parseMemoryUpdateResponse('{"profile":"- a","voice":"- b","stories":"- c"}');
  assert.deepEqual(out, { profile: '- a', voice: '- b', stories: '- c' });
});

test('parseMemoryUpdateResponse strips ```json fences and surrounding prose', () => {
  const out = parseMemoryUpdateResponse('Here you go:\n```json\n{"profile":"- a","voice":"- b","stories":"- c"}\n```\nDone.');
  assert.equal(out.profile, '- a');
});

test('parseMemoryUpdateResponse maps missing/non-string keys to null (unchanged)', () => {
  const out = parseMemoryUpdateResponse('{"profile":"- a"}');
  assert.equal(out.profile, '- a');
  assert.equal(out.voice, null);
  assert.equal(out.stories, null);
});

test('parseMemoryUpdateResponse returns null on garbage or empty', () => {
  assert.equal(parseMemoryUpdateResponse('not json at all'), null);
  assert.equal(parseMemoryUpdateResponse(''), null);
  assert.equal(parseMemoryUpdateResponse(null), null);
  assert.equal(parseMemoryUpdateResponse('{ broken'), null);
});

// ── parseRememberCommand ───────────────────────────────────────────────────────
test('parseRememberCommand strips the trigger and returns the note (explicit command forms)', () => {
  assert.equal(parseRememberCommand('Remember this: no big tech'), 'no big tech');
  assert.equal(parseRememberCommand('add to memory: I hate buzzwords'), 'I hate buzzwords');
  assert.equal(parseRememberCommand('Remember that I led the migration'), 'I led the migration');
  assert.equal(parseRememberCommand('remember to note I want remote-only'), 'note I want remote-only');
});

test('parseRememberCommand requires an explicit command form (no bare "remember X")', () => {
  // A bare "remember" reminiscence is not a command — avoids false-positive writes.
  assert.equal(parseRememberCommand('remember I prefer Series B startups'), null);
  assert.equal(parseRememberCommand('remember'), null);
});

test('parseRememberCommand never fires on a question', () => {
  assert.equal(parseRememberCommand('Remember when I was at GS?'), null);
  assert.equal(parseRememberCommand('remember this thing?'), null);
});

test('parseRememberCommand returns null for non-commands', () => {
  assert.equal(parseRememberCommand('what should I say here'), null);
  assert.equal(parseRememberCommand('I remember when...'), null); // trigger must be at start
  assert.equal(parseRememberCommand(null), null);
});

test('parseRememberCommand keeps whole message when nothing follows the trigger', () => {
  assert.equal(parseRememberCommand('remember this'), 'remember this');
});

// ── resolveMemoryWrites (write-guards for the update path) ──────────────────────
test('resolveMemoryWrites writes changed files and marks unchanged (null) files', () => {
  const current = { profile: '- old', voice: '- v', stories: '- s' };
  const parsed  = { profile: '- new', voice: null, stories: null };
  const { writes, skipped } = resolveMemoryWrites(parsed, current);
  assert.equal(writes.profile, '- new'); // under budget → returned verbatim
  assert.equal(skipped.voice, 'unchanged');
  assert.equal(skipped.stories, 'unchanged');
});

test('resolveMemoryWrites empty-deletion guard: never blanks a non-empty file', () => {
  const current = { profile: '- real facts', voice: '- rule', stories: '- story' };
  const parsed  = { profile: '', voice: '   ', stories: '\n' }; // model tried to wipe all three
  const { writes, skipped } = resolveMemoryWrites(parsed, current);
  assert.deepEqual(writes, {}, 'no file may be blanked');
  assert.equal(skipped.profile, 'empty-guard');
  assert.equal(skipped.voice, 'empty-guard');
  assert.equal(skipped.stories, 'empty-guard');
});

test('resolveMemoryWrites allows an empty result only when the file is already empty', () => {
  const current = { profile: '', voice: '- keep', stories: '' };
  const parsed  = { profile: '', voice: '- keep', stories: null };
  const { writes, skipped } = resolveMemoryWrites(parsed, current);
  // profile: empty→empty is a no-op (not a deletion); voice unchanged content; stories null
  assert.deepEqual(writes, {});
  assert.equal(skipped.voice, 'nochange');
});
