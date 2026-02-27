# ADR-008: CLEO Canonical Architecture — Shared-Core with CQRS Dispatch

**Date**: 2026-02-22
**Status**: accepted
**Accepted**: 2026-02-22
**Related Tasks**: T4797, T4781, T4813, T4863, T4800
**Amended By**: ADR-017, ADR-020
**Summary**: Defines the canonical shared-core + CQRS dispatch architecture. src/core/ is the single source of truth for all business logic. CLI and MCP are thin wrappers that parse/translate then delegate to core. Introduces the dispatch layer (cleo_query/cleo_mutate) as the uniform interface.
**Keywords**: architecture, shared-core, cqrs, dispatch, mcp, cli, core, canonical
**Topics**: admin, orchestrate, tools, naming

---

## 1. Architectural Principles

| Principle | Implementation |
|-----------|----------------|
| **Single Responsibility** | Each layer has exactly one reason to change. Core = business logic. CLI/MCP = I/O adapters only. |
| **Open/Closed** | Extend via domain registration, not modification. New operations register in dispatch. |
| **Liskov Substitution** | All store providers (JSON, SQLite, Dual) implement DataAccessor interface identically. |
| **Interface Segregation** | Granular operation types — no god objects. Each domain exports minimal surface area. |
| **Dependency Inversion** | Core depends on abstractions (types, interfaces). CLI/MCP depend on core. Never the reverse. |
| **DRY** | Business logic lives in ONE location: `src/core/`. Zero duplication between CLI and MCP. |
| **CQRS** | Query (read) and Mutate (write) operations segregated at gateway → dispatch → core boundaries. |

---

## 2. Canonical Architecture Tree

