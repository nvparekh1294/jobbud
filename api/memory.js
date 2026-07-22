// api/memory.js — persistent per-user memory: read surface + write path.
//
// Actions:
//   GET  ?action=get-memory    → { profile, voice, stories } raw file contents
//                                 ('' for any file that does not exist yet).
//   POST ?action=save-memory   → { file, content } — write ONE memory file
//                                 verbatim ([skip ci] commit). Backs the Memory
//                                 page's per-file Save buttons.
//   POST ?action=update-memory → { eventType, payload } — distill the event into
//                                 the three files with claude-haiku-4-5, merging /
//                                 superseding rather than appending, and write only
//                                 the files that changed ([skip ci] commits).
//
// The write path (update-memory) is designed to be FIRED AND FORGOTTEN by the
// client: the dashboard POSTs it without awaiting, so it never blocks a chat or
// onboarding response. We do NOT use Vercel's waitUntil() — this runtime is the
// classic Node serverless function and does not expose it without adding the
// @vercel/functions dependency; a dedicated non-awaited HTTP request is the
// simpler equivalent and keeps the write off the user-facing response's critical
// path. maxDuration is raised in vercel.json so the Haiku call + commit finish.
//
// PRIVACY: the memory files hold the user's real background, voice, and stories —
// personal content. Every write goes through assertRepoPrivate() first (fails
// CLOSED: if visibility can't be determined, it refuses), exactly like the
// story-bank writes in api/coach.js, so personal memory is never committed to a
// public repo.
//
// Pure logic (assembly, capping, prompts, parsing) lives in lib/memory.mjs so it
// is unit-tested in isolation. This file is the thin I/O shell.

import { readGithubText, writeGithubFile, assertRepoPrivate, RepoPublicError } from '../lib/github.js';
import { safeEqual } from '../lib/auth.mjs';
import {
  MEMORY_KEYS,
  MEMORY_PATHS,
  MEMORY_DISTILL_SYSTEM,
  buildDistillationUserPrompt,
  parseMemoryUpdateResponse,
  resolveMemoryWrites,
} from '../lib/memory.mjs';

const HAIKU_MODEL = 'claude-haiku-4-5';

// ── Auth (identical to api/coach.js) ──────────────────────────────────────────
function checkAuth(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  const headerPw = req.headers['x-dashboard-password'];
  return !!(password && headerPw && safeEqual(headerPw, password));
}

// Soft-read all three memory files. Missing files resolve to '' (readGithubText
// already degrades gracefully), so a new user simply gets three empty strings.
async function readMemoryFiles(githubToken, owner, repo) {
  const [profile, voice, stories] = await Promise.all(
    MEMORY_KEYS.map(k => readGithubText(githubToken, owner, repo, MEMORY_PATHS[k])),
  );
  return { profile, voice, stories };
}

// ── Route: GET ?action=get-memory ─────────────────────────────────────────────
async function handleGetMemory(req, res, githubToken, owner, repo) {
  try {
    const files = await readMemoryFiles(githubToken, owner, repo);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(files);
  } catch (err) {
    console.error('[memory] get-memory error:', err);
    // Degrade gracefully rather than break the coach tab / Memory page.
    return res.status(200).json({ profile: '', voice: '', stories: '' });
  }
}

