<!--
  RECONSTRUCTION NOTICE

  This document was reconstructed on 2026-04-09 after the original was
  lost (never committed to git, existed only as an untracked working file).

  Sections marked VERBATIM were captured word-for-word during the T377
  CleoOS Agentic Execution Layer session. Sections marked RECONSTRUCTED
  were rebuilt from the shipped implementation on main @ v2026.4.17, which
  is the ground truth for what the plan specified.

  Original: ~939 lines, dated 2026-04-08, status ACTIVE.
-->

# CLEO Autonomous Orchestration — CANONICAL ULTRAPLAN

**Version**: 1.0.0
**Status**: ACTIVE
**Date**: 2026-04-08
**Epic**: T377 — CleoOS Agentic Execution Layer

> This document is the single source of truth for the CleoOS v2 autonomous
> execution layer. Every subsystem, every wave, every decision traces back
> here. When in doubt, consult the ULTRAPLAN.

---

## 0. Identity

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

CleoOS is the full Agentic Development Environment built on top of
`@cleocode/core`. Where `@cleocode/core` is the kernel — tasks, sessions,
memory, orchestration, lifecycle — CleoOS is the complete operating system:
the runtime, the coordination layer, the deployment surface, and the
intelligence fabric that turns a solo developer and their AI agents into a
governed, continuous software development operation.

> One developer. Many agents. One operating system for the work.

CleoOS is **not** a replacement for CLEO. It is the name for what CLEO
becomes when its four canonical systems (BRAIN, LOOM, NEXUS, LAFS) are
fully realized with autonomous execution, multi-agent coordination, and
project lifecycle management from inception to maintenance.

The ULTRAPLAN governs the construction of this OS layer in ten waves,
targeting the T377 epic. It is empirical-first (L8): no wave is "done"
until its proof gate is green.

---

## 1. Locked Decisions

<!-- VERBATIM — captured by orchestrator during T377 session -->

| # | Decision | Rationale |
|---|----------|-----------|
| L1 | **Wrap Pi, do not fork** | Pi exports a full SDK (`AgentSession`, `ExtensionAPI`, events). `cleoos` is an ~80-line launcher importing from `@mariozechner/pi-coding-agent`. Zero fork burden. |
| L2 | **Package: `@cleocode/cleo-os`, brand: CleoOS** | Sibling to `@cleocode/cleo` in the monorepo at `packages/cleo-os/`. |
| L3 | **Model tiers: `low/mid/high`** | Every tier reference in every `.cant`, doc, and code path MUST use `low/mid/high`. Drafts that used `simple/mid/hard` are corrected. |
| L4 | **JIT context overflow: `escalate_tier`** | When an agent's declared `context_sources:` would exceed its tier token cap, the bridge bumps the tier (low→mid→high) until it fits. Fails only if `high` cannot fit. |
| L5 | **Mental model updates: async-write + validate-on-load** | Writes go to the BRAIN observation queue (fast, non-blocking). On every subsequent spawn the agent MUST re-evaluate and validate the mental model — don't trust, keep fresh. Mental models are **dynamic per project**. |
| L6 | **AGENTS.md chain: preserved, never ripped out** | The bridge appends to Pi's system prompt, it does not replace. `projectDir/AGENTS.md` → `~/.agents/AGENTS.md` → `CLEO-INJECTION.md` stays intact. |
| L7 | **CLEOOS-VISION.md rewrite: incremental, agent-driven, PR-validated** | Worker agents perform section rewrites; validation-lead gates each PR on compliance + continuity. Worker agents do the work; leads never execute. |
| L8 | **Empirical-first** | Every wave has a proof gate. No wave is "done" until its empirical test is green. |

---

## 2. Project Initialization & Discovery (Greenfield vs Brownfield)

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

CleoOS must bootstrap itself correctly whether it is entering a fresh
repository (greenfield) or an existing CLEO project (brownfield).

### 2.1 XDG Path Resolution

All CleoOS paths follow the XDG Base Directory Specification, resolved at
runtime by `packages/cleo-os/src/xdg.ts`:

```
~/.local/share/cleo/          ← XDG_DATA_HOME/cleo (or custom via env)
  extensions/                 ← compiled Pi extensions live here
  cant/                       ← global-tier .cant source tree
  worktrees/<projectHash>/    ← per-project git worktree roots (§14, resolved by cant/worktree.ts)

~/.config/cleo/               ← XDG_CONFIG_HOME/cleo
  auth/                       ← API key storage backend
```

The `resolveCleoOsPaths()` function returns a typed `CleoOsPaths` record
with six paths pre-resolved (`data`, `config`, `agentDir`, `extensions`,
`cant`, `auth`). `worktrees/` is resolved separately by
`packages/cant/src/worktree.ts` via `resolveWorktreeRoot()`. Every CleoOS
subsystem that needs a path MUST call these functions rather than
constructing paths by hand.

### 2.2 Greenfield Detection

A project is greenfield if:
- No `.cleo/` directory exists in the project tree
- `cleo init` has not been run

In greenfield mode, `postinstall.js` scaffolds the hub:
1. Creates `~/.local/share/cleo/` directory tree
2. Copies `cleo-cant-bridge.js` into `extensions/`
3. Scaffolds empty `.cant` tree under `~/.local/share/cleo/cant/`
4. Writes default `model-routing.cant`
5. Installs CleoOS skills via PiHarness registration

### 2.3 Brownfield Detection

A project is brownfield if `.cleo/` already exists. The launcher detects
this and skips the scaffold step, using the existing configuration. The
bridge still discovers `.cleo/cant/` files and compiles them at session
start.

### 2.4 Three-Tier CANT Resolution (Wave 5 target)

Wave 2 only scans the project tier (`<cwd>/.cleo/cant/`). Wave 5 adds
full three-tier resolution:

| Tier | Path |
|------|------|
| Global | `~/.local/share/cleo/cant/` |
| User | `~/.config/cleo/cant/` |
| Project | `<cwd>/.cleo/cant/` |

Project-tier declarations override user-tier, which override global-tier.

---

## 3. LAFS & CANT DSL Canonization

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

### 3.1 Canonical Sources

There are exactly two canonical DSL surfaces in CleoOS:

- **LAFS** (`@cleocode/lafs`): the envelope format for all agent-to-agent
  communication and structured dispatch. Every CLEO CLI response is a LAFS
  envelope. The `success` field is the canonical success signal.
- **CANT** (`@cleocode/cant`): the configuration-as-code DSL for declaring
  agents, teams, tools, lifecycle stages, and routing rules. `.cant` files
  are the single source of truth for agent behavior.

