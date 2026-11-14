# CLEO Canon Index

**A short top-down reading guide for humans and LLMs**

Core canon documents live in this `concept/` folder, with contracts in `spec/` and operating instructions in `guide/`. This index gives a simple read order, what each document is for, and where to go next.

---

## Source-of-Truth Hierarchy (ADR-044)

When canon documents conflict, resolve in this order (higher entry wins):

1. **Code** — `packages/cleo/src/dispatch/types.ts` (`CANONICAL_DOMAINS`), `packages/cleo/src/dispatch/registry.ts` (`OPERATIONS`). Final arbiter for domain + operation lists.
2. **Constitution** — `docs/specs/CLEO-OPERATION-CONSTITUTION.md`. Normative spec derived from the code.
3. **Owner Memory** — `~/.claude/projects/-mnt-projects-cleocode/memory/MEMORY.md`. Owner corrections; wins over aged canon on identity.
4. **Architecture Guide** — `CLEO-ARCHITECTURE-GUIDE.md`. Plain-English reference for what CLEO is; mirrors the Constitution.
5. **System Flow Atlas** — `CLEO-SYSTEM-FLOW-ATLAS.md`. Visual diagrams; mirrors Architecture Guide.
6. **Design docs** — `docs/design/*`. UI / interaction specs; consume canon, never define it.

Full rationale: `docs/adr/adr-044-canon-reconciliation.md`.

---

## Read Order

1. [CLEO-ARCHITECTURE-GUIDE.md](cleo-architecture-guide.md)
   What CLEO is. Read this first: the harness-agnostic core any agent can call through `cleo <command>`, its systems and how they fit together.

2. [CLEO-OPERATION-CONSTITUTION.md](../spec/cleo-operation-constitution.md)
   The runtime contract. Read this second to understand the 11 canonical domains, the internal `query`/`mutate` CQRS split, canonical verbs, and what operations are actually legal in the system.

3. [CLEO-SYSTEM-FLOW-ATLAS.md](cleo-system-flow-atlas.md)
   The visual map. Read this third to see how the conceptual systems, workshop vocabulary, and live runtime forms map to the runtime domains, how requests flow, and where data lives. Includes the package boundary diagram showing `@cleocode/core` vs `@cleocode/cleo`.

4. [CLEO-CANT.md](cleo-cant.md)
   The agent communication protocol. Read this to understand how agents speak to each other (conversation syntax: directives, addressing, task references, tags) and how the system speaks back (response syntax: LAFS envelopes). Includes the formal BNF grammar (with `cant-core` Rust crate as parsing SSoT), directive-to-operation mapping, and how CANT relates to AgentMBX, CLEO's messaging layer (D11176). See also [CLEOCODE-ECOSYSTEM-PLAN.md](../plan/cleocode-ecosystem.md) for the full crate and package architecture.

5. [CANT-DSL-SPEC.md](../spec/cant-dsl.md)
   The formal language specification for CANT (Collaborative Agent Notation Tongue). Defines the `.cant` file format, 3-layer grammar (EBNF), AST type definitions, 42 validation rules (Scope, Pipeline Purity, Types, Hooks, Workflows), CAAMP event mapping, import resolution algorithm, hybrid runtime model (Rust pipelines + TypeScript workflows), and approval token protocol. The `cant-core` Rust crate and `cant-lsp` binary are the canonical implementations. 482 tests, 17K lines Rust, 3.8K lines TypeScript.

6. [CANT-EXECUTION-SEMANTICS.md](../spec/cant-execution-semantics.md)
   Formal execution semantics for the CANT workflow executor. Defines sequential execution (Warp), parallel execution (Conductors), session blocking (Scribes), approval suspension (Crown Layer), error propagation (Wardens), and output collection (Cascade to Tome). Also defines the Generic Domain Event Protocol extending CAAMP from 16 provider events to 31 total events (16 provider + 15 CLEO domain) with D:O:P metadata pattern.

7. [CORE-PACKAGE-SPEC.md](../spec/core-package.md)
   The `@cleocode/core` standalone package contract. Read this when working with the business logic kernel independently of the full product: public API surface, three consumer patterns (Facade / tree-shaking / custom store), purity rules, and build architecture. Status: APPROVED.

---

## Quick Purpose Map

- **What CLEO is**: [CLEO-ARCHITECTURE-GUIDE.md](cleo-architecture-guide.md)
- **Rules and operations**: [CLEO-OPERATION-CONSTITUTION.md](../spec/cleo-operation-constitution.md)
- **System flow, ownership, and runtime forms**: [CLEO-SYSTEM-FLOW-ATLAS.md](cleo-system-flow-atlas.md)
- **Agent communication protocol (CANT)**: [CLEO-CANT.md](cleo-cant.md)
- **CANT formal language spec**: [CANT-DSL-SPEC.md](../spec/cant-dsl.md)
- **CANT execution semantics + domain events**: [CANT-EXECUTION-SEMANTICS.md](../spec/cant-execution-semantics.md)
- **Standalone business logic kernel**: [CORE-PACKAGE-SPEC.md](../spec/core-package.md)

---

