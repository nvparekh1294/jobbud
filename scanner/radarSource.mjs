/**
 * radarSource.mjs
 *
 * Treats the user's Company Radar (data/radar.json) as an additional portal
 * source. Companies the user has toggled on (scannerEnabled === true) and mapped
 * to a scrapable ATS board are run through the SAME ATS fetch + normalize logic
 * as portals.yml (scanner/portalScanner.mjs → scanCompanies), so their jobs flow
 * into the existing dedup → filter → evaluate → persist → digest pipeline
 * unchanged. This is purely additive: nothing here touches portals.yml or the
 * scoring/dedup logic.
 *
 * Data contract: data/radar.json is USER-LAYER data. We read it directly rather
 * than syncing radar companies into portals.yml (a system-layer file), so user
 * data never lands in a system file and radar stays the single source of truth
 * for radar companies.
 *
 * Cadence: RADAR_CADENCE controls which companies a given run includes.
 *   all    → every enabled company (default; manual runs and dry runs)
 *   daily  → only scanFrequency === 'daily'
 *   weekly → only scanFrequency === 'weekly'
 * The daily workflow sets RADAR_CADENCE=daily; a weekly trigger sets it to weekly.
 *
 * ATS mapping: a radar company needs atsBoard (greenhouse | ashby | lever) plus
 * atsSlug to be scrapable. Companies missing that mapping are skipped with a
 * clear log line so the user knows to fill it in — they are never guessed at.
 */

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { scanCompanies } from './portalScanner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RADAR_PATH = path.join(__dirname, '../data/radar.json');

// ATS boards the radar source can scrape. greenhouse/ashby/lever resolve from a
// single slug; workday/custom need extra config we don't collect on radar, so
// they're treated as "not mapped" and skipped.
const SUPPORTED_ATS = ['greenhouse', 'ashby', 'lever'];

/**
 * Read enabled, ATS-mapped radar companies that match the cadence and scan them.
 * Returns normalized jobs (source:'portal') ready for the existing pipeline.
 *
 * @param {{ cadence?: string }} [opts] — 'all' | 'daily' | 'weekly' (default 'all')
 */
export async function fetchRadar({ cadence = 'all' } = {}) {
  let radar;
  try {
    const raw = await fs.readFile(RADAR_PATH, 'utf8');
    radar = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('[radar] data/radar.json not found — no radar companies to scan');
    } else {
      console.error('[radar] Failed to read data/radar.json:', err.message);
    }
    return [];
  }

  const all = Object.values(radar?.companies || {});
  if (all.length === 0) return [];

  const cadenceNorm = String(cadence).toLowerCase();
  const configs = [];

  for (const c of all) {
    if (!c.scannerEnabled) continue;

    // Cadence gate — 'all' lets everything through; otherwise match scanFrequency.
    if (cadenceNorm !== 'all' && (c.scanFrequency || 'daily') !== cadenceNorm) continue;

    const atsBoard = (c.atsBoard || '').toLowerCase();
    const atsSlug = (c.atsSlug || '').trim();

    if (!SUPPORTED_ATS.includes(atsBoard) || !atsSlug) {
      console.log(`[radar] ${c.company}: scanner on but no ATS board mapping (atsBoard/atsSlug) — skipping. Set it on the dashboard to enable scanning.`);
      continue;
    }

    configs.push({
      name: c.company,
      ats: atsBoard,
      ats_id: atsSlug,
      keywords: [],            // radar companies are user-curated — no keyword narrowing
      category: 'radar',
      stealth: false,
    });
  }

  if (configs.length === 0) {
    console.log(`[radar] No mapped radar companies match cadence '${cadenceNorm}' — nothing to scan`);
    return [];
  }

  console.log(`[radar] ${configs.length} radar company(ies) to scan (cadence: ${cadenceNorm})`);
  return scanCompanies(configs, { label: 'radar' });
}
