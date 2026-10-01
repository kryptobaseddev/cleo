---
id: tree-keyed-tool-cache
tasks: [T12958, T12961]
kind: feat
summary: the evidence tool cache is keyed on tracked tree content, so worktrees and commits with the same content share one run and concurrent identical runs coalesce; a failing `tool:test` retries its failing files once (flaky passes are marked) and re-runs only them first after a fix
---

`tool:<name>` evidence results were cached under `{canonical, cmd, args,
HEAD, dirty fingerprint, execution root}`. Every worktree and every commit
missed, including an empty commit or a rebase that left the content
byte-identical, so each concurrent agent re-ran the full suite.

- **Tree-keyed cache (T12958).** The key is now `{canonical, cmd, args,
  treeHash}`. `treeHash` is the git tree of the tracked content as it sits in
  the working tree: the checkout's index is copied to a private temp file,
  `git add -u` stages tracked changes into the copy, and `git write-tree`
  prints the tree. A clean checkout hashes to `HEAD^{tree}`. The real index is
  never touched, and it takes about 90 ms on a 10 000-file repo. Two worktrees
  with identical tracked content now share one result. So do an empty commit,
  a message-only amend, committing the content that was measured, and a rebase
  that reproduces measured content.
- **Untracked files** still do not count (the gh#1221 rule), and
  `CLEO_EVIDENCE_FRESH=1` still forces a run.
- **Audit.** HEAD and the execution root are still recorded on each entry but
  are no longer part of the key. The tree object lives in the repository's
  shared object database, so a result produced in a worktree that has since
  been deleted can still be checked with `git ls-tree <treeHash>`. Hits from
  deleted worktrees are therefore served. Cache entries move to schema 3, and
  older entries are ignored.
- **Failed-first reruns (T12961).** When `tool:test` fails, the failing test
  files are parsed from the vitest/jest `FAIL` lines, stored on the cache entry
  (`failedTestFiles`) and remembered per execution root. The next test run in
  that tree runs only those files first, with the nearest `vitest.config.*` and
  `node_modules/.bin/vitest`. If they still fail, that failure is recorded and
  cached and the full or affected command never starts. If they pass, the
  normal command runs. When the files cannot be named or run (no vitest, no
  config, `No test files found`, spawn error), the run falls back to today's
  behaviour.
- **Flake retry (T12961).** When a test run fails, its failing files are re-run
  ONCE before deciding. If they now pass, the run is recorded as a pass with
  `flaky: [files]` on the cache entry and on the `tool` evidence atom, so it is
  visible and distinct from a clean pass. The retry can only turn the run into
  a pass when the runner's summary (`Test Files  N failed` /
  `Test Suites: N failed`) counts exactly the named files and reports no
  unhandled `Errors`. A failure the named files cannot fully explain stays a
  failure. A failed-first rerun that fails also gets one retry before it
  counts as the result.
- **Coalescing (T12958).** A caller that finds the per-key lock held, meaning
  the same command on the same content, possibly from another worktree, now
  waits for that run and reuses its result. It used to give up after about
  0.7 s with `E_EVIDENCE_TOOL_BUSY` and then run the suite anyway. The wait
  happens outside the global semaphore. If the holder releases without a
  result (timeout, harness failure, crash), the waiter runs the tool itself.
  The wait is bounded by `lockWaitMs` (default: the spawn deadline + 60 s),
  and a caller still waiting at that bound gets `lockBusy` /
  `E_EVIDENCE_TOOL_BUSY`.
