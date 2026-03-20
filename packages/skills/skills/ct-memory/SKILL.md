---
name: ct-memory
version: 1.0.0
description: Brain memory protocol with progressive disclosure for anti-hallucination and context recall
triggers:
  - memory
  - brain
  - recall
  - remember
  - anti-hallucination
---

# ct-memory -- Brain Memory Protocol

## Purpose

Ensures LLM agents never start conversations with amnesia. Provides structured memory access through CLEO's brain system using progressive disclosure.

## Tier 0: Session Start (ALWAYS run on first interaction)

Use CLI (`cleo`) as the primary interface. MCP (`query` / `mutate`) is the fallback when CLI is unavailable.

1. The memory bridge (.cleo/memory-bridge.md) is already loaded via CLEO-INJECTION.md @-reference
2. If the bridge content feels stale (>2 hours old), refresh:
   - CLI (Primary): `cleo memory find "session task decision" --limit 10`
   - MCP (Fallback): `query memory find {query: "session task decision", limit: 10}`
3. Check for anti-patterns to avoid:
   - CLI (Primary): `cleo memory find "mistake error avoid warning" --limit 5`
   - MCP (Fallback): `query memory find {query: "mistake error avoid warning", limit: 5}`
4. If results are relevant, fetch details:
   - CLI (Primary): `cleo memory fetch O-xxx O-yyy`
   - MCP (Fallback): `query memory fetch {ids: ["O-xxx", "O-yyy"]}`

## Tier 1: During Work (run when topic-relevant)

### Before Making Decisions

- CLI (Primary): `cleo memory find "decision ADR architecture" --limit 5`
- MCP (Fallback): `query memory find {query: "decision ADR architecture", limit: 5}`
- Check if a similar decision was already made

### Before Repeating Work

- CLI (Primary): `cleo memory find "{current-topic}" --limit 10`
- MCP (Fallback): `query memory find {query: "{current-topic}", limit: 10}`
- Avoid re-doing work that's already been completed

### After Completing Significant Work

- CLI (Primary): `cleo memory observe "Completed X using approach Y. Key learning: Z" --title "Work completion"`
- MCP (Fallback): `mutate memory observe {text: "Completed X using approach Y. Key learning: Z", title: "Work completion"}`

### Anti-Hallucination Protocol

Before stating facts about the codebase or project:

1. Search brain:
   - CLI (Primary): `cleo memory find "{claim-topic}" --limit 5`
   - MCP (Fallback): `query memory find {query: "{claim-topic}", limit: 5}`
2. If results exist, verify your claim matches stored knowledge
3. If no results, state your uncertainty clearly

## Tier 2: Deep Recall (run when specifically needed)

### Full Timeline

- CLI (Primary): `cleo memory timeline O-xxx --before 5 --after 5`
- MCP (Fallback): `query memory timeline {anchor: "O-xxx", depthBefore: 5, depthAfter: 5}`
- Understand chronological context around a specific observation

### Cross-Project Knowledge (via NEXUS)

- CLI (Primary): `cleo nexus search "pattern" --scope global`
- MCP (Fallback): `query nexus search {query: "pattern", scope: "global"}`
- Search across all CLEO-managed projects

## MCP Resources (Fallback — for providers that support MCP resources)

When CLI is unavailable and the provider supports MCP resources:

- `ReadResource("cleo://memory/recent")` -- last 15 observations
- `ReadResource("cleo://memory/learnings")` -- active learnings with confidence
- `ReadResource("cleo://memory/patterns")` -- patterns to follow/avoid
- `ReadResource("cleo://memory/handoff")` -- last session handoff

## Token Budget Guidelines

| Operation | ~Tokens | Interface | When |
|-----------|---------|-----------|------|
| memory-bridge.md (auto-loaded) | 200-400 | — | Always (free) |
| `cleo memory find` | 50/hit | CLI (Primary) | Discovery |
| `cleo memory fetch` | 500/entry | CLI (Primary) | Details |
| `cleo memory timeline` | 200-500 | CLI (Primary) | Context |
| MCP resources | 200-500 | MCP (Fallback) | On-demand |

Stay within LAFS MVI budget: start minimal, escalate only when needed.
