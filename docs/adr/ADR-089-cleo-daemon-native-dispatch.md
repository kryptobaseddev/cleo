# ADR-089: Cleo Daemon — Native Autonomous Dispatch for Saga Lifecycles

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Saga** | T10401 (SG-HARNESS-DAEMON-IPC) |
| **Epic** | T10400 (E-CLEO-SDK-API) |
| **Author** | Prime (post-mortem of T10538) |
| **Date** | 2026-05-26 |
| **Supersedes** | Hermes Kanban as primary dispatch surface for CLEO sagas |
| **Related** | ADR-047 (GC Daemon), ADR-054 (Sentient Loop), ADR-055 (Worktree), ADR-057/058 (Core API Migration), ADR-062 (Worktree Merge), ADR-079 (AC Binding), ADR-083 (Saga Task Type) |

---

## 1. Context & Motivation

### 1.1 The T10538 Post-Mortem

Saga T10538 (SG-ARCH-SOLID, 76 tasks) proved that CLEO's task model, gate system, and worktree isolation work. However, the orchestration layer — the part that should auto-dispatch, monitor, and reconcile — was outsourced to Hermes Kanban, which was never designed for CLEO's source-of-truth model.

**Critical failures requiring Prime intervention on ~30% of tasks:**

| Issue | Occurrences | Root Cause |
|-------|-------------|------------|
| Workers committed code that didn't build | T10631 | No pre-merge CI gate on worktree branches |
| Workers skipped AC evidence bindings | T10572, T10631, T10637 | `cleo complete` requires explicit AC→evidence binding; workers don't always wire it |
| Worker merged to main but didn't run `cleo verify` | T10637 | Worker assumed merge == done |
| Worker committed test evidence but file was stale | T10631 | Race between code commit and evidence capture |

**Systemic hurdles:**

1. **Kanban dispatch is fundamentally broken for this workload.** The gateway daemon (PID 737736) actively reverts any state change it doesn't agree with. Promote card → "Promoted to ready ✓" → <500ms later gateway checks CLEO → "status=pending, gates=false" → reverts to todo.
2. **Seed script created wrong parent links.** Epic cards linked as parents of child task cards created recursive blocking: `T10548(E10 epic, blocked) → T10636(depends on epic) → T10637(depends on T10636)` — all blocked because parent epic is blocked.
3. **Kanban DB corruption.** 100+ `.corrupt.*.bak` files from concurrent writes. Recovery required `sqlite3 kanban.db ".recover"`.
4. **CLEO complete requires manual AC bindings.** Even with all 3 gates green, `cleo complete` rejects with "3 acceptance criteria have no evidence bindings." Workers don't create these.
5. **Workers exhaust iteration budgets.** T10624 and T10629 hit the 200-iteration budget on first attempt.

### 1.2 Core Thesis

> **The CLI is too deep and too manual to be the primary interaction surface for autonomous agentic flows. CLEO needs a native daemon that owns the dispatch loop, with a clean, typesafe CORE API as the canonical interface.**

The CLI (`cleo orchestrate spawn`, `cleo complete`, etc.) is an extension of the CORE API, not its replacement. The daemon consumes the CORE API. Humans and external systems consume the daemon's status surface or the CLI thin-wrapper.

---

## 2. Goals

1. **Native Cleo Daemon**: Owns dispatch loop, run history, event audit, notification channels.
2. **CORE API First**: All operations exposed through `packages/core`, types shared via `packages/contracts`.
3. **Typesafe End-to-End**: No `any`, no untyped JSON blobs in the daemon→core path.
4. **Steal from Kanban, Drop the Conflicts**: Keep assignee/profiles, run history, event audit, heartbeat, resource caps. Drop gateway auto-revert (CLEO is source-of-truth).
5. **Auto-Close the Verify/Complete Cycle**: Auto-create AC bindings when gates are green. Auto-verify. Auto-complete when all gates pass.
6. **Programmatic TOOLS for CLEO**: Canonical system operations as deterministic tools, not CLI commands.

---

## 3. Non-Goals

1. **Replace Hermes Kanban entirely.** Kanban remains useful for cross-project, cross-tool workflows that don't map to CLEO tasks.
2. **Build a new task model.** The existing `tasks.db` schema (with PM-Core V2 saga/epic/task/subtask containment) is correct.
3. **Replace the existing worktree subsystem.** `packages/worktree` stays; the daemon consumes it via `orchestrateSpawn`.
4. **Build a new harness system.** T10401's harness/gateway work is complementary; the daemon runs *as* a harness.

---

