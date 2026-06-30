/**
 * portalScanner.mjs
 *
 * Directly monitors target company career pages using web fetch (no Playwright).
 * Returns jobs in the same normalized format as jsearch.mjs / adzuna.mjs so they
 * flow straight into the existing dedup → filter → evaluate pipeline.
 *
 * ATS support:
 *   greenhouse  →  boards-api.greenhouse.io REST API (JSON)
 *   ashby       →  jobs.ashbyhq.com HTML + __NEXT_DATA__ extraction (includes descriptions)
 *   lever       →  api.lever.co REST API (JSON, includes descriptions)
 *   workday     →  myworkdayjobs.com REST API (POST, JSON)
 *   custom      →  best-effort HTML scrape; portals tagged jsRendered: true are
 *                  fetched via Firecrawl and extracted with Claude Haiku
 *
 * Portal jobs are tagged source:'portal' — preFilter skips the description-length check
 * for these so they aren't silently dropped when descriptions aren't available.
 */

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { isJobClosed } from './filter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = path.join(__dirname, 'portals.yml');

const GREENHOUSE_API = 'https://boards-api.greenhouse.io/v1/boards';
const ASHBY_BOARD    = 'https://jobs.ashbyhq.com';
const LEVER_API      = 'https://api.lever.co/v0/postings';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const REQUEST_DELAY_MS = 800;   // polite delay between companies
const FETCH_TIMEOUT_MS = 12000; // abort if a single fetch takes too long

const USER_AGENT = 'JobBud-Scanner/1.0 (personal job search tool)';

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchPortals() {
  let companies;
  try {
    const raw = await fs.readFile(PORTALS_PATH, 'utf8');
    companies = parseYaml(raw).companies || [];
  } catch (err) {
    console.error('[portals] Failed to load portals.yml:', err.message);
    return [];
  }
  return scanCompanies(companies, { label: 'portals' });
}

/**
 * Scan an array of portals.yml-shaped company configs and return normalized jobs.
 *
 * Extracted from fetchPortals so other sources (e.g. the Company Radar in
 * data/radar.json — see scanner/radarSource.mjs) can reuse the exact same ATS
 * fetch + normalize logic without re-reading portals.yml. Each company object
 * must have at least { name, ats } and the ATS-specific id fields (ats_id, or
 * workday_tenant/workday_site). Stealth companies and the shared Playwright
 * browser are handled here so every caller behaves identically.
 *
 * @param {Array<object>} companies — raw company configs (stealth entries allowed; filtered out here)
 * @param {{ label?: string }} [opts] — label used only in log lines ('portals' | 'radar')
 */
