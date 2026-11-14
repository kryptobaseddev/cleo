# ADR-032: Provider-Agnostic Memory Bridge

**Status**: Accepted
**Date**: 2026-03-16
**Task**: T5240
**Epic**: T5240

---

## Context

CLEO's brain memory system was surfaced to agents by writing brain observations directly into CLAUDE.md (Claude Code's instruction file). This approach had fundamental problems:

1. **Provider-specific**: Each provider has a different instruction file (CLAUDE.md, AGENTS.md, .cursorrules)
2. **Fragile**: Concurrent writes corrupt instruction file content
3. **Static**: Content is stale the moment it's written
4. **Wrong abstraction**: Instruction files are for instructions, not dynamic memory

Agents starting new conversations had no prior context ("amnesia problem") unless they happened to be using Claude Code with the brain context injection hook.

---

## Decision

Implement a **three-layer provider-agnostic Memory Bridge** that surfaces brain memories to any provider without writing to provider-specific files.

### Layer 1: Static Seed (`.cleo/memory-bridge.md`)

An auto-generated markdown file containing:
- Recent session handoff summary
- Top learnings and anti-patterns (from `brain_learnings`)
- Recent decisions (from `brain_decisions`)
- Active patterns to follow/avoid (from `brain_patterns`)
- Last 10-15 compact observation summaries

Referenced from CLEO-INJECTION.md via `@.cleo/memory-bridge.md`. Any provider that reads instruction files gets this automatically. Regenerated on session end, task completion, high-confidence observations, and manual `cleo refresh-memory` CLI command.

### Layer 2: Guided Self-Retrieval (`ct-memory` skill)

A dedicated skill that teaches any LLM agent the 3-layer retrieval pattern:
- **Tier 0 (session start)**: Read memory-bridge.md (already loaded), check for staleness, search for anti-patterns
- **Tier 1 (during work)**: Search brain before architectural decisions, check for prior work on current topic
- **Tier 2 (deep recall)**: Full timeline, cross-project knowledge via NEXUS

The skill uses LAFS MVI to control token budget (minimal, standard, full).

### Layer 3: Dynamic Resources (MCP resource endpoints)

Four MCP resource URIs served directly from brain.db:
- `cleo://memory/recent` — last 15 observations (compact)
- `cleo://memory/learnings` — active learnings with confidence scores
- `cleo://memory/patterns` — active patterns (follow/avoid)
- `cleo://memory/handoff` — last session handoff summary

Any MCP-compatible provider can `ListResources` + `ReadResource` to access these. No file writing needed — data is served dynamically with LAFS budget-aware truncation.

### Token-Efficiency Routing

A routing table maps each CLEO operation to its preferred channel (MCP vs CLI) based on token overhead. The `preferredChannel` field is added to the capability matrix. A dynamic skill generator produces provider-aware instructions based on the active adapter's capabilities.

### How It Works End-to-End

```
Agent starts new conversation in ANY provider
  ↓
Provider reads instruction file → finds @.cleo/memory-bridge.md reference
  ↓
Layer 1: Agent immediately has recent context seeds (200-400 tokens)
  ↓
ct-memory skill triggers guided self-retrieval (Layer 2)
  - Agent runs: memory.find "recent work" → gets compact index
  - Decides what's relevant → memory.fetch for specific IDs
  ↓
During conversation, agent can query MCP resources (Layer 3)
  - ReadResource("cleo://memory/learnings") for anti-hallucination
  - ReadResource("cleo://memory/patterns") for workflow guidance
```

---

## Consequences

### Positive
- Any provider that reads instruction files gets memory context automatically (Layer 1)
- MCP-compatible providers get dynamic, fresh memory data (Layer 3)
- No provider-specific code needed for memory surfacing
- Token-efficient: Layer 1 costs 200-400 tokens, Layers 2-3 are on-demand
- The memory bridge is CLEO-owned, not provider-owned — adapters never write to it

### Negative
- Layer 1 (static file) can become stale between regeneration triggers
- Layer 3 (MCP resources) requires MCP support — CLI-only providers fall back to Layer 1+2
- Additional complexity in regeneration triggers (session end, task complete, observe)

### Neutral
- The `@.cleo/memory-bridge.md` reference must be added to each provider's instruction file by the adapter's install provider
- Memory bridge content is intentionally compact — full details require Layer 2/3 retrieval

---

## References

- ADR-031: Provider Adapter Architecture
- `src/core/memory/memory-bridge.ts` — bridge generator
- `src/mcp/resources/index.ts` — MCP resource endpoints
- `src/mcp/resources/budget.ts` — LAFS budget-aware truncation
- `packages/skills/skills/ct-memory/SKILL.md` — brain memory skill
- `src/core/skills/routing-table.ts` — token-efficiency routing
- `src/core/skills/dynamic-skill-generator.ts` — provider-aware skill content
