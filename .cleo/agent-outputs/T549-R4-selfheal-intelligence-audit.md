---
title: "Self-Healing & Intelligence Audit — Agent and Intelligence BRAIN Dimensions"
task: T549
type: research
status: complete
date: 2026-04-13
author: cleo-research-agent
---

# Self-Healing & Intelligence Audit

## Executive Summary

Both the Agent (orchestration) and Intelligence (validation) dimensions are partially
built but have a critical shared gap: the low-level building blocks exist in isolation
but are not wired into an automated runtime loop. Self-healing can detect crashes and
has retry logic, but nothing calls `recoverCrashedAgents` on a schedule. Proactive
intelligence can predict risk and score gates, but the CLI surface (`cleo intelligence
predict/suggest`) and the auto-remediation path are completely absent. The tiered memory
tables exist and are written to, but the feedback loop that would route future agent
assignments or pre-warn humans is not closed.

---

## 1. Agent Dimension — Current State vs. Spec Gap

### 1.1 What Is Actually Built

All code lives under `packages/core/src/agents/`:

| File | What It Does | Status |
|------|-------------|--------|
| `health-monitor.ts` | `recordHeartbeat`, `checkAgentHealth`, `detectStaleAgents`, `detectCrashedAgents` — 30s heartbeat interval, 3-min stale threshold, marks crashed agents in DB | BUILT |
| `retry.ts` | `withRetry` (exponential backoff, 3 retries, 1s base, 2x multiplier, 25% jitter), `shouldRetry` (error classification), `recoverCrashedAgents` (resets to 'starting' or abandons if errorCount >= 5 or last error was 'permanent') | BUILT |
| `capacity.ts` | `updateCapacity`, `getAvailableCapacity`, `findLeastLoadedAgent`, `isOverloaded`, `getCapacitySummary` — float 0-1 capacity per agent, queries across active/idle instances | BUILT |
| `agent-registry.ts` | `getAgentsByCapacity` (filter by type, sorted by remaining capacity), `getAgentSpecializations` (skills from metadata_json), `recordAgentPerformance` (delegates to execution-learning) | BUILT |
| `execution-learning.ts` | `recordAgentExecution` → writes to `brain_decisions`; `recordFailurePattern` → writes to `brain_patterns`; `getSelfHealingSuggestions` → reads `brain_patterns` for known failure patterns; `processAgentLifecycleEvent` → full lifecycle integration | BUILT |

The spawn registry (`packages/core/src/spawn/`) supports manifest-based dynamic adapter
loading, capability filtering (`supportsSubagents`, `supportsParallelSpawn`), and
provider-neutral spawn via `CLEOSpawnAdapter`.

The orchestrate CLI (`packages/cleo/src/cli/commands/orchestrate.ts`) exposes:
`start`, `status`, `analyze`, `ready`, `next`, `waves`, `spawn`, `validate`, `context`,
`parallel`, `tessera list/instantiate`, `unblock`, `bootstrap`, `classify`, `fanout`,
`handoff`, `spawn-execute`, and `conduit-*` subcommands.

The agent CLI (`packages/cleo/src/cli/commands/agent.ts`) exposes:
`register`, `list`, `get`, `remove`, `rotate-key`, `poll`, `send`, `start`, `install`,
`pack`, `create`, `health` (with `--detect-crashed`), `reassign`, and `detach`.

### 1.2 What Is Missing vs. the Spec

The BRAIN spec Section 13.3 describes a self-healing loop and a load balancing routing
algorithm. The building blocks are built but the loop is not closed:

