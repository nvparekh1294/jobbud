// Guards for honest quota accounting.
//
// index.mjs used to record the pre-computed ESTIMATE for any source whose
// promise fulfilled, and the sources swallow every per-query error and return
// []. So a scan where all 22 JSearch calls 404'd logged "recorded 22 calls",
// returned zero jobs, and the workflow went green — the third mechanism behind
// a real user's silently empty scans.
//
// index.mjs runs its scan on import, so its wiring is asserted against the
// source text the same way the dashboard tests do. The counters and the quota
// write are exercised for real, with fetch stubbed and a temp working directory
// — no live API calls, and no writes to the repo's data/.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAdzuna, adzunaStats, adzunaQueryCount } from '../scanner/sources/adzuna.mjs';
import { recordUsage } from '../scanner/quota.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, '..', 'scanner', 'index.mjs'), 'utf8');

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realError = console.error;
const realCwd = process.cwd();
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
  process.chdir(realCwd);
});

function silence() {
  console.warn = () => {};
  console.error = () => {};
}

const CONFIG = {
  adzunaAppId: 'app-id',
  adzunaApiKey: 'app-key',
  requiredTitleKeywords: ['product manager'],
  locations: [{ city: 'Austin', country: 'US', radiusMiles: 25 }],
};

// ── Sources count what they actually sent ────────────────────────────────────

test('a source counts a failed request as an attempt', async () => {
  silence();
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'upstream is down',
    json: async () => ({}),
  });

  const jobs = await fetchAdzuna(CONFIG);

  assert.deepEqual(jobs, [], 'the source still swallows the error and returns []');
  // The request went out and counts against the quota even though it failed.
  assert.equal(adzunaStats.attempts, 1);
  assert.equal(adzunaStats.queries, 1);
  assert.equal(adzunaStats.failures, 1);
  assert.match(adzunaStats.lastError, /500/);
});

test('a source that builds no queries reports zero attempts', async () => {
  silence();
  let called = false;
  globalThis.fetch = async () => { called = true; };

  await fetchAdzuna({ ...CONFIG, locations: [{ city: 'Berlin', country: 'DE' }] });

  assert.equal(called, false);
  assert.equal(adzunaStats.attempts, 0);
  assert.equal(adzunaStats.queries, 0);
});

// ── index.mjs records attempts, not the estimate ─────────────────────────────

test('index records the actual attempt count, not the estimate', () => {
  assert.match(indexSrc, /await recordUsage\(name, stats\.attempts\)/);
  assert.doesNotMatch(indexSrc, /recordUsage\(sources\[i\]\.name, sources\[i\]\.estimate\)/);
  // Estimates survive only for the pre-flight projection. (The limit used to be
  // the literal 200; it is now the JSEARCH_MONTHLY_LIMIT env override.)
  assert.match(indexSrc, /checkQuota\('jsearch', jsearchEstimate, JSEARCH_MONTHLY_LIMIT\)/);
});

test('index records usage for a source whose fetch rejected too', () => {
  // The attempts were made before the throw; skipping the write would under-
  // report real quota spend.
  const block = indexSrc.slice(indexSrc.indexOf('for (let i = 0; i < sources.length; i++)'));
  const body = block.slice(0, block.indexOf('\n    }\n'));
  assert.ok(body.indexOf('recordUsage') < body.indexOf("=== 'rejected'"),
    'recordUsage must run before the rejected branch, for every source');
});

// The projection that took Adzuna offline: the whole 35-search list was checked
// against the month, and a list that can never fit in one run blocked the source
// on every run. index must project one RUN's worth and hand the source that cap.
test('index projects the capped per-run estimate for adzuna', () => {
  // The list size is the source's real count, not a guess. `locations × 7`
  // hardcoded one profile's role count into everyone's budget.
  assert.match(indexSrc, /const adzunaWanted = adzunaQueryCount\(config\)/);
  assert.match(indexSrc, /const adzunaEstimate = Math\.min\(adzunaWanted, adzunaPerRun\)/);
  assert.doesNotMatch(indexSrc, /config\.locations\.length \* 7/);
  assert.match(indexSrc, /config\.adzunaMaxCallsPerRun = adzunaBudget\.allowed/);
  assert.match(indexSrc, /adzunaOk = adzunaBudget\.allowed > 0/);
});

test('adzunaQueryCount counts what the source will actually ask for', () => {
  assert.equal(adzunaQueryCount(CONFIG), 1, 'one role in one supported city');

  const threeRolesTwoCities = {
    ...CONFIG,
    requiredTitleKeywords: ['pm', 'chief of staff', 'bizops'],
    locations: [{ city: 'Austin', country: 'US' }, { city: 'London', country: 'UK' }],
  };
  assert.equal(adzunaQueryCount(threeRolesTwoCities), 6, 'aliases like US/UK count as searchable');

  assert.equal(adzunaQueryCount({ ...CONFIG, locations: [{ city: 'Berlin', country: 'DE' }] }), 0,
    'a country Adzuna is not wired up for adds no searches');
  assert.equal(adzunaQueryCount({ ...CONFIG, requiredTitleKeywords: [] }), 0);
});

// Counting the list must not narrate it — buildQueries already warns about every
// skipped location, and a second copy of those lines per run is just noise.
test('counting the adzuna list is silent', () => {
  const said = [];
  console.warn = (...a) => said.push(a.join(' '));
  adzunaQueryCount({ ...CONFIG, locations: [{ city: 'Berlin', country: 'DE' }] });
  assert.deepEqual(said, []);
});

// A profile with nothing for Adzuna to search is a configuration problem, not a
// quota one, and must not be reported to the user as "your allowance is spent".
test('index does not spend a quota check, or blame quota, when adzuna has nothing to search', () => {
  assert.match(indexSrc, /if \(adzunaWanted > 0\) \{/);
  const guarded = indexSrc.slice(indexSrc.indexOf('if (adzunaWanted > 0) {'));
  const body = guarded.slice(0, guarded.indexOf('\n    } else {'));
  assert.ok(body.includes("checkQuota('adzuna'"), 'the adzuna quota check sits inside the guard');
  assert.ok(body.includes("quotaNotice('Adzuna'"), 'and so does the notice it produces');
});

test('index shouts when every query of a source failed', () => {
  assert.match(indexSrc, /stats\.queries > 0 && stats\.failures === stats\.queries/);
  const line = indexSrc.slice(indexSrc.indexOf('stats.failures === stats.queries'));
  const shout = line.slice(0, line.indexOf('\n      }'));
  assert.match(shout, /console\.error/);
  assert.match(shout, /\$\{name\}/);          // names the source
  assert.match(shout, /\$\{stats\.queries\}/); // names the count
  assert.match(shout, /\$\{stats\.lastError\}/); // names the last error
});

// ── The recorded number is what lands on disk ────────────────────────────────

test('recording zero attempts writes zero, not an estimate', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbud-quota-'));
  process.chdir(tmp);

  await recordUsage('jsearch', 0);
  await recordUsage('jsearch', 3);

  const usage = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'api-usage.json'), 'utf8'));
  assert.equal(usage.jsearch.callsThisMonth, 3);
});
