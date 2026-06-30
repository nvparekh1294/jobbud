# LinkedIn Radar Research
# For companies of interest with no open role — JavaScript extraction, no screenshots unless stuck

## Step 0 — Load the company

Read `current_company.json` from the current directory. Extract:
- `COMPANY_NAME` — the company name
- `COMPANY_SLUG` — the LinkedIn slug
- `WHY_INTERESTED` — why this company is interesting
- `CONTACT_PRIORITY` — array of contact types to prioritize (ceo, peer, investor)
- `COMPANY_ID` — the Radar entry ID

If the file is missing, stop and say "current_company.json not found — click Queue Company File on the dashboard first."

---

## Approach: JavaScript-first, screenshots only if stuck

Do not take screenshots to navigate or read content. Use JavaScript execution and direct navigation instead. Only take a screenshot if a step fails and you cannot determine why from the DOM.

You are gathering information only. Do not send messages, connection requests, or take any action that writes, posts, or communicates on behalf of the user.

---

## Critical rules

- **Do NOT navigate to any person's full profile page** (`linkedin.com/in/...`). Visiting a profile records a view.
- **Only click "X mutual connections" links** to expand full mutual lists.
- Wait 1–2 seconds between navigations. Do not add unnecessary waits between JavaScript calls.
- Stop immediately if LinkedIn shows a CAPTCHA or rate-limit warning.
- **Skip recruiter search entirely** — there is no open role to apply for.

---

## Step 1 — Navigate to employee search

1. Navigate to: `https://www.linkedin.com/company/[COMPANY_SLUG]/`
2. Execute JavaScript to find the employee count link:
```javascript
const links = Array.from(document.querySelectorAll('a'));
const emp = links.find(l => l.innerText && l.innerText.match(/\d.*employee/i));
emp ? emp.href : 'NOT FOUND';
```
3. Navigate to the URL returned.

---

## Step 2 — Extract all visible employees

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
    && !line.includes('mutual') && line.length > 3 && !line.match(/^\d+$/)) {
    current.role = line;
  } else if (current && (line.includes('mutual connection') || line.includes('is a mutual'))) {
    current.mutual = line;
  }
}
if (current) results.push(current);
JSON.stringify(results);
```

Prioritize people whose roles match the `CONTACT_PRIORITY` from `current_company.json`:
- `ceo` → CEO, Founder, Co-Founder, President, MD, Managing Director
- `peer` → VP/Director/Head of Strategy, Operations, Finance, BizOps, CorpDev
- `investor` → Investor, Partner, Principal (if they appear in company connections)

---

## Step 3 — Expand partial mutual connection lists

For any 2nd degree person whose mutual text says "and X other mutual connections":

```javascript
const mutualLinks = Array.from(document.querySelectorAll('a, button, span[role="button"]'))
  .filter(el => el.innerText && el.innerText.match(/mutual connection/i));
mutualLinks.map(el => ({ text: el.innerText.trim(), tag: el.tagName }));
```

Click the relevant link, wait 1 second, extract the popup:

```javascript
const popup = document.querySelector('[class*="modal"], [class*="popup"], [class*="artdeco-modal"]');
popup ? popup.innerText : document.body.innerText.substring(0, 3000);
```

---

## Step 4 — Paginate (up to 5 pages)

```javascript
const nextBtn = Array.from(document.querySelectorAll('button, a'))
  .find(el => el.getAttribute('aria-label') === 'Next' || el.innerText.trim() === 'Next');
if (nextBtn) { nextBtn.click(); 'clicked'; } else { 'no next button'; }
```

Wait 2 seconds, re-run Step 2 extraction. Repeat up to 5 pages.

---

## Step 5 — Find investors (if `investor` is in CONTACT_PRIORITY)

Navigate to:
`https://www.linkedin.com/search/results/people/?keywords=investor+partner&currentCompany=[COMPANY_ID]&origin=FACETED_SEARCH`

Run Step 2 extraction. Collect anyone with titles including: Investor, Partner, Principal, General Partner, Managing Partner, Venture Partner, at a VC or PE firm.

Also try `keywords=venture+capital` if the first search returns few results.

---

## Step 6 — Find functional peers (if `peer` is in CONTACT_PRIORITY)

Run searches for:
- `strategy+operations`
- `business+operations`
- `chief+of+staff`
- `strategic+finance`
- `corporate+development`

For each, run Step 2 extraction and collect relevant matches. Skip clearly unrelated roles.

---

## Step 7 — Research creative outreach hooks

Do targeted web research on the company and top 3-4 priority contacts. Max 8 searches total. Look for:
- Company news from the last 6 months (funding, product launches, major hires, press)
- Any public writing, talks, or posts from highest-priority contacts
- Specific challenges or problems the company is publicly working on
- What makes this company specifically interesting given WHY_INTERESTED

---

## Output

### Save to `[COMPANY_NAME]_radar.csv`

Columns: `name,current_role,connection_degree,mutual_connections,category,outreach_priority,notes`

Categories: `direct` | `warm_intro` | `ceo_founder` | `peer` | `investor`

Priority: `high` | `medium` | `low` | `note_only`

Also save the full terminal summary (all sections plus best first move and outreach hooks) to `[COMPANY_NAME]_radar_summary.md` in the same directory. This ensures the summary is not lost when Terminal closes.

### Print a terminal summary:

```
🎯 RADAR RESEARCH — [COMPANY_NAME]

🔗 DIRECT CONNECTIONS
🤝 WARM INTRO PATHS (sorted by role relevance, then mutual count)
👔 CEO / FOUNDER CONTACTS
📊 FUNCTIONAL PEERS
💰 INVESTOR CONNECTIONS

💡 OUTREACH HOOKS

Company angle: [1-2 specific things worth referencing — recent news, funding, product, challenge]

Per-contact hooks (top priority contacts only):
- [Name] ([role]): [specific reason they might respond — background overlap, something they've written, problem they're working on]

🎯 BEST FIRST MOVE: [1-2 sentence recommendation on where to start and why]
```

---

## If JavaScript extraction returns empty

```javascript
document.body.innerText.substring(0, 5000);
```

Read the raw text to identify the current page structure, then adapt selectors accordingly.
