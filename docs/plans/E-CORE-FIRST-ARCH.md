# E-CORE-FIRST-ARCH — CORE-First Architecture Enforcement

**Epic**: T9592  
**Saga**: SG-CLEO-CORE-V2 (T9585)  
**Status**: RCASD complete — ready for IVTR  
**Date**: 2026-05-18  
**Author**: RCASD subagent (T9592)

---

## 1. Research — Current State Audit

### 1.1 Scope of the audit

Three surfaces examined: `packages/cleo/src/cli/commands/` (CLI), `packages/studio/src/routes/` + `packages/studio/src/lib/server/` (Studio), and `packages/core/src/index.ts` (CORE barrel).

### 1.2 CORE API surface — what is already exported

`packages/core/src/index.ts` is a comprehensive barrel that re-exports:

- All `@cleocode/contracts` types
- ~30 domain namespaces: `tasks`, `sessions`, `memory`, `lifecycle`, `orchestration`, `sentient`, `release`, `gc`, `llm`, `nexus`, `conduit`, `agents`, `skills`, `snapshot`, `spawn`, `security`, `compliance`, `roadmap`, `pipeline`, `routing`, `playbooks`, `reconciliation`, `research`, `identity`, `adrs`, `caamp`, `code`, `codebaseMap`, `context`, `harness`, `inject`, `intelligence`, `issue`, `lib`, `metrics`, `migration`, `observability`, `otel`, `phases`, `sequence`, `stats`
- Direct function exports: `addTask`, `completeTask`, `deleteTask`, `findTasks`, `listTasks`, `showTask`, `updateTask`, `startSession`, `endSession`, `startDaemon`, `stopDaemon`, `getDaemonStatus`, `resolvePlaybook`, `listPlaybooks`, plus more from `sessions`, `task-work`

The CORE barrel is **well-populated**. The problem is not missing exports — it is that CLI commands and Studio routes bypass the dispatch layer and call internal CORE APIs directly, or re-implement CORE query logic in-place.

### 1.3 CLI command audit — 130 command files

**Categorization method**: Whether a command routes all mutations and queries through `dispatchFromCli` / `dispatchRaw`, versus calling CORE (or lower-level internals) directly to perform business logic.

#### Group A: Thin dispatchers (correct) — ~90 files

Representative examples:

| File | Pattern |
|------|---------|
| `complete.ts` | `dispatchRaw` → `tasks.complete` |
| `show.ts` | `dispatchFromCli` → `tasks.show` |
| `add.ts` | `dispatchRaw` → `tasks.add` + `inferTaskAddParams` helper (acceptable — pure util) |
| `config.ts` | `loadConfig` for list only (read-only util access); mutations dispatch |
| `release.ts` | all verbs `dispatchFromCli`; `release.*` imports are for type-only constants |
| `orchestrate.ts` | nearly all `dispatchFromCli`; `orchestration.formatRollupTable` is a pure formatter |
| `llm.ts` | all `dispatchFromCli`; `listProviders` lazy import is a query-only helper |
| `find.ts` | `dispatchFromCli` + `createPage` pagination util |
| `list.ts` | `dispatchFromCli` + `createPage` pagination util |

#### Group B: Direct-CORE callers — no dispatch pathway (violators, ~40 files)

These files contain zero `dispatchFromCli` / `dispatchRaw` calls and embed business logic directly:

