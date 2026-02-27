# ADR-020: Session Architecture Cleanup — Drizzle-First, Zero Legacy

**Date**: 2026-02-27
**Status**: accepted
**Accepted**: 2026-02-27
**Related Tasks**: T4959, T5037, T5038, T5039, T5040, T5041, T5042
**Amends**: ADR-003, ADR-006, ADR-008
**Summary**: Completes the session architecture cleanup by establishing Drizzle-first types, eliminating all JSON-era session artifacts (~2,500 lines removed), removing all 33 @deprecated annotations, defining the canonical session lifecycle state machine, documenting the session chain model for agent handoff continuity, and positioning sessions within the BRAIN memory model. All five cleanup waves executed successfully.
**Keywords**: sessions, drizzle, lifecycle, handoff, briefing, chain, cleanup, brain, memory
**Topics**: session, storage, architecture, lifecycle

---

## 1. Context

CLEO's session system accumulated significant technical debt through three overlapping implementation eras:

1. **JSON-file era (v0.1-v0.48)**: Sessions stored in `sessions.json` wrapped in a `SessionsFile` structure with `._meta`, `.sessions[]`, and `.sessionHistory[]` fields. A `multiSessionEnabled` feature flag controlled whether multiple sessions were allowed. The `SessionRecord` interface hand-maintained every field.

2. **Hybrid era (v0.48-v0.68)**: SQLite became canonical storage (ADR-006), but legacy JSON patterns persisted. `loadSessions()` returned a `SessionsFile` wrapper, `sessionEnd()` spliced sessions from `.sessions[]` to `.sessionHistory[]` (which silently deleted ended sessions in SQLite since `saveSessions()` only persisted `.sessions`). Two session engine implementations coexisted: `src/mcp/engine/session-engine.ts` (~1,060 lines, reimplementing core logic) and `src/dispatch/engines/session-engine.ts` (thin wrapper calling core).

3. **Drizzle-first era (v0.68+)**: This ADR codifies the cleanup. The deprecated MCP session-engine was deleted (commit `ffe49957`). Session types are now derived from the Drizzle schema via Zod in `src/store/validation-schemas.ts`. `loadSessions()` returns `Session[]` directly. All JSON-era wrappers, arrays, and feature flags are eliminated or queued for removal.

Three plan documents guided this work:
- `mossy-wondering-moth.md`: Fixed the handoff/briefing pipeline (scope type mismatch, sessionEnd splice bug, handoff consumption gap)
- `scalable-pondering-mccarthy.md`: Session identity architecture overhaul (session chains, auto-binding, rich debrief)
- `goofy-mixing-hopper.md`: Session architecture cleanup plan (Drizzle-first types, wave-by-wave execution)

---

## 2. Decision

### 2.1 Sessions in the BRAIN Memory Model

The CLEO vision document (`docs/concepts/vision.md`) defines sessions as a BRAIN memory type:

> **Sessions** — Handoff notes, briefings, and continuity context — Per-session

Sessions serve a specific role in the BRAIN memory architecture: they are the **unit of continuity** that bridges agent work across conversations. While BRAIN stores long-lived knowledge (observations, patterns, learnings, decisions), sessions store the ephemeral-but-critical context that allows an agent to resume work where a predecessor left off. Specifically:

- **Handoff data**: Structured state snapshot at session end (last task, completed/created tasks, decisions made, open blockers, suggested next actions)
- **Briefing data**: Aggregated orientation at session start (previous session handoff, current task, leverage-scored next tasks, open bugs, blocked tasks, active epics, pipeline stage)
- **Debrief data**: Rich superset of handoff that includes git state, decision log, chain position, and agent identifier

Sessions participate in the BRAIN Three-Layer Retrieval model: session chain queries use indexed lookups (search), session history provides timeline context (timeline), and debrief/handoff JSON provides full details (fetch). This maps directly to the `~10x token savings` pattern described in the vision.

### 2.2 Drizzle-First Type Derivation

All session types are derived from the Drizzle schema, eliminating hand-maintained interfaces:

```
src/store/schema.ts (Drizzle table definition)
  |
  +-- sessions table (26 columns)
  |
  +-- drizzle-orm/zod
        |
        +-- createSelectSchema(sessions) --> selectSessionSchema
        +-- createInsertSchema(sessions) --> insertSessionSchema
        |
        +-- sessionSchema (Zod object, manual alignment)
        |     +-- sessionScopeSchema (JSON blob)
        |     +-- sessionStatsSchema (JSON blob)
        |     +-- sessionTaskWorkSchema (JSON blob)
        |
        +-- z.infer<typeof sessionSchema> --> Session (domain type)
        +-- z.infer<typeof sessionScopeSchema> --> SessionScope
        +-- z.infer<typeof sessionStatsSchema> --> SessionStats
        +-- z.infer<typeof sessionTaskWorkSchema> --> SessionTaskWork
```

The `Session` type is defined in `src/store/validation-schemas.ts` as the SINGLE SOURCE OF TRUTH. The barrel `src/types/session.ts` re-exports these types for consumer convenience. The old hand-maintained interfaces (`SessionRecord` in `src/core/sessions/types.ts`) are retained only for engine-layer compatibility and are scheduled for removal.

### 2.3 Session Lifecycle State Machine

Sessions have four canonical statuses defined in `src/store/status-registry.ts`:

```
SESSION_STATUSES = ['active', 'ended', 'orphaned', 'suspended']
```

State transitions (from actual code):

```
                    +-----------+
        start  --> | active    | <-- resume (from ended/suspended/orphaned)
                    +-----------+
                   /   |   \     \
                  /    |    \     \
         suspend/  end |  gc \   switch
                /      |      \     \
  +-----------+ +------+--+ +--------+  +-----------+
  | suspended | | ended   | | orphaned| | suspended |
  +-----------+ +---------+ +---------+ | (previous)|
                                        +-----------+
```

| Transition | Source | Target | Trigger | Code Location |
|-----------|--------|--------|---------|---------------|
| start | (new) | active | `sessionStart()` | `dispatch/engines/session-engine.ts` |
| end | active | ended | `sessionEnd()` | `dispatch/engines/session-engine.ts` |
| suspend | active | suspended | `suspendSession()` | `core/sessions/session-suspend.ts` |
| resume | ended/suspended/orphaned | active | `sessionResume()` | `dispatch/engines/session-engine.ts` |
| gc (orphan) | active (stale) | ended | `sessionGc()` | `dispatch/engines/session-engine.ts` |
| cleanup (auto-end) | active (stale) | ended | `cleanupSessions()` | `core/sessions/session-cleanup.ts` |
| switch | active -> suspended; target -> active | `switchSession()` | `core/sessions/session-switch.ts` |

Note: The `archived` status existed in the JSON era but is NOT in `SESSION_STATUSES`. Code that references it uses `(session.status as string) === 'archived'` casting, indicating it is a legacy value that may exist in old data but is not a valid canonical state. The cleanup sessions logic removes archived sessions from the store.

### 2.4 Session Chains for Agent Handoff Continuity

Session chains (T4959) link sequential sessions working on the same scope. This enables cross-conversation continuity -- when a new agent session starts with the same scope as a previous ended session, the sessions are linked:

```
Session A (ended) --> Session B (ended) --> Session C (active)
  previousSessionId: null       prev: A.id           prev: B.id
  nextSessionId: B.id           next: C.id           next: null
```

Chain fields on the `sessions` table:
- `previous_session_id TEXT` -- soft FK to predecessor
- `next_session_id TEXT` -- soft FK to successor
- `agent_identifier TEXT` -- LLM agent/conversation identifier
- `handoff_consumed_at TEXT` -- when successor read the handoff
- `handoff_consumed_by TEXT` -- which session consumed the handoff
- `debrief_json TEXT` -- rich debrief (superset of handoff)

Chain linking occurs in `dispatch/engines/session-engine.ts:sessionStart()`:
1. Find most recent ended session for same scope (`status=ended`, matching `rootTaskId` and scope `type`)
2. Set `previousSessionId` on new session
3. Set `nextSessionId` on predecessor
4. Load predecessor's debrief/handoff and include in session start response
5. Mark predecessor's handoff as consumed (`handoffConsumedAt`, `handoffConsumedBy`)

This means a new agent gets full orientation in a single `session.start` call: briefing data, previous session debrief, and chain context -- zero additional queries needed.

### 2.5 Data Flow Architecture

The canonical data flow for session operations:

