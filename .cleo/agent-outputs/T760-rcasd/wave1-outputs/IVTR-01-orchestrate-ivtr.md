# IVTR-01: cleo orchestrate ivtr — Orchestration Harness

**Task**: T811  
**Epic**: T810 — EPIC P0: IVTR multi-agent enforcement  
**Status**: complete  
**Date**: 2026-04-16

---

## Summary

Implements the foundational IVTR orchestration harness: a per-task state machine that enforces the Implement → Validate → Test → Release phase sequence. One Implementation agent CANNOT self-attest completion; the harness requires explicit evidence from three separate phase agents before `releaseIvtr` marks the task done.

---

## Deliverables

### 1. Business Logic Module

`packages/core/src/lifecycle/ivtr-loop.ts`

**Exported API:**

```ts
export type IvtrPhase = 'implement' | 'validate' | 'test' | 'released';

export interface IvtrPhaseEntry {
  phase: IvtrPhase;
  agentIdentity: string | null;
  startedAt: string;
  completedAt: string | null;
  passed: boolean | null;
  evidenceRefs: string[];   // sha256 hashes into .cleo/attachments
  reason?: string;          // loop-back failure note
}

export interface IvtrState {
  taskId: string;
  currentPhase: IvtrPhase;
  phaseHistory: IvtrPhaseEntry[];
  startedAt: string;
}

export async function startIvtr(taskId, options?): Promise<IvtrState>
export async function advanceIvtr(taskId, evidence, options?): Promise<IvtrState>
export async function loopBackIvtr(taskId, toPhase, reason, evidence, options?): Promise<IvtrState>
export async function releaseIvtr(taskId, options?): Promise<{ released: boolean; failures? }>
export async function getIvtrState(taskId, options?): Promise<IvtrState | null>
export function resolvePhasePrompt(taskId, state, title, desc): string
```

### 2. Dispatch Domain

`packages/cleo/src/dispatch/domains/ivtr.ts` — `IvtrHandler implements DomainHandler`

Registered in `OrchestrateHandler` via delegation (same pattern as ConduitHandler).

| Operation | Gateway | Description |
|-----------|---------|-------------|
| `ivtr.status` | query | Current phase + evidence list + history |
| `ivtr.start` | mutate | Begin implement phase, return resolved prompt |
| `ivtr.next` | mutate | Advance phase, close evidence, open next entry |
| `ivtr.release` | mutate | Final gate: require I+V+T passing, mark done |
| `ivtr.loop-back` | mutate | Rewind to earlier phase with failure evidence |

### 3. CLI Surface

```
cleo orchestrate ivtr <taskId> --start [--agent <identity>]
cleo orchestrate ivtr <taskId> --next [--evidence <sha256s>]
cleo orchestrate ivtr <taskId> --status
cleo orchestrate ivtr <taskId> --release
cleo orchestrate ivtr <taskId> --loop-back --phase <impl|validate|test> --reason "..."
```

### 4. Schema Migration

`packages/core/migrations/drizzle-tasks/20260416000001_t811-ivtr-state/migration.sql`

```sql
ALTER TABLE `tasks` ADD COLUMN `ivtr_state` text;
```

`ivtr_state` is nullable JSON (`IvtrState | null`). NULL = loop not started.

### 5. Exports

Added to `packages/core/src/internal.ts`:

```ts
export type { IvtrPhase, IvtrPhaseEntry, IvtrState } from './lifecycle/ivtr-loop.js';
export { advanceIvtr, getIvtrState, loopBackIvtr, releaseIvtr, resolvePhasePrompt, startIvtr }
  from './lifecycle/ivtr-loop.js';
```

---

## State Machine Diagram (ASCII)

```
                           ┌─────────────────────────────────────┐
                           │          IVTR State Machine          │
                           └─────────────────────────────────────┘

          startIvtr()
  (none) ──────────────► implement
                              │
                    advanceIvtr(evidence)
                              │
                              ▼
                          validate
                              │
                    advanceIvtr(evidence)
                              │
                              ▼
                            test
                              │
                    advanceIvtr(evidence)
                              │
                              ▼
                          released ──► releaseIvtr() ──► task.status = done

  (Any non-released phase)
  loopBackIvtr(toPhase, reason, evidence)
  ──────────────────────────────────────────────────────► implement
                                                           validate
                                                           test

  Loop-back closes current active entry as passed=false,
  appends new entry for target phase with reason annotation.
```

---

## Example Prompt Resolution

When `cleo orchestrate ivtr T811 --start` is called, the resolved prompt returned contains:

```
# IVTR Agent Prompt — T811: <task title>
Phase: **IMPLEMENT**

## Task Specification
<description from task.description>

## Prior Phase Evidence
(none — first phase)

## Phase: Implement
You are the Implementation agent for task T811.
1. Read the task spec below in full.
2. Write, modify, or extend code to satisfy the acceptance criteria.
3. Run quality gates: pnpm biome check --write . then pnpm run build.
4. Produce a git diff or file list as evidence.
5. Report your sha256 attachment refs as evidence when you call
   cleo orchestrate ivtr T811 --next.
```

After Implement passes and `--next` is called with evidence refs:

```
# IVTR Agent Prompt — T811: <task title>
Phase: **VALIDATE**

## Prior Phase Evidence (sha256 attachment refs)
- <sha256-from-implement>

## Phase: Validate
You are the Validation agent for task T811.
1. Read the task spec and the prior-phase evidence refs listed above.
2. Retrieve each evidence attachment via cleo docs show <sha256>.
3. Verify spec↔code alignment: every acceptance criterion must be traceable.
4. Produce an EvidenceRecord: { passed: boolean, details: string, gaps: string[] }.
...
```

---

## Test Coverage

| File | Tests | Result |
|------|-------|--------|
| `packages/core/src/lifecycle/__tests__/ivtr-loop.test.ts` | 18 | PASS |
| `packages/cleo/src/dispatch/domains/__tests__/ivtr.test.ts` | 16 | PASS |

State machine assertions verified:
- `start → implement` (happy path entry)
- `implement → validate → test → released` (full happy path)
- `loopBack(test→implement)` records failure + opens new implement entry
- `releaseIvtr` fails when any phase has no passing entry
- `startIvtr` is idempotent
- LAFS envelope shape correct for all 5 operations
- `E_INVALID_INPUT`, `E_NOT_FOUND`, `E_IVTR_GATE_FAILED` error codes verified

---

## Build Status

- `pnpm --filter @cleocode/core exec tsc --noEmit`: 0 ivtr-related errors
- `pnpm --filter @cleocode/cleo exec tsc --noEmit`: 0 ivtr-related errors
- Pre-existing errors in `attachment-store.ts`, `gate-runner.ts`, `task-engine.ts` (contracts missing types) are unrelated to this task
- All 34 new tests pass

---

## Scope Boundary (Not Implemented — Deferred to IVTR-02 through IVTR-06)

- Validate-phase auto-spawn (IVTR-02)
- Test-phase auto-spawn (IVTR-03)
- Loop-back max-retry logic (IVTR-04)
- `cleo complete` strict-mode enforcement (IVTR-05)
- EvidenceRecord typed schema (IVTR-06)
