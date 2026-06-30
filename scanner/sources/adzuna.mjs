const BASE_URLS = {
  us: 'https://api.adzuna.com/v1/api/jobs/us/search',
  gb: 'https://api.adzuna.com/v1/api/jobs/gb/search',
  sg: 'https://api.adzuna.com/v1/api/jobs/sg/search',
};

export async function fetchAdzuna(config) {
  if (!config.adzunaAppId || !config.adzunaApiKey) {
    console.warn('Adzuna credentials not set -- skipping');
    return [];
  }

  console.log(`[adzuna] App ID prefix: ${config.adzunaAppId.slice(0, 4)}...`);

  const queries = buildQueries(config);
  const results = [];

  for (const query of queries) {
    try {
      const jobs = await searchAdzuna(query, config);
      results.push(...jobs);
      await sleep(500);
    } catch (err) {
      console.error(`Adzuna query failed for "${query.what}" in ${query.country}:`, err.message);
    }
  }

  return results.map(normalizeAdzuna);
}

function buildQueries(config) {
  const queries = [];

  const searchTerms = [
    'business operations',
    'chief of staff',
    'strategy operations',
    'head of operations',
    'strategic finance',
    'corporate development',
    'investment principal',
  ];

  for (const location of config.locations) {
    const country = location.country;
    if (!BASE_URLS[country]) continue;

    for (const term of searchTerms) {
      queries.push({
        what: term,
        where: location.city,
        country,
        distanceKm: Math.round((location.radiusMiles || 20) * 1.6),
      });
    }
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