## 4. Architectural Design

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Cleo Daemon (Node.js process)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ DispatchEngine│  │ ClaimManager │  │ SpawnManager │  │ MonitorEngine    │ │
│  │ (poll loop)   │  │ (atomicity)  │  │ (orchestrate │  │ (heartbeat/      │ │
│  │               │  │              │  │  spawn wrap) │  │  reclaim/timeout)│ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘ │
│         │                 │                  │                    │           │
│         └─────────────────┴──────────────────┴────────────────────┘           │
│                                    │                                         │
│  ┌─────────────────────────────────┼─────────────────────────────────────┐  │
│  │         CORE API (packages/core) │                                     │  │
│  │  ┌─────────────┐  ┌─────────────┼──┐  ┌─────────────┐  ┌───────────┐ │  │
│  │  │ tasks.claim │  │ tasks.release│  │  │ daemon.start│  │daemon.stop│ │  │
│  │  │ tasks.list  │  │ tasks.complete │  │  │ daemon.status│  │daemon.log │ │  │
│  │  │ tasks.verify│  │ tasks.show     │  │  │ runs.getHistory│ │events.get │ │  │
│  │  └─────────────┘  └─────────────┘  │  └─────────────┘  └───────────┘ │  │
│  │                                    │                                     │  │
│  │  ┌─────────────────────────────────┘                                     │  │
│  │  │  orchestrate.ready  orchestrate.spawn  orchestrate.waves             │  │
│  │  │  orchestrate.status orchestrate.context orchestrate.validate         │  │
│  │  └────────────────────────────────────────────────────────────────────  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│  ┌─────────────────────────────────┼─────────────────────────────────────┐  │
│  │      Conduit Pub/Sub            │                                     │  │
│  │  ├─ Telegram: task completed, approval needed                        │  │
│  │  ├─ Discord: same                                                   │  │
│  │  └─ Webhook: CI/CD triggers                                         │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │         tasks.db (SQLite)      │
                    │  ┌─────────┐ ┌─────────────┐  │
                    │  │  tasks  │ │ task_runs   │  │
                    │  │(exists) │ │ (new)       │  │
                    │  └─────────┘ └─────────────┘  │
                    │  ┌─────────┐ ┌─────────────┐  │
                    │  │task_events│ │agent_profiles│  │
                    │  │ (new)   │ │ (new)       │  │
                    │  └─────────┘ └─────────────┘  │
                    │  ┌─────────┐ ┌─────────────┐  │
                    │  │task_skills│ │evidence_ac_ │  │
                    │  │ (new)   │ │ bindings    │  │
                    │  └─────────┘ └─────────────┘  │
                    └─────────────────────────────────┘
```

### 4.2 Daemon Components

#### 4.2.1 DispatchEngine

The core polling loop. Replaces the Hermes Kanban dispatcher.

```typescript
interface DispatchEngine {
  /** Start polling for ready tasks in a saga. */
  start(sagaId: string, options: DispatchOptions): Promise<void>;
  /** Stop polling. */
  stop(): Promise<void>;
  /** Current status of the dispatch loop. */
  status(): DispatchStatus;
}

interface DispatchOptions {
  /** Polling interval in ms. Default: 30000 (30s). */
  pollIntervalMs?: number;
  /** Max concurrent workers. Default: 3. */
  maxConcurrent?: number;
  /** Max spawns per poll cycle. Default: 2. */
  maxSpawnPerCycle?: number;
  /** Auto-complete when all gates green. Default: true. */
  autoComplete?: boolean;
  /** Auto-verify on worker completion. Default: true. */
  autoVerify?: boolean;
  /** Default agent profile for tasks without assignee. */
  defaultProfile?: string;
}

interface DispatchStatus {
  state: 'idle' | 'polling' | 'paused' | 'stuck';
  sagaId: string;
  claimedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
}
```

**Poll loop algorithm:**

```
1. cleo orchestrate ready <sagaId> → readyTasks
2. For each ready task (up to maxSpawnPerCycle):
   a. Atomic claim: UPDATE tasks SET status='claimed', claimed_by=<profile>,
      claimed_at=now WHERE id=? AND status='pending'
   b. If claim failed (row count 0), skip (another daemon or manual claim won)
   c. Record task_event: 'claimed'
   d. Resolve agent profile (task.assignee_profile || defaultProfile)
   e. cleo orchestrate spawn <taskId> with profile config
   f. Record task_run: pid, started_at, profile, status='running'
3. Monitor loop (parallel):
   a. For each running task_run:
      - Check heartbeat (task_runs.heartbeat_at)
      - If heartbeat > 5min ago: reclaim (status='reclaimed', record event)
      - If process exited: check exit code, update task_run outcome
   b. Auto-verify: if worker exited 0 and autoVerify=true:
      - Run cleo verify <taskId> for each required gate
      - If all gates green and autoComplete=true:
        - Auto-create AC bindings (coverage type) for unbound ACs
        - Run cleo complete <taskId>