| Gap | Spec Reference | Current Reality |
|----|------|------|
| Automated watchdog scheduler | 13.3.3 — "heartbeat every 30s, timeout 3min, retry 3 attempts" | `detectCrashedAgents` and `recoverCrashedAgents` exist as functions but are called manually via `cleo agent health --detect-crashed`. No scheduler or Watchers Engine calls them automatically. |
| Routing algorithm wired to spawn | 13.3.4 — "filter agents by required skills, sort by capacity, prefer historical success" | `getAgentsByCapacity` and `getAgentSpecializations` exist in core but are never called from the orchestrate engine (`orchestrate-engine.ts`). The `spawn` operation does not consult capacity. |
| Post-failure task reassignment | 13.3.3 — "if all retries fail → reassign to different agent" | `cleo agent reassign <taskId> <agentId>` exists as a manual command. No code path calls this after detecting a crash and a failed recovery sweep. |
| Agent registry persistence in orchestration | 13.3.4 — "agent_id, current_tasks, capacity_remaining, specialization, performance_history" | `agent_instances` table exists with capacity field. `orchestrate spawn` does not write to it or read from it. |
| Learning feedback loop closure | 13.3.5 — "task completion → outcome analysis → store in brain_learnings → adjust routing" | `recordAgentExecution` and `recordFailurePattern` write to brain correctly. But the routing side never reads `getSelfHealingSuggestions` or filters candidates based on past failure rates for similar tasks. |
| `cleo agent spawn --auto-select` | 13.3.6 — "cleo agent spawn --task T3002 --auto-select" | No `--auto-select` flag. Spawn operations require a specific adapter or default to env-detected provider. |
| `cleo agent capacity --show` | 13.3.6 — "capacity management commands" | `getCapacitySummary` exists in core but there is no `cleo agent capacity` CLI command. |
| `cleo agent learn` | 13.3.6 — "cleo agent learn --task T3002 --outcome success" | Not implemented. Execution learning is triggered programmatically but has no CLI surface. |
| Autonomous Watchers Engine | CleoOS Vision 4.1 and CLEO-AUTONOMOUS-RUNTIME-SPEC.md | The spec file explicitly states: "As of v2026.4.x, NONE are implemented." The Watchers, Impulse Engine, and patrol loops are entirely unbuilt. |

### 1.3 Retry Logic Deep Dive

`withRetry` in `retry.ts` is a solid implementation:
- 3 retries, 1s base delay, 2x backoff multiplier, 25% jitter, 30s max delay
- Error classification: permanent errors abort immediately; retriable errors always retry;
  unknown errors defer to `retryOnUnknown` policy flag (default: true)
- `recoverCrashedAgents` checks error history, abandons if `errorCount >= 5` or last
  error was permanent, otherwise resets to `starting`

The gap is integration: nothing calls `withRetry` around a spawn attempt, and nothing
calls `recoverCrashedAgents` on a cron-like schedule.

### 1.4 Heartbeat Monitoring Deep Dive

`health-monitor.ts` correctly implements the spec:
- `HEARTBEAT_INTERVAL_MS = 30_000` (30s)
- `STALE_THRESHOLD_MS = 3 * 60_000` (3 min)
- `detectCrashedAgents` marks agents as `crashed` in DB when active with no heartbeat
- `detectStaleAgents` returns read-only list (does not mutate)
- Only agents in `['starting', 'active', 'idle']` participate in heartbeat

The gap is the watchdog: the `cleo agent start` daemon polls SignalDock for messages
but does not run the health sweep on a schedule. The health commands are manual.

---

## 2. Intelligence Dimension — Current State vs. Spec Gap

### 2.1 What Is Actually Built

All code lives under `packages/core/src/intelligence/`:

