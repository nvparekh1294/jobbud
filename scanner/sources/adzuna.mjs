import { resolveTargetRoles, normalizeCountry } from './queryHelpers.mjs';

const BASE_URLS = {
  us: 'https://api.adzuna.com/v1/api/jobs/us/search',
  gb: 'https://api.adzuna.com/v1/api/jobs/gb/search',
  sg: 'https://api.adzuna.com/v1/api/jobs/sg/search',
};

// Per-run counters, read by index.mjs so quota is recorded from what actually
// went over the wire rather than a pre-computed estimate. attempts = HTTP
// requests made (they count against the quota even when they fail);
// queries/failures = searches tried and how many came back empty-handed.
export const adzunaStats = { attempts: 0, queries: 0, failures: 0, lastError: null };

function resetAdzunaRun() {
  adzunaStats.attempts = 0;
  adzunaStats.queries = 0;
  adzunaStats.failures = 0;
  adzunaStats.lastError = null;
}

export async function fetchAdzuna(config) {
  resetAdzunaRun();

  if (!config.adzunaAppId || !config.adzunaApiKey) {
    console.warn('Adzuna credentials not set -- skipping');
    return [];
  }

  console.log(`[adzuna] App ID prefix: ${config.adzunaAppId.slice(0, 4)}...`);

  const queries = buildQueries(config);
  const results = [];

  for (const query of queries) {
    adzunaStats.queries++;
    try {
      const jobs = await searchAdzuna(query, config);
      results.push(...jobs);
      await sleep(500);
    } catch (err) {
      adzunaStats.failures++;
      adzunaStats.lastError = err.message;
      console.error(`Adzuna query failed for "${query.what}" in ${query.country}:`, err.message);
    }
  }

  return results.map(normalizeAdzuna);
}

function buildQueries(config) {
  // Adzuna's `what` param treats spaces as AND, so each target role is sent as its
  // own single-term query (no OR-grouping). Terms come from the user's profile.
  const searchTerms = resolveTargetRoles(config);
  if (!searchTerms.length) {
    console.warn('[adzuna] No target roles configured (set target_roles in config/profile.yml) -- skipping');
    return [];
  }

  const queries = [];
  const supported = Object.keys(BASE_URLS).join('/');

  for (const location of config.locations) {
    // "US", "USA" and " us " all mean the same market; only the ISO code is a
    // key in BASE_URLS. An unsupported country is a real answer to "why did I
    // get nothing?", so it is said out loud rather than skipped in silence.
    const country = normalizeCountry(location.country);
    if (!BASE_URLS[country]) {
      console.warn(`[adzuna] Skipping ${location.city}: country "${location.country}" is not one Adzuna is wired up for here (supported: ${supported}). Fix target_locations in config/profile.yml.`);
      continue;
    }

    for (const term of searchTerms) {
      queries.push({
        what: term,
        where: location.city,
        country,
        distanceKm: Math.round((location.radiusMiles || 20) * 1.6),
      });
    }
  }

  // Credentials are set, roles are set, and still nothing to ask for: that is a
  // scan that will report zero Adzuna jobs for a fixable reason.
  if (queries.length === 0) {
    console.warn(`[adzuna] No searches could be built from your target_locations, so Adzuna will not run this scan. None of your locations are in a country Adzuna is set up for here (${supported}).`);
  }

  return queries;
}

async function searchAdzuna({ what, where, country, distanceKm }, config) {
  const baseUrl = BASE_URLS[country];
  const params = new URLSearchParams({
    app_id: config.adzunaAppId,
    app_key: config.adzunaApiKey,
    results_per_page: '20',
    what,
    where,
    distance: distanceKm.toString(),
    max_days_old: '7',
    sort_by: 'date',
    full_time: '1',
  });

  adzunaStats.attempts++;
  const response = await fetch(`${baseUrl}/1?${params}`);

  if (!response.ok) {
    throw new Error(`Adzuna HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.results || [];
}

function normalizeAdzuna(job) {
  return {
    source: 'adzuna',
    sourceId: job.id,
    title: job.title,
    company: job.company?.display_name,
    location: job.location?.display_name,
    isRemote: job.title?.toLowerCase().includes('remote') ||
              job.description?.toLowerCase().includes('remote') || false,
    description: job.description,
    url: job.redirect_url,
    postedAt: job.created,
    employmentType: job.contract_time,
    salary: {
      min: job.salary_min,
      max: job.salary_max,
      currency: 'local',
      period: 'annual',
    },
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