```
src/
├── index.ts                    # Public API exports (library consumers)
│
├── types/                      # SINGLE SOURCE OF TRUTH: All type definitions
│   ├── index.ts               # Barrel exports
│   ├── config.ts              # Configuration types
│   ├── exit-codes.ts          # Exit code constants
│   ├── lafs.ts                # LAFS envelope types
│   ├── session.ts             # Session domain types
│   ├── task.ts                # Task domain types
│   └── operations/            # Operation parameter types (canonical)
│       ├── tasks.ts
│       ├── session.ts
│       ├── memory.ts          # Formerly "research"
│       ├── check.ts           # Formerly "validate"
│       ├── pipeline.ts        # Merged: lifecycle + release
│       ├── orchestrate.ts
│       ├── tools.ts           # Merged: skills + providers + issues
│       ├── admin.ts           # Decomposed from system
│       └── nexus.ts           # Cross-project (global scope)
│
├── core/                       # CANONICAL: All business logic
│   ├── index.ts               # Core module exports
│   ├── errors.ts              # Error hierarchy
│   ├── schema.ts              # JSON Schema definitions
│   │
│   ├── tasks/                 # Domain: Task CRUD + analysis
│   │   ├── index.ts          # Barrel: add, update, complete, delete, restore
│   │   ├── add.ts            # Single operation: add task
│   │   ├── update.ts         # Single operation: update task
│   │   ├── complete.ts       # Single operation: complete task
│   │   ├── delete.ts         # Single operation: delete task
│   │   ├── restore.ts        # Single operation: restore/unarchive
│   │   ├── reparent.ts       # Single operation: change parent
│   │   ├── reorder.ts        # Single operation: change position
│   │   ├── promote.ts        # Single operation: promote to epic
│   │   ├── hierarchy.ts      # Tree building, path operations
│   │   ├── dependency-check.ts # Blockers, dependents
│   │   ├── graph-ops.ts      # Waves, next task, topological sort
│   │   ├── analyze.ts        # Priority analysis
│   │   ├── relates.ts        # Relationship management
│   │   ├── labels.ts         # Label operations
│   │   ├── complexity.ts     # Complexity estimation
│   │   ├── export.ts         # Task export
│   │   ├── import.ts         # Task import
│   │   ├── lint.ts           # Task validation
│   │   ├── batch.ts          # Batch operations
│   │   └── __tests__/        # Co-located tests
│   │
│   ├── sessions/              # Domain: Session lifecycle
│   │   ├── index.ts          # Barrel: start, end, resume, list, gc
│   │   ├── start.ts          # Start new session
│   │   ├── end.ts            # End session
│   │   ├── resume.ts         # Resume existing session
│   │   ├── suspend.ts        # Suspend session
│   │   ├── list.ts           # List sessions
│   │   ├── show.ts           # Get session details
│   │   ├── history.ts        # Session history
│   │   ├── gc.ts             # Garbage collection
│   │   ├── decisions.ts      # Decision recording
│   │   ├── assumptions.ts    # Assumption recording
│   │   ├── drift.ts          # Context drift detection
│   │   └── __tests__/
│   │
│   ├── memory/                # Domain: Long-term knowledge (renamed from research)
│   │   ├── index.ts          # Barrel: find, show, inject, link
│   │   ├── find.ts           # Search knowledge base
│   │   ├── show.ts           # Get entry by ID
│   │   ├── list.ts           # List entries
│   │   ├── pending.ts        # Pending research tasks
│   │   ├── stats.ts          # Memory statistics
│   │   ├── manifest.ts       # MANIFEST.jsonl operations
│   │   ├── inject.ts         # Knowledge injection
│   │   ├── link.ts           # Cross-reference linking
│   │   ├── contradictions.ts # Detect contradictions
│   │   ├── superseded.ts     # Superseded entry detection
│   │   ├── compact.ts        # Manifest compaction
│   │   ├── store.ts          # BRAIN: memory.store (future)
│   │   ├── recall.ts         # BRAIN: memory.recall (future)
│   │   ├── consolidate.ts    # BRAIN: memory.consolidate (future)
│   │   └── __tests__/
│   │
│   ├── check/                 # Domain: Validation + QA (renamed from validate)
│   │   ├── index.ts          # Barrel: schema, protocol, compliance
│   │   ├── schema.ts         # Schema validation
│   │   ├── protocol.ts       # Protocol validation
│   │   ├── task.ts           # Task structure validation
│   │   ├── manifest.ts       # Manifest validation
│   │   ├── output.ts         # Agent output validation
│   │   ├── coherence.ts      # Coherence checks
│   │   ├── compliance.ts     # Compliance summary/violations
│   │   ├── doctor/           # Health checks
│   │   │   ├── index.ts
│   │   │   └── checks/       # Individual health checks
│   │   ├── test.ts           # Test status/coverage
│   │   ├── intelligence.ts   # BRAIN: check.intelligence.* (future)
│   │   └── __tests__/
│   │
│   ├── pipeline/              # Domain: RCSD-IVTR + Release (merged)
│   │   ├── index.ts          # Barrel: stage.*, release.*
│   │   ├── stage/            # Lifecycle stage operations
│   │   │   ├── validate.ts
│   │   │   ├── status.ts
│   │   │   ├── history.ts
│   │   │   ├── gates.ts
│   │   │   ├── prerequisites.ts
│   │   │   ├── record.ts
│   │   │   ├── skip.ts
│   │   │   ├── reset.ts
│   │   │   ├── gate-pass.ts
│   │   │   └── gate-fail.ts
│   │   ├── release/          # Release operations
│   │   │   ├── prepare.ts
│   │   │   ├── changelog.ts
│   │   │   ├── commit.ts
│   │   │   ├── tag.ts
│   │   │   ├── push.ts
│   │   │   ├── gates-run.ts
│   │   │   └── rollback.ts
│   │   ├── state-machine.ts  # RCSD-IVTR state machine
│   │   └── __tests__/
│   │
│   ├── orchestrate/           # Domain: Multi-agent coordination
│   │   ├── index.ts          # Barrel: status, spawn, analyze
│   │   ├── status.ts         # Orchestration status
│   │   ├── analyze.ts        # Dependency analysis
│   │   ├── ready.ts          # Ready task detection
│   │   ├── next.ts           # Next task recommendation
│   │   ├── waves.ts          # Wave computation
│   │   ├── context.ts        # Context management
│   │   ├── spawn.ts          # Subagent spawning
│   │   ├── startup.ts        # Orchestrator startup
│   │   ├── bootstrap.ts      # Brain bootstrap
│   │   ├── critical-path.ts  # Critical path analysis
│   │   ├── unblock.ts        # Unblock opportunities
│   │   ├── parallel.ts       # Parallel execution
│   │   ├── verify.ts         # Orchestration verification (renamed from check)
│   │   ├── agent.ts          # BRAIN: orchestrate.agent.* (future)
│   │   └── __tests__/
│   │
│   ├── tools/                 # Domain: Skills + Providers + Issues (merged)
│   │   ├── index.ts          # Barrel: skill.*, provider.*, issue.*
│   │   ├── skill/            # Skill operations
│   │   │   ├── list.ts
│   │   │   ├── show.ts
│   │   │   ├── find.ts
│   │   │   ├── dispatch.ts
│   │   │   ├── verify.ts
│   │   │   ├── dependencies.ts
│   │   │   ├── install.ts
│   │   │   ├── uninstall.ts
│   │   │   ├── enable.ts
│   │   │   ├── disable.ts
│   │   │   ├── configure.ts
│   │   │   └── refresh.ts
│   │   ├── provider/         # Provider operations
│   │   │   ├── list.ts
│   │   │   ├── detect.ts
│   │   │   ├── inject.ts
│   │   │   └── status.ts
│   │   ├── issue/            # Issue operations
│   │   │   ├── diagnostics.ts
│   │   │   ├── create-bug.ts
│   │   │   ├── create-feature.ts
│   │   │   └── create-help.ts
│   │   └── __tests__/
│   │
│   ├── admin/                 # Domain: Infrastructure (decomposed from system)
│   │   ├── index.ts          # Barrel: version, health, config, backup
│   │   ├── version.ts        # Version info
│   │   ├── health.ts         # Health checks
│   │   ├── config.ts         # Config get/set
│   │   ├── stats.ts          # Statistics
│   │   ├── context.ts        # Context operations
│   │   ├── backup.ts         # Backup operations
│   │   ├── restore.ts        # Restore operations
│   │   ├── migrate.ts        # Migration operations
│   │   ├── sync.ts           # Sync operations
│   │   ├── cleanup.ts        # Cleanup operations
│   │   ├── job.ts            # Background jobs
│   │   ├── safestop.ts       # Safe stop
│   │   ├── inject-generate.ts # Injection generation
│   │   ├── dashboard.ts      # Dashboard
│   │   ├── log.ts            # Logging
│   │   ├── sequence.ts       # Sequence operations
│   │   └── __tests__/
│   │
│   ├── nexus/                 # Domain: Cross-project (global ~/.cleo/ scope)
│   │   ├── index.ts          # Barrel: find, export, import, agents
│   │   ├── find.ts           # Cross-project search
│   │   ├── export.ts         # Cross-project export
│   │   ├── import.ts         # Cross-project import
│   │   ├── agents.ts         # Global agent registry
│   │   ├── coordinate.ts     # Multi-project coordination
│   │   ├── similarity.ts     # Pattern similarity
│   │   ├── insights.ts       # Cross-project insights
│   │   ├── list-patterns.ts  # Global pattern listing
│   │   └── __tests__/
│   │
│   ├── validation/            # Domain: Internal validation (lib)
│   │   ├── index.ts
│   │   ├── engine.ts
│   │   ├── gap-check.ts
│   │   ├── manifest.ts
│   │   ├── docs-sync.ts
│   │   └── protocol/
│   │       ├── common.ts
│   │       ├── research.ts
│   │       ├── consensus.ts
│   │       ├── architecture-decision.ts
│   │       ├── specification.ts
│   │       ├── decomposition.ts
│   │       ├── implementation.ts
│   │       ├── contribution.ts
│   │       ├── validation.ts
│   │       ├── testing.ts
│   │       └── release.ts
│   │
│   ├── compliance/            # Domain: Compliance checking
│   ├── context/               # Domain: Context management
│   ├── focus/                 # Domain: Deprecated shim (canonical: task-work/)
│   ├── inject/                # Domain: Injection system
│   ├── issue/                 # Domain: Issue creation
│   ├── lifecycle/             # Domain: Legacy lifecycle (migrating to pipeline)
│   ├── log/                   # Domain: Audit logging
│   ├── metrics/               # Domain: Metrics and telemetry
│   ├── migration/             # Domain: Data migration
│   ├── otel/                  # Domain: OpenTelemetry
│   ├── phases/                # Domain: Phase management
│   ├── release/               # Domain: Legacy release (migrating to pipeline)
│   ├── roadmap/               # Domain: Roadmap generation
│   ├── sequence/              # Domain: Sequence management
│   ├── skills/                # Domain: Legacy skills (migrating to tools)
│   ├── stats/                 # Domain: Statistics
│   ├── system/                # Domain: Legacy system (decomposing to admin)
│   ├── task-work/             # Domain: Work history
│   └── ui/                    # Domain: UI utilities
│
├── store/                      # Data Persistence Layer
│   ├── index.ts               # Store exports
│   ├── schema.ts              # Drizzle ORM schema (SINGLE SOURCE OF TRUTH)
│   ├── data-accessor.ts       # DataAccessor interface
│   ├── provider.ts            # Provider factory
│   ├── atomic.ts              # Atomic operations
│   ├── backup.ts              # Backup management
│   ├── cache.ts               # Caching layer
│   ├── lock.ts                # File locking
│   │
│   ├── json-data-accessor.ts  # JSON implementation
│   ├── json-provider.ts       # JSON provider
│   ├── sqlite-data-accessor.ts # SQLite implementation
│   ├── sqlite.ts              # SQLite utilities
│   ├── safety-data-accessor.ts # Safety wrapper
│   ├── session-store.ts       # Session persistence
│   ├── task-store.ts          # Task persistence
│   ├── git-checkpoint.ts      # Git integration
│   ├── export.ts              # Export functionality
│   ├── import-logging.ts      # Import logging
│   ├── migration-sqlite.ts    # Migration logic
│   └── __tests__/
│
├── dispatch/                   # CQRS Dispatch Layer
│   ├── index.ts               # Dispatch exports
│   ├── dispatcher.ts          # Central dispatcher
│   ├── registry.ts            # Operation registry (140+ operations)
│   ├── types.ts               # Dispatch types
│   │
│   ├── adapters/              # Entry point adapters
│   │   ├── cli.ts             # CLI adapter (maps CLI args → operations)
│   │   └── mcp.ts             # MCP adapter (maps MCP params → operations)
│   │
│   ├── domains/               # Domain handlers (thin wrappers)
│   │   ├── index.ts
│   │   ├── tasks.ts           # Routes to src/core/tasks/
│   │   ├── session.ts         # Routes to src/core/sessions/
│   │   ├── memory.ts          # Routes to src/core/memory/
│   │   ├── check.ts           # Routes to src/core/check/
│   │   ├── pipeline.ts        # Routes to src/core/pipeline/
│   │   ├── orchestrate.ts     # Routes to src/core/orchestration/
│   │   ├── tools.ts           # Routes to src/core/tools/
│   │   ├── admin.ts           # Routes to src/core/admin/
│   │   ├── nexus.ts           # Routes to src/core/nexus/
│   │   └── _meta.ts           # Meta operations
│   │
│   ├── middleware/            # Cross-cutting concerns
│   │   ├── audit.ts           # Audit logging
│   │   ├── pipeline.ts        # RCSD-IVTR enforcement
│   │   ├── protocol-enforcement.ts # CLEO protocol validation
│   │   ├── rate-limiter.ts    # Rate limiting
│   │   ├── sanitizer.ts       # Input sanitization
│   │   └── verification-gates.ts # Gate checking
│   │
│   └── lib/
│       └── meta.ts            # Metadata utilities
│
├── cli/                        # CLI Interface (THIN WRAPPER ONLY)
│   ├── index.ts               # CLI entry point
│   ├── format-context.ts      # Context formatting
│   │
│   ├── commands/              # 80+ command files
│   │   ├── add.ts             # Calls dispatch → core/tasks/add.ts
│   │   ├── update.ts          # Calls dispatch → core/tasks/update.ts
│   │   ├── complete.ts        # Calls dispatch → core/tasks/complete.ts
│   │   ├── delete.ts          # Calls dispatch → core/tasks/delete.ts
│   │   ├── restore.ts         # Calls dispatch → core/tasks/restore.ts
│   │   ├── list.ts            # Calls dispatch → core/tasks/list.ts
│   │   ├── show.ts            # Calls dispatch → core/tasks/show.ts
│   │   ├── find.ts            # Calls dispatch → core/tasks/find.ts
│   │   ├── start.ts           # Calls dispatch → core/tasks/start.ts
│   │   ├── stop.ts            # Calls dispatch → core/tasks/stop.ts
│   │   ├── reparent.ts        # Calls dispatch → core/tasks/reparent.ts
│   │   ├── session.ts         # Calls dispatch → core/sessions/
│   │   └── ... (80 total)
│   │
│   ├── middleware/
│   │   └── output-format.ts   # Output formatting
│   │
│   └── renderers/
│       ├── index.ts
│       ├── colors.ts
│       ├── tasks.ts           # Task output rendering
│       └── system.ts          # System output rendering
│
└── mcp/                        # MCP Gateway (THIN WRAPPER ONLY)
    ├── index.ts               # MCP module entry
    │
    ├── gateways/              # MCP Tool Entry Points
    │   ├── query.ts           # cleo_query gateway (75 operations)
    │   └── mutate.ts          # cleo_mutate gateway (65 operations)
    │
    ├── domains/               # DEPRECATED: Domain handlers
    │   ├── tasks.ts           # → Migrate to dispatch/domains/
    │   ├── session.ts         # → Migrate to dispatch/domains/
    │   ├── system.ts          # → Migrate to dispatch/domains/
    │   ├── lifecycle.ts       # → Migrate to dispatch/domains/
    │   ├── orchestrate.ts     # → Migrate to dispatch/domains/
    │   ├── research.ts        # → Migrate to dispatch/domains/
    │   ├── validate.ts        # → Migrate to dispatch/domains/
    │   ├── release.ts         # → Migrate to dispatch/domains/
    │   ├── skills.ts          # → Migrate to dispatch/domains/
    │   ├── providers.ts       # → Migrate to dispatch/domains/
    │   └── issues.ts          # → Migrate to dispatch/domains/
    │
    ├── engine/                # DEPRECATED: Engine adapters
    │   ├── task-engine.ts     # → Migrate logic to src/core/tasks/
    │   ├── session-engine.ts  # DELETED (ADR-020) — migrated to src/core/sessions/
    │   ├── system-engine.ts   # → Migrate logic to src/core/admin/
    │   ├── lifecycle-engine.ts # → Migrate logic to src/core/pipeline/
    │   ├── orchestrate-engine.ts # → Migrate logic to src/core/orchestration/
    │   ├── research-engine.ts # → Migrate logic to src/core/memory/
    │   ├── validate-engine.ts # → Migrate logic to src/core/check/
    │   ├── release-engine.ts  # → Migrate logic to src/core/pipeline/
    │   ├── config-engine.ts   # → Migrate logic to src/core/config/
    │   └── init-engine.ts     # → Migrate logic to src/core/init/
    │
    ├── types/                 # DEPRECATED: Parallel type definitions
    │   ├── index.ts
    │   ├── domain.ts
    │   ├── error.ts
    │   ├── gateway.ts
    │   └── operations/        # → Consolidate into src/types/operations/
    │
    └── lib/                   # MCP utilities (keep)
        ├── router.ts
        ├── security.ts
        ├── schema.ts
        ├── audit.ts
        ├── cache.ts
        ├── rate-limiter.ts
        └── ...
```

