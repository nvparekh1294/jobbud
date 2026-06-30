import fs from 'fs/promises';
import path from 'path';

const SERP_API_URL = 'https://serpapi.com/search.json';

const PUBLIC_COMPANY_SIGNALS = [
  'nasdaq', 'nyse', 'lse', 'tsx', 'publicly traded', 'public company',
  'google', 'meta', 'amazon', 'apple', 'microsoft', 'nvidia', 'tesla',
];

const STEALTH_SIGNALS = ['stealth', 'undisclosed', 'confidential'];

// Sanity check: max reasonable valuation per round (in $M)
const ROUND_VALUATION_CAPS = {
  'Pre-Seed': 50,
  'Seed': 500,
  'Series A': 5000,
  'Series B': 20000,
  'Series C': 50000,
  'Series D': 100000,
  'Series E': 200000,
};

function looksPublic(company) {
  const c = company.toLowerCase();
  return PUBLIC_COMPANY_SIGNALS.some(s => c.includes(s));
}

function looksStealth(company) {
  const c = company.toLowerCase();
  return !company || STEALTH_SIGNALS.some(s => c.includes(s));
}

function parseDollarAmountAsMillion(str) {
  if (!str) return null;
  const match = str.match(/\$\s*(\d+(?:\.\d+)?)\s*(m|million|b|billion)/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return unit.startsWith('b') ? num * 1000 : num;
}

function sanityCheck(round, valuation) {
  if (!round || !valuation) return true; // nothing to check
  const cap = ROUND_VALUATION_CAPS[round];
  if (!cap) return true;
  const valM = parseDollarAmountAsMillion(valuation);
  if (valM === null) return true;
  return valM <= cap;
}

async function loadCache(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cachePath, cache) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
}

async function searchSerpApi(query, apiKey) {
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    api_key: apiKey,
    num: '5',
  });
  const res = await fetch(`${SERP_API_URL}?${params}`);
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
  const data = await res.json();
  return data.organic_results || [];
}

function parseRound(text) {
  const rounds = ['pre-seed', 'seed', 'series a', 'series b', 'series c', 'series d', 'series e', 'series f', 'growth', 'late stage', 'pre-ipo'];
  const lower = text.toLowerCase();
  for (const r of rounds) {
    if (lower.includes(r)) {
      return r.replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  return null;
}

function parseAmount(text) {
  const match = text.match(/\$\s*(\d+(?:\.\d+)?)\s*(m|million|b|billion)/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('b')) return `$${num}B`;
  return `$${num}M`;
}

function parseInvestors(text) {
  const knownVCs = [
    'sequoia', 'andreessen horowitz', 'a16z', 'benchmark', 'thrive capital',
    'accel', 'kleiner perkins', 'greylock', 'index ventures', 'lightspeed',
    'general catalyst', 'founders fund', 'khosla ventures', 'tiger global',
    'coatue', 'insight partners', 'softbank', 'bessemer', 'battery ventures',
    'first round', 'spark capital', 'union square ventures', 'usv',
    'nvidia ventures', 'google ventures', 'gv', 'intel capital',
    'openai', 'anthropic', 'felicis', 'nea', 'menlo ventures',
  ];
  const lower = text.toLowerCase();
  const found = knownVCs.filter(vc => lower.includes(vc));
  return [...new Set(found)].map(v => v.replace(/\b\w/g, c => c.toUpperCase())).slice(0, 4);
}

export async function enrichCompany(company, config) {
  // Skip stealth / missing company names
  if (looksStealth(company)) {
    console.log(`  [enrich] "${company}": stealth/undisclosed — skipping`);
    return { round: null, skip: true };
  }

  if (looksPublic(company)) {
    console.log(`  [enrich] ${company}: public company — skipping`);
    return null;
  }

  const cachePath = config.companyCachePath || './data/company-cache.json';
  const cache = await loadCache(cachePath);
  const cacheKey = company.toLowerCase().trim();

  if (cache[cacheKey] !== undefined) {
    console.log(`  [enrich] ${company}: cache hit`);
    return cache[cacheKey];
  }

  if (!config.serpApiKey) {
    console.warn(`  [enrich] No SerpAPI key — skipping enrichment for ${company}`);
    cache[cacheKey] = null;
    await saveCache(cachePath, cache);
    return null;
  }

  console.log(`  [enrich] Fetching funding data for ${company}...`);

  try {
    const [crunchbaseResults, generalResults] = await Promise.allSettled([
      searchSerpApi(`${company} funding round crunchbase`, config.serpApiKey),
      searchSerpApi(`${company} series raised investors`, config.serpApiKey),
    ]);

    const allResults = [
      ...(crunchbaseResults.status === 'fulfilled' ? crunchbaseResults.value : []),
      ...(generalResults.status === 'fulfilled' ? generalResults.value : []),
    ];

    // Pick the best source URL (first result with a real link)
    const sourceUrl = allResults.find(r => r.link)?.link || null;

    const allText = allResults.map(r => `${r.title || ''} ${r.snippet || ''}`).join(' ');

    if (!allText.trim()) {
      cache[cacheKey] = null;
      await saveCache(cachePath, cache);
      return null;
    }

    const round = parseRound(allText);
    const amount = parseAmount(allText);
    const investors = parseInvestors(allText);

    if (!round && !amount && investors.length === 0) {
      cache[cacheKey] = null;
      await saveCache(cachePath, cache);
      return null;
    }

    // Sanity check: round + valuation must be logically consistent
    if (!sanityCheck(round, amount)) {
      console.warn(`  [enrich] ${company}: failed sanity check (${round} with ${amount}) — discarding`);
      const unreliable = { round: null, unreliable: true };
      cache[cacheKey] = unreliable;
      await saveCache(cachePath, cache);
      return unreliable;
    }

    const snapshot = {
      round: round || null,
      amount: amount || null,
      valuation: null,
      investors,
      sourceUrl,
      source: 'serpapi',
      fetchedAt: new Date().toISOString(),
    };

    console.log(`  [enrich] ${company}: ${round || '?'} · ${amount || '?'} · ${investors.join(', ') || 'unknown investors'}`);

    cache[cacheKey] = snapshot;
    await saveCache(cachePath, cache);
    return snapshot;

  } catch (err) {
    console.error(`  [enrich] Error for ${company}: ${err.message}`);
    cache[cacheKey] = null;
    await saveCache(cachePath, cache);
    return null;
  }
}