| File | Lines | Violation class | Severity |
|------|-------|-----------------|----------|
| `agent.ts` | 3523 | Direct `AgentRegistryAccessor`, `getDb`, `openCleoDb` calls; agent health/doctor logic in-command | HIGH |
| `memory.ts` | 2615 | Direct `getBrainDb`, `getBrainNativeDb`, raw `.prepare()/.all()/.run()` SQL; `runConsolidation`, `getDreamStatus`, `triggerManualDream` called directly | CRITICAL |
| `sentient.ts` | 922 | `spawnSentientDaemon`, `stopSentientDaemon`, `readSentientState`, `patchSentientState`, `safeRunTick`, `safeRunProposeTick` called directly | HIGH |
| `detect-drift.ts` | 504 | Pure static analysis logic in-command; `findProjectRoot`, drift data-structures, all checks implemented in this file | MEDIUM |
| `self-update.ts` | 588 | Shell-out + npm registry fetch + version comparison logic in-command | MEDIUM |
| `web.ts` | 451 | Process lifecycle management (PID files, spawn, signal handling), port checking — no CORE backing | HIGH |
| `daemon.ts` | 457 | `installDaemon`, `getDaemonStatus` from `@cleocode/core/sentient/daemon` directly | MEDIUM |
| `brain.ts` | 446 | `backfillBrainGraph`, `exportBrainAsGexf`, `getMemoryQualityReport`, `purgeBrainNoise`, `runBrainMaintenance` called directly | HIGH |
| `backup.ts` | 633 | Backup/restore logic (file reads, DB operations) without dispatch | HIGH |
| `restore.ts` | 656 | `parseConflictReport`, `parseMarkdownValue`, conflict merge logic inline; direct `fs.readFileSync`/`writeFileSync` | HIGH |
| `transcript.ts` | 477 | Direct file system + path manipulation for transcript management | MEDIUM |
| `backup-inspect.ts` | 481 | SQLite inspection logic directly in command | HIGH |
| `doctor.ts` | 596 | `buildDoctorReport`, `reconcileDoctor`, direct `openCleoDb` calls | HIGH |
| `event.ts` | 451 | Direct event emission logic without dispatch | MEDIUM |
| `gc.ts` | 312 | GC operations called directly | MEDIUM |
| `migrate-agents-v2.ts` | 435 | Migration logic inline | MEDIUM |
| `caamp.ts` | 140 | CAAMP logic without dispatch backing | LOW |
| `cant.ts` | 280 | CANT execution without dispatch | MEDIUM |
| `setup.ts` | 263 | Setup logic inline | MEDIUM |
| `upgrade.ts` | 296 | Version comparison + npm operations inline | MEDIUM |
| `generate-changelog.ts` | 315 | Changelog generation logic inline; `getConfigPath`, `getProjectRoot` | MEDIUM |
| `status.ts` | 295 | System status aggregation without dispatch | MEDIUM |
| `audit.ts` | 123 | Audit log reading inline | LOW |
| `init.ts` | 198 | Calls `initProject`, `scaffoldWorkflows` directly from CORE (acceptable) + `getGitignoreTemplate` inline helper | LOW |
| `refresh-memory.ts` | 36 | `getProjectRoot` + direct trigger | LOW |
| `backfill.ts` | 188 | Backfill operations without dispatch | MEDIUM |
| `checkpoint.ts` | 135 | Checkpoint logic inline | LOW |
| `schema.ts` | 139 | Schema management directly | LOW |
| `detect-drift.ts` | 504 | Full drift analysis logic in-command | MEDIUM |
| `code.ts` | 184 | Code analysis inline | LOW |
| `remote.ts` | 292 | Remote operations inline | MEDIUM |

**Key observation**: `memory.ts` is the most severe violator — it has 20 raw SQL `.prepare()/.all()/.run()` calls against `brain.db` directly in the CLI command handler, bypassing CORE completely. This means changes to the brain schema require touching the CLI command file instead of only `@cleocode/core/memory/`.

#### Group C: Acceptable hybrid commands

Some commands legitimately call CORE without dispatch because they are **infrastructure commands** that do not fit the request/response dispatch model:

| File | Rationale |
|------|-----------|
| `web.ts` | Process lifecycle (PID files, spawn, signals) — no CORE domain exists for this; could move to CORE but CORE gains no generality |
| `daemon.ts` | System service install/uninstall — calls `installDaemon` from CORE correctly |
| `self-update.ts` | npm registry fetch, binary replacement — not a CORE domain concern |
| `init.ts` | Calls `initProject` from CORE correctly; `getGitignoreTemplate` is a CLI-local template helper |

### 1.4 Studio audit

**Studio API routes** live in `packages/studio/src/routes/api/`.

#### Studio Group A: Correct CORE consumers

| Route | Pattern |
|-------|---------|
| `api/tasks/+server.ts` | `listTasks`, `computeTaskRollups`, `computeTaskViews` from `@cleocode/core` — zero raw SQL |
| `api/tasks/[id]/+server.ts` | `computeTaskView`, `getTaskAccessor` from core |
| `api/tasks/pipeline/+server.ts` | `listTasks`, `computeTaskRollups` from core |
| `api/credentials/+server.ts` | `addCredential`, `getCredentialPool` from `@cleocode/core/llm/` |
| `api/setup/section/[name]/+server.ts` | `@cleocode/core/setup/index.js` |

#### Studio Group B: Direct DB violators

These routes open SQLite connections and issue raw SQL queries, bypassing CORE completely:

