// Unit test for scanner/remind.mjs nudge dedup.
//
// Before this fix only the two 'preparing' nudges wrote once-only markers; the
// unactioned-24h (section 5), unactioned-72h (section 6) and saved-24h/48h (sections
// 7–8) emails re-sent on EVERY run — the owner got identical emails from a manual
// dispatch and the daily cron a few hours apart. These nudges now write per-job,
// per-nudge-type markers with a 20h minimum re-send interval. This test runs the
// SAME context twice and asserts the second run sends nothing.
//
// remind.mjs captures GH_TOKEN / SENDGRID_API_KEY at import and self-invokes
// runReminders() once. We set env + install a stateful GitHub + SendGrid fetch mock
// BEFORE importing, so the import-time auto-run is harmless (empty job set) and every
// GitHub read/write and email send is intercepted and counted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GH_TOKEN = 'test-token';
process.env.GH_REPO = 'owner/repo';
process.env.SENDGRID_API_KEY = 'test-sendgrid';     // makes sendEmail actually POST → countable
process.env.VERCEL_URL = 'https://example.test';
process.env.DASHBOARD_PASSWORD = 'pw';
process.env.ACTION_TOKEN_SECRET = 'secret';
delete process.env.GITHUB_REF_NAME;                  // write/read default to 'main'

// Shared mutable "GitHub file" the mock reads and writes, so markers written on run 1
// persist into run 2 exactly as they would in production.
const store = { doc: { jobs: {} } };
const counts = { sendgrid: 0, contentsReads: 0 };
// Test hook: called with the 1-based read count AFTER the response snapshot is
// serialized, so a mutation made inside it is visible to the NEXT read but not to
// this one — exactly a concurrent dashboard commit landing between two reads.
const hooks = { onContentsRead: null };

const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => obj, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
});

