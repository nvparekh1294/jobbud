import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmail, buildTrackedFingerprintSet, dropTrackedJobs } from '../scanner/notify.mjs';
import { fingerprint } from '../scanner/dedup.mjs';

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
