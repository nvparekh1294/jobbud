// Vercel serverless function — /api/health, the setup self-diagnosis endpoint.
//
// WHY THIS EXISTS. Every one of JobBud's setup failures used to surface as
// silence or as a generic string. A GH_TOKEN scoped to the wrong environment
// made the dashboard open normally and then 401 every request with no message.
// A GH_REPO pointing at a repo the token cannot see made GitHub answer 404, so
// every read "succeeded" and returned nothing — an empty radar, an empty
// pipeline, no error anywhere. A stale password in sessionStorage silently
// re-authenticated as wrong forever. In each case the software knew exactly what
// was wrong and told the user nothing, and the user was left to debug a
// distributed system by hand.
//
// This endpoint is the fix. It runs the checks the software can run about
// itself, and returns each one as a plain-English sentence plus the exact thing
// to do about it. The dashboard renders those sentences; the user never guesses.
//
// SECURITY. This endpoint NEVER returns a secret value. It reports names and
// statuses only ("ANTHROPIC_API_KEY is set", not the key). Every message and fix
// string below is written to be safe to display verbatim on screen.
//
// AUTH, WITH A TWIST. A wrong password does not get a bare 401. It gets HTTP 200
// with a single failed `auth` check. That is deliberate: the password gate uses
// this endpoint to VERIFY a password before unlocking, and it needs a
// distinguishable, describable answer ("that password doesn't match") rather
// than an opaque status code it has to guess the meaning of. No private data is
// exposed on that path — the response contains exactly one check and nothing
// else. Only a correct password runs the real checks.

import { safeEqual } from '../lib/auth.mjs';
import { readGithubFile, normalizeJsonDoc } from '../lib/github.js';

const GITHUB_API = 'https://api.github.com';

// GitHub-Actions-side secrets live in a different vault and are not readable
// from a Vercel function, so this endpoint cannot check them. Say so out loud
// rather than letting a green page imply a scanner that also works.
export const HEALTH_NOTE =
  'These checks cover the Vercel side only — the dashboard you are looking at. ' +
  'The scanner runs on GitHub Actions, which keeps its own separate copy of ' +
  'these secrets that no code here can read. If the dashboard is healthy but ' +
  'scans or email buttons still fail, the GitHub Actions copy is the place to ' +
  'look: see the "two vaults" step in the README.';

// `informational` marks a check that reports a fact rather than a problem. It is
// always ok:true, so it can never contribute to the dashboard's "Setup needs
// attention" banner — it exists purely so a feature the user may not know about
// is visible somewhere instead of only in the docs.
function check(name, ok, message, fix, informational = false) {
  return { check: name, ok, message, fix: fix || '', informational };
}

// ── Optional API job sources ──────────────────────────────────────────────────
//
// JSearch / Adzuna / SerpApi widen the scan beyond the watch list. Their keys are
// read by the SCANNER, from GitHub Actions secrets — this function runs on
// Vercel and cannot see that vault. So this check never fails and never claims a
// key is missing: it names the capability, reports only what is visible from
// here, and says outright that Actions is the authority. Anything stronger would
// be a confident lie about a vault we cannot read.
export const OPTIONAL_SOURCES = [
  { label: 'JSearch', vars: ['JSEARCH_API_KEY'] },
  { label: 'Adzuna', vars: ['ADZUNA_APP_ID', 'ADZUNA_API_KEY'] },
  { label: 'SerpApi', vars: ['SERP_API_KEY'] },
];