NEVER create parallel schemas, inline type definitions, or shadow types for
either surface. Import from `packages/contracts/src/` for LAFS types and
from `packages/cant/src/` for CANT types.

### 3.2 The Bridge Contract

The Bridge (`cleo-cant-bridge.ts`, Wave 2, ~360 LOC shipped):

When the orchestrator executes a CANT DSL instruction, it passes context
to the agent via Pi's `before_agent_start` event. When the agent acts, the
result returns as a LAFS envelope. The bridge evaluates the `success` field
against the CANT decision tree to programmatically determine the next
state. On LAFS error envelopes, CANT rules dictate recursive retry logic.

Bridge behavior (per L6 — append, never replace):
1. On `session_start`: discovers `.cleo/cant/` files, compiles bundle via
   `compileBundle()`, caches result as `bundlePrompt`.
2. On `before_agent_start`: appends `bundlePrompt` to Pi's system prompt.
   If the agent has a `mental_model:` CANT block, also fetches prior
   observations via `memoryFind` and prepends the validate-on-load block.
3. On `tool_call` (Edit/Write/Bash): enforces `permissions.files` ACL from
   the agent's compiled definition. Rejects calls that violate write globs.
4. Best-effort throughout: if `@cleocode/cant` is absent or `.cleo/cant`
   does not exist, the bridge is a silent no-op. NEVER crash Pi.

### 3.3 LAFS SSoT

`packages/lafs` is canonical. `@cleocode/lafs` and `lafs-core/napi` own
the contract. NEVER create parallel LAFS schemas, types, or validators.

---

## 4. Schema Directory Cleanup & Consolidation

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

The protocol `.cant` files that define the RCASD-IVTR+C lifecycle stages
live at:

```
packages/core/src/validation/protocols/cant/
  architecture-decision.cant
  artifact-publish.cant
  consensus.cant
  contribution.cant
  decomposition.cant
  implementation.cant
  provenance.cant
  release.cant
  research.cant
  specification.cant
  testing.cant
  validation.cant
```

Twelve canonical protocol files. These are the source of truth for CANT
protocol validation. A future cleanup wave (Wave 4) will lift these into
the CANT render pipeline so they can be round-tripped as `.md` via
`cant render --kind=protocol --to=md`.

**Rules:**
- Do NOT duplicate these files elsewhere in the monorepo.
- Do NOT create ad-hoc inline protocol definitions in TypeScript.
- Validation logic MUST import from these `.cant` files via the compiled
  bundle, not from hand-authored string constants.

---

## 5. RCASD-IVTR+C Lifecycle via JIT Agents

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

### 5.1 Lifecycle Model

The correct lifecycle acronym is **RCASD-IVTR+C**:
- **Planning phase**: Research → Consensus → Architecture-Decision →
  Specification → Decomposition
- **Execution phase**: Implementation → Validation → Testing → Release
- **Cross-cutting**: Contribution (attribution, provenance, history)

This maps directly to the three platform leads in `teams.cant`:
- `planning-lead` owns RCASD stages
- `engineering-lead` owns I (Implementation)
- `validation-lead` owns VTR stages

### 5.2 JIT Agent Dispatch

Agents are not pre-spawned. They are composed Just-In-Time at spawn time
by `packages/cant/src/composer.ts`. The composition step:

1. Loads the compiled `AgentDefinition` from the CANT bundle
2. Resolves `context_sources:` from BRAIN (via `BrainContextProvider`)
3. Loads the agent's mental model from BRAIN (if declared)
4. Enforces token budgets per tier, escalating if needed
5. Returns a `SpawnPayload` with a fully composed system prompt

The `orchestrate` dispatch domain (`packages/cleo/src/dispatch/domains/`)
is the entry point for agent dispatch. It calls `composeSpawnPayload()` and
hands the result to the Pi harness for execution.

### 5.3 Escalation Chain

When a context overflow occurs:
```
declared tier: low  →  escalate to mid  →  escalate to high  →  FAIL
```
Failure only occurs if `high` tier cannot fit the composed prompt. This
satisfies L4.

---

## 6. Pi Extension Surface (formerly "Autonomous Server Daemons")

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

An earlier draft of CleoOS v2 proposed autonomous server daemons — long-
running processes that would watch for events and spawn agents reactively.
This approach was abandoned. The pivot (CleoOS Pi Pivot, 2026-04-06) made
Pi extensions the canonical extension mechanism.

### 6.1 What Pi Extensions Are

Pi extensions are TypeScript modules loaded by Pi at startup via
`--extension <path>`. They receive an `ExtensionAPI` and `ExtensionContext`
and can register:
- `session_start` handlers (run once at session init)
- `before_agent_start` handlers (run before each agent spawn)
- `tool_call` hooks (intercept tool invocations)
- `/custom:command` slash commands

This is the complete extension surface. There are no brokers, no SSE
servers, no long-running daemons in the CleoOS extension model.

### 6.2 CleoOS Extensions (Wave 2 + Wave 7)

Two Pi extensions ship with CleoOS:

| Extension | File | Wave | Purpose |
|-----------|------|------|---------|
| CANT Bridge | `cleo-cant-bridge.ts` | 2 | Compiles `.cant` files, injects bundle prompt, enforces ACL, validates mental models |
| Chat Room | `cleo-chatroom.ts` | 7 | TUI panel for inter-agent messaging with tier-aware rendering |

Both are installed to `~/.local/share/cleo/extensions/` by the postinstall
script and loaded via `--extension <path>` args injected by `cli.ts`.

### 6.3 Future Extensions

The Pi extension API is the integration point for all future CleoOS
capabilities. Planned extensions beyond Wave 7:
- `cleo-patrol.ts` — background task staleness watcher
- `cleo-conduit.ts` — cross-session agent relay
- `cleo-nexus.ts` — cross-project coordination surface

---

## 7. The CleoOS 4-Layer Architecture

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

CleoOS operates as four stacked layers. Each layer consumes the one below
it and adds autonomous behavior.

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4 — Runtime                                              │
│  Pi Coding Agent + CleoOS extensions                           │
│  Autonomous task execution, multi-agent coordination           │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3 — Dispatch                                             │
│  @cleocode/cleo CLI (90+ commands)                             │
│  LAFS envelope I/O, domain routing, session management         │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2 — Bridge                                               │
│  cleo-cant-bridge.ts (Pi extension)                            │
│  Compiles CANT → system prompt injection, ACL enforcement      │
├─────────────────────────────────────────────────────────────────┤
│  Layer 1 — CANT Source Tree                                     │
│  .cleo/cant/ (project tier)                                    │
│  ~/.local/share/cleo/cant/ (global tier)                       │
│  Declarative agent/team/tool/routing definitions               │
└─────────────────────────────────────────────────────────────────┘
         ↓ consumes
