---
title: "CLEO TypeScript Migration Doctrine"
version: "1.0.0"
status: "stable"
created: "2026-02-12"
updated: "2026-02-12"
task: "T4340"
authors: ["CLEO Development Team"]
---

# CLEO TypeScript Migration Doctrine

**Version**: 1.0.0
**Status**: STABLE
**Date**: 2026-02-12
**Task**: T4340
**Authority**: This document is the single source of truth for CLEO's TypeScript migration strategy. It synthesizes and aligns all existing specs, ADRs, and path-forward documents into one canonical narrative.

---

## 1. Migration Philosophy

### 1.1 Canonical Approach: MCP-First Then Hotspots

The canonical migration doctrine is **MCP-first, then hotspots**. This is NOT a broad rewrite of 133K LOC Bash into TypeScript. It is an incremental, evidence-gated strategy that delivers TypeScript value through the MCP server's native engine and expands scope only when parity is proven.

**Core tenets:**

1. **MCP server is the vehicle for TypeScript expansion.** New TypeScript capabilities are added as native operations inside the MCP engine, not as parallel CLI commands.
2. **CLI Bash is the authoritative behavior baseline.** Any native engine operation MUST produce output identical to the CLI for the same input. The CLI defines correctness.
3. **MCP native engine provides cross-platform standalone capability.** The engine runs anywhere Node.js runs (Linux, macOS, Windows) without requiring Bash or jq.
4. **Full CLI rewrite (T2021) is gated and separate scope.** T2021 remains an aspirational long-term target, blocked on T2112 (Bash stabilization). It is neither cancelled nor active. The MCP-first track operates independently.

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
| D1: TypeScript Port | Fulfilled incrementally via MCP native engine |
| D2: JSON/JSONL Storage | Unchanged -- JSON remains data format |
| D3: Manifest Validation | Unchanged -- four-gate architecture preserved |
| D4: Technical Debt Tracking | Unchanged -- independent of migration path |
| D5: Commander.js CLI | Deferred -- only relevant if T2021 activates |
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

### 3.4 Full CLI TypeScript Rewrite (T2021)

**Status**: Pending. Gated on T2112 (Bash stabilization, not passed).

T2021 is the broad epic for converting all 133K LOC Bash to TypeScript. It has 6 child tasks and covers the complete port including Commander.js CLI framework, all 65+ commands, and full test suite migration from BATS to Jest/Vitest. This is independent scope from the MCP-first track and remains deferred indefinitely.

---

## 4. Decision Authority

### 4.1 Independence of MCP-First Track

The MCP-first track operates **independently** of the T2021 gate (T2112). This is a final decision made on 2026-02-11. The rationale:

- T2112 (Bash stabilization) is a prerequisite for replacing Bash with TypeScript at the CLI layer
- The MCP native engine does NOT replace the Bash CLI -- it provides an alternative execution path for MCP consumers
- Adding native TypeScript operations to the MCP engine is additive and non-breaking
- CLI consumers are unaffected by any MCP engine changes

### 4.2 Hotspot Expansion Criteria

When the native engine achieves proven parity for a domain (validated by golden parity tests), that domain MAY be considered for further migration. The criteria:

1. **Golden parity passing**: Native output matches CLI output for all operations in the domain (diff-level equality)
2. **Cross-platform CI green**: Tests pass on Ubuntu, macOS, and Windows
3. **Performance parity**: Native operations meet or exceed CLI response times
4. **Lock contention safe**: Concurrent native + CLI access produces no data corruption

Only domains that pass ALL four criteria are eligible for expanded native coverage.

### 4.3 CLI Remains Authoritative

Regardless of native engine expansion, the Bash CLI remains the authoritative behavior baseline:

- **Bug in native engine**: Fix the native engine to match CLI behavior
- **Bug in CLI**: Fix the CLI first, then update native engine to match
- **New feature**: Implement in CLI first (or simultaneously), then add native support
- **Behavioral disagreement**: CLI wins. Native engine MUST conform.

This authority hierarchy is unconditional and does not change even after P3/P4 completion.

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

### 5.4 Full CLI Migration (Future, Gated)

- [ ] T2112 (Bash stabilization) passed
- [ ] T2021 epic activated and decomposed
- [ ] Commander.js CLI framework operational (ADR D5)
- [ ] All 65+ CLI commands ported with 100% exit code parity
- [ ] Full BATS test suite passing against TypeScript CLI
- [ ] 60-day parallel release period (both Bash and TypeScript CLIs available)
- [ ] Developer preference survey: >50% prefer TypeScript CLI

**Gate**: T2112 must pass. Separate epic, separate evaluation.

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

T2021 (Full TS Conversion)  ............................ GATED on T2112
  └── T2112 (Bash Stabilization) ...................... NOT PASSED

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
                                        │ (no dependency)
                                        │
                    ┌───────────────────────────────────────────┐
                    │         GATED (SEPARATE SCOPE)            │
                    │                                           │
                    │   T2112 (Bash Stabilization) ─── gate ──► │
                    │                                           │
                    │   T2021 (Full CLI TS Rewrite) ── blocked  │
                    │                                           │
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

The roadmap spec defines Phase 0 as "Foundation" and Phase 1 as "Validation". The current MCP-first work falls within Phase 0. The roadmap's Phase 1 validation gates (Nexus adoption, MCP adoption, strategic direction decision) remain applicable. This doctrine does not alter phase definitions or gate criteria.

The roadmap's Section 5 (Migration Path) describes an incremental Bash-to-TypeScript strategy with gates. This doctrine specifies the concrete vehicle (MCP native engine) and the concrete criteria (golden parity, CI matrix, lock safety). No contradiction exists.

### 7.3 Alignment with ADR D1-D6

ADR D1 recommended "CONDITIONAL GO for TypeScript port at 75% confidence." This doctrine fulfills D1 through the MCP-first path rather than the broad rewrite. The D1 conditions are being met incrementally:

- Exit code parity: Validated for native operations
- JSON Schema reuse: Ajv validation in `schema-validator.ts`
- Startup time: N/A for MCP server (persistent process)
- BATS parity: Golden tests (T4338) will validate
- Atomic file operations: `store.ts` implements equivalent safety

ADR D2-D6 are unchanged by this doctrine.

### 7.4 No Contradictions Found

After synthesis of all source documents, no contradictions were identified between this doctrine and the existing spec corpus.

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
| T4334 | EPIC: MCP Server Native TypeScript Engine | P0-P2 done, P3-P4 pending |
| T4333 | EPIC: Cross-Platform Standalone Mode | Done (v0.91.0) |
| T4344 | EPIC: lib/ Hierarchy Refactor (Track A) | Done (v0.93.0) |
| T4352 | EPIC: Manifest Hierarchy (Track B) | 9 tasks pending |
| T4332 | EPIC: CAAMP Integration | P0 done, 6 tasks pending |
| T4338 | P3: Golden Parity Tests | Pending |
| T4339 | P4: Feature-Flagged Rollout | Pending |
| T4340 | Migration Doctrine (this document) | Complete |
| T2021 | EPIC: Full TS Conversion | Gated on T2112 |
| T2112 | Bash Stabilization Gate | Not passed |

---

**Document Status**: STABLE
**Authority**: Canonical migration doctrine. Defers to `docs/concepts/vision.mdx` (immutable identity) and `docs/specs/PORTABLE-BRAIN-SPEC.md` (product contract) for product definition.
**Next Review**: After T4338 (P3 golden parity tests) completion.
