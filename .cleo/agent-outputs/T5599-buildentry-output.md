# T5599 buildEntry() Fix — Agent Output

**Date**: 2026-03-07
**Agent**: Claude Sonnet 4.6
**Task**: T5603 (fix for T5599 remaining issue)
**Commit**: b576bc3f

---

## Fix Applied

**File**: `src/core/release/release-manifest.ts`

**Function**: `buildEntry()` at line 241

**Change**: Added newline sanitization before the "meaningfully different" check and truncation.

Exact lines changed (3 lines inserted, 1 line replaced):

```typescript
// Before:
const desc = task.description?.trim();

// After:
// Strip newlines and collapse whitespace in description
const safeDesc = task.description?.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
const desc = safeDesc;
```

The `safeDesc` variable replaces `\r\n` and `\n` with spaces, then collapses any resulting
double-spaces, and trims the result. This value is then used for the "meaningfully different"
check and the 150-char truncation, so the rendered changelog entry stays on a single line.

**Reproduces**: T5584 bug where the description "Reduce MCP response sizes...\n- admin help: ..."
caused the `- admin help:` continuation to appear as a separate top-level markdown list item.

---

## dist/ Status

`dist/` is gitignored. The line `dist/` appears in `.gitignore`, and `git ls-files
--error-unmatch dist/cli/index.js` returned an error confirming it is not tracked.

dist/ was NOT staged or committed. Only source was committed.

The dist/ was rebuilt locally as part of this run (see Build Result below), so the local
`dist/cli/index.js` is current.

---

## Build Result

```
Build complete.
```

`npm run build` succeeded without errors. Output: `dist/` recompiled from the updated source.

---

## tsc Result

`npx tsc --noEmit` produced zero output — 0 errors, 0 warnings.

---

## Test Result

```
Test Files  276 passed (276)
      Tests  4327 passed (4327)
   Duration  133.65s
```

Zero failures.

---

## Commit

```
b576bc3f fix(changelog): strip newlines from description in buildEntry() (T5603)
```

Staged: `src/core/release/release-manifest.ts` only.
dist/ not staged (gitignored).