```
CLI commands              MCP tool calls
    |                          |
    v                          v
src/cli/commands/session.ts   src/dispatch/domains/session.ts
    |                          |
    +------ both call --------+
                |
                v
src/dispatch/engines/session-engine.ts   (thin wrapper, EngineResult)
    |                    |
    |   delegates to     |   direct DB ops for
    v                    v   start/end/resume
src/core/sessions/*      src/store/data-accessor.ts
    |                          |
    v                          v
src/store/data-accessor.ts    src/store/sqlite-data-accessor.ts
    |                              |
    v                              v
src/store/sqlite-data-accessor.ts  Drizzle ORM (sessions table)
    |
    v
SQLite (.cleo/tasks.db)
```

Key data flow details:
- `DataAccessor.loadSessions()` returns `Session[]` directly (no wrapper)
- `DataAccessor.saveSessions(sessions: Session[])` writes all sessions
- `src/store/converters.ts:rowToSession()` converts `SessionRow` to domain `Session` (parsing JSON columns)
- `src/store/db-helpers.ts:upsertSession()` converts domain `Session` to row values (serializing JSON columns)
- `SessionView` (in `core/sessions/session-view.ts`) provides typed collection helpers over `Session[]` without changing the DataAccessor interface

### 2.6 What Was Eliminated and Why

| Artifact | Status | Reason |
|----------|--------|--------|
| `src/mcp/engine/session-engine.ts` | **Deleted** (commit `ffe49957`) | Duplicate engine reimplementing core logic. ADR-003 mandate complete. |
| `SessionsFile` wrapper type | **Eliminated** from DataAccessor | JSON-era artifact. `loadSessions()` returns `Session[]` directly. |
| `sessions.sessionHistory[]` array | **Eliminated** | JSON-era pattern. All sessions live in one SQLite table; status-based queries replace the history concept. |
| `multiSessionEnabled` flag | **Deleted** (Wave 3) | JSON-era feature flag. SQLite always supports multi-session. All guards removed from ~10 files. |
| `sessionHistory[]` array | **Deleted** (Wave 3) | JSON-era pattern removed from all files. Status-based queries replace the history concept. |
| `SessionRecord` interface | **Deleted** (Wave 4) | All 33 `@deprecated` annotations removed across 16 files. `Session` from Drizzle-first Zod schema is the sole type. |
| `src/core/focus/` directory | **Deleted** (Wave 4) | Deprecated focus module removed entirely. |
| `sessions.json` references | **Deleted** (Wave 5) | Legacy JSON session lifecycle functions removed from `core/sessions/index.ts`. All JSON fallback paths eliminated. |
| `schemas/sessions.schema.json` | **Deleted** (Wave 3) | JSON Schema for sessions file no longer needed with SQLite-only storage. |
| `multi-session.ts` | **Deleted** (Wave 3) | Multi-session module removed; SQLite is inherently multi-session. |
| `session-migration.ts` | **Deleted** (Wave 3) | JSON-to-SQLite session migration code removed. |
| `generateSessionId()` in `core/sessions/index.ts` | **Superseded** | Canonical ID generation moved to `core/sessions/session-id.ts` with format `ses_{timestamp}_{hex}`. Legacy formats remain valid for backward compat. |

### 2.7 SessionView as the Query Interface

`SessionView` (`src/core/sessions/session-view.ts`) is a typed wrapper over `Session[]` providing discoverable collection helpers:

```typescript
const sessions = await accessor.loadSessions();
const view = SessionView.from(sessions);

view.findActive()                    // Session | undefined
view.findById(id)                    // Session | undefined
view.filterByStatus('ended', 'suspended')  // Session[]
view.findByScope('epic', 'T001')     // Session[]
view.sortByDate('startedAt', true)   // Session[] (descending)
view.mostRecent()                    // Session | undefined
```

SessionView does NOT change the DataAccessor interface. `loadSessions()` continues returning `Session[]`. Consumers create views as needed. This preserves backward compatibility while offering ergonomic query methods.

---

## 3. RCASD-IVTR+C Integration

Sessions relate to the lifecycle pipeline in two ways:

1. **Session scope tracks lifecycle context**: When a session is scoped to an epic (`scope.type='epic'`, `scope.rootTaskId='T001'`), all session operations (handoff, briefing, drift) are filtered to tasks within that epic's hierarchy. If the epic has an active lifecycle pipeline, the briefing includes `pipelineStage` information.

