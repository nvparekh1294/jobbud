import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmail, buildTrackedFingerprintSet, dropTrackedJobs, digestIsWorthSending, sendDigest } from '../scanner/notify.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../scanner/dedup.mjs';
import { quotaNotice } from '../scanner/quota.mjs';

// ── TASK 1: maxJobsPerDigest cap ────────────────────────────────────────────────
// >20 jobs in → exactly maxJobsPerDigest out, highest scores first, with a
// "+N more matches in the dashboard" count line present in both html and text.
test('buildEmail caps the digest at config.maxJobsPerDigest, highest scores first', () => {
  // 25 jobs, all in the "Apply Now" bucket (>=4.5). Descending distinct scores so
  // the cut is unambiguous: Co0 (4.99) is the top keeper, Co24 (4.75) the first drop.
  const jobs = Array.from({ length: 25 }, (_, i) => ({
    company: `Co${i}`,
    title: `Role ${i}`,
    url: `https://example.com/${i}`,
    score: 5 - i * 0.01,
    _fingerprint: `fp${i}`,
  }));

  const { html, text } = buildEmail(jobs, { maxJobsPerDigest: 20 });

  // Exactly 20 shown (subject/header + text header both read the capped length).
  assert.match(text, /20 new matches/);

  // Count line present: 25 in, 20 shown → 5 held back.
  assert.match(text, /\+5 more matches in the dashboard/);
  assert.match(html, /\+5 more matches in the dashboard/);

  // Sorted by score, highest first: the top-20 companies survive, the 5 lowest drop.
  assert.ok(html.includes('Co0'), 'highest-scoring job kept');
  assert.ok(html.includes('Co19'), 'the 20th-highest job kept');
  assert.ok(!html.includes('Co20'), 'the 21st-highest (below cap) dropped');
  assert.ok(!html.includes('Co24'), 'the lowest-scoring job dropped');
});

test('buildEmail adds no "more" note when the job count is within the cap', () => {
  const jobs = Array.from({ length: 5 }, (_, i) => ({
    company: `Co${i}`, title: `Role ${i}`, url: `https://example.com/${i}`,
    score: 4.9, _fingerprint: `fp${i}`,
  }));
  const { html, text } = buildEmail(jobs, { maxJobsPerDigest: 20 });
  assert.ok(!/more match/.test(html), 'no truncation note when under the cap');
  assert.match(text, /5 new matches/);
});

// ── TASK 2: skip jobs already tracked in the dashboard ──────────────────────────
// job-status.json holds both plain fingerprint keys and `manual::…` keys. Both
// must be matched: the fingerprint key directly, the manual record by recomputing
// its fingerprint from stored company+title.
test('dropTrackedJobs skips jobs already present via fingerprint key OR manual:: record', () => {
  const fpFoo = fingerprint({ company: 'Foo', title: 'Bar' });
  const jobStatusDoc = {
    jobs: {
      // A normal fingerprint-keyed record (owner already applied to it).
      [fpFoo]: { company: 'Foo', title: 'Bar', status: 'applied' },
      // A manual:: record — its key is NOT a fingerprint, so it must be matched
      // by recomputing the fingerprint from the stored company + title.
      'manual::jobboardsgreenhouseio::7736005003': {
        company: 'Zipline', title: 'Chief of Staff', status: 'applied',
      },
    },
  };

  const trackedSet = buildTrackedFingerprintSet(jobStatusDoc);

  const jobs = [
    { company: 'Foo', title: 'Bar', _fingerprint: fpFoo },
    {
      company: 'Zipline', title: 'Chief of Staff',
      _fingerprint: fingerprint({ company: 'Zipline', title: 'Chief of Staff' }),
    },
    {
      company: 'BrandNew Co', title: 'Head of Ops',
      _fingerprint: fingerprint({ company: 'BrandNew Co', title: 'Head of Ops' }),
    },
  ];

  const { kept, dropped } = dropTrackedJobs(jobs, trackedSet);

  assert.equal(dropped, 2, 'both the fingerprint-keyed and manual:: jobs are dropped');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].company, 'BrandNew Co', 'only the genuinely-new job survives');
});

