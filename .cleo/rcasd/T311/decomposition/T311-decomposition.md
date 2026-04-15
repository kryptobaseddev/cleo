---
task: T333
epic: T311
type: decomposition
pipeline_stage: decomposition
feeds_into: [T311-implementation]
created: 2026-04-08
spec_source: .cleo/specs/T311-backup-portability-spec.md
adr: ADR-038
consensus: .cleo/consensus/T311-consensus.md
cross_epic_dependency: T310 (v2026.4.12 must ship before T311 v2026.4.13)
---

# T311 Decomposition: Cross-Machine Backup Portability

> Decomposes T311 specification (T332) into 15 atomic implementation subtasks,
> organized into 6 waves with explicit dependency ordering. All tasks are children
> of T311 and appear in the tracker.

---

## Cross-Epic Dependency Statement (MANDATORY)

**T311 CANNOT ship before T310 (v2026.4.12).**

T310 introduces the conduit.db/signaldock.db topology (ADR-037) that T311's
export code directly references:

| Artifact | Before T310 | After T310 (required by T311) |
|----------|-------------|-------------------------------|
| Project-tier agent DB | `.cleo/signaldock.db` | `.cleo/conduit.db` |
| Global-tier agent DB | (not at global tier) | `$XDG_DATA_HOME/cleo/signaldock.db` |
| Global salt file | (absent) | `$XDG_DATA_HOME/cleo/global-salt` |

**Integration risk mitigation**: T342 (Wave 0) adds a T310-readiness gate to
backup-pack.ts. If conduit.db is absent but legacy signaldock.db exists at the
project tier, the export aborts with a descriptive error directing the operator
to run `cleo` to trigger automatic migration. This guard allows T311 implementation
to begin before T310 lands without producing a silent corrupt export. Once T310
is confirmed merged to main, the conditional guard in T342 should be removed.

---

## 1. Subtask Summary Table

| ID | Title | Wave | Priority | Size | Files |
|----|-------|------|----------|------|-------|
| T342 | T310-readiness gate | 0 | critical | small | backup-pack.ts (t310 check fn) |
| T343 | BackupManifest type + JSON Schema asset | 0 | critical | small | packages/contracts/src/backup-manifest.ts, packages/core/src/assets/schemas/manifest-v1.json |
| T345 | backup-crypto.ts: Argon2id + AES-256-GCM | 0 | critical | medium | backup-crypto.ts, backup-encryption.test.ts |
| T347 | backup-pack.ts: packer + checksums | 1 | critical | large | backup-pack.ts, backup-export.test.ts |
| T350 | backup-unpack.ts: unpacker + 6 integrity layers | 1 | critical | large | backup-unpack.ts, backup-unpack.test.ts |
| T352 | regenerators.ts: dry-run JSON generators | 2 | high | medium | regenerators.ts, regenerators.test.ts |
| T354 | restore-json-merge.ts: A/B classification engine | 3 | high | large | restore-json-merge.ts, restore-json-merge.test.ts |
| T357 | Conflict report generator + restore-imported/ | 3 | high | medium | restore-json-merge.ts (extended), restore-json-merge.test.ts (extended) |
| T359 | CLI: cleo backup export | 4 | high | medium | backup-export.ts, backup.ts (register) |
| T361 | CLI: cleo backup import | 4 | high | large | backup-import.ts, backup.ts (register) |
| T363 | CLI: cleo backup inspect | 4 | high | medium | backup-inspect.ts, backup.ts (register) |
| T365 | CLI: cleo restore finalize | 4 | high | medium | restore-finalize.ts, restore.ts (register) |
| T367 | Integration test suite | 5 | high | large | backup.integration.test.ts |
| T368 | TSDoc + README backup docs | 5 | medium | small | inline TSDoc + docs/backup-portability.md |
| T370 | v2026.4.13 release | 6 | high | medium | package.json (x10), CHANGELOG.md |

**Total: 15 subtasks** across 6 waves.

---

## 2. Wave Breakdown

### Wave 0 — Prerequisites + Foundational Modules

All Wave 0 tasks can run in parallel. They have no interdependencies within the wave.
Everything else depends on at least one Wave 0 task.

| Task | Description | Parallel with |
|------|-------------|---------------|
| T342 | T310-readiness gate function | T343, T345 |
| T343 | BackupManifest contract type + JSON Schema asset | T342, T345 |
| T345 | backup-crypto.ts Argon2id + AES-256-GCM module | T342, T343 |

**Wave 0 outputs**:
- `packages/contracts/src/backup-manifest.ts` — BackupManifest + related interfaces
- `packages/core/src/assets/schemas/manifest-v1.json` — JSON Schema Draft 2020-12
- `packages/core/src/store/backup-crypto.ts` — encrypt/decrypt functions
- T310 readiness check function stub in backup-pack.ts

### Wave 1 — Packer + Unpacker

Depends on Wave 0 (T342, T343 for packer; T342, T343, T345 for unpacker).
T347 and T350 can run in parallel.

| Task | Depends on | Parallel with |
|------|-----------|---------------|
| T347 | T342, T343 | T350 |
| T350 | T342, T343, T345 | T347 |

