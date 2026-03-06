# Protocol Chains Analysis

**Agent**: protocol-analyst
**Date**: 2026-03-04
**Task**: Task #1 — MEOW vs LOOM distinction and Protocol Chains design
**Scope**: Deep analysis of MEOW, LOOM, the legacy pattern, and Protocol Chains design proposal

---

## 1. MEOW Analysis

### What MEOW Would Define

MEOW is entirely absent from the codebase (zero references). Based on the SN-005 insight that "MEOW defines WORKFLOW SHAPE (composable workflow program structure)," MEOW would be the missing concept for **defining the structural template of how work flows** — distinct from LOOM's concern with quality/correctness of that flow.

Think of it this way:
- **LOOM** answers: "What stages must work pass through, and what gates must it clear?"
- **MEOW** would answer: "What is the composable shape of this particular workflow? How do its parts connect, branch, merge, and repeat?"

MEOW is about **workflow topology** — the DAG shape, the branching logic, the composition rules, the reusable structural patterns. It is the "program" that describes how work moves, while LOOM is the "type system" that validates correctness at each step.

### Current Codebase Patterns That Align with MEOW's Domain

Several existing patterns implicitly do MEOW's work without naming it:

1. **Tessera Pattern** (`.cleo/rcasd/T5332/T5332-complete-framework.md`): The Tessera Pattern is the closest existing concept to MEOW. It defines reusable multi-agent orchestration shapes — Wave sequences, archetype assignments, Round groupings, dependency DAGs. This IS workflow shape definition. Tessera is currently described as "a reusable composition pattern that can generate Tapestries with different inputs." That description is almost exactly what MEOW would formalize.

2. **Wave/Round Structure** (`src/core/orchestration/waves.ts`): The wave computation engine builds a dependency-ordered execution plan from a task DAG. This is runtime workflow shape calculation — it computes the MEOW at execution time rather than having it defined at design time.

3. **RCASD-IVTR+C Pipeline** (`src/core/lifecycle/stages.ts`): The 9-stage pipeline IS a fixed workflow shape. PIPELINE_STAGES defines a linear progression with prerequisites. But it is a single hardcoded shape, not a composable or parameterizable one.

4. **Orchestrator Protocol** (`docs/mintlify/developer/specifications/ORCHESTRATOR-PROTOCOL.mdx`): ORC-004 ("MUST spawn agents in dependency order") and ORC-008 ("MUST verify previous agent compliance before next spawn") describe workflow shape constraints — the order and dependency structure of execution.

### Gaps

- **No declarative workflow definition format**: Workflow shapes are either hardcoded (PIPELINE_STAGES) or computed at runtime (waves.ts). There is no intermediate layer where a user/agent can **declare** a workflow shape as a reusable artifact.
- **No composability primitives**: You cannot take two workflow shapes and compose them (sequence, parallel, conditional branch). The Tessera Pattern describes this conceptually but has no runtime representation.
- **No workflow shape validation**: There is no system for validating that a declared workflow shape is well-formed (no cycles, reachable end state, valid branch conditions) before execution.
- **Tessera exists only in documentation**: Despite being the most MEOW-aligned concept, Tessera has ZERO TypeScript source references. It lives entirely in `.cleo/rcasd/` and `docs/concepts/`.

---

## 2. LOOM Analysis

### What LOOM Defines as Quality Completion

LOOM (Logical Order of Operations Methodology) is well-established in the codebase as the **quality and correctness framework**. It defines:

1. **Stage progression rules**: Work must pass through stages in order (Research -> Consensus -> ADR -> Spec -> Decomposition -> Implementation -> Validation -> Testing -> Release).
2. **Gate enforcement**: Each stage has prerequisite gates that must be satisfied before progression.
3. **Protocol compliance**: Each stage has an associated protocol type with validation rules.
4. **Verification gates**: A dependency chain of quality checks (implemented -> testsPassed -> qaPassed -> cleanupDone -> securityPassed -> documented).

### Current Gate Implementations

**Layer 1: Pipeline Stage Gates** (`src/core/lifecycle/state-machine.ts`)
- `PrereqCheck` validates prerequisites before stage transitions
- `TransitionValidation` validates state machine transitions (not_started -> in_progress -> completed, with blocked/failed/skipped branches)
- Each `StageDefinition` has `requiredGates: string[]` and `expectedArtifacts: string[]`

