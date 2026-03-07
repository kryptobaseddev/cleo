# T5586 — Agent C2 (wire-cli-domain) Output Report

**Status**: COMPLETE
**Files modified**:
1. `src/cli/commands/release.ts`
2. `src/dispatch/domains/pipeline.ts`
**TypeScript**: `npx tsc --noEmit` — 0 errors

---

## Changes to src/cli/commands/release.ts

### Change A: --guided and --channel flags added to `release ship`

Two new `.option()` calls added to the `release ship` subcommand definition:

```typescript
.option('--guided', 'Show step-by-step guided output during release')
.option('--channel <channel>', 'Override release channel (latest|beta|alpha)')
```

Both are passed through to the params object in the `.action()` handler:

```typescript
guided: opts['guided'] ?? false,
channel: opts['channel'],
```

The JSDoc comment block above the command was also updated to document the two new flags.

### Change B: release list output — channel column

The `release list` command delegates entirely to `dispatchFromCli` without any local formatting code in `release.ts`. Output formatting is handled downstream in the display layer. No change was needed or possible here; noted in report for Wave 4 verifier.

### Change C: release show output — channel field

Same as Change B — `release show` delegates to `dispatchFromCli` with no local formatting. If `releaseShow()` returns channel metadata in its data object, it will be surfaced automatically. No change needed in `release.ts`.

---

## Changes to src/dispatch/domains/pipeline.ts

### New imports added (top of file, after existing release-engine import)

```typescript
import { execFileSync } from 'node:child_process';

import {
  resolveChannelFromBranch,
  channelToDistTag,
  describeChannel,
} from '../../core/release/channel.js';
```

All three channel functions are used in the `release.channel.show` case. `execFileSync` is used for the git branch resolution. No unused imports.

### Change A: guided and channel threaded through release.ship

In `mutateRelease`, the `release.ship` case now extracts and forwards both new params:

```typescript
const guided = params?.guided as boolean | undefined;
const channel = params?.channel as string | undefined;
const result = await releaseShip(
  { version, epicId, remote, dryRun, guided, channel },
  this.projectRoot,
);
```

### Change B: release.channel.show query operation added

New `case 'channel.show':` block added to `queryRelease()`:

- Resolves current git branch via `execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.projectRoot })`
- Falls back to `'unknown'` if git is unavailable (try/catch with empty catch)
- Calls `resolveChannelFromBranch(currentBranch)` → `ReleaseChannel` enum value
- Calls `channelToDistTag(resolvedChannel)` → dist-tag string
- Calls `describeChannel(resolvedChannel)` → human-readable description
- Returns `{ branch, channel, distTag, description }` in the data object

The `cwd: this.projectRoot` is passed to `execFileSync` so git resolves from the correct repo root.

### Change C: getSupportedOperations registry updated

`release.channel.show` added to the `query` array in `getSupportedOperations()`:

```typescript
'release.list', 'release.show', 'release.channel.show',
```

---

## Operation classification

| Operation | Gateway | Rationale |
|---|---|---|
| `release.channel.show` | query | Read-only: reads git HEAD branch and resolves channel. No writes. |

---

## Param names confirmed

| CLI flag | params field | Type |
|---|---|---|
| `--guided` | `params.guided` | `boolean` (defaults to `false` at CLI layer) |
| `--channel <tag>` | `params.channel` | `string \| undefined` |

---

## TypeScript status

`npx tsc --noEmit` — **0 errors**

---

## Differences from plan / adaptations

1. **Dynamic vs static imports**: The plan showed dynamic `await import(...)` inside the case handler. The actual pipeline.ts file uses static imports throughout (no dynamic imports anywhere in the file). Changed to static imports at the top of the file — consistent with existing patterns.

2. **release list / show channel display**: The plan said to add channel to `release list` and `release show` output if the data includes it. The CLI handlers for both commands are one-liners that call `dispatchFromCli` with no local formatting code. There is nothing to modify — output is handled by the dispatch/formatting layer, which will automatically include any `channel` field returned by the engine. No change needed in `release.ts`.

3. **No `release channel` CLI subcommand added**: The spec only calls for `release.channel.show` as a domain operation; no separate `release channel` CLI command was specified. Only the domain operation was added.

---

## Files / changes NOT completed

None. All required changes are implemented and tsc passes clean.