test('buildTrackedFingerprintSet is empty for a doc with no jobs', () => {
  assert.equal(buildTrackedFingerprintSet({}).size, 0);
  assert.equal(buildTrackedFingerprintSet({ jobs: {} }).size, 0);
});

// ── POST-REVIEW FIX (4): this run's own just-persisted jobs must reach the digest ──
// Reproduces the real scanner sequence: persistJobs writes every new job with
// status:'new' BEFORE sendDigest re-reads job-status.json. A this-run 'new' record
// must NOT be treated as tracked (else it gets dropped and the digest is always
// empty); an owner-engaged record (status:'applied') MUST be tracked and dropped;
// a manual:: record is owner-added and tracked whatever its status.
test("buildTrackedFingerprintSet keeps this run's status:'new' jobs but drops engaged + manual records", () => {
  const fpNew      = fingerprint({ company: 'FreshCo', title: 'Head of Ops' });     // (a) this run, status:'new'
  const fpApplied  = fingerprint({ company: 'AppliedCo', title: 'Chief of Staff' }); // (b) owner engaged
  const fpManual   = fingerprint({ company: 'ManualCo', title: 'Founder Associate' }); // (c) manual, status:'new'

  const jobStatusDoc = {
    jobs: {
      [fpNew]:     { company: 'FreshCo',   title: 'Head of Ops',        status: 'new' },
      [fpApplied]: { company: 'AppliedCo', title: 'Chief of Staff',     status: 'applied' },
      'manual::jobboardsgreenhouseio::0001': { company: 'ManualCo', title: 'Founder Associate', status: 'new' },
    },
  };

  const trackedSet = buildTrackedFingerprintSet(jobStatusDoc);

  // (a) this run's freshly-persisted 'new' job is NOT tracked → survives the drop.
  assert.ok(!trackedSet.has(fpNew), "this run's status:'new' job must not be tracked");
  // (b) owner-engaged 'applied' job IS tracked → dropped.
  assert.ok(trackedSet.has(fpApplied), "owner-engaged 'applied' job must be tracked");
  // (c) manual:: record is owner-added → tracked even though its status is 'new'.
  assert.ok(trackedSet.has(fpManual), 'manual:: record must be tracked regardless of status');

  // End-to-end through dropTrackedJobs: only the genuinely-new job reaches the email.
  const jobs = [
    { company: 'FreshCo',   title: 'Head of Ops',        _fingerprint: fpNew },
    { company: 'AppliedCo', title: 'Chief of Staff',     _fingerprint: fpApplied },
    { company: 'ManualCo',  title: 'Founder Associate',  _fingerprint: fpManual },
  ];
  const { kept, dropped } = dropTrackedJobs(jobs, trackedSet);
  assert.equal(dropped, 2, 'engaged + manual dropped');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].company, 'FreshCo', "only this run's new job survives");
});