export async function scanCompanies(companies, { label = 'portals' } = {}) {
  if (!Array.isArray(companies) || companies.length === 0) return [];

  const active = companies.filter(c => !c.stealth);
  console.log(`[${label}] Scanning ${active.length} companies (${companies.length - active.length} stealth skipped)...`);

  const allJobs = [];

  for (const company of active) {
    try {
      const jobs = await fetchCompany(company);
      if (jobs.length > 0) {
        console.log(`  [${label}] ${company.name}: ${jobs.length} job(s)`);
      } else {
        console.log(`  [${label}] ${company.name}: 0 jobs`);
      }
      allJobs.push(...jobs);
    } catch (err) {
      console.warn(`  [${label}] ${company.name} failed: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`[${label}] Total: ${allJobs.length} jobs across ${active.length} companies`);
  return allJobs;
}

// ── ATS Router ────────────────────────────────────────────────────────────────

async function fetchCompany(company) {
  let jobs;
  const timeoutMs = FETCH_TIMEOUT_MS;
  switch (company.ats) {
    case 'greenhouse': jobs = await fetchGreenhouse(company, timeoutMs); break;
    case 'ashby':      jobs = await fetchAshby(company, timeoutMs); break;
    case 'lever':      jobs = await fetchLever(company, timeoutMs); break;
    case 'workday':    jobs = await fetchWorkday(company, timeoutMs); break;
    case 'custom':     jobs = await fetchCustom(company, timeoutMs); break;
    default:
      console.warn(`  [portals] Unknown ATS '${company.ats}' for ${company.name}`);
      return [];
  }

  // Drop postings that are no longer accepting applications
  return jobs.filter(j => {
    if (isJobClosed(j.title, j.description)) {
      console.log(`  [portals] Skipping ${j.company} — ${j.title}: no longer accepting applications`);
      return false;
    }
    return true;
  });
}

// ── Greenhouse ────────────────────────────────────────────────────────────────
// API: GET https://boards-api.greenhouse.io/v1/boards/{id}/jobs
// Response: { jobs: [{ id, title, absolute_url, location: { name }, updated_at }] }
// Note: descriptions are NOT included in the listing endpoint; fetching per-job
// would require N additional requests. We skip it — preFilter allows portal jobs
// without descriptions.

async function fetchGreenhouse(company, timeoutMs = FETCH_TIMEOUT_MS) {
  const url = `${GREENHOUSE_API}/${company.ats_id}/jobs`;
  const data = await fetchJson(url, timeoutMs);
  const jobs = data.jobs || [];

  return jobs
    .filter(j => matchesKeywords(j.title, company.keywords))
    .map(j => normalizeJob({
      id:          String(j.id),
      title:       j.title,
      location:    j.location?.name || '',
      url:         j.absolute_url,
      postedAt:    j.updated_at || null,
      description: '',   // Greenhouse listing API doesn't include descriptions
    }, company));
}

// ── Ashby ─────────────────────────────────────────────────────────────────────
// Ashby migrated away from Next.js in 2025. Their pages now embed job data in
// window.__appData.jobBoard.jobPostings inside a single large inline script.
// We support both the new format and the old __NEXT_DATA__ format as a fallback.
// Listings do not include descriptionHtml — preFilter skips the description-length
// check for portal-sourced jobs so they aren't dropped.

async function fetchAshby(company, timeoutMs = FETCH_TIMEOUT_MS) {
  const url = `${ASHBY_BOARD}/${company.ats_id}`;
  const html = await fetchHtml(url, timeoutMs);

  let postings = [];

  // ── Format 1 (current): window.__appData.jobBoard.jobPostings ──────────────
  const appDataMarker = 'window.__appData = ';
  const appDataStart  = html.indexOf(appDataMarker);

  if (appDataStart !== -1) {
    try {
      const jsonStart = appDataStart + appDataMarker.length;
      const jsonStr   = extractJsonObject(html, jsonStart);
      const appData   = JSON.parse(jsonStr);
      postings = appData?.jobBoard?.jobPostings || [];
    } catch (err) {
      console.warn(`    ↳ window.__appData parse failed: ${err.message} — trying __NEXT_DATA__`);
    }
  }

  // ── Format 2 (legacy): __NEXT_DATA__ ─────────────────────────────────────
  if (postings.length === 0) {
    const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (ndMatch) {
      try {
        const nd       = JSON.parse(ndMatch[1]);
        const pp       = nd?.props?.pageProps || {};
        postings =
          pp.jobPostings ||
          pp.initialData?.jobPostings ||
          pp.dehydratedState?.queries?.flatMap(q => q?.state?.data?.jobPostings || []) ||
          [];
      } catch { /* ignore */ }
    }
  }

  if (postings.length === 0 && !html.includes('jobPostings')) {
    throw new Error('No job data found — Ashby board may be empty or structure changed');
  }

  // Filter first — only fetch descriptions for jobs that will actually be included.
  const matched = postings
    .filter(j => j.isListed !== false)
    .filter(j => matchesKeywords(j.title, company.keywords));

  if (matched.length === 0) return [];

  // Fetch full descriptions from the Ashby detail endpoint, 3 at a time.
  // Each fetch times out at 8s independently; failures fall back to ''.
  console.log(`  [ashby] ${company.name}: fetching descriptions for ${matched.length} matched jobs`);
  const ASHBY_DETAIL = 'https://api.ashbyhq.com/posting-api/job-board';

  async function fetchDesc(jobId) {
    if (!jobId) return '';
    try {
      const res = await fetchWithTimeout(
        `${ASHBY_DETAIL}/${company.ats_id}/posting/${jobId}`,
        {},
        8000
      );
      if (!res.ok) return '';
      const data = await res.json();
      return data.descriptionHtml || data.description || '';
    } catch {
      return '';
    }
  }

  const descriptions = [];
  for (let i = 0; i < matched.length; i += 3) {
    const chunk = matched.slice(i, i + 3);
    const results = await Promise.all(chunk.map(j => fetchDesc(j.id || j.slug || null)));
    descriptions.push(...results);
  }

  return matched.map((j, idx) => normalizeJob({
    id:             j.id || j.slug || j.title,
    title:          j.title,
    location:       j.locationName || j.location || j.primaryLocation?.locationName || '',
    isRemote:       j.workplaceType === 'Remote' || j.isRemote || false,
    url:            `${ASHBY_BOARD}/${company.ats_id}/${j.id}`,
    postedAt:       j.publishedDate || j.publishedAt || j.updatedAt || null,
    description:    stripHtml(descriptions[idx] || j.descriptionHtml || j.description || ''),
    employmentType: j.employmentType || null,
  }, company));
}

/**
 * Walk forward from jsonStart tracking bracket depth to extract a complete JSON object.
 * More reliable than a greedy regex for large nested objects.
 */
function extractJsonObject(str, start) {
  let depth = 0;
  let inStr  = false;
  let esc    = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (esc)             { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true;  continue; }
    if (ch === '"')            { inStr = !inStr; continue; }
    if (inStr)                 { continue; }
    if (ch === '{')            { depth++; }
    else if (ch === '}')       { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  throw new Error('Unterminated JSON object');
}

// ── Lever ─────────────────────────────────────────────────────────────────────
// API: GET https://api.lever.co/v0/postings/{id}?mode=json
// Response includes full description HTML — strip to plain text.

async function fetchLever(company, timeoutMs = FETCH_TIMEOUT_MS) {
  const url = `${LEVER_API}/${company.ats_id}?mode=json`;
  const data = await fetchJson(url, timeoutMs);
  if (!Array.isArray(data)) throw new Error('Lever response was not an array');

  return data
    .filter(j => matchesKeywords(j.text, company.keywords))
    .map(j => {
      // Lever gives description + lists (sections like Requirements, Benefits)
      const descParts = [
        stripHtml(j.description || ''),
        ...(j.lists || []).map(l => `${l.text}:\n${stripHtml(l.content || '')}`),
        stripHtml(j.additional || ''),
      ].filter(Boolean);

      return normalizeJob({
        id:           j.id,
        title:        j.text,
        location:     j.categories?.location || j.categories?.allLocations?.[0] || '',
        isRemote:     /remote/i.test(j.categories?.location || ''),
        url:          j.hostedUrl,
        postedAt:     j.createdAt ? new Date(j.createdAt).toISOString() : null,
        description:  descParts.join('\n\n'),
        employmentType: j.categories?.commitment || null,
        team:         j.categories?.team || j.categories?.department || null,
        level:        j.categories?.level || null,
        tags:         Array.isArray(j.tags) ? j.tags.filter(t => typeof t === 'string') : [],
        workplaceType: j.workplaceType || null,
        salaryRange:  j.salaryRange || j.compensation || null,
      }, company);
    });
}

// ── Workday ───────────────────────────────────────────────────────────────────
// Workday exposes a REST API at /{tenant}.wd5.myworkdayjobs.com/wday/cxs/...
// We search with keyword filter to avoid returning thousands of unrelated jobs.

async function fetchWorkday(company, timeoutMs = FETCH_TIMEOUT_MS) {
  if (!company.workday_tenant || !company.workday_site) {
    throw new Error('Workday company is missing workday_tenant or workday_site in portals.yml');
  }

  const url = `https://${company.workday_tenant}.wd5.myworkdayjobs.com/wday/cxs/${company.workday_tenant}/${company.workday_site}/jobs`;

  // If keywords are defined, search for them; otherwise return first page of all roles
  const searchText = (company.keywords || []).slice(0, 3).join(' OR ');

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      appliedFacets: {},
      limit: 20,
      offset: 0,
      searchText: searchText || '',
    }),
  }, timeoutMs);

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobPostings || [];

  return jobs
    .filter(j => matchesKeywords(j.title, company.keywords))
    .map(j => normalizeJob({
      id:       j.externalPath || j.title,
      title:    j.title,
      location: j.locationsText || '',
      url:      j.externalPath
        ? `https://${company.workday_tenant}.wd5.myworkdayjobs.com${j.externalPath}`
        : null,
      postedAt: j.postedOn || null,
    }, company));
}

