---
title: "CLEO TypeScript Migration Doctrine"
version: "2.0.0"
status: "stable"
created: "2026-02-12"
updated: "2026-02-13"
task: "T4340"
v2_epic: "T4454"
authors: ["CLEO Development Team"]
---

> **Note**: This document is a supporting reference under `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md`. For canonical strategic direction, see the Canonical Plan. This document provides detailed migration authority, convergence criteria, and engine inventory.

# CLEO TypeScript Migration Doctrine

**Version**: 2.0.0
**Status**: STABLE
**Date**: 2026-02-13
**Task**: T4340
**V2 Epic**: T4454
**Authority**: This document is the deep migration reference for CLEO's TypeScript transition. Global canonical strategy and decision authority are maintained in `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md`.

## Canonical Consolidation Notice (2026-02-13)

This doctrine remains authoritative for migration detail, convergence criteria, and engine inventory. For cross-document conflict resolution and final strategic/decision status, use:

- `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md`

---

## 1. Migration Philosophy

### 1.1 Canonical Approach: Both Tracks Parallel (v2.0.0)

**UPDATE (2026-02-13)**: The canonical migration doctrine has evolved from "MCP-first then hotspots" to **both tracks parallel**. The MCP-first approach validated TypeScript viability (29 native ops, cross-platform standalone). This success, combined with LAFS adoption requirements, justifies activating the full CLI rewrite (T2021) in parallel.

**Core tenets (v2.0.0):**

1. **Two parallel tracks converge to one system.** Track MCP expands the native engine (29 to 123 ops). Track CLI (T2021, now ungated) builds a full Commander.js CLI. Both share a common TypeScript core.
2. **LAFS is foundational.** Every command across both tracks MUST return LAFS-compliant envelopes. Machine-readable by default, human-readable opt-in.
3. **CAAMP is the canonical package manager.** Skills, MCP servers, and agent instructions are managed through @cleocode/caamp v0.3.0 (88 exports).
4. **CLI Bash remains the behavior baseline during transition.** Golden parity tests validate TypeScript output matches Bash output. Authority transfers to TypeScript after convergence.
5. **T2021 gate (T2112) is removed.** The MCP-first track proved TypeScript works. The shared core strategy means CLI work directly benefits MCP and vice versa.
6. **Convergence merges both tracks.** When both tracks reach feature parity, CLI and MCP become thin wrappers over the shared TypeScript core. Bash CLI enters maintenance then deprecation.

**Full V2 architecture**: See `docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md` (T4454).

### 1.2 Why MCP-First

The MCP-first approach was validated by the delivery of T4334 (v0.91.0). Evidence supporting this doctrine:

- **Additive risk profile**: Native operations are added alongside CLI, not replacing it. CLI fallback is always available.
- **No gate dependency**: MCP-first proceeds without waiting for T2112 Bash stabilization.
- **Immediate cross-platform value**: Windows developers can use CLEO through MCP without a Unix shell.
- **94% token reduction**: 2 MCP tools vs 65 CLI commands in agent context.
- **Incremental proof**: Each native operation is individually testable against CLI golden output.

### 1.3 Relationship to ADR Decisions (D1-D6)

This doctrine fulfills ADR decision D1 (Conditional GO for TypeScript, 75% confidence) through the incremental MCP path rather than the broad rewrite originally envisioned. The remaining ADR decisions remain valid:

| ADR | Status Under This Doctrine |
|-----|---------------------------|
| D1: TypeScript Port | **FULL GO** -- both tracks active (MCP engine + CLI rewrite) |
| D2: JSON/JSONL Storage | Unchanged -- JSON remains data format |
| D3: Manifest Validation | Unchanged -- four-gate architecture preserved |
| D4: Technical Debt Tracking | Unchanged -- independent of migration path |
| D5: Commander.js CLI | **ACTIVATED** -- T2021 ungated, Commander.js CLI proceeding |
| D6: Multi-Agent Consensus | Unchanged -- protocol layer, not runtime |

---

## 2. What Is Already Done

### 2.1 Completed Components Matrix

