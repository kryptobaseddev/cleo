# T1168: Wire Migration Linter into Pre-Commit + CI

**Task**: T-MSR-W2A-06  
**Status**: complete  
**Commit**: `4b2f230d3fc73b5582723fba6def3ae24bd57d88`  
**Date**: 2026-04-21

## What Was Done

### 1. Linter Enhancements (`scripts/lint-migrations.mjs`)

Added two new capabilities to the existing RULE-1/2/3/4 linter:

- `--fail-on=error|warn|none` flag (default: `error`)
  - `error`: exit 1 only on ERROR-severity violations (RULE-1 trailing breakpoint, RULE-2 timestamp collision)
  - `warn`: exit 1 on any violation
  - `none`: always exit 0 (report-only mode)
- GitHub Actions annotations: when `GITHUB_ACTIONS=true` is set (automatic on runners), violations
  are emitted as `::error file=<path>::<message>` and `::warning file=<path>::<message>` so findings
  appear inline on PR diffs.
- No existing rule severities were changed.

### 2. Pre-Commit Hook (`.git/hooks/pre-commit`)

Added migration linter gate after the existing lockfile drift check. The gate:
- Fires only when staged files match `packages/*/migrations/**` or `scripts/lint-migrations.mjs`
- Runs `node scripts/lint-migrations.mjs --fail-on=error`
- RULE-1 ERRORs block the commit with a clear error message
- WARNs (RULE-3 snapshot chain, RULE-4 flat SQL) print but do not block
- Gracefully skips if Node.js is not in PATH or the linter file is missing

Hook framework used: plain `.git/hooks/pre-commit` shell script (existing repo pattern — no Husky).

### 3. CI Workflow (`.github/workflows/ci.yml`)

Added `migration-lint` job with:
- `ubuntu-latest`, `node 24`, `pnpm 10.30.0` (matching existing jobs)
- pnpm store cache (matching existing jobs)
- `pnpm install --frozen-lockfile` + `node scripts/lint-migrations.mjs --fail-on=error`
- `GITHUB_ACTIONS=true` set automatically by runner — triggers inline PR annotations
- Fails job on any ERROR (RULE-1, RULE-2); WARNs surface as `::warning` annotations without failing

### 4. T1141 Absorption

T1141 ("Drizzle migration generator must NEVER emit trailing statement-breakpoint") is fully satisfied by:
- T1168: RULE-1 CI gate + pre-commit hook enforcement (acceptance item 5: retro-fix scan, item 6: pre-commit hook)
- T1164 (W2A-02): generator post-processing sanitizer

T1141 marked done with owner-override evidence pointing to this commit.

## Current Linter State on Main Branch

- Errors: 0 (CI job will PASS on merge)
- Warnings: 23 (all RULE-3 inconsistent snapshot chain + 1 RULE-4 flat SQL in drizzle-signaldock)
  - These are pre-existing and known — drizzle-signaldock uses a different migration runner
  - They appear as `::warning` annotations on PRs but do not fail the build

## Pre-Existing Issues Surfaced (Not from T1168)

1. `biome.json` schema version mismatch: `2.4.8` in file vs `2.4.11` installed locally.
   `pnpm biome ci .` exits 1 because of this. The CI workflow uses `biomejs/setup-biome@v2` with
   `version: '2.4.8'` which pins the correct version — so this does NOT affect the actual CI run,
   only local `biome ci` calls with the newer locally-installed biome. Orchestrator should track
   this as a separate cleanup task.

2. Pre-existing nexus test failures (6 failures in `nexus.test.ts`) from unstaged changes to
   `packages/cleo/src/dispatch/domains/nexus.ts` — unrelated to T1168.

## Files Changed

- `/mnt/projects/cleocode/scripts/lint-migrations.mjs` — `--fail-on` flag + GHA annotations
- `/mnt/projects/cleocode/.github/workflows/ci.yml` — `migration-lint` job
- `/mnt/projects/cleocode/.git/hooks/pre-commit` — migration linter gate section (not tracked in git)