4. Sleep pollIntervalMs, goto 1
```

#### 4.2.2 ClaimManager

Handles atomic task claiming. Uses SQLite `BEGIN IMMEDIATE` for row-level locking.

```typescript
interface ClaimManager {
  /** Atomically claim a task for a profile. Returns false if already claimed. */
  claim(taskId: string, profileId: string): Promise<boolean>;
  /** Release a claimed task back to pending. */
  release(taskId: string, reason?: string): Promise<void>;
  /** Reclaim a stale task (heartbeat timeout). */
  reclaim(taskId: string): Promise<boolean>;
}
```

**Claim SQL:**
```sql
BEGIN IMMEDIATE;
UPDATE tasks 
SET status = 'claimed', 
    assignee = ?,
    updated_at = datetime('now')
WHERE id = ? 
  AND status = 'pending';
-- If changes() = 1, claim succeeded; else rollback.
COMMIT;
```

**Important:** The `tasks` table already has `assignee` (line 210 in `tasks.ts`). We need to add `claimed_at` and possibly rename `assignee` semantics: `assignee` is the *intended* profile (set at creation), `claimed_by` is the *actual* claim (set by daemon). For simplicity, we can overload `assignee` to mean "currently claimed by" when `status='claimed'`, and add `claimed_at`.

#### 4.2.3 SpawnManager

Wraps `orchestrateSpawn` with profile/skill injection.

```typescript
interface SpawnManager {
  /** Spawn a worker for a task with the given profile. */
  spawn(taskId: string, profile: AgentProfile): Promise<SpawnResult>;
}

interface SpawnResult {
  pid: number;
  worktreePath: string;
  startedAt: string;
}
```

The SpawnManager:
1. Loads the agent profile from `agent_profiles` table.
2. Resolves skills from `task_skills` join table.
3. Calls `orchestrateSpawn` with `protocolType`, `tier`, and `spawnScope` derived from profile.
4. Records the PID and worktree path in `task_runs`.

#### 4.2.4 MonitorEngine

Tracks running workers via heartbeat and process polling.

```typescript
interface MonitorEngine {
  /** Register a heartbeat from a worker. */
  heartbeat(runId: string): Promise<void>;
  /** Check all running tasks for staleness. */
  checkStale(timeoutMs: number): Promise<StaleTask[]>;
  /** Wait for a task run to complete. */
  waitForCompletion(runId: string, timeoutMs: number): Promise<TaskRun>;
}

interface StaleTask {
  runId: string;
  taskId: string;
  lastHeartbeatAt: string;
  elapsedMs: number;
}
```

**Heartbeat mechanism:**
- Workers write to `task_runs.heartbeat_at` every 30s.
- Daemon checks `heartbeat_at > now - timeoutMs` (default 5min).
- If stale: daemon sends SIGTERM, waits 10s, then SIGKILL. Updates `task_runs.status='timed_out'`, creates `task_event` with type='reclaimed'.

#### 4.2.5 VerificationEngine

Auto-runs verification gates and completes tasks.

```typescript
interface VerificationEngine {
  /** Auto-verify all required gates for a task. */
  autoVerify(taskId: string): Promise<VerifyResult>;
  /** Auto-complete a task if all gates pass. */
  autoComplete(taskId: string): Promise<CompleteResult>;
}
```

**Auto-verify logic:**
1. Load task's `verification_json`.
2. For each required gate (from config `verification.requiredGates`):
   - Re-run the gate's evidence validation.
   - If stale, return `stillValid=false`.
3. If all gates green: proceed to auto-complete.

**Auto-complete logic (T10644 — already partially implemented):**
1. Check AC coverage (`computeAcCoverage`).
2. If unbound ACs exist and all gates green: auto-create `coverage` bindings (lines 639-657 in `complete.ts` already do this).
3. Call `completeTask` with the task accessor.
4. Record `task_event` with type='completed'.

**Note:** The auto-coverage binding code at lines 639-657 in `complete.ts` is the fix for "Workers skip AC evidence bindings." It was added in T10644. We need to ensure it fires reliably in the daemon path.

#### 4.2.6 NotificationEngine

Publishes events via Conduit.

```typescript
interface NotificationEngine {
  /** Publish a task completion event. */
  publishTaskCompleted(taskId: string, run: TaskRun): Promise<void>;
  /** Publish an approval-needed event (HITL gate). */
  publishApprovalNeeded(taskId: string, gate: string): Promise<void>;
  /** Publish a task failure event. */
  publishTaskFailed(taskId: string, run: TaskRun, error: string): Promise<void>;
}
```

Conduit subscribers (existing `packages/core/src/store/conduit-schema.ts`):
- Telegram bot
- Discord webhook
- Custom webhooks for CI/CD

---

## 5. Database Schema Additions

### 5.1 New Tables

```sql
-- === AGENT PROFILES ===
-- Stores configuration for each agent profile that can claim tasks.
CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,        -- e.g. 'openai', 'anthropic', 'local'
  model TEXT NOT NULL,           -- e.g. 'gpt-4o', 'claude-sonnet-4'
  skills TEXT,                   -- JSON array of skill names
  max_iterations INTEGER DEFAULT 400,
  timeout_seconds INTEGER DEFAULT 600,
  config_json TEXT,              -- Profile-specific config blob
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

