---
id: component-credit-lows
tasks: [T12689]
kind: fix
summary: "component PRs are credited for files a later change also edited and for deletion-only changes; gh --version is bounded; criterion links record whether a named path supports them"
---
Follow-ups from the component/integration PR review (#1655):

- **Shared files.** A component's change to a file that another change on the
  integration branch later edited is credited while the component's hunks still
  apply. Its first-parent patch must reverse-apply cleanly to the landing
  version. This is checked in a throwaway index and never touches the working
  tree. A reverted or overwritten change is still not credited.
- **Deletion-only components.** A component that only deleted files is now
  credited, on the stacked path and when the integration PR is named. The
  evidence is `pr:<component>@<integration>;note:<deleted paths>`, because a
  deletion has no bytes to hash.
  - The `pr:` atom records `deletedPaths`.
  - `implemented` accepts `pr` + `note` only when every change the PR made is a
    deletion. Any other PR still needs `files:`.
  - Component deletions now count as changed paths for task linkage.
- **`gh --version`.** `isGhCliAvailable` now uses the same deadline as other
  evidence `gh` queries (30s, or `CLEO_GH_TIMEOUT_MS`). A gh that hangs counts
  as unavailable.
- **`satisfies:` coverage.** Each `implemented` criterion link in a receipt now
  records a `basis`:
  - `files` when a path the criterion names is among the inspected artifacts or
    the PR's changed paths;
  - `self-attested` otherwise, meaning the link rests on the agent's claim.

  Paths parsed from criterion text are advisory (T12118), so this flags rather
  than refuses.
