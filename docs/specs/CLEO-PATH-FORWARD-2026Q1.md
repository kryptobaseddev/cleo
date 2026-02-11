---
title: "CLEO Path Forward: Q1 2026"
version: "1.0.0"
status: "stable"
created: "2026-02-11"
updated: "2026-02-11"
authors: ["CLEO Development Team"]
task: "T4334"
---

# CLEO Path Forward: Q1 2026

**Version**: 1.0.0
**Status**: STABLE
**Date**: 2026-02-11
**Context**: Post-v0.91.0 (MCP Native Engine release)

---

## 1. Completed Foundation

### 1.1 MCP Native TypeScript Engine (T4334)

The MCP server now operates as a standalone cross-platform engine, removing the hard dependency on Bash and Unix utilities for agent consumers. This was shipped as v0.91.0.

**What was built:**

- **Native TypeScript engine** with 29 operations running cross-platform without Bash
- **Two-tool CQRS gateway**: `cleo_query` (reads) and `cleo_mutate` (writes) across 8 domains (tasks, session, orchestrate, research, lifecycle, validate, release, system)
- **Hybrid routing**: native TypeScript for core operations, transparent CLI fallback for advanced operations
- **Capability matrix** (`mcp-server/src/engine/capability-matrix.ts`) defining native vs CLI-backed operations
- **Structured error contracts** with `error.fix` suggestions and `error.alternatives` arrays

**Native operation coverage (v0.91.0):**

| Domain | Native Operations |
|--------|-------------------|
| Tasks (query) | show, get, list, find, exists, manifest |
| Tasks (mutate) | add, create, update, complete, delete, archive |
| Session (query) | status, list, show, focus-show, focus.get |
| Session (mutate) | start, end, focus-set, focus.set, focus-clear, focus.clear |
| System | version, config, config.get, config.set, init |
| Validate | schema |

**What it enables:**

- Any MCP-compatible agent (Claude Code, Cursor, Windsurf, etc.) can use CLEO without Bash
- Cross-platform operation: Windows, macOS, Linux via Node.js
- 94% token reduction for agent context (2 MCP tools vs 65 CLI commands)
- Foundation for incremental TypeScript expansion independent of full Bash rewrite

### 1.2 v0.91.0 Release Details

- **Version**: 0.91.0
- **Release type**: Feature release (MCP native engine)
- **Breaking changes**: None (additive only, CLI fully preserved)
- **Node.js requirement**: >=18

---

## 2. Canonical Migration Doctrine

### 2.1 MCP-First Then Hotspots

The canonical migration doctrine is: **MCP-first, then hotspots** -- NOT the broad T2021 Bash-to-TypeScript rewrite.

This means:

1. The MCP server is the primary vehicle for TypeScript expansion
2. TypeScript is added incrementally through the MCP native engine
3. Hotspot migration (sessions.sh, migrate.sh, orchestrator-startup.sh) proceeds through MCP, not through a parallel CLI rewrite
4. Each native operation added to the MCP engine reduces Bash surface area

### 2.2 Relationship Between T2021 and Incremental Work

| Aspect | T2021 (Full Rewrite) | MCP-First (Active) |
|--------|---------------------|--------------------|
| **Status** | Aspirational target, gated on T2112 | Active, canonical doctrine |
| **Scope** | Replace all 133K LOC Bash with TypeScript | Incrementally nativize MCP operations |
| **Gate** | T2112 (Bash stabilization) must pass | No gate -- proceeds independently |
| **Risk** | High (regression, test rewrite) | Low (additive, CLI preserved) |
| **Timeline** | Deferred indefinitely | Continuous |

T2021 remains as a long-term aspirational target. It is NOT cancelled, but it is NOT the active path. The MCP-first approach delivers TypeScript value immediately without waiting for T2112 Bash stabilization.

### 2.3 What Proceeds Independently

The following work proceeds without any dependency on T2021 or T2112:

- Adding native TypeScript operations to the MCP engine
- Track A: lib/ hierarchy refactor (Bash reorganization)
- Track B: manifest hierarchy and query engine
- CAAMP integration for shared TypeScript infrastructure
- Progressive disclosure for agent injection

