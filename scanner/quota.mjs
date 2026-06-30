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

function resetIfNeeded(entry, source) {
  if (!entry.monthResetDate) return entry;
  if (new Date() >= new Date(entry.monthResetDate)) {
    const nextReset = new Date(entry.monthResetDate);
    nextReset.setMonth(nextReset.getMonth() + 1);
    const reset = {
      ...entry,
      callsThisMonth: 0,
      monthResetDate: nextReset.toISOString().slice(0, 10),
      exhausted: false,
    };
    console.log(`[quota] ${source}: monthly counter reset (next reset: ${reset.monthResetDate})`);
    return reset;
  }
  return entry;
}

export async function checkQuota(source, estimatedCalls, monthlyLimit) {
  const usage = await loadUsage();
  let entry = usage[source] || { callsThisMonth: 0, monthResetDate: null, lastScan: null };

  entry = resetIfNeeded(entry, source);

  if (entry.exhausted) {
    console.warn(`[quota] ${source}: marked exhausted until ${entry.monthResetDate} — skipping`);
    // Save the reset if it happened
    usage[source] = entry;
    await saveUsage(usage);
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
  let entry = usage[source] || { callsThisMonth: 0, monthResetDate: null, lastScan: null };

  entry = resetIfNeeded(entry, source);
  entry.callsThisMonth = (entry.callsThisMonth || 0) + callsMade;
  entry.lastScan = new Date().toISOString();

  usage[source] = entry;
  await saveUsage(usage);
  console.log(`[quota] ${source}: recorded ${callsMade} calls (total this month: ${entry.callsThisMonth})`);
}
