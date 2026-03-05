# Warp/MEOW/Protocol Chains Research Report

**Agent**: warp-researcher
**Date**: 2026-03-04
**Task**: Task #2 — Map Warp/MEOW/Protocol Chains from lore docs and existing pipeline/orchestrate code

---

## 1. Canon Term Mapping: How Each Warp Concept Maps to Existing Code

| Canon Term | Code Location | What Exists | What's Missing |
|---|---|---|---|
| **Thread** | `src/core/tasks/` — Task CRUD | Task is the atomic work unit. Full CRUD, hierarchy, dependencies in tasks.db | Nothing — Thread = Task is fully realized |
| **Loom** (epic frame) | `src/core/lifecycle/pipeline.ts` — lifecycle per epic | Pipeline state machine tracks RCASD stages per epic. Each epic gets a `StateMachineContext` | No explicit "Loom" object. The pipeline + epic is the Loom, but there's no `Loom` type |
| **Warp** (protocol chains) | Spread across 5 layers (see section 3) | Quality gates exist as 5 independent enforcement layers. NOT unified into a single chain definition | No declarative chain format. No composition. No definition-time verification |
| **Tapestry** (multi-Loom campaign) | `src/core/orchestration/waves.ts` — wave computation | Wave computation builds DAG execution plans from task dependencies | No Tapestry object. Multi-epic campaigns have no first-class representation |
| **Tessera** (reusable pattern card) | `.cleo/rcasd/T5332/T5332-complete-framework.md` — documentation only | Rich specification (v2.0.0) with archetypes, wave structure, RCASD gates. ZERO TypeScript source | Entirely conceptual. No `Tessera` type, no runtime representation, no storage |
| **Cogs** (callable capabilities) | `src/dispatch/domains/tools.ts` — tools domain | Skills, providers, issues. MCP operations as discrete capabilities | Cogs as a composable unit don't exist. Tools are flat, not composable |
| **Click** (single Cog activation) | Each MCP tool call | Every `cleo_query`/`cleo_mutate` invocation is a Click | No explicit Click tracking or instrumentation |
| **Cascade** (Tapestry in live motion) | `src/dispatch/middleware/verification-gates.ts` — runtime gate enforcement | Middleware intercepts operations and runs verification checks | No Cascade lifecycle object. "In motion through gates" is implicit, not tracked |
| **Tome** (living readable canon) | `MANIFEST.jsonl` — append-only artifact ledger | Manifest entries record what happened. Pipeline domain manages the ledger | No Tome rendering layer. Raw JSONL, not "living readable canon" |
| **MEOW** (workflow shape) | Implicit in `PIPELINE_STAGES` and `waves.ts` | Linear 9-stage pipeline + DAG-based wave computation | No declarative workflow format. Shape is hardcoded or computed, never declared |

---

## 2. MEOW Analysis: Workflow Shape and Declarative Format Proposal

### Current State: Shape Is Implicit

CLEO has two workflow shapes today, both implicit:

1. **PIPELINE_STAGES** (`src/core/lifecycle/stages.ts:43-53`): A fixed linear 9-stage pipeline (research -> consensus -> architecture_decision -> specification -> decomposition -> implementation -> validation -> testing -> release). This is MEOW for the RCASD-IVTR+C lifecycle — but it's a single hardcoded shape, not parameterizable.

2. **Wave computation** (`src/core/orchestration/waves.ts:40-90`): Takes a set of tasks with dependencies and computes execution waves via topological sort. This IS runtime shape computation — it builds the MEOW at execution time from the task DAG.

### What's Missing for Declarative MEOW

**No intermediate declarative layer.** You cannot say "this workflow has this shape" as a reusable artifact. The Tessera Pattern (T5332) describes this conceptually but has zero TypeScript representation.

**No composability primitives.** You cannot take two workflow shapes and combine them (sequence, parallel, conditional). The only composition is implicit: wave computation flattens a dependency graph.

**No shape validation.** There is no system for verifying that a declared workflow shape is well-formed (no cycles, reachable end state, valid branch conditions) before execution.

### Proposed Declarative Format: WarpChain Definition

