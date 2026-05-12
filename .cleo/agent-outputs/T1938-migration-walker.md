# T1938: Migration Walker for Existing Agent Installs

**Task**: Migration walker — scan existing `.cleo/{cant/}agents/` entries and register in `signaldock.db.agents`, log conflicts  
**Status**: complete  
**Commit**: `0e13ec62b`  
**Epic**: T1929 (Phase 1: Agent System Canonicalization v2)

## Summary

Built `cleo migrate agents-v2` — a one-time idempotent migration utility for existing CLEO installations whose `.cleo/cant/agents/` and `.cleo/agents/` directories contain `.cant` files that were never registered in `signaldock.db.agents` (Bug 3 historical fallout from `cleo init --install-seed-agents` only copying files, never writing DB rows).

## Deliverables

### File 1: `packages/cleo/src/cli/commands/migrate-agents-v2.ts` (new)

Core migration module exposing:
- `runMigrateAgentsV2(projectRoot, verbose)` — async walker that scans both agent directories
- `walkAgentsDir(db, scanDir, projectRoot, summary, verbose)` — per-directory scanner
- `extractAgentName(source)` — minimal `.cant` parser (no circular dep on `@cleocode/cant`)
- `readMigrationConflicts(projectRoot)` — doctor diagnostic reader
- `migrateAgentsV2Command` — citty command definition
- Types: `MigrationOutcome`, `MigrationAuditEntry`, `MigrationSummary`

### File 2: Audit log format (`.cleo/audit/migration-agents-v2.jsonl`)

JSONL format, one entry per agent per run:
```json
{"timestamp":"...","type":"conflict","agentName":"...","filePath":"...","existingSha256":"...","newSha256":"...","action":"skipped-conflict-do-not-overwrite","doctor_diagnostic_id":"MIGRATE-AGENTS-V2-CONFLICT"}
```

### File 3: `packages/cleo/src/cli/commands/migrate-claude-mem.ts` (updated)

Added `agents-v2` as a subcommand of the existing `migrate` root command.

### File 4: `packages/cleo/src/cli/commands/doctor.ts` (updated)

Added MIGRATE-AGENTS-V2-CONFLICT diagnostic in the default `cleo doctor` run path. Reads `.cleo/audit/migration-agents-v2.jsonl` and prints unresolved conflicts with resolution guidance. Sets `process.exitCode = 2` when conflicts are present.

### Tests: `packages/cleo/src/cli/commands/__tests__/migrate.test.ts` (new, 13 tests)

- Empty directories: 0/0/0
- Pre-populated + already in DB (same sha256): all skipped
- Pre-populated + DB empty: all registered
- Mix of canonical + custom agents: all registered
- Conflict detection: same name, different content — not overwritten
- Idempotency: re-run produces no changes
- Doctor diagnostic: `readMigrationConflicts` returns conflict entries

## Key Design Decisions

1. **Use `installAgentFromCant()` only** — never write DB rows directly; canonical install path with full validation
2. **sha256-based idempotency** — compare content hashes, not just names; prevents false skips when content changes
3. **Conflict = log, never overwrite** — user customisations are preserved; surfaced via `cleo doctor` for manual resolution
4. **Audit log is append-only JSONL** — structured, machine-readable, survives re-runs without data loss
5. **Minimal .cant parser** — mirrors `agent-install.ts` internal parser to avoid circular deps on `@cleocode/cant`

## Evidence

- `implemented`: commit `0e13ec62b`, 4 files
- `testsPassed`: 13/13 pass (`/tmp/migrate-test-results-T1938.json`)
- `qaPassed`: `tsc --noEmit` exit 0; `pnpm biome ci` on 4 T1938 files exit 0
- `securityPassed`: read-only fs scan + DB writes via installAgentFromCant; no network surface
- `cleanupDone`: idempotent walker — safe to re-run; conflicts surfaced via cleo doctor not silently overwritten