| Component | Status | Task | Version | Notes |
|-----------|--------|------|---------|-------|
| P0: Capability Matrix & Mode Detection | Complete | T4335 | v0.91.0 | `capability-matrix.ts` defines native vs CLI routing |
| P1: Native Engine Core (11 modules) | Complete | T4336 | v0.91.0 | store, schema-validator, validation-rules, id-generator, task-engine, session-engine, config-engine, init-engine, capability-matrix, caamp-adapter, caamp-verify |
| P2: Dual-Mode Domain Routing | Complete | T4337 | v0.91.0 | Auto-detection: native when CLI unavailable, transparent fallback |
| CAAMP v0.3.0 Integration (P0 adapter) | Complete | T4332 (partial) | v0.93.0 | caamp-adapter.ts provides 88 exports; Node engine bumped to >=20 |
| lib/ Hierarchy Refactor (Track A) | Complete | T4344 | v0.93.0 | 80 flat scripts reorganized into 9 semantic subdirectories |
| Cross-Platform Standalone Epic | Complete | T4333 | v0.91.0 | MCP server operates without Bash on any Node.js platform |

### 2.2 Native Engine Coverage (v0.93.1)

The native TypeScript engine covers 29 operations across 4 domains:

| Domain | Native Operations | CLI-Only Operations |
|--------|-------------------|---------------------|
| **Tasks (query)** | show, get, list, find, exists, manifest | next, depends, deps, stats, export, history, lint, batch-validate, tree, blockers, analyze, relates |
| **Tasks (mutate)** | add, create, update, complete, delete, archive | restore, unarchive, import, reorder, reparent, promote, reopen, relates.add |
| **Session (query)** | status, list, show, focus-show, focus.get | history, stats |
| **Session (mutate)** | start, end, focus-set, focus.set, focus-clear, focus.clear | resume, switch, archive, cleanup, suspend, gc |
| **System** | version, config, config.get, config.set, init (+ doctor as hybrid) | context, metrics, health, diagnostics, stats, help, dash, roadmap, labels, compliance, log, archive-stats, sequence, job.status, job.list, backup, restore, migrate, cleanup, audit, sync, job.cancel, safestop, uncancel |
| **Validate** | schema | protocol, task, manifest, output, compliance.summary, compliance.record, test.run, test.coverage, test.status, batch-validate |
| **Orchestrate** | (none) | status, next, ready, analyze, context, waves, skill.list, startup, spawn, validate, parallel.start, parallel.end, check, skill.inject |
| **Research** | (none) | show, list, query, pending, stats, manifest.read, inject, link, manifest.append, manifest.archive, compact, validate |
| **Lifecycle** | (none) | check, status, history, gates, prerequisites, progress, skip, reset, gate.pass, gate.fail |
| **Release** | (none) | prepare, changelog, commit, tag, push, gates.run, rollback |

**Summary**: 29 native + 1 hybrid out of ~130 total operations.

### 2.3 Engine Module Inventory

| Module | Purpose | Exports |
|--------|---------|---------|
| `store.ts` | Atomic file I/O, locking, backup rotation | readJsonFile, writeJsonFileAtomic, withLock, withFileLock, withMultiLock, isProjectInitialized, resolveProjectRoot, getDataPath, listBackups |
| `schema-validator.ts` | Ajv-based JSON Schema validation | validateSchema, validateTask, clearSchemaCache |
| `validation-rules.ts` | Anti-hallucination semantic rules | validateTitleDescription, validateTimestamps, validateIdUniqueness, validateNoDuplicateDescription, validateHierarchy, validateStatusTransition, validateNewTask, hasErrors |
| `id-generator.ts` | Sequential T#### ID generation | generateNextId, generateNextIdFromSet, collectAllIds, findHighestId, isValidTaskId |
| `task-engine.ts` | Task CRUD operations | taskShow, taskList, taskFind, taskExists, taskCreate, taskUpdate, taskComplete, taskDelete, taskArchive |
| `session-engine.ts` | Session lifecycle | sessionStatus, sessionList, sessionShow, focusGet, focusSet, focusClear, sessionStart, sessionEnd |
| `config-engine.ts` | Configuration read/write | configGet, configSet |
| `init-engine.ts` | Project initialization | initProject, isAutoInitEnabled, ensureInitialized, getVersion |
| `capability-matrix.ts` | Operation routing decisions | getOperationMode, canRunNatively, requiresCLI, getNativeOperations, generateCapabilityReport, getCapabilityMatrix |
| `caamp-adapter.ts` | Provider registry, MCP config, injection | providerList, providerGet, providerDetect, providerInstalled, providerCount, registryVersion, mcpList, mcpListAll, mcpInstall, mcpRemove, mcpConfigPath, injectionCheck, injectionCheckAll, injectionUpdate, injectionUpdateAll, caampResolveAlias, caampBuildServerConfig, caampGenerateInjectionContent, caampGetInstructionFiles |
| `caamp-verify.ts` | CAAMP installation verification | (internal) |