A WarpChain would be the runtime data structure that represents MEOW + LOOM unified. The format should be TypeScript interfaces (not JSON Schema, not YAML) because:
- Type safety at definition time
- Composable via TypeScript generics
- Can be validated by the compiler, not just a runtime schema check
- Consistent with the rest of CLEO's codebase

```typescript
// ===== MEOW: Workflow Shape Primitives =====

/** A single stage in a workflow chain */
interface WarpStage {
  id: string;                          // Unique stage identifier
  name: string;                        // Human-readable name
  category: 'planning' | 'decision' | 'execution' | 'validation' | 'delivery';
  skippable: boolean;
}

/** Connection topology between stages */
type WarpLink =
  | { type: 'linear'; from: string; to: string }
  | { type: 'fork'; from: string; to: string[]; join: string }     // parallel fork -> join
  | { type: 'branch'; from: string; condition: string; branches: Record<string, string> }; // conditional

/** The shape of a workflow (MEOW layer) */
interface ChainShape {
  stages: WarpStage[];
  links: WarpLink[];
  entryPoint: string;                  // ID of first stage
  exitPoints: string[];                // IDs of terminal stages
}

// ===== LOOM: Gate Contract Primitives =====

/** A quality gate attached to a stage transition */
interface GateContract {
  id: string;
  name: string;
  type: 'prerequisite' | 'transition' | 'artifact' | 'custom';
  stageId: string;                     // Which stage this gate guards
  position: 'entry' | 'exit';         // Check on entry or exit
  check: GateCheck;                    // The actual validation
  severity: 'blocking' | 'warning';
  canForce: boolean;
}

/** Gate check definition — what to validate */
type GateCheck =
  | { type: 'stage_complete'; stages: string[] }          // Prerequisites met
  | { type: 'artifact_exists'; artifacts: string[] }       // Required outputs present
  | { type: 'protocol_valid'; protocol: ProtocolType }     // Protocol validation passes
  | { type: 'verification_gate'; gate: GateName }          // Verification gate passes
  | { type: 'custom'; validator: string; params: Record<string, unknown> };

// ===== WARP: Unified Chain (MEOW + LOOM) =====

/** A WarpChain is the synthesis: workflow shape + embedded quality gates */
interface WarpChain {
  id: string;
  name: string;
  version: string;
  description: string;

  // MEOW: the shape
  shape: ChainShape;

  // LOOM: the gates
  gates: GateContract[];

  // Tessera: metadata for reuse
  tessera?: {
    variables: Record<string, { type: string; description: string; default?: unknown }>;
    archetypes: string[];              // Which Circle of Ten archetypes this chain uses
  };

  // Validation: definition-time proof
  validation?: ChainValidation;
}

/** Result of static chain validation */
interface ChainValidation {
  wellFormed: boolean;                 // No cycles, reachable exits, valid links
  gateSatisfiable: boolean;            // Every gate has a stage that can satisfy it
  artifactComplete: boolean;           // Every required artifact has a producing stage
  errors: string[];
  warnings: string[];
}
```

### How Tessera Relates to MEOW

A **Tessera** IS a parameterized WarpChain template. The Tessera Pattern (T5332) already describes this:
- A Tessera defines archetype mix, wave structure, RCASD gate status, and critical path
- When instantiated with project-specific inputs, a Tessera produces a concrete WarpChain
- The WarpChain is then executed as a Cascade

The relationship: `Tessera (template) -> instantiate(inputs) -> WarpChain (concrete) -> execute -> Cascade (live)`

---

## 3. LOOM Analysis: Current Gate Layers and Embedding Strategy

### 5 Existing Enforcement Layers

**Layer 1: Pipeline Stage Gates** (`src/core/lifecycle/state-machine.ts`)
- `checkPrerequisites()` validates prerequisites before stage transitions
- `validateTransition()` validates state machine transitions
- `STAGE_PREREQUISITES` map defines which stages must complete first
- Each `StageDefinition` has `requiredGates: string[]` and `expectedArtifacts: string[]`
- Status transitions: not_started -> in_progress -> completed, with blocked/failed/skipped branches