---

## 3. Data Flow Architecture

### 3.1 Query Flow (Read Operations)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ENTRY POINTS                                 │
├─────────────────────────┬───────────────────────────────────────────┤
│   CLI Command           │   MCP Gateway                             │
│   (e.g., cleo show T1)  │   (cleo_query)                            │
└───────────┬─────────────┴───────────────┬───────────────────────────┘
            │                             │
            ▼                             ▼
┌─────────────────────────┐   ┌───────────────────────────────────────┐
│   CLI Adapter           │   │   MCP Adapter                         │
│   src/dispatch/         │   │   src/dispatch/adapters/mcp.ts        │
│   adapters/cli.ts       │   │                                       │
│                         │   │   Validates params against            │
│   Parses arguments      │   │   src/types/operations/*.ts           │
│   Maps to canonical     │   │   Transforms to LAFS envelope         │
│   operation format      │   │                                       │
└───────────┬─────────────┴───────────────┬───────────────────────────┘
            │                             │
            └──────────────┬──────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │   CENTRAL DISPATCHER         │
            │   src/dispatch/dispatcher.ts │
            │                              │
            │   • Registry lookup          │
            │  • Middleware pipeline       │
            │  • Route to domain handler   │
            └──────────────┬───────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
            ▼              ▼              ▼
┌───────────────┐ ┌──────────────┐ ┌──────────────┐
│   Middleware  │ │   Middleware │ │   Middleware │
│   Pipeline    │ │   Pipeline   │ │   Pipeline   │
│               │ │              │ │              │
│ 1. Sanitizer  │ │ 1. Sanitizer │ │ 1. Sanitizer │
│ 2. Rate Limit │ │ 2. Rate Limit│ │ 2. Rate Limit│
│ 3. Audit Log  │ │ 3. Audit Log │ │ 3. Audit Log │
└───────┬───────┘ └──────┬───────┘ └──────┬───────┘
        │                │                │
        └────────────────┼────────────────┘
                         │
                         ▼
            ┌──────────────────────────────┐
            │   DOMAIN HANDLER             │
            │   src/dispatch/domains/*.ts  │
            │                              │
            │   Zero business logic.       │
            │   Pure routing.              │
            └──────────────┬───────────────┘
                         │
                         ▼
            ┌──────────────────────────────┐
            │   CORE BUSINESS LOGIC        │
            │   src/core/{domain}/*.ts     │
            │                              │
            │   • Validation               │
            │   • Business rules           │
            │   • Data transformation      │
            │   • Error handling           │
            └──────────────┬───────────────┘
                         │
                         ▼
            ┌──────────────────────────────┐
            │   DATA ACCESSOR              │
            │   src/store/data-accessor.ts │
            │                              │
            │   Interface:                 │
            │   • read()                   │
            │   • write()                  │
            │   • query()                  │
            └──────────────┬───────────────┘
                         │
            ┌────────────┴────────────┐
            │                         │
            ▼                         ▼
┌───────────────────┐     ┌───────────────────┐
│   JSON Provider   │     │   SQLite Provider │
│   (read-only      │     │   (primary)       │
│    fallback)      │     │                   │
│                   │     │   src/store/      │
│   src/store/      │     │   sqlite-*.ts     │
│   json-*.ts       │     │                   │
│                   │     │   Drizzle ORM     │
│   tasks.json      │     │   tasks.db        │
└───────────────────┘     └───────────────────┘
```

### 3.2 Mutate Flow (Write Operations)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ENTRY POINTS                                 │
├─────────────────────────┬───────────────────────────────────────────┤
│   CLI Command           │   MCP Gateway                             │
│   (e.g., cleo add ...)  │   (cleo_mutate)                           │
└───────────┬─────────────┴───────────────┬───────────────────────────┘
            │                             │
            ▼                             ▼
┌─────────────────────────┐   ┌───────────────────────────────────────┐
│   CLI Adapter           │   │   MCP Adapter                         │
│   src/dispatch/         │   │   src/dispatch/adapters/mcp.ts        │
│   adapters/cli.ts       │   │                                       │
│                         │   │   Security validation                 │
│   Parse args            │   │   Field filtering                     │
│   Build operation       │   │   Transform params                    │
└───────────┬─────────────┴───────────────┬───────────────────────────┘
            │                             │
            └──────────────┬──────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │   CENTRAL DISPATCHER         │
            │   src/dispatch/dispatcher.ts │
            └──────────────┬───────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
            ▼              ▼              ▼
┌───────────────┐ ┌──────────────┐ ┌──────────────┐
│   Middleware  │ │   Middleware │ │   Middleware │
│   Pipeline    │ │   Pipeline   │ │   Pipeline   │
│               │ │              │ │              │
│ 1. Sanitizer  │ │ 1. Sanitizer │ │ 1. Sanitizer │
│ 2. Rate Limit │ │ 2. Rate Limit│ │ 2. Rate Limit│
│ 3. Protocol   │ │ 3. Protocol  │ │ 3. Protocol  │
│    Check      │ │    Check     │ │    Check     │
│ 4. Gate Check │ │ 4. Gate Check│ │ 4. Gate Check│
│ 5. Audit Log  │ │ 5. Audit Log │ │ 5. Audit Log │
└───────┬───────┘ └──────┬───────┘ └──────┬───────┘
        │                │                │
        └────────────────┼────────────────┘
                         │
                         ▼
            ┌──────────────────────────────┐
            │   DOMAIN HANDLER             │
            │   src/dispatch/domains/*.ts  │
            └──────────────┬───────────────┘
                         │
                         ▼
            ┌──────────────────────────────┐
            │   CORE BUSINESS LOGIC        │
            │   src/core/{domain}/*.ts     │
            │                              │
            │   All validation happens     │
            │   here before storage call   │
            └──────────────┬───────────────┘
                         │
                         ▼
            ┌──────────────────────────────┐
            │   ATOMIC WRITE PATTERN       │
            │                              │
            │   1. Write to temp file      │
            │   2. Validate schema         │
            │   3. Create backup           │
            │   4. Atomic rename           │
            └──────────────┬───────────────┘
                         │
                         ▼
            ┌──────────────────────────────┐
            │   DATA ACCESSOR              │
            │   src/store/data-accessor.ts │
            └──────────────┬───────────────┘
                         │
            ┌────────────┴────────────┐
            │                         │
            ▼                         ▼
┌───────────────────┐     ┌───────────────────┐
│   DUAL-WRITE      │     │   SQLite Write    │
│   (backward       │     │   (primary)       │
│    compatibility) │     │                   │
│                   │     │   Drizzle ORM     │
│   tasks.json      │     │   tasks.db        │
│   (read-only      │     │                   │
│    after sunset)  │     │   Canonical       │
└───────────────────┘     └───────────────────┘
```

---

## 4. Domain Consolidation Map (11 → 9 Domains)

| Old Domain | New Domain | Operations | Migration Path |
|------------|------------|------------|----------------|
| **tasks** | **tasks** | ~29 ops | Keep. Absorb leaked system ops (labels, roadmap, archive.stats) |
| **session** | **session** | 13 ops | Keep unchanged |
| **research** | **memory** | 12 ops | Rename. BRAIN: memory.store/recall/consolidate |
| **validate** | **check** | 12 ops | Rename. Avoids collision with validate operations |
| **lifecycle** | **pipeline** | 5+7 ops | Merge with release. Prefix: `pipeline.stage.*` and `pipeline.release.*` |
| **release** | **pipeline** | 7 ops | Merge into pipeline domain |
| **orchestrate** | **orchestrate** | ~15 ops | Keep. Rename `check` → `verify`. Remove `skill.list` |
| **skills** | **tools.skill** | 12 ops | Merge into tools domain |
| **providers** | **tools.provider** | 4 ops | Merge into tools domain |
| **issues** | **tools.issue** | 4 ops | Merge into tools domain |
| **system** | **admin** | ~14 ops | Decompose. Remaining ops → admin |
| (new) | **nexus** | 0 ops | New domain for ~/.cleo/ global scope |

---

## 5. Operation Registry (140 Operations)

### 5.1 Query Operations (75)

| Domain | Operation | Core Function | Description |
|--------|-----------|---------------|-------------|
| tasks | show | tasks/show.ts | Get task by ID |
| tasks | list | tasks/index.ts | List tasks with filters |
| tasks | find | tasks/index.ts | Search tasks |
| tasks | exists | tasks/index.ts | Check task existence |
| tasks | tree | tasks/hierarchy.ts | Build task tree |
| tasks | blockers | tasks/dependency-check.ts | Get blocked tasks |
| tasks | depends | tasks/dependency-check.ts | Get dependencies |
| tasks | analyze | tasks/analyze.ts | Analyze priority |
| tasks | next | tasks/graph-ops.ts | Get next task |
| tasks | relates | tasks/relates.ts | List relations |
| tasks | complexity.estimate | tasks/complexity.ts | Estimate complexity |
| tasks | current | task-work/index.ts | Get current task |
| tasks | labels | tasks/labels.ts | List labels |
| tasks | roadmap | tasks/roadmap.ts | Generate roadmap |
| tasks | archive.stats | tasks/archive.ts | Archive statistics |
| session | status | sessions/index.ts | Get session status |
| session | list | sessions/list.ts | List sessions |
| session | show | sessions/show.ts | Get session details |
| session | history | sessions/history.ts | Session history |
| session | decision.log | sessions/decisions.ts | List decisions |
| session | context.drift | sessions/drift.ts | Drift score |
| memory | show | memory/index.ts | Get entry by ID |
| memory | list | memory/list.ts | List entries |
| memory | find | memory/find.ts | Search entries |
| memory | pending | memory/pending.ts | Pending research |
| memory | stats | memory/stats.ts | Memory statistics |
| memory | manifest.read | memory/manifest.ts | Read manifest |
| memory | contradictions | memory/contradictions.ts | Find contradictions |
| memory | superseded | memory/superseded.ts | Superseded entries |
| check | schema | check/schema.ts | Validate schema |
| check | protocol | check/protocol.ts | Validate protocol |
| check | task | check/task.ts | Validate task |
| check | manifest | check/manifest.ts | Validate manifest |
| check | output | check/output.ts | Validate output |
| check | compliance.summary | check/compliance.ts | Compliance summary |
| check | compliance.violations | check/compliance.ts | Violation list |
| check | test.status | check/test.ts | Test status |
| check | test.coverage | check/test.ts | Test coverage |
| check | coherence.check | check/coherence.ts | Coherence check |
| pipeline | stage.status | pipeline/stage/status.ts | Pipeline status |
| pipeline | stage.history | pipeline/stage/history.ts | Stage history |
| pipeline | stage.gates | pipeline/stage/gates.ts | Gate status |
| pipeline | stage.prerequisites | pipeline/stage/prerequisites.ts | Prerequisites |
| pipeline | release.list | pipeline/release/index.ts | List releases |
| pipeline | release.show | pipeline/release/index.ts | Show release |
| orchestrate | status | orchestrate/status.ts | Orchestration status |
| orchestrate | analyze | orchestrate/analyze.ts | Dependency analysis |
| orchestrate | ready | orchestrate/ready.ts | Ready tasks |
| orchestrate | next | orchestrate/next.ts | Next recommendation |
| orchestrate | waves | orchestrate/waves.ts | Wave computation |
| orchestrate | context | orchestrate/context.ts | Context state |
| orchestrate | bootstrap | orchestrate/bootstrap.ts | Brain bootstrap |
| orchestrate | critical.path | orchestrate/critical-path.ts | Critical path |
| orchestrate | unblock.opportunities | orchestrate/unblock.ts | Unblock analysis |
| orchestrate | verify | orchestrate/verify.ts | Verify state (renamed from check) |
| tools | skill.list | tools/skill/list.ts | List skills |
| tools | skill.show | tools/skill/show.ts | Show skill |
| tools | skill.find | tools/skill/find.ts | Find skills |
| tools | skill.dispatch | tools/skill/dispatch.ts | Dispatch skill |
| tools | skill.verify | tools/skill/verify.ts | Verify skill |
| tools | skill.dependencies | tools/skill/dependencies.ts | Skill deps |
| tools | provider.list | tools/provider/list.ts | List providers |
| tools | provider.detect | tools/provider/detect.ts | Detect providers |
| tools | provider.inject.status | tools/provider/status.ts | Inject status |
| tools | issue.diagnostics | tools/issue/diagnostics.ts | Issue diagnostics |
| admin | version | admin/version.ts | CLEO version |
| admin | health | admin/health.ts | Health check |
| admin | config.get | admin/config.ts | Get config |
| admin | stats | admin/stats.ts | System stats |
| admin | context | admin/context.ts | Context info |
| admin | job.status | admin/job.ts | Job status |
| admin | job.list | admin/job.ts | List jobs |
| admin | dash | admin/dashboard.ts | Dashboard |
| admin | log | admin/log.ts | System log |
| admin | sequence | admin/sequence.ts | Sequence |

### 5.2 Mutate Operations (65)

| Domain | Operation | Core Function | Description |
|--------|-----------|---------------|-------------|
| tasks | add | tasks/add.ts | Add task |
| tasks | update | tasks/update.ts | Update task |
| tasks | complete | tasks/complete.ts | Complete task |
| tasks | delete | tasks/delete.ts | Delete task |
| tasks | archive | tasks/delete.ts | Archive task |
| tasks | restore | tasks/restore.ts | Restore/unarchive |
| tasks | reparent | tasks/reparent.ts | Change parent |
| tasks | promote | tasks/promote.ts | Promote to epic |
| tasks | reorder | tasks/reorder.ts | Reorder task |
| tasks | reopen | tasks/restore.ts | Reopen task |
| tasks | relates.add | tasks/relates.ts | Add relation |
| tasks | uncancel | tasks/restore.ts | Uncancel task |
| tasks | start | task-work/index.ts | Start work |
| tasks | stop | task-work/index.ts | Stop work |
| session | start | sessions/start.ts | Start session |
| session | end | sessions/end.ts | End session |
| session | resume | sessions/resume.ts | Resume session |
| session | suspend | sessions/suspend.ts | Suspend session |
| session | gc | sessions/gc.ts | Garbage collect |
| session | record.decision | sessions/decisions.ts | Record decision |
| session | record.assumption | sessions/assumptions.ts | Record assumption |
| memory | inject | memory/inject.ts | Inject knowledge |
| memory | link | memory/link.ts | Link entries |
| memory | manifest.append | memory/manifest.ts | Append to manifest |
| memory | manifest.archive | memory/manifest.ts | Archive manifest |
| check | compliance.record | check/compliance.ts | Record compliance |
| check | test.run | check/test.ts | Run tests |
| pipeline | stage.record | pipeline/stage/record.ts | Record stage |
| pipeline | stage.skip | pipeline/stage/skip.ts | Skip stage |
| pipeline | stage.reset | pipeline/stage/reset.ts | Reset stage |
| pipeline | stage.gate.pass | pipeline/stage/gate-pass.ts | Pass gate |
| pipeline | stage.gate.fail | pipeline/stage/gate-fail.ts | Fail gate |
| pipeline | release.prepare | pipeline/release/prepare.ts | Prepare release |
| pipeline | release.changelog | pipeline/release/changelog.ts | Generate changelog |
| pipeline | release.commit | pipeline/release/commit.ts | Commit changes |
| pipeline | release.tag | pipeline/release/tag.ts | Create tag |
| pipeline | release.push | pipeline/release/push.ts | Push release |
| pipeline | release.gates.run | pipeline/release/gates-run.ts | Run gates |
| pipeline | release.rollback | pipeline/release/rollback.ts | Rollback release |
| orchestrate | start | orchestrate/startup.ts | Start orchestration |
| orchestrate | spawn | orchestrate/spawn.ts | Spawn subagent |
| orchestrate | validate | orchestrate/protocol-validators.ts | Validate orchestration |
| orchestrate | parallel.start | orchestrate/parallel.ts | Start parallel |
| orchestrate | parallel.end | orchestrate/parallel.ts | End parallel |
| tools | skill.install | tools/skill/install.ts | Install skill |
| tools | skill.uninstall | tools/skill/uninstall.ts | Uninstall skill |
| tools | skill.enable | tools/skill/enable.ts | Enable skill |
| tools | skill.disable | tools/skill/disable.ts | Disable skill |
| tools | skill.configure | tools/skill/configure.ts | Configure skill |
| tools | skill.refresh | tools/skill/refresh.ts | Refresh skills |
| tools | provider.inject | tools/provider/inject.ts | Inject provider |
| tools | issue.create.bug | tools/issue/create-bug.ts | Create bug issue |
| tools | issue.create.feature | tools/issue/create-feature.ts | Create feature issue |
| tools | issue.create.help | tools/issue/create-help.ts | Create help issue |
| admin | init | core/init.ts | Initialize project |
| admin | config.set | admin/config.ts | Set config |
| admin | backup | admin/backup.ts | Create backup |
| admin | restore | admin/restore.ts | Restore backup |
| admin | migrate | admin/migrate.ts | Run migration |
| admin | sync | admin/sync.ts | Sync project |
| admin | cleanup | admin/cleanup.ts | Cleanup data |
| admin | job.cancel | admin/job.ts | Cancel job |
| admin | safestop | admin/safestop.ts | Safe stop |
| admin | inject.generate | admin/inject-generate.ts | Generate injection |

---

## 6. Type System Architecture

### 6.1 Type Hierarchy

```
src/types/
│
├── index.ts                 # Barrel exports all types
│
├── Base Types
│   ├── config.ts           # Configuration schemas
│   ├── exit-codes.ts       # Exit code constants (enum)
│   ├── lafs.ts             # LAFS envelope types
│   ├── session.ts          # Session domain types
│   └── task.ts             # Task domain types
│
└── operations/             # Operation parameter types (canonical)
    ├── tasks.ts            # TasksOperationParams
    ├── session.ts          # SessionOperationParams
    ├── memory.ts           # MemoryOperationParams
    ├── check.ts            # CheckOperationParams
    ├── pipeline.ts         # PipelineOperationParams
    ├── orchestrate.ts      # OrchestrateOperationParams
    ├── tools.ts            # ToolsOperationParams
    ├── admin.ts            # AdminOperationParams
    └── nexus.ts            # NexusOperationParams
```

### 6.2 Type Definition Pattern

```typescript
// src/types/operations/tasks.ts

/** Canonical operation parameter types for tasks domain */

