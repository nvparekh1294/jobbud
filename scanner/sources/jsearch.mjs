import { resolveTargetRoles, buildRoleGroups } from './queryHelpers.mjs';

// JSearch moved on: subscriptions created after the migration only expose
// /search-v2, older ones only expose /search. Asking for the wrong one gets a
// 404 whose body reads "Endpoint '/search' does not exist" — which the old code
// logged per query and then returned zero jobs from. So we probe once per run,
// remember which endpoint answered, and say so in the log.
const API_BASE = 'https://jsearch.p.rapidapi.com';
const V2_PATH = '/search-v2';
const V1_PATH = '/search';
const UNAVAILABLE = 'unavailable';

// Per-run counters, read by index.mjs so quota is recorded from what actually
// went over the wire (attempts count against the provider quota even when they
// fail) instead of a pre-computed estimate. attempts = HTTP requests made;
// queries/failures = search queries tried and how many came back empty-handed.
export const jsearchStats = { attempts: 0, queries: 0, failures: 0, lastError: null };

// Which endpoint this run is using: null = not probed yet, a path = in use,
// UNAVAILABLE = the subscription has neither.
let endpointPath = null;

// Exported for tests, which run several scenarios in one process.
export function resetJSearchRun() {
  jsearchStats.attempts = 0;
  jsearchStats.queries = 0;
  jsearchStats.failures = 0;
  jsearchStats.lastError = null;
  endpointPath = null;
}

export async function fetchJSearch(config) {
  resetJSearchRun();

  if (!config.jsearchApiKey) {
    console.warn('JSearch API key not set -- skipping');
    return [];
  }

  const queries = buildQueries(config);
  const results = [];

  for (const query of queries) {
    jsearchStats.queries++;
    try {
      const jobs = await searchJSearch(query, config.jsearchApiKey);
      results.push(...jobs);
      await sleep(500);
    } catch (err) {
      jsearchStats.failures++;
      jsearchStats.lastError = err.message;
      console.error(`JSearch query failed for "${query}":`, err.message);
    }
  }

  return results.map(normalizeJSearch);
}

function buildQueries(config) {
  const roles = resolveTargetRoles(config);
  if (!roles.length) {
    console.warn('[jsearch] No target roles configured (set target_roles in config/profile.yml) -- skipping');
    return [];
  }

  const roleGroups = buildRoleGroups(roles);
  const queries = [];

  for (const location of config.locations) {
    for (const roleGroup of roleGroups) {
      queries.push(`${roleGroup} in ${location.city}`);
    }
  }

  if (config.includeRemote) {
    for (const roleGroup of roleGroups) {
      queries.push(`${roleGroup} remote`);
    }
  }

  return queries;
}

// One query. The first query of the run doubles as the endpoint probe; every
// later query goes straight to whichever endpoint answered.
async function searchJSearch(query, apiKey) {
  if (endpointPath === UNAVAILABLE) {
    throw new Error(`JSearch subscription exposes neither ${V2_PATH} nor ${V1_PATH}`);
  }
  if (endpointPath) return requestJSearch(endpointPath, query, apiKey);

  try {
    const jobs = await requestJSearch(V2_PATH, query, apiKey);
    endpointPath = V2_PATH;
    console.log(`[jsearch] Using ${V2_PATH} for this run`);
    return jobs;
  } catch (err) {
    if (!isMissingEndpoint(err)) throw err;

    // v2 is not on this subscription — the older /search still is on plans that
    // predate the migration.
    try {
      const jobs = await requestJSearch(V1_PATH, query, apiKey);
      endpointPath = V1_PATH;
      console.log(`[jsearch] ${V2_PATH} not on this subscription — using ${V1_PATH} for this run`);
      return jobs;
    } catch (v1Err) {
      if (!isMissingEndpoint(v1Err)) throw v1Err;
      endpointPath = UNAVAILABLE;
      const message =
        `[jsearch] Your JSearch subscription answers 404 for BOTH ${V2_PATH} and ${V1_PATH}. ` +
        `No JSearch jobs will be fetched this run. Check the JSearch plan on your RapidAPI ` +
        `account (a current subscription should expose ${V2_PATH}).`;
      console.error(message);
      throw new Error(`JSearch subscription exposes neither ${V2_PATH} nor ${V1_PATH}`);
    }
  }
}

async function requestJSearch(path, query, apiKey) {
  jsearchStats.attempts++;

  const response = await fetch(`${API_BASE}${path}?${buildParams(path, query)}`, {
    headers: {
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`JSearch HTTP ${response.status}: ${body}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }

  const data = await response.json();
  return extractJobs(data);
}

function buildParams(path, query) {
  // v2 is cursor-paginated (no page/num_pages); we take the first page either
  // way, so the cursor is never followed.
  if (path === V2_PATH) {
    return new URLSearchParams({ query, date_posted: 'week' });
  }
  return new URLSearchParams({
    query,
    page: '1',
    num_pages: '1',
    date_posted: 'week',
  });
}

// v1 returns { data: [ ...jobs ] }. v2's envelope is documented as cursor-based
// but its exact `data` shape is not published, so accept both an array and an
// object wrapping the array rather than guessing one.
function extractJobs(data) {
  const payload = data?.data ?? data?.jobs ?? [];
  if (Array.isArray(payload)) return payload;
  const nested = payload.jobs ?? payload.results ?? payload.data;
  return Array.isArray(nested) ? nested : [];
}

function isMissingEndpoint(err) {
  return err?.status === 404 && /does not exist/i.test(err.body || err.message || '');
}

// The two endpoints ship mostly the same job fields; v2 adds a flat
// `job_location` and `work_arrangement` where v1 had parsed city/state/country
// and `job_is_remote`. Every v1 field is still read first, so v1 subscriptions
// normalize exactly as before.
function normalizeJSearch(job) {
  return {
    source: 'jsearch',
    sourceId: job.job_id,
    title: job.job_title,
    company: job.employer_name,
    location: [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ') ||
              job.job_location || '',
    isRemote: resolveIsRemote(job),
    description: job.job_description,
    url: job.job_apply_link || job.apply_options?.[0]?.apply_link || job.apply_options?.[0]?.link || null,
    postedAt: resolvePostedAt(job),
    employmentType: job.job_employment_type || job.job_employment_types?.[0] || null,
    salary: {
      min: job.job_min_salary,
      max: job.job_max_salary,
      currency: job.job_salary_currency,
      period: job.job_salary_period,
    },
  };
}

function resolveIsRemote(job) {
  if (typeof job.job_is_remote === 'boolean') return job.job_is_remote;
  return /remote|work.?from.?home/i.test(job.work_arrangement || '');
}

function resolvePostedAt(job) {
  if (job.job_posted_at_datetime_utc) return job.job_posted_at_datetime_utc;
  if (typeof job.job_posted_at_timestamp === 'number') {
    return new Date(job.job_posted_at_timestamp * 1000).toISOString();
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
