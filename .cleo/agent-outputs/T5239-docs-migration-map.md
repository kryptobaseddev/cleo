# T5239 Phase D: Docs Migration Map

Generated: 2026-03-02
Agent: docs-mapper

## Summary

The CLEO-VISION.md Document Authority Hierarchy (lines 520-532) and AGENTS.md both reference specs at `docs/specs/` paths, but most canonical specs only exist at `docs/mintlify/specs/`. Line 532 of CLEO-VISION.md explicitly acknowledges this: "Specs at priority 2, 4, and 5 are currently in `docs/mintlify/specs/` awaiting validation and promotion to `docs/specs/`."

## Document Authority Hierarchy (CLEO-VISION.md lines 16-21)

These five documents form the canonical read order:

| # | Document | Expected Path | Actual Path | Action |
|---|----------|---------------|-------------|--------|
| 1 | Vision (this doc) | `docs/concepts/CLEO-VISION.md` | `docs/concepts/CLEO-VISION.md` | OK |
| 2 | Portable Brain Spec | `docs/specs/PORTABLE-BRAIN-SPEC.md` | `docs/mintlify/specs/PORTABLE-BRAIN-SPEC.md` | **MOVE** |
| 3 | README | `README.md` | `README.md` | OK |
| 4 | Strategic Roadmap | `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` | `docs/mintlify/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` | **MOVE** |
| 5 | BRAIN Specification | `docs/specs/CLEO-BRAIN-SPECIFICATION.md` | `docs/mintlify/specs/CLEO-BRAIN-SPECIFICATION.md` | **MOVE** |

## Specs Referenced in AGENTS.md

| Document | Referenced At | Expected Path | Actual Path | Action |
|----------|--------------|---------------|-------------|--------|
| CLEO-OPERATIONS-REFERENCE.md | AGENTS.md:95, 358 | `docs/specs/CLEO-OPERATIONS-REFERENCE.md` | `docs/mintlify/specs/CLEO-OPERATIONS-REFERENCE.md` | **MOVE** |
| VERB-STANDARDS.md | AGENTS.md:96, 314, 360 | `docs/specs/VERB-STANDARDS.md` | `docs/specs/VERB-STANDARDS.md` | OK (already in docs/specs) |
| MCP-SERVER-SPECIFICATION.md | AGENTS.md:359 | `docs/mintlify/specs/MCP-SERVER-SPECIFICATION.md` | `docs/mintlify/specs/MCP-SERVER-SPECIFICATION.md` | **MOVE** (ref uses mintlify path) |
| MCP-AGENT-INTERACTION-SPEC.md | AGENTS.md:361 | `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` | `docs/mintlify/specs/MCP-AGENT-INTERACTION-SPEC.md` | **MOVE** |
| CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md | AGENTS.md:75 | `docs/specs/CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md` | `docs/mintlify/specs/CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md` | **MOVE** |

## Specs Referenced in Source Code (src/)

| Document | Referenced In | Expected Path | Actual Path | Action |
|----------|--------------|---------------|-------------|--------|
| MCP-SERVER-SPECIFICATION.md | src/mcp/lib/verification-gates.ts:13, src/mcp/lib/protocol-enforcement.ts:10, src/mcp/lib/gate-validators.ts:14, src/mcp/lib/PROTOCOL-ENFORCEMENT.md:213 | `docs/specs/MCP-SERVER-SPECIFICATION.md` | `docs/mintlify/specs/MCP-SERVER-SPECIFICATION.md` | **MOVE** |
| PROTOCOL-ENFORCEMENT-SPEC.md | src/protocols/validation.md:240, src/protocols/testing.md:359 | `docs/specs/PROTOCOL-ENFORCEMENT-SPEC.md` | `docs/mintlify/specs/PROTOCOL-ENFORCEMENT-SPEC.md` | **MOVE** |
| PROJECT-LIFECYCLE-SPEC.md | src/mcp/lib/PROTOCOL-ENFORCEMENT.md:215 | `docs/specs/PROJECT-LIFECYCLE-SPEC.md` | DOES NOT EXIST ANYWHERE | **CREATE or DEFER** |
| CLEO-OPERATIONS-REFERENCE.md | src/cli/commands/detect-drift.ts:107,112,117,165, src/cli/commands/commands.ts:104 | `docs/specs/CLEO-OPERATIONS-REFERENCE.md` | `docs/mintlify/specs/CLEO-OPERATIONS-REFERENCE.md` | **MOVE** |
| PORTABLE-BRAIN-SPEC.md | src/cli/commands/detect-drift.ts:273,293 | `docs/specs/PORTABLE-BRAIN-SPEC.md` | `docs/mintlify/specs/PORTABLE-BRAIN-SPEC.md` | **MOVE** |

## Consolidated Migration Table

Priority-ordered by reference count and authority:

| # | Document | Actual Location | Move To | References | Notes |
|---|----------|----------------|---------|------------|-------|
| 1 | PORTABLE-BRAIN-SPEC.md | `docs/mintlify/specs/` | `docs/specs/` | CLEO-VISION.md, README.md, detect-drift.ts, 20+ specs | Authority hierarchy #2 |
| 2 | CLEO-STRATEGIC-ROADMAP-SPEC.md | `docs/mintlify/specs/` | `docs/specs/` | CLEO-VISION.md, README.md, ADRs, 15+ specs | Authority hierarchy #4 |
| 3 | CLEO-BRAIN-SPECIFICATION.md | `docs/mintlify/specs/` | `docs/specs/` | CLEO-VISION.md, README.md, ADRs, 10+ specs | Authority hierarchy #5 |
| 4 | CLEO-OPERATIONS-REFERENCE.md | `docs/mintlify/specs/` | `docs/specs/` | AGENTS.md, detect-drift.ts, commands.ts, ADRs | Core ops reference |
| 5 | MCP-SERVER-SPECIFICATION.md | `docs/mintlify/specs/` | `docs/specs/` | AGENTS.md, 3 src/mcp/lib/ files, 8+ specs | MCP contract |
| 6 | MCP-AGENT-INTERACTION-SPEC.md | `docs/mintlify/specs/` | `docs/specs/` | AGENTS.md, 5+ specs | Agent interaction patterns |
| 7 | CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md | `docs/mintlify/specs/` | `docs/specs/` | AGENTS.md | Metrics spec |
| 8 | PROTOCOL-ENFORCEMENT-SPEC.md | `docs/mintlify/specs/` | `docs/specs/` | 2 src/protocols/ files, guides, skills | Protocol enforcement |

## Already Correct (No Action)

| Document | Location | Status |
|----------|----------|--------|
| VERB-STANDARDS.md | `docs/specs/VERB-STANDARDS.md` | Already in docs/specs (also exists in mintlify/specs — remove duplicate after move) |
| CLEO-VISION.md | `docs/concepts/CLEO-VISION.md` | Correct location |
| README.md | `README.md` | Correct location |

## Ghost Reference (Doc Does Not Exist)

| Document | Referenced In | Expected Path | Status |
|----------|--------------|---------------|--------|
| PROJECT-LIFECYCLE-SPEC.md | src/mcp/lib/PROTOCOL-ENFORCEMENT.md:215, 10+ mintlify docs | `docs/specs/PROJECT-LIFECYCLE-SPEC.md` | DOES NOT EXIST — referenced in 20+ places but never created |

## Remaining mintlify/specs Files (Not Referenced in AGENTS.md or src/)

These files exist in `docs/mintlify/specs/` but are NOT directly referenced in AGENTS.md or source code. They may still be valuable but are lower priority for migration:

| Document | Referenced Elsewhere |
|----------|---------------------|
| CAAMP-INTEGRATION-GAP-ANALYSIS.md | Within mintlify docs only |
| CLEO-CAAMP-INTEGRATION.md | Within mintlify docs only |
| CLEO-CANONICAL-PLAN-SPEC.md | Within mintlify docs only |
| CLEO-MIGRATION-DOCTRINE.md | Within mintlify docs only |
| CLEO-PATH-FORWARD-2026Q1.md | Within mintlify docs only |
| CLEO-V2-ARCHITECTURE-SPEC.md | Within mintlify docs only |
| CLEO-WEB-DASHBOARD-SPEC.md | Within mintlify docs only |
| CLEO-WEB-DASHBOARD-UI.md | Within mintlify docs only |
| CLI-MCP-PARITY-ANALYSIS.md | Within mintlify docs only |
| DYNAMIC-OUTPUT-LIMITS-SPEC.md | Within mintlify docs only |
| MANIFEST-HIERARCHY-SCHEMA-SPEC.md | Within mintlify docs only |
| MCP-CLI-PARITY-MATRIX.md | Within mintlify docs only |
| METRICS-VALUE-PROOF-SPEC.md | Within mintlify docs only |
| COMMIT-TASK-ENFORCEMENT-SPEC.md | Within mintlify docs only |
| DECISION-LIFECYCLE-SPEC.md | Within mintlify docs only |
| PROTOCOL-MISALIGNMENT-CORRECTIONS.md | Within mintlify docs only |

## After-Move Reference Updates Required

After moving the 8 priority files, these references need updating:

1. **AGENTS.md:359** — Change `docs/mintlify/specs/MCP-SERVER-SPECIFICATION.md` to `docs/specs/MCP-SERVER-SPECIFICATION.md`
2. **README.md:170-173** — Update paths from `docs/mintlify/specs/` to `docs/specs/` for PORTABLE-BRAIN-SPEC, CLEO-STRATEGIC-ROADMAP-SPEC, CLEO-BRAIN-SPECIFICATION
3. **Internal cross-references within moved specs** — Many specs reference each other at `docs/specs/` paths, which will become correct after the move
4. **VERB-STANDARDS.md duplicate** — Remove `docs/mintlify/specs/VERB-STANDARDS.md` after confirming `docs/specs/VERB-STANDARDS.md` is identical or newer
