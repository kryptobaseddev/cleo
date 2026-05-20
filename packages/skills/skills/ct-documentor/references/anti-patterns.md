# Anti-Patterns

Failure modes specific to documentation coordination. Each is detectable
during the documentor's workflow and has a concrete remediation. Several
have been observed in past CLEO sessions and are recorded in BRAIN.

## 1. The Phantom Documentation

**Symptom.** Manifest reports "documentation complete" but no file
exists at the claimed path.

**Detection cue.** `cat <claimed-path>` returns "no such file". Or
`git log --follow <claimed-path>` returns nothing.

**Root cause.** The documentor described work it didn't actually
delegate. Common when the orchestrator stuffed a doc task into a
larger PR and the documentor coordinator didn't get triggered.

**Fix.** After every chain, the documentor MUST verify the file
exists and contains the claimed content. Use `Read` to confirm before
appending the manifest entry.

## 2. The Duplicate Page

**Symptom.** Two pages cover the same topic with similar but
non-identical content. Readers find one or the other depending on
search keywords; updates land on one and not the other.

**Detection cue.** Glob + grep during Discovery turns up a prior
page on the same topic; documentor proceeded to create a new one
anyway.

**Root cause.** Skipped Discovery, or treated "I prefer this path
name" as justification to duplicate.

**Fix.** When prior coverage exists, UPDATE it. The MAINTAIN, DON'T
DUPLICATE rule is in SKILL.md for this reason. Add a section to the
existing page; do not create a sibling.

## 3. The Stale Library Citation

**Symptom.** A how-to or reference cites a library API that has been
renamed, deprecated, or removed.

**Detection cue.** `ct-docs-lookup` was NOT invoked for the topic.

**Root cause.** Documentor coordinator skipped lookup because "I know
the API" or assumed training data was current.

**Fix.** Always invoke `ct-docs-lookup` when documenting external
library behavior. Training data is stale by definition — Context7 is
the current source.

## 4. The Type Confusion

**Symptom.** Document uses tutorial framing for what should be a
reference, or vice versa. Reader confused.

**Detection cue.** A "how-to" doc spends 5 paragraphs explaining
concepts before any imperative step. Or a "reference" doc reads
like a narrative.

**Root cause.** Skipped Classification; documentor didn't pick a type
up front.

**Fix.** Always assign the Diátaxis type (or CLEO-native type) before
invoking write. The type determines the template; the template
prevents drift.

## 5. The Infinite Review Loop

**Symptom.** Review keeps finding issues; write keeps fixing; review
keeps finding new issues. The loop never converges.

**Detection cue.** Iteration count exceeds 3.

**Root cause.** Either (a) the topic is mis-scoped (the audience is
unclear, the type is wrong), or (b) the style guide and the writer's
defaults conflict.

**Fix.** After 3 iterations, escalate to HITL with:
- Original input
- Each draft
- Each review's findings
- The pattern across iterations (e.g., "review keeps flagging tone,
  write keeps producing the same tone")

HITL can override or re-scope. Don't burn tokens on convergence the
loop won't reach.

## 6. The Orphan Cross-Reference

**Symptom.** Updated doc links to a page that no longer exists, or to
a section that was renamed.

**Detection cue.** `markdown-link-check` flags the link as broken.
Or the index/TOC contains entries for files that have been deleted.

**Root cause.** Documentor consolidated content but didn't update
inbound references.

**Fix.** When consolidating or moving content:
1. Find all inbound links: `grep -r "<old-path>" docs/`
2. Update each link or add a redirect
3. Add a deprecation notice at the old path that explains the move
4. Only delete the old path after a deprecation period

## 7. The Voice Drift

**Symptom.** Same doc switches between "you", "we", "the user", and
"people" within a few paragraphs.

**Detection cue.** Grep for pronouns in the new file; count occurrences
of each voice marker.

**Root cause.** Either write produced inconsistent voice, OR the doc
was assembled from multiple sources without normalization.

**Fix.** CLEO style is "you" (second person) for how-tos and tutorials;
"CLEO" (third person) for explanations and references. Apply
consistently. Pass the choice explicitly to ct-docs-write as input.

## 8. The Forbidden Word Sneak-In

**Symptom.** Doc ships with "easy", "simple", "just", "obviously",
or other forbidden phrases.

**Detection cue.** Review didn't catch it. Grep for the forbidden
list in the new file.

**Root cause.** Review's rule list drifted from the canonical style
guide. Or the words appeared inside a code block (where review may
skip).

**Fix.** Run grep yourself before completing:

```bash
for word in easy simple just obviously "click here" "read more here"; do
  grep -n "$word" <new-file> && echo "FAIL: $word"
done
```

If review missed something, also file a task to sync the rule list.

## 9. The Imperative Confusion

**Symptom.** A tutorial uses "you can", "you might", "the user can",
when the contract is "the reader DOES this step now".

**Detection cue.** Modal verbs (can, might, would) appear in tutorial
step bodies.

**Root cause.** Writer hedged when the doc required imperatives.

**Fix.** Tutorials and how-tos use imperative voice — "Run the
command", "Open the file", "Set the value". Pass that constraint
explicitly to ct-docs-write.

## 10. The Lost Manifest

**Symptom.** Documentation work shipped but the orchestrator's rollup
shows no manifest entry. Subsequent agents redo the same work.

**Detection cue.** `cleo find <topic>` returns no manifest entries
for the documentation work. The doc file exists but the manifest
doesn't link to it.

**Root cause.** Documentor skipped the manifest append step (or one
of the children appended in a wrong format).

**Fix.** The manifest append is mandatory. The documentor — not its
children — owns the entry. Run:

```bash
cleo manifest append <(cat <<EOF
{"id":"docs-<topic>-<date>", "file":"<path>", "title":"...", ...}
EOF
)
```

After append, verify with:

```bash
cleo find "<topic>" | head -3
```

The new entry should appear.

## 11. The Audience Whiplash

**Symptom.** Doc switches audience mid-page — opens for end-users,
shifts into maintainer-level detail, returns to end-user framing.
Readers from neither group are well-served.

**Detection cue.** Page mixes "people who use CLEO" framing with
"contributors to CLEO" framing.

**Root cause.** Documentor didn't pin audience in Classification.

**Fix.** One audience per page. If both audiences need coverage, split
into two pages — `guide.md` for end-users and `internals.md` for
contributors — and cross-link.

## 12. The Skipped Pre-PR Pass

**Symptom.** PR opens with documentation; reviewer finds style
violations the local review didn't catch.

**Detection cue.** PR comments contain style-guide flags.

**Root cause.** Documentor ran review on the draft, but not on the
PR diff. Integration introduced drift (rebase fixups, merge prose).

**Fix.** Always run `ct-docs-review --mode=pr` on the PR's diff
before requesting merge. Catches drift that slipped through during
integration.
