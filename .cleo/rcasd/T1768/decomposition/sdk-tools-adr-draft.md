# ADR-XXX: Cleo Core SDK 'Tools' Surface — Taxonomy, Centralization, and Layering

**Status**: DRAFT — Owner decision required  
**Date**: 2026-05-04  
**Author**: Decomposition agent (T1768)  
**Proposed number**: ADR-063 (next after ADR-062 worktree merge)  
**Decision required from**: Owner (keatonhoskins)

---

## Context

Two concurrent epics both use the word "tools" but mean fundamentally different things:

- **T1737** (CleoOS Sentient Harness v3): "60+ tools" = runtime capabilities exposed to LLM agents
  (terminal execution, file I/O, web search, memory, vision). These are agent-facing callable
  primitives that an LLM invokes via function-calling protocol during an active agent session.

- **T1768** (SDK Tools surface): "tools" = harness-agnostic SDK utilities that any orchestration
  mode, harness, or adapter MUST use instead of implementing inline. Examples: WorktreeIsolation,
  EvidenceCapture, ToolResolver. These are infrastructure primitives, not LLM-callable actions.

The ambiguity was exposed by T1759 (WorktreeIsolation centralization), which revealed that
PiHarness (`packages/caamp/src/core/harness/pi.ts`) correctly called `provisionIsolatedShell`
while the Claude Code adapter (`packages/adapters/src/providers/claude-code/spawn.ts`) only
partially consumed it. Without a defined SDK Tools surface, each new harness independently decides
which shared primitives to use and which to inline, creating divergence.

---

## Decision

### 1. Formal Taxonomy (RFC 2119)

This ADR establishes three non-overlapping categories. Implementors MUST use only the canonical
name for each category:

#### Category A: Agent Tool

An **Agent Tool** is a runtime callable primitive that an LLM agent MUST be able to invoke via
structured function-calling during an active agent session. Agent Tools:

- MUST be registered in a tool registry with a JSON schema describing inputs and outputs.
- MUST return a result observable to the calling LLM (success/error + data).
- MUST be scoped to a single agent invocation context (no shared mutable state across calls).
- SHOULD be grouped into toolsets (terminal, file, web, memory, vision, agent-delegation).
- MAY have availability checks (e.g., browser tools require Playwright).

Location: `packages/core/src/tools/agents/` (sub-directory of the existing `tools/` directory).

This is T1737's sense of "tools." T1739 owns the AgentToolRegistry. T1741–T1743 own the
individual Agent Tool implementations.

#### Category B: SDK Tool (Harness Utility)

An **SDK Tool** is a harness-agnostic utility function or class in `packages/core/` (or
`packages/contracts/` for pure functions with no I/O) that every adapter, harness, and
orchestration pathway MUST consume. SDK Tools:

- MUST have zero harness-specific imports (no Pi-specific, no Claude Code-specific code).
- MUST expose a typed contract via `packages/contracts/src/`.
- MUST be consumed by ALL adapters that invoke the relevant operation (not optional per adapter).
- MUST be pure or side-effect-isolated (testable without running an agent).
- SHOULD be deterministic given identical inputs.

Location: `packages/core/src/tools/sdk/` (new sub-directory).

This is T1768's sense of "tools." Existing examples: `provisionIsolatedShell` (already in
`packages/contracts/src/branch-lock.ts`), `resolveToolCommand` (in
`packages/core/src/tasks/tool-resolver.ts`), evidence validation logic (in
`packages/core/src/tasks/evidence.ts`).

#### Category C: Domain Utility

A **Domain Utility** is an internal helper scoped to a specific domain (tasks, memory, sessions,
etc.) that is NOT required to be consumed across package boundaries. Domain Utilities:

- MAY have domain-specific dependencies (e.g., SQLite store access, task schema).
- MUST NOT be exported from `packages/core/src/tools/`.
- Remain in their natural domain directory (e.g., `packages/core/src/tasks/`, `packages/core/src/memory/`).

Examples: `packages/core/src/lifecycle/evidence.ts` (SQLite-backed evidence recording for RCASD
stages — domain utility for the lifecycle domain, not an SDK Tool), `packages/core/src/security/input-sanitization.ts` RateLimiter (security domain utility).

#### Category D: Harness Internal