**Layer 2: Verification Gates** (`src/core/validation/verification.ts`)
- 6-gate dependency chain: `implemented -> testsPassed -> qaPassed -> cleanupDone -> securityPassed -> documented`
- `VERIFICATION_GATE_ORDER` is a fixed constant array
- Round-based retry tracking with failure logging (max 5 rounds)
- Agent attribution and circular validation prevention
- `getMissingGates()`, `checkAllGatesPassed()`, `computePassed()`

**Layer 3: Dispatch Middleware** (`src/dispatch/middleware/verification-gates.ts`)
- Wraps the legacy `createVerificationGate()` function
- Intercepts ALL dispatch operations via the middleware pipeline
- Returns `E_VALIDATION_FAILED` (exit code 80) on gate failure
- Attaches verification result to response `_meta`

**Layer 4: Protocol Validators** (`src/core/orchestration/protocol-validators.ts`)
- 9 protocol types: research, consensus, specification, decomposition, implementation, contribution, release, artifact-publish, provenance
- Each protocol has specific validation rules (e.g., RSCH-006: 3-7 key findings)
- Returns `ProtocolValidationResult` with violations, severity, and fix suggestions
- Maps to exit codes 60-67

**Layer 5: Check Domain** (`src/dispatch/domains/check.ts`)
- Operations: `check.schema`, `check.protocol`, `check.task`, `check.manifest`, `check.output`, `check.compliance.summary`, `check.compliance.violations`, `check.compliance.record`, `check.test.status`, `check.test.coverage`, `check.coherence.check`, `check.test.run`, plus 5 protocol-specific operations
- Delegates to engine functions from `validate-engine`
- This is the MCP surface for quality operations

### Gaps in Current LOOM

1. **Gates are runtime-only.** All gate checks happen at execution time. There is no way to embed gate requirements into a workflow definition.

2. **No gate composition.** You cannot define "this workflow requires these gates at these points." Gates are globally applied based on stage, not locally configured per workflow.

3. **No custom gate definitions.** The verification gate chain is fixed (6 gates in `VERIFICATION_GATE_ORDER`). Users cannot add domain-specific quality gates.

4. **No gate-aware workflow planning.** When planning a Tessera deployment, there's no way to verify that the planned shape will satisfy all required gates before execution.

5. **No definition-time embedding.** The 5 layers operate independently. Nothing ties them together as "this is the complete quality contract for this workflow."

### Embedding Strategy

To make LOOM gates intrinsic to workflow definitions, the `GateContract` type in the WarpChain would wrap existing layers:

| Existing Layer | Maps to GateCheck Type | Embedding |
|---|---|---|
| Pipeline prerequisites (`STAGE_PREREQUISITES`) | `stage_complete` | Entry gates per stage |
| Verification gates (`VERIFICATION_GATE_ORDER`) | `verification_gate` | Exit gates at implementation/testing |
| Protocol validators (9 types) | `protocol_valid` | Stage-specific protocol checks |
| Stage artifacts (`expectedArtifacts`) | `artifact_exists` | Exit gates requiring outputs |
| Custom validation | `custom` | User-defined gates (new) |

The default RCASD-IVTR+C WarpChain would embed all existing gates as its gate contract. Custom WarpChains could override or extend.

---

## 4. Warp Design: Data Structures, Operations, Domain Mapping

### Runtime Data Structures

A WarpChain exists in three states:

1. **Definition** (stored in brain.db as a pattern, or inline in code):
   - `WarpChain` — the full definition with shape + gates
   - Validated at definition time (well-formed, gate-satisfiable)

2. **Instance** (created when a Tessera is instantiated for a specific epic):
   - `WarpChainInstance` — a concrete chain bound to specific task IDs
   - Variables resolved, archetypes assigned, task IDs mapped

3. **Execution** (live Cascade state):
   - `WarpChainExecution` — runtime state tracking active stage, gate results, progress
   - Links to `StateMachineContext` for stage tracking
   - Links to `Verification` for gate tracking

