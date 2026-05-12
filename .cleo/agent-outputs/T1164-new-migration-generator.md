# T1164 — scripts/new-migration.mjs Implementation

**Task**: T-MSR-W2A-02: Author scripts/new-migration.mjs — generator wrapper
**Status**: COMPLETE
**Commits**:
- `8c7da1826` — feat(T1164): scripts/new-migration.mjs — drizzle-kit generator wrapper with post-processing
- `a7511130a` — style(biome): extend biome coverage to scripts/ and fix pre-existing lint issues

## Files Delivered

- `/mnt/projects/cleocode/scripts/new-migration.mjs` — main generator script (ESM, shebang)
- `/mnt/projects/cleocode/scripts/__tests__/new-migration.test.mjs` — 7 integration tests
- `/mnt/projects/cleocode/vitest.config.ts` — added `scripts/__tests__/*.test.mjs` include
- `/mnt/projects/cleocode/biome.json` — added `scripts/**/*.mjs` to includes

## Implementation Summary

The generator script wraps `node_modules/.bin/drizzle-kit generate` with:
1. Temp-DB baseline resolution (env var fallback to `/tmp/cleo-drizzle-baseline/<db>.db`)
2. Trailing `--> statement-breakpoint` post-processing (strip + normalize)
3. Task-ID-based folder renaming: `YYYYMMDDHHMMSS_<drizzle-auto-name>/` → `YYYYMMDDHHMMSS_<tNNNN>-<name>/`
4. Linter validation via `scripts/lint-migrations.mjs` — aborts on RULE-1 ERROR
5. `--commit` flag: auto-commits generated migration
6. `--apply` flag: runs migrateSanitized on fresh temp DB for inspection
7. `--help` flag: prints full usage help

## CLI Interface

```
node scripts/new-migration.mjs --db tasks --task T1234 --name add-column [--commit] [--apply]
pnpm db:new -- --db tasks --task T1234 --name add-column
```

## Tests

7 tests all pass (`pnpm vitest run scripts/__tests__/new-migration.test.mjs`):
- Test 1: End-to-end post-processing + linter PASS (correct folder shape, no trailing breakpoint, snapshot.json)
- Test 2: Synthetic trailing-breakpoint injection + strip assertion
- Test 3: No-op when no trailing breakpoint
- Test 4: `--help` prints usage and exits 0
- Test 5: Missing required args exits 1 with error message
- Test 6: Invalid `--db` exits 1
- Test 7: Invalid `--task` format exits 1

## Edge Cases Deferred

- **signaldock**: Flagged as needing W2A-04 (bare-SQL → Drizzle schema conversion) before the generator
  produces clean output. Script emits a warning when `--db signaldock` is used and proceeds; the linter
  will catch violations. W2A-04 owns the cleanup.
- **--apply mode**: Requires `pnpm build` to have run first (imports from `packages/core/dist/internal.js`).
  Gracefully degrades with an actionable error message if the dist is absent.

## Quality Gates

- `implemented`: commit a7511130a + files verified
- `testsPassed`: 7/7 new tests pass; pre-existing failures (code-engine timeout, nexus ops mismatch) are unrelated
- `qaPassed`: `pnpm biome ci .` passes (0 errors; 1 warning = broken .archive symlink pre-existing)