**Layer 2: Verification Gates** (`src/core/validation/verification.ts`)
- 6-gate dependency chain: implemented -> testsPassed -> qaPassed -> cleanupDone -> securityPassed -> documented
- Round-based retry tracking with failure logging
- Agent attribution for each gate passage

**Layer 3: Dispatch Middleware** (`src/dispatch/middleware/verification-gates.ts`)
- Intercepts all dispatch operations
- Runs verification gate checks before operation execution
- Returns `E_VALIDATION_FAILED` (exit 80) on gate failure

**Layer 4: Protocol Validators** (`src/core/orchestration/protocol-validators.ts`)
- 9 protocol types, each with specific validation rules
- Validates manifest entries against protocol requirements
- Returns violation lists with severity and fix suggestions

**Layer 5: Check Domain** (`src/dispatch/domains/check.ts`)
- Schema validation, protocol compliance, task validation
- Manifest checks, output validation, compliance tracking
- Coherence checks and test operations

### Gaps

- **Gates are runtime-only**: All gate checks happen at execution time. There is no way to embed gate requirements into a workflow definition itself.
- **No gate composition**: You cannot define "this workflow shape requires these specific gates at these specific points." Gates are globally applied based on stage, not locally configured per workflow.
- **No custom gate definitions**: The verification gate chain is fixed (6 gates). Users cannot define domain-specific quality gates for specific workflow shapes.
- **No gate-aware workflow planning**: When planning a workflow (Tessera), there is no mechanism to verify that the planned shape will satisfy all required gates before execution begins.

---

## 3. the legacy pattern Context

### Zero References in Codebase

"the legacy pattern" appears nowhere in the CLEO codebase, documentation, or ADRs. This is an external reference.

### Most Likely Meaning

In the context of "make CLEO better than the legacy pattern," the legacy pattern most likely represents the **anti-pattern of bolted-on quality** — systems where:

1. **Quality is an afterthought**: Gates and validations are added after workflow design, not embedded in it. The workflow runs and then you check if it was good enough — reactive rather than proactive.

2. **Workflow and quality are separate concerns**: The team that designs the workflow shape is different from the team that defines the quality gates. They meet at runtime when things break.

3. **No structural guarantees**: You can define a workflow that is structurally incapable of passing its gates, and you won't know until execution fails. The shape and the quality contract are not co-verified.

4. **Fragile chain integrity**: When quality checks are external to workflow definitions, adding or modifying a gate can silently break workflows that were previously passing. There is no compile-time safety.

The name "the legacy pattern" evokes a place where things are cobbled together from whatever fuel is available — functional but brittle, operational but inelegant. It works until it doesn't, and when it breaks, the failure is always a surprise because the structure never promised anything.

### How CLEO Aims to Surpass It

CLEO already has sophisticated gate enforcement (5 layers described above). The gap is not "CLEO lacks gates" — it is "CLEO's gates are not part of the workflow definition language." Protocol Chains would close that gap by making quality gates intrinsic to workflow shape definitions.

---

## 4. Protocol Chains Design Proposal

### Definition

**Protocol Chains** = composable workflow definitions (MEOW shape) with embedded quality gates (LOOM correctness) baked in at definition time, verified before execution begins.

A Protocol Chain is a **workflow program** where each link in the chain carries:
1. A **stage definition** (what work happens here — the Thread)
2. A **gate contract** (what quality conditions must be met to progress — the LOOM check)
3. A **connection topology** (how this link connects to the next — the MEOW shape)

### How It Works

When you define a Protocol Chain, you are simultaneously defining:
- The **execution shape** (MEOW): what stages exist, how they connect, where they branch/merge
- The **quality contract** (LOOM): what gates guard each transition, what artifacts each stage must produce
- The **verification guarantee**: the chain is statically analyzable — you can verify before execution that the shape satisfies the quality contract

This is the synthesis: **quality gates become part of the type system of workflow composition**, not runtime assertions bolted onto a shape after the fact.

### Domain Mapping

| Existing Domain | Protocol Chains Role | Canon Aspect |
|----------------|---------------------|--------------|
| `pipeline` | Stage definitions, RCASD-IVTR+C lifecycle | Loom frame, Cascade descent |
| `check` | Gate validation, protocol compliance | Gatehouse verification |
| `orchestrate` | Execution coordination, wave computation | Conductor's balcony |
| `tools` | Cog/Click execution primitives | Forge-bench of Cogs |
| `tasks` | Thread-level work tracking | House of Threads |
| `memory` | Tome recording of chain execution | Deep archive |