| Route | Lines | Violation | File:Line |
|-------|-------|-----------|-----------|
| `api/memory/observations/+server.ts` | ~80 | `getBrainDb` + `db.prepare(...).get()`, `db.prepare(...).all()` with inline SQL | `observations/+server.ts:55,67` |
| `api/memory/find/+server.ts` | ~120 | `getBrainDb` + LIKE-scan SQL across 4 tables inline | `find/+server.ts:70-110` |
| `api/memory/decisions/+server.ts` | — | `getBrainDb` + raw SQL | `decisions/+server.ts` |
| `api/memory/patterns/+server.ts` | — | `getBrainDb` + raw SQL | `patterns/+server.ts` |
| `api/memory/learnings/+server.ts` | — | `getBrainDb` + raw SQL | `learnings/+server.ts` |
| `api/memory/graph/+server.ts` | — | `getBrainDb` + raw SQL | `graph/+server.ts` |
| `api/memory/observe/+server.ts` | — | `getBrainDb` + raw write SQL | `observe/+server.ts` |
| `api/memory/pattern-store/+server.ts` | — | `getBrainDb` + raw write SQL | `pattern-store/+server.ts` |
| `api/memory/decision-store/+server.ts` | — | `getBrainDb` + raw write SQL | `decision-store/+server.ts` |
| `api/memory/learning-store/+server.ts` | — | `getBrainDb` + raw write SQL | `learning-store/+server.ts` |
| `api/memory/verify/+server.ts` | — | `getBrainDb` + raw write SQL | `verify/+server.ts` |
| `api/memory/pending-verify/+server.ts` | — | `getBrainDb` + raw SQL | `pending-verify/+server.ts` |
| `api/memory/quality/+server.ts` | — | `getBrainDb` + raw SQL | `quality/+server.ts` |
| `api/memory/tier-stats/+server.ts` | — | `getBrainDb` + raw SQL | `tier-stats/+server.ts` |
| `api/memory/reason-why/+server.ts` | — | `getBrainDb` + raw SQL | `reason-why/+server.ts` |
| `api/search/+server.ts` | ~130 | `new DatabaseSync(nexusPath)` directly + raw `MATCH` SQL | `search/+server.ts:82-130` |
| `api/tasks/graph/+server.ts` | ~60 | `getTasksDb` + raw dep-graph SQL queries | `graph/+server.ts:60-100` |
| `api/tasks/search/+server.ts` | — | Direct SQL search | `search/+server.ts` |
| `api/tasks/events/+server.ts` | — | Direct DB | `events/+server.ts` |
| `api/tasks/tree/[epicId]/+server.ts` | — | Direct DB | `tree/[epicId]/+server.ts` |
| `api/tasks/sessions/+server.ts` | — | Direct DB | `sessions/+server.ts` |
| `api/tasks/[id]/deps/+server.ts` | — | Direct DB | `[id]/deps/+server.ts` |
| `api/nexus/+server.ts` | — | `getNexusDb` + raw SQL | `nexus/+server.ts` |
| `api/nexus/search/+server.ts` | — | `getNexusDb` + raw SQL | `nexus/search/+server.ts` |
| `api/nexus/symbol/[name]/+server.ts` | — | `getNexusDb` + raw SQL | `nexus/symbol/[name]/+server.ts` |
| `api/nexus/community/[id]/+server.ts` | — | `getNexusDb` + raw SQL | `nexus/community/[id]/+server.ts` |
| `api/brain/+server.ts` | ~160 | `getAllSubstrates` from `@cleocode/brain` — **acceptable** (brain is a CORE sub-module) | N/A |
| `api/project/migrate/+server.ts` | — | Direct DB access for migration | `migrate/+server.ts` |
| `api/project/audit/+server.ts` | — | Direct DB access | `audit/+server.ts` |
| `api/health/+server.ts` | — | `getTasksDb` + raw SQL for row count | `health/+server.ts` |

**Critical pattern**: The entire `api/memory/` route tree (~15 endpoints) issues raw SQL against `brain.db` directly. CORE already has `memory` domain operations (`memory.find`, `memory.observe`, `memory.verify`, etc.) that these routes should call.

**Infrastructure note**: `spawn-cli.ts` exists as a fallback for calling the CLI binary from Studio. `api/project/reindex-all` correctly uses this. This pattern is acceptable for operations that are inherently CLI-only (like `nexus analyze` which spawns a background process), but should be the exception, not the rule.

### 1.5 Hermes reference model

`/mnt/projects/hermes-agent/` provides the reference pattern:

- `hermes_agent/` — the backend kernel: all domain logic, LLM adapters, context engine, credential management, file safety. Standalone, no CLI dependency.
- `hermes_cli/` — the CLI adapter: thin command dispatch, output formatting, no domain logic. `commands.py` routes every verb to `hermes_agent/` functions.

This is the exact CORE-first model. The CLI is a calling convention adapter; the agent package is the runtime. Hermes enforces this at the module boundary level: `hermes_cli/` cannot import anything from `hermes_agent/` that is not in the public API surface.

### 1.6 Summary statistics

