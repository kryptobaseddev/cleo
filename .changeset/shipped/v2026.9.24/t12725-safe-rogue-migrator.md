---
id: t12725-safe-rogue-migrator
tasks: [T12725]
kind: fix
summary: "scripts/migrate-rogue-worktrees.mjs refuses unknown flags such as --check, is dry-run by default, moves only with --apply, and never unlocks or moves a locked or in-use worktree"
---

An agent ran every script named in AGENTS.md with `--check`. The migrator
ignored `--check`, because only `--dry-run` stopped it. Each run unlocked one
live Agent-tool worktree under `.claude/worktrees/` and moved it. Three were
moved while agents were working in them.

- **Strict arguments.** Any argument other than `--dry-run`, `--apply`,
  `--no-archive`, `--force-unused` and `--help` is refused with exit 2 and a
  usage message, before any git or filesystem action. `--apply` together with
  `--dry-run` is refused too.
- **Dry-run by default.** A run without `--apply` prints the plan and moves
  nothing.
- **Locked worktrees are never touched.** The script no longer runs
  `git worktree unlock`. A worktree with a `locked` line in
  `git worktree list --porcelain` is skipped, even with `--apply`.
- **In-use worktrees are never touched.** A worktree that a running process
  has as its cwd is skipped. The probe reads `/proc` on Linux and uses
  `lsof -d cwd` elsewhere. When neither is available, the worktree is treated
  as in use unless `--force-unused` is passed. `--force-unused` never
  overrides a lock or a detected process.
- **Reporting.** Every skipped worktree is printed with its reason and, under
  `--apply`, logged as `skipped` in `.cleo/audit/worktree-migration.jsonl`.
  Each moved worktree gets its own archive.
- AGENTS.md now describes the script as a manual, owner-invoked repair
  (`--dry-run` first, then `--apply`), not a gate. The
  `lint-worktree-location.mjs` hint says the same, and the lint stays
  report-only.
