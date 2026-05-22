---
"@cleocode/cleo": minor
---

feat(T9983): .worktreeinclude at repo root is canonical (E6-WORKTREEINCLUDE-MIGRATION)

- Reader prefers `<repo>/.worktreeinclude` (was: `<repo>/.cleo/worktree-include`).
- `cleo init` scaffolds `<repo>/.worktreeinclude` from a multi-language
  template at `packages/core/templates/worktreeinclude`.
- `cleo doctor --migrate-worktree-include` auto-migrates legacy → canonical
  with a timestamped `.cleo/backups/worktree-include-<iso>.bak` backup.
  Supports `--dry-run`.
- Migrates cleocode itself: `.worktreeinclude` committed at root.
- ADR-077 recorded (slug=adr-077-worktreeinclude-canonical-location).
- `AGENTS.md` updated to document the canonical location + deprecation
  policy.

Industry-standard convention: matches Claude Code Desktop + worktrunk-core.
Legacy `<repo>/.cleo/worktree-include` is still readable for one
deprecation cycle (already wired in PR #487 via a one-time
`process.emitWarning('DeprecationWarning', 'CLEO_WORKTREE_INCLUDE_LEGACY')`).

Saga: T9977
Closes: T10029, T10030, T10031, T10032, T10033, T10034
