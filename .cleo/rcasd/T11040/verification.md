# T11040 Verification

**Task**: T10298-followup: brain/src/cleo-home.ts uses CWD-walk-up instead of projectId-based resolution

## AC Coverage

### AC1: getCleoProjectDir() replaced with resolveProjectByCwd()+resolveCanonicalCleoDir
**PASS** — `packages/brain/src/cleo-home.ts:37-43` already implements this. The T1882 refactor (commit a8341a1ec, 2026-05-05) extracted `@cleocode/paths` SSoT and `getCleoProjectDir()` calls `resolveProjectByCwd()` → `resolveCanonicalCleoDir(project.projectId)` with a `projectRoot` fallback when nexus.db hasn't registered the project yet.

### AC2: getBrainDbPath/getTasksDbPath/getConduitDbPath all resolve through projectId
**PASS** — All three functions delegate to `getCleoProjectDir()` which uses projectId-based resolution.

### AC3: resolveDefaultProjectContext uses projectId resolution
**PASS** — `packages/brain/src/project-context.ts:53` calls `resolveProjectByCwd()` and derives `projectPath` from the canonical `project.projectRoot`.

### AC4: Existing tests pass with no regression
**PASS** — 72/72 brain tests pass (vitest JSON: `.cleo/rcasd/T11040/brain-tests.vitest.json`).

## Evidence

- Code fix: present on main since T1882 (commit a8341a1ec, 2026-05-05)
- Explicit T11040 commit: 634a98387 on `fix/T10297-worktree-napi-bundle` (2026-05-26)
- Tests: 72 passed, 0 failed, 0 skipped

## Verdict

ALL ACS PASS — no code changes required; fix was already in place from the T1882 `@cleocode/paths` SSoT extraction.
