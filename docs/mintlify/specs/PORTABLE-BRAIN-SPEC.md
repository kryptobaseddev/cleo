---
title: "CLEO Portable Brain Specification"
version: "1.2.0"
status: "stable"
created: "2026-02-09"
updated: "2026-02-27"
authors: ["CLEO Development Team"]
---

# CLEO Portable Brain Specification

## 1. Purpose

This specification defines CLEO's canonical product identity and long-term architecture contract.

CLEO is a vendor-neutral Brain and Memory system for AI software development that provides portable project memory, verifiable provenance, and agent-safe orchestration across any repository, model provider, or coding tool.

This document is normative. Roadmap documents define sequencing. Capability documents define deep implementation details.

## 2. Scope and Hierarchy

### 2.1 Document Authority

Authority order for product truth:

1. `docs/concepts/vision.md` (immutable vision identity)
2. `docs/mintlify/specs/PORTABLE-BRAIN-SPEC.md` (normative product contract)
3. `README.md` (operational public contract)
4. `docs/mintlify/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` (phase and gate execution plan)
5. `docs/mintlify/specs/CLEO-BRAIN-SPECIFICATION.md` (detailed capability target model)

If conflicts occur, higher authority prevails.

### 2.2 Current vs Target Framing

- Current state MUST describe only shipped behavior.
- Target state MUST be labeled as planned or gated.
- Operational docs MUST NOT present aspirational capabilities as implemented.

## 3. Canonical Pillars

CLEO MUST preserve these five pillars across all interfaces and roadmap phases:

1. Portable Memory  
   Project -> Epic -> Task hierarchy, research manifests, and agent outputs with stable identity.

2. Provenance by Default  
   Every artifact is traceable to task, decision, agent, and operation event.

3. Interoperable Interfaces  
   CLI and MCP are first-class interfaces. Provider-specific adapters are optional, never required.

4. Deterministic Safety  
   Validation layers, lifecycle gates, atomic operations, and immutable logs protect system integrity.

5. Cognitive Retrieval  
   Page index plus graph/vector/RAG retrieval supports contextual reasoning at Tier M/L.

## 4. Provider-Agnostic Contract

CLEO MUST remain provider-agnostic by design:

- MUST operate without dependence on any single LLM vendor.
- MUST support initialization in any project repository.
- MUST preserve portable memory format independent of runtime tool.
- SHOULD offer optimized integrations for specific tools (for example Claude Code) without changing core data contracts.
- MUST define behavior through open schemas, exit codes, and interface contracts.

## 5. Core Invariants

The following are non-negotiable system invariants:

1. Stable task identity (`T###`...) never changes after assignment.
2. Write operations are atomic (temp -> validate -> backup -> rename).
3. Validation-first enforcement blocks invalid state creation.
4. Audit trail is append-only and traceable.
5. JSON output remains machine-first; human output is opt-in.
6. Lifecycle enforcement remains explicit and testable.

## 6. Data and Provenance Model

### 6.1 Required Artifact Lineage

Artifacts SHOULD be linked by durable IDs and metadata:

- Task IDs (`T###`)
- Decision IDs (`D###`, planned)
- Pattern IDs (`P###`, planned)
- Learning IDs (`L###`, planned)
- Session IDs
- Operation/event records

### 6.2 Research and Manifest Memory

CLEO MUST treat research manifests and agent outputs as first-class memory artifacts, with explicit provenance links to tasks and sessions.

## 7. Interface Model

### 7.1 CLI

The TypeScript CLI (`src/cli/`) is the primary runtime interface (per ADR-004). It is 100% compliant with the shared-core architecture pattern, delegating all business logic to `src/core/` modules (validated 2026-02-16, T4565). There are ~86 command files in `src/cli/commands/`. The Bash CLI (`scripts/`, `lib/`) is deprecated and pending removal.

### 7.2 MCP

MCP is the strategic interface for provider-neutral integration. The MCP server exposes 2 tools (`cleo_query`, `cleo_mutate`) with 177 canonical operations (97 query + 80 mutate) across 10 domains. The MCP engine (`src/mcp/engine/`) delegates to `src/core/` modules via thin wrapper engines (task-engine, system-engine, orchestrate-engine, config-engine, etc.). Of 153 routed operations, 146 run natively in TypeScript via `src/core/`.

**Architecture status (updated 2026-02-27)**: The earlier finding (2026-02-16, T4565/T4566) that MCP duplicated task CRUD independently has been resolved. The MCP engine at `src/mcp/engine/` now imports directly from `src/core/tasks/`, `src/core/sessions/`, `src/core/system/`, and other core modules. See `src/mcp/engine/capability-matrix.ts` for the native/cli/hybrid routing matrix.

MCP implementations MUST preserve CLI semantics, invariants, and exit-code intent.

### 7.3 Shared-Core Architecture (Salesforce DX Pattern)

Both CLI and MCP interfaces MUST delegate to a shared core (`src/core/`). Current compliance:
- **CLI**: 100% compliant (~86 command files route through `src/core/`)
- **MCP**: ~95% compliant (146 of 153 operations run natively via `src/core/`; 3 require CLI fallback, 4 hybrid)

### 7.4 Adapters

Provider/tool adapters MAY optimize UX but MUST NOT fork core memory semantics.

## 8. Tier Progression Contract

- Tier S: single-project, deterministic task/memory lifecycle.
- Tier M: cross-project memory and retrieval with validated usage.
- Tier L: coordinated multi-agent intelligence across projects.

Progression MUST remain gate-driven and evidence-based.

## 9. Governance and Change Control

### 9.1 Immutable Vision Requirement

`docs/concepts/vision.md` defines product identity and MUST be treated as constitutional text.

### 9.2 Amendment Process

Any change that alters canonical identity MUST:

1. Include explicit "Vision Amendment" rationale.
2. Update this spec and README in the same change set.
3. Include migration note if terminology or behavior shifts.

### 9.3 Drift Prevention

Documentation and implementation MUST use the same canonical terms for:

- Portable Memory
- Provenance
- Deterministic Safety
- Interoperability
- Cognitive Retrieval

## 10. References

- `docs/concepts/vision.md`
- `README.md`
- `docs/mintlify/specs/CLEO-CANONICAL-PLAN-SPEC.md` (canonical strategy and decisions)
- `docs/mintlify/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md`
- `docs/mintlify/specs/CLEO-BRAIN-SPECIFICATION.md`
- `docs/mintlify/specs/MCP-SERVER-SPECIFICATION.md`
- `.cleo/agent-outputs/T4565-T4566-architecture-validation-report.md` (shared-core compliance audit, historical)
- `.cleo/agent-outputs/T4557-documentation-audit-report.md` (documentation inventory)
