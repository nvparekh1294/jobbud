# LinkedIn Warm Intro & Outreach Research
# Optimised: JavaScript extraction — no screenshots unless stuck

---

**RULE: Never record "and X other mutual connections" as the final value. Always expand first. A record with an unexpanded mutual list is incomplete and must be fixed before moving on.**

---

## Step 0 — load the job

Read the job details from `current_job.json`. The JobBud dashboard writes this file into the repo at `linkedin-research/current_job.json` when you click "Queue Job File", so make sure you have the latest copy before starting:

- If `~/linkedin-research` is a clone of your JobBud repo, run `git fetch origin && git checkout origin/main -- linkedin-research/current_job.json` first — this force-fetches the canonical remote version and ignores any local modifications.
- Read `current_job.json` from the current directory. If it is not there, read `linkedin-research/current_job.json` from the repo root.

Do not ask the user to fill in placeholders. The file looks like (values below are an illustrative example, not real):

```json
{
  "company": "Acme Analytics",
  "slug": "acme-analytics",
  "jobTitle": "Director of Operations",
  "jobFunction": "Business Operations",
  "jobId": "acme-analytics-director-of-operations-00000"
}
```

Map the values to the placeholders used throughout this document:

- `[COMPANY_NAME]` → `company`
- `[COMPANY_SLUG]` → `slug`
- `[JOB_TITLE_APPLIED_FOR]` → `jobTitle`
- `[JOB_FUNCTION]` → `jobFunction`

`[COMPANY_ID]` is the numeric LinkedIn company ID. It is not in the file; you find it during Step 1.

## The user's background (for relevance assessment)

You are running this on behalf of the user — the person self-hosting JobBud. Do not assume any background or target roles. Read them at runtime from the user's own profile files, checking in this order:

- `config/profile.yml` — target roles, seniority, location/remote preferences
- `CLAUDE.md` — positioning and narrative context
- `cv.md` — full work history

