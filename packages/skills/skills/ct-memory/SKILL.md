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

1. The memory bridge (.cleo/memory-bridge.md) is already loaded via CLEO-INJECTION.md @-reference
2. If the bridge content feels stale (>2 hours old), refresh:
   - `query memory brain.search {query: "session task decision", limit: 10}`
3. Check for anti-patterns to avoid:
   - `query memory brain.search {query: "mistake error avoid warning", limit: 5}`
4. If results are relevant, fetch details:
   - `query memory brain.fetch {ids: ["O-xxx", "O-yyy"]}`

## Tier 1: During Work (run when topic-relevant)

### Before Making Decisions

- `query memory brain.search {query: "decision ADR architecture", limit: 5}`
- Check if a similar decision was already made

### Before Repeating Work

- `query memory brain.search {query: "{current-topic}", limit: 10}`
- Avoid re-doing work that's already been completed

### After Completing Significant Work

- `mutate memory brain.observe {text: "Completed X using approach Y. Key learning: Z", title: "Work completion"}`

### Anti-Hallucination Protocol

Before stating facts about the codebase or project:

1. Search brain: `query memory brain.search {query: "{claim-topic}", limit: 5}`
2. If results exist, verify your claim matches stored knowledge
3. If no results, state your uncertainty clearly

## Tier 2: Deep Recall (run when specifically needed)

### Full Timeline

- `query memory brain.timeline {anchor: "O-xxx", depthBefore: 5, depthAfter: 5}`
- Understand chronological context around a specific observation

### Cross-Project Knowledge (via NEXUS)

- `query nexus search {query: "pattern", scope: "global"}`
- Search across all CLEO-managed projects

## MCP Resources (Alternative to search)

For providers that support MCP resources:

- `ReadResource("cleo://memory/recent")` -- last 15 observations
- `ReadResource("cleo://memory/learnings")` -- active learnings with confidence
- `ReadResource("cleo://memory/patterns")` -- patterns to follow/avoid
- `ReadResource("cleo://memory/handoff")` -- last session handoff

## Token Budget Guidelines

| Operation | ~Tokens | When |
|-----------|---------|------|
| memory-bridge.md (auto-loaded) | 200-400 | Always (free) |
| brain.search | 50/hit | Discovery |
| brain.fetch | 500/entry | Details |
| brain.timeline | 200-500 | Context |
| MCP resources | 200-500 | On-demand |

Stay within LAFS MVI budget: start minimal, escalate only when needed.
