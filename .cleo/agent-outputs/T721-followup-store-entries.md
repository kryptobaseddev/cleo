# T725 — T721-FOLLOWUP: store/* entry points fix

**Date**: 2026-04-15
**Task**: T725
**Status**: complete
**Release**: v2026.4.62

## Summary

Root cause for v2026.4.61 CI regression was confirmed: `build.mjs coreBuildOptions` had only 3 entry points (index, conduit, internal). The 3 store subpath entry points (store/nexus-sqlite, store/nexus-schema, store/brain-sqlite) were present in the working tree but not in `HEAD` — they were pending in the working directory from prior session work but never committed.

## What Was Done

1. **Task created**: T725 — T721-FOLLOWUP (parent: T627, priority: critical, size: small)
2. **build.mjs verified**: The 3 store entry points were already in the working tree. `git diff` confirmed they were missing from HEAD.
3. **Local build verification**:
   - `rm -rf packages/core/dist && node build.mjs` — passed after fixing lafs rebuild order
   - `dist/store/brain-sqlite.js` (478K), `dist/store/nexus-schema.js` (49K), `dist/store/nexus-sqlite.js` (426K) all emitted
   - `npm pack --dry-run` confirmed all 3 files in tarball
4. **Version bumped** to 2026.4.62 via `node scripts/version-all.mjs --set 2026.4.62` (14 package.json files)
5. **CHANGELOG updated** with `## [2026.4.62] (2026-04-15)` entry (bracket format required by CI gate)
6. **Commits**:
   - `021c528e` — fix(release): v2026.4.62 — add store/* entry points to build.mjs (T721 followup)
   - `1669f939` — fix(core): add missing dream-cycle.ts (internal.ts referenced untracked file)
   - `2225b2af` — fix(release): fix CHANGELOG format for v2026.4.62 (bracket format required by CI gate)
7. **Tag pushed**: `v2026.4.62` triggered Release workflow
8. **npm verified**:
   - `@cleocode/core@2026.4.62` published
   - `dist/store/brain-sqlite.js` in tarball ✓
   - `dist/store/nexus-sqlite.js` in tarball ✓

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| build.mjs includes store/nexus-sqlite, store/nexus-schema, store/brain-sqlite entries | PASS |
| Local clean build emits all 3 store/*.js files in dist/store/ | PASS (478K, 49K, 426K) |
| npm @cleocode/core@2026.4.62 published with verified .js files | PASS |
| GitHub Release v2026.4.62 auto-created | PASS |
| GitHub Actions Release workflow GREEN | PARTIAL — workflow shows failure due to 403 re-check logic bug (packages were already published by concurrent workflow_dispatch), but all packages ARE on npm |

## Notes

The CI workflow failure at "Publish packages to npm" is a pre-existing issue with the 403 re-check logic: when a package is already published, the re-check for some packages returns SKIP (lafs, contracts) while others return FAIL (core, caamp). This is not related to T721/T725 — the packages are correctly published.

Additional finding: `packages/core/src/internal.ts` referenced `./memory/dream-cycle.js` but `dream-cycle.ts` was untracked. This caused the first CI attempt to fail at the Build step. Fixed by committing `dream-cycle.ts` and its test.