┌─────────────────────────────────────────────────────────────────┐
│  @cleocode/core (kernel)                                        │
│  tasks · sessions · memory (BRAIN) · lifecycle · adapters      │
└─────────────────────────────────────────────────────────────────┘
```

### 7.1 Data Flow

```
Developer writes: .cleo/cant/agents/backend-dev.cant
         ↓
Layer 1: CANT source tree (raw .cant files)
         ↓  (session_start event)
Layer 2: Bridge compiles → AgentBundle { agents, teams, tools }
         ↓  (before_agent_start event)
Layer 3: Dispatch invokes composeSpawnPayload() with AgentDefinition
         ↓  (system prompt injection)
Layer 4: Pi spawns agent with composed prompt + mental model + ACL
```

### 7.2 Invariants

- Layer boundaries are enforced at the package level. `cant` does not
  import from `cleo`. `cleo-os` does not import from `core` at build time
  (lazy imports only at runtime to avoid circular deps).
- The bridge is always append-only (L6). No layer may replace Pi's system
  prompt.
- LAFS envelopes cross the Layer 3/4 boundary exclusively. Agents produce
  structured LAFS output; the dispatch layer interprets `success`.

---

## 8. CANT Grammar Additions (Wave 0)

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

Wave 0 extended the CANT grammar with constructs required for the CleoOS
v2 autonomous layer. All additions are in `crates/cant-core/src/dsl/`.

### 8.1 New DocumentKind Variants

The `DocumentKind` enum in `crates/cant-core/src/dsl/ast.rs` gained four
new variants (13 total after Wave 0):

| Variant | `kind:` value | Purpose |
|---------|---------------|---------|
| `Team` | `team` | 3-tier multi-agent team declarations (§10) |
| `Tool` | `tool` | LLM-callable tool beyond built-in dispatcher tools |
| `ModelRouting` | `model-routing` | Tier matrix driving the 3-layer router (§11) |
| `MentalModel` | `mental-model` | Per-agent persistent model schema (§12) |

Pre-existing variants: `Agent`, `Skill`, `Hook`, `Workflow`, `Pipeline`,
`Config`, `Message`, `Protocol`, `Lifecycle`.

### 8.2 New Agent Properties

The `AgentDef` struct gained three new property blocks:

**`context_sources:`** — declares BRAIN queries to run at spawn time
```cant
agent backend-dev:
  tier: mid
  context_sources:
    - source: patterns
      query: "typescript api patterns"
      max_entries: 5
    - source: decisions
      query: "database schema decisions"
      max_entries: 3
  on_overflow: escalate_tier
```

**`mental_model:`** — configures the agent's persistent BRAIN namespace
```cant
agent backend-dev:
  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true
```

**`permissions.files:`** — path-scoped ACL enforced by the bridge at
runtime (T423). `write: []` means no writes (default-deny).
```cant
agent backend-dev:
  permissions:
    files:
      write: ["packages/cleo/**", "crates/**"]
      read:  ["**/*"]
      delete: ["packages/cleo/**"]
```

### 8.3 New `team` Block

Declares a multi-agent team with orchestrator, leads, and workers:
```cant
team platform:
  orchestrator: cleo-prime
  enforcement: strict
  consult-when: "cross-boundary or HITL governance"
  stages: [research, consensus, ...]
  leads:
    planning: planning-lead
    engineering: engineering-lead
    validation: validation-lead
  workers:
    planning: [product-manager, ux-researcher, spec-writer]
    engineering: [backend-dev, frontend-dev, platform-engineer]
    validation: [qa-engineer, security-reviewer, release-manager]
```

### 8.4 New `tool` Block

Declares an LLM-callable tool for lead or orchestrator agents:
```cant
tool dispatch_worker:
  description: "Spawn a worker subagent with a task assignment"
  tier: lead
  input:
    agent: "Name of the worker agent to spawn"
    task_id: "Task ID to assign"
```

### 8.5 Wave 0 Lint Rules

Seven new validation rules in `crates/cant-core/src/validate/hierarchy.rs`:

| Rule | Check |
|------|-------|
| `TEAM-001` | Team MUST declare an `orchestrator:` |
| `TEAM-002` | Lead-role agents MUST NOT declare `Edit`/`Write`/`Bash` in `tools.core`; teams with leads MUST declare `consult-when:` and `stages:` |
| `TEAM-003` | Worker-role agents MUST declare `parent:` |
| `TIER-001` | Agent `tier:` MUST be one of `low`, `mid`, `high` (per L3) |
| `TIER-002` | `mental_model.max_tokens` MUST be ≤ tier token cap |
| `JIT-001` | `context_sources:` MUST declare `on_overflow:` (per L4) |
| `MM-001` | `mental_model:` MUST declare `scope:` (per L5) |
| `MM-002` | `mental_model.on_load.validate` MUST be `true` (per L5) |

---

## 9. The JIT Agent System

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

The JIT (Just-In-Time) Agent System is the core of CleoOS autonomous
execution. Agents are not pre-instantiated or kept alive between tasks.
Each spawn is a fresh composition event that pulls exactly the context
the agent needs, within its tier budget, at the moment of spawn.

### 9.1 `context_sources:` Block

The `context_sources:` block in a CANT agent definition declares which BRAIN
categories to query at spawn time and how many entries to retrieve:

```cant
agent backend-dev:
  tier: mid
  context_sources:
    - source: patterns
      query: "typescript backend api patterns"
      max_entries: 5
    - source: decisions
      query: "architectural decisions affecting this agent"
      max_entries: 3
    - source: learnings
      query: "past mistakes and their fixes"
      max_entries: 2
  on_overflow: escalate_tier
```

The `on_overflow:` policy is required (JIT-001). The only supported value
in Wave 5 is `escalate_tier`, which triggers the tier escalation logic (L4).

Context sources are resolved by `BrainContextProvider`
(`packages/cant/src/context-provider-brain.ts`), which lazily imports
`memoryFind` from `@cleocode/core/internal` to avoid circular build-time
dependencies.

### 9.2 Domain Ownership: `permissions.files:`

Each worker agent declares the file globs it is permitted to write. This is
the domain ownership contract. The bridge enforces it at `tool_call` time
by checking the target path of every `Edit`, `Write`, and `Bash` invocation
against the agent's compiled `permissions.files.write` glob list.

**Security rules:**
- An **empty `write` array means no writes are allowed** (default-deny).
- An absent `write` field (`undefined`) means unrestricted (no ACL declared).
- `read` and `delete` are enforced analogously, with `read` defaulting to
  unrestricted.

The ACL check uses glob-to-regexp conversion that supports `**` (any path
sequence), `*` (single segment), and `?` (single character).

### 9.3 Canonical Agent Definition Example

A fully-featured CANT agent definition demonstrating all Wave 5+ blocks:

```cant
---
kind: agent
version: "1"
---

