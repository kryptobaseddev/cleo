# Wave 1A: ESM-Fixer Summary

**Date**: 2026-03-19
**Status**: complete

---

## Summary

Eliminated all bare `require('node:fs')` calls from two files by promoting the required symbols into the existing top-level ESM `import` statement and deleting the inline destructuring lines.

---

## Changes

### File 1: `src/core/migration/logger.ts`

**Line 11 — top-level import expanded:**
- Before: `import { existsSync, mkdirSync, statSync, appendFileSync } from 'node:fs';`
- After: `import { existsSync, mkdirSync, statSync, appendFileSync, readdirSync, unlinkSync, readFileSync, accessSync, constants } from 'node:fs';`

**Four inline require() lines deleted (no replacement):**
1. `const { readdirSync, unlinkSync } = require('node:fs');` — inside `cleanupOldLogs()` (~line 302)
2. `const { readFileSync } = require('node:fs');` — inside `readMigrationLog()` (~line 421)
3. `const { accessSync, constants } = require('node:fs');` — inside `logFileExists()` (~line 435)
4. `const { readdirSync, statSync } = require('node:fs');` — inside `getLatestMigrationLog()` (~line 448)

### File 2: `src/core/migration/__tests__/logger.test.ts`

**Line 5 — top-level import expanded:**
- Before: `import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';`
- After: `import { existsSync,mkdirSync,readFileSync,writeFileSync,rmdirSync } from 'node:fs';`

**Two inline require() lines deleted (both were `afterEach` cleanup blocks):**
1. `const { rmdirSync } = require('node:fs');` — first `afterEach` (~line 33)
2. `const { rmdirSync } = require('node:fs');` — second `afterEach` in `helper functions` describe block (~line 278)

---

## Verification

`grep require('node:fs')` across both files returns zero matches — confirmed clean.

---

## Surprises

None. All four require calls in `logger.ts` matched the task description exactly. The test file had two identical inline require lines (both in `afterEach` blocks) rather than one, which were both removed by a `replace_all` edit.
