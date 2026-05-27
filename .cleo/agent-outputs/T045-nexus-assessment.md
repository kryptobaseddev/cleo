# T045 — Nexus Assessment: Validate or Defer

**Date**: 2026-03-22
**Task**: T045
**Epic**: T038 (Documentation-Implementation Drift Remediation)
**Assessment Type**: Production usage audit + code complexity analysis

---

## 1. What Nexus Features Exist

### Core Module (`packages/core/src/nexus/`) — 4591 production LOC

| File | LOC | Capability |
|------|-----|-----------|
| `registry.ts` | 713 | Project registration, reconcile, sync, list, show (SQLite via nexus.db) |
| `deps.ts` | 514 | Global dependency graph, critical path, blocking analysis, orphan detection |
| `discover.ts` | 363 | Cross-project task discovery (keyword + label matching), search across projects |
| `transfer.ts` | 314 | Cross-project task transfer (copy/move), brain observation transfer |
| `sharing/index.ts` | 350 | Multi-contributor .cleo/ state sharing (gitignore sync, snapshot export/import) |
| `query.ts` | 222 | Cross-project query syntax (`project:T001`, `.:T001`, `*:T001`) |
| `permissions.ts` | 144 | Three-tier access control (read/write/execute) |
| `transfer-types.ts` | 129 | Type contracts for transfer operations |
| `migrate-json-to-sqlite.ts` | 120 | Legacy JSON-to-SQLite one-time migration |
| `hash.ts` | 10 | Canonical project identity hash |
| `index.ts` | 114 | Public barrel exports |
| **Store support** | 396 | nexus-schema.ts, nexus-sqlite.ts, nexus-validation-schemas.ts |

### Dispatch Layer (`packages/cleo/src/`)

| File | LOC | Role |
|------|-----|------|
| `dispatch/domains/nexus.ts` | 454 | MCP domain handler |
| `dispatch/engines/nexus-engine.ts` | 508 | Business logic wrapper |
| `cli/commands/nexus.ts` | 240 | CLI subcommand surface |

**Grand total: ~5,753 production LOC** (excluding tests).

### Registered Dispatch Operations

**Query (13)**: `status`, `list`, `show`, `resolve`, `deps`, `graph`, `path.show`, `blockers.show`, `orphans.list`, `discover`, `search`, `share.status`, `transfer.preview`

**Mutate (9)**: `init`, `register`, `unregister`, `sync`, `permission.set`, `reconcile`, `share.snapshot.export`, `share.snapshot.import`, `transfer`

**Total: 22 registered operations.**

---

## 2. Test Coverage

| Test File | LOC | Tests cover |
|-----------|-----|-------------|
| `nexus/__tests__/nexus-e2e.test.ts` | 1,481 | Full E2E: registry, deps, discover, search, reconcile, permissions, audit log |
| `dispatch/domains/__tests__/nexus.test.ts` | 1,006 | All 22 dispatch operations via MCP |
| `nexus/__tests__/transfer.test.ts` | 446 | Transfer (copy, move, brain, dryRun, conflicts) |
| `nexus/__tests__/deps.test.ts` | 357 | Graph building, critical path, blocking, orphans |
| `nexus/__tests__/registry.test.ts` | 294 | Register, unregister, sync, reconcile |
| `nexus/__tests__/query.test.ts` | 202 | Query syntax, wildcard, current project |
| `nexus/__tests__/reconcile.test.ts` | 178 | Four reconcile scenarios |
| `nexus/__tests__/permissions.test.ts` | 152 | Three-tier permission enforcement |
| `cli/commands/__tests__/nexus.test.ts` | 307 | CLI surface tests |
| **Total test LOC** | **4,423** | — |

**Coverage assessment**: All major code paths have corresponding tests. The test suite is comprehensive relative to the implementation size.

---

## 3. Production Usage (Audit Log Analysis)

### nexus.db audit log — 23,048 total entries (2026-03-07 to 2026-03-22)

| Action | Count | First | Last | Classification |
|--------|-------|-------|------|----------------|
| `reconcile` | 11,665 | 2026-03-07 | 2026-03-22 | Auto-triggered by test/bootstrap infra |
| `register` | 11,015 | 2026-03-07 | 2026-03-22 | Auto-triggered by test/bootstrap infra |
| `unregister` | 358 | 2026-03-08 | 2026-03-08 | Test cleanup |
| `sync-all` | 7 | 2026-03-08 | 2026-03-18 | Auto-triggered by upgrade command |
| `sync` | 2 | 2026-03-08 | 2026-03-08 | Single manual or test invocation |
| `set-permission` | 1 | 2026-03-08 | 2026-03-08 | Single manual invocation |

