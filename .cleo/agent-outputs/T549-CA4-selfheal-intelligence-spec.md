# T549-CA4: Self-Healing + Proactive Intelligence Wiring Specification

**Task**: T549 (Memory Architecture v2 — Tiered Cognitive Memory System)
**Component**: CA4 — Self-Healing and Proactive Intelligence
**Author**: Architect subagent
**Date**: 2026-04-13
**Status**: FINAL

---

## Summary

All self-healing and intelligence building blocks exist in `packages/core/src/`. None are
wired to the running system. This spec defines exactly how to activate each one: where
schedulers run, how hooks are registered, what CLI commands to create, and how data flows
through the feedback loop.

---

## 1. Watchdog Scheduler Design

### 1.1 Where It Runs

The watchdog is a periodic check — not a daemon process — that fires inside the session
lifecycle via the `onPatrol` internal hook event defined in
`packages/core/src/hooks/types.ts`.

**Entry point**: `packages/core/src/hooks/handlers/watchdog-hooks.ts` (new file).

The scheduler starts when a `SessionStart` event fires and stops when `SessionEnd` fires.
It stores the timer handle on a module-level variable so it survives across hook dispatches
within the same process. One watchdog per project root, enforced by a `Map<string,
NodeJS.Timeout>` keyed on the resolved project root path.

```
SessionStart fires
  → handleWatchdogStart(projectRoot, payload)
      → if alreadyRunning(projectRoot): return   // idempotent
      → timer = setInterval(runWatchdogTick, 60_000)
      → activeWatchdogs.set(projectRoot, timer)

SessionEnd fires
  → handleWatchdogStop(projectRoot, payload)
      → clearInterval(activeWatchdogs.get(projectRoot))
      → activeWatchdogs.delete(projectRoot)
```

**Priority**: register at priority 50 so session grading (priority 100) and backup
(priority 10) are unaffected by order.

### 1.2 Each Tick: runWatchdogTick

Called every 60 seconds. Uses `onPatrol` hook dispatch to keep the event log consistent
with the rest of the hook system.

```typescript
// packages/core/src/hooks/handlers/watchdog-hooks.ts

import { detectCrashedAgents } from '../../agents/health-monitor.js';
import { recoverCrashedAgents } from '../../agents/retry.js';
import { processAgentLifecycleEvent } from '../../agents/execution-learning.js';
import { hooks } from '../registry.js';

const activeWatchdogs = new Map<string, NodeJS.Timeout>();

async function runWatchdogTick(projectRoot: string): Promise<void> {
  // Step 1: Detect and mark crashed agents (write-side)
  const crashed = await detectCrashedAgents(STALE_THRESHOLD_MS, projectRoot);

  // Step 2: For each crashed agent, record to brain and attempt recovery
  for (const agent of crashed) {
    // Record failure event to brain_decisions + brain_patterns
    await processAgentLifecycleEvent({
      agentId: agent.id,
      agentType: agent.agentType ?? 'unknown',
      taskId: agent.currentTaskId ?? 'unknown',
      taskType: 'unknown',
      outcome: 'failure',
      errorMessage: `Heartbeat timeout — agent presumed crashed`,
      errorType: 'retriable',
      sessionId: agent.sessionId ?? undefined,
    }, projectRoot);
  }

  // Step 3: Attempt recovery for all crashed agents
  if (crashed.length > 0) {
    await recoverCrashedAgents(STALE_THRESHOLD_MS, projectRoot);
  }

  // Step 4: Fire onPatrol event for observability
  await hooks.dispatch('onPatrol', projectRoot, {
    timestamp: new Date().toISOString(),
    watcherId: 'health-watchdog',
    patrolType: 'health',
    scope: `crashed=${crashed.length}`,
  });
}
```

**Constants**:
- Tick interval: `60_000` ms (60 seconds)
- Crash threshold: `STALE_THRESHOLD_MS` (3 minutes, from `health-monitor.ts`)
- Recovery threshold passed to `recoverCrashedAgents`: same 3 minutes

### 1.3 Concurrent Session Handling

`activeWatchdogs` is a module-level `Map<string, NodeJS.Timeout>`. Key is `projectRoot`
(resolved via `getProjectRoot()`). If two sessions start in the same process and same
project root, the second `handleWatchdogStart` call finds an existing entry and returns
immediately — one watchdog per project root, not one per session.

### 1.4 Hook Registration

Add to `packages/core/src/hooks/handlers/index.ts`:

```typescript
import './watchdog-hooks.js';
```

Register in `watchdog-hooks.ts` at module load:

```typescript
hooks.register({
  id: 'watchdog-session-start',
  event: 'SessionStart',
  handler: handleWatchdogStart,
  priority: 50,
});

hooks.register({
  id: 'watchdog-session-end',
  event: 'SessionEnd',
  handler: handleWatchdogStop,
  priority: 50,
});
```

---

## 2. Routing Integration Design

### 2.1 Where to Insert

The spawn path has two entry points:
1. `orchestrateSpawn` — generates spawn prompt context (read-only preparation)
2. `orchestrateSpawnExecute` — executes the actual spawn via adapter

Both are in `packages/cleo/src/dispatch/engines/orchestrate-engine.ts`.

The capacity check belongs in `orchestrateSpawnExecute` (line ~436), immediately after
validating the task is ready and before calling the adapter. This is the authoritative
spawn point — `orchestrateSpawn` only builds the prompt context, so injecting there would
not prevent actual execution.

### 2.2 Spawn Modification (Pseudocode)

```typescript
// packages/cleo/src/dispatch/engines/orchestrate-engine.ts
// Inside orchestrateSpawnExecute, after existing readiness validation:

import { findLeastLoadedAgent, getCapacitySummary } from '@cleocode/core/internal';

// -- CAPACITY CHECK (new) --
const capacitySummary = await getCapacitySummary(0.1, root);

if (capacitySummary.overloaded) {
  // All agents are saturated — queue or escalate
  return {
    success: false,
    error: {
      code: 'E_SPAWN_CAPACITY_EXHAUSTED',
      message: `System overloaded: total capacity ${capacitySummary.totalCapacity.toFixed(2)} below threshold. ${capacitySummary.activeAgentCount} active agents.`,
      exitCode: 60,
    },
  };
}

// If a preferred agent type is known, find the best match
const targetAgentType = params.agentType as AgentType | undefined;
const bestAgent = await findLeastLoadedAgent(targetAgentType, root);

// Attach agent routing hint to spawn context
const agentRoutingHint = bestAgent
  ? { preferredAgentId: bestAgent.id, remainingCapacity: parseCapacity(bestAgent.capacity) }
  : null;

// -- END CAPACITY CHECK --
// Continue with existing adapter.spawn() call, passing agentRoutingHint in metadata
```

**Fallback policy**: if `findLeastLoadedAgent` returns null (no agents registered), spawn
proceeds without routing hint. This preserves backward compatibility — self-healing is
additive, not blocking.

### 2.3 Export Requirements

`findLeastLoadedAgent` and `getCapacitySummary` are currently exported from
`packages/core/src/agents/capacity.ts`. They need to be re-exported from
`packages/core/src/internal.ts` (or wherever the `@cleocode/core/internal` barrel is)
if not already present. Verify with:

```bash
grep -n "findLeastLoadedAgent\|getCapacitySummary" packages/core/src/internal.ts
```

If absent, add the exports to the barrel.

---

## 3. Intelligence CLI Command Definitions

### 3.1 New File

`packages/cleo/src/cli/commands/intelligence.ts`

### 3.2 Command Surface

```bash
# Risk prediction for a task
cleo intelligence predict --task T549 [--stage implementation] [--json]

# Gate focus suggestions before cleo verify
cleo intelligence suggest --task T549 [--json]

# Error pattern analysis
cleo intelligence learn-errors [--limit 50] [--json]

# Verification confidence score (read existing gates)
cleo intelligence confidence --task T549 [--json]

# Match patterns against a task
cleo intelligence match --task T549 [--json]
```

### 3.3 CLI Registration Pattern

Follow the same pattern as `packages/cleo/src/cli/commands/memory-brain.ts`:

```typescript
// packages/cleo/src/cli/commands/intelligence.ts
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerIntelligenceCommand(program: Command): void {
  const intel = program
    .command('intelligence')
    .description('Predictive intelligence and quality analysis');

  intel
    .command('predict')
    .description('Calculate risk score for a task')
    .requiredOption('--task <taskId>', 'Task ID to assess')
    .option('--stage <stage>', 'Lifecycle stage for validation prediction')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'predict',
        { taskId: opts['task'], stage: opts['stage'] },
        { command: 'intelligence' },
      );
    });

  intel
    .command('suggest')
    .description('Suggest verification gate focus for a task')
    .requiredOption('--task <taskId>', 'Task ID to analyze')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'suggest',
        { taskId: opts['task'] },
        { command: 'intelligence' },
      );
    });

  intel
    .command('learn-errors')
    .description('Extract recurring failure patterns from task history')
    .option('--limit <n>', 'Max patterns to return', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'learn-errors',
        { limit: opts['limit'] },
        { command: 'intelligence' },
      );
    });

  intel
    .command('confidence')
    .description('Score verification confidence for a task')
    .requiredOption('--task <taskId>', 'Task ID to score')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'confidence',
        { taskId: opts['task'] },
        { command: 'intelligence' },
      );
    });

  intel
    .command('match')
    .description('Match brain patterns against a task')
    .requiredOption('--task <taskId>', 'Task ID to match')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'match',
        { taskId: opts['task'] },
        { command: 'intelligence' },
      );
    });
}
```

### 3.4 Dispatch Domain Handler

New file: `packages/cleo/src/dispatch/domains/intelligence.ts`

```typescript
export class IntelligenceHandler implements DomainHandler {
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    switch (operation) {
      case 'predict': {
        // Calls calculateTaskRisk() or predictValidationOutcome()
        // depending on whether --stage is provided
      }
      case 'suggest': {
        // Calls suggestGateFocus()
      }
      case 'learn-errors': {
        // Calls extractPatternsFromHistory()
      }
      case 'confidence': {
        // Calls scoreVerificationConfidence() with current task.verification
      }
      case 'match': {
        // Calls matchPatterns()
      }
    }
  }

  async mutate(...): Promise<DispatchResponse> {
    return unsupportedOp('mutate', 'intelligence', operation, startTime);
  }
}
```

Functions to import from core (all exported from
`packages/core/src/intelligence/index.ts`):
- `calculateTaskRisk(taskId, taskAccessor, brainAccessor)`
- `predictValidationOutcome(taskId, stage, taskAccessor, brainAccessor)`
- `suggestGateFocus(taskId, taskAccessor, brainAccessor)`
- `scoreVerificationConfidence(taskId, verification, taskAccessor, brainAccessor)`
- `extractPatternsFromHistory(taskAccessor, brainAccessor, options)`
- `matchPatterns(taskId, taskAccessor, brainAccessor)`

All require both a `DataAccessor` and a `BrainDataAccessor`. Use the same accessor
construction pattern as in `packages/cleo/src/dispatch/lib/engine.ts`:

```typescript
import { getAccessor } from '../lib/engine.js';
import { getBrainAccessor } from '@cleocode/core/internal';
const accessor = await getAccessor(root);
const brain = await getBrainAccessor(root);
```

### 3.5 Domain Registration

In `packages/cleo/src/dispatch/domains/index.ts`, add:

```typescript
import { IntelligenceHandler } from './intelligence.js';
// ...
handlers.set('intelligence', new IntelligenceHandler());
```

### 3.6 Register CLI Command

In `packages/cleo/src/cli/index.ts` (or wherever commands are registered):

```typescript
import { registerIntelligenceCommand } from './commands/intelligence.js';
// ...
registerIntelligenceCommand(program);
```

---

## 4. Proactive Suggestion Triggers and Delivery

### 4.1 Trigger: Task Start (PreToolUse)

**Where**: Add a new handler inside
`packages/core/src/hooks/handlers/task-hooks.ts` or a new sibling file
`packages/core/src/hooks/handlers/intelligence-hooks.ts`.

**Logic**:

```typescript
// intelligence-hooks.ts

export async function handleTaskStartIntelligence(
  projectRoot: string,
  payload: PreToolUsePayload,
): Promise<void> {
  if (!payload.taskId) return;

  const [accessor, brain] = await Promise.all([
    getAccessor(projectRoot),
    getBrainAccessor(projectRoot),
  ]);

  const risk = await calculateTaskRisk(payload.taskId, accessor, brain);

  if (risk.riskScore >= 0.6) {
    // Surface warning via brain observation (picked up by memory-bridge)
    await brain.addObservation({
      id: `O-risk-${payload.taskId}-${Date.now()}`,
      type: 'change',
      title: `HIGH RISK: Task ${payload.taskId} (score: ${risk.riskScore})`,
      subtitle: risk.recommendation,
      narrative: risk.factors.map(f => `${f.name}: ${f.value}`).join(' | '),
      // ... standard fields
    });
  }
}

hooks.register({
  id: 'intelligence-task-start',
  event: 'PreToolUse',
  handler: handleTaskStartIntelligence,
  priority: 80,   // Before brain-tool-start (100) so risk runs first
});
```

