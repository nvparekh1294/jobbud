// Phrases that indicate a job posting is no longer accepting applications.
// Checked against title + description; multi-word phrases are safer than
// single words like "closed"/"expired" which appear in unrelated contexts.
const CLOSED_PHRASES = [
  'no longer accepting',
  'position filled',
  'no longer available',
  'this job is no longer',
  'applications are closed',
  'this position has been filled',
  'role has been filled',
];
// Short keywords only safe to match in the title (too noisy in descriptions)
const CLOSED_TITLE_ONLY = ['[closed]', '[expired]', '(closed)', '(expired)'];

export function isJobClosed(title, description) {
  const titleLower = (title || '').toLowerCase();
  const descLower  = (description || '').toLowerCase();
  const combined   = `${titleLower} ${descLower}`;
  if (CLOSED_TITLE_ONLY.some(p => titleLower.includes(p))) return true;
  return CLOSED_PHRASES.some(p => combined.includes(p));
}

// Escape special regex characters in a keyword before building a RegExp
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True if `keyword` appears as a whole word in `text` (case-insensitive).
// Prevents "intern" from matching "Internal", "International", "Internship", etc.
function wordMatch(text, keyword) {
  return new RegExp('\\b' + escapeRegex(keyword) + '\\b', 'i').test(text);
}

export function preFilter(jobs, config) {
  return jobs.filter(job => {
    const title = (job.title || '').toLowerCase();
    const description = (job.description || '').toLowerCase();
    const company = (job.company || '').toLowerCase();

    // Closed / filled / expired postings — skip regardless of source
    if (isJobClosed(job.title, job.description)) {
      console.log(`  [filter] ${job.company} — ${job.title}: excluded (no longer accepting applications)`);
      return false;
    }

    // Basic data quality checks
    if (!job.title || !job.company) return false;
    if (!job.url) return false;
    // Portal jobs are from curated, trusted sources — skip description length gate.
    // API-sourced jobs still require a description so we don't waste Claude calls on
    // stub/malformed listings.
    if (job.source !== 'portal' && (!job.description || job.description.length < 100)) return false;

    // Positive match gate — must contain at least one required keyword as a whole word
    if (config.requiredTitleKeywords?.length) {
      const hasMatch = config.requiredTitleKeywords.some(k =>
        wordMatch(title, k) || wordMatch(description, k)
      );
      if (!hasMatch) {
        console.log(`  [filter] ${job.company} — ${job.title}: excluded (no required keyword match)`);
        return false;
      }
    }

    // Exclude title keywords (too junior / wrong role type) — whole-word match only
    // Prevents "intern" matching "Internal", "International", "Internship", etc.
    for (const keyword of config.excludeTitleKeywords) {
      if (wordMatch(title, keyword)) {
        console.log(`  [filter] ${job.company} — ${job.title}: excluded (title: "${keyword}")`);
        return false;
      }
    }

    // Deal-breaker industries — substring match is fine here (industry names are distinctive)
    for (const industry of config.dealBreakerIndustries || []) {
      if (description.includes(industry.toLowerCase()) || company.includes(industry.toLowerCase())) {
        console.log(`  [filter] ${job.company} — ${job.title}: excluded (industry: "${industry}")`);
        return false;
      }
    }

    // Deal-breaker keywords — substring match is fine (these are specific multi-word phrases)
    for (const keyword of config.dealBreakerKeywords || []) {
      if (description.includes(keyword.toLowerCase())) {
        console.log(`  [filter] ${job.company} — ${job.title}: excluded (keyword: "${keyword}")`);
        return false;
      }
    }

    return true;
  });
}
