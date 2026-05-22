---
id: t9807-provisioning-perf
tasks: [T9807]
kind: fix
prs: []
summary: "bound worktree include-pattern apply loop + optional sparse-checkout scope"
---

fix(T9807): bound worktree include-pattern apply loop + optional sparse-checkout scope

Fixes a recurring `[worktree] include-pattern symlink failed: .vscode/settings.json`
error on every spawn for projects whose `.cleo/worktree-include` lists nested paths
(e.g. `.vscode/settings.json`). The parent directory (`.vscode/`) was never created
in the worktree before `symlinkSync` was called, causing ENOENT on each provision
attempt. Fix: `applyIncludePatterns` now calls `mkdirSync({ recursive: true })` on
the target parent before attempting the symlink (T9807).

Also wires optional sparse-checkout cone-mode scope to `cleo orchestrate spawn`
via a new `--scope <dir>` flag (e.g. `--scope packages/cleo`). When supplied,
the provisioned worktree runs `git sparse-checkout init --cone && git sparse-checkout
set <scope>` to limit the checked-out tree to the relevant subtree — reducing
initial disk footprint for single-package tasks.

Adds benchmark script `scripts/benchmark-worktree-provisioning.mjs` (AC4) for
measuring p50/p95 provisioning time and disk delta across baseline / CoW / sparse
strategies. Output written to `.cleo/research/t9807-provisioning-benchmark.json`.

Worktree-pool (AC3) and GSD-2 comparison (AC5) deferred to T9807-phase-2 /
T9808 saga-closure task.

Saga: T9800 SG-WORKTREE-CANON