---

## 3. What Is Still Pending

### 3.1 MCP Native Engine (T4334) Remaining Phases

| Phase | Task | Status | Priority | Description |
|-------|------|--------|----------|-------------|
| P3 | T4338 | Pending | Medium | Golden parity tests (native vs CLI output diff), lock contention tests, cross-platform CI matrix (Ubuntu, macOS, Windows). Gate criteria for enabling auto mode by default. |
| P4 | T4339 | Pending | Low | Feature-flagged rollout: Alpha (opt-in) -> Beta (auto default) -> GA. Documentation, npm README, MCP server listing. Depends on T4337 (complete). |

### 3.2 Track B: Manifest Hierarchy (T4352)

**Status**: 9 tasks pending. Depends on Track A completion (done).

| Phase | Tasks | Status | Description |
|-------|-------|--------|-------------|
| Phase 1: Schema Extension | T4353, T4354, T4355, T4356, T4358 | Pending | Add hierarchy fields to MANIFEST.jsonl, backfill entries, tree invariant validation |
| Phase 2: Tree-Aware Commands | T4361, T4363, T4364, T4365 | Pending | `cleo research tree`, subtree queries, rollup aggregation, performance benchmarks |

### 3.3 CAAMP Integration (T4332)

**Status**: P0 adapter done (v0.93.0). 6 tasks remaining.

| Task | Status | Description |
|------|--------|-------------|
| T4341 | Pending | Publish @cleocode/caamp v0.2.0 to npm (HARD BLOCKER for formal dependency) |
| T4342 | Pending | Add @cleocode/caamp ^0.2.0 as formal mcp-server dependency |
| T4343 | Pending | Evaluate extracting native engine modules into caamp |
| T4367 | Pending | Create CAAMP adapter layer for P0 provider/injection functions |
| T4368 | Pending | Add providers domain to MCP gateway |
| T4369 | Pending | Bump mcp-server Node.js engine from >=18 to >=20 |

**Note**: CAAMP v0.3.0 is already installed and operational in the MCP server via direct dependency. T4341 (npm publish) is a formal registry blocker, not a functional blocker.

### 3.4 Full CLI TypeScript Rewrite (T2021 -- NOW UNGATED)

**Status**: **ACTIVE**. Gate T2112 removed (2026-02-13). Superseded by T4454.

T2021 is now superseded by T4454 (EPIC: CLEO V2 Full TypeScript System, LAFS-native). The original T2021 scope (133K LOC Bash to TypeScript) is being executed through T4454's phased approach with 22 child tasks across 4 CLI phases and 5 MCP expansion tasks. LAFS conformance is a foundational requirement. CAAMP is the canonical package manager. Both tracks (MCP engine expansion + CLI rewrite) run in parallel and converge when parity is achieved.

**Full architecture**: `docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md`

---

## 4. Decision Authority

### 4.1 Both Tracks Parallel (Updated 2026-02-13)

Both tracks now operate in parallel. The T2112 gate on T2021 is removed. This is a final decision made on 2026-02-13. The rationale:

- The MCP-first track proved TypeScript viability with 29 native operations running cross-platform
- LAFS adoption requires consistent output format across all transports -- most efficiently achieved with a shared TypeScript core
- The shared core strategy means CLI work directly benefits MCP and vice versa
- CAAMP v0.3.0 is already operational in the MCP server, providing the package management foundation
- T4454 supersedes T2021 with a structured 4-phase CLI approach and 5 parallel MCP expansion tasks

### 4.2 Hotspot Expansion Criteria

When the native engine achieves proven parity for a domain (validated by golden parity tests), that domain MAY be considered for further migration. The criteria:

1. **Golden parity passing**: Native output matches CLI output for all operations in the domain (diff-level equality)
2. **Cross-platform CI green**: Tests pass on Ubuntu, macOS, and Windows
3. **Performance parity**: Native operations meet or exceed CLI response times
4. **Lock contention safe**: Concurrent native + CLI access produces no data corruption

Only domains that pass ALL four criteria are eligible for expanded native coverage.

