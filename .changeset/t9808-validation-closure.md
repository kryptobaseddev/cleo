---
'@cleocode/cleo': minor
'@cleocode/core': minor
'@cleocode/contracts': minor
---

feat(T9808): cleo doctor --audit-worktree-orphans comprehensive scan + isolation lint + saga closure report

Extends `cleo doctor --audit-worktree-orphans` to run a comprehensive audit (council D009 / T9808):
  - Scans ALL git worktrees (via `git worktree list`), not just `.claude/worktrees/`
  - Flags worktrees outside the canonical XDG location (`<cleoHome>/worktrees/<projectHash>/`)
  - Detects rogue `.cleo/worktrees/` DIRECTORY (D009: only `.json` sentinel allowed)

New exports: `auditWorktreeOrphansComprehensive` from `@cleocode/core/doctor/worktree-orphans.js`.
New contracts: `ComprehensiveAuditResult`, `WorktreeAnomaly`, `WorktreeAnomalyKind`.

Also adds:
  - `scripts/lint-agent-worktree-isolation.mjs` — detects `EnterWorktree` (Claude Code isolation:worktree) usage in agent transcripts; wires as non-blocking CI warning.
  - `scripts/saga-T9800-closure-report.mjs` — generates + ingests saga T9800 closure report as `sg-worktree-canon-closure-report`.