// ── FIX (4): blank digest — the 3.0–3.79 bucket was computed but never rendered ──
// Jobs scoring 3.0–3.79 pass the upstream minScoreToIncludeInDigest (3.0) and are
// counted in the subject, but the old HTML only rendered Apply Now (>=4.5), Worth
// a Look (3.8–4.4), and Investing (>=3.5). A digest of all-3.1–3.4 operating jobs
// therefore had a real subject count but a blank body. These now land in the new
// "On the Radar" section.
test('buildEmail renders 3.1–3.4 operating jobs in an "On the Radar" section', () => {
  const jobs = Array.from({ length: 5 }, (_, i) => ({
    company: `Co${i}`,
    title: `Role ${i}`,
    url: `https://example.com/${i}`,
    score: 3.1 + i * 0.05, // 3.10, 3.15, 3.20, 3.25, 3.30 — all in the dead zone
    jobType: 'operating',
    _fingerprint: `fp${i}`,
  }));

  const { html, subject } = buildEmail(jobs, { maxJobsPerDigest: 20 });

  assert.match(html, /On the Radar/, 'the On the Radar section header is present');
  const cardCount = (html.match(/class="card /g) || []).length;
  assert.equal(cardCount, 5, 'all 5 dead-zone jobs render as cards (body is not blank)');
  assert.match(subject, /5 new matches/, 'subject counts all 5 jobs');
});

// Guarantee the digest never claims more matches than it shows: the subject count
// must equal the total number of rendered cards across every section, including
// when investing roles and every score tier are mixed together.
test('buildEmail: subject count equals total rendered cards across all sections', () => {
  const jobs = [
    { company: 'A', title: 'Apply', url: 'https://x/a', score: 4.7, jobType: 'operating', _fingerprint: 'a' },
    { company: 'B', title: 'Worth', url: 'https://x/b', score: 4.0, jobType: 'operating', _fingerprint: 'b' },
    { company: 'C', title: 'Radar', url: 'https://x/c', score: 3.2, jobType: 'operating', _fingerprint: 'c' },
    { company: 'D', title: 'Radar2', url: 'https://x/d', score: 3.0, jobType: 'operating', _fingerprint: 'd' },
    // Investing role scoring high — must appear exactly once (Investing section),
    // not double-counted in both Apply Now and Investing.
    { company: 'E', title: 'Invest', url: 'https://x/e', score: 4.8, jobType: 'investing', _fingerprint: 'e' },
    // Investing role in the old dead zone (3.0–3.49) — floor aligned to 3.0.
    { company: 'F', title: 'Invest2', url: 'https://x/f', score: 3.1, jobType: 'investing', _fingerprint: 'f' },
  ];

  const { html, subject } = buildEmail(jobs, { maxJobsPerDigest: 20 });

  const subjectCount = Number(subject.match(/(\d+) new match/)[1]);
  const cardCount = (html.match(/class="card /g) || []).length;
  assert.equal(subjectCount, jobs.length, 'subject counts every job');
  assert.equal(cardCount, subjectCount, 'exactly one card rendered per counted job');
});

// ── Quota notices ───────────────────────────────────────────────────────────────
// A digest thinned by a paused API source is indistinguishable from a digest
// thinned by a quiet week, and the user can only act on one of them. index.mjs
// puts one line per affected source in config.quotaNotices; the digest shows them.
test('buildEmail shows a quota notice above the matches, in html and text', () => {
  const jobs = [{ company: 'A', title: 'Head of Ops', url: 'https://x/a', score: 4.7, _fingerprint: 'a' }];
  const notice = "Adzuna: paused until September 7 — this month's API allowance is used up.";

  const { html, text } = buildEmail(jobs, { maxJobsPerDigest: 20, quotaNotices: [notice] });

  assert.ok(html.includes('paused until September 7'), 'the html digest carries the line');
  assert.ok(text.includes(notice), 'so does the plain-text digest');
  assert.ok(html.indexOf('paused until September 7') < html.indexOf('Head of Ops'),
    'the notice sits above the matches, where it will be read');
});

test('buildEmail shows a partial-run notice and can show more than one', () => {
  const jobs = [{ company: 'A', title: 'Head of Ops', url: 'https://x/a', score: 4.7, _fingerprint: 'a' }];
  const notices = [
    "JSearch: paused until September 7 — this month's API allowance is used up.",
    'Adzuna: searched 8 of 35 role-and-city combinations this scan, rotating through the rest over the next few scans to stay inside the monthly API allowance.',
  ];

  const { html } = buildEmail(jobs, { maxJobsPerDigest: 20, quotaNotices: notices });

  assert.ok(html.includes('searched 8 of 35'));
  assert.ok(html.includes('JSearch: paused'));
});

test('buildEmail adds nothing when no source was skipped or cut short', () => {
  const jobs = [{ company: 'A', title: 'Head of Ops', url: 'https://x/a', score: 4.7, _fingerprint: 'a' }];
  const { html } = buildEmail(jobs, { maxJobsPerDigest: 20 });
  assert.ok(!/class="quota-notice"/.test(html), 'no notice block on a clean run');
});

// ── The wording itself ──────────────────────────────────────────────────────────
// Shared with the scan log so the email and the Actions run never disagree.
test('quotaNotice names the source, the state, and the date it comes back', () => {
  const paused = quotaNotice('Adzuna', { resetDate: '2026-09-07' });
  assert.match(paused, /^Adzuna: paused until September 7/);
  assert.match(paused, /allowance is used up/);

  const partial = quotaNotice('Adzuna', { ran: 8, total: 35 });
  assert.match(partial, /searched 8 of 35/);
  assert.doesNotMatch(partial, /paused/, 'a partial run is not a pause');
});

test('quotaNotice still reads as a sentence when there is no reset date', () => {
  assert.equal(quotaNotice('Adzuna', {}), "Adzuna: paused — this month's API allowance is used up.");
});

// "Used up" was said for any source that could not run in full, including a
// source with most of its allowance intact and merely not a whole scan's worth.
// A user who checks that sentence against the provider's dashboard finds it
// does not match, and stops trusting the rest of the digest.
test('quotaNotice does not claim the allowance is gone when some of it is left', () => {
  const notice = quotaNotice('JSearch', { remaining: 6, needed: 22, resetDate: '2026-09-07' });

  assert.match(notice, /^JSearch: paused/);
  assert.doesNotMatch(notice, /used up/, 'six calls left is not an allowance used up');
  assert.match(notice, /only 6 of the ~22/, 'it says how short it is');
  assert.match(notice, /resumes September 7/);
});

test('quotaNotice says "used up" only when there really is nothing left', () => {
  assert.match(quotaNotice('JSearch', { remaining: 0, needed: 22, resetDate: '2026-09-07' }),
    /allowance is used up/);
  // A source that CAN run in full is not reported at all, but if a caller asks,
  // the fallback sentence must not invent a shortfall.
  assert.match(quotaNotice('JSearch', { remaining: 22, needed: 22 }), /allowance is used up/);
});

// ── A quota notice is reason enough to send ─────────────────────────────────────
//
// The notices were unreachable exactly when they mattered. Three gates in
// scanner/index.mjs each required jobs — the all-sources-skipped early return,
// the nothing-survived-pre-filter return, and the digest step's own
// digestJobs.length > 0 — so a scan with Adzuna paused and zero matches sent
// nothing, and the user's only signal that a source had gone dark was a digest
// that never arrived.

test('a scan with nothing to show but something to say is still worth sending', () => {
  const notice = "Adzuna: paused until September 7 — this month's API allowance is used up.";
  assert.equal(digestIsWorthSending([], [notice]), true);
});

test('a scan with neither matches nor notices stays silent', () => {
  assert.equal(digestIsWorthSending([], []), false);
  assert.equal(digestIsWorthSending(), false, 'the empty-argument case is the same answer');
});

// News, not noise. A profile bigger than one run's slice rotates on EVERY run,
// so if the routine rotation line could summon a digest, a quiet week would
// deliver an otherwise-empty "no new matches" email every single scan — which
// is how a user learns to stop opening the digest at all. Only the pause-class
// notices, the ones the user can act on, are worth an email by themselves.
test('a routine rotation line never summons a digest of its own', () => {
  const rotation = quotaNotice('Adzuna', { ran: 50, total: 80 });
  const pause = quotaNotice('Adzuna', { resetDate: '2026-09-07' });

  // index.mjs passes the pause-class subset, so a rotation-only scan arrives here
  // with an empty list.
  assert.equal(digestIsWorthSending([], []), false, 'rotation alone sends nothing');
  assert.equal(digestIsWorthSending([], [pause]), true, 'a pause still does');

  // But the rotation line still rides along in a digest that goes out anyway.
  const jobs = [{ company: 'A', title: 'Head of Ops', url: 'https://x/a', score: 4.7, _fingerprint: 'a' }];
  const { html } = buildEmail(jobs, { maxJobsPerDigest: 20, quotaNotices: [rotation] });
  assert.ok(html.includes('searched 50 of 80'));
});

test('index sends on the pause-class notices only, and shows all of them', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const whole = readFileSync(join(__dirname, '..', 'scanner', 'index.mjs'), 'utf8');
  const src = whole.slice(whole.indexOf('async function run()'));

  // The digest gets every line; the send decision gets only the pause list.
  assert.match(src, /config\.quotaNotices = quotaNotices/);
  assert.match(src, /digestIsWorthSending\(digestJobs, pauseNotices\)/);

  // The rotation notice is the one push that must NOT be pause-class.
  const rotation = src.slice(src.indexOf('adzunaStats.window && adzunaStats.window.ran > 0'));
  const body = rotation.slice(0, rotation.indexOf('\n    }'));
  assert.ok(body.includes('quotaNotices.push('), 'the rotation line still reaches the digest');
  assert.ok(!body.includes('notePause('), 'but it must never be able to summon one');
});

test('a no-match digest says so, above the notice that explains why', () => {
  const notice = "Adzuna: paused until September 7 — this month's API allowance is used up.";
  const { html, text, subject } = buildEmail([], { maxJobsPerDigest: 20, quotaNotices: [notice] });

  assert.match(subject, /0 new matches/);
  assert.ok(html.includes('No new matches this scan.'), 'the html body says what happened');
  assert.ok(text.includes('No new matches this scan.'), 'so does the plain-text body');
  assert.ok(html.includes('paused until September 7'), 'and the notice explaining why is there too');
  assert.ok(html.indexOf('No new matches this scan.') < html.indexOf('paused until September 7'),
    'what happened comes before why');
});

test('a digest with matches carries no empty-state line', () => {
  const jobs = [{ company: 'A', title: 'Head of Ops', url: 'https://x/a', score: 4.7, _fingerprint: 'a' }];
  const { html, text } = buildEmail(jobs, { maxJobsPerDigest: 20 });
  assert.ok(!html.includes('No new matches this scan.'));
  assert.ok(!text.includes('No new matches this scan.'));
});

test('the notice-only email really reaches the sender, notice intact', async () => {
  const notice = "Adzuna: paused until September 7 — this month's API allowance is used up.";
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realWarn = console.warn;
  let posted = null;
  globalThis.fetch = async (url, opts) => {
    posted = JSON.parse(opts.body);
    return { ok: true, text: async () => '' };
  };
  console.log = () => {};
  console.warn = () => {};
  try {
    await sendDigest([], {
      sendgridApiKey: 'sg-key',
      recipientEmail: 'user@example.com',
      maxJobsPerDigest: 20,
      quotaNotices: [notice],
    });
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.warn = realWarn;
  }

  assert.ok(posted, 'an email was actually sent for a scan with no jobs in it');
  const bodies = posted.content.map(c => c.value).join('\n');
  assert.ok(bodies.includes('paused until September 7'), 'the notice survives all the way to SendGrid');
  assert.ok(bodies.includes('No new matches this scan.'));
});

// ── The scanner routes every exit through the same decision ────────────────────
// index.mjs runs its scan on import, so its wiring is asserted against the
// source text, the way the other scanner-wiring tests here do it.

test('every exit from a scan goes through the one digest decision', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const whole = readFileSync(join(__dirname, '..', 'scanner', 'index.mjs'), 'utf8');
  // The real scan only — runDryRun is a fixture harness with no quota state and
  // no notices, and its own jobs-only rule there is correct.
  const src = whole.slice(whole.indexOf('async function run()'));
  assert.ok(src.length > 0, 'run() moved — this guard needs repointing');

  // Attached before anything can return, and by reference, so a notice pushed
  // later still reaches the digest builder.
  const attach = src.indexOf('config.quotaNotices = quotaNotices');
  assert.ok(attach > -1, 'index no longer attaches the notices to the config');
  assert.ok(attach < src.indexOf('All sources skipped and no portal jobs'),
    'the notices must be attached before the first early return');

  // No exit may send (or decline to send) on its own terms.
  assert.match(src, /async function deliverDigest\(digestJobs\)/);
  assert.match(src, /digestIsWorthSending\(digestJobs, pauseNotices\)/);
  const calls = src.match(/await deliverDigest\(/g) || [];
  assert.equal(calls.length, 4, 'all four scan exits route through deliverDigest');
  assert.doesNotMatch(src, /if \(digestJobs\.length > 0\)/, 'the jobs-only gate is gone');
  assert.equal((src.match(/await sendDigest\(/g) || []).length, 1,
    'sendDigest is called from exactly one place');
});
