# CI/CD and Template Validation Report

**Date**: 2026-03-18
**Branch**: current working tree
**Validator**: Quality Engineer agent

---

## Summary

| Check | Result | Details |
|-------|--------|---------|
| 1. TypeScript compilation | **FAIL** | 434 errors across 47 files |
| 2. Build | **PASS** | esbuild completes (warnings only: ES2025 target) |
| 3. YAML syntax validation | **PASS** | Both ci.yml and release.yml parse cleanly |
| 4. CI workflow content review | **PASS** | All criteria met |
| 5. Release workflow content review | **PASS** | All criteria met |
| 6. Template files match deployed files | **PARTIAL FAIL** | Workflows match; ISSUE_TEMPLATE and PR template not deployed |
| 7. CHANGELOG.md | **PASS** | Proper Keep a Changelog format with [Unreleased] section |
| 8. Init/upgrade wiring | **PASS** | All three files have GitHub template handling |
| 9. No duplication | **PASS** | templates/ is source, .github/ is target (init copies) |
| 10. Test suite | **FAIL** | 2 files failed (3 tests), 4722 passed, 5 skipped |

**Overall: 7 PASS, 1 PARTIAL FAIL, 2 FAIL**

---

## Detailed Results

### Check 1: TypeScript compilation -- FAIL

`npx tsc --noEmit` reports 434 errors across 47 files. All errors are in test files under `packages/cleo/src/`. The errors are type-mismatch issues in test mocks/fixtures that do not satisfy updated core type definitions (e.g., missing required fields on `TaskRecord`, `MinimalTaskRecord`, etc.).

**Root cause**: Core types were updated (likely during the monorepo extraction) but test files were not updated to match the new type signatures.

**Files affected** (sample):
- `packages/cleo/src/__tests__/cli-mcp-parity.integration.test.ts`
- `packages/cleo/src/dispatch/domains/__tests__/admin.test.ts`
- `packages/cleo/src/dispatch/domains/__tests__/tasks.test.ts`
- `packages/cleo/src/dispatch/engines/__tests__/release-engine.test.ts`
- ...and 43 more test files

**Fix needed**: Update test fixtures and mocks to include all required fields from the updated type definitions. Common missing fields: `description`, `createdAt`, `updatedAt` on `TaskRecord`; `priority` on `MinimalTaskRecord`; `duplicate` on add results; `task` on complete results.

### Check 2: Build -- PASS

`pnpm run build` (via `node build.mjs`) exits 0. Produces:
- `packages/core/dist/index.js`
- `packages/adapters/dist/index.js`
- `packages/cleo/dist/cli/index.js`
- `packages/cleo/dist/mcp/index.js`

Only warnings are about unrecognized `ES2025` target in esbuild (cosmetic, non-blocking).

### Check 3: YAML syntax validation -- PASS

Both workflow files parse as valid YAML:
- `.github/workflows/ci.yml`: VALID
- `.github/workflows/release.yml`: VALID

### Check 4: CI workflow content review -- PASS

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Uses `pnpm/action-setup` | PASS | Lines 61, 94, 128, 184 |
| Uses `pnpm install --frozen-lockfile` | PASS | Lines 74, 108, 141, 198 |
| References Node 24 | PASS | Lines 60, 93, 127, 183 |
| Has typecheck job | PASS | Lines 50-76 |
| Has test job | PASS | Lines 78-110 (unit-tests with sharding) |
| Has build job | PASS | Lines 112-154 (build-verify) |
| Has biome job | PASS | Lines 39-48 |
| Build verifies `packages/*/dist/` paths | PASS | Lines 146-150 |
| No references to old `dev/` scripts | PASS | No matches found |
| No references to `npm` commands | PASS | No matches found |
| Concurrency group set | PASS | Lines 9-11 |
| Path filtering for code changes | PASS | Lines 14-37 (dorny/paths-filter) |

### Check 5: Release workflow content review -- PASS

| Criterion | Status | Evidence |
|-----------|--------|----------|
| CalVer validation present | PASS | Lines 69-96 |
| Multi-package publish in dependency order | PASS | Lines 237-270: contracts -> core -> adapters -> cleo |
| GitHub Release creation with tarball | PASS | Lines 214-231 |
| CHANGELOG extraction | PASS | Lines 195-212 |
| Uses pnpm not npm | PASS | Lines 32-33, 113-114, 244-268 |
| OIDC permissions set | PASS | Lines 17-19 (`contents: write`, `id-token: write`) |
| No reference to server.json or MCP registry | PASS | No matches found |

### Check 6: Template files match deployed files -- PARTIAL FAIL

