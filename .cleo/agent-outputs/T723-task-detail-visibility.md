# T723 — Studio Task Detail Full Visibility

**Status**: complete
**Date**: 2026-04-15
**Commit**: 171ce756
**Agent**: Worker (claude-sonnet-4-6)

## What Was Missing

The Studio task detail page at `/tasks/[id]` was missing:

1. **Notes** — `notes_json` field in tasks.db was not being fetched or displayed
2. **Acceptance criteria pass/fail state** — all criteria were shown as `○` (pending) even for done tasks with all verification gates passed
3. **MANIFEST artifact linkage** — no connection to `.cleo/agent-outputs/MANIFEST.jsonl` entries
4. **Git commit linkage** — no connection to commits mentioning the task ID

Already present but enhanced: verification gates, failure log, subtasks, dependencies.

## What Was Implemented

### Server (`+page.server.ts`)

- Added `notes_json` to the SQL SELECT query and parsed it into `notes: string[]`
- Added `loadManifestEntries(projectPath, taskId)` function that reads `MANIFEST.jsonl`, parses each line, and matches entries where `task === taskId`, `linked_tasks.includes(taskId)`, or `id.startsWith(taskId + '-')`
- Added `loadLinkedCommits(projectPath, taskId)` function that runs `git log --all --format=%H|%s|%ai --grep=<taskId> -n 20` and fetches changed files per commit via `git diff-tree`
- Exported `ManifestEntry` and `LinkedCommit` interfaces
- Extended `TaskDetail` interface with `notes: string[]`

### Page (`+page.svelte`)

- **Header**: Added `size` badge alongside status/priority/type
- **Description**: Changed from `<p>` to `<div>` with `white-space: pre-wrap` for full content without truncation
- **Acceptance Criteria**: Now shows green `✓` checkmarks and `ac-pass` styling when `verification.passed === true`, gray `○` pending otherwise. Includes `ALL PASSED` badge when applicable.
- **Verification Gates**: Added `Round N — Pending` label when not yet passed
- **Notes & History** (NEW): Collapsible section showing each note from `notes_json` as a purple-bordered card with sequential index
- **Agent Artifacts** (NEW): Collapsible section showing MANIFEST entries as cards with type/status/date/title/summary (truncated to 300 chars)/output path/files
- **Git Commits** (NEW): Collapsible section showing commits as blue-bordered cards with SHA/subject/date/changed files (capped at 10, with +N more indicator)
- **Subtasks/Children**: Label now shows "Children" for epic type, "Subtasks" otherwise
- **Sidebar**: Added counts for artifacts, commits, notes as pills

## Verification Evidence

Server-side SSR verified via `curl -b "cleo_project_id=..."`:

**T718** (done task with notes):
- 6 AC all `ac-pass ✓`
- 1 note: "RESTORED FROM BACKUP. Worker actually shipped commit a225dd99..."
- 1 agent artifact: `T718-studio-epics-active` (impl/complete)
- 1 commit: `a225dd99 fix(studio): T718 — epic visibility...`

**T685** (done GPU fix task):
- 5 AC all `ac-pass ✓`
- 1 agent artifact: `T685-gpu-real-fix` (fix/complete) with summary
- 3 commits: `dbe48a84`, `e1b99ac4`, `591b2ff1` (all mention T685 in subject)

**T723** (pending task — this task):
- 7 AC all `ac-pending ○`
- Verification badge shows "Round 1 — Pending"
- No notes/artifacts yet (as expected before completion)

## Quality Gates

- `pnpm biome check`: clean (Svelte files ignored by biome)
- `pnpm run build`: success
- `pnpm --filter @cleocode/studio run test`: 198 tests passed, 0 failures

## Files Changed

- `packages/studio/src/routes/tasks/[id]/+page.server.ts`
- `packages/studio/src/routes/tasks/[id]/+page.svelte`