```typescript
/** Instantiated chain bound to specific tasks */
interface WarpChainInstance {
  chainId: string;                     // Reference to WarpChain definition
  epicId: string;                      // The epic this instance serves
  variables: Record<string, unknown>;  // Resolved template variables
  stageToTask: Record<string, string>; // Stage ID -> Task ID mapping
  createdAt: string;
  createdBy: string;
}

/** Live execution state of a chain */
interface WarpChainExecution {
  instanceId: string;
  currentStage: string;
  gateResults: Record<string, {
    gateId: string;
    passed: boolean;
    checkedAt: string;
    details?: unknown;
  }>;
  status: 'active' | 'blocked' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
}
```

### Domain Mapping

WarpChain operations map to existing domains — NO new domains needed:

| Operation | Domain | Gateway | Purpose |
|---|---|---|---|
| `pipeline.chain.show` | pipeline | query | Show a WarpChain definition |
| `pipeline.chain.list` | pipeline | query | List available WarpChains |
| `pipeline.chain.find` | pipeline | query | Search chains by criteria |
| `pipeline.chain.validate` | check | query | Static validation of chain definition |
| `pipeline.chain.add` | pipeline | mutate | Define a new WarpChain |
| `pipeline.chain.instantiate` | pipeline | mutate | Create instance from definition for an epic |
| `pipeline.chain.advance` | pipeline | mutate | Advance execution to next stage |
| `pipeline.chain.gate.check` | check | query | Run gate checks for current stage |
| `pipeline.chain.gate.pass` | pipeline | mutate | Record gate passage |
| `pipeline.chain.gate.fail` | pipeline | mutate | Record gate failure |
| `orchestrate.chain.plan` | orchestrate | query | Generate wave plan from chain instance |

This adds 11 new operations to existing domains, keeping the 10-domain contract intact.

### How This Maps to Existing Pipeline Stages

The default RCASD-IVTR+C WarpChain would be:

```typescript
const RCASD_IVTRC_CHAIN: WarpChain = {
  id: 'rcasd-ivtrc',
  name: 'RCASD-IVTR+C Default Pipeline',
  version: '1.0.0',
  description: 'The canonical 9-stage lifecycle pipeline with embedded quality gates',
  shape: {
    stages: PIPELINE_STAGES.map(s => ({
      id: s,
      name: STAGE_DEFINITIONS[s].name,
      category: STAGE_DEFINITIONS[s].category,
      skippable: STAGE_DEFINITIONS[s].skippable,
    })),
    links: [
      { type: 'linear', from: 'research', to: 'consensus' },
      { type: 'linear', from: 'consensus', to: 'architecture_decision' },
      // ... all 8 linear links
    ],
    entryPoint: 'research',
    exitPoints: ['release'],
  },
  gates: [
    // Entry gate for consensus: research must be complete
    { id: 'g-cons-prereq', name: 'Research Complete', type: 'prerequisite',
      stageId: 'consensus', position: 'entry',
      check: { type: 'stage_complete', stages: ['research'] },
      severity: 'blocking', canForce: true },
    // ... all existing STAGE_PREREQUISITES as entry gates
    // ... all existing VERIFICATION_GATE_ORDER as exit gates at implementation
    // ... all 9 protocol validators as stage-specific checks
  ],
};
```

This default chain IS the existing system — same stages, same gates, same behavior. But now it's a data structure that can be inspected, composed, and extended.

---

## 5. WarpChain Definition Schema Proposal (Concrete TypeScript Interfaces)

See section 2 above for the complete TypeScript interfaces. Summary of key types:

- `WarpStage` — a single stage in a workflow
- `WarpLink` — connection topology (linear, fork, branch)
- `ChainShape` — the MEOW layer (stages + links + entry/exit)
- `GateContract` — a quality gate bound to a stage
- `GateCheck` — the validation logic (stage_complete, artifact_exists, protocol_valid, verification_gate, custom)
- `WarpChain` — the unified definition (shape + gates + tessera metadata)
- `WarpChainInstance` — concrete instance bound to an epic
- `WarpChainExecution` — live execution state
- `ChainValidation` — result of static definition-time verification

