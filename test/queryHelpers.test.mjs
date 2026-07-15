// Tests for the profile-driven search-query helpers and the API sources' skip
// behavior when no target roles are configured. Role strings must come from the
// user's profile (config.requiredTitleKeywords) — never a hardcoded personal set —
// and a source must skip (search nothing) rather than guess someone else's roles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTargetRoles,
  buildRoleGroups,
  serpApiLocationString,
} from '../scanner/sources/queryHelpers.mjs';
import { fetchJSearch } from '../scanner/sources/jsearch.mjs';
import { fetchAdzuna } from '../scanner/sources/adzuna.mjs';
import { fetchSerpApi } from '../scanner/sources/serpapi.mjs';

const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

function withFetch(fn, run) {
  const real = global.fetch;
  global.fetch = fn;
  return run().finally(() => { global.fetch = real; });
}

// ── resolveTargetRoles ────────────────────────────────────────────────────────
test('resolveTargetRoles returns the configured target roles, trimmed', () => {
  assert.deepEqual(
    resolveTargetRoles({ requiredTitleKeywords: ['  operations manager ', 'program manager'] }),
    ['operations manager', 'program manager'],
  );
});

test('resolveTargetRoles returns [] when no roles are configured', () => {
  assert.deepEqual(resolveTargetRoles({ requiredTitleKeywords: [] }), []);
  assert.deepEqual(resolveTargetRoles({}), []);
  assert.deepEqual(resolveTargetRoles(null), []);
});

test('resolveTargetRoles drops empty/blank entries', () => {
  assert.deepEqual(
    resolveTargetRoles({ requiredTitleKeywords: ['ops manager', '', '   ', 42] }),
    ['ops manager'],
  );
});

// ── buildRoleGroups ───────────────────────────────────────────────────────────
test('buildRoleGroups OR-joins roles into chunks', () => {
  const roles = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(buildRoleGroups(roles, 4), ['a OR b OR c OR d', 'e']);
  assert.deepEqual(buildRoleGroups(roles, 2), ['a OR b', 'c OR d', 'e']);
});

test('buildRoleGroups returns [] for no roles', () => {
  assert.deepEqual(buildRoleGroups([]), []);
});

// ── serpApiLocationString ─────────────────────────────────────────────────────
test('serpApiLocationString derives from config location fields', () => {
  assert.equal(serpApiLocationString({ city: 'New York', region: 'NY' }), 'New York, NY');
  assert.equal(serpApiLocationString({ city: 'Remote Town', region: null }), 'Remote Town');
  assert.equal(serpApiLocationString({}), '');
});

// ── Source skip behavior: no roles → no API calls ─────────────────────────────
const noRolesConfig = {
  requiredTitleKeywords: [],
  includeRemote: true,
  locations: [{ city: 'New York', region: 'NY', country: 'us', radiusMiles: 25 }],
  jsearchApiKey: 'k',
  adzunaAppId: 'id',
  adzunaApiKey: 'k',
  serpApiKey: 'k',
};

test('fetchJSearch skips (no fetch) when no target roles are configured', async () => {
  let called = false;
  await withFetch(async () => { called = true; throw new Error('should not fetch'); }, async () => {
    const out = await fetchJSearch(noRolesConfig);
    assert.deepEqual(out, []);
  });
  assert.equal(called, false);
});

test('fetchAdzuna skips (no fetch) when no target roles are configured', async () => {
  let called = false;
  await withFetch(async () => { called = true; throw new Error('should not fetch'); }, async () => {
    const out = await fetchAdzuna(noRolesConfig);
    assert.deepEqual(out, []);
  });
  assert.equal(called, false);
});

test('fetchSerpApi skips (no fetch) when no target roles are configured', async () => {
  let called = false;
  await withFetch(async () => { called = true; throw new Error('should not fetch'); }, async () => {
    const out = await fetchSerpApi(noRolesConfig);
    assert.deepEqual(out, []);
  });
  assert.equal(called, false);
});

// ── Source query construction from profile roles ──────────────────────────────
test('fetchJSearch builds queries from the profile target roles', async () => {
  const urls = [];
  const config = {
    requiredTitleKeywords: ['operations manager', 'program manager'],
    includeRemote: false,
    locations: [{ city: 'New York', region: 'NY', country: 'us', radiusMiles: 25 }],
    jsearchApiKey: 'k',
  };
  await withFetch(async (url) => { urls.push(url); return jsonRes({ data: [] }); }, async () => {
    await fetchJSearch(config);
  });
  assert.equal(urls.length, 1);
  // URLSearchParams encodes spaces as '+'; normalize before substring checks.
  const decoded = decodeURIComponent(urls[0]).replace(/\+/g, ' ');
  assert.ok(decoded.includes('operations manager'), 'query should include the configured role');
  assert.ok(decoded.includes('program manager'), 'query should OR-join configured roles');
  assert.ok(decoded.includes('New York'), 'query should target the configured city');
});
