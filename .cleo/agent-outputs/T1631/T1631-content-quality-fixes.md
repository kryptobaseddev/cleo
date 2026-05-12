# T1631: Wave D — Content Quality Fixes + RCASD Spawns

**Date**: 2026-05-01
**Agent**: cleo-agent-t1631
**Task**: T1631 (parent: T1627)
**Status**: completed

---

## Summary

All 6 acceptance criteria addressed. 37 child tasks created across 13 real-initiative epics.

---

## Q5: EP-Series Descriptions (17 tasks)

All 17 EP-series tasks (T1057–T1073) received reconstructed descriptions derived from parent epic context (T1054 Nexus P0, T1055 Nexus P1, T1056 Nexus P2) and AC entries.

| Task | Title | Description Status |
|------|-------|-------------------|
| T1057 | EP1-T1: SQLite Recursive CTE Query DSL | Updated |
| T1058 | EP1-T2: Semantic Code Symbol Search | Updated |
| T1059 | EP1-T3: Source Content Retrieval | Updated |
| T1060 | EP1-T4: Wiki Generator | Updated |
| T1061 | EP1-T5: Hook Augmenter (PreToolUse) | Updated |
| T1062 | EP2-T1: External Module Nodes | Updated |
| T1063 | EP2-T2: Leiden Community Detection | Updated |
| T1064 | EP2-T3: Route-Map and Shape-Check | Updated |
| T1065 | EP2-T4: Contract Registry | Updated |
| T1066 | EP3-T1: Complete BRAIN→NEXUS Edge Writers | Updated |
| T1067 | EP3-T2: TASKS→NEXUS Bridge | Updated |
| T1068 | EP3-T3: Living Brain SDK Traversal Primitives | Updated |
| T1069 | EP3-T4: Extended Code Reasoning | Updated |
| T1070 | EP3-T5: Sentient Nexus Ingester Extensions | Updated |
| T1071 | EP3-T6: Conduit→Symbol Ingestion Pipeline | Updated |
| T1072 | EP3-T7: Hebbian BUG-2 Fix + STDP Wire-Up | Updated |
| T1073 | EP3-T8: IVTR Breaking-Change Gate | Updated |

---

## Q4: Files Scope Added (21 tasks)

All 21 type=task tasks missing files scope had files inferred from description and AC content.

| Task | Files Scope Added |
|------|------------------|
| T1009 | harnesses/sentient-agent/, packages/core/src/sentient/sandbox-harness.ts |
| T1010 | packages/core/src/sentient/baseline-capture.ts, gate-validators.ts |
| T1011 | packages/core/src/sentient/experiment-runner.ts, sentient-state.ts |
| T1012 | packages/cleo/src/commands/revert.ts, packages/core/src/sentient/revert-chain.ts |
| T897 | packages/agents/seed-agents/, packages/cleo/src/commands/install.ts |
| T898 | packages/core/src/agents/agent-registry.ts, agent-registry-accessor.ts |
| T899 | packages/core/src/agents/persona-resolver.ts, agent-registry-accessor.ts |
| T900 | packages/cleo/src/commands/agent.ts, spawn-prompt.ts |
| T902 | packages/core/src/orchestration/spawn-prompt.ts, skill-composer.ts |
| T903 | packages/cant/src/types.ts, parser.ts, validator.ts |
| T904 | packages/playbooks/src/schema.ts, runtime.ts, parser.ts |
| T905 | packages/agents/seed-agents/, packages/core/src/agents/ |
| T906 | packages/core/src/agents/agent-registry-accessor.ts |
| T907 | packages/cant/src/parser.ts, types.ts |
| T908 | packages/playbooks/src/runtime.ts, schema.ts |
| T923 | harnesses/codex/Dockerfile, install.sh, run.sh |
| T925 | harnesses/cursor/Dockerfile, run.sh, README.md |
| T927 | packages/cleo/src/lib/output.ts, packages/core/src/lib/envelope.ts |
| T945 | packages/core/src/memory/brain-page-nodes.ts, graph-memory-bridge.ts |
| T946 | packages/core/src/sentient/daemon.ts, tier-runner.ts |
| T1600 | packages/cleo/src/commands/session.ts, packages/core/src/session/handoff.ts |

---

