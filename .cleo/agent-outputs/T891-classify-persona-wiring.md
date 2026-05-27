# T891 — CANT Persona Wiring: classify(task) → spawn payload

**Status**: complete
**Date**: 2026-04-20

## Summary

Implemented `classifyTask()` in `packages/core/src/orchestration/classify.ts` and wired it into `composeSpawnPayload` in `spawn.ts`. The classifier maps task signals (labels, title keywords, structural boosts) to one of 5 default personas with a confidence score. Results below the 0.5 floor fall back to `cleo-subagent`.

## Files Changed

- `packages/core/src/orchestration/classify.ts` — NEW: classifier with 5 persona rules
- `packages/core/src/orchestration/spawn.ts` — wires classifyTask(); adds SpawnPayloadPersonaMeta to meta
- `packages/core/src/orchestration/index.ts` — exports ClassifyResult, classifyTask, SpawnPayloadPersonaMeta
- `packages/core/src/orchestration/__tests__/classify.test.ts` — NEW: 15 tests

## Personas Wired

| Agent | Role | Primary Signals |
|-------|------|-----------------|
| `cleo-prime` | orchestrator | labels: orchestrate, multi-agent; title: orchestration |
| `cleo-rust-lead` | lead | labels: rust, crate; title: cargo, cant-core |
| `cleo-db-lead` | lead | labels: schema, migration, drizzle; title: drizzle, sqlite |
| `cleo-historian` | lead | labels: adr, canon; title: specification, adr |
| `cleo-dev` | lead | labels: implementation, feature; title: implement, build |

## Confidence Floor

`CLASSIFY_CONFIDENCE_FLOOR = 0.5` — scores below this use `cleo-subagent` fallback with `usedFallback=true` and a warning in `meta.classify`.

## Acceptance Criteria Coverage

- [x] classify(task) returns {role, persona, confidence} for all 5 default personas
- [x] composeSpawnPayload reached from cleo orchestrate spawn (single code path)
- [x] spawn payload meta includes classify: {agentId, role, confidence, reason, usedFallback}
- [x] confidence < 0.5 falls back to generic cleo-subagent with warning
- [x] tests: 5 persona resolutions + 1 fallback + 1 warning case = 15 tests total

## Tests

284/284 orchestration tests pass. 15 new classify-specific tests.