| File | What It Does | Status |
|------|-------------|--------|
| `prediction.ts` | `calculateTaskRisk` (4 factors: complexity, historical failure, blocking risk, dependency depth — weighted), `predictValidationOutcome` (pass likelihood from task status + acceptance criteria + historical patterns + learnings) | BUILT |
| `adaptive-validation.ts` | `suggestGateFocus` (ordered gate recommendations with risk scores from brain_patterns + task attributes), `scoreVerificationConfidence` (0-1 confidence from gates passed, failure log length, round number — persists to brain_observations and brain_learnings), `storePrediction` (persists ValidationPrediction to brain), `predictAndStore` (compose prediction + persist) | BUILT |
| `patterns.ts` | `extractPatternsFromHistory` (blocker, success, workflow, observation patterns from tasks.db + brain.db), `matchPatterns` (relevance scoring against task labels/title/description), `storeDetectedPattern`, `updatePatternStats` (running average success rate) | BUILT |
| `impact.ts` | `analyzeTaskImpact`, `calculateBlastRadius`, `predictImpact`, `analyzeChangeImpact` | BUILT |
| `types.ts` | Type contracts for all intelligence types | BUILT |

The compliance module (`packages/core/src/compliance/`) provides:
`getComplianceSummary`, `listComplianceViolations`, `getComplianceTrend`,
`auditEpicCompliance`, `syncComplianceMetrics`, `getSkillReliability`, `getValueMetrics`
— all backed by a JSONL store at `.cleo/metrics/compliance.jsonl`.

The validation layer (`packages/core/src/check/`, `packages/core/src/validation/`)
provides the 4-layer validation (schema, semantic, referential, protocol), 72 exit
codes, and lifecycle gate enforcement.

### 2.2 What Is Missing vs. the Spec

The BRAIN spec Section 13.4 defines four capability phases:

| Gap | Phase | Spec Reference | Current Reality |
|----|------|------|------|
| `cleo compliance score --task T3002` | Phase 1 | 13.4.6 — per-task compliance score | `compliance summary` and `compliance violations` exist. No per-task score command. Compliance scores are written via JSONL but not queryable per task ID. |
| `cleo intelligence learn-errors` | Phase 2 | 13.4.6 — "learn errors, suggest fixes proactively" | No `intelligence` command group registered anywhere in the CLI. `extractPatternsFromHistory` exists in core but is never triggered by the CLI. |
| `cleo intelligence suggest-fix --error E_VALIDATION_FAILED` | Phase 2 | 13.4.6 — suggest fix for specific error code | Not implemented. The error catalog has fix fields but they are static strings, not dynamically suggested from brain patterns. |
| Auto-remediation of known error patterns | Phase 2 | 13.4.3 — "automatically fix known error patterns" | No code path. `suggestGateFocus` suggests what to check; nothing takes action automatically. |
| `cleo intelligence suggest` | Phase 3 | 13.4.6 — "suggest next actions before user asks" | Not implemented. The proactive suggestion engine from Section 13.4.4 (confidence-weighted next action prediction) does not exist as code. |
| `cleo intelligence predict --task T3002` | Phase 3 | 13.4.6 — "predict task success likelihood" | `calculateTaskRisk` and `predictValidationOutcome` exist in core and are internally callable but have no CLI surface. `cleo reason impact` surfaces related logic but not the full quality prediction flow. |
| Adaptive validation feedback cycle | Phase 2 | 13.4.3 — "generate proactive warning for similar context" | `suggestGateFocus` correctly reads patterns and returns recommendations, but the recommendations are not surfaced automatically — callers must invoke it explicitly. No hook triggers it on `TaskStart` or before `cleo verify`. |
| Quality prediction shown at task start | Phase 3 | 13.4.5 — risk score + recommendations before execution | Nothing in the session start or task start path calls `calculateTaskRisk` or `predictValidationOutcome`. |

### 2.3 The Compliance Scoring Gap

The spec calls for `cleo compliance score --task T3002` in Phase 1. What exists:
- `cleo compliance summary` — aggregate pass rates across agents
- `cleo compliance violations` — list entries with violations
- `compliance.jsonl` is keyed by timestamp + agent, not by task ID

Per-task compliance scoring requires indexing the JSONL by `context.task_id` and
surfacing a per-task score. The data is captured (the JSONL includes `context.task_id`)
but the query path is missing.

