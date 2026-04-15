# T624 — Diagnostic Feedback Loop: Autonomous Self-Improvement Telemetry

**Status**: complete
**Date**: 2026-04-15
**Task**: T624

---

## What Was Built

### 1. Telemetry Schema (`packages/core/src/telemetry/schema.ts`)

Drizzle ORM schema for `telemetry.db` stored at `~/.local/share/cleo/telemetry.db`:

- **`telemetry_events`** table: `id`, `anonymous_id`, `domain`, `gateway`, `operation`, `command`, `exit_code`, `duration_ms`, `error_code`, `timestamp`
- **`telemetry_schema_meta`** table: key/value schema version tracking
- Indexes on `command`, `domain`, `exit_code`, `timestamp`, `duration_ms`

### 2. Telemetry SQLite Singleton (`packages/core/src/telemetry/sqlite.ts`)

- Lazy-init singleton following the `brain-sqlite.ts` pattern
- Stores in global `~/.local/share/cleo/telemetry.db` (NOT in project `.cleo/`)
- Migration runner pointing to `migrations/drizzle-telemetry/`
- `resetTelemetryDbState()` for test isolation

### 3. Core Telemetry Module (`packages/core/src/telemetry/index.ts`)

Exports:
- `enableTelemetry()` — generates stable UUIDv4 anonymousId, sets `enabled: true`
- `disableTelemetry()` — sets `enabled: false`, preserves existing data
- `isTelemetryEnabled()` — fast synchronous check
- `loadTelemetryConfig()` / `saveTelemetryConfig()` — reads/writes `~/.local/share/cleo/telemetry-config.json`
- `recordTelemetryEvent(event)` — fire-and-forget async write, no-op when disabled
- `buildDiagnosticsReport(days)` — aggregates patterns, returns `DiagnosticsReport`
- `exportTelemetryEvents(days?)` — raw JSON export

`DiagnosticsReport` contains:
- `topFailing` — top 10 commands by failure rate (min 5 invocations)
- `topSlow` — top 10 commands by average duration
- `rareCommands` — commands invoked exactly once
- `observations` — high-signal BRAIN observation strings

### 4. Telemetry Middleware (`packages/cleo/src/dispatch/middleware/telemetry.ts`)

- Hooks into the dispatch pipeline AFTER every operation
- Fire-and-forget: errors are swallowed, never blocks response
- Wrapped in try/catch for resilience in mocked test environments
- Wired into `createCliDispatcher()` in `adapters/cli.ts`

### 5. Diagnostics Engine (`packages/cleo/src/dispatch/engines/diagnostics-engine.ts`)

Five operations:
- `diagnosticsEnable()` — opt-in
- `diagnosticsDisable()` — opt-out
- `diagnosticsStatus()` — show config and paths
- `diagnosticsAnalyze(days, pushToBrain)` — build report + emit BRAIN observations via `memoryObserve`
- `diagnosticsExport(days?)` — JSON dump

### 6. Diagnostics Domain Handler (`packages/cleo/src/dispatch/domains/diagnostics.ts`)

- `query`: `status`, `analyze`, `export`
- `mutate`: `enable`, `disable`
- Registered in `CANONICAL_DOMAINS` (types.ts) and `createDomainHandlers()` (domains/index.ts)

### 7. CLI Commands (`packages/cleo/src/cli/commands/diagnostics.ts`)

```
cleo diagnostics enable        # Opt in to telemetry
cleo diagnostics disable       # Opt out
cleo diagnostics status        # Show config + DB path
cleo diagnostics analyze       # Show patterns + push to BRAIN
  --days <n>                   # Analysis window (default: 30)
  --no-brain                   # Skip BRAIN push
cleo diagnostics export        # JSON dump
  --days <n>                   # Limit to last N days
```

### 8. Registry Changes

Added 5 operations to `OPERATIONS` array in `registry.ts`:
- `diagnostics.status` (query, tier 2)
- `diagnostics.analyze` (query, tier 2)
- `diagnostics.export` (query, tier 2)
- `diagnostics.enable` (mutate, tier 2)
- `diagnostics.disable` (mutate, tier 2)