// Query parameters
export interface TasksShowParams {
  id: string;
  includeArchived?: boolean;
}

export interface TasksListParams {
  status?: TaskStatus[];
  priority?: Priority[];
  parentId?: string | null;
  limit?: number;
  offset?: number;
}

// Mutate parameters
export interface TasksAddParams {
  title: string;
  description?: string;
  priority?: Priority;
  status?: TaskStatus;
  parentId?: string;
  dependsOn?: string[];
  labels?: string[];
}

export interface TasksUpdateParams {
  id: string;
  title?: string;
  description?: string;
  priority?: Priority;
  status?: TaskStatus;
  parentId?: string | null;  // Empty string promotes to root
  dependsOn?: string[];
  labels?: string[];
}

// Operation result types
export interface TasksAddResult {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
}

export type TasksOperationParams =
  | TasksShowParams
  | TasksListParams
  | TasksAddParams
  | TasksUpdateParams
  // ... all 29 operations;
```

---

## 7. Store Layer Architecture

### 7.1 Data Accessor Interface

```typescript
// src/store/data-accessor.ts

export interface DataAccessor {
  // Core operations
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, data: T): Promise<void>;
  delete(key: string): Promise<void>;
  
  // Query operations
  query<T>(filter: QueryFilter): Promise<T[]>;
  exists(key: string): Promise<boolean>;
  
  // Transactional operations
  atomic<T>(operation: AtomicOperation<T>): Promise<T>;
  
  // Metadata
  getEngine(): StorageEngine;
  getVersion(): number;
}