export function optionalSourcesCheck(env) {
  const seenHere = OPTIONAL_SOURCES.filter(s => s.vars.every(v => env[v])).map(s => s.label);
  const notSeenHere = OPTIONAL_SOURCES.filter(s => !s.vars.every(v => env[v])).map(s => s.label);

  const preamble =
    'Optional: JobBud can also pull jobs from across the web (JSearch, Adzuna, SerpApi) ' +
    'instead of only the companies on your watch list. Their keys are read by the ' +
    'scanner from your GitHub Actions secrets, which this page cannot see, so treat ' +
    'the following as a hint and not an answer.';

  const detail = seenHere.length
    ? ` Visible to the dashboard: ${seenHere.join(', ')}. Not visible here: ${notSeenHere.join(', ') || 'none'}.`
    : ' None of them are visible to the dashboard, which is expected — they belong in GitHub Actions secrets, not Vercel.';

  return check(
    'sources:optional',
    true,
    preamble + detail,
    'To add one, see the "API job sources" step in SETUP.md. The secret names are JSEARCH_API_KEY, ADZUNA_APP_ID, ADZUNA_API_KEY and SERP_API_KEY, and they go in your repo under Settings → Secrets and variables → Actions.',
    true,
  );
}

// ── Environment-variable checks ───────────────────────────────────────────────

function envChecks(env) {
  const checks = [];

  checks.push(
    env.ANTHROPIC_API_KEY
      ? check('env:ANTHROPIC_API_KEY', true, 'ANTHROPIC_API_KEY is set.')
      : check(
          'env:ANTHROPIC_API_KEY',
          false,
          'ANTHROPIC_API_KEY is not set in Vercel. The Coach chat will stay silent and onboarding will never produce your files.',
          'In Vercel → Settings → Environment Variables, add ANTHROPIC_API_KEY, tick Production, then Redeploy.',
        ),
  );

  checks.push(
    env.GH_TOKEN
      ? check('env:GH_TOKEN', true, 'GH_TOKEN is set.')
      : check(
          'env:GH_TOKEN',
          false,
          'GH_TOKEN is not set in Vercel. Without it the dashboard cannot read or write anything in your repo, so every section will fail to load.',
          'In Vercel → Settings → Environment Variables, add GH_TOKEN (a GitHub token with access to your JobBud repo), tick Production, then Redeploy.',
        ),
  );

  const repo = (env.GH_REPO || '').trim();
  if (!repo) {
    checks.push(
      check(
        'env:GH_REPO',
        false,
        'GH_REPO is not set in Vercel. The dashboard does not know which repo holds your data.',
        'In Vercel → Settings → Environment Variables, add GH_REPO in the form yourname/your-repo, tick Production, then Redeploy.',
      ),
    );
  } else if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    checks.push(
      check(
        'env:GH_REPO',
        false,
        `GH_REPO is set to "${repo}", which is not in the form yourname/your-repo. It must be exactly the owner, a slash, and the repo name — no https://, no trailing slash.`,
        'Fix GH_REPO in Vercel → Settings → Environment Variables, then Redeploy.',
      ),
    );
  } else {
    checks.push(check('env:GH_REPO', true, `GH_REPO is set to ${repo}.`));
  }

  // VERCEL_URL is a Vercel SYSTEM variable: Vercel injects it into every
  // deployment as a bare, deployment-specific hostname with no scheme, and a
  // user-set value of the same name does NOT override it. So the schemeless
  // form is not a misconfiguration here and there is nothing the user can do
  // about it — this endpoint used to FAIL on it and hand every Vercel user an
  // instruction that could never succeed. api/action.js already puts a scheme
  // back on the bare hostname for the links it builds, so nothing on the Vercel
  // side is broken by it.
  //
  // The copy that genuinely needs https:// is the SEPARATE VERCEL_URL in the
  // GitHub Actions secrets vault, which the scanner reads when it builds the
  // Apply/Reject buttons in digest emails. A Vercel function cannot read that
  // vault, so we say so instead of pretending to have checked it.
  const vercelUrl = (env.VERCEL_URL || '').trim();
  if (!vercelUrl) {
    checks.push(
      check(
        'env:VERCEL_URL',
        false,
        'VERCEL_URL is not set. Vercel normally fills this in by itself on every deployment, so seeing it empty means this check is running somewhere other than a Vercel deployment. The Apply and Reject buttons in your digest emails are built from a copy of this value, so they will point at localhost and go nowhere.',
        'Two separate places hold this value. Your digest-email buttons use the copy in your repo under Settings → Secrets and variables → Actions: set VERCEL_URL there to the full address including https:// (for example https://your-app.vercel.app). On the Vercel side, Vercel supplies its own value automatically on each deployment — a value you add there will not replace it — so if this is a real Vercel deployment, redeploy and check again.',
      ),
    );
  } else {
    checks.push(
      check(
        'env:VERCEL_URL',
        true,
        `VERCEL_URL is set to ${vercelUrl} (Vercel fills this in automatically, which is why it has no https:// in front — that is normal and nothing here is broken by it). The copy that your digest-email buttons use lives in your GitHub Actions secrets and must include https:// — this page can't check that one.`,
      ),
    );
  }

  return checks;
}

