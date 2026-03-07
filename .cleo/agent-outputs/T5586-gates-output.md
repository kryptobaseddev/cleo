# T5586 Gates Agent Output (B4 — impl-gates)

**Status**: COMPLETE
**File modified**: `src/core/release/release-manifest.ts`
**TypeScript**: `npx tsc --noEmit` — 0 errors

---

## Changes Made

### Change 1: New imports (lines 21–26)

Added after the existing `changelog-writer.js` import:

```typescript
import { detectBranchProtection } from './github-pr.js';
import type { BranchProtectionResult } from './github-pr.js';
import { resolveChannelFromBranch } from './channel.js';
import type { ReleaseChannel } from './channel.js';
import { loadReleaseConfig, getGitFlowConfig, getChannelConfig, getPushMode } from './release-config.js';
import type { PushMode } from './release-config.js';
```

**Discovery**: B2 had already created `channel.ts` and `github-pr.ts`, and had already added `GitFlowConfig`, `ChannelConfig`, `PushMode`, `getGitFlowConfig`, `getChannelConfig`, `getPushMode` to `release-config.ts`. The task description referenced those exact function names (matching B2's implementation).

### Change 2: New `ReleaseGateMetadata` interface (lines ~686–699)

Defined in `release-manifest.ts` (not in `release-config.ts` as spec suggested — it was absent from that file, so defined here and exported):

```typescript
export interface ReleaseGateMetadata {
  channel: ReleaseChannel;
  requiresPR: boolean;
  targetBranch: string;
  currentBranch: string;
}
```

### Change 3: `PushPolicy` interface extended (lines ~701–711)

Added two new optional fields to the existing interface:
- `mode?: PushMode` — push mode override
- `prBase?: string` — override PR target branch

### Change 4: `runReleaseGates()` return type extended (line ~466)

Added `metadata: ReleaseGateMetadata` field to the inline return type. The function signature **was already async** and remains async — no caller changes needed within this file.

### Change 5: `branch_target` gate replaced (lines ~554–591)

Replaced the hardcoded `isPreRelease ? 'develop' : 'main'` logic with GitFlow-aware version:
- Calls `loadReleaseConfig(cwd)`, `getGitFlowConfig(releaseConfig)`, `getChannelConfig(releaseConfig)`
- `expectedBranch` comes from `gitFlowCfg.branches.develop` or `gitFlowCfg.branches.main`
- Feature/hotfix/release branches are allowed with pre-release versions
- Detached HEAD (`currentBranch === 'HEAD'`) and git-unavailable (`!currentBranch`) still pass
- Gate message now includes `(channel: ${detectedChannel})`

### Change 6: New `branch_protection` gate added (lines ~593–619)

Added immediately after `branch_target`, before `allPassed` calculation:
- Gate is **always 'passed'** — purely informational
- `pushMode === 'pr'` → `requiresPR = true` directly
- `pushMode === 'auto'` → calls `detectBranchProtection(expectedBranch, 'origin', projectRoot)` with try/catch (best-effort, never blocks)
- `pushMode === 'direct'` → `requiresPR = false`

### Change 7: `metadata` object built and returned (lines ~621–637)

```typescript
const metadata: ReleaseGateMetadata = {
  channel: detectedChannel,
  requiresPR,
  targetBranch: expectedBranch,
  currentBranch,
};
```
Added to the return statement alongside existing fields.

### Change 8: `pushRelease()` extended (lines ~738–794)

**New `opts` fields**:
```typescript
opts?: {
  explicitPush?: boolean;
  mode?: PushMode;   // NEW
  prBase?: string;   // NEW
  epicId?: string;   // NEW
  guided?: boolean;  // NEW
}
```

**New return type field**: `requiresPR?: boolean`

**New PR-mode logic** inserted at the top of the function body (before the existing `enabled=false` check):
1. Resolves `effectivePushMode` from `opts.mode` → `pushPolicy.mode` → `configPushMode` (priority chain)
2. For `'pr'` or `'auto'` modes: calls `detectBranchProtection` to check the target branch
3. If protected (or `mode === 'pr'`): returns early with `{ status: 'requires_pr', requiresPR: true }` — does NOT throw, lets caller handle PR creation
4. For `'direct'` mode or unprotected branches: falls through to the existing push logic unchanged

---

## Callers Updated

`runReleaseGates()` was **already async** before this change. No callers within `release-manifest.ts` call it — callers are in `release-engine.ts`. The return type now includes `metadata`, which callers can read for channel/requiresPR information. Existing callers that only destructure `{ allPassed, gates, passedCount, failedCount }` are unaffected by the new field addition.

---

## Gate Result Type Structure

The return type of `runReleaseGates()` is:

```typescript
Promise<{
  version: string;
  allPassed: boolean;
  gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }>;
  passedCount: number;
  failedCount: number;
  metadata: ReleaseGateMetadata;  // NEW
}>
```

There is no separate named `ReleaseGateResult` type — the return type remains inline. `ReleaseGateMetadata` is a named exported interface defined in this file.

---

## `gateMetadata` Accumulation

`gateMetadata` fields are captured as local variables during gate evaluation:
- `detectedChannel` — from `resolveChannelFromBranch()` after the git branch is read
- `requiresPR` — from push mode logic in the `branch_protection` gate block
- `expectedBranch` — computed from `gitFlowCfg.branches.{develop|main}`
- `currentBranch` — from `execFileSync('git rev-parse --abbrev-ref HEAD')`

All four are assembled into `ReleaseGateMetadata` just before the return statement.

---

## Push Mode Logic in `pushRelease()`

Priority chain for `effectivePushMode`:
1. `opts?.mode` (caller-supplied)
2. `pushPolicy?.mode` (from `.cleo/config.json` release.push)
3. `configPushMode` from `getPushMode(loadReleaseConfig(cwd))`

When `'pr'` or `'auto'` and branch is determined to be protected → return `{ status: 'requires_pr', requiresPR: true }`. Caller (engine layer) is responsible for creating the PR via `createPullRequest()` from `github-pr.ts`.

---

## Differences from Task Description vs Spec Section 8

| Item | Task description | Actual implementation | Reason |
|------|-----------------|----------------------|--------|
| Import helpers | `getGitFlowConfig`, `getChannelConfig`, `getPushMode` as separate imports | Used same function names (B2 already implemented them in `release-config.ts`) | B2's file matched the task description exactly |
| Gate metadata accumulation | `gateMetadata.channel = ...` (object mutation) | Local variables assembled at end | Cleaner, avoids partial object construction |
| `branch_protection` remote | Read from `projectConfig.release.push.remote` | Hardcoded `'origin'` | `ReleaseConfig` has no `.release` property; remote for detection defaults to 'origin' (pushPolicy remote is checked separately in pushRelease) |
| `pushRelease` PR return | `return { success: false, requiresPR: true, message: ... }` | `return { version, status: 'requires_pr', remote, pushedAt, requiresPR: true }` | Matches existing return shape; `success` field not part of this function's return type |

---

## Functions NOT Modified

None — all required modifications were completed. No functions were left partially modified.
