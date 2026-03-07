# T5586 — Agent C1 (wire-engine) Output Report

**Status**: COMPLETE
**File modified**: `src/dispatch/engines/release-engine.ts`
**TypeScript**: `npx tsc --noEmit` — 0 errors

---

## Changes Confirmed

### Change 1: New imports added (lines 32–50)

Three new import blocks added after the `guards.js` import:

```typescript
import {
  createPullRequest,
  isGhCliAvailable,
  buildPRBody,
  type PRResult,
} from '../../core/release/github-pr.js';

import {
  resolveChannelFromBranch,
  channelToDistTag,
} from '../../core/release/channel.js';

import {
  loadReleaseConfig,
  getPushMode,
  getGitFlowConfig,
} from '../../core/release/release-config.js';
```

All imports are used. No `_` prefix suppression. `getChannelConfig` was not imported because it was not needed — channel resolution uses `resolveChannelFromBranch` from `channel.ts` directly (consistent with what B4's gates do).

### Change 2: releaseShip() params extended

New optional fields added to the params object:

```typescript
params: {
  version: string;
  epicId: string;
  remote?: string;
  dryRun?: boolean;
  guided?: boolean;   // NEW
  channel?: string;   // NEW
}
```

`guided` defaults to `false`. `channel` is optional; if absent, channel is auto-resolved from the current Git branch via `resolveChannelFromBranch`.

### Change 3: releaseShip() is already async — no change needed

The function was already `async` before this change. Return type remains `Promise<EngineResult>`.

### Change 4: Guided step logging — `logStep` helper

A local arrow function `logStep` is defined inside `releaseShip()`:

```typescript
const logStep = (n: number, total: number, label: string, done?: boolean, error?: string): void => {
  if (!guided) return;
  // emits [Step n/total] label... on start
  // emits   ✓ label on success
  // emits   ✗ label: error on failure
};
```

All 7 steps are wrapped with `logStep` calls (start, success, and failure variants).

Step labels used:
1. "Validate release gates"
2. "Check epic completeness"
3. "Check task double-listing"
4. "Generate CHANGELOG"
5. "Commit release"
6. "Tag release"
7. "Push / create PR"

Step 7 (PR path) uses inline `console.log` directly (not `logStep`) because the PR result needs richer multi-line output with URLs and next-step guidance.

### Change 5: Channel resolution

After gates pass, channel is resolved from the current Git branch:

```typescript
let resolvedChannel: string = channel ?? 'latest';
let currentBranchForPR = 'HEAD';
try {
  const branchName = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], ...).trim();
  currentBranchForPR = branchName;
  if (!channel) {
    const channelEnum = resolveChannelFromBranch(branchName);
    resolvedChannel = channelToDistTag(channelEnum);
  }
} catch { /* git unavailable — keep default */ }
```

If `params.channel` is supplied, it is used as-is (caller override). Otherwise branch-based resolution runs.

Gate metadata (`gatesResult.metadata`) is also consumed if present — `currentBranch` and `targetBranch` from B4's gate result are preferred over the locally-resolved values.

### Change 6: PR fallback in step 7

The push step now:
1. Calls `pushRelease(version, remote, projectRoot, { explicitPush: true, mode: pushMode })` to get the push result
2. If `pushResult.requiresPR === true` OR `requiresPRFromGates === true` (from B4's gate metadata):
   - Calls `buildPRBody(...)` to pre-compute a body string
   - Calls `createPullRequest(...)` with base/head/title/labels/version/epicId/projectRoot
   - Emits guided output with PR URL and next-step hint
3. Otherwise: falls through to direct `git push origin --follow-tags`

### Change 7: `buildPRBody` approach

**Imported from `github-pr.ts`** — it was already exported there. No local copy was needed.

Note: `createPullRequest` internally calls `buildPRBody(opts)` again. The `body` field passed to `PRCreateOptions` is used by `formatManualPRInstructions` (the manual fallback path), so pre-computing and passing it is correct and harmless.

### Change 8: Dry-run enhancement

Dry-run now includes channel and PR information:

```typescript
{
  version, epicId, dryRun: true,
  channel: resolvedChannel,
  pushMode,
  wouldDo: [
    'write CHANGELOG...',
    'git add CHANGELOG.md',
    'git commit ...',
    'git tag ...',
    // if PR required:
    'gh pr create --base main --head feature/foo --title "release: ship vX.Y.Z"'
    // OR if direct:
    'git push origin --follow-tags',
    'markReleasePushed(...)',
  ],
  wouldCreatePR: boolean,
  prTitle?: string,
  prTargetBranch?: string,
}
```

### Change 9: channel stored in success response

`releaseShip` now includes `channel: resolvedChannel` in the success `data` object, alongside `pr: { mode, prUrl, prNumber, instructions }` when a PR was created.

### Change 10: `markReleasePushed` — no change

`markReleasePushed(version, pushedAt, projectRoot, { commitSha, gitTag })` signature does NOT accept a `channel` field. The existing 4-arg call was preserved unchanged. Channel is returned in the engine response data instead.

---

## TypeScript Status

`npx tsc --noEmit` — **0 errors**.

---

## For Agent C2 (CLI wiring)

### releaseShip() params

The exact param object type for `releaseShip()`:

```typescript
params: {
  version: string;
  epicId: string;
  remote?: string;
  dryRun?: boolean;
  guided?: boolean;   // --guided flag → params.guided = true
  channel?: string;   // --channel <value> flag → params.channel = value
}
```

### Exact param names for C2 to wire

| CLI flag | param field |
|---|---|
| `--guided` | `params.guided` (boolean) |
| `--channel <tag>` | `params.channel` (string, optional) |

### release.channel.show — engine function needed?

`release.channel.show` does NOT need a new engine function in `release-engine.ts`. It can be handled inline in `pipeline.ts` (the domain handler) by:

1. Reading the current Git branch via `execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], ...)`
2. Calling `resolveChannelFromBranch(branch)` from `../../core/release/channel.js`
3. Calling `channelToDistTag(channel)` for the dist-tag string
4. Optionally calling `describeChannel(channel)` for a human-readable description

All three functions are exported from `src/core/release/channel.ts` with no engine wrapper needed. If a wrapper is preferred for consistency, add a `releaseChannelShow(projectRoot?: string): Promise<EngineResult>` to `release-engine.ts` — but it is not required.

---

## PR path summary

```
pushRelease() returns requiresPR: true
        OR
gatesResult.metadata.requiresPR === true
        ↓
buildPRBody() → prBody string
        ↓
createPullRequest({ base, head, title, body: prBody, labels: ['release', resolvedChannel], ... })
        ↓
PRResult.mode === 'created'  → log PR URL + next steps
PRResult.mode === 'skipped'  → log existing PR URL
PRResult.mode === 'manual'   → log manual instructions
```
