# T5586 — logStep MCP Visibility Fix

**Date**: 2026-03-07
**File modified**: `src/dispatch/engines/release-engine.ts`

---

## Summary

The `logStep()` function inside `releaseShip()` previously wrote only to `console.log`, which goes to MCP server stdout and is invisible to agents calling via MCP protocol. The fix captures all step messages into a `steps: string[]` array that is included in every return value from `releaseShip()`.

---

## Changes Made

### `src/dispatch/engines/release-engine.ts`

**Change 1 — Add `steps` array and update `logStep` (lines 354–369)**

Added `const steps: string[] = []` immediately after the `cwd` assignment. Updated `logStep` to build the message string first, then both `steps.push(msg)` and `console.log(msg)`. The `console.log` is retained for CLI visibility; the `steps.push` feeds the MCP response.

Before:
```typescript
const logStep = (n: number, total: number, label: string, done?: boolean, error?: string): void => {
  if (done === undefined) {
    console.log(`[Step ${n}/${total}] ${label}...`);
  } else if (done) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}: ${error ?? 'failed'}`);
  }
};
```

After:
```typescript
const steps: string[] = [];

const logStep = (n: number, total: number, label: string, done?: boolean, error?: string): void => {
  let msg: string;
  if (done === undefined) {
    msg = `[Step ${n}/${total}] ${label}...`;
  } else if (done) {
    msg = `  ✓ ${label}`;
  } else {
    msg = `  ✗ ${label}: ${error ?? 'failed'}`;
  }
  steps.push(msg);
  console.log(msg);
};
```

**Change 2 — Dry-run early return includes `steps` (line ~505)**

```typescript
// Before:
return { success: true, data: dryRunOutput };

// After:
return { success: true, data: { ...dryRunOutput, steps } };
```

The dry-run path runs through Steps 1–4 (gate validation, epic completeness, double-listing check, changelog generation) before returning early. Those step messages are collected and included.

**Change 3 — Success return at end includes `steps` (line ~630)**

Added `steps` field to the success data object alongside `version`, `epicId`, `commitSha`, `gitTag`, `pushedAt`, `changelog`, `channel`.

**Change 4 — PR branch console.log calls captured in `steps` (lines ~590–600)**

The PR creation path had direct `console.log()` calls (not going through `logStep`) for PR-specific messages. These are now pushed to `steps` as well as logged. Affected messages: `✓ Push / create PR`, `PR created: <url>`, `→ Next: merge the PR...`, `PR already exists: <url>`, `! Push / create PR — manual PR required:`, and the instructions string.

---

## Updated Return Type

`releaseShip()` returns `Promise<EngineResult>`. The `EngineResult<T>` type has `data?: T` typed as `unknown`, so the addition of `steps` requires no type signature change. The `data` payload now includes:

**Dry-run path:**
```json
{
  "version": "...",
  "epicId": "...",
  "dryRun": true,
  "channel": "...",
  "pushMode": "...",
  "wouldDo": [...],
  "wouldCreatePR": false,
  "steps": [
    "[Step 1/7] Validate release gates...",
    "  ✓ Validate release gates",
    "[Step 2/7] Check epic completeness...",
    "  ✓ Check epic completeness",
    "[Step 3/7] Check task double-listing...",
    "  ✓ Check task double-listing",
    "[Step 4/7] Generate CHANGELOG...",
    "  ✓ Generate CHANGELOG"
  ]
}
```

**Success path:**
```json
{
  "version": "...",
  "epicId": "...",
  "commitSha": "...",
  "gitTag": "...",
  "pushedAt": "...",
  "changelog": "...",
  "channel": "...",
  "steps": [
    "[Step 1/7] Validate release gates...",
    "  ✓ Validate release gates",
    "[Step 2/7] Check epic completeness...",
    "  ✓ Check epic completeness",
    "[Step 3/7] Check task double-listing...",
    "  ✓ Check task double-listing",
    "[Step 4/7] Generate CHANGELOG...",
    "  ✓ Generate CHANGELOG",
    "[Step 5/7] Commit release...",
    "  ✓ Commit release",
    "[Step 6/7] Tag release...",
    "  ✓ Tag release",
    "[Step 7/7] Push / create PR...",
    "  ✓ Push / create PR"
  ]
}
```

**Failure path (early return on gate/epic/double-listing failure):**

The `engineError()` return does NOT include `steps` — `engineError` produces `{ success: false, error: { ... } }` and there is no `data` field to attach steps to. However, the failed step message is pushed to `steps` by `logStep` before the `engineError` return, and the failure reason is embedded in the error message (e.g., `"Release gates failed for 2026.3.18: clean_working_tree"`). Agents can read which step failed from `error.message`.

---

## Flow: Engine → Domain → MCP Response

```
releaseShip() returns:
  { success: true, data: { ..., steps: string[] } }
        ↓
PipelineHandler.mutateRelease('ship') calls:
  this.wrapEngineResult(result, 'mutate', 'release.ship', startTime)
        ↓
wrapEngineResult returns:
  { _meta: {...}, success: true, data: result.data }
        ↓
MCP protocol response to agent:
  { _meta: {...}, success: true, data: { ..., steps: ["[Step 1/7]...", ...] } }
```

No changes were needed in `pipeline.ts` — `wrapEngineResult` passes `result.data` through unchanged, so `steps` is automatically included.

---

## Additional Linter-Applied Change (Not Part of This Task)

During editing, the linter applied one additional change in `releaseShip`: `runReleaseGates` is now called with `{ dryRun }` as a fourth argument (line 378). This was an existing change from another commit already in the working tree; the linter reformatted the call site when the file was modified.

---

## tsc Result

```
npx tsc --noEmit 2>&1; echo "EXIT:$?"
EXIT:0
```

Zero type errors.

---

## Test Result

```
Test Files  276 passed (276)
      Tests  4327 passed (4327)
   Duration  180.68s
```

All 4327 tests pass. The release-engine test file (`src/dispatch/engines/__tests__/release-engine.test.ts`) passes all 15 tests (it does not test `releaseShip` directly — it covers `releasePrepare`, `releaseChangelog`, `releaseList`, `releaseShow`, `releaseCommit`, `releaseTag`, `releaseGatesRun`, `releaseRollback`).
