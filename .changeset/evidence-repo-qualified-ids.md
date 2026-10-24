---
id: evidence-repo-qualified-ids
tasks: [T14012]
kind: feat
summary: "Evidence file and commit graph ids carry a repository key for every repository but the store's primary one; `cleo brain migrate-repo-ids --apply` moves existing links"
---

`cleo verify` now links evidence files and commits of every repository but the
store's primary one to repo-qualified graph nodes, `file:<repo>::<path>` and
`commit:<repo>::<sha>`, so same-named files in two child repositories
(`a/src/x.ts`, `b/src/x.ts`) are separate nodes. Files and commits take their
repository from the same rule: the checkout that holds the file, or that
contains the commit.

The primary repository keeps unqualified ids: the store root's own checkout (or
an outer monorepo that tracks the store root), else the declared evidence git
root (`evidence.gitRoot` in `.cleo/project-context.json`, or
`CLEO_EVIDENCE_GIT_ROOT`). Single-repo stores, their worktrees, and a store that
parents one checkout it declares as `evidence.gitRoot` keep their current ids.
A store root that is not a checkout and declares no git root has no primary
repository: every child repository is qualified, even when there is only one,
so adding a second repository later never changes existing ids. Declare
`evidence.gitRoot` in such a store to keep its main repository unqualified.

The repository key comes from the `origin` URL and is the same on every device:
`github.com/<owner>/<repo>` through the github.com-anchored parser the PR
evidence uses, otherwise `<host>/<path>`, with scheme, user, port and `.git`
removed and everything lowercased. A repository without a usable origin is keyed
by its directory relative to the store root. A submodule counts as its own
repository. An outer repository that tracks nothing under the store root, such
as a dotfiles repository at `~`, is ignored. A `files:` path containing `::` is
skipped.

`cleo brain migrate-repo-ids` previews moving existing evidence links to the new
ids. It prints the counts and each ambiguous link, and writes nothing.
`--apply` first writes a receipt under `.cleo/backups/migrations/` mapping every
old id to its new id, then moves the links in one transaction. A commit moves to
the repository that contains it. A file moves to the one repository whose
checkout has its path, or, when several do, to the repository of the same
task's commits. Anything still ambiguous is left unchanged. Old nodes are kept
for a later prune, and copied commit nodes record `repo` in their metadata. The
migration never runs automatically, and re-running it is a no-op.