// ── Custom (best-effort HTML scrape) ─────────────────────────────────────────
// Plain custom companies are fetched with a normal HTTP request. Companies marked
// jsRendered: true (Meta, Google, Microsoft, etc.) render their listings client-side
// and return nothing useful to a plain fetch, so those are fetched via Firecrawl
// (which handles JS rendering) and then extracted with Claude Haiku.

async function fetchCustom(company, timeoutMs = FETCH_TIMEOUT_MS) {
  if (!company.careers_url) return [];

  let html;
  if (company.jsRendered) {
    const { firecrawlApiKey, anthropicApiKey } = await import('./config.mjs')
      .then(m => m.loadConfig());

    if (!firecrawlApiKey) {
      console.log(`    ↳ ${company.name}: FIRECRAWL_API_KEY not set — skipping JS-rendered portal`);
      return [];
    }

    try {
      const markdown = await fetchWithFirecrawl(company.careers_url, firecrawlApiKey);
      const extracted = await extractJobsWithHaiku(markdown, company, anthropicApiKey);

      if (extracted.length === 0) {
        console.log(`    ↳ ${company.name}: Firecrawl+Haiku returned 0 job listings`);
        return [];
      }

      const jobs = [];
      for (const item of extracted) {
        if (!item.title || typeof item.title !== 'string') continue;
        const fullUrl = item.url
          ? (item.url.startsWith('http') ? item.url : new URL(item.url, company.careers_url).href)
          : company.careers_url;
        if (!matchesKeywords(item.title, company.keywords)) continue;
        jobs.push(normalizeJob({
          title: item.title,
          location: item.location || '',
          url: fullUrl
        }, company));
      }

      console.log(`    ↳ ${company.name}: Firecrawl+Haiku found ${jobs.length} matching jobs`);
      return jobs;

    } catch (err) {
      console.warn(`    ↳ ${company.name}: Firecrawl failed: ${err.message} — skipping`);
      return [];
    }
  } else {
    try {
      html = await fetchHtml(company.careers_url, timeoutMs);
    } catch (err) {
      throw new Error(`Fetch failed: ${err.message}`);
    }
  }

  const jobs = [];
  const seen = new Set();

  // Pattern 1: <a href="/jobs/12345">Senior Engineer</a>
  const linkPattern = /<a\s[^>]*href="([^"#]+)"[^>]*>\s*([^<]{4,120})\s*<\/a>/gi;
  let m;

  while ((m = linkPattern.exec(html)) !== null) {
    const href  = m[1].trim();
    const text  = m[2].replace(/\s+/g, ' ').trim();

    if (seen.has(href)) continue;
    if (text.length < 4 || text.length > 140) continue;

    // Skip clearly navigational links
    if (/^(home|about|team|blog|press|news|contact|sign in|log in|back|menu|view all)$/i.test(text)) continue;

    // Skip if it doesn't look like a job link
    const looksLikeJobLink = /jobs?|careers?|openings?|position|role|requisition/i.test(href);
    if (!looksLikeJobLink) continue;

    if (!matchesKeywords(text, company.keywords)) continue;

    seen.add(href);
    const fullUrl = href.startsWith('http') ? href : new URL(href, company.careers_url).href;

    jobs.push(normalizeJob({ title: text, location: '', url: fullUrl }, company));
  }

  if (jobs.length === 0) {
    console.log(`    ↳ ${company.name}: custom scrape returned 0 jobs`);
  }

  return jobs;
}

