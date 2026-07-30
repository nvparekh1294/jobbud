// Tests for the standalone Watch List editor: the GET ?action=get-portals route
// that feeds it, the starter-list detection it shares with the scanner, and the
// dashboard wiring (entry point outside onboarding, radar bridge, shared row
// helpers). DOM behaviour is asserted against the source the same way
// memoryDashboard.test.mjs does — no browser needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStarterPortalsList, PORTALS_GENERATED_MARKER, STARTER_LIST_NOTICE } from '../lib/portalsMeta.mjs';
import { buildPortalsYml } from '../api/coach.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
const starterYml = readFileSync(join(__dirname, '..', 'scanner', 'portals.yml'), 'utf8');

// ── Starter-list detection ────────────────────────────────────────────────────

test('the shipped scanner/portals.yml IS detected as the example list', () => {
  assert.equal(isStarterPortalsList(starterYml), true);
});

test('a generated portals.yml is NOT the example list', () => {
  const { portalsYml } = buildPortalsYml([
    { name: 'Acme', careers_url: 'https://jobs.ashbyhq.com/acme' },
  ]);
  assert.match(portalsYml, new RegExp(PORTALS_GENERATED_MARKER));
  assert.equal(isStarterPortalsList(portalsYml), false);
});

test('a generated file whose header was hand-stripped is still NOT the example list', () => {
  // Second fingerprint: buildPortalsYml stamps category: user on every entry.
  const { portalsYml } = buildPortalsYml([
    { name: 'Acme', careers_url: 'https://jobs.ashbyhq.com/acme' },
  ]);
  const headerless = portalsYml.split('\n').filter(l => !l.startsWith('#')).join('\n');
  assert.doesNotMatch(headerless, new RegExp(PORTALS_GENERATED_MARKER));
  assert.equal(isStarterPortalsList(headerless), false);
});

test('a missing or unreadable portals.yml never triggers the example-list notice', () => {
  assert.equal(isStarterPortalsList(''), false);
  assert.equal(isStarterPortalsList('   \n'), false);
  assert.equal(isStarterPortalsList(null), false);
  assert.equal(isStarterPortalsList(undefined), false);
});

test('the example-list notice is one plain-English line pointing at the editor', () => {
  assert.match(STARTER_LIST_NOTICE, /example company list/);
  assert.match(STARTER_LIST_NOTICE, /Watch List/);
});

// ── GET ?action=get-portals ───────────────────────────────────────────────────

const makeRes = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.statusCode = code; return this; },
  json(obj) { this.body = obj; return this; },
});

function withFetch(fn, run) {
  const real = global.fetch;
  global.fetch = fn;
  return run().finally(() => { global.fetch = real; });
}

const baseEnv = () => {
  process.env.DASHBOARD_PASSWORD = 'pw';
  process.env.GH_TOKEN = 'tok';
  process.env.GH_REPO = 'acme/jobs';
};

const contentsRes = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({ content: Buffer.from(text, 'utf8').toString('base64'), sha: 'b0' }),
  text: async () => '',
});

test('get-portals returns the live file and flags the example list', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  await withFetch(async () => contentsRes(starterYml), async () => {
    const res = makeRes();
    await handler(
      { method: 'GET', query: { action: 'get-portals' }, headers: { 'x-dashboard-password': 'pw' } },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.portalsYml, starterYml);
    assert.equal(res.body.isStarterList, true);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });
});

test('get-portals reports isStarterList:false once the user has their own list', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const { portalsYml } = buildPortalsYml([{ name: 'Acme', careers_url: 'https://jobs.ashbyhq.com/acme' }]);
  await withFetch(async () => contentsRes(portalsYml), async () => {
    const res = makeRes();
    await handler(
      { method: 'GET', query: { action: 'get-portals' }, headers: { 'x-dashboard-password': 'pw' } },
      res,
    );
    assert.equal(res.body.isStarterList, false);
    assert.match(res.body.portalsYml, /Acme/);
  });
});

test('get-portals is auth-gated like every other coach route', async () => {
  baseEnv();
  const { default: handler } = await import('../api/coach.js');
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'get-portals' }, headers: {} }, res);
  assert.equal(res.statusCode, 401);
});

// ── Dashboard wiring ──────────────────────────────────────────────────────────

test('the Watch List editor has an entry point outside onboarding', () => {
  // Lives on the Radar tab toolbar, next to "+ Add Company".
  assert.match(html, /id="radar-watchlist-btn"[^>]*onclick="openWatchList\(\)"/);
  assert.match(html, /id="watchlist-overlay"/);
  assert.match(html, /id="wl-rows"/);
  assert.match(html, /id="wl-save-btn"[^>]*onclick="saveWatchList\(\)"/);
});

test('the editor loads the live watch list and warns when it is the example one', () => {
  assert.match(html, /\/api\/coach\?action=get-portals/);
  assert.match(html, /id="wl-starter-banner"/);
  assert.match(html, /data\.isStarterList/);
});

test('the editor saves through the existing generate + private-repo write path', () => {
  const save = html.slice(html.indexOf('async function saveWatchList'));
  assert.match(save, /action=generate-portals/);
  assert.match(save, /action=save-onboarding/);
  assert.match(save, /portalsYml: gen\.portalsYml/);
});

test('the editor bridges the Radar with one-click import', () => {
  assert.match(html, /On your radar — add to watch list\?/);
  const render = html.slice(html.indexOf('function watchListRenderSuggestions'));
  // Only http(s) links become an add button; anything else gets a prompt.
  assert.match(render, /\^https\?:\\\/\\\//);
  assert.match(render, /Add their careers page link/);
});

test('onboarding and the editor share one row implementation', () => {
  assert.match(html, /function companyRowsAdd\(containerId/);
  assert.match(html, /function companyRowsCollect\(containerId/);
  assert.match(html, /function onboardingAddCompanyRow[\s\S]{0,160}companyRowsAdd\('onboarding-companies-rows'/);
  assert.match(html, /function watchListAddRow[\s\S]{0,160}companyRowsAdd\('wl-rows'/);
});

test('the onboarding companies step is still wired to its own container', () => {
  assert.match(html, /id="onboarding-step-companies"/);
  assert.match(html, /id="onboarding-companies-rows"/);
  assert.match(html, /onclick="onboardingAddCompanyRow\(\)"/);
  assert.match(html, /onclick="onboardingCompaniesContinue\(\)"/);
});
