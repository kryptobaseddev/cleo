# CORE API Agent Guide

**For**: LLM agents, SDK consumers, Studio route authors  
**Package**: `@cleocode/core` (v2026.5.x and later)  
**Stability contract**: `packages/core/STABILITY.md`  
**Architecture spec**: `docs/plans/E-CORE-FIRST-ARCH.md`

---

## Table of Contents

1. [Why CORE-first](#1-why-core-first)
2. [Three import patterns](#2-three-import-patterns)
3. [Public API surface — domain map](#3-public-api-surface--domain-map)
4. [Example invocations](#4-example-invocations)
5. [Error handling](#5-error-handling)
6. [Differences from the CLI](#6-differences-from-the-cli)
7. [Migration cookbook](#7-migration-cookbook)
8. [Stability tiers](#8-stability-tiers)

---

## 1. Why CORE-first

`@cleocode/core` is the CLEO SDK. It is the **single runtime kernel** that
contains all domain logic — tasks, sessions, memory, lifecycle, sentient, nexus,
conduit, and more. The `@cleocode/cleo` CLI package is a thin adapter: it parses
command-line arguments and dispatches to CORE. Studio API routes do the same.

**Agents and SDK consumers SHOULD call CORE directly.** Spawning the `cleo` CLI
binary from within an agent introduces unnecessary overhead:

| Concern | CLI subprocess | Direct CORE import |
|---------|---------------|-------------------|
| Latency per call | 200–800 ms (Node.js cold start) | <5 ms |
| Type safety | None — stdout parse only | Full TypeScript types from `@cleocode/contracts` |
| Error handling | Exit codes + LAFS envelope parsing | Typed `CleoError` throws |
| Tree-shaking | Not possible | Full ESM tree-shaking |
| Debugging | Log scraping | Normal stack traces + source maps |

The architecture diagram (`docs/plans/E-CORE-FIRST-ARCH.md` §3.1) shows all three
consumers — CLI, Studio, and LLM agents — at the same level, all importing from
`@cleocode/core`. CLI gets no special privileges; it is just one adapter.

**Rule**: An agent that shells out to `cleo <command>` to read or mutate state
when a typed CORE function exists for that operation is doing it wrong. Fix the
pattern by importing from the relevant subpath.

---

## 2. Three import patterns

CORE provides three canonical import patterns. All are valid. Choose by context.

### Pattern 1 — Facade (project-bound, domain-grouped)

Best for agents that operate across multiple domains in one session.

```typescript
import { Cleo } from '@cleocode/core/sdk';

const cleo = await Cleo.init(process.cwd());

// All domains available as properties
const task    = await cleo.tasks.add({ title: 'Implement auth', type: 'task', priority: 'high' });
const session = await cleo.sessions.start({ scope: 'global', name: 'agent-session' });
const obs     = await cleo.memory.observe({ text: 'JWT is stateless', type: 'observation' });

await cleo.destroy();
```

`Cleo.init()` opens the SQLite store once and shares it across all domain calls.
Always call `cleo.destroy()` when the agent process exits to close the WAL.

### Pattern 2 — Namespace import

Best for agents that need several operations from one or two domains.

```typescript
import { tasks, memory, sessions, sentient } from '@cleocode/core';

const root = process.cwd();

await sessions.startSession(root, { scope: 'global', name: 'agent-session' });
const found = await tasks.findTasks({ query: 'auth', status: 'open' }, root);
const entry = await memory.observeBrain({ text: 'JWT is stateless' }, root);
const state = await sentient.getDaemonStatus(root);
```

### Pattern 3 — Tree-shaken direct imports

Best for agents that only need one or two specific functions. Minimises bundle
size and load time. Import from the narrowest subpath that satisfies the need.

```typescript
import { addTask }      from '@cleocode/core/tasks';
import { startSession } from '@cleocode/core/sessions';
import { observeBrain } from '@cleocode/core/memory';
import { getDaemonStatus } from '@cleocode/core/sentient';
```

Or from the root barrel for widely-used flat function exports:

```typescript
import { addTask, startSession, observeBrain, showTask, completeTask } from '@cleocode/core';
```

> **Tip**: The root barrel (`@cleocode/core`) re-exports all contracts types plus
> every domain namespace. It is the widest tree-shake surface. Prefer narrow
> subpaths (`@cleocode/core/tasks`, `@cleocode/core/memory`, etc.) in hot paths.

---

## 3. Public API surface — domain map

The table below covers the **ten domains** most commonly needed by LLM agents
and SDK consumers. The full list of ~45 namespaces exported by the core barrel
is in `packages/core/src/index.ts`.

Every function listed accepts `projectRoot?: string` as its last (or second-to-
last) argument. If omitted, CORE resolves the project root from `process.cwd()`.

### 3.1 `tasks` — `@cleocode/core/tasks`

**Stability**: stable

Task CRUD, hierarchy, dependencies, lifecycle, archival, graph operations.

| Function | Signature | Description |
|----------|-----------|-------------|
| `addTask` | `(opts: AddTaskOptions, root?, accessor?) => Promise<Task>` | Create a new task with full validation |
| `showTask` | `(id: string, root?, accessor?) => Promise<Task>` | Fetch a single task by ID |
| `listTasks` | `(opts?: ListTasksOptions, root?, accessor?) => Promise<Task[]>` | List tasks with optional filters |
| `findTasks` | `(opts: FindTasksOptions, root?, accessor?) => Promise<Task[]>` | Full-text + filter search |
| `updateTask` | `(id: string, updates: UpdateTaskOptions, root?, accessor?) => Promise<Task>` | Update task fields |
| `completeTask` | `(id: string, opts?: CompleteTaskOptions, root?, accessor?) => Promise<Task>` | Mark a task done (runs gate checks) |
| `deleteTask` | `(id: string, opts?: DeleteTaskOptions, root?, accessor?) => Promise<DeleteTaskResult>` | Delete with cascade preview |
| `archiveTasks` | `(opts: ArchiveTasksOptions, root?, accessor?) => Promise<ArchiveTasksResult>` | Bulk archive completed tasks |
| `computeTaskView` | `(id: string, accessor?) => Promise<TaskView>` | Rich derived view with rollup, gates, next-action |
| `computeTaskViews` | `(ids: string[], accessor?) => Promise<TaskView[]>` | Batch view computation |

Key option types are in `@cleocode/contracts` — import them alongside functions:

```typescript
import { addTask } from '@cleocode/core/tasks';
import type { AddTaskOptions } from '@cleocode/contracts';
```

### 3.2 `sessions` — `@cleocode/core/sessions`

**Stability**: stable

Session lifecycle — start, resume, end, checkpoint, briefing, handoff, decisions.

| Function | Signature | Description |
|----------|-----------|-------------|
| `startSession` | `(root: string, params: SessionStartParams, accessor?) => Promise<Session>` | Open a new session |
| `endSession` | `(root: string, params: SessionEndParams, accessor?) => Promise<Session>` | Close the active session |
| `resumeSession` | `(root: string, params: SessionResumeParams, accessor?) => Promise<Session>` | Attach to a previous session |
| `listSessions` | `(root: string, params?: SessionListParams, accessor?) => Promise<Session[]>` | Enumerate sessions |
| `sessionStatus` | `(root: string, params?: SessionStatusParams, accessor?) => Promise<SessionStatusResult>` | Current session state |
| `detectSessionDrift` | `(root: string, accessor?) => Promise<DriftReport>` | Check for diverged context |
| `serializeSession` | `(sessionId: string, root?, opts?) => Promise<SessionSnapshot>` | Snapshot for handoff |
| `restoreSession` | `(snapshot: SessionSnapshot, root?, opts?) => Promise<void>` | Restore from snapshot |

### 3.3 `memory` — `@cleocode/core/memory`

**Stability**: stable (peer-dep-gated on SQLite + optional WASM embeddings)

BRAIN storage, search, observation, timeline, lifecycle, consolidation, STDP.

| Function | Signature | Description |
|----------|-----------|-------------|
| `observeBrain` | `(opts: ObserveOpts, root?) => Promise<BrainObservation>` | Store a new observation |
| `searchBrain` | `(query: string, opts?, root?) => Promise<BrainHit[]>` | Semantic + keyword search |
| `searchBrainCompact` | `(query: string, budget?, root?) => Promise<string>` | Budget-aware compact result string |
| `fetchBrainEntries` | `(ids: string[], root?) => Promise<BrainEntry[]>` | Fetch entries by ID |
| `timelineBrain` | `(opts: TimelineOpts, root?) => Promise<BrainEntry[]>` | Chronological retrieval |
| `buildRetrievalBundle` | `(query: string, opts?, root?) => Promise<RetrievalBundle>` | 3-layer retrieval for agent injection |

**Research + manifest sub-domain** (same barrel):

| Function | Description |
|----------|-------------|
| `appendExtendedManifest` | Append a pipeline manifest entry (ADR-027 / T1093) |
| `searchManifest` | Search manifest entries by text relevance |
| `readExtendedManifest` | Read all manifest entries |
| `filterManifestEntries` | Apply typed filter criteria to manifest entries |
| `addResearch` | Attach a research entry to a task |
| `listResearch` | List research with status + task filters |
| `showManifestEntry` | Fetch a manifest entry with optional file content |

### 3.4 `lifecycle` — `@cleocode/core/lifecycle`

**Stability**: stable

RCASD/IVTR pipeline stage management, gate verification, evidence, tessera.

| Function / Const | Description |
|------------------|-------------|
| `PIPELINE_STAGES` | Ordered array of canonical stage names |
| `checkGate` | Read gate state for a task |
| `passGate` | Record a gate as passed with evidence |
| `failGate` | Record a gate as failed |
| `skipStage` | Skip a stage with a reason |
| `getLifecycleStatus` | Full pipeline status for a task |
| `getLifecycleHistory` | Ordered list of all lifecycle events |
| `computeTaskRollup` | Derive epic rollup from child tasks |
| `computeTaskRollups` | Batch rollup computation |
| `buildStageGuidance` | Stage-specific prompt guidance for agents |
| `listEpicsWithLifecycle` | All epics with their pipeline stage |

### 3.5 `sentient` — `@cleocode/core/sentient`

**Stability**: stable

Tier-1/Tier-2/Tier-3 autonomous proposals, sentient daemon, state, KMS.

| Function | Description |
|----------|-------------|
| `getDaemonStatus` | Read daemon health + tier enablement state |
| `startDaemon` | Spawn the sentient daemon process |
| `stopDaemon` | Send shutdown signal to daemon |
| `installDaemon` | Register as a system service |
| `uninstallDaemon` | Deregister system service |
| `sentientProposeList` | List pending Tier-2 proposals |
| `sentientProposeAccept` | Accept a proposal |
| `sentientProposeReject` | Reject a proposal |
| `sentientProposeEnable` | Enable Tier-2 generation |
| `sentientProposeDisable` | Disable Tier-2 generation |
| `readSentientState` | Read the full sentient state file |
| `patchSentientState` | Partially update sentient state |

### 3.6 `llm` — `@cleocode/core` (namespace `llm`)

**Stability**: stable

LLM credential management, provider dispatch, structured output, auxiliary fallback.

| Function | Description |
|----------|-------------|
| `llmList` | List configured LLM credentials |
| `llmAdd` | Store a new credential |
| `llmRemove` | Remove a credential |
| `llmTest` | Test a credential end-to-end |
| `llmWhoami` | Show active model identity |
| `getCredentialPool` | Get all credentials for a transport |
| `listCredentials` | List credentials with filter |
| `cleoLlmCall` | Make a typed LLM completion call via active backend |
| `runAuxiliaryWithFallback` | Multi-provider fallback chain execution |

### 3.7 `agents` — `@cleocode/core` (namespace `agents`)

**Stability**: stable (promotions from internal in progress — see T-CORE-API-PROMOTE)

Agent registry, health monitoring, capacity, execution learning.

| Function | Description |
|----------|-------------|
| `registerAgent` | Register a new agent instance |
| `deregisterAgent` | Remove an agent from the registry |
| `listAgentInstances` | List all registered agents |
| `heartbeat` | Record a heartbeat for an agent |
| `checkAgentHealth` | Health check for a specific agent |
| `detectCrashedAgents` | Find agents whose heartbeat has lapsed |
| `detectStaleAgents` | Find agents inactive past threshold |
| `getAgentCapacity` | Capacity and specialization info |
| `isOverloaded` | Check if an agent is at capacity |
| `recordAgentPerformance` | Log execution outcome for learning |
| `getSelfHealingSuggestions` | Get recovery suggestions from learning history |
| `invokeMetaAgent` | Invoke the meta-agent architect (ADR-055) |

> **Note**: `registerAgent`, `listAgents`, `getAgent`, `removeAgent`, and
> `rotateAgentKey` are currently promoted to the public barrel via the
> `agents` namespace. Task T-CORE-API-PROMOTE adds the remaining wrappers
> over `AgentRegistryAccessor` as an explicit public surface.

### 3.8 `conduit` — `@cleocode/core/conduit`

**Stability**: stable (peer-dep-gated on SQLite conduit DB or HTTP transport)

Inter-agent messaging, local transport, SSE transport, HTTP transport.

| Export | Description |
|--------|-------------|
| `ConduitClient` | High-level messaging client |
| `createConduit` | Factory — resolves transport from config |
| `resolveTransport` | Resolve the active transport |
| `LocalTransport` | Offline SQLite-backed transport |
| `HttpTransport` | HTTP polling transport (cloud) |
| `SseTransport` | Server-sent events transport |

### 3.9 `setup` — `@cleocode/core/setup`

**Stability**: stable

Interactive setup wizard sections — LLM credentials, identity, harness, brain mode.

| Export | Description |
|--------|-------------|
| `createDefaultWizardRunner` | Factory: WizardRunner pre-wired with all built-in sections |
| `WizardRunner` | Step-through wizard executor |
| `StubWizardIO` | Non-interactive IO adapter for programmatic setup |
| `createLlmSection` | LLM credentials section constructor |
| `createIdentitySection` | Agent identity section constructor |
| `createSentientSection` | Sentient daemon section constructor |
| `createHarnessSection` | Harness selection section constructor |
| `createBrainSection` | BRAIN memory mode section constructor |
| `createProjectConventionsSection` | Project strictness preset section constructor |

Programmatic usage (no terminal prompts):

```typescript
import { createDefaultWizardRunner, StubWizardIO } from '@cleocode/core/setup';

const io = new StubWizardIO({
  'llm.transport': 'anthropic',
  'llm.apiKey': process.env.ANTHROPIC_API_KEY!,
});
const runner = createDefaultWizardRunner();
const result = await runner.run(process.cwd(), io);
```

### 3.10 `status` — `@cleocode/core/status`

**Stability**: stable

Lightweight status aggregator — identity, credentials, config tier, session,
harness, and sentient-daemon state in one read-only call. Safe on every tick.

| Export | Description |
|--------|-------------|
| `getCleoStatus` | `(root?) => Promise<CleoStatus>` — full status snapshot |
| `CleoStatus` | Interface for the status envelope |

```typescript
import { getCleoStatus } from '@cleocode/core/status';

const status = await getCleoStatus(process.cwd());
console.log(status.identity.agentName);
console.log(status.daemon.running);
console.log(status.credentials); // per-transport auth state
```

---

## 4. Example invocations

The examples below illustrate the most common agent workflows. All use Pattern 3
(direct imports) for clarity.

### 4.1 Store a memory observation

```typescript
import { observeBrain } from '@cleocode/core/memory';

const root = process.cwd();

const observation = await observeBrain(
  {
    text: 'Evidence atoms must include commit SHA + file list for the "implemented" gate.',
    type: 'observation',
    source: 'agent-session',
    tags: ['gates', 'evidence', 'ADR-051'],
    confidence: 0.9,
  },
  root,
);

console.log(`Stored observation ${observation.id}`);
```

### 4.2 List LLM credentials

```typescript
import { llmList } from '@cleocode/core';

const root = process.cwd();

const { credentials } = await llmList(root);

for (const cred of credentials) {
  console.log(`${cred.transport} — ${cred.authType} — active: ${cred.isActive}`);
}
```

### 4.3 Read the active setup section

```typescript
import { getCleoStatus } from '@cleocode/core/status';

const status = await getCleoStatus(process.cwd());

if (!status.daemon.running) {
  console.warn('Sentient daemon is not running. Start with: cleo daemon start');
}

const activeTransport = status.credentials.find((c) => c.isActive);
console.log(`Active LLM transport: ${activeTransport?.transport ?? 'none'}`);
```

### 4.4 Check sentient daemon status

```typescript
import { getDaemonStatus } from '@cleocode/core/sentient';

const status = await getDaemonStatus(process.cwd());

console.log({
  running: status.running,
  tier1Enabled: status.tier1,
  tier2Enabled: status.tier2,
  pid: status.pid,
  uptime: status.uptime,
});
```

### 4.5 Append a pipeline manifest entry

```typescript
import { appendExtendedManifest } from '@cleocode/core/memory';

const root = process.cwd();

const { entryId, file } = await appendExtendedManifest(
  {
    id: 'T9623-core-api-research',
    task_id: 'T9623',
    type: 'research',
    status: 'completed',
    output: '.cleo/agent-outputs/T9623-output.md',
    file: '.cleo/agent-outputs/T9623-output.md',
    title: 'CORE API surface audit',
    date: new Date().toISOString().slice(0, 10),
    agent_type: 'research',
    topics: ['core-api', 'sdk', 'agents'],
    key_findings: [
      'CORE exports 45+ domain namespaces',
      'memory/index.ts doubles as research + manifest domain',
    ],
    actionable: true,
    needs_followup: [],
    linked_tasks: ['T9623'],
    summary: 'Audited public CORE API for agent guide',
  },
  root,
);

console.log(`Appended manifest entry ${entryId} → ${file}`);
```

### 4.6 Show a task + complete the task lifecycle

```typescript
import { showTask, completeTask } from '@cleocode/core';
import type { Task } from '@cleocode/contracts';

const root = process.cwd();
const taskId = 'T9623';

// 1. Read current state
const task: Task = await showTask(taskId, root);
console.log(`Status: ${task.status} | Priority: ${task.priority}`);

// 2. Complete the task (gate checks run automatically)
//    Pass evidence atoms to satisfy ADR-051 gates before calling
//    complete from external code — or use cleo verify first.
const completed = await completeTask(
  taskId,
  { note: 'CORE-API-AGENT-GUIDE.md written and PR merged' },
  root,
);

console.log(`Task ${completed.id} is now ${completed.status}`);
```

> **Gate reminder**: `completeTask` runs the evidence-gate checks registered by
> `cleo verify`. If you are programmatically completing a task, ensure you have
> already called the CORE `passGate` / lifecycle verification flow, or use the
> `CLEO_OWNER_OVERRIDE` escape hatch (audited — see ADR-051).

---

## 5. Error handling

CORE operations throw typed errors rather than returning error envelopes. The
LAFS envelope (`{success, data?, error?, meta}`) is the **CLI/Studio adapter
layer's** responsibility — it is what the CLI prints to stdout. CORE itself
does not wrap in envelopes.

### 5.1 Error types

All CORE errors extend `CleoError` from `@cleocode/core`:

```typescript
import { CleoError } from '@cleocode/core';
import { ExitCode } from '@cleocode/contracts';

try {
  const task = await showTask('T9999-does-not-exist', root);
} catch (err) {
  if (err instanceof CleoError) {
    console.error(`CLEO error [${err.code}]: ${err.message}`);
    // err.code is an ExitCode enum value — e.g. ExitCode.NOT_FOUND (4)
  } else {
    throw err; // unexpected — re-throw
  }
}
```

### 5.2 Common exit codes

| `ExitCode` value | Numeric | Meaning |
|------------------|---------|---------|
| `NOT_FOUND` | 4 | Task, entry, or resource does not exist |
| `VALIDATION_ERROR` | 6 | Parameter failed validation |
| `PARENT_NOT_FOUND` | 10 | Parent task / epic ID does not exist |
| `LIFECYCLE_GATE_FAILED` | 80 | Gate check rejected the operation |
| `IVTR_INCOMPLETE` | 83 | IVTR loop not released |

These are the same codes the CLI exposes — but in CORE they surface as
`CleoError.code` on the thrown exception, not as process exit codes.

### 5.3 Agent wrapping pattern

When building CLI commands or Studio API routes that wrap CORE operations,
convert `CleoError` to a LAFS envelope at the adapter boundary:

```typescript
// packages/cleo/src/cli/commands/example.ts
import { showTask } from '@cleocode/core/tasks';
import { CleoError } from '@cleocode/core';
import { cliOutput, cliError } from '../renderers/index.js';

async function run({ args }: { args: { id: string } }) {
  try {
    const task = await showTask(args.id, process.cwd());
    cliOutput(task, { command: 'show' });
  } catch (err) {
    if (err instanceof CleoError) {
      cliError(err.code, err.message);
    } else {
      throw err;
    }
  }
}
```

Keep `CleoError` handling at the adapter layer. Do **not** catch and re-wrap
inside CORE functions themselves — let errors propagate cleanly.

### 5.4 Async safety

All CORE functions are async and safe to call concurrently from different
agent threads **unless** they write to the same SQLite database. The SQLite
WAL mode allows concurrent reads, but write operations serialise at the
database level. If you spawn multiple agents writing tasks concurrently,
expect brief serialisation delays rather than corruption.

---

## 6. Differences from the CLI

| Dimension | CLI (`cleo <command>`) | Direct CORE import |
|-----------|------------------------|-------------------|
| Return value | LAFS JSON envelope `{success, data, error, meta}` or human-readable text | Plain value or typed object |
| Error signalling | Non-zero exit code + `{success:false, error:{...}}` envelope | `CleoError` exception |
| Envelope wrapping | Automatic via `cliOutput()` | None — caller decides if envelope is needed |
| Session requirement | Enforced by CLI bootstrap | Optional — CORE functions work without an open session unless the operation requires one (e.g. `completeTask`) |
| Pagination | CLI renders pages; `createPage()` builds envelopes | Raw arrays returned; paginate manually if needed |
| Format flags | `--format json\|human\|quiet` respected | Irrelevant — caller formats output |

### 6.1 CLI dispatch wrapper utilities

If you are building a CLI command that needs to wrap a CORE call in a LAFS
envelope, use the dispatch adapter utilities in `@cleocode/cleo`:

| Utility | Location | Purpose |
|---------|----------|---------|
| `dispatchFromCli` | `packages/cleo/src/dispatch/adapters/cli.ts` | Route a CLI verb through the dispatch engine + auto-wrap in LAFS |
| `dispatchRaw` | `packages/cleo/src/dispatch/adapters/cli.ts` | Lower-level dispatch without format context setup |
| `cliOutput` | `packages/cleo/src/cli/renderers/index.ts` | Print a LAFS success envelope or human-formatted output |
| `cliError` | `packages/cleo/src/cli/renderers/index.ts` | Print a LAFS error envelope and exit non-zero |

These utilities are **not exported from `@cleocode/core`** — they live in the
CLI package. Agents importing directly from CORE do not need them.

### 6.2 When to still use the CLI

Some operations have no CORE backing and legitimately require the CLI binary:

- `cleo nexus analyze` — spawns a background indexer process
- `cleo daemon install` — system service registration (wraps OS-level APIs that differ per platform)
- `cleo self-update` — replaces the running binary

For these, the Studio `spawn-cli.ts` helper or a raw `execa` call to the `cleo`
binary is acceptable. Keep this as the exception — not the default path.

---

## 7. Migration cookbook

When converting a CLI command or Studio route that calls CORE internals directly
to the correct CORE-first pattern, follow these steps.

### Step 1 — Identify the violation

A command is violating CORE-first if it does any of:

- `import ... from '@cleocode/core/internal'`
- `import { getBrainDb, getTasksDb, openCleoDb }` (direct DB handles)
- Raw `.prepare()`, `.all()`, `.run()`, `.get()` calls on a SQLite database
- Inline implementation of business logic that belongs in a CORE domain

### Step 2 — Find or create the public CORE function

Check whether the CORE domain already exports what you need:

```bash
# Search the domain barrel
grep -n "export" packages/core/src/memory/index.ts
grep -n "export" packages/core/src/tasks/index.ts

# Or search the root barrel
grep -n "export" packages/core/src/index.ts
```

If the function exists internally but is not exported, promote it:

```typescript
// packages/core/src/memory/index.ts  — add to the barrel
export { myInternalFn } from './my-internal-file.js';
```

If the function does not exist, implement it in the CORE domain module.

### Step 3 — Import from the public barrel

```typescript
// BEFORE (violation)
import { getBrainDb } from '@cleocode/core/internal';
const db = await getBrainDb(root);
const rows = db.prepare('SELECT * FROM observations WHERE ...').all();

// AFTER (correct)
import { observeBrain, searchBrain } from '@cleocode/core/memory';
const results = await searchBrain(query, { limit: 20 }, root);
```

### Step 4 — Wrap the result for the CLI adapter layer

CLI commands use `cliOutput` to emit the LAFS envelope. Do not call
`formatSuccess` / `formatOutput` directly in the command body — use `cliOutput`:

```typescript
// packages/cleo/src/cli/commands/memory.ts (excerpt)
import { searchBrain } from '@cleocode/core/memory';
import { cliOutput, cliError } from '../renderers/index.js';
import { CleoError } from '@cleocode/core';

async function run({ args }: { args: { query: string } }) {
  try {
    const hits = await searchBrain(args.query, { limit: 20 }, process.cwd());
    cliOutput(hits, { command: 'memory.find' });
  } catch (err) {
    if (err instanceof CleoError) {
      cliError(err.code, err.message);
    } else {
      throw err;
    }
  }
}
```

### Step 5 — Same pattern for Studio API routes

```typescript
// packages/studio/src/routes/api/memory/find/+server.ts
// BEFORE (violation)
import { getBrainDb } from '@cleocode/core/internal';
// ... raw SQL ...

// AFTER (correct)
import { searchBrain } from '@cleocode/core/memory';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
  const query = url.searchParams.get('q') ?? '';
  const hits = await searchBrain(query, {}, locals.projectCtx.projectPath);
  return json({ success: true, data: hits });
};
```

### Cookbook summary table

| Violation pattern | Correct replacement | Source |
|------------------|---------------------|--------|
| `getBrainDb()` + raw SQL in CLI | `searchBrain()`, `observeBrain()`, etc. | `@cleocode/core/memory` |
| `getTasksDb()` + raw SQL in CLI | `listTasks()`, `findTasks()`, `showTask()` | `@cleocode/core/tasks` |
| `AgentRegistryAccessor` in CLI | `registerAgent()`, `listAgentInstances()` | `@cleocode/core` (agents ns) |
| `readSentientState()` internal import | `getDaemonStatus()`, `sentientProposeList()` | `@cleocode/core/sentient` |
| `getBrainDb()` + raw SQL in Studio | Same memory CORE functions as CLI | `@cleocode/core/memory` |
| `new DatabaseSync(nexusPath)` in Studio | `nexus.searchSymbols()`, `nexus.getSymbol()` | `@cleocode/core/nexus` |
| `getTasksDb()` graph SQL in Studio | `computeTaskView()`, task graph ops | `@cleocode/core/tasks` |

---

## 8. Stability tiers

The CORE API follows a CalVer stability contract (`YYYY.M.PATCH`) defined in
`packages/core/STABILITY.md`. Summary for agent consumers:

| Tier | Subpaths | Policy |
|------|----------|--------|
| **stable** | `.` (root), `./sdk`, `./tasks`, `./memory`, `./sessions`, `./nexus`, `./lifecycle`, `./conduit`, `./sentient`, `./setup`, `./status` | Breaking changes require a CalVer month bump + CHANGELOG notice one cycle in advance |
| **internal** | `./internal`, `./store/*`, `./conduit/*` deep paths, `./tasks/*` deep paths | No guarantee — CLI-only, may change at PATCH |
| **peer-dep-gated** | `./memory` (WASM embeddings), `./conduit` (SQLite conduit DB or HTTP transport), `./nexus` (`@cleocode/nexus` peer) | Stable contract, but calls may throw at runtime if the peer dep is not configured |

**Agents MUST import from stable subpaths only.** Importing from `./internal`
bypasses the public API contract and will break when CORE refactors its internals.

### Namespace stability (of the 45+ namespaces)

The following 10 namespaces are the most commonly needed and are marked **stable**:

| Namespace | Import | Stability |
|-----------|--------|-----------|
| `tasks` | `@cleocode/core/tasks` | stable |
| `sessions` | `@cleocode/core/sessions` | stable |
| `memory` | `@cleocode/core/memory` | stable (peer-dep-gated on SQLite) |
| `lifecycle` | `@cleocode/core/lifecycle` | stable |
| `sentient` | `@cleocode/core/sentient` | stable |
| `llm` | `@cleocode/core` (namespace) | stable |
| `agents` | `@cleocode/core` (namespace) | stable (promotions in progress: T-CORE-API-PROMOTE) |
| `conduit` | `@cleocode/core/conduit` | stable (peer-dep-gated) |
| `setup` | `@cleocode/core/setup` | stable |
| `status` | `@cleocode/core/status` | stable |

Namespaces marked as **experimental** (may be reshaped without a month-bump):

| Namespace | Status | Notes |
|-----------|--------|-------|
| `orchestration` | experimental | Spawn prompt shape evolves with ADR-055 |
| `playbooks` / `playbook` | experimental | `.cantbook` runtime format stabilising |
| `intelligence` | experimental | Blast-radius / predictImpact APIs under active design |
| `gc` | experimental | GC daemon protocol subject to change |
| `compliance` | experimental | Drift detection API in flux (T-CLI-MISC-DISPATCH) |
| `caamp` | experimental | CAAMP injection chain being formalised |
| `research` | internal | Re-exported from `memory` barrel; use `memory` path |

---

## See also

- `packages/core/STABILITY.md` — full subpath stability contract
- `packages/core/README.md` — installation, quickstart, namespace index
- `docs/plans/E-CORE-FIRST-ARCH.md` — architecture spec, violation audit, migration tasks
- `packages/cleo/src/dispatch/adapters/cli.ts` — `dispatchFromCli` + `dispatchRaw`
- `packages/cleo/src/cli/renderers/index.ts` — `cliOutput` + `cliError`
- `packages/contracts/src/` — all shared types consumed by CORE operations

---

*Document owner: T9623 (T-CORE-AGENT-API-DOC) — Epic T9592 / Saga T9585*  
*Last updated: 2026-05-18*
