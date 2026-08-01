// Pins the personalized role-type picker: the Generate Package modal must offer
// the tags from the user's OWN bullet bank, never the original author's five
// hardcoded categories, and nothing downstream may assume those old values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const html = readFileSync(join(ROOT, 'dashboard', 'index.html'), 'utf8');
const jobsSrc = readFileSync(join(ROOT, 'api', 'jobs.js'), 'utf8');
const pkgSrc = readFileSync(join(ROOT, 'scanner', 'applicationPackage.mjs'), 'utf8');
const queueSrc = readFileSync(join(ROOT, 'api', 'queue-linkedin-research.js'), 'utf8');
const actionSrc = readFileSync(join(ROOT, 'api', 'action.js'), 'utf8');

const OLD_HARDCODED = ['corpdev', 'stratfin', 'ceo-office'];

test('the modal no longer hardcodes the original author role-type checkboxes', () => {
  for (const value of OLD_HARDCODED) {
    assert.doesNotMatch(html, new RegExp(`<input type="checkbox" value="${value}"`),
      `hardcoded role-type checkbox "${value}" is still in the modal`);
  }
  assert.match(html, /id="role-type-options"/);
  assert.match(html, /id="role-type-source"/);
});

test('the dashboard fetches role tags and renders them without innerHTML', () => {
  assert.match(html, /\/api\/jobs\?resource=role-tags/);
  assert.match(html, /function renderRoleTypeOptions/);
  // Labels come from an AI-generated file — they must never be interpolated
  // into markup.
  const fn = html.slice(html.indexOf('function renderRoleTypeOptions'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.doesNotMatch(body, /innerHTML/);
  assert.match(body, /span\.textContent = tag\.label/);
});

test('the modal explains where role types come from when there is no bank yet', () => {
  assert.match(html, /become your own tags from your bullet bank once onboarding creates it/);
  assert.match(html, /These are the role types from your bullet bank\./);
});

test('the Generate button listener is delegated, not bound to fixed checkboxes', () => {
  // Options are rendered at runtime, so a DOMContentLoaded per-checkbox bind
  // would attach to nothing and leave the button permanently disabled.
  assert.match(html, /getElementById\('role-modal'\)\.addEventListener\('change'/);
});

test('api/jobs.js serves role tags from the bullet bank with a fallback', () => {
  assert.match(jobsSrc, /resource === 'role-tags'/);
  assert.match(jobsSrc, /readGithubText\(githubToken, owner, repo, 'bullet-bank\.md'\)/);
  assert.match(jobsSrc, /parseBulletBankTags\(bank\)/);
  assert.match(jobsSrc, /tags\.length \? tags : FALLBACK_ROLE_TAGS/);
  assert.match(jobsSrc, /tags\.length \? 'bullet-bank' : 'fallback'/);
  // Must sit behind the same password auth as the job data.
  const authIdx = jobsSrc.indexOf("res.status(401)");
  assert.ok(authIdx !== -1 && authIdx < jobsSrc.indexOf("resource === 'role-tags'"),
    'role-tags must be served after the auth gate');
});

test('action.js still passes roleTypes through verbatim', () => {
  assert.match(actionSrc, /roleTypes = Array\.isArray\(req\.body\.roleTypes\) \? req\.body\.roleTypes : \[\]/);
  // No mapping, filtering, or validation against a fixed list on the way through.
  for (const value of OLD_HARDCODED) {
    assert.ok(!actionSrc.includes(`'${value}'`), `action.js references old role type ${value}`);
  }
});

test('the package generator makes no assumption about the five old role types', () => {
  for (const value of [...OLD_HARDCODED, 'investing']) {
    assert.ok(!pkgSrc.includes(`${value} is selected`), `applicationPackage still branches on ${value}`);
  }
  assert.doesNotMatch(pkgSrc, /investing version for investing roles/);
  assert.match(pkgSrc, /a selected role type may not appear in the bank at all/);
});

test('the LinkedIn research map is flagged as a known hardcoded leftover', () => {
  assert.match(queueSrc, /KNOWN HARDCODED LEFTOVER/);
  // The map itself is deliberately untouched — separate feature, separate fix.
  assert.match(queueSrc, /const RESEARCH_FUNCTION_MAP = \{/);
});
