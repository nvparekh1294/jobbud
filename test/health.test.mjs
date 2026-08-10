// Tests for /api/health — the setup self-diagnosis endpoint.
//
// Every failure class the endpoint claims to name gets a test here, because the
// whole point of this endpoint is that its MESSAGES are correct. A check that
// fires with the wrong sentence is worse than no check: it sends a
// non-technical user to fix the wrong thing.
//
// fetch is mocked at the global, which covers both the direct GitHub calls in
// api/health.js and the ones inside lib/github.js readGithubFile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler, {
  runHealthChecks,
  checkApiQuota,
  checkGithubToken,
  checkGithubRepo,
  checkDataFile,
  findInvalidTokenChar,
  optionalSourcesCheck,
  OPTIONAL_SOURCES,
  HEALTH_NOTE,
} from '../api/health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoFile = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// ── Harness ───────────────────────────────────────────────────────────────────

const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(obj) { this.body = obj; return this; },
});

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Route mock: an array of [urlSubstring, response] pairs, first match wins.
function routeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const [needle, res] of routes) {
      if (String(url).includes(needle)) {
        return typeof res === 'function' ? res() : res;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

async function withFetch(fn, run) {
  const real = global.fetch;
  global.fetch = fn;
  try { return await run(); } finally { global.fetch = real; }
}

const HEALTHY_ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-fake',
  GH_TOKEN: 'ghp_fake',
  GH_REPO: 'nikita/jobbud',
  VERCEL_URL: 'https://jobbud.vercel.app',
};

// Contents-API payload for a file with the given text.
function contentsRes(text) {
  return jsonRes(200, { content: Buffer.from(text, 'utf8').toString('base64'), sha: 'abc' });
}

const HEALTHY_ROUTES = [
  ['/user', jsonRes(200, { login: 'nikita' })],
  ['/repos/nikita/jobbud/contents/data/radar.json', contentsRes('{"companies":{}}')],
  ['/repos/nikita/jobbud/contents/data/job-status.json', contentsRes('{"jobs":{}}')],
  ['/repos/nikita/jobbud/contents/data/api-usage.json', contentsRes('{"adzuna":{"callsThisMonth":143,"monthResetDate":"2026-09-07"}}')],
  ['/repos/nikita/jobbud', jsonRes(200, { private: true, full_name: 'nikita/jobbud' })],
];

const byName = (checks, name) => checks.find(c => c.check === name);

// ── Deployment budget ─────────────────────────────────────────────────────────
//
// Vercel's Hobby plan caps a deployment at 12 serverless functions, and every
// file in api/ is one. Adding /api/health spent a slot, so the ceiling is now
// worth pinning: the 13th endpoint fails the whole DEPLOY, not one request, and
// the error arrives as a build failure with no hint about which file to remove.
test('api/ stays within the 12-function Vercel Hobby limit', () => {
  const fns = readdirSync(join(__dirname, '..', 'api')).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
  assert.ok(
    fns.length <= 12,
    `api/ has ${fns.length} serverless functions; Vercel's Hobby plan allows 12. ` +
      `Merge endpoints behind an ?action= switch (api/coach.js does this) instead of adding a file:\n  ${fns.join('\n  ')}`,
  );
});

// ── Shape contract ────────────────────────────────────────────────────────────

test('every check carries a name, a boolean, and a plain-English message', async () => {
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(HEALTHY_ENV));
  assert.ok(checks.length > 0);
  for (const c of checks) {
    assert.equal(typeof c.check, 'string');
    assert.equal(typeof c.ok, 'boolean');
    assert.equal(typeof c.message, 'string');
    assert.equal(typeof c.fix, 'string');
    assert.ok(c.message.length > 10, `message too short on ${c.check}`);
    // A sentence, not a status-code dump: real words, ending in punctuation.
    assert.match(c.message, /\S+ \S+/, `${c.check} message is not a sentence`);
    assert.match(c.message.trim(), /[.!?]$/, `${c.check} message is not punctuated`);
    assert.equal(typeof c.informational, 'boolean');
    // Every FAILING check must tell the user what to do about it.
    if (!c.ok) assert.ok(c.fix.length > 10, `failing check ${c.check} has no fix text`);
  }
});

