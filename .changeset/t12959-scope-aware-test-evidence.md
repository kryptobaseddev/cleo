---
id: t12959-scope-aware-test-evidence
tasks: [T12959, T12960, T12965, T12656]
kind: feat
summary: tool:test runs affected packages first, cleo complete resolves ci:<pr> itself after merge, test-run evidence is bound to its tree
---

**`tool:test` is scope-aware (T12959).** With `testing.affectedCommand`
declared, `tool:test` now plans an affected run first (the packages the branch
diff touches plus their dependents) and records `scope: 'affected'` with the
packages, under the canonical `test` tool. The full suite runs only when that
scope cannot be trusted. That covers a project that opts out
(`testing.preferAffected: false`) and a change that is merged or whose merge
state is unknown, since a scoped run counts before merge only (D11150). It also
covers a planner refusal: a root config or lockfile change, no origin default
branch, no package touched, or unresolvable test projects. A full run records
`scope: 'full'` and the reason in `scopeReason`. A busy `test` slot while
listing projects is `E_EVIDENCE_TOOL_BUSY`; it does not fall back to a heavier
full run.

**`cleo complete` proves testsPassed/qaPassed from merged CI itself (T12960).**
After the task's PR merges, with `evidence.ciSatisfies` on, completion no longer
refuses and sends the agent off to run the whole suite locally. Instead it
synthesizes `ci:<pr>` for any CI gate that is missing, or a testsPassed that no
longer stands. The PR comes from the `pr:` implemented atom, or from the
`cleo done` change-set derivation. The atom is validated through the normal
gate write and recorded with a note and the criterion links already on record.
Red or still-running required CI is a refusal that says to wait for CI, not to
run tests. Pre-merge affected evidence is never trusted alone after merge
(T12656): CI replaces it, and without `ciSatisfies` the existing refusal
stands.

**Targeted `test-run:` evidence is bound to its tree (T12965).** At verify time
the atom records HEAD, the git tree hash of the tracked working tree and the
covered test files (up to 200 listed, plus `testFileCount`). `cleo complete`
refuses a test-run whose tree no longer matches, unless `ci:<pr>` in the gate,
or merged CI resolved at complete, supersedes it. Atoms recorded before this
change carry no tree hash, so this rule does not check them.
