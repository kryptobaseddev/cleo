# T1571 Migration Plan — system-engine.ts (1855 LOC) → packages/core/system/

**Epic**: T1566 (T-ENGINE-MIGRATION)
**Date**: 2026-04-30
**Precedents**: T1568 (task-engine, fd816a16), T1569 (nexus-engine, 652057eb), T1570 (orchestrate-engine, d601250c)

---

## 1. Architectural Decisions (Q1–Q5)

### Q1 — Thin wrapper character of system-engine.ts

**Finding**: Unlike task-engine.ts (which contained real business logic), system-engine.ts is already a pure delegation layer. The comment at line 5 says explicitly: "Thin wrapper layer that delegates to core modules. All business logic lives in src/core/."

All 29 function bodies follow the same pattern:
```typescript
export async function systemX(projectRoot, params?) {
  try {
    const result = await coreFunction(projectRoot, params);
    return { success: true, data: result };
  } catch (err) {
    return cleoErrorToEngineError(err, 'E_CODE', 'message');
  }
}
```

**Three exceptions with real logic in the engine layer**:
1. `systemDash` — adapts the core response shape (adds missing fields, reshapes summary). ~30 LOC of mapping.
2. `systemStats` — adds `byPriority`, `byType`, `byPhase`, `cycleTimes` via extra accessor queries. ~60 LOC of computation on top of core.
3. `systemLog` — contains `queryAuditLogSqlite` (private function, ~175 LOC) that directly queries SQLite audit_log with dynamic WHERE, COUNT, pagination. This is real business logic.
4. `systemContext` — reads `.cleo/context-states/*.json` files, collects session states, returns structured data. ~130 LOC of FS traversal. Core has `getContextStatus` but it does not match this interface.
5. `systemCompliance` — reads `COMPLIANCE.jsonl` directly, computes statistics, trend, dataPoints. ~150 LOC. Core has `getComplianceSummary`/`getComplianceTrend` but the engine reads file directly.
6. `systemPaths` — assembles `PathsData` from path helpers. Pure aggregation, no core equivalent.
7. `systemScaffoldHub` — thin wrapper; core `ensureCleoOsHub()` exists.
8. `systemSmoke` — complex: 11 domain probes + DB checks. Imports `dispatchRaw` (intra-package). Cannot move to core without introducing circular dep. **Stay in new file `packages/core/src/system/smoke.ts` but use a callback injection pattern for dispatch, OR keep in admin domain logic — see Q3.**
9. `systemHelp` — static `HELP_TOPICS` dictionary. Pure data + lookup. Belongs in `packages/core/src/admin/help.ts` extension or new `packages/core/src/system/help.ts`.
10. `backupRestore` — lazy-imports `getBackupDir`, `getTaskPath`, `getConfigPath`, `restoreFromBackup`, `listBackups` from core. Has real conditional logic (~60 LOC). Consolidate into `packages/core/src/system/backup.ts` as `fileRestore`.

**Decision**: Move ALL logic to core, including the non-trivial functions. Functions with real logic become proper functions in existing core/system files (or new files where no home exists). The cleo domain handler (`admin.ts`) imports directly from `@cleocode/core/internal`.

---

### Q2 — EngineResult wrapping boundary

**Finding**: The existing core/system files (audit.ts, backup.ts, cleanup.ts, etc.) do NOT return `EngineResult` — they return raw values or throw `CleoError`. The engine layer wraps them. `wrapCoreResult` in typed.ts handles `EngineResult → LafsEnvelope`.