agent backend-dev:
  role: worker
  parent: engineering-lead
  tier: mid
  description: "APIs, databases, infrastructure, background jobs, third-party integrations"
  consult-when: "APIs, databases, infrastructure, background jobs"

  context_sources:
    - source: patterns
      query: "typescript api architecture patterns"
      max_entries: 5
    - source: decisions
      query: "database and infrastructure decisions"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      write: ["packages/cleo/**", "packages/core/**", "crates/**"]
      read:  ["**/*"]
      delete: ["packages/cleo/**"]

  skills:
    - ct-typescript
    - ct-drizzle-orm
    - ct-testing

  tools:
    core: [Read, Edit, Write, Bash, Glob, Grep]
    dispatch: []
```

### 9.4 TIER_CAPS Table

Token budget caps per tier, drawn from `TIER_CAPS` in
`packages/cant/src/composer.ts` and validated in
`crates/cant-core/src/types.rs`:

| Tier | `systemPrompt` | `mentalModel` | `contextSources` |
|------|---------------|---------------|------------------|
| `low` | 4,000 | 0 | 0 |
| `mid` | 12,000 | 1,000 | 4,000 |
| `high` | 32,000 | 2,000 | 12,000 |

`low` tier agents receive no mental model injection and no context sources —
they are stateless, fast, cheap, and used only for simple transformations.

### 9.5 Composition Algorithm

`composeSpawnPayload()` in `packages/cant/src/composer.ts`:

```
1. Start at declared tier
2. contextBudget = TIER_CAPS[tier].contextSources
3. For each context_source:
     slice = queryContext(source, query, contextBudget / sources.length)
     accumulate slices
4. Load mental model (if declared), capped at TIER_CAPS[tier].mentalModel
5. Compose system prompt = base prompt + mental model block + context slices
6. Estimate totalTokens
7. While totalTokens > TIER_CAPS[effectiveTier].systemPrompt:
     nextTier = escalateTier(effectiveTier)
     if nextTier == null: throw EscalationFailed
     effectiveTier = nextTier
8. Return SpawnPayload { agentName, resolvedTier, escalated, systemPrompt, ... }
```

The `escalated` field on `SpawnPayload` lets callers (and logs) know that
the budget overflow required a tier bump.

### 9.6 BRAIN Context Provider

`BrainContextProvider` (`packages/cant/src/context-provider-brain.ts`)
implements the `ContextProvider` interface. It uses a lazy dynamic import
to load `memoryFind` from `@cleocode/core/internal` at runtime, avoiding
compile-time circular dependencies between `cant` and `core` in the
monorepo build order.

The `agent` filter parameter (T417/T418) on `memoryFind` scopes mental
model observations to the specific agent being spawned, preventing
cross-contamination between different agents sharing the same BRAIN.

---

## 10. The 3-Tier Multi-Agent Hierarchy

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

CleoOS enforces a strict 3-tier role hierarchy. Every agent in a team MUST
be one of: **orchestrator**, **lead**, or **worker**. These roles carry
distinct permissions and behavioral contracts.

### 10.1 Role Contract Table

| Role | Tier | Can Execute | Can Dispatch | Owns |
|------|------|-------------|--------------|------|
| Orchestrator | `high` | Read-only | All tiers | Cross-team coordination, HITL escalation |
| Lead | `mid` | Read-only (`Read`, `Grep`, `Glob`) | Workers in its group | Stage strategy, task decomposition |
| Worker | `low`–`mid` | Full (`Edit`, `Write`, `Bash`, etc.) | None | File writes within declared globs |

**Critical invariant**: Leads MUST NOT hold `Edit`, `Write`, or `Bash` in
their `tools.core` list. This is enforced by TEAM-002 at compile time and
by the bridge `tool_call` hook at runtime. The separation is structural:
leads decide and dispatch; workers execute.

### 10.2 Canonical Team Block

The platform team seed at `.cleo/teams.cant` is the canonical example:

```cant
team platform:
  name: Platform Team
  orchestrator: cleo-prime
  enforcement: strict
  consult-when: "Orchestrator-level escalation when a request crosses team boundaries or requires human-in-the-loop governance"
  stages: [research, consensus, architecture-decision, specification, decomposition, implementation, validation, testing, release]

  leads:
    planning: planning-lead
    engineering: engineering-lead
    validation: validation-lead

  workers:
    planning:    [product-manager, ux-researcher, spec-writer]
    engineering: [backend-dev, frontend-dev, platform-engineer]
    validation:  [qa-engineer, security-reviewer, release-manager]
```

Three leads map to the RCASD-IVTR+C lifecycle phases:
- `planning-lead` → Research, Consensus, Architecture-Decision, Specification, Decomposition
- `engineering-lead` → Implementation
- `validation-lead` → Validation, Testing, Release

### 10.3 Enforcement Points

Enforcement is layered across compile time, spawn time, and runtime:

| Point | Mechanism | Catches |
|-------|-----------|---------|
| Compile (`cant validate`) | TEAM-001/002/003, TIER-001/002, JIT-001, MM-001/002 lint rules | Missing orchestrator, lead holding write tools, orphan workers, invalid tiers |
| Spawn (`composeSpawnPayload`) | Tier cap check, `escalate_tier` | Context overflow |
| Runtime (bridge `tool_call` hook) | `permissions.files` glob check | Unauthorized file writes by workers |

The `enforcement: strict` flag on a team block means runtime violations
are fatal (the tool call is rejected with an ACL error). Without
`enforcement: strict`, violations are logged but not blocked (warn mode).

### 10.4 Lead Agent Template

Lead agents follow this canonical pattern (never hold execution tools):

```cant
agent engineering-lead:
  role: lead
  description: "Decides HOW to build — owns implementation strategy, code review, and refactoring direction. Dispatches to engineering workers. MUST NOT execute Edit/Write/Bash directly."
  consult-when: "Deciding HOW to build — implementation, code writing, refactoring, API design"
  stages: [implementation]
  workers:
    - backend-dev
    - frontend-dev
    - platform-engineer
