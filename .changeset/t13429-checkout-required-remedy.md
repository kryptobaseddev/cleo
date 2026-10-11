---
id: t13429-checkout-required-remedy
tasks: [T13429]
kind: fix
summary: cleo done's checkout-required blocker for a merged PR now fetches a merge commit the checkout lacks before switching to it, and says why a squash- or rebase-merged branch is refused
---

`checkout-required` for a merged PR is intended. When merged CI cannot carry
`testsPassed`/`qaPassed`, `cleo done` runs the tools, and they must measure a
tree containing the PR's merge commit. A squash- or rebase-merged task branch
never contains that commit, even when its diff matches.

Two things were wrong with the blocker:

- Its remedy, `git switch --detach <merge>`, failed in a checkout that had not
  fetched since the merge. The remedy now starts with `git fetch origin &&` when
  the commit is missing locally.
- The message did not explain why a merged branch is refused. It now names the
  squash/rebase case, and points to `ci:<pr>` when `evidence.ciSatisfies` is set.
