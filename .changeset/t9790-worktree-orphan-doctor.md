---
id: t9790-worktree-orphan-doctor
tasks: [T9790]
kind: feat
summary: "cleo doctor gains --audit-worktree-orphans and --prune-worktree-orphans for the T9550/T9580 SSoT-bug fallout."
---

Adds two flags to `cleo doctor`:

- `--audit-worktree-orphans` — read-only LAFS envelope listing every
  orphan `.cleo/` directory under `<projectRoot>/.claude/worktrees/`,
  with per-entry provenance (`worktreePath`, `orphanPath`, `dbFiles`,
  `sizeBytes`, `lastModifiedAt`, `ageSeconds`, `isFullDuplicate`).
- `--prune-worktree-orphans [--dry-run]` — archives every orphan to
  `<projectRoot>/.cleo/backups/worktree-orphans-<ts>.tar.gz`, appends
  one JSONL line per pruned entry to
  `<projectRoot>/.cleo/audit/worktree-prune.jsonl`, then removes the
  orphan. Every path is validated to live under
  `<projectRoot>/.claude/worktrees/` before any unlink.

CORE primitives shipped under `@cleocode/core/doctor/`:
`scanWorktreeOrphans()` and `pruneWorktreeOrphans()`. Contracts shipped
under `@cleocode/contracts`: `OrphanEntry`, `PruneResult`,
`PruneAuditEntry`.

Closes Phase 1 + Phase 2 of T9790. Phase 3 (CI gate) filed as
follow-up.
