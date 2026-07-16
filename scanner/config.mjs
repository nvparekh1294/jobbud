// Model strings — referenced by both scoring stages in evaluate.mjs.
// Stage 1 (cheap binary hard filter) uses Haiku; Stage 2 (full rubric scoring,
// prompt-cached) uses Sonnet. Never hardcode these strings inline elsewhere.
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const SONNET_MODEL = 'claude-sonnet-4-6';

// ── Single profile.yml read path ─────────────────────────────────────────────
// This is the ONE place the codebase reads config/profile.yml from the user's
// repo. loadConfig() (below) consumes it to build search/filter config, and
// evaluate.mjs's buildScoringRubric() consumes the raw text for the LLM prompt —
// so there is a single reader, not two copies that can drift apart.

const GITHUB_API_BASE = 'https://api.github.com';

// Fetch a repo file's raw text via the Contents API. Returns null when the file
// is missing or the read fails — callers decide how to fall back. Nothing
// here is specific to any user: it is a plain GitHub file reader.
export async function readGithubFile(githubToken, owner, repo, path) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.content) return Buffer.from(data.content, 'base64').toString('utf8');
  if (data.download_url) {
    const raw = await fetch(data.download_url, { headers: { Authorization: `Bearer ${githubToken}` } });
    return raw.ok ? raw.text() : null;
  }
  return null;
}

// Read the raw config/profile.yml text once. Returns the string, or null when it
// cannot be read (no repo configured, file absent, or a transient error). This is
// the single entry point both loadConfig and buildScoringRubric call.
export async function loadProfileYml(githubToken, owner, repo) {
  if (!githubToken || !owner || !repo) return null;
  try {
    return await readGithubFile(githubToken, owner, repo, 'config/profile.yml');
  } catch (err) {
    console.warn(`[config] Could not load config/profile.yml: ${err.message} — using defaults`);
    return null;
  }
}

// ── Simple line-by-line YAML parser ──────────────────────────────────────────
// Handles the subset of YAML used in config/profile.yml: flat key:value pairs,
// block scalars (|), and simple arrays (  - item). Does not handle nested maps
// except for target_locations, which is parsed separately by parseLocations.
export function parseProfileYml(yaml) {
  if (!yaml) return {};
  const lines = yaml.split('\n');
  const result = {};
  let currentKey = null;
  let inBlockScalar = false;
  let blockLines = [];

  for (const line of lines) {
    // Skip comments and blank lines at top level when not in a block scalar
    if (!inBlockScalar && (line.trimStart().startsWith('#') || line.trim() === '')) continue;

    if (inBlockScalar) {
      // Block scalar ends when we hit a non-indented line (or EOF)
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
        result[currentKey] = blockLines.join('\n').trim();
        blockLines = [];
        inBlockScalar = false;
        // Fall through to process this line normally
      } else {
        blockLines.push(line.replace(/^  /, ''));
        continue;
      }
    }

    // Array item under current key
    if (line.match(/^  - /) && currentKey) {
      const val = line.replace(/^  - /, '').trim();
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(val);
      continue;
    }

    // Key: value or Key: |
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
    if (kvMatch) {
      // Flush any pending block scalar (shouldn't happen but be safe)
      if (inBlockScalar) {
        result[currentKey] = blockLines.join('\n').trim();
        blockLines = [];
        inBlockScalar = false;
      }
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '|') {
        inBlockScalar = true;
        blockLines = [];
      } else if (val !== '') {
        // Inline value — coerce booleans and numbers
        if (val === 'true') result[currentKey] = true;
        else if (val === 'false') result[currentKey] = false;
        else if (/^\d+$/.test(val)) result[currentKey] = Number(val);
        else result[currentKey] = val.replace(/^['"]|['"]$/g, '');
      }
    }
  }
  // Flush trailing block scalar
  if (inBlockScalar && currentKey) result[currentKey] = blockLines.join('\n').trim();
  return result;
}

// Parse target_locations from the raw YAML string (a nested map array). Returns
// null when no locations are declared, so callers fall back to a generic default.
export function parseLocations(yaml) {
  if (!yaml) return null;
  const results = [];
  const blocks = yaml.split(/\n(?=  - city:)/);
  for (const block of blocks) {
    const city    = (block.match(/city:\s*(.+)/))?.[1]?.trim();
    const region  = (block.match(/region:\s*(.+)/))?.[1]?.trim();
    const country = (block.match(/country:\s*(.+)/))?.[1]?.trim();
    const radius  = (block.match(/radius_miles:\s*(\d+)/))?.[1];
    if (city && country) {
      results.push({
        city,
        region: (!region || region === 'null') ? null : region,
        country,
        radiusMiles: radius ? Number(radius) : 20,
      });
    }
  }
  return results.length ? results : null;
}

