const BASE_URL = 'https://jsearch.p.rapidapi.com/search';

export async function fetchJSearch(config) {
  if (!config.jsearchApiKey) {
    console.warn('JSearch API key not set -- skipping');
    return [];
  }

  const queries = buildQueries(config);
  const results = [];

  for (const query of queries) {
    try {
      const jobs = await searchJSearch(query, config.jsearchApiKey);
      results.push(...jobs);
      await sleep(500);
    } catch (err) {
      console.error(`JSearch query failed for "${query}":`, err.message);
    }
  }

  return results.map(normalizeJSearch);
}

function buildQueries(config) {
  const queries = [];

  const roleGroups = [
    'business operations OR biz ops OR chief of staff OR head of operations',
    'strategy operations OR special projects OR strategic finance OR corporate development',
    'COO OR chief operating officer OR growth operations',
    'investment partner OR investment principal OR venture partner',
  ];

  for (const location of config.locations) {
    for (const roleGroup of roleGroups) {
      queries.push(`${roleGroup} in ${location.city}`);
    }
  }

  if (config.includeRemote) {
    queries.push('business operations OR chief of staff OR strategy operations remote');
    queries.push('COO OR strategic finance OR corporate development remote');
  }

  return queries;
}

async function searchJSearch(query, apiKey) {
  const params = new URLSearchParams({
    query,
    page: '1',
    num_pages: '1',
    date_posted: 'week',
  });

  const response = await fetch(`${BASE_URL}?${params}`, {
    headers: {
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
  });

  if (!response.ok) {
    throw new Error(`JSearch HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.data || [];
}

function normalizeJSearch(job) {
  return {
    source: 'jsearch',
    sourceId: job.job_id,
    title: job.job_title,
    company: job.employer_name,
    location: [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', '),
    isRemote: job.job_is_remote || false,
    description: job.job_description,
    url: job.job_apply_link || null,
    postedAt: job.job_posted_at_datetime_utc,
    employmentType: job.job_employment_type,
    salary: {
      min: job.job_min_salary,
      max: job.job_max_salary,
      currency: job.job_salary_currency,
      period: job.job_salary_period,
    },
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
