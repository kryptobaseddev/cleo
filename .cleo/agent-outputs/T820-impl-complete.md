# T820 Implementation Complete

**Task**: T820 EPIC P0: Project-agnostic cleo release pipeline  
**Date**: 2026-04-17  
**Session**: ses_20260416230443_5f23a3  
**HEAD**: 97894ad20e3c7db4ef95d5f9c4532bbe08e4d7cd  

---

## Test Results

| Metric | Before | After |
|--------|--------|-------|
| Failing tests in project-agnostic-release.test.ts | 17 | 0 |
| Total tests passing (full suite) | 8331 | 8542 |
| New test file tests passing | 0/17 | 24/24 |
| Pre-existing failures (unrelated) | 3 | 3 |

---

## Files Modified / Created

### Core: release-config.ts
**Path**: `/mnt/projects/cleocode/packages/core/src/release/release-config.ts`  
**Changes**:
- `loadReleaseConfig(cwd)` now reads `.cleo/release-config.json` (flat JSON) with priority over `.cleo/config.json` dotted paths
- New fields in `ReleaseConfig` interface: `gitWorkflow`, `registries`, `buildArtifactPaths`, `skipBuildArtifactGate`, `prereleaseChannel`
- `getPushMode()` prioritizes `config.gitWorkflow` over `config.push?.mode`
- `validateReleaseConfig()` validates `gitWorkflow` ('direct' | 'pr' | 'auto') and warns on unknown registries
- Full backward-compatibility with `.cleo/config.json` legacy keys preserved

### Test: project-agnostic-release.test.ts
**Path**: `/mnt/projects/cleocode/packages/core/src/release/__tests__/project-agnostic-release.test.ts`  
**Changes**: Fixed fixture path `../../../../packages/cleo/test/fixtures/release-test-project` → `../../../../cleo/test/fixtures/release-test-project` (was resolving to `packages/packages/cleo`)

### Fixture: release-test-project
**Path**: `/mnt/projects/cleocode/packages/cleo/test/fixtures/release-test-project/`  
**Files present**:
- `package.json` (no cleocode-specific entries)
- `.cleo/release-config.json` (versionScheme=semver, artifactType=source-only, skipBuildArtifactGate=true)

### Engine: release-engine.ts
**Path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/engines/release-engine.ts`  
**Changes**:
- Added `getIvtrState` import from `@cleocode/core/internal`
- Added `checkIvtrGates()` helper that queries IVTR state for a list of task IDs
- Added Step 1.5 in `releaseShip` that blocks if any epic task has `ivtr_state.currentPhase !== 'released'`
- Added `force` parameter to `releaseShip` (bypasses IVTR gate with owner warning)
- Replaced `releaseRollbackFull` stub with full implementation: git tag delete, git revert, DB flip, optional npm deprecate
- Replaced `releaseChangelogSince` stub with real `git log <sinceTag>..HEAD` parsing, task/epic ID extraction, grouped markdown output

### Domain: ivtr.ts
**Path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/ivtr.ts`  
**Changes**: `ivtr.release` success response gains `nextStep` field pointing to `cleo release ship <version> --epic <epicId>`

### Domain: pipeline.ts
**Path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/pipeline.ts`  
**Changes**: `release.ship` dispatch passes `force` flag; `release.rollback.full` dispatch passes `unpublish` flag

### ADR
**Path**: `/mnt/projects/cleocode/.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md`

---

## Evidence for T821-T827

### T821 (RELEASE-01: release-config.json)
- File: `packages/core/src/release/release-config.ts`
- Test: `packages/core/src/release/__tests__/project-agnostic-release.test.ts` — 13 tests in RELEASE-01 group all passing
- No hardcoded paths; reads from `cwd` parameter

### T822 (RELEASE-02: git log CHANGELOG)
- File: `packages/cleo/src/dispatch/engines/release-engine.ts` — `releaseChangelogSince()` + `parseGitLogCommits()`
- Parses `T\d+` and `Epic T\d+` patterns from `git log --pretty=format:%H\x1f%cI\x1f%s %b\x1e`
- Groups by epic, renders markdown with task refs and sha prefixes

### T823 (RELEASE-03: IVTR gate enforcement)
- File: `packages/cleo/src/dispatch/engines/release-engine.ts` — `checkIvtrGates()` + Step 1.5 in `releaseShip`
- Error code: `E_LIFECYCLE_GATE_FAILED` with `fix: "cleo orchestrate ivtr <id> --release"` 
- `--force` bypasses with `console.warn` owner warning

### T824 (RELEASE-04: PR-first mode)
- File: `packages/core/src/release/release-config.ts` — `getPushMode()` prioritizes `gitWorkflow`
- File: `packages/cleo/src/dispatch/domains/pipeline.ts` — passes `force` to `releaseShip`
- `createPullRequest()` call path already existed; now gated by `config.gitWorkflow === 'pr'`

### T825 (RELEASE-05: Real rollback)
- File: `packages/cleo/src/dispatch/engines/release-engine.ts` — `releaseRollbackFull()` full implementation
- Sequence: remote tag delete → local tag delete → revert commit → DB flip → optional npm deprecate
- All steps best-effort with step log; only DB flip is required (rest are graceful)

### T826 (RELEASE-06: Downstream fixture)
- Path: `packages/cleo/test/fixtures/release-test-project/`
- 7 tests in RELEASE-06 group all passing: fixture exists, has config, loads without error, no cleocode paths, skipBuildArtifactGate=true, artifactType=source-only, validates clean

### T827 (RELEASE-07: IVTR pipeline wire)
- File: `packages/cleo/src/dispatch/domains/ivtr.ts` — `ivtr.release` success response gains `nextStep`
- `releaseShip` IVTR gate (T823) closes the feedback loop: IVTR release phase → `cleo release ship`

---

## Quality Gates

| Gate | Status |
|------|--------|
| pnpm biome ci . | PASS (1 warning, 1 info, 0 errors) |
| pnpm run build | PASS |
| 17 previously failing tests | ALL PASS |
| Full suite regression | 0 new failures |
| TypeScript strict (tsc --noEmit) | PASS |
