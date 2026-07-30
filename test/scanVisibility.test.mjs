// Tests for the two "why is the scan doing that?" signals:
//   1. the digest line shown when the scan is still running on the example
//      company list that ships with the repo, and
//   2. the per-run radar summary that explains how many radar companies were
//      left out and why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEmail } from '../scanner/notify.mjs';
import { selectRadarCompanies } from '../scanner/radarSource.mjs';
import { STARTER_LIST_NOTICE } from '../lib/portalsMeta.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
const scannerIndex = readFileSync(join(__dirname, '..', 'scanner', 'index.mjs'), 'utf8');

const job = (over = {}) => ({
  company: 'Acme', title: 'Head of Ops', score: 4.7, jobType: 'operating',
  location: 'New York, NY', url: 'https://example.com/job', recommendedAction: 'Apply',
  _fingerprint: 'fp1', ...over,
});

// ── Digest notice ─────────────────────────────────────────────────────────────

test('the digest carries the example-list line when the scan used the starter file', () => {
  const { html: body, text } = buildEmail([job()], { usingStarterPortals: true });
  assert.ok(body.includes(STARTER_LIST_NOTICE.replace(/'/g, '&#39;')) || body.includes(STARTER_LIST_NOTICE),
    'notice rendered in the HTML digest');
  assert.ok(text.includes(STARTER_LIST_NOTICE), 'notice rendered in the plain-text digest');
});

test('the digest says nothing when the watch list is the user\'s own', () => {
  const { html: body, text } = buildEmail([job()], {});
  assert.doesNotMatch(body, /example company list/);
  assert.doesNotMatch(text, /example company list/);
  assert.doesNotMatch(body, /starter-notice">/); // the wrapper div is not emitted at all
});

test('the notice appears once, above the job sections', () => {
  const { html: body } = buildEmail([job(), job({ _fingerprint: 'fp2', title: 'COO' })], { usingStarterPortals: true });
  const occurrences = body.split('example company list').length - 1;
  assert.equal(occurrences, 1);
  assert.ok(body.indexOf('example company list') < body.indexOf('Apply Now'), 'notice precedes the first section');
});

test('the scanner sets the flag from the real portals.yml, and never on a read failure', () => {
  // The read is guarded so a missing/unreadable file cannot produce the notice.
  assert.match(scannerIndex, /isStarterPortalsList\(portalsRaw\)/);
  assert.match(scannerIndex, /config\.usingStarterPortals = true/);
  const guard = scannerIndex.slice(scannerIndex.indexOf('isStarterPortalsList(portalsRaw)'));
  assert.match(guard, /catch \(err\)[\s\S]{0,400}Could not check the watch list/);
});

// ── Onboarding skip path points somewhere ────────────────────────────────────

test('the onboarding skip button says where to set companies later', () => {
  assert.match(html, /Skip — keep the example list \(you can set your companies anytime from Radar → Edit Watch List\)/);
});

// ── Radar scan summary ───────────────────────────────────────────────────────

const radarCo = (over = {}) => ({
  company: 'Acme', scannerEnabled: true, scanFrequency: 'daily',
  atsBoard: 'greenhouse', atsSlug: 'acme', ...over,
});

test('every radar company lands in exactly one bucket', () => {
  const { configs, counts } = selectRadarCompanies([
    radarCo({ company: 'Scanned' }),
    radarCo({ company: 'ToggledOff', scannerEnabled: false }),
    radarCo({ company: 'NoBoard', atsBoard: '', atsSlug: '' }),
    radarCo({ company: 'NoSlug', atsSlug: '   ' }),
    radarCo({ company: 'Weekly', scanFrequency: 'weekly' }),
  ], 'daily');

  assert.equal(counts.total, 5);
  assert.equal(configs.length, 1);
  assert.equal(counts.toggleOff, 1);
  assert.equal(counts.noMapping, 2);
  assert.equal(counts.otherCadence, 1);
  assert.equal(configs.length + counts.toggleOff + counts.noMapping + counts.otherCadence, counts.total);
  assert.equal(configs[0].name, 'Scanned');
});

test("cadence 'all' never counts a company as the wrong frequency", () => {
  const { configs, counts } = selectRadarCompanies([
    radarCo({ company: 'Daily' }),
    radarCo({ company: 'Weekly', scanFrequency: 'weekly' }),
  ], 'all');
  assert.equal(configs.length, 2);
  assert.equal(counts.otherCadence, 0);
});

test('an unsupported ATS (workday, custom) counts as no mapping, not as scanned', () => {
  const { configs, counts } = selectRadarCompanies([
    radarCo({ company: 'Workday Co', atsBoard: 'workday', atsSlug: 'wd' }),
    radarCo({ company: 'Custom Co', atsBoard: 'custom', atsSlug: 'x' }),
  ], 'all');
  assert.equal(configs.length, 0);
  assert.equal(counts.noMapping, 2);
});

test('an empty radar produces zero counts rather than throwing', () => {
  const { configs, counts } = selectRadarCompanies([], 'all');
  assert.equal(configs.length, 0);
  assert.deepEqual(counts, { total: 0, toggleOff: 0, otherCadence: 0, noMapping: 0 });
});
