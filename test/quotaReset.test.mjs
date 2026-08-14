// The monthly counter has to actually be monthly.
//
// quota.mjs created every entry with `monthResetDate: null` and nothing ever
// filled it in, while the reset check returned immediately on a null date. So
// `callsThisMonth` was a LIFETIME total: it only grew, and the first time it
// crossed the limit the source was skipped on that run and on every run after
// it. A real user's Adzuna went dark permanently that way.
//
// These tests run against a temp working directory — quota.mjs writes
// ./data/api-usage.json relative to cwd, and nothing here may touch the repo's.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkQuota, recordUsage, callsPerRun, takeQueryWindow } from '../scanner/quota.mjs';
import { fetchAdzuna, adzunaStats } from '../scanner/sources/adzuna.mjs';

const realCwd = process.cwd();
const realLog = console.log;
const realWarn = console.warn;
let logged = [];

beforeEach(() => {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'jobbud-quota-reset-')));
  logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => logged.push(args.join(' '));
});

afterEach(() => {
  process.chdir(realCwd);
  console.log = realLog;
  console.warn = realWarn;
});

const usageFile = () => path.join(process.cwd(), 'data', 'api-usage.json');
const readUsage = () => JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
const writeUsage = (doc) => {
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  fs.writeFileSync(usageFile(), JSON.stringify(doc, null, 2));
};