// ── Normalization ─────────────────────────────────────────────────────────────

function normalizeJob(raw, company) {
  const location = raw.location || '';
  return {
    source:         'portal',
    sourceId:       `portal::${company.ats_id || company.name}::${raw.id || raw.title}`,
    title:          (raw.title || '').trim(),
    company:        company.name,
    location:       location.trim(),
    isRemote:       raw.isRemote ?? /\bremote\b/i.test(location),
    description:    (raw.description || '').trim(),
    url:            raw.url || null,
    postedAt:       raw.postedAt || null,
    employmentType: raw.employmentType || null,
    salary:         null,
    portalCategory: company.category || null,
    team:           raw.team          || null,
    level:          raw.level         || null,
    tags:           raw.tags          || [],
    workplaceType:  raw.workplaceType || null,
    salaryRange:    raw.salaryRange   || null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesKeywords(text, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const lower = (text || '').toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await fetchWithTimeout(url, {}, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchHtml(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await fetchWithTimeout(url, {
    headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
  }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// ── Firecrawl + Haiku (JS-rendered portals) ───────────────────────────────────

async function fetchWithFirecrawl(url, apiKey) {
  const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url,
      formats: ['markdown']
    }),
    signal: AbortSignal.timeout(45000)
  });

  if (!response.ok) {
    throw new Error(`Firecrawl error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.success || !data.data?.markdown) {
    throw new Error('Firecrawl returned no markdown content');
  }

  return data.data.markdown;
}

async function extractJobsWithHaiku(markdown, company, apiKey) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1000,
    system: `You are a job listing extractor. Extract all job listings from the provided careers page content. Return ONLY a valid JSON array with no preamble, no markdown fences, no explanation. Each item must have these fields: title (string), url (string or null), location (string, use empty string if not shown). If no job listings are found, return an empty array [].`,
    messages: [{
      role: 'user',
      content: `Extract job listings from this careers page for ${company.name}.\n\n${markdown.slice(0, 12000)}`
    }]
  });

  const text = response.content[0]?.text?.trim() || '[]';
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`    ↳ ${company.name}: Haiku extraction parse failed — returning []`);
    return [];
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