### 2.4 The Intelligence CLI Gap

The spec defines a `cleo intelligence` command group with 6 subcommands. Not one of them
is registered. The `reason` command group covers `impact` and `timeline`, but none of the
intelligence predict/suggest/learn-errors subcommands exist. The functions exist in
`packages/core/src/intelligence/` and are exported from `internal.ts`, but no CLI
command dispatches to them.

---

## 3. How Tiered Memory Enables Both Dimensions

### 3.1 Tables Already in Use

The intelligence module writes to brain.db correctly:

| Use Case | Brain Table | Writer | Reader |
|---------|------------|--------|--------|
| Agent execution history | `brain_decisions` (type: tactical) | `recordAgentExecution` | `getSelfHealingSuggestions` reads `brain_patterns` |
| Failure patterns | `brain_patterns` | `recordFailurePattern` | `suggestGateFocus`, `calculateTaskRisk`, `predictValidationOutcome` |
| Verification confidence | `brain_observations` | `scoreVerificationConfidence` | Not yet read back into routing |
| Quality predictions | `brain_observations` | `storePrediction` | Not yet read back into any auto-trigger |
| Learnings from notable verifications | `brain_learnings` | `maybeExtractLearning` | `gatherLearningContext`, `predictValidationOutcome` |

### 3.2 Self-Healing Memory Needs

The self-healing loop requires three memory tiers:

| Memory Need | Brain Source | Gap |
|------------|-------------|-----|
| Failure history for a specific agent type on a specific task type | `brain_decisions` filtered by `agentType` + `taskType` in `alternatives_json` | `getAgentPerformanceHistory` reads this correctly. But `orchestrate.spawn` does not call it before selecting an adapter. |
| Recovery procedures (what fix works for what error) | `brain_patterns` where type='failure' with `mitigation` field | `getSelfHealingSuggestions` reads this. The mitigation text is human-readable but nothing acts on it programmatically. |
| Agent capabilities (which agent handles which task type) | `agent_instances.metadata_json.specializations` via `getAgentSpecializations` | The field is populated by `updateAgentSpecializations` but nothing calls this during agent registration or completion. |

### 3.3 Proactive Intelligence Memory Needs

| Memory Need | Brain Source | Gap |
|------------|-------------|-----|
| Past patterns for similar tasks | `brain_patterns` (success + failure types) | `matchPatterns` reads these correctly per task. Not called at task start. |
| Current session context | `sessions` + `brain_sticky_notes` + memory bridge | Available via `cleo briefing`. Not injected into the suggestion engine. |
| Successful workflows | `brain_learnings` with `actionable=1` | `gatherLearningContext` reads these. Not called proactively. |

---

## 4. Implementation Priority

### 4.1 Phase 1 — Close the Health Loop (Small/Medium)

Priority: CRITICAL. Without this, self-healing is dead code.

1. **Wire watchdog into the agent daemon.** The `cleo agent start` daemon polls SignalDock
   every 30s. Add a second interval (60s) that calls `detectCrashedAgents` and
   `recoverCrashedAgents`. Output is logged to `agent_error_log` already.
   Files to change: `packages/cleo/src/cli/commands/agent.ts` (the daemon loop section).

2. **Add `cleo agent capacity` CLI command.** Call `getCapacitySummary` and
   `findLeastLoadedAgent`. Thin dispatch wrapper. Files: new dispatch operation in
   `packages/cleo/src/dispatch/domains/` + CLI flag in `agent.ts`.

3. **Add per-task compliance score.** Add a `tasks.compliance.score` operation that reads
   `compliance.jsonl`, filters by `context.task_id`, and returns aggregated pass rate.
   Wire to `cleo compliance score --task <id>`. Files: `packages/core/src/compliance/`
   + dispatch + CLI.

### 4.2 Phase 2 — Wire Routing to Capacity and History (Medium)

