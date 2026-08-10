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

// How many calls a single run may spend against a monthly budget. A run a day
// is the cadence these sources are built for, so a thirty-first of the month's
// allowance still fits in the longest month. Callers pass their own override
// (an env value) when the user has picked a figure.
//
// Generic on purpose: jsearch and serpapi do not budget per run yet — their
// query lists are small enough to fit whole — and wiring them up later is one
// call each rather than a second copy of this arithmetic.
export function callsPerRun(monthlyLimit, override) {
  const chosen = Number(override);
  if (Number.isFinite(chosen) && chosen > 0) return Math.floor(chosen);
  return Math.max(1, Math.floor(monthlyLimit / 31));
}

// What a source may spend this run: never more than it asked for, never more
// than the month has left.
//
// This returns a NUMBER of allowed calls rather than a yes/no because
// all-or-nothing was itself part of the bug. A source whose full query list did
// not fit was skipped entirely, so a list one call too big produced no jobs at
// all instead of nearly a full run's worth. A caller that genuinely needs its
// whole list can still insist on it by comparing `allowed` against what it
// asked for; a caller that can run part of its list now runs part of it.
export async function checkQuota(source, requestedCalls, monthlyLimit) {
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

  const used = entry.callsThisMonth || 0;
  const budget = { allowed: 0, used, limit: monthlyLimit, resetDate: entry.monthResetDate };

  if (entry.exhausted) {
    console.warn(`[quota] ${source}: marked exhausted until ${entry.monthResetDate} — skipping`);
    return budget;
  }

  budget.allowed = Math.max(0, Math.min(requestedCalls, monthlyLimit - used));

  if (budget.allowed === 0) {
    console.warn(`[quota] ${source}: monthly limit reached — ${used}/${monthlyLimit} used, nothing left until ${entry.monthResetDate}`);
  } else if (budget.allowed < requestedCalls) {
    console.warn(`[quota] ${source}: only ${budget.allowed} of ~${requestedCalls} calls fit in what is left of the month (${used}/${monthlyLimit} used, resets ${entry.monthResetDate})`);
  } else {
    console.log(`[quota] ${source}: ${used}/${monthlyLimit} used this month, adding ~${requestedCalls} → OK`);
  }

  return budget;
}

// Hand out the next slice of a query list that is too big to run in one go, and
// remember where the next run should pick up.
//
// The cursor is advanced HERE, when the window is planned, not after the
// queries have run. A run that dies halfway still moves the window on, so one
// query combination that reliably fails cannot pin the rotation in place and
// starve every other combination. `queryCursor` living in the usage entry means
// deleting it is harmless — the rotation simply restarts at the beginning.
export async function takeQueryWindow(source, totalQueries, maxThisRun) {
  const usage = await loadUsage();
  const entry = { ...refreshEntry(usage[source], source) };

  const cursor = Number(entry.queryCursor);
  const start = Number.isInteger(cursor) && cursor >= 0 ? cursor % totalQueries : 0;
  const count = Math.min(maxThisRun, totalQueries);

  entry.queryCursor = (start + count) % totalQueries;
  usage[source] = entry;
  await saveUsage(usage);

  return { start, count, runsPerRotation: Math.ceil(totalQueries / count) };
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
