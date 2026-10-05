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

The PR is a merged PR that carries every recorded implementation commit, so
its CI actually ran them — never a PR that merely cites the task. A commit is
carried when it is an ancestor of the PR's merge commit, one of the PR's own
commits as `gh` lists them (squash and rebase merges), or a patch-equivalent of
one (rebased before merge; the candidates present locally are compared first).
CLEO looks at the newest recorded `pr:` first, then the PR change-set
derivation finds, then a merged PR into the default branch that GitHub
associates with the commits. Every candidate, the GitHub one included, must
carry the commits. The default branch comes from origin's ref, else from `gh`,
so a stacked PR merged into a feature branch never counts.
- Ancestry of the local `origin/<default>` is a positive signal only: a stale
  ref, a squash merge or a pre-rebase SHA never makes a merged change look
  unmerged. New work built on top of an earlier merged PR is unmerged.
- Commits that landed with no PR known to carry them, after every lookup
  answered, count as merged with no PR, so completion refuses: fix CI, or
  record a full `tool:test`.
- A lookup that fails (`gh` unreachable, or commits missing from the local
  object store, each named as such) leaves the merge state unknown, so scoped
  evidence fails closed. When the commits landed but a lookup failed, the
  carrier is unknown: completion records nothing and says to retry or record
  `tool:test`, never to fix a CI that may be green.

`cleo done` planning, `cleo complete` and a scope-aware `tool:test` all judge
the merge through this one function (`taskChangeMergeState`), so `cleo done`
never plans `ci:<pr>` that `cleo complete` would not record. `cleo done` also
plans its test run through the planner `tool:test` uses
(`testing.preferAffected`, the merge state, untested dependents), so the run it
makes is the run validation repeats.

Required CI that is still pending gives a refusal to wait and retry. A final
red (`startup_failure` and every other `*_failure` conclusion included), a
skipped or missing required job, or a PR the `pr:` check refuses gives a
refusal to fix CI or record a full `tool:test` (plus `tool:lint` and
`tool:typecheck`). Neither refusal is an endless wait. Gates recorded this way
persist when completion then fails a later, unrelated check.

**Scoped evidence after merge (T12656).** A targeted `test-run:` is now scoped
like an affected run. After merge, only `ci:<pr>` or a full `tool:test` proves
testsPassed. `cleo done` planning and `cleo complete` share one rule,
`testsPassedSupersededReason`.

**Targeted `test-run:` evidence is bound (T12965).** At verify time, a report is
refused when:
- it ran before the committer time of HEAD or of any commit the branch adds,
  unless those commits only recorded what was on disk when it ran (HEAD as of
  the run is in the reflog and nothing differing from it was modified, deleted
  or moved since): edit, test, commit, verify works; otherwise bind test-run
  before committing, or re-run;
- it ran before the newest working-tree edit of any path the change touches;
- it ran before an uncommitted deletion or rename, dated by the directory the
  path was removed from (a moved file keeps its old mtime);
- it shows no passed test (every test skipped, filtered out or todo);
- in a workspace change, it misses an affected package that has tests: every
  changed package and every package depending on one, the set
  `tool:test-affected` runs. A test file counts only when one of its tests
  passed, so a file a `-t` filter skipped entirely covers nothing. Affected
  packages with no test file are recorded as `untestedPackages`;
- or the change is workspace-wide (a root config, `scripts/` or the lockfile):
  a report cannot show it ran the whole suite, so record `tool:test`.

With a task in context, the report is bound in the task's change-set root (its
worktree when one is registered), the root `cleo done` and `cleo complete`
recompute the tree in, so the three agree wherever each is run from. The atom
records HEAD, the tool cache's tree hash and the covered test files (up to
200, plus `testFileCount`). `cleo complete` refuses a test-run whose tree moved,
unless `ci:<pr>` or a standing full `tool:test` carries the gate. This binding
guards against stale and irrelevant reports. It does not prove the report came
from this tree's code. Atoms recorded before this change are not checked.