export type StorageEngine = 'json' | 'sqlite' | 'dual';
```

### 7.2 Store Provider Hierarchy

```
src/store/
│
├── Abstractions
│   ├── data-accessor.ts         # DataAccessor interface
│   └── provider.ts              # Provider factory
│
├── Implementations
│   ├── json-data-accessor.ts    # JSON file implementation
│   ├── json-provider.ts         # JSON provider factory
│   ├── sqlite-data-accessor.ts  # SQLite implementation
│   └── sqlite.ts                # SQLite utilities
│
├── Wrappers
│   └── safety-data-accessor.ts  # Data safety wrapper
│
├── Specialized Stores
│   ├── session-store.ts         # Session persistence
│   ├── task-store.ts            # Task persistence
│   └── cache.ts                 # Caching layer
│
├── Utilities
│   ├── atomic.ts                # Atomic operations
│   ├── backup.ts                # Backup management
│   ├── lock.ts                  # File locking
│   ├── schema.ts                # Drizzle schema
│   ├── git-checkpoint.ts        # Git integration
│   ├── export.ts                # Export functionality
│   ├── import-logging.ts        # Import logging
│   └── migration-sqlite.ts      # Migration logic
│
└── __tests__/                   # Co-located tests
```

### 7.3 Drizzle Schema (Canonical)

```typescript
// src/store/schema.ts (Single Source of Truth)

