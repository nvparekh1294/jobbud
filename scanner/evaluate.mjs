import { enrichCompany } from './enrich.mjs';
import { HAIKU_MODEL, SONNET_MODEL } from './config.mjs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const GITHUB_API_BASE   = 'https://api.github.com';
const IS_DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

// Rough public list prices in $/million tokens — used only for the per-scan cost
// estimate log. Sonnet cache write = 1.25x base input, cache read = 0.1x base input.
const PRICING = {
  haiku:  { input: 1.00, output: 5.00 },
  sonnet: { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
};

// ── GitHub file helper (same pattern as coach.js / weeklyDigest.mjs) ─────────
async function readGithubFile(githubToken, owner, repo, path) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return '';
  if (!res.ok) {
    console.warn(`[evaluate] GitHub read ${path} failed: ${res.status}`);
    return '';
  }
  const data = await res.json();
  if (data.content) return Buffer.from(data.content, 'base64').toString('utf8');
  if (data.download_url) {
    const rawRes = await fetch(data.download_url, { headers: { Authorization: `Bearer ${githubToken}` } });
    return rawRes.ok ? rawRes.text() : '';
  }
  return '';
}

// ── Stage 2 scoring rubric ──────────────────────────────────────────────────
// Built once per scan run from config/profile.yml, then passed to every
// sonnetScore() call unchanged so the prompt cache hits on every job.
// No per-job interpolation belongs here — job-specific content goes in the
// user message, outside the cache boundary.
// Sonnet's minimum cacheable prefix is 1,024 tokens; this rubric clears it.
const RUBRIC_SUFFIX = `
All calibration below is RELATIVE to the CANDIDATE PROFILE above. Wherever a rule
refers to the candidate's target roles, seniority, locations, compensation target,
preferred companies, or deal-breaker industries, read those from the profile. If
the profile is not configured, apply only the profile-independent mechanisms
(staffing-agency cap, vague-posting cap, the one-metric and score-spreading
guidance) and score the rest on role quality and seniority signals alone. The
experience-requirement penalty is NOT profile-independent -- it is relative to
target seniority, so with no profile it does not apply.

SCORING ANCHORS -- use these as explicit calibration references. Spread scores across the range; do not cluster ties. Two roles that differ in company caliber or seniority fit should not receive the same score.
- 4.6-5.0 Exceptional match. Title is a direct hit for the candidate's target role family at a company that clearly fits their preferred profile. Seniority and scope are right-sized. Compensation (where stated) meets or exceeds the candidate's stated target. Location confirmed or remote. A clear step up or a strong lateral.
- 4.0-4.5 Strong match on three of four dimensions (title family, seniority, company caliber, location/comp signal). One dimension is slightly off.
- 3.5-3.9 Interesting with a real gap. Two dimensions misalign -- e.g. right function but off-profile company, right company but title one tier below target, or location requires relocation with no remote option stated.
- 3.0-3.4 Significant stretch but worth awareness. Useful to monitor, not to apply immediately.
- Below 3.0 Not a fit.

Consider seniority fit, company stage fit, role scope fit, and compensation range fit -- not just title keyword match. A senior leadership role at a very small early-stage company is NOT the same as the same title at a larger, later-stage one.

AUTOMATIC SCORE CAPS -- apply these carefully with the nuances noted:

HARD CAP at 2.5 (score must not exceed 2.5):
- Staffing and recruiting agencies posting roles on behalf of an unnamed client UNLESS the end-client company is clearly identifiable and on-profile.
- Roles clearly in an industry the candidate's profile lists as a deal-breaker or off-target -- but only when the ROLE itself has no on-profile angle. A strategy, operations, corporate-development, chief-of-staff, or investing role, or any role with a clear fit to the candidate's stated interests, is NOT capped by employer industry alone.

CAP at 2.8 unless strong mitigating factors are present:
- Vague postings under 100 words with no specific responsibilities listed.
- Roles that are client-facing/external-delivery variants of a function when the candidate's profile targets the internal/strategic variant of that function.

DO NOT CAP by employer industry alone. Any role that clearly fits the candidate's target function or stated interests is eligible for full scores regardless of the employer's sector.

COMPENSATION GUIDANCE -- apply only when the candidate's profile states a compensation target AND the job description explicitly states a base salary:
- Base well below the candidate's stated target: reduce score by 1.0 (significant mismatch).
- Base modestly below target: add a watchOut noting the gap but do NOT reduce the score -- let other factors decide.
- Base at or above target, or no compensation listed: no adjustment.
- Never use compensation alone to cap a score below what the role deserves on other merits.
- If the profile states no compensation target, make no compensation adjustment.

EXPERIENCE REQUIREMENT PENALTY -- apply relative to the candidate's target seniority when the job description explicitly states a minimum years-of-experience requirement:
- Requires far fewer years than the candidate's target seniority implies: cap score at 2.0 (too junior).
- Requires somewhat fewer years than target: cap score at 2.8.
- Requires slightly fewer years than target: reduce score by 0.3 if other factors would push it above 4.0.
- Requires years appropriate to target seniority or more: no penalty.
- If no years of experience are mentioned, or the profile does not state a target seniority: no penalty, assess on other factors.
- Look for phrases like "X+ years", "X-Y years of experience", "minimum X years". Do NOT penalize when years are mentioned only for a specific technical skill rather than overall experience.

PREFERRED COMPANY BONUS -- apply only when the candidate's profile names preferred or high-priority target companies:
For any role at a company the profile flags as a high-priority target that scores 3.5+ on all other factors, add 0.3 to the final score (capped at 5.0). The bonus only applies when the role itself is a genuine fit -- do not use it to rescue a poor fit. If the profile names no preferred companies, do not apply any bonus.

Respond in valid JSON only.`;