A **Harness Internal** is an implementation detail of a specific harness or adapter that MUST NOT
be referenced outside that harness/adapter package. Examples: `PiCodingAgentAdapter` in
`packages/cleo-os/`, `ClaudeCodeSpawnProvider` in `packages/adapters/`. These consume SDK Tools
but do not expose them further.

---

### 2. SDK Tools Surface (packages/core/src/tools/sdk/)

The following primitives MUST be promoted to or confirmed as SDK Tools:

| Symbol | Current Location | Classification | Action |
|--------|-----------------|----------------|--------|
| `provisionIsolatedShell` | `packages/contracts/src/branch-lock.ts` | SDK Tool (pure) | Already correct; re-export from `packages/core/src/tools/sdk/isolation.ts` for single import path |
| `ISOLATION_ENV_KEYS` | `packages/contracts/src/branch-lock.ts` | SDK Tool (pure) | Same as above |
| `resolveToolCommand` | `packages/core/src/tasks/tool-resolver.ts` | SDK Tool | Relocate to `packages/core/src/tools/sdk/tool-resolver.ts` |
| `CANONICAL_TOOLS` | `packages/core/src/tasks/tool-resolver.ts` | SDK Tool | Relocate with `resolveToolCommand` |
| `runToolCached` | `packages/core/src/tasks/tool-cache.ts` | SDK Tool | Relocate to `packages/core/src/tools/sdk/tool-cache.ts` |
| Evidence atom parsing (`parseEvidenceAtom`, `validateEvidenceAtom`) | `packages/core/src/tasks/evidence.ts` | SDK Tool subset | Extract atom-parsing logic to `packages/core/src/tools/sdk/evidence-atoms.ts`; leave SQLite-backed recording in domain |
| `pipelineManifestAppend` | `packages/core/src/internal.ts` (re-exported) | SDK Tool | Expose from `packages/core/src/tools/sdk/manifest.ts` |
| `buildWorktreeSpawnResult` | `packages/core/src/spawn/branch-lock.ts` | SDK Tool | Re-export from `packages/core/src/tools/sdk/spawn-primitives.ts` |
| `buildAgentEnv` | `packages/core/src/spawn/branch-lock.ts` | SDK Tool | Same as above |

---

### 3. Relationship Between T1768 and T1737

T1768 (SDK Tools) and T1737 (CleoOS Harness v3) are **complementary, not competing**:

- T1768 defines the infrastructure substrate (Category B: SDK Tools). This work MUST ship before or
  alongside T1737 children that build on `packages/core/src/tools/`.
- T1737 children T1739 and T1740 build Category A (Agent Tools registry and dispatch). These are
  DISTINCT from SDK Tools — they are the registry of callable tools exposed to LLMs.
- T1739 extends `packages/core/src/tools/` by adding `agents/` sub-directory — it does NOT conflict
  with T1768's `sdk/` sub-directory. The existing `tools/index.ts` and `tools/engine-ops.ts` (the
  CAAMP skill/provider/adapter operations, migrated in T1575/ENG-MIG-8) represent a THIRD meaning:
  CAAMP provider+skill management operations. These are Category C (Domain Utility for the tools
  management domain) and should NOT be relabeled.

**Canonical layering order**:

```
packages/contracts/src/          ← pure types + pure functions (Category B, zero-dep tier)
    └─ branch-lock.ts            ← provisionIsolatedShell, ISOLATION_ENV_KEYS

packages/core/src/tools/sdk/     ← SDK Tools (Category B, may have I/O)
    ├─ isolation.ts              ← re-exports from contracts
    ├─ tool-resolver.ts          ← project-agnostic tool command resolution
    ├─ tool-cache.ts             ← cached tool execution
    ├─ evidence-atoms.ts         ← atom parsing + validation (no SQLite)
    ├─ manifest.ts               ← pipelineManifestAppend
    ├─ spawn-primitives.ts       ← buildAgentEnv, buildWorktreeSpawnResult
    └─ index.ts                  ← barrel export of all SDK Tools

packages/core/src/tools/agents/  ← Agent Tools (Category A — T1739/T1740/T1741-T1743)
    ├─ registry.ts               ← AgentToolRegistry
    ├─ dispatch.ts               ← tool call dispatch engine
    └─ executors/                ← terminal, file, web, memory, vision, mcp tools

packages/core/src/tools/         ← existing engine-ops (CAAMP skill/provider mgmt, Category C)
    ├─ engine-ops.ts             ← CAAMP provider/skill/adapter operations (T1575)
    └─ index.ts                  ← barrel (currently exports engine-ops; will grow)

Harnesses and adapters:
packages/cleo-os/src/harnesses/  ← Category D (consume SDK Tools, no re-export)
packages/adapters/src/providers/ ← Category D (consume SDK Tools, no re-export)
packages/caamp/src/core/harness/ ← Category D (consumes provisionIsolatedShell already)
```

