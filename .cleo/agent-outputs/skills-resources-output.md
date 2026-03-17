# Phase 4: Dynamic Skill Routing + ct-memory Skill + MCP Resources

**Status**: Complete
**Agent**: skills-resources-agent
**Date**: 2026-03-15

## Summary

All three work packages delivered successfully:

### Part A: MCP Resource Endpoints (WP13)

Created `src/mcp/resources/` with 2 files:

- **`budget.ts`** -- Token estimation and truncation utilities using ~4 chars/token heuristic
- **`index.ts`** -- Resource registration, listing, and reading for 4 memory URIs:
  - `cleo://memory/recent` -- Last 15 observations from brain.db
  - `cleo://memory/learnings` -- Active learnings sorted by confidence
  - `cleo://memory/patterns` -- Patterns to follow/avoid (split into sections)
  - `cleo://memory/handoff` -- Last session handoff summary

Wired into MCP server (`src/mcp/index.ts`):
- Added `resources: {}` to server capabilities
- Registered `ListResources` and `ReadResource` handlers via `registerMemoryResources(server)`

All resource handlers use correct brain.db schema:
- `brain_observations`: id, type, title, created_at
- `brain_learnings`: id, insight, confidence, created_at (no `title` or `status` column)
- `brain_patterns`: id, pattern, type, impact, extracted_at (no `title`, `pattern_type`, or `status`)
- `getLastHandoff(projectRoot)`: returns `{sessionId, handoff: HandoffData}`

### Part B: ct-memory Skill (WP8)

Created `packages/ct-skills/skills/ct-memory/SKILL.md` with:
- Tiered progressive disclosure (Tier 0/1/2)
- Anti-hallucination protocol
- MCP resource alternatives
- Token budget guidelines

### Part C: Dynamic Skill Routing (WP8)

Created `src/core/skills/routing-table.ts` with:
- `RoutingEntry` interface (domain, operation, preferredChannel, reason)
- `ROUTING_TABLE` -- 53 entries across all 10 canonical domains
- `getPreferredChannel(domain, operation)` -- lookup function
- `getRoutingForDomain(domain)` -- domain filter
- `getOperationsByChannel(channel)` -- channel filter

## Build & Test Results

- **TypeScript**: `npx tsc --noEmit` -- zero errors
- **Build**: `npm run build` -- success
- **Tests**: 4864 passed, 7 skipped, 1 pre-existing failure (research-workflow.test.ts)

## Files Created

- `src/mcp/resources/budget.ts`
- `src/mcp/resources/index.ts`
- `src/core/skills/routing-table.ts`
- `packages/ct-skills/skills/ct-memory/SKILL.md`

## Files Modified

- `src/mcp/index.ts` -- added resource capability and registration