// A YYYY-MM-DD string `months` months from today, the shape quota.mjs stores.
function monthsFromToday(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// ── Fresh entries start a month ──────────────────────────────────────────────

test('a source with no api-usage.json at all gets a reset date on first use', async () => {
  await recordUsage('adzuna', 3);

  const entry = readUsage().adzuna;
  assert.equal(entry.callsThisMonth, 3);
  assert.equal(entry.monthResetDate, monthsFromToday(1), 'the month starts on first use, not never');
});

test('checkQuota alone initializes a brand-new source', async () => {
  const budget = await checkQuota('jsearch', 10, 200);

  assert.equal(budget.allowed, 10);
  assert.equal(readUsage().jsearch.monthResetDate, monthsFromToday(1));
});

test('a source absent from an existing api-usage.json is initialized too', async () => {
  writeUsage({ jsearch: { callsThisMonth: 12, monthResetDate: monthsFromToday(1), lastScan: null } });

  await recordUsage('adzuna', 1);

  const usage = readUsage();
  assert.equal(usage.adzuna.monthResetDate, monthsFromToday(1));
  assert.equal(usage.jsearch.callsThisMonth, 12, 'the other source is left alone');
});

// ── Migration: a null date means the count was never monthly ─────────────────

test('a null-date entry is migrated: date set, lifetime counter zeroed, reason logged', async () => {
  // Exactly the stuck user's file: 235 lifetime calls against a 250 limit.
  writeUsage({ adzuna: { callsThisMonth: 235, monthResetDate: null, lastScan: '2026-08-06T09:00:00.000Z' } });

  const budget = await checkQuota('adzuna', 28, 250);

  assert.equal(budget.allowed, 28, 'all 28 calls fit in a freshly-zeroed month');
  const entry = readUsage().adzuna;
  assert.equal(entry.callsThisMonth, 0, 'the lifetime total is dropped, not carried into the new month');
  assert.equal(entry.monthResetDate, monthsFromToday(1));
  const why = logged.find(l => l.includes('lifetime'));
  assert.ok(why, `the log must say why the counter went to zero; got:\n${logged.join('\n')}`);
  assert.match(why, /235/, 'the log names the number it dropped');
});

test('a missing monthResetDate key is migrated the same way', async () => {
  writeUsage({ adzuna: { callsThisMonth: 400 } });

  await checkQuota('adzuna', 5, 250);

  const entry = readUsage().adzuna;
  assert.equal(entry.callsThisMonth, 0);
  assert.equal(entry.monthResetDate, monthsFromToday(1));
});

test('the migration is written to disk even when the source is then skipped', async () => {
  // exhausted:true stops the source before it runs, so recordUsage never fires. If checkQuota did not save, the repair would exist
  // only in the log and the user would be stuck again next run.
  writeUsage({ adzuna: { callsThisMonth: 900, monthResetDate: null, exhausted: true } });

  const budget = await checkQuota('adzuna', 8, 250);

  assert.equal(budget.allowed, 8, 'migration clears the stale exhausted flag along with the count');
  const entry = readUsage().adzuna;
  assert.equal(entry.exhausted, false);
  assert.equal(entry.callsThisMonth, 0);
});

// ── Entries that already have a date behave exactly as before ────────────────

test('a due reset advances by one month and zeroes the counter', async () => {
  writeUsage({ adzuna: { callsThisMonth: 240, monthResetDate: '2026-08-01', exhausted: true, lastScan: null } });

  await checkQuota('adzuna', 8, 250);

  const entry = readUsage().adzuna;
  assert.equal(entry.callsThisMonth, 0);
  assert.equal(entry.monthResetDate, '2026-09-01', 'advanced from the stored date, not from today');
  assert.equal(entry.exhausted, false);
  assert.ok(!logged.some(l => l.includes('lifetime')), 'a normal rollover is not a migration');
});

test('an entry inside its month keeps its counter and its date', async () => {
  const future = monthsFromToday(1);
  writeUsage({ adzuna: { callsThisMonth: 40, monthResetDate: future, lastScan: null } });

  await recordUsage('adzuna', 2);

  const entry = readUsage().adzuna;
  assert.equal(entry.callsThisMonth, 42, 'the running total is preserved');
  assert.equal(entry.monthResetDate, future);
});

test('a genuinely spent month hands back only what is left', async () => {
  writeUsage({ adzuna: { callsThisMonth: 245, monthResetDate: monthsFromToday(1), lastScan: null } });

  const budget = await checkQuota('adzuna', 28, 250);
  assert.equal(budget.allowed, 5, 'genuine monthly exhaustion leaves only the 5 calls that fit');
});

// ── Per-run budgeting and the rotating query window ──────────────────────────
//
// Adzuna's full list (locations × target roles, ~35 searches) cannot run every
// day inside a 250/month budget. The old code checked the WHOLE list against
// the month and skipped the source when it did not fit, so a heavy list meant
// no Adzuna at all. Now a run takes a slice and the slice moves.

// The divisor is the scan cadence, and the cadence that ships is WEEKLY —
// weekly-api-scan.yml is the only workflow that runs the API sources. Dividing
// by 31 assumed a daily scan nobody runs: it held a weekly user to ~8 searches a
// week (each role-and-city pair once every five weeks) while ~86% of the monthly
// budget went unspent. Five ≈ weeks in a month.
test('the default per-run cap is a fifth of the month — one week of a weekly scan', () => {
  assert.equal(callsPerRun(250), 50, '250/5 = 50 a run, so five weekly runs fit the month');
  assert.equal(callsPerRun(1000), 200);
  assert.equal(callsPerRun(10), 2);
  assert.equal(callsPerRun(3), 1, 'a tiny budget still gets one call a run, not none');
});

test('an explicit per-run cap overrides the default, and nonsense does not', () => {
  assert.equal(callsPerRun(250, '12'), 12);
  assert.equal(callsPerRun(250, 'lots'), 50, 'an unparseable override falls back to the default');
  assert.equal(callsPerRun(250, '0'), 50, 'zero would silently disable the source');
});

test('the window rotates and covers every query over a full rotation', async () => {
  const total = 35;
  const cap = 8;
  const covered = new Set();
  let runs = 0;
  let expectedRotation = null;

  // ceil(35/8) = 5 runs to touch all 35.
  for (let run = 0; run < 5; run++) {
    const { start, count, runsPerRotation } = await takeQueryWindow('adzuna', total, cap);
    expectedRotation = runsPerRotation;
    for (let i = 0; i < count; i++) covered.add((start + i) % total);
    runs++;
  }

  assert.equal(expectedRotation, 5, 'the log tells the user a full pass takes 5 runs');
  assert.equal(runs, 5);
  assert.equal(covered.size, total, 'every one of the 35 searches was made at least once');
});

test('the window wraps past the end of the list instead of stranding the tail', async () => {
  // Cursor parked near the end: this run must take the last 2 and then the first 2.
  writeUsage({ adzuna: { callsThisMonth: 0, monthResetDate: monthsFromToday(1), queryCursor: 8 } });

  const { start, count } = await takeQueryWindow('adzuna', 10, 4);
  const picked = Array.from({ length: count }, (_, i) => (start + i) % 10);

  assert.deepEqual(picked, [8, 9, 0, 1]);
  assert.equal(readUsage().adzuna.queryCursor, 2, 'the cursor lands where the next run picks up');
});

test('a missing or junk cursor restarts the rotation at the beginning', async () => {
  writeUsage({ adzuna: { callsThisMonth: 0, monthResetDate: monthsFromToday(1) } });
  assert.equal((await takeQueryWindow('adzuna', 10, 3)).start, 0);

  writeUsage({ adzuna: { callsThisMonth: 0, monthResetDate: monthsFromToday(1), queryCursor: 'x' } });
  assert.equal((await takeQueryWindow('adzuna', 10, 3)).start, 0);
});

test('the cursor advances even when the run that planned it never finishes', async () => {
  // Advanced at planning time on purpose: one query combination that always
  // throws must not pin the window and starve every other combination.
  await takeQueryWindow('adzuna', 35, 8);
  assert.equal(readUsage().adzuna.queryCursor, 8);
});

// ── The pre-flight projection uses the capped estimate ───────────────────────

test('a capped run is not blocked by a query list too big for the month', async () => {
  // The old projection checked the whole 35-search list against the month, and
  // on a stale lifetime counter (35 + 200 > 250) that took Adzuna offline every
  // run. The projection is now one run's worth: at the weekly cadence a 35-item
  // list is under the 50-call slice, so the whole list runs and still fits.
  writeUsage({ adzuna: { callsThisMonth: 200, monthResetDate: monthsFromToday(1) } });

  const perRun = callsPerRun(250);
  const budget = await checkQuota('adzuna', Math.min(35, perRun), 250);

  assert.equal(perRun, 50);
  assert.equal(budget.allowed, 35, 'the run goes ahead with the whole list');
});

test('when less than a run fits, the run is trimmed rather than skipped', async () => {
  writeUsage({ adzuna: { callsThisMonth: 247, monthResetDate: monthsFromToday(1) } });

  const budget = await checkQuota('adzuna', callsPerRun(250), 250);

  assert.equal(budget.allowed, 3, 'the last 3 calls of the month are still spent on jobs');
  assert.equal(budget.resetDate, monthsFromToday(1), 'the caller can tell the user when it comes back');
});

// ── The source actually honors the cap ───────────────────────────────────────
//
// The fetch stub always fails, which keeps these fast: the failure path skips
// the 500ms politeness sleep between searches. Attempts are still counted, and
// attempts are what quota is recorded from.

const SEVEN_ROLES = ['pm', 'product manager', 'chief of staff', 'bizops', 'strategy', 'ops lead', 'gm'];
const FIVE_CITIES = ['Austin', 'Denver', 'Boston', 'Chicago', 'Seattle']
  .map(city => ({ city, country: 'US', radiusMiles: 25 }));

const BUDGET_CONFIG = {
  adzunaAppId: 'app-id',
  adzunaApiKey: 'app-key',
  requiredTitleKeywords: SEVEN_ROLES,
  locations: FIVE_CITIES,
};

function failingFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'nope', json: async () => ({}) });
  return () => { globalThis.fetch = real; };
}

