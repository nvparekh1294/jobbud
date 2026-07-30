// Guard test for Vercel serverless function dependencies.
//
// WHY THIS EXISTS: Vercel installs a function's dependencies from the NEAREST
// package.json, which for everything under api/ is api/package.json -- NOT the
// root one. Locally, Node resolves bare specifiers by walking up to the root
// node_modules, so an import that is only declared at the root works fine on a
// dev machine and in `node --test`, then crashes in production with
// ERR_MODULE_NOT_FOUND / FUNCTION_INVOCATION_FAILED. That is exactly how
// `import { stringify } from 'yaml'` in api/coach.js took down every coach
// request. This test closes that gap.
//
// It statically walks the import graph rooted at api/*.js (following relative
// imports into lib/ and scanner/) and asserts every external package it reaches
// is declared in api/package.json dependencies.
//
// LIMITS of the tracer (deliberately dependency-free -- fs + regex, no parser):
//   - It scans raw source text with regexes, so a specifier that appears inside
//     a string literal, template literal, or prompt text can be picked up as a
//     real import. Comments are stripped first, which removes the common case.
//     A false positive shows up as a missing-dependency failure; if one ever
//     appears, fix it by narrowing the regex, not by deleting the assertion.
//   - `import('...')` with a computed (non-literal) specifier is invisible to
//     it. Those cannot be checked statically at all; keep dynamic imports on
//     string literals.
//   - Only `dependencies` counts. devDependencies are not installed for
//     production functions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'api');

const BUILTINS = new Set(builtinModules);

// 'node:fs/promises' -> builtin; 'fs/promises' -> builtin; 'crypto' -> builtin.
function isBuiltin(spec) {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  return BUILTINS.has(bare) || BUILTINS.has(bare.split('/')[0]);
}