**Wave 1 outputs**:
- `packages/core/src/store/backup-pack.ts` — packBundle function + VACUUM INTO pipeline
- `packages/core/src/store/backup-unpack.ts` — unpackBundle with all 6 integrity layers

### Wave 2 — Local Regenerators

Depends on T343 (needs BackupManifest types). Can begin in parallel with Wave 1.

| Task | Depends on | Notes |
|------|-----------|-------|
| T352 | T343 | Investigate refactoring cleo init code per spec §6.4 |

**Wave 2 output**:
- `packages/core/src/store/regenerators.ts` — dry-run JSON file generators (no disk writes)

### Wave 3 — A/B Engine + Conflict Report

Depends on Wave 2 (T352) and Wave 0 (T343). T354 must complete before T357.

| Task | Depends on | Notes |
|------|-----------|-------|
| T354 | T343, T352 | Classification engine — no disk writes |
| T357 | T354 | Conflict report writer — extends restore-json-merge.ts |

**Wave 3 outputs**:
- A/B regenerate-and-compare engine in `restore-json-merge.ts`
- writeConflictReport function + `.cleo/restore-imported/` preservation logic

### Wave 4 — CLI Verbs

All 4 CLI verbs can begin once their specific dependencies are satisfied.
T359 (export) and T363 (inspect) can run in parallel with T361 (import).
T365 (restore finalize) depends only on T357 and can run in parallel with T359/T361/T363.

| Task | Depends on | Parallel with |
|------|-----------|---------------|
| T359 | T347, T345 | T361, T363, T365 |
| T361 | T350, T354, T357 | T359, T363, T365 |
| T363 | T343, T350 | T359, T361, T365 |
| T365 | T357 | T359, T361, T363 |

**Wave 4 outputs**:
- `packages/cleo/src/cli/commands/backup-export.ts`
- `packages/cleo/src/cli/commands/backup-import.ts`
- `packages/cleo/src/cli/commands/backup-inspect.ts`
- `packages/cleo/src/cli/commands/restore-finalize.ts`
- Registration edits to `backup.ts` and `restore.ts`

### Wave 5 — Integration Tests + Documentation

Both tasks depend on all Wave 4 tasks. They can run in parallel with each other.

| Task | Depends on | Parallel with |
|------|-----------|---------------|
| T367 | T359, T361, T363, T365 | T368 |
| T368 | T359, T361, T363, T365 | T367 |

**Wave 5 outputs**:
- `packages/cleo/src/cli/commands/backup.integration.test.ts`
- TSDoc on all 5 core modules + `docs/backup-portability.md`

### Wave 6 — Release

Final gate. Depends on every non-release task. Cannot begin until all 14 prior
subtasks are complete and all quality gates pass.

| Task | Depends on | Notes |
|------|-----------|-------|
| T370 | ALL 14 prior tasks | v2026.4.13 CalVer release |

---

## 3. Dependency Graph

```
Wave 0 (parallel):
  T342 ──┐
  T343 ──┼─────────────────┐
  T345 ──┘                 │
         │                 │
Wave 1 (parallel):         │
  T342+T343 → T347         │
  T342+T343+T345 → T350    │
         │                 │
Wave 2 (parallel with W1): │
  T343 → T352              │
         │                 │
Wave 3 (sequential):       │
  T343+T352 → T354 → T357  │
                    │      │
Wave 4 (parallel):  │      │
  T347+T345 → T359  │      │
  T350+T354+T357 → T361    │
  T343+T350 → T363  │      │
  T357 → T365       │      │
         │          │      │
Wave 5 (parallel):  │      │
  T359+T361+T363+T365 → T367
  T359+T361+T363+T365 → T368
         │
Wave 6:
  T342+T343+T345+T347+T350+T352+T354+T357+T359+T361+T363+T365+T367+T368 → T370
```

**Cycle check**: No cycles. All edges flow from lower wave to higher wave.

---

## 4. Critical Path

The longest-dependency chain that determines the earliest possible release:

```
T343 (Wave 0) → T352 (Wave 2) → T354 (Wave 3) → T357 (Wave 3)
                                                     ↓
T342 (Wave 0) → T347 (Wave 1)                        ↓
T345 (Wave 0) → T350 (Wave 1)                        ↓
                                               T361 (Wave 4) → T367 (Wave 5) → T370 (Wave 6)
```

T361 (backup import) is the most dependency-laden CLI verb (requires T350 + T354 + T357)
and sits on the critical path. T367 (integration tests) requires T361 to be complete
and is also on the critical path to T370.

**Critical path sequence**: T343 → T352 → T354 → T357 → T361 → T367 → T370

---

## 5. File Boundaries (≤3 files per subtask)