| Comparison | Status |
|-----------|--------|
| `templates/github/workflows/ci.yml` vs `.github/workflows/ci.yml` | **IDENTICAL** (diff exit 0) |
| `templates/github/workflows/release.yml` vs `.github/workflows/release.yml` | **IDENTICAL** (diff exit 0) |
| `templates/github/ISSUE_TEMPLATE/` (4 files exist in source) | Source has 4 files: `bug_report.yml`, `config.yml`, `feature_request.yml`, `help_question.yml` -- all valid YAML |
| `.github/ISSUE_TEMPLATE/` | **MISSING** -- directory does not exist |
| `templates/github/pull_request_template.md` | Source exists (2626 bytes) |
| `.github/pull_request_template.md` | **MISSING** -- file does not exist |

**Fix needed**: Run the init function to deploy templates, OR manually copy:
```bash
cp -r templates/github/ISSUE_TEMPLATE .github/ISSUE_TEMPLATE
cp templates/github/pull_request_template.md .github/pull_request_template.md
```

**Note**: This is expected behavior by design -- the init system (`installGitHubTemplates`) copies these on `cleo init`. Since the cleocode monorepo itself may not have been fully init'd with the latest code, the templates are present in source (`templates/github/`) but not yet deployed to `.github/`. The workflow files were manually placed.

### Check 7: CHANGELOG.md -- PASS

File follows Keep a Changelog format:
- Header references [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
- Uses CalVer versioning notation
- Has `## [Unreleased]` section
- Lists changes under `### Added`

### Check 8: Init/upgrade wiring -- PASS

**`packages/core/src/init.ts`**:
- `installGitHubTemplates()` function at lines 324-377: installs issue templates and PR template
- Idempotent: checks `existsSync(dest)` before writing, skips existing files
- Called from `initProject()` at line 697
- Sources templates from `getPackageRoot()/templates/github/`

**`packages/core/src/upgrade.ts`**:
- Imports `installGitHubTemplates` from init.ts (line 32)
- Checks for `.github/ISSUE_TEMPLATE/` existence at lines 893-898
- Installs missing templates during upgrade (line 901)
- Dry-run preview support at lines 914-929

**`packages/core/src/system/health.ts`**:
- GitHub templates health check at lines 744-759
- Checks `.github/ISSUE_TEMPLATE/` directory existence
- Reports warning status with fix suggestion (`cleo init`) if missing
- Only runs when `.git/` directory exists (line 747)

### Check 9: No duplication -- PASS

Architecture is correct:
- **Source of truth**: `templates/github/` (ships with the package)
- **Target**: `.github/` (created per-project by `installGitHubTemplates()`)
- **Direction**: `templates/github/` -> `.github/` via init/upgrade
- The `init.ts` function reads from `getPackageRoot()/templates/github/` and writes to `projectRoot/.github/`
- No divergent copies -- workflow files in `.github/workflows/` are identical to `templates/github/workflows/`

### Check 10: Test suite -- FAIL

```
Test Files: 2 failed | 279 passed | 1 skipped (282)
Tests:      3 failed | 4722 passed | 5 skipped (4730)
Duration:   186.31s
```

3 test failures in 2 files. The failures are in integration tests (`mutate.integration.test.ts`). This is separate from the 434 TypeScript compilation errors (which are in different test files that may not be included in the vitest run due to build-time exclusion).

---

## Issues Requiring Fixes

### Critical (blocks CI)

1. **TypeScript compilation errors (434 errors in 47 test files)**
   - Update test mocks/fixtures to satisfy updated core type definitions
   - Most common missing fields: `description`, `createdAt`, `updatedAt`, `priority`, `duplicate`, `task`
   - These will block the `typecheck` CI job

2. **3 test failures in integration tests**
   - File: `packages/cleo/src/mcp/gateways/__tests__/mutate.integration.test.ts` (line 203)
   - Likely assertion failures from updated response shapes
   - Will block the `unit-tests` CI job

### Non-Critical (does not block CI)

3. **GitHub issue/PR templates not deployed to `.github/`**
   - `templates/github/ISSUE_TEMPLATE/` has 4 valid YAML files but `.github/ISSUE_TEMPLATE/` does not exist
   - `templates/github/pull_request_template.md` exists but `.github/pull_request_template.md` does not
   - Fix: `cp -r templates/github/ISSUE_TEMPLATE .github/ && cp templates/github/pull_request_template.md .github/`
   - Or run the init system to deploy them automatically

4. **esbuild ES2025 target warnings** (cosmetic)
   - esbuild does not recognize `ES2025` target from tsconfig.json
   - Non-blocking but noisy; consider pinning esbuild target to `ES2024` or `esnext` in `build.mjs`
