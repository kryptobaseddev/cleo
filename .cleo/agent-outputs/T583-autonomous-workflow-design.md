# T583 — Autonomous Workflow Design: 20+ Agent Zero-Intervention Proof

**Date**: 2026-04-14
**Author**: Team Lead subagent
**Status**: Design complete — blocked pending T615, T616

---

## Pre-requisites (must be done first, in order)

| Task | Why | Gate |
|------|-----|------|
| T616 (critical) | Fix `@cleocode/core` missing per-file modules — without it, ALL `cleo nexus` commands fail on a fresh install, workers cannot use code intelligence | `cleo nexus context` returns data |
| T615 (critical) | Fix CANT parser 131 errors — starter bundle agents cannot compile, so persona injection is theater until fixed | `compileBundle` returns 0 errors |
| T566 (high) | Wire 76 unwired test files — we need a real test suite to prove "all tests pass" | `pnpm run test` exits 0 with >0 new test results |

Optional but strongly recommended before running the proof:

- T564 CONDUIT delivery loop confirmed live (LocalTransport active) — without it, CONDUIT message counts will be zero

---

## Target Task Scenario

**Implement `cleo token summary` command** — a new sub-command under the existing `token` domain that aggregates per-session token usage into a human-readable summary table.

Why this target:
- Real, verifiable output (new file + new test)
- Touches multiple layers: CLI registration, business logic, formatter, test
- Nexus-queryable for impact analysis
- Short enough for 5 parallel workers; deep enough to require research and architecture phases
- `git diff` will show >100 lines

---

## Orchestration Flow

Orchestrator is the ONLY spawn point. Subagents return results; they do not spawn.

```
Orchestrator (1 persistent thread)
│
├─ Phase 1 — Research (sequential, 2 agents)
│   ├─ Spawn: Research Lead
│   │   reads: cleo nexus context token, cleo show T583, memory-bridge
│   │   returns: existing token domain map, gaps, constraints
│   └─ [based on findings] Spawn: 3 parallel Research Workers
│       Worker A — audit packages/cleo/src/dispatch/domains/token.ts
│       Worker B — audit packages/contracts/src/ for token types
│       Worker C — audit existing test coverage for token domain
│       each returns: findings file to agent-outputs/
│
├─ Phase 2 — Architecture (sequential, 2 agents)
│   ├─ Spawn: Architecture Lead
│   │   reads: Research Workers' findings, cleo nexus impact token
│   │   returns: spec for token summary command (schema, formatter, CLI shape)
│   │   stores: decision in BRAIN via cleo memory decision.store
│   └─ Spawn: Spec Worker
│       writes: T583-spec.md to agent-outputs/
│       returns: acceptance criteria list
│
├─ Phase 3 — Implementation (parallel, 5 agents)
│   ├─ Spawn: Implementation Lead
│   │   reads: spec, nexus impact, existing patterns
│   │   returns: decomposition into 5 atomic units
│   │   stores: observation in BRAIN
│   └─ [based on decomposition] Spawn 5 parallel Implementation Workers
│       Worker 1 — add SummaryRow type to packages/contracts/src/
│       Worker 2 — implement aggregation logic in packages/core/src/
│       Worker 3 — implement formatter (table output)
│       Worker 4 — register `cleo token summary` in CLI dispatch
│       Worker 5 — write integration test in packages/cleo/src/
│       each runs: pnpm biome check --write, returns diff
│
├─ Phase 4 — Review + Fix (sequential, 3 agents)
│   ├─ Spawn: Code Review Lead
│   │   reads: all 5 Worker diffs, runs cleo nexus impact
│   │   returns: review report (pass / fix list)
│   │   stores: review decision in BRAIN
│   └─ [if issues] Spawn 2 parallel Fix Workers
│       Fix Worker A — type/contract issues
│       Fix Worker B — lint/format issues
│
├─ Phase 5 — QA + Test (parallel, 4 agents)
│   ├─ Spawn: QA Lead
│   │   reads: spec, implementation diff
│   │   returns: test plan
│   └─ Spawn 3 parallel Test Workers
│       Test Worker A — unit tests: aggregation logic
│       Test Worker B — unit tests: formatter
│       Test Worker C — integration: CLI invocation
│       each runs: pnpm run test, returns pass/fail + coverage delta
│
└─ Phase 6 — Docs (sequential, 2 agents)
    ├─ Spawn: Docs Lead
    │   reads: spec, final diff
    │   returns: docs outline
    └─ Spawn: Docs Worker
        writes: TSDoc on exported symbols, updates CHANGELOG.md
        returns: diff
```

**Agent count**: 1 Orchestrator + 5 Leads + 16 Workers = **22 agents**

---

## Zero-Intervention Mechanisms

| Mechanism | How it works |
|-----------|--------------|
| Progress tracking | Orchestrator reads `cleo current`, `cleo show T583` after each phase |
| CONDUIT audit | Orchestrator writes CONDUIT message after each spawn: `cleo agent message send` |
| BRAIN persistence | Every Lead stores its decision: `cleo memory decision.store` or `cleo observe` |
| Worker self-verification | Each Worker runs acceptance criteria check and returns pass/fail JSON |
| Gate enforcement | Orchestrator checks Worker return JSON; spawns Fix Workers only on failure |
| Commit gate | Orchestrator runs `pnpm run test` and `pnpm run build` before committing |
| Auto-commit | On all gates green, Orchestrator runs `git add -p` + `git commit` |

No human prompt is needed at any gate. Orchestrator self-routes failures.

---

## Success Criteria Measurement

| Metric | Target | How to measure |
|--------|--------|----------------|
| Agents spawned | >= 20 | Count Agent() calls in orchestrator log |
| CONDUIT messages | >= 40 | `cleo agent message list --session <id>` |
| BRAIN observations | >= 15 | `cleo memory find "T583"` count |
| Git diff lines | > 100 | `git diff --stat HEAD~1` |
| New tests | > 0 | `pnpm run test` pass count before vs after |
| Human prompts | 0 | Review conversation — count user messages during execution |

---

## Pre-flight Checklist

Before executing:

- [ ] T616 resolved: `cleo nexus context token` returns data (not E_CONTEXT_FAILED)
- [ ] T615 resolved: `cleo cant compile .cleo/cant/` returns 0 errors
- [ ] T566 resolved: `pnpm run test` finds > 0 token domain test files
- [ ] CONDUIT delivery loop live: send a test message and verify receipt
- [ ] BRAIN writable: `cleo observe "pre-flight test"` exits 0
- [ ] Git working tree clean: `git status` shows no uncommitted changes
- [ ] Active session open: `cleo session status` returns active session

---

## Fallback if CONDUIT is still dead

If CONDUIT delivery loop (T564) is not resolved before run, CONDUIT message count will be 0. In that case:

- Replace "CONDUIT messages >= 40" with "agent-outputs/ files >= 20"
- Workers write MANIFEST.jsonl entries as the audit trail substitute
- Mark CONDUIT metric as "blocked on T564" in final report

This keeps the proof runnable without CONDUIT being live, while honestly documenting the gap.
