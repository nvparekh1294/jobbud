import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileYml, parseLocations, numericSetting, loadConfig } from '../scanner/config.mjs';

// ── parseProfileYml ───────────────────────────────────────────────────────────
test('parseProfileYml parses flat key:value pairs', () => {
  const result = parseProfileYml('name: Alex Doe\nemail: alex@example.com');
  assert.equal(result.name, 'Alex Doe');
  assert.equal(result.email, 'alex@example.com');
});

test('parseProfileYml coerces booleans and numbers, strips quotes', () => {
  const result = parseProfileYml('remote: true\nonsite: false\nyears: 5\ntitle: "Head of Ops"');
  assert.equal(result.remote, true);
  assert.equal(result.onsite, false);
  assert.equal(result.years, 5);
  assert.equal(result.title, 'Head of Ops');
});

test('parseProfileYml collects "  - item" lines into an array', () => {
  const result = parseProfileYml('targets:\n  - Product Manager\n  - Head of Operations');
  assert.deepEqual(result.targets, ['Product Manager', 'Head of Operations']);
});

test('parseProfileYml handles a block scalar (|) and resumes normal parsing after it', () => {
  const yaml = 'bio: |\n  line one\n  line two\nnext: value';
  const result = parseProfileYml(yaml);
  assert.equal(result.bio, 'line one\nline two');
  assert.equal(result.next, 'value');
});

test('parseProfileYml skips comments and blank lines', () => {
  const result = parseProfileYml('# a comment\n\nname: Alex\n\n# another\nrole: PM');
  assert.deepEqual(result, { name: 'Alex', role: 'PM' });
});

test('parseProfileYml edge case: empty or null input returns an empty object', () => {
  assert.deepEqual(parseProfileYml(''), {});
  assert.deepEqual(parseProfileYml(null), {});
});

// ── parseLocations ────────────────────────────────────────────────────────────
test('parseLocations reads a target_locations block into structured entries', () => {
  const yaml = [
    'target_locations:',
    '  - city: Austin',
    '    region: TX',
    '    country: us',
    '    radius_miles: 30',
    '  - city: Berlin',
    '    region: null',
    '    country: de',
    '    radius_miles: 15',
  ].join('\n');
  const locs = parseLocations(yaml);
  assert.deepEqual(locs, [
    { city: 'Austin', region: 'TX', country: 'us', radiusMiles: 30 },
    { city: 'Berlin', region: null, country: 'de', radiusMiles: 15 },
  ]);
});

test('parseLocations defaults the radius when none is given', () => {
  const yaml = 'target_locations:\n  - city: Toronto\n    country: ca';
  assert.deepEqual(parseLocations(yaml), [
    { city: 'Toronto', region: null, country: 'ca', radiusMiles: 20 },
  ]);
});

test('parseLocations returns null when no locations are declared', () => {
  assert.equal(parseLocations('name: Alex Doe'), null);
  assert.equal(parseLocations(''), null);
  assert.equal(parseLocations(null), null);
});

// ── Settings the user can actually deliver ────────────────────────────────────
//
// The monthly API limits were env-only, which made them dead on arrival for the
// people they were written for: the scheduled workflow hands the scanner a fixed
// env block, Actions injects nothing by itself, and the workflow files are
// frozen — so ADZUNA_MONTHLY_LIMIT set as a repo secret never reached the code.
// config/profile.yml is fetched from the user's repo on every run, so that is
// the delivery path; env stays ahead of it for a local run.

test('a setting declared in profile.yml is used', () => {
  const profile = parseProfileYml('adzuna_monthly_limit: 1000');
  assert.equal(numericSetting(profile, 'adzuna_monthly_limit', 'ADZUNA_MONTHLY_LIMIT', 250), 1000);
});

test('the built-in default holds when neither env nor profile says anything', () => {
  assert.equal(numericSetting({}, 'adzuna_monthly_limit', 'ADZUNA_MONTHLY_LIMIT', 250), 250);
  assert.equal(numericSetting({}, 'adzuna_calls_per_run', 'ADZUNA_CALLS_PER_RUN', null), null);
});

test('env wins over profile.yml, for the local run that sets it', () => {
  const profile = { adzuna_monthly_limit: 1000 };
  process.env.ADZUNA_MONTHLY_LIMIT = '600';
  try {
    assert.equal(numericSetting(profile, 'adzuna_monthly_limit', 'ADZUNA_MONTHLY_LIMIT', 250), 600);
  } finally {
    delete process.env.ADZUNA_MONTHLY_LIMIT;
  }
});

test('a nonsense value falls through to the next source instead of disabling the budget', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    process.env.ADZUNA_MONTHLY_LIMIT = 'lots';
    assert.equal(numericSetting({ adzuna_monthly_limit: 1000 }, 'adzuna_monthly_limit', 'ADZUNA_MONTHLY_LIMIT', 250), 1000,
      'an unusable env value falls back to the profile, not to zero');
    delete process.env.ADZUNA_MONTHLY_LIMIT;
    assert.equal(numericSetting({ adzuna_monthly_limit: 0 }, 'adzuna_monthly_limit', 'ADZUNA_MONTHLY_LIMIT', 250), 250,
      'zero would silently switch the source off');
    assert.equal(numericSetting({ adzuna_monthly_limit: 'plenty' }, 'adzuna_monthly_limit', 'ADZUNA_MONTHLY_LIMIT', 250), 250);
  } finally {
    delete process.env.ADZUNA_MONTHLY_LIMIT;
    console.warn = warn;
  }
});

test('loadConfig hands the scanner the resolved budgets', async () => {
  // No token/owner/repo — loadProfileYml returns null, so this is the pure
  // defaults path, which is what a user with no settings declared gets.
  const config = await loadConfig(null, null, null);
  assert.equal(config.adzunaMonthlyLimit, 250);
  assert.equal(config.jsearchMonthlyLimit, 200);
  assert.equal(config.serpapiMonthlyLimit, 250);
  assert.equal(config.adzunaCallsPerRun, null, 'no opinion means quota.mjs works the slice out from the cadence');
});
