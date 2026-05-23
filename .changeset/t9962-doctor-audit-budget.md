---
id: t9962-doctor-audit-budget
tasks: [T9962]
kind: fix
summary: "Add width-budget + timeout to doctor worktree-orphan audit to prevent 60s+ hang on large corpora"
---

`cleo doctor --audit-worktree-orphans` hung indefinitely on a 194-orphan corpus because depth was already bounded (MAX_SCAN_DEPTH=3) but per-entry IO at width was unbounded.

Two tactical fixes (strategic Rust rewrite deferred to T9977/T9986):

- Width budget: soft-warn at 100 entries per level, hard-stop at 500 with `isPartial: true, partialReason: 'overflow'` on the result envelope.
- Timeout: `--timeout <seconds>` flag (default 30s) on `cleo doctor --audit-worktree-orphans` and `--prune-worktree-orphans`; on expiry scan returns `isPartial: true, partialReason: 'timeout'`.

New `scanWorktreeOrphansBudgeted()` function wraps the existing bare-array scanner and surfaces the `OrphanScanResult` envelope. Existing `scanWorktreeOrphans` callers are unaffected.
