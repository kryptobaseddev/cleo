---
id: evidence-repo-qualified-ids
tasks: [T14012]
kind: feat
summary: "Evidence file and commit graph ids carry a repository key in stores that parent several repositories; `cleo brain migrate-repo-ids` moves existing links"
---

In a CLEO store that parents several repositories, `cleo verify` now links
evidence files and commits of every repository but the store's own to
repo-qualified graph nodes, `file:<repo>::<path>` and `commit:<repo>::<sha>`.
Same-named files in two child repositories (`a/src/x.ts`, `b/src/x.ts`) are
separate nodes. The repository key is the normalised `origin` URL
(`github.com/owner/repo`), the same on every device; a repository without an
origin is keyed by its directory relative to the store root. Single-repo stores,
worktrees of the store's repository and a store inside a monorepo that tracks it
keep their current ids. A submodule is its own repository. An outer repository
that tracks nothing under the store root (a dotfiles repository at `~`) is
ignored.

`cleo brain migrate-repo-ids [--dry-run]` moves existing evidence links to the
new ids. A commit moves to the one checkout that contains it. A file moves to the
one checkout that has its path, or, when several do, to the one the same task's
commits belong to. Anything still ambiguous is reported in `unresolved` and left
unchanged. Edges from other writers stay on the old node, which is removed only
once nothing uses it. Re-running is a no-op.
