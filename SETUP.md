# JobBud — Advanced Setup

The [README](README.md) covers the core setup (deploy to Vercel, add your four
required environment variables, configure your profile). This file documents the
**optional** integrations that need a few extra steps.

Everything here is optional. JobBud runs fine without any of it — optional
integrations fail silently when their environment variables are absent.

---

## First, the rule that applies to everything below

JobBud runs in **two separate places**, and they cannot see each other's settings.
Each place keeps its keys in its own vault — a settings screen on that website
where you type a name and a value, one pair per key:

| Where | What runs there | Where it reads keys from |
|-------|-----------------|--------------------------|
| **Vercel** | the dashboard and its API | your project → **Settings → Environment Variables** (tick **Production**) |
| **GitHub Actions** | the scheduled scanner | your repo → **Settings → Secrets and variables → Actions** |

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

**Time and difficulty:** about 20 minutes, once. Most of it is clicking through
Google's website. One step asks you to type a command in a terminal, and this
walkthrough assumes you have never opened one before.

This feature needs four **environment variables** — settings you store with your
app instead of writing them into a file:

| Variable | Required for the feature | How you get it |
|----------|--------------------------|----------------|
| `GOOGLE_CLIENT_ID` | yes | OAuth client (step 3) |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client (step 3) |
| `GOOGLE_REFRESH_TOKEN` | yes | `node get-google-token.mjs` (step 5) |
| `GOOGLE_DRIVE_FOLDER_ID` | no | the ID of a Drive folder to save into; omit to save to your Drive root |

**Use one Google account for all of this** — the account whose Drive you want the
docs in. Signing in with a different account halfway through is the single most
common way this setup fails, and the error it produces (step 5) looks like a
permissions bug rather than a wrong-account mistake.

### Before you start — three things you need on your computer

Steps 1–4 happen in a web browser. Step 5 runs a small program on your own
machine, and these three things have to be in place first.

**1. Node.js, the program that runs the helper script.**

Open a **terminal** — the app where you type commands instead of clicking
buttons. It is already installed on every computer:

- **Mac:** press `Cmd + Space`, type `Terminal`, press Enter.
- **Windows:** click Start, type `PowerShell`, and open **Windows PowerShell**.
- **Linux:** open your **Terminal** app.

You get a mostly-empty window with a blinking cursor. Type this and press Enter:

```
node --version
```

*What success looks like:* a version number, like `v20.11.1` or `v22.3.0`.
Anything **18 or higher** works.

