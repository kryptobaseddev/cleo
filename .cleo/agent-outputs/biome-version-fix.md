---
@no-cleo-register
---

# Biome CI Version Pin Fix

## Summary

Fixed version drift between local biome (2.4.11) and CI biome (2.4.8) that was causing Release workflow failures.

## Changes Made

### Primary Fix
- File: `.github/workflows/ci.yml`
- Line 107: `version: '2.4.8'` → `version: '2.4.11'`
- Aligns CI pin with `package.json` devDependencies and `biome.json` schema reference

### Secondary Fixes (pre-existing biome violations exposed by version alignment)
- File: `scripts/verify-t1825.mjs` — sorted imports, `let` → `const`, added blank line after shebang, reformatted
- File: `scripts/verify-t1875.mjs` — sorted imports, reformatted

## Before/After Biome Versions
- Before: CI used `2.4.8`, local used `2.4.11`
- After: Both CI and local use `2.4.11`

## PR
- URL: https://github.com/kryptobaseddev/cleo/pull/116
- Branch: `fix/biome-ci-version-pin`
- Commits:
  - `86f9a5cf9` — ci(biome): bump CI pin 2.4.8 → 2.4.11
  - `b24181208` — includes fixed script files

## CI Status
- CI Run: https://github.com/kryptobaseddev/cleo/actions/runs/25569812273
- Lint & Format: PASS
- All major checks: PASS (unit test shards 1 have pre-existing failures unrelated to biome)

## Release Status
- Original failed run: https://github.com/kryptobaseddev/cleo/actions/runs/25568864491 (FAILED — old tag)
- Successful re-run: https://github.com/kryptobaseddev/cleo/actions/runs/25570500791 (SUCCESS)
- v2026.5.59 tag re-pointed from 3b37ef99e → d7ff50cc9 (includes biome fixes)
- Release published: https://github.com/kryptobaseddev/cleo/releases/tag/v2026.5.59

## Local Verification
- `pnpm biome ci .` exits 0 after fixes applied
- `grep "2.4.8" .github/workflows/*.yml` returns no output (all bumped)
- `grep "2.4.11" .github/workflows/ci.yml` returns match on line 107