Use this to judge which employees and mutual connections are relevant (peers, potential hiring managers, or senior stakeholders for the user's target roles) and to shape outreach hooks later. If none of these files are available, ask the user for their target roles and a one-line background before proceeding.

---

## Approach: JavaScript-first, screenshots only if stuck

**Do not take screenshots to navigate or read content.** Use JavaScript execution and direct navigation instead — it is faster and uses far fewer tokens. The only time to take a screenshot is if a navigation or extraction step fails and you cannot determine why from the DOM.

You are gathering information only. Do not send messages, connection requests, or take any action that writes, posts, or communicates on the user's behalf.

---

## Critical rules

- **Do NOT navigate to any person's full profile page** (`linkedin.com/in/...`). Visiting a profile records a view.
- **Only click "X mutual connections" links** to expand full mutual lists — not profile links.
- Wait 1–2 seconds between navigations. Do not add unnecessary waits between JavaScript calls on the same page.
- Stop immediately if LinkedIn shows a CAPTCHA or rate-limit warning.

---

## Step 1 — Navigate to the employee search

1. Navigate to: `https://www.linkedin.com/company/[COMPANY_SLUG]/`
2. Execute this JavaScript to find and return the href of the "See all X employees" link:
```javascript
const links = Array.from(document.querySelectorAll('a'));
const emp = links.find(l => l.innerText && l.innerText.match(/\d.*employee/i));
emp ? emp.href : 'NOT FOUND';
```
3. Navigate to the URL returned. If NOT FOUND, try navigating directly to:
   `https://www.linkedin.com/search/results/people/?origin=COMPANY_PAGE_CANNED_SEARCH&currentCompany=[COMPANY_ID]`
   — get the company ID by executing: `window.location.href` on the company page and noting the numeric ID in the URL.

---

## Step 2 — Extract and expand employees (repeat per page)

Run Steps 2a and 2b on every page before paginating. Do not advance to the next page until all expansions on the current page are complete.

### Step 2a — Extract visible employees

Once on the employee search results page, execute this JavaScript to extract all visible people cards:

```javascript
const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
const results = [];
let current = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('• 1st') || line.includes('• 2nd') || line.includes('• 3rd+')) {
    if (current) results.push(current);
    const degree = line.includes('1st') ? '1st' : line.includes('2nd') ? '2nd' : '3rd+';
    current = { name: lines[i-1] || '', degree, role: '', mutual: '' };
  } else if (current && !current.role && !['Connect','Message','Follow'].includes(line)
    && !line.includes('mutual') && !line.match(/and \d+ other/i) && line.length > 3 && !line.match(/^\d+$/)) {
    current.role = line;
  } else if (current && (line.includes('mutual connection') || line.includes('is a mutual') || line.match(/and \d+ other/i) || line.match(/\+\d+/))) {
    current.mutual = line;
  }
}
if (current) results.push(current);
JSON.stringify(results);
```

After running, identify every entry whose `mutual` field matches `/and \d+ other/i` or `/\+\d+/` — these must be expanded in Step 2b before recording.

## Step 2b — Expand partial mutual lists (navigate to the mutual-connections page)

**Key insight — LIVE-VERIFIED against a real logged-in session:** the flow runs on the
**employee SEARCH RESULTS page** (company page → click the "10k+ employees" link →
1st/2nd network filter), NOT the company page's "People" tab. On the search results
page, each person's "and X other mutual connections" **is a real link** whose href is
a people-search URL containing `connectionOf=["<member-id>"]` — navigating to it lists
**every** mutual connection as standard paginated search results (verified live: 16 such
anchors on one company's results page; a 40-mutual list extracted across 4 pages).
Two traps, both verified: (1) the company page's **"People" tab** renders the same
text as a plain span with NO link — if you ever see no links, you are on the wrong
surface; go back to the employee search results. (2) Person-name card links also
match a text search for "mutual connection" — the reliable discriminator is that
the true expand link's **href contains `connectionOf`**. There is never a pop-up.

For every person whose `mutual` field contains "and X other" or "+X":

**Step 2b.1 — On the results page, collect each person's mutual-connections link
(read hrefs, do not click).**

```javascript
// The expand link is the anchor whose HREF contains "connectionOf".
// (Text alone also matches whole-card person links — filter on the href.)
const links = Array.from(document.querySelectorAll('a'))
  .filter(a => /other mutual connection/i.test(a.innerText || '')
            && /connectionOf/.test(a.href));
JSON.stringify(links.map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href })));
```

Match each link to its person: the anchor sits inside that person's result card
(walk up to the card container and read the person's name from its `a[href*="/in/"]`
profile link, or match by on-page order). Build `{ name → mutualHref }`.

**Step 2b.2 — FALLBACK ONLY (when a person shows mutual text but no connectionOf
anchor — e.g. DOM drift or a different surface):** read that person's profile link
(`a[href*="/in/"]` on their card), navigate to the profile, and take the
mutual-connections anchor there (verified to exist on profile pages, same
`connectionOf` href shape). If neither surface yields a link, record the original
`mutual` text plus "EXPANSION FAILED — manual check needed". If a person's mutual
line already lists ALL names with no "and X other" (small counts), record those
names directly and skip 2b.3.

**Step 2b.3 — Navigate to the mutual href and read ALL names (paginate!).**
On the mutual-connections search page:

```javascript
// VERIFIED extraction: result names are the first text line of profile anchors.
const names = Array.from(document.querySelectorAll('a[href*="/in/"]'))
  .map(a => (a.innerText || '').split('\n')[0].trim())
  .filter(t => t && t.length > 2 && t.length < 50 && !/view|connect|message|·/i.test(t));
JSON.stringify([...new Set(names)]);
```

Results are paginated (~10 per page, numbered page buttons at the bottom). If the
person's stated count exceeds the names extracted, append `&page=2` (then `&page=3`,
…) to the same URL and repeat until you have them all or pages are exhausted.

**Step 2b.4 — Navigate back** to the employee search URL and continue with the next
person. Success = full names recorded. There is no modal to detect anywhere in this
flow. Never leave "+X others" in the output without an "EXPANSION FAILED" note.

---

**FIRST-COMPANY LIVE-CHECK (required — a human must confirm this once).** The exact
selector for the mutual link and LinkedIn's current mutual-connections URL format
must be confirmed against a real logged-in page, because the page structure changes
over time and can differ by account. On the **first person of the first company**:
print the link's `href` (from 2b.1) and the extracted `names` (from 2b.3), and confirm
the real names come through before processing anyone else. If either returns nothing,
read `document.body.innerText.substring(0, 3000)` on the mutual-connections page to
see the current structure, adjust the selector, then lock it in for the rest of the run.

**Hard rule: do not paginate to the next page until every truncated mutual on the current page has been resolved or explicitly marked EXPANSION FAILED.**

### Step 2c — Paginate

```javascript
// Find and click the Next button
const nextBtn = Array.from(document.querySelectorAll('button, a'))
  .find(el => el.getAttribute('aria-label') === 'Next' || el.innerText.trim() === 'Next');
if (nextBtn) { nextBtn.click(); 'clicked'; } else { 'no next button'; }
```

Wait 2 seconds after clicking, then repeat Steps 2a and 2b for the new page. Repeat for up to 5 pages total.

---

## Step 3 — Filter by connection degree (optional optimisation)

If the results contain many 3rd+ degree people with no mutual connections, apply the 2nd-degree filter using the URL parameter: add `&network=%5B%22S%22%5D` for 2nd degree or `%5B%22F%22%5D` for 1st degree, or look for the Connections filter button on the page and click it via JavaScript.

---

## Step 4 — Find recruiters

Navigate to:
`https://www.linkedin.com/search/results/people/?keywords=recruiter&currentCompany=[COMPANY_ID]&origin=FACETED_SEARCH`

Run the Step 2 extraction JavaScript (including expanding any truncated mutual lists). Collect anyone with titles including: Recruiter, Talent Acquisition, Recruiting Manager, Head of Talent, People Operations, Technical Recruiter.

Also run a second search replacing `recruiter` with `talent acquisition` in the URL.

---

## Step 5 — Find role-relevant people

Run these searches using the same URL pattern, replacing the keywords with terms drawn from the user's target roles (read from `config/profile.yml` / `cv.md`). Choose 3–5 keyword searches that match the user's actual targets. For example, a user targeting operations roles might search:

- `operations+manager`
- `product+manager`

(These are illustrative — substitute the user's real target-role keywords.)

For each, run the Step 2 extraction (including expanding any truncated mutual lists) and collect anyone whose role is plausibly a hiring manager, peer, or senior stakeholder for [JOB_TITLE_APPLIED_FOR]. Skip clearly unrelated roles.

---

## Step 6 — Verification gate: no truncated mutual lists remain

Before writing any output or CSV, scan every collected row and check whether the `mutual_connections` field matches `/and \d+ other/i` or `/\+\d+/`. If any matches are found, return to LinkedIn and resolve each one using the Step 2b expansion procedure before continuing. **Do not write the CSV until all rows are clean.** A row with a truncated mutual count is invalid output.

---

## Output

### Save to `[COMPANY_NAME]_connections.csv`

Columns: `name,current_role,connection_degree,mutual_connections,category,outreach_priority,notes`

Categories: `direct` | `warm_intro` | `recruiter` | `relevant_role`

Priority: `high` | `medium` | `low` | `note_only`

Also save the full terminal summary (all three sections plus best first move and outreach hooks) to `[COMPANY_NAME]_connections_summary.md` in the same directory. This ensures the summary is not lost when Terminal closes.

### Print a terminal summary in three sections:

```
🔗 DIRECT CONNECTIONS AT [COMPANY_NAME]
🤝 WARM INTRO PATHS (sorted by role relevance, then mutual count)
📬 DIRECT OUTREACH TARGETS (recruiters first, then relevant roles)
```

Include a brief "best first move" recommendation at the end.

---

## Step 7 — Research creative outreach hooks

After generating the summary, do targeted web research on the company and the top 3-4 priority contacts. Max 8 web searches total. Look for:

- Company news from the last 6 months (funding, product launches, major hires, press)
- Any public writing, talks, or posts from the highest-priority contacts
- Specific challenges or problems the company is publicly working on

Then append a "Hook ideas" section to the terminal summary, structured like this:

```
💡 OUTREACH HOOKS

Company angle: [1-2 specific things about the company worth referencing — e.g. recent product launch, funding context, a challenge they're visibly tackling]

Per-contact hooks (top priority contacts only):
- [Name] ([role]): [1-2 specific reasons this person might respond — their background overlap with the user, something they've written, a problem they're likely thinking about]
```

The hooks must be specific, not generic. If nothing substantive turns up for a particular contact, skip them rather than writing a vague idea. Speed matters: if the 8 searches don't yield anything useful, say so and move on.

---

## If a JavaScript extraction returns empty or garbled results

LinkedIn may have updated its DOM structure. Fall back to:
```javascript
document.body.innerText.substring(0, 5000);
```
Read the raw text to identify the current page structure, then adapt the extraction selectors accordingly. Take a screenshot only if the text is also unreadable.