## Related implementation and operations

These links retain the supporting contracts, design work, operational guidance and
research behind the canon. Read each document's status and provenance before
using it: dated schema/API inventories and planned designs describe their recorded
revision, while current code and CLI help remain the implementation authority.

### Runtime, data and contracts

- [Database ERDs](database-erds.md) — schema diagrams and relationships, current as of the Core Hardening Waves 0-3 revision it records.
- [Type contracts](type-contracts.md) — public API and schema inventory at the recorded core-hardening revision.
- [Brain package](../spec/cleo-brain-package.md) — the five-substrate package and query contract.
- [NEXUS architecture](../spec/cleo-nexus-architecture.md) — cross-project identity, registration and discovery design.
- [Dispatch adapter](../spec/cleo-dispatch-adapter.md) — the typed boundary between registry parameters and domain handlers.
- [Runtime logging](../spec/cleo-logging-contract.md) — diagnostics, audit ownership and retention rules.
- [JSON storage decisions](../spec/json-storage-jsonb-decision-matrix.md) — per-column JSONB, text and denormalization choices.
- [Sync change journal](../spec/sync-change-journal.md) — replication metadata, capture, signed outbox and apply-boundary design.

### Agents, harness and integration design

- [CAAMP integration](../spec/caamp-integration.md) — provider capabilities, spawn adapters and hooks, including target features.
- [CANT persona MVI](../spec/cant-persona-mvi.md) — draft tiered persona-loading rules.
- [Autonomous runtime](../spec/cleo-autonomous-runtime.md) — planned Hearth, Impulse and Watcher behavior.
- [Conduit protocol](../spec/cleo-conduit-protocol.md) — the planned agent relay contract and its implementation-status caveats.
- [Creating custom agents](../guide/creating-custom-agents.md) — CANT definitions and agent-platform setup.
- [Lead and worker roles](../guide/lead-vs-worker-roles.md) — role-specific injection, tool access and enforcement.
- [Orca report relay evidence](../note/orca-report-relay-live-evidence.md) — recorded throwaway AgentMBX unread-delivery and idempotency checks, with concurrency regression results and coverage limits.
- [Subagent injection](../guide/subagent-injection-pipeline.md) — the path from agent definition to spawned process.
- [Token replacement](../spec/token-replacement-contract.md) — prompt-token resolution and spawn-time validation.

### Operations, releases and verification

- [CI and hooks taxonomy](../guide/ci-hooks-taxonomy-runbook.md) — consumer versus repository workflows and branch-protection checks.
- [Release verb matrix](../reference/verb-matrix.md) — current release entry points and gates.
- [Historical release process](../guide/releasing.md) — the superseded start/ship pipeline, retained as incident and migration history.
- [Template and config inventory](../reference/template-config-inventory.md) — the recorded template/config audit, precedence and drift contracts.
- [Gate integrity](../spec/gate-integrity.md) — evidence grammar and completion re-verification.
- [PR cadence](../spec/pr-cadence.md) — task-to-PR-to-release traceability under ADR-099.

### Documentation and classification

- [Docs interaction contract](../spec/docs-interaction-contract.md) — update, version and supersession behavior.
- [Canonical taxonomy](../taxonomy.md) — shared classification axes for decisions, documents and tasks.

### Recovery and research

- [Brain recovery runbook](../note/brain-recovery-runbook.md) — recovery prerequisites, data-loss expectations and fallback procedure.
- [Agent memory architecture notes](../research/agent-memory-architecture-notes.md) — external research, explicitly separate from CLEO decisions and measurements.
- [Hermes provider architecture](../research/hermes-llm-provider-architecture.md) — external provider/credential design inspiration.
- [Machine worktree census](../research/machine-worktree-census.md) — the evidence and integration map behind machine-hygiene reporting.

---

## One-Line Distinctions

- **Architecture Guide** defines what CLEO is.
- **Constitution** defines what CLEO may do.
- **Atlas** shows how CLEO moves and where the live workshop sits on the contract.
- **CANT** defines how agents speak to each other and how the system answers.
- **CANT DSL Spec** defines the formal .cant file format, grammar, validation, and runtime.
- **CANT Execution Semantics** defines workflow execution and the domain event protocol.
- **Core Package Spec** defines the standalone `@cleocode/core` kernel's public API contract.

---

## LLM Note

If context is limited, read in this order:

1. [CLEO-ARCHITECTURE-GUIDE.md](cleo-architecture-guide.md)
2. [CLEO-OPERATION-CONSTITUTION.md](../spec/cleo-operation-constitution.md)
3. [CLEO-SYSTEM-FLOW-ATLAS.md](cleo-system-flow-atlas.md)

**Package note**: `@cleocode/core` is the standalone npm package containing all CLEO business logic. It can be installed independently of `@cleocode/cleo`. The `@cleocode/cleo` product wraps `@cleocode/core` with the `cleo` CLI -- the sole runtime surface. When working directly with business logic -- tasks, sessions, memory, orchestration, lifecycle, release -- use `@cleocode/core`. See [CORE-PACKAGE-SPEC.md](../spec/core-package.md) for the full API contract.
