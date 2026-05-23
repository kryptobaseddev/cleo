---
"@cleocode/cleo": patch
---

feat(T10220): extract step/* SDK primitives into worktrunk-core (SAGA T10176, T10218)

Pure-function refactor of prune+promote+squash+copy_ignored+shared+relocate
per ADR-078 SoC contract. Builds on T10219's Repo trait + ProcessRepo
substrate (PR #507).

- `worktrunk_core::step::shared` — list_ignored_entries + filter pipeline.
- `worktrunk_core::step::copy_ignored` — plan + run for cross-worktree
  gitignored-file copy with COW + nested-worktree skip.
- `worktrunk_core::step::promote` — move-or-copy + stage + distribute +
  exchange_branches for branch-swap between worktrees.
- `worktrunk_core::step::squash` — classify_squash returns typed
  NoCommitsAhead / AlreadySingleCommit / StagedOnly / Squashable variants.
- `worktrunk_core::step::prune` — build_prune_plan walks worktrees +
  branches, probes integration via RefSnapshot, returns typed candidates.
- `worktrunk_core::step::relocate` — build_relocation_plan with cycle
  detection + blocked-path detection. Wires the canonical worktree path
  through `worktrunk_core::paths` which mirrors `@cleocode/paths`
  SHA-256 16-char project hashing (folds T10207 scope).

ProcessRepo gains 11 new method impls (ref_exists, default_branch,
count_commits, is_ancestor, merge_base, commit_subjects, diff_stats_summary,
all_branches, is_remote_tracking_branch, strip_remote_prefix,
detect_ref_type, capture_refs, integration_reason). 31→20 unimplemented_in_sdk
methods remaining for T10221 + future fill-in.

All extracted functions are pure: no println!, no hook firing, no approval
prompts, no styling. CLI orchestration stays in the worktrunk binary.

Tests: 111 green (101 unit + 6 integration + 4 doctest). Clippy --no-deps
clean. cargo build -p worktrunk-core --all-features clean.
