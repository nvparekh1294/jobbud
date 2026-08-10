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
import { checkQuota, recordUsage } from '../scanner/quota.mjs';

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
  const ok = await checkQuota('jsearch', 10, 200);

  assert.equal(ok, true);
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

  const ok = await checkQuota('adzuna', 28, 250);

  assert.equal(ok, true, '28 estimated calls against a freshly-zeroed month must pass');
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
  // exhausted:true makes checkQuota return false before any source runs, so
  // recordUsage never fires. If checkQuota did not save, the repair would exist
  // only in the log and the user would be stuck again next run.
  writeUsage({ adzuna: { callsThisMonth: 900, monthResetDate: null, exhausted: true } });

  const ok = await checkQuota('adzuna', 8, 250);

  assert.equal(ok, true, 'migration clears the stale exhausted flag along with the count');
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

test('a real over-limit month is still refused', async () => {
  writeUsage({ adzuna: { callsThisMonth: 245, monthResetDate: monthsFromToday(1), lastScan: null } });

  assert.equal(await checkQuota('adzuna', 28, 250), false, 'genuine monthly exhaustion still stops the source');
});