test('a fully configured install reports every check green', async () => {
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(HEALTHY_ENV));
  const failures = checks.filter(c => !c.ok);
  assert.deepEqual(failures, [], `expected no failures, got: ${failures.map(f => f.check).join(', ')}`);
  assert.ok(byName(checks, 'github:token').ok);
  assert.ok(byName(checks, 'github:repo').ok);
  assert.ok(byName(checks, 'data:data/radar.json').ok);
  assert.ok(byName(checks, 'data:data/job-status.json').ok);
});

// ── The endpoint never leaks a secret VALUE ───────────────────────────────────

test('no check message or fix ever contains a secret value', async () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-SUPERSECRET',
    GH_TOKEN: 'ghp_SUPERSECRET',
    GH_REPO: 'nikita/jobbud',
    VERCEL_URL: 'https://jobbud.vercel.app',
  };
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(env));
  const blob = JSON.stringify(checks);
  assert.ok(!blob.includes('SUPERSECRET'), 'a secret value leaked into the health output');
});

test('a wrong password response never contains a secret value', async () => {
  process.env.DASHBOARD_PASSWORD = 'correct-horse';
  const res = makeRes();
  await handler({ headers: { 'x-dashboard-password': 'wrong' } }, res);
  assert.ok(!JSON.stringify(res.body).includes('correct-horse'));
  delete process.env.DASHBOARD_PASSWORD;
});

// ── Auth: 200 with a describable failure, never a bare 401 ────────────────────

