// Pins the memory → search-profile bridge. Editing the Memory page used to change
// nothing about what JobBud searches for: target_roles live in config/profile.yml
// (scanner/config.mjs resolveTargetRoles reads them for both scoring and the
// JSearch/Adzuna queries) and nothing carried a memory edit across.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeSearchFields, describeProfileChange } from '../api/coach.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const html = readFileSync(join(ROOT, 'dashboard', 'index.html'), 'utf8');
const coachSrc = readFileSync(join(ROOT, 'api', 'coach.js'), 'utf8');

const PROFILE_YML = `# JobBud Profile
name: Alex Doe
target_roles:
  - head of operations
  - chief of staff
target_locations:
  - city: Austin
    region: TX
    country: US
    radius_miles: 30
include_remote: true
min_salary: 180000
`;

// ── Reading the search-relevant fields ────────────────────────────────────────

test('summarizeSearchFields pulls the fields that drive the search', () => {
  const s = summarizeSearchFields(PROFILE_YML);
  assert.deepEqual(s.targetRoles, ['head of operations', 'chief of staff']);
  assert.deepEqual(s.locations, ['Austin, TX']);
  assert.equal(s.includeRemote, true);
  assert.equal(s.minSalary, 180000);
});

test('summarizeSearchFields degrades to empty on malformed or missing YAML', () => {
  for (const input of ['', null, 'target_roles: [oops', '{{not yaml']) {
    const s = summarizeSearchFields(input);
    assert.deepEqual(s.targetRoles, []);
    assert.equal(s.minSalary, null);
  }
});

// ── Reporting the change in plain English ─────────────────────────────────────

test('describeProfileChange leads with the search titles, always', () => {
  const before = summarizeSearchFields(PROFILE_YML);
  const after = summarizeSearchFields(PROFILE_YML.replace('chief of staff', 'vp operations'));
  const { lines, changed } = describeProfileChange(before, after);
  assert.equal(changed, true);
  assert.match(lines[0], /^Search titles are now: head of operations, vp operations$/);
  assert.match(lines[1], /they were: head of operations, chief of staff/);
});

test('describeProfileChange reports locations, remote, and salary moves', () => {
  const before = summarizeSearchFields(PROFILE_YML);
  const after = summarizeSearchFields(
    PROFILE_YML.replace('city: Austin', 'city: Denver').replace('region: TX', 'region: CO')
      .replace('include_remote: true', 'include_remote: false')
      .replace('min_salary: 180000', 'min_salary: 200000'));
  const { lines } = describeProfileChange(before, after);
  const text = lines.join('\n');
  assert.match(text, /Locations searched: Denver, CO/);
  assert.match(text, /Remote roles are no longer included\./);
  assert.match(text, /Minimum salary: 200,000/);
});

test('describeProfileChange says so plainly when nothing about the search moved', () => {
  const s = summarizeSearchFields(PROFILE_YML);
  const { lines, changed } = describeProfileChange(s, s);
  assert.equal(changed, false);
  assert.match(lines.join('\n'), /Nothing about your search changed/);
});

test('describeProfileChange handles an empty starting profile', () => {
  const { lines, changed } = describeProfileChange(
    summarizeSearchFields(''), summarizeSearchFields(PROFILE_YML));
  assert.equal(changed, true);
  assert.match(lines.join('\n'), /there were none before/);
});

// ── The endpoint ──────────────────────────────────────────────────────────────

test('apply-memory-to-profile is routed on the existing coach handler', () => {
  assert.match(coachSrc, /action === 'apply-memory-to-profile'\)\s*return handleApplyMemoryToProfile/);
  // No new api/ function was added for this.
  assert.match(coachSrc, /async function handleApplyMemoryToProfile\(req, res, githubToken, owner, repo\)/);
});

test('it reuses the onboarding profile generation, in update mode', () => {
  const fn = coachSrc.slice(coachSrc.indexOf('async function handleApplyMemoryToProfile'));
  assert.match(fn, /system: PROFILE_SYSTEM\(updatePrefix\)/);
  // Update mode is what preserves values the memory does not mention.
  assert.match(fn, /You are UPDATING an existing file, not generating from scratch/);
  assert.match(fn, /PRESERVE all existing content exactly as-is/);
  assert.match(fn, /Do NOT treat absence of information as a signal to clear/);
  // Both callers share one prompt, so they cannot drift apart.
  assert.equal((coachSrc.match(/system: PROFILE_SYSTEM\(/g) || []).length, 2);
});

test('it reads the profile memory file and the existing profile.yml', () => {
  const fn = coachSrc.slice(coachSrc.indexOf('async function handleApplyMemoryToProfile'));
  assert.match(fn, /readGithubText\(githubToken, owner, repo, 'config\/profile\.yml'\)/);
  assert.match(fn, /readGithubText\(githubToken, owner, repo, MEMORY_PATHS\.profile\)/);
});

test('it refuses to write a public repo or an unusable generation', () => {
  const fn = coachSrc.slice(coachSrc.indexOf('async function handleApplyMemoryToProfile'));
  // profile.yml carries the user's real name, location, and salary floor.
  assert.match(fn, /await assertRepoPrivate\(githubToken, owner, repo\)/);
  assert.match(fn, /RepoPublicError/);
  // A failed generation must leave the existing profile alone, not blank it.
  assert.match(fn, /!\/target_roles\/\.test\(profileYml\)/);
  assert.match(fn, /leaving profile\.yml untouched/);
  const guardIdx = fn.indexOf('leaving profile.yml untouched');
  assert.ok(guardIdx !== -1 && guardIdx < fn.indexOf('writeGithubFile'),
    'the usable-YAML guard must run before the write');
});

test('it refuses when there is no profile memory to apply', () => {
  const fn = coachSrc.slice(coachSrc.indexOf('async function handleApplyMemoryToProfile'));
  assert.match(fn, /if \(!memProfile\.trim\(\)\)/);
  assert.match(fn, /There's nothing in your profile memory yet/);
});

// ── The Memory page ───────────────────────────────────────────────────────────

test('the Memory page states plainly where search titles actually live', () => {
  assert.match(html, /What JobBud searches for lives somewhere else/);
  assert.match(html, /config\/profile\.yml/);
  assert.match(html, /it does not change what it goes looking for/);
});

test('the Memory page offers one-click apply and shows what changed', () => {
  assert.match(html, /id="apply-profile-btn"/);
  assert.match(html, /onclick="applyMemoryToProfile\(\)"/);
  assert.match(html, /\/api\/coach\?action=apply-memory-to-profile/);
  assert.match(html, /id="apply-profile-result"/);
  // Server-generated summary text is inserted as text, never as markup.
  const fn = html.slice(html.indexOf('async function applyMemoryToProfile'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.doesNotMatch(body, /innerHTML/);
  assert.match(body, /result\.textContent = \(data\.summary \|\| \[\]\)\.join\('\\n'\)/);
});

test('saving profile memory points the user at the apply step', () => {
  const fn = html.slice(html.indexOf('async function saveMemoryFile'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.match(body, /if \(file === 'profile'\)/);
  assert.match(body, /Apply to search profile/);
});