```

Tools available to leads: `Read`, `Grep`, `Glob`, `dispatch_worker`,
`report_to_orchestrator`. No `Edit`, `Write`, `Bash`.

### 10.5 Orchestrator→Lead→Worker Dispatch Chain

```
Orchestrator (high)
  reads task from CLEO, decides which lead owns it
  dispatches via dispatch_worker tool
    ↓
  Lead (mid)
    reads context, decomposes into sub-tasks
    dispatches each sub-task to appropriate worker
      ↓
      Worker (low/mid)
        executes: reads files, edits code, runs tests
        writes LAFS envelope back to lead
      ↑
    Lead aggregates results, validates, reports to orchestrator
  ↑
Orchestrator marks task complete, runs cleo complete <id>
```

---

## 11. The Model Router (3-Layer)

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

The model router lives in `crates/cant-router/`. It is a pure Rust crate
with no external I/O — it classifies a prompt, selects a model, and logs
the observation. The actual model invocation is the bridge's job.

### 11.1 Layer 1 — Classifier

`crates/cant-router/src/classifier.rs` implements a linear weighted
classifier over five heuristic features (ULTRAPLAN §11.1):

```
score = 0.15 × token_count_normalized
      + 0.25 × syntactic_complexity
      + 0.30 × reasoning_depth
      + 0.20 × domain_specificity
      + 0.10 × touches_files_count
```

Threshold mapping:
- `score ≥ 0.75` → `High` tier
- `0.35 ≤ score < 0.75` → `Mid` tier
- `score < 0.35` → `Low` tier

The classifier is deterministic and requires no training data — it is the
Wave 6 baseline. A learned reranker will replace it in a future wave once
the pipeline logger has sufficient real-traffic observations.

### 11.2 Layer 2 — Router (Tier Matrix)

`crates/cant-router/src/router.rs` maps a `Classification` to a
`ModelSelection` via the v1 tier matrix:

| Tier | Primary | Fallback Chain | Cost Cap | Latency Budget |
|------|---------|----------------|----------|----------------|
| High | `claude-opus-4-6` | `claude-sonnet-4-6`, `kimi-k2.5` | $2.00 | 60,000 ms |
| Mid | `claude-sonnet-4-6` | `kimi-k2.5`, `claude-haiku-4-5` | $0.50 | 30,000 ms |
| Low | `claude-haiku-4-5` | `kimi-k2.5` | $0.10 | 10,000 ms |

The tier matrix is a Rust constant for Wave 6. Future waves can load it
from a `model-routing.cant` config file.

### 11.3 Layer 3 — Pipeline Logger

`crates/cant-router/src/pipeline.rs` records `RoutingObservation`s to an
in-memory `ObservationLog` (guarded by `Mutex<Vec>`). Wave 6 scope is
in-memory only. A future wave will persist observations to
`brain.db:routing_observations` for reranker training.

### 11.4 Router Usage

```rust
use cant_router::{classify, route, pipeline};

let features = PromptFeatures { token_count: 120, reasoning_depth: 3, ... };
let classification = classify(features.clone());
let selection = route(classification.clone());
pipeline::record(RoutingObservation { features, classification, selection, timestamp });
```

The three-function pipeline keeps each layer independently testable and
replaceable without touching the others.

### 11.5 Empirical Gate (Wave 6)

50-prompt labeled corpus with ≥80% agreement between router output and
human-assigned tiers. 3 production tasks correctly routed end-to-end via
the bridge.

---

## 12. Mental Models (Dynamic Per Project, Validate-on-Load)

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

Mental models are the memory layer of JIT agents. They compound
intelligence over time by recording patterns, decisions, and outcomes
across sessions for a specific agent within a specific project.

### 12.1 Core Properties (from L5)

- **Dynamic per project**: mental models are scoped to a `(agentName, projectHash)` pair. The same agent working on two projects has two independent mental models.
- **Async-write**: after each agent session, observations are written to the BRAIN observation queue (non-blocking). The spawning agent does not wait.
- **Validate-on-load**: on every subsequent spawn, the bridge injects the mental model with a mandatory validation preamble. The agent MUST re-evaluate each prior observation against current project state before acting.
- **Bounded growth**: `max_tokens` in the `mental_model:` block caps the model size. Oldest/lowest-reinforcement entries are dropped on overflow.
- **Consolidation**: periodic consolidation merges similar observations. The `lastConsolidated` timestamp in `MentalModelSlice` tracks when this last occurred.

### 12.2 Validate-on-Load Injection

The bridge injects this preamble (exported as `VALIDATE_ON_LOAD_PREAMBLE`
from `cleo-cant-bridge.ts`) before the agent's mental model observations:

```
===== MENTAL MODEL (validate-on-load) =====
These are your prior observations, patterns, and learnings for this project.
Before acting, you MUST re-evaluate each entry against current project state.
If an entry is stale, note it and proceed with fresh understanding.