-- === TASK RUNS ===
-- Every spawn of a worker creates a row here. Append-only.
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,           -- UUIDv4
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  profile TEXT NOT NULL,         -- agent_profiles.id
  status TEXT NOT NULL,          -- 'running' | 'completed' | 'crashed' | 'timed_out' | 'cancelled'
  worker_pid INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  heartbeat_at TEXT,
  outcome TEXT,                  -- 'done' | 'blocked' | 'crashed' | 'timed_out' | 'cancelled'
  summary TEXT,                  -- Worker completion summary
  evidence_json TEXT,            -- JSON array of evidence atoms produced
  error TEXT,                    -- Error message if failed
  iteration_count INTEGER,
  worktree_path TEXT,
  -- Idempotency: prevent double-dispatch of same task+profile+start time
  UNIQUE(task_id, profile, started_at)
);

-- === TASK EVENTS ===
-- Audit log of every claim, reclaim, promote, block, complete, comment.
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,           -- UUIDv4
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,      -- 'claimed' | 'reclaimed' | 'promoted' | 'blocked' | 'completed' | 'comment' | 'spawned' | 'verified' | 'released'
  author TEXT NOT NULL,          -- agent ID or 'system' or 'human'
  body TEXT,                     -- Free-form text (for comments, block reasons)
  metadata_json TEXT,            -- Structured metadata
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- === TASK SKILLS ===
-- Which skills to load for a given task.
CREATE TABLE task_skills (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  PRIMARY KEY (task_id, skill_name)
);
```

### 5.2 Alterations to Existing Tables

```sql
-- Add claim timestamp to tasks
ALTER TABLE tasks ADD COLUMN claimed_at TEXT;

-- Add assignee_profile FK to tasks (separate from assignee which is the current claim)
-- NOTE: tasks.assignee already exists (line 210 in tasks.ts). 
-- We repurpose it: when status='claimed', assignee = claiming profile.
-- When status='pending', assignee = intended profile (or NULL).
-- For clarity, we could rename, but ALTER TABLE RENAME COLUMN in SQLite is fine.
-- Alternative: keep assignee as-is, add intended_profile column.
ALTER TABLE tasks ADD COLUMN intended_profile TEXT REFERENCES agent_profiles(id);
```

### 5.3 Drizzle Schema (TypeScript)

New file: `packages/core/src/store/schema/agent-profiles.ts`

```typescript
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const agentProfiles = sqliteTable('agent_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  skills: text('skills'), // JSON array
  maxIterations: integer('max_iterations').default(400),
  timeoutSeconds: integer('timeout_seconds').default(600),
  configJson: text('config_json'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at'),
});

export type AgentProfileRow = typeof agentProfiles.$inferSelect;
export type NewAgentProfileRow = typeof agentProfiles.$inferInsert;
```

New file: `packages/core/src/store/schema/task-runs.ts`

```typescript
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';
import { agentProfiles } from './agent-profiles.js';

export const TASK_RUN_STATUSES = ['running', 'completed', 'crashed', 'timed_out', 'cancelled'] as const;
export const TASK_RUN_OUTCOMES = ['done', 'blocked', 'crashed', 'timed_out', 'cancelled'] as const;

export const taskRuns = sqliteTable(
  'task_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    profile: text('profile')
      .notNull()
      .references(() => agentProfiles.id, { onDelete: 'cascade' }),
    status: text('status', { enum: TASK_RUN_STATUSES }).notNull(),
    workerPid: integer('worker_pid'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    heartbeatAt: text('heartbeat_at'),
    outcome: text('outcome', { enum: TASK_RUN_OUTCOMES }),
    summary: text('summary'),
    evidenceJson: text('evidence_json'),
    error: text('error'),
    iterationCount: integer('iteration_count'),
    worktreePath: text('worktree_path'),
  },
  (table) => [
    index('idx_task_runs_task_id').on(table.taskId),
    index('idx_task_runs_status').on(table.status),
    index('idx_task_runs_heartbeat').on(table.heartbeatAt),
    unique('uq_task_runs_task_profile_started').on(table.taskId, table.profile, table.startedAt),
  ],
);

export type TaskRunRow = typeof taskRuns.$inferSelect;
export type NewTaskRunRow = typeof taskRuns.$inferInsert;
```

New file: `packages/core/src/store/schema/task-events.ts`

```typescript
import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';
import { taskRuns } from './task-runs.js';

