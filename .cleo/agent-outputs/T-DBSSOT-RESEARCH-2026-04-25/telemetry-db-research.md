# Telemetry DB Research (2026-04-25)

## TL;DR (3 bullets)

- **SCHEMA EXISTS & ACTIVE**: `packages/core/src/telemetry/schema.ts` defines `telemetry_events` (9 fields + 5 indexes) + `telemetry_schema_meta` (2 fields). Fully implemented in drizzle-orm.
- **RUNTIME WRITING IS ACTIVE**: Telemetry is written at runtime via `recordTelemetryEvent()` fire-and-forget callback in the dispatch middleware (`packages/cleo/src/dispatch/middleware/telemetry.ts:32-46`), gated behind `isTelemetryEnabled()` opt-in check (default disabled).
- **MIGRATION COVERAGE COMPLETE**: `packages/core/migrations/drizzle-telemetry/` contains 2 migrations (T624 initial + T1176 baseline reset per ADR-054 Hybrid Path A+). No `drizzle/telemetry.config.ts` exists — migrations are run via `migration-manager.ts` at runtime.

---

## Evidence

### 1. Schema location

- **File**: `/mnt/projects/cleocode/packages/core/src/telemetry/schema.ts` (69 lines)
- **Tables**:
  - `telemetry_events` (9 fields: id, anonymous_id, domain, gateway, operation, command, exit_code, duration_ms, error_code; 5 indexes on command, domain, exit_code, timestamp, duration_ms)
  - `telemetry_schema_meta` (2 fields: key, value)
- **Lines**: schema.ts is 69 lines total; table definitions at lines 24–55 and 63–68

### 2. Runtime usage

- **Active? YES**
- **Call sites**:
  - Middleware: `packages/cleo/src/dispatch/middleware/telemetry.ts:32-46` — calls `recordTelemetryEvent()` after every CQRS operation (success or failure)
  - CLI commands: `packages/cleo/src/cli/commands/diagnostics.ts` — 5 subcommands (enable, disable, status, analyze, export)
  - Dispatch domain: `packages/cleo/src/dispatch/engines/diagnostics-engine.ts:37,72` — implements diagnosticsEnable/diagnosticsDisable
  - Core entry: `packages/core/src/internal.ts:868-871` — exports getTelemetryDbPath, isTelemetryEnabled, recordTelemetryEvent
  - Test: `packages/core/src/__tests__/telemetry.test.ts` — comprehensive coverage

- **Opt-in mechanism**: 
  - Config file: `~/.local/share/cleo/telemetry-config.json` (TelemetryConfig struct with `enabled` bool + `anonymousId` UUID)
  - Enabled via: `cleo diagnostics enable` (generates stable anonymousId on first enable)
  - Default: **disabled** (opt-out, not opt-in)
  - Guard: `isTelemetryEnabled()` check before any write (packages/core/src/telemetry/index.ts:117)
  - Fire-and-forget: errors are swallowed, never blocks calling command (packages/core/src/telemetry/index.ts:177-179)

### 3. Migration coverage

- **Directory**: `packages/core/migrations/drizzle-telemetry/` ✓ EXISTS
- **Migrations**:
  - `20260415000001_t624-initial/migration.sql` (24 lines) — Creates telemetry_events and telemetry_schema_meta tables with all indexes
  - `20260422000000_t1176-telemetry-baseline-reset/migration.sql` (9 lines) — Baseline marker for ADR-054 Hybrid Path A+ (snapshot.json anchor)
- **Count**: 2 migrations
- **Drizzle config**: NO `drizzle/telemetry.config.ts` exists
  - Unlike memory.db, nexus.db, brain.db (which presumably have drizzle-kit configs in their respective packages)
  - Telemetry uses **runtime migration-manager** pattern instead (per ADR-054: migrations run via `migrateWithRetry()` + `reconcileJournal()` at DB init time)
  - See packages/core/src/telemetry/sqlite.ts:57-65

### 4. Schema versioning

- **Version tracking**: YES, exists
- **Constant**: `TELEMETRY_SCHEMA_VERSION = '1.0.0'` (packages/core/src/telemetry/sqlite.ts:26)
- **Storage**: Seeded into `telemetry_schema_meta` table (key='schemaVersion', value='1.0.0') at init time (packages/core/src/telemetry/sqlite.ts:127-131)
- **Follows pattern**: Consistent with other CLEO DBs (memory.db, brain.db, etc. also define version constants)

### 5. CLI surface