// ── GitHub checks ─────────────────────────────────────────────────────────────

// GET /user — is the token itself alive? This is the check that would have named
// the "dashboard opens, everything 401s" failure on day one.
export async function checkGithubToken(token) {
  let res;
  try {
    res = await fetch(`${GITHUB_API}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
  } catch (err) {
    return check(
      'github:token',
      false,
      `Could not reach GitHub to check your token (${err.message}).`,
      'This is usually temporary. Try the check again in a minute.',
    );
  }

  if (res.status === 401) {
    return check(
      'github:token',
      false,
      'GitHub rejected your GH_TOKEN: it is invalid or expired. Every part of the dashboard that reads your repo will fail until it is replaced.',
      'Create a new GitHub token with access to your JobBud repo, paste it into GH_TOKEN in Vercel → Settings → Environment Variables, then Redeploy.',
    );
  }
  if (res.status === 403) {
    return check(
      'github:token',
      false,
      'GitHub is rate-limiting or refusing this token (403). This is usually temporary, but it can also mean the token has been blocked by an organisation policy.',
      'Wait a few minutes and run this check again. If it keeps happening, issue a fresh token and update GH_TOKEN in Vercel, then Redeploy.',
    );
  }
  if (!res.ok) {
    return check(
      'github:token',
      false,
      `GitHub returned an unexpected ${res.status} when checking your token.`,
      'Run this check again in a minute. If it persists, replace GH_TOKEN in Vercel and Redeploy.',
    );
  }
  return check('github:token', true, 'Your GitHub token is valid and GitHub accepted it.');
}

// GET /repos/{owner}/{repo} — can the token actually SEE the repo named in
// GH_REPO? A fine-grained token answers 404 (not 403) for any repo outside its
// repository-access list, and 404 is also what a wrong name returns. The two are
// indistinguishable from here, so we say both possibilities in one sentence
// rather than guessing and sending the user down the wrong path.
export async function checkGithubRepo(token, repoFullName) {
  let res;
  try {
    res = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
  } catch (err) {
    return check(
      'github:repo',
      false,
      `Could not reach GitHub to check access to ${repoFullName} (${err.message}).`,
      'This is usually temporary. Try the check again in a minute.',
    );
  }

  if (res.status === 404) {
    return check(
      'github:repo',
      false,
      `Your GitHub token works but can't see ${repoFullName}. Either the repo name in Vercel is wrong, or the token's repository access list doesn't include it (tokens don't follow deleted-and-recreated repos).`,
      'Check GH_REPO in Vercel → Settings → Environment Variables against the repo name on GitHub, and check the token\'s repository access list includes that repo. Fix, then Redeploy.',
    );
  }
  if (res.status === 403) {
    return check(
      'github:repo',
      false,
      `GitHub returned 403 for ${repoFullName} — the token is being rate-limited, or an organisation policy is blocking it.`,
      'Wait a few minutes and run this check again. If it persists, issue a fresh token with access to this repo and update GH_TOKEN in Vercel, then Redeploy.',
    );
  }
  if (res.status === 401) {
    return check(
      'github:repo',
      false,
      'GitHub rejected your GH_TOKEN while looking up the repo: it is invalid or expired.',
      'Create a new GitHub token with access to your JobBud repo, paste it into GH_TOKEN in Vercel, then Redeploy.',
    );
  }
  if (!res.ok) {
    return check(
      'github:repo',
      false,
      `GitHub returned an unexpected ${res.status} when looking up ${repoFullName}.`,
      'Run this check again in a minute. If it persists, check GH_REPO and GH_TOKEN in Vercel and Redeploy.',
    );
  }

  let info = {};
  try {
    info = await res.json();
  } catch (_) { /* a body we cannot parse does not change the access answer */ }
  const visibility = info.private === false ? ' It is a PUBLIC repo — JobBud refuses to write personal files to a public repo, so make it private.' : '';
  return check(
    'github:repo',
    visibility === '',
    `Your token can see ${repoFullName}.${visibility}`,
    visibility === '' ? '' : `On GitHub, open ${repoFullName} → Settings → General → Danger Zone → Change visibility → Make private.`,
  );
}

// ── Data-file checks ──────────────────────────────────────────────────────────
//
// A file that is absent is FINE on a fresh install — the first scan or the first
// save creates it. So is the committed empty seed (`[]`), which heals on the next
// write. What is not fine is a file that exists and cannot be parsed, or one
// whose contents are not the document JobBud writes: that is the shape bug that
// used to make saved companies vanish on refresh, and it deserves a sentence.

// True when `parsed` is already the shape JobBud writes — i.e. normalizeJsonDoc
// would leave it alone.
//
// Asked of normalizeJsonDoc itself rather than restated here. This used to be a
// hand-written copy of that function's rules, which meant the reader and the
// writer each held their own private definition of "the right shape" and nothing
// stopped them drifting: relax the writer and this check would start calling
// healthy files corrupt, in a diagnostic whose whole job is telling the user the
// truth about their data. Normalize a throwaway copy; if normalizing changed
// nothing, there was nothing to fix.
function shapeMatches(parsed, emptyDoc) {
  const normalized = normalizeJsonDoc(structuredClone(parsed), emptyDoc);
  return JSON.stringify(normalized) === JSON.stringify(parsed);
}

// The committed seed for these files is the empty array `[]`, and an empty object
// is equally harmless. Neither is a corruption.
function isBenignSeed(parsed) {
  if (Array.isArray(parsed)) return parsed.length === 0;
  if (parsed && typeof parsed === 'object') return Object.keys(parsed).length === 0;
  return false;
}

export async function checkDataFile(token, owner, repo, filePath, emptyDoc, label) {
  const name = `data:${filePath}`;
  let file;
  try {
    file = await readGithubFile(token, owner, repo, filePath);
  } catch (err) {
    return check(
      name,
      false,
      `Could not read ${filePath} from your repo (${err.message}). ${label} will not load.`,
      'Run this check again in a minute. If it keeps failing, confirm GH_TOKEN and GH_REPO in Vercel are correct and Redeploy.',
    );
  }

  if (!file.exists) {
    return check(
      name,
      true,
      `${filePath} doesn't exist in your repo yet. That's normal on a new install — it is created the first time ${label.toLowerCase()} has something to save.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(file.content);
  } catch (err) {
    return check(
      name,
      false,
      `${filePath} exists in your repo but is not valid JSON, so ${label.toLowerCase()} cannot load. Something has corrupted the file.`,
      `Open ${filePath} on GitHub and restore it to the last version that worked (History → the previous commit → Revert), or replace its contents with [] to start over.`,
    );
  }

  if (shapeMatches(parsed, emptyDoc)) {
    return check(name, true, `${filePath} is readable and has the expected shape.`);
  }
  if (isBenignSeed(parsed)) {
    return check(
      name,
      true,
      `${filePath} is still the empty starter file. That's normal — it fills in the first time ${label.toLowerCase()} saves something.`,
    );
  }
  // Not empty, not the right shape: real content in a shape nothing here writes.
  const expected = Object.keys(emptyDoc).join(', ');
  return check(
    name,
    false,
    `${filePath} exists but is not in the shape JobBud writes (it should be a JSON object with a "${expected}" key), so ${label.toLowerCase()} will show up empty.`,
    `Open ${filePath} on GitHub and restore it to the last version that worked (History → the previous commit → Revert).`,
  );
}

