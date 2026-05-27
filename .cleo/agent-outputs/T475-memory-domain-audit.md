# T475 Memory Domain Audit

**Date**: 2026-04-10
**Agent**: memory domain lead
**Task**: W3: memory domain lead (18 ops)

---

## Registry Op Inventory

All 18 memory ops extracted from `packages/cleo/src/dispatch/registry.ts`:

| # | Gateway | Operation | Required Params |
|---|---------|-----------|-----------------|
| 1 | query | memory.find | query |
| 2 | query | memory.timeline | anchor |
| 3 | query | memory.fetch | ids |
| 4 | query | memory.decision.find | (none) |
| 5 | query | memory.pattern.find | (none) |
| 6 | query | memory.learning.find | (none) |
| 7 | query | memory.graph.show | nodeId |
| 8 | query | memory.graph.neighbors | nodeId |
| 9 | query | memory.reason.why | taskId |
| 10 | query | memory.reason.similar | entryId |
| 11 | query | memory.search.hybrid | query |
| 12 | mutate | memory.observe | text |
| 13 | mutate | memory.decision.store | decision, rationale |
| 14 | mutate | memory.pattern.store | pattern, context |
| 15 | mutate | memory.learning.store | insight, source |
| 16 | mutate | memory.link | taskId, entryId |
| 17 | mutate | memory.graph.add | (none) |
| 18 | mutate | memory.graph.remove | (none) |

---

## Pre-Existing CLI Coverage (memory-brain.ts)

Before this task, `memory-brain.ts` covered:

| Op | CLI Subcommand | Notes |
|----|---------------|-------|
| memory.find | `memory find <query>` | Also routes to pattern.find / learning.find via --type |
| memory.timeline | `memory timeline <anchor>` | |
| memory.fetch | `memory fetch <ids>` | Comma/space-separated IDs |
| memory.pattern.find | `memory find --type pattern` | Branched inside find handler |
| memory.learning.find | `memory find --type learning` | Branched inside find handler |
| memory.observe | `memory observe <text>` | Also available as top-level `observe` via observe.ts |
| memory.pattern.store | `memory store --type pattern` | Branched inside store handler |
| memory.learning.store | `memory store --type learning` | Branched inside store handler |

Stats subcommand uses pattern.find + learning.find internally, not a direct registry op.

---

## Missing Ops — Classification

| Op | Classification | Reason |
|----|---------------|--------|
| memory.decision.find | needs-cli | Agents and humans need to search stored decisions |
| memory.decision.store | needs-cli | Explicitly listed in task description |
| memory.link | needs-cli | Explicitly listed in task description; links entries to tasks |
| memory.graph.show | needs-cli | Useful for debugging and inspecting PageIndex nodes |
| memory.graph.neighbors | needs-cli | Explicitly listed in task description |
| memory.graph.add | needs-cli | Explicitly listed in task description; graph management |
| memory.graph.remove | needs-cli | Explicitly listed in task description; graph management |
| memory.reason.why | needs-cli | Causal traces useful from CLI for debugging task chains |
| memory.reason.similar | needs-cli | Semantic similarity search useful from CLI |
| memory.search.hybrid | needs-cli | Explicitly listed in task description |

All 10 missing ops classified as needs-cli. None classified as agent-only.

---

## Implementation

All 10 missing subcommands added to `packages/cleo/src/cli/commands/memory-brain.ts`:

| Op | CLI Subcommand | Gateway |
|----|---------------|---------|
| memory.decision.find | `memory decision find [query]` | query |
| memory.decision.store | `memory decision store --decision <text> --rationale <text>` | mutate |
| memory.link | `memory link <taskId> <entryId>` | mutate |
| memory.graph.show | `memory graph show <nodeId>` | query |
| memory.graph.neighbors | `memory graph neighbors <nodeId>` | query |
| memory.graph.add | `memory graph add [--node-id] [--from] [--to]` | mutate |
| memory.graph.remove | `memory graph remove [--node-id] [--from] [--to]` | mutate |
| memory.reason.why | `memory reason why <taskId>` | query |
| memory.reason.similar | `memory reason similar <entryId>` | query |
| memory.search.hybrid | `memory search hybrid <query>` | query |

---

## Quality Gates

- `pnpm biome check --write packages/cleo/src/cli/commands/memory-brain.ts`: PASS (0 fixes applied)
- TypeScript check on memory-brain.ts: PASS (0 errors in this file)
- Full build: Pre-existing failures in @cleocode/cant (TS2591 missing node types) and @cleocode/cleo (TS7016 missing @cleocode/caamp declarations) — unrelated to this task. No new errors introduced.

---

## Verify Op Coverage

Post-implementation: all 18 registry ops have CLI handlers. Total new subcommands added: 10.

| Op | Status |
|----|--------|
| memory.find | covered (pre-existing) |
| memory.timeline | covered (pre-existing) |
| memory.fetch | covered (pre-existing) |
| memory.decision.find | covered (added) |
| memory.pattern.find | covered (pre-existing, via --type branch) |
| memory.learning.find | covered (pre-existing, via --type branch) |
| memory.graph.show | covered (added) |
| memory.graph.neighbors | covered (added) |
| memory.reason.why | covered (added) |
| memory.reason.similar | covered (added) |
| memory.search.hybrid | covered (added) |
| memory.observe | covered (pre-existing) |
| memory.decision.store | covered (added) |
| memory.pattern.store | covered (pre-existing) |
| memory.learning.store | covered (pre-existing) |
| memory.link | covered (added) |
| memory.graph.add | covered (added) |
| memory.graph.remove | covered (added) |

All 18 ops: COVERED.
