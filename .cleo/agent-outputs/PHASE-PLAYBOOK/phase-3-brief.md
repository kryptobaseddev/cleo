# PHASE 3 BRIEF — BBTT BRAIN/Briefing Trust & Truth

**Phase tracker:** T9234 (parent: T9232 MASTER)
**Team name:** `phase-3-bbtt-truth`
**You are:** `phase3-lead`
**Goal:** Land 15 remaining T1892 children (T1898+T1901 already done in Phase 1).

## Why this phase

T1892 BBTT was diagnosed via Council 20260505 + RCASD — 5 smoking guns in BRAIN/Briefing substrate:
1. BM25-as-recency in session-memory.ts:411-415 (wrong sort)
2. Dream cycle had only 7 events ever, last automated 2026-04-24 (T1898/T1901 FIXED in Phase 1)
3. Test fixtures T932EP/E1 lived in production tasks.db (CLEANED in graph-cleanup 2026-05-11)
4. spawn-prompt.ts:1232 parallel-implements briefing path
5. Multi-orchestrator handoff race in getLastHandoff

Plus auto-extract barely works (11 learnings vs 2,819 observations) and pattern bloat (12,390 patterns/2,819 obs = 4.4x ratio).

## Children (15 pending)

| ID | Wave | Title | Domain |
|---|---|---|---|
| T1893 | W0 | Gate relatedDocs on currentTaskId — briefing.ts:782-803 | briefing |
| T1894 | W0 | Filter test-fixture epics from computeActiveEpics | briefing |
| T1895 | W2 | Add `cleo memory dream --status` CLI (engine liveness probe) | dream |
| T1896 | W1 | Pattern dedup at consolidation time | extract |
| T1897 | W3 | Add origin + validated_at + provenance_chain to brain_observations | origin |
| T1899 | W3 | Add origin column to tasks schema — production/test-fixture/imported | origin |
| T1900 | W1 | Add mode=recency/lexical/hybrid + since timestamp to searchBrainComparison | extract |
| T1902 | W5 | ADR — per-worktree handoff schema (design only) | adr |
| T1903 | W3 | Auto-extract repair — only 11 learnings for 2,819 obs | extract |
| T1904 | W2 | Opportunistic dream trigger from cleo briefing (cooldown-respected) | dream |
| T1905 | W1 | BriefingFieldContract types + assertion in computeBriefing | briefing |
| T1906 | W3 | Test-DB isolation CI gate | origin |
| T1907 | W2 | Freshness sentinel CI gate — daily cleo memory dream --status check | dream |
| T1908 | W2 | `cleo doctor brain` health dashboard CLI | dream |
| T1909 | W3 | `cleo doctor scan-test-fixtures-in-prod` heuristic scanner | origin |

## Sequence (parallel within waves)

- **Wave W0 (briefing)** [parallel × 2]: T1893, T1894
- **Wave W1 (extract+briefing)** [parallel × 3]: T1896, T1900, T1905
- **Wave W2 (dream)** [parallel × 4]: T1895, T1904, T1907, T1908
- **Wave W3 (origin)** [parallel × 5]: T1897, T1899, T1903, T1906, T1909
- **Wave W5 (ADR design only)** [single]: T1902

Suggested teammates:
- `phase3-briefing` — T1893, T1894, T1905
- `phase3-dream` — T1895, T1904, T1907, T1908
- `phase3-extract` — T1896, T1900, T1903
- `phase3-origin` — T1897, T1899, T1906, T1909
- `phase3-adr` — T1902 (small, can be folded into briefing worker)

## Done criteria

- 15 children all done (or with deferral notes if blocked)
- T1892 epic complete (closes T1898+T1901 already done → 17/17 closed)
- `cleo briefing` returns faster + smaller token footprint
- `cleo doctor brain` and `cleo memory dream --status` commands exist
- Test-fixture-in-prod scanner runs in CI and is currently green
- Phase tracker T9234 complete
- BRAIN observation + `phase-3-completion-report.md`
- SendMessage Orchestrator `[Lead] complete: phase-3`

## Notes from prior work

- T1894 (filter test-fixture epics) effectively delivered for the *current* DB during the graph cleanup 2026-05-11. The implementation work is the actual *function* in computeActiveEpics that prevents future pollution.
- T1903 (auto-extract repair) is the highest-value learning-pipeline fix. Don't skip.
- T1908 `cleo doctor brain` is the operator-facing health dashboard; pair its design with T1907's freshness sentinel.

## Critical rules

- DO NOT use sqlite3 directly on .cleo/brain.db or .cleo/tasks.db. Use the cleo CLI.
- Schema changes go through Drizzle migrations only (drizzle-orm v1 beta — see CLAUDE.md).
- Run `pnpm biome check --write . && pnpm run build && pnpm run test` per wave.