### Implementation Architecture

```
Protocol Chain Definition (MEOW layer — new)
├── ChainShape: DAG of stages with connection topology
│   ├── LinearChain: A -> B -> C
│   ├── ParallelFork: A -> [B, C] -> D
│   ├── ConditionalBranch: A -> if(X) B else C -> D
│   └── ComposedChain: Chain1 >> Chain2 (sequence composition)
│
├── GateContract (LOOM layer — extends existing)
│   ├── StageGate: prerequisites for entering a stage
│   ├── TransitionGate: conditions for moving between stages
│   ├── ArtifactGate: required outputs before stage completion
│   └── CustomGate: user-defined domain-specific checks
│
└── ChainValidator (synthesis layer — new)
    ├── ShapeValidation: no cycles, reachable end, valid branches
    ├── GateSatisfiability: every gate has a stage that can satisfy it
    ├── ArtifactCompleteness: every required artifact has a producing stage
    └── CompositionSafety: composed chains maintain gate invariants
```

### Relationship to Existing Systems

Protocol Chains would **compose on top of** existing systems, not replace them:

- **PIPELINE_STAGES** becomes the **default chain shape** — the canonical RCASD-IVTR+C chain that every significant piece of work uses
- **Verification gates** become **gate contracts** that can be attached to any chain, not just the default pipeline
- **Tessera Pattern** becomes the **human-readable documentation format** for Protocol Chain definitions — the pattern card IS the chain specification
- **Wave computation** becomes the **runtime executor** that takes a validated Protocol Chain and schedules its execution

---

## 5. MEOW + LOOM Synthesis

### The Core Insight

MEOW and LOOM are two halves of the same problem:

| Aspect | MEOW (Shape) | LOOM (Quality) |
|--------|-------------|----------------|
| Defines | Workflow topology | Correctness criteria |
| Answers | "What is the structure?" | "Is the structure good enough?" |
| Analogy | The blueprint | The building code |
| Failure mode | Workflow doesn't connect | Workflow produces bad output |
| Current state | Implicit (computed at runtime) | Explicit (5 layers of gates) |

### Protocol Chains as Synthesis

Protocol Chains merge these by making the "building code" part of the "blueprint language":

```
BEFORE (the legacy pattern pattern):
  1. Define workflow shape (MEOW — implicit, ad-hoc)
  2. Run workflow
  3. Check quality gates (LOOM — runtime only)
  4. Fail late, fix expensive

AFTER (Protocol Chains):
  1. Define workflow shape WITH quality gates (MEOW + LOOM co-defined)
  2. Validate chain statically (gates satisfiable? shape well-formed?)
  3. Run workflow with embedded gate enforcement
  4. Fail early at definition time, fix cheap
```

The key property is **definition-time verification**: you cannot define a Protocol Chain that is structurally incapable of satisfying its own gates. The chain definition is the proof that the quality contract can be met.

### What This Gives CLEO

1. **Reusable quality-assured workflows**: A "Security Audit Tessera" carries not just the workflow shape but the quality gates — when you instantiate it, the gates come with it.
2. **Composable safety**: When you compose two chains, the system verifies that the composed chain maintains all gate invariants from both source chains.
3. **Static analysis**: Before spawning any agents, the orchestrator can verify that the planned execution will satisfy all quality requirements.
4. **Custom quality profiles**: Different project types can define different gate contracts — an internal tool needs different gates than a security-critical service.

---

## 6. Canon Naming Fit Assessment

### Does "Protocol Chains" Fit the Workshop Language?

**Partially.** The term is technically accurate but does not match the workshop/craft aesthetic established in NEXUS-CORE-ASPECTS.md. The existing canon uses textile metaphors (Thread, Loom, Tapestry, Weave) and mechanical metaphors (Cogs, Clicks, Forge-bench) — never abstract computer science terminology like "protocol" or "chain."

The one existing reference (`docs/mintlify/developer/specifications/ORCHESTRATOR-PROTOCOL.mdx:80` — "Maintains protocol chain integrity") uses it as a descriptive phrase, not a named concept.