---

## 3. Execution Tracks (Active)

### 3.1 Track A: lib/ Hierarchy Refactor (T4344)

**Epic**: T4344
**Priority**: High | **Size**: Large
**Status**: Ready for execution (immediate next work)

**What**: Reorganize `lib/` from 80 flat shell scripts into 7 semantic subdirectories:

```
lib/
  core/         # exit-codes, error-json, output-format, logging, config
  validation/   # schema-validation, compliance, protocol-validation
  session/      # session-*.sh, context-*.sh
  tasks/        # task-*.sh, dependency-check, hierarchy, focus
  skills/       # skill-*.sh, agent-registry, orchestrator-spawn
  data/         # atomic-write, backup, cache, file-ops, migrate
  ui/           # flags, help, prompts, completion-generation
  rcsd/         # (already hierarchical - no changes)
```

**Why**: Research T2748 recommends this with 0.85 confidence as the highest-ROI architectural improvement. Reduces cognitive load by 70%, establishes clear module boundaries, and provides the organizational foundation for any future TypeScript migration of individual modules.

**Task decomposition** (7 tasks, sequential):

| Task | Title | Size | Depends |
|------|-------|------|---------|
| T4345 | Create migration script for lib/ import path updates | Medium | -- |
| T4346 | Move lib/ files into subdirectories with git mv | Medium | T4345 |
| T4347 | Update all source references across codebase | Medium | T4346 |
| T4348 | Create lib/README.md navigation guide | Small | T4346 |
| T4349 | Run full BATS test suite verification | Small | T4347 |
| T4350 | Update CLAUDE.md and developer documentation | Small | T4349 |
| T4351 | Version bump and changelog for lib/ refactor | Small | T4350 |

### 3.2 Track B: Manifest Hierarchy + Path Query Engine (T4352)

**Epic**: T4352
**Priority**: Medium | **Size**: Large
**Status**: Queued (starts after Track A)

**What**: Extend MANIFEST.jsonl with hierarchical fields (Phase 1) and build tree-aware query commands (Phase 2). This is the foundation for the memory-trees architecture.

**Why**: Enables structured research memory organized as trees rather than flat lists. Subtree queries, path-based navigation, and rollup aggregation unlock Phase 1/2 of the memory-trees vision.

**Phase 1 -- Manifest Schema Extension** (5 tasks: T4353-T4358):
- Design manifest hierarchy schema extension
- Implement hierarchy field writers
- Backfill existing entries
- Add tree invariant validation
- Phase 1 testing

**Phase 2 -- Tree-Aware Commands** (4 tasks: T4361-T4365):
- `cleo research tree` command
- `cleo research query --path` for subtree queries
- `cleo research aggregate` for rollup statistics
- Performance benchmarks and go/no-go validation

**Go/No-Go Gates**:
- Phase 1 to Phase 2: Zero data corruption, validation overhead <50ms
- Phase 2 to Phase 3-4: Subtree queries 10x faster than linear at 1K entries

**Dependency**: Track B is conditional on Track A success. The lib/ reorganization establishes the module boundaries that manifest hierarchy code will live within.

---

## 4. MCP-First Agent Architecture

### 4.1 Progressive Disclosure Model

Agent context injection follows a four-level progressive disclosure model, delivering context in layers rather than loading the full protocol stack for every agent:

| Level | Budget | Target | Content |
|-------|--------|--------|---------|
| **0: Minimal Entry** | ~200 tokens | All agents | Two MCP tools, 6 quick-reference examples |
| **1: Domain Discovery** | ~500 tokens | Multi-step workflows | Available operations per domain |
| **2: Operation-Specific** | ~2-5K tokens | On error or request | Parameter schemas, error contracts, examples |
| **3: Protocol-Aware** | ~5-15K tokens | Orchestrators only | Full RCSD lifecycle, manifest requirements |

**Impact**: At 10+ subagent spawns per session, progressive disclosure saves ~45,000 tokens compared to the current injection model, freeing context for actual work.

### 4.2 Interface Delineation

