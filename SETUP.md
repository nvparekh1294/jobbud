# JobBud — Advanced Setup

The [README](README.md) covers the core setup (deploy to Vercel, add your four
required environment variables, configure your profile). This file documents the
**optional** integrations that need a few extra steps.

Everything here is optional. JobBud runs fine without any of it — optional
integrations fail silently when their environment variables are absent.

---

## First, the rule that applies to everything below

JobBud runs in **two separate places**, and they cannot see each other's settings:

| Where | What runs there | Where it reads keys from |
|-------|-----------------|--------------------------|
| **Vercel** | the dashboard and its API | **Settings → Environment Variables** (tick **Production**) |
| **GitHub Actions** | the scheduled scanner | **Settings → Secrets and variables → Actions** |

Any key both halves need must be entered **twice, under the same name, in both
screens**. Setting it in one place does nothing for the other, and nothing warns
you — the half with the key works and the half without it fails quietly.

This is the single most common setup problem. The core keys are covered in the
README's [step 3](README.md#3-configure-github-actions--yes-the-same-keys-again),
including which symptom points at which missing vault:

- a scan run that says the API key is not set, or finds jobs and never scores
  them → `ANTHROPIC_API_KEY` is missing from **GitHub Actions secrets**
- a dashboard whose Coach chat stays silent → `ANTHROPIC_API_KEY` is missing from
  **Vercel**
- a working dashboard but dead Apply/Reject buttons in your emails → the two
  vaults disagree on the signing key (`DASHBOARD_PASSWORD`, or
  `ACTION_TOKEN_SECRET` if you set one). The scanner signs those links and the
  dashboard verifies them, so the value must be **identical** in both.

Every optional integration below follows the same rule.

---

## Optional: Auto-save prep docs to Google Drive

**What you get:** when you generate an interview prep doc, JobBud creates a real
Google Doc in your Drive and puts a persistent link on the job card.

**Without it:** prep docs still generate — they open in a popup you can copy or
download, and you can regenerate them anytime. Nothing breaks; you just don't get
the saved Google Doc.

This feature needs four environment variables:

| Variable | Required for the feature | How you get it |
|----------|--------------------------|----------------|
| `GOOGLE_CLIENT_ID` | yes | OAuth client (steps below) |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client (steps below) |
| `GOOGLE_REFRESH_TOKEN` | yes | `node get-google-token.mjs` (step 4) |
| `GOOGLE_DRIVE_FOLDER_ID` | no | the ID of a Drive folder to save into; omit to save to your Drive root |

### Step 1 — Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown at the top, then **New Project**. Give it a name
   like `jobbud` and create it. Make sure it is selected before continuing.

### Step 2 — Enable the Docs and Drive APIs

1. Go to **APIs & Services → Library**.
2. Search for **Google Docs API**, open it, and click **Enable**.
3. Go back to the Library, search for **Google Drive API**, and **Enable** it too.

### Step 3 — Create an OAuth client (Desktop app)

1. Go to **APIs & Services → OAuth consent screen**.
   - Choose **External** and fill in the required fields (app name, your email).
   - Under **Test users**, add the Google account you will use with JobBud.
   - **Important:** while the app is in *Testing* mode, refresh tokens expire
     after 7 days. Once it works, come back and click **Publish App** to move it
     to *Production*, where refresh tokens do not expire.
2. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
3. For **Application type**, choose **Desktop app**. (A Desktop-app client is what
   lets the helper script use a `http://localhost` redirect without registering
   one.) Name it and click **Create**.
4. Copy the **Client ID** and **Client secret** — you need them in the next step.

### Step 4 — Mint your refresh token

Run the included helper on your own machine. It reads the client ID and secret
from the environment, opens Google's consent screen, and prints a refresh token.
It stores nothing and contains no credentials of its own.

```bash
GOOGLE_CLIENT_ID=your-client-id \
GOOGLE_CLIENT_SECRET=your-client-secret \
node get-google-token.mjs
```

Your browser opens to Google's consent screen. Approve access. The script captures
the response on a temporary `localhost` server and prints your
`GOOGLE_REFRESH_TOKEN`.