// ── The full run ──────────────────────────────────────────────────────────────
//
// Ordering is deliberate: environment first, then the token, then repo access,
// then the files. Each stage is a prerequisite for the next, so when one fails
// the stages behind it are NOT run and NOT reported — reporting four failures for
// one root cause would bury the sentence the user actually needs to read.
export async function runHealthChecks(env = process.env) {
  const checks = [...envChecks(env)];
  const failed = (name) => checks.some(c => c.check === name && !c.ok);

  const token = env.GH_TOKEN;
  const repoFullName = (env.GH_REPO || '').trim();

  if (!failed('env:GH_TOKEN')) {
    checks.push(await checkGithubToken(token));
  }

  const canQueryRepo = !failed('env:GH_TOKEN') && !failed('env:GH_REPO') && !failed('github:token');
  if (canQueryRepo) {
    checks.push(await checkGithubRepo(token, repoFullName));
  }

  if (canQueryRepo && !failed('github:repo')) {
    const [owner, repo] = repoFullName.split('/');
    checks.push(await checkDataFile(token, owner, repo, 'data/radar.json', { companies: {} }, 'Your Radar'));
    checks.push(await checkDataFile(token, owner, repo, 'data/job-status.json', { jobs: {} }, 'Your job pipeline'));
  }

  // Always last, and always informational — see optionalSourcesCheck.
  checks.push(optionalSourcesCheck(env));

  return checks;
}