// Agent: backend-dev
1. [obs-abc123] (pattern) [2026-04-05]: Prefer drizzle-orm v1.0.0-beta for all schema operations
2. [obs-def456] (decision) [2026-04-06]: Use ESM imports with .js extensions in all packages
...
===== END MENTAL MODEL =====
```

### 12.3 BRAIN Namespace

Mental model observations are stored in `brain.db` under the `observations`
table, filtered by `agent` field. The `agent` filter on `memoryFind` scopes
retrieval to the specific spawning agent (T417/T418).

### 12.4 Observation Lifecycle

| Event | Trigger | Action |
|-------|---------|--------|
| `task_completed` | Agent marks task done | Write observation to BRAIN queue |
| `bug_fixed` | Agent resolves a defect | Write observation with fix pattern |
| `pattern_observed` | Agent identifies a recurring pattern | Write observation |
| `decision_made` | Agent records an architectural choice | Write observation |

Observations carry a `reinforceCount` field. Observations that are re-
confirmed across multiple sessions accumulate higher reinforce counts and
are prioritized in token-budget trimming.

### 12.5 TIER-002 Enforcement

`max_tokens` in `mental_model:` MUST be ≤ the tier's mental model cap:
- `low`: 0 (no mental model)
- `mid`: ≤ 1,000 tokens
- `high`: ≤ 2,000 tokens

Violations are caught at `cant validate` time (TIER-002 rule).

---

## 13. The Chat Room (Coordination Primitive)

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

The Chat Room (`cleo-chatroom.ts`) is a Pi extension that surfaces
inter-agent traffic as a TUI panel. It is the coordination primitive for
multi-agent conversations in Wave 7.

### 13.1 Architecture

The Chat Room is a Pi extension — it registers four LLM-callable tools and
a TUI panel widget. It is NOT a separate service, message broker, or SSE
endpoint. All message routing happens within a single Pi session.

### 13.2 Four Coordination Tools

| Tool | Direction | Used By |
|------|-----------|---------|
| `send_to_lead` | Worker → Lead | Worker reporting status or asking for clarification |
| `broadcast_to_team` | Lead → All workers in group | Lead distributing task assignments |
| `report_to_orchestrator` | Lead → Orchestrator | Lead escalating or summarizing results |
| `query_peer` | Worker → Worker (same group) | Worker querying a peer for domain knowledge |

Each tool appends a structured JSONL entry to the Pi session's message log.

### 13.3 TUI Rendering

The chat panel renders messages with tier-aware prefixes and (when ANSI is
available) color coding:

```
[O] cleo-prime: "Assigning T401 to engineering-lead: implement the CANT bridge ACL"
[L] engineering-lead: "Dispatching to backend-dev and platform-engineer"
[W] backend-dev: "Starting work on T423: PathPermissions struct"
[W] platform-engineer: "Starting work on T424: bridge ACL hook"
[W] backend-dev: "T423 complete. PathPermissions in ast.rs + composer.ts"
[L] engineering-lead: "Merging T423 + T424 results. Reporting to orchestrator."
```

Prefix key: `[O]` = Orchestrator, `[L]` = Lead, `[W]` = Worker.

### 13.4 Message Storage

Messages are appended to the Pi session's JSONL message log file, not to
`brain.db`. They are ephemeral within a session. A future wave may persist
cross-session coordination logs to `brain.db:agent_messages`.

---

## 14. Worktree Isolation (Multi-Agent Safety)

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

When multiple workers execute in parallel on the same epic, worktree
isolation prevents filesystem conflicts. Each spawned worker gets its own
git worktree so file edits do not collide.

### 14.1 XDG Path Structure

```
~/.local/share/cleo/worktrees/<projectHash>/
  <taskId>/          ← one directory per spawned worker
    (full git worktree with cleo/<taskId>-<shortId> branch checked out)
```

The `projectHash` scopes worktrees per project so two simultaneous projects
never share a worktree directory. `resolveWorktreeRoot()` in
`packages/cant/src/worktree.ts` computes this path from `WorktreeConfig`.

### 14.2 WorktreeHandle Contract (ADR-041)

`createWorktree()` returns a `WorktreeHandle`:

```typescript
interface WorktreeHandle {
  path: string;       // absolute path to worktree directory
  branch: string;     // "cleo/<taskId>-<shortId>"
  baseRef: string;    // the ref it was branched from
  taskId: string;
  projectHash: string; // for CLEO_PROJECT_HASH env var in spawned process
  cleanup(deleteBranch?: boolean): void;
}
```

ADR-041 replaced the `isolate: boolean` flag in `SpawnOptions` with
`worktree: WorktreeHandle`. The boolean was a dead flag — it expressed
intent without supplying the cwd, env vars, or DB path redirects needed
to act on that intent.

### 14.3 Merge Policy (ff-only)

After a worker completes its task, `mergeWorktree()` in `worktree.ts`
performs a fast-forward merge back to the base branch:

```
git merge --ff-only cleo/<taskId>-<shortId>
```

If the ff-merge fails (diverged history, conflict), the worktree is
**retained** for forensic inspection rather than deleted. This is the
"forensic retain on failure" policy. The orchestrator is notified of the
merge failure and may escalate to HITL.

### 14.4 Reasons for Worktree Creation

The `reason` field on `WorktreeRequest` communicates intent:

| Value | Meaning |
|-------|---------|
| `subagent` | Spawning a worker for a task |
| `experiment` | Speculative exploration (may be discarded) |
| `parallel-wave` | Multiple workers on the same epic in a wave |

### 14.5 DB Path Isolation

Spawned workers must not resolve `.cleo/tasks.db` against the main repo.
The `CLEO_PROJECT_HASH` environment variable, set from
`WorktreeHandle.projectHash`, ensures path resolvers in the worker process
target the worktree's `.cleo/` directory, not the parent repo's.

---

## 15. `cleoos` Launcher & Package Structure

<!-- VERBATIM — captured by orchestrator during T377 session -->

### 15.1 Package layout

```
packages/cleo-os/
├── package.json              # deps: @cleocode/cleo, @mariozechner/pi-coding-agent
├── src/
│   ├── cli.ts                # ~80 LOC launcher
│   ├── xdg.ts                # XDG path resolver
│   ├── keystore.ts           # API key management
│   └── postinstall.ts        # scaffold hub, install bridge
├── extensions/
│   ├── cleo-cant-bridge.ts   # the bridge (Layer 3)
│   └── cleo-chatroom.ts      # chat room UI
├── test/
│   └── empirical/            # see §18
└── README.md
```

### 15.2 Launcher sketch

```ts
#!/usr/bin/env node
import { AgentSession, FileAuthStorageBackend } from "@mariozechner/pi-coding-agent";
import { resolveCleoOsPaths } from "./xdg.js";
import { join } from "node:path";

const paths = resolveCleoOsPaths();
const auth = new FileAuthStorageBackend({ dir: paths.auth });
const bridgePath   = join(paths.extensions, "cleo-cant-bridge.js");
const chatroomPath = join(paths.extensions, "cleo-chatroom.js");

const session = new AgentSession({
  cwd: process.cwd(),
  agentDir: paths.agentDir,
  authStorage: auth,
  additionalExtensionPaths: [bridgePath, chatroomPath],
});

await session.run();
```

### 15.3 Install UX

```
$ npm i -g @cleocode/cleo-os
# postinstall:
#   - resolves XDG paths
#   - creates ~/.local/share/cleo/ hub
#   - copies bridge + chatroom extensions
#   - scaffolds empty .cant tree
#   - installs all CleoOS skills via PiHarness
#   - writes default model-routing.cant