// Tables
export const tasks = sqliteTable('tasks', { ... });
export const taskDependencies = sqliteTable('task_dependencies', { ... });
export const taskRelations = sqliteTable('task_relations', { ... });
export const sessions = sqliteTable('sessions', { ... });
export const sessionWorkHistory = sqliteTable('session_work_history', { ... });

// Pipeline (RCSD-IVTR)
export const lifecyclePipelines = sqliteTable('lifecycle_pipelines', { ... });
export const lifecycleStages = sqliteTable('lifecycle_stages', { ... });
export const lifecycleTransitions = sqliteTable('lifecycle_transitions', { ... });
export const lifecycleGateResults = sqliteTable('lifecycle_gate_results', { ... });
export const lifecycleEvidence = sqliteTable('lifecycle_evidence', { ... });

// ADR Registry
export const architectureDecisions = sqliteTable('architecture_decisions', { ... });

// Relations
export const tasksRelations = relations(tasks, ({ one, many }) => ({ ... }));
```

Lifecycle stage authority for `lifecycle_stages.stage_name` is:

```text
research, consensus, architecture_decision, specification, decomposition,
implementation, validation, testing, release, contribution
```

This list MUST stay aligned across:
- `src/core/lifecycle/stages.ts`
- `src/store/schema.ts` CHECK constraints and enums
- the latest effective drizzle migration state under `drizzle/` (historical migrations may reflect prior states)

---

## 8. Dispatch Layer Architecture

### 8.1 Central Dispatcher

```typescript
// src/dispatch/dispatcher.ts

export class OperationDispatcher {
  private registry: OperationRegistry;
  private middleware: Middleware[];
  
  async dispatch<TParams, TResult>(
    operation: string,
    params: TParams,
    context: OperationContext
  ): Promise<OperationResult<TResult>> {
    // 1. Lookup operation in registry
    const handler = this.registry.get(operation);
    
    // 2. Run middleware pipeline
    const ctx = await this.runMiddleware(context, params);
    
    // 3. Execute domain handler
    const result = await handler(params, ctx);
    
    // 4. Return standardized result
    return this.formatResult(result);
  }
}
```

### 8.2 Operation Registry

```typescript
// src/dispatch/registry.ts

export interface OperationDefinition {
  name: string;                    // e.g., "tasks.show"
  domain: Domain;                  // e.g., Domain.TASKS
  type: OperationType;             // QUERY | MUTATE
  handler: OperationHandler;       // Domain handler function
  paramsSchema: ZodSchema;         // Validation schema
  middleware: Middleware[];        // Operation-specific middleware
  rateLimit?: RateLimitConfig;     // Rate limiting
}

// All 140 operations registered here
export const OPERATION_REGISTRY: OperationDefinition[] = [
  // tasks domain
  { name: 'tasks.show', domain: Domain.TASKS, type: OperationType.QUERY, ... },
  { name: 'tasks.list', domain: Domain.TASKS, type: OperationType.QUERY, ... },
  { name: 'tasks.add', domain: Domain.TASKS, type: OperationType.MUTATE, ... },
  // ... 137 more operations
];
```

### 8.3 Middleware Pipeline

```
Execution Order:

1. sanitizer.ts          # Input sanitization (security)
2. rate-limiter.ts       # Rate limiting (DoS protection)
3. protocol-enforcement.ts # CLEO protocol validation
4. verification-gates.ts # Gate checking (RCSD-IVTR)
5. pipeline.ts           # Stage enforcement
6. audit.ts              # Audit logging

Each middleware can:
- Transform params/context
- Short-circuit (return early)
- Pass through (call next)
- Modify result (on return path)
```

---

## 9. CLI Architecture

### 9.1 CLI Command Pattern

```typescript
// src/cli/commands/add.ts

import { Command } from 'commander';
import { dispatch } from '../../dispatch/index.js';

export const addCommand = new Command('add')
  .description('Add a new task')
  .argument('<title>', 'Task title')
  .option('-d, --description <desc>', 'Task description')
  .option('-p, --priority <level>', 'Priority level')
  .option('--parent <id>', 'Parent task ID')
  .action(async (title, options) => {
    // 1. Build canonical params
    const params: TasksAddParams = {
      title,
      description: options.description,
      priority: options.priority,
      parentId: options.parent,
    };
    
    // 2. Dispatch to core
    const result = await dispatch('tasks.add', params);
    
    // 3. Render output
    renderTaskAdded(result.data);
  });
```

### 9.2 CLI Adapter

```typescript
// src/dispatch/adapters/cli.ts

export class CliAdapter {
  async execute(
    operation: string,
    args: string[],
    options: Record<string, unknown>
  ): Promise<void> {
    // 1. Parse CLI arguments
    const params = this.parseArgs(operation, args, options);
    
    // 2. Build operation context
    const context: OperationContext = {
      source: 'cli',
      sessionId: process.env.CLEO_SESSION_ID,
      userAgent: 'cleo-cli',
    };
    
    // 3. Dispatch through central dispatcher
    const result = await dispatcher.dispatch(operation, params, context);
    
    // 4. Handle result
    if (result.success) {
      this.renderSuccess(result.data);
    } else {
      this.renderError(result.error);
      process.exit(result.error.exitCode);
    }
  }
}
```

---

## 10. MCP Architecture

### 10.1 MCP Gateway Entry Points

```typescript
// src/mcp/gateways/query.ts

export const queryGateway = {
  name: 'cleo_query',
  description: 'Query CLEO data (read-only)',
  inputSchema: QueryParamsSchema,
  async handler(params: QueryParams): Promise<QueryResult> {
    // 1. Validate input
    const validParams = validateParams(params);
    
    // 2. Build context
    const context: OperationContext = {
      source: 'mcp',
      sessionId: params.sessionId,
      userAgent: 'mcp-server',
    };
    
    // 3. Dispatch to core
    const result = await dispatcher.dispatch(
      params.operation,
      validParams,
      context
    );
    
    // 4. Return LAFS envelope
    return formatLafsResult(result);
  },
};
```

### 10.2 MCP Adapter

```typescript
// src/dispatch/adapters/mcp.ts

export class McpAdapter {
  async execute(
    operation: string,
    params: unknown,
    mcpContext: McpContext
  ): Promise<LafsEnvelope> {
    // 1. Security sanitization
    const safeParams = security.sanitize(params);
    
    // 2. Transform MCP params to canonical format
    const canonicalParams = this.transformParams(operation, safeParams);
    
    // 3. Build operation context
    const context: OperationContext = {
      source: 'mcp',
      sessionId: mcpContext.sessionId,
      userAgent: 'mcp-server',
      requestId: mcpContext.requestId,
    };
    
    // 4. Dispatch through central dispatcher
    const result = await dispatcher.dispatch(
      operation,
      canonicalParams,
      context
    );
    
    // 5. Format as LAFS envelope
    return this.toLafsEnvelope(result);
  }
  
