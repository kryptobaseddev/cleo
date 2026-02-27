> Archived: superseded by ADR-007 (accepted 2026-02-25). See .cleo/adrs/ADR-007-domain-consolidation.md.

# ADR-007: CLEO Domain Consolidation — 9-Domain Architecture with Unified Dispatch

**Date**: 2026-02-22  
**Status**: proposed  
**Consensus Manifest**: T4797-domain-model-consensus.md  
**Related Epics**: T4772, T4820, T4813  
**Supersedes**: All prior domain architecture documents  

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context and Problem Statement

CLEO currently operates with **11 MCP domains**: tasks, session, orchestrate, research, lifecycle, validate, release, system, issues, skills, providers. Evidence from T4797 research shows this structure has accumulated significant technical debt:

- **System domain bloat**: 28-40 operations mixing 7 distinct concerns (core system, config, data management, observability, leaked task ops, CAAMP provider ops, background jobs)
- **Confirmed duplicates**: 8+ operations with identical or near-identical implementations across domains
- **80/20 usage pattern**: 80% of agent sessions use only tasks + session (8 operations), yet all 11 domains are exposed
- **Naming collisions**: "validate" domain vs. validate operations in orchestrate, pipeline
- **Identity misalignment**: CLEO's Brain/Memory identity (vision.mdx, PORTABLE-BRAIN-SPEC.md) is not reflected in domain naming

**Additional Critical Issue: Parallel Routing Architectures**

CLEO currently operates with **two competing routing systems**:

1. **Dispatch Layer (Canonical - Partially Implemented)**: Central CQRS dispatcher at `src/dispatch/` with 9 canonical domain handlers. Currently used by 25 of 76 CLI commands.

2. **Legacy DomainRouter (Deprecated - Still Active)**: Old routing system in `src/mcp/lib/router.ts` with 11 legacy domain handlers and 18 engine files. Still used by MCP and 51 CLI commands that bypass dispatch.

The 11-domain model evolved from entity-based restructuring without evidence-driven consolidation. This ADR captures the consensus decision to consolidate to 9 intent-based domains and mandates **all operations MUST route through the unified dispatch layer**.

---

## 2. Options Evaluated

The following domain models were evaluated during T4797 research:

### Option 1: 5-Domain Model (Rejected)
**Proposal**: tasks, session, orchestrate, check, extend

**Rejection Rationale**:
- "extend" doesn't match agent thinking patterns
- Ignores CLEO's Brain/Memory identity
- Merges orthogonal concerns (lifecycle into orchestrate)
- Hides IVTR pipeline as implementation detail

### Option 2: 7-Domain Model v1 (Rejected)
**Proposal**: tasks, session, memory, orchestrate, check, tools, admin

**Rejection Rationale**:
- Three conceptual errors:
  1. Merged lifecycle into orchestrate (hid IVTR pipeline)
  2. Merged release into admin (mixed project ops with CLEO infrastructure)
  3. Conflated CLEO-internal and project-level ops without distinction

### Option 3: 8-Domain Model v2 (Superseded by 9-Domain)
**Proposal**: tasks, session, memory, pipeline, check, orchestrate, tools, admin

**Rationale for Improvement**:
- Corrected all three errors from 7-domain v1
- Pipeline is first-class (lifecycle + release merge)
- Clean separation of concerns

**Why Superseded**:
- Nexus (cross-project coordination) was deferred as memory.network.*
- This conflates project-local knowledge with global multi-project coordination
- Nexus requires distinct global scope (~/.cleo/ vs project-local .cleo/)

### Option 4: 9-Domain Model with Unified Dispatch (ACCEPTED)
**Proposal**: tasks, session, memory, check, pipeline, orchestrate, tools, admin, nexus with mandatory dispatch routing

**Acceptance Rationale**:
- 8 project-local + 1 global domain
- Every domain has single clear purpose
- No orthogonal concerns merged
- BRAIN-forward (all 5 dimensions have homes)
- IVTR-first-class (pipeline explicit)
- Progressive disclosure by agent complexity
- **Single routing path**: All CLI and MCP operations flow through unified dispatch
- Production-ready architecture with elimination of parallel routing systems

---

## 3. Decision

**CLEO SHALL consolidate 11 MCP domains into 9 intent-based domains** (8 project-local + 1 global) aligned with CLEO's Brain/Memory identity, progressive disclosure tiers, RCSD-IVTR pipeline, and BRAIN specification forward compatibility.

**ADDITIONALLY, CLEO SHALL mandate that ALL operations (CLI and MCP) MUST route through the unified CQRS dispatch layer** at `src/dispatch/`, eliminating the parallel DomainRouter architecture.

### 3.1 The 9 Canonical Domains

| # | Domain | Purpose | Brain Metaphor | CLEO Pillar | Tier | Ops |
|---|--------|---------|---------------|-------------|------|-----|
| 1 | **tasks** | Task CRUD, hierarchy, focus, analysis, labels | Neurons | Portable Memory | 0 | ~29 |
| 2 | **session** | Session lifecycle, decisions, assumptions, context | Working Memory | Portable Memory | 0 | 13 |
| 3 | **memory** | Research manifests, knowledge store, retrieval | Long-term Memory | Cognitive Retrieval | 1 | 12 |
| 4 | **check** | CLEO validation + project quality assurance | Immune System | Deterministic Safety | 1 | 12 |
| 5 | **pipeline** | RCSD-IVTR state machine + release execution | Executive Pipeline | Provenance | 2 | ~17 |
| 6 | **orchestrate** | Multi-agent coordination, spawning, waves | Executive Function | Agent Coordination | 2 | ~15 |
| 7 | **tools** | Skills, providers, issue management | Capabilities | Interoperable Interfaces | 2 | ~20 |
| 8 | **admin** | System config, backup, migration, observability | Autonomic System | Infrastructure | 2 | ~20 |
| 9 | **nexus** | Cross-project search, knowledge transfer, federation | Hive Network | Network Intelligence | 2 | 0 (future) |