test('a wrong password returns 200 with a single failed auth check, not a 401', async () => {
  process.env.DASHBOARD_PASSWORD = 'correct-horse';
  const res = makeRes();
  await handler({ headers: { 'x-dashboard-password': 'nope' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.checks.length, 1);
  assert.equal(res.body.checks[0].check, 'auth');
  assert.equal(res.body.checks[0].ok, false);
  assert.match(res.body.checks[0].message, /doesn't match the DASHBOARD_PASSWORD set in Vercel/);
  delete process.env.DASHBOARD_PASSWORD;
});

test('a missing password header returns the same describable auth failure', async () => {
  process.env.DASHBOARD_PASSWORD = 'correct-horse';
  const res = makeRes();
  await handler({ headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.checks[0].check, 'auth');
  assert.equal(res.body.checks[0].ok, false);
  delete process.env.DASHBOARD_PASSWORD;
});

test('an unset DASHBOARD_PASSWORD is reported as its own named problem', async () => {
  delete process.env.DASHBOARD_PASSWORD;
  const res = makeRes();
  await handler({ headers: { 'x-dashboard-password': 'anything' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.checks[0].check, 'auth');
  assert.match(res.body.checks[0].message, /DASHBOARD_PASSWORD is not set in Vercel/);
});

test('the correct password runs the real checks and prepends a passing auth check', async () => {
  process.env.DASHBOARD_PASSWORD = 'correct-horse';
  Object.assign(process.env, HEALTHY_ENV);
  const res = await withFetch(routeFetch(HEALTHY_ROUTES), async () => {
    const r = makeRes();
    await handler({ headers: { 'x-dashboard-password': 'correct-horse' } }, r);
    return r;
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.checks[0].check, 'auth');
  assert.equal(res.body.checks[0].ok, true);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.checks.length > 4, 'the real checks did not run');
  for (const k of ['DASHBOARD_PASSWORD', ...Object.keys(HEALTHY_ENV)]) delete process.env[k];
});

test('the response always carries the GitHub-Actions-side note', async () => {
  process.env.DASHBOARD_PASSWORD = 'correct-horse';
  const res = makeRes();
  await handler({ headers: { 'x-dashboard-password': 'nope' } }, res);
  assert.equal(res.body.note, HEALTH_NOTE);
  assert.match(HEALTH_NOTE, /GitHub Actions/);
  assert.match(HEALTH_NOTE, /two vaults/);
  assert.match(HEALTH_NOTE, /README/);
  delete process.env.DASHBOARD_PASSWORD;
});

// ── Environment checks ────────────────────────────────────────────────────────

test('a missing ANTHROPIC_API_KEY names the symptom the user would actually see', async () => {
  const env = { ...HEALTHY_ENV, ANTHROPIC_API_KEY: '' };
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(env));
  const c = byName(checks, 'env:ANTHROPIC_API_KEY');
  assert.equal(c.ok, false);
  assert.match(c.message, /Coach chat/);
  assert.match(c.fix, /Redeploy/);
});

test('a missing GH_TOKEN fails and stops the GitHub checks from running at all', async () => {
  const env = { ...HEALTHY_ENV, GH_TOKEN: '' };
  const checks = await runHealthChecks(env); // no fetch mock: nothing may call out
  assert.equal(byName(checks, 'env:GH_TOKEN').ok, false);
  assert.equal(byName(checks, 'github:token'), undefined);
  assert.equal(byName(checks, 'github:repo'), undefined);
  assert.equal(byName(checks, 'data:data/radar.json'), undefined);
});

test('a missing GH_REPO fails with the required user/repo form spelled out', async () => {
  const env = { ...HEALTHY_ENV, GH_REPO: '' };
  const checks = await withFetch(routeFetch([['/user', jsonRes(200, {})]]), () => runHealthChecks(env));
  const c = byName(checks, 'env:GH_REPO');
  assert.equal(c.ok, false);
  assert.match(c.message, /does not know which repo/);
  assert.match(c.fix, /yourname\/your-repo/);
  // The repo lookup cannot be attempted without a name.
  assert.equal(byName(checks, 'github:repo'), undefined);
});

test('a GH_REPO that is a URL rather than owner/repo is caught by format', async () => {
  const env = { ...HEALTHY_ENV, GH_REPO: 'https://github.com/nikita/jobbud' };
  const checks = await withFetch(routeFetch([['/user', jsonRes(200, {})]]), () => runHealthChecks(env));
  const c = byName(checks, 'env:GH_REPO');
  assert.equal(c.ok, false);
  assert.match(c.message, /not in the form yourname\/your-repo/);
  assert.match(c.message, /no https:\/\//);
});

// Vercel injects VERCEL_URL itself, always schemeless, on every deployment, and
// a user-set value cannot override it. Failing on the missing scheme nagged
// every single Vercel user with an instruction that could never work.
test('a bare-hostname VERCEL_URL passes — that is the form Vercel itself injects', async () => {
  const env = { ...HEALTHY_ENV, VERCEL_URL: 'jobbud.vercel.app' };
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(env));
  const c = byName(checks, 'env:VERCEL_URL');
  assert.equal(c.ok, true);
  assert.match(c.message, /jobbud\.vercel\.app/);
  assert.match(c.message, /automatically/i);
  // It must not tell the user to go and change the injected value.
  assert.doesNotMatch(c.message, /dead links/);
  assert.doesNotMatch(c.message + c.fix, /Change VERCEL_URL/);
});

test('a schemeful VERCEL_URL passes too', async () => {
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks({ ...HEALTHY_ENV }));
  const c = byName(checks, 'env:VERCEL_URL');
  assert.equal(c.ok, true);
  assert.match(c.message, /https:\/\/jobbud\.vercel\.app/);
  // The wording has to match the value printed beside it. Telling someone
  // "which is why it has no https:// in front" while showing them a value that
  // starts with https:// reads as a broken checker.
  assert.match(c.message, /already includes the scheme/);
  assert.doesNotMatch(c.message, /has no https:\/\/ in front/);
});

// The VERCEL_URL pass carries the only mention of the GitHub Actions copy. The
// setup panel renders failures and informational entries only, so an ok:true
// non-informational check means that sentence is written for nobody.
test('the VERCEL_URL pass is informational, so the setup panel actually shows it', async () => {
  for (const url of ['jobbud.vercel.app', 'https://jobbud.vercel.app']) {
    const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks({ ...HEALTHY_ENV, VERCEL_URL: url }));
    const c = byName(checks, 'env:VERCEL_URL');
    assert.equal(c.ok, true);
    assert.equal(c.informational, true, `VERCEL_URL pass not informational for ${url}`);
  }
});

test('a MISSING VERCEL_URL is a real failure, not an informational note', async () => {
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks({ ...HEALTHY_ENV, VERCEL_URL: '' }));
  const c = byName(checks, 'env:VERCEL_URL');
  assert.equal(c.ok, false);
  assert.equal(c.informational, false);
});

test('a set VERCEL_URL points at the GitHub Actions copy as the one that needs https://', async () => {
  const env = { ...HEALTHY_ENV, VERCEL_URL: 'jobbud.vercel.app' };
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(env));
  const c = byName(checks, 'env:VERCEL_URL');
  assert.match(c.message, /GitHub Actions secrets/);
  assert.match(c.message, /can't check that one/);
});

test('a missing VERCEL_URL still fails and says the email buttons will point at localhost', async () => {
  const env = { ...HEALTHY_ENV, VERCEL_URL: '' };
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(env));
  const c = byName(checks, 'env:VERCEL_URL');
  assert.equal(c.ok, false);
  assert.match(c.message, /localhost/);
  // The fix names BOTH vaults, and does not claim editing the Vercel side
  // replaces the value Vercel injects.
  assert.match(c.fix, /Actions/);
  assert.match(c.fix, /https:\/\//);
  assert.match(c.fix, /will not replace it/);
});

test('a VERCEL_URL problem does not block the GitHub checks — they are independent', async () => {
  const env = { ...HEALTHY_ENV, VERCEL_URL: '' };
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(env));
  assert.equal(byName(checks, 'github:token').ok, true);
  assert.equal(byName(checks, 'github:repo').ok, true);
});

// ── GitHub token ──────────────────────────────────────────────────────────────

// A token copied out of a password manager can carry an invisible character.
// fetch() throws before any request goes out, and the generic catch-all used to
// call that "usually temporary" — a wait that never ends.
test('findInvalidTokenChar spots a non-Latin1 character and where it sits', () => {
  const bad = findInvalidTokenChar('ghp_abcdefghij•klmno');
  assert.equal(bad.index, 14);
  assert.equal(bad.code, 0x2022);
  // Whitespace, smart quotes and line breaks are caught too.
  assert.ok(findInvalidTokenChar('ghp_abc def'));
  assert.ok(findInvalidTokenChar('ghp_abc\n'));
  assert.ok(findInvalidTokenChar('ghp_abc def'));
  assert.equal(findInvalidTokenChar('ghp_ABCdef0123-_'), null);
});

test('a token with an invisible character names the paste bug, not the network', async () => {
  // No fetch mock at all: a token this broken must never reach the network.
  const c = await checkGithubToken('ghp_abcdefghij•klmno');
  assert.equal(c.ok, false);
  assert.match(c.message, /invisible or invalid character/);
  assert.match(c.message, /password manager/);
  assert.match(c.message, /position 15/);
  assert.doesNotMatch(c.fix, /usually temporary/);
  assert.match(c.fix, /delete GH_TOKEN/);
  assert.match(c.fix, /re-paste/);
  assert.match(c.fix, /Redeploy/);
});

test('the runtime ByteString TypeError is reported as the paste bug too', async () => {
  const throwing = async () => {
    throw new TypeError('Cannot convert argument to a ByteString because the character at index 15 has a value of 8226 which is greater than 255.');
  };
  const c = await withFetch(throwing, () => checkGithubToken('ghp_looksclean'));
  assert.equal(c.ok, false);
  assert.match(c.message, /invisible or invalid character/);
  assert.doesNotMatch(c.fix, /usually temporary/);
});

test('a genuine network error still gets the temporary-network message', async () => {
  const throwing = async () => { throw new Error('fetch failed'); };
  const c = await withFetch(throwing, () => checkGithubToken('ghp_clean'));
  assert.equal(c.ok, false);
  assert.match(c.message, /Could not reach GitHub/);
  assert.match(c.fix, /usually temporary/);
});

test('a dead token (GitHub 401) is named as invalid or expired', async () => {
  const c = await withFetch(routeFetch([['/user', jsonRes(401, { message: 'Bad credentials' })]]),
    () => checkGithubToken('ghp_dead'));
  assert.equal(c.ok, false);
  assert.match(c.message, /invalid or expired/);
  assert.match(c.fix, /Redeploy/);
});

test('a rate-limited token (403) is named as rate-limited, not as invalid', async () => {
  const c = await withFetch(routeFetch([['/user', jsonRes(403, {})]]), () => checkGithubToken('ghp_x'));
  assert.equal(c.ok, false);
  assert.match(c.message, /rate-limit/i);
  assert.doesNotMatch(c.message, /invalid or expired/);
});

test('an unexpected GitHub status on the token check still produces a sentence', async () => {
  const c = await withFetch(routeFetch([['/user', jsonRes(500, {})]]), () => checkGithubToken('ghp_x'));
  assert.equal(c.ok, false);
  assert.match(c.message, /500/);
});

test('a network failure reaching GitHub is reported as reachability, not as a bad token', async () => {
  const boom = async () => { throw new Error('ENOTFOUND api.github.com'); };
  const c = await withFetch(boom, () => checkGithubToken('ghp_x'));
  assert.equal(c.ok, false);
  assert.match(c.message, /Could not reach GitHub/);
  assert.doesNotMatch(c.message, /invalid or expired/);
});

test('a dead token stops the repo and data checks from running', async () => {
  const routes = [['/user', jsonRes(401, {})]];
  const checks = await withFetch(routeFetch(routes), () => runHealthChecks(HEALTHY_ENV));
  assert.equal(byName(checks, 'github:token').ok, false);
  assert.equal(byName(checks, 'github:repo'), undefined);
  assert.equal(byName(checks, 'data:data/radar.json'), undefined);
});

// ── GitHub repo access ────────────────────────────────────────────────────────

test('a 404 on the repo gives BOTH possibilities in one message — wrong name or token access', async () => {
  const c = await withFetch(routeFetch([['/repos/nikita/jobbud', jsonRes(404, {})]]),
    () => checkGithubRepo('ghp_x', 'nikita/jobbud'));
  assert.equal(c.ok, false);
  assert.match(c.message, /token works but can't see nikita\/jobbud/);
  assert.match(c.message, /repo name in Vercel is wrong/);
  assert.match(c.message, /repository access list/);
  assert.match(c.message, /deleted-and-recreated/);
  assert.match(c.fix, /Redeploy/);
});

test('the wrong-repo case is what a valid token plus an inaccessible repo produces end to end', async () => {
  const routes = [
    ['/user', jsonRes(200, { login: 'nikita' })],
    ['/repos/nikita/jobbud', jsonRes(404, {})],
  ];
  const checks = await withFetch(routeFetch(routes), () => runHealthChecks(HEALTHY_ENV));
  assert.equal(byName(checks, 'github:token').ok, true);
  assert.equal(byName(checks, 'github:repo').ok, false);
  // The data reads would just come back empty here, which is the silent failure
  // this whole endpoint exists to replace — so they are not run.
  assert.equal(byName(checks, 'data:data/radar.json'), undefined);
});

test('a 403 on the repo is rate-limiting, not a wrong name', async () => {
  const c = await withFetch(routeFetch([['/repos/a/b', jsonRes(403, {})]]),
    () => checkGithubRepo('ghp_x', 'a/b'));
  assert.equal(c.ok, false);
  assert.match(c.message, /403/);
  assert.doesNotMatch(c.message, /repo name in Vercel is wrong/);
});

test('a 401 on the repo lookup is reported as a token problem', async () => {
  const c = await withFetch(routeFetch([['/repos/a/b', jsonRes(401, {})]]),
    () => checkGithubRepo('ghp_x', 'a/b'));
  assert.equal(c.ok, false);
  assert.match(c.message, /invalid or expired/);
});

test('a reachable but PUBLIC repo fails the check and says to make it private', async () => {
  const c = await withFetch(routeFetch([['/repos/a/b', jsonRes(200, { private: false, full_name: 'a/b' })]]),
    () => checkGithubRepo('ghp_x', 'a/b'));
  assert.equal(c.ok, false);
  assert.match(c.message, /PUBLIC repo/);
  assert.match(c.fix, /Make private/);
});

test('a private repo the token can see passes', async () => {
  const c = await withFetch(routeFetch([['/repos/a/b', jsonRes(200, { private: true, full_name: 'a/b' })]]),
    () => checkGithubRepo('ghp_x', 'a/b'));
  assert.equal(c.ok, true);
});

// ── Data files ────────────────────────────────────────────────────────────────

test('an absent data file is normal on a new install, not a failure', async () => {
  const c = await withFetch(routeFetch([['contents/data/radar.json', jsonRes(404, {})]]),
    () => checkDataFile('t', 'a', 'b', 'data/radar.json', { companies: {} }, 'Your Radar'));
  assert.equal(c.ok, true);
  assert.match(c.message, /normal on a new install/);
});

test('the committed empty-array seed is recognised as normal, not as corruption', async () => {
  const c = await withFetch(routeFetch([['contents/data/radar.json', contentsRes('[]')]]),
    () => checkDataFile('t', 'a', 'b', 'data/radar.json', { companies: {} }, 'Your Radar'));
  assert.equal(c.ok, true);
  assert.match(c.message, /empty starter file/);
});

test('a well-formed data file passes', async () => {
  const c = await withFetch(routeFetch([['contents/data/radar.json', contentsRes('{"companies":{"x":{}}}')]]),
    () => checkDataFile('t', 'a', 'b', 'data/radar.json', { companies: {} }, 'Your Radar'));
  assert.equal(c.ok, true);
  assert.match(c.message, /expected shape/);
});

test('the shape check defers to normalizeJsonDoc rather than restating its rules', async () => {
  // The reader and the writer must share one definition of "the right shape".
  // A second, hand-written copy of the rules here would drift the moment
  // normalizeJsonDoc changed, and this endpoint would start calling healthy
  // files corrupt.
  const src = repoFile('api', 'health.js');
  const fn = src.slice(src.indexOf('function shapeMatches'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /normalizeJsonDoc\(/);
  assert.doesNotMatch(body, /Array\.isArray\(empty\)/);

  // and it still answers the same way at the boundaries normalizeJsonDoc cares
  // about: a key present but the wrong container type is a shape failure.
  const wrongType = await withFetch(
    routeFetch([['contents/data/radar.json', contentsRes('{"companies":[]}')]]),
    () => checkDataFile('t', 'a', 'b', 'data/radar.json', { companies: {} }, 'Your Radar'));
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.message, /not in the shape JobBud writes/);

  // ...while extra keys alongside a correct one are none of our business.
  const extraKeys = await withFetch(
    routeFetch([['contents/data/radar.json', contentsRes('{"companies":{"x":{}},"notes":"hi"}')]]),
    () => checkDataFile('t', 'a', 'b', 'data/radar.json', { companies: {} }, 'Your Radar'));
  assert.equal(extraKeys.ok, true);
});

test('unparseable JSON in a data file is named as corruption with a recovery route', async () => {
  const c = await withFetch(routeFetch([['contents/data/radar.json', contentsRes('{not json')]]),
    () => checkDataFile('t', 'a', 'b', 'data/radar.json', { companies: {} }, 'Your Radar'));
  assert.equal(c.ok, false);
  assert.match(c.message, /not valid JSON/);
  assert.match(c.fix, /History/);
});

test('a data file with real content in the wrong shape is named as the silent-empty cause', async () => {
  const c = await withFetch(routeFetch([['contents/data/job-status.json', contentsRes('{"foo":1}')]]),
    () => checkDataFile('t', 'a', 'b', 'data/job-status.json', { jobs: {} }, 'Your job pipeline'));
  assert.equal(c.ok, false);
  assert.match(c.message, /not in the shape JobBud writes/);
  assert.match(c.message, /"jobs" key/);
  assert.match(c.message, /empty/);
});

test('a read that throws is reported rather than swallowed', async () => {
  const c = await withFetch(routeFetch([['contents/data/radar.json', jsonRes(451, { message: 'nope' })]]),
    () => checkDataFile('t', 'a', 'b', 'data/radar.json', { companies: {} }, 'Your Radar'));
  assert.equal(c.ok, false);
  assert.match(c.message, /Could not read data\/radar\.json/);
});

// ── Optional API job sources (informational only) ─────────────────────────────

test('the optional-sources check never fails, so it can never raise the banner', () => {
  for (const env of [{}, { SERP_API_KEY: 'x' }, { JSEARCH_API_KEY: 'x', ADZUNA_APP_ID: 'a', ADZUNA_API_KEY: 'b', SERP_API_KEY: 'c' }]) {
    const c = optionalSourcesCheck(env);
    assert.equal(c.ok, true);
    assert.equal(c.informational, true);
  }
});

test('the optional-sources check names the capability and points at Actions secrets', () => {
  const c = optionalSourcesCheck({});
  assert.match(c.message, /jobs from across the web/);
  assert.match(c.message, /JSearch, Adzuna/);
  // SerpApi's key is not passed through by any workflow, so the hint must say so
  // rather than list it as something to set up.
  assert.match(c.message, /SerpApi is not currently wired to scheduled scans/);
  // It must not claim a key is missing — it cannot see the vault that holds them.
  assert.match(c.message, /GitHub Actions secrets, which this page cannot see/);
  assert.match(c.message, /expected/);
  assert.match(c.fix, /Settings → Secrets and variables → Actions/);
  for (const name of ['JSEARCH_API_KEY', 'ADZUNA_APP_ID', 'ADZUNA_API_KEY']) {
    assert.ok(c.fix.includes(name), `fix text omits ${name}`);
  }
  assert.ok(!c.fix.includes('SERP_API_KEY'), 'the fix text tells users to add a secret no workflow reads');
});

test('Adzuna needs BOTH of its values before it counts as visible', () => {
  assert.doesNotMatch(optionalSourcesCheck({ ADZUNA_APP_ID: 'a' }).message, /Visible to the dashboard: [^.]*Adzuna/);
  assert.match(optionalSourcesCheck({ ADZUNA_APP_ID: 'a', ADZUNA_API_KEY: 'b' }).message, /Visible to the dashboard: Adzuna/);
});

test('the optional-sources check reports presence only, never a value', () => {
  const c = optionalSourcesCheck({ SERP_API_KEY: 'SUPERSECRET', JSEARCH_API_KEY: 'SUPERSECRET' });
  assert.ok(!JSON.stringify(c).includes('SUPERSECRET'));
  assert.match(c.message, /Visible to the dashboard: JSearch\./);
  assert.match(c.message, /Not visible here: Adzuna/);
});

test('the informational check rides along on a full run without failing it', async () => {
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(HEALTHY_ENV));
  const c = byName(checks, 'sources:optional');
  assert.ok(c, 'the optional-sources check is missing from a full run');
  assert.equal(c.ok, true);
  assert.equal(checks.filter(x => !x.ok).length, 0);
});

test('a missing GH_TOKEN still leaves the informational sources check in place', async () => {
  const checks = await runHealthChecks({ ...HEALTHY_ENV, GH_TOKEN: '' });
  assert.ok(byName(checks, 'sources:optional'));
});

// ── Docs for the optional sources ─────────────────────────────────────────────

test('every optional source secret this code knows about is read by a workflow', () => {
  const wfDir = join(__dirname, '..', '.github', 'workflows');
  const workflows = readdirSync(wfDir).map(f => readFileSync(join(wfDir, f), 'utf8')).join('\n');
  for (const src of OPTIONAL_SOURCES) {
    for (const v of src.vars) {
      assert.ok(
        workflows.includes(`secrets.${v}`),
        `SETUP.md and /api/health tell users to add "${v}" as an Actions secret, but no workflow passes secrets.${v} to the scanner — it would silently do nothing`,
      );
    }
  }
});

test('SETUP.md sends the API-source keys to Actions secrets, not to .env or Vercel', () => {
  const setup = repoFile('SETUP.md');
  const section = setup.slice(setup.indexOf('## Optional: API job sources'));
  const body = section.slice(0, section.indexOf('\n---'));
  assert.match(body, /Settings → Secrets and variables → Actions/);
  // .env.example may only be mentioned as a local-development aside.
  assert.match(body, /`\.env\.example`[^\n]*local development/);
  assert.match(body, /Adding them to Vercel does nothing/);
  for (const name of ['JSEARCH_API_KEY', 'ADZUNA_APP_ID', 'ADZUNA_API_KEY']) {
    assert.ok(body.includes(name), `SETUP.md omits ${name}`);
  }
});

// The companion to the OPTIONAL_SOURCES check above, guarding the docs directly:
// the "Where the keys go" table is the list of secrets SETUP.md tells the reader
// to create, so every name in it must actually reach the scanner. SerpApi's
// SERP_API_KEY was removed from that table because the workflow files are frozen
// at the fleet's version for updater deliverability and no longer pass it through.
test('every secret SETUP.md tells users to create is passed through by a workflow', () => {
  const setup = repoFile('SETUP.md');
  const table = setup.slice(setup.indexOf('### Where the keys go'));
  const body = table.slice(0, table.indexOf('\n### ') === -1 ? undefined : table.indexOf('\n### '));
  const names = [...new Set([...body.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map(m => m[1]))];
  assert.ok(names.length >= 3, 'no secret names found in the "Where the keys go" table — did it move?');
  const wfDir = join(__dirname, '..', '.github', 'workflows');
  const workflows = readdirSync(wfDir).map(f => readFileSync(join(wfDir, f), 'utf8')).join('\n');
  for (const name of names) {
    assert.ok(
      workflows.includes(`secrets.${name}`),
      `SETUP.md tells users to add "${name}" as an Actions secret, but no workflow passes secrets.${name} to the scanner — it would silently do nothing`,
    );
  }
});

test('SETUP.md quotes the real skip lines the scanner logs, so the symptom is searchable', () => {
  const setup = repoFile('SETUP.md');
  const sources = readdirSync(join(__dirname, '..', 'scanner', 'sources'))
    .map(f => readFileSync(join(__dirname, '..', 'scanner', 'sources', f), 'utf8')).join('\n');
  for (const line of ['JSearch API key not set -- skipping', 'Adzuna credentials not set -- skipping', 'SerpAPI key not set -- skipping']) {
    assert.ok(sources.includes(line), `scanner no longer logs "${line}" — SETUP.md's symptom section is now wrong`);
    assert.ok(setup.includes(line), `SETUP.md does not quote the real log line "${line}"`);
  }
});

test('SETUP.md names the workflow that actually runs the API sources', () => {
  const setup = repoFile('SETUP.md');
  const wf = repoFile('.github', 'workflows', 'weekly-api-scan.yml');
  const name = (wf.match(/^name:\s*(.+)$/m) || [])[1].trim();
  assert.ok(setup.includes(name), `SETUP.md does not name the "${name}" workflow`);
  assert.match(setup, /Run workflow/);
});

test('the README advertises the API job sources and cross-refs the SETUP section', () => {
  const readme = repoFile('README.md');
  assert.match(readme, /### API job sources/);
  assert.match(readme, /GitHub Actions secrets only/);
  assert.match(readme, /both-vaults rule does \*not\* apply/);

  // The cross-reference must resolve to a real heading in SETUP.md.
  const anchor = (readme.match(/SETUP\.md(#optional-api-job-sources[a-z0-9-]*)\)/) || [])[1];
  assert.ok(anchor, 'README does not link to the SETUP.md API-sources section');
  const slugs = [...repoFile('SETUP.md').matchAll(/^#{2,4} (.+)$/gm)].map(m =>
    m[1].toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-'));
  assert.ok(slugs.includes(anchor.slice(1)), `SETUP.md has no heading for ${anchor}`);
});

// ── API quota status ──────────────────────────────────────────────────────────
//
// A source paused for quota is invisible from outside: the digest just gets
// thinner. These numbers are the only place a user can see it from the
// dashboard, so they have to be there, and they have to be honest about the one
// figure this page cannot see — the limit, which lives in Actions secrets.

test('the quota check reports each source\'s calls and when the count restarts', async () => {
  const c = await withFetch(routeFetch(HEALTHY_ROUTES), () => checkApiQuota('ghp_x', 'nikita', 'jobbud'));
  assert.equal(c.ok, true);
  assert.equal(c.informational, true, 'usage is a fact, not a failure');
  assert.match(c.message, /adzuna: 143 calls this month/);
  assert.match(c.message, /2026-09-07/);
  assert.match(c.message, /cannot read/, 'it says outright that the limit is not visible from here');
});

test('the quota check is quiet on a fresh install with no usage file', async () => {
  const routes = [['/contents/data/api-usage.json', jsonRes(404, {})]];
  const c = await withFetch(routeFetch(routes), () => checkApiQuota('ghp_x', 'nikita', 'jobbud'));
  assert.equal(c.ok, true);
  assert.match(c.message, /No API calls have been counted yet/);
});

test('a corrupt usage file never turns into a scary failure', async () => {
  const routes = [['/contents/data/api-usage.json', contentsRes('{not json')]];
  const c = await withFetch(routeFetch(routes), () => checkApiQuota('ghp_x', 'nikita', 'jobbud'));
  assert.equal(c.ok, true);
  assert.match(c.message, /not valid JSON/);
});

test('the quota check runs as part of a healthy install', async () => {
  const checks = await withFetch(routeFetch(HEALTHY_ROUTES), () => runHealthChecks(HEALTHY_ENV));
  assert.ok(byName(checks, 'quota:api'), 'the quota line is part of the setup report');
});
