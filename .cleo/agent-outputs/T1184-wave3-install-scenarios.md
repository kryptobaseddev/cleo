# T1184: Wave 3 Install-Scenario Integration Matrix

**Task**: T-MSR-W3-9: Integration test — install scenarios (global, npx, workspace, init-in-empty-project)
**Status**: complete
**Commit**: e4e95acae76a84936283d1590af507d854339320
**Output file**: /mnt/projects/cleocode/scripts/wave3-install-scenarios.mjs

## Summary

Created and validated a standalone ESM Node script that empirically proves the
Wave 3 bundle-externalization (T1177-T1182) works across all testable install
layouts.

## Scenario Results (run 2026-04-22, Node v24.13.1, npm 11.8.0)

| ID | Scenario | Status | Key Finding |
|----|----------|--------|-------------|
| A  | Workspace install | PASS | --version=2026.4.108; init created tasks.db + brain.db (3.8s) |
| B  | Packed tarball install | PASS | 16 drizzle-tasks migrations bundled; init works (32s) |
| C  | npx-style resolution | SKIP | Requires published registry package |
| D  | Missing @cleocode/core — postinstall hook | PASS | exits 0, boxed warning printed (105ms) |

**Summary: 3/3 non-skipped scenarios passed, 1 skipped**

## Tarball Sizes

- `cleocode-cleo-2026.4.108.tgz` — packed during Scenario B
- `cleocode-core-2026.4.108.tgz` — packed during Scenario B (16 drizzle-tasks migrations bundled)

## Environmental Notes

- Scenario C (npx-style) cannot be automated without a published npm registry
  tarball. Manual steps are documented in the script source at `scripts/wave3-install-scenarios.mjs`.
- Scenario D reveals that `cleo --version` exits 1 when core is absent (the
  CLI imports core at load time, not just for --version). This is documented as
  expected behavior in the scenario detail. The postinstall hook is the right
  place to catch this — it always exits 0.

## Files Changed

- `scripts/wave3-install-scenarios.mjs` — new integration test script (742 lines)
- `package.json` — added `"test:install-scenarios"` root script

## Evidence Gates

- implemented: commit:e4e95acae;files:scripts/wave3-install-scenarios.mjs,package.json
- testsPassed: tool:pnpm-test (639 files, 10620 tests)
- qaPassed: tool:biome (1796 files, no errors)