  private transformParams(operation: string, params: unknown): unknown {
    // Map MCP-specific param names to canonical names
    // e.g., mcp "taskId" → canonical "id"
    // e.g., mcp "parent" → canonical "parentId"
    return mapMcpToCanonical(operation, params);
  }
}
```

---

## 11. Migration Path (Current → Target)

### 11.1 Phase 1: Core Canonicalization (T4781)

| Step | Action | Files | Status |
|------|--------|-------|--------|
| 1 | Create core modules | src/core/{domain}/*.ts | Pending |
| 2 | Migrate task-engine | src/core/tasks/*.ts | Partial |
| 3 | Migrate session-engine | src/core/sessions/*.ts | **COMPLETE** (ADR-020, commit ffe49957) |
| 4 | Migrate system-engine | src/core/admin/*.ts | Pending |
| 5 | Migrate orchestrate-engine | src/core/orchestration/*.ts | Pending |
| 6 | Migrate lifecycle-engine | src/core/pipeline/stage/*.ts | Pending |
| 7 | Migrate validate-engine | src/core/check/*.ts | Pending |
| 8 | Migrate research-engine | src/core/memory/*.ts | Pending |
| 9 | Migrate release-engine | src/core/pipeline/release/*.ts | Pending |
| 10 | Update MCP engine | src/mcp/engine/*.ts → thin wrappers | Pending |
| 11 | Update CLI commands | src/cli/commands/*.ts → dispatch calls | Partial |
| 12 | Integration tests | Verify parity | Pending |

### 11.2 Phase 2: Dispatch Consolidation (T4813)

| Step | Action | Files | Status |
|------|--------|-------|--------|
| 1 | Complete registry | src/dispatch/registry.ts | Partial |
| 2 | CLI adapter | src/dispatch/adapters/cli.ts | Pending |
| 3 | MCP adapter | src/dispatch/adapters/mcp.ts | Pending |
| 4 | Middleware pipeline | src/dispatch/middleware/*.ts | Partial |
| 5 | Domain handlers | src/dispatch/domains/*.ts | Partial |
| 6 | Remove legacy routing | src/mcp/domains/*.ts | Pending |
| 7 | Remove legacy engine | src/mcp/engine/*.ts | Pending |

### 11.3 Phase 3: Type Consolidation

| Step | Action | Files | Status |
|------|--------|-------|--------|
| 1 | Consolidate operation types | src/types/operations/*.ts | Pending |
| 2 | Remove MCP parallel types | src/mcp/types/operations/*.ts | Pending |
| 3 | Update all imports | All files | Pending |

### 11.4 Phase 4: Domain Consolidation (T4772)

| Step | Action | Impact | Status |
|------|--------|--------|--------|
| 1 | Rename research → memory | 12 ops | Pending |
| 2 | Rename validate → check | 12 ops | Pending |
| 3 | Merge lifecycle + release → pipeline | 17 ops | Pending |
| 4 | Merge skills + providers + issues → tools | 20 ops | Pending |
| 5 | Decompose system → admin | 20 ops | Pending |
| 6 | Create nexus domain | 0→8 ops | Pending |
| 7 | Implement aliases | Backward compat | Pending |

---

## 12. Dependencies

### 12.1 Layer Dependencies (Must Not Violate)

```
Allowed Dependencies:

┌─────────────────────────────────────────────────────────────┐
│   CLI / MCP (Entry Points)                                  │
│   Can depend on: dispatch, types                            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│   Dispatch Layer                                            │
│   Can depend on: core, types, store                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│   Core Layer (Business Logic)                               │
│   Can depend on: types, store                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│   Store Layer (Data Persistence)                            │
│   Can depend on: types ONLY                                 │
└─────────────────────────────────────────────────────────────┘

FORBIDDEN:
❌ core/ → cli/
❌ core/ → mcp/
❌ store/ → core/
❌ store/ → cli/
❌ store/ → mcp/
❌ types/ → ANY other layer
```

### 12.2 Import Rules

```typescript
// CORRECT: Core depends only on types and store
import { Task, TaskStatus } from '../types/index.js';
import { getAccessor } from '../store/index.js';

// INCORRECT: Core must never import from CLI or MCP
import { something } from '../cli/commands/add.js';  // ❌ VIOLATION
import { something } from '../mcp/engine/task-engine.js';  // ❌ VIOLATION
```

---

## 13. Testing Architecture

### 13.1 Test Location

```
src/
├── core/
│   └── __tests__/           # Unit tests for each core module
│       ├── add.test.ts
│       ├── update.test.ts
│       └── ...
├── store/
│   └── __tests__/           # Store implementation tests
├── dispatch/
│   └── __tests__/           # Dispatch and middleware tests
├── cli/
│   └── __tests__/           # CLI command tests
└── mcp/
    └── __tests__/           # MCP gateway tests
