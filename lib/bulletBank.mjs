// lib/bulletBank.mjs — pure parsing helpers for bullet-bank.md.
//
// bullet-bank.md has two jobs, and they must never blur together:
//
//   1. The BODY holds bullets taken VERBATIM from the user's own resume. These
//      are the only bullets that may ever appear in a generated resume.
//   2. The SUGGESTIONS section at the bottom holds AI-written bullets for
//      achievements the user mentioned in conversation but never put on their
//      resume. Every one carries an [ai-suggested] tag and a "Why:" rationale.
//      These are advisory only — they surface in the package's suggestions area
//      and are NEVER selected into the resume body.
//
// The file also declares the user's OWN role-type tags. Those tags used to be
// invisible to the app: the Generate Package modal shipped a hardcoded list of
// the original author's five categories, so every user filtered their bullets
// against tags that did not exist in their bank. The `Tags:` legend line parsed
// here is what makes the modal show the user's real tags instead.
//
// Everything in this file is pure string work so it can be unit-tested without
// network or filesystem access.

// The tag that marks an AI-written suggestion. Never a selectable role type,
// and never valid on a resume-body bullet.
export const AI_SUGGESTED_TAG = 'ai-suggested';

// Tags that carry meaning other than "role type" and must never be offered to
// the user as a role-type checkbox.
export const RESERVED_TAGS = new Set([
  AI_SUGGESTED_TAG,
  'primary',
  'alt',
  'optional',
  'allow-2',
]);

// Shown when the user has no bullet bank yet, or when its legend cannot be
// parsed. Deliberately generic — the dashboard pairs it with a line explaining
// that these become the user's own tags once onboarding builds the bank.
export const FALLBACK_ROLE_TAGS = [
  { value: 'operations', label: 'Operations / Program Management' },
  { value: 'strategy',   label: 'Strategy / Business Development' },
  { value: 'finance',    label: 'Finance / Analytics' },
  { value: 'product',    label: 'Product / Project Management' },
  { value: 'leadership', label: 'Leadership / People Management' },
];

const MAX_TAGS = 12;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// The "Suggested Additions" heading, matched the way models actually emit it.
//
// The prompt asks for `## Suggested Additions (AI-written — not from your
// resume)`, but a language model paraphrases its own headings. Observed and
// plausible variants that a `^#{1,6}` -only pattern silently missed:
//
//   **Suggested Additions (AI-written)**   bold line, no hash at all
//   ## **Suggested Additions**             hash AND bold
//   ## AI-Suggested Additions              reworded
//   ## Suggested Addition                  singular
//
// Every miss has the same consequence and it is the dangerous direction: the
// entire AI-written section stays inside the "verbatim body" that the package
// generator hands the model as the user's own resume language.
//
// A heading must carry a `#` or a bold marker. Without that gate an ordinary
// prose line ("Suggested Additions are advisory only") would split the file.
const SUGGESTIONS_HEADING_SRC =
  '^[ \\t]*(?:(#{1,6})[ \\t]*\\**|\\*{1,3})[ \\t]*(?:AI[-\\s]?)?Suggested[ \\t]+Additions?\\b.*$';

function suggestionsHeadingRe() {
  return new RegExp(SUGGESTIONS_HEADING_SRC, 'im');
}

// A markdown bullet or numbered-list line. Used to answer "does this bank
// actually contain any bullets?" — see splitBulletBank's callers.
export const BULLET_LINE_RE = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+\S/m;

/**
 * Belt-and-braces quarantine: pull every line carrying the [ai-suggested] tag
 * out of a bank body, regardless of what headings surround it.
 *
 * The heading split above is the primary mechanism, but headings are the part a
 * model is most free to reword. The tag itself is the part the prompt is most
 * explicit about, so it makes a far more reliable second gate. A tagged line's
 * following "Why:" rationale line belongs to it and travels with it.
 *
 * @param {string} body bank text with the suggestions section already removed
 * @returns {{kept: string, moved: string}}
 */
export function quarantineAiSuggestedLines(body) {
  if (!body) return { kept: '', moved: '' };
  const needle = `[${AI_SUGGESTED_TAG}]`;
  if (!body.toLowerCase().includes(needle)) return { kept: body, moved: '' };

  const lines = body.split('\n');
  const kept = [];
  const moved = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(needle)) { kept.push(lines[i]); continue; }
    moved.push(lines[i]);
    // Carry the rationale line(s) that belong to this bullet.
    while (i + 1 < lines.length && /^[ \t>*_-]*\**Why\**[ \t]*:/i.test(lines[i + 1])) {
      moved.push(lines[++i]);
    }
  }
  return { kept: kept.join('\n'), moved: moved.join('\n') };
}

// Strip the markdown a model tends to wrap a tag in: backticks, brackets,
// bold/italic asterisks, stray whitespace.
function cleanSlug(raw) {
  return String(raw)
    .replace(/[`*_]/g, '')
    .replace(/[[\]]/g, '')
    .trim()
    .toLowerCase();
}

function cleanLabel(raw) {
  return String(raw)
    .replace(/[`*]/g, '')
    .trim()
    .replace(/[.;,]+$/, '')
    .slice(0, 80)
    .trim();
}

