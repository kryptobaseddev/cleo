# T530 Brain Graph Back-fill Report

**Task**: Wave C-1: Populate brain graph from surviving entries
**Date**: 2026-04-12
**Status**: complete

## Before State

| Table | Row count |
|-------|-----------|
| brain_decisions | 1 |
| brain_patterns | 111 |
| brain_learnings | 5 |
| brain_observations | 43 |
| brain_sticky_notes | 7 |
| **brain_page_nodes** | **0** |
| **brain_page_edges** | **0** |

## After State

| Table | Row count |
|-------|-----------|
| brain_page_nodes | **281** |
| brain_page_edges | **228** |

## Node Breakdown

| Node Type | Count | Avg Quality Score |
|-----------|-------|-------------------|
| task (stubs) | 112 | 1.000 |
| pattern | 111 | 0.450 |
| observation | 43 | 0.784 |
| sticky | 7 | 0.600 |
| learning | 5 | 0.700 |
| session (stubs) | 2 | 1.000 |
| decision | 1 | 0.700 |
| **Total** | **281** | |

## Edge Breakdown

| Edge Type | Count |
|-----------|-------|
| applies_to | 119 |
| derived_from | 107 |
| produced_by | 2 |
| **Total** | **228** |

## Implementation Summary

### Files Created

- `packages/core/src/memory/brain-backfill.ts` — core backfill function `backfillBrainGraph(projectRoot)`
- `scripts/brain-backfill-runner.ts` — CLI runner delegating to compiled cleo binary

### Files Modified

- `packages/core/src/internal.ts` — exports `backfillBrainGraph`, `BrainBackfillResult`, `purgeBrainNoise`
- `packages/cleo/src/cli/commands/brain.ts` — added `cleo brain backfill` and `cleo brain purge` subcommands

### Quality Score Computation

| Entity Type | Formula |
|-------------|---------|
| Decision | `high=0.9, medium=0.7, low=0.5` |
| Pattern | `min(0.9, 0.4 + frequency*0.05 + successRate*0.3)` |
| Learning | `min(0.9, confidence)` |
| Observation | `manual=0.8, agent=0.7, other=0.5` |
| Sticky | `0.6` (fixed moderate) |
| Stub (task/session/epic) | `1.0` (deterministic reference) |

### Edge Inference Rules

| Rule | Edge Type | Source |
|------|-----------|--------|
| `decision.contextTaskId != null` | `applies_to` | Decision → Task stub |
| `decision.contextEpicId != null` | `applies_to` | Decision → Epic stub |
| Task ID refs in `pattern.context` | `derived_from` | Pattern → Task stub |
| `observation.sourceSessionId != null` | `produced_by` | Observation → Session stub |
| Task ID refs in observation text | `applies_to` | Observation → Task stub |
| Task ID refs in sticky content | `applies_to` | Sticky → Task stub |

### Content Hash

SHA-256 prefix (first 16 hex chars) of normalised content. Stub nodes have `contentHash = null`.

## Quality Gates

- pnpm biome check: PASS
- pnpm run build: PASS
- pnpm run test (391 test files): PASS

## Notes

The brain.db migration journal was in a partially-applied state (missing t033, t417, t528, t531 entries). The `cleo upgrade --diagnose` command fixed the journal for the compiled CLI path. The missing t528/t531 DDL was applied directly via sqlite3 before running the backfill, since these migrations add `quality_score`, `content_hash`, `last_activity_at`, and `updated_at` columns required by the backfill implementation.

The `brain-backfill-runner.ts` script delegates to the compiled `packages/cleo/dist/cli/index.js` binary to use the correct migration reconciliation path.
