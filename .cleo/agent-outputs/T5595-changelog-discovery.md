# T5595 Discovery Context — Changelog Generation Gaps

**Date**: 2026-03-07
**Session**: perf-safety-fixes + release cleanup

## What the Generator Actually Does (src/core/release/release-manifest.ts:172)

1. Reads `releaseManifests.tasksJson` — task IDs manually added via `release add`
2. For each ID: loads `task.title` only — no description, no children
3. Buckets by naive string match: `startsWith('feat')`, `includes('add ')`, etc.
4. Emits `- {task.title} ({task.id})` per line

**No git log. No commit messages. No task descriptions. No epic traversal. No children.**

## Real Evidence of the Problem

**v2026.3.16** generated:
```
### Bug Fixes
- fix: MCP response payload optimization — ranked blockedTasks, compact admin help, domain pagination (T5584)
```
That's the OLD T5584 title before the actual work was done. What shipped: batch saveArchive() transaction, iterative BFS findDescendants, hook error hardening, lifecycle_transitions ID uniqueness fix. None of that appears.

**v2026.3.15** generated:
```
### Other
- EPIC: Metrics Value Proof System - Real Token Tracking and Validation (T2847)
- EPIC: CLEO V2 Full TypeScript System (LAFS-native) (T4454)
- EPIC: Full System Audit, Assessment & Cleanup Post-V2 Migration (T4541)
```
Three epic titles. The actual work (release engine, SQLite manifests, contributor detection, CI consolidation) was never captured because those tasks weren't manually added to the manifest.

## Root Cause

`releaseManifests.tasksJson` must be manually curated. Nobody does this correctly. Git commits are the ground truth of what shipped but are never consulted.

## Proposed Fix: Git-Primary Changelog

```
git log v{prev}..v{current} --format="%s" --no-merges
```

Each commit subject already has type prefix (`feat:`, `fix:`, `chore:`) and task ref `(T####)`.

Steps:
1. `git log` from prev tag to current tag — get all commit subjects
2. Parse type from prefix → bucket into feat/fix/chore/docs/tests
3. Extract `(T####)` refs → look up task for description/parentId
4. Group under epic heading when parentId is an epic
5. Orphan commits (no T####): include as-is under their type bucket
6. Orphan tasks (in manifest but no commits): include as footnote

## Files to Change
- `src/core/release/release-manifest.ts:172` — `generateReleaseChangelog()`
- `src/dispatch/engines/release-engine.ts` — `releaseChangelog()` wrapper
- `src/core/release/changelog-writer.ts` — may need epic grouping support

## Also: `findLatestPushedVersion()` at line 79
There's already a function that finds the previous version tag. Use it to establish the git log range automatically.
