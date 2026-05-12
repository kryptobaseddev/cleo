# ALPHA-5 — T1565 cleo→contracts layering fix (cli-other / backfill scope)

**Agent**: Alpha-5 of Team Alpha
**Task**: T1565 (T-LAYERING-FIX)
**Date**: 2026-04-29
**Scope**: `packages/cleo/src/` excluding `cli/commands/` (Alpha-3), `dispatch/` (Alpha-4),
`__tests__/` (Alpha-1), and `cli/__tests__/nexus-projects-clean.test.ts`.

## Summary

| Metric | Value |
|---|---|
| Files touched | **7** |
| Imports rewritten | **8** (one file had 2 imports) |
| Pre-grep count (in scope) | 7 files |
| Post-grep count (in scope) | **0** |
| Full-repo prod cleo→contracts (excl tests) before | 15 |
| Full-repo prod cleo→contracts (excl tests) after | **7** (all in `dispatch/` — Alpha-4 owns) |
| `tsc --noEmit` (cleo tsconfig) | **PASS** (exit 0, no output) |
| `biome check` (touched files) | **PASS** (clean, no errors) |

## Files touched

| # | File | Imports rewritten |
|---|---|---|
| 1 | `packages/cleo/src/backfill/audit-columns.ts` | 1 (`type Session, Task`) |
| 2 | `packages/cleo/src/cli/lib/registry-args.ts` | 2 (`type CittyArgDef, ParamDef`; `paramsToCittyArgs` re-export) |
| 3 | `packages/cleo/src/cli/renderers/tasks.ts` | 1 (`type Task`) |
| 4 | `packages/cleo/src/cli/renderers/colors.ts` | 1 (multi-line value+type group) |
| 5 | `packages/cleo/src/cli/renderers/error.ts` | 1 (`getExitCodeName`) + minimal merge fix (see below) |
| 6 | `packages/cleo/src/cli/renderers/lafs-validator.ts` | 1 (`ExitCode`) |
| 7 | `packages/cleo/src/cli/renderers/system.ts` | 1 (`type Task`) |

## Deviation from "don't merge imports" rule

**File**: `packages/cleo/src/cli/renderers/error.ts`

After the literal swap, the file had three `from '@cleocode/core'` imports:

```ts
import { getExitCodeName } from '@cleocode/core';   // newly redirected
import type { CleoError } from '@cleocode/core';    // pre-existing
import { getErrorDefinition } from '@cleocode/core'; // pre-existing
```

Biome's `noDuplicateImportSources` rule failed the `pnpm biome check` gate. Per the
"Workflow step 5 — pnpm biome check ... clean" requirement, I applied the minimal
merge biome demanded:

```ts
import type { CleoError } from '@cleocode/core';
import { getErrorDefinition, getExitCodeName } from '@cleocode/core';
```

Net behavior unchanged. No reformatting outside the import group. This was the
narrowest possible change to satisfy the gate. **Flagging for synth-time awareness**.
All other 6 files required no merging — biome was clean on them.

## Files skipped

None. All in-scope files were rewritten.

## Verification commands run

```bash
# Pre-grep (scope) — 7 files
grep -rlE "from '@cleocode/contracts'" packages/cleo/src/ \
  | grep -vE "(cli/commands/|dispatch/|__tests__/|cli/__tests__/)"

# Post-grep (scope) — 0 files (empty output)

# tsc
pnpm tsc --noEmit -p packages/cleo/tsconfig.json   # exit 0, no output

# biome
pnpm biome check <7 touched files>                  # "Checked 7 files. No fixes applied." clean
```

## Remaining cleo prod code that imports `@cleocode/contracts` (NOT my scope)

7 imports across 6 files, all in `packages/cleo/src/dispatch/` — owned by Alpha-4:

- `dispatch/domains/pipeline.ts` (1)
- `dispatch/domains/playbook.ts` (1)
- `dispatch/engines/task-engine.ts` (2: import + re-export)
- `dispatch/engines/session-engine.ts` (1)
- `dispatch/lib/engine.ts` (1 re-export)
- `dispatch/lib/gateway-meta.ts` (1)

## Status

**COMPLETE**. Scope clean. Quality gates green. Ready for synth.
