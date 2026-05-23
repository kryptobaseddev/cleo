---
id: t9809-location-guards
tasks: [T9809]
kind: feat
prs: []
summary: "Ban worktrees outside canonical XDG location + CI lint gate + migration tool."
---

Implements the worktree location enforcement layer for Saga T9800 SG-WORKTREE-CANON,
council verdict D009.

## Changes

### `packages/worktree/src/worktree-create.ts` (AC1)

Added `assertCanonicalWorktreeLocation(targetPath)` — called **before** any
`git worktree add` execution. Throws `E_WT_LOCATION_FORBIDDEN` when the
resolved worktree path is outside `<cleoHome>/worktrees/`. There is NO
`CLEO_FORCE_LOCATION` escape hatch per AC4 / D009.

### `scripts/lint-worktree-location.mjs` (AC2)

CI script that runs `git worktree list --porcelain` and enforces:

- **RULE-1**: Every non-primary worktree must be under `<cleoHome>/worktrees/`.
- **RULE-2**: No `worktrees/` *directory* may exist under `<repo>/.cleo/` —
  only the sentinel file `.cleo/worktrees.json` is allowed (D009).

Added to `.github/workflows/ci.yml` as the `worktree-location-lint` job.

### `scripts/migrate-rogue-worktrees.mjs` (AC3)

Dry-runnable (`--dry-run`), idempotent migration tool:
1. Archives original rogue worktree paths to `.cleo/backups/rogue-worktrees-<ts>.tar.gz`.
2. Moves via `git worktree move <old> <canonical>`.
3. Appends to `.cleo/audit/worktree-migration.jsonl`.

### `packages/worktree/src/__tests__/worktree-create-location-guard.test.ts` (AC4)

Regression tests covering:
- Canonical path creation succeeds.
- Rogue path is rejected (structural guard contract).
- `CLEO_FORCE_LOCATION` has no effect — no escape hatch.
- Error message includes the forbidden path and canonical root.

### `AGENTS.md` (AC6)

Added "Worktree Location" subsection documenting the banned locations, runtime
enforcement, CI gate, and migration tool with a pointer to Epic T9809.