### 4.3 CLI Authority (Transitional)

**During migration**: The Bash CLI remains the authoritative behavior baseline:

- **Bug in native engine**: Fix the native engine to match CLI behavior
- **Bug in CLI**: Fix the CLI first, then update native engine to match
- **New feature**: Implement in CLI first (or simultaneously), then add native support
- **Behavioral disagreement**: CLI wins. Native engine MUST conform.

**After convergence**: Authority transfers to the TypeScript system. The shared TypeScript core becomes the single source of truth. The Bash CLI enters maintenance mode (critical fixes only) then deprecation. This authority transfer occurs only after all convergence criteria in CLEO-V2-ARCHITECTURE-SPEC.md section 7.2 are met.

---

## 5. Exit Criteria for Each Phase

### 5.1 MCP Native Alpha (DONE)

- [x] Manual opt-in via `MCP_EXECUTION_MODE=native`
- [x] Basic task CRUD operations native
- [x] Session operations native
- [x] Capability matrix published
- [x] Dual-mode routing operational
- [x] Cross-platform standalone mode functional

**Shipped**: v0.91.0

### 5.2 MCP Native Beta

- [ ] Auto-detection mode enabled by default
- [ ] P3 golden parity tests passing for all 29 native operations
- [ ] Cross-platform CI matrix: Ubuntu + macOS + Windows
- [ ] Lock contention tests passing (concurrent native + CLI writes)
- [ ] Performance benchmarks: native operations within 10% of CLI

**Gate**: T4338 completion

### 5.3 MCP Native GA

- [ ] All platforms green in CI for 30 consecutive days
- [ ] Mixed-writer safety validated (native + CLI writing to same data files)
- [ ] Documentation complete: migration guide, capability matrix docs, troubleshooting
- [ ] Feature flag removed: native mode is default for all MCP consumers
- [ ] Zero P0 bugs in 30-day bake period

**Gate**: T4339 completion

### 5.4 Full CLI Migration (ACTIVE -- T4454)

- [x] T2112 gate removed (2026-02-13)
- [x] T4454 epic created and decomposed (22 tasks, 4 CLI phases + 5 MCP expansion)
- [ ] Commander.js CLI framework operational (ADR D5, T4455)
- [ ] LAFS-compliant output format across all commands (T4456)
- [ ] All 65+ CLI commands ported with 100% exit code parity (T4460-T4468)
- [ ] LAFS conformance certification passing (T4469)
- [ ] CAAMP full API integration (T4470)
- [ ] Cross-platform CI green on Ubuntu, macOS, Windows (T4471)
- [ ] 60-day parallel release period (both Bash and TypeScript CLIs available)
- [ ] Developer preference survey: >50% prefer TypeScript CLI

**Gate**: T2112 gate REMOVED. T4454 is the active epic. See `docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md` for full architecture.

---

## 6. Relationship Map

### 6.1 Epic and Task Hierarchy

```
T4333 (Cross-Platform Standalone Mode)  ................ DONE (v0.91.0)
  └── Related: T4334 (canonical MCP Native Engine epic)

T4334 (MCP Native Engine)  ............................. P0-P2 DONE, P3-P4 PENDING
  ├── T4335 (P0: Capability Matrix & Mode Detection) ... DONE
  ├── T4336 (P1: Native Engine Core, 11 modules) ...... DONE
  ├── T4337 (P2: Dual-Mode Domain Routing) ............ DONE
  ├── T4338 (P3: Golden Parity Tests + CI) ............ PENDING
  └── T4339 (P4: Feature-Flagged Rollout) ............. PENDING

T4344 (Track A: lib/ Hierarchy Refactor)  .............. DONE (v0.93.0)
  ├── T4345 (Migration script) ........................ DONE
  ├── T4346 (git mv into subdirectories) .............. DONE
  ├── T4347 (Update source references) ................ DONE
  ├── T4348 (lib/README.md guide) ..................... DONE
  ├── T4349 (BATS test verification) .................. DONE
  ├── T4350 (Documentation updates) ................... DONE
  └── T4351 (Version bump + changelog) ................ DONE

T4352 (Track B: Manifest Hierarchy)  ................... 9 tasks PENDING
  ├── Phase 1: T4353, T4354, T4355, T4356, T4358
  └── Phase 2: T4361, T4363, T4364, T4365

T4332 (CAAMP Integration)  ............................. P0 adapter DONE, 6 tasks PENDING
  ├── T4341 (npm publish) ............................. PENDING (blocker)
  ├── T4342 (formal dependency) ....................... PENDING
  ├── T4343 (module extraction evaluation) ............ PENDING
  ├── T4367 (adapter layer) ........................... PENDING
  ├── T4368 (providers MCP domain) .................... PENDING
  └── T4369 (Node >=20 bump) ......................... PENDING

T4454 (CLEO V2 Full TypeScript System, LAFS-native) .... ACTIVE (22 tasks)
  ├── Phase 1: T4455-T4458 (Foundation) .............. PENDING
  ├── Phase 2: T4460-T4463 (Core Commands) ........... PENDING (depends P1)
  ├── Phase 3: T4464-T4468 (Feature Parity) .......... PENDING (depends P2)
  ├── Phase 4: T4469-T4472 (Integration) ............. PENDING (depends P3)
  └── MCP Track: T4474-T4478 (Engine Expansion) ...... PENDING (parallel)

T2021 (Full TS Conversion)  ............................ SUPERSEDED by T4454
  └── T2112 (Bash Stabilization) ...................... GATE REMOVED

T4340 (This Document: Migration Doctrine)
```

