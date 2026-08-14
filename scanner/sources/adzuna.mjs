import { resolveTargetRoles, normalizeCountry } from './queryHelpers.mjs';
import { takeQueryWindow } from '../quota.mjs';

const BASE_URLS = {
  us: 'https://api.adzuna.com/v1/api/jobs/us/search',
  gb: 'https://api.adzuna.com/v1/api/jobs/gb/search',
  sg: 'https://api.adzuna.com/v1/api/jobs/sg/search',
};

// Per-run counters, read by index.mjs so quota is recorded from what actually
// went over the wire rather than a pre-computed estimate. attempts = HTTP
// requests made (they count against the quota even when they fail);
// queries/failures = searches tried and how many came back empty-handed.
// `window` is null on a run that searched everything it wanted to; when the run
// was trimmed to fit the monthly budget it carries what was run out of what was
// asked for, which index.mjs turns into the line the user reads.
export const adzunaStats = { attempts: 0, queries: 0, failures: 0, lastError: null, window: null };

function resetAdzunaRun() {
  adzunaStats.attempts = 0;
  adzunaStats.queries = 0;
  adzunaStats.failures = 0;
  adzunaStats.lastError = null;
  adzunaStats.window = null;
}

export async function fetchAdzuna(config) {
  resetAdzunaRun();

  if (!config.adzunaAppId || !config.adzunaApiKey) {
    console.warn('Adzuna credentials not set -- skipping');
    return [];
  }

  console.log(`[adzuna] App ID prefix: ${config.adzunaAppId.slice(0, 4)}...`);

  const queries = await applyRunBudget(buildQueries(config), config.adzunaMaxCallsPerRun);
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

// Trim the run to the calls it is allowed to make, and rotate which searches
// those are.
//
// A typical profile asks for locations × target roles ≈ 28-35 searches. Run
// daily that is ~1,000 Adzuna calls a month against a budget of 250, so the
// whole list can never keep running — and the old answer was to skip Adzuna
// entirely on any run that did not fit, which is how "too many searches" became
// "no jobs from Adzuna at all". Running a window instead means every search
// still gets made, just spread across several runs.
//
// No cap set (a dry run, a direct caller, a test) leaves the list untouched, so
// nothing outside a budgeted scan changes behavior or writes quota state.
async function applyRunBudget(queries, maxCalls) {
  if (!queries.length || !Number.isFinite(maxCalls) || maxCalls >= queries.length) return queries;

  if (maxCalls <= 0) {
    adzunaStats.window = { ran: 0, total: queries.length, runsPerRotation: null };
    console.warn(`[adzuna] No monthly budget left for Adzuna this run — all ${queries.length} searches skipped.`);
    return [];
  }

  const { start, count, runsPerRotation } = await takeQueryWindow('adzuna', queries.length, maxCalls);
  adzunaStats.window = { ran: count, total: queries.length, runsPerRotation };
  console.log(`[adzuna] Running ${count} of ${queries.length} searches this run (positions ${start + 1}-${start + count} in the rotation) — a full pass over every search takes ${runsPerRotation} runs.`);

  // Wraps: the last window of a rotation runs the tail of the list and then the
  // head, so no search is ever stranded at the end.
  return Array.from({ length: count }, (_, i) => queries[(start + i) % queries.length]);
}

// The configured locations Adzuna can actually search: those whose country is
// one of the markets wired up above. Shared by the query builder and the
// per-run count so the estimate and the real list can never disagree.
//
// `warn` is off by default: counting the list must be silent, or every run
// would print the skip warnings twice.
function searchableLocations(config, { warn = false } = {}) {
  const supported = Object.keys(BASE_URLS).join('/');
  const kept = [];
  // Whether any location was actually dropped for its country. Without this we
  // cannot tell "your countries are unsupported" apart from "you listed no
  // locations at all", and the warning in buildQueries would confidently give
  // the wrong diagnosis for the second case.
  let skippedForCountry = false;

  for (const location of config?.locations || []) {
    // "US", "USA" and " us " all mean the same market; only the ISO code is a
    // key in BASE_URLS. An unsupported country is a real answer to "why did I
    // get nothing?", so it is said out loud rather than skipped in silence.
    const country = normalizeCountry(location.country);
    if (!BASE_URLS[country]) {
      skippedForCountry = true;
      if (warn) console.warn(`[adzuna] Skipping ${location.city}: country "${location.country}" is not one Adzuna is wired up for here (supported: ${supported}). Fix target_locations in config/profile.yml.`);
      continue;
    }
    kept.push({ ...location, country });
  }

  return { kept, skippedForCountry };
}

// How many searches this profile asks Adzuna for, without building or sending
// any of them. index.mjs needs the real figure BEFORE the source runs, to size
// the per-run slice and the pre-flight quota projection against. It used to
// guess `locations × 7` — seven being a role count from one person's profile —
// which over-budgeted anyone with fewer roles and under-budgeted anyone with
// more. The real list is roles × searchable locations, counted here from the
// same two functions that build it.
export function adzunaQueryCount(config) {
  return resolveTargetRoles(config).length * searchableLocations(config).kept.length;
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
  const { kept, skippedForCountry } = searchableLocations(config, { warn: true });

  for (const location of kept) {
    for (const term of searchTerms) {
      queries.push({
        what: term,
        where: location.city,
        country: location.country,
        distanceKm: Math.round((location.radiusMiles || 20) * 1.6),
      });
    }
  }

  // Credentials are set, roles are set, and still nothing to ask for: that is a
  // scan that will report zero Adzuna jobs for a fixable reason. Which reason
  // depends on whether anything was actually dropped above — saying "none of
  // your locations are supported" to someone who listed none would send them
  // hunting for a problem that isn't there.
  if (queries.length === 0) {
    const why = skippedForCountry
      ? `None of your locations are in a country Adzuna is set up for here (${supported}).`
      : `No target_locations are configured, so there is nothing for Adzuna to search. Add at least one location in config/profile.yml (Adzuna is set up for ${supported} here).`;
    console.warn(`[adzuna] No searches could be built from your target_locations, so Adzuna will not run this scan. ${why}`);
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