Updated `parity.test.ts`: query=150, mutate=103, total=253

---

## Privacy Design

- **Opt-out by default** — `telemetry-config.json` does not exist until `cleo diagnostics enable`
- **Anonymous** — stable UUIDv4 identifier, no PII
- **Minimal** — only `domain`, `operation`, `exit_code`, `duration_ms`, `error_code`
- **Local-only** — data stays in `~/.local/share/cleo/telemetry.db`

---

## Sample `cleo diagnostics analyze` output

```json
{
  "report": {
    "period": { "from": "2026-03-16T...", "to": "2026-04-15T..." },
    "totalEvents": 1247,
    "topFailing": [
      {
        "command": "session.start",
        "count": 23,
        "failureCount": 18,
        "failureRate": 0.78,
        "avgDurationMs": 312,
        "maxDurationMs": 1102,
        "topErrorCode": "E_SESSION_CONFLICT"
      }
    ],
    "topSlow": [
      {
        "command": "nexus.analyze",
        "count": 8,
        "avgDurationMs": 4821,
        ...
      }
    ],
    "rareCommands": ["admin.scaffold-hub", "pipeline.stage.advance"],
    "observations": [
      "Command 'session.start' fails 78% of the time across 23 invocations (most common error: E_SESSION_CONFLICT). Investigate root cause.",
      "Command 'nexus.analyze' averages 4821ms — 6x slower than the 812ms median. Profile for performance improvement."
    ]
  },
  "brainObservationsAdded": 2
}
```

---

## Files Changed / Created

**New files:**
- `/mnt/projects/cleocode/packages/core/src/telemetry/schema.ts`
- `/mnt/projects/cleocode/packages/core/src/telemetry/sqlite.ts`
- `/mnt/projects/cleocode/packages/core/src/telemetry/index.ts`
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-telemetry/20260415000001_t624-initial/migration.sql`
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-telemetry/20260415000001_t624-initial/snapshot.json`
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/middleware/telemetry.ts`
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/engines/diagnostics-engine.ts`
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/diagnostics.ts`
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/diagnostics.ts`
- `/mnt/projects/cleocode/packages/core/src/__tests__/telemetry.test.ts`

**Modified files:**
- `packages/core/src/index.ts` — added `telemetry` namespace export
- `packages/core/src/internal.ts` — added flat exports for telemetry functions
- `packages/cleo/src/dispatch/types.ts` — added 'diagnostics' to CANONICAL_DOMAINS
- `packages/cleo/src/dispatch/registry.ts` — added 5 diagnostics operations
- `packages/cleo/src/dispatch/domains/index.ts` — registered DiagnosticsHandler
- `packages/cleo/src/dispatch/adapters/cli.ts` — wired createTelemetry() middleware
- `packages/cleo/src/cli/index.ts` — registered registerDiagnosticsCommand
- `packages/cleo/src/dispatch/__tests__/parity.test.ts` — updated operation counts

---

## Quality Gates

- `pnpm biome check --write` — passed (0 errors, 0 warnings)
- `pnpm --filter @cleocode/core run build` — passed
- `pnpm --filter @cleocode/cleo run build` — 1 pre-existing web.ts error (not introduced by T624)
- `pnpm run test` — 14/14 telemetry tests pass; 0 new failures (release-engine timeout pre-existing)

## Acceptance Criteria

- [x] Telemetry schema defined — `schema.ts` with `telemetry_events` + `telemetry_schema_meta`
- [x] Opt-in via cleo config — `cleo diagnostics enable/disable`, stored in `telemetry-config.json`
- [x] All LAFS envelopes captured with exit code — middleware hooks into every dispatch
- [x] `cleo diagnostics analyze` shows patterns — top failing, top slow, rare commands
- [x] Slow/failing commands surfaced — sorted by failure rate and average duration
- [x] BRAIN learnings auto-generated — `memoryObserve` called for high-signal patterns
