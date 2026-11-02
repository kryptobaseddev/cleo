---
id: release-supervisor-attach
tasks: [T14179]
kind: fix
summary: "release.yml attaches the cleo-supervisor binaries to the GitHub Release after creating it"
---

The cleo-supervisor prebuild workflow waited two minutes on a tag push for the
GitHub Release that release.yml creates about seven minutes later, so it failed
on almost every release and no supervisor binaries were attached.

- release.yml now calls the prebuild workflow and attaches the 5 binaries and
  their sha256 manifest in a `supervisor-attach` job that needs `publish`. It
  never gates publishing, and a failed release leaves no red supervisor run.
- The prebuild workflow no longer runs on tag pushes.
- `packages/core/binaries/README.md` now states that `@cleocode/core` ships no
  binary manifest today (nothing launches the supervisor yet; worktree-napi is
  bundled by `@cleocode/worktree`); shipping it is T14182.
