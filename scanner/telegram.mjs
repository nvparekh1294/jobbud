// scanner/telegram.mjs
// Telegram Bot API notifications for the scanner pipeline.
// All functions are silent no-ops when TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID
// is not set — never throws, never crashes the scan.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const DASHBOARD_URL = (() => {
  const raw = (process.env.VERCEL_URL || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return raw ? `https://${raw}/dashboard` : null;
})();

// MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
function escapeMd(str) {
  return String(str ?? '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Build a MarkdownV2 clickable link, or plain text fallback.
function dashboardLink(label) {
  if (DASHBOARD_URL) return `[${escapeMd(label)}](${DASHBOARD_URL})`;
  return escapeMd(label);
}

async function send(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'MarkdownV2' }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[telegram] sendMessage failed: ${res.status} — ${body}`);
    }
  } catch (err) {
    console.warn(`[telegram] sendMessage error: ${err.message}`);
  }
}

// A) Daily match alert — call at end of scan if any jobs met threshold.
export async function sendDailyAlert(jobs) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  if (!jobs || jobs.length === 0) return;

  const MAX_SHOWN = 5;
  const shown = jobs.slice(0, MAX_SHOWN);
  const overflow = jobs.length - shown.length;

  const lines = [
    `🟢 *${escapeMd(`JobBud Daily — ${jobs.length} new match${jobs.length !== 1 ? 'es' : ''}`)}*`,
    ...shown.map(j => `• ${escapeMd(j.title)} · ${escapeMd(j.company)} · ${escapeMd(j.score?.toFixed(1))}/5`),
    ...(overflow > 0 ? [`\\.\\.\\.and ${escapeMd(overflow)} more`] : []),
    `↗ ${dashboardLink('Open your dashboard to review')}`,
  ];

  await send(lines.join('\n'));
  console.log(`[telegram] Daily alert sent — ${jobs.length} job(s)`);
}

// B) Weekly digest — call from weeklyDigest.mjs on Monday runs.
export async function sendWeeklyTelegram({ counts, staleSavedCount, responseRate }) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  const pipeline = escapeMd(
    `Pipeline: ${counts.saved} saved · ${counts.preparing} preparing · ${counts.applied} applied · ${counts.interviewing} interviewing`
  );
  const staleNote = staleSavedCount > 0
    ? `⚠️ ${escapeMd(`${staleSavedCount} job${staleSavedCount !== 1 ? 's' : ''} going stale (saved 14+ days, no action)`)}`
    : null;
  const rateNote = responseRate != null
    ? `🔥 ${escapeMd(`Response rate: ${responseRate}%`)}`
    : null;

  const lines = [
    `📊 *${escapeMd('JobBud Weekly')}*`,
    pipeline,
    staleNote,
    rateNote,
    `↗ ${dashboardLink('Open your dashboard')}`,
  ].filter(Boolean);

  await send(lines.join('\n'));
  console.log('[telegram] Weekly digest sent');
}
