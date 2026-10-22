---
id: config-schema-composition-generated-clients
tasks: [T13778, T13779, T13780, T13781, T13782, T13783]
kind: fix
summary: "Targeted evidence for config edits, merged changes, redirected JSON reports and generated-client dependents, with no whole-suite run"
---

**T13779.** Editing `.cleo/project-context.json` or `.cleo/config.json` no
longer makes a change workspace-wide. Those files are set aside for
`tool:config-schema` to judge.

**T13778.** `tool:config-schema` now also works on a mixed change. It
validates the config files and records the other paths. A test-run or
qa-run that left config to it records those files as `configPaths`. The gate
needs both results in one write
(`--evidence "test-run:<report>;tool:config-schema"`); either alone is
refused, with that route named. A config edit cannot hide an untested source
change. `cleo done --plan` now suggests the combined evidence.

**T13780.** Untracked files under `.cleo/rcasd/` and `.claude/`, or matched
by the default branch's `evidence.scopeExcludes` (for example `.opencode/**`),
are session state, so they are no longer part of the change. Every other
untracked file still counts, including ones under `.github/`. A file committed
later keeps the same tree hash, so leaving it out would let earlier evidence
skip it.

**T13781.** For an already-merged change, `tool:config-schema` judges the
task's own merge, named in the same write: a `commit:<sha>` recorded on its
`implemented` gate, or a task-linked `pr:<n>`. Any other commit is refused.
The change is the task's change, not the named commit's diff. After the merge,
config-schema never covers the change's code files on its own.

When a change edits `.cleo/project-context.json`, evidence reads the test,
lint and typecheck commands from the default branch's copy, so a change cannot
relax its own checks (T13779).

**T13782.** A typed test gate whose JSON reporter writes to a file (its
`--outputFile`, or `.vitest/json/output.json`) now gets that run's counts.
The file counts only if this run wrote it. Its bytes must have changed since
the spawn, its mtime must be after the spawn, and its `startTime` must not be
earlier than the spawn. A report left behind by an earlier run is never read.

**T13783.** The owner decided how generated clients count.
`evidence.typecheckOnlyDependents` lists globs, read from the default branch
only (for example `lib/api-zod/**`). A package that depends on the change only
through packages whose every changed path matches a glob owes a typecheck
(`tool:typecheck`, or a qa-run typecheck receipt naming it) instead of a test
file. A catch-all glob such as `**` is ignored with a warning. Dependents with
their own changed source still owe tests, and so does every edited test file. A typecheck or lint `tool:` result never counts as a
test run.