export const TASK_EVENT_TYPES = [
  'claimed', 'reclaimed', 'promoted', 'blocked', 'completed', 
  'comment', 'spawned', 'verified', 'released', 'failed'
] as const;

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => taskRuns.id, { onDelete: 'set null' }),
    eventType: text('event_type', { enum: TASK_EVENT_TYPES }).notNull(),
    author: text('author').notNull(),
    body: text('body'),
    metadataJson: text('metadata_json'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_task_events_task_id').on(table.taskId),
    index('idx_task_events_run_id').on(table.runId),
    index('idx_task_events_type').on(table.eventType),
    index('idx_task_events_created_at').on(table.createdAt),
  ],
);

export type TaskEventRow = typeof taskEvents.$inferSelect;
export type NewTaskEventRow = typeof taskEvents.$inferInsert;
```

New file: `packages/core/src/store/schema/task-skills.ts`

```typescript
import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';

export const taskSkills = sqliteTable(
  'task_skills',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    skillName: text('skill_name').notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.skillName] })],
);

export type TaskSkillRow = typeof taskSkills.$inferSelect;
```

### 5.4 Schema Barrel Update

Update `packages/core/src/store/schema/index.ts`:

```typescript
export * from './agent-profiles.js';
export * from './task-runs.js';
export * from './task-events.js';
export * from './task-skills.js';
```

---

## 6. CORE API Surface

### 6.1 New Operations (packages/core/src/daemon/)

New module: `packages/core/src/daemon/index.ts`

```typescript
/**
 * Daemon Operations — Native autonomous dispatch for CLEO sagas.
 * @task T10401
 * @epic T10400
 */

export interface DaemonStartInput {
  sagaId: string;
  pollIntervalMs?: number;
  maxConcurrent?: number;
  maxSpawnPerCycle?: number;
  autoComplete?: boolean;
  autoVerify?: boolean;
  defaultProfile?: string;
}

export interface DaemonStopInput {
  sagaId?: string; // If omitted, stop all
}

export interface DaemonStatusInput {
  sagaId?: string;
}

export interface DaemonStatusOutput {
  state: 'idle' | 'polling' | 'paused' | 'stuck';
  sagaId: string;
  claimedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  activeRuns: Array<{
    runId: string;
    taskId: string;
    profile: string;
    startedAt: string;
    heartbeatAt: string | null;
  }>;
}

export interface TaskClaimInput {
  taskId: string;
  profileId: string;
}

export interface TaskReleaseInput {
  taskId: string;
  reason?: string;
}

export interface RunsHistoryInput {
  taskId: string;
  limit?: number;
  offset?: number;
}

export interface RunsHistoryOutput {
  runs: TaskRunRow[];
  total: number;
}

export interface EventsAuditInput {
  taskId: string;
  eventTypes?: string[];
  limit?: number;
  offset?: number;
}

export interface EventsAuditOutput {
  events: TaskEventRow[];
  total: number;
}

// Engine functions
export async function daemonStart(
  projectRoot: string,
  input: DaemonStartInput,
): Promise<EngineResult<DaemonStatusOutput>>;

export async function daemonStop(
  projectRoot: string,
  input: DaemonStopInput,
): Promise<EngineResult<{ stopped: boolean }>>;

export async function daemonStatus(
  projectRoot: string,
  input: DaemonStatusInput,
): Promise<EngineResult<DaemonStatusOutput>>;

export async function taskClaim(
  projectRoot: string,
  input: TaskClaimInput,
): Promise<EngineResult<{ claimed: boolean; task: TaskRecord }>>;

export async function taskRelease(
  projectRoot: string,
  input: TaskReleaseInput,
): Promise<EngineResult<{ released: boolean; task: TaskRecord }>>;

export async function runsGetHistory(
  projectRoot: string,
  input: RunsHistoryInput,
): Promise<EngineResult<RunsHistoryOutput>>;

export async function eventsGetAuditLog(
  projectRoot: string,
  input: EventsAuditInput,
): Promise<EngineResult<EventsAuditOutput>>;
```

### 6.2 Contracts Types (packages/contracts/src/daemon/)

New file: `packages/contracts/src/daemon.ts`

```typescript
/**
 * Daemon types shared between core and cleo packages.
 * @task T10400
 */

export interface AgentProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  skills?: string[];
  maxIterations?: number;
  timeoutSeconds?: number;
  config?: Record<string, unknown>;
}