$ cleoos                          # batteries-included
$ cleo                            # raw CLI (unchanged)
$ pi                              # raw Pi (unchanged)
```

Three binaries, three audiences, one shared core.

---

## 16. The 6 Pillars → CleoOS Subsystems

<!-- VERBATIM — captured by orchestrator during T377 session -->

| Pillar | CleoOS Subsystem | Section |
|--------|------------------|---------|
| **Team Leads and Workers (3-tier)** | `kind: team` CANT + bridge enforcement + Lead tool blocking | §10 |
| **Expertise and Specialization** | JIT agent composer with `context_sources:` | §9 |
| **Agent Memory (mental models)** | Per-agent BRAIN namespace + reinforcement loop + validate-on-load | §12 |
| **Domain Ownership** | `permissions.files: write[glob]` + runtime hook block | §9.2, §10 |
| **Chat Room Interface** | `cleo-chatroom.ts` Pi extension | §13 |
| **Configuration-Driven Harness** | The CANT source tree + `cleo-os.config.cant` | §7 (Layer 2) |

Every pillar is buildable on top of primitives that either already ship (PiHarness, BRAIN, CANT parser) or are in Waves 0-2. **None require fictional engines, brokers, or new transports.**

---

## 17. Wave-by-Wave Build Plan

<!-- VERBATIM — captured by orchestrator during T377 session -->

Every wave has: Deliverables · Empirical Gate (L8) · Owner Role · Dispatch chain.

| Wave | Title | Owner Role | Deliverables | Empirical Gate |
|------|-------|-----------|--------------|----------------|
| 0 | Grammar Additions | engineering-lead → backend-dev | New DocumentKinds + team/tool/context_sources/mental_model parsers + lint rules | `cant validate` passes on cleo-subagent.cant + 3 fixtures; CI regression gate |
| 1 | Render Pipeline | backend-dev | `cant render --kind=protocol --to=md` round-trips | All 12 protocol `.cant` → `.md` byte-identical to committed |
| 2 | Bridge MVP | engineering-lead → backend-dev | `compileBundle()` + `cleo-cant-bridge.ts` (~150 LOC), append-only injection | Bridge installed in Pi; 5 hand-authored prompts confirm both CleoOS persona AND AGENTS.md present |
| 3 | `cleoos` Launcher | backend-dev | `packages/cleo-os/` package, postinstall, launcher | Clean container: `npm i -g`, `cleoos`, first task completes |
| 4 | Lifecycle + Protocol Lift | validation-lead → backend-dev + qa-engineer | Convert `lifecycle/stages.ts` + 12 `protocols-markdown/*.md` to `.cant`; codegen TS const | CI diff gate: rendered MD matches committed; `cleo lifecycle status` output unchanged |
| 5 | JIT Agent Composer | engineering-lead → backend-dev | `context_sources:` resolver, BRAIN queries, token budgeting, `escalate_tier` | Spawn same agent twice; verify 2nd spawn injects ≥1 pattern from 1st |
| 6 | Model Router v1 | backend-dev + qa-engineer | `cant-router` Rust crate, classifier, router, pipeline logger | 50-prompt labeled corpus ≥80% agreement; 3 production tasks correctly routed |
| 7 | 3-Tier Hierarchy + Chat Room | engineering-lead → frontend-dev + backend-dev | `kind: team` enforcement, Lead tool blocking, `cleo-chatroom.ts` | Orchestrator→Lead→Worker chain on real task; Lead `Edit` attempt blocked; chat room renders all three |
| 8 | Mental Models | backend-dev | Per-agent BRAIN namespace, async reinforcement, validate-on-load prefix, consolidation | Run agent on 5 sequential tasks; snapshot mental model each time; verify bounded growth + pattern reuse + validation logs |
| 9 | Worktree Isolation | engineering-lead → backend-dev | `Harness.createWorktree`, `SubagentSpawnOptions.worktree`, merge policy | Spawn 3 parallel workers on same epic; verify isolation + ff-merge success + retain on failure |
| 10 | CLEOOS-VISION.md Rewrite | validation-lead → technical-writer + multi-worker | Incremental per-section PRs; dual validation | Doc-validator passes; every section maps to a shipped wave |

**Crucial safety net**: Waves 0-3 ship a working `cleoos` binary. Even if 4-10 slip, you have a batteries-included wrapped Pi launcher. That's the minimum viable deliverable.

---

## 18. Empirical Validation Scaffold

<!-- RECONSTRUCTED from implementation on main @ v2026.4.17 -->

Per L8 (empirical-first), every wave has a proof gate. The empirical tests
live in `packages/cleo-os/test/empirical/`. As of Wave 9, four test suites
have shipped:

```
packages/cleo-os/test/empirical/
  CLEAN-INSTALL.md            # manual clean-install checklist (Wave 3 gate)
  wave-3-launcher.test.ts     # Wave 3: launcher binary smoke test
  wave-7-chatroom.test.ts     # Wave 7: chat room TUI rendering
  wave-7-hierarchy.test.ts    # Wave 7: 3-tier enforcement (Lead Edit blocked)
  wave-acl-paths.test.ts      # Wave 9+: ACL path permission enforcement
```

### 18.1 Test Conventions

All empirical tests use Vitest (`pnpm run test`). They are integration
tests — they exercise the shipped Pi extensions against real (or
realistically mocked) data. They MUST NOT be flaky; if a test requires
network access, it must be gated by an environment variable.

### 18.2 Per-Wave Gates Summary

| Wave | Gate File | What It Proves |
|------|-----------|----------------|
| 0 | (CI via `cargo test`) | `cant validate` passes on new grammar fixtures |
| 1 | (CI via `cargo test`) | Protocol `.cant` → `.md` round-trips byte-identical |
| 2 | (manual via 5 prompts) | Bridge appends bundle + AGENTS.md present in prompt |
| 3 | `wave-3-launcher.test.ts` + `CLEAN-INSTALL.md` | `cleoos` binary launches and first task completes |
| 4 | (CI diff gate) | Rendered `.md` matches committed; lifecycle CLI unchanged |
| 5 | (`pnpm run test` + BRAIN integration) | 2nd spawn injects ≥1 pattern from 1st session |
| 6 | (`cargo test` + 50-prompt corpus) | ≥80% classifier agreement; 3 tasks correctly routed |
| 7 | `wave-7-hierarchy.test.ts` + `wave-7-chatroom.test.ts` | Lead Edit blocked; chat room renders all 3 tiers |
| 8 | (BRAIN integration, 5 tasks) | Bounded growth + pattern reuse + validation log entries |
| 9 | `wave-acl-paths.test.ts` + 3 parallel workers | Isolation + ff-merge + forensic retain on failure |
| 10 | (doc-validator + section mapping) | Every VISION.md section maps to a shipped wave |

### 18.3 Running Gates

```bash
# TypeScript empirical tests
pnpm run test --filter @cleocode/cleo-os

# Rust empirical tests (cant-core, cant-router)
cargo test -p cant-core
cargo test -p cant-router

# Full quality gates (MUST pass before any wave is marked done)
pnpm biome check --write .
pnpm run build
pnpm run test
git diff --stat HEAD
```

No wave is complete until all four quality gates and its empirical gate
are green. This is non-negotiable (L8).

---

## 19. CLEOOS-VISION.md Migration (Incremental, Per L7)

<!-- RECONSTRUCTED from session context — sections 19.1-19.4 were read
     verbatim during the T310/T311 orchestration session on 2026-04-08 -->

### 19.1 Strategy

CLEOOS-VISION.md is rewritten **section by section** via agent-driven PRs.
Worker agents perform rewrites. validation-lead gates each PR on:

- **Compliance check**: does the rewrite reflect the canonical plan in this ultraplan?
- **Continuity check**: does it preserve the still-valid content from the original doc? (See audit in §19.3.)

### 19.2 Ownership

- **validation-lead** owns the PR train
- **technical-writer** (worker) drafts section rewrites
- **qa-engineer** (worker) runs doc-validator
- **cleo-prime** has final approval for cross-section consistency

### 19.3 Section audit

| Section | State | Action | Sub-wave |
|---------|-------|--------|----------|
| §1 What CleoOS Is | Still valid | Minor update: add Pi wrapper framing | 10a |
| §2 Kernel Relationship | Still valid | Keep diagram, update kernel version | 10a |
| §3 Why CleoOS | Still valid | No change needed | — |
| §4.1 Autonomous Runtime | Speculative | Rewrite to match shipped waves | 10b |
| §4.2 Conduit Protocol | **Stale** | Rewrite: remove Rust broker, add 4-shell model | 10b |
| §4.3 Provider Ecosystem | **Stale** | Remove MCP, add Pi extension model | 10b |
| §4.4 Project Lifecycle | Still valid | Minor update | 10a |
| §4.5 Brain Intelligence | Mostly valid | Update shipped items list | 10a |
| §4.6 Nexus Network | Still valid (deferred) | Keep Phase 3 deferral note | — |
| §5 Architecture Layers | **Stale** | Add conduit.db, signaldock.db to store layer diagram | 10c |
| §6 Vision Timeline | **Stale** | Rewrite to match shipped waves + current version | 10c |
| §7 Design Principles | Still valid | No change needed | — |
| §8 What CleoOS Is Not | Mostly valid | Add "not a fork of Pi" | 10a |
| §9 Operating Metaphor | Still valid | No change needed | — |

### 19.4 Immediate partial update (this turn)

The following corrections are safe to apply NOW without a full rewrite wave:

1. §4.3 Provider Ecosystem: remove "any tool that can speak MCP" — per
   ADR-035 §D4, MCP is not first-class in CleoOS. Replace with "any tool
   that implements the Pi ExtensionAPI or the CLEOProviderAdapter interface."
2. §5 Architecture Layers diagram: add `conduit.db` and `signaldock.db`
   to the SQLite store layer (currently shows only 3 DBs; canon is 5 per
   ADR-036).
3. §6 Vision Timeline: update `@cleocode/core` version from v2026.3.72 to
   current shipped version. Add brain automation, conduit/signaldock split,
   and backup portability to the "What Exists Now" section.

These corrections do NOT require the full agent-driven PR train from L7.
They are factual updates to stale data, not narrative rewrites.

---

## 20. Handoff Protocol

<!-- RECONSTRUCTED from session context — sections 20.1-20.4 were read
     verbatim during the T310/T311 orchestration session on 2026-04-08 -->

### 20.1 Current state

- CleoOS v2 is a 10-wave build plan governed by this ULTRAPLAN
- Waves 0-3 ship the minimum viable deliverable: a working `cleoos` binary
- Waves 4-10 extend the autonomous execution capabilities
- Each wave follows RCASD-IVTR+C with empirical gates (L8)
- The bridge (`cleo-cant-bridge.ts`) is the single integration point

### 20.2 Handoff artifacts produced this turn

| Artifact | Path | Status |
|----------|------|--------|
| ULTRAPLAN | `docs/plans/CLEO-ULTRAPLAN.md` | This document |
| Execution log | `docs/plans/cleoos-v2-execution-log.md` | Per-session ship log |
| ADR-035 | `.cleo/adrs/ADR-035-pi-v2-v3-harness.md` | Accepted |
| ADR-041 | `.cleo/adrs/ADR-041-worktree-handle-spawn-contract.md` | Accepted |
| teams.cant | `.cleo/teams.cant` | Canonical team definition |
| 12 protocol .cant files | `packages/core/src/validation/protocols/cant/` | Canonical |

### 20.3 Engineering-lead instructions (Wave 0)

1. Read this ULTRAPLAN end-to-end. Do not skim.
2. Run `cant validate` on all `.cant` files in the project. Fix any failures.
3. Start Wave 0 by extending the CANT grammar per §8.
4. Every commit references the task ID and wave number in the message.
5. Every wave ends with a green empirical gate (§18).
6. If a design question arises that this plan does not answer, escalate to
   cleo-prime via `report_to_orchestrator`. Do NOT guess.

### 20.4 Validation-lead instructions (every wave)

1. After each wave PR, run the full quality gate sequence:
   `pnpm biome check --write .` → `pnpm run build` → `pnpm run test` →
   `cargo test -p cant-core` → `git diff --stat HEAD`
2. Verify the empirical gate for the wave (§18) is green.
3. Verify no pre-existing test was broken.
4. If the wave touches CLEOOS-VISION.md, run the compliance check (§19.1).
5. Approve the PR only if ALL of the above pass.

---

## 21. References

| Document | Path | Purpose |
|----------|------|---------|
| CLEOOS-VISION.md | `docs/concepts/CLEOOS-VISION.md` | Narrative vision (defer to this plan on conflict) |
| CLEO-WORLD-MAP.md | `docs/concepts/CLEO-WORLD-MAP.md` | Founding myth and system vocabulary |
| CLEO-SYSTEM-FLOW-ATLAS.md | `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` | System flow diagrams and domain mapping |
| ADR-035 | `.cleo/adrs/ADR-035-pi-v2-v3-harness.md` | Pi harness decisions (D1-D7) |
| ADR-036 | `.cleo/adrs/ADR-036-cleoos-database-topology.md` | 4-DB × 2-tier topology |
| ADR-037 | `.cleo/adrs/ADR-037-conduit-signaldock-separation.md` | Conduit/signaldock split |
| ADR-041 | `.cleo/adrs/ADR-041-worktree-handle-spawn-contract.md` | Worktree handle contract |
| Execution log | `docs/plans/cleoos-v2-execution-log.md` | Per-session ship history |
| CLEO-CONDUIT-PROTOCOL-SPEC.md | `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` | Shell 4 spec (NOT built) |
| CLEO-AUTONOMOUS-RUNTIME-SPEC.md | `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md` | Autonomous runtime spec (NOT built) |
| packages/cleo-os/ | `packages/cleo-os/` | CleoOS package source |

---

*End of CLEO-ULTRAPLAN.md — CANONICAL*