**Total**: ~138 operations (down from ~140, with 4+ duplicates removed)

### 3.2 Unified Entry Point Architecture

**CRITICAL DECISION**: Both CLI and MCP SHALL use the same dispatch layer as their single entry point to core business logic.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     UNIFIED ENTRY POINT ARCHITECTURE                         │
├─────────────────────────────┬───────────────────────────────────────────────┤
│        CLI (76 commands)    │         MCP Gateway (cleo_query/mutate)       │
│                             │                                               │
│  Commander.js registration  │    2-tool CQRS interface                      │
│  → parse arguments          │    → validate params                          │
│  → build operation request  │    → build operation request                  │
└──────────────┬──────────────┴─────────────────────┬─────────────────────────┘
               │                                    │
               └────────────────┬───────────────────┘
                                │
                                ▼
               ┌─────────────────────────────────────┐
               │   DISPATCH ADAPTERS                  │
               │   src/dispatch/adapters/             │
               │                                      │
               │   • cli.ts  ← CLI adapter            │
               │   • mcp.ts  ← MCP adapter            │
               │                                      │
               │   Transforms interface-specific      │
               │   params to canonical format         │
               └────────────────┬─────────────────────┘
                                │
                                ▼
               ┌─────────────────────────────────────┐
               │   CENTRAL DISPATCHER                 │
               │   src/dispatch/dispatcher.ts         │
               │                                      │
               │   • Registry lookup (147 ops)        │
               │   • Middleware pipeline              │
               │   • Route to domain handler          │
               └────────────────┬─────────────────────┘
                                │
               ┌────────────────┼────────────────┐
               │                │                │
               ▼                ▼                ▼
   ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
   │   9 Domain     │  │   Middleware   │  │   Middleware   │
   │   Handlers     │  │   Pipeline     │  │   Pipeline     │
   │                │  │                │  │                │
   │ tasks, session │  │ 1. Sanitizer   │  │ 1. Sanitizer   │
   │ memory, check  │  │ 2. Rate Limit  │  │ 2. Rate Limit  │
   │ pipeline, etc. │  │ 3. Protocol    │  │ 3. Audit Log   │
   └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
           │                   │                   │
           └───────────────────┼───────────────────┘
                               │
                               ▼
               ┌─────────────────────────────────────┐
               │   CORE BUSINESS LOGIC                │
               │   src/core/{domain}/*.ts             │
               │                                      │
               │   Single source of truth for         │
               │   all business logic                 │
               └────────────────┬─────────────────────┘
                                │
                                ▼
               ┌─────────────────────────────────────┐
               │   DATA ACCESS LAYER                  │
               │   src/store/*.ts                     │
               │                                      │
               │   • SQLite (primary)                 │
               │   • JSON (read-only fallback)        │
               └─────────────────────────────────────┘
```

**Key Principles**:
1. **Single Routing Path**: No operation may bypass the dispatch layer
2. **Thin Adapters**: CLI and MCP adapters contain ZERO business logic
3. **Canonical Operations**: All 147 operations defined ONCE in `src/dispatch/registry.ts`
4. **Middleware Consistency**: Same middleware pipeline for both entry points
5. **Shared Core**: All business logic lives in `src/core/` only

### 3.3 CLI Command Mapping to 9 Domains

The **76 CLI commands** map to the 9 canonical domains as follows:

```typescript
// Domain to CLI Commands Mapping
const DOMAIN_CLI_MAP = {
  tasks: [
    'add', 'list', 'show', 'find', 'complete', 'delete', 'restore', 
    'archive', 'reparent', 'promote', 'reorder', 'focus', 'blockers',
    'deps', 'analyze', 'next', 'relates', 'labels', 'roadmap', 'archive-stats'
  ],
  
  session: [
    'session', 'start', 'stop', 'current', 'history', 'detect-drift'
  ],
  
  memory: [
    'research'  // Was research domain
  ],
  
  check: [
    'validate', 'doctor', 'verify', 'compliance', 'consensus'
  ],
  
  pipeline: [
    'lifecycle', 'release', 'phase', 'phases', 'implementation', 
    'specification', 'decomposition', 'testing'
  ],
  
  orchestrate: [
    'orchestrate', 'next', 'spawn'
  ],
  
  tools: [
    'skills', 'issue', 'context', 'inject'
  ],
  
  admin: [
    'config', 'backup', 'restore', 'init', 'stats', 'dash', 'log',
    'sequence', 'migrate', 'sync', 'cleanup', 'safestop', 'self-update',
    'env', 'export', 'import', 'checkpoint', 'web', 'otel'
  ],
  
  nexus: [
    'nexus'
  ]
};
```

**Current Migration Status**:
- ✅ **25 commands** use dispatch (correct)
- ❌ **51 commands** bypass dispatch (MUST migrate)

### 3.4 Dynamic CLI Registration with Commander.js

**DECISION**: CLI SHALL use dynamic command registration from the operation registry, eliminating manual command definitions for domain-namespaced operations.

```typescript
// src/cli/commands/dynamic.ts — Dynamic Registration Utility

import { Command } from 'commander';
import { OPERATIONS } from '../../dispatch/registry.js';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliOutput, cliError } from '../renderers/index.js';

/**
 * Auto-register all operations from the canonical registry.
 * 
 * High-frequency commands (add, list, show, etc.) MAY have explicit
 * definitions for custom help text and argument parsing.
 * Domain-namespaced operations (tools.skill.list, admin.config.get)
 * SHALL be auto-registered.
 */
