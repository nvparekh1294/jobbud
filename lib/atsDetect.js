// Deterministic ATS detection from a company careers URL.
//
// Onboarding asks the user for target companies + their careers page URLs and
// builds a personalized scanner/portals.yml. Each portals entry needs to know
// which ATS the company runs on so the scanner (scanner/portalScanner.mjs) knows
// which fetcher to use. This module derives that from the URL alone — pure
// hostname/path parsing, no network call and no LLM — so it is safe to run in an
// API route (api/coach.js) on every onboarding submission.
//
// It is a plain imported module (like lib/github.js), NOT an API route.
//
// Returns the shape the scanner expects per ATS:
//   greenhouse | ashby | lever  →  { ats, ats_id, careers_url }
//   workday                      →  { ats, workday_tenant, workday_site, careers_url }
//   custom (anything unrecognised) → { ats: 'custom', careers_url }

// Ensure the URL has a scheme so `new URL()` can parse a bare host like
// "jobs.lever.co/acme". Also trims surrounding whitespace. Returns '' for
// empty/nullish input so callers can fall through to the custom branch.
function withScheme(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// First non-empty path segment. For "/en-US/Site/" → 'en-US'; for "/acme" → 'acme'.
function pathSegments(pathname) {
  return pathname.split('/').filter(Boolean);
}

// A Workday careers path is /<locale?>/<site>. The locale (e.g. en-US) is
// optional — detect it so we don't mistake it for the site id.
function looksLikeLocale(segment) {
  return /^[a-z]{2}-[A-Za-z]{2}$/.test(segment);
}

/**
 * Detect the ATS for a company careers URL.
 *
 * Deterministic — parses the hostname and path only. Tolerant of missing scheme,
 * trailing slashes, query strings, and http vs https. Anything it does not
 * recognise falls back to `custom`, which the scanner best-effort scrapes.
 *
 * @param {string} careersUrl — e.g. "https://jobs.ashbyhq.com/acme?utm=x"
 * @returns {{ ats: string, ats_id?: string, workday_tenant?: string, workday_site?: string, careers_url: string }}
 */
export function detectAts(careersUrl) {
  const normalized = withScheme(careersUrl);
  if (!normalized) {
    return { ats: 'custom', careers_url: '' };
  }

  let url;
  try {
    url = new URL(normalized);
  } catch {
    // Unparseable — treat as a custom page and hand the raw string to the scanner.
    return { ats: 'custom', careers_url: normalized };
  }

  const host = url.hostname.toLowerCase();
  const segments = pathSegments(url.pathname);
  const careers_url = normalized;

  // ── Ashby: jobs.ashbyhq.com/<slug> ─────────────────────────────────────────
  if (host === 'jobs.ashbyhq.com' && segments[0]) {
    return { ats: 'ashby', ats_id: segments[0], careers_url };
  }

  // ── Greenhouse: boards.greenhouse.io/<slug> and job-boards.greenhouse.io/<slug>.
  // Also accept the boards-api.greenhouse.io/v1/boards/<slug>/jobs REST form the
  // starter portals.yml uses, so the refresh path can re-parse an existing file.
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    // Embed form: boards.greenhouse.io/embed/job_board?for=<slug> — the path
    // segment is 'embed', not the board slug. The scanner's boards-api call would
    // 404 on ats_id 'embed', so pull the slug from the `for` query param instead.
    // Without it there is no usable board id → fall through to the custom scrape.
    if (segments[0] === 'embed') {
      const forSlug = url.searchParams.get('for');
      if (forSlug) return { ats: 'greenhouse', ats_id: forSlug, careers_url };
      return { ats: 'custom', careers_url };
    }
    if (segments[0]) return { ats: 'greenhouse', ats_id: segments[0], careers_url };
  }
  if (host === 'boards-api.greenhouse.io') {
    // /v1/boards/<slug>/jobs → slug is the 3rd segment.
    const slug = segments[0] === 'v1' && segments[1] === 'boards' ? segments[2] : segments[0];
    if (slug) return { ats: 'greenhouse', ats_id: slug, careers_url };
  }

  // ── Lever: jobs.lever.co/<slug> ────────────────────────────────────────────
  if (host === 'jobs.lever.co' && segments[0]) {
    return { ats: 'lever', ats_id: segments[0], careers_url };
  }

  // ── Workday: <tenant>.wd<N>.myworkdayjobs.com/<locale?>/<site> ─────────────
  const workdayMatch = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (workdayMatch) {
    const workday_tenant = workdayMatch[1];
    // Skip a leading locale segment (en-US, fr-FR, …) if present; the site id is
    // whatever remains.
    const siteSegments = segments.length && looksLikeLocale(segments[0])
      ? segments.slice(1)
      : segments;
    const workday_site = siteSegments[0];
    if (workday_tenant && workday_site) {
      return { ats: 'workday', workday_tenant, workday_site, careers_url };
    }
  }

  // ── Anything else: custom best-effort scrape ───────────────────────────────
  return { ats: 'custom', careers_url };
}