export interface TaskRun {
  id: string;
  taskId: string;
  profile: string;
  status: 'running' | 'completed' | 'crashed' | 'timed_out' | 'cancelled';
  workerPid?: number;
  startedAt: string;
  endedAt?: string;
  heartbeatAt?: string;
  outcome?: 'done' | 'blocked' | 'crashed' | 'timed_out' | 'cancelled';
  summary?: string;
  evidence?: unknown[];
  error?: string;
  iterationCount?: number;
  worktreePath?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  runId?: string;
  eventType: string;
  author: string;
  body?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface DaemonConfig {
  pollIntervalMs: number;
  maxConcurrent: number;
  maxSpawnPerCycle: number;
  autoComplete: boolean;
  autoVerify: boolean;
  defaultProfile?: string;
  heartbeatTimeoutMs: number;
  reclaimEnabled: boolean;
}
```

### 6.3 Operations Registry

Add to `packages/contracts/src/operations/daemon.ts` (new file) and register in the operations registry:

```typescript
export const DAEMON_OPERATIONS = [
  { gateway: 'command', domain: 'daemon', operation: 'start', ... },
  { gateway: 'command', domain: 'daemon', operation: 'stop', ... },
  { gateway: 'command', domain: 'daemon', operation: 'status', ... },
  { gateway: 'command', domain: 'tasks', operation: 'claim', ... },
  { gateway: 'command', domain: 'tasks', operation: 'release', ... },
  { gateway: 'query', domain: 'runs', operation: 'history', ... },
  { gateway: 'query', domain: 'events', operation: 'audit', ... },
] as const;
```

---

## 7. CLI Thinning

The CLI becomes a thin wrapper around the CORE API. New commands:

```bash
# Daemon lifecycle
cleo daemon start --saga <sagaId> [--poll-interval 30000] [--max-concurrent 3]
cleo daemon stop [--saga <sagaId>]
cleo daemon status [--saga <sagaId>]

# Task claiming (manual override)
cleo tasks claim <taskId> --profile <profileId>
cleo tasks release <taskId> [--reason "..."]

# Run history
cleo runs history <taskId> [--limit 10] [--offset 0]

# Event audit
cleo events audit <taskId> [--type claimed,completed] [--limit 50]
```

**Deprecated (move to daemon-only, remove from CLI):**
- `hermes kanban promote` (for CLEO tasks) — daemon handles promotion via `orchestrateReady`.
- `hermes kanban claim` (for CLEO tasks) — use `cleo tasks claim`.

---

## 8. Concrete Fixes in Existing Code

### 8.1 Auto-Create AC Bindings (P0) — ALREADY DONE

**Location:** `packages/core/src/tasks/complete.ts` lines 639-657

The T10644 fix auto-creates `coverage` bindings when `task.verification?.passed === true`:

```typescript
if (task.verification?.passed === true) {
  const acRows = await acc.getAcRows(options.taskId);
  if (acRows.length > 0) {
    const acIds = acRows.map((ac) => ac.id);
    const bindings = await acc.getAcBindings(acIds);
    const boundAcIds = new Set(bindings.map((b: any) => b.acId));
    const unbound = acRows.filter((ac) => !boundAcIds.has(ac.id));
    if (unbound.length > 0) {
      await tx.insertAcBindings(
        unbound.map((ac) => ({
          id: `auto-coverage-${ac.id.slice(0, 8)}`,
          evidenceAtomId: 'auto-coverage-verification-passed',
          acId: ac.id,
          bindingType: 'coverage' as const,
        })),
      );
    }
  }
}
```

**Verification:** This code exists and runs inside the `withTaskWriteTransaction` block. The daemon's VerificationEngine must ensure this path is hit by calling `completeTask` (not `taskComplete` directly) so the transaction wrapper executes.

### 8.2 Fix Seed Script (P0)

**Location:** `seed_kanban_from_cleo_saga.py` (or equivalent)

**Rule:** Epic cards aggregate children; they do NOT gate them.

**Fix:**
```python
# WRONG — creates recursive blocking
# kanban_link(epic_card_id, child_card_id)

# CORRECT — epic card has no parent link to children
# Children are listed in epic card's metadata only
# kanban_link(child_card_id, epic_card_id)  # NEVER do this either
```

The seed script should:
1. Create epic cards with `type='epic'`.
2. Create task cards with `type='task'` and NO parent link to epic.
3. Store epic→child relationship in card metadata or comments, NOT in `parents`.

### 8.3 Increase Iteration Budget (P1)

**Location:** Agent profile config or spawn prompt

Default `max_iterations` for implementation tasks: 400 (was 200).

In `AgentProfile` schema:
```typescript
maxIterations: integer('max_iterations').default(400),
```

### 8.4 Pre-merge CI in Worktree (P1)

**Location:** `packages/core/src/spawn/branch-lock.ts` or worktree completion

Before merging a worktree branch to main:
1. Run `npm run build` (or equivalent) in the worktree.
2. Run `npm test` in the worktree.
3. Only if both pass, proceed with `git merge --no-ff`.

This prevents "workers committed code that didn't build."

---

## 9. Migration Path

### Phase 1: Schema Migrations (Week 1)
1. Create SQL migration for `agent_profiles`, `task_runs`, `task_events`, `task_skills`.
2. Add `claimed_at` and `intended_profile` to `tasks`.
3. Run `drizzle-kit generate` (or hand-write migration per project convention).

### Phase 2: CORE API Implementation (Week 2-3)
1. Implement `packages/core/src/daemon/` module:
   - `dispatch-engine.ts` — poll loop
   - `claim-manager.ts` — atomic claiming
   - `spawn-manager.ts` — wrapper around `orchestrateSpawn`
   - `monitor-engine.ts` — heartbeat/reclaim
   - `verification-engine.ts` — auto-verify/complete
   - `notification-engine.ts` — conduit pub/sub
2. Add types to `packages/contracts/src/daemon.ts`.
3. Register operations in `packages/contracts/src/operations/`.
4. Add tests in `packages/core/src/daemon/__tests__/`.

### Phase 3: CLI Integration (Week 3-4)
1. Add `cleo daemon start/stop/status` commands.
2. Add `cleo tasks claim/release` commands.
3. Add `cleo runs history` and `cleo events audit` commands.
4. Thin existing CLI: remove manual orchestrate spawn from common paths.

### Phase 4: Kanban Deprecation (Week 4-5)
1. Fix seed script (epics don't gate children).
2. Add deprecation warnings to `hermes kanban` for CLEO tasks.
3. Document migration path for users.

### Phase 5: Harness Integration (Week 5-6)
1. Integrate daemon with T10401's harness/gateway work.
2. Daemon runs as a harness instance (CleoNativeHarnessAdapter).
3. IPC between daemon and harness for status reporting.

---

## 10. Integration with the North Star Tier-0 Mesh

ADR-089 is **not standalone**. It is the dispatch-loop specification that plugs into the broader Tier-0 harness architecture defined in the **CLEO Canonical North Star** (`docs/plan/cleo-canonical-north-star.md`). The following sagas consume or extend this ADR:

| Saga | Role w.r.t. ADR-089 | Integration Point |
|------|---------------------|-------------------|
| **T10401 SG-HARNESS-DAEMON-IPC** | **Primary consumer** | The daemon IS the harness. T10401's 10 children (T1738 architecture, T1750 native adapter, T1751 branch-lock worktree, T1752 health monitoring, T1753 deprecation of external binaries, T1783 gateway session schemas, T1792 gateway runner, T1802 cron scheduler, T1808 gateway hooks, T1811 diagnostics) all build the substrate that the dispatch loop runs on. |
| **T10400 SG-CLEO-SDK-API** | **API surface provider** | The daemon consumes `orchestrate.ready`, `orchestrate.spawn`, `tasks.claim`, `tasks.complete` through the SDK API envelope. ADR-089's CORE API additions (`daemon.start`, `runs.history`, etc.) are new endpoints in the T10400 OpenAPI 3.2 spec. |
| **T10409 SG-VAULT-CORE** | **Credential security** | Agent profiles in `agent_profiles` table store provider/model configs but **NOT** API keys. Keys live in `vault.db` (AES-256-GCM). The SpawnManager resolves credentials via the vault gateway at spawn time, per T10409 AC7 (JWT Proxy-Authorization). |
| **T10403 SG-GENKIT-MIDDLEWARE** | **Worker prompt pipeline** | The SpawnManager injects `task_skills` into the worker's context. The worker's LLM calls flow through Genkit middleware (gaze-pii, LLMLingua-2, provider cache) per T10403 D4/D3 decisions. |
| **T10418 SG-AGENT-TOOL-REGISTRY** | **Tool catalog for workers** | Workers spawned by the daemon load tools from the registry. The `task_skills` table maps tasks to skills; the registry maps skills to toolsets. Coordinates with T10377 SG-IVTR-AC-BINDING's 4 CORE tools. |
| **T10419 SG-CHANNELS** | **Notification delivery** | The NotificationEngine publishes to Conduit topics. T10419's 18 channel adapters (Telegram, Discord, etc.) subscribe to these topics for real-time status. |
| **T10404 SG-CANT-RUNTIME-V2** | **Workflow engine for complex tasks** | Multi-step tasks (e.g., "research → implement → test → review") can be modeled as CANT workflows. The daemon dispatches the workflow; CANT runtime manages the state machine. Approval gates (HITL) persist to `conduit_approvals` per D6. |

### 10.1 How the Daemon Fits the End-to-End Data Flow

From the North Star §5.2 data flow diagram, the daemon sits at the **control plane** layer:

```
USER input (CLI / Cockpit TUI)
         │
         ▼
[cleo daemon serve] ── HTTPS Gateway (axum+hyper+tokio-rustls per T10409) ── SG-HARNESS-DAEMON-IPC (T10401)
         │
         ├── DispatchEngine polls orchestrate.ready ──► tasks.db
         │
         ├── SpawnManager calls orchestrate.spawn ──► packages/worktree
         │
         ├── MonitorEngine checks heartbeats ──► task_runs table
         │
         └── NotificationEngine publishes ──► Conduit ──► T10419 channels
         │
         ▼
[Worker process spawned]
         │
         ├── Loads skills from task_skills ──► T10418 registry
         │
         ├── LLM calls via Genkit middleware ──► T10403 gaze-pii + LLMLingua-2
         │
         ├── Credentials via vault gateway ──► T10409 AES-256-GCM decrypt
         │
         └── Memory writes through Mem0 chokepoint ──► T10405 PSYCHE
```

### 10.2 Resolved: Sentient Daemon vs. Dispatch Daemon

**Question:** Does ADR-089 create a second daemon process alongside the existing sentient daemon (`packages/core/src/sentient/daemon.ts`)?

**Answer: NO — Single Daemon, Multiple Ticks.**

The existing sentient daemon (T1737 legacy) runs a cron-style tick every 5 minutes for GC, self-healing, and BRAIN maintenance. The North Star explicitly retires T1737 and absorbs its children into T10401. The **new daemon** (T10401) is a single TypeScript long-running process (`cleo daemon serve`) with multiple internal tick loops:

| Tick | Frequency | Owner | Purpose |
|------|-----------|-------|---------|
| Dispatch tick | 30s (configurable) | DispatchEngine | Poll `orchestrate.ready`, claim, spawn |
| Monitor tick | 10s | MonitorEngine | Check heartbeats, reclaim stale |
| GC tick | 5min | GC sidecar (existing) | Garbage-collect old worktrees, prune DB |
| Sentient tick | 5min | Sentient loop (existing) | BRAIN maintenance, idle dream, skill distillation |
| Cron tick | 1min | CronScheduler (T1802) | Execute scheduled tasks |

All ticks run in the **same process** (`cleo daemon serve`). They share the SQLite connection pool and Conduit publisher. No second daemon process.

### 10.3 Sequencing Implications

Per North Star §4 critical sequencing:

1. **T10400 SG-CLEO-SDK-API** must ship BEFORE ADR-089 implementation (the daemon consumes the SDK API).
2. **T10409 SG-VAULT-CORE** must ship BEFORE daemon production use (credentials must be secured).
3. **T10401 SG-HARNESS-DAEMON-IPC** is the **implementation saga** for ADR-089. ADR-089 is the spec; T10401 is the build.
4. **T10403 SG-GENKIT-MIDDLEWARE** can ship in parallel with T10401 (different code surfaces).

### 10.4 Open Questions

1. **What happens when multiple daemons run (multi-machine or multi-repo)?**
   - SQLite advisory locking (`BEGIN IMMEDIATE`) prevents double-claim.
   - Daemon writes PID to `.cleo/daemon.pid` and checks for stale locks on startup.

2. **How do we handle HITL gates in the daemon?**
   - Daemon pauses task (status='blocked') and publishes via Conduit.
   - Human approves via `cleo daemon approve <taskId>` or Cockpit dashboard.
   - Daemon resumes on approval (listens to `conduit_approvals` table per D6).

---

## 11. Success Criteria

1. **Dispatch reliability:** 95%+ of saga tasks are claimed, spawned, and completed without Prime intervention.
2. **AC binding coverage:** 100% of tasks with green gates auto-complete without manual AC binding injection.
3. **Zero Kanban DB corruption:** No `.corrupt.*.bak` files from daemon operations.
4. **CLI thinning:** Common workflows (saga execution) require ≤3 CLI commands (start, status, stop).
5. **Typesafe API:** All daemon→core calls are type-checked at build time via `packages/contracts`.

---

## 12. Appendix: What to Steal from Kanban

| Kanban Feature | CLEO Native Equivalent | Status |
|----------------|------------------------|--------|
| Assignee/profile per task | `tasks.assignee` + `agent_profiles` table | ✅ Schema defined |
| Run history with PID/summary/evidence | `task_runs` table | ✅ Schema defined |
| Event audit log | `task_events` table | ✅ Schema defined |
| Card comments | `task_events` with event_type='comment' | ✅ Schema defined |
| Auto-dispatch daemon | `DispatchEngine` in daemon module | 🔄 Design complete |
| Resource caps (max_concurrent, max_spawn) | `DispatchOptions` | 🔄 Design complete |
| Heartbeat timeout (5min → reclaim) | `MonitorEngine.checkStale()` | 🔄 Design complete |
| Idempotency keys | `uq_task_runs_task_profile_started` | ✅ Schema defined |
| Per-run logs | `task_runs.evidence_json` + `task_events` | ✅ Schema defined |
| Notification channels | `NotificationEngine` via Conduit | 🔄 Design complete |
| Skills association | `task_skills` table | ✅ Schema defined |

---

*End of ADR-089*
