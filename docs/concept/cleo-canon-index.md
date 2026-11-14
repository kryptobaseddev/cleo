# CLEO Canon Index

**A short top-down reading guide for humans and LLMs**

Core canon documents live in this `concept/` folder, with contracts in `spec/` and operating instructions in `guide/`. This index gives a simple read order, what each document is for, and where to go next.

---

## Source-of-Truth Hierarchy (ADR-044)

When canon documents conflict, resolve in this order (higher entry wins):

1. **Code** — `packages/cleo/src/dispatch/types.ts` (`CANONICAL_DOMAINS`), `packages/cleo/src/dispatch/registry.ts` (`OPERATIONS`). Final arbiter for domain + operation lists.
2. **Constitution** — `docs/spec/cleo-operation-constitution.md`. Normative spec derived from the code.
3. **Owner Memory** — `~/.claude/projects/-mnt-projects-cleocode/memory/MEMORY.md`. Owner corrections; wins over aged canon on identity.
4. **Architecture Guide** — `docs/concept/cleo-architecture-guide.md`. Plain-English reference for what CLEO is, including the request flow (it absorbed the retired System Flow Atlas); mirrors the Constitution.
5. **Design docs** — `docs/design/*`. UI / interaction specs; consume canon, never define it.

Full rationale: `docs/adr/adr-044-canon-reconciliation.md`.

---

## Read Order

1. [CLEO-ARCHITECTURE-GUIDE.md](cleo-architecture-guide.md)
   What CLEO is. Read this first: the harness-agnostic core any agent can call through `cleo <command>`, its systems, how they fit together, and how a request flows from the CLI to the store.

2. [CLEO-OPERATION-CONSTITUTION.md](../spec/cleo-operation-constitution.md)
   The runtime contract. Read this second to understand the 11 canonical domains, the internal `query`/`mutate` CQRS split, canonical verbs, and what operations are actually legal in the system.

3. [CANT reference](../reference/cant.md)
   The agent communication protocol. Read this to understand how agents speak to each other (conversation syntax: directives, addressing, task references, tags) and how the system speaks back (response syntax: LAFS envelopes). Includes the formal BNF grammar (with `cant-core` Rust crate as parsing SSoT), directive-to-operation mapping, and how CANT relates to AgentMBX, CLEO's messaging layer (D11176).

4. [CANT-DSL-SPEC.md](../spec/cant-dsl.md)
   The formal language specification for CANT (Collaborative Agent Notation Tongue). Defines the `.cant` file format, 3-layer grammar (EBNF), AST type definitions, 42 validation rules (Scope, Pipeline Purity, Types, Hooks, Workflows), CAAMP event mapping, import resolution algorithm, hybrid runtime model (Rust pipelines + TypeScript workflows), and approval token protocol. The `cant-core` Rust crate and `cant-lsp` binary are the canonical implementations. 482 tests, 17K lines Rust, 3.8K lines TypeScript.

---

## Quick Purpose Map

- **What CLEO is**: [CLEO-ARCHITECTURE-GUIDE.md](cleo-architecture-guide.md)
- **Rules and operations**: [CLEO-OPERATION-CONSTITUTION.md](../spec/cleo-operation-constitution.md)
- **Agent communication protocol (CANT)**: [CANT reference](../reference/cant.md)
- **CANT formal language spec**: [CANT-DSL-SPEC.md](../spec/cant-dsl.md)
- **Standalone business logic kernel**: [CORE API agent guide](../reference/core-sdk.md)

---

## Related implementation and operations

These links retain the supporting contracts, design work, operational guidance and
research behind the canon. Read each document's status and provenance before
using it: dated schema/API inventories and planned designs describe their recorded
revision, while current code and CLI help remain the implementation authority.

### Runtime, data and contracts

- [Brain package](../spec/cleo-brain-package.md) — the five-substrate package and query contract.
- [NEXUS architecture](../spec/cleo-nexus-architecture.md) — cross-project identity, registration and discovery design.
- [Dispatch adapter](../spec/cleo-dispatch-adapter.md) — the typed boundary between registry parameters and domain handlers.
- [Runtime logging](../spec/cleo-logging-contract.md) — diagnostics, audit ownership and retention rules.
- [Database architecture](../spec/database-architecture.md) — stores, JSON-column storage classes (TEXT, JSONB, junction) and the JSONB read rules.
- [Sync change journal](../spec/sync-change-journal.md) — replication metadata, capture, signed outbox and apply-boundary design.

### Agents, harness and integration design

- [CAAMP integration](../spec/caamp-integration.md) — provider capabilities, spawn adapters and hooks, including target features.
- [Conduit protocol](../spec/cleo-conduit-protocol.md) — the planned agent relay contract and its implementation-status caveats.
- [Creating custom agents](../guide/creating-custom-agents.md) — CANT definitions and agent-platform setup.
- [Orchestration flow](orchestration-flow.md) — spawn layers, spawn execution, the lead tool strip and worker isolation.
- [Orca report relay evidence](../note/orca-report-relay-live-evidence.md) — recorded throwaway AgentMBX unread-delivery and idempotency checks, with concurrency regression results and coverage limits.

### Operations, releases and verification

- [Consumer workflow and hook contract](../spec/consumer-workflow-hook-contract.md) — consumer versus repository workflows, trigger policy and branch-protection checks.
- [Release verb matrix](../reference/verb-matrix.md) — current release entry points and gates.
- [Historical release process](../guide/releasing.md) — the superseded start/ship pipeline, retained as incident and migration history.
- [Gate integrity](../spec/gate-integrity.md) — evidence grammar and completion re-verification.
- [PR cadence](../spec/pr-cadence.md) — task-to-PR-to-release traceability under ADR-099.

### Documentation and classification

- [Docs interaction contract](../spec/docs-interaction-contract.md) — update, version and supersession behavior.
- [Canonical taxonomy](../reference/taxonomy.md) — shared classification axes for decisions, documents and tasks.

### Recovery and research

- [Brain recovery runbook](../note/brain-recovery-runbook.md) — recovery prerequisites, data-loss expectations and fallback procedure.
- [Agent memory architecture notes](../research/agent-memory-architecture-notes.md) — external research, explicitly separate from CLEO decisions and measurements.
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

**Package note**: `@cleocode/core` is the standalone npm package containing all CLEO business logic. It can be installed independently of `@cleocode/cleo`. The `@cleocode/cleo` product wraps `@cleocode/core` with the `cleo` CLI -- the sole runtime surface. When working directly with business logic -- tasks, sessions, memory, orchestration, lifecycle, release -- use `@cleocode/core`. See the [CORE API agent guide](../reference/core-sdk.md) for the API contract.
