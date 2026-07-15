import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export async function dedup(jobs) {
  const seenPath = './data/seen-jobs.json';
  const seen = await loadSeen(seenPath);
  const { unique, newSeen } = dedupAgainstSeen(jobs, seen);
  await saveSeen(seenPath, newSeen);
  return unique;
}

// Pure dedup core (no file I/O) — testable in isolation.
// Given this run's raw jobs and the persisted `seen` map, returns the jobs to
// evaluate plus the updated seen map.
//
// Two distinct dedup concerns are handled here:
//   1. Cross-run: skip a job already seen AND scored (scored: true / legacy no
//      field). Re-surface a prior-run scored:false entry (seen but capped before
//      Claude could evaluate it) so it gets a second chance.
//   2. In-batch: the SAME job appearing twice within THIS run's raw list must
//      survive only once. A first occurrence writes a fresh scored:false entry,
//      so without per-run tracking the second occurrence would read that
//      just-written scored:false entry and pass too — double-scoring the same job
//      at real API cost. `batchSeen` guarantees at most one survivor per run.
export function dedupAgainstSeen(jobs, seen) {
  const unique = [];
  const newSeen = { ...seen };
  const batchSeen = new Set();

  for (const job of jobs) {
    const fp = fingerprint(job);

    // In-batch guard: a repeat within this same run is always dropped, whether it
    // was brand-new (first occurrence wrote scored:false) or a prior-run resurface.
    if (batchSeen.has(fp)) {
      continue;
    }
    batchSeen.add(fp);

    const existing = newSeen[fp];

    // Skip if already seen AND already evaluated (scored: true).
    // Re-surface if scored: false (was seen but capped before Claude could evaluate it).
    // Legacy entries without a scored field are treated as already evaluated — don't re-surface.
    if (existing && existing.scored !== false) {
      continue;
    }

    // Only write a new entry if this job hasn't been seen before.
    // If it already exists with scored: false, leave the entry alone — markScored will update it.
    if (!existing) {
      newSeen[fp] = {
        seenAt: new Date().toISOString(),
        title: job.title,
        company: job.company,
        scored: false,
      };
    }

    unique.push({ ...job, _fingerprint: fp });
  }

  return { unique, newSeen };
}

export async function markScored(fingerprints) {
  const seenPath = './data/seen-jobs.json';
  const seen = await loadSeen(seenPath);
  for (const fp of fingerprints) {
    if (seen[fp]) {
      seen[fp] = { ...seen[fp], scored: true };
    }
  }
  await saveSeen(seenPath, seen);
}

export function fingerprint(job) {
  const company = normalizeCompany(job.company || '');
  const title   = normalizeTitle(job.title || '');

  // Location intentionally excluded from the fingerprint.
  // Greenhouse portal listings return an empty location field while the
  // same job from an API source returns "San Francisco, CA" — identical
  // jobs produce different hashes when location is included.
  // Company + normalized title is sufficient to identify duplicates.
  const raw = `${company}::${title}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function normalizeCompany(company) {
  return normalize(company)
    // Strip leading articles
    .replace(/^the\s+/, '')
    // Strip common legal suffixes
    .replace(/\s+(inc|llc|ltd|corp|corporation|company|co|group|holdings|capital|ventures|partners)\s*$/, '')
    .trim();
}

export function normalizeTitle(title) {
  // Normalize & → and before stripping non-alphanum, so "Strategy & Ops" and "Strategy and Ops" match
  return normalize(title.replace(/&/g, 'and'))
    .replace(/^(senior|sr|junior|jr|lead|principal|staff|vp|svp|evp|head of|director of)\s+/i, '')
    .trim();
}

async function loadSeen(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const pruned = {};
    for (const [fp, entry] of Object.entries(data)) {
      if (new Date(entry.seenAt).getTime() > cutoff) {
        pruned[fp] = entry;
      }
    }
    return pruned;
  } catch {
    return {};
  }
}

async function saveSeen(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}