// '@scope/pkg/sub' -> '@scope/pkg'; 'pkg/sub' -> 'pkg'.
function topLevelPackage(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Remove // line comments and /* block comments */ so commented-out imports and
// doc examples do not register. Naive: a "//" inside a string literal will also
// truncate that line, which is acceptable here (it can only cause us to MISS a
// specifier on such a line, and real imports never share a line with one).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Matches: `from '<spec>'`, `import '<spec>'`, `require('<spec>')`,
// `import('<spec>')` -- single or double quoted.
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

function extractSpecifiers(src) {
  const out = [];
  for (const m of stripComments(src).matchAll(SPECIFIER_RE)) out.push(m[1]);
  return out;
}

// Node's ESM/CJS resolution for a relative specifier, in the forms this repo
// actually uses.
const EXT_CANDIDATES = ['', '.js', '.mjs', '/index.js', '/index.mjs'];

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of EXT_CANDIDATES) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Walk the graph from every api/*.js entry point.
// Returns { external, files }:
//   external — Map of package name -> sorted list of files that import it
//   files    — sorted repo-relative paths of every FILE reachable from api/,
//              including the api entry points themselves. This is the set that
//              must survive .vercelignore (see the bundling test below).
function traceApiGraph() {
  const entries = fs
    .readdirSync(API_DIR)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .map((f) => path.join(API_DIR, f));

  const seen = new Set();
  const external = new Map();
  const queue = [...entries];

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    const src = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(src)) {
      if (isBuiltin(spec)) continue;

      if (spec.startsWith('./') || spec.startsWith('../')) {
        const resolved = resolveRelative(file, spec);
        assert.ok(
          resolved,
          `Unresolvable relative import '${spec}' in ${path.relative(ROOT, file)}`,
        );
        queue.push(resolved);
        continue;
      }
      if (spec.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(spec)) continue; // absolute / URL

      const pkg = topLevelPackage(spec);
      if (!external.has(pkg)) external.set(pkg, new Set());
      external.get(pkg).add(path.relative(ROOT, file));
    }
  }

  return {
    external: new Map([...external].map(([pkg, files]) => [pkg, [...files].sort()])),
    files: [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort(),
  };
}

function traceExternalPackages() {
  return traceApiGraph().external;
}

function apiDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(API_DIR, 'package.json'), 'utf8'));
  return new Set(Object.keys(pkg.dependencies || {}));
}

test('every package imported from api/ is declared in api/package.json', () => {
  const declared = apiDependencies();
  const used = traceExternalPackages();

  const missing = [...used]
    .filter(([pkg]) => !declared.has(pkg))
    .map(([pkg, files]) => `  ${pkg}  (imported by: ${files.join(', ')})`);

  assert.equal(
    missing.length,
    0,
    'These packages are imported from api/ but are NOT in api/package.json ' +
      'dependencies. Vercel installs function deps from api/package.json, so ' +
      'they will be missing in production and the function will crash with ' +
      `ERR_MODULE_NOT_FOUND:\n${missing.join('\n')}`,
  );
});

// Sanity check on the tracer itself: if this ever finds nothing, the walk is
// broken and the assertion above would pass vacuously.
test('the api import tracer actually reaches external packages', () => {
  const used = traceExternalPackages();
  assert.ok(used.size > 0, 'tracer found no external imports under api/ -- it is broken');
  assert.ok(used.has('yaml'), "tracer did not find api/coach.js's 'yaml' import");
});

// ── .vercelignore allowlist ───────────────────────────────────────────────────
//
// SECOND WAY THE SAME FUNCTION DIES. The test above covers EXTERNAL packages.
// This one covers OUR OWN files. .vercelignore is an allowlist -- `/*` drops
// every top-level entry and each needed path is re-included by name -- so adding
// a new module under lib/ or scanner/ and importing it from api/ silently ships
// a bundle WITHOUT that file. Every request to the function then fails at import
// with ERR_MODULE_NOT_FOUND, exactly like the missing-package case, and nothing
// in local dev or `node --test` notices because the file is right there on disk.
//
// That is precisely how lib/portalsMeta.mjs went out: api/coach.js imported it,
// .vercelignore did not re-include it, and every coach request 500'd.
//
// Rather than reimplement gitignore matching (the anchored `/*` + negation
// subset is subtle -- notably that a re-include cannot resurrect a file whose
// parent dir is still excluded), this shells out to git itself, which is the
// same semantics Vercel applies to .vercelignore.

// Ask git which of `paths` .vercelignore excludes. A throwaway repo whose
// .gitignore IS our .vercelignore; --no-index means the files need not exist.
function vercelIgnoredPaths(paths) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbud-vercelignore-'));
  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
    fs.copyFileSync(path.join(ROOT, '.vercelignore'), path.join(dir, '.gitignore'));

    // check-ignore exits 1 when NOTHING matches, which is a legitimate result.
    let stdout = '';
    try {
      stdout = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
        cwd: dir,
        input: paths.join('\n'),
        encoding: 'utf8',
      });
    } catch (err) {
      if (err.status !== 1) throw err;
      stdout = err.stdout || '';
    }
    return new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('every file an api function imports is shipped by .vercelignore', () => {
  const { files } = traceApiGraph();
  const ignored = vercelIgnoredPaths(files);
  const dropped = files.filter((f) => ignored.has(f));

  assert.deepEqual(
    dropped,
    [],
    'These files are reachable from api/ but .vercelignore EXCLUDES them from the ' +
      'Vercel bundle, so the function will crash at import with ERR_MODULE_NOT_FOUND ' +
      'on every request (it works locally because the file exists on disk). ' +
      `Add a "!/<path>" re-include line for each to .vercelignore:\n${
        dropped.map((f) => `  ${f}`).join('\n')}`,
  );
});

// Guards the guard: if the tracer or the git simulation silently returned
// nothing, the assertion above would pass no matter what .vercelignore said.
test('the .vercelignore simulation is actually working', () => {
  const { files } = traceApiGraph();
  assert.ok(files.length > 5, `tracer reached only ${files.length} files -- it is broken`);
  assert.ok(files.includes('api/coach.js'), 'tracer did not reach api/coach.js');
  assert.ok(files.includes('lib/portalsMeta.mjs'), 'tracer did not reach lib/portalsMeta.mjs');

  // A path .vercelignore is known to exclude must come back as ignored -- proves
  // the git simulation is evaluating the rules rather than matching nothing.
  const ignored = vercelIgnoredPaths(['lib/ssrf.mjs', 'cv.md', 'api/coach.js', 'lib/github.js']);
  assert.ok(ignored.has('lib/ssrf.mjs'), 'simulation failed to exclude scanner-only lib/ssrf.mjs');
  assert.ok(ignored.has('cv.md'), 'simulation failed to exclude a personal file');
  assert.ok(!ignored.has('api/coach.js'), 'simulation wrongly excluded api/coach.js');
  assert.ok(!ignored.has('lib/github.js'), 'simulation wrongly excluded a re-included lib file');
});

// The dashboard is served from the same deployment, so it has to survive too.
test('.vercelignore ships the dashboard and the manifests', () => {
  const needed = ['dashboard/index.html', 'package.json', 'package-lock.json', 'vercel.json'];
  const ignored = vercelIgnoredPaths(needed);
  assert.deepEqual([...ignored], [], 'these must be in the Vercel bundle');
});
