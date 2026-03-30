# T196: CANT Import and Composition Model — Design Draft

**Agent**: cleo-historian
**Date**: 2026-03-30
**Epic**: T191 (CANT DSL Subagent Prompt Exploration)
**Status**: complete

---

## Summary

This document designs how .cant handles skill composition: importing definitions, composing agent + protocol + task context, tier-based visibility scoping, and declarative dispatch routing. The import model is the linchpin that eliminates the ~3,000 token redundancy in current prompts.

---

## Current State: Flat File Loading

The current injection engine (`subagent.ts`) loads files as flat strings:

```typescript
const skill = findSkill(skillName, cwd);    // Reads SKILL.md from disk
const protocolBase = loadProtocolBase(cwd);  // Reads subagent-protocol-base.md
const taskContext = await buildTaskContext(taskId); // Queries CLEO DB
// Concatenates: skill + "---" + protocol + "---" + taskContext
```

**Problems**:
1. No deduplication — AGENT.md and protocol-base both define the 10 domains (~800 tokens each)
2. No selective loading — entire files are included regardless of tier
3. No composition — skills can't extend or override base definitions
4. No dependency tracking — skill A can't declare it needs skill B

---

## Proposed Import Model

### Import Syntax (Already in CANT EBNF)

```ebnf
import_stmt     = "@import" , WS , import_source , LINE_END ;
import_source   = STRING
                | NAME , WS , "from" , WS , STRING ;
```

### Import Resolution Algorithm

1. **Bare name**: `@import "ct-cleo"` → resolves via skill discovery (`findSkill()`)
2. **Relative path**: `@import "./protocols/base.cant"` → file relative to importing file
3. **Package name**: `@import "@cleocode/domains"` → resolved from packages/ directory
4. **Named import**: `@import domains from "@cleocode/domains"` → imports specific export

### Shared Definition Files

Create canonical shared .cant files that define once, import everywhere:

```
packages/cant/shared/
  domains.cant        — The 10 canonical domains
  gateways.cant       — The 2 CQRS gateways
  subagent-protocol.cant — Base protocol constraints
  lafs-envelope.cant  — LAFS envelope contract
  memory-protocol.cant — 3-layer retrieval pattern
```

**Example — domains.cant**:

```cant
---
kind: config
version: 1
---

# The Circle of Ten — Canonical Domain Registry
# Single source. All agents import this. No inline definitions.

let domains = {
  tasks: "Task hierarchy, CRUD, work tracking"
  session: "Session lifecycle, decisions, context"
  memory: "Cognitive memory: observations, decisions, patterns, learnings"
  check: "Schema validation, compliance, testing, grading"
  pipeline: "RCASD-IVTR+C lifecycle, manifest ledger, release management"
  orchestrate: "Multi-agent coordination, wave planning"
  tools: "Skills, providers, CAAMP catalog"
  admin: "Configuration, diagnostics, ADRs, protocol injection"
  nexus: "Cross-project coordination, dependency graph"
  sticky: "Ephemeral capture before formal task creation"
}
```

**Usage in agent**:

```cant
@import domains from "@cleocode/domains"
@import gateways from "@cleocode/gateways"
@import base-protocol from "@cleocode/subagent-protocol"

agent cleo-subagent:
  domains: domains      # Reference, not copy
  gateways: gateways    # Reference, not copy
  protocol: base-protocol
```

---

## Composition Model

### Three Composition Patterns

**1. Include** — Import entire definition as-is:
```cant
@import "@cleocode/subagent-protocol"
# All constraints, phases, tokens from the protocol are available
```

**2. Extend** — Import and add:
```cant
@import base-protocol from "@cleocode/subagent-protocol"

agent my-agent:
  protocol: base-protocol
  # Additional constraints beyond the base
  constraints [custom]:
    CUST-001: MUST run biome check before commit
```

**3. Override** — Import and replace specific items:
```cant
@import base-protocol from "@cleocode/subagent-protocol"

agent my-agent:
  protocol: base-protocol
  # Override a specific constraint
  constraints [output]:
    OUT-001: MUST write to "${CUSTOM_DIR}/${TASK_ID}.md"
    # Replaces base OUT-001 — same ID = override
```

**Resolution rule**: When the same constraint ID appears in both imported and local definitions, the local definition wins. This follows the principle of specificity.

---

## Tier-Based Visibility Scoping

### Replacing HTML Comment Markers