export default async function handler(req, res) {
  const password = process.env.DASHBOARD_PASSWORD;
  const headerPw = req.headers['x-dashboard-password'];

  // Deliberately 200, not 401 — see the AUTH note at the top of this file.
  if (!password) {
    return res.status(200).json({
      ok: false,
      checks: [
        check(
          'auth',
          false,
          'DASHBOARD_PASSWORD is not set in Vercel, so there is no password to check against and the dashboard is locked for everyone.',
          'In Vercel → Settings → Environment Variables, add DASHBOARD_PASSWORD, tick Production, then Redeploy. Add the same value to your GitHub Actions secrets.',
        ),
      ],
      note: HEALTH_NOTE,
    });
  }

  if (!headerPw || !safeEqual(String(headerPw), password)) {
    return res.status(200).json({
      ok: false,
      checks: [
        check(
          'auth',
          false,
          "That password doesn't match the DASHBOARD_PASSWORD set in Vercel.",
          'Check the DASHBOARD_PASSWORD value in Vercel → Settings → Environment Variables. If you changed it recently, remember a redeploy is needed for the new value to take effect.',
        ),
      ],
      note: HEALTH_NOTE,
    });
  }

  let checks;
  try {
    checks = await runHealthChecks(process.env);
  } catch (err) {
    return res.status(200).json({
      ok: false,
      checks: [
        check(
          'self',
          false,
          `The setup check itself failed to run (${err.message}).`,
          'Try again in a minute. If it keeps happening, check your Vercel function logs.',
        ),
      ],
      note: HEALTH_NOTE,
    });
  }

  checks.unshift(check('auth', true, 'Your dashboard password matches the one set in Vercel.'));
  return res.status(200).json({
    ok: checks.every(c => c.ok),
    checks,
    note: HEALTH_NOTE,
  });
}