### 4.2 Trigger: Before Verify (PreToolUse with toolName='verify')

The `PreToolUse` payload includes `toolName`. When `toolName === 'verify'`, call
`suggestGateFocus()` and write the suggestions to a brain observation. The agent reads
the suggestions on the next memory bridge refresh.

```typescript
export async function handlePreVerifyIntelligence(
  projectRoot: string,
  payload: PreToolUsePayload,
): Promise<void> {
  if (payload.toolName !== 'verify' || !payload.taskId) return;

  const [accessor, brain] = await Promise.all([
    getAccessor(projectRoot),
    getBrainAccessor(projectRoot),
  ]);

  const suggestion = await suggestGateFocus(payload.taskId, accessor, brain);

  await brain.addObservation({
    id: `O-gatef-${payload.taskId}-${Date.now()}`,
    type: 'discovery',
    title: `Gate focus for ${payload.taskId} (confidence: ${suggestion.overallConfidence})`,
    subtitle: suggestion.tips.join(' | '),
    narrative: suggestion.gateFocus
      .filter(g => g.priority === 'high')
      .map(g => `${g.gate}: ${g.rationale}`)
      .join('\n'),
    // ... standard fields
  });
}
```

### 4.3 Trigger: Error Occurs (PostToolUseFailure)

The existing `error-hooks.ts` (`packages/core/src/hooks/handlers/error-hooks.ts`)
already writes to brain on errors. Extend it with healing suggestion retrieval:

```typescript
// After existing observeBrain call in error-hooks.ts:
const healing = await getSelfHealingSuggestions(agentType, taskType, projectRoot);
if (healing.length > 0) {
  // Append top suggestion to the brain observation
  // OR write as a separate brain_observation
}
```

Where `agentType` and `taskType` are derived from the error payload domain/operation
fields.

### 4.4 Suggestion Delivery Mechanism

All suggestions are written to `brain_observations` in brain.db. The memory bridge
(`packages/core/src/hooks/handlers/memory-bridge-refresh.ts`) regenerates
`.cleo/memory-bridge.md` after each session event. Agents read this file at session
start — it is `@`-referenced in `AGENTS.md`.

For non-tool-use providers that cannot run hooks directly (Cursor, Gemini, Kimi K2),
the suggestion delivery path is identical: they read `.cleo/memory-bridge.md` on session
start. The suggestions written by hook handlers are present in that file after the next
refresh cycle.

There is no separate suggestion channel — brain.db is the universal bus.

---

## 5. Feedback Loop Data Model

### 5.1 Event Lifecycle

```
Task executed (success or failure)
  ↓
cleo complete <taskId>  OR  crash detected by watchdog
  ↓
PostToolUse / PostToolUseFailure hook fires
  ↓
processAgentLifecycleEvent(event, projectRoot) called
  ↓
  brain_decisions: tactical entry (AGT-{hex})
  brain_patterns:  failure pattern upserted (P-agt-{hex})
  brain_observations: healing strategy at frequency >= 3 (O-agt-{hex})
  ↓
Next orchestrateSpawnExecute call
  ↓
findLeastLoadedAgent(targetAgentType, root)
    reads agent_instances table (tasks.db)
    returns agent with highest capacity
  ↓
Agent routing informed by current load
```

### 5.2 Data Fields Fed to Learning

The `AgentExecutionEvent` struct (defined in `execution-learning.ts`) captures:

| Field | Source | Used For |
|-------|--------|----------|
| `agentId` | `agent_instances.id` | Trace which instance failed |
| `agentType` | `agent_instances.agent_type` | Pattern: type X fails on Y |
| `taskId` | Task being executed | Link failure to task |
| `taskType` | `tasks.type` column | Pattern grouping |
| `taskLabels` | `tasks.labels` | Richer pattern matching |
| `outcome` | success / failure / partial | Signal direction |
| `errorMessage` | caught exception `.message` | Mitigation wording |
| `errorType` | `classifyError(err)` from `registry.ts` | Retry decision |
| `sessionId` | Current session ID | Lineage |
| `durationMs` | `Date.now() - startTime` | Performance tracking |

### 5.3 How Routing Reads Learning

`findLeastLoadedAgent()` currently reads `agent_instances` by capacity field (float
string). The next phase (T549-CA5 or later) should extend routing to also consult
`brain_patterns` for agent-type failure rates:

```
SELECT agentType, AVG(successRate) AS rate
FROM brain_patterns
WHERE type = 'failure'
  AND pattern LIKE 'Agent type "%" fails on task type "%"'
GROUP BY agentType
ORDER BY rate DESC
LIMIT 1
```

For the current wiring scope (T549-CA4), routing uses capacity only. The brain pattern
data is written and available; reading it for routing is the next iteration.

---

## 6. Integration with Tiered Memory

### 6.1 Memory Tier Mapping

| Tier | Storage | Self-Healing Use | Intelligence Use |
|------|---------|-----------------|-----------------|
| Short-term (session-scoped) | session notes, current task | Active crash recovery state, watchdog tick count | Task risk warnings for current session |
| Medium-term (brain.db episodic) | `brain_observations`, `brain_decisions` | Crash events, recovery outcomes per session | Gate focus suggestions, per-task risk observations |
| Medium-term (brain.db procedural) | `brain_patterns`, `brain_learnings` | Failure patterns (P-agt-*), healing strategies (O-agt-*) | Validation outcome patterns, error-to-fix mappings |
| Long-term (brain.db semantic) | `brain_learnings` with high confidence | Stable routing rules: "type X crashes on Y" | Proven gate patterns: "security tasks need securityPassed first" |

### 6.2 Read Paths

The watchdog reads from `tasks.db` only (agent_instances table via `detectCrashedAgents`,
`listAgentInstances`). It writes crash observations to brain.db via
`processAgentLifecycleEvent`.

Intelligence functions (`calculateTaskRisk`, `suggestGateFocus`, etc.) read from BOTH
databases:
- `tasks.db` via `DataAccessor` (task details, deps, children, status)
- `brain.db` via `BrainDataAccessor` (patterns, learnings, decisions)

They never write directly — all writes go through `processAgentLifecycleEvent` or the
observation helpers.

### 6.3 No New Tables Required

All self-healing and intelligence data fits the existing schema:
- `brain_decisions`: execution events (AGT- prefix)
- `brain_patterns`: failure patterns (P-agt- prefix), gate risk patterns
- `brain_observations`: crash events, healing strategies, risk warnings
- `brain_learnings`: extracted insights from verification confidence
- `agent_instances` (tasks.db): current capacity, heartbeat, status

---

## 7. Multi-Harness Considerations

### 7.1 Heartbeat Mechanism

`recordHeartbeat(agentId, cwd)` writes `last_heartbeat` to `agent_instances` in tasks.db.
This is database-level, not provider-specific. Any agent running in any harness (Claude
Code, Cursor, Gemini CLI, Kimi K2) can call `cleo agent heartbeat <agentId>` from the
CLI to record liveness.

The CLI command already exists: `cleo agent heartbeat` dispatches `agents.heartbeat`.
No harness-specific work is needed for the heartbeat mechanism itself.

### 7.2 Recovery Across Providers

`recoverCrashedAgents` resets agent status to `'starting'`. The orchestrator (running
in its own process/harness) then re-assigns the task. The reassigned agent can be from
any provider — `findLeastLoadedAgent` is provider-agnostic (it queries capacity, not
provider type).

If the original crashed agent was a Claude Code agent and no Claude Code agents have
capacity, the orchestrator's existing `orchestrateSpawnSelectProvider` can pick a
different provider. No additional wiring is needed here.

### 7.3 Suggestion Delivery for Non-Tool-Use Providers

Providers that do not support the CAAMP hook event system (e.g., non-Claude providers
accessed via raw prompting) cannot receive inline hook payloads. For these providers:

1. Suggestions are written to `brain_observations` by hook handlers.
2. `memory-bridge.md` is refreshed at the next session boundary.
3. The agent reads `memory-bridge.md` at session start — this is the only delivery
   channel guaranteed to work across all providers.

For tool-use-capable providers (Claude Code, Gemini with function calling), hooks fire
in-process and suggestions can be surfaced immediately via `brain_observations` without
waiting for the next memory bridge refresh.

---

## 8. Implementation Plan

Wire in this order to minimize risk and enable incremental testing:

### Phase 1: Intelligence CLI (zero production risk, pure additive)

1. Create `packages/cleo/src/dispatch/domains/intelligence.ts` (IntelligenceHandler).
2. Wire `getBrainAccessor` and `getAccessor` in the handler's query methods.
3. Create `packages/cleo/src/cli/commands/intelligence.ts`.
4. Register handler in `packages/cleo/src/dispatch/domains/index.ts`.
5. Register command in `packages/cleo/src/cli/index.ts`.
6. Run `pnpm biome check --write .` then `pnpm run build` then `pnpm run test`.
7. Smoke test: `cleo intelligence predict --task T549` should return risk assessment.