Storage: WarpChain definitions would be stored in brain.db as patterns (memory.pattern.store), with full-text search via FTS5. Instances and execution state would live in tasks.db (extending the existing lifecycle_pipelines table).

---

## 6. the legacy pattern Patterns in Current CLEO to Upgrade

"the legacy pattern" = bolted-on quality (gates at runtime only, not definition-time).

### Pattern 1: Fixed Verification Gate Chain

**Current (the legacy pattern)**: `VERIFICATION_GATE_ORDER` is a fixed 6-gate constant in `src/core/validation/verification.ts:20-27`. Every task gets the same gates regardless of workflow type.

**Warp upgrade**: Gate contracts are per-chain. A security audit WarpChain has different gates than a documentation update chain. The gates are declared in the chain definition.

### Pattern 2: Runtime-Only Prerequisite Checking

**Current (the legacy pattern)**: `STAGE_PREREQUISITES` in `stages.ts:351-361` is checked at runtime via `checkPrerequisites()`. You can define a workflow that's structurally impossible to complete, and you won't know until execution fails.

**Warp upgrade**: `ChainValidation.gateSatisfiable` verifies at definition time that every gate has a stage capable of satisfying it. Badly-formed chains are rejected before execution.

### Pattern 3: Middleware as Bolt-On

**Current (the legacy pattern)**: `verification-gates.ts` middleware intercepts ALL operations indiscriminately. It wraps a legacy function. The middleware has no knowledge of the workflow shape it's protecting.

**Warp upgrade**: Gate enforcement reads the WarpChain definition to know which gates apply at which stage. The middleware becomes chain-aware, not blind.

### Pattern 4: Protocol Validators Disconnected from Workflow

**Current (the legacy pattern)**: Protocol validators in `protocol-validators.ts` validate manifest entries against protocol rules. But nothing connects "this stage requires this protocol" at definition time.

**Warp upgrade**: `GateCheck.protocol_valid` embeds protocol requirements into the chain definition. Stage `research` in the chain declares it requires the research protocol. This is verified before execution.

### Pattern 5: No Workflow Composition

**Current (the legacy pattern)**: The only workflow shape is the hardcoded 9-stage pipeline. If you want a different workflow (e.g., a 3-stage bug fix: implement -> test -> release), you skip stages with `force` flags.

**Warp upgrade**: Define custom WarpChains. A "Bug Fix" chain has 3 stages with appropriate gates. A "Security Audit" chain has 5 stages. Composition operators let you combine chains.

---

## 7. Relationship to Tessera, Tapestry, Cascade

### Tessera -> WarpChain (template)

A Tessera IS a WarpChain with `tessera.variables` populated. The Tessera Pattern (T5332) already defines:
- Archetype mix (maps to `tessera.archetypes`)
- Wave structure (maps to `shape.stages` + `shape.links`)
- RCASD gate status (maps to `gates[]`)
- Template variables (maps to `tessera.variables`)

The T5332 framework becomes the human documentation format; WarpChain becomes the machine-executable format. They're two views of the same thing.

### Tapestry -> WarpChainInstance (concrete)

A Tapestry is a WarpChainInstance bound to specific tasks. When you instantiate a Tessera for an epic:
- Variables are resolved
- Task IDs are assigned to stages
- The result is a Tapestry — a concrete body of work

### Cascade -> WarpChainExecution (live)

A Cascade is a Tapestry in motion. The WarpChainExecution tracks:
- Which stage is active
- Which gates have passed/failed
- Overall status (active, blocked, completed, failed)

This maps directly to the existing `StateMachineContext` in `state-machine.ts`.

### Flow

```
Tessera (reusable pattern)
  |
  | instantiate(epicId, variables)
  v
Tapestry (concrete chain instance)
  |
  | execute()
  v
Cascade (live execution with gate tracking)
  |
  | complete / fail
  v
Tome (durable record in MANIFEST.jsonl / brain.db)
```

---

## 8. New Operations Needed (domain.operation format)

### Pipeline Domain (6 new operations)

