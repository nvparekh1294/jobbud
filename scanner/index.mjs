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

import { fetchJSearch } from './sources/jsearch.mjs';
import { fetchAdzuna } from './sources/adzuna.mjs';
import { fetchSerpApi, checkSerpApiBalance } from './sources/serpapi.mjs';
import { fetchPortals } from './portalScanner.mjs';
import { fetchRadar } from './radarSource.mjs';
import { dedup, markScored } from './dedup.mjs';
import { preFilter } from './filter.mjs';
import { evaluateJobs, wasScoredOrFiltered } from './evaluate.mjs';
import { sendDigest } from './notify.mjs';
import { sendDailyAlert } from './telegram.mjs';
import { persistJobs } from './persistJobs.mjs';
import { checkQuota, recordUsage } from './quota.mjs';
import { loadConfig } from './config.mjs';
import { actionKeySource, actionKeyFingerprint } from '../lib/auth.mjs';

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

  const config = await loadConfig();

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
  const adzunaEstimate = config.locations.length * 7;
  const serpApiEstimate = config.locations.length * 4 + (config.includeRemote ? 2 : 0);

  // ── Quota checks (API sources only) ───────────────────────────────────────
  let jsearchOk = false, adzunaOk = false, serpApiOk = false;
  if (runApi) {
    [jsearchOk, adzunaOk] = await Promise.all([
      checkQuota('jsearch', jsearchEstimate, 200),
      checkQuota('adzuna', adzunaEstimate, 250),
    ]);

    if (SCAN_MODE === 'full') {
      serpApiOk = await checkQuota('serpapi', serpApiEstimate, 250);
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
  let portalJobs = [];
  if (runPortals) {
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
  const sources = [];
  if (jsearchOk) sources.push({ name: 'jsearch', fn: () => fetchJSearch(config), estimate: jsearchEstimate });
  else console.warn('[index] JSearch skipped (quota check failed)');

  if (adzunaOk) sources.push({ name: 'adzuna', fn: () => fetchAdzuna(config), estimate: adzunaEstimate });
  else console.warn('[index] Adzuna skipped (quota check failed)');

  if (serpApiOk) sources.push({ name: 'serpapi', fn: () => fetchSerpApi(config), estimate: serpApiEstimate });

  if (sources.length === 0 && portalJobs.length === 0) {
    console.warn('[index] All sources skipped and no portal jobs — nothing to process. Exiting.');
    return;
  }

  let apiJobs = [];
  if (sources.length > 0) {
    const fetchResults = await Promise.allSettled(sources.map(s => s.fn()));

    // Record usage for sources that completed successfully
    for (let i = 0; i < sources.length; i++) {
      if (fetchResults[i].status === 'fulfilled') {
        await recordUsage(sources[i].name, sources[i].estimate);
      } else {
        console.error(`[index] ${sources[i].name} fetch failed:`, fetchResults[i].reason?.message);
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