- **MCP tools** (`cleo_query` / `cleo_mutate`): Primary entry point for all AI agent consumers. Structured JSON in/out, cross-platform, 2-tool surface.
- **CLI** (`cleo` / `ct`): Primary entry point for human developers. Rich terminal formatting, scriptable, Bash-native.
- **Both converge** on the same business logic, validation rules, and data files.

### 4.3 Reference Specification

Full details: `docs/specs/MCP-AGENT-INTERACTION-SPEC.md`

This specification covers MCP-first principle rationale, capability matrix, progressive disclosure architecture, entry point delineation, error handling contracts, and the agent injection evolution plan.

---

## 5. CAAMP Integration Path

### 5.1 Current State

`@cleocode/caamp` is CLEO's companion library for AI agent provider management. It provides MCP config management, provider registry (46 providers), skills management, and instruction injection APIs.

**Blocker**: v0.2.0 is tagged and released on GitHub but NOT published to npm. Only v0.1.0 exists on the registry. This blocks integration with the MCP server.

### 5.2 Integration Plan

| Task | Title | Status | Depends |
|------|-------|--------|---------|
| T4341 | Publish @cleocode/caamp v0.2.0 to npm | Pending | -- |
| T4342 | Add @cleocode/caamp ^0.2.0 dependency to mcp-server | Pending | T4341 |
| T4343 | Evaluate extracting T4334 native engine modules into caamp | Pending | T4334, T4342 |

### 5.3 Shared TypeScript Foundation Opportunity

The MCP native engine (T4334) built several modules that overlap with CAAMP capabilities:

| MCP Engine Module | CAAMP Equivalent | Extraction Candidate |
|-------------------|------------------|---------------------|
| `config-engine.ts` | `readConfig`/`writeConfig` (JSONC/YAML/TOML) | Yes |
| `schema-validator.ts` | Ajv-based validation | Yes |
| `store.ts` (atomic file ops) | No equivalent | Yes (contribute upstream) |

Extracting shared modules into CAAMP creates a unified TypeScript foundation serving both the MCP server and CAAMP's provider management, reducing duplication across the ecosystem.

### 5.4 Node.js Engine Note

CAAMP v0.2.0 requires Node >=20. The MCP server currently requires Node >=18. Adding CAAMP as a dependency requires bumping the MCP server engine to >=20.

---

## 6. Dependencies and Gates

### 6.1 T2112 Gate Status

**T2112** (Bash stabilization) is the gate that controls the full T2021 TypeScript rewrite. Its current status:

- T2112 is NOT passed
- T2021 (full rewrite) remains blocked on T2112
- **Independent work proceeds without T2112**: MCP native engine expansion, Track A, Track B, CAAMP integration, progressive disclosure

The MCP-first doctrine explicitly decouples incremental TypeScript progress from T2112. This gate only blocks the broad rewrite, not incremental improvement.

### 6.2 Dependency Chain

```
T4341 (CAAMP npm publish)
  └── T4342 (CAAMP integration)
        └── T4343 (shared module extraction)

T4344 (Track A: lib/ hierarchy) -- independent, immediate
  └── T4352 (Track B: manifest hierarchy) -- starts after Track A

T2112 (Bash stabilization) -- NOT blocking current work
  └── T2021 (full TS rewrite) -- deferred, aspirational
```

### 6.3 Strategic Roadmap Gate Alignment

Per `CLEO-STRATEGIC-ROADMAP-SPEC.md`, the current work falls within **Phase 0: Foundation**. The Phase 1 validation gates (Nexus adoption, MCP adoption, strategic direction decision) remain as defined. Track A and Track B are Phase 0 work that improves the foundation before validation gates are evaluated.

---

## 7. Modern 2026 Vision Alignment

### 7.1 BRAIN Vision

This path forward aligns with CLEO's canonical BRAIN model:

| BRAIN Layer | How This Work Contributes |
|-------------|--------------------------|
| **B**ase (Memory) | Track B extends manifest with hierarchical memory-trees |
| **R**easoning | Tree-aware queries enable structured context retrieval |
| **A**gent | MCP-first architecture enables any agent to use CLEO |
| **I**ntelligence | Progressive disclosure optimizes agent token efficiency |
| **N**etwork | CAAMP integration provides cross-provider awareness |