**Actions with zero production records**: `transfer`, `deps`, `graph`, `path.show`, `blockers.show`, `orphans.list`, `discover`, `search`, `transfer.preview`, `share.snapshot.export`, `share.snapshot.import`

### tasks.db audit log — domain distribution

Domains recorded in project audit log: `admin`, `check`, `session`, `tasks`.

**Nexus domain: 0 entries.** No MCP call to the nexus domain has been made against this project.

### Registry state

- 8,446 total registered projects in nexus.db
- 8,422 (99.7%) are test-generated temp directories (`cleo-test-*`, `.temp/*`)
- 24 real projects registered
- All health statuses: `unknown` (no health check has ever run)

### Conclusion

The 23,048 audit entries are entirely lifecycle noise: test scaffolding creates temp projects (register + reconcile), then cleans them up (unregister). The single `set-permission` entry on 2026-03-08 is the only non-automated action and was likely a manual test during initial development.

**Zero user-facing Nexus operations have ever been executed in production.** The core federated features — cross-project dependency analysis, graph traversal, task discovery, cross-project search, task transfer — have never been invoked outside of automated tests.

---

## 4. Maintenance Cost

| Dimension | Assessment |
|-----------|-----------|
| Production LOC | ~5,753 lines across 17 files |
| Test LOC | ~4,423 lines across 9 test files |
| Database footprint | Separate nexus.db (fourth DB alongside tasks.db, brain.db, external refs) |
| Schema complexity | 2 tables (project_registry, nexus_audit_log) + 5 indexes |
| Dispatch surface | 22 registered operations (13 query + 9 mutate) |
| CLI commands | Full subcommand tree under `cleo nexus` |
| Integration points | Touches store, reconciliation, brain, sessions, migration layers |
| Drift risk | High — 22 operations with zero real-world exercise create documentation/behavior drift as surrounding code evolves |

The feature is non-trivial to maintain. Any refactor of the data accessor, task schema, or brain layer must be validated against Nexus behavior — but that validation can only happen via automated tests, not production signal.

---

## 5. Recommendation: Defer to Phase 3

### Rationale

1. **Zero production usage after 15+ days of active development.** The system has been available since 2026-03-07 with full CLI and MCP exposure, yet no cross-project features have been exercised by any real workflow.

2. **All registered real projects have `health_status = 'unknown'`.** The health check subsystem has never run, meaning the project registry is stale on first real use.

3. **The feature addresses a use case that does not yet exist.** Cross-project coordination requires multiple CLEO projects to coexist in a developer's workflow simultaneously. Current usage evidence shows single-project workflows only.

4. **Maintenance cost is disproportionate to return.** ~10,000 LOC (production + tests) for an untested capability creates real carrying cost as the core data layer evolves.

5. **Registry accumulation is a quality signal.** 8,422 test-generated stale entries that are never cleaned up indicate the lifecycle management path (init, register, health-check, prune) is not production-ready.

### Deferral Criteria for Phase 3 Entry

Nexus should be reconsidered when any of the following is true:

- A real user workflow requires referencing tasks across two distinct CLEO projects
- CleoOS is delivering multi-project workspace views that need federated task data
- A concrete use case for cross-project transfer (`nexus transfer`) exists and is documented
- The health check subsystem is designed (currently the `healthStatus` field is always `unknown`)

### What to Do Now (No Code Changes)

This task explicitly prohibits code modification. The following markers are recommended for a follow-up deferral task:

1. Add `@deferred-phase3` TSDoc tag to `packages/core/src/nexus/index.ts` barrel
2. Add a `NEXUS_DEFERRED.md` note in `docs/` explaining the deferral decision
3. Suppress nexus-related test runs from CI baseline to reduce noise

---

## 6. Summary Table

| Dimension | Value |
|-----------|-------|
| Total Nexus operations | 22 (13 query + 9 mutate) |
| Operations with tests | 22 of 22 (100%) |
| Operations used in production | 0 of 22 (0%) |
| Production LOC | ~5,753 |
| Test LOC | ~4,423 |
| Registry entries (real projects) | 24 |
| Health status for all real projects | `unknown` |
| Days available with zero usage | 15+ |
| **Recommendation** | **Defer to Phase 3** |