| Task | New Files (max 3) | Modified Files |
|------|-------------------|----------------|
| T342 | — | backup-pack.ts (t310 fn only, pre-creation stub) |
| T343 | backup-manifest.ts, manifest-v1.json | — |
| T345 | backup-crypto.ts, backup-encryption.test.ts | — |
| T347 | backup-pack.ts, backup-export.test.ts | — |
| T350 | backup-unpack.ts, backup-unpack.test.ts | — |
| T352 | regenerators.ts, regenerators.test.ts | — |
| T354 | restore-json-merge.ts, restore-json-merge.test.ts | — |
| T357 | — | restore-json-merge.ts (extended), restore-json-merge.test.ts (extended) |
| T359 | backup-export.ts | backup.ts (1-line register) |
| T361 | backup-import.ts | backup.ts (1-line register) |
| T363 | backup-inspect.ts | backup.ts (1-line register) |
| T365 | restore-finalize.ts | restore.ts (1-line register) |
| T367 | backup.integration.test.ts | — |
| T368 | docs/backup-portability.md | (inline TSDoc only) |
| T370 | — | package.json (x10), CHANGELOG.md |

All subtasks are within the ≤3 files constraint.

---

## 6. Per-Subtask Acceptance Criteria Count

| Task | AC Count |
|------|----------|
| T342 | 4 |
| T343 | 4 |
| T345 | 5 |
| T347 | 5 |
| T350 | 5 |
| T352 | 4 |
| T354 | 5 |
| T357 | 5 |
| T359 | 5 |
| T361 | 5 |
| T363 | 5 |
| T365 | 5 |
| T367 | 5 |
| T368 | 4 |
| T370 | 5 |

All subtasks meet the ≥3 AC requirement. Minimum: 4 (T342, T343, T352, T368).

---

## 7. Parallel Dispatch Plan

For maximum throughput the orchestrator SHOULD dispatch in the following batches:

**Batch 1 (Wave 0 — all parallel)**: T342, T343, T345

**Batch 2 (Wave 1 + Wave 2 — parallel across waves)**:
- T347 (unblocked by T342+T343 completing)
- T350 (unblocked by T342+T343+T345 completing)
- T352 (unblocked by T343 completing)

**Batch 3 (Wave 3 — sequential within wave)**:
- T354 (unblocked by T343+T352)
- T357 (unblocked by T354)

**Batch 4 (Wave 4 — all parallel once their dependencies complete)**:
- T359 (unblocked by T347+T345)
- T361 (unblocked by T350+T354+T357)
- T363 (unblocked by T343+T350)
- T365 (unblocked by T357)

**Batch 5 (Wave 5 — parallel)**:
- T367 (unblocked by all Wave 4)
- T368 (unblocked by all Wave 4)

**Batch 6 (Wave 6 — final gate)**:
- T370 (unblocked by all 14 prior tasks)

---

## 8. Exit Codes Catalog (spec §4.3)

All new exit codes are in the 70-79 range. Implementers must use these exact values:

| Code | Symbol | Throwing Task |
|------|--------|---------------|
| 70 | E_BUNDLE_DECRYPT | T345 (crypto), T350 (layer 1), T361 (import) |
| 71 | E_BUNDLE_SCHEMA | T350 (layers 2+3), T361 (import) |
| 72 | E_CHECKSUM_MISMATCH | T350 (layer 4) |
| 73 | E_SQLITE_INTEGRITY | T350 (layer 5) |
| 74 | E_MANIFEST_MISSING | T350 (unpack) |
| 75 | E_SCHEMAS_MISSING | T350 (unpack) |
| 76 | E_SCHEMA_NEWER | T350 (layer 6, WARNING only, exit 0) |
| 77 | E_SCHEMA_OLDER | T350 (layer 6, WARNING only, exit 0) |
| 78 | E_DATA_EXISTS | T361 (import pre-check) |
| 79 | E_RESTORE_PARTIAL | T361 (import mid-sequence failure) |

---

## 9. Key Design Decisions (from consensus + spec)

1. **T310 hard dependency**: T342 implements the guard. Remove once T310 is on main.
2. **tar.gz format**: Node `tar` package only (ADR-010 compliant, no native bindings).
3. **manifest.json FIRST** in tar: T347 enforces; T363 relies on for < 100ms inspect.
4. **Argon2id + AES-256-GCM**: ADR-010 requires pure-JS/WASM. T345 raises flag if no compliant library exists.
5. **A/B regenerate-and-compare**: T352 regenerators MUST NOT call `cleo init` as child process.
6. **5-category classification**: identical → machine-local → user-intent → project-identity → auto-detect → unknown. T354 implements precedence order.
7. **Abort-with-force**: T361 pre-check enforces; `--force` bypasses but A/B still runs.
8. **Bundled JSON Schema**: T343 creates the asset; T350 validates against it without network access.

---

## 10. Summary Statistics

| Metric | Value |
|--------|-------|
| Total subtasks | 15 |
| Waves | 6 |
| Critical path length | 7 tasks |
| Parallel-dispatchable at peak | 4 (Wave 4) |
| Wave 0 tasks (foundational) | 3 |
| Wave 4 tasks (CLI verbs) | 4 |
| New source files | 10 |
| Modified source files | 4 (backup.ts, restore.ts, + T357 extends 2 existing) |
| New test files | 8 |
| Integration test scenarios | 13 (spec §8.2) |
| Exit codes defined | 10 (70-79 range) |
| T310 dependency documented | yes (T342, spec cross-ref, this doc §cross-epic) |