### 6.2 Dependency Flow

```
                    ┌─────────────────────────────────────────────┐
                    │         INDEPENDENT TRACKS                  │
                    │                                             │
  Track A (DONE)    │   MCP Native Engine        CAAMP            │
  T4344             │   T4334                    T4332            │
  lib/ refactor     │   P0-P2 done               P0 adapter done │
       │            │   P3-P4 pending            6 tasks pending  │
       │            │                                             │
       ▼            │                                             │
  Track B           │                                             │
  T4352             │                                             │
  manifest          │                                             │
  hierarchy         │                                             │
  (9 pending)       │                                             │
                    └─────────────────────────────────────────────┘
                                        │
                                        │ (feeds into)
                                        │
                    ┌───────────────────────────────────────────┐
                    │    V2: BOTH TRACKS PARALLEL (T4454)       │
                    │                                           │
                    │  Track CLI    │    Track MCP Expansion    │
                    │  T4455-T4472  │    T4474-T4478            │
                    │  (17 tasks)   │    (5 tasks, parallel)    │
                    │               │                           │
                    │  T2021 ────── SUPERSEDED ──► T4454        │
                    │  T2112 ────── GATE REMOVED                │
                    └───────────────────────────────────────────┘
```

### 6.3 Spec Relationship

```
docs/concepts/vision.mdx                    (immutable identity)
    │
    ├── docs/specs/PORTABLE-BRAIN-SPEC.md   (product contract)
    │
    ├── docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md  (phase execution plan)
    │       │
    │       └── Phase 0 Foundation ◄── this doctrine operates here
    │
    ├── docs/specs/CLEO-PATH-FORWARD-2026Q1.md     (Q1 2026 decisions)
    │       │
    │       └── MCP-first doctrine defined ◄── this document codifies
    │
    ├── claudedocs/CLEO-V2-ARCHITECTURE-DECISIONS.md  (ADR D1-D6)
    │       │
    │       └── D1 fulfilled incrementally via MCP-first
    │
    └── docs/specs/CLEO-MIGRATION-DOCTRINE.md       (THIS DOCUMENT)
            │
            └── Single source of truth for migration strategy
```

---

## 7. Consistency Verification

### 7.1 Alignment with vision.mdx

The interface-layer architecture described in `vision.mdx` defines:

- **CLI (Bash baseline)**: authoritative runtime behavior and deterministic enforcement
- **MCP (strategic interface)**: provider-neutral integration surface for AI tooling
- **All interfaces MUST preserve the same memory model, lifecycle guarantees, and provenance invariants**

This doctrine is **fully consistent**. The MCP native engine preserves CLI authority, implements the same validation layers, and provides the MCP strategic interface. No identity or pillar is redefined.

### 7.2 Alignment with Strategic Roadmap

The roadmap phase structure remains valid (Phase 0-3.5, evidence gates, risk governance). However, parts of roadmap migration ordering are historical after 2026-02-13.

Canonical reconciliation:

- Keep roadmap for phase definitions, metrics, and governance details
- Use canonical plan + doctrine for active migration ordering and authority state
- Treat MCP-first sequencing language in older sections as historical context, superseded by both-tracks-parallel execution

