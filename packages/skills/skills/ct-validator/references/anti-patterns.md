# Anti-Patterns

Common failure modes when running validation tasks. These degrade the
report's usefulness, break downstream consumers, or mask defects. Avoid
them by following the detection cue and the remediation.

## 1. The Short-Circuit Validator

**Symptom.** Validator stops on the first failure and reports only that
one. The report claims "FAIL" but lists only one issue when there are
several.

**Detection cue.** Issue count is exactly 1 but the underlying tool
(biome, tsc, jsonschema) has multi-issue output.

**Root cause.** Engine was run without `--all-errors` (AJV),
`--exhaustive`, or equivalent. Or a try/catch wrapped the validation
and bailed on first throw.

**Fix.** Always pass the all-errors flag. For Zod, use `safeParse` and
collect every issue from `result.error.issues`. For TypeScript, use
`tsc -b --pretty false` and capture every line.

## 2. The Soft Pass

**Symptom.** Report status is `PASS` but the target has known
unaddressed warnings.

**Detection cue.** Findings table contains entries; status is PASS.

**Root cause.** Status calculus violation — PASS requires zero
critical AND ≤2 warnings (per `compliance-reports.md`). Warnings
above threshold demote to PARTIAL.

**Fix.** Apply the status calculus mechanically. PASS only when the
table is empty (or warnings ≤2). When in doubt, demote.

## 3. The Unreproducible Report

**Symptom.** Six weeks later, someone tries to re-validate the same
target. The report's claims cannot be verified.

**Detection cue.** Report has no `## Trace` section or the Trace lists
no reproducer command.

**Root cause.** Reporter forgot to record the command sequence and
tool versions used.

**Fix.** Always include the reproducer. The Trace section is mandatory
per the canonical scaffold.

```markdown
## Trace

- Target: packages/cleo/src/release.ts (at 5608f75cd)
- Tooling: biome@2.4.11, tsc@5.6.0, pnpm@9.x
- Reproducer:
  pnpm biome check packages/cleo/src/release.ts && \
  pnpm exec tsc -b packages/cleo --pretty false
```

## 4. The Mode Confusion

**Symptom.** A Document-mode report applies Code-mode rules, or
vice-versa.

**Detection cue.** Findings about TypeScript strictness in a spec
review; findings about RFC 2119 in a code lint.

**Root cause.** Mode was not made explicit at the start; the validator
defaulted to its strongest familiarity.

**Fix.** Declare mode in the report header. The spawn prompt or task
body MUST set it; if absent, ask the orchestrator to clarify before
proceeding.

## 5. The Missing Severity

**Symptom.** Findings listed but consumer cannot prioritize.

**Detection cue.** Findings without `Critical | Warning | Suggestion`
classification.

**Root cause.** Reporter treated all findings as equal.

**Fix.** Every finding MUST carry severity. When unclear, apply the
"blocks ship?" test: yes → Critical; no → Warning; "nice to have" →
Suggestion.

## 6. The Vague Remediation

**Symptom.** Issue says "fix this". Reader does not know how.

**Detection cue.** `Fix:` line is missing or contains only "see above"
/ "obvious from context" / "fix the issue".

**Root cause.** Reporter ran out of energy by the time they got to
the fix column.

**Fix.** Every finding has a concrete fix step. If the fix requires
discussion (architectural change), state that — but specifically:
"file a task to redesign the credential rotation flow; reference
ADR-XX-NEW once it lands".

## 7. The Phantom Test

**Symptom.** Protocol mode report claims REQ-NNN is verified by
`test/foo.test.ts::case-name`. The test does not exist.

**Detection cue.** Reproducer command fails with "no such test".

**Root cause.** Reporter copied the spec's traceability matrix without
re-checking that the named tests still exist (or ever existed).

**Fix.** Re-run each verification command from the traceability
matrix during validation. Flag REQs whose verification fails to
resolve as Critical findings — the spec drifted from the implementation.

## 8. The Single-File Tunnel

**Symptom.** Code-mode validation runs only on the file that was
explicitly named. Misses related files that share the violation.

**Detection cue.** Report has findings in `release.ts` only; the
same issue exists in 5 sibling files that were not checked.

**Root cause.** Reporter took the task literally instead of the
useful scope.

**Fix.** Apply the validation to all related files when feasible —
"the diff" usually means "all files touched by the task branch", not
"only the one file the orchestrator mentioned".

## 9. The Stale Schema

**Symptom.** Schema-mode validation passes but downstream consumers
still reject the data.

**Detection cue.** Schema version pinned in the report does not match
the producer's contract.

**Root cause.** Schema was updated upstream; validator used a cached
or pinned older version.

**Fix.** Always resolve the schema fresh from the contract source
(`@cleocode/contracts`). Pin the consumer/producer relationship in
the schema's `$id` and `version` fields and check both.

## 10. The Disposable Sidecar

**Symptom.** JSON sidecar emitted, but it has different findings than
the markdown report.

**Detection cue.** `diff <(md-extract-findings report.md)
<(jq '.findings' report.json)` shows mismatched data.

**Root cause.** Reporter wrote the markdown manually and the JSON
separately; they drifted.

**Fix.** Generate one from the other. Write the structured data first
(JSON), then render the markdown from it. A `--render-md` flag on the
report generator enforces this.

## 11. The Unsourced Rule

**Symptom.** A finding cites a rule that does not exist in any visible
standard.

**Detection cue.** Rule reference is prose ("naming should be
consistent") rather than a stable identifier ("AGENTS.md §Package
Boundary").

**Root cause.** Reporter applied a personal preference and labeled
it as a rule.

**Fix.** Every rule citation MUST link to a stable source:
`AGENTS.md §X`, `ADR-NNN`, `biome.json#rules.style.Y`. If the
preference is real but unwritten, the report SHOULD propose adding
it to the standard (file a task) rather than enforcing it silently.

## 12. The Pre-Empty Report

**Symptom.** Validator runs against an empty or absent target, reports
`PASS`.

**Detection cue.** Target file is empty or does not exist; report says
"100% compliance".

**Root cause.** Engine returned zero violations because there was
nothing to violate.

**Fix.** Always sanity-check the target exists and has content before
running validation. Empty/missing target is itself a Critical finding —
not a clean pass.
