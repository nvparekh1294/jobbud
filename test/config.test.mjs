import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileYml, parseLocations } from '../scanner/config.mjs';

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
