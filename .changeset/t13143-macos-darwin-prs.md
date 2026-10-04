---
id: t13143-macos-darwin-prs
tasks: [T13143]
kind: chore
summary: A darwin-specific pull request runs the macOS tests; Linux and macOS shard 8 ways; the newest main push gets a macOS run
---

macOS unit tests ran only nightly and in merge groups, so a macOS-only regression was found the next
night. A pull request whose change is darwin-specific now runs them too. That means a changed path
naming darwin or macOS (outside `.changeset/` and `docs/`), or a changed code or workflow line that
adds or removes a platform check (`process.platform`, `os.platform()`, a `'darwin'` literal). macOS
now shards 8 ways (Linux 4), so its wall time drops to the Linux range when it runs. One script,
`scripts/ci-platform-matrix.mjs`, decides the runners for Build, Build & Verify and Unit Tests. If
it cannot read the diff, macOS runs.

Linux unit tests and release-prepare's preflight shards also go from 4 to 8, because runners are free
on a public repo, so a full suite fits a PR's ~10-minute budget. A new cancellable `macos-main.yml`
workflow runs the macOS suite on main pushes, and only the newest push keeps its run. `cleo release
open` reads that result for the release commit, so release-prepare can usually skip its macOS
shards. Darwin detection also covers Rust `target_os`, `'Darwin'`, `uname` in shell scripts, and
macOS-only CI steps. A platform-agnostic change that only breaks on macOS (realpath, spaces in paths,
the case-insensitive filesystem, BSD flags) is still found by the nightly or main-push run, not on
its PR.