function pushTag(out, seen, slugRaw, labelRaw) {
  const value = cleanSlug(slugRaw);
  if (!SLUG_RE.test(value)) return;
  if (RESERVED_TAGS.has(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  const label = cleanLabel(labelRaw || '');
  out.push({ value, label: label || value });
}

/**
 * Parse the role-type tag legend out of a bullet-bank.md.
 *
 * PRIMARY FORMAT — the one BULLET_BANK_SYSTEM instructs the model to emit, a
 * single line in the "How to Use This File" section:
 *
 *   Tags: ops = Business Operations / Chief of Staff; finance = Strategic Finance
 *
 * Entries are separated by `;`, each is `slug = Human label`. The line may be
 * bolded or bulleted; leading `**`/`-` are tolerated.
 *
 * FALLBACK FORMAT — legacy banks (and hand-edited ones) list tags as bullets:
 *
 *   - `[ops]` = Business Operations, Chief of Staff
 *
 * Both are parsed defensively: anything that is not a plausible slug is dropped
 * rather than surfaced as a broken checkbox. Returns [] when nothing parses, so
 * callers can fall back to FALLBACK_ROLE_TAGS.
 *
 * @param {string} text raw bullet-bank.md contents
 * @returns {{value: string, label: string}[]}
 */
export function parseBulletBankTags(text) {
  if (!text || typeof text !== 'string') return [];

  // Only ever read the legend, never the bullets themselves — a bullet's inline
  // `[ops][primary]` tags are noisy and would leak priority tags into the list.
  const legendScope = text.split(suggestionsHeadingRe())[0];

  const out = [];
  const seen = new Set();

  // 1. The canonical `Tags:` legend line.
  // Bold markers may sit anywhere around the word and the colon: `Tags:`,
  // `**Tags:**`, and `**Tags**:` are all things a model emits. The old pattern
  // pinned the colon directly to the word and so missed the third form, which
  // dropped the user back to the generic fallback role types.
  const legendLine = legendScope.match(/^[ \t]*(?:[-*][ \t]*)?\**Tags\**[ \t]*:\**[ \t]*(.+)$/im);
  if (legendLine) {
    for (const entry of legendLine[1].split(';')) {
      if (!entry.trim()) continue;
      const eq = entry.indexOf('=');
      if (eq === -1) {
        // Tolerate a bare list of slugs ("Tags: ops; finance") — no labels.
        pushTag(out, seen, entry, '');
      } else {
        pushTag(out, seen, entry.slice(0, eq), entry.slice(eq + 1));
      }
      if (out.length >= MAX_TAGS) return out;
    }
  }
  if (out.length) return out;

  // 2. Legacy bullet-list legend: - `[ops]` = Business Operations
  const bulletRe = /^[ \t]*[-*][ \t]*`?\[([^\]\n]{1,40})\]`?[ \t]*[=:–—-][ \t]*(.+)$/gim;
  let m;
  while ((m = bulletRe.exec(legendScope))) {
    pushTag(out, seen, m[1], m[2]);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Split a bullet bank into its verbatim body and its AI-suggestions section.
 *
 * This is a real mechanism, not a prompt request: the package generator sends
 * the body as the authoritative bullet source and the suggestions block as a
 * separate, explicitly advisory block, so an [ai-suggested] bullet is never
 * sitting in the same text the model is told to copy verbatim from.
 *
 * The suggestions section is normally last, but it need not be — a model that
 * emits a company section after it would otherwise cost the user every real
 * resume bullet in that section, because a naive "everything after the heading"
 * slice swallows it. The slice therefore ends at the next heading of the same or
 * a higher level, and that remainder is returned to the body.
 *
 * @param {string} text raw bullet-bank.md contents
 * @returns {{body: string, suggestions: string, hasSuggestions: boolean}}
 */
export function splitBulletBank(text) {
  if (!text || typeof text !== 'string') {
    return { body: '', suggestions: '', hasSuggestions: false };
  }
  const m = text.match(suggestionsHeadingRe());
  if (!m || m.index == null) {
    return { body: text, suggestions: '', hasSuggestions: false };
  }

  const before = text.slice(0, m.index);
  const rest = text.slice(m.index);

  // Heading level of the suggestions heading itself. The bold-line form carries
  // no hashes; treat it as a section heading (level 2), which is what a model
  // that writes bold headings is expressing.
  const level = m[1] ? m[1].length : 2;

  // Only `#` headings terminate the section. A standalone bold line inside an
  // AI-written section ("**Why this matters**") is far more likely to be emphasis
  // than a new section, and mistaking one for a heading would push AI-written
  // text back into the verbatim body — the exact failure this file exists to
  // prevent. Erring the other way merely keeps extra text advisory.
  const nextRe = new RegExp(`^[ \\t]*(#{1,${level}})[ \\t]*(?!#)\\S.*$`, 'm');
  const after = rest.slice(m[0].length);
  const next = after.match(nextRe);

  const suggestions = (next && next.index != null
    ? after.slice(0, next.index)
    : after);
  const tail = next && next.index != null ? after.slice(next.index) : '';

  const body = [before.trimEnd(), tail.trim()].filter(Boolean).join('\n\n');
  const full = (m[0] + suggestions).trim();
  return { body, suggestions: full, hasSuggestions: full.length > 0 };
}