**Current** (markdown):
```markdown
<!-- TIER:minimal -->
## 10 Canonical Domains
...
<!-- /TIER:minimal -->

<!-- TIER:standard -->
## Memory Protocol
...
<!-- /TIER:standard -->
```

**Proposed** (CANT):
```cant
agent cleo-subagent:
  tier: 0  # Default spawn tier

  # Always included (tier 0+)
  constraints [output]:
    OUT-001: MUST write to "${OUTPUT_PATH}"
    OUT-002: MUST append manifest entry

  # Included at tier 1+
  constraints [lifecycle] [tier >= 1]:
    LIFE-001: MUST follow RCASD-IVTR+C phases
    LIFE-002: MUST check dependency completion

  # Included at tier 2+
  constraints [advanced] [tier >= 2]:
    ADV-001: MAY use orchestrate.wave for parallel spawns
    ADV-002: MAY access nexus for cross-project queries
```

### Tier-Gated Imports

```cant
# Always imported
@import domains from "@cleocode/domains"
@import base-protocol from "@cleocode/subagent-protocol"

# Only imported at tier 1+
@import memory-protocol from "@cleocode/memory-protocol" [tier >= 1]

# Only imported at tier 2+
@import orchestration from "@cleocode/orchestration" [tier >= 2]
```

### Composition at Spawn Time

The orchestrator specifies the tier when spawning:

```cant
workflow deploy-feature:
  session "Spawn subagent at tier 1 for standard work":
    spawn cleo-subagent:
      tier: 1
      tokens:
        TASK_ID: "${current_task.id}"
        TOPIC_SLUG: "deploy-${feature_name}"
```

The CANT compiler resolves imports and tier guards, producing a flattened prompt that includes only the content appropriate for the requested tier.

---

## Declarative Dispatch Routing

### Current State

Dispatch routing is hardcoded in TypeScript:
```typescript
// packages/cleo/src/mcp-dispatch.ts
if (domain === 'tasks' && operation === 'show') { ... }
```

### Proposed: Route Declarations in .cant

```cant
---
kind: config
version: 1
---

# Dispatch routing table — declarative, not imperative

let routes = {
  tasks: {
    query: [show, find, next, plan, current]
    mutate: [add, update, complete, start, stop]
  }
  session: {
    query: [status, handoff.show, briefing.show]
    mutate: [start, end]
  }
  memory: {
    query: [find, timeline, fetch]
    mutate: [observe, link, decision.store, pattern.store, learning.store]
  }
  # ... remaining 7 domains
}
```

**Benefit**: The dispatch table becomes a .cant file that cant-core can validate. Adding a new operation means editing a .cant config, not TypeScript code. cant-lsp can autocomplete operation names.

**This is aspirational** — it requires the CANT runtime to emit routing tables that the TS dispatch layer consumes. Feasible via cant-napi but not a T191 deliverable. Documented here as the vision.

---

## Token Cost Impact of Import Model

| Scenario | Current (Markdown) | With Imports |
|----------|-------------------|--------------|
| Domain listing (10 domains) | ~800 tokens × N agents | ~800 tokens × 1 (shared) |
| Protocol constraints | ~400 tokens × N agents | ~400 tokens × 1 (shared) + ~50/agent (extensions) |
| CQRS gateways | ~200 tokens × N agents | ~200 tokens × 1 (shared) |
| Memory protocol | ~500 tokens × N agents | ~500 tokens × 1 (shared) |
| **Total for 5 agents** | **~9,500 tokens** | **~2,150 tokens** |

**Savings**: ~77% reduction in shared content duplication. The import model doesn't reduce the content an LLM receives (the flattened prompt is still full-size), but it eliminates the *authoring* duplication and ensures single-source consistency.

---

## Implementation Path

1. **Phase 1** (T191 scope): Design the grammar, write example files, validate parsability
2. **Phase 2** (future): Implement `@import` resolution in cant-core
3. **Phase 3** (future): Build the flattening compiler that produces spawn prompts from .cant imports
4. **Phase 4** (future): Wire into subagent.ts as an alternative to markdown composition

Phase 1 is what we're delivering now. Phases 2-4 depend on the T191 go/no-go decision (T201).

---

## Linked Tasks

- Epic: T191
- Task: T196
- Dependencies: T193 (agent syntax), T194 (constraints), T195 (tokens)
- Feeds: T197 (prototype agent), T198 (prototype protocol), T201 (go/no-go)