---

### 4. Consequences

**Positive**:
- Eliminates the divergence pattern: new harnesses have a single import for each shared primitive.
- Makes the contract explicit: `packages/core/src/tools/sdk/` is the canonical source for all
  harness-agnostic infrastructure.
- Allows T1737 children to proceed with confidence that the substrate is defined before they build
  the agent-facing layer on top.
- `tools/` directory gains a clear internal structure: `sdk/` (infrastructure) vs `agents/`
  (LLM-callable) vs root (CAAMP management operations).

**Negative**:
- Relocating `resolveToolCommand` and `runToolCached` from `packages/core/src/tasks/` to
  `packages/core/src/tools/sdk/` requires updating all import paths in `evidence.ts` and its
  tests. Low risk (internal to core, no cross-package API change) but requires careful execution.
- Introducing `packages/core/src/tools/sdk/evidence-atoms.ts` means splitting
  `packages/core/src/tasks/evidence.ts`. The SQLite-backed portion stays in tasks; the atom-parsing
  portion moves. Requires a careful extract-with-re-export migration.

---

## Owner Decisions Required

The following decisions MUST be made by the owner before T1768 implementation children ship:

| # | Decision | Options | Default if no response |
|---|----------|---------|----------------------|
| D1 | Should `packages/core/src/tools/sdk/` be the canonical location for SDK Tools, or should they remain in their current domain directories with a re-export barrel? | (a) New `sdk/` sub-dir (clean) vs (b) Re-export barrel at `tools/sdk/index.ts` pointing to current locations | (a) New sub-dir |
| D2 | Should `resolveToolCommand` and `runToolCached` be physically relocated from `tasks/` to `tools/sdk/`, or re-exported in place? | (a) Physical relocation (breaks existing import paths, requires migration) vs (b) Re-export in place (no breakage, softer boundary) | (b) Re-export in place |
| D3 | Does T1768 own the `packages/core/src/tools/agents/` directory structure (the registry skeleton), or does T1739 own that entirely? | (a) T1768 creates empty skeleton + defines interfaces, T1739 implements vs (b) T1739 owns entirely, T1768 only defines Category B | (b) T1739 owns entirely |
| D4 | What ADR number? Next after ADR-062 is ADR-063. Confirm or assign differently. | ADR-063 | ADR-063 |

---

## Alternatives Considered

**Alt-A: Close T1768 as duplicate of T1737**  
Rejected. T1737 is focused on building 60+ Agent Tools (Category A). T1768 addresses the SDK
substrate (Category B) that T1737 children themselves need. The two epics are orthogonal and
complementary. Closing T1768 would leave the harness-divergence problem (the original T1759
trigger) unresolved.

**Alt-B: Merge T1768 into T1738**  
T1738 is a research/architecture task for CleoOS harness architecture. T1768's scope is broader
(applies to ALL harnesses, not just CleoOS). Merging would artificially narrow T1768's scope.
Rejected.

**Alt-C: Create a new `packages/sdk-tools/` package**  
Premature. The existing `packages/core/` package is the correct home for harness-agnostic
infrastructure. A new package would add dependency graph complexity without benefit at this scale.
Deferred — revisit if `packages/core/` grows beyond ~1000 source files.

---

## References

- T1756: Worktree isolation bug (original trigger)
- T1759: WorktreeIsolation centralization (ships `provisionIsolatedShell` to contracts)
- T1737: CleoOS Sentient Harness v3 (60+ Agent Tools)
- T1739: AgentToolRegistry (Category A registry)
- ADR-055: Worktree-by-default spawn
- ADR-062: Worktree merge via git merge --no-ff
- ADR-051: Evidence-based gate ritual
- ADR-061: Tool resolution + result cache
- ENG-MIG-8 / T1575: tools/engine-ops.ts migration (CAAMP skill/provider mgmt)
