# Anti-Patterns

Common failure modes when writing CLEO specs. Each pattern degrades the
spec from a testable contract into prose. Detection cues and remediations
are listed; many of these were caught in past `ct-validator` reports and
in council reviews on previously-shipped specs.

## 1. The Ambiguous MUST

**Symptom.** A requirement uses MUST but the failure condition cannot be
mechanically determined.

**Example (bad)**

> **REQ-005**: The system MUST handle errors gracefully.

**Detection cue.** Words like "gracefully", "appropriately", "reasonably",
"properly", "sensibly" appear in the requirement body.

**Remediation.** Replace fuzzy adverbs with measurable conditions.

> **REQ-005**: The system MUST return an LAFS envelope with
> `success: false` and `error.code` matching one of the registered
> error codes (see `packages/contracts/src/errors.ts`) on any failure
> reaching the command dispatcher.

## 2. The Tautological Requirement

**Symptom.** The requirement restates the function's name.

**Example (bad)**

> **REQ-003**: The `validate()` function MUST validate the input.

**Detection cue.** The requirement body's main verb matches the
subject's name without adding constraint.

**Remediation.** State the contract — what defines successful validation,
what the function returns on failure, what side effects it has.

> **REQ-003**: The `validate()` function MUST return `{ ok: true }` if
> the input matches the schema, or `{ ok: false, errors: [...] }`
> containing one entry per violation otherwise. It MUST NOT mutate
> the input.

## 3. The Compound Requirement

**Symptom.** A single REQ asserts multiple independent constraints joined
by "and" or commas.

**Example (bad)**

> **REQ-009**: The release pipeline MUST run lint, MUST run tests, MUST
> generate a changelog, AND MUST push the tag.

**Detection cue.** Multiple MUST/MUST NOT/SHOULD phrases in one REQ; or
"and" connecting verb phrases.

**Remediation.** Split into atomic REQs so each can be tested
independently and traced individually.

> **REQ-009**: The release pipeline MUST run lint.
> **REQ-010**: The release pipeline MUST run tests after lint passes.
> **REQ-011**: The release pipeline MUST generate a changelog.
> **REQ-012**: The release pipeline MUST push the tag only after all
> prior REQs in this sequence have passed.

## 4. The Implementation Detail Spec

**Symptom.** The spec dictates HOW the implementation should work, not
WHAT it must achieve.

**Example (bad)**

> **REQ-014**: The cache MUST be implemented using a Map<string, Buffer>
> with LRU eviction.

**Detection cue.** Concrete data structures, library names, or algorithm
choices appear in MUST clauses.

**Remediation.** State the observable contract; let implementations
choose the structure.

> **REQ-014**: The cache MUST support O(1) lookup by string key.
> **REQ-015**: The cache MUST evict the least-recently-used entry when
> capacity is exceeded.

## 5. The Untestable SHOULD

**Symptom.** SHOULD is used to mean "MAY" or to defer the test problem.

**Example (bad)**

> **REQ-017**: The orchestrator SHOULD be efficient.

**Detection cue.** SHOULD without a measurable cap, threshold, or
comparison.

**Remediation.** Either make it testable, or downgrade to MAY.

> **REQ-017**: The orchestrator SHOULD complete a 5-task wave dispatch
> within 2 seconds on the reference hardware (T9396).
> [— OR —]
> **REQ-017**: The orchestrator MAY parallelize wave dispatch.

## 6. The Forgotten Edge Case

**Symptom.** The happy-path requirement is stated, but failure modes
(timeouts, partial completion, concurrent invocation) are unspecified.

**Detection cue.** No requirement mentions error codes, retries,
timeouts, or concurrent semantics — yet the implementation will face
all of these.

**Remediation.** For every operation, add at minimum:

- Timeout behavior (REQ: "after N seconds without progress, MUST return
  E_TIMEOUT")
- Concurrent invocation (REQ: "MUST serialize concurrent calls per
  resource ID")
- Partial state (REQ: "on failure mid-operation, MUST roll back to
  pre-call state OR persist a recovery record")

## 7. The Spec Without Conformance

**Symptom.** The spec has 20 REQs but no `## Compliance` section.

**Detection cue.** Last section heading is not `## Compliance`.

**Remediation.** Add the section. Without it, `ct-validator` cannot
produce pass/fail reports, and implementations cannot self-attest. A
spec without a compliance criteria block is unfinished.

## 8. The Stealth Decision

**Symptom.** The spec contains a phrase like "we chose X over Y for
reasons A, B, C" — but that decision was not recorded in any ADR.

**Detection cue.** Spec body explains *why* a choice was made, instead
of *what* the requirement is.

**Remediation.** Pull the decision into a proper ADR. Reference the ADR
from the REQ's source column. The spec body asserts the requirement
flatly; the rationale lives in the ADR.

## 9. The Drift-Prone Cross-Reference

**Symptom.** A REQ cross-references another section by prose ("as
discussed in the previous section") or by page number.

**Detection cue.** No `REQ-NNN` token in cross-references.

**Remediation.** Always reference by stable identifier — `REQ-001`,
`CON-007`, `§3.2`, `ADR-065`. Prose references rot when sections
reorder.

## 10. The Version Hostage

**Symptom.** The spec hard-codes the version of a dependency or the
specific commit of an ADR that motivated it.

**Example (bad)**

> **REQ-021**: The pipeline MUST use drizzle-orm@1.0.0-beta.

**Detection cue.** Pinned version in a requirement body.

**Remediation.** Pin only the behavior; pin the version in the
implementation's manifest. If a specific version is genuinely required,
state the constraint as a range.

> **REQ-021**: The pipeline MUST use a Drizzle ORM release that
> supports `defineRelations` (introduced in v1.0.0-beta or later).

This preserves the spec across patch upgrades that do not change
contracts.