| Operation | Gateway | Description |
|---|---|---|
| `pipeline.chain.show` | query | Show a WarpChain definition by ID |
| `pipeline.chain.list` | query | List all WarpChain definitions |
| `pipeline.chain.find` | query | Search chains by name/category/archetype |
| `pipeline.chain.add` | mutate | Define a new WarpChain |
| `pipeline.chain.instantiate` | mutate | Create a Tapestry (instance) from a Tessera (chain def) for an epic |
| `pipeline.chain.advance` | mutate | Advance chain execution to next stage |

### Check Domain (2 new operations)

| Operation | Gateway | Description |
|---|---|---|
| `check.chain.validate` | query | Static validation of WarpChain definition (well-formed, gate-satisfiable) |
| `check.chain.gate` | query | Run gate checks for a specific stage in a chain instance |

### Orchestrate Domain (1 new operation)

| Operation | Gateway | Description |
|---|---|---|
| `orchestrate.chain.plan` | query | Generate wave execution plan from a chain instance's shape |

### Pipeline Domain — Gate Tracking (2 new operations)

| Operation | Gateway | Description |
|---|---|---|
| `pipeline.chain.gate.pass` | mutate | Record successful gate passage for a chain instance |
| `pipeline.chain.gate.fail` | mutate | Record gate failure with reason |

**Total: 11 new operations (6 pipeline query/mutate, 2 check query, 1 orchestrate query, 2 pipeline mutate)**

---

## 9. Atomic Task Decomposition for Implementation

### Phase 1: Type Definitions (small, 1 file)

**Task**: Define WarpChain type system
- **File**: `src/types/warp-chain.ts`
- **Scope**: All TypeScript interfaces from section 5 — WarpStage, WarpLink, ChainShape, GateContract, GateCheck, WarpChain, WarpChainInstance, WarpChainExecution, ChainValidation
- **Dependencies**: Imports from `src/core/lifecycle/stages.ts` (Stage type), `src/core/validation/verification.ts` (GateName type), `src/core/orchestration/protocol-validators.ts` (ProtocolType)
- **Tests**: Type-only, validated by TypeScript compiler

### Phase 2: Default Chain Builder (small, 1-2 files)

**Task**: Build the default RCASD-IVTR+C WarpChain from existing constants
- **File**: `src/core/lifecycle/default-chain.ts`
- **Scope**: Function that constructs the canonical WarpChain from PIPELINE_STAGES, STAGE_PREREQUISITES, STAGE_DEFINITIONS, VERIFICATION_GATE_ORDER, and PROTOCOL_TYPES
- **Dependencies**: Phase 1 types, existing lifecycle/stages.ts, validation/verification.ts, orchestration/protocol-validators.ts
- **Tests**: `src/core/lifecycle/__tests__/default-chain.test.ts` — verify the default chain has 9 stages, all prerequisites as entry gates, all verification gates, all protocol validators

### Phase 3: Chain Validation (small, 1-2 files)

**Task**: Implement static chain validation (well-formedness + gate satisfiability)
- **File**: `src/core/validation/chain-validation.ts`
- **Scope**: `validateChainShape()` — no cycles, reachable exits, valid links. `validateGateSatisfiability()` — every gate has a producing stage. `validateChain()` — full validation returning `ChainValidation`
- **Dependencies**: Phase 1 types
- **Tests**: `src/core/validation/__tests__/chain-validation.test.ts` — well-formed chains pass, cyclic chains fail, unsatisfiable gates detected

### Phase 4: Chain Storage (medium, 2 files)

**Task**: Store WarpChain definitions in tasks.db (or brain.db as patterns)
- **File**: `src/store/chain-schema.ts` (Drizzle schema extension), `src/core/lifecycle/chain-store.ts` (CRUD operations)
- **Scope**: Schema for warp_chains table. addChain, showChain, listChains, findChains functions
- **Dependencies**: Phase 1 types, Phase 3 validation (validate before store)
- **Migration**: `npx drizzle-kit generate` for new table
- **Tests**: Integration tests for CRUD operations

### Phase 5: Chain Instance + Execution (medium, 2 files)

