# Wave 7A: Final-Verifier — v2026.3.20 Pipeline Status

**Date**: 2026-03-08
**Version**: v2026.3.20
**Overall Status**: PARTIAL — Release shipped, CI FAILING

---

## CI: FAIL

**Run ID**: 22811087081
**Trigger**: push to `main` (commit: `release: ship v2026.3.20 (T5598)`)
**URL**: https://github.com/kryptobaseddev/cleo/actions/runs/22811087081

| Job | Result |
|-----|--------|
| Hygiene Gates | SUCCESS |
| Validate JSON Files | SUCCESS |
| npm Install Test | SUCCESS |
| TypeScript Build & Test (ubuntu-latest) | FAIL |
| TypeScript Build & Test (macos-latest) | FAIL |
| TypeScript Build & Test (windows-latest) | FAIL |

**Root cause**: `drizzle-brain/` directory was deleted from the repository (git status shows multiple `D drizzle-brain/...` entries). This causes `ENOENT: no such file or directory, scandir '.../drizzle-brain'` in `src/store/brain-sqlite.ts:109` (`readMigrationFiles`) when the brain-lifecycle e2e tests run. All 3 platforms fail identically.

**Failing test**: `tests/e2e/brain-lifecycle.test.ts` — `getBrainDb` → `runBrainMigrations` → `readMigrationFiles` cannot find the `drizzle-brain/` migrations directory.

## npm @latest: 2026.3.20 — PUBLISHED

```
npm view @cleocode/cleo version → 2026.3.20
```

Published successfully via the Release workflow (separate from CI).

## GitHub Release: SUCCESS

**URL**: https://github.com/kryptobaseddev/cleo/releases/tag/v2026.3.20
**Label**: Latest (non-prerelease)
**Published**: 2026-03-08T01:14:54Z
**Assets**: cleo-2026.3.20.tar.gz, install.sh, SHA256SUMS

Release workflow run 22811087277: **completed / success**

**Release notes include**:
- Fix missing drizzle-brain symlink for brain.db initialization (T5650)
- Fix Layer 1 gate validator rejecting valid non-task status values (T5598)

## brain.db Health

- **Path**: `/home/keatonhoskins/.cleo/brain.db`
- **Size**: 0 bytes (empty — brain.db is uninitialized at this path)
- **memory find "migration"**: Returns 30 results — brain search is fully operational via the project's local build (`dist/cli/index.js`)

Note: The 0-byte brain.db at `~/.cleo/brain.db` is expected; the project-local brain.db is what matters for dev use and it works correctly.

## claude-mem Observation Count

**Count**: 8,622 observations in `~/.claude-mem/claude-mem.db`

## Final Observation Saved

**Status**: YES
**Brain ID**: `O-mmh2k4ue-0`
**Text**: "Release v2026.3.20 complete - ESM fix (T5598) and brain.db symlink (T5650) shipped. Release workflow: SUCCESS, npm @latest: 2026.3.20 published. CI on main: FAIL - drizzle-brain/ directory deleted from repo..."
**Confirmed via**: `memory find "ESM fix"` returned `O-mmh2k4ue-0` as first result.

---

## Summary

| Check | Status | Detail |
|-------|--------|--------|
| Release workflow (v2026.3.20 tag) | GREEN | Run 22811087277 — success |
| npm @latest | GREEN | 2026.3.20 published |
| GitHub release | GREEN | https://github.com/kryptobaseddev/cleo/releases/tag/v2026.3.20 |
| CI on main | RED | All 3 platform test runs fail — drizzle-brain/ deleted |
| brain.db memory find | GREEN | 30 results for "migration" query |
| claude-mem count | GREEN | 8,622 observations |
| Final observation saved | GREEN | O-mmh2k4ue-0 confirmed |

**Action required**: The `drizzle-brain/` directory (and its migration files) must be restored or the `drizzle-brain` symlink must be committed to the repository. The T5650 fix added a runtime symlink resolution, but the actual migration files need to exist in the repo for CI runners (which start from a clean checkout with no symlinks pre-created).
