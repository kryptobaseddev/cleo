---
id: t12959-scope-aware-test-evidence
tasks: [T12959, T12960, T12965, T12656]
kind: feat
summary: tool:test runs affected packages first, cleo complete resolves ci:<pr> itself after merge, test-run evidence is bound to fresh, relevant reports and its tree
---

**`tool:test` is scope-aware (T12959).** With `testing.affectedCommand`
declared, `tool:test` now plans an affected run first: the packages the branch
diff touches plus their dependents, taken from declared workspace package
dependencies only. It records `scope: 'affected'`, the packages and that basis
under the canonical `test` tool.

The full suite runs only when the affected scope cannot be trusted:
- the project opts out (`testing.preferAffected: false`);
- the change's latest implementation is merged, or its merge state is unknown;
- an affected dependent has no test project;
- the planner refuses: a root config or lockfile change, no origin, no package
  touched, or unresolvable projects.

A full run records `scope: 'full'` and the reason in `scopeReason`. A busy
`test` slot is `E_EVIDENCE_TOOL_BUSY`. It never falls back to a heavier full
run.

**`cleo complete` proves testsPassed/qaPassed from merged CI itself (T12960).**
After merge, with `evidence.ciSatisfies` on, completion synthesizes `ci:<pr>`
for any CI gate that is missing, or a testsPassed that no longer stands. It
validates it through the normal gate write and records it with a note and the
criterion links already on record.

The PR is the merged PR that contains the task's latest implementation:
- A recorded `commit:` that has not reached origin's default branch means the
  change is unmerged, whatever earlier PR merged.
- Otherwise, CLEO uses the newest merged `pr:` that contains every recorded
  commit.
- Commits that landed without a known PR count as merged, so scoped evidence
  fails closed.

Required CI that is still pending gives a refusal to wait and retry. A final
red, a skipped or missing required job, or a PR the `pr:` check refuses gives a
refusal to fix CI or record a full `tool:test` (plus `tool:lint` and
`tool:typecheck`). Neither refusal is an endless wait. Gates recorded this way
persist when completion then fails a later, unrelated check.

**Scoped evidence after merge (T12656).** A targeted `test-run:` is now scoped
like an affected run. After merge, only `ci:<pr>` or a full `tool:test` proves
testsPassed. `cleo done` planning and `cleo complete` share one rule,
`testsPassedSupersededReason`.

**Targeted `test-run:` evidence is bound (T12965).** At verify time, a report is
refused when:
- it ran before the newest working-tree edit of any path the change touches
  (committing after the run is fine);
- or, in a workspace change, it covers no test file in a directly changed
  package.

The atom records HEAD, the tracked tree hash and the covered test files (up to
200, plus `testFileCount`). `cleo complete` refuses a test-run whose tree moved,
unless `ci:<pr>` or a standing full `tool:test` carries the gate. This binding
guards against stale and irrelevant reports. It does not prove the report came
from this tree's code. Atoms recorded before this change are not checked.