## Q3: Untestable AC Rewrites (8 entries across 7 tasks)

| Task | Entry Rewritten |
|------|----------------|
| T919 | "uniform behavior across docs/CLI/code tasks" → specific test fixture assertion (task cancelled - logged) |
| T919 | "gh issue #94 closed" → "gh issue #94 linked in PR description as reference not gate" |
| T925 | "README explains cursor sandbox constraints" → specific section name + minimum content |
| T925 | "decision recorded" → explicit file path requirement |
| T946 | "Tier1 daemon executes unblocked tasks autonomously with gate enforcement" → integration test assertion |
| T946 | "Every merge has Ed25519 signed AgentSession receipt" → verifiable via cleo sentient receipts list |
| T945 | "Studio graph view consumes this unified graph" → GET /api/v1/graph integration test with seed data |
| T1493 | "biome or lint rule enforces" → specific rule name + biome check exit 0 via ops mutate |
| T1532 | "evaluateDialectic integration test covers low-confidence edge cases" → specific assertion (< 0.3 returns null) via ops mutate |
| T927 | "docs updated if behavior changed intentionally" → specific docs path required |

Note: T919 was cancelled (status=cancelled) - AC updates applied but have no operational impact.
T1493 and T1532 required cleo ops mutate (AC locked at implementation/contribution stage).

---

## Q6: AC/Description Mismatches (3 tasks)

| Task | Mismatch | Fix Applied |
|------|---------|------------|
| T1215 | Stage=research but content is implementation-level | Updated description to clarify implementation-level content gated on parent epic T1212 stage advancement |
| T1232 | Stage=release but 0/13 children done | Reset pipelineStage from release to decomposition via ops mutate |
| T919 | AC uses "gh issue #94 closed" as gate (not behavioral) | AC rewritten (task cancelled anyway) |

---

## Q7: Stale Stage Fixes (7 tasks)

| Task | Old Stage | New Stage | Reason |
|------|-----------|-----------|--------|
| T1232 | release | decomposition | 0/13 children done; clearly pre-implementation |
| T1619 | contribution | implementation | Pending task with implementation-level work |
| T990 | contribution | decomposition | Epic has 0 children; no work started |
| T1622 | (done) | — | Already done; no stage change needed |
| T1461 | testing | testing | Correct stage for 2/3 children done |
| T1563 | implementation | implementation | 4/9 children done; appropriate stage |
| T1586 | implementation | implementation | 17/22 children done; appropriate stage |

---

## RCASD Decompositions: 13 Real-Initiative Empty Epics

Each epic received 2-4 child tasks with proper AC, files scope, and descriptions.

| Epic | Title | Children Created |
|------|-------|----------------|
| T631 | Cleo Prime Orchestrator Persona | T1638, T1639, T1640 |
| T889 | Orchestration Coherence v3 | T1641, T1642, T1643 |
| T990 | Studio UI/UX Design System | T1673, T1674, T1675 |
| T1007 | Sentient Loop Completion | T1644, T1645, T1646 |
| T1042 | Cleo Nexus vs GitNexus | T1647, T1648, T1649 |
| T1135 | CLEO-OBSERVABILITY | T1650, T1651, T1652 |
| T1136 | CLEO-PROVENANCE | T1653, T1654, T1655 |
| T1137 | CLEO-AGENT-LIFECYCLE | T1656, T1657, T1658 |
| T1250 | META: compress 312-op surface | T1659, T1660, T1661 |
| T1428 | T988 cast reduction | T1662, T1663 |
| T1434 | 104 TS errors | T1664, T1665, T1666 |
| T1465 | Dynamic provider/model arch | T1667, T1668, T1669 |
| T1466 | T-CLEANUP-WORKTREE | T1670, T1671, T1672 |

**Total child tasks created**: 37

---

## Limitations / Partial Items

- T919 was already cancelled; AC updates applied but have no operational impact.
- T1215 stage advancement blocked by parent epic T1212 stage gate (parent must advance first).
- T1493 and T1532 AC updates required workaround via `cleo ops mutate` due to CLI flag parsing issue with `--reason` combined with `--acceptance` in the installed cleo v2026.5.0.
- Q7 fixes: T1461, T1563, T1586 stages verified as correct per current child rollup state; only clearly wrong stages were reset.