const ghMock = (() => {
  const s = { blobs: new Map(), treeBlob: new Map(), commitBlob: new Map(), seq: 0, headSha: 'commit-0' };
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (url.includes('api.sendgrid.com')) { counts.sendgrid += 1; return jsonRes({}, 202); }
    if (url.includes('/contents/')) {
      const snapshot = Buffer.from(JSON.stringify(store.doc)).toString('base64');
      counts.contentsReads += 1;
      if (hooks.onContentsRead) hooks.onContentsRead(counts.contentsReads);
      return jsonRes({ content: snapshot, encoding: 'base64' });
    }
    if (url.endsWith('/git/blobs') && method === 'POST') {
      const sha = `blob-${++s.seq}`; s.blobs.set(sha, Buffer.from(body.content, 'base64').toString('utf8')); return jsonRes({ sha });
    }
    if (url.includes('/git/ref/heads/') && method === 'GET') return jsonRes({ object: { sha: s.headSha } });
    if (url.includes('/git/commits/') && method === 'GET') return jsonRes({ tree: { sha: `tree-of-${url.split('/').pop()}` } });
    if (url.endsWith('/git/trees') && method === 'POST') { const sha = `tree-${++s.seq}`; s.treeBlob.set(sha, body.tree[0].sha); return jsonRes({ sha }); }
    if (url.endsWith('/git/commits') && method === 'POST') { const sha = `commit-${++s.seq}`; s.commitBlob.set(sha, s.treeBlob.get(body.tree)); return jsonRes({ sha }); }
    if (url.includes('/git/refs/heads/') && method === 'PATCH') {
      store.doc = JSON.parse(s.blobs.get(s.commitBlob.get(body.sha))); s.headSha = body.sha; return jsonRes({ ref: 'refs/heads/main' });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
})();

global.fetch = ghMock;

const { runReminders } = await import('../scanner/remind.mjs');
// Let the import-time auto-run (empty job set) settle, then reset the counter.
await new Promise(r => setTimeout(r, 20));

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const H = 60 * 60 * 1000;

test('nudge emails dedup: identical context run twice → second run sends nothing', async () => {
  counts.sendgrid = 0;
  // One job qualifying for each of the four previously-undeduped nudge types.
  store.doc = {
    jobs: {
      u24: { status: 'new',   score: 4.5, company: 'Acme',  title: 'Unactioned 24h',  url: 'https://x/u24', firstSeenAt: iso(30 * H) },
      u72: { status: 'new',   score: 4.5, company: 'Beta',  title: 'Unactioned 72h',  url: 'https://x/u72', firstSeenAt: iso(100 * H) },
      s24: { status: 'saved', score: 4.5, company: 'Gamma', title: 'Saved 24h',       url: 'https://x/s24', savedAt: iso(30 * H),         firstSeenAt: iso(40 * H) },
      s48: { status: 'saved', score: 4.5, company: 'Delta', title: 'Saved 48h',       url: 'https://x/s48', statusUpdatedAt: iso(60 * H), firstSeenAt: iso(70 * H) },
    },
  };

  // ── Run 1: all four nudges fire (section5 email + section6 email + digest). ──
  await runReminders();
  const afterRun1 = counts.sendgrid;
  assert.ok(afterRun1 >= 1, `run 1 should send nudge emails; sent ${afterRun1}`);

  // Every selected job got its dedup marker, persisted through the mocked write.
  for (const [id, marker] of [
    ['u24', 'nudged_unactioned_24h'], ['u72', 'nudged_unactioned_72h'],
    ['s24', 'nudged_saved_24h'],      ['s48', 'nudged_saved_48h'],
  ]) {
    const hist = store.doc.jobs[id].statusHistory || [];
    assert.ok(hist.some(h => h.status === marker), `${id} should carry a ${marker} marker after run 1`);
  }

  // ── Run 2: same context, markers < 20h old → nothing sent. ──
  counts.sendgrid = 0;
  await runReminders();
  assert.equal(counts.sendgrid, 0, `run 2 must send nothing within 20h; sent ${counts.sendgrid}`);
});

test('nudge re-fires once the 20h interval has elapsed', async () => {
  counts.sendgrid = 0;
  // A saved-48h job whose only saved_48h marker is 21h old — past the 20h floor.
  store.doc = {
    jobs: {
      s48: {
        status: 'saved', score: 4.5, company: 'Epsilon', title: 'Saved long ago', url: 'https://x/s48b',
        statusUpdatedAt: iso(80 * H), firstSeenAt: iso(90 * H),
        statusHistory: [{ status: 'nudged_saved_48h', timestamp: iso(21 * H) }],
      },
    },
  };
  await runReminders();
  assert.ok(counts.sendgrid >= 1, `nudge should re-fire after 20h; sent ${counts.sendgrid}`);
  // And a fresh marker is appended (now two markers: the old 21h one + a new one).
  const marks = (store.doc.jobs.s48.statusHistory || []).filter(h => h.status === 'nudged_saved_48h');
  assert.equal(marks.length, 2, 'a new marker is recorded on the re-fire');
});

// ── remind's save must not clobber a concurrent dashboard change ─────────────────
// saveJobStatus used to write the ENTIRE document from the snapshot loaded at run
// start (string form of writeGithubFile) — any dashboard action committed between
// remind's load and its save was silently reverted. It now uses the builder form:
// re-read the current file and replay ONLY this run's recorded per-job mutations.
// This test injects a dashboard reject between remind's load (contents read #1) and
// its save (the builder's re-read) and asserts BOTH the reject and the nudge marker
// survive. It FAILS under the old string-form save: the snapshot write reverts the
// reject and never performs a second read.
test('a dashboard change landing between remind load and save survives alongside the nudge markers', async () => {
  counts.sendgrid = 0;
  counts.contentsReads = 0;
  store.doc = {
    jobs: {
      // Qualifies for the unactioned-24h nudge → remind will mark and save.
      u24:   { status: 'new', score: 4.5, company: 'Acme', title: 'Unactioned 24h', url: 'https://x/u24', firstSeenAt: iso(30 * H) },
      // Untouched by remind (too young, below score gate) — the dashboard acts on it.
      other: { status: 'new', score: 3.0, company: 'Zeta', title: 'Concurrent target', url: 'https://x/other', firstSeenAt: iso(1 * H) },
    },
  };

  const rejectIso = new Date().toISOString();
  hooks.onContentsRead = (n) => {
    if (n === 1) {
      // Concurrent dashboard action: the owner rejects 'other' AFTER remind loaded
      // its snapshot but BEFORE remind saves. (The hook runs after read #1's response
      // is serialized, so remind's snapshot does NOT contain this change.)
      store.doc.jobs.other.status = 'rejected_by_me';
      store.doc.jobs.other.statusUpdatedAt = rejectIso;
      store.doc.jobs.other.statusHistory = [{ status: 'rejected_by_me', timestamp: rejectIso }];
    }
  };
  try {
    await runReminders();
  } finally {
    hooks.onContentsRead = null;
  }

  // The save must have RE-READ the file (builder form), not written the load snapshot.
  assert.ok(counts.contentsReads >= 2,
    `save must re-read current content instead of writing the load snapshot; saw ${counts.contentsReads} read(s)`);
  // The concurrent dashboard reject survived the save…
  assert.equal(store.doc.jobs.other.status, 'rejected_by_me',
    "concurrent dashboard change was preserved — not reverted by remind's save");
  assert.ok((store.doc.jobs.other.statusHistory || []).some(h => h.status === 'rejected_by_me'),
    "the reject's history entry survived");
  // …AND this run's own nudge marker persisted.
  assert.ok((store.doc.jobs.u24.statusHistory || []).some(h => h.status === 'nudged_unactioned_24h'),
    'the nudge marker from this run persisted alongside the concurrent change');
  assert.ok(counts.sendgrid >= 1, 'the nudge email still sent');
});