// Builds the full scoring rubric string once per scan run.
// Reads config/profile.yml from the user's repo so the CANDIDATE PROFILE section
// is always personalised without hardcoding any individual's background here.
export async function buildScoringRubric(githubToken, owner, repo) {
  const profileYml = githubToken && owner && repo
    ? await readGithubFile(githubToken, owner, repo, 'config/profile.yml').catch(() => null)
    : null;

  const candidateProfileSection = profileYml && profileYml.trim()
    ? `CANDIDATE PROFILE (for calibration):\n${profileYml.trim()}`
    : `CANDIDATE PROFILE: Not configured. Score generically based on role title and seniority signals only. Flag this in results so the user knows to configure config/profile.yml for accurate scoring.`;

  return `You are JobBud, scoring job matches for this candidate.
${candidateProfileSection}
${RUBRIC_SUFFIX}`;
}

// ── Stage 1 hard-filter prompt ──────────────────────────────────────────────
// Deliberately short. NO prompt caching — the write overhead would make the
// cheap Haiku call slower for no benefit. The filter leans hard toward PASS: any
// AI signal in the company or role passes, and traditional industries only fail
// when the company is clearly non-AI AND the role has no AI component. Borderline
// cases go to Stage 2, where Sonnet's HARD-CAP-at-2.5 rules suppress true non-fits
// below the digest threshold. False negatives (dropping a good job) are worse than
// false positives (passing a mediocre one to Sonnet) here.
export const STAGE1_SYSTEM = `You are a fast pre-filter for a professional job search. Decide ONLY whether a job is an UNAMBIGUOUS non-fit. Bias heavily toward PASS: whenever data is missing, ambiguous, or borderline, PASS it through. A false negative here silently drops a strong match -- the worst outcome. Fail ONLY on a clear, explicit disqualifier.

Hard disqualifiers -- FAIL only if the job CLEARLY matches one:
- title: a pure individual-contributor role with no leadership, strategy, operations, or management scope of any kind (e.g. a hands-on software engineer, designer, sales rep, or customer support agent) AND nothing in the description suggests a broader remit.
- seniority: clearly entry-level, junior, or intern, with no path to ownership or leadership.
- staffing/recruiting agency: the posting company is a staffing or recruiting firm advertising a GENERIC role -- no named client and no identifiable employer (see STAFFING below).

STAFFING / RECRUITING AGENCIES -- do NOT auto-fail just because the posting company is a recruiter or staffing firm. If the description names a specific client company or an identifiable employer, and that company/role sounds relevant, PASS to full scoring. FAIL only when the posting is generic: no named client, no identifiable employer, just the agency advertising for an unnamed company.

If none of the disqualifiers clearly applies, PASS. When in doubt, PASS. Respond in valid JSON only.`;

