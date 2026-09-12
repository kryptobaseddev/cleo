---
id: evidence-pipeline-tree-and-cache
tasks: [T12112]
kind: fix
summary: evidence tools run in the caller's worktree, and a tool no longer invalidates its own cache by running (gh#1221, gh#1220, gh#1226, gh#1230)
---

Evidence could describe a tree other than the one under test, and the result
cache could never hit for `tool:test`. Both are fixed at the root.

**Wrong tree (gh#1220, gh#1226, gh#1230).** `getProjectRoot()` deliberately
resolves a worktree to the MAIN repo so every worktree shares one `.cleo/`
store — correct for the store, wrong as a tool's working directory. The same
value was being used to spawn evidence tools, so a verify launched from a
worktree measured the shared checkout: a peer's in-flight branch and untracked
files decided the outcome. A red peer produced a false FAIL; a green peer
produced a silent false PASS attesting a run that never touched the code under
test. Execution root and store root are now distinct — the tool spawns in, and
is fingerprinted against, the caller's tree, while the cache entry stays shared
(it is content-addressed, so two trees only collide when they hold the same
code). The measured tree is reported on the result. `test-run:<path>` resolves
relative paths against the caller's tree before falling back to the store root.

**Cache could never hit (gh#1221).** The reported cause — fingerprint churn
from peers editing a shared checkout — was measured and refuted; the shared
checkout's fingerprint was byte-identical across 60s with 12 live sessions. Two
deterministic causes explain it on an idle single-agent box:

1. The fingerprint hashed `git status --porcelain`, which lists untracked
   files, so a tool emitting any untracked artifact changed the key the next
   call computes — the tool invalidated its own entry by running. `coverage/`,
   `.vitest/` and `*.log` are not gitignored here, so one suite run suffices.
   The fingerprint now covers tracked content only.
2. The 300s default deadline is below a real monorepo suite, and the timeout
   path deliberately caches nothing, so every run was killed and discarded
   after burning the full deadline at full parallelism. The deadline raise
   ships separately, behind the memory bound; here the timeout error stops
   advising an identical retry and names `CLEO_TOOL_TIMEOUT_<CANONICAL>`.

TRADEOFF: an uncommitted NEW file no longer invalidates the cache either.
Commit it, or force a measured run with `CLEO_EVIDENCE_FRESH=1`. The
alternative — a maintained per-project exclude list — trades a loud documented
staleness for a silent one that rots as tooling changes.