4. **Integrate capacity routing into `orchestrate.spawn`.** Before selecting an adapter,
   call `getAgentsByCapacity(agentType)` and `getAgentSpecializations` to filter and rank
   candidates. Fall back to current env-detected provider if no agents registered.
   Files: `packages/cleo/src/dispatch/engines/orchestrate-engine.ts`.

5. **Register the `intelligence` CLI command group.** Create
   `packages/cleo/src/cli/commands/intelligence.ts` with subcommands:
   - `predict --task <id>` → calls `calculateTaskRisk` + `predictValidationOutcome`
   - `learn-errors` → calls `extractPatternsFromHistory` and stores results
   - `suggest-fix --error <code>` → reads `brain_patterns` for matching mitigations
   Wire to `cleo.ts` CLI bootstrap.

6. **Hook `suggestGateFocus` into the verify command path.** Before `cleo verify` sets
   gates, call `suggestGateFocus` and surface the high-risk gate warnings. This converts
   the adaptive validation from pull (explicit call) to push (automatic warning).
   Files: the verify operation in dispatch.

### 4.3 Phase 3 — Proactive Suggestion Engine (Large)

7. **Proactive suggestion on task start.** When `cleo start <taskId>` is called, trigger
   `predictAndStore` and surface risk factors if score > 0.6. This closes the quality
   prediction loop at the moment it is most actionable.

8. **Proactive next-action suggestions.** After `cleo complete`, call `matchPatterns` on
   the completed task's labels/type, find high-confidence success patterns, and suggest
   the statistically likely next command. This is the `cleo intelligence suggest`
   surface from the spec.

9. **Auto-remediation of known error patterns.** When a validation fails, read
   `getSelfHealingSuggestions` for the failing agent type + task type, and if a
   mitigation command exists in the pattern's `mitigation` field, offer it as a
   one-click fix suggestion in the error output.

---

## 5. Dependencies Between Self-Healing, Intelligence, and Memory Tiers

```
brain_patterns (failure, blocker, success, workflow)
        |
        +--> calculateTaskRisk (before task start) ---------> [gap: not called]
        +--> suggestGateFocus (before verify) --------------> [gap: not hooked]
        +--> getSelfHealingSuggestions (after crash) -------> [gap: not wired to reassign]
        +--> matchPatterns (next action suggestion) ---------> [gap: no CLI]

brain_decisions (agent execution events)
        |
        +--> getAgentPerformanceHistory (routing) -----------> [gap: spawn does not read]
        +--> A/B routing improvement (Phase 3) -------------> [not built]

brain_learnings (verification outcomes, notable completions)
        |
        +--> gatherLearningContext (passLikelihood) ---------> [built, not hooked at start]
        +--> temporal decay (confidence) -------------------> [built in brain-lifecycle.ts]

brain_observations (verification confidence scores)
        |
        +--> aggregate for per-task compliance score --------> [gap: no query path]
        +--> quality prediction storage --------------------> [built via storePrediction]

agent_instances (capacity, specializations, error_count)
        |
        +--> findLeastLoadedAgent (spawn routing) -----------> [gap: not called by spawn]
        +--> getAgentSpecializations (skill matching) -------> [gap: not called by spawn]
        +--> recoverCrashedAgents (self-heal) ---------------> [gap: no scheduler]
```

### Critical Path

The minimum viable self-healing loop requires items 1 and 4 above:
- Item 1 closes the watchdog gap (detect → mark crashed → recover automatically)
- Item 4 closes the routing gap (capacity-aware spawn selection)

The minimum viable intelligence surface requires item 5 above:
- Item 5 creates the `intelligence` CLI group and exposes all built core functions

Items 2, 3, and 6 are low-effort and deliver Phase 1 spec compliance.
Items 7-9 are the Phase 3 work that transforms the system from reactive to proactive.

---

## 6. CleoOS Vision Alignment

### 6.1 Self-Healing and the Watchers Engine

