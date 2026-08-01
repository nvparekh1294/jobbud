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
  const legendScope = text.split(/^#{1,6}\s*Suggested Additions\b/im)[0];

  const out = [];
  const seen = new Set();

  // 1. The canonical `Tags:` legend line.
  const legendLine = legendScope.match(/^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?Tags:(?:\*\*)?[ \t]*(.+)$/im);
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
 * @param {string} text raw bullet-bank.md contents
 * @returns {{body: string, suggestions: string, hasSuggestions: boolean}}
 */
export function splitBulletBank(text) {
  if (!text || typeof text !== 'string') {
    return { body: '', suggestions: '', hasSuggestions: false };
  }
  // Match the heading the prompt emits, plus reasonable variants a model or a
  // hand-editing user might produce.
  const headingRe = /^#{1,6}[ \t]*Suggested Additions\b.*$/im;
  const m = text.match(headingRe);
  if (!m || m.index == null) {
    return { body: text, suggestions: '', hasSuggestions: false };
  }
  const body = text.slice(0, m.index).trimEnd();
  const suggestions = text.slice(m.index).trim();
  return { body, suggestions, hasSuggestions: suggestions.length > 0 };
}
