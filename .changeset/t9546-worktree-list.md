---
"@cleocode/cleo": minor
"@cleocode/core": minor
"@cleocode/contracts": minor
---

feat(T9546): cleo worktree list — structured JSON for all CLEO-managed worktrees (SAGA T10176)

Extends the `worktree.list` dispatch op so every entry returned by
`cleo worktree list` now exposes the full AC4 shape:
`{ taskId, path, branch, source, createdAt, lockState, ... }`. The new
`createdAt` field is derived from `<gitCommonDir>/worktrees/<name>/HEAD`
mtime for git-native entries and falls back to the sentinel index
`adoptedAt` timestamp for adopted external worktrees. The new
`lockState: 'locked' | 'unlocked'` field mirrors `isLocked` as a
human-readable token for downstream consumers.

Sentinel-only `.cleo/worktrees.json` entries (D009 hybrid pattern) are
unioned into the listing so adopted Claude Code Agent / manual worktrees
surface alongside canonical CLEO-spawned ones per ADR-055.

Adds 7 new integration tests under
`packages/core/src/__tests__/worktree-list.test.ts` covering AC1–AC4
with real on-disk git fixtures (no mocks).
