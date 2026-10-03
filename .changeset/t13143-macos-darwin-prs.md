---
id: t13143-macos-darwin-prs
tasks: [T13143]
kind: chore
summary: A darwin-specific pull request runs the macOS tests; macOS shards 8 ways
---

macOS unit tests ran only nightly and in merge groups, so a macOS-only regression was found the next
night. A pull request whose change is darwin-specific now runs them too. That means a changed path
naming darwin or macOS (outside `.changeset/` and `docs/`), or a changed code or workflow line that
adds or removes a platform check (`process.platform`, `os.platform()`, a `'darwin'` literal). macOS
now shards 8 ways (Linux 4), so its wall time drops to the Linux range when it runs. One script,
`scripts/ci-platform-matrix.mjs`, decides the runners for Build, Build & Verify and Unit Tests. If
it cannot read the diff, macOS runs.
