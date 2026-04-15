# T511: Health System Consolidation — Output Summary

**Date**: 2026-04-11
**Task**: T511
**Status**: complete

---

## Changes Made

### 1. Storage Migration Preflight — Already Consolidated (no change needed)

Investigation confirmed that `checkStorageMigration()` in
`packages/core/src/system/storage-preflight.ts` is already the single source
of truth. Both `self-update.ts` and `upgrade.ts` import it from
`@cleocode/core/internal`. No duplication exists. A clarifying comment was
added to `health.ts` to document this for future maintainers.

### 2. brain.db and memory-bridge Added to `coreDoctorReport()` (health.ts)

**File**: `packages/core/src/system/health.ts`

Added checks for `brain.db` and `memory-bridge.md` to `coreDoctorReport()`.
Previously these were only checked in `startupHealthCheck()` (as warnings) but
not in the comprehensive doctor report. Both now appear as named sections in
the doctor output:

- `brain_db` — delegates to `checkBrainDb(projectRoot)` from `scaffold.ts`.
  Reports `ok`, `warning` (empty), or `error` (not found).
- `memory_bridge` — delegates to `checkMemoryBridge(projectRoot)` from
  `scaffold.ts`. Reports `ok` or `warning` (not found, auto-generated).

Both functions were already imported (they were used in `startupHealthCheck()`),
so no new imports were required.

### 3. tree-sitter in Doctor — Already Covered (T507)

The dependency registry (`checkAllDependencies()` from `./dependencies.ts`)
already runs in `coreDoctorReport()` and includes tree-sitter. Verified by
inspecting `packages/core/src/system/dependencies.ts`. No change needed.

### 4. Adapter Health Added to `coreDoctorReport()` (health.ts)

**File**: `packages/core/src/system/health.ts`

Added a new private helper `checkAdapterHealth(projectRoot)` that:
- Imports `AdapterManager` dynamically (non-critical path)
- Calls `discover()` (idempotent) and `healthCheckAll()`
- Returns `DoctorCheck[]` entries: one per initialized adapter, or a single
  `ok` entry if no adapters are initialized (adapters are optional)
- Catches all errors gracefully — adapter system failure never blocks doctor

The `coreDoctorReport()` function now calls `checkAdapterHealth()` and includes
the results in section 5f.

### 5. Adapter Probe Added to `systemSmoke()` (system-engine.ts)

**File**: `packages/cleo/src/dispatch/engines/system-engine.ts`

Added `{ domain: 'adapter', operation: 'list' }` to `SMOKE_PROBES`. This
ensures the adapter dispatch pipeline is exercised during smoke tests
(`cleo doctor --full`), consistent with adapter health being included in the
doctor report.

### 6. Bootstrap vs Startup Health — Documented Separation (bootstrap.ts)

**File**: `packages/core/src/bootstrap.ts`

Added comprehensive TSDoc to `verifyBootstrapHealth()` documenting WHY it is
separate from `startupHealthCheck()` in `health.ts`:

- `verifyBootstrapHealth()`: checks global CAAMP injection-chain state (XDG
  template, AGENTS.md references). Only called post-install/self-update.
- `startupHealthCheck()`: checks project/global scaffold health (.cleo/,
  tasks.db, config.json). Called on every CLI startup.

These serve genuinely different purposes and lifecycles. Merging them would
either slow startup (CAAMP parsing on every run) or skip injection-chain checks
after install. The separation is intentional.

### 7. Duplicate Check Categories — Assessment

The same paths (`.cleo/`, `tasks.db`, `config.json`) are checked in multiple
systems:

- `getSystemHealth()`: lightweight checks used by `cleo health` (fast path)
- `coreDoctorReport()`: comprehensive checks used by `cleo doctor` (full path)
- `startupHealthCheck()`: startup-time checks (different result types)

These are NOT duplicates — they serve different consumers with different
performance and detail requirements. `getSystemHealth()` is the fast API health
check; `coreDoctorReport()` is the comprehensive diagnostic. Both exist
intentionally. No consolidation was performed here as it would break the
performance contract of `getSystemHealth()`.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/system/health.ts` | Added `checkAdapterHealth()` helper; added brain.db, memory-bridge, adapter sections to `coreDoctorReport()`; added storage-preflight consolidation comment |
| `packages/core/src/bootstrap.ts` | Added TSDoc to `verifyBootstrapHealth()` documenting separation from `startupHealthCheck()` |
| `packages/cleo/src/dispatch/engines/system-engine.ts` | Added adapter probe to `SMOKE_PROBES` |

---

## Quality Gates

- `pnpm biome check --write .` — no issues (all 3 files clean)
- `pnpm run build` — build success, no type errors
- `pnpm run test` — 390 test files passed, 0 failures