If instead you see `command not found: node` (Mac) or `'node' is not recognized`
(Windows), Node is not installed. Download the **LTS** installer from
[nodejs.org](https://nodejs.org/), run it, accept the defaults, then **close the
terminal window and open a new one** — a terminal only notices newly installed
programs when it starts — and run `node --version` again.

**2. A copy of your JobBud repo on your computer.**

Your **repo** is the folder of JobBud code that lives in your GitHub account. If
you set JobBud up with the Deploy button, that code has never been on your
computer — Vercel copied it straight into GitHub. Get a copy now:

1. Go to [github.com](https://github.com) and open your own JobBud repo (it is at
   `github.com/<your-github-username>/jobbud`; it is private, so sign in first).
2. Click the green **Code** button, then **Download ZIP**.
3. Find the file in your Downloads folder and unzip it — **Mac:** double-click it;
   **Windows:** right-click → **Extract All** → **Extract**.

*What success looks like:* a folder named `jobbud` or `jobbud-main` that contains
`README.md` and `get-google-token.mjs` side by side.

(If you already use Git, `git clone https://github.com/<your-username>/jobbud.git`
does the same thing.)

**3. A terminal opened *inside* that folder.**

Every command runs "in" one folder, and this one only works in the folder that
holds `get-google-token.mjs`.

- **Mac:** open Terminal, type `cd ` (the letters c and d, then a space, and do
  not press Enter yet), then drag the unzipped folder from Finder onto the
  Terminal window — the path types itself — and press Enter.
- **Windows:** open the unzipped folder in File Explorer, hold **Shift** and
  right-click on empty space inside it, and choose **Open PowerShell window
  here**. (On older Windows the item reads "Open command window here"; on Windows
  11 you may need **Show more options** first.)
- **Any system:** you can also type `cd `, paste the folder's full path, and press
  Enter.

*What success looks like:* type `ls` (Mac/Linux) or `dir` (Windows) and press
Enter — the list that prints includes `get-google-token.mjs`. Keep this window
open; step 5 uses it.

### Step 1 — Create a Google Cloud project

*Where you are:* [console.cloud.google.com](https://console.cloud.google.com/) in
your browser, signed in with the Google account you chose above. A "project" is
just a container for the settings you are about to create; it is free.

1. At the top of the page, click the project dropdown (it sits just right of the
   **Google Cloud** logo and shows either a project name or **Select a project**).
2. Click **New Project**, type the name `jobbud`, and click **Create**.
3. Wait a few seconds, then click the same dropdown again and select **jobbud**.

*What success looks like:* the bar at the top now reads **jobbud**. Everything
you do from here lands in this project — if that name is not showing, stop and
select it, or you will configure a project JobBud never uses.

### Step 2 — Turn on the Docs and Drive APIs

*Where you are:* still in the Google Cloud Console, with **jobbud** selected.

1. Open the menu (**☰**, top left) and choose **APIs & Services → Library**.
2. In the search box, type `Google Docs API` and click the result with that exact
   name.
3. Click the blue **Enable** button and wait for the page to reload.
4. Go back to **Library** (browser back button twice, or the menu again), search
   `Google Drive API`, open it, and click **Enable** as well.

*What success looks like:* each of the two pages now shows **API Enabled** with a
**Manage** button where the **Enable** button used to be. If a page shows
**Enable**, that API is still off.

### Step 3 — Set up the consent screen and create an OAuth client

Google is midway through renaming these screens, so your console shows one of two
layouts. Both are named below — use whichever you see.

**3a. Configure the consent screen.**

*Where you are:* menu **☰ → APIs & Services → OAuth consent screen**. In the newer
layout the same thing lives under **☰ → Google Auth Platform → Branding** and
**→ Audience**.

1. If you have never done this, click **Get started** (newer layout) or pick a
   **User Type** (older layout).
2. **App name:** type `JobBud`. **User support email** and **Developer contact
   email:** your own email address.
3. **Audience / User Type:** choose **External**. That sounds wrong for a private
   tool, but it only means "not limited to a Google Workspace organisation" —
   personal Gmail accounts have no other option, and you remain the only user.
4. Click **Create** / **Save**.

*What success looks like:* a summary page showing your app name, with
**Publishing status: Testing**.

**3b. Add yourself as a test user.** Skipping this is what produces the hard
"Access blocked" error in step 5.

1. Older layout: **OAuth consent screen → Test users → + Add users**.
   Newer layout: **Audience → Test users → + Add users**.
2. Type the full email address of the Google account you will sign in with — the
   same one from the top of this section — and click **Save**.

*What success looks like:* your email address is listed under **Test users**.

**3c. Create the OAuth client.**

*Where you are:* menu **☰ → APIs & Services → Credentials** (newer layout:
**Google Auth Platform → Clients**).

1. Click **+ Create Credentials → OAuth client ID** (newer layout: **+ Create
   client**).
2. For **Application type**, choose **Desktop app**. This matters: a Desktop-app
   client is allowed to send its answer back to `http://localhost` — your own
   computer — which is how the helper script catches your token without you
   registering a web address anywhere.
3. Name it `jobbud-helper` and click **Create**.

*What success looks like:* a panel appears showing **Client ID** (a long string
ending in `.apps.googleusercontent.com`) and **Client secret** (a shorter random
string). Copy both somewhere you can get at them in a minute — a notes window is
fine. Treat the secret like a password: no email, no chat, no screenshots. If you
lose them, reopen the client from the **Credentials** / **Clients** list.

### Step 4 — Publish the app, or your token dies in 7 days

**Read this before minting anything.** While your app's publishing status is
**Testing**, Google expires the refresh token after **7 days**. JobBud then stops
saving to Drive, silently, about a week after you finish this setup — and the
cause is invisible unless you know to look for it.

The fix is one button, and doing it **now** saves you from redoing step 5 later:

1. Go to **APIs & Services → OAuth consent screen** (newer layout: **Google Auth
   Platform → Audience**).
2. Click **Publish App**, then **Confirm** in the dialog.

*What success looks like:* **Publishing status: In production**.

Google's dialog warns about verification requirements. It does not apply to you:
verification matters for apps asking strangers for access, and this app has
exactly one user — you. **Do not** submit it for verification. Nothing else
changes, nobody else can use your app, and you never have to think about it again.

If you would rather prove the setup works first, you can mint a token now and
publish afterwards. In that case, **run step 5 again after publishing** —
publishing does not extend a token that was already issued in Testing mode, so
the 7-day one you are holding stays a 7-day one.

### Step 5 — Mint your refresh token

The helper is the file **`get-google-token.mjs`**, at the top level of your copy
of the JobBud repo — the same folder as `README.md`. This is the file you made
sure you could see at the end of "Before you start".

It reads the client ID and secret from the terminal's environment, opens Google's
consent screen in your browser, and prints a refresh token. It stores nothing and
contains no credentials of its own.

*Where you are:* the terminal window you opened inside the repo folder.

The command differs by system because each one has its own way of handing values
to a program. Use the block that matches yours, replacing `your-client-id` and
`your-client-secret` with the two values from step 3c (keep the quotes on
Windows). **Everything must happen in the same terminal window** — these values
live only in that window, they vanish when you close it, and a second window
cannot see them.

**Mac / Linux** — one command, typed or pasted as a single block (the `\` at the
end of a line means "this continues below"):

```bash
GOOGLE_CLIENT_ID=your-client-id \
GOOGLE_CLIENT_SECRET=your-client-secret \
node get-google-token.mjs
```

**Windows PowerShell** — three separate lines; press Enter after each:

```powershell
$env:GOOGLE_CLIENT_ID="your-client-id"
$env:GOOGLE_CLIENT_SECRET="your-client-secret"
node get-google-token.mjs
```

**Windows Command Prompt (cmd)** — three separate lines; press Enter after each:

```
set GOOGLE_CLIENT_ID=your-client-id
set GOOGLE_CLIENT_SECRET=your-client-secret
node get-google-token.mjs
```

> If the script stops with **"GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both
> be set in the environment"**, it means those two values did not reach it. The
> usual cause is using the Mac/Linux block on Windows — the backslashes and the
> `NAME=value node ...` form are Unix-only and Windows ignores them. Use the
> PowerShell or cmd block above, in the same window, and run `node
> get-google-token.mjs` last.

*What success looks like:* the terminal prints "Opening Google's consent screen
in your browser…" and your browser opens a Google sign-in page. (If no browser
window appears, the terminal also prints the full web address — select it, copy
it, and paste it into your browser yourself.) Sign in **with the account you
added as a test user**, work through the screens below, and click **Allow**. The
browser then says "Success! Refresh token minted." and your terminal prints a
long string under **Your GOOGLE_REFRESH_TOKEN:**.

Copy that string out of the terminal — highlight it with the mouse, then
`Cmd + C` on Mac, or right-click the selection in PowerShell (right-click copies
there; `Ctrl + C` would stop the program instead). Paste it somewhere safe for a
moment; it is the value you enter in step 6, and it is as sensitive as a
password.

#### Screens you may see while approving

**"Google hasn't verified this app"** — a warning page with a **Back to safety**
button. This is expected. Click **Advanced** (bottom left), then **Go to JobBud
(unsafe)**, then continue. Nothing unsafe is happening: this is *your* app, in
*your* Google account, asking for access to *your* Drive. That warning exists to
protect people from unknown third-party apps, and there is no third party here.
Do not submit the app for verification — see step 4.

**"Access blocked: JobBud has not completed the Google verification process"**,
with **Error 403: access_denied** — this one is a wall, not a warning, and it
means the account you just signed in with is **not on the Test users list**
(or the app is still in Testing and you signed in as someone else). Fix it:

1. Go back to the Google Cloud Console, check the top bar still says **jobbud**.
2. **APIs & Services → OAuth consent screen → Test users → + Add users** (newer
   layout: **Audience → Test users → + Add users**).
3. Add the exact email address you were signing in with, and **Save**.
4. Run the step 5 command again, and sign in with **that same account**.

If you published the app in step 4 and still get this, you are almost certainly
signed into a second Google account in that browser — sign out of the others, or
retry in a private/incognito window.

**"No refresh token was returned"** — printed in the terminal, not the browser.
You have authorized this app before. Remove it at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
(find JobBud, click **Remove access**) and run the command again.

### Step 6 — Put each value where it belongs

You now hold four values, and each one belongs in a different set of places.
Getting this wrong is the other common failure — a value in the wrong vault does
nothing and warns you about nothing.

| Value | Where it came from | Terminal (step 5) | Vercel env vars | GitHub Actions secrets |
|-------|--------------------|-------------------|-----------------|------------------------|
| `GOOGLE_CLIENT_ID` | step 3c | yes, temporarily | **yes** | **yes** |
| `GOOGLE_CLIENT_SECRET` | step 3c | yes, temporarily | **yes** | **yes** |
| `GOOGLE_REFRESH_TOKEN` | printed by step 5 | no — it is the output | **yes** | **yes** |
| `GOOGLE_DRIVE_FOLDER_ID` | a Drive folder URL (below) | no | optional | optional |

The terminal column is temporary by design: those values existed only in that one
window, only long enough to mint the token, and they are gone once you close it.
The two columns that persist are the ones JobBud actually reads:

- **Vercel** → your project → **Settings → Environment Variables** → **Add New**
  for each row, name on the left, value on the right (powers prep docs you
  generate from the dashboard).
- **GitHub** → your repo → **Settings → Secrets and variables → Actions** → **New
  repository secret** for each row (powers prep and application docs generated by
  the scheduled scans).

These are the four name/value pairs to enter — not something to type into a
terminal. Use the names exactly as written, with no quotes and no spaces around
the value:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_DRIVE_FOLDER_ID=...   # optional
```

In Vercel, tick **Production** for each variable as you add it — your live site
reads Production only, so a variable left on Development alone does nothing for
it. Then redeploy (**Deployments → ⋯ → Redeploy** on the newest one) so the new
variables take effect.

*What success looks like:* open your dashboard, generate a prep doc for any job,
and the job card shows a **Google Doc** link that opens a real document in your
Drive.

> If nothing changes — the feature stays dead, or the API comes back
> "Unauthorized" — the variables are almost certainly missing from Production.
> The [README](README.md#1-deploy-to-vercel) explains this trap in full.
>
> If it worked and then stopped about a week later, your app is still in
> **Testing** mode. Publish it (step 4) and run step 5 again for a fresh token.

To find a `GOOGLE_DRIVE_FOLDER_ID`: open the folder in Google Drive and copy the
last part of the address bar's URL (`.../folders/THIS_PART`). Leave it unset and
JobBud saves to the top level of your Drive.

---

## Optional: API job sources (JSearch, Adzuna)

By default JobBud only looks at the companies on your watch list. These two
services widen that to jobs from across the web — roles at companies you have
never heard of, scored against your profile by exactly the same pipeline.

Each source is independent. Set up one or both; skip them entirely and
JobBud still scans everything on your company watch list — the file
`scanner/portals.yml`, which you edit from the dashboard's **Radar tab → ⚙ Edit
Watch List**.

### What each one adds

| Service | What it adds |
|---------|--------------|
| **JSearch** | A broad aggregated job feed, searched by your target roles and locations. |
| **Adzuna** | Job-board listings for the US, UK, and Singapore. In `config/profile.yml` write the country as `us`, `gb` or `sg` — `usa` and `uk` are understood too; anything else is skipped, and the scan log says which location it skipped and why. |

> **SerpApi (Google Jobs) is not currently wired to scheduled scans.** The scanner
> still knows how to call it, but the weekly workflow does not pass a
> `SERP_API_KEY` through to it, so adding that secret today would do nothing.
> There is nothing for you to set up — it will come back with a future update.

### Where to sign up

- **JSearch** is sold through the **RapidAPI** marketplace at
  [rapidapi.com](https://rapidapi.com) — create a RapidAPI account, subscribe to
  the JSearch API, and copy the API key it issues you.
- **Adzuna** is at [adzuna.com](https://www.adzuna.com). Register for its
  developer API and it issues you a **pair** of values, an app ID and an app key.
  You need both.

Each service sets its own pricing, usually with a small free tier. Check the
current plan on the site before you rely on it — the scan makes real API calls.

### Telling JobBud how big your allowance is

JobBud keeps its own count of the calls it makes each month and stops a source
before it runs past the limit. It cannot ask the provider what your limit is, so
it assumes a conservative one: 250 calls a month for Adzuna, 200 for JSearch,
250 for SerpApi. **Your real Adzuna limit is shown in the Adzuna developer
dashboard** — the free tier is commonly around 1,000 calls a month, four times
what JobBud assumes. If yours is higher than the assumption, say so and JobBud
will use the room:

| Setting | What it does |
|---------|--------------|
| `ADZUNA_MONTHLY_LIMIT` | Adzuna calls JobBud will make per month (default 250) |
| `JSEARCH_MONTHLY_LIMIT` | JSearch calls per month (default 200) |
| `SERPAPI_MONTHLY_LIMIT` | SerpApi calls per month (default 250) |

These are settings, not secrets — nothing breaks if you leave them alone, and
setting one higher than your real plan just means the provider starts refusing
calls before JobBud does.

Adzuna searches one target role in one location at a time, so a profile with
five cities and seven roles is 35 searches — far more than a month's budget can
afford every run. Rather than skip Adzuna on those runs, JobBud runs a slice
each time and moves through the list, so every search still gets made, just
over several runs. The scan log says which slice ran and how many runs a full
pass takes. `ADZUNA_CALLS_PER_RUN` sets the slice size if you want a different
one; by default it is a thirty-first of your monthly limit.

### Where the keys go

*Where you are:* github.com, in your own JobBud repo, under **Settings → Secrets and variables → Actions**
— that is the repo's own **Settings** tab along the top of the repo page, not your
account settings. Click the green **New repository secret** button. Add each key
you have, using these exact names — the name goes in **Name**, the key itself in
**Secret**:

| Secret | Which service |
|--------|---------------|
| `JSEARCH_API_KEY` | JSearch (via RapidAPI) |
| `ADZUNA_APP_ID` | Adzuna — the app ID |
| `ADZUNA_API_KEY` | Adzuna — the app key |

These are **the one exception** to the two-vaults rule at the top of this file.
The scanner runs on GitHub Actions and it is the only thing that reads them, so
they go in Actions secrets and nowhere else. Adding them to Vercel does nothing.

(`.env.example` lists the same names for local development, if you run the
scanner on your own machine. That file is not read by the deployed system.)

### When they take effect

The API sources run in the **JobBud Weekly API Scan** workflow, on a schedule of
every Monday at 6am UTC. You do not have to wait for it: in your repo, open the
**Actions** tab (top of the repo page), pick **JobBud Weekly API Scan** from the
list on the left, then click the **Run workflow** button on the right and confirm.

*What success looks like:* after a few seconds a new run appears at the top of the
list with a spinning amber dot, turning into a green tick when it finishes. Click
the run, then the **scan** job, to read its log line by line.

### If nothing shows up

Open that run's log and look at the top of the scan. A source with a missing key
says so in plain text and skips itself:

```
JSearch API key not set -- skipping
Adzuna credentials not set -- skipping
SerpAPI key not set -- skipping
```

The **SerpAPI** line is expected on every run and there is nothing to fix — as
above, that source is not currently wired to scheduled scans.

Seeing one of the other two lines when you *did* add the key means it landed in the wrong
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