export function registerDynamicCommands(program: Command): void {
  // Group operations by domain
  const opsByDomain = OPERATIONS.reduce((acc, op) => {
    if (!acc[op.domain]) acc[op.domain] = [];
    acc[op.domain].push(op);
    return acc;
  }, {} as Record<string, typeof OPERATIONS>);

  // Create domain subcommands
  Object.entries(opsByDomain).forEach(([domain, operations]) => {
    const domainCmd = program.command(domain)
      .description(`Operations for ${domain} domain`);
    
    // Register each operation as subcommand
    operations.forEach(op => {
      const opCmd = new Command(op.operation)
        .description(op.description);
      
      // Add required params as options
      op.requiredParams.forEach(param => {
        opCmd.requiredOption(`--${param} <value>`, `Required: ${param}`);
      });
      
      // Add optional params
      // (would parse from param schema)
      
      opCmd.action(async (options) => {
        await dispatchFromCli(
          op.gateway,
          op.domain,
          op.operation,
          options,
          { command: `${domain}.${op.operation}` }
        );
      });
      
      domainCmd.addCommand(opCmd);
    });
  });
}

// Example usage:
// cleo tasks show --id T1234
// cleo tools skill list
// cleo admin config get --key version
```

**Benefits**:
1. **Single Source of Truth**: Operations defined ONCE in registry
2. **Auto-discovery**: New operations automatically available in CLI
3. **Consistency**: Same validation and middleware as MCP
4. **Maintainability**: No manual command registration to maintain

### 3.5 CLI Commands Requiring Dispatch Migration

**CRITICAL**: The following **51 CLI commands** currently bypass dispatch and MUST be migrated:

#### Tier 0 Commands (High Priority - 18 commands)
| Command | Current Pattern | Target Domain | Target Operation |
|---------|----------------|---------------|------------------|
| backup | Direct core | admin | backup |
| checkpoint | Direct core | admin | checkpoint |
| compliance | Direct core | check | compliance.summary |
| config (list) | Direct core | admin | config.list |
| consensus | Direct core | check | consensus |
| context | Direct core | admin | context |
| dash | Direct core | admin | dash |
| delete | Direct core | tasks | delete |
| deps | Direct core | tasks | depends |
| detect-drift | Direct core | session | context.drift |
| doctor | Direct core | check | doctor |
| env | Direct core | admin | env |
| export | Direct core | admin | export |
| export-tasks | Direct core | tasks | export |
| history | Direct core | session | history |
| import | Direct core | admin | import |
| import-tasks | Direct core | tasks | import |
| labels | Direct core | tasks | labels |

#### Tier 1 Commands (Medium Priority - 17 commands)
| Command | Current Pattern | Target Domain | Target Operation |
|---------|----------------|---------------|------------------|
| issue | Direct core | tools | issue.* |
| lifecycle | Direct core | pipeline | stage.* |
| log | Direct core | admin | log |
| migrate | Direct core | admin | migrate |
| migrate-storage | Direct core | admin | migrate.storage |
| mcp-install | Direct core | admin | mcp.install |
| nexus | Direct core | nexus | find |
| otel | Direct core | admin | otel |
| phase | Direct core | pipeline | stage.status |
| phases | Direct core | pipeline | stage.list |
| promote | Direct core | tasks | promote |
| reorder | Direct core | tasks | reorder |
| reparent | Direct core | tasks | reparent |
| research | Direct core | memory | find |
| restore | Direct core | tasks | restore |
| roadmap | Direct core | tasks | roadmap |
| safestop | Direct core | admin | safestop |

#### Tier 2 Commands (Lower Priority - 16 commands)
| Command | Current Pattern | Target Domain | Target Operation |
|---------|----------------|---------------|------------------|
| self-update | Direct core | admin | self-update |
| sequence | Direct core | admin | sequence |
| session (full) | Partial dispatch | session | * |
| skills | Direct core | tools | skill.* |
| stats | Direct core | admin | stats |
| sync | Direct core | admin | sync |
| testing | Direct core | check | test.* |
| validate | Direct core | check | validate |
| verify | Direct core | check | verify |
| web | Direct core | admin | web |
| inject | Direct core | tools | provider.inject |
| extract | Direct core | memory | extract |
| generate-changelog | Direct core | pipeline | release.changelog |
| implementation | Direct core | pipeline | stage.implementation |
| specification | Direct core | pipeline | stage.specification |
| decomposition | Direct core | pipeline | stage.decomposition |

### 3.6 MCP Migration Requirements

**CRITICAL**: MCP currently routes through deprecated `DomainRouter` (`src/mcp/lib/router.ts`) and MUST migrate to use dispatch adapters.

**Current State**:
```
MCP Gateway → DomainRouter → Legacy Domains → Engines (src/mcp/engine/)
                                    ↓
                              CLIExecutor (subprocess)