| Surface | Total files | Thin dispatchers | Direct-CORE violators | Critical violators |
|---------|-------------|------------------|-----------------------|--------------------|
| CLI commands | 130 | ~90 (69%) | ~40 (31%) | 6 (memory, agent, backup/restore, doctor, sentient, brain) |
| Studio API routes | ~60 | ~15 (25%) | ~40 (67%) | 15+ (all memory/* routes) |

---

## 2. Consensus — Design Decisions

### D-1: Definition of "thin adapter"

**Decision**: A CLI command or Studio API route is a thin adapter if and only if:

1. It performs argument parsing / request validation (citty args → typed params).
2. It calls exactly one CORE operation (or a small composition of operations where each is pure CORE).
3. It formats the result for the consumer (terminal output or HTTP JSON).
4. It contains no domain predicates, no SQL, no file I/O beyond what is needed for CLI bootstrap (e.g., `getGitignoreTemplate` in `init.ts`).

**Where the line is drawn**: Infrastructure commands that manage the runtime process of CLEO itself (web server lifecycle, daemon PID management, system service install) are exempt because they have no CORE domain. They SHOULD still have a CORE backing eventually (e.g., `WebServerManager` in CORE), but they are P2 compared to the data-access violations.

### D-2: CORE/internal vs CORE public barrel

**Decision**: CLI commands MUST import from `@cleocode/core` (the public barrel) or its published subpath exports (`@cleocode/core/tasks/list`, etc.). They MUST NOT import from `@cleocode/core/internal`. `@cleocode/core/internal` is reserved for intra-package use and cross-package test utilities.

**Rationale**: CLI commands importing from `@cleocode/core/internal` bypass the public API contract and make refactoring the internals impossible without touching CLI code. The `agent.ts` and `memory.ts` commands both import from `/internal` extensively.

### D-3: Studio direct-DB access

**Decision**: Studio API routes MUST NOT use `getBrainDb`, `getTasksDb`, or `new DatabaseSync(...)` to issue raw SQL. They MUST call CORE operations via direct TypeScript import (`import { ... } from '@cleocode/core/...'`).

**Exception allowed**: `@cleocode/brain` (the `getAllSubstrates` call in `api/brain/+server.ts`) is acceptable because `brain` is a purpose-built, typed, adapter package — not raw DB access. The Studio calling `getAllSubstrates` is equivalent to calling a CORE operation.

**Rationale**: The 15-file `api/memory/` SQL cluster means any brain schema change requires updating both `@cleocode/core/memory/` AND 15 Studio route files. This is the exact duplication CORE-first architecture eliminates.

### D-4: Dispatch domain vs direct CORE import

**Decision**: For CLI → CORE, the dispatch layer (via `dispatchFromCli`/`dispatchRaw`) is the PREFERRED mechanism for all operations that have a registered dispatch operation. Direct CORE imports in CLI commands are acceptable ONLY for:
- Pure utility functions (formatters, paginators, error helpers)
- CORE functions with no dispatch domain analog (infra commands)
- Large commands where dispatch overhead would require architectural surgery — these are acceptable as MEDIUM priority tech debt

**For Studio → CORE**, direct TypeScript import is preferred over `spawn-cli.ts` (subprocess CLI calls). Direct import gives type safety; subprocess call does not.

### D-5: CI lint enforcement

**Decision**: Introduce two ESLint/Biome rules:
1. `no-internal-core-in-cli`: Disallow `import ... from '@cleocode/core/internal'` in `packages/cleo/src/cli/commands/`.
2. `no-raw-sql-in-studio`: Disallow `DatabaseSync`, `.prepare(`, `.all()`, `.run()`, `.get(` in `packages/studio/src/routes/`.

Both rules emit as warnings in the first release and are escalated to errors in the second.

### D-6: LLM/SDK consumer interface

**Decision**: Document the agent-facing CORE API as a first-class surface. Agents import directly from `@cleocode/core` using the three patterns already documented in the barrel comment:

```typescript
// Pattern 1: Facade
import { Cleo } from '@cleocode/core';
const cleo = await Cleo.init('./project');

// Pattern 2: Namespace
import { tasks, sessions, memory, sentient } from '@cleocode/core';

// Pattern 3: Tree-shaken direct
import { addTask, startSession, observeBrain } from '@cleocode/core';
```

The spec doc to be created (`docs/api/CORE-API-AGENT-GUIDE.md`) formalizes which namespaces are stable vs experimental.

---

## 3. Architecture

### 3.1 CORE-first system diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       @cleocode/core                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐ │
│  │  tasks   │ │ sessions │ │  memory  │ │  sentient / gc     │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐ │
│  │lifecycle │ │   llm    │ │  nexus   │ │  orchestration     │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────────┘ │
│              ... (30+ domain namespaces) ...                     │
└────────────────────────────────────────────────────────────────-┘
         ↑                    ↑                    ↑
         │ import             │ import             │ import
  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
  │  @cleocode/  │    │  @cleocode/  │    │  LLM agents /    │
  │    cleo      │    │   studio     │    │  SDK consumers   │
  │  (CLI only)  │    │  (SvelteKit) │    │                  │
  │              │    │              │    │                  │
  │  parse args  │    │  parse HTTP  │    │  direct import   │
  │  dispatch →  │    │  call CORE → │    │  or Cleo facade  │
  │  format out  │    │  return JSON │    │                  │
  └──────────────┘    └──────────────┘    └──────────────────┘
```

### 3.2 Dispatch wrapper pattern (CLI)

Every CLI command MUST follow this pattern:

```typescript
// packages/cleo/src/cli/commands/example.ts
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export const exampleCommand = defineCommand({
  meta: { name: 'example', description: '...' },
  args: { /* citty args */ },
  async run({ args }) {
    await dispatchFromCli(
      'query',          // gateway: 'query' | 'mutate' | 'subscribe'
      'domain',         // domain name (matches dispatch/domains/)
      'operation.name', // operation key
      { /* typed params from args */ },
      { command: 'example' },
    );
  },
});
```

For commands that need pre-processing (e.g., reading from stdin for `cleo llm add`), the pre-processing occurs BEFORE the dispatch call and produces the params. No post-processing beyond what `cliOutput` / `cliError` provides.

### 3.3 Studio API route pattern

```typescript
// packages/studio/src/routes/api/memory/find/+server.ts
import { findMemoryEntries } from '@cleocode/core/memory'; // ← CORE, not raw SQL
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
  const query = url.searchParams.get('q') ?? '';
  const result = await findMemoryEntries({ query, projectPath: locals.projectCtx.projectPath });
  return json(result);
};
```

### 3.4 CORE operation surface — new operations needed

Based on the violator analysis, the following CORE operations are missing or need to be promoted from internal to public:

| Domain | Missing operation | Currently in |
|--------|------------------|-------------|
| `memory` | `findMemoryEntries(opts)` — cross-table search | CLI command inline SQL |
| `memory` | `getObservations(opts)` — filtered observation list | Studio route inline SQL |
| `memory` | `getDecisions(opts)` | Studio route inline SQL |
| `memory` | `getPatterns(opts)` | Studio route inline SQL |
| `memory` | `getLearnings(opts)` | Studio route inline SQL |
| `memory` | `getMemoryGraph(opts)` | Studio route inline SQL |
| `memory` | `getTierStats()` | Studio route inline SQL |
| `memory` | `getPendingVerify()` | Studio route inline SQL |
| `memory` | `getQualityReport()` | `getMemoryQualityReport` exists in internal — needs promotion |
| `agents` | `registerAgent(opts)` | `AgentRegistryAccessor` called directly in CLI |
| `agents` | `listAgents(projectPath)` | `listAgentsForProject` in internal |
| `agents` | `getAgent(id)` | `lookupAgent` in internal |
| `agents` | `removeAgent(id)` | `AgentRegistryAccessor` in internal |
| `agents` | `rotateAgentKey(id)` | `AgentRegistryAccessor` in internal |
| `tasks` | `getTaskGraph(epicId)` | Studio route inline SQL |
| `tasks` | `getTaskTree(epicId)` | Studio route inline SQL |
| `tasks` | `searchTasks(query)` | Studio route inline SQL |
| `nexus` | `searchSymbols(query, opts)` | Studio `api/search` inline SQL |
| `nexus` | `getSymbol(name)` | Studio `api/nexus/symbol/[name]` inline SQL |
| `nexus` | `getCommunity(id)` | Studio route inline SQL |

### 3.5 CI lint rule design

**Rule 1 — `no-internal-core-in-cli`** (ESLint custom rule or Biome `noRestrictedImports`):

```json
{
  "files": ["packages/cleo/src/cli/commands/**/*.ts"],
  "rules": {
    "no-restricted-imports": ["warn", {
      "patterns": ["@cleocode/core/internal*"],
      "message": "CLI commands must not import from @cleocode/core/internal. Promote the function to the public CORE barrel or add a dispatch operation."
    }]
  }
}
```

**Rule 2 — `no-raw-sql-in-studio`** (Biome `noRestrictedSyntax` or custom rule):

Detect `DatabaseSync`, `db.prepare(`, `.all()` calls in `packages/studio/src/routes/`:

```json
{
  "files": ["packages/studio/src/routes/**/*.ts"],
  "rules": {
    "no-restricted-syntax": [
      "warn",
      { "selector": "NewExpression[callee.name='DatabaseSync']", "message": "Studio routes must not open SQLite connections directly. Use @cleocode/core operations." },
      { "selector": "CallExpression[callee.property.name='prepare']", "message": "Studio routes must not issue raw SQL. Use @cleocode/core operations." }
    ]
  }
}
```

---

## 4. Specification — RFC 2119 Acceptance Criteria

### Global ACs (apply to all tasks in this epic)

- AC-G1: All code changes MUST pass `pnpm run build` and `pnpm run test` with zero new failures.
- AC-G2: All new/modified files MUST pass `pnpm biome check --write .`.
- AC-G3: All new CORE exports MUST have TSDoc comments (`/** ... */`) on the exported symbol.
- AC-G4: No `any` types MUST be introduced; all new code MUST be TypeScript strict.

---

## 5. Decomposition — Tasks

### T-CORE-API-PROMOTE (Task 1): Promote memory + agents from internal to public CORE barrel

**Size**: large  
**Priority**: critical  
**Kind**: work  
**Acceptance**:

- AC1: `@cleocode/core/memory` exports `findMemoryEntries(opts)`, `getObservations(opts)`, `getDecisions(opts)`, `getPatterns(opts)`, `getLearnings(opts)`, `getMemoryGraph(opts)`, `getTierStats(projectPath)`, `getPendingVerify(projectPath)`, `getMemoryQualityReport(projectPath)` — all typed, no raw SQL in consumers.
- AC2: `@cleocode/core/agents` exports `registerAgent`, `listAgents`, `getAgent`, `removeAgent`, `rotateAgentKey` — wrappers over existing `AgentRegistryAccessor`, promoted to public.
- AC3: All promoted functions are exported from `packages/core/src/index.ts` barrel.
- AC4: No changes to `packages/core/src/internal.ts` — internal remains internal; the promotion adds new public wrappers.
- AC5: Unit tests added for all new public functions (minimum: one happy-path test per function).

**Subtasks**:
- T-CORE-API-PROMOTE-1: memory query operations (findMemoryEntries, getObservations, getDecisions, getPatterns, getLearnings)
- T-CORE-API-PROMOTE-2: memory graph + tier operations (getMemoryGraph, getTierStats, getPendingVerify, getMemoryQualityReport)
- T-CORE-API-PROMOTE-3: agent CRUD operations (registerAgent, listAgents, getAgent, removeAgent, rotateAgentKey)
- T-CORE-API-PROMOTE-4: task graph/tree/search operations (getTaskGraph, getTaskTree, searchTasks)
- T-CORE-API-PROMOTE-5: nexus query operations (searchSymbols, getSymbol, getCommunity)

---

### T-STUDIO-MEMORY-ROUTES (Task 2): Replace all `api/memory/*` raw SQL with CORE calls

**Size**: large  
**Priority**: high  
**Kind**: work  
**Depends on**: T-CORE-API-PROMOTE  
**Acceptance**:

- AC1: All 15 `packages/studio/src/routes/api/memory/` routes have zero `getBrainDb` calls.
- AC2: All 15 routes import from `@cleocode/core/memory` (or `@cleocode/core`) only.
- AC3: Zero `db.prepare(`, `.all()`, `.run()`, `.get(` calls in `packages/studio/src/routes/api/memory/`.
- AC4: All existing Studio memory UI features continue to work (tested by running Studio and verifying the brain graph page loads with data).
- AC5: No raw SQL in `packages/studio/src/lib/server/` except in `db/connections.ts` (which is the abstraction boundary — the connection pool itself is allowed).

**Subtasks**:
- T-STUDIO-MEMORY-ROUTES-1: Replace read routes (observations, decisions, patterns, learnings, find, graph, tier-stats, pending-verify, quality, reason-why)
- T-STUDIO-MEMORY-ROUTES-2: Replace write routes (observe, pattern-store, decision-store, learning-store, verify)

---

### T-STUDIO-TASKS-ROUTES (Task 3): Replace `api/tasks/graph`, `api/tasks/search`, `api/tasks/tree`, `api/tasks/sessions`, `api/tasks/[id]/deps` raw SQL with CORE calls

**Size**: medium  
**Priority**: high  
**Kind**: work  
**Depends on**: T-CORE-API-PROMOTE  
**Acceptance**:

- AC1: `api/tasks/graph/+server.ts` uses `getTaskGraph(epicId, projectPath)` from CORE — no `getTasksDb` or raw SQL.
- AC2: `api/tasks/search/+server.ts` uses `searchTasks(query, projectPath)` from CORE.
- AC3: `api/tasks/tree/[epicId]/+server.ts` uses `getTaskTree(epicId, projectPath)` from CORE.
- AC4: `api/tasks/sessions/+server.ts` uses `listSessions(projectPath)` from CORE (already exported; verify and wire).
- AC5: `api/tasks/[id]/deps/+server.ts` uses CORE dep-graph API.
- AC6: `api/health/+server.ts` replaces raw task count SQL with `listTasks({ limit: 1 })`.

**Subtasks**:
- T-STUDIO-TASKS-ROUTES-1: task graph + tree + deps routes
- T-STUDIO-TASKS-ROUTES-2: tasks search + sessions + health routes

---

### T-STUDIO-NEXUS-ROUTES (Task 4): Replace `api/nexus/*` + `api/search` raw SQL with CORE nexus operations

**Size**: medium  
**Priority**: high  
**Kind**: work  
**Depends on**: T-CORE-API-PROMOTE  
**Acceptance**:

- AC1: `api/search/+server.ts` uses `nexus.searchSymbols(query, opts)` from CORE — no `new DatabaseSync(nexusPath)`.
- AC2: `api/nexus/+server.ts`, `api/nexus/search`, `api/nexus/symbol/[name]`, `api/nexus/community/[id]` use CORE nexus query operations.
- AC3: `getNexusDb()` in `db/connections.ts` is removed or deprecated with a comment pointing to the CORE nexus operations (keep only if `@cleocode/brain` getAllSubstrates still needs it directly).
- AC4: All existing Studio code-intelligence views work correctly.

**Subtasks**:
- T-STUDIO-NEXUS-ROUTES-1: api/search + api/nexus/* routes

---

### T-CLI-MEMORY-DISPATCH (Task 5): Replace `memory.ts` CLI command inline SQL and direct-internal imports with CORE dispatch

**Size**: large  
**Priority**: critical  
**Kind**: work  
**Depends on**: T-CORE-API-PROMOTE  
**Acceptance**:

- AC1: `packages/cleo/src/cli/commands/memory.ts` has zero `.prepare(`, `.all()`, `.run()`, `.get(` calls.
- AC2: `memory.ts` imports zero items from `@cleocode/core/internal`.
- AC3: All `memory` subcommands (store, find, stats, observe, timeline, fetch, decision-find, decision-store, link, trace, related, context, graph-stats, graph-show, graph-neighbors, graph-add, graph-remove, reason-why, reason-similar, search-hybrid, code-links, code-auto-link, code-memories-for-code, code-for-memory, consolidate, dream, reflect, dedup-scan, import, llm-status, verify, pending-verify, tier) route through `dispatchFromCli` or call a public CORE function.
- AC4: The `memory import` subcommand's `parseMemoryFileFrontmatter` helper is moved to `@cleocode/core/memory/import-helpers.ts` (or inlined into the CORE operation) rather than living in the CLI command file.
- AC5: The inline state file management for memory import (hash tracking) is moved to CORE.

**Subtasks**:
- T-CLI-MEMORY-DISPATCH-1: memory read operations (find, fetch, timeline, stats, observations, decisions, patterns, learnings)
- T-CLI-MEMORY-DISPATCH-2: memory write operations (observe, store, decision-store, verify, tier)
- T-CLI-MEMORY-DISPATCH-3: memory graph operations (graph-*, reason-*, search-hybrid, code-*)
- T-CLI-MEMORY-DISPATCH-4: memory pipeline operations (consolidate, dream, reflect, dedup-scan, import)

---

### T-CLI-AGENT-DISPATCH (Task 6): Replace `agent.ts` CLI command direct-internal imports with CORE dispatch

**Size**: large  
**Priority**: high  
**Kind**: work  
**Depends on**: T-CORE-API-PROMOTE  
**Acceptance**:

- AC1: `packages/cleo/src/cli/commands/agent.ts` imports zero items from `@cleocode/core/internal`.
- AC2: All agent registry operations (register, list, get, remove, rotate-key) route through `dispatchFromCli` or call the promoted public `@cleocode/core/agents` API.
- AC3: The agent doctor/health check logic (`computeProfileStatus`, `checkAgentHealth`, `detectCrashedAgents`, `detectStaleAgents`) is either (a) dispatched through the existing `agents.doctor` operation or (b) the operation is added to the dispatch registry.
- AC4: `agent.ts` line count reduces by at least 30% (current: 3523 lines).
- AC5: All existing `cleo agent *` subcommands produce identical output to pre-change behavior.

**Subtasks**:
- T-CLI-AGENT-DISPATCH-1: agent registry CRUD (register, list, get, remove, rotate-key)
- T-CLI-AGENT-DISPATCH-2: agent health/doctor operations (poll, start, install, pack, create)
- T-CLI-AGENT-DISPATCH-3: agent send/conduit integration

---

### T-CLI-MISC-DISPATCH (Task 7): Replace remaining CLI command direct-CORE-internal imports with public API

**Size**: medium  
**Priority**: medium  
**Kind**: work  
**Depends on**: T-CORE-API-PROMOTE  
**Acceptance**:

- AC1: `brain.ts` imports zero items from `@cleocode/core/internal`; all operations call public CORE API.
- AC2: `sentient.ts` imports from `@cleocode/core/sentient` public exports (not deep path internals).
- AC3: `backup.ts` and `restore.ts` — the `parseConflictReport`, conflict-merge logic, and `parseMarkdownValue` helpers are either moved to `@cleocode/core/restore/` or the commands are left as-is with a tech-debt comment (these are CLI-local file operations with no runtime domain concern).
- AC4: `generate-changelog.ts` inline changelog logic is either dispatched or moved to `@cleocode/core/release/`.
- AC5: `detect-drift.ts` inline analysis logic is moved to `@cleocode/core/compliance/drift.ts` and the CLI command dispatches.
- AC6: `doctor.ts` uses `buildDoctorReport` and `reconcileDoctor` from the public CORE barrel (not `/internal`).

**Subtasks**:
- T-CLI-MISC-DISPATCH-1: brain.ts + sentient.ts + doctor.ts
- T-CLI-MISC-DISPATCH-2: backup.ts + restore.ts + generate-changelog.ts
- T-CLI-MISC-DISPATCH-3: detect-drift.ts + status.ts + gc.ts

---

### T-CORE-FIRST-LINT (Task 8): Add CI lint rules enforcing CORE-first boundaries

**Size**: small  
**Priority**: high  
**Kind**: work  
**Acceptance**:

- AC1: ESLint config in `packages/cleo/` has a `no-restricted-imports` rule (warning level) for `@cleocode/core/internal` in `src/cli/commands/**/*.ts`. CI runs this check.
- AC2: ESLint or Biome config in `packages/studio/` has a rule (warning level) detecting `DatabaseSync`, `.prepare(`, `.all(`, `.run(`, `.get(` in `src/routes/**/*.ts`.
- AC3: Both rules appear in `pnpm run lint` output for the respective packages.
- AC4: CI workflow (`ci.yml` or equivalent) runs `pnpm run lint` for both packages.
- AC5: Both rules emit warnings (not errors) in this task; escalation to errors is scheduled for the follow-up sprint.

**Subtasks**: none — single task

---

### T-CORE-AGENT-API-DOC (Task 9): Write `docs/api/CORE-API-AGENT-GUIDE.md`

**Size**: small  
**Priority**: medium  
**Kind**: work  
**Acceptance**:

- AC1: `docs/api/CORE-API-AGENT-GUIDE.md` exists and documents the three import patterns (Facade, Namespace, Tree-shaken direct).
- AC2: Document lists the 10 most commonly needed namespaces for agent consumers: `tasks`, `sessions`, `memory`, `sentient`, `llm`, `agents`, `lifecycle`, `orchestration`, `conduit`, `snapshot`.
- AC3: Document marks namespaces as stable/experimental/deprecated per current status.
- AC4: Document includes one complete worked example for a common agent workflow (task add → complete lifecycle).
- AC5: Document is linked from `packages/core/README.md` (or equivalent, if it exists).

**Subtasks**: none — single task

---

## 6. Worker Dispatch + Ship Plan

### Wave 0 (unblocked — can start immediately)

| Task | Agent type | Notes |
|------|-----------|-------|
| T-CORE-API-PROMOTE | implementation | Foundation task; all others depend on it |
| T-CORE-FIRST-LINT | implementation | Independent; can be done in parallel with wave 0 |
| T-CORE-AGENT-API-DOC | research/spec | Independent documentation task |

### Wave 1 (unblocked after T-CORE-API-PROMOTE completes)

| Task | Agent type | Notes |
|------|-----------|-------|
| T-STUDIO-MEMORY-ROUTES | implementation | 15 routes; large surface |
| T-STUDIO-TASKS-ROUTES | implementation | 6 routes; medium surface |
| T-STUDIO-NEXUS-ROUTES | implementation | 5 routes; medium surface |
| T-CLI-MEMORY-DISPATCH | implementation | Most critical CLI violator |

### Wave 2 (unblocked after Wave 1 stabilizes)

| Task | Agent type | Notes |
|------|-----------|-------|
| T-CLI-AGENT-DISPATCH | implementation | Largest CLI violator by line count |
| T-CLI-MISC-DISPATCH | implementation | Remaining CLI violators |

### Validation

After each wave: run `pnpm run test` (full suite), `pnpm biome check .`, and manually verify a representative CLI command from each changed domain produces correct output.

### Timeline

- Wave 0: Sprint 1 (parallel, ~2 days per task)
- Wave 1: Sprint 2 (parallel agents, ~3 days per task)
- Wave 2: Sprint 3 (parallel agents, ~2 days per task)

---

## Appendix A: File reference index

| File | Type | Status |
|------|------|--------|
| `packages/cleo/src/cli/commands/memory.ts` | CLI violator | CRITICAL — raw SQL + internal imports |
| `packages/cleo/src/cli/commands/agent.ts` | CLI violator | HIGH — 3523 lines, all internal |
| `packages/cleo/src/cli/commands/brain.ts` | CLI violator | HIGH — internal imports |
| `packages/cleo/src/cli/commands/sentient.ts` | CLI violator | HIGH — deep path imports |
| `packages/cleo/src/cli/commands/backup.ts` | CLI violator | HIGH — embedded file logic |
| `packages/cleo/src/cli/commands/restore.ts` | CLI violator | HIGH — conflict parse logic |
| `packages/cleo/src/cli/commands/doctor.ts` | CLI violator | HIGH — openCleoDb direct |
| `packages/studio/src/routes/api/memory/` | Studio violator | CRITICAL — all 15 routes, raw SQL |
| `packages/studio/src/routes/api/search/+server.ts` | Studio violator | HIGH — DatabaseSync direct |
| `packages/studio/src/routes/api/tasks/graph/+server.ts` | Studio violator | HIGH — raw dep-graph SQL |
| `packages/studio/src/routes/api/nexus/` | Studio violator | HIGH — 4 routes, raw nexus SQL |
| `packages/core/src/index.ts` | CORE barrel | Good — comprehensive, well-structured |
| `packages/cleo/src/dispatch/` | Dispatch layer | Good — properly routes 90 commands |
| `packages/studio/src/lib/server/spawn-cli.ts` | Studio infra | Acceptable — subprocess fallback only |

---

*End of E-CORE-FIRST-ARCH specification.*
