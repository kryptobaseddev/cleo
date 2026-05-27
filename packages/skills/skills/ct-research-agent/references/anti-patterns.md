# Anti-Patterns

Common failure modes for research tasks. Each pattern below has been
observed in real CLEO sessions (some recorded in BRAIN as patterns
`P-b2e59bf4`, `P-75035d53`, and others). Avoid them by following the
detection cue and applying the remediation.

## 1. The Hallucinated Citation

**Symptom.** A finding cites a URL, function signature, or API that does
not actually exist. The agent inferred its existence from naming
conventions and a plausible domain.

**Detection cue.** Citation has not been retrieved during this session.
URL was not produced by a tool call; signature was not read from a file.

**Remediation.** Every citation MUST come from a tool call output in this
session — `WebFetch`, `WebSearch`, `Grep`, `Read`, `ctx7 docs`, or
`gitnexus_*`. If the source cannot be re-shown by a tool call, it is
hallucinated. Strip it and either re-fetch or downgrade the finding to
`hypothesis`.

## 2. The Stale Authority

**Symptom.** A finding cites the official docs for library X — but the
project uses version Y, and the cited page describes version Z which has
different semantics.

**Detection cue.** No version qualifier on the citation. The
`package.json` or `Cargo.toml` for the project specifies a version that
differs from the doc page version.

**Remediation.** Always pin Context7 queries to the project's actual
version. Use the `/org/project/version` form when available. Read the
project's lockfile before citing version-dependent behavior.

## 3. The Single-Blog Cascade

**Symptom.** A blog post made an interesting claim; the research output
cited it as fact; downstream the spec writer baked it into requirements;
the implementation fails because the claim was wrong.

**Detection cue.** A finding sourced to a single blog post or Medium
article is labeled `verified` or `documented` in the output.

**Remediation.** Blog posts are at most `reported` rung-3 evidence.
Promote to `documented` only after corroborating with the canonical
source (official docs, source code, or RFC). If no canonical source
exists, label `anecdotal` and put it under `## Hypotheses`.

## 4. The Boil-the-Ocean

**Symptom.** The research task is "investigate JavaScript build tools".
The agent spends 90 minutes producing a 50-page survey of every tool from
Browserify to Bun, exhausts its token budget, and never answers the
question the orchestrator actually had.

**Detection cue.** Output exceeds 30 KB without a `## Recommendations`
section in the first 20% of the file.

**Remediation.** Before opening any source, restate the question in one
sentence and pick the success criterion. "Boil the ocean" tasks SHOULD be
split into multiple narrower research tasks via the orchestrator — return
a `needs_followup` list rather than producing one giant document.

## 5. The Confirmation Loop

**Symptom.** The user (or the calling task) implied a preferred answer in
the question. The agent finds that preferred answer immediately, stops
searching, and reports it as if it had explored alternatives.

**Detection cue.** The output lists fewer than 2 alternatives even when
the task description used comparative language ("compare", "evaluate",
"options"). All findings support a single direction.

**Remediation.** For comparative tasks, mandate one paragraph per
alternative with stated pros and cons, even if the agent expects to
recommend one. The reader needs to see the tradeoff space.

## 6. The Ungrounded Recommendation

**Symptom.** The recommendations section contains imperative statements
("use library X", "adopt pattern Y") that are not tied to any specific
finding above.

**Detection cue.** Recommendations cannot be traced back to a numbered
finding or cited source.

**Remediation.** Each recommendation MUST reference at least one finding
by name or section heading. Use this format:

```markdown
1. Adopt `defineRelations` for the new schema work.
   - Based on finding: "Drizzle v1 deprecates `relations()` in favor of
     `defineRelations` (verified, 0.95)"
   - Tradeoff: minor migration cost; offset by ergonomics + future-proof.
```

## 7. The Forgotten Codebase

**Symptom.** Research output cites web sources extensively but never
references the existing codebase, ADRs, or BRAIN memory. The
recommendation contradicts a decision already recorded in ADR-XXX.

**Detection cue.** No `.cleo/adrs/`, `packages/`, or `cleo memory find`
references in the citations.

**Remediation.** ALWAYS run a codebase + BRAIN sweep before opening the
web. Even when the topic is "external", the project has likely already
made related decisions that constrain the answer space. ADRs are
canonical — overriding them requires explicit consensus, not silent
research recommendation.

## 8. The Manifest Stuffer

**Symptom.** The pipeline_manifest entry's `key_findings` array contains
20+ items, half of which are minor or duplicative. The orchestrator's
briefing surface chokes on the noise.

**Detection cue.** `key_findings` length > 7 or contains items shorter
than 8 words.

**Remediation.** `key_findings` is for the orchestrator's roll-up — 3-7
sentence-length, action-oriented items only. Detail belongs in the
output file. If a finding cannot be summarized in one sentence, it is
two findings.

## 9. The Premature Completion

**Symptom.** Task is marked complete; the output file says "research
complete" but the recommendations are vague ("further investigation
needed", "more work required") with no specific followup IDs.

**Detection cue.** Manifest status is `complete` but the file contains
phrases like "TBD", "future work", or "to be determined".

**Remediation.** If research cannot reach actionable recommendations,
the manifest status MUST be `partial` or `blocked`, NOT `complete`.
Specific gaps belong in `needs_followup` as concrete task descriptions,
not as soft prose in the file body.

## 10. The Format Drift

**Symptom.** Output file does not match the template in SKILL.md.
Sections are renamed, the manifest entry uses old field names, or the
file location is wrong.

**Detection cue.** Validator script fails or the orchestrator reports
"could not parse manifest entry".

**Remediation.** Re-read SKILL.md's "Output File Format" and "Manifest
Entry Format" sections before writing. The downstream consumers are
brittle by design — they trust the format and will reject anything
unexpected.
