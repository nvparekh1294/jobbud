// Model strings — referenced by both scoring stages in evaluate.mjs.
// Stage 1 (cheap binary hard filter) uses Haiku; Stage 2 (full rubric scoring,
// prompt-cached) uses Sonnet. Never hardcode these strings inline elsewhere.
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const SONNET_MODEL = 'claude-sonnet-4-6';

export async function loadConfig() {
  return {
    operatingRoles: [
      'business operations',
      'biz ops',
      'chief of staff',
      'COO',
      'chief operating officer',
      'head of operations',
      'VP operations',
      'strategy and operations',
      'strategy & operations',
      'special projects',
      "CEO's office",
      'office of the CEO',
      'strategic finance',
      'corporate development',
      'growth operations',
    ],

    investingRoles: [
      'investment partner',
      'investment principal',
      'venture partner',
      'principal',
      'investor',
    ],

    locations: [
      { city: 'San Francisco', region: 'CA', country: 'us', radiusMiles: 30 },
      { city: 'New York City', region: 'NY', country: 'us', radiusMiles: 20 },
      { city: 'Los Angeles', region: 'CA', country: 'us', radiusMiles: 25 },
      { city: 'London', region: null, country: 'gb', radiusMiles: 15 },
      { city: 'Singapore', region: null, country: 'sg', radiusMiles: 15 },
    ],

    includeRemote: true,

    excludeTitleKeywords: [
      'coordinator',
      'assistant',
      'intern',
      'junior',
      'entry level',
      'associate',
      'analyst',
      'specialist',
      'account director',
      'account manager',
      'account executive',
    ],

    requiredTitleKeywords: [
      // Operating role families
      'business operations',
      'biz ops',
      'strategy',
      'operations',
      'chief of staff',
      'COO',
      'chief operating officer',
      'head of',
      'VP',
      'vice president',
      'director',
      'strategic finance',
      'corporate development',
      'corp dev',
      'special projects',
      'growth',
      // Investing role families
      'principal',
      'partner',
      'investor',
      'venture',
      'investment',
    ],

    dealBreakerIndustries: [
      'gambling',
      'casino',
      'tobacco',
      'payday loan',
      'weapons',
      'defense contractor',
    ],

    dealBreakerKeywords: [
      'FP&A only',
      'pure finance',
      'accounts payable',
      'accounts receivable',
      'bookkeeping',
      'payroll specialist',
      'tax specialist',
      'audit associate',
    ],

    minSalary: 200000,
    minCompanySize: 0,
    maxTravelPercent: null,

    targetCompanyStages: [
      'Series A',
      'Series B',
      'Series C',
      'Series D',
      'Series E',
      'late stage',
      'growth stage',
      'public',
      'pre-IPO',
      // Pre-seed/seed allowed only with signal — handled in evaluate, not filtered here
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