export function classifyJobType(job) {
  const title   = (job.title   || '').toLowerCase();
  const company = (job.company || '').toLowerCase();

  // Company-level signals: name or portal category indicates a VC / family office / fund
  const companyInvestingSignals = ['venture', 'capital', ' fund', 'family office', 'investments', ' vc'];
  const companyIsInvestor = companyInvestingSignals.some(k => company.includes(k))
    || job.portalCategory === 'vc';

  // Title-level signals: the role itself is an investing seat
  const titleInvestingSignals = ['principal', 'partner', 'investor', 'portfolio', 'venture'];
  const titleIsInvesting = titleInvestingSignals.some(k => title.includes(k));

  // Require BOTH to fire — a single financial keyword in the description
  // (e.g. Visa, Mastercard) is not enough to mark a role as 'investing'.
  return (companyIsInvestor && titleIsInvesting) ? 'investing' : 'operating';
}

export function sanitizeLocation(str) {
  if (!str) return '';
  return str.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Single place all Anthropic calls go through. Retries once on transient errors
// (429 / 5xx) with a short fixed delay — NOT a long backoff, which between
// successful scoring calls would let the 5-minute prompt cache expire. The
// monthly spend-limit error (HTTP 400, "usage limits") is surfaced loudly and
// not retried — retrying cannot help until the limit is raised.
export async function callAnthropic(body, config, label) {
  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
    });

    if (response.ok) return response.json();

    const errText = await response.text().catch(() => '');
    if (response.status === 400 && /usage limit|spend/i.test(errText)) {
      console.error(`  [${label}] Anthropic MONTHLY SPEND LIMIT reached (HTTP 400). Raise the limit at console.anthropic.com > Settings > Limits. Body: ${errText.slice(0, 200)}`);
      throw new Error(`Anthropic spend limit reached: ${errText.slice(0, 200)}`);
    }

    lastErr = new Error(`Anthropic API HTTP ${response.status}: ${errText.slice(0, 200)}`);
    const transient = response.status === 429 || response.status >= 500;
    if (transient && attempt < MAX_ATTEMPTS) {
      console.warn(`  [${label}] transient error HTTP ${response.status} — retrying once in 2s`);
      await sleep(2000);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

// ── Stage 1: Haiku binary hard filter ───────────────────────────────────────
// Returns { pass, confidence, reasonCategory, reason, usage }. Fails OPEN on any
// error or parse failure (pass: true) — never silently drops a job.
export async function haikuHardFilter(job, config) {
  const userMsg = `Assess this job:

TITLE: ${job.title}
COMPANY: ${job.company}
LOCATION: ${job.location}${job.isRemote ? ' (Remote)' : ''}${job.level ? `\nLEVEL: ${job.level}` : ''}${job.team ? `\nTEAM: ${job.team}` : ''}
DESCRIPTION (first 600 chars):
${(job.description || '(none provided)').slice(0, 600)}

Respond with exactly this JSON:
{
  "pass": <true if NOT an unambiguous non-fit, false only on a clear disqualifier>,
  "confidence": <0.0-1.0, how strong a genuine fit this looks for full scoring; higher = more relevant>,
  "reasonCategory": <"title" | "seniority" | "location" | "industry" | "none">,
  "reason": "<=10 words"
}`;

  try {
    const data = await callAnthropic({
      model: HAIKU_MODEL,
      max_tokens: 150,
      system: STAGE1_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    }, config, 'stage1');

    const u = data.usage || {};
    const usage = { input: u.input_tokens || 0, output: u.output_tokens || 0 };
    const text = data.content?.[0]?.text || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    return {
      pass: parsed.pass !== false, // default to pass unless explicitly false
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reasonCategory: parsed.reasonCategory || 'none',
      reason: parsed.reason || '',
      usage,
    };
  } catch (err) {
    // Fail OPEN — pass the job to Stage 2 rather than risk dropping a real match.
    console.warn(`  [stage1] parse/API error for ${job.company} — ${job.title}: ${err.message} — passing open`);
    return { pass: true, confidence: 0.5, reasonCategory: 'none', reason: 'filter error - passed open', usage: { input: 0, output: 0 } };
  }
}

// ── Stage 2: Sonnet full-rubric scoring with prompt caching ─────────────────
// Returns { scoreObj, usage, cacheHit }. scoreObj is byte-identical in schema to
// the legacy single-pass scorer — downstream (notify, dashboard, job-status.json)
// depends on the exact shape. Throws on hard API error so the caller records null.
export async function sonnetScore(job, config, rubric) {
  const jobType = classifyJobType(job);

  const metaLines = [
    job.team           ? `TEAM: ${job.team}`                          : '',
    job.level          ? `LEVEL: ${job.level}`                        : '',
    job.tags?.length   ? `TAGS: ${job.tags.join(', ')}`               : '',
    job.workplaceType  ? `WORKPLACE: ${job.workplaceType}`            : '',
    job.salaryRange    ? `SALARY: ${JSON.stringify(job.salaryRange)}`  : '',
    job.employmentType ? `EMPLOYMENT TYPE: ${job.employmentType}`      : '',
  ].filter(Boolean);
  const metaBlock = metaLines.length ? `\nMETADATA:\n${metaLines.join('\n')}` : '';

  const userMsg = `Evaluate this job:

ROLE: ${job.title}
COMPANY: ${job.company}
LOCATION: ${job.location}${job.isRemote ? ' (Remote)' : ''}
TYPE: ${jobType}
URL: ${job.url}

DESCRIPTION:
${job.description?.slice(0, 3000)}${metaBlock}

Respond with exactly this JSON:
{
  "score": <1.0-5.0, weighted: subtract 0.3 if aiExposureRisk is high, subtract 0.1 if medium>,
  "whyFit": [<2-3 specific reasons>],
  "watchOuts": [<1-3 concerns>],
  "recommendedAction": <"Apply now" | "Apply with tailored resume" | "Investigate further" | "Skip">,
  "seniority": <"good fit" | "too junior" | "too senior" | "unclear">,
  "jobType": "${jobType}",
  "oneLineSummary": <one sentence>,
  "companyDescription": <1-2 sentences on what the company does, based on the job description context>,
  "aiExposureRisk": <"low" | "medium" | "high" -- assess how likely this specific role is to be significantly disrupted by AI in the next 2-3 years, based on how much of the work involves judgment, relationships, ambiguity, and cross-functional coordination vs. repeatable tasks>,
  "aiExposureRationale": <one sentence explaining the risk rating>
}`;

  const data = await callAnthropic({
    model: SONNET_MODEL,
    max_tokens: 1024,
    // cache_control on the rubric block — built once per scan run, byte-identical across all jobs.
    system: [{ type: 'text', text: rubric, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  }, config, 'stage2');

  const u = data.usage || {};
  const usage = {
    cache_creation: u.cache_creation_input_tokens || 0,
    cache_read:     u.cache_read_input_tokens || 0,
    input:          u.input_tokens || 0,
    output:         u.output_tokens || 0,
  };
  const cacheHit = usage.cache_read > 0;
  console.log(`  [stage2] ${cacheHit ? 'cache HIT' : 'cache MISS'} (read=${usage.cache_read} write=${usage.cache_creation}) — ${job.company} — ${job.title}`);

  const text = data.content?.[0]?.text || '';
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  console.log(`  [stage2] parsed score: ${parsed.score} | action: ${parsed.recommendedAction}`);

  const scoreObj = {
    score: parsed.score,
    whyFit: parsed.whyFit || [],
    watchOuts: parsed.watchOuts || [],
    recommendedAction: parsed.recommendedAction || 'Investigate further',
    seniority: parsed.seniority || 'unclear',
    jobType: parsed.jobType || jobType,
    oneLineSummary: parsed.oneLineSummary || '',
    companyDescription: parsed.companyDescription || '',
    aiExposureRisk: parsed.aiExposureRisk || 'unclear',
    aiExposureRationale: parsed.aiExposureRationale || '',
    evaluation: parsed,
  };
  return { scoreObj, usage, cacheHit };
}

export async function evaluateJobs(jobs, config) {
  // Dry run: return fixture data as-is without calling Claude
  if (IS_DRY_RUN) {
    console.log(`[evaluate] DRY RUN — returning ${jobs.length} pre-scored fixture jobs (no Claude call)`);
    return [...jobs].sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  if (!config.anthropicApiKey) {
    console.warn('Anthropic API key not set -- skipping evaluation');
    return jobs.map(j => ({ ...j, score: null, evaluation: null }));
  }

  // Build the scoring rubric once — reads config/profile.yml from the repo so the
  // CANDIDATE PROFILE section is personalised. The same string is reused for every
  // sonnetScore() call in this run so the prompt cache hits after the first miss.
  const githubToken = process.env.GH_TOKEN;
  const githubRepo  = process.env.GH_REPO || '';
  const [owner, repo] = githubRepo.split('/');
  const rubric = await buildScoringRubric(githubToken, owner, repo);
  console.log(`[evaluate] Scoring rubric built (${rubric.length} chars, profile ${owner && repo ? 'loaded from repo' : 'not configured'})`);

  const cap = config.maxJobsToEvaluate || 25;

  // ── Stage 1: run the cheap Haiku hard filter on ALL candidates (no cap) ────
  const passers = [];   // { job, s1 } that cleared Stage 1
  const filtered = [];  // jobs that failed Stage 1 (returned with null score, marked scored)
  const filterReasonCounts = {};
  let haikuIn = 0, haikuOut = 0;

  for (const job of jobs) {
    job.location = sanitizeLocation(job.location);
    const s1 = await haikuHardFilter(job, config);
    haikuIn += s1.usage.input;
    haikuOut += s1.usage.output;

    if (s1.pass) {
      passers.push({ job, s1 });
    } else {
      filtered.push(job);
      filterReasonCounts[s1.reasonCategory] = (filterReasonCounts[s1.reasonCategory] || 0) + 1;
      console.log(`  [stage1] FILTERED (${s1.reasonCategory}) ${job.company} — ${job.title}: ${s1.reason}`);
    }
  }

  // Over-filtering guardrail: if almost nothing passed, something is likely wrong.
  if (jobs.length >= 50 && passers.length <= 3) {
    console.warn(`  [stage1] WARNING: only ${passers.length}/${jobs.length} jobs passed Stage 1 — likely over-filtering. Review disqualifier rules before trusting this run.`);
  }

  // ── Cap: only how many jobs reach Stage 2 (cost ceiling across all sources) ─
  // Rank passers by Stage 1 confidence (desc); break ties toward portal jobs
  // (curated target companies). If the cap truncates, the lowest-confidence
  // passers are deferred — they were never marked scored, so they retry next run.
  const ranked = [...passers].sort((a, b) => {
    const d = (b.s1.confidence ?? 0.5) - (a.s1.confidence ?? 0.5);
    if (d !== 0) return d;
    const ap = a.job.source === 'portal' ? 1 : 0;
    const bp = b.job.source === 'portal' ? 1 : 0;
    return bp - ap;
  });
  const toScore = ranked.slice(0, cap);
  const deferred = ranked.length - toScore.length;
  if (deferred > 0) {
    console.log(`  [stage2] cap=${cap} reached — deferring ${deferred} lowest-confidence passer(s) to next run`);
  }

  // ── Stage 2: full Sonnet scoring (prompt-cached) on the selected passers ───
  const results = [];
  let s2Hit = 0, s2Miss = 0;
  let cacheCreate = 0, cacheRead = 0, sonnetIn = 0, sonnetOut = 0;

  for (const { job } of toScore) {
    try {
      const { scoreObj, usage, cacheHit } = await sonnetScore(job, config, rubric);
      if (cacheHit) s2Hit++; else s2Miss++;
      cacheCreate += usage.cache_creation;
      cacheRead   += usage.cache_read;
      sonnetIn    += usage.input;
      sonnetOut   += usage.output;

      // Funding enrichment — skip for public companies, use cache
      let fundingSnapshot = null;
      try {
        fundingSnapshot = await enrichCompany(job.company, config);
      } catch (err) {
        console.warn(`  [enrich] Failed for ${job.company}: ${err.message}`);
      }

      results.push({ ...job, ...scoreObj, fundingSnapshot });
    } catch (err) {
      console.error(`Stage 2 scoring failed for ${job.company} — ${job.title}:`, err);
      results.push({ ...job, score: null, evaluation: null, fundingSnapshot: null });
    }
  }

  // Stage-1-filtered jobs: return with null score so they're excluded from the
  // digest (score === null) but still get marked scored upstream — they're clear
  // non-fits and shouldn't be re-evaluated every run.
  for (const job of filtered) {
    results.push({ ...job, score: null, evaluation: null, fundingSnapshot: null, stage1Filtered: true });
  }

  // ── Per-scan summary log (primary tuning + cost instrument) ────────────────
  const reasonSummary = Object.entries(filterReasonCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${cat} (${n})`)
    .join(' | ') || 'none';
  const cost =
    (haikuIn * PRICING.haiku.input + haikuOut * PRICING.haiku.output) / 1e6 +
    (sonnetIn * PRICING.sonnet.input
      + cacheCreate * PRICING.sonnet.cacheWrite
      + cacheRead * PRICING.sonnet.cacheRead
      + sonnetOut * PRICING.sonnet.output) / 1e6;

  console.log(`[score] Stage 1: ${jobs.length} evaluated → ${passers.length} passed → ${filtered.length} filtered`);
  console.log(`[score] Stage 1 filter reasons: ${reasonSummary}`);
  console.log(`[score] Stage 2: ${toScore.length} scored | cache MISS: ${s2Miss} | cache HIT: ${s2Hit}${deferred > 0 ? ` | deferred over cap: ${deferred}` : ''}`);
  console.log(`[score] Stage 2 tokens: cache_write=${cacheCreate} cache_read=${cacheRead} uncached_in=${sonnetIn} output=${sonnetOut}`);
  console.log(`[score] Stage 1 tokens (Haiku): in=${haikuIn} out=${haikuOut}`);
  console.log(`[score] Estimated scan cost: $${cost.toFixed(3)}`);

  return results.sort((a, b) => (b.score || 0) - (a.score || 0));
}

// Whether a job from evaluateJobs should be marked scored in seen-jobs.json —
// i.e. never re-evaluated. TRUE for jobs that were successfully scored (numeric
// score) and for jobs intentionally dropped by the Stage-1 hard filter (they
// carry stage1Filtered:true and are clear non-fits — re-filtering them every run
// wastes Haiku spend). FALSE only for a Stage-2 scoring FAILURE: score is null
// AND there is no stage1Filtered marker (the score:null result.push above).
// Leaving those unmarked lets a transient failure (e.g. a 429) retry next run
// instead of silently dropping the job forever.
export function wasScoredOrFiltered(job) {
  return job.score != null || job.stage1Filtered === true;
}