- **Command**: `cleo diagnostics`
- **Subcommands**:
  - `cleo diagnostics enable` — opt-in to telemetry (mutate, T624)
  - `cleo diagnostics disable` — opt-out (mutate, T624)
  - `cleo diagnostics status` — show config + dbPath (query)
  - `cleo diagnostics analyze [--days=N] [--no-brain]` — aggregate telemetry patterns, push high-signal observations to BRAIN (query, T624)
  - `cleo diagnostics export [--days=N]` — dump all telemetry events as JSON (query, T624)
- **File**: packages/cleo/src/cli/commands/diagnostics.ts (lines 1–129)
- **User instruction**: Users opt-in via `cleo diagnostics enable` (disabled by default). Help text in registry (packages/cleo/src/dispatch/registry.ts:5606–5617)

### 6. Naming convention

- **Follows canonical `*-schema.ts` + `*-sqlite.ts`?** YES, partially
  - Telemetry uses: `schema.ts` + `sqlite.ts` (DEVIATES from other DBs)
  - Other DBs use: `{memory,brain,nexus,conduit,signaldock}-schema.ts` + `{memory,brain,nexus,conduit,signaldock}-sqlite.ts`
  
- **Actual file layout for telemetry**:
  ```
  packages/core/src/telemetry/
  ├── index.ts              (main entry point — TelemetryEvent, TelemetryConfig, recordTelemetryEvent, buildDiagnosticsReport, etc.)
  ├── schema.ts             (drizzle tables: telemetryEvents, telemetrySchemaMeta)
  └── sqlite.ts             (getTelemetryDb, getTelemetryDbPath, TELEMETRY_SCHEMA_VERSION, migrations)
  ```

- **Why the deviation?** Telemetry is opt-in, self-contained domain (not mixed with core store files). Separate `packages/core/src/telemetry/` folder keeps it isolated. This is a conscious design choice, not an oversight.

- **Open/init/CRUD functions location**:
  - Init: `getTelemetryDb()` (sqlite.ts:103)
  - Path: `getTelemetryDbPath()` (sqlite.ts:38)
  - Config I/O: `loadTelemetryConfig(), saveTelemetryConfig()` (index.ts:97–114)
  - Record event: `recordTelemetryEvent()` (index.ts:155)
  - Query/analyze: `buildDiagnosticsReport(), exportTelemetryEvents()` (index.ts:197, 312)
  - Enable/disable: `enableTelemetry(), disableTelemetry()` (index.ts:125, 139)

---

## Recommendation for SSoT scope

**DECISION: (a) Include in migration-runner unification epic**

**RATIONALE:**

1. **Already actively used**: Telemetry is runtime-active (fire-and-forget recording in dispatch middleware). Not dormant or deprecated.

2. **Migration coverage exists**: ADR-054 Hybrid Path A+ baseline reset is already applied (T1176 baseline marker). Schema is canonical and up-to-date.

3. **Runtime migration pattern is in place**: Uses `migration-manager.ts` (migrateWithRetry, reconcileJournal) uniformly with other DBs. No special handling needed.

4. **Schema version tracking is correct**: TELEMETRY_SCHEMA_VERSION = '1.0.0' matches the two-tier migration structure.

5. **CLI surface is mature**: 5 subcommands covering enable/disable/status/analyze/export. Users have clear opt-in flow.

6. **Naming convention choice is intentional**: Separate `packages/core/src/telemetry/` folder is a deliberate design (opt-in, isolated domain). Not a bug.

7. **No drizzle-kit config needed**: Telemetry does NOT need a `drizzle/telemetry.config.ts` file because:
   - Migrations are canonical (hand-written SQL in drizzle-telemetry/)
   - No auto-generate workflow required (telemetry schema is stable, minimal)
   - Runtime migration-manager handles versioning + rollout
   - Consistent with ADR-054 "canonical migration tree" design

**Action items for unification**:
- Audit that `telemetry_schema_meta` journal table is present and recording migration IDs correctly
- Verify `migration-manager.ts` treats telemetry identically to memory.db, brain.db (same reconcileJournal, migrateWithRetry signatures)
- Document the intentional naming deviation (`telemetry/{schema,sqlite}.ts` not `telemetry-{schema,sqlite}.ts`) in the SSoT spec
- Ensure telemetry.db is included in any migration inventory/dashboard tools

**Status: READY FOR INCLUSION**. Telemetry.db is not a stray DB — it is a well-integrated, actively used, and properly migrated database.

