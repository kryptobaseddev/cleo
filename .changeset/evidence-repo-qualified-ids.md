---
id: evidence-repo-qualified-ids
tasks: [T14012]
kind: feat
summary: "Evidence file and commit graph ids carry a repository key in stores that parent several repositories; `cleo brain migrate-repo-ids --apply` moves existing links"
---

In a CLEO store that parents several repositories, `cleo verify` now links
evidence files and commits of every repository but the store's own to
repo-qualified graph nodes, `file:<repo>::<path>` and `commit:<repo>::<sha>`.
Same-named files in two child repositories (`a/src/x.ts`, `b/src/x.ts`) are
separate nodes. The repository key comes from the `origin` URL, the same on every
device: `github.com/<owner>/<repo>` through the github.com-anchored parser the PR
evidence uses, else the host and path lowercased; a repository without an
origin is keyed by its directory relative to the store root. Single-repo stores,
worktrees of the store's repository and a store inside a monorepo that tracks it
keep their current ids. A submodule is its own repository. An outer repository
that tracks nothing under the store root (a dotfiles repository at `~`) is
ignored.

`cleo brain migrate-repo-ids` plans moving existing evidence links to the new
ids and lists the ambiguous ones; it is a dry run unless given `--apply`, which
writes a receipt under `.cleo/backups/migrations/` (the moves, the ambiguous
links and the full rows of deleted nodes) before its single transaction. It
never runs automatically. A commit moves to the one checkout that contains it. A file moves to the
one checkout that has its path, or, when several do, to the one the same task's
commits belong to. Anything still ambiguous is reported in `unresolved` and left
unchanged. Edges from other writers stay on the old node, which is removed only
once nothing uses it. Re-running is a no-op.
