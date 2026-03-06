---
title: "CLEO Portable Brain Specification"
version: "1.3.0"
status: "stable"
created: "2026-02-09"
updated: "2026-03-06"
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

1. `docs/concepts/CLEO-VISION.md` (immutable vision identity)
2. `docs/specs/PORTABLE-BRAIN-SPEC.md` (normative product contract)
3. `README.md` (operational public contract)
4. `docs/ROADMAP.md` (current and future targets)
5. `docs/specs/CLEO-BRAIN-SPECIFICATION.md` (detailed capability target model)

If conflicts occur, higher authority prevails.

### 2.2 Current vs Target Framing

- Current state MUST describe only shipped behavior.
- Target state MUST be labeled as planned or gated.
- Operational docs MUST NOT present aspirational capabilities as implemented.

## 3. Portable Brain: The `.cleo/` Directory

The `.cleo/` directory is CLEO's **portable brain** - a complete, self-contained project memory that can be:

### 3.1 Portability Mechanisms

| Mechanism | Description | Use Case |
|-----------|-------------|----------|
| **Git-tracked** | `.cleo/` is designed to be committed to version control | Team collaboration, history preservation |
| **Zippable** | Entire directory can be archived and transferred | Backup, migration, offline sharing |
| **Shareable** | Can be synced between developers | Pair programming, handoff |
| **Provider-agnostic** | No dependency on specific AI tools | Cross-tool workflows |

### 3.2 Core Components

```
.cleo/
├── brain.db              # SQLite database with task/session/memory data
├── config.json           # Project configuration
├── tasks.db              # Task archive and audit log
├── nexus.json            # Cross-project registry (NEXUS sync)
├── manifest.jsonl        # Agent outputs and research manifests
├── page-index/           # Graph-RAG page index
│   ├── nodes.json
│   └── edges.json
├── agent-outputs/        # Research and analysis artifacts
├── backups/              # Recovery backups
└── .backups/             # Operational atomic backups
```

### 3.3 Cross-Provider Agnostic Design

The `.cleo/` brain is **completely provider-agnostic**:

- **No LLM vendor lock-in**: Works with Claude, OpenAI, Gemini, or any provider
- **No tool dependency**: Functions independently of specific coding tools
- **Standard formats**: JSON, SQLite, Markdown - universally readable
- **Exit code contracts**: Machine-parseable regardless of runtime

## 4. NEXUS Synchronization

The Portable Brain integrates with the **CLEO-NEXUS** system for cross-project intelligence:

### 4.1 Registration

- `.cleo/nexus.json` registers the project with local NEXUS registry
- Enables cross-project task references (`project:taskId`)
- Supports federated memory queries across projects

### 4.2 Sync Points

| Trigger | Sync Action |
|---------|-------------|
| Task created | Update NEXUS index |
| Task completed | Archive to NEXUS |
| Session start | Register active project |
| Memory injection | Sync to brain.db |

## 5. Canonical Pillars

CLEO MUST preserve these five pillars across all interfaces and roadmap phases:

1. **Portable Memory**  
   Project -> Epic -> Task hierarchy, research manifests, and agent outputs with stable identity.

2. **Provenance by Default**  
   Every artifact is traceable to task, decision, agent, and operation event.

3. **Interoperable Interfaces**  
   CLI and MCP are first-class interfaces. Provider-specific adapters are optional, never required.

4. **Deterministic Safety**  
   Validation layers, lifecycle gates, atomic operations, and immutable logs protect system integrity.

5. **Cognitive Retrieval**  
   Page index plus graph/vector/RAG retrieval supports contextual reasoning at Tier M/L.

## 6. Provider-Agnostic Contract

CLEO MUST remain provider-agnostic by design:

- MUST operate without dependence on any single LLM vendor.
- MUST support initialization in any project repository.
- MUST preserve portable memory format independent of runtime tool.
- SHOULD offer optimized integrations for specific tools (for example Claude Code) without changing core data contracts.
- MUST define behavior through open schemas, exit codes, and interface contracts.

## 7. Core Invariants

The following are non-negotiable system invariants:

1. Stable task identity (`T###`...) never changes after assignment.
2. Write operations are atomic (temp -> validate -> backup -> rename).
3. Validation-first enforcement blocks invalid state creation.
4. Audit trail is append-only and traceable.
5. JSON output remains machine-first; human output is opt-in.
6. Lifecycle enforcement remains explicit and testable.