2. **Lifecycle resume integration**: `startSessionWithResume()` in `core/sessions/index.ts` integrates with `core/lifecycle/resume.ts` to check for resumable lifecycle pipelines when a session starts. This enables an agent to auto-resume interrupted lifecycle work from a previous session.

3. **Provenance chain**: The audit log records `session_id` on every operation. Combined with lifecycle stage tracking, this creates a complete provenance chain: which session, which agent, which lifecycle stage produced each artifact.

The Contribution protocol (+C) interacts with sessions through the `sessionId` field on audit log entries and task `provenance.sessionId`. Every task created, updated, or completed within a session carries the session's identity, establishing the attribution chain from session to artifact.

---

## 4. Consequences

### Positive

- **Type safety**: All session types flow from Drizzle schema through Zod to domain, with zero hand-maintained interfaces
- **No dual-engine**: Single session engine in `dispatch/engines/session-engine.ts` delegating to `core/sessions/*`
- **Clean data flow**: `loadSessions()` returns `Session[]` directly; no wrapper indirection
- **Agent continuity**: Session chains provide zero-query orientation at session start
- **BRAIN alignment**: Sessions serve their defined role as BRAIN memory for handoff/briefing context

### Completed (All Waves Executed)

- **Wave 1**: Deleted deprecated MCP `src/mcp/engine/session-engine.ts` (~1,060 lines, commit `ffe49957`)
- **Wave 2**: Replaced hand-maintained session types with Drizzle-schema-derived types, created `SessionView`, `loadSessions()` returns `Session[]`
- **Wave 3**: Removed `multiSessionEnabled` flag and `sessionHistory` array, deleted `multi-session.ts`, `session-migration.ts`, `schemas/sessions.schema.json`
- **Wave 4**: Removed all 33 `@deprecated` annotations across 16 files, deleted `src/core/focus/` directory
- **Wave 5**: Removed legacy JSON session lifecycle functions from `core/sessions/index.ts`, wrote this ADR, cancelled superseded tasks

### Deferred

- **T5043**: `TaskFile` to `TaskData` modernization with Drizzle-first task Zod schemas (deferred to dedicated epic)

### Residual Risks

- Some core session files may still use `as unknown as TaskFileExt` casts for task file access, which bypass type safety (to be addressed as part of T5043)

---

## 5. Supersedes / Amends

This ADR amends three existing decisions:

- **ADR-003 (MCP Engine Unification)**: The MCP `src/mcp/engine/session-engine.ts` has been deleted. The dispatch `src/dispatch/engines/session-engine.ts` is the sole session engine. This completes the ADR-003 mandate for session engine unification.

- **ADR-006 (Canonical SQLite Storage)**: All session JSON artifacts have been removed. Sessions are exclusively in the SQLite `sessions` table. Session types are Drizzle-first. `loadSessions()` returns `Session[]` directly.

- **ADR-008 (CLEO Canonical Architecture)**: The session-engine migration from `src/mcp/engine/` to `src/core/sessions/` is COMPLETE. `src/dispatch/engines/session-engine.ts` is the sole active engine. Session type unification is complete: single `Session` type from Drizzle-first Zod schema.

---

## 6. References

- Vision document: `docs/concepts/vision.md` (BRAIN memory types, sessions as continuity context)
- Plan: `mossy-wondering-moth.md` (handoff/briefing pipeline fix)
- Plan: `scalable-pondering-mccarthy.md` (session identity architecture overhaul)
- Plan: `goofy-mixing-hopper.md` (session architecture cleanup, Drizzle-first)
- Schema: `src/store/schema.ts` (sessions table definition)
- Domain types: `src/store/validation-schemas.ts` (Session Zod schema, SINGLE SOURCE OF TRUTH)
- Status registry: `src/store/status-registry.ts` (SESSION_STATUSES)
- Session engine: `src/dispatch/engines/session-engine.ts` (sole active engine)
- Core session modules: `src/core/sessions/` (handoff, briefing, cleanup, drift, stats, etc.)
- Store converters: `src/store/converters.ts` (rowToSession)
- Store helpers: `src/store/db-helpers.ts` (upsertSession)
- SessionView: `src/core/sessions/session-view.ts`
- Type barrel: `src/types/session.ts` (re-exports from validation-schemas)
