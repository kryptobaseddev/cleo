---
id: skill-version-branch-point
tasks: [T14393]
kind: fix
summary: "Gate 32 measures skill version bumps from the branch point, so parallel PRs bumping one skill merge in either order"
---

Parallel PRs that changed one skill each bumped its `metadata.version` from
the same value; the second to merge failed gate 32 and had to re-bump, which
conflicted with every other open PR. The gate now requires the version to
exceed the branch point's (CI passes the PR head with `--head`) and never fall
below the base's, so identical next-minor bumps merge cleanly. A `v*` release
tag cut after the branch point becomes the anchor, so released versions stay
monotonic.
