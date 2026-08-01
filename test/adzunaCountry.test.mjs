// Adzuna country-normalization guards.
//
// A real user's AI-written config/profile.yml said `country: US`. The BASE_URLS
// lookup is keyed on lowercase ISO codes, so every location missed, zero queries
// were built, and the scan reported no Adzuna jobs with not one line of log
// saying why. These tests pin the normalization and both loud warnings.
//
// fetch is stubbed with fixture payloads throughout — no live API is ever called.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAdzuna } from '../scanner/sources/adzuna.mjs';
import { normalizeCountry } from '../scanner/sources/queryHelpers.mjs';

const realFetch = globalThis.fetch;
const realWarn = console.warn;
afterEach(() => { globalThis.fetch = realFetch; console.warn = realWarn; });

const BASE_CONFIG = {
  adzunaAppId: 'app-id',
  adzunaApiKey: 'app-key',
  requiredTitleKeywords: ['product manager'],
};

function stubFetch() {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '{}' };
  };
  return urls;
}

function captureWarnings() {
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  return warnings;
}

test('normalizeCountry trims, lowercases and maps the common aliases', () => {
  assert.equal(normalizeCountry('US'), 'us');
  assert.equal(normalizeCountry(' us '), 'us');
  assert.equal(normalizeCountry('USA'), 'us');
  assert.equal(normalizeCountry('UK'), 'gb');
  assert.equal(normalizeCountry('gb'), 'gb');
  assert.equal(normalizeCountry('de'), 'de');
  assert.equal(normalizeCountry(undefined), '');
});

test('an uppercase country still builds queries instead of being skipped', async () => {
  const urls = stubFetch();
  captureWarnings();

  await fetchAdzuna({
    ...BASE_CONFIG,
    locations: [{ city: 'Austin', region: 'TX', country: 'US', radiusMiles: 25 }],
  });

  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith('https://api.adzuna.com/v1/api/jobs/us/search'));
  assert.ok(urls[0].includes('where=Austin'));
});

test('"USA" and "UK" reach the us and gb endpoints', async () => {
  const urls = stubFetch();
  captureWarnings();

  await fetchAdzuna({
    ...BASE_CONFIG,
    locations: [
      { city: 'Austin', country: 'USA', radiusMiles: 25 },
      { city: 'London', country: 'UK', radiusMiles: 25 },
    ],
  });

  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('/jobs/us/search'));
  assert.ok(urls[1].includes('/jobs/gb/search'));
});

test('an unsupported country is warned about by city, value and supported list', async () => {
  stubFetch();
  const warnings = captureWarnings();

  await fetchAdzuna({
    ...BASE_CONFIG,
    locations: [
      { city: 'Berlin', country: 'DE', radiusMiles: 25 },
      { city: 'Austin', country: 'US', radiusMiles: 25 },
    ],
  });

  const skip = warnings.find(w => w.includes('Berlin'));
  assert.ok(skip, 'the skipped city was never named');
  assert.match(skip, /"DE"/);
  assert.match(skip, /us\/gb\/sg/);
});

test('zero buildable queries says plainly that Adzuna will not run', async () => {
  const urls = stubFetch();
  const warnings = captureWarnings();

  const jobs = await fetchAdzuna({
    ...BASE_CONFIG,
    locations: [{ city: 'Berlin', country: 'DE', radiusMiles: 25 }],
  });

  assert.deepEqual(jobs, []);
  assert.equal(urls.length, 0, 'no request should be made when no query was built');
  assert.ok(warnings.some(w => /Adzuna will not run this scan/.test(w)),
    'a scan that fetches nothing must say so');
  assert.ok(warnings.some(w => /None of your locations are in a country/.test(w)),
    'when a location really was dropped for its country, say so');
});

test('an empty location list is diagnosed as empty, not as unsupported countries', async () => {
  // Blaming unsupported countries when the user listed no locations at all is a
  // confident wrong answer that sends them looking in the wrong file.
  const urls = stubFetch();
  const warnings = captureWarnings();

  const jobs = await fetchAdzuna({ ...BASE_CONFIG, locations: [] });

  assert.deepEqual(jobs, []);
  assert.equal(urls.length, 0);
  const warned = warnings.find(w => /Adzuna will not run this scan/.test(w));
  assert.ok(warned, 'a scan that fetches nothing must say so');
  assert.match(warned, /No target_locations are configured/);
  assert.ok(!/None of your locations are in a country/.test(warned),
    'nothing was skipped for its country, so that must not be blamed');
});
