import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isJobClosed, preFilter } from '../scanner/filter.mjs';

// ── isJobClosed ───────────────────────────────────────────────────────────────
test('isJobClosed detects a bracketed closed marker in the title', () => {
  assert.equal(isJobClosed('Product Manager [closed]', 'Great role'), true);
});

test('isJobClosed detects a closed phrase in the description', () => {
  assert.equal(isJobClosed('Product Manager', 'We are no longer accepting applications.'), true);
});

test('isJobClosed returns false for an open posting', () => {
  assert.equal(isJobClosed('Product Manager', 'Apply today to join our team.'), false);
});

test('isJobClosed only honors bracket markers in the title, not the description', () => {
  // "[closed]" appearing in the description alone must NOT close the job —
  // bracket markers are title-scoped to avoid false positives.
  assert.equal(isJobClosed('Product Manager', 'See the [closed] captions option in settings.'), false);
});

test('isJobClosed edge case: null title and description do not throw and return false', () => {
  assert.equal(isJobClosed(null, null), false);
});

// ── preFilter ─────────────────────────────────────────────────────────────────
const baseConfig = {
  requiredTitleKeywords: ['product', 'operations'],
  excludeTitleKeywords: ['intern', 'contract'],
  dealBreakerIndustries: ['gambling'],
  dealBreakerKeywords: ['unpaid'],
};

const goodJob = {
  title: 'Head of Product',
  company: 'Acme',
  url: 'https://acme.com/jobs/1',
  description: 'A'.repeat(150),
  source: 'api',
};

test('preFilter keeps a well-formed job that matches a required keyword', () => {
  assert.deepEqual(preFilter([goodJob], baseConfig).map(j => j.title), ['Head of Product']);
});

test('preFilter drops a job whose title hits an exclude keyword (whole-word match)', () => {
  const intern = { ...goodJob, title: 'Product Intern' };
  assert.equal(preFilter([intern], baseConfig).length, 0);
});

test('preFilter does not let "intern" exclude "International" (whole-word only)', () => {
  const intl = { ...goodJob, title: 'Head of Product, International' };
  assert.equal(preFilter([intl], baseConfig).length, 1);
});

test('preFilter drops a job with no required-keyword match', () => {
  const offTarget = { ...goodJob, title: 'Software Engineer', description: 'Write code all day.'.padEnd(150, '.') };
  assert.equal(preFilter([offTarget], baseConfig).length, 0);
});

test('preFilter edge case: portal-sourced jobs skip the description-length gate', () => {
  const portalJob = { ...goodJob, description: 'short', source: 'portal' };
  const apiJob = { ...goodJob, description: 'short', source: 'api' };
  assert.equal(preFilter([portalJob], baseConfig).length, 1); // kept despite short desc
  assert.equal(preFilter([apiJob], baseConfig).length, 0);    // dropped for short desc
});