## 8. Data and Provenance Model

### 8.1 Required Artifact Lineage

Artifacts SHOULD be linked by durable IDs and metadata:

- Task IDs (`T###`)
- Decision IDs (`D###`, planned)
- Pattern IDs (`P###`, planned)
- Learning IDs (`L###`, planned)
- Session IDs
- Operation/event records

### 8.2 Research and Manifest Memory

CLEO MUST treat research manifests and agent outputs as first-class memory artifacts, with explicit provenance links to tasks and sessions.

## 9. Interface Model

### 9.1 CLI

The TypeScript CLI (`src/cli/`) is the primary runtime interface (per ADR-004). It is 100% compliant with the shared-core architecture pattern, delegating all business logic to `src/core/` modules (validated 2026-02-16, T4565). There are ~86 command files in `src/cli/commands/`. The Bash CLI (`scripts/`, `lib/`) is deprecated and pending removal.

### 9.2 MCP

MCP is the strategic interface for provider-neutral integration. The MCP server exposes 2 tools (`query`, `mutate`) with 256 canonical operations (145 query + 111 mutate) across 10 domains. The MCP engine (`src/dispatch/engines/`) delegates to `src/core/` modules via thin wrapper engines (task-engine, system-engine, orchestrate-engine, config-engine, etc.).

**Architecture status (updated 2026-03-06)**: The MCP engine now imports directly from `src/core/` modules. See `src/mcp/engine/capability-matrix.ts` for the native/cli/hybrid routing matrix.

MCP implementations MUST preserve CLI semantics, invariants, and exit-code intent.

### 9.3 Shared-Core Architecture (Salesforce DX Pattern)

Both CLI and MCP interfaces MUST delegate to a shared core (`src/core/`). Current compliance:
- **CLI**: 100% compliant (~86 command files route through `src/core/`)
- **MCP**: ~95% compliant (operations run natively via `src/core/`; some require CLI fallback)

### 9.4 Adapters

Provider/tool adapters MAY optimize UX but MUST NOT fork core memory semantics.

## 10. Tier Progression Contract

- **Tier S**: single-project, deterministic task/memory lifecycle.
- **Tier M**: cross-project memory and retrieval with validated usage.
- **Tier L**: coordinated multi-agent intelligence across projects.

Progression MUST remain gate-driven and evidence-based.

## 11. Migration and Portability

### 11.1 Moving a Project

To move a CLEO project to a new location:

1. Commit `.cleo/` to git (or zip the directory)
2. Clone/copy to new location
3. Run `cleo admin.init` to validate integrity
4. NEXUS will auto-re-register on next sync

### 11.2 Sharing Between Developers

```bash
# Export brain
zip -r project-brain.zip .cleo/

# Import brain
unzip project-brain.zip
cleo admin.validate
```

### 11.3 Cross-Tool Usage

The same `.cleo/` brain works with:
- Claude Code
- OpenCode
- Any MCP-compatible tool
- Direct CLI usage

## 12. Governance and Change Control

### 12.1 Immutable Vision Requirement

`docs/concepts/CLEO-VISION.md` defines product identity and MUST be treated as constitutional text.

### 12.2 Amendment Process

Any change that alters canonical identity MUST:

1. Include explicit "Vision Amendment" rationale.
2. Update this spec and README in the same change set.
3. Include migration note if terminology or behavior shifts.

### 12.3 Drift Prevention

Documentation and implementation MUST use the same canonical terms for:

- Portable Memory
- Provenance
- Deterministic Safety
- Interoperability
- Cognitive Retrieval

## 13. References

- `docs/concepts/CLEO-VISION.md`
- `README.md`
- `docs/ROADMAP.md`
- `docs/specs/CLEO-BRAIN-SPECIFICATION.md`
- `docs/specs/CLEO-NEXUS-SPECIFICATION.md`
- `docs/specs/MCP-SERVER-SPECIFICATION.md`
- `.cleo/agent-outputs/T4565-T4566-architecture-validation-report.md` (shared-core compliance audit, historical)
- `.cleo/agent-outputs/T4557-documentation-audit-report.md` (documentation inventory)
