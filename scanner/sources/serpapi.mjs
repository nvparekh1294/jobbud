/**
 * SerpAPI client - Google Jobs search
 * Captures Google-indexed listings including LinkedIn, Greenhouse, Lever, Ashby, Workday
 * Free tier: 100 searches/month
 * Docs: https://serpapi.com/google-jobs-api
 */

import { resolveTargetRoles, buildRoleGroups, serpApiLocationString } from './queryHelpers.mjs';

const BASE_URL = 'https://serpapi.com/search.json';

export async function checkSerpApiBalance(apiKey) {
  if (!apiKey) return 0;
  const res = await fetch(`https://serpapi.com/account.json?api_key=${apiKey}`);
  if (!res.ok) throw new Error(`SerpAPI account check failed: ${res.status}`);
  const data = await res.json();
  const remaining = data.total_searches_left ?? 0;
  console.log(`[serpapi] Live balance: ${remaining} searches remaining`);
  return remaining;
}

export async function fetchSerpApi(config) {
  if (!config.serpApiKey) {
    console.warn('SerpAPI key not set -- skipping');
    return [];
  }

  const queries = buildQueries(config);
  const results = [];

  for (const query of queries) {
    try {
      const jobs = await searchSerpApi(query, config.serpApiKey);
      results.push(...jobs);
      await sleep(500);
    } catch (err) {
      console.error(`SerpAPI query failed for "${query.q}":`, err.message);
    }
  }

  return results.map(normalizeSerpApi);
}

function buildQueries(config) {
  const roles = resolveTargetRoles(config);
  if (!roles.length) {
    console.warn('[serpapi] No target roles configured (set target_roles in config/profile.yml) -- skipping');
    return [];
  }

  const roleGroups = buildRoleGroups(roles);
  const queries = [];

  for (const location of config.locations) {
    const locationStr = serpApiLocationString(location);
    if (!locationStr) continue;
    for (const roleGroup of roleGroups) {
      queries.push({
        q: roleGroup,
        location: locationStr,
        chips: 'date_posted:week',
      });
    }
  }

  if (config.includeRemote) {
    for (const roleGroup of roleGroups) {
      queries.push({
        q: roleGroup,
        chips: 'date_posted:week,work_from_home:1',
      });
    }
  }

  return queries;
}

async function searchSerpApi(query, apiKey) {
  const params = new URLSearchParams({
    engine: 'google_jobs',
    api_key: apiKey,
    ...query,
  });

  const response = await fetch(`${BASE_URL}?${params}`);

  if (!response.ok) {
    throw new Error(`SerpAPI HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.jobs_results || [];
}

function resolveJobUrl(job) {
  // 1st choice: direct application link
  const applyLink = job.apply_options?.[0]?.link;
  if (applyLink) return applyLink;

  // 2nd choice: company career page from related links
  const relatedLink = job.related_links?.[0]?.link;
  if (relatedLink) return relatedLink;

  // 3rd choice: share_link only if it's a real direct URL (not a Google search/jobs redirect)
  const shareLink = job.share_link;
  if (
    shareLink &&
    shareLink.startsWith('http') &&
    !shareLink.includes('google.com/search') &&
    !shareLink.includes('google.com/jobs')
  ) {
    return shareLink;
  }

  return null;
}

function normalizeSerpApi(job) {
  const ext = job.detected_extensions || {};
  return {
    source: 'serpapi',
    sourceId: job.job_id,
    title: job.title,
    company: job.company_name,
    location: job.location,
    isRemote: job.location?.toLowerCase().includes('remote') ||
              ext.work_from_home || false,
    description: job.description,
    url: resolveJobUrl(job),
    postedAt: ext.posted_at,
    employmentType: ext.schedule_type,
    salary: {
      min: null,
      max: null,
      currency: null,
      period: null,
    },
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