### Phase 2: Intelligence Hooks (additive, best-effort)

1. Create `packages/core/src/hooks/handlers/intelligence-hooks.ts`.
2. Register `handleTaskStartIntelligence` on `PreToolUse` (priority 80).
3. Add import to `packages/core/src/hooks/handlers/index.ts`.
4. Extend `error-hooks.ts` with healing suggestion retrieval (additive, lines appended).
5. Run quality gates.
6. Verify: after `cleo start` then `cleo focus <taskId>`, brain.db should gain an
   observation with `O-risk-` prefix if task has risk >= 0.6.

### Phase 3: Watchdog Scheduler (session-scoped, reversible)

1. Create `packages/core/src/hooks/handlers/watchdog-hooks.ts`.
2. Implement `runWatchdogTick`, `handleWatchdogStart`, `handleWatchdogStop`.
3. Register `SessionStart` (priority 50) and `SessionEnd` (priority 50) handlers.
4. Add import to `packages/core/src/hooks/handlers/index.ts`.
5. Run quality gates.
6. Verify: start a session, check that `onPatrol` hook fires after 60s (use a test with
   a short interval override).

### Phase 4: Routing Integration (surgical change to orchestrate-engine.ts)

1. Run `gitnexus_impact({target: "orchestrateSpawnExecute", direction: "upstream"})`
   before touching the file.
2. If risk is HIGH or CRITICAL, report to owner before proceeding.
3. Add capacity check block in `orchestrateSpawnExecute` after readiness validation.
4. Ensure fallback (no agents = proceed without routing hint) is intact.
5. Add `E_SPAWN_CAPACITY_EXHAUSTED` to error catalog if not present.
6. Run quality gates.
7. Verify: with zero registered agents, `cleo orchestrate spawn-execute <taskId>` must
   still succeed (fallback path).

### Phase 5: Feedback Loop Verification

1. Trigger a task failure via a test agent.
2. Verify `brain_decisions` gains an `AGT-` prefixed entry.
3. Trigger the same failure type 3 times.
4. Verify `brain_patterns` gains a `P-agt-` entry with `frequency >= 3`.
5. Verify `brain_observations` gains an `O-agt-` healing strategy entry.
6. Run `cleo intelligence learn-errors` and confirm the pattern appears.

---

## 9. File Change Summary

| File | Action | Phase |
|------|--------|-------|
| `packages/cleo/src/dispatch/domains/intelligence.ts` | Create | 1 |
| `packages/cleo/src/dispatch/domains/index.ts` | Edit: add IntelligenceHandler | 1 |
| `packages/cleo/src/cli/commands/intelligence.ts` | Create | 1 |
| `packages/cleo/src/cli/index.ts` | Edit: registerIntelligenceCommand | 1 |
| `packages/core/src/hooks/handlers/intelligence-hooks.ts` | Create | 2 |
| `packages/core/src/hooks/handlers/index.ts` | Edit: add import | 2, 3 |
| `packages/core/src/hooks/handlers/error-hooks.ts` | Edit: add healing call | 2 |
| `packages/core/src/hooks/handlers/watchdog-hooks.ts` | Create | 3 |
| `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` | Edit: capacity check | 4 |
| `packages/core/src/internal.ts` | Edit: export capacity functions if missing | 4 |

---

## 10. Acceptance Criteria

- `cleo intelligence predict --task <id>` returns a JSON risk assessment with `riskScore`,
  `confidence`, `factors[]`, and `recommendation`.
- `cleo intelligence suggest --task <id>` returns `gateFocus[]` ordered by priority.
- `cleo intelligence learn-errors` returns `DetectedPattern[]` from task history.
- After a session starts, brain.db gains a risk observation for any task with risk >= 0.6
  when `cleo focus <taskId>` is called.
- After 60 seconds of an active session, the `onPatrol` hook fires with
  `patrolType: 'health'`.
- `cleo orchestrate spawn-execute <taskId>` fails with `E_SPAWN_CAPACITY_EXHAUSTED` when
  all agents are saturated (capacity sum < 0.1), and succeeds when no agents are
  registered (fallback).
- A task failure writes to `brain_decisions` (AGT-prefix) within the same session.
- Three identical failures write a `brain_patterns` entry (P-agt-prefix) with
  `frequency: 3` and a non-null `mitigation`.