**Decision**: For the moved functions, adopt TWO patterns depending on complexity:
- **Simple delegates** (systemAudit, systemBackup, systemCleanup, etc. — ~20 functions): The domain handler (`admin.ts`) calls core directly and uses `wrapCoreResult` at the dispatch boundary. No wrapper needed.
- **Complex with real mapping logic** (systemDash, systemStats, systemLog, systemContext, systemCompliance, systemPaths, backupRestore): Add new exported functions to the relevant core/system/*.ts files that encapsulate the adapted shape. Return `EngineResult<T>` from these functions (matching the precedent in `caamp/adapter.ts`). The domain handler calls them directly.

**Rationale**: Keeps all business logic in core. Domain handler stays thin. Consistent with T1568/T1569/T1570.

---

### Q3 — systemSmoke circular dependency risk

**Finding**: `systemSmoke` calls `dispatchRaw` from `'../adapters/cli.js'` — an intra-cleo import. Moving this to core would create a circular dependency (core → cleo dispatch → core).

**Decision**: `systemSmoke` stays in cleo but moves to the admin domain logic directly. After deleting system-engine.ts, the smoke logic is inlined into `admin.ts` as a private helper `runSystemSmoke()` (not exported — admin domain calls it directly). The DB check portions that use `@cleocode/core/internal` stay in that private helper. No new core file needed.

**Alternative considered**: Extract to `packages/core/src/system/smoke.ts` with an injected `dispatchFn` callback. Rejected — over-engineered for a single call site.

---

### Q4 — Interface types that engine exports

**Finding**: system-engine.ts exports 10+ interfaces and 3 type re-exports that downstream consumers (admin.ts, engine barrel, tests) import:

**Type re-exports** (already in core/contracts — drop the engine re-export):
- `ArchiveStatsData` → `ArchiveStatsResult` from `@cleocode/core/internal`
- `AuditData` → `AuditResult` from `@cleocode/core/internal`
- `BackupData`, `BackupEntryData` → `BackupResult`, `BackupEntry` from `@cleocode/core/internal`
- `CleanupData` → `CleanupResult`, etc. — ALL already in core with different names

**Interface types with NO core equivalent** (must move to core):
- `DashboardData` → extend or add to `packages/core/src/stats/index.ts`
- `StatsData` → extend or add to `packages/core/src/stats/index.ts`
- `LogQueryData` → add to `packages/core/src/system/audit.ts` (audit log is there)
- `ContextData` → add to `packages/core/src/context/index.ts`
- `SequenceData` → add to `packages/core/src/sequence/index.ts`
- `RoadmapData` → add to `packages/core/src/roadmap/index.ts`
- `ComplianceData` → add to `packages/core/src/compliance/index.ts`
- `HelpData` → already exists partially in `packages/core/src/admin/help.ts`; extend
- `SyncData` → add to new `packages/core/src/system/sync.ts`
- `PathsData` → add to `packages/core/src/system/platform-paths.ts`
- `ScaffoldHubData` → add to `packages/core/src/scaffold.ts` (near `ScaffoldResult`)
- `SmokeProbe`, `SmokeResult` → stay in admin domain (see Q3)

**Decision**: Move each interface to the logical core module. Export from `@cleocode/core/internal`. The engine barrel (`lib/engine.ts`) re-exports the renamed types under the OLD names for the duration of the single commit that wires it — immediately deleted with the engine file.

---

### Q5 — Call site inventory

**Importers of system-engine.ts (production)**:

| File | Import | Disposition |
|------|--------|-------------|
| `packages/cleo/src/dispatch/lib/engine.ts` | All 37 symbols (re-export barrel block) | Remove system-engine block; re-export from `@cleocode/core/internal` |
| `packages/cleo/src/dispatch/domains/admin.ts` | 27 symbols (direct import from barrel) | Update import source to `@cleocode/core/internal` |
| `packages/cleo/src/cli/commands/context.ts` | `systemContext` | Update to `@cleocode/core/internal` |
| `packages/cleo/src/cli/commands/sequence.ts` | `systemSequenceRepair` (dynamic import) | Update to `@cleocode/core/internal` |

**Importers — tests (mock the barrel, NO changes needed)**:
- `packages/cleo/src/dispatch/adapters/__tests__/cli.test.ts` — mocks `'../../lib/engine.js'`; barrel change is transparent
- `packages/cleo/src/cli/commands/__tests__/verify-explain.test.ts` — mocks `systemArchiveStats` via barrel; transparent

**Importers — tests (MUST update)**:
| File | Required Change | Wave |
|------|----------------|------|
| `packages/cleo/src/__tests__/core-parity.test.ts` line 150-156 | Test reads system-engine.ts and asserts it imports from `@cleocode/core`. After deletion, rewrite to assert `@cleocode/core/internal` exports the key system functions. | Wave 4 |

---

## 2. Existing core/system/ Surface

| LOC | File | Key exports |
|-----|------|-------------|
| 1507 | `health.ts` | `getSystemHealth`, `getSystemDiagnostics`, `coreDoctorReport`, `runDoctorFixes`, `HealthResult`, `DiagnosticsResult`, `DoctorReport`, `FixResult` |
| 898 | `project-health.ts` | `checkProjectHealth`, `checkGlobalHealth`, `probeDb` |
| 534 | `dependencies.ts` | `checkAllDependencies`, `getDependencySpecs` |
| 464 | `archive-analytics.ts` | `analyzeArchive`, `summaryReport`, report variants |
| 348 | `backup.ts` | `createBackup` (aliased `systemCreateBackup`), `listSystemBackups`, `restoreBackup`, `BackupResult`, `RestoreResult`, `BackupEntry` |
| 220 | `runtime.ts` | `getRuntimeDiagnostics`, `RuntimeDiagnostics` |
| 180 | `audit.ts` | `auditData`, `AuditResult`, `AuditIssue` |
| 154 | `storage-preflight.ts` | `checkStorageMigration`, `PreflightResult` |
| 152 | `cleanup.ts` | `cleanupSystem`, `CleanupResult` |
| 147 | `inject-generate.ts` | `generateInjection`, `InjectGenerateResult` |
| 128 | `safestop.ts` | `safestop`, `uncancelTask`, `SafestopResult`, `UncancelResult` |
| 96 | `platform-paths.ts` | `getPlatformPaths`, `getSystemInfo`, `PlatformPaths` |
| 90 | `metrics.ts` | `getSystemMetrics`, `SystemMetricsResult` |
| 90 | `archive-stats.ts` | `getArchiveStats`, `ArchiveStatsResult` |
| 81 | `index.ts` | barrel |
| 55 | `migrate.ts` | `getMigrationStatus`, `MigrateResult` |
| 49 | `labels.ts` | `getLabels`, `LabelsResult` |
| 37 | `bridge-mode.ts` | `resolveBridgeMode` |

**Non-system core files relevant to system-engine migration**:

| File | Key exports used by system-engine |
|------|----------------------------------|
| `core/src/stats/index.ts` | `getDashboard`, `getProjectStats` |
| `core/src/roadmap/index.ts` | `getRoadmap` |
| `core/src/sequence/index.ts` | `showSequence`, `checkSequence`, `repairSequence` |
| `core/src/compliance/index.ts` | `getComplianceSummary`, `listComplianceViolations`, `getComplianceTrend` |
| `core/src/context/index.ts` | `getContextStatus`, `listContextSessions` |
| `core/src/admin/help.ts` | `computeHelp`, `HelpResult`, `HelpOperationDef` |
| `core/src/scaffold.ts` | `ensureCleoOsHub`, `ScaffoldResult` |
| `core/src/paths.ts` | `getCleoHome`, `getCleoConfigDir`, `getCleoGlobalRecipesDir`, `getCleoGlobalJustfilePath`, `getCleoPiExtensionsDir`, `getCleoCantWorkflowsDir`, `getCleoGlobalAgentsDir`, `getBackupDir`, `getTaskPath`, `getConfigPath` |

---

## 3. Symbol Inventory — Every Export with Target

### Type re-exports (engine barrel aliases — become direct imports from core in consumers)

| Engine Symbol | Core Canonical | Source |
|---------------|---------------|--------|
| `ArchiveStatsData` | `ArchiveStatsResult` | `@cleocode/core/internal` |
| `AuditData` | `AuditResult` | `@cleocode/core/internal` |
| `BackupEntryData` | `BackupEntry` | `@cleocode/core/internal` |
| `BackupData` | `BackupResult` | `@cleocode/core/internal` |
| `CleanupData` | `CleanupResult` | `@cleocode/core/internal` |
| `DiagnosticsData` | `DiagnosticsResult` | `@cleocode/core/internal` |
| `HealthData` | `HealthResult` | `@cleocode/core/internal` |
| `InjectGenerateData` | `InjectGenerateResult` | `@cleocode/core/internal` |
| `LabelsData` | `LabelsResult` | `@cleocode/core/internal` |
| `MigrateData` | `MigrateResult` | `@cleocode/core/internal` |
| `RestoreData` | `RestoreResult` | `@cleocode/core/internal` |
| `SafestopData` | `SafestopResult` | `@cleocode/core/internal` |
| `MetricsData` | `SystemMetricsResult` | `@cleocode/core/internal` |
| `UncancelData` | `UncancelResult` | `@cleocode/core/internal` |
| `RuntimeData` | `RuntimeDiagnostics` | `@cleocode/core/internal` |

### Interface types — move to core (new exports)

| Engine Interface | Target File | Target Export Name | Notes |
|-----------------|-------------|-------------------|-------|
| `DashboardData` | `packages/core/src/stats/index.ts` | `DashboardData` | Add alongside `getDashboard` |
| `StatsData` | `packages/core/src/stats/index.ts` | `StatsData` | Add alongside `getProjectStats` |
| `LogQueryData` | `packages/core/src/system/audit.ts` | `LogQueryData` | Audit log query shape |
| `ContextData` | `packages/core/src/context/index.ts` | `ContextData` | Context window state |
| `SequenceData` | `packages/core/src/sequence/index.ts` | `SequenceData` | Sequence state shape |
| `RoadmapData` | `packages/core/src/roadmap/index.ts` | `RoadmapData` | Roadmap response |
| `ComplianceData` | `packages/core/src/compliance/index.ts` | `ComplianceData` | Compliance stats |
| `HelpData` | `packages/core/src/admin/help.ts` | `HelpData` | System help topic |
| `SyncData` | `packages/core/src/system/sync.ts` (NEW) | `SyncData` | Sync op result |
| `PathsData` | `packages/core/src/system/platform-paths.ts` | `PathsData` | XDG paths aggregation |
| `ScaffoldHubData` | `packages/core/src/scaffold.ts` | `ScaffoldHubData` | Hub scaffold result |
| `SmokeProbe` | `packages/cleo/src/dispatch/domains/admin.ts` | (private) | Keep in admin domain |
| `SmokeResult` | `packages/cleo/src/dispatch/domains/admin.ts` | (private) | Keep in admin domain |

### Functions — target assignments

| Engine Function | LOC | Core Target | Notes |
|----------------|-----|-------------|-------|
| `systemDash` | ~47 | `packages/core/src/stats/index.ts` → `getDashboard` | `getDashboard` already exists; `systemDash` mapping logic folds into it or admin.ts calls core directly with reshaping |
| `systemStats` | ~85 | `packages/core/src/stats/index.ts` → `getProjectStats` + new `getProjectStatsExtended` | Extra byPriority/byType/byPhase/cycleTimes computation → new `getProjectStatsExtended` in stats |
| `systemLabels` | ~18 | EXTEND `packages/core/src/system/labels.ts` → `getLabels` | Already exists; admin.ts calls `getLabels` directly |
| `systemArchiveStats` | ~36 | EXTEND `packages/core/src/system/archive-stats.ts` → `getArchiveStats` | Already exists; admin.ts calls directly |
| `systemLog` | ~15 + private `queryAuditLogSqlite` ~175 | NEW `packages/core/src/system/audit.ts` → `queryAuditLog` | Extend existing audit.ts with `queryAuditLog` function + `LogQueryData` interface; uses `getDb` from core |
| `systemContext` | ~130 | EXTEND `packages/core/src/context/index.ts` → `getContextStatus` + new `getContextWindow` | `getContextStatus` exists but different shape; add `getContextWindow(cwd, opts): ContextData` |
| `systemSequence` | ~30 | `packages/core/src/sequence/index.ts` → `showSequence` + `checkSequence` | Both exist; admin.ts calls directly + reshapes |
| `systemInjectGenerate` | ~12 | EXTEND `packages/core/src/system/inject-generate.ts` → `generateInjection` | Already exists; admin.ts calls directly |
| `systemMetrics` | ~12 | EXTEND `packages/core/src/system/metrics.ts` → `getSystemMetrics` | Already exists; admin.ts calls directly |
| `systemHealth` | ~12 | EXTEND `packages/core/src/system/health.ts` → `getSystemHealth` | Already exists; admin.ts calls directly |
| `systemDiagnostics` | ~12 | EXTEND `packages/core/src/system/health.ts` → `getSystemDiagnostics` | Already exists; admin.ts calls directly |
| `systemHelp` | ~50 | EXTEND `packages/core/src/admin/help.ts` → add `getSystemHelp(topic?)` + `SYSTEM_HELP_TOPICS` | `computeHelp` exists; add `getSystemHelp` for the static-topic path |
| `systemRoadmap` | ~20 | `packages/core/src/roadmap/index.ts` → `getRoadmap` | Already exists; admin.ts calls directly |
| `systemCompliance` | ~150 | EXTEND `packages/core/src/compliance/index.ts` → use `getComplianceSummary` + `getComplianceTrend` | Core already has these ops; add `getComplianceStats(cwd, params)` that wraps both + adds JSONL path reading |
| `systemBackup` | ~12 | EXTEND `packages/core/src/system/backup.ts` → `createBackup` (already `systemCreateBackup`) | Already exists; admin.ts calls `createBackup` directly |
| `systemListBackups` | ~12 | EXTEND `packages/core/src/system/backup.ts` → `listSystemBackups` | Already exists |
| `systemRestore` | ~12 | EXTEND `packages/core/src/system/backup.ts` → `restoreBackup` | Already exists |
| `backupRestore` | ~65 | EXTEND `packages/core/src/system/backup.ts` → new `fileRestore` function | Add to backup.ts; uses `getBackupDir`, `getTaskPath`, `getConfigPath`, `listBackups`, `restoreFromBackup` |
| `systemMigrate` | ~12 | EXTEND `packages/core/src/system/migrate.ts` → `getMigrationStatus` | Already exists |
| `systemCleanup` | ~12 | EXTEND `packages/core/src/system/cleanup.ts` → `cleanupSystem` | Already exists |
| `systemAudit` | ~12 | EXTEND `packages/core/src/system/audit.ts` → `auditData` | Already exists |
| `systemSync` | ~20 | NEW `packages/core/src/system/sync.ts` → `systemSync` | Trivial no-op; new file justified by interface + function pairing |
| `systemSafestop` | ~12 | EXTEND `packages/core/src/system/safestop.ts` → `safestop` | Already exists |
| `systemUncancel` | ~12 | EXTEND `packages/core/src/system/safestop.ts` → `uncancelTask` | Already exists |
| `systemDoctor` | ~12 | EXTEND `packages/core/src/system/health.ts` → `coreDoctorReport` | Already exists |
| `systemFix` | ~12 | EXTEND `packages/core/src/system/health.ts` → `runDoctorFixes` | Already exists |
| `systemRuntime` | ~12 | EXTEND `packages/core/src/system/runtime.ts` → `getRuntimeDiagnostics` | Already exists |
| `systemPaths` | ~50 | EXTEND `packages/core/src/system/platform-paths.ts` → new `getSystemPaths(cwd): PathsData` | Add aggregator function; uses path helpers from `core/src/paths.ts` |
| `systemScaffoldHub` | ~12 | `packages/core/src/scaffold.ts` → `ensureCleoOsHub` | Already exists; add `ScaffoldHubData` type near `ScaffoldResult` |
| `systemSequenceRepair` | ~20 | `packages/core/src/sequence/index.ts` → `repairSequence` | Already exists; admin.ts reshapes output |
| `systemSmoke` | ~120 | INLINE to admin.ts private `runSystemSmoke()` | Cannot move to core (uses `dispatchRaw`) — see Q3 |

---

## 4. Call-Site Update Table

| File | Change | Wave |
|------|--------|------|
| `packages/cleo/src/dispatch/lib/engine.ts` | Remove entire system-engine.ts import block (lines ~260-297); re-export all system symbols from `@cleocode/core/internal` | Wave 4 |
| `packages/cleo/src/dispatch/domains/admin.ts` | Update import from `'../lib/engine.js'` system symbols to `@cleocode/core/internal` direct imports | Wave 4 |
| `packages/cleo/src/cli/commands/context.ts` | `import { systemContext } from '../../dispatch/engines/system-engine.js'` → `import { getContextWindow } from '@cleocode/core/internal'` | Wave 4 |
| `packages/cleo/src/cli/commands/sequence.ts` | Dynamic `await import('../../dispatch/engines/system-engine.js')` → `await import('@cleocode/core/internal')` + use `repairSequence` | Wave 4 |
| `packages/cleo/src/__tests__/core-parity.test.ts` | Lines 150-156: replace readFile-then-assert-content test with `@cleocode/core/internal` export existence test | Wave 4 |
| `packages/cleo/src/dispatch/adapters/__tests__/cli.test.ts` | No change — mocks barrel; transparent | — |
| `packages/cleo/src/cli/commands/__tests__/verify-explain.test.ts` | No change — mocks `systemArchiveStats` via barrel | — |
| `packages/cleo/src/cli/renderers/__tests__/system-renderers.test.ts` | No change — tests renderer functions, not engine | — |

---

## 5. Wave Plan

### Wave 1 — New core/system/ functions (non-trivial logic, new targets)

**Goal**: Add new exported functions/interfaces to existing core files for the engine functions with real logic that have no direct core equivalent. No cleo changes.

**Files to create/extend**:
- EXTEND `packages/core/src/system/audit.ts` — add `LogQueryData` interface + `queryAuditLog(cwd, filters?)` function (175 LOC moved from engine; uses `getDb` from core/internal, `drizzle-orm`)
- EXTEND `packages/core/src/context/index.ts` — add `ContextData` interface + `getContextWindow(cwd, opts?): ContextData` (130 LOC; replaces `systemContext` FS traversal)
- EXTEND `packages/core/src/system/platform-paths.ts` — add `PathsData` interface + `getSystemPaths(cwd): PathsData` (50 LOC; uses path helpers from `core/src/paths.ts`)
- EXTEND `packages/core/src/system/backup.ts` — add `FileRestoreResult` interface + `fileRestore(cwd, fileName, opts?)` function (65 LOC; replaces `backupRestore`; imports `getBackupDir`, `getTaskPath`, `getConfigPath`, `listBackups`, `restoreFromBackup` — all already in core)
- NEW `packages/core/src/system/sync.ts` — `SyncData` interface + `systemSync(cwd, params?): SyncData` (trivial no-op function)
- EXTEND `packages/core/src/admin/help.ts` — add `HelpData` interface compatible with engine's + `SYSTEM_HELP_TOPICS` dict + `getSystemHelp(topic?): HelpData` (static lookup, 50 LOC)
- EXTEND `packages/core/src/scaffold.ts` — add `ScaffoldHubData` interface near `ScaffoldResult`
- EXTEND `packages/core/src/stats/index.ts` — add `DashboardData` interface + `StatsData` interface + `getProjectStatsExtended(cwd, params?, accessor?)` that adds byPriority/byType/byPhase/cycleTimes
- EXTEND `packages/core/src/system/audit.ts` — `LogQueryData` already mentioned above
- EXTEND `packages/core/src/compliance/index.ts` — add `ComplianceData` interface + `getComplianceStats(cwd, params?)` that reads JSONL + computes stats (150 LOC; replaces `systemCompliance`)

**Update `packages/core/src/internal.ts`**: Export all new symbols.

**Verify**: `pnpm --filter @cleocode/core run build` passes. All new exports appear in compiled output.

**Commit message**:
```
feat(T1571): add core system ops — audit-log query, context-window, paths, file-restore, sync, help, compliance-stats (Wave 1)

Adds 9 new/extended functions to core/system/ that carry the non-trivial
logic from system-engine.ts: queryAuditLog, getContextWindow, getSystemPaths,
fileRestore, systemSync, getSystemHelp, getComplianceStats, getProjectStatsExtended.
Interfaces DashboardData, StatsData, LogQueryData, ContextData, PathsData,
ScaffoldHubData, ComplianceData, HelpData, SyncData exported from core/internal.
```

---

### Wave 2 — Extend existing core/system files + internal.ts barrel

**Goal**: Wire the new Wave 1 additions into `core/src/system/index.ts` and `core/src/internal.ts`. Verify existing core tests pass.

**Files**:
- EXTEND `packages/core/src/system/index.ts` — add exports for `queryAuditLog`, `LogQueryData`, `getSystemPaths`, `PathsData`, `fileRestore`, `FileRestoreResult`, `systemSync`, `SyncData`, `ScaffoldHubData`, `getProjectStatsExtended`
- EXTEND `packages/core/src/internal.ts` — export all new symbols (queryAuditLog, LogQueryData, getContextWindow, ContextData, getSystemPaths, PathsData, fileRestore, getSystemHelp, HelpData, SYSTEM_HELP_TOPICS, getComplianceStats, ComplianceData, getProjectStatsExtended, StatsData, DashboardData, SyncData, systemSync, ScaffoldHubData)

**Verify**: `pnpm --filter @cleocode/core run build && pnpm --filter @cleocode/core run test`

**Commit message**:
```
feat(T1571): wire Wave 1 core symbols to system/index.ts + internal.ts barrel (Wave 2)

All new exports from Wave 1 accessible via @cleocode/core/internal.
Core build green. Core tests pass.
```

---

### Wave 3 — Update admin domain + direct CLI callers

**Goal**: Update all cleo call sites to import from `@cleocode/core/internal` directly, removing dependency on system-engine.ts. The engine barrel still re-exports from system-engine (not changed yet) — admin.ts is updated to bypass the barrel.

**Files**:
- MODIFY `packages/cleo/src/dispatch/domains/admin.ts`:
  - Replace import block that includes system functions from `'../lib/engine.js'` with direct imports from `@cleocode/core/internal`
  - Update each call site:
    - `systemDash` → `getDashboard` (with reshaping inline or via `DashboardData` from core)
    - `systemStats` → `getProjectStatsExtended`
    - `systemHealth` → `getSystemHealth`
    - `systemContext` → `getContextWindow`
    - `systemRuntime` → `getRuntimeDiagnostics`
    - `systemPaths` → `getSystemPaths`
    - `systemDash` → `getDashboard`
    - `systemLog` → `queryAuditLog`
    - `systemSequence` → `showSequence` / `checkSequence`
    - `systemListBackups` → `listSystemBackups`
    - `systemRoadmap` → `getRoadmap`
    - `systemSmoke` → inline `runSystemSmoke()` private function (with `dispatchRaw` import)
    - `systemScaffoldHub` → `ensureCleoOsHub`
    - `systemDoctor` → `coreDoctorReport`
    - `systemFix` → `runDoctorFixes`
    - `systemInjectGenerate` → `generateInjection`
    - `backupRestore` → `fileRestore`
    - `systemBackup` → `createBackup`
    - `systemCleanup` → `cleanupSystem`
    - `systemMigrate` → `getMigrationStatus`
    - `systemSafestop` → `safestop`
    - `systemRestore` → `restoreBackup`
    - `systemAudit` → `auditData`
    - `systemMetrics` → `getSystemMetrics`
    - `systemLabels` → `getLabels`
    - `systemStats` → `getProjectStatsExtended`
    - `systemRoadmap` → `getRoadmap`
    - `systemHelp` → `getSystemHelp`
    - `systemCompliance` → `getComplianceStats`
    - `systemUncancel` → `uncancelTask`
    - `systemArchiveStats` → `getArchiveStats`
    - `systemSync` → `systemSync` from core
    - `systemSequenceRepair` → `repairSequence` (reshape output inline)
- MODIFY `packages/cleo/src/cli/commands/context.ts` — `systemContext` → `getContextWindow` from `@cleocode/core/internal`
- MODIFY `packages/cleo/src/cli/commands/sequence.ts` — dynamic `import('...system-engine.js')` → `import('@cleocode/core/internal')` + `repairSequence`

**Verify**: `pnpm --filter @cleocode/cleo run build` passes. Run integration test for admin domain: `pnpm run test --filter @cleocode/cleo -- admin`

**Commit message**:
```
feat(T1571): admin.ts + CLI commands import from @cleocode/core/internal directly (Wave 3)

admin.ts, context.ts, sequence.ts updated to bypass system-engine.ts barrel.
All 28 system operations now import from core. systemSmoke logic inlined as
private runSystemSmoke() in admin.ts (dispatchRaw dependency precludes core move).
```

---

### Wave 4 — Delete system-engine.ts + update barrel + update tests

**Goal**: Delete the source file. Update the engine barrel to remove system-engine references. Update core-parity.test.ts.

**Files**:
- DELETE `packages/cleo/src/dispatch/engines/system-engine.ts`
- MODIFY `packages/cleo/src/dispatch/lib/engine.ts` — remove system-engine.ts import block (~35 lines, lines 260-297 approx); add re-exports of renamed symbols from `@cleocode/core/internal` if any consumers still depend on old alias names (e.g., `ArchiveStatsData` alias for `ArchiveStatsResult`). Check engine barrel callers — only cli.test.ts mocks the barrel and uses these aliases.
- MODIFY `packages/cleo/src/__tests__/core-parity.test.ts` — lines 150-156: replace "reads system-engine.ts file content" assertion with "@cleocode/core/internal exports expected system functions" assertion:
  ```typescript
  it('@cleocode/core/internal exports core system functions (T1571: system-engine.ts deleted)', async () => {
    const core = await import('@cleocode/core/internal');
    expect(typeof core.getSystemHealth).toBe('function');
    expect(typeof core.getDashboard).toBe('function');
    expect(typeof core.queryAuditLog).toBe('function');
    expect(typeof core.getContextWindow).toBe('function');
    expect(typeof core.getSystemPaths).toBe('function');
  });
  ```

**Verify**: Full test suite — `pnpm run test`; `pnpm biome ci .`; `pnpm run build`

**Commit message**:
```
feat(T1571): delete system-engine.ts, update barrel + parity test (Wave 4)

system-engine.ts deleted (1855 LOC). Engine barrel updated: system-engine block
removed, type aliases retained via @cleocode/core/internal for test mocks.
core-parity.test.ts updated to verify @cleocode/core/internal exports system
functions. Build green, tests pass.
```

---

## 6. Risk Register

### Risk 1 — `systemCompliance` JSONL path hardcoding

**Description**: `systemCompliance` reads `join(projectRoot, '.cleo', 'metrics', 'COMPLIANCE.jsonl')` using the literal string `.cleo`, bypassing `getCleoDir()` (which respects `CLEO_DIR` env var). Moving this to `getComplianceStats()` in core must use `getCleoDirAbsolute(cwd)` instead.

**Mitigation**: In `getComplianceStats`, replace hardcoded path construction with `getCleoDirAbsolute(cwd)` from `core/src/paths.ts`. Add a test case that mocks `CLEO_DIR`.

**Severity**: Medium — would silently fail for non-default CLEO_DIR users.

---

### Risk 2 — `systemLog` uses cleo-local constants

**Description**: `queryAuditLogSqlite` imports `CLEO_DIR_NAME`, `TASKS_DB_FILENAME` from `packages/cleo/src/cli/paths.js` — cleo-internal constants. When moved to `core/src/system/audit.ts`, these must be replaced with `core`-owned constants or path helpers (`getCleoDir()`, `getTaskPath()`).

**Mitigation**: Replace `join(projectRoot, CLEO_DIR_NAME, TASKS_DB_FILENAME)` with `getTaskPath(projectRoot)` from `core/src/paths.ts` (already exported from `@cleocode/core/internal`). Replace `METRICS_SUBDIR` + `COMPLIANCE_JSONL` with inline strings or add constants to `core/src/paths.ts`.

**Severity**: High — build would fail if cleo constants imported in core.

---

### Risk 3 — `systemSmoke` is not movable to core (circular dep)

**Description**: `systemSmoke` imports `dispatchRaw` from `'../adapters/cli.js'`. Moving this to core creates a core→cleo→core circular dependency.

**Mitigation**: Decision is to inline `runSystemSmoke()` as a private function in `admin.ts`. The smoke probes array and DB check logic move with it. This is the only function that cannot become a core export.

**Severity**: Low — decision made in Q3 with clear mitigation.

---

### Risk 4 — Type alias name changes break engine.ts barrel consumers

**Description**: system-engine.ts exports engine-layer aliases (`ArchiveStatsData`, `AuditData`, `BackupData`, etc.) that remap core type names. Tests that mock `lib/engine.js` (cli.test.ts, verify-explain.test.ts) reference these aliases. After deleting system-engine.ts, if these aliases are not preserved in the barrel, TypeScript will fail.

**Mitigation**: In the Wave 4 barrel update, add explicit alias re-exports in `engine.ts`:
```typescript
export type { ArchiveStatsResult as ArchiveStatsData, AuditResult as AuditData, ... } from '@cleocode/core/internal';
```
These aliases stay in the barrel until any remaining consumers are updated.

**Severity**: Medium — TypeScript compile error if missed.

---

### Risk 5 — `backupRestore` uses two different `listBackups` exports

**Description**: `backupRestore` imports `listBackups` from `@cleocode/core/internal`. However, `core/src/store/backup.ts` exports `listBackups(fileName, backupDir)` (async, two params) while `core/src/store/file-utils.ts` exports `listBackups(filePath)` (sync, one param). The engine currently uses the async two-param version from `store/backup.ts`. The new `fileRestore` function must import the correct one.

**Mitigation**: Confirm import path. The engine imports `restoreFromBackup` and `listBackups` from `'@cleocode/core/internal'` (line 1291), which re-exports from `store/backup.ts`. Verify `internal.ts` line 841: `export { createBackup, listBackups, restoreFromBackup } from './store/backup.js'` — correct two-param version. Use explicit import from `'./store/backup.js'` in the new `fileRestore` in `backup.ts`.

**Severity**: Low — caught by TypeScript if wrong overload used, but subtle.

---

## 7. Summary

- **46 exports** in system-engine.ts: 15 type re-exports + 10 new interface types + 29 functions (including 1 private `queryAuditLogSqlite`)
- **18 existing core/system/ files** provide homes for ~20 of the 29 functions
- **5 new exports** needed: `queryAuditLog`, `getContextWindow`, `getSystemPaths`, `fileRestore`, `getComplianceStats`, `getProjectStatsExtended`, `getSystemHelp`, `systemSync` (8 new functions + accompanying types)
- **1 new file**: `packages/core/src/system/sync.ts`
- **4 call-site files updated**: `admin.ts`, `context.ts`, `sequence.ts`, `engine.ts`
- **1 test file updated**: `core-parity.test.ts`
- **4 waves**, each ending with a passing build + test run
