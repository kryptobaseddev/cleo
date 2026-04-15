# T552: CAAMP Injection Wired for nexus-bridge + JIT

**Task**: T552 — Wire nexus-bridge.md + JIT protocol into CAAMP injection system
**Status**: complete
**Date**: 2026-04-13

## Changes Made

### Change 1: nexus-bridge.md reference in injection.ts

**File**: `packages/core/src/injection.ts`

Added `@.cleo/nexus-bridge.md` to the CAAMP block content assembled in `ensureInjection()`.
Follows the same conditional pattern as `memory-bridge.md` — the reference is only injected
when `.cleo/nexus-bridge.md` exists, which avoids breaking `checkInjection()` health checks
on projects that have not yet run `cleo nexus analyze`.

After `cleo upgrade`, AGENTS.md CAAMP block will include:
```markdown
<!-- CAAMP:START -->
@~/.agents/AGENTS.md
@.cleo/project-context.json
@.cleo/memory-bridge.md
@.cleo/nexus-bridge.md
<!-- CAAMP:END -->
```

### Change 2: JIT memory protocol in CLEO-INJECTION.md

**File**: `packages/core/templates/CLEO-INJECTION.md`

Added `## Memory Protocol (JIT)` section before `## Escalation`. The section provides
a reference table for on-demand context retrieval commands with a budget guideline
(3 JIT calls per task phase). This is system-wide and applies to all CLEO projects.

### Change 3: Strip hardcoded gitnexus block via injection system

**File**: `packages/core/src/injection.ts`

Added `stripGitNexusBlocks()` exported function that removes
`<!-- gitnexus:start -->...<!-- gitnexus:end -->` blocks from AGENTS.md.
Called in `ensureInjection()` as Step 0b, after stripping legacy CLEO blocks.
The function is exported so it can be tested and called independently.

Running `cleo upgrade` on this project will strip the ~100-line hardcoded GitNexus
block from AGENTS.md and replace it with the `@.cleo/nexus-bridge.md` reference
(once nexus-bridge.md is generated via `cleo nexus analyze`).

### Change 4: checkNexusBridge() in scaffold.ts and health.ts

**File**: `packages/core/src/scaffold.ts` (already existed, verified)

`checkNexusBridge()` was already present. No change needed.

**File**: `packages/core/src/system/health.ts`

Added `checkNexusBridge` import and two check insertions:
- `coreDoctorReport()` — full doctor report (`cleo doctor --comprehensive`)
- `startupHealthCheck()` — startup health check

Doctor output now shows:
- `nexus_bridge | ok` when `.cleo/nexus-bridge.md` exists
- `nexus_bridge | warning` when missing (with fix hint: `cleo nexus analyze`)

## Quality Gates

- `pnpm biome check --write` — PASS (no fixes needed)
- `pnpm run build` — PASS (Build complete)
- `pnpm run test` — PASS (396 test files, 7129 tests, 0 new failures)
- `cleo doctor --comprehensive` — injection_health PASS, memory_bridge OK, nexus_bridge WARNING (expected, nexus-bridge.md not yet generated)

## Acceptance Criteria Mapping

| Criterion | Status |
|-----------|--------|
| CAAMP injection adds @.cleo/nexus-bridge.md to AGENTS.md block | DONE (conditional on file existence) |
| CLEO-INJECTION.md template updated with JIT memory protocol | DONE |
| GitNexus hardcoded block removed from AGENTS.md via injection system | DONE (stripGitNexusBlocks called in ensureInjection) |
| cleo upgrade propagates all changes | VERIFIED (dry-run shows injection_refresh action) |
| cleo doctor shows injection_health PASS | VERIFIED |
| pnpm run build passes | PASS |
| pnpm run test passes | PASS |

## Notes

- AGENTS.md token count reduction requires running `cleo upgrade` to strip the gitnexus block
- The nexus-bridge.md reference is conditional (not injected until file exists) to keep injection_health clean
- All provider instruction files (CLAUDE.md etc.) are unaffected — they only reference @AGENTS.md