test('fetchAdzuna runs only its allowance and says so in the log', async () => {
  const restore = failingFetch();
  try {
    await fetchAdzuna({ ...BUDGET_CONFIG, adzunaMaxCallsPerRun: 8 });
  } finally {
    restore();
  }

  assert.equal(adzunaStats.attempts, 8, '35 searches wanted, 8 allowed, 8 sent');
  assert.deepEqual(adzunaStats.window, { ran: 8, total: 35, runsPerRotation: 5 });
  const line = logged.find(l => l.includes('of 35 searches'));
  assert.ok(line, `the run says what it ran; got:\n${logged.join('\n')}`);
  assert.match(line, /takes 5 runs/, 'and how many runs a full rotation takes');
});

test('two consecutive runs search different combinations', async () => {
  const restore = failingFetch();
  try {
    await fetchAdzuna({ ...BUDGET_CONFIG, adzunaMaxCallsPerRun: 8 });
    const firstCursor = readUsage().adzuna.queryCursor;
    await fetchAdzuna({ ...BUDGET_CONFIG, adzunaMaxCallsPerRun: 8 });
    assert.equal(firstCursor, 8);
    assert.equal(readUsage().adzuna.queryCursor, 16, 'run two picked up where run one stopped');
  } finally {
    restore();
  }
});