```

### 13.2 Test Hierarchy

| Level | Scope | Location | Command |
|-------|-------|----------|---------|
| Unit | Individual functions | `*/__tests__/*.test.ts` | `npx vitest run` |
| Integration | Cross-module | `tests/integration/*.test.ts` | `npx vitest run --config vitest.integration.config.ts` |
| E2E | Full workflows | `src/mcp/__tests__/e2e/*.test.ts` | `npm run test:e2e` |

### 13.3 Core Testing Pattern

```typescript
// src/core/tasks/__tests__/add.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { addTask } from '../add.js';
import { getTestAccessor } from '../../../store/__tests__/helpers.js';

describe('addTask', () => {
  let accessor: DataAccessor;
  
  beforeEach(async () => {
    accessor = await getTestAccessor();
  });
  
  it('should add a task with required fields', async () => {
    const result = await addTask({
      title: 'Test Task',
      priority: 'medium',
    }, { accessor });
    
    expect(result.id).toBeDefined();
    expect(result.title).toBe('Test Task');
    expect(result.status).toBe('pending');
  });
  
  it('should reject duplicate titles', async () => {
    // ...
  });
});
```

---

## 14. File Naming Conventions

**Canonical Reference**: ADR-017 §4. Summary table retained for quick reference.

| Pattern | Usage | Example |
|---------|-------|---------|
| `kebab-case.ts` | Utility files | `dependency-check.ts` |
| `camelCase.ts` | Single-operation modules | `add.ts`, `update.ts` |
| `PascalCase.ts` | Type definitions | `TaskStatus.ts` (rare) |
| `index.ts` | Barrel exports | `src/core/tasks/index.ts` |
| `*.test.ts` | Unit tests | `add.test.ts` |
| `*.integration.test.ts` | Integration tests | `cli.integration.test.ts` |

---

## 15. Constants and Configuration

### 15.1 Exit Codes (src/types/exit-codes.ts)

```typescript
export enum ExitCode {
  SUCCESS = 0,
  
  // General errors (1-59)
  GENERAL_ERROR = 1,
  INVALID_ARGUMENTS = 2,
  NOT_FOUND = 3,
  // ...
  
  // Protocol violations (60-67)
  PROTOCOL_VIOLATION = 60,
  RESEARCH_VIOLATION = 61,
  CONSENSUS_VIOLATION = 62,
  SPECIFICATION_VIOLATION = 63,
  // ...
  
  // Validation violations (68-70)
  VALIDATION_ERROR = 68,
  // ...
  
  // Lifecycle gate errors (75-79)
  GATE_REJECTION = 75,
  // ...
}
```

### 15.2 Verb Standards (docs/specs/VERB-STANDARDS.md)

**Canonical Reference**: ADR-017 §1 and docs/specs/VERB-STANDARDS.md. See those documents for the authoritative 36-verb list. Summary table retained below for quick reference.

| Verb | Meaning | Usage |
|------|---------|-------|
| `add` | Create new entity | tasks.add, tools.skill.add |
| `show` | Get single entity by ID | tasks.show, session.show |
| `list` | Get paginated collection | tasks.list, session.list |
| `find` | Search with filters | tasks.find, memory.find |
| `update` | Modify existing entity | tasks.update, config.set |
| `complete` | Mark as done | tasks.complete |
| `delete` | Remove entity | tasks.delete |
| `restore` | Unarchive/reopen | tasks.restore |
| `start` | Begin work/session | tasks.start, session.start |
| `stop` | End work/session | tasks.stop, session.end |
| `verify` | Check state/validity | orchestrate.verify |
| `check` | Validate/inspect | check.schema, check.protocol |
| `run` | Execute process | check.test.run |
| `inject` | Add to context | memory.inject, tools.provider.inject |

---

## 16. Appendix: Complete File Inventory

### Core Modules (Target State)

```
src/core/
├── index.ts
├── errors.ts
├── schema.ts
├── config.ts
├── paths.ts
├── platform.ts
├── init.ts
├── upgrade.ts
├── repair.ts
├── output.ts
├── pagination.ts
│
├── tasks/              # 18 files
│   ├── index.ts
│   ├── add.ts
│   ├── update.ts
│   ├── complete.ts
│   ├── delete.ts
│   ├── restore.ts
│   ├── reparent.ts
│   ├── reorder.ts
│   ├── promote.ts
│   ├── hierarchy.ts
│   ├── dependency-check.ts
│   ├── graph-ops.ts
│   ├── analyze.ts
│   ├── relates.ts
│   ├── labels.ts
│   ├── complexity.ts
│   ├── export.ts
│   ├── import.ts
│   └── lint.ts
│
├── sessions/           # 11 files
│   ├── index.ts
│   ├── start.ts
│   ├── end.ts
│   ├── resume.ts
│   ├── suspend.ts
│   ├── list.ts
│   ├── show.ts
│   ├── history.ts
│   ├── gc.ts
│   ├── decisions.ts
│   └── assumptions.ts
│   └── drift.ts
│
├── memory/             # 13 files
│   ├── index.ts
│   ├── find.ts
│   ├── show.ts
│   ├── list.ts
│   ├── pending.ts
│   ├── stats.ts
│   ├── manifest.ts
│   ├── inject.ts
│   ├── link.ts
│   ├── contradictions.ts
│   ├── superseded.ts
│   ├── compact.ts
│   ├── store.ts        # BRAIN
│   ├── recall.ts       # BRAIN
│   └── consolidate.ts  # BRAIN
│
├── check/              # 11 files
│   ├── index.ts
│   ├── schema.ts
│   ├── protocol.ts
│   ├── task.ts
│   ├── manifest.ts
│   ├── output.ts
│   ├── coherence.ts
│   ├── compliance.ts
│   ├── test.ts
│   ├── doctor/
│   │   ├── index.ts
│   │   └── checks/
│   └── intelligence.ts # BRAIN
│
├── pipeline/           # 16 files
│   ├── index.ts
│   ├── state-machine.ts
│   ├── stage/
│   │   ├── validate.ts
│   │   ├── status.ts
│   │   ├── history.ts
│   │   ├── gates.ts
│   │   ├── prerequisites.ts
│   │   ├── record.ts
│   │   ├── skip.ts
│   │   ├── reset.ts
│   │   ├── gate-pass.ts
│   │   └── gate-fail.ts
│   └── release/
│       ├── prepare.ts
│       ├── changelog.ts
│       ├── commit.ts
│       ├── tag.ts
│       ├── push.ts
│       ├── gates-run.ts
│       └── rollback.ts
│
├── orchestrate/        # 13 files
│   ├── index.ts
│   ├── status.ts
│   ├── analyze.ts
│   ├── ready.ts
│   ├── next.ts
│   ├── waves.ts
│   ├── context.ts
│   ├── spawn.ts
│   ├── startup.ts
│   ├── bootstrap.ts
│   ├── critical-path.ts
│   ├── unblock.ts
│   ├── parallel.ts
│   ├── verify.ts
│   └── agent.ts        # BRAIN
│
├── tools/              # 22 files
│   ├── index.ts
│   ├── skill/
│   │   ├── list.ts
│   │   ├── show.ts
│   │   ├── find.ts
│   │   ├── dispatch.ts
│   │   ├── verify.ts
│   │   ├── dependencies.ts
│   │   ├── install.ts
│   │   ├── uninstall.ts
│   │   ├── enable.ts
│   │   ├── disable.ts
│   │   ├── configure.ts
│   │   └── refresh.ts
│   ├── provider/
│   │   ├── list.ts
│   │   ├── detect.ts
│   │   ├── inject.ts
│   │   └── status.ts
│   └── issue/
│       ├── diagnostics.ts
│       ├── create-bug.ts
│       ├── create-feature.ts
│       └── create-help.ts
│
├── admin/              # 16 files
│   ├── index.ts
│   ├── version.ts
│   ├── health.ts
│   ├── config.ts
│   ├── stats.ts
│   ├── context.ts
│   ├── backup.ts
│   ├── restore.ts
│   ├── migrate.ts
│   ├── sync.ts
│   ├── cleanup.ts
│   ├── job.ts
│   ├── safestop.ts
│   ├── inject-generate.ts
│   ├── dashboard.ts
│   └── log.ts
│
└── nexus/              # 9 files
    ├── index.ts
    ├── find.ts
    ├── export.ts
    ├── import.ts
    ├── agents.ts
    ├── coordinate.ts
    ├── similarity.ts
    ├── insights.ts
    └── list-patterns.ts
```

### Total: ~129 core files implementing 140 operations

---

## 17. Decision Register

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Single core location | Business logic in ONE place eliminates drift between CLI and MCP |
| D2 | CQRS dispatch layer | Separates query/mutate concerns; enables middleware pipeline |
| D3 | Operation registry | Central catalog of all 140 operations; enables discovery |
| D4 | Thin CLI/MCP wrappers | Adapters handle I/O translation only; zero business logic |
| D5 | Domain consolidation (11→9) | Intent-based domains align with agent mental models |
| D6 | SQLite primary storage | Performance, ACID, querying; JSON as fallback |
| D7 | Dual-write transition | Backward compatibility during migration period |
| D8 | Co-located tests | Tests live with code they test; improves discoverability |
| D9 | Barrel exports | Single import point per module; clean public API |
| D10 | Zod validation | Runtime type safety; single schema for TS and validation |
| D11 | Atomic write pattern | Data integrity: temp→validate→backup→rename |
| D12 | Verb standards | Consistent naming reduces cognitive load |
| D13 | 9-domain model | BRAIN-forward, RCSD-IVTR aligned, progressive disclosure |
| D14 | Pipeline domain | Release IS RCSD-IVTR terminal stage; merge lifecycle+release |
| D15 | Nexus standalone | Global scope (~/.cleo/) distinct from project-local |

---

## 18. Success Criteria

The architecture is complete when:

- [ ] All 140 operations route through `src/dispatch/`
- [ ] All business logic lives in `src/core/` (zero in CLI/MCP)
- [ ] CLI commands are <50 lines (pure dispatch calls)
- [ ] MCP engine files are <100 lines (pure dispatch calls)
- [ ] Types defined ONCE in `src/types/` (zero duplication)
- [ ] SQLite is primary storage (JSON is read-only fallback)
- [ ] All 3,000+ tests pass
- [ ] No circular dependencies between layers
- [ ] All imports follow layer dependency rules
- [ ] Documentation references only canonical locations

---

## References

- T4797: Domain Model Consensus (9-domain architecture)
- T4781: Core Canonicalization Epic
- T4813: Unified CQRS Dispatch Epic
- ADR-007: Domain Architecture — 9-Domain Shared-Core Model
- VERB-STANDARDS.md: Canonical verb definitions
- CLEO-BRAIN-SPECIFICATION.md: BRAIN 5 dimensions

---

### Footnotes

**[T4798, 2026-02-25]** Section 12.1 Layer Dependencies states engines must not import from `store/` directly. Six engine files previously violated this by importing from `../../store/file-utils.js`. These have been corrected to import from `../../core/platform.js`, which re-exports the necessary path/IO utilities (`resolveProjectRoot`, `readJsonFile`, `writeJsonFileAtomic`, `getDataPath`, `readLogFileEntries`). Additionally, `src/core/lifecycle/rcasd-index.ts` was migrated from raw `writeFileSync`/`readFileSync` to atomic `writeJsonFileAtomic`/`readJsonFile` per the mandatory atomic write pattern. The four BRAIN foundation features (`ct briefing`, `ct bug`, `ct plan`, structured handoff) will follow this same pattern: thin CLI commands delegating to `src/core/` with no direct store imports.

**[ADR-020, 2026-02-27]** Session engine migration is COMPLETE. The deprecated MCP session engine (`src/mcp/engine/session-engine.ts`, ~1,060 lines) has been deleted (commit `ffe49957`). The dispatch layer engine (`src/dispatch/engines/session-engine.ts`) is now the sole active session engine, delegating all business logic to `src/core/sessions/*`. Session type unification is complete: a single `Session` type derived from the Drizzle schema via Zod in `src/store/validation-schemas.ts` replaces all hand-maintained interfaces. The migration status table (Section 15) has been updated to reflect this completion. See ADR-020 for the full session architecture documentation.

**END OF ADR-008**
