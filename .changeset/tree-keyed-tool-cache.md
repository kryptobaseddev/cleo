---
id: tree-keyed-tool-cache
tasks: [T12958, T12961]
kind: feat
summary: the evidence tool cache is keyed on source tree content plus an environment fingerprint, so equally built worktrees and commits with the same content share one run and concurrent identical runs coalesce; a failing `tool:test` is re-run in full once (a pass then is marked `flaky`) and, after a change, re-runs only its failing files first
---

`tool:<name>` evidence results were cached under `{canonical, cmd, args,
HEAD, dirty fingerprint, execution root}`. Every worktree and every commit
missed, including an empty commit or a rebase that left the content
byte-identical, so each concurrent agent re-ran the full suite.

- **Content key (T12958).** The key is now `{canonical, cmd, args, treeHash,
  envFingerprint}`.
  - `treeHash` is the git tree of the working tree's source. The checkout's
    index is copied to a private temp file with its mtime preserved, so git's
    racy-clean check still works. `git add -A` then stages tracked changes and
    untracked, not-ignored files into the copy. `.cleo/` and common tool
    output (`coverage/`, `.vitest/`, `*.log`, …) are reset to their HEAD
    state, and `git write-tree` prints the tree. A clean checkout hashes to
    `HEAD^{tree}`, and the real index is never touched.
  - Untracked, not-ignored files now count. Otherwise a worker's uncommitted
    new test would be served main's pass.
- **Environment fingerprint (T12958).** For `test`, `build` and `typecheck`
  the key also covers state git cannot see: the installed-lockfile snapshot
  inside `node_modules`, the path and size of every file under each workspace
  package's gitignored `dist/`, and the content of `.env*`. Two worktrees
  share a result only when both their source and their environment match.
  Other tools use the constant `none`.
- **Audit.** HEAD and the execution root are still recorded on each entry. A
  hit whose recorded checkout no longer exists is refused (gh#1419). Tree
  objects are ordinary loose objects that `git gc` may prune after
  `gc.pruneExpire`. Cache entries move to schema 3, and older entries are
  deleted once per process.
- **Coalescing (T12958).** A caller that finds the per-key lock held now
  waits, outside the global semaphore, for that run and reuses its result. It
  used to give up after about 0.7 s with `E_EVIDENCE_TOOL_BUSY`. If the holder
  releases without a result, the waiter runs the tool itself. The wait is
  bounded by `lockWaitMs`, which defaults to 3× the spawn deadline + 60 s;
  past it the caller gets `E_EVIDENCE_TOOL_BUSY`.
- **Flake retry (T12961).** A failing `tool:test` re-runs the FULL recorded
  command once, never a narrower focused run. If that rerun passes, the result
  is a pass with `flaky: [files from the first run]` on the cache entry and on
  the run result, next to `treeHash` and `cacheHit`, for evidence atoms to
  carry. A second failure is red.
- **Failed-first reruns (T12961).** A failing run stores its failing test
  files (`failedTestFiles`, parsed from vitest/jest `FAIL` lines). The next
  run on a changed tree first runs only those files, using the nearest
  `vitest.config.*` and `node_modules/.bin/vitest`.
  - If they still fail, that red result is returned at once. It is marked
    `scope: 'focused'` and is never cached under the full command's key, and
    the next run on the same tree runs the normal command.
  - If they pass, the normal command runs. So does a focused run with no
    `FAIL` line (a startup crash). `CLEO_EVIDENCE_FRESH=1` skips failed-first.