The BRAIN spec's self-healing architecture (13.3.3) and the Watchers Engine (CleoOS
Vision 4.1) are the same concept at different abstraction levels:

- Spec 13.3.3 describes the heartbeat → timeout → retry → reassign → escalate sequence
- Watchers are described as "long-running Cascades that patrol health, continuity, and
  gate state" via hooks `onPatrol` and `onAgentSpawn`/`onAgentComplete`

The Autonomous Runtime Spec (`CLEO-AUTONOMOUS-RUNTIME-SPEC.md`) explicitly states NONE
of the Watchers, Impulse Engine, or patrol loops are built as of v2026.4.x.

The gap between the BRAIN spec self-healing (partially built functions) and the full
Watchers Engine (entirely unbuilt) is bridgeable by item 1 (daemon watchdog) without
requiring the full Watchers implementation. The watchdog in the agent daemon is a
practical interim step that satisfies the spec requirement without waiting for the
complete autonomous runtime.

### 6.2 Proactive Intelligence and the Living BRAIN

Section 4.5 of the CleoOS vision describes two tiers:
- Shipped: three-layer retrieval, FTS5, vector search, session summarization, memory bridge
- Planned: knowledge graph, active circulation (reinforcement, contradiction detection,
  proactive surfacing)

The intelligence module's `suggestGateFocus`, `predictValidationOutcome`, and
`extractPatternsFromHistory` are the first layer of active circulation — they read
accumulated memory and produce forward-looking recommendations. The gap is that they are
not wired into any lifecycle event (task start, verify, complete).

Connecting these functions to CAAMP hooks (`SubagentStart` for risk prediction,
`SubagentStop` for pattern extraction) would implement the "Living BRAIN actively
surfaces relevant context" capability described in 4.5 without requiring a full
knowledge graph or contradiction detection system.

---

## 7. Summary Table

| Dimension | Component | Status | Gap Type |
|----------|-----------|--------|---------|
| Agent | Heartbeat monitoring | BUILT | Not scheduled |
| Agent | Crash detection | BUILT | Manual only |
| Agent | Retry with backoff | BUILT | Not called from spawn |
| Agent | Crashed agent recovery | BUILT | No scheduler triggers it |
| Agent | Capacity tracking | BUILT | Spawn does not consult it |
| Agent | Specialization lookup | BUILT | Spawn does not consult it |
| Agent | Execution learning → brain | BUILT | Works correctly |
| Agent | Self-healing suggestions from brain | BUILT | Not acted on programmatically |
| Agent | Watchdog loop | NOT BUILT | Requires daemon change |
| Agent | `cleo agent capacity` CLI | NOT BUILT | Requires thin CLI wrapper |
| Agent | `cleo agent learn` CLI | NOT BUILT | Requires thin CLI wrapper |
| Agent | `cleo agent spawn --auto-select` | NOT BUILT | Requires routing integration |
| Agent | Task reassignment after retry exhaustion | NOT BUILT | Requires orchestration change |
| Intelligence | 4-layer validation | BUILT | Works correctly |
| Intelligence | Compliance JSONL metrics | BUILT | Works correctly |
| Intelligence | Quality prediction (calculateTaskRisk) | BUILT | No CLI, not hooked at start |
| Intelligence | Gate focus recommendations | BUILT | Not hooked to verify path |
| Intelligence | Pattern extraction from history | BUILT | Not triggered by CLI/hooks |
| Intelligence | Verification confidence scoring | BUILT | Not triggered by verify path |
| Intelligence | `cleo intelligence` command group | NOT BUILT | All Phase 2-3 CLI missing |
| Intelligence | `cleo compliance score --task` | NOT BUILT | Per-task query missing |
| Intelligence | Auto-remediation | NOT BUILT | Requires new code |
| Intelligence | Proactive suggestion engine | NOT BUILT | Phase 3 |