> If it prints "No refresh token was returned," you have authorized this app
> before. Remove it at
> [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
> and run the command again.

### Step 5 — Set the environment variables

Add all three (plus the optional folder ID) in **both** places JobBud runs:

- **Vercel** → your project → **Settings → Environment Variables** (powers prep
  docs generated from the dashboard).
- **GitHub** → your repo → **Settings → Secrets and variables → Actions** (powers
  prep/application docs generated by the scheduled scans).

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_DRIVE_FOLDER_ID=...   # optional
```

In Vercel, tick **Production** for each variable as you add it — your live site
reads Production only, so a variable left on Development alone does nothing for
it. Then redeploy so the new variables take effect. Generate a prep doc — the
job card should now show a Google Doc link.

> If nothing changes — the feature stays dead, or the API comes back
> "Unauthorized" — the variables are almost certainly missing from Production.
> The [README](README.md#1-deploy-to-vercel) explains this trap in full.

To find a `GOOGLE_DRIVE_FOLDER_ID`: open the folder in Google Drive and copy the
last path segment of the URL (`.../folders/THIS_PART`).

---

## Optional: API job sources (JSearch, Adzuna, SerpApi)

By default JobBud only looks at the companies on your watch list. These three
services widen that to jobs from across the web — roles at companies you have
never heard of, scored against your profile by exactly the same pipeline.

Each source is independent. Set up one, two, or all three; skip them entirely and
JobBud still scans everything on your company watch list — the file
`scanner/portals.yml`, which you edit from the dashboard's **Radar tab → ⚙ Edit
Watch List**.

### What each one adds

| Service | What it adds |
|---------|--------------|
| **JSearch** | A broad aggregated job feed, searched by your target roles and locations. |
| **Adzuna** | Job-board listings for the US, UK, and Singapore. In `config/profile.yml` write the country as `us`, `gb` or `sg` — `usa` and `uk` are understood too; anything else is skipped, and the scan log says which location it skipped and why. |
| **SerpApi** | Google Jobs results — which sweeps up LinkedIn, Greenhouse, Lever, Ashby and Workday postings Google has indexed. |

### Where to sign up

- **JSearch** is sold through the **RapidAPI** marketplace at
  [rapidapi.com](https://rapidapi.com) — create a RapidAPI account, subscribe to
  the JSearch API, and copy the API key it issues you.
- **Adzuna** is at [adzuna.com](https://www.adzuna.com). Register for its
  developer API and it issues you a **pair** of values, an app ID and an app key.
  You need both.
- **SerpApi** is at [serpapi.com](https://serpapi.com) — create an account and
  copy your API key. Its free plan is 100 searches a month
  ([Google Jobs API docs](https://serpapi.com/google-jobs-api)).

Each service sets its own pricing, usually with a small free tier. Check the
current plan on the site before you rely on it — the scan makes real API calls.

### Where the keys go

**Your repo → Settings → Secrets and variables → Actions → New repository
secret.** Add each one you have, using these exact names:

| Secret | Which service |
|--------|---------------|
| `JSEARCH_API_KEY` | JSearch (via RapidAPI) |
| `ADZUNA_APP_ID` | Adzuna — the app ID |
| `ADZUNA_API_KEY` | Adzuna — the app key |
| `SERP_API_KEY` | SerpApi |

These are **the one exception** to the two-vaults rule at the top of this file.
The scanner runs on GitHub Actions and it is the only thing that reads them, so
they go in Actions secrets and nowhere else. Adding them to Vercel does nothing.

(`.env.example` lists the same names for local development, if you run the
scanner on your own machine. That file is not read by the deployed system.)

### When they take effect

The API sources run in the **JobBud Weekly API Scan** workflow, on a schedule of
every Monday at 6am UTC. You do not have to wait for it: open the **Actions** tab,
pick **JobBud Weekly API Scan**, and use **Run workflow** to trigger a run now.

### If nothing shows up

Open that run's log and look at the top of the scan. A source with a missing key
says so in plain text and skips itself:

```
JSearch API key not set -- skipping
Adzuna credentials not set -- skipping
SerpAPI key not set -- skipping
```

Seeing one of those lines when you *did* add the key means it landed in the wrong
place — most often in Vercel's environment variables instead of the repo's Actions
secrets, or under a slightly different name. Re-check the spelling against the
table above and re-run the workflow.

A different line — `No target roles configured (set target_roles in
config/profile.yml)` — means the key is fine but the scanner has nothing to search
for yet. Finish your profile first.

---

For SendGrid email digests, Telegram push notifications, Firecrawl, and the
dashboard password, see the **Optional Integrations** section of the
[README](README.md#optional-integrations).
