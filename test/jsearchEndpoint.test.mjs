// JSearch endpoint migration guards.
//
// A real user's scans returned zero API jobs because his RapidAPI subscription
// only exposes /search-v2, while the scanner only ever called /search — every
// query 404'd with "Endpoint '/search' does not exist" and the run still went
// green. These tests pin the probe-once-per-run fallback and the normalization
// of both response shapes.
//
// fetch is stubbed with fixture payloads throughout — no live API is ever called.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJSearch, jsearchStats, resetJSearchRun } from '../scanner/sources/jsearch.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetJSearchRun(); });

// One role, one location, no remote → exactly one query per run, which keeps
// the source's inter-query sleep out of the test runtime.
const CONFIG = {
  jsearchApiKey: 'test-key',
  requiredTitleKeywords: ['product manager'],
  locations: [{ city: 'Austin', region: 'TX', country: 'us', radiusMiles: 25 }],
  includeRemote: false,
};

const V1_JOB = {
  job_id: 'v1-1',
  job_title: 'Product Manager',
  employer_name: 'Acme',
  job_city: 'Austin',
  job_state: 'TX',
  job_country: 'US',
  job_is_remote: false,
  job_description: 'Build things.',
  job_apply_link: 'https://acme.example/jobs/1',
  job_posted_at_datetime_utc: '2026-07-30T00:00:00.000Z',
  job_employment_type: 'FULLTIME',
  job_min_salary: 150000,
  job_max_salary: 190000,
  job_salary_currency: 'USD',
  job_salary_period: 'YEAR',
};

// v2 drops the parsed city/state/country for a flat job_location, reports
// remoteness via work_arrangement, and dates via a unix timestamp.
const V2_JOB = {
  job_id: 'v2-1',
  job_title: 'Senior Product Manager',
  employer_name: 'Globex',
  job_location: 'Remote, United States',
  work_arrangement: 'remote',
  job_description: 'Own the roadmap.',
  apply_options: [{ apply_link: 'https://globex.example/jobs/2' }],
  job_posted_at_timestamp: 1785369600,
  job_employment_types: ['FULLTIME'],
  job_min_salary: 180000,
  job_max_salary: 220000,
  job_salary_currency: 'USD',
  job_salary_period: 'YEAR',
};

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function missingEndpointResponse(path) {
  const body = JSON.stringify({ message: `Endpoint '${path}' does not exist` });
  return { ok: false, status: 404, json: async () => JSON.parse(body), text: async () => body };
}

// Records every URL fetched and replies from a handler keyed on the path.
function stubFetch(handler) {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return handler(String(url));
  };
  return urls;
}

test('a v2-only subscription gets its jobs from /search-v2', async () => {
  const urls = stubFetch((url) =>
    url.includes('/search-v2')
      ? jsonResponse({ status: 'OK', data: [V2_JOB] })
      : missingEndpointResponse('/search'));

  const jobs = await fetchJSearch(CONFIG);

  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('/search-v2'));
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    source: 'jsearch',
    sourceId: 'v2-1',
    title: 'Senior Product Manager',
    company: 'Globex',
    location: 'Remote, United States',
    isRemote: true,
    description: 'Own the roadmap.',
    url: 'https://globex.example/jobs/2',
    postedAt: '2026-07-30T00:00:00.000Z',
    employmentType: 'FULLTIME',
    salary: { min: 180000, max: 220000, currency: 'USD', period: 'YEAR' },
  });
});

test('a v2 payload that wraps its jobs in an object still normalizes', async () => {
  // The v2 envelope's `data` shape is not published; both an array and an
  // object carrying the array plus a cursor are accepted.
  stubFetch(() => jsonResponse({ status: 'OK', data: { jobs: [V2_JOB], cursor: 'abc' } }));

  const jobs = await fetchJSearch(CONFIG);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceId, 'v2-1');
});

test('a v1-only subscription falls back to /search and normalizes as before', async () => {
  const urls = stubFetch((url) =>
    url.includes('/search-v2')
      ? missingEndpointResponse('/search-v2')
      : jsonResponse({ status: 'OK', data: [V1_JOB] }));

  const jobs = await fetchJSearch(CONFIG);

  assert.deepEqual(urls.map(u => u.includes('/search-v2')), [true, false]);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    source: 'jsearch',
    sourceId: 'v1-1',
    title: 'Product Manager',
    company: 'Acme',
    location: 'Austin, TX, US',
    isRemote: false,
    description: 'Build things.',
    url: 'https://acme.example/jobs/1',
    postedAt: '2026-07-30T00:00:00.000Z',
    employmentType: 'FULLTIME',
    salary: { min: 150000, max: 190000, currency: 'USD', period: 'YEAR' },
  });
});

test('the endpoint is probed once per run, not once per query', async () => {
  const multiQuery = { ...CONFIG, requiredTitleKeywords: ['product manager'], includeRemote: true };
  const urls = stubFetch((url) =>
    url.includes('/search-v2')
      ? missingEndpointResponse('/search-v2')
      : jsonResponse({ status: 'OK', data: [V1_JOB] }));

  await fetchJSearch(multiQuery);

  // Two queries (one city + one remote): probe pair on the first, then /search
  // straight away on the second.
  assert.equal(urls.filter(u => u.includes('/search-v2')).length, 1);
  assert.equal(urls.filter(u => !u.includes('/search-v2')).length, 2);
});

test('a subscription with neither endpoint fails loudly, naming both', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    stubFetch((url) => missingEndpointResponse(url.includes('/search-v2') ? '/search-v2' : '/search'));
    const jobs = await fetchJSearch(CONFIG);
    assert.deepEqual(jobs, []);
  } finally {
    console.error = realError;
  }

  const loud = errors.join('\n');
  assert.match(loud, /\/search-v2/);
  assert.match(loud, /\/search\b/);
  assert.equal(jsearchStats.failures, jsearchStats.queries);
});

test('a non-404 error is not treated as a missing endpoint', async () => {
  // A rate-limit or auth failure must not silently switch endpoints.
  const urls = stubFetch(() => ({
    ok: false,
    status: 429,
    text: async () => 'Too Many Requests',
    json: async () => ({}),
  }));

  const jobs = await fetchJSearch(CONFIG);
  assert.deepEqual(jobs, []);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('/search-v2'));
});

test('per-run stats count HTTP attempts, queries and failures', async () => {
  stubFetch((url) =>
    url.includes('/search-v2')
      ? missingEndpointResponse('/search-v2')
      : jsonResponse({ status: 'OK', data: [V1_JOB] }));

  await fetchJSearch(CONFIG);

  // The failed v2 probe still burned a request against the plan's quota.
  assert.equal(jsearchStats.attempts, 2);
  assert.equal(jsearchStats.queries, 1);
  assert.equal(jsearchStats.failures, 0);
});
