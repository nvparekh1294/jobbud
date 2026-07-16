// Vercel serverless function — fetches a company website and extracts basic
// details (company name, description, location) to pre-fill the Add Company modal
// in the Radar feature. Best-effort: any field that can't be found comes back as
// null, and a single missing field never fails the whole request.
//
// Auth: X-Dashboard-Password header (same check as api/jobs.js).
//
// Note: this uses the global fetch built into the Node 18+ Vercel runtime with a
// realistic browser User-Agent. The codebase has no node-fetch dependency and
// every other endpoint (add-job.js, action.js, outreach.js) uses global fetch the
// same way, so we stay consistent rather than add a package.

// ── HTML extraction helpers ──────────────────────────────────────────────────

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Read a <meta name=...> or <meta property=...> content value (attribute order
// agnostic), same approach as add-job.js extractFromMeta.
function metaContent(html, prop) {
  const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${prop}["'][^>]+content=["']([^"']*?)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+(?:name|property)=["']${prop}["']`, 'i'));
  return m ? stripHtml(m[1]) : '';
}

function extractCompany(html) {
  const og = metaContent(html, 'og:title');
  if (og) return og;
  const siteName = metaContent(html, 'og:site_name');
  if (siteName) return siteName;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = stripHtml(h1[1]);
    if (t) return t;
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    // Trim common "Page | Company" / "Company - tagline" suffixes to the first segment.
    const t = stripHtml(titleTag[1]).split(/[|–—\-]/)[0].trim();
    if (t) return t;
  }
  return null;
}

function extractDescription(html) {
  return metaContent(html, 'description')
    || metaContent(html, 'og:description')
    || null;
}

// Location is rarely marked up. Try, in order: JSON-LD address, an <address> tag,
// then a footer line that looks like "City, ST" or "City, Country".
function extractLocation(html) {
  // 1 — JSON-LD structured data with a PostalAddress
  const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of ldBlocks) {
    try {
      const json = JSON.parse(block[1].trim());
      const nodes = Array.isArray(json) ? json : (json['@graph'] || [json]);
      for (const node of nodes) {
        const addr = node && node.address;
        if (!addr) continue;
        if (typeof addr === 'string') return stripHtml(addr);
        const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
          .map(p => (typeof p === 'object' && p ? (p.name || '') : p))
          .filter(Boolean);
        if (parts.length) return parts.join(', ');
      }
    } catch { /* skip malformed JSON-LD */ }
  }

  // 2 — an explicit <address> element
  const addrTag = html.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
  if (addrTag) {
    const t = stripHtml(addrTag[1]);
    if (t && t.length <= 120) return t;
  }

  // 3 — a footer line resembling "San Francisco, CA" or "London, United Kingdom"
  const footer = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/i);
  const haystack = footer ? stripHtml(footer[1]) : '';
  const m = haystack.match(/\b([A-Z][a-zA-Z.'-]+(?:\s[A-Z][a-zA-Z.'-]+)*),\s*([A-Z]{2}|[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*)\b/);
  if (m) return `${m[1]}, ${m[2]}`;

  return null;
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const password = process.env.DASHBOARD_PASSWORD;
  const headerPw = req.headers['x-dashboard-password'];
  if (!password || !headerPw || headerPw !== password) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let { url } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: 'url is required' });
  }
  url = String(url).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // LinkedIn auth-walls server-side fetches — be explicit instead of returning junk.
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (host.includes('linkedin.com')) {
    return res.status(200).json({
      ok: false,
      linkedin: true,
      message: 'LinkedIn pages are blocked for server-side fetches. Enter the company details manually, or use the company’s own website URL.',
      company: null,
      description: null,
      location: null,
    });
  }

  try {
    const html = await fetchPage(url);
    // Each extractor is independent — one failing returns null for that field only.
    const company     = extractCompany(html);
    const description = extractDescription(html);
    const location    = extractLocation(html);
    console.log(`[radar-fetch-company] ${url} → company:${!!company} desc:${!!description} loc:${!!location}`);
    return res.status(200).json({
      ok: true,
      company:     company     || null,
      description: description || null,
      location:    location    || null,
    });
  } catch (err) {
    console.error(`[radar-fetch-company] fetch failed for ${url}: ${err.message}`);
    // Graceful: surface the failure but don't 500 — the modal falls back to manual entry.
    return res.status(200).json({
      ok: false,
      error: 'Could not fetch the page. Enter details manually.',
      company: null,
      description: null,
      location: null,
    });
  }
}