### 7.2 Portable Operability Through MCP

The MCP native engine delivers on Pillar 3 (Interoperable Interfaces) of the canonical vision:

- **Any MCP-compatible agent** can use CLEO through `cleo_query`/`cleo_mutate`
- **No Bash dependency** for core operations (29 native operations)
- **Transparent routing** to CLI for advanced operations -- agents do not need to know the difference
- **Structured contracts** (JSON in, JSON out) replace text parsing

### 7.3 Cross-Platform

The native TypeScript engine runs anywhere Node.js runs:

- **Linux**: Primary development platform, full CLI + MCP
- **macOS**: Full CLI + MCP
- **Windows**: MCP native operations work without WSL/Git Bash; CLI operations require Bash-compatible shell

This addresses a long-standing limitation: Windows developers can now use CLEO through MCP without installing a Unix shell environment.

### 7.4 AI-Agent-First Design Principles

Every aspect of this path forward prioritizes agent consumption:

1. **Structured I/O**: MCP tools return validated JSON, not text to parse
2. **Error contracts**: Every error includes machine-actionable `fix` and `alternatives`
3. **Progressive disclosure**: Agents receive only the context they need
4. **Token efficiency**: 94% reduction in tool definition overhead (2 tools vs 65 commands)
5. **Deterministic safety**: All validation, lifecycle gates, and atomic operations preserved through both interfaces

---

## 8. Summary of Decisions Made (2026-02-11)

| Decision | Status | Rationale |
|----------|--------|-----------|
| MCP-first/hotspots is canonical migration doctrine | **Final** | T4334 validates incremental TS path; T2021 broad rewrite deferred |
| Track A (lib/ hierarchy) is immediate next work | **Final** | 0.85 confidence, highest ROI, foundation for everything else |
| Track B (manifest hierarchy) follows Track A | **Final** | Depends on lib/ reorganization |
| T2021 remains aspirational, gated on T2112 | **Final** | Not cancelled, but not the active path |
| MCP-AGENT-INTERACTION-SPEC.md is normative | **Final** | Defines MCP vs CLI delineation and progressive disclosure |
| CAAMP v0.2.0 npm publish is a blocker | **Acknowledged** | T4341 tracks resolution |
| T2742 research closed, outputs indexed | **Final** | Folder structure/memory-trees research complete |

---

## 9. References

### Source Documents

| Document | Path | Purpose |
|----------|------|---------|
| Strategic Roadmap | `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` | Phase and gate execution plan |
| MCP Agent Interaction | `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` | MCP vs CLI delineation |
| Track A/B Planning | `claudedocs/agent-outputs/track-ab-planning.md` | Epic decomposition details |
| CAAMP Analysis | `claudedocs/agent-outputs/caamp-dependency-analysis.md` | Dependency analysis |
| Vision | `docs/concepts/vision.mdx` | Immutable vision identity |
| Portable Brain | `docs/specs/PORTABLE-BRAIN-SPEC.md` | Canonical product contract |
| v2 ADR | `claudedocs/CLEO-V2-ARCHITECTURE-DECISIONS.md` | Architecture decisions |

### Key Tasks

| Task | Title | Status |
|------|-------|--------|
| T4334 | MCP Server Native TypeScript Engine | Complete (v0.91.0) |
| T4344 | EPIC: lib/ Hierarchy Refactor | Active |
| T4352 | EPIC: Manifest Hierarchy + Path Query Engine | Queued |
| T4341 | Publish @cleocode/caamp v0.2.0 to npm | Pending |
| T4342 | Add @cleocode/caamp to mcp-server | Pending (blocked) |
| T2021 | TypeScript Rewrite | Deferred (gated on T2112) |
| T2112 | Bash Stabilization | Not passed |

---

**Document Status**: STABLE
**Authority**: This document synthesizes decisions made on 2026-02-11 into an authoritative path-forward reference. It defers to `docs/concepts/vision.mdx` (immutable identity) and `docs/specs/PORTABLE-BRAIN-SPEC.md` (product contract) for canonical product definition.
**Next Review**: After Track A completion