test('a zero allowance sends nothing and does not move the rotation on', async () => {
  const restore = failingFetch();
  try {
    await fetchAdzuna({ ...BUDGET_CONFIG, adzunaMaxCallsPerRun: 0 });
  } finally {
    restore();
  }

  assert.equal(adzunaStats.attempts, 0);
  assert.deepEqual(adzunaStats.window, { ran: 0, total: 35, runsPerRotation: null });
  assert.equal(fs.existsSync(usageFile()), false, 'a run that spends nothing writes no cursor');
});

test('no cap set leaves the source exactly as it was', async () => {
  const restore = failingFetch();
  try {
    await fetchAdzuna({ ...BUDGET_CONFIG });
  } finally {
    restore();
  }

  assert.equal(adzunaStats.attempts, 35, 'every search runs when nobody set a budget');
  assert.equal(adzunaStats.window, null, 'nothing to tell the user about');
  assert.equal(fs.existsSync(usageFile()), false, 'and no quota state is touched');
});

// ── An empty window divides by nothing ───────────────────────────────────────

test('a window over an empty list hands back nothing and leaves the cursor alone', async () => {
  writeUsage({ adzuna: { callsThisMonth: 4, monthResetDate: monthsFromToday(1), queryCursor: 6 } });

  // start % 0 is NaN and ceil(0/0) is NaN: the old code wrote NaN into the
  // cursor, and a NaN cursor restarts the rotation from the beginning forever.
  const empty = await takeQueryWindow('adzuna', 0, 8);
  assert.deepEqual(empty, { start: 0, count: 0, runsPerRotation: 0 });

  const noAllowance = await takeQueryWindow('adzuna', 35, 0);
  assert.deepEqual(noAllowance, { start: 0, count: 0, runsPerRotation: 0 });

  assert.equal(readUsage().adzuna.queryCursor, 6, 'the rotation resumes where it was');
});

// ── The month is a month, in every timezone ──────────────────────────────────
//
// oneMonthOn parsed the stored day as UTC midnight and then advanced it with the
// LOCAL-time setMonth. Under TZ=America/New_York that turned '2026-03-01' into
// '2026-03-28' — a 27-day "month" that reset the counter early and handed the
// user back an allowance they had not earned. Actions runners are UTC so
// production never saw it; anyone scanning from their own machine did.
//
// Run in a child process because TZ has to be set before the process starts to
// be worth trusting.

const quotaModuleUrl = pathToFileURL(path.join(realCwd, 'scanner', 'quota.mjs')).href;

function rolloverUnder(tz, storedResetDate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbud-quota-tz-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'api-usage.json'), JSON.stringify({
    adzuna: { callsThisMonth: 40, monthResetDate: storedResetDate },
  }));

  execFileSync(process.execPath, ['--input-type=module', '-e', `
    console.log = () => {}; console.warn = () => {};
    const { checkQuota } = await import(${JSON.stringify(quotaModuleUrl)});
    await checkQuota('adzuna', 1, 250);
  `], { cwd: dir, env: { ...process.env, TZ: tz }, stdio: 'pipe' });

  return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'api-usage.json'), 'utf8')).adzuna;
}

test('a rollover advances a whole month west of UTC, not 27 days', () => {
  const local = rolloverUnder('America/New_York', '2026-03-01');
  assert.equal(local.monthResetDate, '2026-04-01');
  assert.equal(local.callsThisMonth, 0, 'and the counter still starts over');

  const utc = rolloverUnder('UTC', '2026-03-01');
  assert.equal(utc.monthResetDate, '2026-04-01', 'the CI runner and the laptop agree');
});

test('a month-end reset date lands in the next month, not the one after it', () => {
  // Jan 31 + 1 month has no 31st to land on. setMonth rolled it into March 3rd,
  // skipping February; the last day of the target month is the honest answer.
  assert.equal(rolloverUnder('UTC', '2026-01-31').monthResetDate, '2026-02-28');
  assert.equal(rolloverUnder('America/New_York', '2026-01-31').monthResetDate, '2026-02-28');
  assert.equal(rolloverUnder('UTC', '2024-01-31').monthResetDate, '2024-02-29', 'February gets its leap day');
  assert.equal(rolloverUnder('UTC', '2026-05-31').monthResetDate, '2026-06-30');
});