**Task**: Implement chain instantiation and execution tracking
- **File**: `src/core/lifecycle/chain-instance.ts`, `src/core/lifecycle/chain-execution.ts`
- **Scope**: `instantiateChain()` — bind chain to epic + tasks, resolve variables. `advanceChainExecution()` — check gates, advance stage, track state
- **Dependencies**: Phase 1-4
- **Tests**: Full lifecycle test: define chain -> validate -> instantiate -> advance through stages -> complete

### Phase 6: MCP Operations Wiring (medium, 2 files)

**Task**: Wire 11 new operations into dispatch registry and domain handlers
- **File**: Update `src/dispatch/registry.ts` (11 new OperationDef entries), update `src/dispatch/domains/pipeline.ts` and `src/dispatch/domains/check.ts` (new handlers)
- **Scope**: Register operations, route to engine functions, handle params
- **Dependencies**: Phase 1-5 (all core logic must exist)
- **Tests**: E2E tests via dispatch: `query pipeline.chain.show`, `mutate pipeline.chain.add`, etc.

### Phase 7: Chain Composition (medium, 1-2 files)

**Task**: Implement chain composition operators
- **File**: `src/core/lifecycle/chain-composition.ts`
- **Scope**: `sequenceChains()` — A >> B. `parallelChains()` — A | B -> join. Composition safety: composed chains maintain gate invariants from both sources
- **Dependencies**: Phase 1-3 (types + validation)
- **Tests**: Compose two valid chains -> result is valid. Compose conflicting chains -> validation catches it

### Phase 8: Orchestrate Integration (small, 1 file)

**Task**: Wire chain instances into wave computation
- **File**: Update `src/core/orchestration/waves.ts`
- **Scope**: `computeWavesFromChain()` — generate wave plan from a WarpChainInstance's shape (handles fork/branch, not just linear)
- **Dependencies**: Phase 5 (chain instances exist)
- **Tests**: Fork chain produces parallel waves. Linear chain produces sequential waves. Branch chain produces conditional waves

---

## 10. Dependencies Between Warp Tasks and Other Workstreams

### Dependencies ON Other Workstreams

| Warp Phase | Depends On | Reason |
|---|---|---|
| Phase 4 (Storage) | BRAIN Phase 1-2 (DONE) | If storing chains in brain.db as patterns, needs brain.db schema access |
| Phase 4 (Storage) | Drizzle migration system | New table needs drizzle-kit generate |
| Phase 6 (MCP Wiring) | Dispatch registry | Must add entries to OPERATIONS array |
| Phase 8 (Orchestrate) | Existing waves.ts | Extends, not replaces. Must maintain backward compat |

### Dependencies FROM Other Workstreams

| Other Workstream | Depends on Warp Phase | Reason |
|---|---|---|
| BRAIN Phase 3 (SQLite-vec) | Phase 4 (Storage) | WarpChain definitions could be vectorized for semantic search |
| Tessera runtime | Phase 1-5 (all) | Tessera becomes a WarpChain template; needs the full type system |
| Hooks system | Phase 6 (MCP Wiring) | Hook dispatch points may want to fire on chain.advance or chain.gate.pass events |
| CAAMP skills | Phase 1 (Types) | Skills could declare which WarpChain gates they can satisfy |

### No Hard Blockers

Warp Phase 1-3 (types, default chain, validation) have NO external dependencies. They can be built immediately using only existing types from the lifecycle and validation modules.

Phase 4+ needs design decisions about storage location (tasks.db vs brain.db) and Drizzle migration, but these are standard CLEO patterns with established precedent.

---

## Summary

The Warp/Protocol Chains concept fills a real architectural gap: CLEO has sophisticated quality enforcement (5 layers), but those gates are bolted on at runtime rather than embedded in workflow definitions. The WarpChain type system unifies MEOW (workflow shape) and LOOM (quality gates) into a single declarative format that can be validated before execution, composed safely, and extended with custom gates.

The implementation is decomposed into 8 phases, each touching 1-2 files, building incrementally from types -> validation -> storage -> MCP wiring -> composition -> orchestration. Phases 1-3 are immediately executable with no external dependencies.