// ── Route: POST ?action=save-memory ───────────────────────────────────────────
// Direct per-file save from the Memory page ("What JobBud knows about you"). The
// user is editing their own words, so the content is written verbatim. Refuses a
// public repo (fails closed) since memory is personal.
async function handleSaveMemory(req, res, githubToken, owner, repo) {
  const { file, content } = req.body || {};
  if (!MEMORY_KEYS.includes(file)) {
    return res.status(400).json({ error: `file must be one of: ${MEMORY_KEYS.join(', ')}` });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  try {
    await assertRepoPrivate(githubToken, owner, repo);
    const normalized = content.endsWith('\n') ? content : content + '\n';
    // Builder-function write (not string): memory is read-modify-write shared state,
    // so a raw-string write would re-commit a STALE blob on a 422 ref conflict
    // (see lib/github.js). The builder ignores `current` and returns the user's
    // edited content, giving correct last-writer-wins on a FRESH HEAD sha — never a
    // stale-blob overwrite.
    await writeGithubFile(
      githubToken, owner, repo, MEMORY_PATHS[file], () => normalized,
      `chore: update memory ${file} [skip ci]`, { logTag: 'memory' },
    );
    console.log(`[memory] action=save-memory file=${file} bytes=${normalized.length}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof RepoPublicError) {
      console.warn(`[memory] save-memory refused: ${err.message}`);
      return res.status(403).json({ error: err.message, code: 'REPO_PUBLIC' });
    }
    console.error('[memory] save-memory error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

async function anthropicFetch(anthropicKey, payload) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Route: POST ?action=update-memory ─────────────────────────────────────────
// Distill one event into the three files. Fired-and-forgotten by the client, so it
// NEVER throws to the caller in a way that would surface as a user-facing failure:
// on any problem it returns 200 with { updated: [] } and logs, leaving existing
// memory untouched (we would rather skip an update than clobber good memory). A
// public-repo target is refused up front (personal content).
async function handleUpdateMemory(req, res, githubToken, owner, repo) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const { eventType = 'note', payload } = req.body || {};
  console.log(`[memory] action=update-memory eventType=${eventType}`);

  if (!anthropicKey) {
    console.error('[memory] update-memory: ANTHROPIC_API_KEY not configured');
    return res.status(200).json({ updated: [], skipped: true, reason: 'no-api-key' });
  }
  if (payload == null || (typeof payload === 'string' && !payload.trim())) {
    return res.status(200).json({ updated: [], skipped: true, reason: 'empty-payload' });
  }

  try {
    // Personal content — refuse a public repo before doing any work. Fails closed.
    await assertRepoPrivate(githubToken, owner, repo);

    const current = await readMemoryFiles(githubToken, owner, repo);

    const data = await anthropicFetch(anthropicKey, {
      model: HAIKU_MODEL,
      // Must fit all THREE complete files (~10k-token cap) plus JSON-escaping
      // overhead. Too small and every reply truncates once memory grows, silently
      // ending all updates — so budget well above the cap.
      max_tokens: 16000,
      system: MEMORY_DISTILL_SYSTEM,
      messages: [{ role: 'user', content: buildDistillationUserPrompt(eventType, payload, current) }],
    });
    // A truncated reply is NOT a valid file set — never parse/commit a cut-off body.
    if (data.stop_reason === 'max_tokens') {
      console.warn('[memory] update-memory: distillation truncated (stop_reason=max_tokens) — leaving memory unchanged');
      return res.status(200).json({ updated: [], skipped: true, reason: 'truncated' });
    }
    const replyText = data.content?.[0]?.text ?? '';
    const parsed = parseMemoryUpdateResponse(replyText);
    if (!parsed) {
      console.warn('[memory] update-memory: could not parse distillation reply — leaving memory unchanged');
      return res.status(200).json({ updated: [], skipped: true, reason: 'unparseable' });
    }

    // Decide which files to write (caps applied, empty-deletion guard enforced,
    // no-op changes dropped). See lib/memory.mjs resolveMemoryWrites.
    const { writes, skipped } = resolveMemoryWrites(parsed, current);
    for (const [k, reason] of Object.entries(skipped)) {
      if (reason === 'empty-guard') console.warn(`[memory] update-memory: refusing to blank non-empty ${k}`);
    }

    const updated = [];
    for (const k of MEMORY_KEYS) {
      if (!(k in writes)) continue;
      const next = writes[k];
      const base = current[k] || '';

      // Builder-function write (read-modify-write shared state). If a concurrent
      // writer changed this file since we distilled from `base`, we throw to SKIP
      // rather than clobber their change — the merge was computed against a now-stale
      // snapshot. On a 422 ref conflict writeGithubFile re-runs the builder against
      // the fresh content, so this check re-evaluates against the latest HEAD.
      try {
        await writeGithubFile(
          githubToken, owner, repo, MEMORY_PATHS[k],
          (fresh) => {
            if ((fresh ?? '').replace(/\s+$/, '') !== base.replace(/\s+$/, '')) {
              const e = new Error('memory changed concurrently');
              e.code = 'MEMORY_CONCURRENT';
              throw e;
            }
            return next;
          },
          `chore: memory update (${eventType}) — ${k} [skip ci]`, { logTag: 'memory' },
        );
        updated.push(k);
      } catch (e) {
        if (e && e.code === 'MEMORY_CONCURRENT') {
          console.warn(`[memory] update-memory: ${k} changed concurrently — skipped (no clobber)`);
          continue;
        }
        throw e;
      }
    }

    console.log(`[memory] update-memory eventType=${eventType} updated=[${updated.join(',')}]`);
    return res.status(200).json({ updated });
  } catch (err) {
    if (err instanceof RepoPublicError) {
      console.warn(`[memory] update-memory refused: ${err.message}`);
      return res.status(403).json({ error: err.message, code: 'REPO_PUBLIC' });
    }
    console.error('[memory] update-memory error:', err);
    return res.status(200).json({ updated: [], skipped: true, reason: 'error' });
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action } = req.query;
  console.log(`[memory] action=${action} method=${req.method}`);

  const githubToken = process.env.GH_TOKEN;
  const githubRepo  = process.env.GH_REPO;
  if (!githubToken) {
    return res.status(500).json({ error: 'GH_TOKEN not configured' });
  }
  if (!githubRepo) {
    return res.status(500).json({ error: 'GH_REPO not configured' });
  }
  const [owner, repo] = githubRepo.split('/');

  try {
    if (req.method === 'GET'  && action === 'get-memory')    return handleGetMemory(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'save-memory')   return handleSaveMemory(req, res, githubToken, owner, repo);
    if (req.method === 'POST' && action === 'update-memory') return handleUpdateMemory(req, res, githubToken, owner, repo);
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error(`[memory] uncaught error for action=${action}:`, err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
