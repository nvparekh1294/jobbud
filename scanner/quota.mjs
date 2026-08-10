import fs from 'fs/promises';
import path from 'path';

const USAGE_PATH = './data/api-usage.json';

async function loadUsage() {
  try {
    const raw = await fs.readFile(USAGE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveUsage(usage) {
  await fs.mkdir(path.dirname(USAGE_PATH), { recursive: true });
  await fs.writeFile(USAGE_PATH, JSON.stringify(usage, null, 2));
}

// One month on from `from`, as the plain YYYY-MM-DD string this file has always
// stored.
function oneMonthOn(from) {
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  return next.toISOString().slice(0, 10);
}

// Bring an entry up to date before anything reads its counter. Returns the SAME
// object when nothing needed doing, so callers can tell whether there is
// anything to write back.
//
// THE BUG THIS REPAIRS. New entries were created with `monthResetDate: null`,
// nothing anywhere set it, and the reset check returned immediately on a null
// date — so `callsThisMonth` was never a month's worth of calls, it was a
// LIFETIME total that only ever grew. The first time it crossed the limit the
// source was skipped, and then it was skipped on every run after that, forever.
// A real user's log: "adzuna: would exceed monthly limit — 235 used + ~28
// estimated = 263 > 250", every run, with no Adzuna jobs in any digest.
//
// So an entry with no reset date is not a new entry: it is a lifetime count that
// cannot be converted into a monthly one. The honest repair is to start its
// month now, drop the number that never meant what it claimed, and say why in
// the log — otherwise the user sees a counter jump to zero with no explanation.
function refreshEntry(entry, source) {
  if (!entry) {
    // A source's first ever run. The month starts today; without this the entry
    // would be written with a null date and inherit the lifetime-counter bug.
    return { callsThisMonth: 0, monthResetDate: oneMonthOn(new Date()), lastScan: null };
  }

  if (!entry.monthResetDate) {
    const migrated = {
      ...entry,
      callsThisMonth: 0,
      monthResetDate: oneMonthOn(new Date()),
      exhausted: false,
    };
    console.log(`[quota] ${source}: this entry had no monthly reset date, so its ${entry.callsThisMonth || 0} recorded calls were a lifetime total rather than a monthly one — starting a fresh month now (next reset: ${migrated.monthResetDate})`);
    return migrated;
  }

  if (new Date() >= new Date(entry.monthResetDate)) {
    const reset = {
      ...entry,
      callsThisMonth: 0,
      monthResetDate: oneMonthOn(entry.monthResetDate),
      exhausted: false,
    };
    console.log(`[quota] ${source}: monthly counter reset (next reset: ${reset.monthResetDate})`);
    return reset;
  }

  return entry;
}

export async function checkQuota(source, estimatedCalls, monthlyLimit) {
  const usage = await loadUsage();
  const stored = usage[source];
  const entry = refreshEntry(stored, source);

  // A reset or a migration has to survive a run that then skips this source —
  // otherwise a stuck user is "repaired" in the log and still stuck on disk,
  // because only a source that actually runs reaches recordUsage.
  if (entry !== stored) {
    usage[source] = entry;
    await saveUsage(usage);
  }

  if (entry.exhausted) {
    console.warn(`[quota] ${source}: marked exhausted until ${entry.monthResetDate} — skipping`);
    return false;
  }

  const projected = (entry.callsThisMonth || 0) + estimatedCalls;
  if (projected > monthlyLimit) {
    console.warn(`[quota] ${source}: would exceed monthly limit — ${entry.callsThisMonth} used + ~${estimatedCalls} estimated = ${projected} > ${monthlyLimit}`);
    return false;
  }

  console.log(`[quota] ${source}: ${entry.callsThisMonth}/${monthlyLimit} used this month, adding ~${estimatedCalls} → OK`);
  return true;
}

export async function recordUsage(source, callsMade) {
  const usage = await loadUsage();
  const entry = { ...refreshEntry(usage[source], source) };

  entry.callsThisMonth = (entry.callsThisMonth || 0) + callsMade;
  entry.lastScan = new Date().toISOString();

  usage[source] = entry;
  await saveUsage(usage);
  console.log(`[quota] ${source}: recorded ${callsMade} calls (total this month: ${entry.callsThisMonth})`);
}
