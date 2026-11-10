---
id: skill-version-branch-point
tasks: [T14393]
kind: fix
summary: "Gate 32 measures skill version bumps from the branch point, so parallel PRs bumping one skill merge in either order"
---

Parallel PRs that changed one skill each bumped its `metadata.version` from
the same value; the second to merge failed gate 32 and had to re-bump, which
conflicted with every other open PR. The gate now requires the version to
exceed the branch point's in the PR head itself (CI passes it with `--head`)
and the merged version never to fall below the base's, so identical
next-minor bumps merge cleanly. A stable `v*` release tag (not canary or rc)
cut after the branch point becomes the anchor, so released versions stay
monotonic; a missing merge base or tag fails and names the fetch.
