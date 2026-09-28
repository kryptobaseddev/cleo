---
id: t12518-macos-physical-temp
tasks: [T12518]
kind: test
summary: the vitest fork sandbox is built under the physical temp root, so ~350 tests stop failing on macOS
---

On macOS `tmpdir()` is a symlink into `/private`. Code under test realpaths
directories (registry, evidence roots, worktree guards) while fixtures built
from the unresolved sandbox path did not, so a local `tool:test` evidence run
failed 348 tests that pass on Linux CI. The sandbox parent is now realpath'd.
