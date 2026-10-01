---
id: tree-keyed-tool-cache
tasks: [T12958, T12961]
kind: feat
summary: the evidence tool cache is keyed on tracked tree content, so worktrees and commits with the same content share one run; a failing `tool:test` re-runs only its failing files first after a fix
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
