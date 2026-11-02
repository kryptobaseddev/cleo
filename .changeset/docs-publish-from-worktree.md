---
id: docs-publish-from-worktree
tasks: [T14135]
kind: fix
summary: "cleo docs publish from any canonical CLEO worktree writes the mirror into that worktree and records the repo-relative path; docs status reads unpulled mirrors from the default branch"
---

Publishing a doc from a task worktree used to land in the root checkout, and
the root checkout may hold another branch. Publishing into a worktree whose
directory was not named `T####` was refused. The ledger then recorded a path
that `cleo docs status` reported as deleted until the root pulled the merge.

- **Publish target:** any registered worktree at the project's canonical CLEO
  location (`<cleoHome>/worktrees/<hash>/<name>`, same Git common directory)
  is now a target, whatever its name.
- **Relative `--to`:** run from such a worktree, a relative `--to` resolves
  inside it.
- **Recorded path:** `relativePath`, and so the ledger's `publishedPath`, is
  relative to the worktree's project directory. That is the path the merge
  makes true under the project root, never a worktree or `../` path.
- **Status:** `cleo docs status` (and `cleo docs doctor`, which shares
  `statusDocs`) handles a mirror missing from this checkout in two new ways.
  - When the default branch tracks the file, it judges the default branch's
    bytes (`in-sync` or `modified`, with `source` naming the ref).
  - When the file is present only in an unmerged canonical worktree, it reports
    `pending-merge`, which `allInSync` treats as not drift.
- **One classification:** the read model's `status()` now delegates to
  `statusDocs`, so the two copies of the drift classification can no longer
  diverge.
- **Skill:** ct-documentor 3.35.0 documents the new rules.