// ── Config ───────────────────────────────────────────────────────────────────
// loadConfig reads config/profile.yml (when a repo is passed) and layers the
// user's declared preferences over GENERIC defaults. The defaults are deliberately
// neutral — no individual's cities, target roles, comp floor, or industry stances
// are baked in. A user's real preferences live only in their own (gitignored)
// config/profile.yml, which the scanner reads at runtime.
export async function loadConfig(githubToken, owner, repo) {
  const rawYaml = await loadProfileYml(githubToken, owner, repo);
  const profile = rawYaml ? parseProfileYml(rawYaml) : {};
  const profileLocations = rawYaml ? parseLocations(rawYaml) : null;

  // Generic default markets — a neutral starting point so the API sources have
  // somewhere to search out of the box. Override entirely by declaring
  // `target_locations` in config/profile.yml.
  const DEFAULT_LOCATIONS = [
    { city: 'New York', region: 'NY', country: 'us', radiusMiles: 25 },
    { city: 'San Francisco', region: 'CA', country: 'us', radiusMiles: 25 },
  ];

  // Generic seniority exclusions — junior titles most senior searches skip.
  // Not specific to anyone. Override with `exclude_titles` in config/profile.yml.
  const DEFAULT_EXCLUDE_TITLES = [
    'coordinator', 'assistant', 'intern', 'junior', 'entry level',
  ];

  // Generic ethical exclusions — override with `deal_breaker_industries`.
  const DEFAULT_DEAL_BREAKER_INDUSTRIES = [
    'gambling', 'casino', 'tobacco', 'payday loan', 'weapons',
  ];

  // Profile arrays replace the generic default when present (the structured
  // schema: target_roles / exclude_titles / deal_breaker_* / min_salary /
  // target_locations). When a profile field is absent, the generic default holds.
  const targetRoles = Array.isArray(profile.target_roles) && profile.target_roles.length
    ? profile.target_roles
    : null;
  const excludeTitles = Array.isArray(profile.exclude_titles) && profile.exclude_titles.length
    ? profile.exclude_titles
    : DEFAULT_EXCLUDE_TITLES;
  const dealBreakerIndustries = Array.isArray(profile.deal_breaker_industries) && profile.deal_breaker_industries.length
    ? profile.deal_breaker_industries
    : DEFAULT_DEAL_BREAKER_INDUSTRIES;
  const dealBreakerKeywords = Array.isArray(profile.deal_breaker_keywords) && profile.deal_breaker_keywords.length
    ? profile.deal_breaker_keywords
    : [];

  if (profile.name) console.log('[config] Loaded config/profile.yml');

  return {
    // Positive keyword gate. Empty by default so the tool does not silently filter
    // for any preset role family — the profile's target_roles opt into it, and the
    // LLM stages judge relevance. See filter.mjs (the gate is skipped when empty).
    requiredTitleKeywords: targetRoles || [],

    locations: profileLocations || DEFAULT_LOCATIONS,

    includeRemote: typeof profile.include_remote === 'boolean' ? profile.include_remote : true,

    excludeTitleKeywords: excludeTitles,

    dealBreakerIndustries,
    dealBreakerKeywords,

    // Comp floor: profile value or 0 (no comp filter). No figure is hardcoded.
    minSalary: typeof profile.min_salary === 'number' ? profile.min_salary : 0,
    minCompanySize: 0,
    maxTravelPercent: null,

    targetCompanyStages: [
      'Series A', 'Series B', 'Series C', 'Series D', 'Series E',
      'late stage', 'growth stage', 'public', 'pre-IPO',
    ],

    minScoreToIncludeInDigest: 3.0,
    maxJobsPerDigest: 20,
    maxJobsToEvaluate: Number(process.env.MAX_JOBS_TO_EVALUATE) || 50, // Stage 2 ceiling: max jobs sent to the Sonnet scorer per run, across BOTH portal and API sources. Stage 1 (Haiku) runs on all candidates uncapped. If more than this pass Stage 1, the lowest-Stage-1-confidence passers are deferred (stay scored:false in seen-jobs.json) and retried next run. Override via MAX_JOBS_TO_EVALUATE env (the weekly API-only workflow sets it to 250).
    scanFrequencyHours: 4,
    backfillMode: false,

    recipientEmail: process.env.NOTIFICATION_EMAIL || '',

    jsearchApiKey: process.env.JSEARCH_API_KEY,
    adzunaAppId: process.env.ADZUNA_APP_ID,
    adzunaApiKey: process.env.ADZUNA_API_KEY,
    serpApiKey: process.env.SERP_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY || null,
    sendgridApiKey: process.env.SENDGRID_API_KEY,

    seenJobsPath: './data/seen-jobs.json',
    companyCachePath: './data/company-cache.json',
  };
}