### Alternative Names (Canon-Compatible)

| Candidate | Metaphor Source | Meaning |
|-----------|----------------|---------|
| **Warp** | Textile — the lengthwise threads on a loom that the weft weaves through | The structural framework of a workflow (the shape). Warp defines the topology; Weft (LOOM quality) weaves through it. Warp + Weft = fabric (Protocol Chain). |
| **Pattern Chain** | Textile + metalwork | A linked sequence of pattern pieces with embedded quality marks. More workshop-native than "Protocol Chain." |
| **Spindle** | Textile — the rod that holds thread under tension while spinning | The mechanism that holds workflow shape and quality together under controlled tension. |
| **Selvedge** | Textile — the self-finished edge of fabric that prevents unraveling | The quality boundary built into the fabric itself, not added after weaving. Captures the key insight of definition-time quality. |
| **Lattice** | Architecture/craft — a framework of crossed strips | The interwoven structure of workflow shape (MEOW) and quality gates (LOOM). |

### Recommendation

**"Warp"** is the strongest canon-compatible alternative. In weaving:
- The **warp** is the structural framework (MEOW shape)
- The **weft** is what weaves through it (LOOM quality gates)
- Together they produce **fabric** (the complete Protocol Chain)

This extends the existing textile metaphor naturally. A Tessera would define a "Warp pattern" — the structural template with embedded quality weft — that can be instantiated on a Loom as a working Tapestry.

However, if the team prefers the technical precision of "Protocol Chains" for developer-facing documentation while using workshop terms in conceptual docs, that split is consistent with CLEO's existing pattern (e.g., RCASD-IVTR+C is the technical name; LOOM is the conceptual name).

---

## 7. Implementation Roadmap

### Phase 1: Chain Definition Format (small)

- Define the `ChainShape` type system in TypeScript (linear, parallel fork, conditional branch, composed)
- Create a JSON Schema for Protocol Chain definitions
- Implement chain shape validation (well-formedness: no cycles, reachable end state)
- Store chain definitions in brain.db as Tessera records
- Map to existing domain: extend `pipeline` domain with `chain.*` operations

### Phase 2: Gate Contract Embedding (medium)

- Extend `StageDefinition` to support custom gate contracts (not just the fixed 6-gate chain)
- Implement `GateContract` type with per-stage prerequisites, transition conditions, artifact requirements
- Add `chain.validate` operation to `check` domain that statically verifies gate satisfiability
- Wire gate contracts into existing verification-gates middleware so they are enforced at runtime

### Phase 3: Chain Composition (medium)

- Implement chain composition operators (sequence, parallel, conditional)
- Add composition safety verification (composed chains maintain gate invariants)
- Create Tessera-to-Chain conversion: a Tessera definition produces a validated Protocol Chain
- Add `orchestrate.chain.plan` operation for pre-execution chain planning

### Phase 4: Runtime Execution (large)

- Extend wave computation engine to execute arbitrary chain shapes (not just linear pipeline)
- Implement chain-aware orchestrator that follows the chain topology for spawn ordering
- Add chain execution monitoring (which link is active, which gates have passed)
- Create chain execution history in Tome for post-mortem analysis

### Phase 5: Developer Experience (small)

- CLI commands for chain definition, validation, instantiation
- Chain visualization (ASCII DAG rendering of chain shape with gate annotations)
- Chain composition REPL for interactive chain building
- Integration with existing Tessera Pattern documentation format

---

## Summary

| Concept | What It Is | Current State | Gap |
|---------|-----------|---------------|-----|
| **MEOW** | Workflow shape / composable structure | Implicit (waves.ts, Tessera docs) | No declarative format, no composition |
| **LOOM** | Quality completion / gate correctness | Explicit (5 enforcement layers) | Runtime-only, no definition-time embedding |
| **the legacy pattern** | Anti-pattern of bolted-on quality | What CLEO partially still does | Gates are external to workflow definitions |
| **Protocol Chains** | MEOW + LOOM synthesized | 1 reference (chain integrity) | Full concept does not exist yet |

The synthesis target is clear: make quality gates **intrinsic to workflow definitions** so that a badly-defined workflow is a type error, not a runtime failure. This is what would make CLEO "better than the legacy pattern" — not just having gates, but having gates that are structurally guaranteed by the workflow definition itself.
