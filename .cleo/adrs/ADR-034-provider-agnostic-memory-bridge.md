# ADR-002: Provider-Agnostic Memory Bridge

**Status**: Accepted
**Date**: 2026-03-16
**Task**: T5240 (Provider-Agnostic Task Sync Adapter)

## Context

CLEO's brain memory system captured observations into `brain.db` but injected context through provider-specific mechanisms:

- The `brain-context.sh` hook wrote directly to `CLAUDE.md` via a Claude Code plugin hook
- Every provider has a different instruction file format (CLAUDE.md, .cursorrules, opencode.md)
- Direct file injection was fragile: concurrent writes could corrupt the instruction file
- Stale memory data persisted until the next hook trigger, with no on-demand refresh capability
- The entire approach was architecturally coupled to a single provider's lifecycle

## Decision

Implement a three-layer provider-agnostic memory system:

### Layer 1: Static Seed (`.cleo/memory-bridge.md`)

An auto-generated markdown file that any provider's instruction file can reference via `@`-directives. Contains:

- Recent session handoff context
- Active learnings and anti-patterns
- Decision history
- Recent observations

The file is regenerated at key lifecycle points: session end, task completion, and manual refresh via the `memory bridge.refresh` operation. The memory bridge is CLEO-owned, not provider-owned. Adapters only ensure their provider's instruction file includes an `@`-reference to it.

### Layer 2: Guided Self-Retrieval (`ct-memory` skill)

A progressive disclosure skill (`packages/skills/skills/ct-memory/SKILL.md`) that teaches agents to search `brain.db` for relevant context using three tiers:

- **Tier 0** (session start): Load recent handoff and active learnings
- **Tier 1** (during work): Search for topic-specific patterns and decisions
- **Tier 2** (deep recall): Full timeline and cross-referenced fetch

This layer enables agents to pull exactly the context they need without pre-loading everything.

### Layer 3: Dynamic Resources (MCP `cleo://memory/*`)

Four MCP resource endpoints for on-demand memory access:

| URI | Content |
|-----|---------|
| `cleo://memory/recent` | Recent observations from brain.db |
| `cleo://memory/learnings` | Active learnings and anti-patterns |
| `cleo://memory/patterns` | Recognized patterns and recurring themes |
| `cleo://memory/handoff` | Session handoff context |

Any MCP-compatible provider can call `ListResources` and `ReadResource` to access memory without file I/O. This is the most dynamic layer, always returning fresh data from `brain.db`.

### Token-Efficient Routing

A 53-entry routing table (`src/core/skills/routing-table.ts`) maps common agent queries to the cheapest effective retrieval path, preventing agents from over-fetching memory context.

## Consequences

**Positive:**
- Zero-config memory for any provider that supports `@`-directive instruction files
- No more writing to provider-owned files (CLAUDE.md, .cursorrules) for memory injection
- Fresh data from brain.db at every regeneration trigger
- MCP resources provide fully dynamic access without any file I/O
- Progressive disclosure prevents context bloat through tiered retrieval
- Routing table ensures token-efficient access patterns

**Negative:**
- Static bridge file can become stale between regeneration triggers
- Requires brain.db to be populated for the system to provide useful content
- Three layers add conceptual complexity compared to the previous single-mechanism approach
- MCP resource endpoints require the MCP server to be running (not available in CLI-only mode)