### 7.3 Alignment with ADR D1-D6

ADR D1 recommended "CONDITIONAL GO for TypeScript port at 75% confidence." This doctrine fulfills D1 through the MCP-first path rather than the broad rewrite. The D1 conditions are being met incrementally:

- Exit code parity: Validated for native operations
- JSON Schema reuse: Ajv validation in `schema-validator.ts`
- Startup time: N/A for MCP server (persistent process)
- BATS parity: Golden tests (T4338) will validate
- Atomic file operations: `store.ts` implements equivalent safety

ADR D2-D6 are unchanged by this doctrine.

### 7.4 Contradictions Reconciled by Authority Hierarchy

Legacy wording differences exist across source documents (especially around sequential vs parallel migration ordering). They are resolved by authority hierarchy and chronology:

1. `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md` (active strategy and decision state)
2. This doctrine + `docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md` (migration and architecture detail)
3. Older roadmap/ADR phrasing retained for provenance

---

## 8. References

### 8.1 Source Documents

| Document | Path | Purpose |
|----------|------|---------|
| Vision Charter | `docs/concepts/vision.mdx` | Immutable product identity |
| Strategic Roadmap | `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` | Phase execution plan |
| Path Forward Q1 2026 | `docs/specs/CLEO-PATH-FORWARD-2026Q1.md` | Q1 2026 decisions |
| Architecture Decisions | `claudedocs/CLEO-V2-ARCHITECTURE-DECISIONS.md` | ADR D1-D6 |
| Portable Brain Spec | `docs/specs/PORTABLE-BRAIN-SPEC.md` | Canonical product contract |
| MCP Server Spec | `docs/specs/MCP-SERVER-SPECIFICATION.md` | Two-tool CQRS gateway |
| MCP Agent Interaction | `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` | MCP vs CLI delineation |

### 8.2 Code Artifacts

| Artifact | Path | Purpose |
|----------|------|---------|
| Capability Matrix | `mcp-server/src/engine/capability-matrix.ts` | Native vs CLI routing truth |
| Engine Barrel Export | `mcp-server/src/engine/index.ts` | Engine API surface |
| CAAMP Adapter | `mcp-server/src/engine/caamp-adapter.ts` | Provider registry bridge |

### 8.3 Key Tasks

| Task | Title | Status |
|------|-------|--------|
| T4454 | EPIC: CLEO V2 Full TypeScript System (LAFS-native) | **ACTIVE** (22 tasks) |
| T4334 | EPIC: MCP Server Native TypeScript Engine | P0-P2 done, P3-P4 pending |
| T4333 | EPIC: Cross-Platform Standalone Mode | Done (v0.91.0) |
| T4344 | EPIC: lib/ Hierarchy Refactor (Track A) | Done (v0.93.0) |
| T4352 | EPIC: Manifest Hierarchy (Track B) | 9 tasks pending |
| T4332 | EPIC: CAAMP Integration | P0 done, 6 tasks pending |
| T4338 | P3: Golden Parity Tests | Pending |
| T4339 | P4: Feature-Flagged Rollout | Pending |
| T4340 | Migration Doctrine (this document) | Updated v2.0.0 |
| T2021 | EPIC: Full TS Conversion | Superseded by T4454 |
| T2112 | Bash Stabilization Gate | Gate removed |

---

**Document Status**: STABLE (v2.0.0)
**Authority**: Canonical migration doctrine. Defers to `docs/concepts/vision.mdx` (immutable identity) and `docs/specs/PORTABLE-BRAIN-SPEC.md` (product contract) for product definition.
**V2 Architecture**: `docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md` (T4454)
**Changes from v1.0.0**:
1. Migration strategy evolved from "MCP-first then hotspots" to "both tracks parallel"
2. T2021 ungated -- T2112 gate removed, T4454 supersedes T2021
3. LAFS (LLM-Agent-First Specification) made foundational constraint
4. CAAMP (@cleocode/caamp v0.3.0) designated canonical package manager
5. Convergence plan added: CLI + MCP merge into shared TypeScript core
6. ADR D1 upgraded from "fulfilled incrementally" to "FULL GO"
7. ADR D5 upgraded from "deferred" to "ACTIVATED"
8. CLI authority made transitional (transfers to TypeScript after convergence)
**Next Review**: After T4454 Phase 1 foundation tasks complete.
