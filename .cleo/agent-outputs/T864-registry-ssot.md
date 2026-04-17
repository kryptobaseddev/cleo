# T864 — Operations Registry as Single Source of Truth

**Status**: complete
**Date**: 2026-04-17

## ParamDef Contract Location

`packages/contracts/src/operations/params.ts`

Exports:
- `ParamType` — `'string' | 'number' | 'boolean' | 'array'`
- `ParamCliDef` — CLI-specific decoration (positional, short, flag, variadic)
- `ParamDef` — fully-described parameter definition (SSoT)
- `OperationParams` — `ParamDef[]` alias
- `CittyArgDef` — citty arg shape (helper type)
- `paramsToCittyArgs(params: OperationParams): Record<string, CittyArgDef>` — converter

Re-exported from `packages/contracts/src/operations/index.ts` (under `ops.*`) and at top level from `packages/contracts/src/index.ts`.

## Helper Signature + File Path

`packages/cleo/src/cli/lib/registry-args.ts`

```typescript
export function getOperationParams(
  gateway: Gateway,
  domain: string,
  operation: string,
): ParamDef[]

export { paramsToCittyArgs } from '@cleocode/contracts';
```

Usage in command files:
```typescript
import { getOperationParams, paramsToCittyArgs } from '../lib/registry-args.js';

args: paramsToCittyArgs(getOperationParams('query', 'tasks', 'show')),
```

## 3 Commands Refactored

| Command | File | Operation | Pattern |
|---------|------|-----------|---------|
| `cleo show` | `packages/cleo/src/cli/commands/show.ts` | `tasks.show` | positional required arg |
| `cleo list` | `packages/cleo/src/cli/commands/list.ts` | `tasks.list` | multiple optional flags (pre-existing params[]) |
| `cleo check schema` | `packages/cleo/src/cli/commands/check.ts` | `check.schema` | multi-sub parent command, positional arg |

Registry params[] backfilled for:
- `tasks.show` — taskId (positional, required), history (boolean), ivtr-history (boolean)
- `check.schema` — type (positional, required) + `requiredParams: ['type']` sync fix

## types.ts Update

`packages/cleo/src/dispatch/types.ts` now re-exports `ParamDef`, `ParamCliDef`, `ParamType`, `OperationParams` from `@cleocode/contracts` instead of redefining them. All existing import sites within `packages/cleo` continue to work unchanged.

Verification: `grep -n "ParamDef" packages/cleo/src/dispatch/types.ts` shows RE-EXPORT (line 39), not redefinition.

## parity.test.ts Fix

`packages/cleo/src/dispatch/__tests__/parity.test.ts`:
- Updated `getOperationSchema for op with no params` test to use `tasks.find` (still no params[]) instead of `tasks.show` (now has params[])
- Added new test `getOperationSchema for tasks.show returns derived schema (T864 migration)`

## Follow-up Task

**T868** — "Backfill remaining 183 operations registry params[] to 100% coverage" (parented to T864)

Phase 5 scope: all operations that still have no `params[]` need to be backfilled with full param descriptors, `requiredParams[]` kept in sync, and parity test count updated. ~183 operations remaining.

## Gate Results

### biome check
```
pnpm biome check --write packages/contracts/src/operations/ packages/cleo/src/dispatch/ packages/cleo/src/cli/lib/ packages/cleo/src/cli/commands/
→ Checked 18 files. Fixed formatting. 0 errors.
```

### contracts build
```
pnpm --filter @cleocode/contracts run build → EXIT 0
→ tsc -b --force clean, 6 schemas emitted
```

### TypeScript (files touched)
```
pnpm --filter @cleocode/cleo exec tsc --noEmit | grep "types.ts|registry-args|show.ts|list.ts|check.ts|params.ts"
→ 0 errors in any modified file
```

### Tests
```
pnpm run test → 2 failed (pre-existing) | 8542 passed | 10 skipped
```

Pre-existing failures (not caused by this task):
- `registry has the expected operation count` — pre-existing: another agent added `pipeline.release.changelog.since` (working tree M)
- `key commands are wired in subCommands` — pre-existing: startup-migration.test.ts was M in initial git status

### Smoke tests
```
cleo show --help   → renders taskId positional + --history + --ivtr-history
cleo list --help   → renders --status, --priority, --type, --parent, --phase, --label, --children, --limit, --offset
cleo check schema --help  → renders TYPE positional argument
```