```

**Target State**:
```
MCP Gateway → handleMcpToolCall() → Dispatch Adapter → Dispatcher → Core
```

**Migration Steps**:
1. Update `src/mcp/gateways/query.ts` to call `handleMcpToolCall()`
2. Update `src/mcp/gateways/mutate.ts` to call `handleMcpToolCall()`
3. Deprecate `DomainRouter` class
4. Migrate business logic from `src/mcp/engine/*.ts` to `src/core/`
5. Remove legacy domain handlers in `src/mcp/domains/*.ts`

### 3.7 RCSD-IVTR Pipeline Architecture

The CLEO project lifecycle follows an **8-stage pipeline** with two distinct phases:

```
┌─────────────────────────────────────────────────────────────────┐
│                        RCSD PHASE                                │
│  (Research → Consensus → Specification → Decomposition)         │
│                                                                  │
│  Takes singular ideas and breaks them down into executable      │
│  specifications with documented architectural decisions          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   ADR Protocol  │
                    │  (Cross-cutting)│
                    └─────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       IVTR PHASE                                 │
│  (Implementation → Validation → Testing → Release)              │
│                                                                  │
│  Executes the work with iterative quality loops                 │
│  Validation/Testing can cycle back to Implementation            │
└─────────────────────────────────────────────────────────────────┘
```

#### Stage Definitions (8 Stages)

| Phase | Stage | Order | Purpose | Key Activities |
|-------|-------|-------|---------|----------------|
| **RCSD** | Research | 1 | Gather information and explore | Investigation, data collection, findings documentation |
| **RCSD** | Consensus | 2 | Multi-agent decision making | Agreement on approach, options evaluation |
| **RCSD** | Specification | 3 | Document requirements and design | RFC-style specs, API contracts, design docs |
| **RCSD** | Decomposition | 4 | Break work into atomic tasks | Task creation, dependency mapping, wave planning |
| **IVTR** | Implementation | 5 | Build the solution | Code writing, feature development |
| **IVTR** | Validation | 6 | Quality checks and static analysis | Lint, type check, code review |
| **IVTR** | Testing | 7 | Execute test suites | Unit, integration, e2e tests, coverage |
| **IVTR** | Release | 8 | Version and publish | Tagging, changelog, deployment |

#### Cross-Cutting Protocols

**ADR Protocol (Architecture Decision Records)**
- **When**: Triggered during/after Consensus stage
- **Purpose**: Capture significant architectural decisions with context and rationale
- **Artifacts**: Stored in `.cleo/adrs/ADR-XXX-{title}.md`
- **Lifecycle**: `proposed` → `accepted` → `superseded`/`deprecated`
- **Blocking**: Specification stage MUST reference accepted ADRs

**Contribution Protocol**
- **When**: Can occur during ANY stage
- **Purpose**: Multi-agent collaborative work and consensus building
- **Scope**: Crosses all pipeline stages
- **Artifacts**: Contribution records, agent outputs, consensus manifests

#### IVTR Iteration Loops

The IVTR phase supports iterative refinement:

```
┌──────────────────────────────────────────────────┐
│              IMPLEMENTATION                      │
│         (Write code, build features)             │
└────────────────┬─────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────┐
│              VALIDATION                          │
│    (Static analysis, type check, lint)          │
└────────┬─────────────────────┬───────────────────┘
         │                     │
    Pass │                     │ Fail
         ▼                     ▼
┌────────────────┐    ┌────────────────────────┐
│    TESTING     │    │  LOOP BACK             │
│ (Test suites)  │    │  (Fix issues)          │
└──┬──────────┬──┘    └────────────────────────┘
   │          │
Pass│          │Fail
   ▼          ▼
┌──────────────────┐  ┌────────────────────────┐
│     RELEASE      │  │  LOOP BACK             │
│ (Version, ship)  │  │  (Fix bugs)            │
└──────────────────┘  └────────────────────────┘
```

**Loop Mechanics**:
- Validation failures → Return to Implementation (fix code)
- Testing failures → Return to Implementation (fix bugs)
- Each loop iteration SHOULD update agent outputs in `.cleo/agent-outputs/`
- Loop exit criteria: All gates pass (validation + testing)

#### Domain Alignment with Pipeline

| Pipeline Stage | Primary Domain | Operations |
|----------------|----------------|------------|
| Research | memory | memory.find, memory.manifest.read, research domain (legacy) |
| Consensus | session, orchestrate | session.record.decision, orchestrate.consensus |
| Specification | memory | memory.store (specs), memory.link |
| Decomposition | tasks | tasks.add, tasks.tree, tasks.depends |
| Implementation | tasks, orchestrate | tasks.start, tasks.complete, orchestrate.spawn |
| Validation | check | check.schema, check.protocol, check.lint |
| Testing | check | check.test.run, check.test.coverage |
| Release | pipeline | pipeline.release.prepare, pipeline.release.tag, pipeline.release.push |

**IVTR → Domain Mapping**:
- Implementation: `tasks` (work tracking) + `orchestrate` (agent coordination)
- Validation: `check` domain (quality gates)
- Testing: `check` domain (test execution)
- Release: `pipeline` domain (RCSD-IVTR state + release execution)

### 3.8 Domain Consolidation Mapping

#### Simple Aliases (1:1 Redirect)

| Old Domain | New Domain | Transformation |
|------------|-----------|----------------|
| research | memory | Rename |
| validate | check | Rename |
| lifecycle | pipeline | Rename + namespace (pipeline.stage.*) |
| release | pipeline | Absorb (pipeline.release.*) |
| skills | tools | Namespace prefix (tools.skill.*) |
| providers | tools | Namespace prefix (tools.provider.*) |
| issues | tools | Namespace prefix (tools.issue.*) |

#### Complex Decomposition (system → 4 domains)

The system domain (28-40 ops) SHALL be decomposed:

| System Operation | Destination | Rationale |
|-----------------|-------------|-----------|
| system.labels | tasks.labels | Task labeling concern |
| system.roadmap | tasks.roadmap | Task planning concern |
| system.archive.stats | tasks.archive.stats | Task archival concern |
| system.uncancel | REMOVE | Duplicate of tasks.uncancel |
| system.compliance | check.compliance.* | Validation concern |
| system.provider.* | tools.provider.* | Extension ecosystem |
| system.* (remaining) | admin.* | Infrastructure concern |

#### Duplicate Elimination

| Duplicate | Canonical Home | Remove From |
|-----------|---------------|-------------|
| system.uncancel | tasks.uncancel | system |
| orchestrate.skill.list | tools.skill.list | orchestrate |
| system.provider.list | tools.provider.list | system |
| system.provider.detect | tools.provider.detect | system |
| system.provider.installed | tools.provider.inject.status | system |

**Net result**: ~140 → ~136 operations.

---

## 4. Rationale

### 4.1 Evidence Sources

The 9-domain model is derived from seven convergent evidence streams:

1. **Agent workflow clustering** (T4797 Finding 2): 80% of agents use only tasks+session → domains tiered by access frequency
2. **CLEO Brain/Memory identity** (vision.mdx, PORTABLE-BRAIN-SPEC.md): Domains map to cognitive functions aligned with 5 pillars
3. **src/core/ natural clustering** (T4797 Finding 3): 13 core modules group into ~9 cohesive clusters when measured by cohesion
4. **System domain junk drawer** (T4797 Finding 4): 28-40 ops mixing 7 concerns must be decomposed
5. **RCSD-IVTR pipeline**: 8-stage lifecycle with clear phase boundaries and iteration support
6. **BRAIN specification** (CLEO-BRAIN-SPECIFICATION.md): 5 dimensions need domain homes
7. **Nexus architecture**: Cross-project coordination operates at ~/.cleo/ (global) scope, distinct from project-local

**Additional Evidence: Architecture Validation**

- **Dispatch Layer Audit**: Only 25 of 76 CLI commands (33%) correctly use dispatch
- **MCP Routing Audit**: 100% of MCP operations bypass dispatch through DomainRouter
- **Code Duplication**: 18 engine files in `src/mcp/engine/` duplicate logic in `src/core/`
- **Maintenance Burden**: Parallel routing systems require dual maintenance

### 4.2 Key Architectural Principles

**Progressive Disclosure**:
- Tier 0 (80% agents): tasks + session = 42 ops, ~200 tokens
- Tier 1 (15% agents): + memory, check = 66 ops, ~400 tokens  
- Tier 2 (5% agents): + pipeline, orchestrate, tools, admin, nexus = ~138 ops, ~900 tokens

**Single Routing Path**:
- **NO operation** may bypass the dispatch layer
- CLI adapters transform CLI arguments to canonical operations
- MCP adapters transform MCP tool calls to canonical operations
- Both use identical middleware and domain handlers

**DRY (Don't Repeat Yourself)**:
- Operations defined ONCE in `src/dispatch/registry.ts`
- Business logic lives ONCE in `src/core/`
- Type definitions live ONCE in `src/types/`
- No duplication between CLI and MCP

**RCSD-IVTR Pipeline**:
- **RCSD** (Setup): Research → Consensus (→ ADR) → Specification → Decomposition
- **IVTR** (Execution): Implementation ⇄ Validation ⇄ Testing → Release
- ADR Protocol: Captures consensus decisions, referenced by specifications
- Contribution Protocol: Cross-cutting collaborative work

**BRAIN Dimension Coverage** (See ADR-009 for complete bridging reference):

The 5 BRAIN dimensions map to the 9 canonical domains as follows. This table covers all current and planned operations per dimension.

**Base (Memory) — Primary: `memory`, Secondary: `session`, `tasks`**

| Operation | Domain | Phase | Status |
|-----------|--------|-------|--------|
| Task/session persistence | `tasks.*`, `session.*` | Current | Shipped |
| Research artifacts | `memory.manifest.*` | Current | Shipped |
| Contradiction detection | `memory.contradictions` | Current | Shipped |
| Context persistence | `session.context.*` | 1 | Planned |
| Decision memory (store/recall/search) | `memory.decision.*` | 2 | Planned |
| Pattern memory (store/extract/search) | `memory.pattern.*` | 2 | Planned |
| Learning memory (store/search) | `memory.learning.*` | 3 | Planned |
| Memory consolidation | `memory.consolidate` | 3 | Planned |
| Memory export/import (JSONL portability) | `memory.export`, `memory.import` | 2 | Planned |

**Reasoning (Inference) — Domain: DEFERRED (ADR-009 Section 2.5)**

Reasoning domain placement is deferred to a future RCSD Research & Consensus cycle. CLEO is built for LLM agents, and the domain placement requires research into how agents actually use analytical operations. The `reason.*` namespace is reserved.

| Operation | Proposed | Phase | Status |
|-----------|----------|-------|--------|
| Causal inference | `reason.why` | 2 | Deferred |
| Similarity detection | `reason.similar` | 2 | Deferred |
| Impact prediction | `reason.impact` | 2 | Deferred |
| Timeline analysis | `reason.timeline` | 3 | Deferred |
| Counterfactual reasoning | `reason.counterfactual` | 3 | Deferred |

Existing reasoning-adjacent operations remain in their current domains: `tasks.blockers`, `tasks.depends`, `orchestrate.waves`, `orchestrate.analyze`, `orchestrate.critical.path`, `nexus.find`.

**Agent (Orchestration) — Primary: `orchestrate`, Secondary: `tools`**

| Operation | Domain | Phase | Status |
|-----------|--------|-------|--------|
| Multi-agent spawning | `orchestrate.spawn` | Current | Shipped |
| Wave computation | `orchestrate.waves` | Current | Shipped |
| Next task recommendation | `orchestrate.next` | Current | Shipped |
| Brain bootstrap | `orchestrate.bootstrap` | Current | Shipped |
| Skill dispatch | `tools.skill.dispatch` | Current | Shipped |
| Self-healing (retry + reassignment) | `orchestrate.agent.retry` | 1 | Planned |
| Health monitoring (heartbeat) | `orchestrate.agent.health` | 1 | Planned |
| Timeout detection | `orchestrate.agent.timeout` | 1 | Planned |
| Agent registry | `orchestrate.agent.registry` | 2 | Planned |
| Load balancing | `orchestrate.agent.balance` | 2 | Planned |
| Capability discovery | `orchestrate.agent.capabilities` | 2 | Planned |
| Capacity management | `orchestrate.agent.capacity` | 2 | Planned |
| Learning from execution | `orchestrate.agent.learn` | 3 | Planned |
| Adaptive routing | `orchestrate.agent.route` | 3 | Planned |

**Intelligence (Validation & Adaptation) — Primary: `check`, Secondary: `pipeline`**

| Operation | Domain | Phase | Status |
|-----------|--------|-------|--------|
| Schema/protocol/task validation | `check.schema`, `check.protocol`, `check.task` | Current | Shipped |
| Compliance summary/violations | `check.compliance.*` | Current | Shipped |
| Coherence checks | `check.coherence.check` | Current | Shipped |
| Test execution/coverage | `check.test.*` | Current | Shipped |
| Lifecycle gates | `pipeline.stage.gates` | Current | Shipped |
| Compliance scoring | `check.compliance.score` | 1 | Planned |
| Error pattern learning | `check.intelligence.learn` | 2 | Planned |
| Adaptive validation | `check.intelligence.adapt` | 2 | Planned |
| Auto-remediation | `check.intelligence.fix` | 2 | Planned |
| Proactive suggestions | `check.intelligence.suggest` | 3 | Planned |
| Quality prediction | `check.intelligence.predict` | 3 | Planned |

**Network (Cross-Project) — Primary: `nexus`**

| Operation | Domain | Phase | Status |
|-----------|--------|-------|--------|
| Cross-project search | `nexus.find` | Current | Shipped (unvalidated) |
| Cross-project export/import | `nexus.export`, `nexus.import` | 1 | Planned |
| Knowledge transfer | `nexus.transfer` | 2 | Planned (gated on Nexus validation) |
| Global pattern library | `nexus.patterns.*` | 2 | Planned (gated) |
| Project similarity | `nexus.similarity` | 2 | Planned (gated) |
| Federated agent registry | `nexus.agents` | 3 | Planned (gated) |
| Cross-project coordination | `nexus.coordinate` | 3 | Planned (gated) |
| Global intelligence | `nexus.insights` | 3 | Planned (gated) |

---

## 5. Consequences

### 5.1 Positive

- **Reduced cognitive load**: 9 intuitive domains vs 11 fragmented ones
- **Identity alignment**: Domain names match CLEO's Brain/Memory identity
- **Progressive disclosure**: Tiered access by agent complexity
- **IVTR first-class**: 8-stage pipeline with iteration support clearly defined
- **ADR protocol clarity**: ADR as artifact of consensus, not a stage
- **BRAIN forward compatibility**: All 5 dimensions have domain homes
- **Duplicate elimination**: 4+ redundant operations removed
- **System domain cleaned**: 28-40 ops → ~20 focused infrastructure ops
- **Production longevity**: Nexus defined now for future cross-project features
- **Single routing path**: No more dual maintenance of parallel systems
- **Auto-discovery**: New operations automatically available in both CLI and MCP
- **Consistency**: Same validation, error handling, and middleware for all operations

### 5.2 Negative

- **Migration effort**: 51 CLI commands must be updated to use dispatch
- **MCP refactoring**: DomainRouter and 18 engine files must be deprecated
- **Breaking change**: Domain name changes require client updates (mitigated by aliases)
- **Coordination required**: Multiple spec files must update simultaneously
- **HITL dependency**: This ADR requires human acceptance before Specification stage (T4776) can proceed
- **Testing overhead**: Must verify all 147 operations work through both CLI and MCP paths

### 5.3 Technical Debt Acknowledged

- Gateway/capability matrix discrepancy (44 mismatches) must be reconciled before implementation
- T4780 verb rulings (10 gaps) are dependency but not blocker
- Operation-aware alias routing for system domain decomposition is complex
- `stages.ts` has conflicting 9-stage definition (includes "adr" as stage) that must be corrected
- **NEW**: 51 CLI commands require dispatch migration
- **NEW**: MCP DomainRouter and 18 engine files require deprecation
- **NEW**: Dynamic CLI registration utility must be implemented

---

## 6. Downstream Impact (Traceability)

### 6.1 Specifications Requiring Update

| Document | Changes Required |
|----------|-----------------|
| CLEO-OPERATIONS-REFERENCE.md | Update domain list (11→9), operation counts |
| MCP-SERVER-SPECIFICATION.md | Update domain enums, examples, schemas |
| MCP-AGENT-INTERACTION-SPEC.md | Update domain references |
| CLEO-STRATEGIC-ROADMAP-SPEC.md | Update domain transition notes |
| CLI-MCP-PARITY-ANALYSIS.md | Update operation counts |
| llms.txt | Update domain lists |
| MCP-SERVER.mdx | Update domain tables |
| mcp-quickstart.mdx | Update domain examples |
| CLAUDE.md | Update architecture overview |
| AGENTS.md | Update domain counts |

### 6.2 Implementation Tasks

| Task | Title | Status | Priority |
|------|-------|--------|----------|
| T4772 | EPIC: Domain Consolidation | pending | P0 |
| T4773 | Eliminate confirmed operation duplicates | pending | P1 |
| T4774 | Decompose bloated system domain | pending | P1 |
| T4775 | Consolidate skills/providers/issues into tools | pending | P1 |
| T4776 | Design and spec the 9 intent-based domain model | done | - |
| T4777 | Merge lifecycle + release into pipeline | pending | P1 |
| T4778 | Rename research→memory, validate→check | pending | P1 |
| T4779 | Implement backward-compatible domain aliases | pending | P1 |
| T4780 | Update VERB-STANDARDS.md for BRAIN commands | pending | P2 |
| T4781 | Refactor src/mcp/engine/ → src/core/ | pending | P0 |
| **T4817** | **Migrate 51 CLI commands to dispatch** | **pending** | **P0** |
| **T4818** | **Implement CLI dispatch adapter** | **pending** | **P0** |
| **T4819** | **Implement MCP dispatch adapter** | **pending** | **P0** |
| **T4820** | **EPIC: Unified CQRS Dispatch Layer** | **in-progress** | **P0** |
| **T4821** | **Deprecate DomainRouter and legacy engines** | **pending** | **P1** |
| **T4822** | **Implement dynamic CLI registration** | **pending** | **P1** |

### 6.3 CLI Migration Task Breakdown

| Phase | Commands | Count | Tasks |
|-------|----------|-------|-------|
| Phase 1 | backup, checkpoint, delete, deps, doctor, restore | 6 | T4817-1 |
| Phase 2 | compliance, config, consensus, context, dash, detect-drift, env, export, history, import, labels | 11 | T4817-2 |
| Phase 3 | issue, lifecycle, log, migrate, phase, phases, promote, reorder, reparent, research | 10 | T4817-3 |
| Phase 4 | nexus, otel, safestop, skills, stats, sync, testing, validate, verify | 9 | T4817-4 |
| Phase 5 | extract, generate-changelog, implementation, inject, mcp-install, self-update, sequence, specification, decomposition, web | 10 | T4817-5 |
| Phase 6 | session (complete), checkpoint, migrate-storage | 5 | T4817-6 |

### 6.4 Pipeline Stage Dependencies

Per this ADR, the canonical pipeline is:

```
RCSD Phase:
  Research (T4797) ✓ COMPLETED
    │
    ▼
  Consensus (T4797) ✓ COMPLETED
    │
    ├──► ADR Protocol: ADR-007 (This Document) ⏳ PROPOSED → HITL → ACCEPTED
    │
    ▼
  Specification (T4776) ⏳ BLOCKED until ADR accepted
    │
    ▼
  Decomposition (T4772 child tasks) ⏳ BLOCKED until spec active
    │
    ├──► T4820: Dispatch Layer Implementation
    ├──► T4817: CLI Migration
    ├──► T4818-T4819: Adapter Implementation
    └──► T4821: Deprecation of Legacy Routing

IVTR Phase:
  Implementation → Validation ⇄ Testing → Release
  (With iteration loops: Validation/Testing can cycle back to Implementation)
```

**ADR Creation Flow**:
```
Research produces findings
    │
    ▼
Consensus evaluates options, reaches verdict
    │
    ▼
ADR Protocol captures decision (ADR-007 created) ⏳ PROPOSED
    │
    ▼
HITL reviews and ACCEPTS
    │
    ▼
Specification references ADR-007, formalizes requirements
    │
    ▼
Decomposition creates tasks
    │
    ├──► Dispatch layer implementation (T4820)
    ├──► CLI migration (T4817)
    ├──► MCP migration (T4819)
    └──► Dynamic registration (T4822)
```

**IVTR Iteration Flow**:
```
Decomposition complete
    │
    ▼
Implementation (tasks.start, orchestrate.spawn)
    │
    ▼
Validation (check.schema, check.lint)
    ├──► FAIL ──► Loop back to Implementation
    └──► PASS
         │
         ▼
    Testing (check.test.run, check.test.coverage)
         ├──► FAIL ──► Loop back to Implementation
         └──► PASS
              │
              ▼
         Release (pipeline.release.prepare, pipeline.release.tag)
```

**Loop Artifact Storage**:
- Each IVTR iteration MUST store agent outputs in `.cleo/agent-outputs/`
- Format: `T{task-id}-{iteration}-{stage}-{timestamp}.md`
- Example: `T4776-01-validation-2026-02-22T10:30:00Z.md`

---

## 7. Compliance Criteria

This decision is compliant when:

1. **ALL** 11-domain references in documentation are updated to 9-domain model
2. **ALL** duplicate operations identified in Section 3.8 are eliminated
3. **ALL** system domain operations are migrated to appropriate domains
4. **ALL** domain aliases are implemented for backward compatibility
5. **Pipeline definition** corrected to 8 stages (RCSD: 4, IVTR: 4) without "adr" stage
6. **RCSD_STAGES** array updated: `['research', 'consensus', 'specification', 'decomposition']`
7. **EXECUTION_STAGES** array updated: `['implementation', 'validation', 'testing', 'release']`
8. **Gateway routing** updated to route old domain names to new domains
9. **Tests** pass with new domain structure
10. **Contribution protocol** documented as cross-cutting (not a stage)
11. **ADR protocol** documented as producing artifacts during RCSD (not a stage)
12. **ALL 76 CLI commands** route through dispatch layer (zero bypass)
13. **MCP gateway** routes through dispatch adapter (not DomainRouter)
14. **Dynamic CLI registration** utility implemented
15. **DomainRouter deprecated** with migration path documented
16. **MCP engine files** migrated to src/core/ or removed

---

## 8. Notes

### 8.1 Consensus Reference

This ADR formalizes the consensus reached in T4797 (Domain Model Research). The consensus output is stored at:
- `.cleo/agent-outputs/T4797-domain-model-consolidation.md` (409 lines)

### 8.2 Pipeline Correction Required

**CRITICAL**: The `src/core/lifecycle/stages.ts` file currently defines 9 stages with "adr" as a stage. This MUST be corrected to:
- 8 stages total
- Remove "adr" from PIPELINE_STAGES
- Rename: spec → specification, decompose → decomposition, implement → implementation, verify → validation, test → testing
- Update TRANSITION_RULES to reflect 8-stage flow
- Document ADR and Contribution as protocols, not stages

### 8.3 Related ADRs

| ADR | Relationship | Description |
|-----|-------------|-------------|
| ADR-006 | Enables | SQLite storage architecture enables this domain consolidation |
| ADR-007 | (this) | Domain consolidation decision |
| ADR-008 | Implements | Canonical architecture with unified dispatch |
| ADR-009 | Extends | BRAIN cognitive architecture — bridges 5 dimensions to 9 domains, resolves storage and retrieval contradictions |

### 8.4 Implementation Status

**Current State (as of 2026-02-22)**:
- ✅ Dispatch layer skeleton implemented (T4820)
- ✅ 9 canonical domain handlers created
- ✅ 147 operations defined in registry
- ✅ CLI adapter implemented (25/76 commands using it)
- ✅ MCP adapter implemented (NOT YET INTEGRATED)
- ❌ 51 CLI commands bypass dispatch
- ❌ MCP still uses DomainRouter
- ❌ Dynamic CLI registration not implemented

**Blockers**:
1. This ADR requires HITL acceptance
2. T4817 (CLI migration) depends on this ADR
3. T4819 (MCP adapter integration) depends on this ADR

### 8.5 Future Considerations

- Nexus domain (0 current ops) is defined for BRAIN Network dimension forward compatibility
- src/core/nexus/ (1.5K lines) exists but is only CLI-exposed currently
- Future operations: nexus.find, nexus.export, nexus.import, nexus.coordinate
- Dynamic registration may evolve to support command plugins

---

### Footnotes

**[T4863, 2026-02-25]** This ADR defines an 8-stage pipeline (RCSD: 4, IVTR: 4) using long-form names. The canonical pipeline is now 9 stages using short-form names as defined in `src/core/lifecycle/stages.ts`: `research, consensus, adr, spec, decompose, implement, verify, test, release`. The `adr` stage was elevated from a cross-cutting protocol to a first-class pipeline stage between `consensus` and `spec`, per ADR-014 (T4860). Long-form names (`specification`, `decomposition`, `implementation`, `validation`, `testing`) are retained as `@deprecated` re-exports in `src/core/lifecycle/index.ts` for backward compatibility. See T4800 for the unification implementation and T4799 for the compatibility matrix.

**[T4798, 2026-02-25]** Section 3.3 CLI command mapping for the `session` domain does not yet include four planned BRAIN foundation features: `ct briefing` (session context summary), `ct bug` (structured bug reporting), `ct plan` (lightweight planning), and structured session handoff (`session.end` with handoff metadata). These map to the BRAIN Recall dimension and will be added as thin CLI wrappers delegating to `src/core/` business logic. See ADR-009 Section 6 (Recall dimension) for the architectural foundation. Epic created under T4763.

**END OF ADR-007**
