// Guards for the update-check workflow's release targeting.
//
// Downstream copies belong to non-technical users whose live deployment IS the
// thing being updated. Shipping them upstream's working tip means shipping
// half-finished work into a running job search. The workflow therefore merges
// the newest v* tag, and only falls back to main while no release exists yet.
//
// These are static assertions over update-check.yml: they pin the ref-selection
// shell — which namespace tags are fetched into, the version sort, the prerelease
// filter, the no-tag fallback, and that everything downstream goes through
// $TARGET_REF. They do not execute the workflow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wf = readFileSync(join(__dirname, '..', '.github', 'workflows', 'update-check.yml'), 'utf8');

test('upstream tags are fetched into their own namespace, never the local one', () => {
  assert.match(wf, /git fetch --no-tags upstream '\+refs\/tags\/\*:refs\/upstream-tags\/\*'/);
  // A user's own v1.0 tag must not be able to become "the update".
  assert.doesNotMatch(wf, /git fetch\s+(--tags\s+)?upstream\s+main\s+--tags/);
});

test('the target is the newest v* tag by VERSION order, not lexical order', () => {
  assert.match(wf, /git for-each-ref --sort=-v:refname[\s\S]{0,120}'refs\/upstream-tags\/v\*'/);
  // `head -1` on a git pipe under `set -o pipefail` is the SIGPIPE trap this
  // workflow already documents elsewhere; awk drains the producer instead.
  assert.match(wf, /awk '!\/-\/ && !found \{ print; found = 1 \}'/);
  assert.doesNotMatch(wf, /refs\/upstream-tags[\s\S]{0,120}head -n? ?1/);
});

test('prereleases are filtered out before the newest tag is picked', () => {
  // `-v:refname` ranks v2.0.0-rc1 above v2.0.0. Without the filter, the first RC
  // upstream ever tags becomes every downstream copy's permanent target.
  const pick = wf.slice(wf.indexOf('LATEST_TAG='), wf.indexOf('if [ -n "$LATEST_TAG" ]'));
  assert.match(pick, /awk '!\/-\/[^']*'/);
  // and the reason is written down where the next person will read it
  assert.match(wf, /prerelease/i);
});

test('with no release tags it falls back to main and says so', () => {
  assert.match(wf, /no release tags found — tracking main until the first release/);
  const block = wf.slice(wf.indexOf('LATEST_TAG='), wf.indexOf('# 2. If we already contain'));
  assert.match(block, /TARGET_REF="upstream\/main"/);
  assert.match(block, /TARGET_REF="refs\/upstream-tags\/\$LATEST_TAG"/);
});

test('every comparison and the merge itself go through TARGET_REF', () => {
  // Below the target-selection block, nothing may name upstream/main directly
  // except the graft lookup, which is deliberately left alone (it needs the full
  // branch history to find the snapshot the copy was made from).
  const after = wf.slice(wf.indexOf('# 2. If we already contain'));
  const strays = after
    .split('\n')
    .filter(l => l.includes('upstream/main') && !l.trimStart().startsWith('#'))
    // MANUAL_RECIPE embeds the graft lookup verbatim for the user to run by hand;
    // that lookup needs the whole branch history, same as the workflow's own.
    .filter(l => !l.trimStart().startsWith('MANUAL_RECIPE='));
  assert.deepEqual(strays, [], `these lines still target the branch instead of the release:\n${strays.join('\n')}`);

  assert.match(after, /git merge-base --is-ancestor "\$TARGET_REF" HEAD/);
  assert.match(after, /git merge-base --is-ancestor "\$TARGET_REF" "origin\/\$UPDATE_BRANCH"/);
  assert.match(after, /git log --oneline --no-merges "HEAD\.\.\$TARGET_REF"/);
  assert.match(after, /git merge --no-edit --allow-unrelated-histories -m "[^"]*" "\$TARGET_REF"/);
});

test('the graft repair is untouched — it still scans the full upstream branch', () => {
  const graft = wf.slice(wf.indexOf('UNRELATED_NO_MATCH=""'), wf.indexOf('# 1c.'));
  assert.match(graft, /git merge-base HEAD upstream\/main/);
  assert.match(graft, /git log --format='%H %T' upstream\/main/);
});

test('the manual-merge recipes tell the user to merge the same ref the workflow does', () => {
  // Three issue paths, each with its own recipe; all three take the fetch command
  // and the ref from the same two variables the workflow itself used.
  assert.equal((wf.match(/"\$HUMAN_FETCH" "\$HUMAN_REF"/g) || []).length, 3);
  // The hand recipe must fetch into the same private namespace the workflow uses.
  // `git fetch upstream --tags` writes to the user's own refs/tags/* and refuses to
  // overwrite a tag they already hold, so their v1.2.0 would quietly beat upstream's.
  assert.match(wf, /HUMAN_FETCH="git fetch --no-tags upstream main '\+refs\/tags\/\*:refs\/upstream-tags\/\*'"/);
  assert.match(wf, /HUMAN_REF="refs\/upstream-tags\/\$LATEST_TAG"/);
  assert.doesNotMatch(wf, /HUMAN_FETCH="git fetch upstream --tags"/);
});

test('the README says updates deliver releases', () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /Updates deliver vetted \*\*releases\*\*/);
});
