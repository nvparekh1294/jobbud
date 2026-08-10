import fs from 'fs/promises';

// Auto-load .env for local development — silently skipped in CI where the file won't exist
try {
  const envRaw = await fs.readFile(new URL('../.env', import.meta.url), 'utf8');
  for (const line of envRaw.split('\n')) {
    const match = line.match(/^([^#\s][^=]*)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim().replace(/^["']|["']$/g, '');
      if (key && !process.env[key]) process.env[key] = val;
    }
  }
} catch { /* .env not present — fine in CI */ }

import { fetchJSearch, jsearchStats } from './sources/jsearch.mjs';
import { fetchAdzuna, adzunaStats } from './sources/adzuna.mjs';
import { fetchSerpApi, checkSerpApiBalance, serpApiStats } from './sources/serpapi.mjs';
import { fetchPortals } from './portalScanner.mjs';
import { fetchRadar } from './radarSource.mjs';
import { dedup, markScored } from './dedup.mjs';
import { preFilter } from './filter.mjs';
import { evaluateJobs, wasScoredOrFiltered } from './evaluate.mjs';
import { sendDigest } from './notify.mjs';
import { sendDailyAlert } from './telegram.mjs';
import { persistJobs } from './persistJobs.mjs';
import { checkQuota, recordUsage, callsPerRun } from './quota.mjs';
import { loadConfig } from './config.mjs';
import { actionKeySource, actionKeyFingerprint } from '../lib/auth.mjs';
import { isStarterPortalsList, STARTER_LIST_NOTICE } from '../lib/portalsMeta.mjs';

const SCAN_MODE = process.env.SCAN_MODE || 'standard';
const IS_DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

// Which job sources to run this scan: 'all' (default), 'portals', or 'api'.
// The daily workflow runs 'portals' (no API quota burned); the weekly workflow runs
// 'api' (JSearch + Adzuna only). 'all' preserves the original combined behavior.
const SCAN_SOURCES = (process.env.SCAN_SOURCES || 'all').toLowerCase();
const runPortals = SCAN_SOURCES !== 'api';
const runApi = SCAN_SOURCES !== 'portals';

// Which Company Radar (data/radar.json) companies to include this run:
// 'all' (default — manual/dry runs), 'daily', or 'weekly'. The daily portal
// workflow sets RADAR_CADENCE=daily; a weekly trigger sets it to weekly. Radar
// companies are scanned alongside portals.yml and share the same pipeline.
const RADAR_CADENCE = (process.env.RADAR_CADENCE || 'all').toLowerCase();

// Monthly API budgets, one per source. The defaults are the figures these were
// hardcoded to, but none of them is a fact: every provider sets its own
// allowance per account and Adzuna does not publish its free tier at all, so a
// number baked into the code is a guess that silently throttles anyone whose
// real plan is bigger. Each is overridable — the provider's developer dashboard
// shows the true figure. A non-numeric or non-positive value falls back to the
// default rather than turning the budget off by accident.
function monthlyLimit(envName, fallback) {
  const raw = Number(process.env[envName]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  if (process.env[envName]) console.warn(`[index] ${envName}="${process.env[envName]}" is not a positive number — using the default of ${fallback}`);
  return fallback;
}

const ADZUNA_MONTHLY_LIMIT = monthlyLimit('ADZUNA_MONTHLY_LIMIT', 250);
const JSEARCH_MONTHLY_LIMIT = monthlyLimit('JSEARCH_MONTHLY_LIMIT', 200);
const SERPAPI_MONTHLY_LIMIT = monthlyLimit('SERPAPI_MONTHLY_LIMIT', 250);

async function runDryRun(config) {
  console.log('[dry-run] ── DRY RUN MODE ── loading fixtures, skipping all API calls');

  const fixtureRaw = await fs.readFile(new URL('./fixtures/test-jobs.json', import.meta.url));
  const fixtures = JSON.parse(fixtureRaw);
  console.log(`[dry-run] Loaded ${fixtures.length} fixture jobs`);

  // Fixtures bypass dedup and preFilter (they include a no-URL job that preFilter would drop)
  // evaluateJobs returns them as-is in dry run mode
  const evaluated = await evaluateJobs(fixtures, config);

  const digestJobs = evaluated.filter(j => j.score !== null && j.score >= config.minScoreToIncludeInDigest);
  console.log(`[dry-run] ${digestJobs.length} jobs meet digest threshold (${config.minScoreToIncludeInDigest})`);

  if (digestJobs.length > 0) {
    await sendDigest(digestJobs, config);
    console.log('[dry-run] Digest sent — check your inbox.');
  } else {
    console.log('[dry-run] No jobs met threshold — check fixture scores vs minScoreToIncludeInDigest');
  }

  console.log('[dry-run] Complete. remind.mjs not run in dry run mode.');
}

async function run() {
  console.log(`[${new Date().toISOString()}] JobBud scan starting — mode: ${IS_DRY_RUN ? 'DRY RUN' : SCAN_MODE.toUpperCase()} | sources: ${SCAN_SOURCES} (portals: ${runPortals}, API: ${runApi})`);
  // Action-token key diagnostics — logged once per run so a mint/verify key desync
  // (e.g. a half-applied secret rotation) can be diffed against the Vercel logs.
  console.log(`action-token key: source=${actionKeySource()} fp=${actionKeyFingerprint()}`);

  // Pass the run's repo so loadConfig can layer the user's config/profile.yml over
  // the generic defaults. Vercel/CI set GH_TOKEN + GH_REPO; absent them, loadConfig
  // returns the neutral defaults.
  const [cfgOwner, cfgRepo] = (process.env.GH_REPO || '').split('/');
  const config = await loadConfig(process.env.GH_TOKEN, cfgOwner, cfgRepo);

  // ── Dry run path ──────────────────────────────────────────────────────────
  if (IS_DRY_RUN) {
    await runDryRun(config);
    return;
  }

  // ── Quota estimates (based on query builder counts in each source) ────────
  // jsearch: 4 roleGroups × locations + 2 remote = ~22 calls
  // adzuna: 7 searchTerms × locations = ~35 calls
  // serpapi: 4 roleGroups × locations + 2 remote = ~22 calls
  const jsearchEstimate = config.locations.length * 4 + (config.includeRemote ? 2 : 0);
  const serpApiEstimate = config.locations.length * 4 + (config.includeRemote ? 2 : 0);

  // Adzuna is the one source whose full list cannot run every time: locations ×
  // target roles is ~35 searches, which daily is four times the whole monthly
  // budget. So it asks for a run's worth, not the list's worth — and the source
  // rotates through the list across runs so every search still gets made. The
  // projection has to use the CAPPED number, otherwise a list that will never
  // run in one go blocks the source on every single run.
  const adzunaPerRun = callsPerRun(ADZUNA_MONTHLY_LIMIT, process.env.ADZUNA_CALLS_PER_RUN);
  const adzunaEstimate = Math.min(config.locations.length * 7, adzunaPerRun);

  // ── Quota checks (API sources only) ───────────────────────────────────────
  let jsearchOk = false, adzunaOk = false, serpApiOk = false;
  if (runApi) {
    // Sequential, not Promise.all: each check can write a repaired entry back to
    // the single api-usage.json, and two concurrent writes would drop one of them.
    const jsearchBudget = await checkQuota('jsearch', jsearchEstimate, JSEARCH_MONTHLY_LIMIT);
    const adzunaBudget = await checkQuota('adzuna', adzunaEstimate, ADZUNA_MONTHLY_LIMIT);

    // JSearch keeps its all-or-nothing rule: its query list is small enough to
    // fit whole, so a partial allowance means the month really is nearly spent.
    jsearchOk = jsearchBudget.allowed >= jsearchEstimate;

    // Adzuna runs whatever fits, down to nothing. The source reads this cap and
    // trims its query list to match.
    config.adzunaMaxCallsPerRun = adzunaBudget.allowed;
    adzunaOk = adzunaBudget.allowed > 0;

    if (SCAN_MODE === 'full') {
      const serpApiBudget = await checkQuota('serpapi', serpApiEstimate, SERPAPI_MONTHLY_LIMIT);
      serpApiOk = serpApiBudget.allowed >= serpApiEstimate;
      if (serpApiOk && config.serpApiKey) {
        try {
          const remaining = await checkSerpApiBalance(config.serpApiKey);
          if (remaining < 20) {
            console.warn(`[index] SerpAPI live balance too low (${remaining}) — skipping`);
            serpApiOk = false;
          }
        } catch (err) {
          console.warn(`[index] SerpAPI balance check failed: ${err.message} — skipping SerpAPI`);
          serpApiOk = false;
        }
      }
    } else {
      console.log(`[index] SCAN_MODE=standard — SerpAPI skipped (use SCAN_MODE=full to enable)`);
    }
  } else {
    console.log(`[index] SCAN_SOURCES=${SCAN_SOURCES} — API sources skipped (no quota used)`);
  }

  // ── Portal scanner — runs first, no quota needed ─────────────────────────
  //
  // Before scanning, answer the question a confused user can't: are these even
  // my companies? Skipping onboarding's companies step leaves the maintainer's
  // example scanner/portals.yml in place, and every digest after that is full of
  // roles at companies the user never chose, with nothing saying why. When the
  // file still has no sign of being personalized we say so in the log and add one
  // line to the digest. Detection lives in lib/portalsMeta.mjs.
  let portalJobs = [];
  if (runPortals) {
    try {
      const portalsRaw = await fs.readFile(new URL('./portals.yml', import.meta.url), 'utf8');
      if (isStarterPortalsList(portalsRaw)) {
        config.usingStarterPortals = true;
        console.warn(`[index] ${STARTER_LIST_NOTICE}`);
      }
    } catch (err) {
      // A missing/unreadable portals.yml is the portal scanner's problem to
      // report; never turn a read failure into a scary line in someone's digest.
      console.warn(`[index] Could not check the watch list: ${err.message}`);
    }

    try {
      portalJobs = await fetchPortals();
      console.log(`[index] Portal scanner: ${portalJobs.length} jobs fetched`);
    } catch (err) {
      console.error('[index] Portal scanner failed:', err.message);
    }

    // ── Company Radar — additional portal-type source (no quota) ───────────
    // Reads data/radar.json directly; enabled + ATS-mapped companies matching
    // RADAR_CADENCE are scanned and merged into portalJobs so they flow through
    // the identical dedup → filter → evaluate → persist → digest pipeline.
    try {
      const radarJobs = await fetchRadar({ cadence: RADAR_CADENCE });
      if (radarJobs.length > 0) {
        portalJobs = [...portalJobs, ...radarJobs];
        console.log(`[index] Company Radar: ${radarJobs.length} jobs fetched (cadence: ${RADAR_CADENCE})`);
      }
    } catch (err) {
      console.error('[index] Company Radar scan failed:', err.message);
    }
  } else {
    console.log(`[index] SCAN_SOURCES=${SCAN_SOURCES} — portal scan skipped`);
  }

  // ── API source fetches ────────────────────────────────────────────────────
  //
  // Each source carries its per-run stats object. Quota is recorded from
  // stats.attempts — the requests actually sent, which count against the
  // provider's quota whether they succeeded or 404'd — never from the estimate
  // above. The estimates exist only for the pre-flight checkQuota projection.
  const sources = [];
  if (jsearchOk) sources.push({ name: 'jsearch', fn: () => fetchJSearch(config), stats: jsearchStats });
  else console.warn('[index] JSearch skipped (quota check failed)');

  if (adzunaOk) sources.push({ name: 'adzuna', fn: () => fetchAdzuna(config), stats: adzunaStats });
  else console.warn('[index] Adzuna skipped (quota check failed)');

  if (serpApiOk) sources.push({ name: 'serpapi', fn: () => fetchSerpApi(config), stats: serpApiStats });

  if (sources.length === 0 && portalJobs.length === 0) {
    console.warn('[index] All sources skipped and no portal jobs — nothing to process. Exiting.');
    return;
  }

  let apiJobs = [];
  if (sources.length > 0) {
    const fetchResults = await Promise.allSettled(sources.map(s => s.fn()));

    // Record what each source actually spent, and say so when a source came
    // back with nothing because every one of its queries failed. The old code
    // recorded the estimate on any fulfilled promise, and the sources swallow
    // per-query errors — so a scan where all 22 calls 404'd logged "recorded 22
    // calls", returned 0 jobs, and the Action went green.
    for (let i = 0; i < sources.length; i++) {
      const { name, stats } = sources[i];
      await recordUsage(name, stats.attempts);

      if (fetchResults[i].status === 'rejected') {
        console.error(`[index] ${name} fetch failed:`, fetchResults[i].reason?.message);
      } else if (stats.queries > 0 && stats.failures === stats.queries) {
        console.error(`[index] ${name}: ALL ${stats.queries} quer${stats.queries === 1 ? 'y' : 'ies'} failed — 0 jobs from this source this scan. Last error: ${stats.lastError}`);
      }
    }

    apiJobs = fetchResults
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    console.log(`Fetched ${apiJobs.length} raw listings across ${sources.length} API source(s)`);
  }

  const raw = [...portalJobs, ...apiJobs];
  console.log(`${raw.length} total raw jobs (portals: ${portalJobs.length}, API: ${apiJobs.length})`);

  // ── Pipeline ──────────────────────────────────────────────────────────────
  const unique = await dedup(raw);
  console.log(`${unique.length} unique jobs after deduplication`);

  const filtered = preFilter(unique, config);
  console.log(`${filtered.length} jobs passed pre-filter`);

  if (filtered.length === 0) {
    console.log('No new jobs to evaluate. Exiting.');
    return;
  }

  // ── Evaluation (wrapped so a Claude API error doesn't discard portal results) ──
  let evaluated = [];
  try {
    evaluated = await evaluateJobs(filtered, config);
    const portalEvaluated = evaluated.filter(j => j.source === 'portal').length;
    const apiEvaluated = evaluated.filter(j => j.source !== 'portal').length;
    console.log(`[index] Portal jobs evaluated: ${portalEvaluated} | API jobs evaluated: ${apiEvaluated} | Total: ${evaluated.length}`);
  } catch (err) {
    console.error(`[index] evaluateJobs failed: ${err.message} — continuing with any partial results`);
    // evaluated stays [] if evaluateJobs threw before returning — partial results from
    // inside evaluateJobs are already handled per-job there (each job has its own try/catch)
  }

  // ── Always persist and notify even if evaluation errored ─────────────────
  if (evaluated.length > 0) {
    // Persist FIRST. markScored writes seen-jobs.json so a job is never
    // re-surfaced; if we marked-seen before persisting and the persist then
    // failed, the job would be silently lost (never saved, never re-scanned).
    // So persist first and only mark-seen after it succeeds.
    let persisted = false;
    try {
      await persistJobs(evaluated);
      persisted = true;
    } catch (err) {
      console.error(`[index] persistJobs failed: ${err.message} — NOT marking jobs seen, so they retry next scan`);
    }

    // Mark scored in seen-jobs.json ONLY after a successful persist.
    if (persisted) {
      try {
        // Exclude Stage-2 (Sonnet) scoring FAILURES from the marked-scored set so
        // they re-surface next run. A failed job comes back with score:null and no
        // stage1Filtered marker; marking it scored would drop it permanently (never
        // re-evaluated). Stage-1-filtered jobs (stage1Filtered:true) ARE marked —
        // they're clear non-fits and re-filtering them every run wastes Haiku spend.
        const toMark = evaluated.filter(wasScoredOrFiltered);
        const unmarkedForRetry = evaluated.length - toMark.length;
        if (unmarkedForRetry > 0) {
          console.log(`[index] ${unmarkedForRetry} job(s) had Stage-2 scoring failures — left unmarked so they retry next run`);
        }
        const evaluatedFingerprints = toMark.map(j => j._fingerprint).filter(Boolean);
        if (evaluatedFingerprints.length > 0) await markScored(evaluatedFingerprints);
      } catch (err) {
        console.error(`[index] markScored failed: ${err.message}`);
      }
    }

    // Send digest for jobs above score threshold
    try {
      const digestJobs = evaluated.filter(j => j.score !== null && j.score >= config.minScoreToIncludeInDigest);
      console.log(`${evaluated.filter(j => j.score !== null).length} scored; ${digestJobs.length} at or above threshold (${config.minScoreToIncludeInDigest})`);
      if (digestJobs.length > 0) {
        await sendDigest(digestJobs, config);
        console.log('Digest sent.');
      } else {
        console.log(`No jobs at or above score threshold (${config.minScoreToIncludeInDigest}). No digest sent.`);
      }
    } catch (err) {
      console.error(`[index] sendDigest failed: ${err.message}`);
    }

    // Telegram: daily summary after scan
    try {
      const dailyJobs = evaluated.filter(j => j.score != null && j.score >= config.minScoreToIncludeInDigest);
      if (dailyJobs.length > 0) await sendDailyAlert(dailyJobs);
    } catch (err) {
      console.error(`[index] Telegram notify failed: ${err.message}`);
    }
  } else {
    console.log('[index] No evaluated jobs — skipping persist and digest.');
  }

  console.log('Scan complete.');
}

run().catch(err => {
  // Log but do not exit(1) — a top-level crash should not fail the workflow step.
  // Individual step errors are already caught and logged above.
  console.error('[index] Unexpected top-level error:', err);
});
