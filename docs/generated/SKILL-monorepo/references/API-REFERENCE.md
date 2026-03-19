# @cleocode/monorepo — API Reference

## Table of Contents

- [Functions](#functions)
- [Types](#types)
- [Classes](#classes)
- [Constants](#constants)

## Functions

### `checkStatuslineIntegration`

Check if statusline integration is configured. Returns the current integration status.

```typescript
() => StatuslineStatus
```

### `getStatuslineConfig`

Get the statusline setup command for Claude Code settings.

```typescript
(cleoHome: string) => Record<string, unknown>
```

### `getSetupInstructions`

Get human-readable setup instructions.

```typescript
(cleoHome: string) => string
```

### `createAdapter`

Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback.

```typescript
() => ClaudeCodeAdapter
```

### `createAdapter`

Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback.

```typescript
() => CursorAdapter
```

### `buildOpenCodeAgentMarkdown`

Build the markdown content for an OpenCode agent definition file.  OpenCode agents are defined as markdown files with YAML frontmatter in the .opencode/agent/ directory.

```typescript
(description: string, instructions: string) => string
```

**Parameters:**

- `description` — Agent description for frontmatter
- `instructions` — Markdown instructions body

**Returns:** Complete agent definition markdown

### `createAdapter`

Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback.

```typescript
() => OpenCodeAdapter
```

### `getProviderManifests`

Get the manifests for all bundled provider adapters.

```typescript
() => AdapterManifest[]
```

**Returns:** Array of adapter manifests

### `discoverProviders`

Discover all available provider adapters.  Returns a map of provider ID to adapter factory function.

```typescript
() => Promise<Map<string, () => Promise<unknown>>>
```

### `setFieldContext`

Set the field extraction context for this CLI invocation. Called once from the preAction hook in src/cli/index.ts.

```typescript
(ctx: FieldExtractionResolution) => void
```

### `getFieldContext`

Get the current field extraction context.

```typescript
() => FieldExtractionResolution
```

### `resolveFieldContext`

Parse global field options from Commander.js parsed opts and resolve via the canonical LAFS SDK resolver (conflict detection, type narrowing).

```typescript
(opts: Record<string, unknown>) => FieldExtractionResolution
```

### `setFormatContext`

Set the resolved format for this CLI invocation. Called once from the preAction hook in src/cli/index.ts.

```typescript
(resolution: FlagResolution) => void
```

### `getFormatContext`

Get the current resolved format.

```typescript
() => FlagResolution
```

### `isJsonFormat`

Check if output should be JSON format.

```typescript
() => boolean
```

### `isHumanFormat`

Check if output should be human-readable format.

```typescript
() => boolean
```

### `isQuiet`

Check if quiet mode is enabled (suppress non-essential output).

```typescript
() => boolean
```

### `normalizeForHuman`

Normalize data shape for human renderers.  Each command expects data with specific named keys (e.g., `data.task` for 'show', `data.tasks` for 'list'). This function detects and corrects flat/array data from the engine layer.

```typescript
(command: string, data: Record<string, unknown>) => Record<string, unknown>
```

### `statusSymbol`

Map task status to a display symbol. Falls back to '?' for unknown values.

```typescript
(status: string) => string
```

### `statusColor`

Map task status to a color escape.

```typescript
(status: string) => string
```

### `prioritySymbol`

Map task priority to a display symbol.

```typescript
(priority: string) => string
```

### `priorityColor`

Map task priority to a color escape.

```typescript
(priority: string) => string
```

### `hRule`

Create a horizontal rule with box-drawing characters.

```typescript
(width?: number) => string
```

### `shortDate`

Format a date string as YYYY-MM-DD.

```typescript
(isoDate: string | null | undefined) => string
```

### `renderDoctor`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderStats`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderNext`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderBlockers`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderTree`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderStart`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderStop`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderCurrent`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderSession`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderVersion`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderPlan`

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderGeneric`

Generic human renderer for commands that don't have a specific renderer. Renders data as indented key-value pairs.

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderShow`

Render a single task in a box format (mirrors bash display_text).

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderList`

Render a list of tasks (mirrors bash list.sh text output).

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderFind`

Render search results.

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderAdd`

Render add result.

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderUpdate`

Render update result.

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderComplete`

Render complete result.

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderDelete`

Render delete result.

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderArchive`

Render archive result.

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `renderRestore`

Render restore result.

```typescript
(data: Record<string, unknown>, quiet: boolean) => string
```

### `cliOutput`

Output data to stdout in the resolved format (JSON or human-readable).  Replaces `console.log(formatSuccess(data))` in all V2 commands. When format is 'human', normalizes the data shape then dispatches to the appropriate renderer. When format is 'json', delegates to existing formatSuccess().   T4665  T4666  T4813

```typescript
(data: unknown, opts: CliOutputOptions) => void
```

### `cliError`

Output an error in the resolved format. For JSON: delegates to formatError (already handled in command catch blocks). For human: prints a plain error message to stderr.   T4666  T4813

```typescript
(message: string, code?: string | number | undefined, _details?: CliErrorDetails | undefined) => void
```

### `createDispatchMeta`

Create metadata for a dispatch response.

```typescript
(gateway: string, domain: string, operation: string, startTime: number, source?: Source, requestId?: string | undefined, sessionId?: string | null | undefined) => { ...; }
```

**Parameters:**

- `gateway` — Gateway name (e.g., 'query', 'mutate')
- `domain` — Domain name (e.g., 'tasks', 'session')
- `operation` — Operation name (e.g., 'show', 'list')
- `startTime` — Timestamp from Date.now() at start of request
- `source` — Where the request originated ('cli' or 'mcp')
- `requestId` — Optional pre-generated request ID
- `sessionId` — Optional session ID to include in metadata

**Returns:** Metadata conforming to DispatchResponse['_meta']   T4772  T4959

### `compose`

Composes an array of Middleware functions into a single Middleware function. Execution flows through the array from first to last, and returns bubble back up from last to first.

```typescript
(middlewares: Middleware[]) => Middleware
```

**Parameters:**

- `middlewares` — Array of middleware functions to chain

**Returns:** A single composed Middleware function

### `deriveGatewayMatrix`

Derive a gateway operation matrix from the registry.  Returns `Record<string, string[]>` containing: - All canonical domains with their operations  This is the SINGLE derivation point — gateways use this instead of maintaining independent operation lists.

```typescript
(gateway: Gateway) => Record<string, string[]>
```

### `getGatewayDomains`

Get all accepted domain names for a gateway (canonical only).

```typescript
(gateway: Gateway) => string[]
```

### `resolve`

Resolves a domain + operation to its registered definition.

```typescript
(gateway: Gateway, domain: string, operation: string) => Resolution | undefined
```

### `validateRequiredParams`

Validates that all required parameters are present in the request. Returns an array of missing parameter keys.

```typescript
(def: OperationDef, params?: Record<string, unknown> | undefined) => string[]
```

### `getByDomain`

Get all operations for a specific canonical domain.

```typescript
(domain: "tasks" | "session" | "memory" | "check" | "pipeline" | "orchestrate" | "tools" | "admin" | "nexus" | "sticky") => OperationDef[]
```

### `getByGateway`

Get all operations for a specific gateway.

```typescript
(gateway: Gateway) => OperationDef[]
```

### `getByTier`

Get all operations available at or below a specific tier.

```typescript
(tier: Tier) => OperationDef[]
```

### `getActiveDomains`

Get a list of canonical domains that actually have operations registered.

```typescript
() => ("tasks" | "session" | "memory" | "check" | "pipeline" | "orchestrate" | "tools" | "admin" | "nexus" | "sticky")[]
```

### `getCounts`

Returns summary counts of operations for module validation.

```typescript
() => { query: number; mutate: number; total: number; }
```

### `engineError`

Create a typed engine error result with pino logging and correct exit code.

```typescript
<T>(code: string, message: string, options?: { details?: Record<string, unknown> | undefined; fix?: string | undefined; alternatives?: { action: string; command: string; }[] | undefined; } | undefined) => EngineResult<...>
```

**Parameters:**

- `code` — String error code (e.g., 'E_NOT_FOUND')
- `message` — Human-readable error message
- `options` — Optional details, fix command, and alternatives

**Returns:** EngineResult with success=false and properly structured error

### `engineSuccess`

Create an engine success result.

```typescript
<T>(data: T) => EngineResult<T>
```

**Parameters:**

- `data` — The result data

**Returns:** EngineResult with success=true

### `mapCodebase`

Analyze a codebase and return structured mapping. When storeToBrain is true, findings are persisted to brain.db.

```typescript
(projectRoot: string, options?: { focus?: string | undefined; storeToBrain?: boolean | undefined; } | undefined) => Promise<EngineResult<unknown>>
```

### `configGet`

Get config value by key (dot-notation supported)

```typescript
(projectRoot: string, key?: string | undefined) => Promise<EngineResult<unknown>>
```

### `configSet`

Set a config value by key (dot-notation supported)

```typescript
(projectRoot: string, key: string, value: unknown) => Promise<EngineResult<{ key: string; value: unknown; }>>
```

### `initProject`

Initialize a CLEO project directory.  Creates the .cleo/ directory structure with empty data files. Returns error if already initialized (unless force=true).

```typescript
(projectRoot: string, options?: { projectName?: string | undefined; force?: boolean | undefined; } | undefined) => Promise<EngineResult<{ initialized: boolean; projectRoot: string; filesCreated: string[]; }>>
```

### `isAutoInitEnabled`

Check if auto-init is enabled via environment variable

```typescript
() => boolean
```

### `ensureInitialized`

Check initialization status and auto-init if configured

```typescript
(projectRoot: string) => Promise<EngineResult<{ initialized: boolean; }>>
```

### `getVersion`

Get current version (native implementation)

```typescript
(projectRoot: string) => Promise<EngineResult<{ version: string; }>>
```

### `listRcsdEpics`

List all epic IDs that have RCASD pipeline data.

```typescript
(projectRoot?: string | undefined) => Promise<string[]>
```

### `lifecycleStatus`

lifecycle.check / lifecycle.status - Get lifecycle status for epic.  T4785

```typescript
(epicId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `lifecycleHistory`

lifecycle.history - Stage transition history.  T4785

```typescript
(taskId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `lifecycleGates`

lifecycle.gates - Get all gate statuses for an epic.  T4785

```typescript
(taskId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `lifecyclePrerequisites`

lifecycle.prerequisites - Get required prior stages for a target stage.  T4785

```typescript
(targetStage: string, _projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `lifecycleCheck`

lifecycle.check - Check if a stage's prerequisites are met.  T4785

```typescript
(epicId: string, targetStage: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `lifecycleProgress`

lifecycle.progress / lifecycle.record - Record stage completion.  T4785

```typescript
(taskId: string, stage: string, status: string, notes?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `lifecycleSkip`

lifecycle.skip - Skip a stage with reason.  T4785

```typescript
(taskId: string, stage: string, reason: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `lifecycleReset`

lifecycle.reset - Reset a stage (emergency).  T4785

```typescript
(taskId: string, stage: string, reason: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `lifecycleGatePass`

lifecycle.gate.pass - Mark gate as passed.  T4785

```typescript
(taskId: string, gateName: string, agent?: string | undefined, notes?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `lifecycleGateFail`

lifecycle.gate.fail - Mark gate as failed.  T4785

```typescript
(taskId: string, gateName: string, reason?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `sessionStatus`

Get current session status.  T4782

```typescript
(projectRoot: string) => Promise<EngineResult<{ hasActiveSession: boolean; session?: Session | null | undefined; taskWork?: TaskWorkState | null | undefined; }>>
```

### `sessionList`

List sessions with budget enforcement.  When a limit is applied (explicit or default), the response includes `_meta.truncated` and `_meta.total` so agents know the result set was capped.   T4782  T5120 - budget enforcement metadata  T5121 - default limit=10

```typescript
(projectRoot: string, params?: { active?: boolean | undefined; status?: string | undefined; limit?: number | undefined; offset?: number | undefined; } | undefined) => Promise<EngineResult<{ sessions: Session[]; total: number; filtered: number; _meta: { ...; }; }>>
```

### `sessionFind`

Lightweight session discovery — returns minimal session records.   T5119

```typescript
(projectRoot: string, params?: FindSessionsParams | undefined) => Promise<EngineResult<MinimalSessionRecord[]>>
```

### `sessionShow`

Show a specific session.  T4782

```typescript
(projectRoot: string, sessionId: string) => Promise<EngineResult<Session>>
```

### `taskCurrentGet`

Get current task being worked on. Delegates to core/task-work/currentTask.  T4782

```typescript
(projectRoot: string) => Promise<EngineResult<{ currentTask: string | null; currentPhase: string | null; }>>
```

### `taskStart`

Start working on a specific task. Delegates to core/task-work/startTask.  T4782

```typescript
(projectRoot: string, taskId: string) => Promise<EngineResult<{ taskId: string; previousTask: string | null; }>>
```

### `taskStop`

Stop working on the current task. Delegates to core/task-work/stopTask.  T4782

```typescript
(projectRoot: string) => Promise<EngineResult<{ cleared: boolean; previousTask: string | null; }>>
```

### `taskWorkHistory`

Get task work history from session notes.  T5323

```typescript
(projectRoot: string) => Promise<EngineResult<{ history: TaskWorkHistoryEntry[]; count: number; }>>
```

### `sessionStart`

Start a new session. Note: This function has engine-specific logic for task file focus management and session store updates, so it remains in the engine layer.  T4782

```typescript
(projectRoot: string, params: { scope: string; name?: string | undefined; autoStart?: boolean | undefined; startTask?: string | undefined; grade?: boolean | undefined; }) => Promise<EngineResult<Session>>
```

### `sessionEnd`

End the current session. Note: This function has engine-specific logic for task file focus management and session store management, so it remains in the engine layer.  T4782

```typescript
(projectRoot: string, notes?: string | undefined) => Promise<EngineResult<{ sessionId: string; ended: boolean; }>>
```

### `sessionResume`

Resume an ended or suspended session. Note: This function has engine-specific logic for task file focus sync, so it remains in the engine layer.  T4782

```typescript
(projectRoot: string, sessionId: string) => Promise<EngineResult<Session>>
```

### `sessionGc`

Garbage collect old sessions.  T4782

```typescript
(projectRoot: string, maxAgeDays?: number) => Promise<EngineResult<{ orphaned: string[]; removed: string[]; }>>
```

### `sessionSuspend`

Suspend an active session.  T4782

```typescript
(projectRoot: string, sessionId: string, reason?: string | undefined) => Promise<EngineResult<Session>>
```

### `sessionHistory`

List session history with focus changes and completed tasks.  T4782

```typescript
(projectRoot: string, params?: { sessionId?: string | undefined; limit?: number | undefined; } | undefined) => Promise<EngineResult<{ sessions: { id: string; name?: string | undefined; status: string; startedAt: string; endedAt?: string | ... 1 more ... | undefined; tasksCompleted: number; focusChanges: number; focu...
```

### `sessionCleanup`

Remove orphaned sessions and clean up stale data.  T4782

```typescript
(projectRoot: string) => Promise<EngineResult<{ removed: string[]; autoEnded: string[]; cleaned: boolean; }>>
```

### `sessionRecordDecision`

Record a decision to the audit trail.  T4782

```typescript
(projectRoot: string, params: { sessionId: string; taskId: string; decision: string; rationale: string; alternatives?: string[] | undefined; }) => Promise<EngineResult<DecisionRecord>>
```

### `sessionDecisionLog`

Read the decision log, optionally filtered by sessionId and/or taskId.  T4782

```typescript
(projectRoot: string, params?: { sessionId?: string | undefined; taskId?: string | undefined; } | undefined) => Promise<EngineResult<DecisionRecord[]>>
```

### `sessionContextDrift`

Compute context drift score for the current session.  T4782

```typescript
(projectRoot: string, params?: { sessionId?: string | undefined; } | undefined) => Promise<EngineResult<{ score: number; factors: string[]; completedInScope: number; totalInScope: number; outOfScope: number; }>>
```

### `sessionRecordAssumption`

Record an assumption made during a session.  T4782

```typescript
(projectRoot: string, params: { sessionId?: string | undefined; taskId?: string | undefined; assumption: string; confidence: "high" | "medium" | "low"; }) => Promise<EngineResult<{ id: string; sessionId: string; taskId: string | null; assumption: string; confidence: string; timestamp: string; }>>
```

### `sessionStats`

Compute session statistics, optionally for a specific session.  T4782

```typescript
(projectRoot: string, sessionId?: string | undefined) => Promise<EngineResult<{ totalSessions: number; activeSessions: number; suspendedSessions: number; endedSessions: number; archivedSessions: number; totalTasksCompleted: number; totalFocusChanges: number; averageResumeCount: number; session?: { ...; } | undefined...
```

### `sessionSwitch`

Switch to a different session.  T4782

```typescript
(projectRoot: string, sessionId: string) => Promise<EngineResult<Session>>
```

### `sessionArchive`

Archive old/ended sessions.  T4782

```typescript
(projectRoot: string, olderThan?: string | undefined) => Promise<EngineResult<{ archived: string[]; count: number; }>>
```

### `sessionHandoff`

Get handoff data for the most recent ended session.  T4915, T5123

```typescript
(projectRoot: string, scope?: { type: string; epicId?: string | undefined; } | undefined) => Promise<EngineResult<{ sessionId: string; handoff: HandoffData; } | null>>
```

### `sessionComputeHandoff`

Compute and persist handoff data for a session.  T4915

```typescript
(projectRoot: string, sessionId: string, options?: { note?: string | undefined; nextAction?: string | undefined; } | undefined) => Promise<EngineResult<HandoffData>>
```

### `sessionBriefing`

Compute session briefing - composite view for session start. Aggregates data from handoff, current focus, next tasks, bugs, blockers, and epics.  T4916

```typescript
(projectRoot: string, options?: { maxNextTasks?: number | undefined; maxBugs?: number | undefined; maxBlocked?: number | undefined; maxEpics?: number | undefined; scope?: string | undefined; } | undefined) => Promise<...>
```

### `sessionComputeDebrief`

Compute and persist rich debrief data for a session. Persists as both handoffJson (backward compat) and debriefJson (rich data).  T4959

```typescript
(projectRoot: string, sessionId: string, options?: { note?: string | undefined; nextAction?: string | undefined; } | undefined) => Promise<EngineResult<DebriefData>>
```

### `sessionDebriefShow`

Read a session's debrief data. Falls back to handoff data if no debrief is available.  T4959

```typescript
(projectRoot: string, sessionId: string) => Promise<EngineResult<DebriefData | { handoff: unknown; fallback: true; } | null>>
```

### `sessionChainShow`

Show the session chain for a given session. Returns ordered list of sessions linked via previousSessionId/nextSessionId.  T4959

```typescript
(projectRoot: string, sessionId: string) => Promise<EngineResult<{ id: string; status: string; startedAt: string; endedAt: string | null; agentIdentifier: string | null; position: number; }[]>>
```

### `sessionContextInject`

Inject context protocol content.  T5673

```typescript
(protocolType: string, params?: { taskId?: string | undefined; variant?: string | undefined; } | undefined, projectRoot?: string | undefined) => EngineResult<ContextInjectionData>
```

### `orchestrateStatus`

orchestrate.status - Get orchestrator status  T4478

```typescript
(epicId?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateAnalyze`

orchestrate.analyze - Dependency analysis  T4478

```typescript
(epicId?: string | undefined, projectRoot?: string | undefined, mode?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateReady`

orchestrate.ready - Get parallel-safe tasks (ready to execute)  T4478

```typescript
(epicId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateNext`

orchestrate.next - Next task to spawn  T4478

```typescript
(epicId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateWaves`

orchestrate.waves - Compute dependency waves  T4478

```typescript
(epicId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateContext`

orchestrate.context - Context usage check  T4478

```typescript
(epicId?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateValidate`

orchestrate.validate - Validate spawn readiness for a task  T4478

```typescript
(taskId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateSpawnSelectProvider`

orchestrate.spawn.select - Select best provider for spawn based on required capabilities  T5236

```typescript
(capabilities: ("supportsSubagents" | "supportsProgrammaticSpawn" | "supportsInterAgentComms" | "supportsParallelSpawn")[], _projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateSpawnExecute`

orchestrate.spawn.execute - Execute spawn for a task using adapter registry  T5236

```typescript
(taskId: string, adapterId?: string | undefined, protocolType?: string | undefined, projectRoot?: string | undefined, tier?: 0 | 1 | 2 | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateSpawn`

orchestrate.spawn - Generate spawn prompt for a task  T4478

```typescript
(taskId: string, protocolType?: string | undefined, projectRoot?: string | undefined, tier?: 0 | 1 | 2 | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateStartup`

orchestrate.startup - Initialize orchestration for an epic  T4478

```typescript
(epicId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateBootstrap`

orchestrate.bootstrap - Load brain state for agent bootstrapping  T4478  T4657

```typescript
(projectRoot?: string | undefined, params?: { speed?: "full" | "fast" | "complete" | undefined; } | undefined) => Promise<EngineResult<BrainState>>
```

### `orchestrateCriticalPath`

orchestrate.critical-path - Find the longest dependency chain  T4478

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateUnblockOpportunities`

orchestrate.unblock-opportunities - Analyze dependency graph for unblocking opportunities  T4478

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateParallel`

orchestrate.parallel - Manage parallel execution (start/end)  T4632

```typescript
(action: "start" | "end", epicId: string, wave?: number | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateParallelStart`

orchestrate.parallel.start - Start parallel execution for a wave  T4632

```typescript
(epicId: string, wave: number, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateParallelEnd`

orchestrate.parallel.end - End parallel execution for a wave  T4632

```typescript
(epicId: string, wave: number, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateCheck`

orchestrate.check - Check current orchestration state  T4632

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `orchestrateSkillInject`

orchestrate.skill.inject - Read skill content for injection into agent context  T4632

```typescript
(skillName: string, projectRoot?: string | undefined) => EngineResult<unknown>
```

### `orchestrateHandoff`

orchestrate.handoff - Composite session handoff + successor spawn  Step order is explicit and fixed: 1) session.context.inject 2) session.end 3) orchestrate.spawn  Idempotency policy: - Non-idempotent overall. A retry after step 2 can duplicate spawn output. - Failures include exact step state and a safe retry entry point.

```typescript
(params: OrchestrateHandoffParams, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `phaseList`

phase.list - List all project phases

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `phaseShow`

phase.show - Show details of a specific phase

```typescript
(phaseId?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `phaseSet`

phase.set - Set the current phase

```typescript
(params: { phaseId: string; rollback?: boolean | undefined; force?: boolean | undefined; dryRun?: boolean | undefined; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `phaseStart`

phase.start - Start a pending phase

```typescript
(phaseId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `phaseComplete`

phase.complete - Complete an active phase

```typescript
(phaseId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `phaseAdvance`

phase.advance - Advance to the next phase

```typescript
(force?: boolean, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `phaseRename`

phase.rename - Rename a phase

```typescript
(oldName: string, newName: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `phaseDelete`

phase.delete - Delete a phase

```typescript
(phaseId: string, params?: { reassignTo?: string | undefined; force?: boolean | undefined; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releasePrepare`

release.prepare - Prepare a release  T4788

```typescript
(version: string, tasks?: string[] | undefined, notes?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releaseChangelog`

release.changelog - Generate changelog  T4788

```typescript
(version: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releaseList`

release.list - List all releases (query operation via data read)  T4788

```typescript
(optionsOrProjectRoot?: string | ReleaseListOptions | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releaseShow`

release.show - Show release details (query operation via data read)  T4788

```typescript
(version: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releaseCommit`

release.commit - Mark release as committed (metadata only)  T4788

```typescript
(version: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releaseTag`

release.tag - Mark release as tagged (metadata only)  T4788

```typescript
(version: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releaseGatesRun`

release.gates.run - Run release gates (validation checks)  T4788

```typescript
(version: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releaseRollback`

release.rollback - Rollback a release  T4788

```typescript
(version: string, reason?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releaseCancel`

release.cancel - Cancel and remove a release in draft or prepared state  T5602

```typescript
(version: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `releasePush`

release.push - Push release to remote via git Uses execFileSync (no shell) for safety. Respects config.release.push policy.  Agent protocol guard (T4279): When running in agent context (detected via CLEO_SESSION_ID or CLAUDE_AGENT_TYPE env vars), requires a release manifest entry for the version. This ensures agents go through the proper release.ship workflow rather than calling release.push directly, maintaining provenance tracking.   T4788  T4276  T4279

```typescript
(version: string, remote?: string | undefined, projectRoot?: string | undefined, opts?: { explicitPush?: boolean | undefined; } | undefined) => Promise<EngineResult<unknown>>
```

### `releaseShip`

release.ship - Composite release operation  Sequence: validate gates → epic completeness → double-listing check → write CHANGELOG → git commit/tag/push (or PR) → record provenance   T5582  T5586  T5576

```typescript
(params: { version: string; epicId: string; remote?: string | undefined; dryRun?: boolean | undefined; bump?: boolean | undefined; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `taskShow`

Get a single task by ID  T4657  T4654

```typescript
(projectRoot: string, taskId: string) => Promise<EngineResult<{ task: TaskRecord; }>>
```

### `taskList`

List tasks with optional filters  T4657  T4654

```typescript
(projectRoot: string, params?: { parent?: string | undefined; status?: string | undefined; priority?: string | undefined; type?: string | undefined; phase?: string | undefined; label?: string | undefined; children?: boolean | undefined; limit?: number | undefined; offset?: number | undefined; compact?: boolean | und...
```

### `taskFind`

Fuzzy search tasks by title/description/ID  T4657  T4654

```typescript
(projectRoot: string, query: string, limit?: number | undefined, options?: { id?: string | undefined; exact?: boolean | undefined; status?: string | undefined; includeArchive?: boolean | undefined; offset?: number | undefined; } | undefined) => Promise<...>
```

### `taskExists`

Check if a task exists  T4657  T4654

```typescript
(projectRoot: string, taskId: string) => Promise<EngineResult<{ exists: boolean; taskId: string; }>>
```

### `taskCreate`

Create a new task

```typescript
(projectRoot: string, params: { title: string; description: string; parent?: string | undefined; depends?: string[] | undefined; priority?: string | undefined; labels?: string[] | undefined; type?: string | undefined; ... 4 more ...; files?: string[] | undefined; }) => Promise<...>
```

### `taskUpdate`

Update a task

```typescript
(projectRoot: string, taskId: string, updates: { title?: string | undefined; description?: string | undefined; status?: string | undefined; priority?: string | undefined; notes?: string | undefined; ... 9 more ...; size?: string | undefined; }) => Promise<...>
```

### `taskComplete`

Complete a task (set status to done)

```typescript
(projectRoot: string, taskId: string, notes?: string | undefined) => Promise<EngineResult<{ task: TaskRecord; autoCompleted?: string[] | undefined; unblockedTasks?: { id: string; title: string; }[] | undefined; }>>
```

### `taskDelete`

Delete a task

```typescript
(projectRoot: string, taskId: string, force?: boolean | undefined) => Promise<EngineResult<{ deletedTask: TaskRecord; deleted: boolean; cascadeDeleted?: string[] | undefined; }>>
```

### `taskArchive`

Archive completed tasks. Moves done/cancelled tasks from active task data to archive.

```typescript
(projectRoot: string, taskId?: string | undefined, before?: string | undefined) => Promise<EngineResult<{ archivedCount: number; archivedTasks: { id: string; }[]; }>>
```

### `taskNext`

Suggest next task to work on based on priority, phase alignment, age, and dependency readiness.  T4657  T4790  T4654

```typescript
(projectRoot: string, params?: { count?: number | undefined; explain?: boolean | undefined; } | undefined) => Promise<EngineResult<{ suggestions: { id: string; title: string; priority: string; phase: string | null; score: number; reasons?: string[] | undefined; }[]; totalCandidates: number; }>>
```

### `taskBlockers`

Show blocked tasks and analyze blocking chains.  T4657  T4790  T4654

```typescript
(projectRoot: string, params?: { analyze?: boolean | undefined; limit?: number | undefined; } | undefined) => Promise<EngineResult<{ blockedTasks: { id: string; title: string; status: string; depends?: string[] | undefined; blockingChain: string[]; }[]; criticalBlockers: { ...; }[]; summary: string; total: number; l...
```

### `taskTree`

Build hierarchy tree.  T4657  T4790  T4654

```typescript
(projectRoot: string, taskId?: string | undefined) => Promise<EngineResult<unknown>>
```

### `taskDeps`

Show dependencies for a task - both what it depends on and what depends on it.  T4657  T4790  T4654

```typescript
(projectRoot: string, taskId: string) => Promise<EngineResult<{ taskId: string; dependsOn: { id: string; title: string; status: string; }[]; dependedOnBy: { id: string; title: string; status: string; }[]; unresolvedDeps: string[]; allDepsReady: boolean; }>>
```

### `taskRelates`

Show task relations (existing relates entries).  T4657  T4790  T4654

```typescript
(projectRoot: string, taskId: string) => Promise<EngineResult<{ taskId: string; relations: { taskId: string; type: string; reason?: string | undefined; }[]; count: number; }>>
```

### `taskRelatesAdd`

Add a relation between two tasks.  T4790

```typescript
(projectRoot: string, taskId: string, relatedId: string, type: string, reason?: string | undefined) => Promise<EngineResult<{ from: string; to: string; type: string; added: boolean; }>>
```

### `taskAnalyze`

Analyze a task for description quality, missing fields, and dependency health.  T4657  T4790  T4654

```typescript
(projectRoot: string, taskId?: string | undefined, params?: { tierLimit?: number | undefined; } | undefined) => Promise<EngineResult<{ recommended: { id: string; title: string; leverage: number; reason: string; } | null; bottlenecks: { ...; }[]; tiers: { ...; }; metrics: { ...; }; tierLimit: number; }>>
```

### `taskRestore`

Restore a cancelled task back to pending.  T4790

```typescript
(projectRoot: string, taskId: string, params?: { cascade?: boolean | undefined; notes?: string | undefined; } | undefined) => Promise<EngineResult<{ task: string; restored: string[]; count: number; }>>
```

### `taskUnarchive`

Move an archived task back to active task data with status 'done' (or specified status).  T4790

```typescript
(projectRoot: string, taskId: string, params?: { status?: string | undefined; preserveStatus?: boolean | undefined; } | undefined) => Promise<EngineResult<{ task: string; unarchived: boolean; title: string; status: string; }>>
```

### `taskReorder`

Change task position within its sibling group.  T4790

```typescript
(projectRoot: string, taskId: string, position: number) => Promise<EngineResult<{ task: string; reordered: boolean; newPosition: number; totalSiblings: number; }>>
```

### `taskReparent`

Move task under a different parent.  T4790

```typescript
(projectRoot: string, taskId: string, newParentId: string | null) => Promise<EngineResult<{ task: string; reparented: boolean; oldParent: string | null; newParent: string | null; newType?: string | undefined; }>>
```

### `taskPromote`

Promote a subtask to task or task to root (remove parent).  T4790

```typescript
(projectRoot: string, taskId: string) => Promise<EngineResult<{ task: string; promoted: boolean; previousParent: string | null; typeChanged: boolean; }>>
```

### `taskReopen`

Reopen a completed task (set status back to pending).  T4790

```typescript
(projectRoot: string, taskId: string, params?: { status?: string | undefined; reason?: string | undefined; } | undefined) => Promise<EngineResult<{ task: string; reopened: boolean; previousStatus: string; newStatus: string; }>>
```

### `taskCancel`

Cancel a task (soft terminal state — reversible via restore).  T4529

```typescript
(projectRoot: string, taskId: string, reason?: string | undefined) => Promise<EngineResult<{ task: string; cancelled: boolean; reason?: string | undefined; cancelledAt: string; }>>
```

### `taskComplexityEstimate`

Deterministic complexity scoring from task metadata.  T4657  T4790  T4654

```typescript
(projectRoot: string, params: { taskId: string; }) => Promise<EngineResult<{ size: "medium" | "small" | "large"; score: number; factors: ComplexityFactor[]; dependencyDepth: number; subtaskCount: number; fileCount: number; }>>
```

### `taskDepends`

List dependencies for a task in a given direction.  T4657  T4790  T4654

```typescript
(projectRoot: string, taskId: string, direction?: "upstream" | "downstream" | "both", tree?: boolean | undefined) => Promise<EngineResult<unknown>>
```

### `taskDepsOverview`

Overview of all dependencies across the project.  T5157

```typescript
(projectRoot: string) => Promise<EngineResult<{ totalTasks: number; tasksWithDeps: number; blockedTasks: { id: string; title: string; status: string; unblockedBy: string[]; }[]; readyTasks: { id: string; title: string; status: string; }[]; validation: { ...; }; }>>
```

### `taskDepsCycles`

Detect circular dependencies across the project.  T5157

```typescript
(projectRoot: string) => Promise<EngineResult<{ hasCycles: boolean; cycles: { path: string[]; tasks: { id: string; title: string; }[]; }[]; }>>
```

### `taskStats`

Compute task statistics, optionally scoped to an epic.  T4657  T4790  T4654

```typescript
(projectRoot: string, epicId?: string | undefined) => Promise<EngineResult<{ total: number; pending: number; active: number; blocked: number; done: number; cancelled: number; byPriority: Record<string, number>; byType: Record<...>; }>>
```

### `taskExport`

Export tasks as JSON or CSV.  T4657  T4790  T4654

```typescript
(projectRoot: string, params?: { format?: "json" | "csv" | undefined; status?: string | undefined; parent?: string | undefined; } | undefined) => Promise<EngineResult<unknown>>
```

### `taskHistory`

Get task history from the log file.  T4657  T4790  T4654

```typescript
(projectRoot: string, taskId: string, limit?: number | undefined) => Promise<EngineResult<Record<string, unknown>[]>>
```

### `taskLint`

Lint tasks for common issues.  T4657  T4790  T4654

```typescript
(projectRoot: string, taskId?: string | undefined) => Promise<EngineResult<{ taskId: string; severity: "error" | "warning"; rule: string; message: string; }[]>>
```

### `taskBatchValidate`

Validate multiple tasks at once.  T4657  T4790  T4654

```typescript
(projectRoot: string, taskIds: string[], checkMode?: "full" | "quick") => Promise<EngineResult<{ results: Record<string, { severity: "error" | "warning"; rule: string; message: string; }[]>; summary: { ...; }; }>>
```

### `taskImport`

Import tasks from a JSON source string or export package.  T4790

```typescript
(projectRoot: string, source: string, overwrite?: boolean | undefined) => Promise<EngineResult<{ imported: number; skipped: number; errors: string[]; remapTable?: Record<string, string> | undefined; }>>
```

### `taskPlan`

Compute a ranked plan: in-progress epics, ready tasks, blockers, bugs.  T4815

```typescript
(projectRoot: string) => Promise<EngineResult<unknown>>
```

### `taskRelatesFind`

Find related tasks using semantic search or keyword matching.  T5672

```typescript
(projectRoot: string, taskId: string, params?: { mode?: "suggest" | "discover" | undefined; threshold?: number | undefined; } | undefined) => Promise<EngineResult<Record<string, unknown>>>
```

### `taskLabelList`

List all labels used in tasks.  T5672

```typescript
(projectRoot: string) => Promise<EngineResult<{ labels: unknown[]; count: number; }>>
```

### `taskLabelShow`

Show tasks associated with a label.  T5672

```typescript
(projectRoot: string, label: string) => Promise<EngineResult<Record<string, unknown>>>
```

### `systemDash`

Project dashboard: task counts by status, active session info, current focus, recent completions.

```typescript
(projectRoot: string, params?: { blockedTasksLimit?: number | undefined; } | undefined) => Promise<EngineResult<DashboardData>>
```

### `systemStats`

Detailed statistics: tasks by status/priority/type/phase, completion rate, average cycle time.

```typescript
(projectRoot: string, params?: { period?: number | undefined; } | undefined) => Promise<EngineResult<StatsData>>
```

### `systemLabels`

List all unique labels across tasks with counts and task IDs per label.

```typescript
(projectRoot: string) => Promise<EngineResult<LabelsResult>>
```

### `systemArchiveStats`

Archive metrics: total archived, by reason, average cycle time, archive rate.

```typescript
(projectRoot: string, params?: { period?: number | undefined; } | undefined) => Promise<EngineResult<ArchiveStatsResult>>
```

### `systemLog`

Query audit log with optional filters. Reads from SQLite audit_log table.   T4837

```typescript
(projectRoot: string, filters?: { operation?: string | undefined; taskId?: string | undefined; since?: string | undefined; until?: string | undefined; limit?: number | undefined; offset?: number | undefined; } | undefined) => Promise<...>
```

### `systemContext`

Context window tracking: estimate token usage from current session/state.

```typescript
(projectRoot: string, params?: { session?: string | undefined; } | undefined) => EngineResult<ContextData>
```

### `systemSequence`

Read task ID sequence state from canonical SQLite metadata. Supports 'show' and 'check' actions.  T4815

```typescript
(projectRoot: string, params?: { action?: "check" | "show" | undefined; } | undefined) => Promise<EngineResult<Record<string, unknown> | SequenceData>>
```

### `systemInjectGenerate`

Generate Minimum Viable Injection (MVI).

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<InjectGenerateResult>>
```

### `systemMetrics`

System metrics: token usage, compliance summary, session counts.  T4631

```typescript
(projectRoot: string, params?: { scope?: string | undefined; since?: string | undefined; } | undefined) => Promise<EngineResult<SystemMetricsResult>>
```

### `systemHealth`

System health check: verify core data files exist and are valid.  T4631

```typescript
(projectRoot: string, params?: { detailed?: boolean | undefined; } | undefined) => EngineResult<HealthResult>
```

### `systemDiagnostics`

System diagnostics: extended health checks with fix suggestions.  T4631

```typescript
(projectRoot: string, params?: { checks?: string[] | undefined; } | undefined) => Promise<EngineResult<DiagnosticsResult>>
```

### `systemHelp`

Return help text for the system.  T4631

```typescript
(_projectRoot: string, params?: { topic?: string | undefined; } | undefined) => EngineResult<HelpData>
```

### `systemRoadmap`

Generate roadmap from pending epics and optional CHANGELOG history.  T4631

```typescript
(projectRoot: string, params?: { includeHistory?: boolean | undefined; upcomingOnly?: boolean | undefined; } | undefined) => Promise<EngineResult<unknown>>
```

### `systemCompliance`

System compliance report from COMPLIANCE.jsonl.  T4631

```typescript
(projectRoot: string, params?: { subcommand?: string | undefined; days?: number | undefined; epic?: string | undefined; } | undefined) => EngineResult<ComplianceData>
```

### `systemBackup`

Create a backup of CLEO data files.  T4631

```typescript
(projectRoot: string, params?: { type?: string | undefined; note?: string | undefined; } | undefined) => EngineResult<BackupResult>
```

### `systemRestore`

Restore from a backup.  T4631

```typescript
(projectRoot: string, params: { backupId: string; force?: boolean | undefined; }) => EngineResult<RestoreResult>
```

### `backupRestore`

Restore an individual file from backup.  T5329

```typescript
(projectRoot: string, fileName: string, options?: { dryRun?: boolean | undefined; } | undefined) => Promise<EngineResult<{ restored: boolean; file: string; from: string; targetPath: string; dryRun?: boolean | undefined; }>>
```

### `systemMigrate`

Check/run schema migrations.  T4631

```typescript
(projectRoot: string, params?: { target?: string | undefined; dryRun?: boolean | undefined; } | undefined) => Promise<EngineResult<MigrateResult>>
```

### `systemCleanup`

Cleanup stale data (sessions, backups, logs).  T4631

```typescript
(projectRoot: string, params: { target: string; olderThan?: string | undefined; dryRun?: boolean | undefined; }) => Promise<EngineResult<CleanupResult>>
```

### `systemAudit`

Audit data integrity.  T4631

```typescript
(projectRoot: string, params?: { scope?: string | undefined; fix?: boolean | undefined; } | undefined) => Promise<EngineResult<AuditResult>>
```

### `systemSync`

Sync check (no external sync targets in native mode).  T4631

```typescript
(_projectRoot: string, params?: { direction?: string | undefined; } | undefined) => EngineResult<SyncData>
```

### `systemSafestop`

Safe stop: signal clean shutdown for agents.  T4631

```typescript
(projectRoot: string, params?: { reason?: string | undefined; commit?: boolean | undefined; handoff?: string | undefined; noSessionEnd?: boolean | undefined; dryRun?: boolean | undefined; } | undefined) => EngineResult<...>
```

### `systemUncancel`

Uncancel a cancelled task (restore to pending).  T4631

```typescript
(projectRoot: string, params: { taskId: string; cascade?: boolean | undefined; notes?: string | undefined; dryRun?: boolean | undefined; }) => Promise<EngineResult<UncancelResult>>
```

### `systemDoctor`

Run comprehensive doctor diagnostics.  T4795

```typescript
(projectRoot: string) => Promise<EngineResult<DoctorReport>>
```

### `systemFix`

Run auto-fix for failed doctor checks.  T4795

```typescript
(projectRoot: string) => Promise<EngineResult<FixResult[]>>
```

### `systemRuntime`

Runtime/channel diagnostics for CLI/MCP installation mode checks.  T4815

```typescript
(_projectRoot: string, params?: { detailed?: boolean | undefined; } | undefined) => Promise<EngineResult<RuntimeDiagnostics>>
```

### `systemSequenceRepair`

Repair task ID sequence using canonical core implementation.  T4815

```typescript
(projectRoot: string) => Promise<EngineResult<Record<string, unknown>>>
```

### `parseIssueTemplates`

Parse all templates from the repo's .github/ISSUE_TEMPLATE/ directory.

```typescript
(projectRoot: string) => EngineResult<TemplateConfig>
```

### `getTemplateForSubcommand`

Get template config for a specific subcommand (bug/feature/help).

```typescript
(projectRoot: string, subcommand: string) => EngineResult<IssueTemplate>
```

### `generateTemplateConfig`

Generate and cache the config as .cleo/issue-templates.json.

```typescript
(projectRoot: string) => Promise<EngineResult<TemplateConfig>>
```

### `validateLabels`

Validate that labels exist on a GitHub repo.

```typescript
(labels: string[], repoLabels: string[]) => EngineResult<{ existing: string[]; missing: string[]; }>
```

### `validateSchemaOp`

validate.schema - JSON Schema validation  T4477

```typescript
(type: string, data?: unknown, projectRoot?: string | undefined) => EngineResult<unknown>
```

### `validateTask`

validate.task - Anti-hallucination task validation  T4477

```typescript
(taskId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `validateProtocol`

validate.protocol - Protocol compliance check  T4477

```typescript
(taskId: string, protocolType?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `validateManifest`

validate.manifest - Manifest entry validation  T4477

```typescript
(projectRoot?: string | undefined) => EngineResult<unknown>
```

### `validateOutput`

validate.output - Output file validation  T4477

```typescript
(filePath: string, taskId?: string | undefined, projectRoot?: string | undefined) => EngineResult<unknown>
```

### `validateComplianceSummary`

validate.compliance.summary - Aggregated compliance metrics  T4477

```typescript
(projectRoot?: string | undefined) => EngineResult<unknown>
```

### `validateComplianceViolations`

validate.compliance.violations - List compliance violations  T4477

```typescript
(limit?: number | undefined, projectRoot?: string | undefined) => EngineResult<unknown>
```

### `validateComplianceRecord`

validate.compliance.record - Record compliance check result  T4477

```typescript
(taskId: string, result: string, protocol?: string | undefined, violations?: { code: string; message: string; severity: "error" | "warning"; }[] | undefined, projectRoot?: string | undefined) => EngineResult<...>
```

### `validateTestStatus`

validate.test.status - Test suite status  T4477

```typescript
(projectRoot?: string | undefined) => EngineResult<unknown>
```

### `validateCoherenceCheck`

validate.coherence-check - Cross-validate task graph for consistency  T4477

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<{ coherent: boolean; issues: CoherenceIssue[]; }>>
```

### `validateTestRun`

validate.test.run - Execute test suite via subprocess  T4632

```typescript
(params?: { scope?: string | undefined; pattern?: string | undefined; parallel?: boolean | undefined; } | undefined, projectRoot?: string | undefined) => EngineResult<unknown>
```

### `validateBatchValidate`

validate.batch-validate - Batch validate all tasks against schema and rules  T4632

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `validateTestCoverage`

validate.test.coverage - Coverage metrics  T4477

```typescript
(projectRoot?: string | undefined) => EngineResult<unknown>
```

### `validateProtocolConsensus`

check.protocol.consensus - Validate consensus protocol compliance  T5327

```typescript
(params: ProtocolValidationParams, _projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `validateProtocolContribution`

check.protocol.contribution - Validate contribution protocol compliance  T5327

```typescript
(params: ProtocolValidationParams, _projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `validateProtocolDecomposition`

check.protocol.decomposition - Validate decomposition protocol compliance  T5327

```typescript
(params: ProtocolValidationParams, _projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `validateProtocolImplementation`

check.protocol.implementation - Validate implementation protocol compliance  T5327

```typescript
(params: ProtocolValidationParams, _projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `validateProtocolSpecification`

check.protocol.specification - Validate specification protocol compliance  T5327

```typescript
(params: ProtocolValidationParams, _projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `validateGateVerify`

check.gate.verify - View or modify verification gates for a task  T5327

```typescript
(params: GateVerifyParams, projectRoot?: string | undefined) => Promise<EngineResult<GateVerifyResult>>
```

### `dispatchMeta`

Build metadata for a dispatch domain response.

```typescript
(gateway: string, domain: string, operation: string, startTime: number, source?: Source) => { [key: string]: unknown; gateway: Gateway; domain: string; operation: string; timestamp: string; ... 5 more ...; version?: string | undefined; }
```

**Parameters:**

- `gateway` — Gateway name (e.g., 'query', 'mutate')
- `domain` — Domain name (e.g., 'tasks', 'session')
- `operation` — Operation name (e.g., 'show', 'list')
- `startTime` — Timestamp from Date.now() at start of request
- `source` — Where the request originated ('cli' or 'mcp')

**Returns:** Metadata conforming to DispatchResponse['_meta']   T4772

### `wrapResult`

Wrap a native engine result into a DispatchResponse. Handles success data, page metadata, and structured errors.

```typescript
(result: EngineResult, gateway: string, domain: string, operation: string, startTime: number) => DispatchResponse
```

### `errorResult`

Return a standard error response.

```typescript
(gateway: string, domain: string, operation: string, code: string, message: string, startTime: number) => DispatchResponse
```

### `unsupportedOp`

Return a standard "unsupported operation" error response.

```typescript
(gateway: string, domain: string, operation: string, startTime: number) => DispatchResponse
```

### `getListParams`

Extract limit and offset pagination params from a params dict.

```typescript
(params?: Record<string, unknown> | undefined) => { limit?: number | undefined; offset?: number | undefined; }
```

### `handleErrorResult`

Handle a caught error: extract message and return an internal error response. Callers should log the error themselves (with their domain-specific logger) before or after calling this.

```typescript
(gateway: string, domain: string, operation: string, error: unknown, startTime: number) => DispatchResponse
```

### `routeByParam`

Shared parameter-based routing for merged operations. DRY utility -- all 10 domain handlers use this instead of re-implementing action dispatch.   T5671

```typescript
<T>(params: Record<string, unknown> | undefined, paramName: string, routes: Record<string, () => T>, defaultRoute?: string | undefined) => T
```

### `setJobManager`

```typescript
(manager: BackgroundJobManager) => void
```

### `getJobManager`

```typescript
() => BackgroundJobManager | null
```

### `nexusStatus`

Get nexus status (initialized, project count, last updated).

```typescript
() => Promise<EngineResult<{ initialized: boolean; projectCount: number; lastUpdated: string | null; }>>
```

### `nexusListProjects`

List all registered projects.

```typescript
(limit?: number | undefined, offset?: number | undefined) => Promise<EngineResult<{ projects: NexusProject[]; count: number; total: number; filtered: number; page: LAFSPage; }>>
```

### `nexusShowProject`

Show a single project by name.

```typescript
(name: string) => Promise<EngineResult<NexusProject | null>>
```

### `nexusResolve`

Resolve a cross-project task query.

```typescript
(query: string, currentProject?: string | undefined) => Promise<EngineResult<NexusResolvedTask | NexusResolvedTask[]>>
```

### `nexusDepsQuery`

Get cross-project dependencies for a task query.

```typescript
(query: string, direction?: "forward" | "reverse") => Promise<EngineResult<DepsResult>>
```

### `nexusGraph`

Build the global dependency graph.

```typescript
() => Promise<EngineResult<NexusGlobalGraph>>
```

### `nexusCriticalPath`

Get the critical path across projects.

```typescript
() => Promise<EngineResult<CriticalPathResult>>
```

### `nexusBlockers`

Analyze blockers for a task query.

```typescript
(query: string) => Promise<EngineResult<BlockingAnalysisResult>>
```

### `nexusOrphans`

List orphaned cross-project tasks.

```typescript
(limit?: number | undefined, offset?: number | undefined) => Promise<EngineResult<{ orphans: OrphanEntry[]; count: number; total: number; filtered: number; page: LAFSPage; }>>
```

### `nexusDiscover`

Discover tasks related to a given task query across projects. Delegates all business logic to src/core/nexus/discover.ts.

```typescript
(taskQuery: string, method?: string, limit?: number) => Promise<EngineResult<{ query: string; method: string; results: { project: string; taskId: string; title: string; score: number; type: string; reason: string; }[]; total: number; }>>
```

### `nexusSearch`

Search for tasks across all registered projects. Delegates all business logic to src/core/nexus/discover.ts.

```typescript
(pattern: string, projectFilter?: string | undefined, limit?: number) => Promise<EngineResult<{ pattern: string; results: { id: string; title: string; status: string; priority?: string | undefined; description?: string | undefined; _project: string; }[]; resultCount: number; }>>
```

### `nexusInitialize`

Initialize the nexus.

```typescript
() => Promise<EngineResult<{ message: string; }>>
```

### `nexusRegisterProject`

Register a project in the nexus.

```typescript
(path: string, name?: string | undefined, permission?: NexusPermissionLevel) => Promise<EngineResult<{ hash: string; message: string; }>>
```

### `nexusUnregisterProject`

Unregister a project from the nexus.

```typescript
(name: string) => Promise<EngineResult<{ message: string; }>>
```

### `nexusSyncProject`

Sync a specific project or all projects.

```typescript
(name?: string | undefined) => Promise<EngineResult<unknown>>
```

### `nexusSetPermission`

Set permission level for a project.

```typescript
(name: string, level: NexusPermissionLevel) => Promise<EngineResult<{ message: string; }>>
```

### `nexusReconcileProject`

Reconcile the nexus registry with the filesystem.

```typescript
(projectRoot: string) => Promise<EngineResult<{ status: "ok" | "path_updated" | "auto_registered"; oldPath?: string | undefined; newPath?: string | undefined; }>>
```

### `nexusShareStatus`

Get sharing status for a project.

```typescript
(projectRoot: string) => Promise<EngineResult<SharingStatus>>
```

### `nexusShareSnapshotExport`

Export a snapshot of the project's tasks.

```typescript
(projectRoot: string, outputPath?: string | undefined) => Promise<EngineResult<{ path: string; taskCount: number; checksum: string; }>>
```

### `nexusShareSnapshotImport`

Import a snapshot into the project.

```typescript
(projectRoot: string, inputPath: string) => Promise<EngineResult<ImportResult>>
```

### `bindSession`

Bind a session to the current process. Called by session.start mutation handler after successful session creation.

```typescript
(ctx: Omit<SessionContext, "agentPid" | "boundAt">) => SessionContext
```

### `getBoundSession`

Get the currently bound session context, or null if none is bound.

```typescript
() => SessionContext | null
```

### `hasSession`

Check whether a session is currently bound.

```typescript
() => boolean
```

### `unbindSession`

Unbind the current session context. Called by session.end mutation handler.

```typescript
() => SessionContext | null
```

**Returns:** The unbound context, or null if nothing was bound.

### `resetSessionContext`

Reset the session context (for testing only).

```typescript
() => void
```

### `stickyAdd`

Create a new sticky note.

```typescript
(projectRoot: string, params: CreateStickyParams) => Promise<EngineResult<StickyNote>>
```

**Parameters:**

- `projectRoot` — Project root path
- `params` — Creation parameters

**Returns:** EngineResult with created sticky note

### `stickyList`

List sticky notes with optional filtering.

```typescript
(projectRoot: string, params?: ListStickiesParams) => Promise<EngineResult<{ stickies: StickyNote[]; total: number; }>>
```

**Parameters:**

- `projectRoot` — Project root path
- `params` — Filter parameters

**Returns:** EngineResult with array of sticky notes

### `stickyShow`

Get a single sticky note by ID.

```typescript
(projectRoot: string, id: string) => Promise<EngineResult<StickyNote | null>>
```

**Parameters:**

- `projectRoot` — Project root path
- `id` — Sticky note ID

**Returns:** EngineResult with sticky note or null

### `stickyConvertToTask`

Convert a sticky note to a task.

```typescript
(projectRoot: string, stickyId: string, title?: string | undefined) => Promise<EngineResult<{ taskId: string; }>>
```

**Parameters:**

- `projectRoot` — Project root path
- `stickyId` — Sticky note ID
- `title` — Optional task title

**Returns:** EngineResult with new task ID

### `stickyConvertToMemory`

Convert a sticky note to a memory observation.

```typescript
(projectRoot: string, stickyId: string, memoryType?: string | undefined) => Promise<EngineResult<{ memoryId: string; }>>
```

**Parameters:**

- `projectRoot` — Project root path
- `stickyId` — Sticky note ID
- `memoryType` — Optional memory type

**Returns:** EngineResult with new memory entry ID

### `stickyArchive`

Archive a sticky note.

```typescript
(projectRoot: string, id: string) => Promise<EngineResult<StickyNote>>
```

**Parameters:**

- `projectRoot` — Project root path
- `id` — Sticky note ID

**Returns:** EngineResult with archived sticky note

### `stickyConvertToTaskNote`

Convert a sticky note to a task note.

```typescript
(projectRoot: string, stickyId: string, taskId: string) => Promise<EngineResult<{ taskId: string; }>>
```

**Parameters:**

- `projectRoot` — Project root path
- `stickyId` — Sticky note ID
- `taskId` — Target task ID

**Returns:** EngineResult with updated task ID

### `stickyConvertToSessionNote`

Convert a sticky note to a session note.

```typescript
(projectRoot: string, stickyId: string, sessionId?: string | undefined) => Promise<EngineResult<{ sessionId: string; }>>
```

**Parameters:**

- `projectRoot` — Project root path
- `stickyId` — Sticky note ID
- `sessionId` — Optional target session ID

**Returns:** EngineResult with session ID

### `stickyPurge`

Purge (permanently delete) a sticky note.

```typescript
(projectRoot: string, id: string) => Promise<EngineResult<StickyNote>>
```

**Parameters:**

- `projectRoot` — Project root path
- `id` — Sticky note ID

**Returns:** EngineResult with purged sticky note

### `queryHookProviders`

Query providers that support a specific hook event  Returns detailed provider information including which hooks each provider supports, enabling intelligent routing and filtering of hook handlers.

```typescript
(event: HookEvent) => Promise<EngineResult<{ event: HookEvent; providers: ProviderHookInfo[]; }>>
```

**Parameters:**

- `event` — The hook event to query providers for

**Returns:** Engine result with provider hook capability data

### `queryCommonHooks`

Get hook events common to specified providers  Analyzes which hook events are supported by all providers in the given list, useful for determining the intersection of hook capabilities.

```typescript
(providerIds?: string[] | undefined) => Promise<EngineResult<{ providerIds?: string[] | undefined; commonEvents: HookEvent[]; }>>
```

**Parameters:**

- `providerIds` — Optional array of provider IDs to analyze (uses all active if omitted)

**Returns:** Engine result with common hook events

### `toolsIssueDiagnostics`

Collect issue diagnostics.

```typescript
() => EngineResult<Record<string, string>>
```

### `toolsSkillList`

List all discovered skills.

```typescript
(limit?: number | undefined, offset?: number | undefined) => Promise<EngineResult<{ skills: SkillEntry[]; count: number; total: number; filtered: number; page: LAFSPage; }>>
```

### `toolsSkillShow`

Show a single skill by name.

```typescript
(name: string) => Promise<EngineResult<{ skill: SkillEntry | null; }>>
```

### `toolsSkillFind`

Find skills matching a query string.

```typescript
(query?: string | undefined) => Promise<EngineResult<{ skills: SkillEntry[]; count: number; query: string; }>>
```

### `toolsSkillDispatch`

Get dispatch matrix entries for a skill.

```typescript
(name: string) => EngineResult<{ skill: string; dispatch: { byTaskType: string[]; byKeyword: string[]; byProtocol: string[]; }; }>
```

### `toolsSkillVerify`

Verify a skill's installation and catalog status.

```typescript
(name: string) => Promise<EngineResult<{ skill: string; installed: boolean; inCatalog: boolean; installPath: string | null; }>>
```

### `toolsSkillDependencies`

Get dependency tree for a skill.

```typescript
(name: string) => EngineResult<{ skill: string; direct: string[]; tree: string[]; }>
```

### `toolsSkillSpawnProviders`

Get spawn-capable providers by capability.

```typescript
(capability?: "supportsSubagents" | "supportsProgrammaticSpawn" | "supportsInterAgentComms" | "supportsParallelSpawn" | undefined) => Promise<EngineResult<{ providers: unknown[]; capability: string; count: number; }>>
```

### `toolsSkillCatalogInfo`

Get catalog info (protocols, profiles, resources, or summary).

```typescript
() => EngineResult<{ available: boolean; version: string | null; libraryRoot: string | null; skillCount: number; protocolCount: number; profileCount: number; }>
```

### `toolsSkillCatalogProtocols`

List catalog protocols.

```typescript
(limit?: number | undefined, offset?: number | undefined) => EngineResult<{ protocols: { name: string; path: string | null; }[]; count: number; total: number; filtered: number; page: LAFSPage; }>
```

### `toolsSkillCatalogProfiles`

List catalog profiles.

```typescript
(limit?: number | undefined, offset?: number | undefined) => EngineResult<{ profiles: { name: string; description: string; extends: string | undefined; skillCount: number; skills: string[]; }[]; count: number; total: number; filtered: number; page: LAFSPage; }>
```

### `toolsSkillCatalogResources`

List catalog shared resources.

```typescript
(limit?: number | undefined, offset?: number | undefined) => EngineResult<{ resources: { name: string; path: string | null; }[]; count: number; total: number; filtered: number; page: LAFSPage; }>
```

### `toolsSkillPrecedenceShow`

Show skill precedence map.

```typescript
() => Promise<EngineResult<{ precedenceMap: unknown; }>>
```

### `toolsSkillPrecedenceResolve`

Resolve skill paths for a specific provider.

```typescript
(providerId: string, scope: "global" | "project", projectRoot: string) => Promise<EngineResult<{ providerId: string; scope: string; paths: unknown; }>>
```

### `toolsSkillInstall`

Install a skill to one or more providers.

```typescript
(name: string, projectRoot: string, source?: string | undefined, isGlobal?: boolean | undefined) => Promise<EngineResult<{ results: { providerId: string; success: boolean; errors: string[]; }[]; targets: string[]; }>>
```

### `toolsSkillUninstall`

Uninstall a skill from all providers.

```typescript
(name: string, projectRoot: string, isGlobal?: boolean | undefined) => Promise<EngineResult<{ removed: string[]; errors: string[]; }>>
```

### `toolsSkillRefresh`

Refresh all tracked skills that have updates available.

```typescript
(projectRoot: string) => Promise<EngineResult<{ updated: string[]; failed: { name: string; error: string; }[]; checked: number; }>>
```

### `toolsProviderList`

List all registered providers.

```typescript
(limit?: number | undefined, offset?: number | undefined) => EngineResult<{ providers: Provider[]; count: number; total: number; filtered: number; page: LAFSPage; }>
```

### `toolsProviderDetect`

Detect all available providers in the environment.

```typescript
() => EngineResult<{ providers: DetectionResult[]; count: number; }>
```

### `toolsProviderInjectStatus`

Check injection status for all installed providers.

```typescript
(projectRoot: string, scope?: "global" | "project" | undefined, content?: string | undefined) => Promise<EngineResult<{ checks: unknown[]; count: number; }>>
```

### `toolsProviderSupports`

Check if a provider supports a specific capability.

```typescript
(providerId: string, capability: string) => Promise<EngineResult<{ providerId: string; capability: string; supported: boolean; }>>
```

### `toolsProviderHooks`

Query hook providers for a specific event.

```typescript
(event: string) => Promise<EngineResult<unknown>>
```

### `toolsProviderInject`

Inject CLEO directives into all installed provider instruction files.

```typescript
(projectRoot: string, scope?: "global" | "project" | undefined, references?: string[] | undefined, content?: string | undefined) => Promise<EngineResult<{ actions: { file: string; action: string; }[]; count: number; }>>
```

### `toolsTodowriteStatus`

Get TodoWrite sync status.

```typescript
(projectRoot: string) => Promise<EngineResult<unknown>>
```

### `toolsTodowriteSync`

Trigger TodoWrite sync.

```typescript
(projectRoot: string, params?: { direction?: string | undefined; } | undefined) => EngineResult<unknown>
```

### `toolsTodowriteClear`

Clear TodoWrite sync state.

```typescript
(projectRoot: string, dryRun?: boolean | undefined) => Promise<EngineResult<unknown>>
```

### `toolsAdapterList`

List all discovered adapters.

```typescript
(projectRoot: string) => EngineResult<{ adapters: AdapterInfo[]; count: number; }>
```

### `toolsAdapterShow`

Show a single adapter by ID.

```typescript
(projectRoot: string, id: string) => EngineResult<{ manifest: unknown; initialized: boolean; active: boolean; }>
```

### `toolsAdapterDetect`

Detect active adapters.

```typescript
(projectRoot: string) => EngineResult<{ detected: string[]; count: number; }>
```

### `toolsAdapterHealth`

Get adapter health status.

```typescript
(projectRoot: string, id?: string | undefined) => EngineResult<{ adapters: AdapterInfo[]; count: number; }>
```

### `toolsAdapterActivate`

Activate an adapter by ID.

```typescript
(projectRoot: string, id: string) => Promise<EngineResult<{ id: string; name: string; version: string; active: boolean; }>>
```

### `toolsAdapterDispose`

Dispose one or all adapters.

```typescript
(projectRoot: string, id?: string | undefined) => Promise<EngineResult<{ disposed: string; }>>
```

### `createDomainHandlers`

Create a Map of all canonical domain handlers.

```typescript
() => Map<string, DomainHandler>
```

### `validateConfig`

Validate complete configuration

```typescript
(config: MCPConfig) => void
```

### `loadConfig`

Load configuration from all sources  Priority order: 1. Environment variables (CLEO_MCP_*) 2. Config file (.cleo/config.json) 3. Defaults

```typescript
(projectRoot?: string | undefined) => MCPConfig
```

### `getConfig`

Get global configuration (singleton)

```typescript
() => MCPConfig
```

### `resetConfig`

Reset global configuration (for testing)

```typescript
() => void
```

### `createAudit`

Creates an audit middleware that logs all mutate operations (and query operations during grade sessions) to Pino + SQLite.

```typescript
() => Middleware
```

### `createFieldFilter`

Create the LAFS field-filter middleware.  Handles: - _fields: filter response data to specified fields (delegates to SDK applyFieldFilter) - _mvi: envelope verbosity — stored on request for downstream use  _fields and _mvi are extracted from req.params (for MCP callers that pass them as params) and stored on the DispatchRequest before the domain handler runs.

```typescript
() => Middleware
```

### `createSanitizer`

Creates a middleware that sanitizes incoming request parameters. Uses the canonical sanitization logic from security.ts to handle Task IDs, paths, string lengths, and enum validation.

```typescript
(getProjectRoot?: (() => string) | undefined) => Middleware
```

**Parameters:**

- `getProjectRoot` — Optional function to resolve the current project root for path sanitization

### `createSessionResolver`

Creates the session resolver middleware.

```typescript
(cliSessionLookup?: (() => Promise<string | null>) | undefined) => Middleware
```

**Parameters:**

- `cliSessionLookup` — Optional async function that resolves the active   session ID from SQLite for CLI commands. If not provided, the resolver   falls through to env var / null.

### `getCliDispatcher`

Get or create the singleton CLI dispatcher.  Creates a Dispatcher with all 9 domain handlers and sanitizer middleware. No rate limiter — CLI is a single-user tool.

```typescript
() => Dispatcher
```

### `createCliDispatcher`

Factory: creates a Dispatcher with all domain handlers + session-resolver, sanitizer, field-filter, and audit middleware.   T4959 — added session-resolver + audit to CLI pipeline

```typescript
() => Dispatcher
```

### `resetCliDispatcher`

Reset the singleton dispatcher (for testing).

```typescript
() => void
```

### `dispatchFromCli`

Build a DispatchRequest, dispatch it, and handle output/errors.  This is the primary entry point for migrated CLI commands:   await dispatchFromCli('query', 'tasks', 'show',  taskId ,  command: 'show' );  Automatically honors global --field/--fields/--mvi flags from the FieldContext: - --field    → plain-text extraction, no JSON envelope - --fields   → field-filter middleware filters the JSON response - --mvi     → envelope verbosity passed to field-filter middleware  On success: calls cliOutput(response.data, outputOpts) On error: calls cliError(message, exitCode) + process.exit(exitCode)   T4953  T4955

```typescript
(gateway: Gateway, domain: string, operation: string, params?: Record<string, unknown> | undefined, outputOpts?: CliOutputOptions | undefined) => Promise<...>
```

### `handleRawError`

Handle an error response from dispatchRaw().  Calls cliError() and process.exit() when the response indicates failure. No-op when response.success is true.

```typescript
(response: DispatchResponse, _opts: { command: string; operation: string; }) => void
```

### `dispatchRaw`

Dispatch and return the raw response without handling output.  For commands that need custom output logic (pagination, conditional messages, etc.), call this instead of dispatchFromCli().

```typescript
(gateway: Gateway, domain: string, operation: string, params?: Record<string, unknown> | undefined) => Promise<DispatchResponse>
```

### `resolveTier`

Resolve tier from request params, defaulting to 'standard'.

```typescript
(params?: Record<string, unknown> | undefined, sessionScope?: { type: string; epicId?: string | undefined; } | null | undefined) => MviTier
```

### `isOperationAllowed`

Check if a domain is allowed at the given tier.

```typescript
(domain: string, tier: MviTier) => boolean
```

### `applyProjection`

Apply field projection to a result object. Removes fields that are excluded at the given tier and prunes depth.

```typescript
<T>(data: T, config: ProjectionConfig) => T
```

### `createProjectionContext`

Create projection context from request params.

```typescript
(params?: Record<string, unknown> | undefined) => ProjectionContext
```

### `createProjectionMiddleware`

Create the MVI projection middleware.  Extracts _mviTier from params, checks domain access, and applies field exclusions to the response.

```typescript
() => Middleware
```

### `createProtocolEnforcement`

Creates a middleware that enforces protocol compliance.  Delegates to ProtocolEnforcer.enforceProtocol() which: - Passes through query operations untouched - Passes through mutate operations that don't require validation - Validates protocol compliance on validated mutate operations after execution - In strict mode, blocks operations with protocol violations (exit codes 60-70)

```typescript
(strictMode?: boolean) => Middleware
```

### `createRateLimiter`

Creates a rate limiting middleware.

```typescript
(config?: Partial<RateLimitingConfig> | undefined) => Middleware
```

### `createVerificationGates`

```typescript
(strictMode?: boolean) => Middleware
```

### `initMcpDispatcher`

Initialize and get the singleton MCP dispatcher.

```typescript
(config?: McpDispatcherConfig) => Dispatcher
```

### `getMcpDispatcher`

Get the initialized singleton MCP dispatcher.

```typescript
() => Dispatcher
```

### `resetMcpDispatcher`

Reset the singleton dispatcher (for testing).

```typescript
() => void
```

### `handleMcpToolCall`

Handle an MCP tool call (query or mutate).  Translates the MCP parameters into a DispatchRequest, executes it through the dispatcher, and formats the response back to the standard MCP SDK format.

```typescript
(gateway: string, domain: string, operation: string, params?: Record<string, unknown> | undefined, requestId?: string | undefined) => Promise<DispatchResponse>
```

### `initLogger`

Initialize the root logger. Call once at startup.  Uses pino-roll for automatic size+daily rotation with built-in retention. No custom rotation code needed.

```typescript
(cleoDir: string, config: LoggerConfig, projectHash?: string | undefined) => Logger<never, boolean>
```

**Parameters:**

- `cleoDir` — Absolute path to .cleo directory
- `config` — Logging configuration from CleoConfig.logging
- `projectHash` — Stable project identity token bound to every log entry.                        Optional for backward compatibility; warns if absent.

**Returns:** The root pino logger instance

### `getLogger`

Get a child logger bound to a subsystem name.  Safe to call before initLogger — returns a stderr fallback logger so early startup code and tests never crash.

```typescript
(subsystem: string) => Logger<never, boolean>
```

**Parameters:**

- `subsystem` — Logical subsystem name (e.g. 'audit', 'mcp', 'migration')

### `getLogDir`

Get the current log directory path. Useful for read APIs that need to scan log files.

```typescript
() => string | null
```

### `closeLogger`

Flush and close the logger. Call during graceful shutdown.  Returns a Promise that resolves once the pino transport worker thread has processed all pending writes. Callers that cannot await (e.g. sync shutdown handlers) may fire-and-forget safely — the underlying flush will still occur before the process exits.

```typescript
() => Promise<void>
```

### `getPlatformPaths`

Get OS-appropriate paths for CLEO's global directories. Cached after first call. CLEO_HOME env var overrides the data path.  The cache is automatically invalidated when CLEO_HOME changes, so test code can set process.env['CLEO_HOME'] without calling _resetPlatformPathsCache() manually.

```typescript
() => PlatformPaths
```

### `getSystemInfo`

Get a cached system information snapshot. Captured once and reused for the process lifetime. Useful for diagnostics, issue reports, and log enrichment.

```typescript
() => SystemInfo
```

### `_resetPlatformPathsCache`

Invalidate the path and system info caches. Use in tests after mutating CLEO_HOME env var.

```typescript
() => void
```

### `isProjectInitialized`

Check if a CLEO project is initialized at the given root. Checks for tasks.db.

```typescript
(projectRoot?: string | undefined) => boolean
```

### `getCleoHome`

Get the global CLEO home directory. Respects CLEO_HOME env var; otherwise uses the OS-appropriate data path via env-paths (XDG_DATA_HOME on Linux, Library/Application Support on macOS, %LOCALAPPDATA% on Windows).

```typescript
() => string
```

### `getCleoTemplatesDir`

Get the global CLEO templates directory.

```typescript
() => string
```

### `getCleoSchemasDir`

Get the global CLEO schemas directory.

```typescript
() => string
```

### `getCleoDocsDir`

Get the global CLEO docs directory.

```typescript
() => string
```

### `getCleoDir`

Get the project CLEO data directory (relative). Respects CLEO_DIR env var, defaults to ".cleo".

```typescript
(cwd?: string | undefined) => string
```

### `getCleoDirAbsolute`

Get the absolute path to the project CLEO directory.

```typescript
(cwd?: string | undefined) => string
```

### `getProjectRoot`

Get the project root from the CLEO directory. Respects CLEO_ROOT env var, then derives from CLEO_DIR. If CLEO_DIR is ".cleo", the project root is its parent.

```typescript
(cwd?: string | undefined) => string
```

### `resolveProjectPath`

Resolve a project-relative path to an absolute path.

```typescript
(relativePath: string, cwd?: string | undefined) => string
```

### `getTaskPath`

Get the path to the project's tasks.db file (SQLite database).

```typescript
(cwd?: string | undefined) => string
```

### `getConfigPath`

Get the path to the project's config.json file.

```typescript
(cwd?: string | undefined) => string
```

### `getSessionsPath`

Get the path to the project's sessions.json file.

```typescript
(cwd?: string | undefined) => string
```

### `getArchivePath`

Get the path to the project's archive file.

```typescript
(cwd?: string | undefined) => string
```

### `getLogPath`

Get the path to the project's log file. Canonical structured runtime log path (pino).  T4644

```typescript
(cwd?: string | undefined) => string
```

### `getBackupDir`

Get the backup directory for operational backups.

```typescript
(cwd?: string | undefined) => string
```

### `getGlobalConfigPath`

Get the global config file path.

```typescript
() => string
```

### `getAgentOutputsDir`

Get the agent outputs directory (relative path) from config or default.  Config lookup priority:   1. config.agentOutputs.directory   2. config.research.outputDir (deprecated)   3. config.directories.agentOutputs (deprecated)   4. Default: '.cleo/agent-outputs'   T4700

```typescript
(cwd?: string | undefined) => string
```

### `getAgentOutputsAbsolute`

Get the absolute path to the agent outputs directory.  T4700

```typescript
(cwd?: string | undefined) => string
```

### `getManifestPath`

Get the absolute path to the MANIFEST.jsonl file.  Checks config.agentOutputs.manifestFile for custom filename, defaults to 'MANIFEST.jsonl'.   T4700

```typescript
(cwd?: string | undefined) => string
```

### `getManifestArchivePath`

Get the absolute path to the MANIFEST.archive.jsonl file.  T4700

```typescript
(cwd?: string | undefined) => string
```

### `isAbsolutePath`

Check if a path is absolute (POSIX or Windows).

```typescript
(path: string) => boolean
```

### `getCleoLogDir`

Get the OS log directory for CLEO global logs. Linux: ~/.local/state/cleo | macOS: ~/Library/Logs/cleo | Windows: %LOCALAPPDATA%cleoLog

```typescript
() => string
```

### `getCleoCacheDir`

Get the OS cache directory for CLEO. Linux: ~/.cache/cleo | macOS: ~/Library/Caches/cleo | Windows: %LOCALAPPDATA%cleoCache

```typescript
() => string
```

### `getCleoTempDir`

Get the OS temp directory for CLEO ephemeral files.

```typescript
() => string
```

### `getCleoConfigDir`

Get the OS config directory for CLEO. Linux: ~/.config/cleo | macOS: ~/Library/Preferences/cleo | Windows: %APPDATA%cleoConfig

```typescript
() => string
```

### `getAgentsHome`

Get the global agents hub directory. Respects AGENTS_HOME env var, defaults to ~/.agents.

```typescript
() => string
```

### `getClaudeAgentsDir`

Get the Claude Code agents directory (~/.claude/agents by default).

```typescript
() => string
```

### `getClaudeMemDbPath`

Get the claude-mem SQLite database path.

```typescript
() => string
```

### `vacuumIntoBackup`

Create a VACUUM INTO snapshot of the SQLite database.  Debounced by default (30s). Pass `force: true` to bypass debounce. WAL checkpoint is run before the snapshot for consistency. Oldest snapshots are rotated out when MAX_SNAPSHOTS is reached.  Non-fatal: all errors are swallowed.

```typescript
(opts?: VacuumOptions) => Promise<void>
```

### `listSqliteBackups`

List existing SQLite backup snapshots, newest first.

```typescript
(cwd?: string | undefined) => { name: string; path: string; mtimeMs: number; }[]
```

### `getBrainDbPath`

Get the path to the brain.db SQLite database file.

```typescript
(cwd?: string | undefined) => string
```

### `resolveBrainMigrationsFolder`

Resolve the path to the drizzle-brain migrations folder. Works from both src/ (dev via tsx) and dist/ (compiled).

```typescript
() => string
```

### `isBrainVecLoaded`

Check whether the sqlite-vec extension is loaded for the current brain.db.

```typescript
() => boolean
```

### `getBrainDb`

Initialize the brain.db SQLite database (lazy, singleton). Creates the database file and tables if they don't exist. Returns the drizzle ORM instance (async via sqlite-proxy).  Uses a promise guard so concurrent callers wait for the same initialization to complete (migrations are async).

```typescript
(cwd?: string | undefined) => Promise<NodeSQLiteDatabase<typeof import("/mnt/projects/cleocode/packages/core/src/store/brain-schema", { with: { "resolution-mode": "import" } }), EmptyRelations>>
```

### `closeBrainDb`

Close the brain.db database connection and release resources.

```typescript
() => void
```

### `resetBrainDbState`

Reset brain.db singleton state without saving. Used during tests or when database file is recreated. Safe to call multiple times.

```typescript
() => void
```

### `getBrainNativeDb`

Get the underlying node:sqlite DatabaseSync instance for brain.db. Useful for direct PRAGMA calls or raw SQL operations. Returns null if the database hasn't been initialized.

```typescript
() => DatabaseSync | null
```

### `getNexusDbPath`

Get the path to the nexus.db SQLite database file. nexus.db lives in the global ~/.cleo/ directory.

```typescript
() => string
```

### `resolveNexusMigrationsFolder`

Resolve the path to the drizzle-nexus migrations folder. Works from both src/ (dev via tsx) and dist/ (compiled).

```typescript
() => string
```

### `getNexusDb`

Initialize the nexus.db SQLite database (lazy, singleton). Creates the database file and tables if they don't exist. Returns the drizzle ORM instance (async via sqlite-proxy).  Uses a promise guard so concurrent callers wait for the same initialization to complete (migrations are async).

```typescript
() => Promise<NodeSQLiteDatabase<typeof import("/mnt/projects/cleocode/packages/core/src/store/nexus-schema", { with: { "resolution-mode": "import" } }), EmptyRelations>>
```

### `closeNexusDb`

Close the nexus.db database connection and release resources.

```typescript
() => void
```

### `resetNexusDbState`

Reset nexus.db singleton state without saving. Used during tests or when database file is recreated. Safe to call multiple times.

```typescript
() => void
```

### `getNexusNativeDb`

Get the underlying node:sqlite DatabaseSync instance for nexus.db. Useful for direct PRAGMA calls or raw SQL operations. Returns null if the database hasn't been initialized.

```typescript
() => DatabaseSync | null
```

### `openNativeDatabase`

Open a node:sqlite DatabaseSync with CLEO standard pragmas.  CRITICAL: WAL mode is verified, not just requested. If another process holds an EXCLUSIVE lock in DELETE mode, PRAGMA journal_mode=WAL silently returns 'delete'. This caused data loss (T5173) when concurrent MCP servers opened the same database — writes were silently dropped under lock contention.

```typescript
(path: string, options?: { readonly?: boolean | undefined; timeout?: number | undefined; enableWal?: boolean | undefined; allowExtension?: boolean | undefined; } | undefined) => DatabaseSync
```

### `getDbPath`

Get the path to the SQLite database file.

```typescript
(cwd?: string | undefined) => string
```

### `getDb`

Initialize the SQLite database (lazy, singleton). Creates the database file and tables if they don't exist. Returns the drizzle ORM instance (node-sqlite driver).  Uses a promise guard so concurrent callers wait for the same initialization to complete (migrations are async).

```typescript
(cwd?: string | undefined) => Promise<NodeSQLiteDatabase<typeof import("/mnt/projects/cleocode/packages/core/src/store/tasks-schema", { with: { "resolution-mode": "import" } }), EmptyRelations>>
```

### `resolveMigrationsFolder`

Resolve the path to the drizzle migrations folder. Works from both src/ (dev via tsx) and dist/ (compiled).

```typescript
() => string
```

### `isSqliteBusy`

Check if an error is a SQLite BUSY error (database locked by another process). node:sqlite throws native Error with message containing the SQLite error code.  T5185

```typescript
(err: unknown) => boolean
```

### `closeDb`

Close the database connection and release resources.

```typescript
() => void
```

### `resetDbState`

Reset database singleton state without saving. Used during migrations when database file is deleted and recreated. Safe to call multiple times.

```typescript
() => void
```

### `getSchemaVersion`

Get the schema version from the database.

```typescript
(cwd?: string | undefined) => Promise<string | null>
```

### `dbExists`

Check if the database file exists.

```typescript
(cwd?: string | undefined) => boolean
```

### `getNativeDb`

Get the underlying node:sqlite DatabaseSync instance. Useful for direct PRAGMA calls or raw SQL operations. Returns null if the database hasn't been initialized.

```typescript
() => DatabaseSync | null
```

### `getNativeTasksDb`

Get the underlying node:sqlite DatabaseSync instance for tasks.db. Alias for getNativeDb() — mirrors getBrainNativeDb() naming convention.

```typescript
() => DatabaseSync | null
```

### `closeAllDatabases`

Close ALL database singletons (tasks.db, brain.db, nexus.db).  Must be called before deleting temp directories on Windows, where SQLite holds exclusive file handles on .db, .db-wal, and .db-shm files. Safe to call even if some databases were never opened.   T5508

```typescript
() => Promise<void>
```

### `safeParseJson`

Parse a JSON string, returning undefined on null/undefined input or parse error.

```typescript
<T>(str: string | null | undefined) => T | undefined
```

### `safeParseJsonArray`

Parse a JSON string expected to contain an array. Returns undefined for null/undefined input, empty arrays, or parse errors.

```typescript
<T = string>(str: string | null | undefined) => T[] | undefined
```

### `rowToTask`

Convert a database TaskRow to a domain Task object.

```typescript
(row: { sessionId: string | null; id: string; description: string | null; createdAt: string; updatedAt: string | null; status: "cancelled" | "pending" | "active" | "blocked" | "done" | "archived"; ... 24 more ...; modifiedBy: string | null; }) => Task
```

### `taskToRow`

Convert a domain Task to a database row for insert/upsert.

```typescript
(task: Partial<Task> & { id: string; }) => { id: string; title: string; sessionId?: string | null | undefined; description?: string | null | undefined; createdAt?: string | undefined; ... 25 more ...; modifiedBy?: string | ... 1 more ... | undefined; }
```

### `archivedTaskToRow`

Convert a domain Task to a row suitable for archived tasks.

```typescript
(task: Task) => { id: string; title: string; sessionId?: string | null | undefined; description?: string | null | undefined; createdAt?: string | undefined; updatedAt?: string | null | undefined; ... 24 more ...; modifiedBy?: string | ... 1 more ... | undefined; }
```

### `rowToSession`

Convert a SessionRow to a domain Session.

```typescript
(row: { gradeMode: number | null; id: string; name: string; status: "active" | "ended" | "orphaned" | "suspended"; agent: string | null; notesJson: string | null; scopeJson: string; currentTask: string | null; ... 14 more ...; resumeCount: number | null; }) => Session
```

### `getErrorDefinition`

Look up an error definition by exit code.

```typescript
(code: number) => ErrorDefinition | undefined
```

### `getErrorDefinitionByLafsCode`

Look up an error definition by LAFS string code.

```typescript
(lafsCode: string) => ErrorDefinition | undefined
```

### `getAllErrorDefinitions`

Get all error definitions as an array.

```typescript
() => ErrorDefinition[]
```

### `upsertTask`

Upsert a single task row into the tasks table. Handles both active task upsert and archived task upsert via optional archiveFields.  Defensively nulls out parentId if it references a non-existent task, preventing orphaned FK violations from blocking bulk operations (T5034).

```typescript
(db: DrizzleDb, row: { id: string; title: string; sessionId?: string | null | undefined; description?: string | null | undefined; createdAt?: string | undefined; updatedAt?: string | null | undefined; ... 24 more ...; modifiedBy?: string | ... 1 more ... | undefined; }, archiveFields?: ArchiveFields | undefined) => ...
```

### `upsertSession`

Upsert a single session row into the sessions table.

```typescript
(db: DrizzleDb, session: Session) => Promise<void>
```

### `updateDependencies`

Update dependencies for a task: delete existing, then re-insert. Optionally filters by a set of valid IDs.

```typescript
(db: DrizzleDb, taskId: string, depends: string[], validIds?: Set<string> | undefined) => Promise<void>
```

### `batchUpdateDependencies`

Batch-update dependencies for multiple tasks in two bulk SQL operations. Replaces per-task updateDependencies() loops with: 1. Single DELETE for all task IDs 2. Single INSERT for all dependency rows  Callers are responsible for wrapping this in a transaction if needed.

```typescript
(db: DrizzleDb, tasks: { taskId: string; deps: string[]; }[], validIds?: Set<string> | undefined) => Promise<void>
```

### `loadDependenciesForTasks`

Batch-load dependencies for a list of tasks and apply them in-place. Uses inArray for efficient querying. Optionally filters by a set of valid IDs.

```typescript
(db: DrizzleDb, tasks: Task[], validationIds?: Set<string> | undefined) => Promise<void>
```

### `loadRelationsForTasks`

Batch-load relations for a list of tasks and apply them in-place. Mirrors loadDependenciesForTasks pattern for task_relations table (T5168).

```typescript
(db: DrizzleDb, tasks: Task[]) => Promise<void>
```

### `setMetaValue`

Write a JSON blob to the schema_meta table by key.

```typescript
(cwd: string | undefined, key: string, value: unknown) => Promise<void>
```

### `createSqliteDataAccessor`

Create a SQLite-backed DataAccessor.  Opens (or creates) the SQLite database at `.cleo/tasks.db` and returns a DataAccessor that materializes/dematerializes whole-file structures from the relational tables.

```typescript
(cwd?: string | undefined) => Promise<DataAccessor>
```

**Parameters:**

- `cwd` — Working directory for path resolution (defaults to process.cwd())

### `atomicWrite`

Write data to a file atomically. Creates parent directories if they don't exist. Uses write-file-atomic for crash-safe writes (temp file - rename).

```typescript
(filePath: string, data: string, options?: { mode?: number | undefined; encoding?: BufferEncoding | undefined; } | undefined) => Promise<void>
```

### `safeReadFile`

Read a file and return its contents. Returns null if the file does not exist.

```typescript
(filePath: string) => Promise<string | null>
```

### `atomicWriteJson`

Write JSON data atomically with consistent formatting.

```typescript
(filePath: string, data: unknown, options?: { indent?: number | undefined; } | undefined) => Promise<void>
```

### `atomicDatabaseMigration`

Perform atomic database migration using rename operations.  Pattern:   1. Write new database to temp file (tasks.db.new)   2. Validate temp database integrity   3. Rename existing tasks.db → tasks.db.backup   4. Rename temp → tasks.db (atomic)   5. Only delete backup on success

```typescript
(dbPath: string, tempPath: string, validateFn: (path: string) => Promise<boolean>) => Promise<AtomicMigrationResult>
```

**Parameters:**

- `dbPath` — Path to the database file (e.g., tasks.db)
- `tempPath` — Path to temporary database (e.g., tasks.db.new)
- `validateFn` — Async function to validate the temp database

**Returns:** Result with paths and success status

### `restoreDatabaseFromBackup`

Restore database from backup after failed migration.

```typescript
(dbPath: string, backupPath: string) => Promise<boolean>
```

**Parameters:**

- `dbPath` — Path to the database file
- `backupPath` — Path to the backup file

**Returns:** true if restore succeeded

### `cleanupMigrationArtifacts`

Clean up migration artifacts after successful migration.

```typescript
(backupPath: string) => Promise<boolean>
```

**Parameters:**

- `backupPath` — Path to backup file to delete

**Returns:** true if cleanup succeeded

### `validateSqliteDatabase`

Validate SQLite database integrity by attempting to open it.

```typescript
(dbPath: string) => Promise<boolean>
```

**Parameters:**

- `dbPath` — Path to database file

**Returns:** true if database is valid

### `createBackup`

Create a numbered backup of a file. Rotates existing backups (file.1 - file.2, etc.) and removes excess.

```typescript
(filePath: string, backupDir: string, maxBackups?: number) => Promise<string>
```

### `listBackups`

List existing backups for a file, sorted by number (newest first).

```typescript
(fileName: string, backupDir: string) => Promise<string[]>
```

### `restoreFromBackup`

Restore a file from its most recent backup. Returns the path of the backup that was restored.

```typescript
(fileName: string, backupDir: string, targetPath: string) => Promise<string>
```

### `acquireLock`

Acquire an exclusive lock on a file. Returns a release function that must be called when done.

```typescript
(filePath: string, options?: { stale?: number | undefined; retries?: number | undefined; } | undefined) => Promise<ReleaseFn>
```

### `isLocked`

Check if a file is currently locked.

```typescript
(filePath: string) => Promise<boolean>
```

### `withLock`

Execute a function while holding an exclusive lock on a file. The lock is automatically released when the function completes (or throws).

```typescript
<T>(filePath: string, fn: () => Promise<T>, options?: { stale?: number | undefined; retries?: number | undefined; } | undefined) => Promise<T>
```

### `isProviderHookEvent`

Type guard for CAAMP/provider-discoverable hook events.

```typescript
(event: HookEvent) => event is HookEvent
```

### `isInternalHookEvent`

Type guard for CLEO-local coordination hook events.

```typescript
(event: HookEvent) => event is "onWorkAvailable" | "onAgentSpawn" | "onAgentComplete" | "onCascadeStart" | "onPatrol"
```

### `readJson`

Read and parse a JSON file. Returns null if the file does not exist.

```typescript
<T = unknown>(filePath: string) => Promise<T | null>
```

### `readJsonRequired`

Read a JSON file, throwing if it doesn't exist.

```typescript
<T = unknown>(filePath: string) => Promise<T>
```

### `computeChecksum`

Compute a truncated SHA-256 checksum of a value. Used for integrity verification (matches Bash CLI's 16-char hex format).

```typescript
(data: unknown) => string
```

### `saveJson`

Save JSON data with optional locking, backup, and validation. Follows the CLEO atomic write pattern:   1. Acquire lock   2. Validate data   3. Create backup of existing file   4. Atomic write (temp file - rename)   5. Release lock

```typescript
(filePath: string, data: unknown, options?: SaveJsonOptions | undefined) => Promise<void>
```

### `appendJsonl`

Append a line to a JSONL file atomically. Used for manifest entries and audit logs.

```typescript
(filePath: string, entry: unknown) => Promise<void>
```

### `readLogEntries`

Read log entries from a hybrid JSON/JSONL file. Handles three formats:   1. Pure JSON: `{ "entries": [...] }` (legacy bash format)   2. Pure JSONL: one JSON object per line (new TS format)   3. Hybrid: JSON object followed by JSONL lines (migration state) Returns a flat array of all entries found.  T4622

```typescript
(filePath: string) => Promise<Record<string, unknown>[]>
```

### `makeCleoGitEnv`

Build environment variables that point git at the isolated .cleo/.git repo.  T4872

```typescript
(cleoDir: string) => ProcessEnv
```

### `cleoGitCommand`

Run a git command against the isolated .cleo/.git repo, suppressing errors.  T4872

```typescript
(args: string[], cleoDir: string) => Promise<{ stdout: string; success: boolean; }>
```

### `isCleoGitInitialized`

Check whether the isolated .cleo/.git repo has been initialized.  T4872

```typescript
(cleoDir: string) => boolean
```

### `loadStateFileAllowlist`

Load additional state file paths from config.json `checkpoint.stateFileAllowlist`. Returns an empty array if config is missing, malformed, or the key is absent.

```typescript
(cwd?: string | undefined) => Promise<string[]>
```

### `loadCheckpointConfig`

Load checkpoint configuration from config.json.  T4552

```typescript
(cwd?: string | undefined) => Promise<CheckpointConfig>
```

### `shouldCheckpoint`

Check whether a checkpoint should be performed. Evaluates: enabled, .cleo/.git initialized, debounce elapsed, files changed.  T4552  T4872

```typescript
(options?: { force?: boolean | undefined; cwd?: string | undefined; } | undefined) => Promise<boolean>
```

### `gitCheckpoint`

Stage .cleo/ state files and commit to the isolated .cleo/.git repo. Never fatal - all git errors are suppressed.  T4552  T4872

```typescript
(trigger?: "manual" | "auto" | "session-end", context?: string | undefined, cwd?: string | undefined) => Promise<void>
```

### `gitCheckpointStatus`

Show checkpoint configuration and status.  T4552  T4872

```typescript
(cwd?: string | undefined) => Promise<CheckpointStatus>
```

### `gitCheckpointDryRun`

Show what files would be committed (dry-run).  T4552  T4872

```typescript
(cwd?: string | undefined) => Promise<ChangedFile[]>
```

### `getSafetyStats`

Get current safety statistics

```typescript
() => SafetyStats
```

### `resetSafetyStats`

Reset safety statistics (for testing)

```typescript
() => void
```

### `safeSaveSessions`

Safe wrapper for DataAccessor.saveSessions()

```typescript
(accessor: DataAccessor, data: Session[], cwd?: string | undefined, options?: Partial<SafetyOptions> | undefined) => Promise<void>
```

### `safeSaveArchive`

Safe wrapper for DataAccessor.saveArchive()

```typescript
(accessor: DataAccessor, data: ArchiveFile, cwd?: string | undefined, options?: Partial<SafetyOptions> | undefined) => Promise<...>
```

### `safeSingleTaskWrite`

Safe wrapper for single-task write operations (T5034).  Performs: 1. Sequence validation 2. Write operation (caller-provided function) 3. Git checkpoint  Verification is lightweight — no full-file read-back. The write itself is a targeted SQL operation that either succeeds or throws.

```typescript
(_accessor: DataAccessor, taskId: string, writeFn: () => Promise<void>, cwd?: string | undefined, options?: Partial<SafetyOptions> | undefined) => Promise<...>
```

### `safeAppendLog`

Safe wrapper for DataAccessor.appendLog()  Note: Log appends are fire-and-forget (no verification) but we still checkpoint to ensure data is committed.

```typescript
(accessor: DataAccessor, entry: Record<string, unknown>, cwd?: string | undefined, options?: Partial<SafetyOptions> | undefined) => Promise<...>
```

### `runDataIntegrityCheck`

Run comprehensive data integrity check. Validates all data files and sequence consistency.

```typescript
(accessor: DataAccessor, cwd?: string | undefined) => Promise<{ passed: boolean; errors: string[]; warnings: string[]; stats: SafetyStats; }>
```

### `forceSafetyCheckpoint`

Force immediate checkpoint. Use before destructive operations.

```typescript
(context: string, cwd?: string | undefined) => Promise<void>
```

### `disableSafety`

Disable all safety for current process. DANGEROUS - only use for recovery operations.

```typescript
() => void
```

### `enableSafety`

Re-enable safety after being disabled.

```typescript
() => void
```

### `wrapWithSafety`

Wrap a DataAccessor with safety.  This is the internal factory helper that wraps any accessor with the SafetyDataAccessor wrapper.

```typescript
(accessor: DataAccessor, cwd?: string | undefined) => DataAccessor
```

**Parameters:**

- `accessor` — The accessor to wrap
- `cwd` — Working directory

**Returns:** SafetyDataAccessor wrapping the input

### `isSafetyEnabled`

Check if safety is currently enabled.

```typescript
() => boolean
```

**Returns:** true if safety checks are active

### `getSafetyStatus`

Get safety status information.

```typescript
() => { enabled: boolean; reason?: string | undefined; }
```

**Returns:** Object with safety status details

### `createDataAccessor`

Create a DataAccessor for the given working directory. Always creates a SQLite accessor (ADR-006 canonical storage).  ALL accessors returned are safety-enabled by default via SafetyDataAccessor wrapper. Use CLEO_DISABLE_SAFETY=true to bypass (emergency only).

```typescript
(_engine?: "sqlite" | undefined, cwd?: string | undefined) => Promise<DataAccessor>
```

### `getAccessor`

Convenience: get a DataAccessor with auto-detected engine.

```typescript
(cwd?: string | undefined) => Promise<DataAccessor>
```

### `showSequence`

Show current sequence state.

```typescript
(cwd?: string | undefined) => Promise<Record<string, unknown>>
```

### `checkSequence`

Check sequence integrity.

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Record<string, unknown>>
```

### `repairSequence`

Repair sequence if behind.

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<RepairResult>
```

### `allocateNextTaskId`

Atomically allocate the next task ID via SQLite.  Uses BEGIN IMMEDIATE to guarantee no two concurrent callers receive the same ID, even across processes (WAL mode).  Falls back to repair+retry if the sequence counter is behind the actual max task ID (e.g., stale counter from installations that never incremented it).   T5184

```typescript
(cwd?: string | undefined, retryCount?: number) => Promise<string>
```

### `checkTaskExists`

Check if a task ID already exists (collision detection).

```typescript
(taskId: string, cwd?: string | undefined, config?: Partial<SafetyConfig>) => Promise<boolean>
```

### `verifyTaskWrite`

Verify a task was actually written to the database.

```typescript
(taskId: string, expectedData?: Partial<Task> | undefined, cwd?: string | undefined, config?: Partial<SafetyConfig>) => Promise<boolean>
```

### `validateAndRepairSequence`

Validate and repair sequence if necessary.

```typescript
(cwd?: string | undefined, config?: Partial<SafetyConfig>) => Promise<{ valid: boolean; repaired: boolean; oldCounter?: number | undefined; newCounter?: number | undefined; }>
```

**Returns:** true if sequence was valid or successfully repaired

### `triggerCheckpoint`

Trigger auto-checkpoint after successful write.

```typescript
(context: string, cwd?: string | undefined, config?: Partial<SafetyConfig>) => Promise<void>
```

### `safeCreateTask`

Safely create a task with all safety mechanisms. Wraps the actual createTask operation.

```typescript
(createFn: () => Promise<Task>, task: Task, cwd?: string | undefined, config?: Partial<SafetyConfig>) => Promise<Task>
```

### `safeUpdateTask`

Safely update a task with all safety mechanisms.

```typescript
(updateFn: () => Promise<Task | null>, taskId: string, _updates: Partial<Task>, cwd?: string | undefined, config?: Partial<SafetyConfig>) => Promise<...>
```

### `safeDeleteTask`

Safely delete a task with all safety mechanisms.

```typescript
(deleteFn: () => Promise<boolean>, taskId: string, cwd?: string | undefined, config?: Partial<SafetyConfig>) => Promise<boolean>
```

### `verifySessionWrite`

Verify session write.

```typescript
(sessionId: string, cwd?: string | undefined, config?: Partial<SafetyConfig>) => Promise<boolean>
```

### `safeCreateSession`

Safely create a session with all safety mechanisms.

```typescript
(createFn: () => Promise<Session>, session: Session, cwd?: string | undefined, config?: Partial<SafetyConfig>) => Promise<Session>
```

### `forceCheckpointBeforeOperation`

Force a checkpoint before destructive operations. Use this before migrations, bulk updates, etc.

```typescript
(operation: string, cwd?: string | undefined) => Promise<void>
```

### `runDataIntegrityCheck`

Run comprehensive data integrity check. Reports all issues found.

```typescript
(cwd?: string | undefined) => Promise<{ passed: boolean; issues: string[]; repairs: string[]; }>
```

### `getTask`

Get a task by ID, including its dependencies.

```typescript
(taskId: string, cwd?: string | undefined) => Promise<Task | null>
```

### `updateTask`

Update an existing task.

```typescript
(taskId: string, updates: Partial<Task>, cwd?: string | undefined) => Promise<Task | null>
```

### `deleteTask`

Delete a task by ID.

```typescript
(taskId: string, cwd?: string | undefined) => Promise<boolean>
```

### `listTasks`

List tasks with optional filters.

```typescript
(filters?: { status?: "cancelled" | "pending" | "active" | "blocked" | "done" | "archived" | undefined; parentId?: string | null | undefined; type?: TaskType | undefined; phase?: string | undefined; limit?: number | undefined; } | undefined, cwd?: string | undefined) => Promise<...>
```

### `findTasks`

Find tasks by fuzzy text search.

```typescript
(query: string, limit?: number, cwd?: string | undefined) => Promise<Task[]>
```

### `archiveTask`

Archive a task (sets status to 'archived' with metadata).

```typescript
(taskId: string, reason?: string | undefined, cwd?: string | undefined) => Promise<boolean>
```

### `addDependency`

Add a dependency between tasks.

```typescript
(taskId: string, dependsOn: string, cwd?: string | undefined) => Promise<void>
```

### `removeDependency`

Remove a dependency.

```typescript
(taskId: string, dependsOn: string, cwd?: string | undefined) => Promise<void>
```

### `addRelation`

Add a relation between tasks.

```typescript
(taskId: string, relatedTo: string, relationType?: "related" | "blocks" | "duplicates" | "absorbs" | "fixes" | "extends" | "supersedes", cwd?: string | undefined, reason?: string | undefined) => Promise<...>
```

### `getRelations`

Get relations for a task.

```typescript
(taskId: string, cwd?: string | undefined) => Promise<{ relatedTo: string; type: string; reason?: string | undefined; }[]>
```

### `getBlockerChain`

Get the dependency chain (blockers) for a task using recursive CTE.

```typescript
(taskId: string, cwd?: string | undefined) => Promise<string[]>
```

### `getChildren`

Get children of a task (hierarchy).

```typescript
(parentId: string, cwd?: string | undefined) => Promise<Task[]>
```

### `getSubtree`

Build a tree from a root task using recursive CTE.

```typescript
(rootId: string, cwd?: string | undefined) => Promise<Task[]>
```

### `countByStatus`

Count tasks by status.

```typescript
(cwd?: string | undefined) => Promise<Record<string, number>>
```

### `countTasks`

Get total task count (excluding archived).

```typescript
(cwd?: string | undefined) => Promise<number>
```

### `createTask`

Create a task with full safety protections. Includes: collision detection, write verification, sequence validation, auto-checkpoint.

```typescript
(task: Task, cwd?: string | undefined, config?: Partial<SafetyConfig> | undefined) => Promise<Task>
```

### `updateTaskSafe`

Update a task with full safety protections. Includes: write verification, auto-checkpoint.

```typescript
(taskId: string, updates: Partial<Task>, cwd?: string | undefined, config?: Partial<SafetyConfig> | undefined) => Promise<Task | null>
```

### `deleteTaskSafe`

Delete a task with full safety protections. Includes: delete verification, auto-checkpoint.

```typescript
(taskId: string, cwd?: string | undefined, config?: Partial<SafetyConfig> | undefined) => Promise<boolean>
```

### `showTask`

Get a task by ID with enriched details. Checks active tasks first, then archive if not found.  T4460

```typescript
(taskId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<TaskDetail>
```

### `createPage`

Create an LAFSPage object from pagination parameters.  Returns mode:"none" when no pagination is requested (no limit/offset). Returns mode:"offset" with hasMore/total when pagination is active.   T4668  T4663

```typescript
(input: PaginateInput) => LAFSPage
```

### `paginate`

Apply pagination to an array of items and return the sliced result with page metadata.   T4668  T4663

```typescript
<T>(items: T[], limit?: number | undefined, offset?: number | undefined) => { items: T[]; page: LAFSPage; }
```

### `toCompact`

Convert a full Task to compact representation.

```typescript
(task: Task) => CompactTask
```

### `listTasks`

List tasks with optional filtering and pagination.  T4460

```typescript
(options?: ListTasksOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<ListTasksResult>
```

### `fuzzyScore`

Calculate fuzzy match score between query and text. Higher score = better match. 0 = no match.  T4460

```typescript
(query: string, text: string) => number
```

### `findTasks`

Search tasks by fuzzy matching, ID prefix, or exact title. Returns minimal fields only (context-efficient).  T4460

```typescript
(options: FindTasksOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<FindTasksResult>
```

### `extractAdrId`

Extract ADR ID from filename (e.g., 'ADR-007-domain-consolidation.md' - 'ADR-007')

```typescript
(filename: string) => string
```

### `parseFrontmatter`

Parse bold-key frontmatter pattern: **Key**: value

```typescript
(content: string) => AdrFrontmatter
```

### `extractTitle`

Extract H1 title from markdown

```typescript
(content: string) => string
```

### `parseAdrFile`

Parse a single ADR markdown file into an AdrRecord

```typescript
(filePath: string, projectRoot: string) => AdrRecord
```

### `linkPipelineAdr`

Link ADRs to a pipeline task when the architecture_decision stage completes.

```typescript
(projectRoot: string, taskId: string) => Promise<PipelineAdrLinkResult>
```

**Parameters:**

- `projectRoot` — Absolute path to project root
- `taskId` — Task ID that owns the pipeline (e.g., 'T4942')

### `syncAdrsToDb`

Sync all ADR markdown files into the architecture_decisions table AND regenerate MANIFEST.jsonl in one pass.

```typescript
(projectRoot: string) => Promise<AdrSyncResult>
```

### `recordEvidence`

Record an evidence artifact linked to a lifecycle stage.  Writes to the SQLite `lifecycle_evidence` table.

```typescript
(epicId: string, stage: string, uri: string, type: EvidenceType, options?: { agent?: string | undefined; description?: string | undefined; cwd?: string | undefined; } | undefined) => Promise<...>
```

**Parameters:**

- `epicId` — Epic task ID (e.g. 'T4881')
- `stage` — Canonical stage name (e.g. 'research')
- `uri` — URI of the evidence artifact
- `type` — Evidence type: 'file', 'url', or 'manifest'
- `options` — Optional agent and description

**Returns:** The created evidence record

### `getEvidence`

Query evidence records for an epic, optionally filtered by stage.

```typescript
(epicId: string, stage?: string | undefined, cwd?: string | undefined) => Promise<EvidenceRecord[]>
```

**Parameters:**

- `epicId` — Epic task ID
- `stage` — Optional stage name filter
- `cwd` — Optional working directory

**Returns:** Array of evidence records

### `linkProvenance`

Convenience wrapper to record a file as provenance evidence.  Converts the file path to a URI relative to the `.cleo/` directory, sets the type to 'file', and extracts a description from the filename.

```typescript
(epicId: string, stage: string, filePath: string, cwd?: string | undefined) => Promise<EvidenceRecord>
```

**Parameters:**

- `epicId` — Epic task ID
- `stage` — Canonical stage name
- `filePath` — Absolute or relative path to the file
- `cwd` — Optional working directory

**Returns:** The created evidence record

### `getEvidenceSummary`

Aggregate evidence counts per stage for an epic.

```typescript
(epicId: string, cwd?: string | undefined) => Promise<{ stage: string; count: number; types: Record<EvidenceType, number>; }[]>
```

**Parameters:**

- `epicId` — Epic task ID
- `cwd` — Optional working directory

**Returns:** Array of per-stage summaries with type breakdowns

### `normalizeEpicId`

Strip suffixes from epic directory names. E.g. `T4881_install-channels` - `T4881`

```typescript
(dirName: string) => string
```

**Parameters:**

- `dirName` — Directory name that may contain a suffix

**Returns:** The normalized T#### epic ID

### `getRcasdBaseDir`

Get the absolute path to the `.cleo/rcasd/` base directory.

```typescript
(cwd?: string | undefined) => string
```

**Parameters:**

- `cwd` — Optional working directory override

**Returns:** Absolute path to the rcasd base directory

### `getEpicDir`

Get the absolute path to `.cleo/rcasd/{epicId}/`. Uses the normalized epic ID (without suffixes).

```typescript
(epicId: string, cwd?: string | undefined) => string
```

**Parameters:**

- `epicId` — Epic identifier (e.g. `T4881`)
- `cwd` — Optional working directory override

**Returns:** Absolute path to the epic directory

### `findEpicDir`

Search both `rcasd/` and legacy `rcsd/` for an existing epic directory. Also checks suffixed directory names (e.g. `T4881_install-channels` matches `T4881`).

```typescript
(epicId: string, cwd?: string | undefined) => string | null
```

**Parameters:**

- `epicId` — Epic identifier to search for
- `cwd` — Optional working directory override

**Returns:** Absolute path to the found directory, or null

### `getStagePath`

Get the stage subdirectory path for an epic. Uses STAGE_SUBDIRS mapping, falling back to the raw stage name.

```typescript
(epicId: string, stage: string, cwd?: string | undefined) => string
```

**Parameters:**

- `epicId` — Epic identifier
- `stage` — Canonical stage name (e.g. `research`, `contribution`)
- `cwd` — Optional working directory override

**Returns:** Absolute path to the stage subdirectory

### `ensureStagePath`

Get the stage subdirectory path, creating it if it does not exist.

```typescript
(epicId: string, stage: string, cwd?: string | undefined) => string
```

**Parameters:**

- `epicId` — Epic identifier
- `stage` — Canonical stage name
- `cwd` — Optional working directory override

**Returns:** Absolute path to the (now existing) stage subdirectory

### `getManifestPath`

Get the manifest path for an epic under the default rcasd directory.

```typescript
(epicId: string, cwd?: string | undefined) => string
```

**Parameters:**

- `epicId` — Epic identifier
- `cwd` — Optional working directory override

**Returns:** Absolute path to `.cleo/rcasd/{epicId}/_manifest.json`

### `findManifestPath`

Search both `rcasd/` and `rcsd/` for an existing manifest file. Checks suffixed directory names as well.

```typescript
(epicId: string, cwd?: string | undefined) => string | null
```

**Parameters:**

- `epicId` — Epic identifier
- `cwd` — Optional working directory override

**Returns:** Absolute path to the found manifest, or null

### `getLooseResearchFiles`

Scan the rcasd root directory for loose `T####_*.md` files that are not inside subdirectories.

```typescript
(cwd?: string | undefined) => { file: string; epicId: string; fullPath: string; }[]
```

**Parameters:**

- `cwd` — Optional working directory override

**Returns:** Array of file info with extracted epic ID

### `listEpicDirs`

List all epic directories across `rcasd/` and `rcsd/`.

```typescript
(cwd?: string | undefined) => { epicId: string; dirName: string; fullPath: string; }[]
```

**Parameters:**

- `cwd` — Optional working directory override

**Returns:** Array of epic info with normalized IDs and original directory names

### `parseFrontmatter`

Parse YAML frontmatter from a markdown string.  Finds the YAML block delimited by `---` at the start of the file, parses key-value pairs, and returns the structured metadata plus the remaining body content.

```typescript
(content: string) => ParsedFrontmatter
```

**Parameters:**

- `content` — Full markdown file content

**Returns:** Parsed frontmatter, body, and raw YAML block

### `serializeFrontmatter`

Convert a FrontmatterMetadata object to a YAML frontmatter string.  Output format:

```typescript
(metadata: FrontmatterMetadata) => string
```

**Parameters:**

- `metadata` — The frontmatter metadata to serialize

**Returns:** YAML frontmatter string including `---` delimiters

### `addFrontmatter`

Add or replace YAML frontmatter in markdown content.  If the content already has a frontmatter block, it is replaced. Otherwise the YAML block is prepended.

```typescript
(content: string, metadata: FrontmatterMetadata) => string
```

**Parameters:**

- `content` — Original markdown content
- `metadata` — Frontmatter metadata to set

**Returns:** Updated content with new frontmatter

### `buildFrontmatter`

Convenience builder for common frontmatter patterns.  Auto-sets `updated` to the current ISO date string.

```typescript
(epicId: string, stage: string, options?: { task?: string | undefined; related?: RelatedLink[] | undefined; created?: string | undefined; } | undefined) => FrontmatterMetadata
```

**Parameters:**

- `epicId` — Epic identifier (e.g. `T4881`)
- `stage` — RCASD stage name (e.g. `research`)
- `options` — Optional fields: task, related links, created date

**Returns:** A FrontmatterMetadata object ready for serialization

### `getBacklinks`

Scan all markdown files in `.cleo/rcasd/` for files that reference the given epic+stage combination via their `related` frontmatter links.  This enables "what links here?" queries (Obsidian-style backlinks).

```typescript
(epicId: string, stage: string, cwd?: string | undefined) => { file: string; link: RelatedLink; }[]
```

**Parameters:**

- `epicId` — Epic identifier to search for
- `stage` — Stage name to search for
- `cwd` — Optional working directory override

**Returns:** Array of files with matching related links

### `getStageOrder`

Get the order/index of a stage (1-based).

```typescript
(stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release") => number
```

**Parameters:**

- `stage` — The stage to look up

**Returns:** The stage order (1-9)   T4800

### `isStageBefore`

Check if stage A comes before stage B in the pipeline.

```typescript
(stageA: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", stageB: "research" | ... 7 more ... | "release") => boolean
```

**Parameters:**

- `stageA` — First stage to compare
- `stageB` — Second stage to compare

**Returns:** True if stageA comes before stageB   T4800

### `isStageAfter`

Check if stage A comes after stage B in the pipeline.

```typescript
(stageA: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", stageB: "research" | ... 7 more ... | "release") => boolean
```

**Parameters:**

- `stageA` — First stage to compare
- `stageB` — Second stage to compare

**Returns:** True if stageA comes after stageB   T4800

### `getNextStage`

Get the next stage in the pipeline.

```typescript
(stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release") => "research" | ... 8 more ... | null
```

**Parameters:**

- `stage` — Current stage

**Returns:** The next stage, or null if at the end   T4800

### `getPreviousStage`

Get the previous stage in the pipeline.

```typescript
(stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release") => "research" | ... 8 more ... | null
```

**Parameters:**

- `stage` — Current stage

**Returns:** The previous stage, or null if at the start   T4800

### `getStagesBetween`

Get all stages between two stages (inclusive).

```typescript
(from: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", to: "research" | "consensus" | ... 6 more ... | "release") => ("research" | ... 7 more ... | "release")[]
```

**Parameters:**

- `from` — Starting stage
- `to` — Ending stage

**Returns:** Array of stages between from and to   T4800

### `getPrerequisites`

Get prerequisites for a stage.

```typescript
(stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release") => ("research" | ... 7 more ... | "release")[]
```

**Parameters:**

- `stage` — The stage to get prerequisites for

**Returns:** Array of prerequisite stages   T4800

### `isPrerequisite`

Check if one stage is a prerequisite of another.

```typescript
(potentialPrereq: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", stage: "research" | ... 7 more ... | "release") => boolean
```

**Parameters:**

- `potentialPrereq` — Stage that might be a prerequisite
- `stage` — Stage to check against

**Returns:** True if potentialPrereq is required before stage   T4800

### `getDependents`

Get all stages that depend on a given stage.

```typescript
(stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release") => ("research" | ... 7 more ... | "release")[]
```

**Parameters:**

- `stage` — The stage to find dependents for

**Returns:** Array of stages that require this stage   T4800

### `isValidStage`

Check if a stage name is valid.

```typescript
(stage: string) => stage is "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release"
```

**Parameters:**

- `stage` — Stage name to validate

**Returns:** True if valid stage name   T4800

### `validateStage`

Validate a stage name and throw if invalid.

```typescript
(stage: string) => "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release"
```

**Parameters:**

- `stage` — Stage name to validate

**Returns:** The validated Stage   T4800

### `isValidStageStatus`

Check if a stage status is valid.

```typescript
(status: string) => status is "completed" | "failed" | "blocked" | "not_started" | "in_progress" | "skipped"
```

**Parameters:**

- `status` — Status to validate

**Returns:** True if valid status   T4800

### `getStagesByCategory`

Get stages by category.

```typescript
(category: StageCategory) => ("research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release")[]
```

**Parameters:**

- `category` — Category to filter by

**Returns:** Array of stages in that category   T4800

### `getSkippableStages`

Get skippable stages.

```typescript
() => ("research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release")[]
```

**Returns:** Array of stages that can be skipped   T4800

### `checkTransition`

Check if a transition is allowed.

```typescript
(from: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", to: "research" | "consensus" | ... 6 more ... | "release", force?: boolean) => { ...; }
```

**Parameters:**

- `from` — Source stage
- `to` — Target stage
- `force` — Whether to allow forced transitions

**Returns:** Object with allowed flag and reason   T4800

### `ensureStageArtifact`

Ensure stage artifact exists and frontmatter/backlinks are up to date.

```typescript
(epicId: string, stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", cwd?: string | undefined) => Promise<...>
```

### `getLifecycleState`

Get the current lifecycle state for an epic.  T4467

```typescript
(epicId: string, cwd?: string | undefined) => Promise<RcasdManifest>
```

### `startStage`

Start a lifecycle stage.  T4467

```typescript
(epicId: string, stage: string, cwd?: string | undefined) => Promise<StageTransitionResult>
```

### `completeStage`

Complete a lifecycle stage.  T4467

```typescript
(epicId: string, stage: string, artifacts?: string[] | undefined, cwd?: string | undefined) => Promise<StageTransitionResult>
```

### `skipStage`

Skip a lifecycle stage.  T4467

```typescript
(epicId: string, stage: string, reason: string, cwd?: string | undefined) => Promise<StageTransitionResult>
```

### `checkGate`

Check lifecycle gate before starting a stage.  T4467

```typescript
(epicId: string, targetStage: string, cwd?: string | undefined) => Promise<GateCheckResult>
```

### `getLifecycleStatus`

Get lifecycle status for an epic from SQLite. Returns stage progress, current/next stage, and blockers.  T4801 - SQLite-native implementation

```typescript
(epicId: string, cwd?: string | undefined) => Promise<{ epicId: string; title?: string | undefined; currentStage: "research" | "consensus" | "architecture_decision" | "specification" | ... 5 more ... | null; stages: { ...; }[]; nextStage: "research" | ... 8 more ... | null; blockedOn: string[]; initialized: boolean;...
```

### `getLifecycleHistory`

Get lifecycle history for an epic. Returns stage transitions and gate events sorted by timestamp. SQLite-native implementation - queries lifecycle_stages and lifecycle_gate_results tables.  T4785  T4801

```typescript
(epicId: string, cwd?: string | undefined) => Promise<{ epicId: string; history: LifecycleHistoryEntry[]; }>
```

### `getLifecycleGates`

Get all gate statuses for an epic.  T4785

```typescript
(epicId: string, cwd?: string | undefined) => Promise<Record<string, Record<string, GateData>>>
```

### `getStagePrerequisites`

Get prerequisites for a target stage. Pure data function, no I/O.  T4785

```typescript
(targetStage: string) => { prerequisites: string[]; stageInfo: { stage: string; name: string; description: string; order: number; } | undefined; }
```

### `checkStagePrerequisites`

Check if a stage's prerequisites are met for an epic.  T4785

```typescript
(epicId: string, targetStage: string, cwd?: string | undefined) => Promise<{ epicId: string; targetStage: string; valid: boolean; canProgress: boolean; missingPrerequisites: string[]; issues: { ...; }[]; }>
```

### `recordStageProgress`

Record a stage status transition (progress/record). SQLite-native implementation - T4801  T4785  T4801

```typescript
(epicId: string, stage: string, status: string, notes?: string | undefined, cwd?: string | undefined) => Promise<{ epicId: string; stage: string; status: string; timestamp: string; }>
```

### `skipStageWithReason`

Skip a stage with a reason (engine-compatible).  T4785

```typescript
(epicId: string, stage: string, reason: string, cwd?: string | undefined) => Promise<{ epicId: string; stage: string; reason: string; timestamp: string; }>
```

### `resetStage`

Reset a stage to pending (emergency).  T4785

```typescript
(epicId: string, stage: string, reason: string, cwd?: string | undefined) => Promise<{ epicId: string; stage: string; reason: string; }>
```

### `passGate`

Mark a gate as passed. SQLite-native implementation - T4801  T4785  T4801

```typescript
(epicId: string, gateName: string, agent?: string | undefined, notes?: string | undefined, cwd?: string | undefined) => Promise<{ epicId: string; gateName: string; timestamp: string; }>
```

### `failGate`

Mark a gate as failed. SQLite-native implementation - T4801  T4785  T4801

```typescript
(epicId: string, gateName: string, reason?: string | undefined, cwd?: string | undefined) => Promise<{ epicId: string; gateName: string; reason?: string | undefined; timestamp: string; }>
```

### `listEpicsWithLifecycle`

List all epic IDs that have lifecycle data.  T4785

```typescript
(cwd?: string | undefined) => Promise<string[]>
```

### `getCurrentSessionId`

Get the current session ID.

```typescript
(cwd?: string | undefined) => string | null
```

### `getContextStatePath`

Get context state file path for a session.

```typescript
(sessionId?: string | undefined, cwd?: string | undefined) => string
```

### `readContextState`

Read context state for a session. Returns null if stale or missing.

```typescript
(sessionId?: string | undefined, cwd?: string | undefined) => Record<string, unknown> | null
```

### `getThresholdLevel`

Determine the threshold level for a given percentage.

```typescript
(percentage: number) => AlertLevel | null
```

### `shouldAlert`

Determine if we should alert based on threshold crossing. Returns the alert level if a new threshold was crossed, null otherwise.

```typescript
(currentPct: number, lastAlertedPct?: number, minThreshold?: AlertLevel) => AlertLevel | null
```

### `getRecommendedAction`

Get recommended action for an alert level.

```typescript
(percentage: number) => string | null
```

### `checkContextAlert`

Main function to check and determine if an alert should fire. Non-blocking - always returns a result.

```typescript
(currentCommand?: string | undefined, cwd?: string | undefined) => AlertCheckResult
```

### `pushWarning`

Push a deprecation or informational warning into the current envelope. Warnings are drained (consumed) by the next formatSuccess/formatError call.   T4669  T4663

```typescript
(warning: Warning) => void
```

### `formatSuccess`

Format a successful result as a full LAFS-conformant envelope.  Always produces the full LAFSEnvelope with $schema and _meta. When operation is omitted, defaults to 'cli.output'. Supports optional page (T4668) and _extensions (T4670).   T4672  T4668  T4670  T4663

```typescript
<T>(data: T, message?: string | undefined, operationOrOpts?: string | FormatOptions | undefined) => string
```

### `formatError`

Format an error as a full LAFS-conformant envelope.  Always produces the full LAFSEnvelope with $schema and _meta. When operation is omitted, defaults to 'cli.output'.   T4672  T4663

```typescript
(error: CleoError, operation?: string | undefined) => string
```

### `formatOutput`

Format any result (success or error) as LAFS JSON.

```typescript
<T>(result: CleoError | T) => string
```

### `createGatewayMeta`

Create a fully typed GatewayMeta for MCP domain responses.

```typescript
(gateway: string, domain: string, operation: string, startTime: number) => GatewayMetaRecord
```

**Parameters:**

- `gateway` — Gateway name (e.g., 'query', 'mutate')
- `domain` — Domain name (e.g., 'tasks', 'session')
- `operation` — Operation name (e.g., 'show', 'list')
- `startTime` — Timestamp from Date.now() at start of request

**Returns:** GatewayMeta with all LAFS and CLEO-specific fields   T4700  T4663

### `getRegistryEntry`

Look up a registry entry by CLEO exit code.   T4671  T4663

```typescript
(exitCode: ExitCode) => CleoRegistryEntry | undefined
```

### `getRegistryEntryByLafsCode`

Look up a registry entry by LAFS string code.   T4671  T4663

```typescript
(lafsCode: string) => CleoRegistryEntry | undefined
```

### `getCleoErrorRegistry`

Get the full CLEO error registry for conformance testing.   T4671  T4663

```typescript
() => CleoRegistryEntry[]
```

### `isCleoRegisteredCode`

Check if a LAFS code is registered in the CLEO error registry.   T4671  T4663

```typescript
(lafsCode: string) => boolean
```

### `createTestDb`

Create a temporary directory with an initialized tasks.db.  Usage:

```typescript
() => Promise<TestDbEnv>
```

### `makeTaskFile`

Build a TaskFile structure from a list of task partials. Useful for seeding test data via accessor.upsertSingleTask().

```typescript
(tasks: (Partial<Task> & { id: string; })[]) => TaskFile
```

### `seedTasks`

Seed tasks into the test database via the accessor.  Uses a two-pass approach to avoid foreign key violations: 1. First pass: upsert all tasks without dependencies so FK targets exist 2. Second pass: upsert tasks again with dependencies (all FK targets now exist) 3. Initialize metadata for the test environment

```typescript
(accessor: DataAccessor, tasks: (Partial<Task> & { id: string; })[]) => Promise<void>
```

### `getChildren`

Get direct children of a task.

```typescript
(taskId: string, tasks: Task[]) => Task[]
```

### `getChildIds`

Get direct child IDs.

```typescript
(taskId: string, tasks: Task[]) => string[]
```

### `getDescendants`

Get all descendants of a task (recursive).

```typescript
(taskId: string, tasks: Task[]) => Task[]
```

### `getDescendantIds`

Get all descendant IDs (flat list).

```typescript
(taskId: string, tasks: Task[]) => string[]
```

### `getParentChain`

Get the parent chain (ancestors) from a task up to the root. Returns ordered from immediate parent to root.

```typescript
(taskId: string, tasks: Task[]) => Task[]
```

### `getParentChainIds`

Get the parent chain as IDs.

```typescript
(taskId: string, tasks: Task[]) => string[]
```

### `getDepth`

Calculate depth of a task in the hierarchy (0-based). Root tasks have depth 0, their children depth 1, etc.

```typescript
(taskId: string, tasks: Task[]) => number
```

### `getRootAncestor`

Get the root ancestor of a task.

```typescript
(taskId: string, tasks: Task[]) => Task | null
```

### `isAncestorOf`

Check if a task is an ancestor of another.

```typescript
(ancestorId: string, descendantId: string, tasks: Task[]) => boolean
```

### `isDescendantOf`

Check if a task is a descendant of another.

```typescript
(descendantId: string, ancestorId: string, tasks: Task[]) => boolean
```

### `getSiblings`

Get sibling tasks (same parent).

```typescript
(taskId: string, tasks: Task[]) => Task[]
```

### `validateHierarchy`

```typescript
(parentId: string | null, tasks: Task[], policy?: { maxDepth?: number | undefined; maxSiblings?: number | undefined; } | undefined) => HierarchyValidation
```

### `wouldCreateCircle`

Detect circular reference if parentId were set.

```typescript
(taskId: string, newParentId: string, tasks: Task[]) => boolean
```

### `buildTree`

```typescript
(tasks: Task[]) => TaskTreeNode[]
```

### `flattenTree`

Flatten a tree back to a list (depth-first).

```typescript
(nodes: TaskTreeNode[]) => Task[]
```

### `resolveHierarchyPolicy`

Resolve a full HierarchyPolicy from config, starting with a profile preset and overriding with any explicitly set config.hierarchy fields.

```typescript
(config: CleoConfig) => HierarchyPolicy
```

### `assertParentExists`

Assert that a parent task exists in the task list. Returns an error result if not found, null if OK.

```typescript
(parentId: string, tasks: Task[]) => HierarchyValidationResult | null
```

### `assertNoCycle`

Assert that re-parenting would not create a cycle. Returns an error result if a cycle is detected, null if OK.

```typescript
(taskId: string, newParentId: string, tasks: Task[]) => HierarchyValidationResult | null
```

### `countActiveChildren`

Count active (non-done, non-cancelled, non-archived) children of a parent.

```typescript
(parentId: string, tasks: Task[]) => number
```

### `validateHierarchyPlacement`

Validate whether a new task can be placed under the given parent according to the resolved hierarchy policy.

```typescript
(parentId: string | null, tasks: Task[], policy: HierarchyPolicy) => HierarchyValidationResult
```

### `enforceBudget`

Apply budget enforcement to an MCP response envelope.  Converts the DomainResponse into an LAFSEnvelope shape for budget checking, then applies truncation if the response exceeds the budget.

```typescript
(response: Record<string, unknown>, budget?: number | undefined) => { response: Record<string, unknown>; enforcement: BudgetEnforcementResult; }
```

**Parameters:**

- `response` — The MCP domain response object
- `budget` — Maximum allowed tokens (defaults to DEFAULT_BUDGET)

**Returns:** The response, potentially truncated, with budget metadata   T4701  T4663

### `isWithinBudget`

Quick check whether a response exceeds a token budget without modifying it.   T4701  T4663

```typescript
(response: Record<string, unknown>, budget?: number | undefined) => boolean
```

### `loadConfig`

Load and merge configuration from all sources. Priority: defaults  global config  project config  environment vars

```typescript
(cwd?: string | undefined) => Promise<CleoConfig>
```

### `getConfigValue`

Get a single config value with source tracking. Returns the value and which source it came from.

```typescript
<T>(path: string, cwd?: string | undefined) => Promise<ResolvedValue<T>>
```

### `getRawConfigValue`

Get a raw config value from the project config file only (no cascade). Returns undefined if the key is not found. Used by the engine layer for simple key lookups without source tracking.  T4789

```typescript
(key: string, cwd?: string | undefined) => Promise<unknown>
```

### `getRawConfig`

Get the full raw project config (no cascade). Returns null if no config file exists.  T4789

```typescript
(cwd?: string | undefined) => Promise<Record<string, unknown> | null>
```

### `parseConfigValue`

Parse a string value into its appropriate JS type. Handles booleans, null, integers, floats, and JSON.  T4789

```typescript
(value: unknown) => unknown
```

### `setConfigValue`

Set a config value in the project or global config file (dot-notation supported). Creates intermediate objects as needed. Parses string values into appropriate types (boolean, number, null, JSON).  T4789  T4795

```typescript
(key: string, value: unknown, cwd?: string | undefined, opts?: { global?: boolean | undefined; } | undefined) => Promise<{ key: string; value: unknown; scope: "global" | "project"; }>
```

### `validateTitle`

Validate a task title.  T4460

```typescript
(title: string) => void
```

### `validateStatus`

Validate task status.  T4460

```typescript
(status: string) => asserts status is "cancelled" | "pending" | "active" | "blocked" | "done" | "archived"
```

### `normalizePriority`

Normalize priority to canonical string format. Accepts both string names ("critical","high","medium","low") and numeric (1-9). Returns the canonical string format per todo.schema.json.  T4572

```typescript
(priority: string | number) => TaskPriority
```

### `validatePriority`

Validate task priority.  T4460  T4572

```typescript
(priority: string) => asserts priority is TaskPriority
```

### `validateTaskType`

Validate task type.  T4460

```typescript
(type: string) => asserts type is TaskType
```

### `validateSize`

Validate task size.  T4460

```typescript
(size: string) => asserts size is TaskSize
```

### `validateLabels`

Validate label format.  T4460

```typescript
(labels: string[]) => void
```

### `validatePhaseFormat`

Validate phase slug format.  T4460

```typescript
(phase: string) => void
```

### `validateDepends`

Validate dependency IDs exist.  T4460

```typescript
(depends: string[], tasks: Task[]) => void
```

### `validateParent`

Validate parent hierarchy constraints.  T4460

```typescript
(parentId: string, tasks: Task[], maxDepth?: number, maxSiblings?: number) => void
```

### `getTaskDepth`

Get the depth of a task in the hierarchy.  T4460

```typescript
(taskId: string, tasks: Task[]) => number
```

### `inferTaskType`

Infer task type from parent context.  T4460

```typescript
(parentId: string | null | undefined, tasks: Task[]) => TaskType
```

### `getNextPosition`

Get the next position for a task within a parent scope.  T4460

```typescript
(parentId: string | null | undefined, tasks: Task[]) => number
```

### `logOperation`

Log an operation to the audit log.  T4460

```typescript
(operation: string, taskId: string, details: Record<string, unknown>, accessor?: DataAccessor | undefined) => Promise<void>
```

### `findRecentDuplicate`

Check for recent duplicate task.  T4460

```typescript
(title: string, phase: string | undefined, tasks: Task[], windowSeconds?: number) => Task | null
```

### `addTask`

Add a new task to the todo file.  T4460

```typescript
(options: AddTaskOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<AddTaskResult>
```

### `listPhases`

List all phases with status summaries.  T4464

```typescript
(_cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<ListPhasesResult>
```

### `showPhase`

Show the current phase details.  T4464

```typescript
(slug?: string | undefined, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<ShowPhaseResult>
```

### `setPhase`

Set the current project phase.  T4464

```typescript
(options: SetPhaseOptions, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<SetPhaseResult>
```

### `startPhase`

Start a phase (pending - active).  T4464

```typescript
(slug: string, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ phase: string; startedAt: string; }>
```

### `completePhase`

Complete a phase (active - completed).  T4464

```typescript
(slug: string, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ phase: string; completedAt: string; }>
```

### `advancePhase`

Advance to the next phase.  T4464

```typescript
(force?: boolean, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<AdvancePhaseResult>
```

### `renamePhase`

Rename a phase and update all task references.  T4464

```typescript
(oldName: string, newName: string, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<RenamePhaseResult>
```

### `deletePhase`

Delete a phase with optional task reassignment.  T4464

```typescript
(slug: string, options?: { reassignTo?: string | undefined; force?: boolean | undefined; }, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<DeletePhaseResult>
```

### `registerAddCommand`

Register the add command.  T4460

```typescript
(program: ShimCommand) => void
```

### `registerAdrCommand`

```typescript
(program: ShimCommand) => void
```

### `registerAnalyzeCommand`

Register the analyze command.  T4538

```typescript
(program: ShimCommand) => void
```

### `registerArchiveCommand`

Register the archive command.  T4461

```typescript
(program: ShimCommand) => void
```

### `registerArchiveStatsCommand`

Register the archive-stats command. Routes through dispatch layer to admin.archive.stats.  T4555

```typescript
(program: ShimCommand) => void
```

### `registerBackupCommand`

```typescript
(program: ShimCommand) => void
```

### `registerBlockersCommand`

```typescript
(program: ShimCommand) => void
```

### `registerBriefingCommand`

Register the briefing command.  T4916

```typescript
(program: ShimCommand) => void
```

### `registerBugCommand`

Register the bug command.  T4913

```typescript
(program: ShimCommand) => void
```

### `registerCheckpointCommand`

Register the checkpoint command. Delegates to src/store/git-checkpoint.ts for isolated .cleo/.git operations.  T4551  T4872

```typescript
(program: ShimCommand) => void
```

### `registerCommandsCommand`

Register the commands command.  T4551, T5671

```typescript
(program: ShimCommand) => void
```

### `registerCompleteCommand`

Register the complete command.  T4461

```typescript
(program: ShimCommand) => void
```

### `registerComplianceCommand`

```typescript
(program: ShimCommand) => void
```

### `registerConfigCommand`

```typescript
(program: ShimCommand) => void
```

### `registerConsensusCommand`

Register the consensus command group.  T4537

```typescript
(program: ShimCommand) => void
```

### `registerContextCommand`

```typescript
(program: ShimCommand) => void
```

### `registerContributionCommand`

Register the contribution command group.  T4537

```typescript
(program: ShimCommand) => void
```

### `registerCurrentCommand`

Register the current command.  T4756  T4666

```typescript
(program: ShimCommand) => void
```

### `registerDashCommand`

Register the dash command.  T4535

```typescript
(program: ShimCommand) => void
```

### `registerDecompositionCommand`

Register the decomposition command group.  T4537

```typescript
(program: ShimCommand) => void
```

### `registerDeleteCommand`

Register the delete command.  T4461

```typescript
(program: ShimCommand) => void
```

### `registerDepsCommand`

```typescript
(program: ShimCommand) => void
```

### `registerTreeCommand`

```typescript
(program: ShimCommand) => void
```

### `registerDetectDriftCommand`

```typescript
(program: ShimCommand) => void
```

### `registerDocsCommand`

Register the docs command.  T4551

```typescript
(program: ShimCommand) => void
```

### `createSelfUpdateProgress`

Create a progress tracker for self-update operations.

```typescript
(enabled: boolean) => ProgressTracker
```

### `createDoctorProgress`

Create a progress tracker for doctor operations.

```typescript
(enabled: boolean) => ProgressTracker
```

### `createUpgradeProgress`

Create a progress tracker for upgrade operations.

```typescript
(enabled: boolean) => ProgressTracker
```

### `registerDoctorCommand`

```typescript
(program: ShimCommand) => void
```

### `registerEnvCommand`

Register the env command group.  T4581

```typescript
(program: ShimCommand) => void
```

### `registerExistsCommand`

```typescript
(program: ShimCommand) => void
```

### `registerExportCommand`

```typescript
(program: ShimCommand) => void
```

### `registerExportTasksCommand`

```typescript
(program: ShimCommand) => void
```

### `registerExtractCommand`

Register the extract command.  T4551

```typescript
(program: ShimCommand) => void
```

### `registerFindCommand`

Register the find command.  T4460  T4668

```typescript
(program: ShimCommand) => void
```

### `registerGenerateChangelogCommand`

Register the generate-changelog command.  T4555

```typescript
(program: ShimCommand) => void
```

### `registerGradeCommand`

```typescript
(program: ShimCommand) => void
```

### `registerHistoryCommand`

```typescript
(program: ShimCommand) => void
```

### `registerImplementationCommand`

Register the implementation command group.  T4537

```typescript
(program: ShimCommand) => void
```

### `registerImportCommand`

```typescript
(program: ShimCommand) => void
```

### `registerImportTasksCommand`

```typescript
(program: ShimCommand) => void
```

### `getGitignoreTemplate`

Load the gitignore template from the package's templates/ directory. Falls back to embedded content if file not found.  Kept as export for backward compatibility (used by upgrade.ts).  T4700

```typescript
() => string
```

### `registerInitCommand`

Register the init command.  T4681  T4663

```typescript
(program: ShimCommand) => void
```

### `registerInjectCommand`

```typescript
(program: ShimCommand) => void
```

### `registerInstallGlobalCommand`

```typescript
(program: ShimCommand) => void
```

### `registerIssueCommand`

Register the issue command with all subcommands.  T4555

```typescript
(program: ShimCommand) => void
```

### `registerLabelsCommand`

Register the labels command group.  T4538

```typescript
(program: ShimCommand) => void
```

### `registerLifecycleCommand`

```typescript
(program: ShimCommand) => void
```

### `registerListCommand`

Register the list command.  T4460  T4668

```typescript
(program: ShimCommand) => void
```

### `registerLogCommand`

Register the log command.  T4538

```typescript
(program: ShimCommand) => void
```

### `registerMapCommand`

Register the map command.

```typescript
(program: ShimCommand) => void
```

### `registerMcpInstallCommand`

Register the mcp-install command.  T4676

```typescript
(program: ShimCommand) => void
```

### `registerMemoryBrainCommand`

```typescript
(program: ShimCommand) => void
```

### `registerMigrateClaudeMemCommand`

Register the `migrate claude-mem` command under a migrate parent command.  Usage:   cleo migrate claude-mem [--dry-run] [--source ] [--project ]

```typescript
(program: ShimCommand) => void
```

### `registerNextCommand`

```typescript
(program: ShimCommand) => void
```

### `registerNexusCommand`

Register the nexus command group.  T4554

```typescript
(program: ShimCommand) => void
```

### `registerObserveCommand`

```typescript
(program: ShimCommand) => void
```

### `registerOpsCommand`

Register the ops command.

```typescript
(program: ShimCommand) => void
```

### `registerOrchestrateCommand`

```typescript
(program: ShimCommand) => void
```

### `registerOtelCommand`

Register the otel command group.  T4535

```typescript
(program: ShimCommand) => void
```

### `registerPhaseCommand`

Register the phase command group.  T4464, T5326

```typescript
(program: ShimCommand) => void
```

### `registerPhasesCommand`

Register the phases command group.  T4538, T5326

```typescript
(program: ShimCommand) => void
```

### `registerPlanCommand`

```typescript
(program: ShimCommand) => void
```

### `registerPromoteCommand`

```typescript
(program: ShimCommand) => void
```

### `registerRefreshMemoryCommand`

```typescript
(program: ShimCommand) => void
```

### `registerRelatesCommand`

Register the relates command group.  T4538

```typescript
(program: ShimCommand) => void
```

### `registerReleaseCommand`

```typescript
(program: ShimCommand) => void
```

### `registerRemoteCommand`

Register the remote command with add/remove/list/push/pull subcommands.  T4884

```typescript
(program: ShimCommand) => void
```

### `registerReorderCommand`

```typescript
(program: ShimCommand) => void
```

### `registerReparentCommand`

```typescript
(program: ShimCommand) => void
```

### `registerResearchCommand`

```typescript
(program: ShimCommand) => void
```

### `registerRestoreCommand`

```typescript
(program: ShimCommand) => void
```

### `registerRoadmapCommand`

```typescript
(program: ShimCommand) => void
```

### `registerSafestopCommand`

Register the safestop command.  T4551

```typescript
(program: ShimCommand) => void
```

### `registerSelfUpdateCommand`

```typescript
(program: ShimCommand) => void
```

### `registerSequenceCommand`

```typescript
(program: ShimCommand) => void
```

### `registerSessionCommand`

Register the session command group.  T4463

```typescript
(program: ShimCommand) => void
```

### `registerShowCommand`

Register the show command.  T4460  T4666

```typescript
(program: ShimCommand) => void
```

### `registerSkillsCommand`

Register the skills command with all subcommands.  T4555

```typescript
(program: ShimCommand) => void
```

### `registerSnapshotCommand`

```typescript
(program: ShimCommand) => void
```

### `registerSpecificationCommand`

Register the specification command group.  T4537

```typescript
(program: ShimCommand) => void
```

### `registerStartCommand`

Register the start command.  T4756  T4666

```typescript
(program: ShimCommand) => void
```

### `registerStatsCommand`

Register the stats command.  T4535

```typescript
(program: ShimCommand) => void
```

### `registerStickyCommand`

Register the sticky command group.  T5281

```typescript
(program: ShimCommand) => void
```

### `registerStopCommand`

Register the stop command.  T4756  T4666

```typescript
(program: ShimCommand) => void
```

### `registerSyncCommand`

Register the sync command.  T4551, T5326

```typescript
(program: ShimCommand) => void
```

### `registerTestingCommand`

Register the testing command.  T4551

```typescript
(program: ShimCommand) => void
```

### `registerTokenCommand`

```typescript
(program: ShimCommand) => void
```

### `registerUpdateCommand`

Register the update command.  T4461

```typescript
(program: ShimCommand) => void
```

### `registerUpgradeCommand`

```typescript
(program: ShimCommand) => void
```

### `registerValidateCommand`

```typescript
(program: ShimCommand) => void
```

### `registerVerifyCommand`

```typescript
(program: ShimCommand) => void
```

### `registerWebCommand`

Register the web command.  T4551

```typescript
(program: ShimCommand) => void
```

### `initCliLogger`

Initialize CLI logger with optional projectHash correlation context.

```typescript
(cwd: string, loggingConfig: LoggerConfig) => void
```

### `registerDynamicCommands`

Register dynamically-generated commands onto the Commander program.  Stub implementation: no commands registered until T4897 populates OperationDef.params arrays for all operations.

```typescript
(_program: ShimCommand) => void
```

### `resolveFormat`

Resolve output format from Commander.js option values.  Reads --json, --human, and --quiet flags and delegates to the canonical LAFS resolveOutputFormat(). Project/user defaults can be passed via the optional `defaults` parameter.

```typescript
(opts: Record<string, unknown>, defaults?: { projectDefault?: "json" | "human" | undefined; userDefault?: "json" | "human" | undefined; } | undefined) => FlagResolution
```

**Parameters:**

- `opts` — Commander.js parsed options object
- `defaults` — Optional project/user defaults

**Returns:** Resolved format with source provenance   T4703  T4663

### `renderErrorMarkdown`

Render a CleoError as structured markdown for CLI display.

```typescript
(error: CleoError) => string
```

### `getOperationSchema`

Look up an operation in the OPERATIONS registry and return a JSON Schema object suitable for use as `input_schema.properties.params` or as a stand-alone per-operation schema.

```typescript
(domain: string, operation: string, gateway: Gateway) => JSONSchemaObject
```

**Parameters:**

- `domain` — Canonical domain name (e.g. 'tasks', 'session')
- `operation` — Operation name (e.g. 'show', 'add')
- `gateway` — Gateway ('query' or 'mutate')

**Returns:** JSONSchemaObject derived from ParamDef[], or permissive fallback

### `getAllOperationSchemas`

Return schemas for ALL operations of a given gateway.  Useful for documentation generation and tool introspection endpoints.

```typescript
(gateway: Gateway) => Record<string, JSONSchemaObject>
```

**Returns:** Record keyed by "." → JSONSchemaObject

### `validateMutateParams`

Validate mutate request parameters

```typescript
(request: MutateRequest) => { valid: boolean; error?: DomainResponse | undefined; }
```

### `registerMutateTool`

Register mutate tool with MCP server  Returns tool definition for ListToolsRequestSchema handler

```typescript
() => { name: string; description: string; inputSchema: { type: string; required: string[]; properties: { domain: { type: string; enum: string[]; description: string; }; operation: { type: string; description: string; }; params: { ...; }; }; }; }
```

### `handleMutateRequest`

Handle mutate request  Validates parameters, logs to audit trail, routes to domain handler, and handles idempotency

```typescript
(request: MutateRequest) => Promise<DomainResponse>
```

**Parameters:**

- `request` — Mutate request with domain, operation, and params

**Returns:** Promise resolving to mutate response

### `isIdempotentOperation`

Check if operation is idempotent

```typescript
(domain: string, operation: string) => boolean
```

### `requiresSession`

Check if operation requires session binding

```typescript
(domain: string, operation: string) => boolean
```

### `getMutateOperationCount`

Get mutate operation count for specific domain or all domains

```typescript
(domain?: string | undefined) => number
```

### `isMutateOperation`

Check if operation is write (mutate)

```typescript
(domain: string, operation: string) => boolean
```

### `getMutateDomains`

Get all mutate domains

```typescript
() => string[]
```

### `getMutateOperations`

Get operations for specific mutate domain

```typescript
(domain: string) => string[]
```

### `validateQueryParams`

Validate query request parameters

```typescript
(request: QueryRequest) => { valid: boolean; error?: DomainResponse | undefined; }
```

### `registerQueryTool`

Register query tool with MCP server  Returns tool definition for ListToolsRequestSchema handler

```typescript
() => { name: string; description: string; inputSchema: { type: string; required: string[]; properties: { domain: { type: string; enum: string[]; description: string; }; operation: { type: string; description: string; }; params: { ...; }; }; }; }
```

### `handleQueryRequest`

Handle query request  Validates parameters and routes to domain handler via DomainRouter

```typescript
(request: QueryRequest) => Promise<DomainResponse>
```

**Parameters:**

- `request` — Query request with domain, operation, and params

**Returns:** Promise resolving to query response

### `getQueryOperationCount`

Get query operation count for specific domain or all domains

```typescript
(domain?: string | undefined) => number
```

### `isQueryOperation`

Check if operation is read-only (query)

```typescript
(domain: string, operation: string) => boolean
```

### `getQueryDomains`

Get all query domains

```typescript
() => string[]
```

### `getQueryOperations`

Get operations for specific query domain

```typescript
(domain: string) => string[]
```

### `estimateTokens`

Estimate the number of tokens in a text string. Uses a conservative character-based estimate (~4 chars per token).

```typescript
(text: string) => number
```

### `truncateToTokenBudget`

Truncate text to fit within a token budget.

```typescript
(text: string, budget?: number | undefined) => string
```

**Parameters:**

- `text` — Text content to potentially truncate
- `budget` — Maximum token budget

**Returns:** Truncated text with indicator if truncation occurred

### `listMemoryResources`

List all available CLEO memory resources.

```typescript
() => McpResource[]
```

### `registerMemoryResources`

Register MCP resource handlers on the server.

```typescript
(server: Server<{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string | number | undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; } | undefined; } | undefined; } | undefined; }, { ...; }, { ...; }>) => void
```

**Parameters:**

- `server` — MCP Server instance

### `readMemoryResource`

Read a CLEO memory resource by URI.

```typescript
(uri: string, tokenBudget?: number | undefined) => Promise<McpResourceContent | null>
```

**Parameters:**

- `uri` — Resource URI (e.g. "cleo://memory/recent")
- `tokenBudget` — Optional token budget for truncation

**Returns:** Resource content or null if URI is unknown

### `createTestEnvironment`

Create an isolated test CLEO environment.  This initializes a fresh CLEO project in a temporary directory, disables session enforcement, and pre-populates test data.

```typescript
() => Promise<TestEnvironment>
```

### `destroyTestEnvironment`

Destroy the test environment and clean up all temporary files.

```typescript
(env: TestEnvironment) => Promise<void>
```

### `readAuditEntries`

Query audit log entries from the SQLite audit_log table in the test environment. Replaces legacy todo-log.jsonl readers (T5338, ADR-024).

```typescript
(projectRoot: string, filter?: { action?: string | undefined; taskId?: string | undefined; sessionId?: string | undefined; } | undefined) => Promise<any[]>
```

### `unwrapPayload`

Extract the actual payload from an executor result's data field.  The LAFS envelope format uses `result` instead of `data` for the payload. When the executor encounters `{success:true, result:{...}}`, it may place the full envelope into `ExecutorResult.data` because it doesn't recognize `result` as the payload wrapper. This helper unwraps that case.

```typescript
<T = unknown>(data: any) => T
```

### `setupIntegrationTest`

Setup integration test context with isolated CLEO environment

```typescript
() => Promise<IntegrationTestContext>
```

### `cleanupIntegrationTest`

Cleanup integration test resources

```typescript
(context: IntegrationTestContext | null | undefined) => Promise<void>
```

### `createTestTask`

Create a test task and track for cleanup

```typescript
(context: IntegrationTestContext, title: string, description: string, options?: { parent?: string | undefined; status?: string | undefined; priority?: string | undefined; labels?: string[] | undefined; } | undefined) => Promise<...>
```

### `createTestEpic`

Create a test epic (task without parent)

```typescript
(context: IntegrationTestContext, title: string, description: string) => Promise<string>
```

### `startTestSession`

Start a test session

```typescript
(context: IntegrationTestContext, epicId: string) => Promise<void>
```

### `getCleoVersion`

Get current CLEO version

```typescript
(executor: WrappedExecutor) => Promise<string>
```

### `taskExists`

Check if a task exists

```typescript
(executor: WrappedExecutor, taskId: string, cwd?: string | undefined) => Promise<boolean>
```

### `waitForCondition`

Wait for a condition to be true (polling helper)

```typescript
(condition: () => Promise<boolean>, options?: { timeout?: number | undefined; interval?: number | undefined; errorMessage?: string | undefined; } | undefined) => Promise<void>
```

### `getAuditLogEntries`

Capture audit log entries from the isolated test environment. Reads from SQLite audit_log table (T5338, ADR-024).

```typescript
(projectRootOrTestDataDir: string, filter?: { domain?: string | undefined; operation?: string | undefined; sessionId?: string | undefined; action?: string | undefined; } | undefined) => Promise<...>
```

### `createManifestEntry`

Create a manifest entry fixture

```typescript
(taskId: string, overrides?: any) => any
```

### `verifyResponseFormat`

Verify response format matches specification.  Note: The response here is an ExecutorResult, not the raw MCP gateway envelope. The executor parses CLI output and populates its own fields. Gateway-level _meta is only present in the raw stdout, not the executor result.

```typescript
(response: any, _expectedGateway: "query" | "mutate", _expectedDomain: string, _expectedOperation: string) => void
```

### `createMockExecutor`

Creates a mock CLIExecutor for testing

```typescript
() => Mocked<CLIExecutor>
```

### `createSuccessResult`

Creates a successful executor result

```typescript
<T = any>(data: T, overrides?: Partial<ExecutorResult<T>> | undefined) => ExecutorResult<T>
```

### `createErrorResult`

Creates an error executor result

```typescript
(code: string, message: string, exitCode?: number, overrides?: Partial<ExecutorResult<never>> | undefined) => ExecutorResult<never>
```

### `getResponseData`

Extract data payload from an ExecutorResult, handling LAFS envelope.  When the executor can't unwrap the LAFS `result` field, ExecutorResult.data may contain the full LAFS envelope. Detect and unwrap that case.

```typescript
(result: any) => any
```

### `setupE2ETest`

Setup E2E test environment  Creates a fresh integration test context with: - CLI executor configured - Test session initialized - Cleanup tracking enabled

```typescript
() => Promise<IntegrationTestContext>
```

### `cleanupE2ETest`

Cleanup E2E test environment  Archives all created tasks, ends session, removes test data

```typescript
() => Promise<void>
```

### `getE2EContext`

Get current E2E test context

```typescript
() => IntegrationTestContext
```

### `extractTaskId`

Extract task ID from operation result

```typescript
(result: any) => string
```

### `extractSessionId`

Extract session ID from operation result

```typescript
(result: any) => string
```

### `verifyResponseFormat`

Verify response format matches specification  E2E tests run through the CLI executor which returns ExecutorResult, not the full MCP gateway response. The gateway/domain/operation params are accepted for API compatibility but not validated against the executor result (which lacks MCP envelope metadata).

```typescript
(response: any, _expectedGateway: "query" | "mutate", _expectedDomain: string, _expectedOperation: string) => void
```

### `waitFor`

Wait for condition to be true with timeout

```typescript
(condition: () => Promise<boolean>, options?: { timeout?: number | undefined; interval?: number | undefined; errorMessage?: string | undefined; } | undefined) => Promise<void>
```

### `sleep`

Sleep helper for timing-dependent tests

```typescript
(ms: number) => Promise<void>
```

### `sanitizeTaskId`

Sanitize and validate a task ID  Validates format: ^T[0-9]+$ Rejects empty, malformed, or excessively large IDs

```typescript
(value: unknown) => string
```

**Parameters:**

- `id` — Raw task ID input

**Returns:** Sanitized task ID

### `sanitizePath`

Sanitize and validate a file path  Prevents path traversal attacks by ensuring the resolved path stays within the project root directory.

```typescript
(path: string, projectRoot: string) => string
```

**Parameters:**

- `path` — Raw path input
- `projectRoot` — Project root directory (absolute path)

**Returns:** Sanitized absolute path within project root

### `sanitizeContent`

Sanitize content string  Enforces size limits and strips control characters (except newline, tab, CR).

```typescript
(content: string, maxLength?: number) => string
```

**Parameters:**

- `content` — Raw content string
- `maxLength` — Maximum allowed length (default: 64KB)

**Returns:** Sanitized content string

### `validateEnum`

Validate that a value is in an allowed enum set

```typescript
(value: string, allowed: string[], fieldName: string) => string
```

**Parameters:**

- `value` — Value to validate
- `allowed` — Array of allowed values
- `fieldName` — Name of the field (for error messages)

**Returns:** The validated value

### `sanitizeParams`

Sanitize all params in a DomainRequest before routing  Applies appropriate sanitization based on known field names: - taskId, parent, epicId - sanitizeTaskId - path, file - sanitizePath (if projectRoot provided) - title, description, notes, content - sanitizeContent - status - validateEnum(TASK_STATUSES) - priority - validateEnum(VALID_PRIORITIES) - domain - validateEnum(VALID_DOMAINS)

```typescript
(params: Record<string, unknown> | undefined, projectRoot?: string | undefined, context?: { domain?: string | undefined; operation?: string | undefined; } | undefined) => Record<...> | undefined
```

**Parameters:**

- `params` — Raw request parameters
- `projectRoot` — Project root for path sanitization

**Returns:** Sanitized parameters

### `isValidStatus`

```typescript
(entityType: EntityType, value: string) => boolean
```

### `normalizeError`

Normalize any thrown value into a standardized error object.  Handles: - Error instances (preserves stack trace info) - Strings (wraps in Error) - Objects with message property - null/undefined (provides fallback)

```typescript
(error: unknown, fallbackMessage?: string) => Error
```

**Parameters:**

- `error` — The thrown value to normalize
- `fallbackMessage` — Message to use if error provides none

**Returns:** Normalized error with consistent shape

```typescript
try {
  await riskyOperation();
} catch (err) {
  const error = normalizeError(err, 'Operation failed');
  console.error(error.message);
}
```

### `getErrorMessage`

Extract a human-readable message from any error value.  Safe to use on unknown thrown values without type guards.

```typescript
(error: unknown, fallback?: string) => string
```

**Parameters:**

- `error` — The error value
- `fallback` — Fallback message if extraction fails

**Returns:** The error message string

```typescript
const message = getErrorMessage(err, 'Unknown error');
```

### `formatError`

Format error details for logging or display.  Includes stack trace for Error instances when includeStack is true.

```typescript
(error: unknown, context?: string | undefined, includeStack?: boolean) => string
```

**Parameters:**

- `error` — The error to format
- `context` — Optional context to prepend
- `includeStack` — Whether to include stack traces (default: false)

**Returns:** Formatted error string

```typescript
console.error(formatError(err, 'Database connection'));
// Output: [Database connection] Connection refused
```

### `isErrorType`

Check if an error represents a specific error type by code or name.  Useful for conditional error handling based on error types.

```typescript
(error: unknown, codeOrName: string) => boolean
```

**Parameters:**

- `error` — The error to check
- `codeOrName` — The error code or name to match

**Returns:** True if the error matches

```typescript
if (isErrorType(err, 'E_NOT_FOUND')) {
  // Handle not found specifically
}
```

### `createErrorResult`

Create a standardized error result object.  Common pattern for operations that return  success: boolean, error?: string

```typescript
(error: unknown) => { success: false; error: string; }
```

**Parameters:**

- `error` — The error value

**Returns:** Error result object

```typescript
return createErrorResult(err);
// Returns: { success: false, error: "Something went wrong" }
```

### `createSuccessResult`

Create a standardized success result object.

```typescript
() => { success: true; }
```

**Returns:** Success result object

```typescript
return createSuccessResult();
// Returns: { success: true }
```

### `isErrorResult`

Type guard for error results.

```typescript
(result: { success: boolean; error?: string | undefined; }) => result is { success: false; error: string; }
```

**Parameters:**

- `result` — The result to check

**Returns:** True if the result is an error result

```typescript
const result = await someOperation();
if (isErrorResult(result)) {
  console.error(result.error);
}
```

### `isErrorCode`

Check if an exit code represents an error (1-99).

```typescript
(code: ExitCode) => boolean
```

### `isSuccessCode`

Check if an exit code represents success (0 or 100+).

```typescript
(code: ExitCode) => boolean
```

### `isNoChangeCode`

Check if an exit code indicates no change (idempotent operation).

```typescript
(code: ExitCode) => boolean
```

### `isRecoverableCode`

Check if an exit code is recoverable (retry may succeed).

```typescript
(code: ExitCode) => boolean
```

### `getExitCodeName`

Human-readable name for an exit code.

```typescript
(code: ExitCode) => string
```

### `isLafsSuccess`

Type guard for success responses.

```typescript
<T>(envelope: LafsEnvelope<T>) => envelope is LafsSuccess<T>
```

### `isLafsError`

Type guard for error responses.

```typescript
<T>(envelope: LafsEnvelope<T>) => envelope is LafsError
```

### `isGatewayEnvelope`

Type guard for MCP gateway responses (has _meta).

```typescript
<T>(envelope: CleoResponse<T>) => envelope is GatewayEnvelope<T>
```

### `pruneAuditLog`

Prune old audit_log rows from tasks.db.  1. If auditRetentionDays is 0 or undefined, skip age-based pruning. 2. Compute cutoff timestamp from auditRetentionDays. 3. If archiveBeforePrune, select rows older than cutoff and write to    .cleo/backups/logs/audit-YYYY-MM-DD.jsonl.gz. 4. Delete rows older than cutoff from audit_log.  Idempotent — safe to call multiple times. Never throws — returns zero counts on any error.

```typescript
(cleoDir: string, config: LoggingConfig) => Promise<PruneResult>
```

**Parameters:**

- `cleoDir` — Absolute path to .cleo directory
- `config` — LoggingConfig with auditRetentionDays and archiveBeforePrune

### `queryAudit`

Query audit entries from SQLite audit_log table. Used by session-grade.ts for behavioral analysis.  Returns entries ordered chronologically (ASC) to preserve behavioral sequence for grading analysis.

```typescript
(options?: { sessionId?: string | undefined; domain?: string | undefined; operation?: string | undefined; taskId?: string | undefined; since?: string | undefined; limit?: number | undefined; } | undefined) => Promise<...>
```

### `generateProjectHash`

Canonical project identity hash. SHA-256 of absolute path, first 12 hex chars. Single source of truth — do not duplicate this function elsewhere.

```typescript
(projectPath: string) => string
```

### `validateAgainstSchema`

Validate data against a JSON Schema object. Throws CleoError on validation failure.

```typescript
(data: unknown, schema: Record<string, unknown>, schemaId?: string | undefined) => void
```

### `validateAgainstSchemaFile`

Load a JSON Schema file and validate data against it.

```typescript
(data: unknown, schemaPath: string) => Promise<void>
```

### `checkSchema`

Check if data is valid against a schema without throwing. Returns an array of error messages (empty if valid).

```typescript
(data: unknown, schema: Record<string, unknown>) => string[]
```

### `resolveSchemaPath`

Resolve the absolute path to a schema file at runtime.  Priority:   1. Global install: ~/.cleo/schemas/schemaName   2. Package bundled: /schemas/schemaName

```typescript
(schemaName: string) => string | null
```

**Parameters:**

- `schemaName` — Filename of the schema (e.g. "config.schema.json")

**Returns:** Absolute path to the schema file, or null if not found

### `getSchemaVersion`

Read the schema version from a resolved schema file.  Checks `schemaVersion` (top-level) and `_meta.schemaVersion` (canonical).

```typescript
(schemaName: string) => string | null
```

**Parameters:**

- `schemaName` — Filename of the schema (e.g. "config.schema.json")

**Returns:** The version string, or null if not found or unreadable

### `ensureGlobalSchemas`

Copy ALL bundled schemas from package schemas/ to ~/.cleo/schemas/.  - Creates the global schemas directory if it doesn't exist. - Skips files that are already up-to-date (same version). - Overwrites stale files (version mismatch).

```typescript
(_opts?: Record<string, unknown> | undefined) => SchemaInstallResult
```

**Parameters:**

- `opts` — Optional settings (currently unused, reserved for future options)

**Returns:** Summary of installed, updated, and total schemas

### `checkGlobalSchemas`

Verify that global schemas are installed and not stale.

```typescript
() => CheckResult
```

**Returns:** Check result with counts and lists of issues

### `checkSchemaStaleness`

Compare global schema versions against bundled package versions.

```typescript
() => StalenessReport
```

**Returns:** Report of stale, current, and missing schemas

### `listInstalledSchemas`

List all schemas installed in ~/.cleo/schemas/.

```typescript
() => InstalledSchema[]
```

**Returns:** Array of installed schema details

### `cleanProjectSchemas`

Backup and remove deprecated .cleo/schemas/ directory from a project.  Schemas should live in ~/.cleo/schemas/ (global) not in project directories. This function creates a backup before removal for safety.

```typescript
(projectRoot: string) => Promise<{ cleaned: boolean; }>
```

**Parameters:**

- `projectRoot` — Absolute path to the project root

**Returns:** Whether cleanup was performed

### `readSchemaVersionFromFile`

Read the top-level `schemaVersion` field from a schema file. Delegates to the centralized schema-management module. Returns null if the file cannot be read or has no such field.

```typescript
(schemaName: string) => string | null
```

### `checkSchemaIntegrity`

Check integrity of all active JSON files in a CLEO project.

```typescript
(cwd?: string | undefined) => Promise<SchemaIntegrityReport>
```

**Parameters:**

- `cwd` — Project root (defaults to process.cwd())

### `detectProjectType`

Detect project type from directory contents. Returns a schema-compliant ProjectContext object.

```typescript
(projectDir: string) => ProjectContext
```

### `getBrainAccessor`

Factory: get a BrainDataAccessor backed by the brain.db singleton.

```typescript
(cwd?: string | undefined) => Promise<BrainDataAccessor>
```

### `setEmbeddingProvider`

Register an embedding provider for the brain system. Validates that the provider's dimensions match the vec0 table.

```typescript
(provider: EmbeddingProvider) => void
```

### `getEmbeddingProvider`

Get the currently registered embedding provider, or null.

```typescript
() => EmbeddingProvider | null
```

### `clearEmbeddingProvider`

Clear the current embedding provider (useful for testing).

```typescript
() => void
```

### `embedText`

Embed text into a float vector using the registered provider. Returns null when no provider is set or not available (FTS5-only fallback).

```typescript
(text: string) => Promise<Float32Array<ArrayBufferLike> | null>
```

### `isEmbeddingAvailable`

Check whether embedding is currently available.

```typescript
() => boolean
```

### `searchSimilar`

Search for entries similar to a query string using vector similarity.  1. Embeds the query text via the registered embedding provider. 2. Runs KNN query against brain_embeddings vec0 table. 3. Joins with observation/decision/pattern/learning tables for full entries.  Returns empty array when embedding is unavailable (graceful fallback).

```typescript
(query: string, projectRoot: string, limit?: number | undefined) => Promise<SimilarityResult[]>
```

**Parameters:**

- `query` — Text to find similar entries for
- `projectRoot` — Project root directory
- `limit` — Maximum results to return (default 10)

**Returns:** Array of similar entries ranked by distance (ascending)

### `ensureFts5Tables`

Create FTS5 virtual tables and content-sync triggers if they don't exist.  Uses content= to sync from main tables, so inserts to main tables auto-populate FTS. UPDATE/DELETE require triggers.   T5130

```typescript
(nativeDb: DatabaseSync) => boolean
```

### `rebuildFts5Index`

Rebuild FTS5 indexes from the content tables. Useful after bulk inserts that bypass triggers.   T5130

```typescript
(nativeDb: DatabaseSync) => void
```

### `searchBrain`

Unified search across all BRAIN memory tables.  Uses FTS5 MATCH for full-text search with BM25 ranking when available, falls back to LIKE queries otherwise.   T5130

```typescript
(projectRoot: string, query: string, options?: BrainSearchOptions | undefined) => Promise<BrainSearchResult>
```

### `resetFts5Cache`

Reset the cached FTS5 availability flag. Used in tests to force re-detection.

```typescript
() => void
```

### `hybridSearch`

Hybrid search across FTS5, vector similarity, and graph neighbors.  1. Runs FTS5 search via existing searchBrain. 2. Runs vector similarity via searchSimilar (if available). 3. Runs graph neighbor expansion via getNeighbors (if query matches a node). 4. Normalizes scores to 0-1 using min-max normalization. 5. Combines with configurable weights. 6. Deduplicates by ID, keeping highest combined score. 7. Returns top-N sorted by score descending.  Graceful fallback: if vec unavailable, redistributes weight to FTS5.

```typescript
(query: string, projectRoot: string, options?: HybridSearchOptions | undefined) => Promise<HybridResult[]>
```

**Parameters:**

- `query` — Search query text
- `projectRoot` — Project root directory
- `options` — Weight and limit configuration

**Returns:** Array of hybrid results ranked by combined score

### `getInjectionTemplateContent`

Get the CLEO-INJECTION.md template content from the package templates/ directory. Returns null if the template file is not found.

```typescript
() => string | null
```

### `ensureInjection`

Full injection refresh: strip legacy blocks, inject CAAMP content, install global template, create hub.  Replaces initInjection from init.ts with a ScaffoldResult return type.  Target architecture:   CLAUDE.md/GEMINI.md - AGENTS.md (via injectAll)   AGENTS.md - ~/.cleo/templates/CLEO-INJECTION.md + .cleo/project-context.json   T4682

```typescript
(projectRoot: string) => Promise<ScaffoldResult>
```

### `buildContributorInjectionBlock`

Build a smart, contextual contributor block for AGENTS.md injection. Returns null if this is not a contributor project.  The block is INFORMATIONAL, not prescriptive. It tells agents:   - This is the CLEO source repo (contributor project)   - cleo-dev is available (or not, with reason)   - Prefer cleo-dev for unreleased features, but fall back to cleo if     the dev build is broken or unavailable  This avoids the trap where a hardcoded "ALWAYS use cleo-dev" instruction sends agents into a loop when the dev build has compile errors.

```typescript
(projectRoot: string) => string | null
```

### `checkInjection`

Verify injection health: AGENTS.md exists, has CAAMP markers, markers are balanced, and  references resolve.  Combines logic from doctor/checks.ts checkAgentsMdHub, checkCaampMarkerIntegrity, and checkAtReferenceTargetExists.

```typescript
(projectRoot: string) => InjectionCheckResult
```

### `fileExists`

Check if a file exists and is readable.

```typescript
(path: string) => Promise<boolean>
```

### `stripCLEOBlocks`

Strip legacy !-- CLEO:START --...!-- CLEO:END -- blocks from a file. Called before CAAMP injection to prevent competing blocks.

```typescript
(filePath: string) => Promise<void>
```

### `removeCleoFromRootGitignore`

Remove .cleo/ or .cleo entries from the project root .gitignore.

```typescript
(projectRoot: string) => Promise<{ removed: boolean; }>
```

### `getPackageRoot`

Resolve the package root directory (where schemas/ and templates/ live). scaffold.ts lives in packages/core/src/, so 1 level up reaches the package root.

```typescript
() => string
```

### `getGitignoreContent`

Load the gitignore template from the package's templates/ directory. Falls back to embedded content if file not found.

```typescript
() => string
```

### `getCleoVersion`

Read CLEO version from package.json.

```typescript
() => string
```

### `createDefaultConfig`

```typescript
() => Record<string, unknown>
```

### `ensureCleoStructure`

Create .cleo/ directory and all required subdirectories. Idempotent: skips directories that already exist.

```typescript
(projectRoot: string) => Promise<ScaffoldResult>
```

### `ensureGitignore`

Create or repair .cleo/.gitignore from template. Idempotent: skips if file already exists with correct content.

```typescript
(projectRoot: string) => Promise<ScaffoldResult>
```

### `ensureConfig`

Create default config.json if missing. Idempotent: skips if file already exists.

```typescript
(projectRoot: string, opts?: { force?: boolean | undefined; } | undefined) => Promise<ScaffoldResult>
```

### `ensureProjectInfo`

Create or refresh project-info.json. Idempotent: skips if file already exists (unless force).

```typescript
(projectRoot: string, opts?: { force?: boolean | undefined; } | undefined) => Promise<ScaffoldResult>
```

### `ensureContributorMcp`

Ensure .mcp.json contains a cleo-dev server entry pointing to the local build. Only runs when isCleoContributorProject() is true (ADR-029).  Writes the server entry:   cleo-dev → node /dist/mcp/index.js  This ensures Claude Code loads the LOCAL dev build MCP server for this project, not the published cleocode/cleolatest. Idempotent: preserves other entries.

```typescript
(projectRoot: string) => Promise<ScaffoldResult>
```

### `ensureProjectContext`

Detect and write project-context.json. Idempotent: skips if file exists and is less than staleDays old (default: 30).

```typescript
(projectRoot: string, opts?: { force?: boolean | undefined; staleDays?: number | undefined; } | undefined) => Promise<ScaffoldResult>
```

### `ensureCleoGitRepo`

Initialize isolated .cleo/.git checkpoint repository. Idempotent: skips if .cleo/.git already exists.

```typescript
(projectRoot: string) => Promise<ScaffoldResult>
```

### `ensureSqliteDb`

Create SQLite database if missing. Idempotent: skips if tasks.db already exists.

```typescript
(projectRoot: string) => Promise<ScaffoldResult>
```

### `checkCleoStructure`

Verify all required .cleo/ subdirectories exist.

```typescript
(projectRoot: string) => CheckResult
```

### `checkGitignore`

Verify .cleo/.gitignore exists and matches template.

```typescript
(projectRoot: string) => CheckResult
```

### `checkConfig`

Verify config.json exists and is valid JSON.

```typescript
(projectRoot: string) => CheckResult
```

### `checkProjectInfo`

Verify project-info.json exists with required fields.

```typescript
(projectRoot: string) => CheckResult
```

### `checkProjectContext`

Verify project-context.json exists and is not stale (default: 30 days).

```typescript
(projectRoot: string, staleDays?: number) => CheckResult
```

### `checkCleoGitRepo`

Verify .cleo/.git checkpoint repository exists.

```typescript
(projectRoot: string) => CheckResult
```

### `checkSqliteDb`

Verify .cleo/tasks.db exists and is non-empty.

```typescript
(projectRoot: string) => CheckResult
```

### `ensureBrainDb`

Create brain.db if missing. Idempotent: skips if brain.db already exists.

```typescript
(projectRoot: string) => Promise<ScaffoldResult>
```

### `checkBrainDb`

Verify .cleo/brain.db exists and is non-empty.

```typescript
(projectRoot: string) => CheckResult
```

### `checkMemoryBridge`

Verify .cleo/memory-bridge.md exists. Warning level if missing (not failure) — it is auto-generated.

```typescript
(projectRoot: string) => CheckResult
```

### `ensureGlobalHome`

Ensure the global ~/.cleo/ home directory and its required subdirectories exist. Idempotent: skips directories that already exist.  This is the SSoT for global home scaffolding, replacing raw mkdirSync calls that were previously scattered across global-bootstrap.ts.

```typescript
() => Promise<ScaffoldResult>
```

### `ensureGlobalTemplates`

Ensure the global CLEO injection template is installed. Delegates to injection.ts for the template content, but owns the filesystem write to maintain SSoT for scaffolding.  Idempotent: skips if the template already exists with correct content.

```typescript
() => Promise<ScaffoldResult>
```

### `ensureGlobalScaffold`

Perform a complete global scaffold operation: ensure home, schemas, and templates are all present and current. This is the single entry point for global infrastructure scaffolding.  Used by:   - MCP startup (via startupHealthCheck in health.ts)   - init (for first-time global setup)   - upgrade (for global repair)

```typescript
() => Promise<{ home: ScaffoldResult; schemas: { installed: number; updated: number; total: number; }; templates: ScaffoldResult; }>
```

### `checkGlobalHome`

Check that the global ~/.cleo/ home and its required subdirectories exist. Read-only: no side effects.

```typescript
() => CheckResult
```

### `checkGlobalTemplates`

Check that the global injection template is present and current. Read-only: no side effects.

```typescript
() => CheckResult
```

### `checkLogDir`

Check that the project log directory exists. Read-only: no side effects.

```typescript
(projectRoot: string) => CheckResult
```

### `getMcpServerName`

Resolve MCP server name by channel.

```typescript
(env: McpEnvMode) => string
```

### `detectEnvMode`

Detect the current CLEO environment mode by reading ~/.cleo/VERSION.  The VERSION file format:   Line 1: version number   Lines 2+: key=value pairs (mode, source, etc.)   T4584

```typescript
() => McpEnvMode
```

### `generateMcpServerEntry`

Generate the MCP server entry for the cleo server based on env mode.  Returns a config object compatible with CAAMP's McpServerConfig: - dev-ts:  command: 'node', args: ['/dist/mcp/index.js']  - prod-npm stable:  command: 'npx', args: ['-y', 'cleocode/cleolatest', 'mcp']  - prod-npm beta:  command: 'npx', args: ['-y', 'cleocode/cleobeta', 'mcp']    T4584

```typescript
(env: McpEnvMode) => Record<string, unknown>
```

### `ensureGitHooks`

Install or update managed git hooks from templates/git-hooks/ into .git/hooks/.  Handles: - No .git directory (skips gracefully) - No source templates directory (skips gracefully) - Hooks already installed (skips unless force) - Sets executable permissions on installed hooks

```typescript
(projectRoot: string, opts?: EnsureGitHooksOptions | undefined) => Promise<ScaffoldResult>
```

### `checkGitHooks`

Verify managed hooks are installed and current.  Compares installed hooks in .git/hooks/ against source templates in the package's templates/git-hooks/ directory. Returns per-hook status including whether the hook is installed and whether its content matches the source.

```typescript
(projectRoot: string) => Promise<HookCheckResult[]>
```

### `toTaskFileExt`

Convert a TaskFile (from contracts) to the looser TaskFileExt shape. Accepts any object with at least the basic TaskFileExt structure. The runtime object is the same reference — this only changes the TS type.

```typescript
<T extends { _meta?: object; tasks?: unknown[]; focus?: object; lastUpdated?: string; }>(taskFile: T) => TaskFileExt
```

### `recordDecision`

Record a decision to the audit trail. Appends a JSON line to `.cleo/audit/decisions.jsonl`. Throws if required params are missing.

```typescript
(projectRoot: string, params: RecordDecisionParams) => Promise<DecisionRecord>
```

### `getDecisionLog`

Read the decision log, optionally filtered by sessionId and/or taskId.

```typescript
(projectRoot: string, params?: DecisionLogParams | undefined) => Promise<DecisionRecord[]>
```

### `computeHandoff`

Compute handoff data for a session. Gathers all session statistics and auto-computes structured state.

```typescript
(projectRoot: string, options: ComputeHandoffOptions) => Promise<HandoffData>
```

### `persistHandoff`

Persist handoff data to a session.

```typescript
(projectRoot: string, sessionId: string, handoff: HandoffData) => Promise<void>
```

### `getHandoff`

Get handoff data for a session.

```typescript
(projectRoot: string, sessionId: string) => Promise<HandoffData | null>
```

### `getLastHandoff`

Get handoff data for the most recent ended session. Filters by scope if provided.

```typescript
(projectRoot: string, scope?: { type: string; epicId?: string | undefined; rootTaskId?: string | undefined; } | undefined) => Promise<{ sessionId: string; handoff: HandoffData; } | null>
```

### `computeDebrief`

Compute rich debrief data for a session. Builds on computeHandoff() and adds decisions, git state, chain position.   T4959

```typescript
(projectRoot: string, options: ComputeDebriefOptions) => Promise<DebriefData>
```

### `generateMemoryBridgeContent`

Generate memory bridge content from brain.db. Returns the markdown string (does not write to disk).

```typescript
(projectRoot: string, config?: Partial<MemoryBridgeConfig> | undefined) => Promise<string>
```

### `writeMemoryBridge`

Write memory bridge content to .cleo/memory-bridge.md.

```typescript
(projectRoot: string, config?: Partial<MemoryBridgeConfig> | undefined) => Promise<{ path: string; written: boolean; }>
```

### `refreshMemoryBridge`

Best-effort refresh: call from session.end, tasks.complete, or memory.observe. Never throws.

```typescript
(projectRoot: string) => Promise<void>
```

### `detectLegacyAgentOutputs`

Detect legacy agent-output directories in a project.  Read-only check — never modifies the filesystem.

```typescript
(projectRoot: string, cleoDir: string) => LegacyDetectionResult
```

**Parameters:**

- `projectRoot` — Absolute path to project root
- `cleoDir` — Absolute path to .cleo/ directory

### `migrateAgentOutputs`

Run the full agent-outputs migration.  Copies files from all legacy locations into .cleo/agent-outputs/, merges MANIFEST.jsonl entries with path rewriting and deduplication, updates config.json, and removes legacy directories.  Safe to call when no legacy directories exist (returns early). Safe to call when canonical directory already exists (merges).

```typescript
(projectRoot: string, cleoDir: string) => AgentOutputsMigrationResult
```

**Parameters:**

- `projectRoot` — Absolute path to project root
- `cleoDir` — Absolute path to .cleo/ directory

### `migrateJsonToSqlite`

Migrate projects from legacy JSON registry to nexus.db.  For each project entry in projects-registry.json: - Reads target/.cleo/project-info.json for a stable UUID (projectId) - Falls back to randomUUID() if project-info.json is absent - Upserts into project_registry (on conflict by projectHash → update path/name/lastSeen)  On success, renames the JSON file to .migrated.

```typescript
() => Promise<number>
```

**Returns:** Number of projects migrated.

### `getNexusHome`

Get path to the NEXUS home directory (cache, etc.).

```typescript
() => string
```

### `getNexusCacheDir`

Get path to the NEXUS cache directory.

```typescript
() => string
```

### `getRegistryPath`

Get path to the legacy projects registry JSON file.

```typescript
() => string
```

### `readRegistry`

Read all projects from nexus.db and return as a NexusRegistryFile. Compatibility wrapper for consumers that expect the legacy JSON shape. Returns null if nexus.db has not been initialized yet.

```typescript
() => Promise<NexusRegistryFile | null>
```

### `readRegistryRequired`

Read the global registry, throwing if not initialized.

```typescript
() => Promise<NexusRegistryFile>
```

### `nexusInit`

Initialize the NEXUS directory structure and nexus.db. Idempotent -- safe to call multiple times. Migrates legacy JSON registry on first run if present.

```typescript
() => Promise<void>
```

### `nexusRegister`

Register a project in the global registry (nexus.db).

```typescript
(projectPath: string, name?: string | undefined, permissions?: NexusPermissionLevel) => Promise<string>
```

**Returns:** The project hash.

### `nexusUnregister`

Unregister a project from the global registry.

```typescript
(nameOrHash: string) => Promise<void>
```

### `nexusList`

List all registered projects.

```typescript
() => Promise<NexusProject[]>
```

### `nexusGetProject`

Get a project by name or hash. Returns null if not found.

```typescript
(nameOrHash: string) => Promise<NexusProject | null>
```

### `nexusProjectExists`

Check if a project exists in the registry.

```typescript
(nameOrHash: string) => Promise<boolean>
```

### `nexusSync`

Sync project metadata (task count, labels) for a registered project.

```typescript
(nameOrHash: string) => Promise<void>
```

### `nexusSyncAll`

Sync all registered projects.

```typescript
() => Promise<{ synced: number; failed: number; }>
```

**Returns:** Counts of synced and failed projects.

### `nexusSetPermission`

Update a project's permission level in the registry. Used by permissions.ts to avoid direct JSON file writes.

```typescript
(nameOrHash: string, permission: NexusPermissionLevel) => Promise<void>
```

### `nexusReconcile`

Reconcile the current project's identity with the global nexus registry.  4-scenario policy:   1. projectId in registry + path matches → update lastSeen, return status:'ok'   2. projectId in registry + path changed → update path+hash, return status:'path_updated'   3. projectId not in registry → auto-register, return status:'auto_registered'   4. projectHash matches but different projectId → throw CleoError (identity conflict)  Uses projectId as the stable identifier across project moves, since projectHash is derived from the absolute path and changes when moved.   T5368

```typescript
(projectRoot: string) => Promise<{ status: "ok" | "path_updated" | "auto_registered"; oldPath?: string | undefined; newPath?: string | undefined; }>
```

### `analyzeStack`

```typescript
(projectRoot: string, projectContext: ProjectContext) => StackAnalysis
```

### `analyzeArchitecture`

```typescript
(projectRoot: string, _projectContext: ProjectContext) => ArchAnalysis
```

### `analyzeStructure`

```typescript
(projectRoot: string) => StructureAnalysis
```

### `analyzeConventions`

```typescript
(projectRoot: string, projectContext: ProjectContext) => ConventionAnalysis
```

### `analyzeTesting`

```typescript
(projectRoot: string, projectContext: ProjectContext) => TestingAnalysis
```

### `analyzeIntegrations`

```typescript
(projectRoot: string, _projectContext: ProjectContext) => IntegrationAnalysis
```

### `analyzeConcerns`

```typescript
(projectRoot: string) => ConcernAnalysis
```

### `storePattern`

Store a new pattern. If a similar pattern already exists (same type + matching text), increments frequency.  T4768, T5241

```typescript
(projectRoot: string, params: StorePatternParams) => Promise<{ examples: any; id: string; updatedAt: string | null; type: "success" | "workflow" | "failure" | "blocker" | "optimization"; ... 8 more ...; extractedAt: string; }>
```

### `searchPatterns`

Search patterns by criteria.  T4768, T5241

```typescript
(projectRoot: string, params?: SearchPatternParams) => Promise<{ examples: any; id: string; updatedAt: string | null; type: "success" | "workflow" | "failure" | "blocker" | "optimization"; ... 8 more ...; extractedAt: string; }[]>
```

### `patternStats`

Get pattern statistics.  T4768, T5241

```typescript
(projectRoot: string) => Promise<{ total: number; byType: Record<string, number>; byImpact: Record<string, number>; highestFrequency: { pattern: string; frequency: number; } | null; }>
```

### `storeLearning`

Store a new learning.  T4769, T5241

```typescript
(projectRoot: string, params: StoreLearningParams) => Promise<{ applicableTypes: any; id: string; createdAt: string; updatedAt: string | null; source: string; confidence: number; insight: string; actionable: boolean; application: string | null; applicableTypesJson: string | null; }>
```

### `searchLearnings`

Search learnings by criteria. Results sorted by confidence (highest first).  T4769, T5241

```typescript
(projectRoot: string, params?: SearchLearningParams) => Promise<{ applicableTypes: any; id: string; createdAt: string; updatedAt: string | null; source: string; confidence: number; insight: string; actionable: boolean; application: string | null; applicableTypesJson: string | null; }[]>
```

### `learningStats`

Get learning statistics.  T4769, T5241

```typescript
(projectRoot: string) => Promise<{ total: number; actionable: number; averageConfidence: number; bySource: Record<string, number>; highConfidence: number; lowConfidence: number; }>
```

### `searchBrainCompact`

Token-efficient compact search across BRAIN tables. Returns index-level hits (~50 tokens per result).  Delegates to searchBrain() from brain-search.ts for FTS5/LIKE search, then projects results to a compact format with optional date filtering.

```typescript
(projectRoot: string, params: SearchBrainCompactParams) => Promise<SearchBrainCompactResult>
```

**Parameters:**

- `projectRoot` — Project root directory
- `params` — Search parameters

**Returns:** Compact search results with token estimate

### `timelineBrain`

Get chronological context around an anchor entry. Fetches the anchor's full data, then queries all 4 BRAIN tables via UNION ALL to find chronological neighbors.

```typescript
(projectRoot: string, params: TimelineBrainParams) => Promise<TimelineBrainResult>
```

**Parameters:**

- `projectRoot` — Project root directory
- `params` — Timeline parameters with anchor ID and depth

**Returns:** Anchor entry data with surrounding chronological entries

### `fetchBrainEntries`

Batch-fetch full details by IDs. Groups IDs by prefix to query the correct tables via BrainDataAccessor.

```typescript
(projectRoot: string, params: FetchBrainEntriesParams) => Promise<FetchBrainEntriesResult>
```

**Parameters:**

- `projectRoot` — Project root directory
- `params` — Fetch parameters with IDs

**Returns:** Full entry data for each found ID, plus not-found list

### `observeBrain`

Save an observation to the BRAIN observations table. Replaces the external claude-mem save_observation pattern.  Auto-classifies type from text if not provided. Generates a unique ID with O- prefix + base36 timestamp.

```typescript
(projectRoot: string, params: ObserveBrainParams) => Promise<ObserveBrainResult>
```

**Parameters:**

- `projectRoot` — Project root directory
- `params` — Observation data

**Returns:** Created observation ID, type, and timestamp

### `populateEmbeddings`

Backfill embeddings for existing observations that lack them.  Iterates through observations not yet in brain_embeddings and generates vectors using the registered embedding provider. Processes in batches to avoid memory pressure.

```typescript
(projectRoot: string, options?: { batchSize?: number | undefined; } | undefined) => Promise<PopulateEmbeddingsResult>
```

**Parameters:**

- `projectRoot` — Project root directory
- `options` — Optional batch size configuration

**Returns:** Count of processed and skipped observations

### `storeMapToBrain`

```typescript
(projectRoot: string, result: CodebaseMapResult) => Promise<{ patternsStored: number; learningsStored: number; observationsStored: number; }>
```

### `mapCodebase`

```typescript
(projectRoot: string, options?: MapCodebaseOptions | undefined) => Promise<CodebaseMapResult>
```

### `isValidAdapter`

Validate that a loaded module export implements the CLEOProviderAdapter interface. Checks for required methods and properties without relying on instanceof.

```typescript
(adapter: unknown) => adapter is CLEOProviderAdapter
```

### `loadAdapterFromManifest`

Dynamically load and instantiate an adapter from its manifest.  Uses the manifest's packagePath to resolve the adapter module, then looks for a `createAdapter()` factory or a default export class.

```typescript
(manifest: AdapterManifest) => Promise<CLEOProviderAdapter>
```

**Parameters:**

- `manifest` — The adapter manifest with a resolved packagePath

**Returns:** A CLEOProviderAdapter instance

### `discoverAdapterManifests`

Scan the packages/adapters/ directory for adapter packages. Each adapter must have a manifest.json at its root.

```typescript
(projectRoot: string) => AdapterManifest[]
```

### `detectProvider`

Detect whether a provider is active in the current environment by checking its detection patterns.

```typescript
(patterns: DetectionPattern[]) => boolean
```

### `initAgentDefinition`

Install cleo-subagent agent definition to ~/.agents/agents/.  T4685

```typescript
(created: string[], warnings: string[]) => Promise<void>
```

### `initMcpServer`

Install MCP server config to all detected providers via CAAMP.  T4706

```typescript
(projectRoot: string, created: string[], warnings: string[]) => Promise<void>
```

### `initCoreSkills`

Install CLEO core skills to the canonical skills directory via CAAMP.  T4707  T4689

```typescript
(created: string[], warnings: string[]) => Promise<void>
```

### `initNexusRegistration`

Register/reconcile project with NEXUS. Uses nexusReconcile for idempotent handshake — auto-registers if new, updates path if moved, confirms identity if unchanged.  T4684  T5368

```typescript
(projectRoot: string, created: string[], warnings: string[]) => Promise<void>
```

### `installGitHubTemplates`

Install GitHub issue and PR templates to .github/ if a git repo exists but .github/ISSUE_TEMPLATE/ is not yet present.  Idempotent: skips files that already exist. Never overwrites existing templates — the project owner's customisations take precedence.

```typescript
(projectRoot: string, created: string[], skipped: string[]) => Promise<void>
```

**Parameters:**

- `projectRoot` — Absolute path to the project root.
- `created` — Array to push "created: ..." log entries into.
- `skipped` — Array to push "skipped: ..." log entries into.

### `updateDocs`

Run update-docs only: refresh all injections without reinitializing. Re-injects CLEO-INJECTION.md into all detected agent instruction files.   T4686

```typescript
() => Promise<InitResult>
```

### `initProject`

Run full project initialization.  Creates the .cleo/ directory structure, installs schemas, templates, agent definitions, MCP server configs, skills, and registers with NEXUS.   T4681  T4682  T4684  T4685  T4686  T4687  T4689  T4706  T4707

```typescript
(opts?: InitOptions) => Promise<InitResult>
```

### `isAutoInitEnabled`

Check if auto-init is enabled via environment variable.  T4789

```typescript
() => boolean
```

### `ensureInitialized`

Check if a project is initialized and auto-init if configured. Returns  initialized: true  if ready, throws otherwise.  T4789

```typescript
(projectRoot?: string | undefined) => Promise<{ initialized: boolean; }>
```

### `getVersion`

Get the current CLEO/project version. Checks VERSION file, then package.json.  T4789

```typescript
(projectRoot?: string | undefined) => Promise<{ version: string; }>
```

### `bootstrapGlobalCleo`

Bootstrap the global CLEO directory structure and install templates.  Creates:   - ~/.cleo/templates/CLEO-INJECTION.md (from bundled template or injection content)   - ~/.agents/AGENTS.md with CAAMP injection block  This is idempotent — safe to call multiple times.

```typescript
(options?: BootstrapOptions | undefined) => Promise<BootstrapContext>
```

### `installMcpToProviders`

Install the CLEO MCP server config to all detected providers.

```typescript
(ctx: BootstrapContext) => Promise<void>
```

### `installSkillsGlobally`

Install CLEO core skills globally via CAAMP.

```typescript
(ctx: BootstrapContext) => Promise<void>
```

### `bootstrapCaamp`

```typescript
() => void
```

### `exportTasks`

Export tasks to a portable format. Returns the formatted content and metadata.

```typescript
(params: ExportParams) => Promise<ExportResult>
```

### `importTasks`

Import tasks from an export file.

```typescript
(params: ImportParams) => Promise<ImportResult>
```

### `validateSyntax`

Validate a query string matches expected syntax.

```typescript
(query: string) => boolean
```

### `parseQuery`

Parse a query string into its components.

```typescript
(query: string, currentProject?: string | undefined) => NexusParsedQuery
```

### `getCurrentProject`

Get the current project name from context. Reads .cleo/project-info.json or falls back to directory name.

```typescript
() => string
```

### `resolveProjectPath`

Resolve a project name to its filesystem path. Handles special cases: "." (current), "*" (wildcard marker).

```typescript
(projectName: string) => Promise<string>
```

### `resolveTask`

Resolve a query to task data. For wildcard queries, returns an array of matches from all projects. For named projects, returns a single task with project context.

```typescript
(query: string, currentProject?: string | undefined) => Promise<NexusResolvedTask | NexusResolvedTask[]>
```

### `getProjectFromQuery`

Extract the project name from a query without full resolution. Useful for permission checks before task lookup.

```typescript
(query: string, currentProject?: string | undefined) => string
```

### `extractKeywords`

Extract meaningful keywords from text (filters stop words and short tokens).

```typescript
(text: string) => string[]
```

### `discoverRelated`

Discover tasks related to a given task query across projects.  Returns a structured result or throws on unrecoverable errors. Validation errors (bad syntax, wildcard) are returned as  error  objects so callers can wrap them in an appropriate engine error response.

```typescript
(taskQuery: string, method?: string, limit?: number) => Promise<NexusDiscoverResult | { error: { code: string; message: string; }; }>
```

### `searchAcrossProjects`

Search for tasks across all registered projects.  Returns a structured result or throws on unrecoverable errors. Validation errors (bad pattern) are returned as  error  objects.

```typescript
(pattern: string, projectFilter?: string | undefined, limit?: number) => Promise<NexusSearchResult | { error: { code: string; message: string; }; }>
```

### `permissionLevel`

Convert a permission string to its numeric level. Returns 0 for invalid/unknown permissions.

```typescript
(permission: string) => number
```

### `getPermission`

Get the permission level for a registered project. Returns 'read' as default if the project has no explicit permission.

```typescript
(nameOrHash: string) => Promise<NexusPermissionLevel>
```

### `checkPermission`

Check if a project has sufficient permissions (non-throwing). Uses hierarchical comparison: execute = write = read.

```typescript
(nameOrHash: string, required: NexusPermissionLevel) => Promise<boolean>
```

**Returns:** true if the granted permission meets or exceeds the required level.

### `requirePermission`

Require a permission level or throw CleoError. Used as a guard at the start of cross-project operations.

```typescript
(nameOrHash: string, required: NexusPermissionLevel, operationName?: string) => Promise<void>
```

### `checkPermissionDetail`

Full permission check returning a structured result.

```typescript
(nameOrHash: string, required: NexusPermissionLevel) => Promise<PermissionCheckResult>
```

### `setPermission`

Set the permission level for a project. Validates the permission value and updates the registry.  T4574

```typescript
(nameOrHash: string, permission: NexusPermissionLevel) => Promise<void>
```

### `canRead`

Convenience: check read access.

```typescript
(nameOrHash: string) => Promise<boolean>
```

### `canWrite`

Convenience: check write access.

```typescript
(nameOrHash: string) => Promise<boolean>
```

### `canExecute`

Convenience: check execute access.

```typescript
(nameOrHash: string) => Promise<boolean>
```

### `matchesPattern`

Match a file path against a glob-like pattern. Supports: '*' (single segment wildcard), '**' (recursive wildcard), and trailing '/' for directory matching.  T4883

```typescript
(filePath: string, pattern: string) => boolean
```

### `getSharingStatus`

Get the sharing status: which .cleo/ files are tracked vs ignored.  T4883

```typescript
(cwd?: string | undefined) => Promise<SharingStatus>
```

### `syncGitignore`

Sync the project .gitignore to match the sharing config. Adds/updates a managed section between CLEO markers.  T4883

```typescript
(cwd?: string | undefined) => Promise<{ updated: boolean; entriesCount: number; }>
```

### `invalidateDepsCache`

Invalidate the cached TaskFile (call after writes).  T4659  T4654

```typescript
() => void
```

### `buildGraph`

Build an adjacency graph from task dependencies.  T4464

```typescript
(tasks: Task[]) => Map<string, DepNode>
```

### `getDepsOverview`

Get dependency overview for all tasks.  T4464

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<DepsOverviewResult>
```

### `getTaskDeps`

Get dependencies for a specific task.  T4464

```typescript
(taskId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<TaskDepsResult>
```

### `topologicalSort`

Topological sort of tasks respecting dependencies. Returns tasks in execution order. Throws on cycles.  T4464

```typescript
(tasks: Task[]) => Task[]
```

### `getExecutionWaves`

Group tasks into parallelizable execution waves.  T4464

```typescript
(epicId?: string | undefined, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<ExecutionWave[]>
```

### `getCriticalPath`

Find the critical path (longest dependency chain) from a task.  T4464

```typescript
(taskId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<CriticalPathResult>
```

### `getImpact`

Find all tasks affected by changes to a given task.  T4464

```typescript
(taskId: string, maxDepth?: number, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<string[]>
```

### `detectCycles`

Detect circular dependencies in the task graph.  T4464

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<CycleResult>
```

### `getTaskTree`

Build task hierarchy tree.  T4464

```typescript
(rootId?: string | undefined, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<TreeNode[]>
```

### `addRelation`

Manage task relationships (relates/blocks).  T4464

```typescript
(taskId: string, relatedId: string, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ taskId: string; relatedId: string; }>
```

### `buildDependencyGraph`

Build a dependency graph for a set of tasks.  Returns a Map from task ID to the set of task IDs it depends on.

```typescript
(tasks: Task[]) => Map<string, Set<string>>
```

### `detectCircularDependencies`

Detect circular dependencies using DFS traversal.

```typescript
(tasks: Task[], graph?: Map<string, Set<string>> | undefined) => CircularDependency[]
```

**Parameters:**

- `tasks` — The set of tasks to analyze
- `graph` — Pre-built dependency graph (optional; built from tasks if not provided)

**Returns:** Array of circular dependency cycles (each cycle is an array of task IDs)

### `findMissingDependencies`

Find missing dependencies — deps that reference tasks outside the epic that are not yet completed.

```typescript
(children: Task[], allTasks: Task[]) => MissingDependency[]
```

**Parameters:**

- `children` — Child tasks of the epic
- `allTasks` — All tasks in the project (to check if deps are completed elsewhere)

**Returns:** Array of missing dependency references

### `analyzeDependencies`

Perform full dependency analysis for an epic's children.  Combines dependency graph building, circular detection, and missing dep identification into a single analysis result.

```typescript
(children: Task[], allTasks: Task[]) => DependencyAnalysis
```

**Parameters:**

- `children` — Child tasks of the epic
- `allTasks` — All tasks in the project

**Returns:** Complete dependency analysis

### `countManifestEntries`

Count manifest entries from MANIFEST.jsonl.

```typescript
(projectRoot: string) => number
```

**Parameters:**

- `projectRoot` — The project root directory

**Returns:** Number of manifest entries

### `estimateContext`

Estimate context usage for orchestration.

```typescript
(taskCount: number, projectRoot: string, epicId?: string | undefined) => ContextEstimation
```

**Parameters:**

- `taskCount` — Number of tasks to estimate for
- `projectRoot` — The project root directory
- `epicId` — Optional epic ID for scoped estimation

**Returns:** Context estimation with recommendations

### `computeWaves`

Compute execution waves using topological sort.

```typescript
(tasks: Task[]) => Wave[]
```

### `getEnrichedWaves`

Get enriched wave data for an epic.

```typescript
(epicId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ epicId: string; waves: EnrichedWave[]; totalWaves: number; totalTasks: number; }>
```

### `countByStatus`

Count tasks by status.

```typescript
(tasks: Task[]) => StatusCounts
```

### `computeEpicStatus`

Compute epic-specific status.

```typescript
(epicId: string, epicTitle: string, children: Task[]) => EpicStatus
```

**Parameters:**

- `epicId` — The epic task ID
- `epicTitle` — The epic title
- `children` — Child tasks of the epic

**Returns:** Epic status with wave information

### `computeOverallStatus`

Compute overall orchestration status across all tasks.

```typescript
(tasks: Task[]) => OverallStatus
```

**Parameters:**

- `tasks` — All tasks in the project

**Returns:** Overall status with epic count

### `computeProgress`

Compute progress metrics for all tasks.

```typescript
(tasks: Task[]) => ProgressMetrics
```

**Parameters:**

- `tasks` — All tasks to measure

**Returns:** Progress metrics with completion percentage

### `computeStartupSummary`

Compute startup summary for an epic.

```typescript
(epicId: string, epicTitle: string, children: Task[], readyCount: number) => StartupSummary
```

**Parameters:**

- `epicId` — The epic task ID
- `epicTitle` — The epic title
- `children` — Child tasks of the epic
- `readyCount` — Number of ready tasks

**Returns:** Startup summary with wave information

### `startOrchestration`

Start an orchestrator session for an epic.  T4466

```typescript
(epicId: string, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<OrchestratorSession>
```

### `analyzeEpic`

Analyze an epic's dependency structure.  T4466

```typescript
(epicId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<AnalysisResult>
```

### `getReadyTasks`

Get parallel-safe ready tasks for an epic.  T4466

```typescript
(epicId: string, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<TaskReadiness[]>
```

### `getNextTask`

Get the next task to work on for an epic.  T4466

```typescript
(epicId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<TaskReadiness | null>
```

### `prepareSpawn`

Prepare a spawn context for a subagent.  T4466

```typescript
(taskId: string, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<SpawnContext>
```

### `validateSpawnOutput`

Validate a subagent's output.  T4466

```typescript
(_taskId: string, output: { file?: string | undefined; manifestEntry?: boolean | undefined; }) => Promise<{ valid: boolean; errors: string[]; }>
```

### `getOrchestratorContext`

Get orchestrator context summary.  T4466

```typescript
(epicId: string, _cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ epicId: string; epicTitle: string; totalTasks: number; completed: number; inProgress: number; blocked: number; pending: number; completionPercent: number; }>
```

### `autoDispatch`

Auto-dispatch: determine the protocol for a task based on metadata.  T4466

```typescript
(task: Task) => string
```

### `resolveTokens`

Resolve tokens in a prompt string.  T4466

```typescript
(prompt: string, context: Record<string, string>) => { resolved: string; unresolved: string[]; }
```

### `bridgeSessionToMemory`

Bridge session end data to brain.db as an observation.  Builds a summary text from the session metadata and saves it as a 'change' observation with source_type 'agent'.

```typescript
(projectRoot: string, sessionData: SessionBridgeData) => Promise<void>
```

**Parameters:**

- `projectRoot` — Project root directory for brain.db resolution
- `sessionData` — Session metadata to record

### `storeDecision`

Store a new decision or update an existing one if a duplicate is found. Duplicate detection: same decision text (case-insensitive).   T5155

```typescript
(projectRoot: string, params: StoreDecisionParams) => Promise<{ id: string; createdAt: string; updatedAt: string | null; type: "architecture" | "technical" | "process" | "strategic" | "tactical"; ... 7 more ...; contextPhase: string | null; }>
```

### `recallDecision`

Recall a specific decision by ID.   T5155

```typescript
(projectRoot: string, id: string) => Promise<{ id: string; createdAt: string; updatedAt: string | null; type: "architecture" | "technical" | "process" | "strategic" | "tactical"; confidence: "high" | ... 1 more ... | "low"; ... 6 more ...; contextPhase: string | null; } | null>
```

### `searchDecisions`

Search decisions by type, confidence, outcome, and/or free-text query. Query searches across decision + rationale fields using LIKE.   T5155

```typescript
(projectRoot: string, params?: SearchDecisionParams) => Promise<{ id: string; createdAt: string; updatedAt: string | null; type: "architecture" | "technical" | "process" | "strategic" | "tactical"; ... 7 more ...; contextPhase: string | null; }[]>
```

### `listDecisions`

List decisions with pagination.   T5155

```typescript
(projectRoot: string, params?: ListDecisionParams) => Promise<{ decisions: { id: string; createdAt: string; updatedAt: string | null; type: "architecture" | "technical" | "process" | "strategic" | "tactical"; ... 7 more ...; contextPhase: string | null; }[]; total: number; }>
```

### `updateDecisionOutcome`

Update the outcome of a decision after learning from results.   T5155

```typescript
(projectRoot: string, id: string, outcome: "pending" | "success" | "failure" | "mixed" | null) => Promise<{ id: string; createdAt: string; updatedAt: string | null; type: "architecture" | "technical" | "process" | "strategic" | "tactical"; ... 7 more ...; contextPhase: string | null; }>
```

### `extractTaskCompletionMemory`

Extract and store memory entries when a task is completed.  - Always stores a learning for the completed task. - Stores a second learning if the task had dependencies. - Detects recurring label patterns across recent completed tasks   and stores a success pattern when any label appears 3+ times.

```typescript
(projectRoot: string, task: Task, _parentTask?: Task | undefined) => Promise<void>
```

### `extractSessionEndMemory`

Extract and store memory entries when a session ends.  - Stores a process decision summarising the session. - Stores a per-task learning for each completed task. - Stores a workflow pattern when 2+ completed tasks share a label.

```typescript
(projectRoot: string, sessionData: SessionBridgeData, taskDetails: Task[]) => Promise<void>
```

### `resolveTaskDetails`

Resolve an array of task IDs to their full Task objects. Tasks that cannot be found are silently excluded.

```typescript
(projectRoot: string, taskIds: string[]) => Promise<Task[]>
```

### `completeTask`

Complete a task by ID. Handles dependency checking and optional auto-completion of epics.  T4461

```typescript
(options: CompleteTaskOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<CompleteTaskResult>
```

### `updateTask`

Update a task's fields.  T4461

```typescript
(options: UpdateTaskOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<UpdateTaskResult>
```

### `readSyncState`

Read sync session state for a provider. Returns null if no state file exists.

```typescript
(providerId: string, cwd?: string | undefined) => Promise<SyncSessionState | null>
```

### `writeSyncState`

Write sync session state for a provider.

```typescript
(providerId: string, state: SyncSessionState, cwd?: string | undefined) => Promise<void>
```

### `clearSyncState`

Clear (delete) sync session state for a provider.

```typescript
(providerId: string, cwd?: string | undefined) => Promise<void>
```

### `reconcile`

Reconcile external task state with CLEO's authoritative task store.

```typescript
(externalTasks: ExternalTask[], options: ReconcileOptions, accessor?: DataAccessor | undefined) => Promise<ReconcileResult>
```

**Parameters:**

- `externalTasks` — Normalized tasks from a provider adapter.
- `options` — Reconciliation options.
- `accessor` — Optional DataAccessor override (for testing).

**Returns:** Reconciliation result with actions taken.

### `getArtifactHandler`

Get handler for an artifact type.  T4552

```typescript
(artifactType: ArtifactType) => ArtifactHandler | null
```

### `hasArtifactHandler`

Check if a handler is registered for an artifact type.  T4552

```typescript
(artifactType: string) => artifactType is ArtifactType
```

### `buildArtifact`

Build an artifact using the appropriate handler.  T4552

```typescript
(config: ArtifactConfig, dryRun?: boolean) => Promise<ArtifactResult>
```

### `validateArtifact`

Validate an artifact using the appropriate handler.  T4552

```typescript
(config: ArtifactConfig) => Promise<ArtifactResult>
```

### `publishArtifact`

Publish an artifact using the appropriate handler.  T4552

```typescript
(config: ArtifactConfig, dryRun?: boolean) => Promise<ArtifactResult>
```

### `getSupportedArtifactTypes`

Get all supported artifact types.  T4552

```typescript
() => ArtifactType[]
```

### `parseChangelogBlocks`

Parse [custom-log]...[/custom-log] blocks from a CHANGELOG section. Returns the extracted block content (tags stripped) and the content with tags+content removed.

```typescript
(content: string) => { customBlocks: string[]; strippedContent: string; }
```

### `writeChangelogSection`

Write or update a CHANGELOG.md section for a specific version.  - If ## [VERSION] section exists: replaces it in-place. - If not: prepends as new section after any top-level # heading. - Custom block content (from [custom-log] blocks) is appended after   generated content. - Section header format: '## [VERSION] (YYYY-MM-DD)'

```typescript
(version: string, generatedContent: string, customBlocks: string[], changelogPath: string) => Promise<void>
```

### `loadReleaseConfig`

Load release configuration with defaults.

```typescript
(cwd?: string | undefined) => ReleaseConfig
```

### `validateReleaseConfig`

Validate release configuration.

```typescript
(config: ReleaseConfig) => { valid: boolean; errors: string[]; warnings: string[]; }
```

### `getArtifactType`

Get artifact type from config.

```typescript
(cwd?: string | undefined) => string
```

### `getReleaseGates`

Get release gates from config.

```typescript
(cwd?: string | undefined) => ReleaseGate[]
```

### `getChangelogConfig`

Get changelog configuration.

```typescript
(cwd?: string | undefined) => { format: string; file: string; }
```

### `getDefaultGitFlowConfig`

Return the default GitFlow branch configuration.

```typescript
() => GitFlowConfig
```

### `getGitFlowConfig`

Merge caller-supplied GitFlow config with defaults.

```typescript
(config: ReleaseConfig) => GitFlowConfig
```

### `getDefaultChannelConfig`

Return the default channel configuration.

```typescript
() => ChannelConfig
```

### `getChannelConfig`

Merge caller-supplied channel config with defaults.

```typescript
(config: ReleaseConfig) => ChannelConfig
```

### `getPushMode`

Return the configured push mode, defaulting to 'auto'.

```typescript
(config: ReleaseConfig) => PushMode
```

### `getDefaultChannelConfig`

Return the default branch-to-channel mapping.

```typescript
() => ChannelConfig
```

### `resolveChannelFromBranch`

Resolve the release channel for a given Git branch name.  Resolution order: 1. Exact match in `config.custom` 2. Prefix match in `config.custom` 3. Exact match against `config.main` → 'latest' 4. Exact match against `config.develop` → 'beta' 5. Starts with 'feature/', 'hotfix/', 'release/', or `config.feature` → 'alpha' 6. Fallback → 'alpha'

```typescript
(branch: string, config?: ChannelConfig | undefined) => ReleaseChannel
```

### `channelToDistTag`

Map a release channel to its npm dist-tag string.  Kept as an explicit function (rather than a direct cast) so that callers remain decoupled from the string values and the mapping can be extended without changing call sites.

```typescript
(channel: ReleaseChannel) => string
```

### `validateVersionChannel`

Validate that a version string satisfies the pre-release conventions for the given channel.  Rules: - 'latest': version must NOT contain '-' (no pre-release suffix) - 'beta':   version must contain '-beta' or '-rc' - 'alpha':  version must contain '-alpha', '-dev', '-rc', or '-beta'

```typescript
(version: string, channel: ReleaseChannel) => ChannelValidationResult
```

### `describeChannel`

Return a human-readable description of the given release channel.

```typescript
(channel: ReleaseChannel) => string
```

### `getPlatformPath`

Get the output path for a CI platform.

```typescript
(platform: CIPlatform) => string
```

### `detectCIPlatform`

Detect the CI platform from the project.

```typescript
(projectDir?: string | undefined) => CIPlatform | null
```

### `generateCIConfig`

Generate CI config for a platform.

```typescript
(platform: CIPlatform, cwd?: string | undefined) => string
```

### `writeCIConfig`

Write CI config to the appropriate path.

```typescript
(platform: CIPlatform, options?: { projectDir?: string | undefined; dryRun?: boolean | undefined; }) => { action: string; path: string; content: string; }
```

### `validateCIConfig`

Validate an existing CI config.

```typescript
(platform: CIPlatform, projectDir?: string | undefined) => { valid: boolean; exists: boolean; errors: string[]; }
```

### `isGhCliAvailable`

Check if the `gh` CLI is available by attempting to run `gh --version`. Does NOT use `which` to remain cross-platform.

```typescript
() => boolean
```

### `extractRepoOwnerAndName`

Parse a GitHub remote URL (HTTPS or SSH) into owner and repo components. Returns null if the URL cannot be parsed.  Supported formats:   https://github.com/owner/repo.git   https://github.com/owner/repo   gitgithub.com:owner/repo.git   gitgithub.com:owner/repo

```typescript
(remote: string) => RepoIdentity | null
```

### `detectBranchProtection`

Detect whether a branch has protection rules enabled.  Strategy 1 (preferred): use `gh api` to query GitHub branch protection. Strategy 2 (fallback): use `git push --dry-run` and inspect stderr.

```typescript
(branch: string, remote: string, projectRoot?: string | undefined) => Promise<BranchProtectionResult>
```

### `buildPRBody`

Build the markdown body for a GitHub pull request.

```typescript
(opts: PRCreateOptions) => string
```

### `formatManualPRInstructions`

Format human-readable instructions for creating a PR manually.

```typescript
(opts: PRCreateOptions) => string
```

### `createPullRequest`

Create a GitHub pull request using the `gh` CLI, or return manual instructions if the CLI is unavailable or the operation fails.

```typescript
(opts: PRCreateOptions) => Promise<PRResult>
```

### `checkEpicCompleteness`

Check epic completeness for a set of release task IDs. Verifies all children of each referenced epic are included.

```typescript
(releaseTaskIds: string[], cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<EpicCompletenessResult>
```

### `checkDoubleListing`

Check if any tasks are listed in multiple releases.

```typescript
(releaseTaskIds: string[], existingReleases: { version: string; tasks: string[]; }[]) => DoubleListingResult
```

### `validateVersionFormat`

Validate version format (semver X.Y.Z or CalVer YYYY.M.patch, with optional pre-release).

```typescript
(version: string) => boolean
```

### `isCalVer`

Check if a version string is CalVer format.

```typescript
(version: string) => boolean
```

### `calculateNewVersion`

Calculate new version from current + bump type.

```typescript
(current: string, bump: string) => string
```

### `getVersionBumpConfig`

Get version bump configuration, mapping config field names to VersionBumpTarget.

```typescript
(cwd?: string | undefined) => VersionBumpTarget[]
```

### `isVersionBumpConfigured`

Check if version bump is configured.

```typescript
(cwd?: string | undefined) => boolean
```

### `bumpVersionFromConfig`

Bump version in all configured files.

```typescript
(newVersion: string, options?: { dryRun?: boolean | undefined; }, cwd?: string | undefined) => { results: BumpResult[]; allSuccess: boolean; }
```

### `prepareRelease`

Prepare a release (create a release manifest entry).  T4788

```typescript
(version: string, tasks: string[] | undefined, notes: string | undefined, loadTasksFn: () => Promise<ReleaseTaskRecord[]>, cwd?: string | undefined) => Promise<...>
```

### `generateReleaseChangelog`

Generate changelog for a release.  T4788

```typescript
(version: string, loadTasksFn: () => Promise<ReleaseTaskRecord[]>, cwd?: string | undefined) => Promise<{ version: string; changelog: string; taskCount: number; sections: Record<...>; }>
```

### `listManifestReleases`

List all releases.  T4788

```typescript
(optionsOrCwd?: string | ReleaseListOptions | undefined, cwd?: string | undefined) => Promise<{ releases: { version: string; status: string; createdAt: string; taskCount: number; }[]; total: number; filtered: number; latest?: string | undefined; page: LAFSPage; }>
```

### `showManifestRelease`

Show release details.  T4788

```typescript
(version: string, cwd?: string | undefined) => Promise<ReleaseManifest>
```

### `commitRelease`

Mark release as committed (metadata only).  T4788

```typescript
(version: string, cwd?: string | undefined) => Promise<{ version: string; status: string; committedAt: string; }>
```

### `tagRelease`

Mark release as tagged (metadata only).  T4788

```typescript
(version: string, cwd?: string | undefined) => Promise<{ version: string; status: string; taggedAt: string; }>
```

### `runReleaseGates`

Run release validation gates.  T4788  T5586

```typescript
(version: string, loadTasksFn: () => Promise<ReleaseTaskRecord[]>, cwd?: string | undefined, opts?: { dryRun?: boolean | undefined; } | undefined) => Promise<...>
```

### `cancelRelease`

Cancel and remove a release in draft or prepared state. Only releases that have not yet been committed to git can be cancelled. For committed/tagged/pushed releases, use rollbackRelease() instead.   T5602

```typescript
(version: string, projectRoot?: string | undefined) => Promise<{ success: boolean; message: string; version: string; }>
```

### `rollbackRelease`

Rollback a release.  T4788

```typescript
(version: string, reason?: string | undefined, cwd?: string | undefined) => Promise<{ version: string; previousStatus: string; status: string; reason: string; }>
```

### `pushRelease`

Push release to remote via git.  Respects config.release.push policy: - remote: override default remote (fallback to 'origin') - requireCleanTree: verify git working tree is clean before push - allowedBranches: verify current branch is in the allowed list - enabled: if false and no explicit push flag, caller should skip   T4788  T4276

```typescript
(version: string, remote?: string | undefined, cwd?: string | undefined, opts?: { explicitPush?: boolean | undefined; mode?: PushMode | undefined; prBase?: string | undefined; epicId?: string | undefined; guided?: boolean | undefined; } | undefined) => Promise<...>
```

### `markReleasePushed`

Update release status after push, with optional provenance fields.  T4788  T5580

```typescript
(version: string, pushedAt: string, cwd?: string | undefined, provenance?: { commitSha?: string | undefined; gitTag?: string | undefined; } | undefined) => Promise<void>
```

### `migrateReleasesJsonToSqlite`

One-time migration: read .cleo/releases.json and insert each release into the release_manifests table. Renames the file to releases.json.migrated on success.   T5580

```typescript
(projectRoot?: string | undefined) => Promise<{ migrated: number; }>
```

### `gradeSession`

Grade a session by sessionId using the 5-dimension behavioral rubric.

```typescript
(sessionId: string, cwd?: string | undefined) => Promise<GradeResult>
```

### `readGrades`

Read past grade results from .cleo/metrics/GRADES.jsonl

```typescript
(sessionId?: string | undefined, cwd?: string | undefined) => Promise<GradeResult[]>
```

### `handleSessionStart`

Handle onSessionStart - capture initial session context

```typescript
(projectRoot: string, payload: OnSessionStartPayload) => Promise<void>
```

### `handleSessionEnd`

Handle onSessionEnd - capture session summary

```typescript
(projectRoot: string, payload: OnSessionEndPayload) => Promise<void>
```

### `handleToolStart`

Handle onToolStart (maps to task.start in CLEO)

```typescript
(projectRoot: string, payload: OnToolStartPayload) => Promise<void>
```

### `handleToolComplete`

Handle onToolComplete (maps to task.complete in CLEO)

```typescript
(projectRoot: string, payload: OnToolCompletePayload) => Promise<void>
```

### `handleError`

Handle onError - capture operation errors to BRAIN  Includes infinite-loop guard: if the payload has _fromHook marker, the handler skips to prevent onError - observeBrain - onError loops. Additionally, ALL observeBrain errors are silently suppressed to prevent re-entrant hook firing.

```typescript
(projectRoot: string, payload: OnErrorPayload) => Promise<void>
```

### `handleFileChange`

Handle onFileChange - capture file changes to BRAIN  Gated behind CLEO_BRAIN_CAPTURE_FILES=true env var. Deduplicates rapid writes to the same file within a 5-second window. Filters out .cleo/ internal files and test temp directories. Converts absolute paths to project-relative paths.

```typescript
(projectRoot: string, payload: OnFileChangePayload) => Promise<void>
```

### `handlePromptSubmit`

Handle onPromptSubmit - optionally capture prompt events to BRAIN  No-op by default. Set CLEO_BRAIN_CAPTURE_MCP=true to enable.

```typescript
(projectRoot: string, payload: OnPromptSubmitPayload) => Promise<void>
```

### `handleResponseComplete`

Handle onResponseComplete - optionally capture response events to BRAIN  No-op by default. Set CLEO_BRAIN_CAPTURE_MCP=true to enable.

```typescript
(projectRoot: string, payload: OnResponseCompletePayload) => Promise<void>
```

### `recordAssumption`

Record an assumption made during a session. Appends to .cleo/audit/assumptions.jsonl (creates dir if needed). Throws if required params are missing or invalid.

```typescript
(projectRoot: string, params: RecordAssumptionParams) => Promise<Omit<AssumptionRecord, "validatedAt"> & { timestamp: string; }>
```

### `linkMemoryToTask`

Link a memory entry to a task.   T5156

```typescript
(projectRoot: string, memoryType: "decision" | "pattern" | "learning" | "observation", memoryId: string, taskId: string, linkType: "produced_by" | "applies_to" | "informed_by" | "contradicts") => Promise<...>
```

### `unlinkMemoryFromTask`

Remove a link between a memory entry and a task.   T5156

```typescript
(projectRoot: string, memoryType: "decision" | "pattern" | "learning" | "observation", memoryId: string, taskId: string, linkType: "produced_by" | "applies_to" | "informed_by" | "contradicts") => Promise<...>
```

### `getTaskLinks`

Get all memory entries linked to a specific task.   T5156

```typescript
(projectRoot: string, taskId: string) => Promise<{ createdAt: string; taskId: string; linkType: "produced_by" | "applies_to" | "informed_by" | "contradicts"; memoryType: "decision" | "pattern" | "learning" | "observation"; memoryId: string; }[]>
```

### `getMemoryLinks`

Get all tasks linked to a specific memory entry.   T5156

```typescript
(projectRoot: string, memoryType: "decision" | "pattern" | "learning" | "observation", memoryId: string) => Promise<{ createdAt: string; taskId: string; linkType: "produced_by" | "applies_to" | "informed_by" | "contradicts"; memoryType: "decision" | ... 2 more ... | "observation"; memoryId: string; }[]>
```

### `bulkLink`

Batch create multiple links at once.   T5156

```typescript
(projectRoot: string, links: BulkLinkEntry[]) => Promise<{ created: number; skipped: number; }>
```

### `getLinkedDecisions`

Get all decisions linked to a task. Convenience method that fetches full decision rows.   T5156

```typescript
(projectRoot: string, taskId: string) => Promise<{ id: string; createdAt: string; updatedAt: string | null; type: "architecture" | "technical" | "process" | "strategic" | "tactical"; confidence: "high" | ... 1 more ... | "low"; ... 6 more ...; contextPhase: string | null; }[]>
```

### `getLinkedPatterns`

Get all patterns linked to a task. Convenience method that fetches full pattern rows.   T5156

```typescript
(projectRoot: string, taskId: string) => Promise<{ id: string; updatedAt: string | null; type: "success" | "workflow" | "failure" | "blocker" | "optimization"; pattern: string; context: string; ... 6 more ...; extractedAt: string; }[]>
```

### `getLinkedLearnings`

Get all learnings linked to a task. Convenience method that fetches full learning rows.   T5156

```typescript
(projectRoot: string, taskId: string) => Promise<{ id: string; createdAt: string; updatedAt: string | null; source: string; confidence: number; insight: string; actionable: boolean; application: string | null; applicableTypesJson: string | null; }[]>
```

### `extractMemoryItems`

Extract memory-worthy items from debrief data. Pure function -- no side effects.  Items extracted: - Decisions (from debrief.decisions[]) - observations with type='decision' - Tasks completed summary - observation with type='change' - Session-level note (if present) - observation with type='discovery'

```typescript
(sessionId: string, debrief: DebriefData | null | undefined) => MemoryItem[]
```

### `persistSessionMemory`

Main entry point -- called from session.end handler. Extracts memory-worthy content from debrief data and persists to brain.db.  ALL errors are caught and accumulated in result.errors -- never throws.

```typescript
(projectRoot: string, sessionId: string, debrief: DebriefData | null | undefined) => Promise<SessionMemoryResult>
```

**Parameters:**

- `projectRoot` — Project root directory
- `sessionId` — The session that just ended
- `debrief` — Rich debrief data from sessionComputeDebrief()

**Returns:** Summary of what was persisted

### `getSessionMemoryContext`

Retrieve session memory for a given scope. Used by briefing/handoff to enrich response with brain context.

```typescript
(projectRoot: string, scope?: { type: string; epicId?: string | undefined; rootTaskId?: string | undefined; } | undefined, options?: { limit?: number | undefined; includeDecisions?: boolean | undefined; includePatterns?: boolean | undefined; } | undefined) => Promise<...>
```

**Parameters:**

- `projectRoot` — Project root directory
- `scope` — Session scope for filtering (epic:T### or global)
- `options` — Retrieval options

**Returns:** Relevant brain memory entries

### `depsReady`

Check if all dependencies of a task are satisfied.

```typescript
(depends: string[] | undefined, taskLookup: ReadonlyMap<string, unknown>) => boolean
```

**Parameters:**

- `depends` — Array of dependency task IDs (may be undefined/empty)
- `taskLookup` — Map from task ID to a task-like object with at least  status: string

**Returns:** true if all dependencies are done/cancelled, or if no dependencies exist

### `computeBriefing`

Compute the complete session briefing. Aggregates data from all 6+ sources.

```typescript
(projectRoot: string, options?: BriefingOptions) => Promise<SessionBriefing>
```

### `findSessions`

Find sessions with minimal field projection.  Loads all sessions, applies filters, then projects to minimal fields. This is cheaper for agents that only need discovery-level data.

```typescript
(accessor: DataAccessor, params?: FindSessionsParams | undefined) => Promise<MinimalSessionRecord[]>
```

**Parameters:**

- `accessor` — DataAccessor for loading sessions
- `params` — Optional filters (status, scope, query, limit)

**Returns:** Array of minimal session records

### `archiveSessions`

Archive old/ended sessions. Identifies ended and suspended sessions older than the threshold. With SQLite, all sessions live in a single table — "archiving" marks them as identified for potential cleanup rather than moving between arrays.

```typescript
(projectRoot: string, olderThan?: string | undefined) => Promise<{ archived: string[]; count: number; }>
```

### `cleanupSessions`

Remove orphaned sessions, auto-end stale active sessions, and clean up stale data.  Stale active sessions (no activity beyond the configured threshold) are transitioned to 'ended' with an auto-end note. The threshold is read from `retention.autoEndActiveAfterDays` in the project config (default: 7 days).   T2304

```typescript
(projectRoot: string) => Promise<{ removed: string[]; autoEnded: string[]; cleaned: boolean; }>
```

### `getContextDrift`

Compute context drift score for the current session. Compares session progress against original scope by counting completed vs total tasks in scope, and detecting out-of-scope work.

```typescript
(projectRoot: string, params?: { sessionId?: string | undefined; } | undefined) => Promise<ContextDriftResult>
```

### `getSessionHistory`

List session history with focus changes and completed tasks. If sessionId is provided, returns history for that specific session. Otherwise, returns history across all sessions.

```typescript
(projectRoot: string, params?: SessionHistoryParams | undefined) => Promise<{ sessions: SessionHistoryEntry[]; }>
```

### `showSession`

Show a specific session. Looks in active sessions first, then session history. Throws CleoError if not found.

```typescript
(projectRoot: string, sessionId: string) => Promise<Session>
```

### `getSessionStats`

Compute session statistics, optionally for a specific session. Throws CleoError if a specific session is requested but not found.

```typescript
(projectRoot: string, sessionId?: string | undefined) => Promise<SessionStatsResult>
```

### `suspendSession`

Suspend an active session. Sets status to 'suspended' and records the reason. Throws if session not found or not active.

```typescript
(projectRoot: string, sessionId: string, reason?: string | undefined) => Promise<Session>
```

### `switchSession`

Switch to a different session. Suspends the current active session and activates the target. Throws if session not found or archived.

```typescript
(projectRoot: string, sessionId: string) => Promise<Session>
```

### `selectRuntimeProviderContext`

```typescript
(detections: DetectionResult[], snapshot?: RuntimeProviderSnapshot) => RuntimeProviderContext
```

### `detectRuntimeProviderContext`

```typescript
(snapshot?: RuntimeProviderSnapshot) => RuntimeProviderContext
```

### `resetRuntimeProviderContextCache`

```typescript
() => void
```

### `parseScope`

Parse a scope string into a SessionScope.  T4463

```typescript
(scopeStr: string) => SessionScope
```

### `readSessions`

Read sessions from accessor or JSON file.  T4463

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Session[]>
```

### `saveSessions`

Save sessions via accessor or JSON file.  T4463

```typescript
(sessions: Session[], cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<void>
```

### `startSession`

Start a new session.  T4463

```typescript
(options: StartSessionOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Session>
```

### `endSession`

End a session.  T4463

```typescript
(options?: EndSessionOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Session>
```

### `sessionStatus`

Get current session status.  T4463

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Session | null>
```

### `resumeSession`

Resume an existing session.  T4463

```typescript
(sessionId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Session>
```

### `listSessions`

List sessions with optional filtering.  T4463

```typescript
(options?: ListSessionsOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Session[]>
```

### `gcSessions`

Garbage collect old sessions. Marks orphaned sessions that have been active too long.  T4463

```typescript
(maxAgeHours?: number, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ orphaned: string[]; removed: string[]; }>
```

### `archiveSticky`

Archive a sticky note.

```typescript
(id: string, projectRoot: string) => Promise<StickyNote | null>
```

**Parameters:**

- `id` — Sticky note ID
- `projectRoot` — Project root path

**Returns:** The archived sticky note or null if not found

### `convertStickyToTask`

Convert a sticky note to a task.

```typescript
(stickyId: string, taskTitle: string | undefined, projectRoot: string) => Promise<{ success: boolean; taskId?: string | undefined; error?: { code: string; message: string; } | undefined; }>
```

**Parameters:**

- `stickyId` — Sticky note ID
- `taskTitle` — Optional task title (defaults to sticky content)
- `projectRoot` — Project root path

**Returns:** Result with new task ID

### `convertStickyToMemory`

Convert a sticky note to a memory observation.

```typescript
(stickyId: string, memoryType: string | undefined, projectRoot: string) => Promise<{ success: boolean; memoryId?: string | undefined; error?: { code: string; message: string; } | undefined; }>
```

**Parameters:**

- `stickyId` — Sticky note ID
- `memoryType` — Optional memory type
- `projectRoot` — Project root path

**Returns:** Result with new memory entry ID

### `convertStickyToTaskNote`

Convert a sticky note to a task note.

```typescript
(stickyId: string, taskId: string, projectRoot: string) => Promise<{ success: boolean; taskId?: string | undefined; error?: { code: string; message: string; } | undefined; }>
```

**Parameters:**

- `stickyId` — Sticky note ID
- `taskId` — Target task ID
- `projectRoot` — Project root path

**Returns:** Result with updated task ID

### `convertStickyToSessionNote`

Convert a sticky note to a session note.

```typescript
(stickyId: string, sessionId: string | undefined, projectRoot: string) => Promise<{ success: boolean; sessionId?: string | undefined; error?: { code: string; message: string; } | undefined; }>
```

**Parameters:**

- `stickyId` — Sticky note ID
- `sessionId` — Optional target session ID (defaults to current active session)
- `projectRoot` — Project root path

**Returns:** Result with session ID

### `generateStickyId`

Generate the next sticky note ID.  Finds the highest existing SN-XXX ID and increments.

```typescript
(projectRoot: string) => Promise<string>
```

**Parameters:**

- `projectRoot` — Project root path

**Returns:** Next sticky note ID (e.g., "SN-042")

### `addSticky`

Create a new sticky note.

```typescript
(params: CreateStickyParams, projectRoot: string) => Promise<StickyNote>
```

**Parameters:**

- `params` — Creation parameters
- `projectRoot` — Project root path

**Returns:** The created sticky note

### `listStickies`

List sticky notes with optional filters.

```typescript
(params: ListStickiesParams, projectRoot: string) => Promise<StickyNote[]>
```

**Parameters:**

- `params` — Filter parameters
- `projectRoot` — Project root path

**Returns:** Array of sticky notes

### `purgeSticky`

Purge (permanently delete) a sticky note.

```typescript
(id: string, projectRoot: string) => Promise<StickyNote | null>
```

**Parameters:**

- `id` — Sticky note ID
- `projectRoot` — Project root path

**Returns:** The deleted sticky note or null if not found

### `getSticky`

Get a sticky note by ID.

```typescript
(id: string, projectRoot: string) => Promise<StickyNote | null>
```

**Parameters:**

- `id` — Sticky note ID (e.g., "SN-042")
- `projectRoot` — Project root path

**Returns:** The sticky note or null if not found

### `archiveTasks`

Archive completed (and optionally cancelled) tasks. Moves them from active task data to archive.  T4461

```typescript
(options?: ArchiveTasksOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<ArchiveTasksResult>
```

### `deleteTask`

Delete a task (soft delete - moves to archive).  T4461

```typescript
(options: DeleteTaskOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<DeleteTaskResult>
```

### `calculateExportChecksum`

Calculate SHA-256 checksum for export integrity (truncated to 16 hex chars).

```typescript
(tasksJson: string) => string
```

### `verifyExportChecksum`

Verify export package checksum.

```typescript
(pkg: ExportPackage) => boolean
```

### `buildIdMap`

Build ID map from tasks.

```typescript
(tasks: Task[]) => Record<string, IdMapEntry>
```

### `buildRelationshipGraph`

Build relationship graph from tasks.

```typescript
(tasks: Task[]) => RelationshipGraph
```

### `buildExportPackage`

Build a complete export package.

```typescript
(tasks: Task[], taskData: TaskFile, options: { mode: string; rootTaskIds: string[]; includeChildren: boolean; cleoVersion?: string | undefined; filters?: unknown; }) => ExportPackage
```

### `exportSingle`

Export a single task.

```typescript
(taskId: string, taskData: TaskFile) => ExportPackage | null
```

### `exportSubtree`

Export a subtree (task + all descendants).

```typescript
(rootId: string, taskData: TaskFile) => ExportPackage | null
```

### `exportTasksPackage`

Export tasks to a portable cross-project package.

```typescript
(params: ExportTasksParams) => Promise<ExportTasksResult>
```

### `getCostHint`

Determine cost hint for an operation based on domain and operation name.

```typescript
(domain: string, operation: string) => CostHint
```

### `groupOperationsByDomain`

Group operations by domain into a compact format.

```typescript
(ops: HelpOperationDef[]) => GroupedOperations
```

**Parameters:**

- `ops` — Operations filtered to the requested tier

**Returns:** Domain-grouped operations with query and mutate arrays

### `buildVerboseOperations`

Build verbose operation entries with cost hints.

```typescript
(ops: HelpOperationDef[]) => VerboseOperation[]
```

**Parameters:**

- `ops` — Operations filtered to the requested tier

**Returns:** Array of verbose operation objects

### `computeHelp`

Compute the help result for the admin.help operation.  Accepts the full OPERATIONS registry and filters/formats based on tier and verbosity. This is pure business logic with no dispatch or engine dependencies.

```typescript
(allOperations: HelpOperationDef[], tier: number, verbose: boolean) => HelpResult
```

**Parameters:**

- `allOperations` — The full operation registry
- `tier` — The tier level to filter to (0, 1, or 2)
- `verbose` — Whether to return full operation objects or compact grouped format

**Returns:** The computed help result

### `getNextAvailableId`

Get the next available task ID number from existing tasks.

```typescript
(tasks: Task[]) => number
```

### `generateRemapTable`

Generate a remap table for importing tasks. Maps source task IDs to new sequential IDs starting from nextAvailable.

```typescript
(sourceTaskIds: string[], existingTasks: Task[]) => RemapTable
```

### `validateRemapTable`

Validate that a remap table is complete and consistent.

```typescript
(table: RemapTable, expectedSourceIds: string[]) => { valid: boolean; errors: string[]; }
```

### `remapTaskId`

Remap a single task ID, returning original if not in table.

```typescript
(taskId: string | null, table: RemapTable) => string | null
```

### `remapTaskReferences`

Remap all ID references in a task.

```typescript
(task: Task, table: RemapTable, existingTaskIds: Set<string>, missingDepStrategy?: "fail" | "strip") => Task
```

### `detectDuplicateTitles`

Detect duplicate titles between import and target.

```typescript
(importTasks: Task[], existingTasks: Task[]) => { sourceId: string; title: string; existingId: string; }[]
```

### `resolveDuplicateTitle`

Resolve duplicate title by appending suffix.

```typescript
(title: string, existingTitles: Set<string>) => string
```

### `importTasksPackage`

Import tasks from a cross-project export package with ID remapping.

```typescript
(params: ImportTasksParams) => Promise<ImportTasksResult>
```

### `findAdrs`

```typescript
(projectRoot: string, query: string, opts?: { topics?: string | undefined; keywords?: string | undefined; status?: string | undefined; } | undefined) => Promise<AdrFindResult>
```

### `listAdrs`

List ADRs from .cleo/adrs/ directory with optional status filter

```typescript
(projectRoot: string, opts?: { status?: string | undefined; since?: string | undefined; limit?: number | undefined; offset?: number | undefined; } | undefined) => Promise<AdrListResult>
```

### `showAdr`

Retrieve a single ADR by ID (e.g., 'ADR-007')

```typescript
(projectRoot: string, adrId: string) => Promise<AdrRecord | null>
```

### `validateAllAdrs`

Validate all ADRs in .cleo/adrs/ against the schema

```typescript
(projectRoot: string) => Promise<ValidationResult>
```

### `providerList`

List all registered providers.  T4332

```typescript
() => EngineResult<Provider[]>
```

### `providerGet`

Get a single provider by ID or alias.  T4332

```typescript
(idOrAlias: string) => EngineResult<Provider>
```

### `providerDetect`

Detect all providers installed on the system.  T4332

```typescript
() => EngineResult<DetectionResult[]>
```

### `providerInstalled`

Get providers that are installed on the system.  T4332

```typescript
() => EngineResult<Provider[]>
```

### `providerCount`

Get count of registered providers.  T4332

```typescript
() => EngineResult<{ count: number; }>
```

### `registryVersion`

Get CAAMP registry version.  T4332

```typescript
() => EngineResult<{ version: string; }>
```

### `mcpList`

List MCP servers for a specific provider.  T4332

```typescript
(providerId: string, scope: "global" | "project", projectDir?: string | undefined) => Promise<EngineResult<{ servers: unknown[]; }>>
```

### `mcpListAll`

List MCP servers across all installed providers.  T4332

```typescript
(scope: "global" | "project", projectDir?: string | undefined) => Promise<EngineResult<{ servers: unknown[]; }>>
```

### `mcpInstall`

Install an MCP server to a provider's config.  T4332

```typescript
(providerId: string, serverName: string, config: McpServerConfig, scope?: "global" | "project" | undefined, projectDir?: string | undefined) => Promise<EngineResult<InstallResult>>
```

### `mcpRemove`

Remove an MCP server from a provider's config.  T4332

```typescript
(providerId: string, serverName: string, scope: "global" | "project", projectDir?: string | undefined) => Promise<EngineResult<{ removed: boolean; }>>
```

### `mcpConfigPath`

Resolve the config file path for a provider.  T4332

```typescript
(providerId: string, scope: "global" | "project", projectDir?: string | undefined) => EngineResult<{ path: string | null; }>
```

### `injectionCheck`

Check injection status for a single file.  T4332

```typescript
(filePath: string, expectedContent?: string | undefined) => Promise<EngineResult<InjectionStatus>>
```

### `injectionCheckAll`

Check injection status across all providers.  T4332

```typescript
(projectDir: string, scope: "global" | "project", expectedContent?: string | undefined) => Promise<EngineResult<{ results: unknown[]; }>>
```

### `injectionUpdate`

Inject or update content in a single file.  T4332

```typescript
(filePath: string, content: string) => Promise<EngineResult<{ action: string; }>>
```

### `injectionUpdateAll`

Inject content to all providers' instruction files.  T4332

```typescript
(projectDir: string, scope: "global" | "project", content: string) => Promise<EngineResult<{ results: Record<string, string>; }>>
```

### `batchInstallWithRollback`

Install multiple MCP servers atomically with rollback on failure. Supports Wave 4 init rewrite which needs to install multiple skills/configs as a single atomic operation.   T4705  T4663

```typescript
(options: BatchInstallOptions) => Promise<EngineResult<BatchInstallResult>>
```

### `dualScopeConfigure`

Configure a provider at both global and project scope simultaneously. Used during init to set up MCP configs in both scopes atomically.   T4705  T4663

```typescript
(providerId: string, options: DualScopeConfigureOptions) => Promise<EngineResult<DualScopeConfigureResult>>
```

### `checkProviderCapability`

Check if provider supports a specific capability

```typescript
(provider: string | Provider, capabilityPath: string) => boolean
```

**Parameters:**

- `provider` — Provider object or ID
- `capabilityPath` — Dot notation path (e.g., 'spawn.supportsSubagents')

**Returns:** boolean  Examples: - providerSupports(provider, 'spawn.supportsSubagents') - providerSupports(provider, 'hooks.supported') - providerSupportsById('claude-code', 'spawn.supportsParallelSpawn') - providerSupportsById('gemini-cli', 'skills.precedence')

### `checkProviderCapabilities`

Check multiple capabilities at once

```typescript
(providerId: string, capabilities: string[]) => Record<string, boolean>
```

### `getComplianceJsonlPath`

Resolve COMPLIANCE.jsonl path for a project root.

```typescript
(projectRoot: string) => string
```

### `readComplianceJsonl`

Read COMPLIANCE.jsonl entries. Invalid JSON lines are skipped to preserve append-only log resilience.

```typescript
(projectRoot: string) => ComplianceJsonlEntry[]
```

### `appendComplianceJsonl`

Append one entry to COMPLIANCE.jsonl, creating directories as needed.

```typescript
(projectRoot: string, entry: ComplianceJsonlEntry) => void
```

### `getComplianceSummary`

Get compliance summary.

```typescript
(opts: { since?: string | undefined; agent?: string | undefined; cwd?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `listComplianceViolations`

List compliance violations.

```typescript
(opts: { severity?: string | undefined; since?: string | undefined; agent?: string | undefined; cwd?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `getComplianceTrend`

Get compliance trend.

```typescript
(days?: number, cwd?: string | undefined) => Promise<Record<string, unknown>>
```

### `auditEpicCompliance`

Audit epic compliance.

```typescript
(epicId: string, opts: { since?: string | undefined; cwd?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `syncComplianceMetrics`

Sync compliance metrics to a summary file.

```typescript
(opts: { force?: boolean | undefined; cwd?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `getSkillReliability`

Get skill reliability stats.

```typescript
(opts: { global?: boolean | undefined; cwd?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `getValueMetrics`

Get value metrics (T2833).

```typescript
(days?: number, cwd?: string | undefined) => Promise<Record<string, unknown>>
```

### `getContextStatus`

Get context status.

```typescript
(opts: { session?: string | undefined; cwd?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `checkContextThreshold`

Check context threshold (returns exit code info).

```typescript
(opts: { session?: string | undefined; cwd?: string | undefined; }) => Promise<Record<string, unknown> & { exitCode?: number | undefined; }>
```

### `listContextSessions`

List all context state files.

```typescript
(cwd?: string | undefined) => Promise<Record<string, unknown>>
```

### `injectTasks`

Inject tasks into TodoWrite format.

```typescript
(opts: { maxTasks?: number | undefined; focusedOnly?: boolean | undefined; phase?: string | undefined; output?: string | undefined; saveState?: boolean | undefined; dryRun?: boolean | undefined; cwd?: string | undefined; }, accessor?: DataAccessor | undefined) => Promise<...>
```

### `collectDiagnostics`

Collect system diagnostics for bug reports.

```typescript
() => Record<string, string>
```

### `formatDiagnosticsTable`

Format diagnostics as markdown table.

```typescript
(diag: Record<string, string>) => string
```

### `parseIssueTemplates`

Parse all issue templates from available sources. Priority:   1. Packaged templates in the CLEO installation (for npm-installed users)   2. Project's .github/ISSUE_TEMPLATE/ (for contributors working on CLEO)

```typescript
(projectDir?: string | undefined) => IssueTemplate[]
```

### `getTemplateConfig`

Get template configuration - tries live parse, cache, then fallback.

```typescript
(cwd?: string | undefined) => IssueTemplate[]
```

### `getTemplateForSubcommand`

Get the template for a specific subcommand (bug, feature, etc.).

```typescript
(subcommand: string, cwd?: string | undefined) => IssueTemplate | null
```

### `cacheTemplates`

Cache parsed templates to .cleo/issue-templates.json.

```typescript
(templates: IssueTemplate[], cwd?: string | undefined) => void
```

### `validateLabelsExist`

Validate that required labels exist (informational).

```typescript
(_templates: IssueTemplate[]) => { valid: boolean; missingLabels: string[]; }
```

### `buildIssueBody`

Build structured issue body with template sections.

```typescript
(subcommand: string, rawBody: string, severity?: string | undefined, area?: string | undefined) => string
```

### `checkGhCli`

Check that gh CLI is installed and authenticated.

```typescript
() => void
```

### `addIssue`

Add a GitHub issue for a given type (bug, feature, help). Returns structured result. Does not handle CLI output or process.exit.  Note: Named 'add' per VERB-STANDARDS.md (canonical verb for "Create new entity")

```typescript
(params: AddIssueParams) => AddIssueResult
```

### `applyTemporalDecay`

Apply temporal decay to brain_learnings confidence values.  Entries older than `olderThanDays` have their confidence reduced by an exponential decay factor based on the number of days since their last update (or creation if never updated).  Formula: new_confidence = confidence * (decayRate ^ daysSinceUpdate)

```typescript
(projectRoot: string, options?: { decayRate?: number | undefined; olderThanDays?: number | undefined; } | undefined) => Promise<DecayResult>
```

**Parameters:**

- `projectRoot` — Project root directory for brain.db resolution
- `options` — Decay configuration

**Returns:** Count of updated rows and tables processed

### `consolidateMemories`

Consolidate old observations by keyword similarity.  Groups observations older than `olderThanDays` by FTS5 keyword overlap. For groups with at least `minClusterSize` entries, creates one summary observation and marks originals as archived (updated_at set, narrative prefixed with [ARCHIVED]).

```typescript
(projectRoot: string, options?: { olderThanDays?: number | undefined; minClusterSize?: number | undefined; } | undefined) => Promise<ConsolidationResult>
```

**Parameters:**

- `projectRoot` — Project root directory for brain.db resolution
- `options` — Consolidation configuration

**Returns:** Counts of grouped, merged, and archived observations

### `migrateBrainData`

Migrate BRAIN memory data from JSONL files to brain.db.  Reads: - .cleo/memory/patterns.jsonl - brain_patterns table - .cleo/memory/learnings.jsonl - brain_learnings table  Skips entries where the ID already exists in the database (idempotent).   T5129

```typescript
(projectRoot: string) => Promise<BrainMigrationResult>
```

### `addResearch`

Add a research entry.  T4465

```typescript
(options: AddResearchOptions, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<ResearchEntry>
```

### `showResearch`

Show a specific research entry.  T4465

```typescript
(researchId: string, cwd?: string | undefined) => Promise<ResearchEntry>
```

### `listResearch`

List research entries with optional filtering.  T4465

```typescript
(options?: ListResearchOptions, cwd?: string | undefined) => Promise<ResearchEntry[]>
```

### `pendingResearch`

List pending research entries.  T4465

```typescript
(cwd?: string | undefined) => Promise<ResearchEntry[]>
```

### `linkResearch`

Link a research entry to a task.  T4465

```typescript
(researchId: string, taskId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ researchId: string; taskId: string; }>
```

### `updateResearch`

Update research findings.  T4465

```typescript
(researchId: string, updates: { findings?: string[] | undefined; sources?: string[] | undefined; status?: "complete" | "pending" | "partial" | undefined; }, cwd?: string | undefined) => Promise<...>
```

### `statsResearch`

Get research statistics.  T4474

```typescript
(cwd?: string | undefined) => Promise<{ total: number; byStatus: Record<string, number>; byTopic: Record<string, number>; }>
```

### `linksResearch`

Get research entries linked to a specific task.  T4474

```typescript
(taskId: string, cwd?: string | undefined) => Promise<ResearchEntry[]>
```

### `archiveResearch`

Archive old research entries by status. Moves 'complete' entries older than a threshold to an archive, or returns summary of archivable entries.  T4474

```typescript
(cwd?: string | undefined) => Promise<{ action: string; entriesArchived: number; entriesRemaining: number; }>
```

### `readManifest`

Read manifest entries from MANIFEST.jsonl.  T4465

```typescript
(cwd?: string | undefined) => Promise<ManifestEntry[]>
```

### `appendManifest`

Append a manifest entry.  T4465

```typescript
(entry: ManifestEntry, cwd?: string | undefined) => Promise<void>
```

### `queryManifest`

Query manifest entries.  T4465

```typescript
(options?: ManifestQueryOptions, cwd?: string | undefined) => Promise<ManifestEntry[]>
```

### `readExtendedManifest`

Read all manifest entries as extended entries.  T4787

```typescript
(cwd?: string | undefined) => Promise<ExtendedManifestEntry[]>
```

### `filterManifestEntries`

Filter manifest entries by criteria.  T4787

```typescript
(entries: ExtendedManifestEntry[], filter: ResearchFilter) => ExtendedManifestEntry[]
```

### `showManifestEntry`

Show a manifest entry by ID with optional file content.  T4787

```typescript
(researchId: string, cwd?: string | undefined) => Promise<ExtendedManifestEntry & { fileContent: string | null; fileExists: boolean; }>
```

### `searchManifest`

Search manifest entries by text with relevance scoring.  T4787

```typescript
(query: string, options?: { confidence?: number | undefined; limit?: number | undefined; } | undefined, cwd?: string | undefined) => Promise<(ExtendedManifestEntry & { ...; })[]>
```

### `pendingManifestEntries`

Get pending manifest entries (partial, blocked, or needing followup).  T4787

```typescript
(epicId?: string | undefined, cwd?: string | undefined) => Promise<{ entries: ExtendedManifestEntry[]; total: number; byStatus: { partial: number; blocked: number; needsFollowup: number; }; }>
```

### `manifestStats`

Get manifest-based research statistics.  T4787

```typescript
(epicId?: string | undefined, cwd?: string | undefined) => Promise<{ total: number; byStatus: Record<string, number>; byType: Record<string, number>; actionable: number; needsFollowup: number; averageFindings: number; }>
```

### `linkManifestEntry`

Link a manifest entry to a task (adds taskId to linked_tasks array).  T4787

```typescript
(taskId: string, researchId: string, cwd?: string | undefined) => Promise<{ taskId: string; researchId: string; alreadyLinked: boolean; }>
```

### `appendExtendedManifest`

Append an extended manifest entry. Validates required fields before appending.  T4787

```typescript
(entry: ExtendedManifestEntry, cwd?: string | undefined) => Promise<{ entryId: string; file: string; }>
```

### `archiveManifestEntries`

Archive manifest entries older than a date.  T4787

```typescript
(beforeDate: string, cwd?: string | undefined) => Promise<{ archived: number; remaining: number; archiveFile: string; }>
```

### `findContradictions`

Find manifest entries with overlapping topics but conflicting key_findings.  T4787

```typescript
(cwd?: string | undefined, params?: { topic?: string | undefined; } | undefined) => Promise<ContradictionDetail[]>
```

### `findSuperseded`

Identify research entries replaced by newer work on same topic.  T4787

```typescript
(cwd?: string | undefined, params?: { topic?: string | undefined; } | undefined) => Promise<SupersededDetail[]>
```

### `readProtocolInjection`

Read protocol injection content for a given protocol type.  T4787

```typescript
(protocolType: string, params?: { taskId?: string | undefined; variant?: string | undefined; } | undefined, cwd?: string | undefined) => Promise<{ protocolType: string; content: string; ... 4 more ...; variant: string | null; }>
```

### `compactManifest`

Compact MANIFEST.jsonl by removing duplicate/stale entries.  T4787

```typescript
(cwd?: string | undefined) => Promise<{ compacted: boolean; originalLines: number; malformedRemoved: number; duplicatesRemoved: number; remainingEntries: number; }>
```

### `validateManifestEntries`

Validate research entries for a task.  T4787

```typescript
(taskId: string, cwd?: string | undefined) => Promise<{ taskId: string; valid: boolean; entriesFound: number; issues: { entryId: string; issue: string; severity: "error" | "warning"; }[]; errorCount: number; warningCount: number; }>
```

### `ensureMetricsDir`

Ensure metrics directory exists, returning its path.

```typescript
(metricsDir?: string | undefined) => Promise<string>
```

### `getCompliancePath`

Get compliance log path.

```typescript
(metricsDir?: string | undefined) => string
```

### `getViolationsPath`

Get violations log path.

```typescript
(metricsDir?: string | undefined) => string
```

### `getSessionsMetricsPath`

Get sessions metrics log path.

```typescript
(metricsDir?: string | undefined) => string
```

### `isoTimestamp`

Generate ISO 8601 UTC timestamp.

```typescript
() => string
```

### `isoDate`

Generate ISO 8601 date only.

```typescript
() => string
```

### `readJsonlFile`

Read a JSONL file into an array of parsed objects.

```typescript
(filePath: string) => Record<string, unknown>[]
```

### `getComplianceSummaryBase`

Get compliance summary from log file.

```typescript
(compliancePath?: string | undefined) => ComplianceSummary
```

### `isOtelEnabled`

Check if OTel telemetry is enabled.

```typescript
() => boolean
```

### `getOtelSetupCommands`

Get environment variable commands for OTel capture setup.

```typescript
(mode?: OtelCaptureMode, cwd?: string | undefined) => string
```

### `parseTokenMetrics`

Parse OTel token metrics from collected data.

```typescript
(inputFile?: string | undefined, cwd?: string | undefined) => OtelTokenDataPoint[]
```

### `getSessionTokens`

Get aggregated token counts from OTel data.

```typescript
(sessionId?: string | undefined, cwd?: string | undefined) => AggregatedTokens
```

### `recordSessionStart`

Record token counts at session start.

```typescript
(sessionId: string, cwd?: string | undefined) => Promise<Record<string, unknown>>
```

### `recordSessionEnd`

Record token counts at session end.

```typescript
(sessionId: string, cwd?: string | undefined) => Promise<Record<string, unknown>>
```

### `compareSessions`

Compare token usage between two sessions.

```typescript
(sessionA: string, sessionB: string, cwd?: string | undefined) => Record<string, unknown>
```

### `getTokenStats`

Get statistics about token usage across sessions.

```typescript
(cwd?: string | undefined) => Record<string, unknown>
```

### `logABEvent`

Log an A/B test event.

```typescript
(eventType: ABEventType, testName: string, variant: ABVariant, context?: string | Record<string, unknown> | undefined, cwd?: string | undefined) => Promise<...>
```

### `startABTest`

Start an A/B test session.

```typescript
(testName: string, variant: ABVariant, description?: string | undefined, cwd?: string | undefined) => Promise<void>
```

### `endABTest`

End an A/B test session with summary.

```typescript
(options?: { tasksCompleted?: number | undefined; validationPasses?: number | undefined; validationFailures?: number | undefined; notes?: string | undefined; }, cwd?: string | undefined) => Promise<...>
```

### `getABTestResults`

Get results for a specific test variant.

```typescript
(testName: string, variant: ABVariant, cwd?: string | undefined) => Record<string, unknown> | null
```

### `listABTests`

List all A/B tests.

```typescript
(filter?: string | undefined, cwd?: string | undefined) => Record<string, unknown>[]
```

### `compareABTest`

Compare two variants of the same test.

```typescript
(testName: string, cwd?: string | undefined) => Record<string, unknown>
```

### `getABTestStats`

Get aggregate statistics of all A/B tests.

```typescript
(cwd?: string | undefined) => Record<string, unknown>
```

### `syncMetricsToGlobal`

Sync project metrics to global aggregation file.

```typescript
(options?: { force?: boolean | undefined; }, cwd?: string | undefined) => Promise<Record<string, unknown>>
```

### `getProjectComplianceSummary`

Get compliance summary for the current project.

```typescript
(options?: { since?: string | undefined; agent?: string | undefined; category?: string | undefined; }, cwd?: string | undefined) => Record<string, unknown>
```

### `getGlobalComplianceSummary`

Get compliance summary across all projects.

```typescript
(options?: { since?: string | undefined; project?: string | undefined; }) => Record<string, unknown>
```

### `getComplianceTrend`

Get compliance trend over time.

```typescript
(days?: number, options?: { project?: string | undefined; global?: boolean | undefined; }, cwd?: string | undefined) => Record<string, unknown>
```

### `getSkillReliability`

Get reliability stats per skill/agent.

```typescript
(options?: { since?: string | undefined; global?: boolean | undefined; }, cwd?: string | undefined) => Record<string, unknown>
```

### `logSessionMetrics`

Log session metrics to SESSIONS.jsonl.

```typescript
(metricsJson: Record<string, unknown>, cwd?: string | undefined) => Promise<Record<string, unknown>>
```

### `getSessionMetricsSummary`

Get summary of session metrics.

```typescript
(options?: { since?: string | undefined; }, cwd?: string | undefined) => Record<string, unknown>
```

### `isValidEnumValue`

Validate that a value is a member of a given enum.

```typescript
<T extends Record<string, string>>(enumObj: T, value: string) => value is T[keyof T]
```

### `estimateTokens`

Estimate token count from text. ~4 characters per token.

```typescript
(text: string) => number
```

### `estimateTokensFromFile`

Estimate token count from a file.

```typescript
(filePath: string) => number
```

### `logTokenEvent`

Log a token usage event to the JSONL file.

```typescript
(eventType: TokenEventType, tokens: number, source: string, taskId?: string | undefined, context?: Record<string, unknown> | undefined, cwd?: string | undefined) => Promise<...>
```

### `trackFileRead`

Track a file read with token estimate.

```typescript
(filePath: string, purpose: string, taskId?: string | undefined, cwd?: string | undefined) => Promise<number>
```

### `trackManifestQuery`

Track a manifest query (partial read).

```typescript
(queryType: string, resultCount: number, taskId?: string | undefined, cwd?: string | undefined) => Promise<number>
```

### `trackSkillInjection`

Track skill injection with tokens.

```typescript
(skillName: string, tier: number, tokens: number, taskId?: string | undefined, cwd?: string | undefined) => Promise<void>
```

### `trackPromptBuild`

Track final prompt size.

```typescript
(prompt: string, taskId: string, skillsUsed: string, cwd?: string | undefined) => Promise<number>
```

### `trackSpawnOutput`

Track subagent output tokens.

```typescript
(taskId: string, outputText: string, sessionId?: string | undefined, cwd?: string | undefined) => Promise<number>
```

### `trackSpawnComplete`

Track complete spawn cycle (prompt + output).

```typescript
(taskId: string, promptTokens: number, outputTokens: number, sessionId?: string | undefined, cwd?: string | undefined) => Promise<number>
```

### `startTokenSession`

Start tracking tokens for a session.

```typescript
(sessionId: string, cwd?: string | undefined) => Promise<void>
```

### `endTokenSession`

End token tracking session with summary.

```typescript
(cwd?: string | undefined) => Promise<TokenSessionSummary | null>
```

### `getTokenSummary`

Get token usage summary for a time period.

```typescript
(days?: number, cwd?: string | undefined) => Record<string, unknown>
```

### `compareManifestVsFull`

Compare manifest vs full file token usage strategies.

```typescript
(manifestEntries: number) => Record<string, unknown>
```

### `getTrackingStatus`

Get tracking status.

```typescript
() => { tracking_enabled: boolean; env_var: string; }
```

### `computeChecksum`

Compute SHA-256 checksum of a file.

```typescript
(filePath: string) => Promise<string>
```

**Parameters:**

- `filePath` — Path to the file

**Returns:** Hex-encoded SHA-256 checksum  T4728

### `verifyBackup`

Verify that a backup file matches the source file and is a valid SQLite database.  Performs three checks: 1. Computes SHA-256 checksum of both files 2. Compares checksums to detect any content differences 3. Verifies the backup can be opened as a valid SQLite database

```typescript
(sourcePath: string, backupPath: string) => Promise<VerificationResult>
```

**Parameters:**

- `sourcePath` — Path to the source database file
- `backupPath` — Path to the backup file

**Returns:** VerificationResult with checksums and validity status  T4728

### `compareChecksums`

Quick checksum comparison without SQLite verification. Use when you only need to compare file contents.

```typescript
(filePath1: string, filePath2: string) => Promise<boolean>
```

**Parameters:**

- `filePath1` — First file path
- `filePath2` — Second file path

**Returns:** true if checksums match, false otherwise  T4728

### `createMigrationLogger`

Create a migration logger for the given cleo directory. Convenience function for functional programming style.

```typescript
(cleoDir: string, config?: MigrationLoggerConfig | undefined) => MigrationLogger
```

### `readMigrationLog`

Read and parse a migration log file.

```typescript
(logPath: string) => MigrationLogEntry[]
```

### `logFileExists`

Check if a log file exists and is readable.

```typescript
(logPath: string) => boolean
```

### `getLatestMigrationLog`

Get the most recent migration log file for a cleo directory.

```typescript
(cleoDir: string) => string | null
```

### `checkStorageMigration`

Check whether legacy JSON data needs to be migrated to SQLite.  Returns a diagnostic result that callers can use to warn users. This function is read-only and never modifies any files.

```typescript
(cwd?: string | undefined) => PreflightResult
```

### `createMigrationState`

Create initial migration state at the start of migration.  Captures source file checksums and initializes progress tracking. Uses atomic write pattern to ensure state is never in an inconsistent state.

```typescript
(cleoDir: string, sourceFiles?: { todoJson?: SourceFileInfo | undefined; sessionsJson?: SourceFileInfo | undefined; archiveJson?: SourceFileInfo | undefined; } | undefined) => Promise<...>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory
- `sourceFiles` — Optional pre-computed source file info

**Returns:** The created migration state  T4726

### `updateMigrationState`

Update migration state with partial updates.  Merges updates with existing state and writes atomically. Automatically adds timestamp to phase transitions.

```typescript
(cleoDir: string, updates: Partial<MigrationState>) => Promise<MigrationState>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory
- `updates` — Partial state updates to apply

**Returns:** The updated migration state  T4726

### `updateMigrationPhase`

Update just the migration phase. Convenience wrapper for common phase transition.

```typescript
(cleoDir: string, phase: MigrationPhase) => Promise<MigrationState>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory
- `phase` — New phase

**Returns:** The updated migration state  T4726

### `updateMigrationProgress`

Update progress counters during import.

```typescript
(cleoDir: string, progress: Partial<MigrationProgress>) => Promise<MigrationState>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory
- `progress` — Progress updates (only changed counters needed)

**Returns:** The updated migration state  T4726

### `addMigrationError`

Add an error to the migration state.

```typescript
(cleoDir: string, error: string) => Promise<MigrationState>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory
- `error` — Error message

**Returns:** The updated migration state  T4726

### `addMigrationWarning`

Add a warning to the migration state.

```typescript
(cleoDir: string, warning: string) => Promise<MigrationState>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory
- `warning` — Warning message

**Returns:** The updated migration state  T4726

### `loadMigrationState`

Load existing migration state.

```typescript
(cleoDir: string) => Promise<MigrationState | null>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory

**Returns:** Migration state, or null if no state file exists  T4726

### `isMigrationInProgress`

Check if a migration is in progress.

```typescript
(cleoDir: string) => Promise<boolean>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory

**Returns:** true if migration state exists and is not complete/failed  T4726

### `canResumeMigration`

Check if migration can be resumed.

```typescript
(cleoDir: string) => Promise<{ canResume: boolean; phase: MigrationPhase; progress: MigrationProgress; errors: string[]; } | null>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory

**Returns:** Object with resume info, or null if cannot resume  T4726

### `completeMigration`

Mark migration as complete.

```typescript
(cleoDir: string) => Promise<MigrationState>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory

**Returns:** The completed migration state  T4726

### `failMigration`

Mark migration as failed with error details.

```typescript
(cleoDir: string, error: string) => Promise<MigrationState>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory
- `error` — Primary error message

**Returns:** The failed migration state  T4726

### `clearMigrationState`

Clear migration state file. Safe to call even if state doesn't exist.

```typescript
(cleoDir: string) => Promise<void>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory  T4726

### `getMigrationSummary`

Get a summary of migration state for display.

```typescript
(cleoDir: string) => Promise<string | null>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory

**Returns:** Human-readable summary, or null if no state  T4726

### `verifySourceIntegrity`

Verify source files haven't changed since migration started.  Compares current checksums with stored checksums to detect if source files were modified during migration.

```typescript
(cleoDir: string) => Promise<{ valid: boolean; changed: string[]; missing: string[]; }>
```

**Parameters:**

- `cleoDir` — Path to .cleo directory

**Returns:** Object with verification results  T4726

### `validateSourceFiles`

Validate all JSON source files before migration.  This function MUST be called BEFORE any destructive database operations. It checks that all JSON files are parseable and contain expected data.

```typescript
(cleoDir: string) => JsonValidationResult
```

**Parameters:**

- `cleoDir` — Path to the .cleo directory

**Returns:** Validation result with details for each file  T4725

### `formatValidationResult`

Format validation result for human-readable output.

```typescript
(result: JsonValidationResult) => string
```

**Parameters:**

- `result` — Validation result

**Returns:** Formatted string

### `checkTaskCountMismatch`

Check for task count mismatch between existing database and JSON.  This helps detect cases where the database has data but JSON is empty (indicating a potential configuration or path issue).

```typescript
(cleoDir: string, jsonTaskCount: number) => string | null
```

**Parameters:**

- `cleoDir` — Path to .cleo directory
- `jsonTaskCount` — Number of tasks found in JSON

**Returns:** Warning message if mismatch detected, null otherwise

### `detectVersion`

Detect schema version from a data file.  T4468

```typescript
(data: unknown) => string
```

### `compareSemver`

Compare two version strings (X.Y.Z format, works for both semver and CalVer). Returns -1 if a  b, 0 if equal, 1 if a  b.  T4468

```typescript
(a: string, b: string) => number
```

### `getMigrationStatus`

Get migration status for all data files.  T4468

```typescript
(cwd?: string | undefined) => Promise<MigrationStatus>
```

### `runMigration`

Run migrations on a data file.  T4468

```typescript
(fileType: string, options?: { dryRun?: boolean | undefined; }, cwd?: string | undefined) => Promise<MigrationResult>
```

### `runAllMigrations`

Run all pending migrations.  T4468

```typescript
(options?: { dryRun?: boolean | undefined; }, cwd?: string | undefined) => Promise<MigrationResult[]>
```

### `invalidateGraphCache`

Invalidate the in-memory graph cache.

```typescript
() => void
```

### `buildGlobalGraph`

Build the global dependency graph from all registered projects. Uses checksum-based caching to avoid unnecessary rebuilds.

```typescript
() => Promise<NexusGlobalGraph>
```

### `nexusDeps`

Show dependencies for a task across projects. Supports forward (what this depends on) and reverse (what depends on this) lookups.

```typescript
(taskQuery: string, direction?: "forward" | "reverse") => Promise<DepsResult>
```

### `resolveCrossDeps`

Resolve an array of dependencies (local or cross-project).

```typescript
(depsArray: string[], sourceProject: string) => Promise<DepsEntry[]>
```

### `criticalPath`

Calculate the critical path across project boundaries. Returns the longest dependency chain in the global graph.

```typescript
() => Promise<CriticalPathResult>
```

### `blockingAnalysis`

Analyze the blocking impact of a task across all projects. Uses BFS to find all direct and transitive dependents.

```typescript
(taskQuery: string) => Promise<BlockingAnalysisResult>
```

### `orphanDetection`

Detect orphaned cross-project dependencies. Finds tasks with dependency references to projects or tasks that don't exist.

```typescript
() => Promise<OrphanEntry[]>
```

### `compareLevels`

Compare two pino levels numerically. Returns negative if a  b, 0 if equal, positive if a  b.

```typescript
(a: PinoLevel, b: PinoLevel) => number
```

### `matchesFilter`

Check if a single entry matches the filter criteria. All specified fields must match (AND logic).

```typescript
(entry: PinoLogEntry, filter: LogFilter) => boolean
```

### `filterEntries`

Filter an array of parsed log entries against criteria. Returns entries matching ALL specified criteria (AND logic). Does not apply pagination (limit/offset) -- use paginate() for that.

```typescript
(entries: PinoLogEntry[], filter: LogFilter) => PinoLogEntry[]
```

### `paginate`

Apply pagination (limit/offset) to a result set.

```typescript
(entries: PinoLogEntry[], limit?: number | undefined, offset?: number | undefined) => PinoLogEntry[]
```

### `isValidLevel`

Validate that a string is a valid PinoLevel.

```typescript
(level: string) => level is PinoLevel
```

### `parseLogLine`

Parse a single JSONL line into a PinoLogEntry. Returns null for empty lines, non-JSON, or lines missing required fields.

```typescript
(line: string) => PinoLogEntry | null
```

### `parseLogLines`

Parse multiple JSONL lines into PinoLogEntry array. Skips malformed lines.

```typescript
(lines: string[]) => PinoLogEntry[]
```

### `getProjectLogDir`

Get the project log directory path. Uses getLogDir() from logger if available, falls back to config-based resolution.

```typescript
(cwd?: string | undefined) => string | null
```

### `getGlobalLogDir`

Get the global log directory path (~/.cleo/logs/).

```typescript
() => string
```

### `discoverLogFiles`

Discover all log files in the specified scope. Returns file info sorted by date (newest first).

```typescript
(options?: LogDiscoveryOptions | undefined, cwd?: string | undefined) => LogFileInfo[]
```

### `readLogFileLines`

Read all lines from a log file synchronously. Returns raw JSON strings (one per line). Suitable for small-to-medium files.

```typescript
(filePath: string) => string[]
```

### `streamLogFileLines`

Create an async iterable over lines of a log file. Suitable for large files -- does not load entire file into memory.

```typescript
(filePath: string) => AsyncGenerator<string, any, any>
```

### `queryLogs`

High-level query: discover files, parse, filter, paginate. Convenience wrapper combining all three layers.

```typescript
(filter?: LogFilter | undefined, options?: LogDiscoveryOptions | undefined, cwd?: string | undefined) => LogQueryResult
```

### `streamLogs`

Stream-based query for large log datasets. Yields matching entries one at a time. Respects limit. Does not support offset (streaming is forward-only).

```typescript
(filter?: LogFilter | undefined, options?: LogDiscoveryOptions | undefined, cwd?: string | undefined) => AsyncGenerator<PinoLogEntry, any, any>
```

### `getLogSummary`

Get a summary of log activity (counts by level, date range, subsystems). Reads all discovered files but does not return individual entries.

```typescript
(options?: LogDiscoveryOptions | undefined, cwd?: string | undefined) => LogSummary
```

### `getOtelStatus`

Get token tracking status.

```typescript
() => Promise<Record<string, unknown>>
```

### `getOtelSummary`

Get combined token usage summary.

```typescript
() => Promise<Record<string, unknown>>
```

### `getOtelSessions`

Get session-level token data.

```typescript
(opts: { session?: string | undefined; task?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `getOtelSpawns`

Get spawn-level token data.

```typescript
(opts: { task?: string | undefined; epic?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `getRealTokenUsage`

Get real token usage from Claude Code API.

```typescript
(_opts: { session?: string | undefined; since?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `clearOtelData`

Clear token tracking data with backup.

```typescript
() => Promise<Record<string, unknown>>
```

### `listPhases`

List all phases with status summaries.  T5326

```typescript
(projectRoot: string, accessor?: DataAccessor | undefined) => Promise<{ success: boolean; data?: ListPhasesResult | undefined; error?: { code: string; message: string; } | undefined; }>
```

### `showPhase`

Show phase details by slug or current phase.  T5326

```typescript
(projectRoot: string, phaseId?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ success: boolean; data?: ShowPhaseResult | undefined; error?: { ...; } | undefined; }>
```

### `getCurrentBranch`

Get the current branch name in .cleo/.git.  T4884

```typescript
(cwd?: string | undefined) => Promise<string>
```

### `addRemote`

Add a git remote to .cleo/.git.  T4884

```typescript
(url: string, name?: string, cwd?: string | undefined) => Promise<void>
```

### `removeRemote`

Remove a git remote from .cleo/.git.  T4884

```typescript
(name?: string, cwd?: string | undefined) => Promise<void>
```

### `listRemotes`

List configured remotes in .cleo/.git.  T4884

```typescript
(cwd?: string | undefined) => Promise<RemoteInfo[]>
```

### `push`

Push .cleo/.git to a remote.  T4884

```typescript
(remote?: string, options?: { force?: boolean | undefined; setUpstream?: boolean | undefined; } | undefined, cwd?: string | undefined) => Promise<PushResult>
```

### `pull`

Pull from a remote into .cleo/.git. Uses rebase strategy to maintain clean history.  T4884

```typescript
(remote?: string, cwd?: string | undefined) => Promise<PullResult>
```

### `getSyncStatus`

Get the sync status between local .cleo/.git and remote.  T4884

```typescript
(remote?: string, cwd?: string | undefined) => Promise<{ ahead: number; behind: number; branch: string; remote: string; }>
```

### `getRoadmap`

Get roadmap from pending epics and CHANGELOG history.

```typescript
(opts: { includeHistory?: boolean | undefined; upcomingOnly?: boolean | undefined; cwd?: string | undefined; }, accessor?: DataAccessor | undefined) => Promise<Record<string, unknown>>
```

### `getOperationMode`

Lookup the execution mode for a specific operation

```typescript
(domain: string, operation: string, gateway: GatewayType) => ExecutionMode | undefined
```

### `canRunNatively`

Check if an operation can run natively (without CLI)

```typescript
(domain: string, operation: string, gateway: GatewayType) => boolean
```

### `requiresCLI`

Check if an operation requires CLI

```typescript
(domain: string, operation: string, gateway: GatewayType) => boolean
```

### `getNativeOperations`

Get all native-capable operations for a domain

```typescript
(domain: string) => OperationCapability[]
```

### `generateCapabilityReport`

Generate a capability report for system.doctor

```typescript
() => CapabilityReport
```

### `getCapabilityMatrix`

Get the full capability matrix (for testing/introspection)

```typescript
() => readonly OperationCapability[]
```

### `findHighestId`

Find the highest existing task ID number

```typescript
(existingIds: Set<string>) => number
```

### `generateNextIdFromSet`

Generate the next ID given an explicit set of existing IDs. Useful when caller has already loaded task data.

```typescript
(existingIds: Set<string>) => string
```

### `isValidTaskId`

Validate that a task ID matches the expected format

```typescript
(id: string) => boolean
```

### `normalizeTaskId`

Normalize a task ID input to canonical T#### format.  Accepts various loose formats (lowercase prefix, bare digits, underscore-suffixed descriptors) and returns the canonical form, or null if the input cannot be parsed as a task ID.

```typescript
(input: unknown) => string | null
```

### `sanitizeTaskId`

Sanitize and validate a task ID

```typescript
(value: unknown) => string
```

### `sanitizePath`

Sanitize and validate a file path

```typescript
(path: string, projectRoot: string) => string
```

### `sanitizeContent`

Sanitize content string

```typescript
(content: string, maxLength?: number) => string
```

### `validateEnum`

Validate that a value is in an allowed enum set

```typescript
(value: string, allowed: string[], fieldName: string) => string
```

### `ensureArray`

Normalize a value to an array of strings. Handles MCP clients sending comma-separated strings where arrays are expected.

```typescript
(value: unknown, separator?: string) => string[] | undefined
```

### `sanitizeParams`

Sanitize all params in a request before routing

```typescript
(params: Record<string, unknown> | undefined, projectRoot?: string | undefined, context?: { domain?: string | undefined; operation?: string | undefined; } | undefined) => Record<...> | undefined
```

### `createTransport`

Create an AgentTransport instance based on configuration.  Returns SignalDockTransport if signaldock is enabled, otherwise returns ClaudeCodeTransport as the default.

```typescript
(config?: TransportFactoryConfig | undefined) => AgentTransport
```

### `getSkillSearchPaths`

Build the CAAMP skill search paths in priority order. Uses CAAMP's canonical path functions for standard locations.  T4516

```typescript
(cwd?: string | undefined) => SkillSearchPath[]
```

### `getSkillsDir`

Get the primary skills directory (app-embedded).  T4516

```typescript
(cwd?: string | undefined) => string
```

### `getSharedDir`

Get the shared skills resources directory.  T4516

```typescript
(cwd?: string | undefined) => string
```

### `mapSkillName`

Map a user-friendly skill name to the canonical ct-prefixed directory name. Supports: UPPER-CASE, lower-case, with/without ct- prefix.  T4516

```typescript
(input: string) => { canonical: string; mapped: boolean; }
```

### `listCanonicalSkillNames`

List all known canonical skill names (unique values from the map).  T4516

```typescript
() => string[]
```

### `parseFrontmatter`

Parse YAML-like frontmatter from a SKILL.md file. Handles the --- delimited header with key: value pairs.  T4516

```typescript
(content: string) => SkillFrontmatter
```

### `discoverSkill`

Discover a single skill from a directory. Tries CAAMP's parseSkillFile first, falls back to local parsing.  T4516

```typescript
(skillDir: string) => Skill | null
```

### `discoverSkillsInDir`

Discover all skills in a single directory. Scans for subdirectories containing SKILL.md.  T4516

```typescript
(dir: string) => Skill[]
```

### `discoverAllSkills`

Discover all skills across CAAMP search paths. Returns skills in priority order (earlier paths take precedence).  T4516

```typescript
(cwd?: string | undefined) => Skill[]
```

### `findSkill`

Find a specific skill by name across all search paths.  T4516

```typescript
(name: string, cwd?: string | undefined) => Skill | null
```

### `toSkillSummary`

Convert a Skill to a lightweight SkillSummary.  T4516

```typescript
(skill: Skill) => SkillSummary
```

### `generateManifest`

Generate a skill manifest from discovered skills.  T4516

```typescript
(cwd?: string | undefined) => SkillManifest
```

### `resolveTemplatePath`

Resolve a skill template path (SKILL.md) by name.  T4516

```typescript
(name: string, cwd?: string | undefined) => string | null
```

### `getAgentsDir`

Get the agents directory path.  T4518

```typescript
(cwd?: string | undefined) => string
```

### `parseAgentConfig`

Parse an AGENT.md file into an AgentConfig. AGENT.md uses the same YAML frontmatter format as SKILL.md.  T4518

```typescript
(agentDir: string) => AgentConfig | null
```

### `loadAgentConfig`

Load agent configuration by name. Searches in the agents/ directory.  T4518

```typescript
(agentName: string, cwd?: string | undefined) => AgentConfig | null
```

### `getSubagentConfig`

Get the cleo-subagent configuration (universal executor).  T4518

```typescript
(cwd?: string | undefined) => AgentConfig | null
```

### `agentExists`

Check if an agent definition exists.  T4518

```typescript
(agentName: string, cwd?: string | undefined) => boolean
```

### `installAgent`

Install a single agent via symlink.  T4518

```typescript
(agentDir: string) => { installed: boolean; path: string; error?: string | undefined; }
```

### `installAllAgents`

Install all agents from the project agents/ directory.  T4518

```typescript
(cwd?: string | undefined) => { name: string; installed: boolean; error?: string | undefined; }[]
```

### `uninstallAgent`

Uninstall a single agent by removing its symlink.  T4518

```typescript
(agentName: string) => boolean
```

### `getRegistryPath`

Get the agent registry file path.  T4518

```typescript
() => string
```

### `readRegistry`

Read the agent registry, creating if needed.  T4518

```typescript
() => AgentRegistry
```

### `saveRegistry`

Save the agent registry.  T4518

```typescript
(registry: AgentRegistry) => void
```

### `registerAgent`

Register an agent in the registry.  T4518

```typescript
(name: string, path: string, config: AgentConfig) => AgentRegistryEntry
```

### `unregisterAgent`

Unregister an agent from the registry.  T4518

```typescript
(name: string) => boolean
```

### `getAgent`

Get an agent from the registry by name.  T4518

```typescript
(name: string) => AgentRegistryEntry | null
```

### `listAgents`

List all registered agents.  T4518

```typescript
() => AgentRegistryEntry[]
```

### `syncRegistry`

Scan the agents/ directory and register all found agents.  T4518

```typescript
(cwd?: string | undefined) => { added: string[]; removed: string[]; unchanged: string[]; }
```

### `loadPlaceholders`

Load token definitions from placeholders.json.  T4521

```typescript
(cwd?: string | undefined) => PlaceholdersConfig | null
```

### `buildDefaults`

Build the full default values map (merging placeholders.json with hardcoded defaults).  T4521

```typescript
(cwd?: string | undefined) => TokenValues
```

### `validateTokenValue`

Validate a single token value against its pattern.  T4521

```typescript
(token: string, value: string) => { valid: boolean; error?: string | undefined; }
```

### `validateRequired`

Validate all required tokens are present and valid.  T4521

```typescript
(values: TokenValues) => { valid: boolean; missing: string[]; invalid: { token: string; error: string; }[]; }
```

### `validateAllTokens`

Validate all tokens in a values map (required + optional).  T4521

```typescript
(values: TokenValues) => { valid: boolean; errors: { token: string; error: string; }[]; }
```

### `injectTokens`

Inject token values into a template string. Replaces all TOKEN_NAME patterns with corresponding values. Unresolved tokens are left as-is (for debugging).  T4521

```typescript
(template: string, values: TokenValues) => string
```

### `hasUnresolvedTokens`

Check if a template has unresolved tokens after injection.  T4521

```typescript
(content: string) => string[]
```

### `loadAndInject`

Load a skill template and inject tokens.  T4521

```typescript
(templatePath: string, values: TokenValues) => { content: string; unresolvedTokens: string[]; }
```

### `setFullContext`

Build a complete TokenValues map from a task, resolving all standard tokens. Ports ti_set_full_context from lib/skills/token-inject.sh.  This is the primary entry point for orchestrators to prepare token values before spawning subagents. It populates: TASK_ID, DATE, TOPIC_SLUG, EPIC_ID, TITLE, TASK_TITLE, TASK_DESCRIPTION, TOPICS_JSON, DEPENDS_LIST, RESEARCH_ID, OUTPUT_DIR, MANIFEST_PATH, and all command defaults.   T4712  T4663

```typescript
(task: { id: string; title: string; description?: string | undefined; parentId?: string | undefined; labels?: string[] | undefined; depends?: string[] | undefined; }, options?: { date?: string | undefined; topicSlug?: string | undefined; outputDir?: string | undefined; manifestPath?: string | undefined; } | undefine...
```

### `autoDispatch`

Auto-dispatch a task to the most appropriate skill. Tries strategies in priority order: label - catalog - type - keyword - fallback.  T4517

```typescript
(task: Task, cwd?: string | undefined) => DispatchResult
```

### `dispatchExplicit`

Dispatch with explicit skill override. Verifies the skill exists before returning.  T4517

```typescript
(skillName: string, cwd?: string | undefined) => DispatchResult | null
```

### `getProtocolForDispatch`

Get the protocol type for a dispatch result.  T4517

```typescript
(result: DispatchResult) => SkillProtocolType | null
```

### `prepareSpawnContext`

Prepare spawn context for a dispatched skill. Returns the skill name and protocol needed for token injection.  T4517

```typescript
(task: Task, overrideSkill?: string | undefined, cwd?: string | undefined) => { skill: string; protocol: SkillProtocolType | null; dispatch: DispatchResult; }
```

### `prepareSpawnMulti`

Compose multiple skills into a single prompt with progressive disclosure. Ports skill_prepare_spawn_multi from lib/skills/skill-dispatch.sh.  The first skill is loaded fully (primary). Secondary skills use progressive disclosure (frontmatter + first section only) to save context budget.   T4712  T4663

```typescript
(skillNames: string[], tokenValues: Record<string, string>, cwd?: string | undefined) => MultiSkillComposition
```

### `loadProtocolBase`

Load the subagent protocol base content.  T4521

```typescript
(cwd?: string | undefined) => string | null
```

### `buildTaskContext`

Build task context block for injection into a subagent prompt.  T4521

```typescript
(taskId: string, cwd?: string | undefined) => string
```

### `filterProtocolByTier`

Filter protocol content by MVI tier. Extracts sections based on !-- TIER:X -- markers. - tier 0: header + minimal only + footer - tier 1: header + minimal + standard + footer - tier 2: header + all tiers + footer (full content)  Header = content before first TIER marker. Footer = content after last /TIER marker.   T5155

```typescript
(content: string, tier: 0 | 1 | 2) => string
```

### `injectProtocol`

Inject the subagent protocol into skill content. Composes: skill content + protocol base + task context.  T4521

```typescript
(skillContent: string, taskId: string, tokenValues: TokenValues, cwd?: string | undefined, tier?: 0 | 1 | 2 | undefined) => string
```

### `orchestratorSpawnSkill`

Full orchestrator spawn workflow (skill-based). High-level function that loads the skill, injects protocol, and returns the prompt.  T4521

```typescript
(taskId: string, skillName: string, tokenValues: TokenValues, cwd?: string | undefined, tier?: 0 | 1 | 2 | undefined) => string
```

### `prepareTokenValues`

Prepare standard token values for a task spawn.  T4521

```typescript
(taskId: string, topicSlug: string, epicId?: string | undefined, _cwd?: string | undefined) => TokenValues
```

### `installSkill`

Install a single skill via CAAMP.

```typescript
(skillName: string, projectDir?: string | undefined) => Promise<{ installed: boolean; path: string; error?: string | undefined; }>
```

### `generateContributionId`

Generate a unique contribution ID.  T4520

```typescript
(taskId: string) => string
```

### `validateContributionTask`

Validate that a task is suitable for contribution protocol.  T4520

```typescript
(taskId: string, cwd?: string | undefined) => { valid: boolean; issues: string[]; }
```

### `getContributionInjection`

Generate the contribution injection block for a subagent prompt.  T4520

```typescript
(taskId: string, protocolPath?: string | undefined, _cwd?: string | undefined) => string
```

### `detectConflicts`

Detect conflicts between two sets of decisions.  T4520

```typescript
(decisions1: ContributionDecision[], decisions2: ContributionDecision[]) => ContributionConflict[]
```

### `computeConsensus`

Compute weighted consensus from multiple agent decisions.  T4520

```typescript
(decisions: ContributionDecision[], weights?: Record<string, number> | undefined) => ConsensusResult
```

### `createContributionManifestEntry`

Create a manifest entry for a contribution.  T4520

```typescript
(taskId: string, contributionId: string, decisions: ContributionDecision[]) => ManifestEntry
```

### `ensureOutputs`

Ensure agent outputs directory and manifest file exist.  T4520

```typescript
(cwd?: string | undefined) => { created: string[]; }
```

### `readManifest`

Read all manifest entries.  T4520

```typescript
(cwd?: string | undefined) => ManifestEntry[]
```

### `appendManifest`

Append a manifest entry (atomic JSONL append).  T4520

```typescript
(entry: ManifestEntry, cwd?: string | undefined) => void
```

### `findEntry`

Find a manifest entry by ID.  T4520

```typescript
(id: string, cwd?: string | undefined) => ManifestEntry | null
```

### `filterEntries`

Filter manifest entries by criteria.  T4520

```typescript
(criteria: { status?: string | undefined; agentType?: string | undefined; topic?: string | undefined; linkedTask?: string | undefined; actionable?: boolean | undefined; }, cwd?: string | undefined) => ManifestEntry[]
```

### `getPendingFollowup`

Get entries with pending follow-ups.  T4520

```typescript
(cwd?: string | undefined) => ManifestEntry[]
```

### `getFollowupTaskIds`

Get unique follow-up task IDs from all manifest entries.  T4520

```typescript
(cwd?: string | undefined) => string[]
```

### `taskHasResearch`

Check if a task has linked research.  T4520

```typescript
(taskId: string, cwd?: string | undefined) => { hasResearch: boolean; count: number; }
```

### `archiveEntry`

Archive a manifest entry (move to archive status).  T4520

```typescript
(entryId: string, cwd?: string | undefined) => boolean
```

### `rotateManifest`

Rotate manifest by archiving old entries.  T4520

```typescript
(maxEntries?: number, cwd?: string | undefined) => number
```

### `isCacheFresh`

Check if the cached manifest is fresh (within TTL).  T4520

```typescript
(cachePath?: string | undefined) => boolean
```

### `invalidateCache`

Invalidate the cache (delete the cached manifest).  T4520

```typescript
() => void
```

### `resolveManifest`

Resolve the skills manifest. Returns a cached version if fresh, otherwise generates a new one.  Graceful degradation:   1. Fresh cached manifest (within TTL)   2. Stale cached manifest (expired but valid)   3. Embedded project manifest (skills/manifest.json)   4. Freshly generated manifest   T4520

```typescript
(cwd?: string | undefined) => SkillManifest
```

### `regenerateCache`

Force regenerate the cache.  T4520

```typescript
(cwd?: string | undefined) => SkillManifest
```

### `loadConfig`

Load SkillsMP configuration from skillsmp.json.  T4521

```typescript
(cwd?: string | undefined) => SkillsMpConfig | null
```

### `searchSkills`

Search the skills marketplace. Delegates to CAAMP's searchSkills for the actual API call.  T4521

```typescript
(query: string, _config?: SkillsMpConfig | undefined) => Promise<MarketplaceSkill[]>
```

### `getSkill`

Get a specific skill from the marketplace. Uses CAAMP's MarketplaceClient for retrieval.  T4521

```typescript
(skillId: string, _config?: SkillsMpConfig | undefined) => Promise<MarketplaceSkill | null>
```

### `isEnabled`

Check if the marketplace is enabled and reachable.  T4521

```typescript
(cwd?: string | undefined) => boolean
```

### `buildPrompt`

Build a fully-resolved prompt for spawning a subagent.  T4519

```typescript
(taskId: string, templateName?: string, cwd?: string | undefined, tier?: 0 | 1 | 2 | undefined) => SpawnPromptResult
```

### `spawn`

Generate full spawn command with metadata.  T4519

```typescript
(taskId: string, templateName?: string, cwd?: string | undefined, tier?: 0 | 1 | 2 | undefined) => SpawnPromptResult & { spawnTimestamp: string; }
```

### `canParallelize`

Check if tasks can be spawned in parallel (no inter-dependencies).  T4519

```typescript
(taskIds: string[], cwd?: string | undefined) => { canParallelize: boolean; conflicts: (Pick<Task, "id"> & { dependsOn: string[]; })[]; safeToSpawn: string[]; }
```

### `spawnBatch`

Spawn prompts for multiple tasks in a batch. Ports orchestrator_spawn_batch from lib/skills/orchestrator-spawn.sh.  Iterates over task IDs, building spawn prompts for each. Individual failures are captured per-entry rather than aborting the entire batch.   T4712  T4663

```typescript
(taskIds: string[], templateName?: string | undefined, cwd?: string | undefined, tier?: 0 | 1 | 2 | undefined) => BatchSpawnResult
```

### `getThresholds`

Get orchestrator context thresholds from config or defaults.  T4519

```typescript
(config?: Record<string, unknown> | undefined) => OrchestratorThresholds
```

### `getContextState`

Read the current context state from session-aware files.  T4519

```typescript
(sessionId?: string | undefined, cwd?: string | undefined) => ContextState
```

### `sessionInit`

Initialize orchestrator session state. Determines the recommended action based on current state.  T4519

```typescript
(_epicId?: string | undefined, cwd?: string | undefined) => Promise<SessionInitResult>
```

### `shouldPause`

Check if orchestrator should pause based on context usage.  T4519

```typescript
(config?: Record<string, unknown> | undefined, sessionId?: string | undefined, cwd?: string | undefined) => PauseStatus
```

### `analyzeDependencies`

Analyze dependency graph and compute execution waves.  T4519

```typescript
(epicId: string, cwd?: string | undefined) => Promise<DependencyAnalysis>
```

### `getNextTask`

Get the next task ready to spawn for an epic.  T4519

```typescript
(epicId: string, cwd?: string | undefined) => Promise<{ task: Task | null; readyCount: number; }>
```

### `getReadyTasks`

Get all tasks ready to spawn in parallel (no inter-dependencies).  T4519

```typescript
(epicId: string, cwd?: string | undefined) => Promise<TaskRefPriority[]>
```

### `generateHitlSummary`

Generate a Human-in-the-Loop summary for session handoff.  T4519

```typescript
(epicId?: string | undefined, stopReason?: string, cwd?: string | undefined) => Promise<HitlSummary>
```

### `validateSubagentOutput`

Validate a subagent's manifest entry for protocol compliance.  T4519

```typescript
(researchId: string, cwd?: string | undefined) => { passed: boolean; issues: string[]; checkedRules: string[]; }
```

### `validateManifestIntegrity`

Validate the entire manifest file integrity.  T4519

```typescript
(cwd?: string | undefined) => ManifestValidationResult
```

### `verifyCompliance`

Verify previous agent completed protocol compliance before spawning next.  T4519

```typescript
(previousTaskId: string, researchId?: string | undefined, cwd?: string | undefined) => ComplianceResult
```

### `validateOrchestratorCompliance`

Validate orchestrator compliance (post-hoc behavioral checks).  T4519

```typescript
(epicId?: string | undefined, cwd?: string | undefined) => { compliant: boolean; violations: string[]; warnings: string[]; }
```

### `getSkillSearchPaths`

Get ordered skill search paths based on configuration.  Priority: 1. CLEO_SKILL_PATH entries (colon-separated, explicit overrides) 2. Source-determined paths based on CLEO_SKILL_SOURCE  CLEO_SKILL_SOURCE modes: - auto: CAAMP canonical + embedded (default) - caamp: CAAMP canonical only - embedded: Project embedded only   T4552

```typescript
(projectRoot?: string | undefined) => SkillSearchPath[]
```

### `resolveSkillPath`

Resolve a skill directory containing SKILL.md. Searches all paths from getSkillSearchPaths() in priority order. First match wins.   T4552

```typescript
(skillName: string, projectRoot?: string | undefined) => string | null
```

### `resolveProtocolPath`

Resolve a protocol .md file.  Search order per base path: 1. base/_ct-skills-protocols/protocol_name.md (Strategy B shared dir) 2. PROJECT_ROOT/src/protocols/protocol_name.md (legacy embedded fallback)   T4552

```typescript
(protocolName: string, projectRoot?: string | undefined) => string | null
```

### `resolveSharedPath`

Resolve a shared resource .md file.  Search order per base path: 1. base/_ct-skills-shared/resource_name.md (Strategy B shared dir) 2. base/_shared/resource_name.md (legacy embedded layout)   T4552

```typescript
(resourceName: string, projectRoot?: string | undefined) => string | null
```

### `getSkillSourceType`

Classify the source of a skill directory.  Determines where a skill directory lives in the search hierarchy: - "embedded": Within the project's skills/ directory - "caamp": Within the CAAMP canonical directory (~/.agents/skills) - "project-link": Symlink pointing to project directory - "global-link": Symlink pointing to CAAMP or external location   T4552

```typescript
(skillDir: string, projectRoot?: string | undefined) => SkillSourceType | null
```

### `formatIsoDate`

Format a date string in ISO 8601 format. Converts a YYYY-MM-DD date string to a full ISO 8601 timestamp.

```typescript
(inputDate: string) => string
```

**Parameters:**

- `inputDate` — Date string in YYYY-MM-DD format

**Returns:** ISO 8601 formatted string (e.g., "2026-02-03T00:00:00Z")

### `getCurrentTimestamp`

Get current timestamp in ISO 8601 format. Returns the current UTC time as an ISO 8601 string.

```typescript
() => string
```

**Returns:** Current timestamp (e.g., "2026-02-16T14:30:00Z")  T4552

### `isValidIsoDate`

Validate that a string is a valid ISO 8601 date.  T4552

```typescript
(dateStr: string) => boolean
```

### `formatDateYMD`

Format a Date object to a YYYY-MM-DD string.  T4552

```typescript
(date: Date) => string
```

### `validateSkill`

Validate a skill directory structure and content.  T4517

```typescript
(skillDir: string) => SkillValidationResult
```

### `validateSkills`

Validate multiple skills at once.  T4517

```typescript
(skillDirs: string[]) => SkillValidationResult[]
```

### `validateReturnMessage`

Validate a return message against protocol-compliant patterns.  T4517

```typescript
(message: string) => { valid: boolean; error?: string | undefined; }
```

### `getInstalledVersionAsync`

Get the installed version of a skill from CAAMP lock state.

```typescript
(name: string) => Promise<string | null>
```

### `checkSkillUpdateAsync`

Check if a specific skill needs an update via CAAMP.

```typescript
(name: string) => Promise<{ needsUpdate: boolean; currentVersion?: string | undefined; latestVersion?: string | undefined; }>
```

### `checkAllSkillUpdatesAsync`

Check all installed skills for available updates via CAAMP.

```typescript
() => Promise<{ name: string; installedVersion: string; availableVersion: string; needsUpdate: boolean; }[]>
```

### `exportSnapshot`

Export current task state to a snapshot.  T4882

```typescript
(cwd?: string | undefined) => Promise<Snapshot>
```

### `writeSnapshot`

Write a snapshot to a file.  T4882

```typescript
(snapshot: Snapshot, outputPath: string) => Promise<void>
```

### `readSnapshot`

Read a snapshot from a file.  T4882

```typescript
(inputPath: string) => Promise<Snapshot>
```

### `getDefaultSnapshotPath`

Generate a default snapshot file path.  T4882

```typescript
(cwd?: string | undefined) => string
```

### `importSnapshot`

Import a snapshot into the local task database. Uses last-write-wins strategy: if a task exists locally and in the snapshot, the snapshot version wins only if its updatedAt is newer.  T4882

```typescript
(snapshot: Snapshot, cwd?: string | undefined) => Promise<ImportResult>
```

### `getProvidersWithSpawnCapability`

Get providers by specific spawn capability  Queries CAAMP for providers that support a specific spawn capability.

```typescript
(capability: SpawnCapability) => Provider[]
```

**Parameters:**

- `capability` — The spawn capability to filter by

**Returns:** Array of providers with the specified capability

### `hasParallelSpawnProvider`

Check if any provider supports parallel spawn

```typescript
() => boolean
```

**Returns:** True if at least one provider supports parallel spawn

### `initializeSpawnAdapters`

Initialize spawn adapters dynamically from discovered adapter manifests.  Scans all discovered manifests for adapters with `capabilities.supportsSpawn`, dynamically imports their spawn provider, and bridges it into the spawn registry.  Zero hardcoded adapter names — everything derives from manifests.

```typescript
(manifests: AdapterManifest[]) => Promise<void>
```

**Parameters:**

- `manifests` — Discovered adapter manifests (from AdapterManager.discover())

**Returns:** Promise that resolves when initialization is complete

### `initializeDefaultAdapters`

Initialize the registry with default adapters.  Legacy entry point that discovers adapters from the project root and delegates to initializeSpawnAdapters(). Maintains backward compatibility for callers that don't have manifests handy.

```typescript
() => Promise<void>
```

**Returns:** Promise that resolves when initialization is complete

### `getProjectStats`

Get project statistics.

```typescript
(opts: { period?: string | undefined; verbose?: boolean | undefined; cwd?: string | undefined; }, accessor?: DataAccessor | undefined) => Promise<Record<string, unknown>>
```

### `rankBlockedTask`

Compute a ranking score for a blocked task. Higher score = more urgent = sort first.

```typescript
(task: Task, allTasks: Task[], focusTask: Task | null) => number
```

### `getDashboard`

Get project dashboard data.

```typescript
(opts: { compact?: boolean | undefined; period?: number | undefined; showCharts?: boolean | undefined; sections?: string[] | undefined; verbose?: boolean | undefined; quiet?: boolean | undefined; cwd?: string | undefined; blockedTasksLimit?: number | undefined; }, accessor?: DataAccessor | undefined) => Promise<...>
```

### `getCompletionHistory`

Get completion history data.

```typescript
(opts: { days?: number | undefined; since?: string | undefined; until?: string | undefined; cwd?: string | undefined; }) => Promise<Record<string, unknown>>
```

### `filterByDate`

Filter tasks by date range on archivedAt.

```typescript
(tasks: AnalyticsTask[], since?: string | undefined, until?: string | undefined) => AnalyticsTask[]
```

### `summaryReport`

Generate summary statistics.

```typescript
(tasks: AnalyticsTask[]) => SummaryReportData
```

### `byPhaseReport`

Group tasks by phase with cycle time averages.

```typescript
(tasks: AnalyticsTask[]) => PhaseGroupEntry[]
```

### `byLabelReport`

Group tasks by label frequency.

```typescript
(tasks: AnalyticsTask[]) => LabelFrequencyEntry[]
```

### `byPriorityReport`

Group tasks by priority with cycle time averages.

```typescript
(tasks: AnalyticsTask[]) => PriorityGroupEntry[]
```

### `cycleTimesReport`

Compute cycle time statistics with distribution buckets.

```typescript
(tasks: AnalyticsTask[]) => CycleTimesReportData
```

### `trendsReport`

Compute archive trends by day and month.

```typescript
(tasks: AnalyticsTask[]) => TrendsReportData
```

### `analyzeArchive`

Analyze archived tasks and produce a report.  This is the primary entry point for archive analytics. It loads archive data from the DataAccessor, normalizes task records, applies date filters, and delegates to the appropriate report function.

```typescript
(opts: AnalyzeArchiveOptions, accessor?: DataAccessor | undefined) => Promise<ArchiveAnalyticsResult<ArchiveReportType>>
```

### `getArchiveStats`

Get archive statistics.

```typescript
(opts: { period?: number | undefined; cwd?: string | undefined; }, accessor?: DataAccessor | undefined) => Promise<ArchiveStatsResult>
```

### `auditData`

Audit data integrity.

```typescript
(projectRoot: string, opts?: { scope?: string | undefined; fix?: boolean | undefined; } | undefined) => Promise<AuditResult>
```

### `createBackup`

Create a backup of CLEO data files.

```typescript
(projectRoot: string, opts?: { type?: string | undefined; note?: string | undefined; } | undefined) => BackupResult
```

### `restoreBackup`

Restore from a backup.

```typescript
(projectRoot: string, params: { backupId: string; force?: boolean | undefined; }) => RestoreResult
```

### `cleanupSystem`

Cleanup stale data (sessions, backups, logs).

```typescript
(projectRoot: string, params: { target: string; olderThan?: string | undefined; dryRun?: boolean | undefined; }) => Promise<CleanupResult>
```

### `writeJsonFileAtomic`

Write a JSON file atomically with backup rotation.  Pattern: write temp - backup original - rename temp to target

```typescript
<T>(filePath: string, data: T, indent?: number) => void
```

**Parameters:**

- `filePath` — Target file path
- `data` — Data to serialize as JSON
- `indent` — JSON indentation (default: 2 spaces)

### `readJsonFile`

Read a JSON file, returning parsed content or null if not found.

```typescript
<T = unknown>(filePath: string) => T | null
```

**Parameters:**

- `filePath` — Path to the JSON file

### `getDataPath`

Get the path to a CLEO data file within a project root.

```typescript
(projectRoot: string, filename: string) => string
```

**Parameters:**

- `projectRoot` — Root directory of the project
- `filename` — Filename within .cleo/ directory

### `resolveProjectRoot`

Resolve the project root directory. Checks CLEO_ROOT env, then falls back to cwd.

```typescript
() => string
```

### `withLock`

Read and write a JSON file with exclusive locking.  Acquires a cross-process lock, reads current state, applies the transform function, validates, and writes back atomically.

```typescript
<T>(filePath: string, transform: (current: T | null) => T) => Promise<T>
```

**Parameters:**

- `filePath` — File to lock and modify
- `transform` — Function that receives current data and returns new data

**Returns:** The transformed data

### `withFileLock`

Acquire a file lock and execute an operation. Unlike withLock, this doesn't read/write the file - caller manages I/O. The return type R is independent of the file content type.

```typescript
<R>(filePath: string, operation: () => R | Promise<R>) => Promise<R>
```

### `withMultiLock`

Acquire locks on multiple files in correct order. Used for operations that need to modify multiple files atomically (e.g., coordinated updates across task data and config).

```typescript
<T>(filePaths: string[], operation: () => T | Promise<T>) => Promise<T>
```

**Parameters:**

- `filePaths` — Files to lock
- `operation` — Function to execute while locks are held

### `isProjectInitialized`

Check if a CLEO project directory exists at the given path

```typescript
(projectRoot: string) => boolean
```

### `listBackups`

List backup files for a given data file

```typescript
(filePath: string) => string[]
```

### `detectPlatform`

Detect the current platform.

```typescript
() => Platform
```

### `commandExists`

Check if a command exists on PATH.

```typescript
(command: string) => boolean
```

### `requireTool`

Require a tool to be available, returning an error message if missing.

```typescript
(tool: string, installHint?: string | undefined) => { available: boolean; error?: string | undefined; }
```

### `checkRequiredTools`

Check all required tools.

```typescript
(tools: { name: string; installHint?: string | undefined; }[]) => { allAvailable: boolean; missing: string[]; }
```

### `getIsoTimestamp`

Get ISO 8601 UTC timestamp.

```typescript
() => string
```

### `isoToEpoch`

Convert ISO timestamp to epoch seconds.

```typescript
(isoTimestamp: string) => number
```

### `dateDaysAgo`

Get ISO date for N days ago.

```typescript
(days: number) => string
```

### `getFileSize`

Get file size in bytes.

```typescript
(filePath: string) => number
```

### `getFileMtime`

Get file modification time as ISO string.

```typescript
(filePath: string) => string | null
```

### `generateRandomHex`

Generate N random hex characters.

```typescript
(bytes?: number) => string
```

### `sha256`

Compute SHA-256 checksum of a string.

```typescript
(data: string) => string
```

### `createTempFilePath`

Create a temporary file path.

```typescript
(prefix?: string, suffix?: string) => string
```

### `getNodeVersionInfo`

Get Node.js version info.

```typescript
() => { version: string; major: number; minor: number; patch: number; meetsMinimum: boolean; }
```

### `getNodeUpgradeInstructions`

Get platform-specific Node.js upgrade instructions. Returns actionable install/upgrade guidance based on OS and available tools.

```typescript
() => { platform: Platform; arch: string; instructions: string[]; recommended: string; }
```

### `getSystemInfo`

Gather a snapshot of the host system.  This is the SSoT for system information. Use this instead of scattering `process.platform` / `os.type()` calls throughout the codebase.  Use cases:   - Logger base context (every log entry carries platform info)   - Error reports and issue submission   - Doctor diagnostics   - Startup health check results

```typescript
() => SystemInfo
```

### `checkCliInstallation`

T4525

```typescript
(cleoHome?: string) => CheckResult
```

### `checkCliVersion`

T4525

```typescript
(cleoHome?: string) => CheckResult
```

### `checkDocsAccessibility`

T4525

```typescript
(cleoHome?: string) => CheckResult
```

### `checkAtReferenceResolution`

T4525

```typescript
(cleoHome?: string) => CheckResult
```

### `checkAgentsMdHub`

Check that AGENTS.md exists in project root and contains the CAAMP:START marker, indicating it serves as the injection hub for CLEO protocol content.

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkRootGitignore`

Check if project root .gitignore is blocking the entire .cleo/ directory. This prevents core CLEO data from being tracked by git.  T4641  T4637

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkCleoGitignore`

Check if .cleo/.gitignore exists and matches the template.  T4700

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkVitalFilesTracked`

Check that vital CLEO configuration files are tracked by git. Only checks config files (config.json, .gitignore, project-info.json, project-context.json). SQLite databases are excluded per ADR-013.  T4700

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkCoreFilesNotIgnored`

Check that core CLEO files are not being ignored by .gitignore. Uses `git check-ignore` to detect files that would be excluded by any gitignore rule (root, .cleo/, or global). Returns critical status if any protected file is gitignored.

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkSqliteNotTracked`

Check that SQLite databases (.cleo/tasks.db) are NOT tracked by project git. Tracked SQLite files cause data loss from merge conflicts (ADR-013). Warns if tasks.db is currently tracked so the user can untrack it.  T5160

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkLegacyAgentOutputs`

Check if any legacy output directories still exist. Delegates detection to the migration/agent-outputs utility.  T4700

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkCaampMarkerIntegrity`

Verify balanced CAAMP:START/END markers in CLAUDE.md and AGENTS.md.  T5153

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkAtReferenceTargetExists`

Parse  references from AGENTS.md CAAMP block and verify each target file exists.  T5153

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkTemplateFreshness`

Compare templates/CLEO-INJECTION.md vs ~/.cleo/templates/CLEO-INJECTION.md.  T5153

```typescript
(projectRoot?: string | undefined, cleoHome?: string | undefined) => CheckResult
```

### `checkTierMarkersPresent`

Verify all 3 tier markers exist with matching close tags in deployed template.  T5153

```typescript
(cleoHome?: string | undefined) => CheckResult
```

### `checkNodeVersion`

Check that Node.js meets the minimum required version. Provides OS-specific upgrade instructions when below minimum.

```typescript
() => CheckResult
```

### `checkGlobalSchemaHealth`

Check that global schemas at ~/.cleo/schemas/ are installed and not stale. Delegates to checkGlobalSchemas() from schema-management.ts.

```typescript
(_projectRoot?: string | undefined) => CheckResult
```

### `checkNoLocalSchemas`

Warn if deprecated .cleo/schemas/ directory still exists in the project. Schemas should live in ~/.cleo/schemas/ (global), not in project directories.

```typescript
(projectRoot?: string | undefined) => CheckResult
```

### `checkJsonSchemaIntegrity`

Check that active JSON files (config.json, project-info.json, etc.) are valid against their schemas and have current schema versions.  Maps JsonFileIntegrityResult[] from checkSchemaIntegrity() into CheckResult[], then returns a single rolled-up CheckResult for the doctor summary.

```typescript
(projectDir: string) => Promise<CheckResult>
```

### `runAllGlobalChecks`

Run all global health checks and return results array.  T4525

```typescript
(cleoHome?: string | undefined, projectRoot?: string | undefined) => CheckResult[]
```

### `calculateHealthStatus`

Calculate overall status from check results. Returns: 0=passed, 50=warning, 52=critical.  T4525

```typescript
(checks: CheckResult[]) => number
```

### `getSystemHealth`

Run system health checks (SQLite-first per ADR-006).

```typescript
(projectRoot: string, opts?: { detailed?: boolean | undefined; } | undefined) => HealthResult
```

### `getSystemDiagnostics`

Run extended diagnostics with fix suggestions.

```typescript
(projectRoot: string, opts?: { checks?: string[] | undefined; } | undefined) => Promise<DiagnosticsResult>
```

### `coreDoctorReport`

Run comprehensive doctor diagnostics combining dependency checks, directory checks, data file checks, gitignore checks, and environment info.  T4795

```typescript
(projectRoot: string) => Promise<DoctorReport>
```

### `runDoctorFixes`

Run auto-fix for failed doctor checks by calling the corresponding ensure* functions. Returns a list of fix results for each attempted repair.

```typescript
(projectRoot: string) => Promise<FixResult[]>
```

### `startupHealthCheck`

Unified startup health check for MCP server and CLI entry points.  This is the single entry point for startup diagnostics. It follows a three-phase approach:  Phase 1: Global scaffold (~/.cleo/) — always auto-repaired.   The global home is CLEO infrastructure, not project data. It is safe   to create/repair unconditionally on every startup.  Phase 2: Project detection — determines if this is an initialized project.   Uses isProjectInitialized() from paths.ts as the SSoT for detection.  Phase 3: Project health — lightweight checks on the project scaffold.   If the project is initialized, runs check* functions to detect drift.   Auto-repairs safe items (missing subdirs via ensureCleoStructure).   Flags items requiring full upgrade (missing DB, config issues).  Design principles:   - SSoT: All checks delegate to scaffold.ts check* functions   - DRY: No duplicated health-check logic   - SRP: This function only diagnoses and does safe auto-repair   - Graceful: Never throws. All errors are captured as check results.   - Logged: Returns structured results for the caller to log via pino

```typescript
(projectRoot?: string | undefined) => Promise<StartupHealthResult>
```

**Parameters:**

- `projectRoot` — Absolute path to the project root (defaults to cwd)

### `generateInjection`

Generate Minimum Viable Injection (MVI) markdown.

```typescript
(projectRoot: string, accessor?: DataAccessor | undefined) => Promise<InjectGenerateResult>
```

### `getLabels`

Get all labels with counts and task IDs per label.

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<LabelsResult>
```

### `getSystemMetrics`

Get system metrics: token usage, compliance summary, session counts.

```typescript
(projectRoot: string, opts?: { scope?: string | undefined; since?: string | undefined; } | undefined, accessor?: DataAccessor | undefined) => Promise<SystemMetricsResult>
```

### `getMigrationStatus`

Check/report schema migration status.

```typescript
(projectRoot: string, opts?: { target?: string | undefined; dryRun?: boolean | undefined; } | undefined) => Promise<MigrateResult>
```

### `getRuntimeDiagnostics`

```typescript
(options?: { detailed?: boolean | undefined; } | undefined) => Promise<RuntimeDiagnostics>
```

### `safestop`

Safe stop: signal clean shutdown for agents.

```typescript
(projectRoot: string, opts?: { reason?: string | undefined; commit?: boolean | undefined; handoff?: string | undefined; noSessionEnd?: boolean | undefined; dryRun?: boolean | undefined; } | undefined) => SafestopResult
```

### `uncancelTask`

Uncancel a cancelled task (restore to pending).

```typescript
(projectRoot: string, params: { taskId: string; cascade?: boolean | undefined; notes?: string | undefined; dryRun?: boolean | undefined; }) => Promise<UncancelResult>
```

### `detectCircularDeps`

Detect circular dependencies using DFS. Returns the cycle path if found, empty array otherwise.

```typescript
(taskId: string, tasks: Task[]) => string[]
```

### `wouldCreateCycle`

Check if adding a dependency would create a cycle.

```typescript
(fromId: string, toId: string, tasks: Task[]) => boolean
```

### `getBlockedTasks`

Get tasks that are blocked (have unmet dependencies).

```typescript
(tasks: Task[]) => Task[]
```

### `getReadyTasks`

Get tasks that are ready (all dependencies met).

```typescript
(tasks: Task[]) => Task[]
```

### `getDependents`

Get tasks that depend on a given task.

```typescript
(taskId: string, tasks: Task[]) => Task[]
```

### `getDependentIds`

Get dependent IDs.

```typescript
(taskId: string, tasks: Task[]) => string[]
```

### `getUnresolvedDeps`

Get unresolved dependencies for a task (deps that are not done/cancelled).

```typescript
(taskId: string, tasks: Task[]) => string[]
```

### `validateDependencyRefs`

Validate dependencies for missing references.

```typescript
(tasks: Task[]) => DependencyError[]
```

### `validateDependencies`

Full dependency graph validation.

```typescript
(tasks: Task[]) => DependencyCheckResult
```

### `topologicalSort`

Topological sort of tasks by dependencies. Returns sorted task IDs or null if cycle detected.

```typescript
(tasks: Task[]) => string[] | null
```

### `getTransitiveBlockers`

Walk upstream recursively through a task's dependency chain. Returns all non-done/non-cancelled dependency IDs (deduplicated). Uses a visited set for cycle protection.

```typescript
(taskId: string, tasks: Task[]) => string[]
```

### `getLeafBlockers`

From the transitive blockers, return only "leaf" blockers — those whose own dependencies are all resolved (done/cancelled) or that have no dependencies at all. These are the root-cause tasks that need action first.

```typescript
(taskId: string, tasks: Task[]) => string[]
```

### `analyzeChanges`

Analyze TodoWrite state and detect changes against injected task IDs.

```typescript
(todowriteState: TodoWriteState, injectedIds: string[]) => ChangeSet
```

### `mergeTodoWriteState`

Merge TodoWrite state back to CLEO tasks.

```typescript
(options: TodoWriteMergeOptions) => Promise<TodoWriteMergeResult>
```

### `currentTask`

Show current task work state.  T4462  T4750

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<TaskCurrentResult>
```

### `startTask`

Start working on a specific task.  T4462  T4750

```typescript
(taskId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<TaskStartResult>
```

### `stopTask`

Stop working on the current task.  T4462  T4750

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ previousTask: string | null; }>
```

### `getWorkHistory`

Get task work history from session notes.  T4462  T4750

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<TaskWorkHistoryEntry[]>
```

### `parseIssueTemplates`

Parse all templates from the repo's .github/ISSUE_TEMPLATE/ directory.  Reads YAML files directly (live parse, no caching). Excludes config.yml which is the GitHub template chooser config.

```typescript
(projectRoot: string) => TemplateResult<TemplateConfig>
```

### `getTemplateForSubcommand`

Get template config for a specific subcommand (bug/feature/help).  Performs a live parse and filters to the matching template.

```typescript
(projectRoot: string, subcommand: string) => TemplateResult<IssueTemplate>
```

### `generateTemplateConfig`

Generate and cache the config as .cleo/issue-templates.json.  Performs a live parse, then writes the result using writeJsonFileAtomic.

```typescript
(projectRoot: string) => Promise<TemplateResult<TemplateConfig>>
```

### `validateLabels`

Validate that labels exist on a GitHub repo.  Compares the template labels against a list of known repo labels. Returns which labels exist and which are missing.

```typescript
(labels: string[], repoLabels: string[]) => TemplateResult<{ existing: string[]; missing: string[]; }>
```

### `getCurrentShell`

Detect the current shell.

```typescript
() => ShellType
```

### `getRcFilePath`

Get the RC file path for a shell.

```typescript
(shell?: ShellType | undefined) => string
```

### `detectAvailableShells`

Detect which shells are available on the system.

```typescript
() => ShellType[]
```

### `generateBashAliases`

Generate bash/zsh alias content.

```typescript
(cleoPath?: string | undefined) => string
```

### `generatePowershellAliases`

Generate PowerShell alias content.

```typescript
(cleoPath?: string | undefined) => string
```

### `hasAliasBlock`

Check if aliases are already injected in a file.

```typescript
(filePath: string) => boolean
```

### `getInstalledVersion`

Get the installed alias version from an RC file.

```typescript
(filePath: string) => string | null
```

### `injectAliases`

Inject aliases into a shell RC file.

```typescript
(filePath: string, shell?: ShellType, cleoPath?: string | undefined) => { action: "created" | "updated" | "added"; version: string; }
```

### `removeAliases`

Remove aliases from a shell RC file.

```typescript
(filePath: string) => boolean
```

### `checkAliasesStatus`

Get alias status for the current shell.

```typescript
(shell?: ShellType | undefined) => { shell: ShellType; rcFile: string; installed: boolean; version: string | null; needsUpdate: boolean; }
```

### `discoverReleaseTasks`

Discover task IDs for a release from completed tasks. Optionally filtered by date range or specific task IDs.

```typescript
(options?: { since?: string | undefined; until?: string | undefined; taskIds?: string[] | undefined; }, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<...>
```

### `groupTasksIntoSections`

Group tasks into changelog sections.

```typescript
(tasks: ChangelogTask[]) => ChangelogSection[]
```

### `generateChangelogMarkdown`

Generate changelog markdown for a version.

```typescript
(version: string, date: string, sections: ChangelogSection[]) => string
```

### `formatChangelogJson`

Format changelog data as JSON.

```typescript
(version: string, date: string, sections: ChangelogSection[]) => Record<string, unknown>
```

### `writeChangelogFile`

Write changelog content to a file.

```typescript
(filePath: string, content: string) => void
```

### `appendToChangelog`

Append a new release section to an existing CHANGELOG.md.

```typescript
(filePath: string, newContent: string) => void
```

### `generateChangelog`

Full changelog generation: discover tasks, group, generate, write.

```typescript
(version: string, options?: { since?: string | undefined; until?: string | undefined; taskIds?: string[] | undefined; outputPath?: string | undefined; append?: boolean | undefined; }, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<...>
```

### `parseCommandHeader`

Parse a ###CLEO header block from a script file.

```typescript
(scriptPath: string) => CommandMeta | null
```

### `scanAllCommands`

Scan a scripts directory and build a command registry. Returns a map of command name to metadata.

```typescript
(scriptsDir: string) => Map<string, CommandMeta>
```

### `validateHeader`

Validate a command header has required fields.

```typescript
(meta: CommandMeta) => { valid: boolean; errors: string[]; }
```

### `getCommandScriptMap`

Get command-to-script mapping.

```typescript
(scriptsDir: string) => Record<string, string>
```

### `getCommandsByCategory`

Group commands by category.

```typescript
(scriptsDir: string) => Record<string, CommandMeta[]>
```

### `getCommandsByRelevance`

Filter commands by relevance level.

```typescript
(scriptsDir: string, relevance: string) => CommandMeta[]
```

### `defaultFlags`

Default flag values.

```typescript
() => ParsedFlags
```

### `parseCommonFlags`

Parse common CLI flags from an argument array. Returns flags and remaining positional arguments.

```typescript
(args: string[]) => ParsedFlags
```

### `resolveFormat`

Resolve output format based on flags and TTY detection. Returns 'json' for non-TTY (piped), 'human' for TTY.

```typescript
(flagFormat: string) => "json" | "human"
```

### `isJsonOutput`

Check if output should be JSON.

```typescript
(flags: ParsedFlags) => boolean
```

### `getValidationKey`

Get the validation key for a target filename.

```typescript
(target: string) => string
```

### `extractMarkerVersion`

Extract the CLEO version from an injection marker string. Returns null if no version is present (current format). Returns the version string for legacy format.

```typescript
(markerLine: string) => string | null
```

### `checkManifestEntry`

Verify a manifest entry for a task has valid required fields.  T4524

```typescript
(entry: ManifestEntry | null) => ManifestIntegrity
```

### `checkReturnFormat`

Check if a response matches the expected return format.  T4524

```typescript
(response: string) => boolean
```

### `scoreSubagentCompliance`

Calculate comprehensive compliance score for a subagent.  T4524

```typescript
(taskId: string, agentId: string, manifestEntry: ManifestEntry | null, researchLinked: boolean, response: string) => ComplianceMetrics
```

### `calculateTokenEfficiency`

Calculate token efficiency metrics.  T4524

```typescript
(tokensUsed: number, maxTokens?: number, tasksCompleted?: number, inputTokens?: number, outputTokens?: number) => TokenEfficiency
```

### `calculateOrchestrationOverhead`

Calculate orchestration overhead metrics.  T4524

```typescript
(orchestratorTokens: number, totalSubagentTokens: number, numSubagents?: number) => OrchestrationOverhead
```

### `getScriptCommands`

Get command names from scripts directory. Returns sorted list of script basenames without .sh extension.  T4527

```typescript
(scriptsDir: string) => string[]
```

### `getIndexScripts`

Get script names from COMMANDS-INDEX.json.  T4527

```typescript
(indexPath: string) => string[]
```

### `getIndexCommands`

Get command names from COMMANDS-INDEX.json.  T4527

```typescript
(indexPath: string) => string[]
```

### `checkCommandsSync`

Check commands index vs scripts directory for sync.  T4527

```typescript
(scriptsDir: string, indexPath: string) => DriftIssue[]
```

### `checkWrapperSync`

Check wrapper template sync with COMMANDS-INDEX.  T4527

```typescript
(wrapperPath: string, indexPath: string) => DriftIssue[]
```

### `detectDrift`

Run full drift detection across scripts, index, wrapper, and README.  T4527

```typescript
(mode?: "full" | "quick", projectRoot?: string) => DriftReport
```

### `shouldRunDriftDetection`

Check if drift detection should run automatically based on config.  T4527

```typescript
(enabled?: boolean, autoCheck?: boolean, command?: string | undefined, criticalCommands?: string[]) => boolean
```

### `getCacheFilePath`

Get cache file path.  T4525

```typescript
(cleoHome?: string | undefined) => string
```

### `initCacheFile`

Initialize empty cache file.  T4525

```typescript
(cacheFile: string) => DoctorProjectCache
```

### `loadCache`

Load cache file or return null if missing/invalid.  T4525

```typescript
(cacheFile: string) => DoctorProjectCache | null
```

### `getFileHash`

Get file hash for cache invalidation.  T4525

```typescript
(filePath: string) => string
```

### `getCachedValidation`

Check if project validation is cached and valid. Returns the cache entry if valid, null if cache miss.  T4525

```typescript
(projectHash: string, projectPath: string, cacheFile?: string | undefined) => ProjectCacheEntry | null
```

### `cacheValidationResult`

Cache project validation results.  T4525

```typescript
(projectHash: string, projectPath: string, validationStatus: "warning" | "failed" | "passed", issues?: string[], schemaVersions?: SchemaVersions, cacheFile?: string | undefined) => void
```

### `clearProjectCache`

Clear cache for a specific project.  T4525

```typescript
(projectHash: string, cacheFile?: string | undefined) => void
```

### `clearEntireCache`

Clear entire cache.  T4525

```typescript
(cacheFile?: string | undefined) => void
```

### `isTempProject`

Check if a project path is a temporary/test directory.  T4525

```typescript
(path: string) => boolean
```

### `categorizeProjects`

Filter projects into categories: active, temp, orphaned.  T4525

```typescript
(projects: ProjectDetail[]) => CategorizedProjects
```

### `getProjectCategoryName`

Get human-readable project category name.  T4525

```typescript
(category: "active" | "orphaned" | "temp") => string
```

### `formatProjectHealthSummary`

Format project health summary for display.  T4525

```typescript
(summary: HealthSummary) => string
```

### `getProjectGuidance`

Get actionable guidance for project issues.  T4525

```typescript
(activeFailed: number, activeWarnings: number, tempCount: number, orphanedCount: number) => string[]
```

### `getUserJourneyStage`

Check user journey stage based on system state.  T4525

```typescript
(hasProjects: boolean, tempProjectCount: number, agentConfigsOk: boolean) => UserJourneyStage
```

### `getJourneyGuidance`

Get journey-specific guidance text.  T4525

```typescript
(stage: UserJourneyStage) => string[]
```

### `sanitizeFilePath`

Sanitize a file path for safe shell usage. Prevents command injection via malicious file names.  T4523

```typescript
(path: string) => string
```

### `validateTitle`

Validate a task title. Checks for emptiness, newlines, invisible characters, control chars, and length.  T4523

```typescript
(title: string) => ValidationResult
```

### `validateDescription`

T4523

```typescript
(desc: string) => ValidationResult
```

### `validateNote`

T4523

```typescript
(note: string) => ValidationResult
```

### `validateBlockedBy`

T4523

```typescript
(reason: string) => ValidationResult
```

### `validateSessionNote`

T4523

```typescript
(note: string) => ValidationResult
```

### `validateCancelReason`

Validate a cancellation reason.  T4523

```typescript
(reason: string) => ValidationResult
```

### `validateStatusTransition`

Validate that a status transition is allowed.  T4523

```typescript
(oldStatus: "cancelled" | "pending" | "active" | "blocked" | "done" | "archived", newStatus: "cancelled" | "pending" | "active" | "blocked" | "done" | "archived") => ValidationResult
```

### `isValidStatus`

Check if a status string is valid.  T4523

```typescript
(status: string) => status is "cancelled" | "pending" | "active" | "blocked" | "done" | "archived"
```

### `checkTimestampSanity`

Check timestamp format and sanity.  T4523

```typescript
(createdAt: string, completedAt?: string | undefined) => ValidationResult
```

### `isMetadataOnlyUpdate`

Check if an update contains only metadata fields (safe for done tasks).  T4523

```typescript
(fields: string[]) => boolean
```

### `normalizeLabels`

Deduplicate and normalize labels.  T4523

```typescript
(labels: string) => string
```

### `checkIdUniqueness`

Check ID uniqueness within and across files.  T4523

```typescript
(taskFile: TaskFile, archiveFile?: ArchiveFile | undefined) => ValidationResult
```

### `validateTask`

Validate a single task object.  T4523

```typescript
(task: Task) => ValidationResult
```

### `validateNoCircularDeps`

Check for circular dependencies using DFS.  T4523

```typescript
(tasks: Task[], taskId: string, newDeps: string[]) => ValidationResult
```

### `validateSingleActivePhase`

Validate only one phase is active.  T4523

```typescript
(taskFile: TaskFile) => ValidationResult
```

### `validateCurrentPhaseConsistency`

Validate currentPhase matches an active phase.  T4523

```typescript
(taskFile: TaskFile) => ValidationResult
```

### `validatePhaseTimestamps`

Validate phase timestamp ordering.  T4523

```typescript
(taskFile: TaskFile) => ValidationResult
```

### `validatePhaseStatusRequirements`

Validate phase status requirements (e.g., active phases must have startedAt).  T4523

```typescript
(taskFile: TaskFile) => ValidationResult
```

### `validateAll`

Run all validation checks on a TaskFile.  T4523

```typescript
(taskFile: TaskFile, archiveFile?: ArchiveFile | undefined) => ComprehensiveValidationResult
```

### `parseManifest`

Parse a MANIFEST.jsonl file into entries. Skips invalid JSON lines gracefully.  T4524

```typescript
(content: string) => ManifestDoc[]
```

### `findReviewDocs`

Find documents in review status.  T4524

```typescript
(entries: ManifestDoc[], filterId?: string | undefined) => ManifestDoc[]
```

### `extractTopics`

Extract markdown headings from file content.  T4524

```typescript
(content: string) => string[]
```

### `searchCanonicalCoverage`

Search for topic coverage in a docs directory. Returns count of matching files.  T4524

```typescript
(topic: string, docsFileContents: Map<string, string>) => { topic: string; matches: number; files: string[]; }
```

### `analyzeCoverage`

Analyze documentation coverage for review documents.  T4524

```typescript
(reviewDocs: ManifestDoc[], docsFileContents: Map<string, string>, filterId?: string | undefined) => GapReport
```

### `formatGapReport`

Format a gap report for human-readable display.  T4524

```typescript
(report: GapReport) => string
```

### `findManifestEntry`

Find a manifest entry for a task ID in a JSONL file.  T4526

```typescript
(taskId: string, manifestPath?: string | undefined) => Promise<ManifestEntry | null>
```

### `validateManifestEntry`

Run validation on a manifest entry for a specific task.  T4526

```typescript
(taskId: string, manifestEntry?: ManifestEntry | null | undefined, manifestPath?: string) => Promise<ManifestValidationResult>
```

### `logRealCompliance`

Log validation results to the compliance JSONL file.  T4526

```typescript
(taskId: string, validationResult: ManifestValidationResult, agentType?: string, compliancePath?: string) => Promise<void>
```

### `validateAndLog`

Find, validate, and log compliance for a task in one call.  T4526

```typescript
(taskId: string, manifestPath?: string, compliancePath?: string) => Promise<ManifestValidationResult>
```

### `checkOutputFileExists`

Check if expected output file exists.  T4527

```typescript
(taskId: string, expectedDir: string, pattern?: string | undefined) => boolean
```

### `checkDocumentationSections`

Check if file contains required documentation sections.  T4527

```typescript
(filePath: string, sections: string[]) => boolean
```

### `checkReturnMessageFormat`

Check if return message follows protocol format. Expected: " . See MANIFEST.jsonl for ."  T4527

```typescript
(message: string, _protocolType?: string | undefined) => boolean
```

### `checkManifestFieldPresent`

Check if manifest entry has a required field (non-null, non-empty).  T4527

```typescript
(entry: Record<string, unknown>, fieldName: string) => boolean
```

### `checkManifestFieldType`

Check if manifest field has expected type.  T4527

```typescript
(entry: Record<string, unknown>, fieldName: string, expectedType: "string" | "number" | "boolean" | "object" | "array") => boolean
```

### `checkKeyFindingsCount`

Check if key_findings array has valid count (3-7).  T4527

```typescript
(entry: Record<string, unknown>) => boolean
```

### `checkStatusValid`

Check if status is valid enum value.  T4527

```typescript
(entry: Record<string, unknown>) => boolean
```

### `checkAgentType`

Check if agent_type matches expected value.  T4527

```typescript
(entry: Record<string, unknown>, expectedType: string) => boolean
```

### `checkLinkedTasksPresent`

Check if linked_tasks array contains required task IDs.  T4527

```typescript
(entry: Record<string, unknown>, requiredIds: string[]) => boolean
```

### `checkProvenanceTags`

Check if file contains  provenance tag.  T4527

```typescript
(filePath: string, taskId?: string | undefined) => boolean
```

### `validateCommonManifestRequirements`

Validate common manifest requirements across all protocols.  T4527

```typescript
(entry: Record<string, unknown>, _protocolType?: string | undefined) => ProtocolValidationResult
```

### `isValidGateName`

T4526

```typescript
(name: string) => name is "implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented"
```

### `isValidAgentName`

T4526

```typescript
(name: string) => name is "testing" | "planner" | "coder" | "qa" | "cleanup" | "security" | "docs"
```

### `getGateOrder`

T4526

```typescript
() => ("implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented")[]
```

### `getGateIndex`

T4526

```typescript
(gateName: "implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented") => number
```

### `getDownstreamGates`

T4526

```typescript
(fromGate: "implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented") => ("implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented")[]
```

### `initVerification`

Initialize a new verification object with default values.  T4526

```typescript
() => Verification
```

### `computePassed`

Compute whether verification has passed based on required gates.  T4526

```typescript
(verification: Verification, requiredGates?: ("implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented")[]) => boolean
```

### `setVerificationPassed`

Update the passed field on a verification object.  T4526

```typescript
(verification: Verification, passed: boolean) => Verification
```

### `updateGate`

Update a single gate value.  T4526

```typescript
(verification: Verification, gateName: "implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented", value: boolean | null, agent?: string | undefined) => Verification
```

### `resetDownstreamGates`

Reset all downstream gates to null after a gate failure.  T4526

```typescript
(verification: Verification, fromGate: "implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented") => Verification
```

### `incrementRound`

Increment the round counter. Returns null if max rounds exceeded.  T4526

```typescript
(verification: Verification, maxRounds?: number) => Verification | null
```

### `logFailure`

Log a failure to the failureLog array.  T4526

```typescript
(verification: Verification, gateName: "implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented", agent: string, reason: string) => Verification
```

### `checkAllGatesPassed`

Check if all required gates have passed.  T4526

```typescript
(verification: Verification, requiredGates?: ("implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented")[]) => boolean
```

### `isVerificationComplete`

Check if verification is complete (passed = true).  T4526

```typescript
(verification: Verification | null) => boolean
```

### `getVerificationStatus`

Get verification status for display.  T4526

```typescript
(verification: Verification | null) => VerificationStatus
```

### `shouldRequireVerification`

Check if a task type should require verification.  T4526

```typescript
(taskType?: string, verificationEnabled?: boolean) => boolean
```

### `getMissingGates`

Get gate names that are not yet true.  T4526

```typescript
(verification: Verification, requiredGates?: ("implemented" | "testsPassed" | "qaPassed" | "cleanupDone" | "securityPassed" | "documented")[]) => ("implemented" | ... 4 more ... | "documented")[]
```

### `getGateSummary`

Get gate summary for display.  T4526

```typescript
(verification: Verification) => { passed: boolean; round: number; gates: VerificationGates; lastAgent: string | null; lastUpdated: string; failureCount: number; }
```

### `checkCircularValidation`

Check for circular validation (self-approval prevention). Prevents: creator validating own work, validator re-testing, tester self-creating.  T4526

```typescript
(currentAgent: string, createdBy?: string | null | undefined, validatedBy?: string | null | undefined, testedBy?: string | null | undefined) => CircularValidationResult
```

### `allEpicChildrenVerified`

Check if all children of an epic have verification.passed = true.  T4526

```typescript
(epicId: string, tasks: TaskForVerification[]) => boolean
```

### `allSiblingsVerified`

Check if all siblings of a task are verified.  T4526

```typescript
(parentId: string, tasks: TaskForVerification[]) => boolean
```

### `getProjectInfo`

Read project-info.json and return a typed ProjectInfo.  Falls back gracefully when projectId is missing (pre-T5333 installs) by returning an empty string, allowing callers to detect and handle.

```typescript
(cwd?: string | undefined) => Promise<ProjectInfo>
```

### `getProjectInfoSync`

Synchronous variant for use in hot paths where async is not feasible. Returns null if the file is missing or unparseable.

```typescript
(cwd?: string | undefined) => ProjectInfo | null
```

### `getSyncStatus`

Get current sync status.  T5326

```typescript
(projectRoot: string) => Promise<{ success: boolean; data?: SyncStatusResult | undefined; error?: { code: string; message: string; } | undefined; }>
```

### `clearSyncState`

Clear sync state.  T5326

```typescript
(projectRoot: string, dryRun?: boolean | undefined) => Promise<{ success: boolean; data?: SyncClearResult | undefined; error?: { code: string; message: string; } | undefined; }>
```

### `getHookCapableProviders`

Get all providers that support a specific hook event

```typescript
(event: HookEvent) => string[]
```

**Parameters:**

- `event` — The hook event to query

**Returns:** Array of provider IDs that support this event

### `getSharedHookEvents`

Get hook events supported by all specified providers

```typescript
(providerIds?: string[] | undefined) => HookEvent[]
```

**Parameters:**

- `providerIds` — Optional array of provider IDs (uses all active providers if omitted)

**Returns:** Array of hook events supported by all specified providers

### `validateChainShape`

Validate the topology/DAG of a chain shape.  Checks: - All link source/target IDs reference existing stages - entryPoint references an existing stage - All exitPoints reference existing stages - No cycles (topological sort) - All stages are reachable from the entry point   T5401

```typescript
(shape: ChainShape) => string[]
```

### `validateGateSatisfiability`

Validate that all gates in a chain reference valid stages and gate names.  Checks: - Every gate's stageId references an existing stage - Every stage_complete check references an existing stage - Every verification_gate check references a valid GateName   T5401

```typescript
(chain: WarpChain) => string[]
```

### `validateChain`

Validate a complete WarpChain definition.  Orchestrates shape validation and gate satisfiability checks, returning a unified ChainValidation result.   T5401

```typescript
(chain: WarpChain) => ChainValidation
```

### `addChain`

Store a validated WarpChain definition.  Validates the chain before storing. Throws if validation fails.   T5403

```typescript
(chain: WarpChain, projectRoot: string) => Promise<void>
```

### `showChain`

Retrieve a WarpChain definition by ID.   T5403

```typescript
(id: string, projectRoot: string) => Promise<WarpChain | null>
```

### `listChains`

List all stored WarpChain definitions.   T5403

```typescript
(projectRoot: string) => Promise<WarpChain[]>
```

### `findChains`

Find WarpChain definitions by criteria.   T5403

```typescript
(criteria: ChainFindCriteria, projectRoot: string) => Promise<WarpChain[]>
```

### `createInstance`

Create a chain instance binding a chain to an epic.   T5403

```typescript
(params: { chainId: string; epicId: string; variables?: Record<string, unknown> | undefined; stageToTask?: Record<string, string> | undefined; }, projectRoot: string) => Promise<...>
```

### `showInstance`

Retrieve a chain instance by ID.   T5403

```typescript
(id: string, projectRoot: string) => Promise<WarpChainInstance | null>
```

### `listInstanceGateResults`

Read persisted gate results for a chain instance.

```typescript
(id: string, projectRoot: string) => Promise<GateResult[]>
```

### `advanceInstance`

Advance a chain instance to the next stage, recording gate results.   T5403

```typescript
(id: string, nextStage: string, gateResults: GateResult[], projectRoot: string) => Promise<WarpChainInstance>
```

### `validateResearchProtocol`

T4499

```typescript
(entry: ManifestEntryInput, options?: { strict?: boolean | undefined; hasCodeChanges?: boolean | undefined; }) => ProtocolValidationResult
```

### `validateConsensusProtocol`

T4499

```typescript
(entry: ManifestEntryInput, votingMatrix?: VotingMatrix) => ProtocolValidationResult
```

### `validateSpecificationProtocol`

T4499

```typescript
(entry: ManifestEntryInput, specContent?: string | undefined) => ProtocolValidationResult
```

### `validateDecompositionProtocol`

T4499

```typescript
(entry: ManifestEntryInput, options?: { siblingCount?: number | undefined; descriptionClarity?: boolean | undefined; maxSiblings?: number | undefined; maxDepth?: number | undefined; }) => ProtocolValidationResult
```

### `validateImplementationProtocol`

T4499

```typescript
(entry: ManifestEntryInput, options?: { hasTaskTags?: boolean | undefined; }) => ProtocolValidationResult
```

### `validateContributionProtocol`

T4499

```typescript
(entry: ManifestEntryInput, options?: { hasContributionTags?: boolean | undefined; }) => ProtocolValidationResult
```

### `validateReleaseProtocol`

T4499

```typescript
(entry: ManifestEntryInput, options?: { version?: string | undefined; hasChangelog?: boolean | undefined; }) => ProtocolValidationResult
```

### `validateArtifactPublishProtocol`

T4499

```typescript
(entry: ManifestEntryInput, options?: { artifactType?: string | undefined; buildPassed?: boolean | undefined; }) => ProtocolValidationResult
```

### `validateProvenanceProtocol`

T4499

```typescript
(entry: ManifestEntryInput, options?: { hasAttestation?: boolean | undefined; hasSbom?: boolean | undefined; }) => ProtocolValidationResult
```

### `validateProtocol`

Validate a manifest entry against a specific protocol. Throws CleoError with appropriate exit code on strict failure.  T4499

```typescript
(protocol: "research" | "consensus" | "specification" | "decomposition" | "implementation" | "release" | "contribution" | "provenance" | "artifact-publish", entry: ManifestEntryInput, options?: Record<...>, strict?: boolean) => ProtocolValidationResult
```

### `buildDefaultChain`

Build the canonical 9-stage RCASD-IVTR+C WarpChain.  - Each PIPELINE_STAGE becomes a WarpStage - Each prerequisite from STAGE_PREREQUISITES becomes an entry GateContract - Each verification gate from VERIFICATION_GATE_ORDER becomes an exit GateContract - All 8 links are linear (stage[i] - stage[i+1])   T5399

```typescript
() => WarpChain
```

### `buildDefaultTessera`

Build the default RCASD Tessera template.  Wraps buildDefaultChain() with template variables: - epicId (required, type 'epicId') - projectName (optional, type 'string', default 'unnamed') - skipResearch (optional, type 'boolean', default false)   T5409

```typescript
() => TesseraTemplate
```

### `instantiateTessera`

Instantiate a Tessera template into a concrete WarpChainInstance.  Steps: 1. Validate all required variables are provided 2. Apply defaults for missing optional variables 3. Construct concrete WarpChain from template 4. Validate chain via validateChain() 5. Store via createInstance() from chain-store 6. Return instance   T5409

```typescript
(template: TesseraTemplate, input: TesseraInstantiationInput, projectRoot: string) => Promise<WarpChainInstance>
```

### `listTesseraTemplates`

List all registered Tessera templates.   T5409

```typescript
() => TesseraTemplate[]
```

### `showTessera`

Find a Tessera template by ID.   T5409

```typescript
(id: string) => TesseraTemplate | null
```

### `migrateClaudeMem`

Migrate observations from claude-mem's SQLite database into CLEO brain.db.  Reads from ~/.claude-mem/claude-mem.db (or a custom path) and inserts into: - brain_observations (all observations, prefixed CM-) - brain_decisions (decision-typed observations, prefixed CMD-) - brain_learnings (session summaries with learned field, prefixed CML-)  Idempotent: skips rows whose ID already exists in brain.db. After all inserts, rebuilds FTS5 indexes.

```typescript
(projectRoot: string, options?: ClaudeMemMigrationOptions) => Promise<ClaudeMemMigrationResult>
```

**Parameters:**

- `projectRoot` — The CLEO project root (for brain.db resolution)
- `options` — Migration options

### `reasonWhy`

Build a causal trace for why a task is blocked.  Walks upstream through `depends` fields, collecting unresolved blockers and their associated brain decisions. Leaf blockers (no further unresolved deps) are reported as root causes.

```typescript
(taskId: string, projectRoot: string, taskAccessor?: DataAccessor | undefined) => Promise<CausalTrace>
```

### `reasonSimilar`

Find entries similar to a given brain.db entry.  1. Loads the source entry's text from brain.db. 2. Calls searchSimilar() for vector-based similarity if embeddings exist. 3. Falls back to FTS5 keyword search if no embeddings are available. 4. Filters out the source entry itself.

```typescript
(entryId: string, projectRoot: string, limit?: number | undefined) => Promise<SimilarEntry[]>
```

**Parameters:**

- `entryId` — ID of the brain.db entry to find similar entries for
- `projectRoot` — Project root directory
- `limit` — Maximum results to return (default 10)

**Returns:** Array of similar entries ranked by distance/relevance

### `memoryShow`

memory.show - Look up a brain.db entry by ID

```typescript
(entryId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryBrainStats`

memory.stats - Aggregate stats from brain.db across all tables

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryDecisionFind`

memory.decision.find - Search decisions in brain.db

```typescript
(params: { query?: string | undefined; taskId?: string | undefined; limit?: number | undefined; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryDecisionStore`

memory.decision.store - Store a decision to brain.db

```typescript
(params: { decision: string; rationale: string; alternatives?: string[] | undefined; taskId?: string | undefined; sessionId?: string | undefined; }, projectRoot?: string | undefined) => Promise<...>
```

### `memoryFind`

memory.find - Token-efficient brain search

```typescript
(params: { query: string; limit?: number | undefined; tables?: string[] | undefined; dateStart?: string | undefined; dateEnd?: string | undefined; }, projectRoot?: string | undefined) => Promise<...>
```

### `memoryTimeline`

memory.timeline - Chronological context around anchor

```typescript
(params: { anchor: string; depthBefore?: number | undefined; depthAfter?: number | undefined; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryFetch`

memory.fetch - Batch fetch brain entries by IDs

```typescript
(params: { ids: string[]; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryObserve`

memory.observe - Save observation to brain

```typescript
(params: { text: string; title?: string | undefined; type?: string | undefined; project?: string | undefined; sourceSessionId?: string | undefined; sourceType?: string | undefined; }, projectRoot?: string | undefined) => Promise<...>
```

### `memoryPatternStore`

memory.pattern.store - Store a pattern to BRAIN memory

```typescript
(params: StorePatternParams, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryPatternFind`

memory.pattern.find - Search patterns in BRAIN memory

```typescript
(params: SearchPatternParams, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryPatternStats`

memory.pattern.stats - Get pattern memory statistics

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryLearningStore`

memory.learning.store - Store a learning to BRAIN memory

```typescript
(params: StoreLearningParams, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryLearningFind`

memory.learning.find - Search learnings in BRAIN memory

```typescript
(params: SearchLearningParams, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryLearningStats`

memory.learning.stats - Get learning memory statistics

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryContradictions`

memory.contradictions - Find contradictory entries in brain.db

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memorySuperseded`

memory.superseded - Find superseded entries in brain.db  Identifies entries that have been superseded by newer entries on the same topic. For brain.db, we group by: - Decisions: type + contextTaskId/contextEpicId - Patterns: type + context (first 100 chars for similarity) - Learnings: source + applicableTypes - Observations: type + project

```typescript
(params?: { type?: string | undefined; project?: string | undefined; } | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryLink`

memory.link - Link a brain entry to a task

```typescript
(params: { taskId: string; entryId: string; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryUnlink`

memory.unlink - Remove a link between a brain entry and a task

```typescript
(params: { taskId: string; entryId: string; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryGraphAdd`

memory.graph.add - Add a node or edge to the PageIndex graph

```typescript
(params: { nodeId?: string | undefined; nodeType?: string | undefined; label?: string | undefined; metadataJson?: string | undefined; fromId?: string | undefined; toId?: string | undefined; edgeType?: string | undefined; weight?: number | undefined; }, projectRoot?: string | undefined) => Promise<...>
```

### `memoryGraphShow`

memory.graph.show - Get a node and its edges from the PageIndex graph

```typescript
(params: { nodeId: string; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryGraphNeighbors`

memory.graph.neighbors - Get neighbor nodes from the PageIndex graph

```typescript
(params: { nodeId: string; edgeType?: string | undefined; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryReasonWhy`

memory.reason.why - Causal trace through task dependency chains

```typescript
(params: { taskId: string; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memoryReasonSimilar`

memory.reason.similar - Find semantically similar entries

```typescript
(params: { entryId: string; limit?: number | undefined; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `memorySearchHybrid`

memory.search.hybrid - Hybrid search across FTS5, vector, and graph

```typescript
(params: { query: string; ftsWeight?: number | undefined; vecWeight?: number | undefined; graphWeight?: number | undefined; limit?: number | undefined; }, projectRoot?: string | undefined) => Promise<...>
```

### `memoryGraphRemove`

memory.graph.remove - Remove a node or edge from the PageIndex graph

```typescript
(params: { nodeId?: string | undefined; fromId?: string | undefined; toId?: string | undefined; edgeType?: string | undefined; }, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestShow`

pipeline.manifest.show - Get manifest entry details by ID

```typescript
(researchId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestList`

pipeline.manifest.list - List manifest entries with filters

```typescript
(params: PipelineManifestListParams, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestFind`

pipeline.manifest.find - Find manifest entries by text (LIKE search on content + type)

```typescript
(query: string, options?: { confidence?: number | undefined; limit?: number | undefined; } | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestPending`

pipeline.manifest.pending - Get pending manifest items

```typescript
(epicId?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestStats`

pipeline.manifest.stats - Manifest statistics

```typescript
(epicId?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestRead`

pipeline.manifest.read - Read manifest entries with optional filter

```typescript
(filter?: ResearchFilter | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestAppend`

pipeline.manifest.append - Append entry to pipeline_manifest table

```typescript
(entry: ExtendedManifestEntry, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestArchive`

pipeline.manifest.archive - Archive old manifest entries by date

```typescript
(beforeDate: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestCompact`

pipeline.manifest.compact - Dedup by contentHash (keep newest by createdAt)

```typescript
(projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestValidate`

pipeline.manifest.validate - Validate manifest entries for a task

```typescript
(taskId: string, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `pipelineManifestContradictions`

pipeline.manifest.contradictions - Find entries with overlapping topics but conflicting key_findings

```typescript
(projectRoot?: string | undefined, params?: { topic?: string | undefined; } | undefined) => Promise<EngineResult<{ contradictions: ContradictionDetail[]; }>>
```

### `pipelineManifestSuperseded`

pipeline.manifest.superseded - Identify entries replaced by newer work on same topic

```typescript
(projectRoot?: string | undefined, params?: { topic?: string | undefined; } | undefined) => Promise<EngineResult<{ superseded: SupersededDetail[]; }>>
```

### `pipelineManifestLink`

pipeline.manifest.link - Link manifest entry to a task

```typescript
(taskId: string, researchId: string, notes?: string | undefined, projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `readManifestEntries`

Read all manifest entries from the pipeline_manifest table. Replaces readManifestEntries() from pipeline-manifest-compat.

```typescript
(projectRoot?: string | undefined) => Promise<ExtendedManifestEntry[]>
```

### `filterEntries`

Filter manifest entries by criteria (alias for backward compatibility).

```typescript
(entries: ExtendedManifestEntry[], filter: ResearchFilter) => ExtendedManifestEntry[]
```

### `distillManifestEntry`

Distill a manifest entry to brain.db observation (Phase 3, pending).

```typescript
(_entryId: string, _projectRoot?: string | undefined) => Promise<EngineResult<unknown>>
```

### `migrateManifestJsonlToSqlite`

Migrate existing .cleo/MANIFEST.jsonl entries into the pipeline_manifest table. Skips entries that already exist (by id). Renames MANIFEST.jsonl to MANIFEST.jsonl.migrated when done.

```typescript
(projectRoot?: string | undefined) => Promise<{ migrated: number; skipped: number; }>
```

**Returns:** Count of migrated and skipped entries.

### `resolveProviderFromModelIndex`

```typescript
(index: ModelsDevIndex, model?: string | undefined) => ModelProviderLookup
```

### `resolveProviderFromModelRegistry`

```typescript
(model?: string | undefined) => Promise<ModelProviderLookup>
```

### `resetModelsDevCache`

```typescript
() => void
```

### `measureTokenExchange`

```typescript
(input: TokenExchangeInput) => Promise<TokenMeasurement>
```

### `recordTokenExchange`

```typescript
(input: TokenExchangeInput) => Promise<{ sessionId: string | null; id: string; createdAt: string; taskId: string | null; metadataJson: string; domain: string | null; ... 14 more ...; responseHash: string | null; }>
```

### `showTokenUsage`

```typescript
(id: string, cwd?: string | undefined) => Promise<{ sessionId: string | null; id: string; createdAt: string; taskId: string | null; metadataJson: string; domain: string | null; operation: string | null; ... 13 more ...; responseHash: string | null; } | null>
```

### `listTokenUsage`

```typescript
(filters?: TokenUsageFilters, cwd?: string | undefined) => Promise<{ records: { sessionId: string | null; id: string; createdAt: string; taskId: string | null; metadataJson: string; ... 15 more ...; responseHash: string | null; }[]; total: number; filtered: number; }>
```

### `summarizeTokenUsage`

```typescript
(filters?: TokenUsageFilters, cwd?: string | undefined) => Promise<TokenUsageSummary>
```

### `deleteTokenUsage`

```typescript
(id: string, cwd?: string | undefined) => Promise<{ deleted: boolean; id: string; }>
```

### `clearTokenUsage`

```typescript
(filters?: TokenUsageFilters, cwd?: string | undefined) => Promise<{ deleted: number; }>
```

### `autoRecordDispatchTokenUsage`

```typescript
(input: TokenExchangeInput) => Promise<void>
```

### `getLatestTokenRecord`

```typescript
(cwd?: string | undefined) => Promise<{ sessionId: string | null; id: string; createdAt: string; taskId: string | null; metadataJson: string; domain: string | null; operation: string | null; ... 13 more ...; responseHash: string | null; } | null>
```

### `getTokenUsageAggregateSql`

```typescript
(cwd?: string | undefined) => Promise<{ provider: string; transport: string; totalTokens: number; count: number; }[]>
```

### `startParallelExecution`

Start parallel execution for a wave.

```typescript
(epicId: string, wave: number, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ epicId: string; wave: number; tasks: string[]; taskCount: number; startedAt: string; }>
```

### `endParallelExecution`

End parallel execution for a wave.

```typescript
(epicId: string, wave: number, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<{ epicId: string; wave: number; tasks: string[]; taskCount: number; startedAt: string | null; endedAt: string; durationMs: number; alreadyEnded?: boolean | undefined; }>
```

### `getParallelStatus`

Get current parallel execution state.

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<ParallelState>
```

### `listSkills`

List available skills.

```typescript
(_projectRoot: string) => { skills: SkillEntry[]; total: number; }
```

### `getSkillContent`

Read skill content for injection into agent context.

```typescript
(skillName: string, _projectRoot: string) => SkillContent
```

### `getUnblockOpportunities`

Analyze dependency graph for unblocking opportunities.

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<UnblockResult>
```

### `validateSpawnReadiness`

Validate spawn readiness for a task.

```typescript
(taskId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<SpawnValidationResult>
```

### `injectContext`

Read protocol injection content for a given protocol type. Core logic for session.context.inject.

```typescript
(protocolType: string, params?: { taskId?: string | undefined; variant?: string | undefined; } | undefined, projectRoot?: string | undefined) => ContextInjectionData
```

### `generateSessionId`

Generate a canonical session ID.  Format: ses_YYYYMMDDHHmmss_6hex Example: ses_20260227171900_a1b2c3

```typescript
() => string
```

### `isValidSessionId`

Check if a string is a valid session ID (any format).

```typescript
(id: string) => boolean
```

### `isCanonicalSessionId`

Check if a session ID uses the canonical format.

```typescript
(id: string) => boolean
```

### `extractSessionTimestamp`

Extract an approximate timestamp from any valid session ID format. Returns null if the ID format is not recognized.

```typescript
(id: string) => Date | null
```

### `createSession`

Create a new session.

```typescript
(session: Session, cwd?: string | undefined) => Promise<Session>
```

### `getSession`

Get a session by ID.

```typescript
(sessionId: string, cwd?: string | undefined) => Promise<Session | null>
```

### `updateSession`

Update a session.

```typescript
(sessionId: string, updates: Partial<Session>, cwd?: string | undefined) => Promise<Session | null>
```

### `listSessions`

List sessions with optional filters.

```typescript
(filters?: { active?: boolean | undefined; limit?: number | undefined; } | undefined, cwd?: string | undefined) => Promise<Session[]>
```

### `endSession`

End a session.

```typescript
(sessionId: string, note?: string | undefined, cwd?: string | undefined) => Promise<Session | null>
```

### `startTask`

Start working on a task within a session.

```typescript
(sessionId: string, taskId: string, cwd?: string | undefined) => Promise<void>
```

### `getCurrentTask`

Get current task for a session.

```typescript
(sessionId: string, cwd?: string | undefined) => Promise<{ taskId: string | null; since: string | null; }>
```

### `stopTask`

Stop working on the current task for a session.

```typescript
(sessionId: string, cwd?: string | undefined) => Promise<void>
```

### `workHistory`

Get work history for a session.

```typescript
(sessionId: string, limit?: number, cwd?: string | undefined) => Promise<{ taskId: string; setAt: string; clearedAt: string | null; }[]>
```

### `gcSessions`

Garbage collect old sessions (mark ended sessions as orphaned after threshold).

```typescript
(maxAgeDays?: number, cwd?: string | undefined) => Promise<number>
```

### `getActiveSession`

Get the currently active session (if any).

```typescript
(cwd?: string | undefined) => Promise<Session | null>
```

### `computeDependencyWaves`

Compute dependency waves for parallel execution. Tasks in the same wave can run in parallel; waves must be sequential.

```typescript
(tasks: Task[]) => DependencyWave[]
```

### `getNextTask`

Get the next task to work on (highest priority ready task).

```typescript
(tasks: Task[]) => Task | null
```

### `getCriticalPath`

Calculate the critical path (longest dependency chain). Returns task IDs along the critical path.

```typescript
(tasks: Task[]) => string[]
```

### `getTaskOrder`

Get task ordering by dependency + priority.

```typescript
(tasks: Task[]) => string[]
```

### `getParallelTasks`

Get parallelizable tasks (tasks with no unmet dependencies).

```typescript
(tasks: Task[]) => string[]
```

### `suggestRelated`

Suggest related tasks based on shared attributes.

```typescript
(taskId: string, opts: { threshold?: number | undefined; cwd?: string | undefined; }, accessor?: DataAccessor | undefined) => Promise<Record<string, unknown>>
```

### `addRelation`

Add a relation between tasks.

```typescript
(from: string, to: string, type: string, reason: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Record<string, unknown>>
```

### `discoverRelated`

Discover related tasks using various methods.

```typescript
(taskId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Record<string, unknown>>
```

### `listRelations`

List existing relations for a task.

```typescript
(taskId: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Record<string, unknown>>
```

### `canCancel`

Check if a task can be cancelled.

```typescript
(task: Task) => { allowed: boolean; reason?: string | undefined; }
```

### `cancelTask`

Cancel a task in the tasks array (returns updated array). Does NOT handle children - use deletion-strategy for that.

```typescript
(taskId: string, tasks: Task[], reason?: string | undefined) => { tasks: Task[]; result: CancelResult; }
```

### `cancelMultiple`

Batch cancel multiple tasks.

```typescript
(taskIds: string[], tasks: Task[], reason?: string | undefined) => { tasks: Task[]; results: CancelResult[]; }
```

### `coreTaskNext`

Suggest next task to work on based on priority, phase, age, and deps.  T4790

```typescript
(projectRoot: string, params?: { count?: number | undefined; explain?: boolean | undefined; } | undefined) => Promise<{ suggestions: { id: string; title: string; priority: string; phase: string | null; score: number; reasons?: string[] | undefined; }[]; totalCandidates: number; }>
```

### `coreTaskBlockers`

Show blocked tasks and analyze blocking chains.  T4790

```typescript
(projectRoot: string, params?: { analyze?: boolean | undefined; limit?: number | undefined; } | undefined) => Promise<{ blockedTasks: { id: string; title: string; status: string; depends?: string[] | undefined; blockingChain: string[]; }[]; criticalBlockers: BottleneckTask[]; summary: string; total: number; limit: n...
```

### `coreTaskTree`

Build hierarchy tree.  T4790

```typescript
(projectRoot: string, taskId?: string | undefined) => Promise<{ tree: FlatTreeNode[]; totalNodes: number; }>
```

### `coreTaskDeps`

Show dependencies for a task.  T4790

```typescript
(projectRoot: string, taskId: string) => Promise<TaskDepsResult>
```

### `coreTaskRelates`

Show task relations.  T4790

```typescript
(projectRoot: string, taskId: string) => Promise<{ taskId: string; relations: { taskId: string; type: string; reason?: string | undefined; }[]; count: number; }>
```

### `coreTaskRelatesAdd`

Add a relation between two tasks.  T4790

```typescript
(projectRoot: string, taskId: string, relatedId: string, type: string, reason?: string | undefined) => Promise<{ from: string; to: string; type: string; reason?: string | undefined; added: boolean; }>
```

### `coreTaskAnalyze`

Analyze tasks for priority and leverage.  T4790

```typescript
(projectRoot: string, taskId?: string | undefined, params?: { tierLimit?: number | undefined; } | undefined) => Promise<TaskAnalysisResult & { tierLimit: number; }>
```

### `coreTaskRestore`

Restore a cancelled task back to pending.  T4790

```typescript
(projectRoot: string, taskId: string, params?: { cascade?: boolean | undefined; notes?: string | undefined; } | undefined) => Promise<{ task: string; restored: string[]; count: number; }>
```

### `coreTaskCancel`

Cancel a task (sets status to 'cancelled', a soft terminal state). Use restore to reverse. Use delete for permanent removal.  T4529

```typescript
(projectRoot: string, taskId: string, params?: { reason?: string | undefined; } | undefined) => Promise<{ task: string; cancelled: boolean; reason?: string | undefined; cancelledAt: string; }>
```

### `coreTaskUnarchive`

Move an archived task back to active tasks.  T4790

```typescript
(projectRoot: string, taskId: string, params?: { status?: string | undefined; preserveStatus?: boolean | undefined; } | undefined) => Promise<{ task: string; unarchived: boolean; title: string; status: string; }>
```

### `coreTaskReorder`

Change task position within its sibling group.  T4790

```typescript
(projectRoot: string, taskId: string, position: number) => Promise<{ task: string; reordered: boolean; newPosition: number; totalSiblings: number; }>
```

### `coreTaskReparent`

Move task under a different parent.  T4790

```typescript
(projectRoot: string, taskId: string, newParentId: string | null) => Promise<{ task: string; reparented: boolean; oldParent: string | null; newParent: string | null; newType?: string | undefined; }>
```

### `coreTaskPromote`

Promote a subtask to task or task to root.  T4790

```typescript
(projectRoot: string, taskId: string) => Promise<{ task: string; promoted: boolean; previousParent: string | null; typeChanged: boolean; }>
```

### `coreTaskReopen`

Reopen a completed task.  T4790

```typescript
(projectRoot: string, taskId: string, params?: { status?: string | undefined; reason?: string | undefined; } | undefined) => Promise<{ task: string; reopened: boolean; previousStatus: string; newStatus: string; }>
```

### `coreTaskComplexityEstimate`

Deterministic complexity scoring from task metadata.  T4790

```typescript
(projectRoot: string, params: { taskId: string; }) => Promise<{ size: "medium" | "small" | "large"; score: number; factors: ComplexityFactor[]; dependencyDepth: number; subtaskCount: number; fileCount: number; }>
```

### `coreTaskDepsOverview`

Overview of all dependencies across the project.  T5157

```typescript
(projectRoot: string) => Promise<{ totalTasks: number; tasksWithDeps: number; blockedTasks: (TaskRef & { unblockedBy: string[]; })[]; readyTasks: TaskRef[]; validation: { valid: boolean; errorCount: number; warningCount: number; }; }>
```

### `coreTaskDepsCycles`

Detect circular dependencies across the project.  T5157

```typescript
(projectRoot: string) => Promise<{ hasCycles: boolean; cycles: { path: string[]; tasks: Pick<TaskRef, "id" | "title">[]; }[]; }>
```

### `coreTaskDepends`

List dependencies for a task in a given direction.  T4790

```typescript
(projectRoot: string, taskId: string, direction?: "upstream" | "downstream" | "both", options?: { tree?: boolean | undefined; } | undefined) => Promise<{ taskId: string; direction: string; ... 6 more ...; upstreamTree?: FlatTreeNode[] | undefined; }>
```

### `coreTaskStats`

Compute task statistics.  T4790

```typescript
(projectRoot: string, epicId?: string | undefined) => Promise<{ total: number; pending: number; active: number; blocked: number; done: number; cancelled: number; byPriority: Record<string, number>; byType: Record<...>; }>
```

### `coreTaskExport`

Export tasks as JSON or CSV.  T4790

```typescript
(projectRoot: string, params?: { format?: "json" | "csv" | undefined; status?: string | undefined; parent?: string | undefined; } | undefined) => Promise<unknown>
```

### `coreTaskHistory`

Get task history from the log file.  T4790

```typescript
(projectRoot: string, taskId: string, limit?: number | undefined) => Promise<Record<string, unknown>[]>
```

### `coreTaskLint`

Lint tasks for common issues.  T4790

```typescript
(projectRoot: string, taskId?: string | undefined) => Promise<{ taskId: string; severity: "error" | "warning"; rule: string; message: string; }[]>
```

### `coreTaskBatchValidate`

Validate multiple tasks at once.  T4790

```typescript
(projectRoot: string, taskIds: string[], checkMode?: "full" | "quick") => Promise<{ results: Record<string, { severity: "error" | "warning"; rule: string; message: string; }[]>; summary: { ...; }; }>
```

### `coreTaskImport`

Import tasks from a JSON source string.  T4790

```typescript
(projectRoot: string, source: string, overwrite?: boolean | undefined) => Promise<{ imported: number; skipped: number; errors: string[]; remapTable?: Record<string, string> | undefined; }>
```

### `analyzeTaskPriority`

Analyze task priority with leverage scoring.

```typescript
(opts: { autoStart?: boolean | undefined; cwd?: string | undefined; }, accessor?: DataAccessor | undefined) => Promise<AnalysisResult>
```

### `listLabels`

List all labels with task counts.

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<LabelInfo[]>
```

### `showLabelTasks`

Show tasks with a specific label.

```typescript
(label: string, cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Record<string, unknown>>
```

### `getLabelStats`

Get detailed label statistics.

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<Record<string, unknown>>
```

### `createStoreProvider`

Create a store provider. Always creates SQLite provider (ADR-006).  T4647

```typescript
(_engine?: "sqlite" | undefined, cwd?: string | undefined) => Promise<StoreProvider>
```

### `getStore`

Get a StoreProvider instance for the given working directory. Convenience wrapper around createStoreProvider with auto-detection.   T4645  T4638

```typescript
(cwd?: string | undefined) => Promise<StoreProvider>
```

### `countJsonRecords`

Count records in JSON source files.

```typescript
(cleoDir: string) => { tasks: number; archived: number; sessions: number; }
```

### `migrateJsonToSqliteAtomic`

Migrate JSON data to SQLite with atomic rename pattern. Writes to a temporary database file first, then atomically renames.

```typescript
(cwd?: string | undefined, tempDbPath?: string | undefined, logger?: MigrationLogger | undefined) => Promise<MigrationResult>
```

**Parameters:**

- `cwd` — Optional working directory
- `tempDbPath` — Optional temporary database path for atomic migration
- `logger` — Optional migration logger for audit trail (task T4727)

**Returns:** Migration result

### `migrateJsonToSqlite`

```typescript
(cwd?: string | undefined, options?: MigrationOptions | undefined) => Promise<MigrationResult>
```

### `exportToJson`

Export SQLite data back to JSON format (for inspection or emergency recovery).

```typescript
(cwd?: string | undefined) => Promise<{ tasks: Task[]; archived: Task[]; sessions: Session[]; }>
```

### `repairMissingSizes`

Set size='medium' on tasks that have no size value. Operates directly on the SQLite tasks table.

```typescript
(cwd: string | undefined, dryRun: boolean) => Promise<RepairAction>
```

### `repairMissingCompletedAt`

Set completedAt=now() on done/cancelled tasks that are missing a completedAt timestamp. Operates directly on the SQLite tasks table.

```typescript
(cwd: string | undefined, dryRun: boolean) => Promise<RepairAction>
```

### `runAllRepairs`

Run all repair functions. Returns all actions taken (or previewed in dry-run mode).

```typescript
(cwd: string | undefined, dryRun: boolean) => Promise<RepairAction[]>
```

### `runUpgrade`

Run a full upgrade pass on the project .cleo/ directory.  Steps:   1. Pre-flight storage check (JSON → SQLite)   2. If migration needed and not dry-run, run auto-migration with backup   3. Schema version checks on JSON files   4. Structural repairs (checksums, missing fields)

```typescript
(options?: { dryRun?: boolean | undefined; includeGlobal?: boolean | undefined; autoMigrate?: boolean | undefined; cwd?: string | undefined; }) => Promise<UpgradeResult>
```

**Parameters:**

- `` — options.dryRun  Preview changes without applying
- `` — options.includeGlobal  Also check global ~/.cleo
- `` — options.autoMigrate  Auto-migrate storage if needed (default: true)
- `` — options.cwd  Project directory override

### `createVerificationGate`

Factory function for creating verification gates

```typescript
(strictMode?: boolean) => VerificationGate
```

### `isValidWorkflowGateName`

Validate a workflow gate name string

```typescript
(name: string) => name is WorkflowGateName
```

### `getWorkflowGateDefinition`

Get the definition for a workflow gate

```typescript
(name: WorkflowGateName) => WorkflowGateDefinition | undefined
```

### `validateLayer1Schema`

Layer 1: Schema Validation  Validates operation parameters against JSON Schema definitions. Checks required fields, data types, and format constraints.

```typescript
(context: OperationContext) => Promise<LayerResult>
```

### `validateLayer2Semantic`

Layer 2: Semantic Validation  Validates business rules and logical constraints.

```typescript
(context: OperationContext) => Promise<LayerResult>
```

### `validateLayer3Referential`

Layer 3: Referential Validation  Validates cross-entity references and relationships.

```typescript
(context: OperationContext) => Promise<LayerResult>
```

### `validateLayer4Protocol`

Layer 4: Protocol Validation  Validates RCASD-IVTR+C lifecycle compliance and protocol requirements.

```typescript
(context: OperationContext, _enforcer: ProtocolEnforcer) => Promise<LayerResult>
```

### `isFieldRequired`

Helper to check if a field is required for an operation

```typescript
(domain: string, operation: string, field: string) => boolean
```

### `validateWorkflowGateName`

Validate a workflow gate name   T3141

```typescript
(name: string) => boolean
```

### `validateWorkflowGateStatus`

Validate a workflow gate status value per Section 7.3   T3141

```typescript
(status: unknown) => status is "failed" | "blocked" | "passed" | null
```

### `validateWorkflowGateUpdate`

Validate a gate update operation.   T3141

```typescript
(gateName: string, status: string, agent?: string | undefined, tracker?: WorkflowGateTracker | undefined) => GateViolation[]
```

### `buildMcpInputSchema`

Build a JSON Schema `input_schema` object from an `OperationDef`.  Algorithm:  1. Iterate `def.params`  2. Skip params where `mcp.hidden === true`  3. Map ParamType → JSON Schema type  4. Collect names where `required === true` into `required[]`  5. Return  type: 'object', properties, required

```typescript
(def: OperationDef) => JSONSchemaObject
```

### `buildCommanderArgs`

Split `OperationDef.params` into positional arguments and option flags, suitable for Commander.js registration.  - `cli.positional === true` → goes into `positionals[]` - everything else with a `cli` key → goes into `options[]` - Params with no `cli` key → MCP-only; excluded from both arrays

```typescript
(def: OperationDef) => CommanderArgSplit
```

### `buildCommanderOptionString`

Build the Commander option string for a single non-positional ParamDef.  Examples:    name:'taskId', type:'string', cli:      → '--taskId '    name:'status', type:'string', cli:short:'-s', flag:'status'      → '-s, --status '    name:'dryRun', type:'boolean', cli:flag:'dry-run'      → '--dry-run'    name:'limit', type:'number', cli:      → '--limit '

```typescript
(param: ParamDef) => string
```

### `camelToKebab`

Convert a camelCase string to kebab-case. e.g. 'includeArchive' → 'include-archive'

```typescript
(s: string) => string
```

### `validateRequiredParamsDef`

Validates that all required parameters are present in the request. Returns an array of missing parameter names.  Replaces the old `requiredParams: string[]` check in registry.ts.

```typescript
(def: OperationDef, params?: Record<string, unknown> | undefined) => string[]
```

### `validateConsensusTask`

Validate consensus protocol for a task.

```typescript
(taskId: string, opts: { strict?: boolean | undefined; votingMatrixFile?: string | undefined; }) => Promise<ValidationResult>
```

### `checkConsensusManifest`

Validate consensus protocol from manifest file.

```typescript
(manifestFile: string, opts: { strict?: boolean | undefined; votingMatrixFile?: string | undefined; }) => Promise<ValidationResult>
```

### `validateContributionTask`

Validate contribution protocol for a task.

```typescript
(taskId: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `checkContributionManifest`

Validate contribution protocol from manifest file.

```typescript
(manifestFile: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `validateDecompositionTask`

Validate decomposition protocol for a task.

```typescript
(taskId: string, opts: { strict?: boolean | undefined; epicId?: string | undefined; }) => Promise<ValidationResult>
```

### `checkDecompositionManifest`

Validate decomposition protocol from manifest file.

```typescript
(manifestFile: string, opts: { strict?: boolean | undefined; epicId?: string | undefined; }) => Promise<ValidationResult>
```

### `validateImplementationTask`

Validate implementation protocol for a task.

```typescript
(taskId: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `checkImplementationManifest`

Validate implementation protocol from manifest file.

```typescript
(manifestFile: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `validateSpecificationTask`

Validate specification protocol for a task.

```typescript
(taskId: string, opts: { strict?: boolean | undefined; specFile?: string | undefined; }) => Promise<ValidationResult>
```

### `checkSpecificationManifest`

Validate specification protocol from manifest file.

```typescript
(manifestFile: string, opts: { strict?: boolean | undefined; specFile?: string | undefined; }) => Promise<ValidationResult>
```

### `validateSchema`

Validate data against a CLEO schema

```typescript
(schemaType: "config", data: unknown) => ValidationResult
```

**Parameters:**

- `schemaType` — Which schema to validate against
- `data` — The data to validate

**Returns:** Validation result with errors if invalid

### `validateTask`

Validate a single task object against the drizzle-zod insert schema. Uses drizzle-derived Zod schemas as the single source of truth for field-level constraints (pattern, length, enum).

```typescript
(task: unknown) => ValidationResult
```

**Parameters:**

- `task` — Task object to validate

**Returns:** Validation result

### `clearSchemaCache`

Clear the schema cache (useful for testing)

```typescript
() => void
```

### `validateTitleDescription`

Validate that title and description are both present and different. This is a critical anti-hallucination check.

```typescript
(title?: string | undefined, description?: string | undefined) => RuleViolation[]
```

### `validateTimestamps`

Validate that timestamps are not in the future

```typescript
(task: TaskLike) => RuleViolation[]
```

### `validateIdUniqueness`

Validate ID uniqueness across all tasks (todo + archive)

```typescript
(taskId: string, existingIds: Set<string>) => RuleViolation[]
```

### `validateNoDuplicateDescription`

Validate no duplicate task descriptions

```typescript
(description: string, existingDescriptions: string[], _excludeTaskId?: string | undefined) => RuleViolation[]
```

### `validateHierarchy`

Validate hierarchy constraints. Accepts optional limits to override defaults (from config).

```typescript
(parentId: string | null | undefined, tasks: { id: string; parentId?: string | null | undefined; type?: string | undefined; }[], _taskType?: string | undefined, limits?: { maxDepth?: number | undefined; maxSiblings?: number | undefined; } | undefined) => RuleViolation[]
```

### `validateStatusTransition`

Validate status transition

```typescript
(currentStatus: string, newStatus: string) => RuleViolation[]
```

### `validateNewTask`

Run all validation rules on a task being created

```typescript
(task: TaskLike, existingIds: Set<string>, existingDescriptions: string[], existingTasks: { id: string; parentId?: string | null | undefined; type?: string | undefined; }[], limits?: { ...; } | undefined) => RuleViolation[]
```

### `hasErrors`

Check if violations contain any errors (not just warnings)

```typescript
(violations: RuleViolation[]) => boolean
```

### `coreValidateReport`

Run comprehensive validation report on tasks database — checks business rules, dependencies, checksums, data integrity, and schema compliance.  T4795

```typescript
(projectRoot: string) => Promise<ValidateReportResult>
```

### `coreValidateAndFix`

Run validation report, then apply data repairs for fixable issues. Calls runAllRepairs() from src/core/repair.ts (same repairs used by `upgrade`).  T4795

```typescript
(projectRoot: string, dryRun?: boolean) => Promise<ValidateAndFixResult>
```

### `coreValidateSchema`

Validate data against a schema type.  For SQLite-backed types (todo, archive, sessions, log), queries rows directly from SQLite and validates with drizzle-zod schemas. For config type, uses AJV against the JSON schema file. If raw `data` is provided, validates directly with AJV (backward compat).   T4786

```typescript
(type: string, data: unknown, projectRoot: string) => Promise<{ type: string; valid: boolean; errors: unknown[]; errorCount: number; }>
```

### `coreValidateTask`

Validate a single task against anti-hallucination rules.  T4786

```typescript
(taskId: string, projectRoot: string) => Promise<{ taskId: string; valid: boolean; violations: RuleViolation[]; errorCount: number; warningCount: number; }>
```

### `coreValidateProtocol`

Check basic protocol compliance for a task.  T4786

```typescript
(taskId: string, protocolType: string | undefined, projectRoot: string) => Promise<{ taskId: string; protocolType: string; compliant: boolean; violations: { code: string; message: string; severity: string; }[]; }>
```

### `coreValidateManifest`

Validate manifest JSONL entries for required fields.  T4786

```typescript
(projectRoot: string) => { valid: boolean; totalEntries: number; validEntries: number; invalidEntries: number; errors: { line: number; entryId: string; errors: string[]; }[]; message?: string | undefined; }
```

### `coreValidateOutput`

Validate an output file for required sections.  T4786

```typescript
(filePath: string, taskId: string | undefined, projectRoot: string) => { filePath: string; valid: boolean; issues: { code: string; message: string; severity: string; }[]; fileSize: number; lineCount: number; }
```

### `coreComplianceSummary`

Get aggregated compliance metrics.  T4786

```typescript
(projectRoot: string) => { total: number; pass: number; fail: number; partial: number; passRate: number; byProtocol: Record<string, { pass: number; fail: number; partial: number; }>; }
```

### `coreComplianceViolations`

List compliance violations.  T4786

```typescript
(limit: number | undefined, projectRoot: string) => { violations: { timestamp: string; taskId: string; protocol: string; result: string; violations?: { code: string; message: string; severity: "error" | "warning"; }[] | undefined; }[]; total: number; }
```

### `coreComplianceRecord`

Record a compliance check result to COMPLIANCE.jsonl.  T4786

```typescript
(taskId: string, result: string, protocol: string | undefined, violations: { code: string; message: string; severity: "error" | "warning"; }[] | undefined, projectRoot: string) => { ...; }
```

### `coreTestStatus`

Check test suite availability.  T4786

```typescript
(projectRoot: string) => { batsTests: { available: boolean; directory: string | null; }; mcpTests: { available: boolean; directory: string | null; }; message: string; }
```

### `coreCoherenceCheck`

Cross-validate task graph for consistency.  T4786

```typescript
(projectRoot: string) => Promise<{ coherent: boolean; issues: CoherenceIssue[]; }>
```

### `coreTestRun`

Execute test suite via subprocess.  T4786

```typescript
(params: { scope?: string | undefined; pattern?: string | undefined; parallel?: boolean | undefined; } | undefined, projectRoot: string) => { ran: boolean; runner?: string | undefined; ... 5 more ...; message?: string | undefined; }
```

### `coreBatchValidate`

Batch validate all tasks against schema and rules.  T4786

```typescript
(projectRoot: string) => Promise<{ totalTasks: number; validTasks: number; invalidTasks: number; totalErrors: number; totalWarnings: number; results: { taskId: string; valid: boolean; errorCount: number; warningCount: number; violations: RuleViolation[]; }[]; }>
```

### `coreTestCoverage`

Get test coverage metrics.  T4786

```typescript
(projectRoot: string) => { [key: string]: unknown; available: boolean; message?: string | undefined; }
```

### `buildBrainState`

Build brain state for agent bootstrapping.

```typescript
(projectRoot: string, opts?: { speed?: "full" | "fast" | "complete" | undefined; } | undefined, accessor?: DataAccessor | undefined) => Promise<BrainState>
```

### `getCriticalPath`

Find the critical path (longest dependency chain) in the task graph.

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<CriticalPathResult>
```

### `resolveSkillPathsForProvider`

Get effective skill paths for a provider considering precedence

```typescript
(providerId: string, scope: "global" | "project", projectRoot?: string | undefined) => Promise<ResolvedSkillPath[]>
```

**Parameters:**

- `providerId` — The ID of the provider
- `scope` — The scope ('global' or 'project')
- `projectRoot` — Optional project root path for project-scoped resolution

**Returns:** Array of resolved skill paths with precedence information

### `getProvidersWithPrecedence`

Get all providers that use a specific precedence mode

```typescript
(precedence: SkillsPrecedence) => string[]
```

**Parameters:**

- `precedence` — The precedence mode to filter by

**Returns:** Array of provider IDs using the specified precedence

### `getSkillsMapWithPrecedence`

Build complete skills map with precedence information

```typescript
() => { providerId: string; toolName: string; precedence: SkillsPrecedence; paths: { global: string | null; project: string | null; }; }[]
```

**Returns:** Array of provider skill configurations with precedence data

### `determineInstallationTargets`

Determine target installation paths for a skill

```typescript
(context: SkillInstallationContext) => Promise<{ providerId: string; path: string; }[]>
```

**Parameters:**

- `context` — The installation context including target providers and project root

**Returns:** Array of installation targets with provider ID and path

### `supportsAgentsPath`

Check if provider supports agents path

```typescript
(providerId: string) => Promise<boolean>
```

**Parameters:**

- `providerId` — The ID of the provider to check

**Returns:** True if provider has agents path configuration

### `coreTaskPlan`

Build composite planning view.  T4914

```typescript
(projectRoot: string) => Promise<PlanResult>
```

### `buildIndex`

Scan .cleo/rcasd/ and legacy .cleo/rcsd/ directories and build the RCASD index.  Reads all _manifest.json files and any spec/report markdown files to produce a complete index.

```typescript
(cwd?: string | undefined) => RcasdIndex
```

**Parameters:**

- `cwd` — Working directory

**Returns:** Populated RcasdIndex  T4801

### `writeIndex`

Write RCASD-INDEX.json to disk.

```typescript
(index: RcasdIndex, cwd?: string | undefined) => void
```

**Parameters:**

- `index` — The index to write
- `cwd` — Working directory  T4801

### `readIndex`

Read RCASD-INDEX.json from disk.

```typescript
(cwd?: string | undefined) => RcasdIndex | null
```

**Parameters:**

- `cwd` — Working directory

**Returns:** The index or null if not found  T4801

### `rebuildIndex`

Rebuild and write the index from current disk state.

```typescript
(cwd?: string | undefined) => RcasdIndex
```

**Parameters:**

- `cwd` — Working directory

**Returns:** The rebuilt index  T4801

### `getTaskAnchor`

Get task anchor by task ID.

```typescript
(taskId: string, cwd?: string | undefined) => TaskAnchor | null
```

**Parameters:**

- `taskId` — The task ID to look up
- `cwd` — Working directory

**Returns:** TaskAnchor or null  T4801

### `findByStage`

Find tasks by pipeline stage.

```typescript
(stage: string, cwd?: string | undefined) => [string, TaskAnchor][]
```

**Parameters:**

- `stage` — The pipeline stage to filter by
- `cwd` — Working directory

**Returns:** Array of [taskId, anchor] pairs  T4801

### `findByStatus`

Find tasks by status.

```typescript
(status: "completed" | "failed" | "active" | "archived" | "paused", cwd?: string | undefined) => [string, TaskAnchor][]
```

**Parameters:**

- `status` — The status to filter by
- `cwd` — Working directory

**Returns:** Array of [taskId, anchor] pairs  T4801

### `getIndexTotals`

Get index summary statistics.

```typescript
(cwd?: string | undefined) => IndexTotals | null
```

**Parameters:**

- `cwd` — Working directory

**Returns:** Index totals or null  T4801

### `generateCodebaseMapSummary`

```typescript
(result: CodebaseMapResult) => string
```

### `sequenceChains`

Sequence two chains: connect A's exit points to B's entry point.  B's stage IDs are prefixed with "b" to avoid collision with A. The result is validated and throws if invalid.   T5406

```typescript
(a: WarpChain, b: WarpChain) => WarpChain
```

### `parallelChains`

Compose chains in parallel with a common fork entry and join stage.  Creates a fork entry stage that links to each chain's entry, and all chain exits link to the provided joinStage.  Each chain's IDs are prefixed with "pindex" to avoid collisions.   T5406

```typescript
(chains: WarpChain[], joinStage: WarpStage) => WarpChain
```

### `resolveEpicFromContent`

Extract an epic/task ID from file content by searching for:   1. `@task T####` or `@epic T####` annotations (highest priority)   2. JSON `"task"`, `"epicId"`, or `"taskId"` fields   3. First `T####` at a word boundary (fallback)

```typescript
(content: string) => string | null
```

### `resolveEpicFromFilename`

Extract an epic ID from a filename pattern like `T####-*` or `T####_*`.

```typescript
(filename: string) => string | null
```

### `normalizeDirectoryNames`

Rename suffixed epic directories (e.g. `T4881_install-channels` → `T4881`).

```typescript
(options?: ConsolidateOptions) => MoveRecord[]
```

### `migrateConsensusFiles`

Migrate `.cleo/consensus/` files to appropriate epic's consensus/ subdirectory.  - T4869-checkpoint-consensus.json → rcasd/T4869/consensus/ - Agent finding files and CONSENSUS-REPORT.md → resolve epic from content - phase1-best-practices-evidence.md → resolve epic from content → research/

```typescript
(options?: ConsolidateOptions) => MoveRecord[]
```

### `migrateContributionFiles`

Migrate `.cleo/contributions/` files to appropriate epic's contributions/ subdirectory.  Files follow the pattern `T####-session-*.json` with epicId in content.

```typescript
(options?: ConsolidateOptions) => MoveRecord[]
```

### `migrateLooseFiles`

Migrate loose `T####_*.md` files from `.cleo/rcasd/` root into `rcasd/{epicId}/research/` subdirectories.

```typescript
(options?: ConsolidateOptions) => MoveRecord[]
```

### `consolidateRcasd`

Consolidate all provenance files into the unified `.cleo/rcasd/{epicId}/` structure with stage subdirectories.  Performs migrations in order:   1. Rename suffixed directories (T4881_install-channels → T4881)   2. Move consensus files to appropriate epic's consensus/ subdirectory   3. Move contribution files to appropriate epic's contributions/ subdirectory   4. Move loose research files to appropriate epic's research/ subdirectory

```typescript
(options?: ConsolidateOptions) => MigrationResult
```

**Parameters:**

- `` — options.dryRun - If true, log planned moves without executing them
- `` — options.cwd - Optional working directory override

### `initializePipeline`

Initialize a new pipeline for a task.  Creates a new pipeline record in the database with all 9 stages initialized to 'not_started' status. The pipeline starts at the research stage by default.

```typescript
(taskId: string, options?: InitializePipelineOptions) => Promise<Pipeline>
```

**Parameters:**

- `taskId` — The task ID (e.g., 'T4800')
- `options` — Optional configuration

**Returns:** Promise resolving to the created Pipeline

```typescript
const pipeline = await initializePipeline('T4800', {
  startStage: 'research',
  assignedAgent: 'agent-001'
});
console.log(`Pipeline initialized: ${pipeline.id}`);
```

### `getPipeline`

Retrieve a pipeline by task ID.  Returns the complete pipeline state including current stage and status. Returns null if no pipeline exists for the given task ID.

```typescript
(taskId: string) => Promise<Pipeline | null>
```

**Parameters:**

- `taskId` — The task ID (e.g., 'T4800')

**Returns:** Promise resolving to Pipeline or null

```typescript
const pipeline = await getPipeline('T4800');
if (pipeline) {
  console.log(`Current stage: ${pipeline.currentStage}`);
}
```

### `advanceStage`

Advance a pipeline to the next stage.  Performs atomic stage transition with prerequisite checking and audit logging. Validates the transition is allowed, updates stage statuses, and records the transition in the audit trail.

```typescript
(taskId: string, options: AdvanceStageOptions) => Promise<void>
```

**Parameters:**

- `taskId` — The task ID
- `options` — Advance options including target stage and reason

**Returns:** Promise resolving when transition is complete

```typescript
await advanceStage('T4800', {
  toStage: 'consensus',
  reason: 'Research completed, moving to consensus',
  initiatedBy: 'agent-001'
});
```

### `getCurrentStage`

Get the current stage of a pipeline.  Convenience method to quickly check which stage a task is currently in.

```typescript
(taskId: string) => Promise<"research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release">
```

**Parameters:**

- `taskId` — The task ID

**Returns:** Promise resolving to the current Stage

```typescript
const currentStage = await getCurrentStage('T4800');
if (currentStage === 'validation') {
  console.log('Task is in verification');
}
```

### `listPipelines`

List pipelines with optional filtering.

```typescript
(options?: PipelineQueryOptions) => Promise<Pipeline[]>
```

**Parameters:**

- `options` — Query options for filtering and pagination

**Returns:** Promise resolving to array of Pipelines

```typescript
const activePipelines = await listPipelines({
  status: 'active',
  limit: 10
});
```

### `completePipeline`

Complete a pipeline (mark all stages done).  Marks the pipeline as completed and sets the completion timestamp. Only valid when the pipeline is in the 'release' stage.

```typescript
(taskId: string, _reason?: string | undefined) => Promise<void>
```

**Parameters:**

- `taskId` — The task ID
- `_reason` — Optional completion reason (unused, for API compatibility)

**Returns:** Promise resolving when complete   T4800  T4912 - Implemented SQLite wiring

### `cancelPipeline`

Cancel a pipeline before completion.  Marks the pipeline as cancelled (user-initiated). Once cancelled, the pipeline cannot be resumed (a new one must be created). Use this for deliberate user decisions to abandon a pipeline. System-forced terminations should use the 'aborted' status directly.

```typescript
(taskId: string, reason: string) => Promise<void>
```

**Parameters:**

- `taskId` — The task ID
- `reason` — Reason for cancellation

**Returns:** Promise resolving when cancelled   T4800  T4912 - Implemented SQLite wiring

### `pipelineExists`

Check if a pipeline exists for a task.

```typescript
(taskId: string) => Promise<boolean>
```

**Parameters:**

- `taskId` — The task ID

**Returns:** Promise resolving to boolean   T4800  T4912 - Implemented SQLite wiring

### `getPipelineStatistics`

Get pipeline statistics.  Returns aggregate counts of pipelines by status and stage.

```typescript
() => Promise<{ total: number; byStatus: Record<"completed" | "failed" | "cancelled" | "active" | "blocked" | "aborted", number>; byStage: Partial<Record<"research" | "consensus" | "architecture_decision" | ... 5 more ... | "release", number>>; }>
```

**Returns:** Promise resolving to statistics object   T4800  T4912 - Implemented SQLite wiring

### `getPipelineStages`

Get all stages for a pipeline.

```typescript
(taskId: string) => Promise<PipelineStageRecord[]>
```

**Parameters:**

- `taskId` — The task ID

**Returns:** Promise resolving to array of stage records   T4912

### `findResumablePipelines`

Query active pipelines that can be resumed.  Searches the lifecycle_pipelines table for pipelines with status 'active' and joins with lifecycle_stages to determine current stage status. Also joins with tasks table to get task metadata.

```typescript
(options?: FindResumableOptions, cwd?: string | undefined) => Promise<ResumablePipeline[]>
```

**Parameters:**

- `options` — Query options for filtering
- `cwd` — Working directory for database

**Returns:** Promise resolving to array of resumable pipelines

```typescript
// Find all active pipelines
const resumable = await findResumablePipelines();

// Find specific tasks
const specific = await findResumablePipelines({
  taskIds: ['T4805', 'T4806']
});

// Include blocked pipelines
const withBlocked = await findResumablePipelines({
  includeBlocked: true
});
```

### `loadPipelineContext`

Load complete pipeline context for session resume.  Uses SQL JOINs to efficiently load all related data: - Pipeline and current stage - All stages with their status - Gate results for current stage - Evidence linked to current stage - Recent transitions - Task details

```typescript
(taskId: string, cwd?: string | undefined) => Promise<PipelineContext>
```

**Parameters:**

- `taskId` — The task ID to load context for
- `cwd` — Working directory for database

**Returns:** Promise resolving to pipeline context

```typescript
const context = await loadPipelineContext('T4805');
console.log(`Current stage: ${context.currentStage}`);
console.log(`Stage status: ${context.stages.find(s => s.stage === context.currentStage)?.status}`);
```

### `resumeStage`

Resume a specific stage in a pipeline.  Updates the stage status from 'blocked' or 'not_started' to 'in_progress', records the transition, and returns the resume result.

```typescript
(taskId: string, targetStage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", options?: { ...; }, cwd?: string | undefined) => Promise<...>
```

**Parameters:**

- `taskId` — The task ID
- `targetStage` — The stage to resume
- `options` — Resume options
- `cwd` — Working directory for database

**Returns:** Promise resolving to resume result

```typescript
const result = await resumeStage('T4805', 'implement');
if (result.success) {
  console.log(`Resumed ${result.taskId} at ${result.stage}`);
}
```

### `autoResume`

Auto-detect where to resume across all active pipelines.  Finds the best candidate for resuming work based on: 1. Active stages (currently in progress) 2. Blocked stages (can be unblocked) 3. Failed stages (can be retried) 4. Priority ordering

```typescript
(cwd?: string | undefined) => Promise<AutoResumeResult>
```

**Parameters:**

- `cwd` — Working directory for database

**Returns:** Promise resolving to auto-resume result

```typescript
const result = await autoResume();
if (result.canResume) {
  console.log(`Recommended: Resume ${result.taskId} at ${result.stage}`);
} else if (result.options && result.options.length > 0) {
  console.log('Multiple options available:', result.options);
}
```

### `checkSessionResume`

Check for resumable work on session start.  Integrates with session initialization to check for active pipelines and present resumable work to the user. Can auto-resume if there's a clear single candidate.

```typescript
(options?: SessionResumeCheckOptions, cwd?: string | undefined) => Promise<SessionResumeCheckResult>
```

**Parameters:**

- `options` — Resume check options
- `cwd` — Working directory for database

**Returns:** Promise resolving to resume check result

```typescript
// On session start
const resumeCheck = await checkSessionResume({ autoResume: true });
if (resumeCheck.didResume) {
  console.log(`Auto-resumed ${resumeCheck.resumedTaskId}`);
} else if (resumeCheck.requiresUserChoice) {
  console.log('Multiple options:', resumeCheck.options);
}
```

### `formatResumeSummary`

Get resume summary for display to user.  Formats resumable pipelines into a human-readable summary.

```typescript
(pipelines: ResumablePipeline[]) => string
```

**Parameters:**

- `pipelines` — Resumable pipelines

**Returns:** Formatted summary string   T4805

### `handleCompletedStage`

Handle completed stage edge case.  If the current stage is completed, suggests advancing to next stage.

```typescript
(context: PipelineContext) => { action: "review" | "advance" | "stay"; message: string; nextStage?: "research" | "consensus" | "architecture_decision" | "specification" | ... 5 more ... | undefined; }
```

**Parameters:**

- `context` — Pipeline context

**Returns:** Recommendation for handling completed stage   T4805

### `handleBlockedStage`

Handle blocked stage edge case.  Provides information about why a stage is blocked and potential resolutions.

```typescript
(context: PipelineContext) => { isBlocked: boolean; blockReason?: string | undefined; blockedSince?: Date | undefined; resolutions: string[]; canUnblock: boolean; }
```

**Parameters:**

- `context` — Pipeline context

**Returns:** Block analysis and resolution hints   T4805

### `checkBlockedStageDetails`

Handle blocked stage edge case - async version with database lookup.

```typescript
(taskId: string, cwd?: string | undefined) => Promise<{ isBlocked: boolean; blockReason?: string | undefined; blockedSince?: Date | undefined; resolutions: string[]; canUnblock: boolean; prerequisites?: { ...; }[] | undefined; }>
```

**Parameters:**

- `taskId` — Task ID to check
- `cwd` — Working directory

**Returns:** Block analysis with prerequisite details   T4805

### `checkPrerequisites`

Check if prerequisites are met for a stage.  Validates that all prerequisite stages are in an acceptable state (completed or skipped) for the target stage to proceed.

```typescript
(targetStage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", currentStages: Record<"research" | ... 7 more ... | "release", StageState>) => Promise<...>
```

**Parameters:**

- `targetStage` — The stage to check prerequisites for
- `currentStages` — Current state of all stages

**Returns:** Promise resolving to PrereqCheck result

```typescript
const check = await checkPrerequisites('implement', {
  research: { status: 'completed' },
  spec: { status: 'completed' },
  decompose: { status: 'completed' },
  // ... other stages
});
if (check.met) {
  console.log('Ready to implement');
}
```

### `validateTransition`

Validate a stage transition.  Comprehensive validation that checks both transition rules and prerequisites. This is the core state machine validation logic.

```typescript
(transition: StateTransition, context: StateMachineContext) => Promise<TransitionValidation>
```

**Parameters:**

- `transition` — The transition to validate
- `context` — Current state machine context

**Returns:** Promise resolving to TransitionValidation

```typescript
const validation = await validateTransition(
  { from: 'spec', to: 'implement', initiatedBy: 'agent-001' },
  pipelineContext
);
if (!validation.valid) {
  console.log(validation.errors);
}
```

### `executeTransition`

Execute a state transition.  Applies the transition to the state machine context, updating stage statuses and returning the new state. This function does NOT persist to database - that is handled by the pipeline module.

```typescript
(transition: StateTransition, context: StateMachineContext) => Promise<StateTransitionResult>
```

**Parameters:**

- `transition` — The transition to execute
- `context` — Current state machine context

**Returns:** Promise resolving to StateTransitionResult

```typescript
const result = await executeTransition(
  { from: 'spec', to: 'implement', initiatedBy: 'agent-001' },
  pipelineContext
);
if (result.success) {
  console.log(`Transitioned to ${result.newState.stage}`);
}
```

### `setStageStatus`

Set the status of a stage.  Updates stage status with validation of allowed state transitions.

```typescript
(stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", status: "completed" | ... 4 more ... | "skipped", context: StateMachineContext) => StageState
```

**Parameters:**

- `stage` — The stage to update
- `status` — The new status
- `context` — Current state machine context

**Returns:** Updated StageState   T4800

### `getStageStatus`

Get the status of a stage.

```typescript
(stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", context: StateMachineContext) => "completed" | ... 4 more ... | "skipped"
```

**Parameters:**

- `stage` — The stage to check
- `context` — Current state machine context

**Returns:** The stage status   T4800

### `isValidStatusTransition`

Check if a status transition is valid.  State transitions:   not_started → in_progress, skipped   in_progress → completed, blocked, failed   blocked     → in_progress   failed      → in_progress (retry)   completed   → (no transition - use force to override)   skipped     → (no transition)

```typescript
(from: "completed" | "failed" | "blocked" | "not_started" | "in_progress" | "skipped", to: "completed" | "failed" | "blocked" | "not_started" | "in_progress" | "skipped") => { ...; }
```

**Parameters:**

- `from` — Current status
- `to` — Target status

**Returns:** Object with valid flag and reason   T4800

### `createInitialContext`

Create initial state machine context for a pipeline.

```typescript
(pipelineId: string, assignedAgent?: string | undefined) => StateMachineContext
```

**Parameters:**

- `pipelineId` — The pipeline/task ID
- `assignedAgent` — Optional agent to assign

**Returns:** Initial StateMachineContext   T4800

### `getValidNextStages`

Get stages that can be transitioned to from the current stage.

```typescript
(context: StateMachineContext, includeForce?: boolean) => ("research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release")[]
```

**Parameters:**

- `context` — Current state machine context
- `includeForce` — Whether to include transitions that require force

**Returns:** Array of valid next stages   T4800

### `getCurrentStageState`

Get the current stage state.

```typescript
(context: StateMachineContext) => StageState
```

**Parameters:**

- `context` — State machine context

**Returns:** Current StageState   T4800

### `isTerminalState`

Check if the pipeline is in a terminal state.

```typescript
(context: StateMachineContext) => boolean
```

**Parameters:**

- `context` — State machine context

**Returns:** True if in release stage and completed   T4800

### `isBlocked`

Check if the pipeline is blocked.

```typescript
(context: StateMachineContext) => boolean
```

**Parameters:**

- `context` — State machine context

**Returns:** True if current stage is blocked   T4800

### `validateTransitions`

Validate multiple transitions.

```typescript
(transitions: StateTransition[], context: StateMachineContext) => Promise<TransitionValidation[]>
```

**Parameters:**

- `transitions` — Array of transitions to validate
- `context` — State machine context

**Returns:** Array of validation results   T4800

### `canSkipStage`

Check if a stage can be skipped.

```typescript
(stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release") => boolean
```

**Parameters:**

- `stage` — The stage to check

**Returns:** True if stage is skippable   T4800

### `skipStage`

Skip a stage with validation.

```typescript
(stage: "research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", _reason: string, context: StateMachineContext) => StageState
```

**Parameters:**

- `stage` — The stage to skip
- `reason` — Reason for skipping
- `context` — State machine context

**Returns:** Updated StageState   T4800

### `getContextStatusFromPercentage`

Determine status from percentage.

```typescript
(percentage: number) => ContextStatus
```

### `processContextInput`

Process context window input and write state file. Returns the status line string for display.  Tries adapter-based context monitoring first; falls back to local implementation.

```typescript
(input: ContextWindowInput, cwd?: string | undefined) => Promise<string>
```

### `isHITLEnabled`

Check if HITL warnings are enabled.

```typescript
(cwd?: string | undefined) => boolean
```

### `generateHITLWarnings`

Generate HITL warnings based on lock state.

```typescript
(cwd?: string | undefined) => HITLWarningsResult
```

### `getHighestLevel`

Get highest warning level from warnings.

```typescript
(warnings: HITLWarning[]) => HITLLevel
```

### `getConcurrencyJson`

Get concurrency data for analyze JSON output.

```typescript
(cwd?: string | undefined) => Record<string, unknown>
```

### `getEnforcementMode`

Get the current enforcement mode.

```typescript
(cwd?: string | undefined) => EnforcementMode
```

### `isSessionEnforcementEnabled`

Check if session enforcement is enabled.

```typescript
(cwd?: string | undefined) => boolean
```

### `getActiveSessionInfo`

Get active session info. Returns null if no active session.

```typescript
(cwd?: string | undefined) => Promise<ActiveSessionInfo | null>
```

### `requireActiveSession`

Require an active session for write operations. In strict mode, throws if no session is active. In warn mode, returns a warning but allows the operation. In none mode, always allows.

```typescript
(operation: string, cwd?: string | undefined) => Promise<EnforcementResult>
```

### `validateTaskInScope`

Validate that a task is within the current session's scope. Only enforced when a session is active.

```typescript
(taskId: string, taskEpicId?: string | undefined, cwd?: string | undefined) => Promise<{ inScope: boolean; warning?: string | undefined; }>
```

### `checkStatuslineIntegration`

Check if statusline integration is configured. Returns the current integration status.

```typescript
() => StatuslineStatus
```

### `getStatuslineConfig`

Get the statusline setup command for Claude Code settings.

```typescript
() => Record<string, unknown>
```

### `getSetupInstructions`

Get human-readable setup instructions.

```typescript
() => string
```

### `getPreferredChannel`

Look up the preferred channel for a given domain + operation.

```typescript
(domain: string, operation: string) => "cli" | "mcp" | "either"
```

**Parameters:**

- `domain` — Domain name
- `operation` — Operation name

**Returns:** Preferred channel ('mcp', 'cli', or 'either' as fallback)

### `getRoutingForDomain`

Get routing entries for a specific domain.

```typescript
(domain: string) => RoutingEntry[]
```

**Parameters:**

- `domain` — Domain name

**Returns:** All routing entries for the domain

### `getOperationsByChannel`

Get all operations that prefer a specific channel.

```typescript
(channel: "cli" | "mcp" | "either") => RoutingEntry[]
```

**Parameters:**

- `channel` — Channel preference to filter by

**Returns:** Matching routing entries

### `generateMemoryProtocol`

Generate dynamic memory protocol instructions based on provider capabilities.

```typescript
(context: ProviderContext) => string
```

**Parameters:**

- `context` — Provider capability context

**Returns:** Markdown content for memory protocol guidance

### `generateRoutingGuide`

Generate a dynamic routing guide based on operation preferences.

```typescript
(context: ProviderContext) => string
```

**Parameters:**

- `context` — Provider capability context

**Returns:** Markdown content showing preferred channels per operation

### `generateDynamicSkillContent`

Generate complete dynamic skill content for the current provider.

```typescript
(context: ProviderContext) => string
```

**Parameters:**

- `context` — Provider capability context

**Returns:** Complete dynamic skill markdown content

### `extractPackageMeta`

Extract package metadata from an export file.  T4552

```typescript
(sourceFilePath: string) => Promise<ImportPackageMeta>
```

### `logImportStart`

Log import operation start with package metadata.  T4552

```typescript
(sourceFilePath: string, sessionId?: string | undefined, cwd?: string | undefined) => Promise<void>
```

### `logImportSuccess`

Log import operation completion with full metadata.  T4552

```typescript
(sourceFilePath: string, tasksImported: string[], idRemap: Record<string, string>, conflicts?: { type: string; resolution: string; }[] | undefined, options?: ImportOptions | undefined, sessionId?: string | undefined, cwd?: string | undefined) => Promise<...>
```

### `logImportError`

Log import operation error with diagnostic details.  T4552

```typescript
(sourceFilePath: string, errorMessage: string, errorCode: string | number, stage?: "validation" | "unknown" | "parsing" | "remapping" | "writing", sessionId?: string | undefined, cwd?: string | undefined) => Promise<...>
```

### `logImportConflict`

Log import conflict detection and resolution.  T4552

```typescript
(conflictType: ImportConflictType, taskId: string, conflictDetails: Record<string, unknown>, resolution: ImportConflictResolution, sessionId?: string | undefined, cwd?: string | undefined) => Promise<...>
```

### `topologicalSortTasks`

Topological sort for task import order using Kahn's algorithm.  Ensures tasks are imported in dependency order: - Parents before children (parentId references) - Dependencies before dependents (depends[] references) - Only counts edges to tasks within the set (external deps ignored)   T4552

```typescript
(tasks: SortableTask[]) => string[]
```

### `detectCycles`

Detect cycles in task dependency graph. Returns true if no cycles, false if cycles detected.  T4552

```typescript
(tasks: SortableTask[]) => boolean
```

### `findActivePipelinesWithStagesAndTasks`

Find active pipelines joined with their stages and tasks. Optionally filters by specific task IDs.

```typescript
(taskIds?: string[] | undefined, cwd?: string | undefined) => Promise<PipelineStageTaskRow[]>
```

**Parameters:**

- `taskIds` — Optional list of task IDs to filter by
- `cwd` — Working directory for database

**Returns:** Rows with pipeline, stage, and task data

### `findPipelineWithCurrentStageAndTask`

Find a pipeline with its current stage and task by taskId. Matches stages where stageName equals the pipeline's currentStageId.

```typescript
(taskId: string, cwd?: string | undefined) => Promise<PipelineStageTaskRow[]>
```

**Parameters:**

- `taskId` — Task ID to look up
- `cwd` — Working directory for database

**Returns:** Matching rows (typically 0 or 1)

### `findPipelineWithStage`

Find a pipeline and a specific stage by taskId and stageName.

```typescript
(taskId: string, stageName: string, cwd?: string | undefined) => Promise<PipelineStageRow[]>
```

**Parameters:**

- `taskId` — Task ID
- `stageName` — Stage name to match
- `cwd` — Working directory for database

**Returns:** Matching rows (typically 0 or 1)

### `updatePipelineCurrentStage`

Update pipeline's currentStageId.

```typescript
(pipelineId: string, currentStageId: string, cwd?: string | undefined) => Promise<void>
```

**Parameters:**

- `pipelineId` — Pipeline ID to update
- `currentStageId` — New current stage identifier
- `cwd` — Working directory for database

### `getStagesByPipelineId`

Get all stages for a pipeline, ordered by sequence.

```typescript
(pipelineId: string, cwd?: string | undefined) => Promise<{ id: string; status: "completed" | "failed" | "blocked" | "not_started" | "in_progress" | "skipped"; notesJson: string | null; ... 15 more ...; provenanceChainJson: string | null; }[]>
```

**Parameters:**

- `pipelineId` — Pipeline ID
- `cwd` — Working directory for database

**Returns:** All stage rows for the pipeline

### `activateStage`

Update a stage's status to 'in_progress' and clear block fields.

```typescript
(stageId: string, startedAt: string, cwd?: string | undefined) => Promise<void>
```

**Parameters:**

- `stageId` — Stage ID to update
- `startedAt` — ISO timestamp for when the stage started
- `cwd` — Working directory for database

### `findPipelineWithCurrentStage`

Find pipeline with current stage (no task join) by taskId. Used by checkBlockedStageDetails.

```typescript
(taskId: string, cwd?: string | undefined) => Promise<PipelineStageRow[]>
```

**Parameters:**

- `taskId` — Task ID
- `cwd` — Working directory for database

**Returns:** Matching rows

### `getGateResultsByStageId`

Get gate results for a stage, ordered by checkedAt descending.

```typescript
(stageId: string, cwd?: string | undefined) => Promise<{ id: string; reason: string | null; stageId: string; gateName: string; result: "warn" | "pass" | "fail"; checkedAt: string; checkedBy: string; details: string | null; }[]>
```

**Parameters:**

- `stageId` — Stage ID
- `cwd` — Working directory for database

**Returns:** Gate result rows

### `getGateResultsByStageIdUnordered`

Get gate results for a stage without ordering (for simple checks).

```typescript
(stageId: string, cwd?: string | undefined) => Promise<{ id: string; reason: string | null; stageId: string; gateName: string; result: "warn" | "pass" | "fail"; checkedAt: string; checkedBy: string; details: string | null; }[]>
```

**Parameters:**

- `stageId` — Stage ID
- `cwd` — Working directory for database

**Returns:** Gate result rows

### `getEvidenceByStageId`

Get evidence for a stage, ordered by recordedAt descending.

```typescript
(stageId: string, cwd?: string | undefined) => Promise<{ id: string; description: string | null; type: "file" | "url" | "manifest"; stageId: string; uri: string; recordedAt: string; recordedBy: string | null; }[]>
```

**Parameters:**

- `stageId` — Stage ID
- `cwd` — Working directory for database

**Returns:** Evidence rows

### `getRecentTransitions`

Get recent transitions for a pipeline, ordered by createdAt descending.

```typescript
(pipelineId: string, limit?: number, cwd?: string | undefined) => Promise<{ id: string; createdAt: string; pipelineId: string; fromStageId: string; toStageId: string; transitionType: "automatic" | "manual" | "forced"; transitionedBy: string | null; }[]>
```

**Parameters:**

- `pipelineId` — Pipeline ID
- `limit` — Max rows to return (default: 10)
- `cwd` — Working directory for database

**Returns:** Transition rows

### `insertTransition`

Insert a new transition record.

```typescript
(transition: { id: string; pipelineId: string; fromStageId: string; toStageId: string; createdAt?: string | undefined; transitionType?: "automatic" | "manual" | "forced" | undefined; transitionedBy?: string | ... 1 more ... | undefined; }, cwd?: string | undefined) => Promise<...>
```

**Parameters:**

- `transition` — Transition data to insert
- `cwd` — Working directory for database

### `checkAtomicity`

Check task atomicity using 6-point heuristic test. Default threshold: 4 (passing requires = 4/6 criteria met).

```typescript
(task: Task, threshold?: number) => AtomicityResult
```

### `extractTaskRefs`

Extract task IDs from text content. Scans for patterns like T1234, T001, T42 (T followed by 3+ digits).

```typescript
(text: string, excludeId?: string | undefined) => string[]
```

### `createRelatesEntries`

Create relates entries from extracted task IDs.

```typescript
(refs: string[], relType?: RelatesType, reason?: string | undefined) => RelatesEntry[]
```

### `mergeRelatesArrays`

Merge new relates entries with existing ones. Existing entries take precedence (dedup by taskId).

```typescript
(existing: RelatesEntry[], newEntries: RelatesEntry[]) => RelatesEntry[]
```

### `validateRelatesRefs`

Validate that referenced task IDs exist. Returns array of invalid (non-existent) task IDs.

```typescript
(relates: RelatesEntry[], validTaskIds: string[]) => string[]
```

### `extractAndCreateRelates`

Convenience: extract task refs from text and create relates entries.

```typescript
(text: string, excludeId?: string | undefined, relType?: RelatesType, reason?: string | undefined) => RelatesEntry[]
```

### `calculateAffectedTasks`

Calculate which tasks would be affected by a delete operation.

```typescript
(taskId: string, strategy: string, tasks: Task[]) => AffectedTasks
```

### `calculateImpact`

Calculate impact of deletion.

```typescript
(affected: AffectedTasks, tasks: Task[]) => DeleteImpact
```

### `generateWarnings`

Generate warnings based on impact analysis.

```typescript
(affected: AffectedTasks, impact: DeleteImpact, strategy: string) => DeleteWarning[]
```

### `previewDelete`

Main preview function - coordinates all preview calculations.

```typescript
(taskId: string, tasks: Task[], options?: { strategy?: string | undefined; reason?: string | undefined; } | undefined) => DeletePreview
```

### `isValidStrategy`

Validate a strategy name.

```typescript
(strategy: string) => strategy is ChildStrategy
```

### `handleChildren`

Handle children using the specified strategy. Returns the modified tasks array and the strategy result.

```typescript
(taskId: string, strategy: ChildStrategy, tasks: Task[], options?: { force?: boolean | undefined; cascadeThreshold?: number | undefined; allowCascade?: boolean | undefined; } | undefined) => { ...; }
```

### `discoverByLabels`

Discover related tasks by shared labels.

```typescript
(taskId: string, tasks: Task[]) => DiscoveryMatch[]
```

### `discoverByDescription`

Discover related tasks by description similarity (keyword-based Jaccard).

```typescript
(taskId: string, tasks: Task[]) => DiscoveryMatch[]
```

### `discoverByFiles`

Discover related tasks by shared files.

```typescript
(taskId: string, tasks: Task[]) => DiscoveryMatch[]
```

### `discoverByHierarchy`

Discover related tasks by hierarchical proximity (siblings and cousins).

```typescript
(taskId: string, tasks: Task[], options?: { siblingBoost?: number | undefined; cousinBoost?: number | undefined; } | undefined) => DiscoveryMatch[]
```

### `discoverRelatedTasks`

Discover related tasks using all methods combined.

```typescript
(taskId: string, tasks: Task[], method?: DiscoveryMethod) => DiscoveryMatch[]
```

### `suggestRelates`

Suggest relates entries filtered by threshold.

```typescript
(taskId: string, tasks: Task[], threshold?: number) => DiscoveryMatch[]
```

### `getCurrentPhase`

Get the current active phase from project metadata.

```typescript
(project: ProjectMeta) => Phase | null
```

### `getTasksByPhase`

Get tasks belonging to a specific phase.

```typescript
(phaseName: string, tasks: Task[]) => Task[]
```

### `calculatePhaseProgress`

Calculate progress for a phase.

```typescript
(phaseName: string, tasks: Task[]) => PhaseProgress
```

### `getAllPhaseProgress`

Get progress for all phases.

```typescript
(phases: Record<string, Phase>, tasks: Task[]) => PhaseProgress[]
```

### `validatePhaseTransition`

```typescript
(fromPhase: string | null, toPhase: string, phases: Record<string, Phase>) => PhaseTransitionValidation
```

### `createPhaseTransition`

Create a phase transition record.

```typescript
(phase: string, transitionType: "completed" | "started" | "rollback", taskCount: number, fromPhase?: string | null | undefined, reason?: string | undefined) => PhaseTransition
```

### `applyPhaseTransition`

Apply a phase transition to project metadata. Returns updated project data.

```typescript
(project: ProjectMeta, toPhase: string, transitionType: "completed" | "started" | "rollback", taskCount: number, reason?: string | undefined) => ProjectMeta
```

### `getNextPhase`

Get the next phase in order.

```typescript
(currentPhaseName: string | null, phases: Record<string, Phase>) => string | null
```

### `allPhasesComplete`

Check if all phases are complete.

```typescript
(phases: Record<string, Phase>) => boolean
```

### `reparentTask`

Reparent a task within a TaskFile.  Mutates the task in-place within `data.tasks`. Updates `parentId`, `type`, and `updatedAt` on the target task, and `lastUpdated` on the TaskFile.

```typescript
(data: TaskFile, opts: ReparentOptions) => Promise<ReparentResult>
```

**Parameters:**

- `data` — The loaded TaskFile (mutated in place)
- `opts` — Reparent options (taskId, newParentId)

**Returns:** Result with old/new parent and new type

### `getSizeWeight`

Get weight for a task size.

```typescript
(size: TaskSize | null | undefined) => number
```

### `getPriorityWeight`

Get weight for a task priority.

```typescript
(priority: TaskPriority) => number
```

### `calculateTaskScore`

Calculate a composite score for task ordering. Higher score = should be worked on first.

```typescript
(task: Task) => number
```

### `sortByWeight`

Sort tasks by weighted score (highest first).

```typescript
(tasks: Task[]) => Task[]
```

### `calculateTotalEffort`

Calculate total weighted effort for a set of tasks.

```typescript
(tasks: Task[]) => number
```

### `calculateWeightedProgress`

Calculate completion percentage by weight.

```typescript
(tasks: Task[]) => number
```

### `calculateRemainingEffort`

Estimate remaining effort (weighted sum of non-complete tasks).

```typescript
(tasks: Task[]) => number
```

### `getLastActivity`

Get the most recent activity timestamp for a task.

```typescript
(task: Task) => string
```

### `classifyStaleness`

Classify staleness level for a task.

```typescript
(task: Task, thresholds?: StalenessThresholds) => StalenessLevel
```

### `getStalenessInfo`

Get staleness info for a single task.

```typescript
(task: Task, thresholds?: StalenessThresholds | undefined) => StalenessInfo
```

### `findStaleTasks`

Find all stale tasks (stale, critical, or abandoned).

```typescript
(tasks: Task[], thresholds?: StalenessThresholds | undefined) => StalenessInfo[]
```

### `getStalenessSummary`

```typescript
(tasks: Task[], thresholds?: StalenessThresholds | undefined) => StalenessSummary
```

### `validateReleaseTask`

Validate release protocol for a task.

```typescript
(taskId: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `checkReleaseManifest`

Validate release protocol from manifest file.

```typescript
(manifestFile: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `validateResearchTask`

Validate research protocol for a task.

```typescript
(taskId: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `checkResearchManifest`

Validate research protocol from manifest file.

```typescript
(manifestFile: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `validateTestingTask`

Validate testing protocol for a task.

```typescript
(taskId: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `checkTestingManifest`

Validate testing protocol from manifest file.

```typescript
(manifestFile: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `validateValidationTask`

Validate verification/validation protocol for a task.

```typescript
(taskId: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

### `checkValidationManifest`

Validate validation protocol from manifest file.

```typescript
(manifestFile: string, opts: { strict?: boolean | undefined; }) => Promise<ValidationResult>
```

## Types

### `AdapterManifest`

Minimal manifest shape for provider discovery.

```typescript
any
```

**Members:**

- `id`
- `name`
- `version`
- `description`
- `provider`
- `entryPoint`
- `capabilities`
- `detectionPatterns`

### `CliOutputOptions`

```typescript
any
```

**Members:**

- `command` — Command name (used to pick the correct human renderer).
- `message` — Optional success message for JSON envelope.
- `operation` — Operation name for LAFS _meta.
- `page` — Pagination for LAFS envelope.
- `extensions` — Extra LAFS extensions.

### `CliErrorDetails`

Error details for structured error output.

```typescript
any
```

**Members:**

- `name`
- `details`
- `fix`

### `Gateway`

CQRS gateway: read-only queries vs state-modifying mutations.

```typescript
any
```

### `Source`

Where the request originated.

```typescript
any
```

### `Tier`

Progressive disclosure tier. 0 = tasks + session (80% of agents) 1 = + memory + check (15% of agents) 2 = + pipeline + orchestrate + tools + admin + nexus (5%)

```typescript
any
```

### `ParamType`

The concrete value types a parameter can carry at runtime. Drives JSON Schema `type` and Commander argument/option parsing.

```typescript
any
```

### `ParamCliDef`

CLI-specific decoration for a parameter. All fields are optional — omit the entire `cli` key for MCP-only params.

```typescript
any
```

**Members:**

- `positional` — When true, registers as `.argument('<name>')` (positional). When false or omitted, registers as `.option('--name <value>')`.  false
- `short` — Short flag alias, e.g. `'-t'` for `--type`, `'-s'` for `--status`. Only meaningful when `positional` is false/omitted.
- `flag` — Override the CLI flag name when it differs from the param's `name`. e.g. `name: 'includeArchive'` but `flag: 'include-archive'` Defaults to kebab-case of `name`.
- `variadic` — For array-type params on the CLI: when true the option can be repeated. When false/omitted, the CLI accepts a single comma-separated string.  false
- `parse` — Custom parse function applied by Commander (e.g. `parseInt`).

### `ParamMcpDef`

MCP-specific decoration for a parameter. All fields are optional — omit the entire `mcp` key for CLI-only params.

```typescript
any
```

**Members:**

- `hidden` — When true, the parameter is excluded from the generated MCP `input_schema`. Use for CLI-only params (e.g. `--dry-run`, `--offset`).  false
- `enum` — JSON Schema `enum` constraint for this parameter.

### `ParamDef`

A fully-described parameter definition.  One `ParamDef` entry drives:  - Commander: `.argument()` (positional) or `.option()` (flag)  - MCP: a JSON Schema property with `type`, `description`, and optionally `enum`

```typescript
any
```

**Members:**

- `name` — Canonical camelCase parameter name (matches the key in `params` dict).
- `type` — Runtime value type. Drives JSON Schema `type` and Commander parsing.
- `required` — When true:  - Commander: positional argument (`<name>` or `[name]`)  - MCP: included in `required[]` array of the input_schema
- `description` — Human-readable description used in Commander help text and MCP tool docs.
- `cli` — CLI-specific metadata. Omit entire key if this param has no CLI surface.
- `mcp` — MCP-specific metadata. Omit entire key if this param has no MCP surface.

### `CanonicalDomain`

```typescript
any
```

### `DispatchRequest`

Canonical request shape that both CLI and MCP adapters produce.  The dispatcher validates this against the OperationRegistry before passing it through the middleware pipeline and into a DomainHandler.

```typescript
any
```

**Members:**

- `gateway` — CQRS gateway.
- `domain` — Target domain (canonical name).
- `operation` — Domain-specific operation name.
- `params` — Operation parameters (already sanitized by middleware).
- `source` — Where this request came from.
- `requestId` — Unique request identifier for tracing.
- `sessionId` — Bound session ID, if any.
- `_fields` — LAFS field selection: filter response data to these fields only.
- `_mvi` — LAFS envelope verbosity. Defaults to 'standard'. 'custom' is server-set via _fields.

### `RateLimitMeta`

Rate limit metadata attached to every response.

```typescript
any
```

**Members:**

- `limit`
- `remaining`
- `resetMs`
- `category`

### `DispatchError`

Structured error shape (LAFS-compatible).

```typescript
any
```

**Members:**

- `code` — Machine-readable error code (E_NOT_FOUND, E_VALIDATION_FAILED, …).
- `exitCode` — LAFS exit code (1-99).
- `message` — Human-readable message.
- `details` — Additional structured details.
- `fix` — Copy-paste fix command.
- `alternatives` — Alternative actions the caller can try.
- `problemDetails` — RFC 9457 Problem Details (optional, populated from CleoError.toProblemDetails()).

### `DispatchResponse`

Canonical response shape returned by the dispatcher.  Adapters translate this into their wire format: - CLI adapter → cliOutput() / cliError() + process.exit() - MCP adapter → MCP SDK JSON envelope

```typescript
any
```

**Members:**

- `_meta`
- `success`
- `data`
- `page`
- `partial`
- `error`

### `DomainHandler`

Contract for domain handlers.  Each of the 9 target domains (tasks, session, memory, check, pipeline, orchestrate, tools, admin, nexus) implements this interface.

```typescript
any
```

**Members:**

- `query` — Execute a read-only query operation.
- `mutate` — Execute a state-modifying mutation operation.
- `getSupportedOperations` — Declared operations for introspection and validation.

### `DispatchNext`

Async function that produces a DispatchResponse.

```typescript
any
```

### `Middleware`

Middleware function signature.  Receives the request and a `next` continuation. Can short-circuit by returning early (e.g., rate-limit exceeded) or modify the request/response.

```typescript
any
```

### `OperationDef`

Definition of a single dispatchable operation.

```typescript
any
```

**Members:**

- `gateway` — The CQRS gateway ('query' or 'mutate').
- `domain` — The canonical domain this operation belongs to.
- `operation` — The specific operation name (e.g. 'show', 'skill.list').
- `description` — Brief description of what the operation does.
- `tier` — Agent progressive-disclosure tier (0=basic, 1=memory/check, 2=full).
- `idempotent` — Whether the operation is safe to retry.
- `sessionRequired` — Whether this operation requires an active session.
- `requiredParams` — List of parameter keys that MUST be present in the request.
- `params` — Fully-described parameter list. Replaces `requiredParams` when populated. Empty array = "no declared params" (not "no params accepted"). Optional during T4897 migration — defaults to [] when absent.

### `Resolution`

Resolution output for a dispatch request.

```typescript
any
```

**Members:**

- `domain` — The canonical domain.
- `operation` — The operation name.
- `def` — The definition of the matched operation.

### `DispatcherConfig`

```typescript
any
```

**Members:**

- `handlers`
- `middlewares`

### `TaskRecord`

Task object as stored in task data.

```typescript
any
```

**Members:**

- `id`
- `title`
- `description`
- `status`
- `priority`
- `type`
- `phase`
- `createdAt`
- `updatedAt`
- `completedAt`
- `cancelledAt`
- `parentId`
- `position`
- `positionVersion`
- `depends`
- `relates`
- `files`
- `acceptance`
- `notes`
- `labels`
- `size`
- `epicLifecycle`
- `noAutoComplete`
- `verification`
- `origin`
- `createdBy`
- `validatedBy`
- `testedBy`
- `lifecycleState`
- `validationHistory`
- `blockedBy`
- `cancellationReason`

### `MinimalTaskRecord`

Minimal task representation for find results

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `priority`
- `parentId`

### `RuntimeData`

```typescript
any
```

### `DashboardData`

```typescript
any
```

**Members:**

- `project`
- `currentPhase`
- `summary`
- `taskWork`
- `activeSession`
- `highPriority`
- `blockedTasks`
- `recentCompletions`
- `topLabels`

### `StatsData`

```typescript
any
```

**Members:**

- `currentState`
- `byPriority`
- `byType`
- `byPhase`
- `completionMetrics`
- `activityMetrics`
- `allTime`
- `cycleTimes`

### `LogQueryData`

```typescript
any
```

**Members:**

- `entries`
- `pagination`

### `ContextData`

```typescript
any
```

**Members:**

- `available`
- `status`
- `percentage`
- `currentTokens`
- `maxTokens`
- `timestamp`
- `stale`
- `sessions`

### `SequenceData`

```typescript
any
```

**Members:**

- `counter`
- `lastId`
- `checksum`
- `nextId`

### `RoadmapData`

```typescript
any
```

**Members:**

- `currentVersion`
- `upcoming`
- `releaseHistory`
- `completedEpics`
- `summary`

### `ComplianceData`

```typescript
any
```

**Members:**

- `totalEntries`
- `averagePassRate`
- `averageAdherence`
- `totalViolations`
- `trend`
- `dataPoints`

### `HelpData`

```typescript
any
```

**Members:**

- `topic`
- `content`
- `relatedCommands`

### `SyncData`

```typescript
any
```

**Members:**

- `direction`
- `synced`
- `conflicts`
- `message`

### `EngineResult`

Engine result shape accepted by wrapResult. Matches the union of what all engine functions return.

```typescript
any
```

**Members:**

- `success`
- `data`
- `page`
- `error`

### `JobStatus`

Background job status

```typescript
any
```

### `BackgroundJob`

Background job representation

```typescript
any
```

**Members:**

- `id`
- `operation`
- `status`
- `startedAt`
- `completedAt`
- `result`
- `error`
- `progress`

### `BackgroundJobManagerConfig`

Configuration for BackgroundJobManager

```typescript
any
```

**Members:**

- `maxJobs`
- `retentionMs`

### `SessionContext`

Immutable snapshot of the bound session context.

```typescript
any
```

**Members:**

- `sessionId` — Active session ID.
- `scope` — Session scope.
- `gradeMode` — Whether full audit logging is enabled for behavioral grading.
- `agentPid` — PID of the process that bound this context.
- `boundAt` — ISO timestamp when this context was bound.

### `RateLimitConfig`

Rate limit configuration for a single category

```typescript
any
```

**Members:**

- `maxRequests` — Maximum requests allowed in the window
- `windowMs` — Time window in milliseconds

### `RateLimitingConfig`

Complete rate limiting configuration

```typescript
any
```

**Members:**

- `enabled` — Enable/disable rate limiting globally
- `query` — Limits for query gateway operations
- `mutate` — Limits for mutate gateway operations
- `spawn` — Limits for spawn operations (orchestrate.spawn)

### `RateLimitResult`

Rate limit check result

```typescript
any
```

**Members:**

- `allowed` — Whether the request is allowed
- `remaining` — Requests remaining in the current window
- `limit` — Maximum requests allowed in the window
- `resetMs` — Milliseconds until the window resets
- `category` — The category that was checked

### `LifecycleEnforcementConfig`

Lifecycle enforcement configuration (Section 12.2)

```typescript
any
```

**Members:**

- `mode` — Enforcement mode: strict blocks, advisory warns, off skips
- `allowSkip` — Stages that may be skipped without failing gates
- `emergencyBypass` — Emergency bypass flag - disables all gate checks

### `ProtocolValidationConfig`

Protocol validation configuration (Section 12.3)

```typescript
any
```

**Members:**

- `strictMode` — Enable strict protocol validation
- `blockOnViolation` — Block operations on protocol violations
- `logViolations` — Log protocol violations to audit trail

### `MCPConfig`

```typescript
any
```

**Members:**

- `cliPath` — Path to CLEO CLI binary (default: 'cleo')
- `timeout` — Operation timeout in milliseconds (default: 30000)
- `logLevel` — Logging verbosity level (default: 'info')
- `enableMetrics` — Enable token tracking metrics (default: false)
- `maxRetries` — Retry count for failed operations (default: 3)
- `queryCache` — Enable query cache (default: true)
- `queryCacheTtl` — Query cache TTL in milliseconds (default: 30000)
- `auditLog` — Enable audit logging (default: true)
- `strictValidation` — Strict validation mode (default: true)
- `lifecycleEnforcement` — Lifecycle enforcement configuration (Section 12.2)
- `protocolValidation` — Protocol validation configuration (Section 12.3)
- `rateLimiting` — Rate limiting configuration (Section 13.3)

### `MviTier`

MVI (Minimum Viable Information) projection configurations. Maps disclosure tiers to operation access and field filtering rules.   T4820  T5096

```typescript
any
```

### `ProjectionConfig`

```typescript
any
```

**Members:**

- `allowedDomains` — Operations allowed at this tier
- `excludeFields` — Fields to exclude from responses
- `maxDepth` — Maximum depth for nested objects

### `ProjectionContext`

```typescript
any
```

**Members:**

- `tier`
- `config`

### `RateLimitConfig`

Rate Limit Configuration

```typescript
any
```

**Members:**

- `maxRequests`
- `windowMs`

### `RateLimitingConfig`

```typescript
any
```

**Members:**

- `enabled`
- `query`
- `mutate`
- `spawn`

### `McpDispatcherConfig`

```typescript
any
```

**Members:**

- `rateLimiting`
- `strictMode`

### `LoggerConfig`

```typescript
any
```

**Members:**

- `level`
- `filePath`
- `maxFileSize`
- `maxFiles`

### `PlatformPaths`

OS-appropriate paths for CLEO's global directories.

```typescript
any
```

**Members:**

- `data` — User data dir. Override with CLEO_HOME env var.
- `config` — User config dir (XDG_CONFIG_HOME / Library/Preferences / %APPDATA%).
- `cache` — User cache dir (XDG_CACHE_HOME / Library/Caches / %LOCALAPPDATA%).
- `log` — User log dir (XDG_STATE_HOME / Library/Logs / %LOCALAPPDATA%).
- `temp` — Temp dir for ephemeral files.

### `SystemInfo`

Immutable system information snapshot, captured once per process.

```typescript
any
```

**Members:**

- `platform`
- `arch`
- `release`
- `hostname`
- `nodeVersion`
- `paths`

### `VacuumOptions`

```typescript
any
```

**Members:**

- `cwd`
- `force`

### `WarpChainRow`

```typescript
any
```

### `NewWarpChainRow`

```typescript
any
```

### `WarpChainInstanceRow`

```typescript
any
```

### `NewWarpChainInstanceRow`

```typescript
any
```

### `StatusRegistryRow`

```typescript
any
```

### `TaskRow`

```typescript
any
```

### `NewTaskRow`

```typescript
any
```

### `SessionRow`

```typescript
any
```

### `NewSessionRow`

```typescript
any
```

### `TaskDependencyRow`

```typescript
any
```

### `TaskRelationRow`

```typescript
any
```

### `WorkHistoryRow`

```typescript
any
```

### `LifecyclePipelineRow`

```typescript
any
```

### `NewLifecyclePipelineRow`

```typescript
any
```

### `LifecycleStageRow`

```typescript
any
```

### `NewLifecycleStageRow`

```typescript
any
```

### `LifecycleGateResultRow`

```typescript
any
```

### `NewLifecycleGateResultRow`

```typescript
any
```

### `LifecycleEvidenceRow`

```typescript
any
```

### `NewLifecycleEvidenceRow`

```typescript
any
```

### `LifecycleTransitionRow`

```typescript
any
```

### `NewLifecycleTransitionRow`

```typescript
any
```

### `AuditLogRow`

```typescript
any
```

### `NewAuditLogRow`

```typescript
any
```

### `TokenUsageRow`

```typescript
any
```

### `NewTokenUsageRow`

```typescript
any
```

### `ArchitectureDecisionRow`

```typescript
any
```

### `NewArchitectureDecisionRow`

```typescript
any
```

### `AdrTaskLinkRow`

```typescript
any
```

### `NewAdrTaskLinkRow`

```typescript
any
```

### `AdrRelationRow`

```typescript
any
```

### `NewAdrRelationRow`

```typescript
any
```

### `ManifestEntryRow`

```typescript
any
```

### `NewManifestEntryRow`

```typescript
any
```

### `PipelineManifestRow`

```typescript
any
```

### `NewPipelineManifestRow`

```typescript
any
```

### `ReleaseManifestRow`

```typescript
any
```

### `NewReleaseManifestRow`

```typescript
any
```

### `BrainDecisionRow`

```typescript
any
```

### `NewBrainDecisionRow`

```typescript
any
```

### `BrainPatternRow`

```typescript
any
```

### `NewBrainPatternRow`

```typescript
any
```

### `BrainLearningRow`

```typescript
any
```

### `NewBrainLearningRow`

```typescript
any
```

### `BrainObservationRow`

```typescript
any
```

### `NewBrainObservationRow`

```typescript
any
```

### `BrainMemoryLinkRow`

```typescript
any
```

### `NewBrainMemoryLinkRow`

```typescript
any
```

### `BrainPageNodeRow`

```typescript
any
```

### `NewBrainPageNodeRow`

```typescript
any
```

### `BrainPageEdgeRow`

```typescript
any
```

### `NewBrainPageEdgeRow`

```typescript
any
```

### `BrainStickyNoteRow`

```typescript
any
```

### `NewBrainStickyNoteRow`

```typescript
any
```

### `ProjectRegistryRow`

```typescript
any
```

### `NewProjectRegistryRow`

```typescript
any
```

### `NexusAuditLogRow`

```typescript
any
```

### `NewNexusAuditLogRow`

```typescript
any
```

### `NexusSchemaMetaRow`

```typescript
any
```

### `NewNexusSchemaMetaRow`

```typescript
any
```

### `ErrorDefinition`

A single entry in the unified error catalog.

```typescript
any
```

**Members:**

- `code` — Numeric exit code from ExitCode enum.
- `name` — Machine-readable name (matches ExitCode enum key).
- `category` — LAFS error category for protocol conformance.
- `message` — Default human-readable message.
- `fix` — Default fix suggestion (copy-paste command or instruction).
- `httpStatus` — HTTP status code for API/MCP responses.
- `recoverable` — Whether retry may succeed.
- `lafsCode` — LAFS-style string error code (E_CLEO_*).

### `ProblemDetails`

RFC 9457 Problem Details object. Structured error representation for API/MCP responses.   T5240

```typescript
any
```

**Members:**

- `type`
- `title`
- `status`
- `detail`
- `instance`
- `extensions`

### `ArchiveFields`

Archive-specific fields for task upsert.

```typescript
any
```

**Members:**

- `archivedAt`
- `archiveReason`
- `cycleTimeDays`

### `AtomicMigrationResult`

Atomic database migration result.

```typescript
any
```

**Members:**

- `success`
- `tempPath`
- `backupPath`
- `error`

### `ReleaseFn`

A release function returned by acquireLock.

```typescript
any
```

### `ProviderHookEvent`

CAAMP-defined hook events supported by provider capability discovery.

```typescript
any
```

### `InternalHookEvent`

```typescript
any
```

### `HookEvent`

Full CLEO hook event union.  CAAMP defines provider-facing events; CLEO extends the registry with local coordination events for autonomous execution.

```typescript
any
```

### `HookPayload`

Base interface for all hook payloads Provides common fields available across all hook events

```typescript
any
```

**Members:**

- `timestamp` — ISO 8601 timestamp when the hook fired
- `sessionId` — Optional session ID if firing within a session context
- `taskId` — Optional task ID if firing within a task context
- `providerId` — Optional provider ID that triggered the hook
- `metadata` — Optional metadata for extensibility

### `OnSessionStartPayload`

Payload for onSessionStart hook Fired when a CLEO session begins

```typescript
any
```

**Members:**

- `sessionId` — Session identifier (required for session events)
- `name` — Human-readable session name
- `scope` — Session scope/area of work
- `agent` — Optional agent identifier

### `OnSessionEndPayload`

Payload for onSessionEnd hook Fired when a CLEO session ends

```typescript
any
```

**Members:**

- `sessionId` — Session identifier
- `duration` — Session duration in seconds
- `tasksCompleted` — Array of task IDs completed during this session

### `OnToolStartPayload`

Payload for onToolStart hook Fired when a task/tool operation begins

```typescript
any
```

**Members:**

- `taskId` — Task identifier
- `taskTitle` — Human-readable task title
- `previousTask` — Optional ID of the previous task if sequential

### `OnToolCompletePayload`

Payload for onToolComplete hook Fired when a task/tool operation completes

```typescript
any
```

**Members:**

- `taskId` — Task identifier
- `taskTitle` — Human-readable task title
- `status` — Final status of the completed task

### `HookHandler`

Handler function type for hook events Handlers receive project root and typed payload

```typescript
any
```

### `HookRegistration`

Hook registration metadata Tracks registered handlers with priority and event binding

```typescript
any
```

**Members:**

- `id` — Unique identifier for this registration
- `event` — CAAMP hook event this handler listens for
- `handler` — Handler function to execute when event fires
- `priority` — Priority for execution order (higher = earlier)

### `HookConfig`

Configuration for the hook system Controls which events are enabled/disabled

```typescript
any
```

**Members:**

- `enabled` — Master switch for hook system
- `events` — Per-event enable/disable configuration

### `OnFileChangePayload`

Payload for onFileChange hook Fired when a tracked file is written, created, or deleted

```typescript
any
```

**Members:**

- `filePath` — Absolute or project-relative path of the changed file
- `changeType` — Kind of filesystem change
- `sizeBytes` — File size in bytes after the change (absent for deletes)

### `OnErrorPayload`

Payload for onError hook Fired when an operation fails with a structured error

```typescript
any
```

**Members:**

- `errorCode` — Numeric exit code or string error code
- `message` — Human-readable error message
- `domain` — Domain where the error occurred
- `operation` — Operation that failed
- `gateway` — Gateway (query / mutate) that received the error
- `stack` — Optional stack trace

### `OnPromptSubmitPayload`

Payload for onPromptSubmit hook Fired when an agent submits a prompt through a gateway

```typescript
any
```

**Members:**

- `gateway` — Gateway that received the prompt (query / mutate)
- `domain` — Target domain
- `operation` — Target operation
- `source` — Optional source identifier (e.g. agent name)

### `OnResponseCompletePayload`

Payload for onResponseComplete hook Fired when a gateway operation finishes (success or failure)

```typescript
any
```

**Members:**

- `gateway` — Gateway that handled the operation
- `domain` — Target domain
- `operation` — Target operation
- `success` — Whether the operation succeeded
- `durationMs` — Wall-clock duration in milliseconds
- `errorCode` — Error code if the operation failed

### `OnWorkAvailablePayload`

Payload for onWorkAvailable hook Fired when the system detects ready work on a Loom/Tapestry

```typescript
any
```

**Members:**

- `taskIds` — IDs of tasks now ready for execution
- `epicId` — Optional epic / Loom identifier
- `chainId` — Optional chain or tessera instance identifier
- `reason` — Why the work became available

### `OnAgentSpawnPayload`

Payload for onAgentSpawn hook Fired when a worker session/process is launched

```typescript
any
```

**Members:**

- `agentId` — Worker or session identifier
- `role` — Worker role / archetype name
- `adapterId` — Provider or adapter used to launch the worker
- `taskId` — Optional task assignment at spawn time

### `OnAgentCompletePayload`

Payload for onAgentComplete hook Fired when a worker finishes its assigned run

```typescript
any
```

**Members:**

- `agentId` — Worker or session identifier
- `role` — Worker role / archetype name
- `status` — Completion status for the run
- `taskId` — Optional task assignment that was completed
- `summary` — Optional summary or manifest reference

### `OnCascadeStartPayload`

Payload for onCascadeStart hook Fired when autonomous execution begins flowing through a chain or wave

```typescript
any
```

**Members:**

- `cascadeId` — Identifier for the cascade / execution wave
- `chainId` — Optional chain identifier
- `tesseraId` — Optional tessera template / instance identifier
- `taskIds` — Task IDs participating in the cascade

### `OnPatrolPayload`

Payload for onPatrol hook Fired when a watcher performs a periodic health/sweep cycle

```typescript
any
```

**Members:**

- `watcherId` — Watcher / patrol identifier
- `patrolType` — Patrol category
- `scope` — Optional scope being patrolled

### `CLEOLifecycleEvent`

Type for CLEO lifecycle event names These are the internal events CLEO fires that get mapped to CAAMP events

```typescript
any
```

### `CLEOAutonomousLifecycleEvent`

Type for autonomous CLEO lifecycle events.

```typescript
any
```

### `SaveJsonOptions`

Options for saveJson.

```typescript
any
```

**Members:**

- `backupDir` — Directory for backups. If omitted, no backup is created.
- `maxBackups` — Maximum number of backups to retain. Default: 5.
- `indent` — JSON indentation. Default: 2.
- `validate` — Validation function. Called before write; throw to abort.

### `CheckpointConfig`

Checkpoint configuration.

```typescript
any
```

**Members:**

- `enabled`
- `debounceMinutes`
- `messagePrefix`
- `noVerify`

### `CheckpointStatus`

Checkpoint status information.

```typescript
any
```

**Members:**

- `config`
- `status`

### `ChangedFile`

Changed file with its status.

```typescript
any
```

**Members:**

- `path`
- `status`

### `SafetyOptions`

Safety configuration - can be overridden per-operation

```typescript
any
```

**Members:**

- `verify` — Verify data was written (default: true)
- `checkpoint` — Create git checkpoint (default: true)
- `validateSequence` — Validate sequence (default: true)
- `strict` — Strict mode - throw on any issue (default: true)

### `RepairResult`

Repair result with proper typing.

```typescript
any
```

**Members:**

- `repaired`
- `message`
- `counter`
- `oldCounter`
- `newCounter`

### `SafetyConfig`

Safety configuration options.

```typescript
any
```

**Members:**

- `verifyWrites` — Enable write verification (default: true)
- `detectCollisions` — Enable collision detection (default: true)
- `validateSequence` — Enable sequence validation (default: true)
- `autoCheckpoint` — Enable auto-checkpoint (default: true)
- `strictMode` — Throw on safety violations (default: true)

### `TaskDetail`

Enriched task with hierarchy info.

```typescript
any
```

**Members:**

- `children`
- `dependencyStatus`
- `unresolvedDeps`
- `dependents`
- `hierarchyPath`
- `isArchived`

### `PaginateInput`

Input parameters for paginating a result set.   T4668  T4663

```typescript
any
```

**Members:**

- `total` — Total number of items before pagination.
- `limit` — Number of items to return per page.
- `offset` — Number of items to skip.

### `CompactTask`

Compact task representation — minimal fields for MCP list responses.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `priority`
- `type`
- `parentId`

### `ListTasksOptions`

Filter options for listing tasks.

```typescript
any
```

**Members:**

- `status`
- `priority`
- `type`
- `parentId`
- `phase`
- `label`
- `children`
- `limit`
- `offset`

### `ListTasksResult`

Result of listing tasks.

```typescript
any
```

**Members:**

- `tasks`
- `total`
- `filtered`
- `page`
- `pagination`

### `FindResult`

Minimal task info for search results.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `priority`
- `type`
- `parentId`
- `score`

### `FindTasksOptions`

Options for finding tasks.

```typescript
any
```

**Members:**

- `query`
- `id`
- `exact`
- `status`
- `field`
- `includeArchive`
- `limit`
- `offset`

### `FindTasksResult`

Result of finding tasks.

```typescript
any
```

**Members:**

- `results`
- `total`
- `query`
- `searchType`

### `AdrFrontmatter`

Parsed ADR frontmatter from .md file

```typescript
any
```

**Members:**

- `Date`
- `Status`
- `Accepted`
- `Supersedes`
- `'Superseded By'`
- `Amends`
- `'Amended By'`
- `'Related ADRs'`
- `'Related Tasks'`
- `Gate`
- `'Gate Status'`
- `Summary`
- `Keywords`
- `Topics`

### `AdrRecord`

```typescript
any
```

**Members:**

- `id`
- `file`
- `title`
- `frontmatter`

### `AdrSyncResult`

```typescript
any
```

**Members:**

- `inserted`
- `updated`
- `skipped`
- `errors`

### `AdrListResult`

```typescript
any
```

**Members:**

- `adrs`
- `total`
- `filtered`

### `AdrFindResult`

```typescript
any
```

**Members:**

- `adrs`
- `query`
- `total`

### `PipelineAdrLinkResult`

```typescript
any
```

**Members:**

- `linked`
- `synced`
- `skipped`
- `errors`

### `EvidenceType`

```typescript
any
```

### `EvidenceRecord`

```typescript
any
```

**Members:**

- `id`
- `stageId`
- `uri`
- `type`
- `recordedAt`
- `recordedBy`
- `description`

### `RelatedLink`

Related link in frontmatter.

```typescript
any
```

**Members:**

- `type`
- `path`
- `id`

### `FrontmatterMetadata`

Frontmatter metadata for an RCASD artifact.

```typescript
any
```

**Members:**

- `epic`
- `stage`
- `task`
- `related`
- `created`
- `updated`

### `ParsedFrontmatter`

Result of parsing frontmatter from a markdown file.

```typescript
any
```

**Members:**

- `frontmatter`
- `body`
- `raw`

### `Stage`

Stage type derived from canonical stage list.   T4800

```typescript
any
```

### `StageCategory`

Stage category for grouping related stages.   T4800

```typescript
any
```

### `StageDefinition`

Stage metadata with descriptive information.   T4800

```typescript
any
```

**Members:**

- `stage` — Stage identifier
- `name` — Display name for the stage
- `description` — Detailed description of what happens in this stage
- `order` — Execution order (1-based)
- `category` — Category for grouping
- `skippable` — Whether this stage can be skipped
- `defaultTimeoutHours` — Default timeout in hours (null = no timeout)
- `requiredGates` — Required gate checks before completing this stage
- `expectedArtifacts` — Expected artifacts produced by this stage

### `TransitionRule`

Transition rule - defines if a transition is allowed.   T4800

```typescript
any
```

**Members:**

- `from`
- `to`
- `allowed`
- `requiresForce`
- `reason`

### `StageArtifactResult`

```typescript
any
```

**Members:**

- `absolutePath`
- `outputFile`
- `related`

### `EnforcementMode`

Lifecycle enforcement modes.

```typescript
any
```

### `GateData`

Gate data within a stage.

```typescript
any
```

**Members:**

- `status`
- `agent`
- `notes`
- `reason`
- `timestamp`

### `ManifestStageData`

Stage data in an on-disk manifest.

```typescript
any
```

**Members:**

- `status`
- `completedAt`
- `skippedAt`
- `skippedReason`
- `artifacts`
- `notes`
- `gates`

### `RcasdManifest`

Canonical RCASD manifest-shaped interface for compatibility payloads. Lifecycle persistence is SQLite-native; this shape is used for API responses that present stage+gate state in a manifest-like structure.  Stage keys use full canonical names matching the DB CHECK constraint: research, consensus, architecture_decision, specification, decomposition, implementation, validation, testing, release.   T4798

```typescript
any
```

**Members:**

- `epicId`
- `title`
- `stages`

### `GateCheckResult`

Gate check result.

```typescript
any
```

**Members:**

- `allowed`
- `mode`
- `missingPrerequisites`
- `currentStage`
- `message`

### `StageTransitionResult`

Stage transition result.

```typescript
any
```

**Members:**

- `epicId`
- `stage`
- `previousStatus`
- `newStatus`
- `timestamp`

### `LifecycleHistoryEntry`

History entry for stage transitions.

```typescript
any
```

**Members:**

- `stage`
- `action`
- `timestamp`
- `notes`

### `AlertLevel`

Alert level names.

```typescript
any
```

### `AlertCheckResult`

Alert result from check_context_alert.

```typescript
any
```

**Members:**

- `alerted`
- `level`
- `percentage`
- `currentTokens`
- `maxTokens`
- `action`

### `FormatOptions`

Options for envelope formatting.   T4668  T4670  T4663

```typescript
any
```

**Members:**

- `operation`
- `page`
- `extensions`
- `mvi` — MVI level to embed in the envelope _meta. Defaults to 'standard'.  T4957

### `GatewayMetaRecord`

GatewayMeta with an index signature for DomainResponse._meta compatibility.  All domain handlers receive this from createGatewayMeta().   T4655

```typescript
any
```

### `CleoRegistryEntry`

Entry in the CLEO-to-LAFS error registry.   T4671  T4663

```typescript
any
```

**Members:**

- `exitCode`
- `lafsCode`
- `category`
- `description`
- `retryable`
- `httpStatus`

### `TestDbEnv`

Result of creating a test database environment.

```typescript
any
```

**Members:**

- `tempDir` — Temporary directory (the project root).
- `cleoDir` — Path to .cleo directory.
- `accessor` — SQLite-backed DataAccessor.
- `cleanup` — Clean up temp dir and close DB.

### `HierarchyValidation`

Validate that adding a child to a parent would not violate constraints.

```typescript
any
```

**Members:**

- `valid`
- `error`

### `TaskTreeNode`

Build a tree structure from flat task list.

```typescript
any
```

**Members:**

- `task`
- `children`

### `HierarchyPolicy`

```typescript
any
```

**Members:**

- `maxDepth`
- `maxSiblings`
- `maxActiveSiblings`
- `countDoneInLimit`
- `enforcementProfile`

### `HierarchyValidationResult`

```typescript
any
```

**Members:**

- `valid`
- `error`

### `AddTaskOptions`

Options for creating a task.  `description` is **required** per CLEO's anti-hallucination rules — every task must have both a title and a description, and they must differ.

```typescript
any
```

**Members:**

- `title`
- `description`
- `status`
- `priority`
- `type`
- `parentId`
- `size`
- `phase`
- `labels`
- `files`
- `acceptance`
- `depends`
- `notes`
- `position`
- `addPhase`
- `dryRun`

### `AddTaskResult`

Result of adding a task.

```typescript
any
```

**Members:**

- `task`
- `duplicate`
- `dryRun`

### `ListPhasesResult`

Options for listing phases.

```typescript
any
```

**Members:**

- `currentPhase`
- `phases`
- `summary`

### `SetPhaseOptions`

Options for setting current phase.

```typescript
any
```

**Members:**

- `slug`
- `rollback`
- `force`
- `dryRun`

### `SetPhaseResult`

Result of a phase set operation.

```typescript
any
```

**Members:**

- `previousPhase`
- `currentPhase`
- `isRollback`
- `isSkip`
- `skippedPhases`
- `warning`
- `dryRun`

### `ShowPhaseResult`

Phase show result.

```typescript
any
```

**Members:**

- `slug`
- `name`
- `status`
- `order`
- `startedAt`
- `completedAt`
- `taskCount`
- `completedTaskCount`

### `AdvancePhaseResult`

Phase advance result.

```typescript
any
```

**Members:**

- `previousPhase`
- `currentPhase`
- `forced`

### `RenamePhaseResult`

Phase rename result.

```typescript
any
```

**Members:**

- `oldName`
- `newName`
- `tasksUpdated`
- `currentPhaseUpdated`

### `DeletePhaseResult`

Phase delete result.

```typescript
any
```

**Members:**

- `deletedPhase`
- `tasksReassigned`
- `reassignedTo`

### `ShimOption`

Parsed option definition.

```typescript
any
```

**Members:**

- `longName` — Long flag name (camelCase), e.g. 'dryRun'
- `shortName` — Short alias, e.g. 's'
- `takesValue` — Whether it takes a value (vs boolean flag)
- `description` — Description text
- `required` — Whether this option is required
- `parseFn` — Custom parse function (e.g. parseInt)
- `defaultValue` — Default value

### `ShimArg`

Positional argument definition.

```typescript
any
```

**Members:**

- `name`
- `required`
- `variadic`

### `CommanderCompatOption`

Commander-compatible option view for tests.

```typescript
any
```

**Members:**

- `long`
- `required`
- `defaultValue`

### `ActionHandler`

Type for the action handler function - flexible to support various signatures

```typescript
any
```

### `ProgressOptions`

```typescript
any
```

**Members:**

- `enabled` — Whether to show progress (true for human mode, false for JSON mode)
- `prefix` — Prefix for progress messages

### `DomainRequest`

Request from MCP gateway (inline — replaces legacy router.ts import)

```typescript
any
```

**Members:**

- `gateway`
- `domain`
- `operation`
- `params`

### `DomainResponse`

Response from domain handler (inline — replaces legacy router.ts import)

```typescript
any
```

**Members:**

- `_meta`
- `success`
- `data`
- `partial`
- `error`

### `MutateRequest`

Mutate request interface

```typescript
any
```

**Members:**

- `domain`
- `operation`
- `params`

### `MutateResponse`

Mutate response interface (aliases DomainResponse)

```typescript
any
```

### `DomainRequest`

Request from MCP gateway (inline — replaces legacy router.ts import)

```typescript
any
```

**Members:**

- `gateway`
- `domain`
- `operation`
- `params`

### `DomainResponse`

Response from domain handler (inline — replaces legacy router.ts import)

```typescript
any
```

**Members:**

- `_meta`
- `success`
- `data`
- `partial`
- `error`

### `QueryRequest`

Query request interface

```typescript
any
```

**Members:**

- `domain`
- `operation`
- `params`

### `QueryResponse`

Query response interface (aliases DomainResponse)

```typescript
any
```

### `CacheStats`

Cache statistics

```typescript
any
```

**Members:**

- `hits`
- `misses`
- `evictions`
- `size`
- `domains`

### `McpResource`

MCP Resource definition.

```typescript
any
```

**Members:**

- `uri`
- `name`
- `description`
- `mimeType`

### `McpResourceContent`

MCP Resource content response.

```typescript
any
```

**Members:**

- `uri`
- `mimeType`
- `text`

### `TestEnvironment`

```typescript
any
```

**Members:**

- `projectRoot` — Path to the temporary CLEO project root
- `epicId` — Pre-created epic ID
- `taskIds` — Pre-created task IDs (children of the epic)
- `cliPath` — Path to the CLEO CLI

### `IntegrationTestContext`

Test context for integration tests

```typescript
any
```

**Members:**

- `executor` — CLI executor instance (wrapped to use project root)
- `sessionId` — Test session ID
- `epicId` — Test epic ID for scoped operations
- `createdTaskIds` — Created task IDs for cleanup
- `originalCwd` — Project root (isolated temp directory)
- `testDataDir` — Test data directory
- `testEnv` — Isolated test environment handle

### `DomainRequest`

Request from MCP gateway

```typescript
any
```

**Members:**

- `gateway`
- `domain`
- `operation`
- `params`

### `DomainResponse`

Response from domain handler

```typescript
any
```

**Members:**

- `_meta`
- `success`
- `data`
- `partial`
- `error`

### `DomainHandler`

Domain handler interface (legacy - retained for type compatibility)

```typescript
any
```

**Members:**

- `query`
- `mutate`
- `getSupportedOperations`

### `RateLimitConfig`

Rate limiter configuration

```typescript
any
```

**Members:**

- `maxRequests` — Maximum requests allowed in the window
- `windowMs` — Time window in milliseconds

### `RateLimitResult`

Rate limit check result

```typescript
any
```

**Members:**

- `allowed` — Whether the request is allowed
- `remaining` — Remaining requests in current window
- `resetMs` — Milliseconds until window resets
- `limit` — Total limit for the window

### `AdapterCapabilities`

Adapter capability declarations for CLEO provider adapters.   T5240

```typescript
any
```

**Members:**

- `supportsHooks`
- `supportedHookEvents`
- `supportsSpawn`
- `supportsInstall`
- `supportsMcp`
- `supportsInstructionFiles`
- `instructionFilePattern` — Provider-specific instruction file name, e.g. "CLAUDE.md", ".cursorrules"
- `supportsContextMonitor`
- `supportsStatusline`
- `supportsProviderPaths`
- `supportsTransport`
- `supportsTaskSync`

### `AdapterContextMonitorProvider`

Context monitor provider interface for CLEO provider adapters. Allows providers to implement context window tracking and statusline integration.  T5240

```typescript
any
```

**Members:**

- `processContextInput` — Process context window input and return a status string
- `checkStatuslineIntegration` — Check if statusline integration is configured
- `getStatuslineConfig` — Get the statusline configuration object
- `getSetupInstructions` — Get human-readable setup instructions

### `AdapterHookProvider`

Hook provider interface for CLEO provider adapters. Maps provider-specific events to CAAMP hook events.   T5240

```typescript
any
```

**Members:**

- `mapProviderEvent` — Map a provider-specific event name to a CAAMP hook event name, or null if unmapped.
- `registerNativeHooks` — Register the provider's native hook mechanism for a project.
- `unregisterNativeHooks` — Unregister all native hooks previously registered.
- `getEventMap` — Return the full event mapping for introspection.

### `AdapterInstallProvider`

Install provider interface for CLEO provider adapters. Handles registration with the provider and instruction file references.   T5240

```typescript
any
```

**Members:**

- `install`
- `uninstall`
- `isInstalled`
- `ensureInstructionReferences` — Ensure the provider's instruction file references CLEO (e.g. AGENTS.md in CLAUDE.md).

### `InstallOptions`

```typescript
any
```

**Members:**

- `projectDir`
- `global`
- `mcpServerPath`

### `InstallResult`

```typescript
any
```

**Members:**

- `success`
- `installedAt`
- `instructionFileUpdated`
- `mcpRegistered`
- `details`

### `AdapterPathProvider`

Path provider interface for CLEO provider adapters. Allows providers to declare their OS-specific directory locations.  T5240

```typescript
any
```

**Members:**

- `getProviderDir` — Get the provider's global config directory (e.g., ~/.claude/)
- `getSettingsPath` — Get the path to the provider's settings file, or null if N/A
- `getAgentInstallDir` — Get the directory where this provider installs agents, or null if N/A
- `getMemoryDbPath` — Get the path to a third-party memory DB if applicable, or null

### `AdapterSpawnProvider`

Spawn provider interface for CLEO provider adapters.   T5240

```typescript
any
```

**Members:**

- `canSpawn`
- `spawn`
- `listRunning`
- `terminate`

### `SpawnContext`

```typescript
any
```

**Members:**

- `taskId`
- `prompt`
- `workingDirectory`
- `options`

### `SpawnResult`

```typescript
any
```

**Members:**

- `instanceId`
- `taskId`
- `providerId`
- `output` — Output captured from the spawned process. Optional for detached/fire-and-forget spawns.
- `exitCode` — Exit code of the spawned process. Optional for detached/fire-and-forget spawns.
- `status`
- `startTime`
- `endTime`
- `error` — Error message when status is 'failed'. Contains details about what went wrong.

### `ExternalTaskStatus`

Normalized status for tasks coming from an external provider.

```typescript
any
```

### `ExternalTask`

A task as reported by an external provider, normalized to a common shape. Provider-specific adapters translate their native format into this.

```typescript
any
```

**Members:**

- `externalId` — Provider-assigned identifier for this task (opaque to core).
- `cleoTaskId` — Mapped CLEO task ID, or null if the task is new / unmatched.
- `title` — Human-readable title.
- `status` — Normalized status.
- `description` — Optional description text.
- `labels` — Optional labels/tags from the provider.
- `providerMeta` — Arbitrary provider-specific metadata (opaque to core).

### `SyncSessionState`

Persistent state for a sync session between CLEO and a provider. Stored per-provider under `.cleo/sync/<providerId>-session.json`.

```typescript
any
```

**Members:**

- `injectedTaskIds` — CLEO task IDs that were injected into the provider's task list.
- `injectedPhase` — Optional phase context when tasks were injected.
- `taskMetadata` — Per-task metadata at injection time.
- `lastSyncAt` — ISO timestamp of the last successful reconciliation.

### `ConflictPolicy`

Policy for resolving conflicts between CLEO and provider state.  - `cleo-wins`: CLEO state takes precedence (default). - `provider-wins`: Provider state takes precedence. - `latest-wins`: Most recently modified value wins. - `report-only`: Report conflicts without applying changes.

```typescript
any
```

### `ReconcileOptions`

Options for the reconciliation engine.

```typescript
any
```

**Members:**

- `providerId` — Provider ID (e.g. 'claude-code', 'cursor').
- `cwd` — Working directory (project root).
- `dryRun` — If true, compute actions without applying them.
- `conflictPolicy` — Conflict resolution policy. Defaults to 'cleo-wins'.
- `defaultPhase` — Default phase for newly created tasks.
- `defaultLabels` — Default labels for newly created tasks.

### `ReconcileActionType`

The type of action the reconciliation engine will take.

```typescript
any
```

### `ReconcileAction`

A single reconciliation action (planned or applied).

```typescript
any
```

**Members:**

- `type` — What kind of change.
- `cleoTaskId` — The CLEO task ID affected (null for creates before they happen).
- `externalId` — The external task that triggered this action.
- `summary` — Human-readable description of the action.
- `applied` — Whether this action was actually applied.
- `error` — Error message if the action failed during apply.

### `ReconcileResult`

Result of a full reconciliation run.

```typescript
any
```

**Members:**

- `dryRun` — Whether this was a dry run.
- `providerId` — Provider that was reconciled.
- `actions` — Individual actions taken (or planned).
- `summary` — Summary counts.
- `sessionCleared` — Whether sync session state was cleared after apply.

### `AdapterTaskSyncProvider`

Interface that provider adapters implement to expose their external task system to the reconciliation engine.  Provider-specific parsing lives here — core never sees native formats.

```typescript
any
```

**Members:**

- `getExternalTasks` — Read the provider's current task state and return normalized ExternalTasks.
- `pushTaskState` — Optionally push CLEO task state back to the provider. Not all providers support bidirectional sync.
- `cleanup` — Clean up provider-specific sync artifacts (e.g. state files).

### `AdapterTransportProvider`

Transport provider interface for CLEO provider adapters. Allows providers to supply custom inter-agent transport mechanisms.  T5240

```typescript
any
```

**Members:**

- `createTransport` — Create a transport instance for inter-agent communication
- `transportName` — Name of this transport type for logging/debugging

### `CLEOProviderAdapter`

```typescript
any
```

**Members:**

- `id`
- `name`
- `version`
- `capabilities`
- `hooks`
- `spawn`
- `install`
- `paths`
- `contextMonitor`
- `transport`
- `taskSync`
- `initialize`
- `dispose`
- `healthCheck`

### `AdapterHealthStatus`

```typescript
any
```

**Members:**

- `healthy`
- `provider`
- `details`

### `TaskStatus`

```typescript
any
```

### `SessionStatus`

```typescript
any
```

### `PipelineStatus`

```typescript
any
```

### `StageStatus`

```typescript
any
```

### `AdrStatus`

```typescript
any
```

### `GateStatus`

```typescript
any
```

### `ManifestStatus`

```typescript
any
```

### `EntityType`

```typescript
any
```

### `TaskPriority`

Task priority levels.

```typescript
any
```

### `TaskType`

Task type in hierarchy.

```typescript
any
```

### `TaskSize`

Task size (scope, NOT time).

```typescript
any
```

### `EpicLifecycle`

Epic lifecycle states.

```typescript
any
```

### `TaskOrigin`

Task origin (provenance).

```typescript
any
```

### `VerificationAgent`

Verification agent types.

```typescript
any
```

### `VerificationGate`

Verification gate names.

```typescript
any
```

### `VerificationFailure`

Verification failure log entry.

```typescript
any
```

**Members:**

- `round`
- `agent`
- `reason`
- `timestamp`

### `TaskVerification`

Task verification state.

```typescript
any
```

**Members:**

- `passed`
- `round`
- `gates`
- `lastAgent`
- `lastUpdated`
- `failureLog`

### `TaskProvenance`

Task provenance tracking.

```typescript
any
```

**Members:**

- `createdBy`
- `modifiedBy`
- `sessionId`

### `TaskRelation`

A single task relation entry.

```typescript
any
```

**Members:**

- `taskId`
- `type`
- `reason`

### `Task`

A single CLEO task as stored in the database.  Fields marked as required are enforced by CLEO's anti-hallucination validation at runtime. Making them required here ensures the type system catches violations at compile time rather than deferring to runtime checks.

```typescript
any
```

**Members:**

- `id` — Unique task identifier. Must match pattern `T\d{3,}` (e.g., T001, T5800).
- `title` — Human-readable task title. Required, max 120 characters.
- `description` — Task description. **Required** — CLEO's anti-hallucination rules reject tasks without a description, and require it to differ from the title.
- `status` — Current task status. Must be a valid `TaskStatus` enum value.
- `priority` — Task priority level. Defaults to `'medium'` on creation.
- `type` — Task type in hierarchy. Inferred from parent context if not specified.
- `parentId` — ID of the parent task. `null` for root-level tasks.
- `position` — Sort position within sibling scope.
- `positionVersion` — Optimistic concurrency version for position changes.
- `size` — Relative scope sizing (small/medium/large). NOT a time estimate.
- `phase` — Phase slug this task belongs to.
- `files` — File paths associated with this task.
- `acceptance` — Acceptance criteria for completion.
- `depends` — IDs of tasks this task depends on.
- `relates` — Related task entries (non-dependency relationships).
- `epicLifecycle` — Epic lifecycle state. Only meaningful when `type = 'epic'`.
- `noAutoComplete` — When true, epic will not auto-complete when all children are done.
- `blockedBy` — Reason the task is blocked (free-form text).
- `notes` — Timestamped notes appended during task lifecycle.
- `labels` — Classification labels for filtering and grouping.
- `origin` — Task origin/provenance category.
- `createdAt` — ISO 8601 timestamp of task creation. Must not be in the future.
- `updatedAt` — ISO 8601 timestamp of last update. Set automatically on mutation.
- `completedAt` — ISO 8601 timestamp of task completion. Set when `status` transitions to `'done'`. See `CompletedTask` for the status-narrowed type where this is required.
- `cancelledAt` — ISO 8601 timestamp of task cancellation. Set when `status` transitions to `'cancelled'`. See `CancelledTask` for the status-narrowed type where this is required.
- `cancellationReason` — Reason for cancellation. Required when `status = 'cancelled'`. See `CancelledTask` for the status-narrowed type where this is required.
- `verification` — Verification pipeline state.
- `provenance` — Provenance tracking (who created/modified, which session).

### `TaskCreate`

Input type for creating a new task via `addTask()`.  Only the fields the caller MUST provide are required. All other fields have sensible defaults applied by the creation logic: - `status` defaults to `'pending'` - `priority` defaults to `'medium'` - `type` is inferred from parent context - `size` defaults to `'medium'`

```typescript
any
```

**Members:**

- `title` — Human-readable task title. Required, max 120 characters.
- `description` — Task description. **Required** — CLEO's anti-hallucination rules reject tasks without a description, and require it to differ from the title.
- `status` — Initial status. Defaults to `'pending'`.
- `priority` — Priority level. Defaults to `'medium'`.
- `type` — Task type. Inferred from parent context if not specified.
- `parentId` — Parent task ID for hierarchy placement.
- `size` — Relative scope sizing. Defaults to `'medium'`.
- `phase` — Phase slug to assign. Inherited from project.currentPhase if not specified.
- `labels` — Classification labels.
- `files` — File paths associated with this task.
- `acceptance` — Acceptance criteria.
- `depends` — IDs of tasks this task depends on.
- `notes` — Initial note to attach.
- `position` — Sort position. Auto-calculated if not specified.

### `CompletedTask`

A task with `status = 'done'`. Narrows `Task` to require `completedAt`.  Use this type when you need to guarantee a completed task has its completion timestamp — for example, in cycle-time calculations or archive operations.

```typescript
any
```

### `CancelledTask`

A task with `status = 'cancelled'`. Narrows `Task` to require `cancelledAt` and `cancellationReason`.  Use this type when processing cancelled tasks where the cancellation metadata is guaranteed to be present.

```typescript
any
```

### `PhaseStatus`

Phase status.

```typescript
any
```

### `Phase`

Phase definition.

```typescript
any
```

**Members:**

- `order`
- `name`
- `description`
- `status`
- `startedAt`
- `completedAt`

### `PhaseTransition`

Phase transition record.

```typescript
any
```

**Members:**

- `phase`
- `transitionType`
- `timestamp`
- `taskCount`
- `fromPhase`
- `reason`

### `ReleaseStatus`

Release status.

```typescript
any
```

### `Release`

Release definition.

```typescript
any
```

**Members:**

- `version`
- `status`
- `targetDate`
- `releasedAt`
- `tasks`
- `notes`
- `changelog`

### `ProjectMeta`

Project metadata.

```typescript
any
```

**Members:**

- `name`
- `currentPhase`
- `phases`
- `phaseHistory`
- `releases`

### `FileMeta`

File metadata (_meta block).

```typescript
any
```

**Members:**

- `schemaVersion`
- `specVersion`
- `checksum`
- `configVersion`
- `lastSessionId`
- `activeSession`
- `activeSessionCount`
- `sessionsFile`
- `generation`

### `SessionNote`

Session note in taskWork block.

```typescript
any
```

**Members:**

- `note`
- `timestamp`
- `conversationId`
- `agent`

### `TaskWorkState`

Task work state.

```typescript
any
```

**Members:**

- `currentTask`
- `currentPhase`
- `blockedUntil`
- `sessionNote`
- `sessionNotes`
- `nextAction`
- `primarySession`

### `TaskFile`

Root task data structure.

```typescript
any
```

**Members:**

- `version`
- `project`
- `lastUpdated`
- `_meta`
- `taskWork`
- `focus`
- `tasks`
- `labels`

### `ArchiveMetadata`

Archive metadata attached to archived task records.

```typescript
any
```

**Members:**

- `archivedAt`
- `cycleTimeDays`
- `archiveSource`
- `archiveReason`

### `ArchivedTask`

A task with archive metadata.

```typescript
any
```

**Members:**

- `_archive`

### `ArchiveReportType`

Report type for archive statistics.

```typescript
any
```

### `ArchiveSummaryReport`

Summary report from archive statistics.

```typescript
any
```

**Members:**

- `totalArchived`
- `byStatus`
- `byPriority`
- `averageCycleTime`
- `oldestArchived`
- `newestArchived`
- `archiveSourceBreakdown`

### `ArchivePhaseEntry`

Phase breakdown entry from archive statistics.

```typescript
any
```

**Members:**

- `phase`
- `count`
- `avgCycleTime`

### `ArchiveLabelEntry`

Label breakdown entry from archive statistics.

```typescript
any
```

**Members:**

- `label`
- `count`

### `ArchivePriorityEntry`

Priority breakdown entry from archive statistics.

```typescript
any
```

**Members:**

- `priority`
- `count`
- `avgCycleTime`

### `CycleTimeDistribution`

Cycle time distribution buckets.

```typescript
any
```

**Members:**

- `'0-1 days'`
- `'2-7 days'`
- `'8-30 days'`
- `'30+ days'`

### `CycleTimePercentiles`

Cycle time percentiles.

```typescript
any
```

**Members:**

- `p25`
- `p50`
- `p75`
- `p90`

### `ArchiveCycleTimesReport`

Cycle times report from archive statistics.

```typescript
any
```

**Members:**

- `count`
- `min`
- `max`
- `avg`
- `median`
- `distribution`
- `percentiles`

### `ArchiveDailyTrend`

Daily archive trend entry.

```typescript
any
```

**Members:**

- `date`
- `count`

### `ArchiveMonthlyTrend`

Monthly archive trend entry.

```typescript
any
```

**Members:**

- `month`
- `count`

### `ArchiveTrendsReport`

Trends report from archive statistics.

```typescript
any
```

**Members:**

- `byDay`
- `byMonth`
- `totalPeriod`
- `averagePerDay`

### `ArchiveStatsEnvelope`

Archive statistics result envelope.

```typescript
any
```

**Members:**

- `report`
- `filters`
- `data`

### `BrainEntryRef`

Compact brain entry reference used in contradiction analysis.

```typescript
any
```

**Members:**

- `id`
- `type`
- `content`
- `createdAt`

### `BrainEntrySummary`

Brain entry reference with summary, used in superseded analysis.

```typescript
any
```

**Members:**

- `id`
- `type`
- `createdAt`
- `summary`

### `ContradictionDetail`

Contradiction detail between two brain entries.

```typescript
any
```

**Members:**

- `entryA`
- `entryB`
- `context`
- `conflictDetails`

### `SupersededEntry`

Superseded entry pair showing old and replacement entries.

```typescript
any
```

**Members:**

- `oldEntry`
- `replacement`
- `grouping`

### `OutputFormat`

Output format options.

```typescript
any
```

### `DateFormat`

Date format options.

```typescript
any
```

### `OutputConfig`

Output configuration.

```typescript
any
```

**Members:**

- `defaultFormat`
- `showColor`
- `showUnicode`
- `showProgressBars`
- `dateFormat`

### `BackupConfig`

Backup configuration.

```typescript
any
```

**Members:**

- `maxOperationalBackups`
- `maxSafetyBackups`
- `compressionEnabled`

### `EnforcementProfile`

Hierarchy enforcement profile preset.

```typescript
any
```

### `HierarchyConfig`

Hierarchy configuration.

```typescript
any
```

**Members:**

- `maxDepth`
- `maxSiblings`
- `cascadeDelete`
- `maxActiveSiblings` — Maximum number of active (non-done) siblings. 0 = disabled.
- `countDoneInLimit` — Whether done tasks count toward the sibling limit.
- `enforcementProfile` — Enforcement profile preset. Explicit fields override preset values.

### `SessionConfig`

Session configuration.

```typescript
any
```

**Members:**

- `autoStart`
- `requireNotes`
- `multiSession`

### `LogLevel`

Pino log levels.

```typescript
any
```

### `LoggingConfig`

Logging configuration.

```typescript
any
```

**Members:**

- `level` — Minimum log level to record (default: 'info')
- `filePath` — Log file path relative to .cleo/ (default: 'logs/cleo.log')
- `maxFileSize` — Max log file size in bytes before rotation (default: 10MB)
- `maxFiles` — Number of rotated log files to retain (default: 5)
- `auditRetentionDays` — Days to retain audit_log rows before pruning (default: 90)
- `archiveBeforePrune` — Whether to archive pruned rows to compressed JSONL before deletion (default: true)

### `LifecycleEnforcementMode`

Lifecycle enforcement mode.

```typescript
any
```

### `LifecycleConfig`

Lifecycle enforcement configuration.

```typescript
any
```

**Members:**

- `mode`

### `SharingMode`

Sharing mode: whether .cleo/ files are committed to the project git repo.

```typescript
any
```

### `SharingConfig`

Sharing configuration for multi-contributor .cleo/ state management.

```typescript
any
```

**Members:**

- `mode` — Sharing mode (default: 'none').
- `commitAllowlist` — Files/patterns in .cleo/ to commit to project git (relative to .cleo/).
- `denylist` — Files/patterns to always exclude, even if in commitAllowlist.

### `SignalDockMode`

SignalDock transport mode.

```typescript
any
```

### `SignalDockConfig`

SignalDock integration configuration.

```typescript
any
```

**Members:**

- `enabled` — Whether SignalDock transport is enabled (default: false).
- `mode` — Transport mode: 'http' for REST API client, 'native' for napi-rs bindings (default: 'http').
- `endpoint` — SignalDock API server endpoint (default: 'http://localhost:4000').
- `agentPrefix` — Prefix for CLEO agent names in SignalDock registry (default: 'cleo-').
- `privacyTier` — Default privacy tier for registered agents (default: 'private').

### `CleoConfig`

CLEO project configuration (config.json).

```typescript
any
```

**Members:**

- `version`
- `output`
- `backup`
- `hierarchy`
- `session`
- `lifecycle`
- `logging`
- `sharing`
- `signaldock` — SignalDock inter-agent transport (optional, disabled by default).

### `ConfigSource`

Configuration resolution priority.

```typescript
any
```

### `ResolvedValue`

A resolved config value with its source.

```typescript
any
```

**Members:**

- `value`
- `source`

### `SessionScope`

Session scope JSON blob shape.

```typescript
any
```

**Members:**

- `type`
- `epicId`
- `rootTaskId`
- `includeDescendants`
- `phaseFilter`
- `labelFilter`
- `maxDepth`
- `explicitTaskIds`
- `excludeTaskIds`
- `computedTaskIds`
- `computedAt`

### `SessionStats`

Session statistics.

```typescript
any
```

**Members:**

- `tasksCompleted`
- `tasksCreated`
- `tasksUpdated`
- `focusChanges`
- `totalActiveMinutes`
- `suspendCount`

### `SessionTaskWork`

Active task work state within a session.

```typescript
any
```

**Members:**

- `taskId`
- `setAt`

### `Session`

Session domain type — plain interface aligned with Drizzle sessions table.

```typescript
any
```

**Members:**

- `id`
- `name`
- `status`
- `scope`
- `taskWork`
- `startedAt`
- `endedAt`
- `agent`
- `notes`
- `tasksCompleted`
- `tasksCreated`
- `handoffJson`
- `previousSessionId`
- `nextSessionId`
- `agentIdentifier`
- `handoffConsumedAt`
- `handoffConsumedBy`
- `debriefJson`
- `stats`
- `resumeCount`
- `gradeMode`
- `providerId`

### `SessionStartResult`

Result of a session start operation.  The `sessionId` field is a convenience alias for `session.id`, provided for consumers that expect it at the top level of the result.

```typescript
any
```

**Members:**

- `session`
- `sessionId`

### `ArchiveFields`

Archive-specific fields for task upsert.

```typescript
any
```

**Members:**

- `archivedAt`
- `archiveReason`
- `cycleTimeDays`

### `ArchiveFile`

Archive file structure.

```typescript
any
```

**Members:**

- `archivedTasks`
- `version`

### `TaskQueryFilters`

Filter bag for queryTasks(). Covers ~90% of task query patterns.

```typescript
any
```

**Members:**

- `status`
- `priority`
- `type`
- `parentId`
- `phase`
- `label`
- `search`
- `excludeStatus`
- `limit`
- `offset`
- `orderBy`

### `QueryTasksResult`

Result from queryTasks() with pagination support.

```typescript
any
```

**Members:**

- `tasks`
- `total`

### `TaskFieldUpdates`

Partial task row fields for updateTaskFields().

```typescript
any
```

**Members:**

- `title`
- `description`
- `status`
- `priority`
- `type`
- `parentId`
- `phase`
- `size`
- `position`
- `positionVersion`
- `labelsJson`
- `notesJson`
- `acceptanceJson`
- `filesJson`
- `origin`
- `blockedBy`
- `epicLifecycle`
- `noAutoComplete`
- `completedAt`
- `cancelledAt`
- `cancellationReason`
- `verificationJson`
- `createdBy`
- `modifiedBy`
- `sessionId`
- `updatedAt`

### `TransactionAccessor`

Subset of DataAccessor methods available inside a transaction callback. Write-only — reads use the outer accessor (snapshot isolation).

```typescript
any
```

**Members:**

- `upsertSingleTask`
- `archiveSingleTask`
- `removeSingleTask`
- `setMetaValue`
- `updateTaskFields`
- `appendLog`

### `DataAccessor`

DataAccessor interface.  Core modules call these methods instead of readJson/saveJson. Each method maps directly to the file-level operations that core modules already perform.

```typescript
any
```

**Members:**

- `engine` — The storage engine backing this accessor.
- `loadArchive` — Load the archive file. Returns null if archive doesn't exist.
- `saveArchive` — Save the archive file atomically. Creates backup before write.
- `loadSessions` — Load all sessions from the store. Returns empty array if none exist.
- `saveSessions` — Save all sessions to the store atomically.
- `appendLog` — Append an entry to the audit log.
- `close` — Release any resources (close DB connections, etc.).
- `upsertSingleTask` — Upsert a single task (targeted write, no full-file reload).
- `archiveSingleTask` — Archive a single task by ID (sets status='archived' + archive metadata).
- `removeSingleTask` — Delete a single task permanently from the tasks table.
- `loadSingleTask` — Load a single task by ID with its dependencies and relations. Returns null if not found.
- `addRelation` — Insert a row into the task_relations table (T5168).
- `getMetaValue` — Read a typed value from the metadata store. Returns null if not found.
- `setMetaValue` — Write a typed value to the metadata store.
- `getSchemaVersion` — Read the schema version from metadata. Convenience for getMetaValue('schema_version').
- `queryTasks` — Query tasks with filters, pagination, and ordering. Returns matching tasks + total count.
- `countTasks` — Count tasks matching optional filters. Excludes archived by default.
- `getChildren` — Get direct children of a parent task.
- `countChildren` — Count direct children of a parent task (all statuses except archived).
- `countActiveChildren` — Count active (non-terminal) children of a parent task.
- `getAncestorChain` — Get ancestor chain from task to root via WITH RECURSIVE CTE. Ordered root-first.
- `getSubtree` — Get full subtree rooted at taskId via WITH RECURSIVE CTE. Includes root.
- `getDependents` — Get tasks that depend on (are blocked by) the given task. Reverse dep lookup.
- `getDependencyChain` — Get transitive dependency chain via WITH RECURSIVE CTE. Returns task IDs.
- `taskExists` — Check if a task exists (any status including archived).
- `loadTasks` — Load multiple tasks by ID in a single batch query.
- `updateTaskFields` — Update specific fields on a task without full load/save cycle.
- `getNextPosition` — Get next available position for a task within a parent scope (SQL-level, race-safe).
- `shiftPositions` — Shift positions of siblings = fromPosition by delta (bulk SQL update).
- `transaction` — Execute a function inside a SQLite transaction (BEGIN IMMEDIATE / COMMIT / ROLLBACK).
- `getActiveSession` — Get the currently active session (status='active', most recent).
- `upsertSingleSession` — Upsert a single session (targeted write).
- `removeSingleSession` — Remove a single session by ID.

### `AdapterManifest`

```typescript
any
```

**Members:**

- `id`
- `name`
- `version`
- `description`
- `provider` — Provider identifier, e.g. "claude-code", "opencode", "cursor"
- `entryPoint` — Relative path to the main adapter module
- `packagePath` — Resolved absolute path to the adapter package root. Populated at discovery time by discoverAdapterManifests().
- `capabilities`
- `detectionPatterns`

### `DetectionPattern`

```typescript
any
```

**Members:**

- `type`
- `pattern`
- `description`

### `ExitCode`

CLEO exit codes — canonical definitions shared across all layers.  Ranges: 0 = success, 1-99 = errors, 100+ = special (non-error) states.   T4454  T4456  T5710

```typescript
typeof ExitCode
```

**Members:**

- `SUCCESS`
- `GENERAL_ERROR`
- `INVALID_INPUT`
- `FILE_ERROR`
- `NOT_FOUND`
- `DEPENDENCY_ERROR`
- `VALIDATION_ERROR`
- `LOCK_TIMEOUT`
- `CONFIG_ERROR`
- `PARENT_NOT_FOUND`
- `DEPTH_EXCEEDED`
- `SIBLING_LIMIT`
- `INVALID_PARENT_TYPE`
- `CIRCULAR_REFERENCE`
- `ORPHAN_DETECTED`
- `HAS_CHILDREN`
- `TASK_COMPLETED`
- `CASCADE_FAILED`
- `HAS_DEPENDENTS`
- `CHECKSUM_MISMATCH`
- `CONCURRENT_MODIFICATION`
- `ID_COLLISION`
- `SESSION_EXISTS`
- `SESSION_NOT_FOUND`
- `SCOPE_CONFLICT`
- `SCOPE_INVALID`
- `TASK_NOT_IN_SCOPE`
- `TASK_CLAIMED`
- `SESSION_REQUIRED`
- `SESSION_CLOSE_BLOCKED`
- `ACTIVE_TASK_REQUIRED`
- `NOTES_REQUIRED`
- `VERIFICATION_INIT_FAILED`
- `GATE_UPDATE_FAILED`
- `INVALID_GATE`
- `INVALID_AGENT`
- `MAX_ROUNDS_EXCEEDED`
- `GATE_DEPENDENCY`
- `VERIFICATION_LOCKED`
- `ROUND_MISMATCH`
- `CONTEXT_WARNING`
- `CONTEXT_CAUTION`
- `CONTEXT_CRITICAL`
- `CONTEXT_EMERGENCY`
- `CONTEXT_STALE`
- `PROTOCOL_MISSING`
- `INVALID_RETURN_MESSAGE`
- `MANIFEST_ENTRY_MISSING`
- `SPAWN_VALIDATION_FAILED`
- `AUTONOMOUS_BOUNDARY`
- `HANDOFF_REQUIRED`
- `RESUME_FAILED`
- `CONCURRENT_SESSION`
- `NEXUS_NOT_INITIALIZED`
- `NEXUS_PROJECT_NOT_FOUND`
- `NEXUS_PERMISSION_DENIED`
- `NEXUS_INVALID_SYNTAX`
- `NEXUS_SYNC_FAILED`
- `NEXUS_REGISTRY_CORRUPT`
- `NEXUS_PROJECT_EXISTS`
- `NEXUS_QUERY_FAILED`
- `NEXUS_GRAPH_ERROR`
- `NEXUS_RESERVED`
- `LIFECYCLE_GATE_FAILED`
- `AUDIT_MISSING`
- `CIRCULAR_VALIDATION`
- `LIFECYCLE_TRANSITION_INVALID`
- `PROVENANCE_REQUIRED`
- `ARTIFACT_TYPE_UNKNOWN`
- `ARTIFACT_VALIDATION_FAILED`
- `ARTIFACT_BUILD_FAILED`
- `ARTIFACT_PUBLISH_FAILED`
- `ARTIFACT_ROLLBACK_FAILED`
- `PROVENANCE_CONFIG_INVALID`
- `SIGNING_KEY_MISSING`
- `SIGNATURE_INVALID`
- `DIGEST_MISMATCH`
- `ATTESTATION_INVALID`
- `ADAPTER_NOT_FOUND`
- `ADAPTER_INIT_FAILED`
- `ADAPTER_HOOK_FAILED`
- `ADAPTER_SPAWN_FAILED`
- `ADAPTER_INSTALL_FAILED`
- `NO_DATA`
- `ALREADY_EXISTS`
- `NO_CHANGE`
- `TESTS_SKIPPED`

### `LAFSErrorCategory`

LAFS error category.

```typescript
any
```

### `LAFSError`

LAFS error object.

```typescript
any
```

**Members:**

- `code`
- `category`
- `message`
- `fix`
- `details`

### `Warning`

LAFS warning.

```typescript
any
```

**Members:**

- `code`
- `message`

### `LAFSTransport`

LAFS transport metadata.

```typescript
any
```

### `MVILevel`

MVI (Minimal Viable Information) level.

```typescript
any
```

### `LAFSPageNone`

LAFS page — no pagination.

```typescript
any
```

**Members:**

- `strategy`

### `LAFSPageOffset`

LAFS page — offset-based pagination.

```typescript
any
```

**Members:**

- `strategy`
- `offset`
- `limit`
- `total`
- `hasMore`

### `LAFSPage`

LAFS page union.

```typescript
any
```

### `LAFSMeta`

LAFS metadata block.

```typescript
any
```

**Members:**

- `transport`
- `mvi`
- `page`
- `warnings`
- `durationMs`

### `LAFSEnvelope`

LAFS envelope (canonical protocol type).

```typescript
any
```

**Members:**

- `success`
- `data`
- `error`
- `_meta`

### `FlagInput`

Flag input for conformance checks.

```typescript
any
```

**Members:**

- `flag`
- `value`

### `ConformanceReport`

Conformance report.

```typescript
any
```

**Members:**

- `valid`
- `violations`
- `warnings`

### `LafsAlternative`

Actionable alternative the caller can try.

```typescript
any
```

**Members:**

- `action`
- `command`

### `LafsErrorDetail`

LAFS error detail shared between CLI and MCP.

```typescript
any
```

**Members:**

- `code`
- `name`
- `message`
- `fix`
- `alternatives`
- `details`

### `LafsSuccess`

LAFS success envelope (CLI).

```typescript
any
```

**Members:**

- `success`
- `data`
- `message`
- `noChange`

### `LafsError`

LAFS error envelope (CLI).

```typescript
any
```

**Members:**

- `success`
- `error`

### `LafsEnvelope`

CLI envelope union type.

```typescript
any
```

### `GatewayMeta`

Metadata attached to every MCP gateway response. Extends the canonical LAFSMeta with CLEO gateway-specific fields.   T4655

```typescript
any
```

**Members:**

- `gateway`
- `domain`
- `duration_ms`

### `GatewaySuccess`

MCP success envelope (extends CLI base with _meta).

```typescript
any
```

**Members:**

- `_meta`

### `GatewayError`

MCP error envelope (extends CLI base with _meta).

```typescript
any
```

**Members:**

- `_meta`

### `GatewayEnvelope`

MCP envelope union type.

```typescript
any
```

### `CleoResponse`

Unified CLEO response envelope.  Every CLEO response (CLI or MCP) is a CleoResponse. MCP responses include the _meta field; CLI responses do not.

```typescript
any
```

### `MemoryBridgeConfig`

Memory bridge types for CLEO provider adapters. Defines the shape of .cleo/memory-bridge.md content for cross-provider memory sharing.   T5240

```typescript
any
```

**Members:**

- `maxObservations`
- `maxLearnings`
- `maxPatterns`
- `maxDecisions`
- `includeHandoff`
- `includeAntiPatterns`

### `MemoryBridgeContent`

```typescript
any
```

**Members:**

- `generatedAt`
- `lastSession`
- `learnings`
- `patterns`
- `antiPatterns`
- `decisions`
- `recentObservations`

### `SessionSummary`

```typescript
any
```

**Members:**

- `sessionId`
- `date`
- `tasksCompleted`
- `decisions`
- `nextSuggested`

### `BridgeLearning`

```typescript
any
```

**Members:**

- `id`
- `text`
- `confidence`

### `BridgePattern`

```typescript
any
```

**Members:**

- `id`
- `text`
- `type`

### `BridgeDecision`

```typescript
any
```

**Members:**

- `id`
- `title`
- `date`

### `BridgeObservation`

```typescript
any
```

**Members:**

- `id`
- `date`
- `summary`

### `IssueSeverity`

Common issue types

```typescript
any
```

### `IssueArea`

```typescript
any
```

### `IssueType`

```typescript
any
```

### `Diagnostics`

```typescript
any
```

**Members:**

- `cleoVersion`
- `bashVersion`
- `jqVersion`
- `os`
- `shell`
- `cleoHome`
- `ghVersion`
- `installLocation`

### `IssuesDiagnosticsParams`

```typescript
any
```

### `IssuesDiagnosticsResult`

```typescript
any
```

**Members:**

- `diagnostics`

### `IssuesCreateBugParams`

```typescript
any
```

**Members:**

- `title`
- `body`
- `severity`
- `area`
- `dryRun`

### `IssuesCreateBugResult`

```typescript
any
```

**Members:**

- `type`
- `url`
- `number`
- `title`
- `labels`

### `IssuesCreateFeatureParams`

```typescript
any
```

**Members:**

- `title`
- `body`
- `area`
- `dryRun`

### `IssuesCreateFeatureResult`

```typescript
any
```

**Members:**

- `type`
- `url`
- `number`
- `title`
- `labels`

### `IssuesCreateHelpParams`

```typescript
any
```

**Members:**

- `title`
- `body`
- `area`
- `dryRun`

### `IssuesCreateHelpResult`

```typescript
any
```

**Members:**

- `type`
- `url`
- `number`
- `title`
- `labels`

### `LifecycleStage`

Common lifecycle types

```typescript
any
```

### `GateStatus`

```typescript
any
```

### `StageRecord`

```typescript
any
```

**Members:**

- `stage`
- `status`
- `started`
- `completed`
- `agent`
- `notes`

### `Gate`

```typescript
any
```

**Members:**

- `name`
- `stage`
- `status`
- `agent`
- `timestamp`
- `reason`

### `LifecycleCheckParams`

```typescript
any
```

**Members:**

- `taskId`
- `targetStage`

### `LifecycleCheckResult`

```typescript
any
```

**Members:**

- `taskId`
- `targetStage`
- `canProceed`
- `missingPrerequisites`
- `gateStatus`

### `LifecycleStatusParams`

```typescript
any
```

**Members:**

- `taskId`
- `epicId`

### `LifecycleStatusResult`

```typescript
any
```

**Members:**

- `id`
- `currentStage`
- `stages`
- `completedStages`
- `pendingStages`

### `LifecycleHistoryParams`

```typescript
any
```

**Members:**

- `taskId`

### `LifecycleHistoryEntry`

```typescript
any
```

**Members:**

- `stage`
- `from`
- `to`
- `timestamp`
- `agent`
- `notes`

### `LifecycleHistoryResult`

```typescript
any
```

### `LifecycleGatesParams`

```typescript
any
```

**Members:**

- `taskId`

### `LifecycleGatesResult`

```typescript
any
```

### `LifecyclePrerequisitesParams`

```typescript
any
```

**Members:**

- `targetStage`

### `LifecyclePrerequisitesResult`

```typescript
any
```

**Members:**

- `targetStage`
- `prerequisites`
- `optional`

### `LifecycleProgressParams`

```typescript
any
```

**Members:**

- `taskId`
- `stage`
- `status`
- `notes`

### `LifecycleProgressResult`

```typescript
any
```

**Members:**

- `taskId`
- `stage`
- `status`
- `timestamp`

### `LifecycleSkipParams`

```typescript
any
```

**Members:**

- `taskId`
- `stage`
- `reason`

### `LifecycleSkipResult`

```typescript
any
```

**Members:**

- `taskId`
- `stage`
- `skipped`
- `reason`

### `LifecycleResetParams`

```typescript
any
```

**Members:**

- `taskId`
- `stage`
- `reason`

### `LifecycleResetResult`

```typescript
any
```

**Members:**

- `taskId`
- `stage`
- `reset`
- `reason`
- `warning`

### `LifecycleGatePassParams`

```typescript
any
```

**Members:**

- `taskId`
- `gateName`
- `agent`
- `notes`

### `LifecycleGatePassResult`

```typescript
any
```

**Members:**

- `taskId`
- `gateName`
- `status`
- `timestamp`

### `LifecycleGateFailParams`

```typescript
any
```

**Members:**

- `taskId`
- `gateName`
- `reason`

### `LifecycleGateFailResult`

```typescript
any
```

**Members:**

- `taskId`
- `gateName`
- `status`
- `reason`
- `timestamp`

### `Wave`

Common orchestration types

```typescript
any
```

**Members:**

- `wave`
- `taskIds`
- `canRunParallel`
- `dependencies`

### `SkillDefinition`

```typescript
any
```

**Members:**

- `name`
- `description`
- `tags`
- `model`
- `protocols`

### `OrchestrateStatusParams`

```typescript
any
```

**Members:**

- `epicId`

### `OrchestrateStatusResult`

```typescript
any
```

**Members:**

- `epicId`
- `totalTasks`
- `completedTasks`
- `pendingTasks`
- `blockedTasks`
- `currentWave`
- `totalWaves`
- `parallelCapacity`

### `OrchestrateNextParams`

```typescript
any
```

**Members:**

- `epicId`

### `OrchestrateNextResult`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `recommendedSkill`
- `reasoning`

### `OrchestrateReadyParams`

```typescript
any
```

**Members:**

- `epicId`

### `OrchestrateReadyResult`

```typescript
any
```

**Members:**

- `wave`
- `taskIds`
- `parallelSafe`

### `OrchestrateAnalyzeParams`

```typescript
any
```

**Members:**

- `epicId`

### `OrchestrateAnalyzeResult`

```typescript
any
```

**Members:**

- `waves`
- `criticalPath`
- `estimatedParallelism`
- `bottlenecks`

### `OrchestrateContextParams`

```typescript
any
```

**Members:**

- `tokens`

### `OrchestrateContextResult`

```typescript
any
```

**Members:**

- `currentTokens`
- `maxTokens`
- `percentUsed`
- `level`
- `recommendation`

### `OrchestrateWavesParams`

```typescript
any
```

**Members:**

- `epicId`

### `OrchestrateWavesResult`

```typescript
any
```

### `OrchestrateSkillListParams`

```typescript
any
```

**Members:**

- `filter`

### `OrchestrateSkillListResult`

```typescript
any
```

### `OrchestrateBootstrapParams`

```typescript
any
```

**Members:**

- `speed`

### `BrainState`

```typescript
any
```

**Members:**

- `session`
- `currentTask`
- `nextSuggestion`
- `recentDecisions`
- `blockers`
- `progress`
- `contextDrift`
- `_meta`

### `OrchestrateStartupParams`

```typescript
any
```

**Members:**

- `epicId`

### `OrchestrateStartupResult`

```typescript
any
```

**Members:**

- `epicId`
- `status`
- `analysis`
- `firstTask`

### `OrchestrateSpawnParams`

```typescript
any
```

**Members:**

- `taskId`
- `skill`
- `model`

### `OrchestrateSpawnResult`

```typescript
any
```

**Members:**

- `taskId`
- `skill`
- `model`
- `prompt`
- `metadata`

### `OrchestrateHandoffParams`

```typescript
any
```

**Members:**

- `taskId`
- `protocolType`
- `note`
- `nextAction`
- `variant`
- `tier`
- `idempotencyKey`

### `OrchestrateHandoffResult`

```typescript
any
```

**Members:**

- `taskId`
- `predecessorSessionId`
- `endedSessionId`
- `protocolType`

### `OrchestrateValidateParams`

```typescript
any
```

**Members:**

- `taskId`

### `OrchestrateValidateResult`

```typescript
any
```

**Members:**

- `taskId`
- `ready`
- `blockers`
- `lifecycleGate`
- `recommendations`

### `OrchestrateParallelStartParams`

```typescript
any
```

**Members:**

- `epicId`
- `wave`

### `OrchestrateParallelStartResult`

```typescript
any
```

**Members:**

- `wave`
- `taskIds`
- `started`

### `OrchestrateParallelEndParams`

```typescript
any
```

**Members:**

- `epicId`
- `wave`

### `OrchestrateParallelEndResult`

```typescript
any
```

**Members:**

- `wave`
- `completed`
- `failed`
- `duration`

### `ReleaseType`

Common release types

```typescript
any
```

### `ReleaseGate`

```typescript
any
```

**Members:**

- `name`
- `description`
- `passed`
- `reason`

### `ChangelogSection`

```typescript
any
```

**Members:**

- `type`
- `entries`

### `ReleasePrepareParams`

```typescript
any
```

**Members:**

- `version`
- `type`

### `ReleasePrepareResult`

```typescript
any
```

**Members:**

- `version`
- `type`
- `currentVersion`
- `files`
- `ready`
- `warnings`

### `ReleaseChangelogParams`

```typescript
any
```

**Members:**

- `version`
- `sections`

### `ReleaseChangelogResult`

```typescript
any
```

**Members:**

- `version`
- `content`
- `sections`
- `commitCount`

### `ReleaseCommitParams`

```typescript
any
```

**Members:**

- `version`
- `files`

### `ReleaseCommitResult`

```typescript
any
```

**Members:**

- `version`
- `commitHash`
- `message`
- `filesCommitted`

### `ReleaseTagParams`

```typescript
any
```

**Members:**

- `version`
- `message`

### `ReleaseTagResult`

```typescript
any
```

**Members:**

- `version`
- `tagName`
- `created`

### `ReleasePushParams`

```typescript
any
```

**Members:**

- `version`
- `remote`

### `ReleasePushResult`

```typescript
any
```

**Members:**

- `version`
- `remote`
- `pushed`
- `tagsPushed`

### `ReleaseGatesRunParams`

```typescript
any
```

**Members:**

- `gates`

### `ReleaseGatesRunResult`

```typescript
any
```

**Members:**

- `total`
- `passed`
- `failed`
- `gates`
- `canRelease`

### `ReleaseRollbackParams`

```typescript
any
```

**Members:**

- `version`
- `reason`

### `ReleaseRollbackResult`

```typescript
any
```

**Members:**

- `version`
- `rolledBack`
- `restoredVersion`
- `reason`

### `ResearchEntry`

Common research types

```typescript
any
```

**Members:**

- `id`
- `taskId`
- `title`
- `file`
- `date`
- `status`
- `agentType`
- `topics`
- `keyFindings`
- `actionable`
- `needsFollowup`
- `linkedTasks`
- `confidence`

### `ManifestEntry`

```typescript
any
```

**Members:**

- `id`
- `file`
- `title`
- `date`
- `status`
- `agent_type`
- `topics`
- `key_findings`
- `actionable`
- `needs_followup`
- `linked_tasks`

### `ResearchShowParams`

```typescript
any
```

**Members:**

- `researchId`

### `ResearchShowResult`

```typescript
any
```

### `ResearchListParams`

```typescript
any
```

**Members:**

- `epicId`
- `status`

### `ResearchListResult`

```typescript
any
```

### `ResearchQueryParams`

```typescript
any
```

**Members:**

- `query`
- `confidence`

### `ResearchQueryResult`

```typescript
any
```

**Members:**

- `entries`
- `matchCount`
- `avgConfidence`

### `ResearchPendingParams`

```typescript
any
```

**Members:**

- `epicId`

### `ResearchPendingResult`

```typescript
any
```

### `ResearchStatsParams`

```typescript
any
```

**Members:**

- `epicId`

### `ResearchStatsResult`

```typescript
any
```

**Members:**

- `total`
- `complete`
- `partial`
- `blocked`
- `byAgentType`
- `byTopic`
- `avgConfidence`

### `ResearchManifestReadParams`

```typescript
any
```

**Members:**

- `filter`
- `limit`
- `offset`

### `ResearchManifestReadResult`

```typescript
any
```

### `ResearchInjectParams`

```typescript
any
```

**Members:**

- `protocolType`
- `taskId`
- `variant`

### `ResearchInjectResult`

```typescript
any
```

**Members:**

- `protocol`
- `content`
- `tokensUsed`

### `ResearchLinkParams`

```typescript
any
```

**Members:**

- `researchId`
- `taskId`
- `relationship`

### `ResearchLinkResult`

```typescript
any
```

**Members:**

- `researchId`
- `taskId`
- `relationship`
- `linked`

### `ResearchManifestAppendParams`

```typescript
any
```

**Members:**

- `entry`
- `validateFile`

### `ResearchManifestAppendResult`

```typescript
any
```

**Members:**

- `id`
- `appended`
- `validated`

### `ResearchManifestArchiveParams`

```typescript
any
```

**Members:**

- `beforeDate`
- `moveFiles`

### `ResearchManifestArchiveResult`

```typescript
any
```

**Members:**

- `archived`
- `entryIds`
- `filesMovedCount`

### `SessionOp`

Common session types

```typescript
any
```

**Members:**

- `id`
- `name`
- `scope`
- `started`
- `ended`
- `startedTask`
- `status`
- `notes`

### `SessionStatusParams`

```typescript
any
```

### `SessionStatusResult`

```typescript
any
```

**Members:**

- `current`
- `hasStartedTask`
- `startedTask`

### `SessionListParams`

```typescript
any
```

**Members:**

- `active`
- `status`
- `limit`
- `offset`

### `SessionListResult`

```typescript
any
```

**Members:**

- `sessions`
- `total`
- `filtered`

### `SessionShowParams`

```typescript
any
```

**Members:**

- `sessionId`

### `SessionShowResult`

```typescript
any
```

### `SessionHistoryParams`

```typescript
any
```

**Members:**

- `limit`

### `SessionHistoryEntry`

```typescript
any
```

**Members:**

- `sessionId`
- `name`
- `started`
- `ended`
- `tasksCompleted`
- `duration`

### `SessionHistoryResult`

```typescript
any
```

### `SessionStartParams`

```typescript
any
```

**Members:**

- `scope`
- `name`
- `autoStart`
- `startTask`

### `SessionStartResult`

```typescript
any
```

### `SessionEndParams`

```typescript
any
```

**Members:**

- `notes`

### `SessionEndResult`

```typescript
any
```

**Members:**

- `session`
- `summary`

### `SessionResumeParams`

```typescript
any
```

**Members:**

- `sessionId`

### `SessionResumeResult`

```typescript
any
```

### `SessionSuspendParams`

```typescript
any
```

**Members:**

- `notes`

### `SessionSuspendResult`

```typescript
any
```

**Members:**

- `sessionId`
- `suspended`

### `SessionGcParams`

```typescript
any
```

**Members:**

- `olderThan`

### `SessionGcResult`

```typescript
any
```

**Members:**

- `cleaned`
- `sessionIds`

### `SkillCategory`

Common skill types

```typescript
any
```

### `SkillStatus`

```typescript
any
```

### `DispatchStrategy`

```typescript
any
```

### `SkillSummary`

```typescript
any
```

**Members:**

- `name`
- `version`
- `description`
- `category`
- `core`
- `tier`
- `status`
- `protocol`

### `SkillDetail`

```typescript
any
```

**Members:**

- `path`
- `references`
- `dependencies`
- `sharedResources`
- `compatibility`
- `license`
- `metadata`
- `capabilities`
- `constraints`

### `DispatchCandidate`

```typescript
any
```

**Members:**

- `skill`
- `score`
- `strategy`
- `reason`

### `DependencyNode`

```typescript
any
```

**Members:**

- `name`
- `version`
- `direct`
- `depth`

### `ValidationIssue`

```typescript
any
```

**Members:**

- `level`
- `field`
- `message`

### `SkillsListParams`

```typescript
any
```

**Members:**

- `category`
- `core`
- `filter`

### `SkillsListResult`

```typescript
any
```

### `SkillsShowParams`

```typescript
any
```

**Members:**

- `name`

### `SkillsShowResult`

```typescript
any
```

### `SkillsFindParams`

```typescript
any
```

**Members:**

- `query`
- `limit`

### `SkillsFindResult`

```typescript
any
```

**Members:**

- `query`
- `results`

### `SkillsDispatchParams`

```typescript
any
```

**Members:**

- `taskId`
- `taskType`
- `labels`
- `title`
- `description`

### `SkillsDispatchResult`

```typescript
any
```

**Members:**

- `selectedSkill`
- `reason`
- `strategy`
- `candidates`

### `SkillsVerifyParams`

```typescript
any
```

**Members:**

- `name`

### `SkillsVerifyResult`

```typescript
any
```

**Members:**

- `valid`
- `total`
- `passed`
- `failed`
- `results`

### `SkillsDependenciesParams`

```typescript
any
```

**Members:**

- `name`
- `transitive`

### `SkillsDependenciesResult`

```typescript
any
```

**Members:**

- `name`
- `dependencies`
- `resolved`

### `SkillsInstallParams`

```typescript
any
```

**Members:**

- `name`
- `source`

### `SkillsInstallResult`

```typescript
any
```

**Members:**

- `name`
- `installed`
- `version`
- `path`

### `SkillsUninstallParams`

```typescript
any
```

**Members:**

- `name`
- `force`

### `SkillsUninstallResult`

```typescript
any
```

**Members:**

- `name`
- `uninstalled`

### `SkillsEnableParams`

```typescript
any
```

**Members:**

- `name`

### `SkillsEnableResult`

```typescript
any
```

**Members:**

- `name`
- `enabled`
- `status`

### `SkillsDisableParams`

```typescript
any
```

**Members:**

- `name`
- `reason`

### `SkillsDisableResult`

```typescript
any
```

**Members:**

- `name`
- `disabled`
- `status`

### `SkillsConfigureParams`

```typescript
any
```

**Members:**

- `name`
- `config`

### `SkillsConfigureResult`

```typescript
any
```

**Members:**

- `name`
- `configured`
- `config`

### `SkillsRefreshParams`

```typescript
any
```

**Members:**

- `force`

### `SkillsRefreshResult`

```typescript
any
```

**Members:**

- `refreshed`
- `skillCount`
- `timestamp`

### `HealthCheck`

Common system types

```typescript
any
```

**Members:**

- `component`
- `healthy`
- `message`

### `ProjectStats`

```typescript
any
```

**Members:**

- `tasks`
- `sessions`
- `research`

### `SystemVersionParams`

```typescript
any
```

### `SystemVersionResult`

```typescript
any
```

**Members:**

- `version`
- `schemaVersion`
- `buildDate`

### `SystemDoctorParams`

```typescript
any
```

### `SystemDoctorResult`

```typescript
any
```

**Members:**

- `healthy`
- `checks`
- `warnings`
- `errors`

### `SystemConfigGetParams`

```typescript
any
```

**Members:**

- `key`

### `SystemConfigGetResult`

```typescript
any
```

**Members:**

- `key`
- `value`
- `type`

### `SystemStatsParams`

```typescript
any
```

### `SystemStatsResult`

```typescript
any
```

### `SystemContextParams`

```typescript
any
```

### `SystemContextResult`

```typescript
any
```

**Members:**

- `currentTokens`
- `maxTokens`
- `percentUsed`
- `level`
- `estimatedFiles`
- `largestFile`

### `SystemInitParams`

```typescript
any
```

**Members:**

- `projectType`
- `detect`

### `SystemInitResult`

```typescript
any
```

**Members:**

- `initialized`
- `projectType`
- `filesCreated`
- `detectedFeatures`

### `SystemConfigSetParams`

```typescript
any
```

**Members:**

- `key`
- `value`

### `SystemConfigSetResult`

```typescript
any
```

**Members:**

- `key`
- `value`
- `previousValue`

### `SystemBackupParams`

```typescript
any
```

**Members:**

- `type`
- `note`

### `SystemBackupResult`

```typescript
any
```

**Members:**

- `backupId`
- `type`
- `timestamp`
- `files`
- `size`

### `SystemRestoreParams`

```typescript
any
```

**Members:**

- `backupId`

### `SystemRestoreResult`

```typescript
any
```

**Members:**

- `backupId`
- `restored`
- `filesRestored`

### `SystemMigrateParams`

```typescript
any
```

**Members:**

- `version`
- `dryRun`

### `SystemMigrateResult`

```typescript
any
```

**Members:**

- `fromVersion`
- `toVersion`
- `migrations`
- `dryRun`

### `SystemSyncParams`

```typescript
any
```

**Members:**

- `direction`

### `SystemSyncResult`

```typescript
any
```

**Members:**

- `direction`
- `synced`
- `tasksSynced`
- `conflicts`

### `SystemCleanupParams`

```typescript
any
```

**Members:**

- `type`
- `olderThan`

### `SystemCleanupResult`

```typescript
any
```

**Members:**

- `type`
- `cleaned`
- `freed`
- `items`

### `TaskPriority`

```typescript
any
```

### `TaskOp`

```typescript
any
```

**Members:**

- `id`
- `title`
- `description`
- `status`
- `priority`
- `parent`
- `depends`
- `labels`
- `created`
- `updated`
- `completed`
- `notes`

### `MinimalTask`

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `parent`

### `TasksGetParams`

```typescript
any
```

**Members:**

- `taskId`

### `TasksGetResult`

```typescript
any
```

### `TasksListParams`

```typescript
any
```

**Members:**

- `parent`
- `status`
- `priority`
- `type`
- `phase`
- `label`
- `children`
- `limit`
- `offset`
- `compact`

### `TasksListResult`

```typescript
any
```

**Members:**

- `tasks`
- `total`
- `filtered`

### `TasksFindParams`

```typescript
any
```

**Members:**

- `query`
- `limit`

### `TasksFindResult`

```typescript
any
```

### `TasksExistsParams`

```typescript
any
```

**Members:**

- `taskId`

### `TasksExistsResult`

```typescript
any
```

**Members:**

- `exists`
- `taskId`

### `TasksTreeParams`

```typescript
any
```

**Members:**

- `rootId`
- `depth`

### `TaskTreeNode`

```typescript
any
```

**Members:**

- `task`
- `children`
- `depth`

### `TasksTreeResult`

```typescript
any
```

### `TasksBlockersParams`

```typescript
any
```

**Members:**

- `taskId`

### `Blocker`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `status`
- `blockType`

### `TasksBlockersResult`

```typescript
any
```

### `TasksDepsParams`

```typescript
any
```

**Members:**

- `taskId`
- `direction`

### `TaskDependencyNode`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `status`
- `distance`

### `TasksDepsResult`

```typescript
any
```

**Members:**

- `taskId`
- `upstream`
- `downstream`

### `TasksAnalyzeParams`

```typescript
any
```

**Members:**

- `epicId`

### `TriageRecommendation`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `priority`
- `reason`
- `readiness`

### `TasksAnalyzeResult`

```typescript
any
```

### `TasksNextParams`

```typescript
any
```

**Members:**

- `epicId`
- `count`

### `SuggestedTask`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `score`
- `rationale`

### `TasksNextResult`

```typescript
any
```

### `TasksCreateParams`

```typescript
any
```

**Members:**

- `title`
- `description`
- `parent`
- `depends`
- `priority`
- `labels`

### `TasksCreateResult`

```typescript
any
```

### `TasksUpdateParams`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `description`
- `status`
- `priority`
- `notes`
- `parent`
- `labels`
- `addLabels`
- `removeLabels`
- `depends`
- `addDepends`
- `removeDepends`
- `type`
- `size`

### `TasksUpdateResult`

```typescript
any
```

### `TasksCompleteParams`

```typescript
any
```

**Members:**

- `taskId`
- `notes`
- `archive`

### `TasksCompleteResult`

```typescript
any
```

**Members:**

- `taskId`
- `completed`
- `archived`

### `TasksDeleteParams`

```typescript
any
```

**Members:**

- `taskId`
- `force`

### `TasksDeleteResult`

```typescript
any
```

**Members:**

- `taskId`
- `deleted`

### `TasksArchiveParams`

```typescript
any
```

**Members:**

- `taskId`
- `before`

### `TasksArchiveResult`

```typescript
any
```

**Members:**

- `archived`
- `taskIds`

### `TasksUnarchiveParams`

```typescript
any
```

**Members:**

- `taskId`

### `TasksUnarchiveResult`

```typescript
any
```

### `TasksReparentParams`

```typescript
any
```

**Members:**

- `taskId`
- `newParent`

### `TasksReparentResult`

```typescript
any
```

### `TasksPromoteParams`

```typescript
any
```

**Members:**

- `taskId`

### `TasksPromoteResult`

```typescript
any
```

### `TasksReorderParams`

```typescript
any
```

**Members:**

- `taskId`
- `position`

### `TasksReorderResult`

```typescript
any
```

**Members:**

- `taskId`
- `newPosition`

### `TasksReopenParams`

```typescript
any
```

**Members:**

- `taskId`

### `TasksReopenResult`

```typescript
any
```

### `TasksStartParams`

```typescript
any
```

**Members:**

- `taskId`

### `TasksStartResult`

```typescript
any
```

**Members:**

- `taskId`
- `sessionId`
- `timestamp`

### `TasksStopParams`

```typescript
any
```

### `TasksStopResult`

```typescript
any
```

**Members:**

- `stopped`
- `previousTask`

### `TasksCurrentParams`

```typescript
any
```

### `TasksCurrentResult`

```typescript
any
```

**Members:**

- `taskId`
- `since`
- `sessionId`

### `ValidationSeverity`

Common validation types

```typescript
any
```

### `ValidationViolation`

```typescript
any
```

**Members:**

- `rule`
- `severity`
- `message`
- `field`
- `value`
- `expected`
- `line`

### `ComplianceMetrics`

```typescript
any
```

**Members:**

- `total`
- `passed`
- `failed`
- `score`
- `byProtocol`
- `bySeverity`

### `ValidateSchemaParams`

```typescript
any
```

**Members:**

- `fileType`
- `filePath`

### `ValidateSchemaResult`

```typescript
any
```

**Members:**

- `valid`
- `schemaVersion`
- `violations`

### `ValidateProtocolParams`

```typescript
any
```

**Members:**

- `taskId`
- `protocolType`

### `ValidateProtocolResult`

```typescript
any
```

**Members:**

- `taskId`
- `protocol`
- `passed`
- `score`
- `violations`
- `requirements`

### `ValidateTaskParams`

```typescript
any
```

**Members:**

- `taskId`
- `checkMode`

### `ValidateTaskResult`

```typescript
any
```

**Members:**

- `taskId`
- `valid`
- `violations`
- `checks`

### `ValidateManifestParams`

```typescript
any
```

**Members:**

- `entry`
- `taskId`

### `ValidateManifestResult`

```typescript
any
```

**Members:**

- `valid`
- `entry`
- `violations`

### `ValidateOutputParams`

```typescript
any
```

**Members:**

- `taskId`
- `filePath`

### `ValidateOutputResult`

```typescript
any
```

**Members:**

- `taskId`
- `filePath`
- `valid`
- `checks`
- `violations`

### `ValidateComplianceSummaryParams`

```typescript
any
```

**Members:**

- `scope`
- `since`

### `ValidateComplianceSummaryResult`

```typescript
any
```

### `ValidateComplianceViolationsParams`

```typescript
any
```

**Members:**

- `severity`
- `protocol`

### `ValidateComplianceViolationsResult`

```typescript
any
```

**Members:**

- `violations`
- `total`

### `ValidateTestStatusParams`

```typescript
any
```

**Members:**

- `taskId`

### `ValidateTestStatusResult`

```typescript
any
```

**Members:**

- `total`
- `passed`
- `failed`
- `skipped`
- `passRate`
- `byTask`

### `ValidateTestCoverageParams`

```typescript
any
```

**Members:**

- `taskId`

### `ValidateTestCoverageResult`

```typescript
any
```

**Members:**

- `lineCoverage`
- `branchCoverage`
- `functionCoverage`
- `statementCoverage`
- `threshold`
- `meetsThreshold`

### `ValidateComplianceRecordParams`

```typescript
any
```

**Members:**

- `taskId`
- `result`

### `ValidateComplianceRecordResult`

```typescript
any
```

**Members:**

- `taskId`
- `recorded`
- `metrics`

### `ValidateTestRunParams`

```typescript
any
```

**Members:**

- `scope`
- `pattern`
- `parallel`

### `ValidateTestRunResult`

```typescript
any
```

**Members:**

- `status`
- `coverage`
- `duration`
- `output`

### `TaskRecordRelation`

A single task relation entry (string-widened version).

```typescript
any
```

**Members:**

- `taskId`
- `type`
- `reason`

### `ValidationHistoryEntry`

Validation history entry.

```typescript
any
```

**Members:**

- `round`
- `agent`
- `result`
- `timestamp`

### `TaskRecord`

String-widened Task for JSON serialization in dispatch/LAFS layer.

```typescript
any
```

**Members:**

- `id`
- `title`
- `description`
- `status`
- `priority`
- `type`
- `phase`
- `createdAt`
- `updatedAt`
- `completedAt`
- `cancelledAt`
- `parentId`
- `position`
- `positionVersion`
- `depends`
- `relates`
- `files`
- `acceptance`
- `notes`
- `labels`
- `size`
- `epicLifecycle`
- `noAutoComplete`
- `verification`
- `origin`
- `createdBy`
- `validatedBy`
- `testedBy`
- `lifecycleState`
- `validationHistory`
- `blockedBy`
- `cancellationReason`

### `MinimalTaskRecord`

Minimal task representation for find results.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `priority`
- `parentId`

### `TaskSummary`

Task summary counts used in dashboard and stats views.

```typescript
any
```

**Members:**

- `pending`
- `active`
- `blocked`
- `done`
- `cancelled`
- `total`
- `archived`
- `grandTotal`

### `LabelCount`

Label frequency entry.

```typescript
any
```

**Members:**

- `label`
- `count`

### `DashboardResult`

Dashboard result from system.dash query.

```typescript
any
```

**Members:**

- `project`
- `currentPhase`
- `summary`
- `taskWork`
- `activeSession`
- `highPriority`
- `blockedTasks`
- `recentCompletions`
- `topLabels`

### `StatsCurrentState`

Current state counts used in stats results.

```typescript
any
```

**Members:**

- `pending`
- `active`
- `done`
- `blocked`
- `cancelled`
- `totalActive`
- `archived`
- `grandTotal`

### `StatsCompletionMetrics`

Completion metrics for a given time period.

```typescript
any
```

**Members:**

- `periodDays`
- `completedInPeriod`
- `createdInPeriod`
- `completionRate`

### `StatsActivityMetrics`

Activity metrics for a given time period.

```typescript
any
```

**Members:**

- `createdInPeriod`
- `completedInPeriod`
- `archivedInPeriod`

### `StatsAllTime`

All-time cumulative statistics.

```typescript
any
```

**Members:**

- `totalCreated`
- `totalCompleted`
- `totalCancelled`
- `totalArchived`
- `archivedCompleted`

### `StatsCycleTimes`

Cycle time statistics.

```typescript
any
```

**Members:**

- `averageDays`
- `samples`

### `StatsResult`

Stats result from system.stats query.

```typescript
any
```

**Members:**

- `currentState`
- `byPriority`
- `byType`
- `byPhase`
- `completionMetrics`
- `activityMetrics`
- `allTime`
- `cycleTimes`

### `LogQueryResult`

Log query result from system.log query.

```typescript
any
```

**Members:**

- `entries`
- `pagination`

### `ContextResult`

Context monitoring data from system.context query.

```typescript
any
```

**Members:**

- `available`
- `status`
- `percentage`
- `currentTokens`
- `maxTokens`
- `timestamp`
- `stale`
- `sessions`

### `SequenceResult`

Sequence counter data from system.sequence query.

```typescript
any
```

**Members:**

- `counter`
- `lastId`
- `checksum`
- `nextId`

### `TaskRef`

Compact task reference used across analysis and dependency results.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`

### `TaskRefPriority`

Task reference with optional priority (used in orchestrator/HITL contexts).

```typescript
any
```

### `LeveragedTask`

Task with leverage score for prioritization.

```typescript
any
```

**Members:**

- `id`
- `title`
- `leverage`
- `reason`

### `BottleneckTask`

Bottleneck task — blocks other tasks.

```typescript
any
```

**Members:**

- `id`
- `title`
- `blocksCount`

### `TaskAnalysisResult`

Task analysis result from tasks.analyze.

```typescript
any
```

**Members:**

- `recommended`
- `bottlenecks`
- `tiers`
- `metrics`

### `TaskDepsResult`

Single task dependency result from tasks.deps.

```typescript
any
```

**Members:**

- `taskId`
- `dependsOn`
- `dependedOnBy`
- `unresolvedDeps`
- `allDepsReady`

### `CompleteTaskUnblocked`

Completion result — unblocked tasks after completing a task.

```typescript
any
```

**Members:**

- `unblockedTasks`

### `Provider`

Provider identifier for spawn operations.

```typescript
any
```

### `CAAMPSpawnOptions`

CAAMP-compatible spawn options (inlined for zero-dep contracts).

```typescript
any
```

### `CAAMPSpawnResult`

CAAMP-compatible spawn result (inlined for zero-dep contracts).

```typescript
any
```

**Members:**

- `instanceId`
- `output`
- `exitCode`

### `CLEOSpawnContext`

CLEO-specific spawn context Extends CAAMP options with CLEO task and protocol metadata

```typescript
any
```

**Members:**

- `taskId` — Task ID being spawned
- `protocol` — Protocol to use for the spawned task
- `prompt` — Fully-resolved prompt to send to subagent
- `provider` — Provider to use for spawning
- `options` — CAAMP-compatible spawn options
- `workingDirectory` — Project root or working directory for provider-specific files and process execution
- `tokenResolution` — Token resolution information for the prompt

### `CLEOSpawnResult`

CLEO spawn result Extends CAAMP SpawnResult with CLEO-specific timing and metadata

```typescript
any
```

**Members:**

- `taskId` — Task ID that was spawned
- `providerId` — Provider ID used for the spawn
- `timing` — Timing information for the spawn operation
- `manifestEntryId` — Reference to manifest entry if output was captured

### `CLEOSpawnAdapter`

Spawn adapter interface Wraps CAAMP SpawnAdapter with CLEO-specific context and result types

```typescript
any
```

**Members:**

- `id` — Unique identifier for this adapter instance
- `providerId` — Provider ID this adapter uses
- `canSpawn` — Check if this adapter can spawn in the current environment
- `spawn` — Execute a spawn using the provider's native mechanism
- `listRunning` — List currently running spawns
- `terminate` — Terminate a running spawn

### `TokenResolution`

Token resolution information for prompt processing

```typescript
any
```

**Members:**

- `resolved` — Array of resolved token identifiers
- `unresolved` — Array of unresolved token identifiers
- `totalTokens` — Total number of tokens processed

### `SpawnStatus`

Spawn status values

```typescript
any
```

### `ProtocolType`

All supported protocol types.

```typescript
any
```

### `GateName`

Verification gate names (ordered dependency chain).

```typescript
any
```

### `WarpStage`

A single stage in the warp chain.  The category union includes all canonical CLEO pipeline stages plus 'custom' for user-defined stages.

```typescript
any
```

**Members:**

- `id`
- `name`
- `category`
- `skippable`
- `description`

### `WarpLink`

Connection between two stages in the chain.

```typescript
any
```

**Members:**

- `from`
- `to`
- `type`
- `condition`

### `ChainShape`

The topology/DAG of a workflow.

```typescript
any
```

**Members:**

- `stages`
- `links`
- `entryPoint`
- `exitPoints`

### `GateCheck`

Discriminated union for gate check types.

```typescript
any
```

### `GateContract`

A quality gate embedded in the chain.

```typescript
any
```

**Members:**

- `id`
- `name`
- `type`
- `stageId`
- `position`
- `check`
- `severity`
- `canForce`

### `WarpChain`

Complete chain definition combining shape and gates.

```typescript
any
```

**Members:**

- `id`
- `name`
- `version`
- `description`
- `shape`
- `gates`
- `tessera`
- `metadata`

### `ChainValidation`

Result of validating a chain definition.

```typescript
any
```

**Members:**

- `wellFormed`
- `gateSatisfiable`
- `artifactComplete`
- `errors`
- `warnings`

### `WarpChainInstance`

A chain bound to a specific epic.

```typescript
any
```

**Members:**

- `id`
- `chainId`
- `epicId`
- `variables`
- `stageToTask`
- `status`
- `currentStage`
- `createdAt`
- `createdBy`

### `GateResult`

Result of evaluating a single gate.

```typescript
any
```

**Members:**

- `gateId`
- `passed`
- `forced`
- `message`
- `evaluatedAt`

### `WarpChainExecution`

Runtime state of a chain instance execution.

```typescript
any
```

**Members:**

- `instanceId`
- `currentStage`
- `gateResults`
- `status`
- `startedAt`
- `completedAt`

### `TesseraVariable`

A variable declaration within a Tessera template.

```typescript
any
```

**Members:**

- `name`
- `type`
- `description`
- `required`
- `default`

### `TesseraTemplate`

A parameterized WarpChain template with variable bindings.

```typescript
any
```

**Members:**

- `variables`
- `archetypes`
- `defaultValues`
- `category`

### `TesseraInstantiationInput`

Input for instantiating a Tessera template into a concrete chain.

```typescript
any
```

**Members:**

- `templateId`
- `epicId`
- `variables`

### `TodoWriteItemStatus`

TodoWrite item status as exported by Claude.

```typescript
any
```

### `TodoWriteItem`

TodoWrite item as exported by Claude.

```typescript
any
```

**Members:**

- `content`
- `status`
- `activeForm`

### `TodoWriteState`

TodoWrite state file format.

```typescript
any
```

**Members:**

- `todos`

### `TodoWriteSyncSessionState`

Sync session state for TodoWrite integration.

```typescript
any
```

**Members:**

- `injected_tasks`
- `injectedPhase`
- `task_metadata`

### `TodoWriteChangeSet`

Detected changes from TodoWrite state analysis.

```typescript
any
```

**Members:**

- `completed`
- `progressed`
- `newTasks`
- `removed`

### `TodoWriteChangeAction`

Action type for a TodoWrite merge change.

```typescript
any
```

### `TodoWriteChange`

A single change applied during TodoWrite merge.

```typescript
any
```

**Members:**

- `taskId`
- `action`
- `details`

### `TodoWriteMergeResult`

Result of a TodoWrite merge operation.

```typescript
any
```

**Members:**

- `dryRun`
- `changes`
- `sessionCleared`

### `PruneResult`

```typescript
any
```

**Members:**

- `rowsArchived`
- `rowsDeleted`
- `archivePath`

### `AuditEntry`

Audit entry interface. Used by session-grade and system-engine for behavioral analysis.

```typescript
any
```

**Members:**

- `timestamp`
- `sessionId`
- `domain`
- `operation`
- `params`
- `result`
- `metadata`
- `error`

### `SchemaInstallResult`

```typescript
any
```

**Members:**

- `installed`
- `updated`
- `total`

### `StalenessReport`

```typescript
any
```

**Members:**

- `stale`
- `current`
- `missing`

### `InstalledSchema`

```typescript
any
```

**Members:**

- `name`
- `path`
- `version`

### `CheckResult`

```typescript
any
```

**Members:**

- `ok`
- `installed`
- `bundled`
- `missing`
- `stale`

### `JsonFileIntegrityResult`

Result for a single file check.

```typescript
any
```

**Members:**

- `label`
- `status`
- `errors`
- `dataVersion` — Version found in the data file.
- `expectedVersion` — Version declared in the schema file.

### `SchemaIntegrityReport`

Full integrity report for all JSON files.

```typescript
any
```

**Members:**

- `files`
- `sqliteVersion` — SQLite schema_meta.schemaVersion — null if DB not accessible.
- `allOk`

### `ProjectType`

Detected project type.

```typescript
any
```

### `TestFramework`

Test framework.

```typescript
any
```

### `FileNamingConvention`

```typescript
any
```

### `ImportStyle`

```typescript
any
```

### `ProjectContext`

Schema-compliant project context for LLM agent consumption.

```typescript
any
```

**Members:**

- `schemaVersion`
- `detectedAt`
- `projectTypes`
- `primaryType`
- `monorepo`
- `testing`
- `build`
- `directories`
- `conventions`
- `llmHints`

### `BrainFtsRow`

Row returned by FTS content_hash duplicate check.

```typescript
any
```

**Members:**

- `id`
- `type`
- `created_at`

### `BrainNarrativeRow`

Row returned by narrative backfill query (missing embeddings).

```typescript
any
```

**Members:**

- `id`
- `narrative`
- `title`

### `BrainSearchHit`

Flattened FTS hit used in hybrid search scoring.

```typescript
any
```

**Members:**

- `id`
- `type`
- `title`
- `text`

### `BrainKnnRow`

Row returned by KNN vector similarity query.

```typescript
any
```

**Members:**

- `id`
- `distance`

### `BrainDecisionNode`

Decision node attached to a blocker in causal traces.

```typescript
any
```

**Members:**

- `id`
- `title`
- `rationale`

### `BrainAnchor`

Anchor entry in a timeline result.

```typescript
any
```

**Members:**

- `id`
- `type`
- `data`

### `EmbeddingProvider`

Contract for embedding providers (local models, API services, etc.).

```typescript
any
```

**Members:**

- `embed` — Convert text into a fixed-dimension float vector.
- `dimensions` — Number of dimensions the provider produces. Must match vec0 table.
- `isAvailable` — Whether the provider is ready to produce embeddings.

### `SimilarityResult`

```typescript
any
```

**Members:**

- `id`
- `distance`
- `type`
- `title`
- `text`

### `BrainSearchResult`

Search result with BM25 rank.

```typescript
any
```

**Members:**

- `decisions`
- `patterns`
- `learnings`
- `observations`

### `BrainSearchOptions`

Search options.

```typescript
any
```

**Members:**

- `limit` — Max results per table. Default 10.
- `tables` — Which tables to search. Default: all four.

### `HybridResult`

Result from hybridSearch combining multiple search signals.

```typescript
any
```

**Members:**

- `id`
- `score`
- `type`
- `title`
- `text`
- `sources`

### `HybridSearchOptions`

Options for hybridSearch weighting and limits.

```typescript
any
```

**Members:**

- `ftsWeight`
- `vecWeight`
- `graphWeight`
- `limit`

### `ScaffoldResult`

```typescript
any
```

**Members:**

- `action`
- `path`
- `details`

### `InjectionCheckResult`

```typescript
any
```

**Members:**

- `id`
- `category`
- `status`
- `message`
- `details`
- `fix`

### `ScaffoldResult`

Result of an ensure* scaffolding operation.

```typescript
any
```

**Members:**

- `action`
- `path`
- `details`

### `CheckStatus`

Status of a check* diagnostic.

```typescript
any
```

### `CheckResult`

Result of a check* diagnostic (compatible with doctor/checks.ts CheckResult).

```typescript
any
```

**Members:**

- `id`
- `category`
- `status`
- `message`
- `details`
- `fix`

### `McpEnvMode`

Resolved environment mode for MCP server config.

```typescript
any
```

**Members:**

- `mode`
- `source` — Absolute path to the source directory (dev-ts mode only).
- `channel` — Resolved install channel for npm package invocation.

### `ScaffoldResult`

```typescript
any
```

**Members:**

- `action`
- `path`
- `details`

### `HookCheckResult`

```typescript
any
```

**Members:**

- `hook`
- `installed`
- `current`
- `sourcePath`
- `installedPath`

### `EnsureGitHooksOptions`

```typescript
any
```

**Members:**

- `force`

### `ManagedHook`

```typescript
any
```

### `SessionRecord`

Session object (engine-compatible).

```typescript
any
```

**Members:**

- `id`
- `status`
- `agentId`
- `name`
- `scope`
- `focus`
- `startedAt`
- `lastActivity`
- `suspendedAt`
- `endedAt`
- `archivedAt`
- `resumeCount`
- `gradeMode` — Whether full query+mutation audit logging is enabled (behavioral grading).
- `stats`
- `previousSessionId` — Soft FK to predecessor session.
- `nextSessionId` — Soft FK to successor session.
- `agentIdentifier` — LLM agent/conversation identifier.
- `handoffConsumedAt` — When the successor read this session's handoff/debrief.
- `handoffConsumedBy` — Who consumed the handoff.
- `debriefJson` — Rich debrief data (superset of handoffJson).

### `TaskWorkStateExt`

Task work state from the task store.

```typescript
any
```

**Members:**

- `currentTask`
- `currentPhase`
- `blockedUntil`
- `sessionNote`
- `sessionNotes`
- `nextAction`
- `primarySession`

### `TaskFileExt`

Task file structure (subset for session operations).

```typescript
any
```

**Members:**

- `focus`
- `_meta`
- `tasks`
- `lastUpdated`

### `DecisionRecord`

Decision record stored in decisions.jsonl.

```typescript
any
```

**Members:**

- `id`
- `sessionId`
- `taskId`
- `decision`
- `rationale`
- `alternatives`
- `timestamp`

### `AssumptionRecord`

Assumption record stored in assumptions.jsonl.

```typescript
any
```

**Members:**

- `id`
- `sessionId`
- `taskId`
- `assumption`
- `confidence`
- `validatedAt`
- `timestamp`

### `RecordDecisionParams`

```typescript
any
```

**Members:**

- `sessionId`
- `taskId`
- `decision`
- `rationale`
- `alternatives`

### `DecisionLogParams`

```typescript
any
```

**Members:**

- `sessionId`
- `taskId`

### `HandoffData`

Handoff data schema - structured state for session transition.

```typescript
any
```

**Members:**

- `lastTask` — Last task being worked on
- `tasksCompleted` — Tasks completed in session
- `tasksCreated` — Tasks created in session
- `decisionsRecorded` — Count of decisions recorded
- `nextSuggested` — Top-3 from tasks.next
- `openBlockers` — Tasks with blockers
- `openBugs` — Open bugs
- `note` — Human override note
- `nextAction` — Human override next action

### `ComputeHandoffOptions`

Options for computing handoff data.

```typescript
any
```

**Members:**

- `sessionId`
- `note` — Optional human note override
- `nextAction` — Optional human next action override

### `GitState`

Git state snapshot captured at session end.

```typescript
any
```

**Members:**

- `branch`
- `commitCount`
- `lastCommitHash`
- `uncommittedChanges`

### `DebriefDecision`

Decision summary for debrief output.

```typescript
any
```

**Members:**

- `id`
- `decision`
- `rationale`
- `taskId`

### `DebriefData`

Rich debrief data — superset of HandoffData. Captures comprehensive session state for cross-conversation continuity.   T4959

```typescript
any
```

**Members:**

- `handoff` — Standard handoff data (backward compat).
- `sessionId` — Session that produced this debrief.
- `agentIdentifier` — Agent/conversation identifier (if known).
- `startedAt` — Session start time.
- `endedAt` — Session end time.
- `durationMinutes` — Duration in minutes.
- `decisions` — Decisions made during the session.
- `gitState` — Git state at session end (best-effort).
- `chainPosition` — Position in the session chain (1-based).
- `chainLength` — Total length of the session chain.

### `ComputeDebriefOptions`

Options for computing debrief data.

```typescript
any
```

**Members:**

- `agentIdentifier` — Agent/conversation identifier.
- `startedAt` — Session start time.
- `endedAt` — Session end time.

### `MemoryBridgeConfig`

Configuration for memory bridge content generation.

```typescript
any
```

**Members:**

- `maxObservations`
- `maxLearnings`
- `maxPatterns`
- `maxDecisions`
- `includeHandoff`
- `includeAntiPatterns`

### `LegacyDetectionResult`

Result of detecting legacy agent-output directories.

```typescript
any
```

**Members:**

- `hasLegacy` — Whether any legacy directories were found.
- `hasResearchOutputs` — claudedocs/research-outputs/ exists.
- `hasLegacyAgentOutputs` — claudedocs/agent-outputs/ exists.
- `hasCanonical` — .cleo/agent-outputs/ already exists.
- `legacyPaths` — Human-readable list of found legacy paths.

### `AgentOutputsMigrationResult`

Result of running the agent-outputs migration.

```typescript
any
```

**Members:**

- `migrated` — Whether migration was performed.
- `filesCopied` — Number of files copied to canonical location.
- `manifestEntries` — Number of manifest entries in the merged MANIFEST.jsonl.
- `removed` — Legacy directories that were removed.
- `summary` — Human-readable summary of what happened.

### `NexusPermissionLevel`

```typescript
any
```

### `NexusHealthStatus`

```typescript
any
```

### `NexusProject`

Domain representation of a registered Nexus project.

```typescript
any
```

**Members:**

- `hash`
- `projectId`
- `path`
- `name`
- `registeredAt`
- `lastSeen`
- `healthStatus`
- `healthLastCheck`
- `permissions`
- `lastSync`
- `taskCount`
- `labels`

### `NexusRegistryFile`

Legacy registry file shape (pre-SQLite). Retained for migration compatibility.

```typescript
any
```

**Members:**

- `$schema`
- `schemaVersion`
- `lastUpdated`
- `projects`

### `PatternType`

Pattern types from ADR-009.

```typescript
any
```

### `PatternImpact`

Impact level.

```typescript
any
```

### `StorePatternParams`

Parameters for storing a new pattern.

```typescript
any
```

**Members:**

- `type`
- `pattern`
- `context`
- `impact`
- `antiPattern`
- `mitigation`
- `examples`
- `successRate`

### `SearchPatternParams`

Parameters for searching patterns.

```typescript
any
```

**Members:**

- `type`
- `impact`
- `query`
- `minFrequency`
- `limit`

### `StoreLearningParams`

Parameters for storing a new learning.

```typescript
any
```

**Members:**

- `insight`
- `source`
- `confidence`
- `actionable`
- `application`
- `applicableTypes`

### `SearchLearningParams`

Parameters for searching learnings.

```typescript
any
```

**Members:**

- `query`
- `minConfidence`
- `actionableOnly`
- `applicableType`
- `limit`

### `BrainCompactHit`

Compact search hit — minimal fields for index-level results.

```typescript
any
```

**Members:**

- `id`
- `type`
- `title`
- `date`
- `relevance`

### `SearchBrainCompactParams`

Parameters for searchBrainCompact.

```typescript
any
```

**Members:**

- `query`
- `limit`
- `tables`
- `dateStart`
- `dateEnd`

### `SearchBrainCompactResult`

Result from searchBrainCompact.

```typescript
any
```

**Members:**

- `results`
- `total`
- `tokensEstimated`

### `TimelineBrainParams`

Parameters for timelineBrain.

```typescript
any
```

**Members:**

- `anchor`
- `depthBefore`
- `depthAfter`

### `TimelineNeighbor`

Timeline entry — compact id/type/date tuple.

```typescript
any
```

**Members:**

- `id`
- `type`
- `date`

### `TimelineBrainResult`

Result from timelineBrain.

```typescript
any
```

**Members:**

- `anchor`
- `before`
- `after`

### `FetchBrainEntriesParams`

Parameters for fetchBrainEntries.

```typescript
any
```

**Members:**

- `ids`

### `FetchedBrainEntry`

Fetched entry with full data.

```typescript
any
```

**Members:**

- `id`
- `type`
- `data`

### `FetchBrainEntriesResult`

Result from fetchBrainEntries.

```typescript
any
```

**Members:**

- `results`
- `notFound`
- `tokensEstimated`

### `BrainObservationType`

Observation type from schema.

```typescript
any
```

### `BrainObservationSourceType`

Observation source type from schema.

```typescript
any
```

### `ObserveBrainParams`

Parameters for observeBrain.

```typescript
any
```

**Members:**

- `text`
- `title`
- `type`
- `project`
- `sourceSessionId`
- `sourceType`

### `ObserveBrainResult`

Result from observeBrain.

```typescript
any
```

**Members:**

- `id`
- `type`
- `createdAt`

### `PopulateEmbeddingsResult`

Result from populateEmbeddings backfill.

```typescript
any
```

**Members:**

- `processed`
- `skipped`

### `StackAnalysis`

```typescript
any
```

**Members:**

- `languages`
- `frameworks`
- `dependencies`
- `packageManager`
- `runtime`

### `ArchAnalysis`

```typescript
any
```

**Members:**

- `layers`
- `entryPoints`
- `patterns`

### `StructureAnalysis`

```typescript
any
```

**Members:**

- `directories`
- `totalFiles`
- `totalLines`

### `ConventionAnalysis`

```typescript
any
```

**Members:**

- `fileNaming`
- `importStyle`
- `linter`
- `formatter`
- `typeSystem`
- `errorHandling`

### `TestingAnalysis`

```typescript
any
```

**Members:**

- `framework`
- `patterns`
- `directories`
- `hasFixtures`
- `hasMocks`
- `coverageConfigured`

### `IntegrationAnalysis`

```typescript
any
```

**Members:**

- `apis`
- `databases`
- `auth`
- `cicd`
- `containerized`

### `ConcernAnalysis`

```typescript
any
```

**Members:**

- `todos`
- `largeFiles`
- `complexity`

### `CodebaseMapResult`

```typescript
any
```

**Members:**

- `projectContext`
- `stack`
- `architecture`
- `structure`
- `conventions`
- `testing`
- `integrations`
- `concerns`
- `analyzedAt`

### `MapCodebaseOptions`

```typescript
any
```

**Members:**

- `focus`
- `storeToBrain`

### `AdapterInfo`

Summary info for an adapter without exposing the full instance.

```typescript
any
```

**Members:**

- `id`
- `name`
- `version`
- `provider`
- `healthy`
- `active`

### `InitOptions`

Options for the init operation.

```typescript
any
```

**Members:**

- `name` — Project name override.
- `force` — Overwrite existing files.
- `detect` — Auto-detect project configuration.
- `updateDocs` — Update agent documentation injections only.
- `mapCodebase` — Run codebase analysis and store findings to brain.db.

### `InitResult`

Result of the init operation.

```typescript
any
```

**Members:**

- `initialized`
- `directory`
- `created`
- `skipped`
- `warnings`
- `updateDocsOnly`

### `BootstrapContext`

Result tracking arrays passed through each bootstrap step.

```typescript
any
```

**Members:**

- `created`
- `warnings`
- `isDryRun`

### `BootstrapOptions`

Options for bootstrapGlobalCleo.

```typescript
any
```

**Members:**

- `dryRun` — Preview changes without applying.
- `packageRoot` — Override package root for template/skill discovery.

### `ExportFormat`

```typescript
any
```

### `ExportParams`

```typescript
any
```

**Members:**

- `format`
- `output`
- `status`
- `parent`
- `phase`
- `cwd`

### `ExportResult`

```typescript
any
```

**Members:**

- `format`
- `taskCount`
- `file`
- `content`

### `ImportParams`

```typescript
any
```

**Members:**

- `file`
- `parent`
- `phase`
- `onDuplicate`
- `addLabel`
- `dryRun`
- `cwd`

### `ImportResult`

```typescript
any
```

**Members:**

- `imported`
- `skipped`
- `renamed`
- `totalTasks`
- `dryRun`

### `NexusParsedQuery`

```typescript
any
```

**Members:**

- `project`
- `taskId`
- `wildcard`

### `NexusResolvedTask`

Task with project context annotation.

```typescript
any
```

### `DiscoverResult`

```typescript
any
```

**Members:**

- `project`
- `taskId`
- `title`
- `score`
- `type`
- `reason`

### `NexusDiscoverResult`

```typescript
any
```

**Members:**

- `query`
- `method`
- `results`
- `total`

### `SearchResult`

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `priority`
- `description`
- `_project`

### `NexusSearchResult`

```typescript
any
```

**Members:**

- `pattern`
- `results`
- `resultCount`

### `PermissionCheckResult`

```typescript
any
```

**Members:**

- `project`
- `required`
- `granted`
- `allowed`

### `SharingStatus`

Result of a sharing status check.

```typescript
any
```

**Members:**

- `mode`
- `allowlist`
- `denylist`
- `tracked`
- `ignored`

### `DepNode`

A node in the dependency graph.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `depends`
- `dependents`

### `DepsOverviewResult`

Dependency overview result.

```typescript
any
```

**Members:**

- `nodes`
- `totalTasks`
- `withDependencies`
- `withDependents`
- `roots`
- `leaves`

### `TaskDepsResult`

Single task dependency result.

```typescript
any
```

**Members:**

- `task`
- `upstream`
- `downstream`
- `blockedBy`

### `ExecutionWave`

Execution wave (group of parallelizable tasks).

```typescript
any
```

**Members:**

- `wave`
- `tasks`

### `CriticalPathResult`

Critical path result.

```typescript
any
```

**Members:**

- `path`
- `length`

### `CycleResult`

Cycle detection result.

```typescript
any
```

**Members:**

- `hasCycles`
- `cycles`

### `TreeNode`

Tree node representation.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `type`
- `children`

### `CircularDependency`

A circular dependency cycle found via DFS traversal.

```typescript
any
```

### `MissingDependency`

A missing dependency reference within an epic.

```typescript
any
```

**Members:**

- `taskId`
- `missingDep`

### `DependencyAnalysis`

Full dependency analysis result for an epic.

```typescript
any
```

**Members:**

- `dependencyGraph`
- `circularDependencies`
- `missingDependencies`

### `ContextEstimation`

Context estimation result.

```typescript
any
```

**Members:**

- `epicId`
- `taskCount`
- `manifestEntries`
- `estimatedTokens`
- `recommendation`
- `limits`

### `Wave`

```typescript
any
```

**Members:**

- `waveNumber`
- `tasks`
- `status`

### `EnrichedWave`

```typescript
any
```

**Members:**

- `waveNumber`
- `tasks`
- `status`

### `StatusCounts`

Status counts by task state.

```typescript
any
```

**Members:**

- `pending`
- `active`
- `blocked`
- `done`
- `cancelled`

### `EpicStatus`

Epic-specific status result.

```typescript
any
```

**Members:**

- `epicId`
- `epicTitle`
- `totalTasks`
- `byStatus`
- `waves`
- `currentWave`

### `OverallStatus`

Overall orchestration status (no specific epic).

```typescript
any
```

**Members:**

- `totalEpics`
- `totalTasks`
- `byStatus`

### `ProgressMetrics`

Progress metrics for orchestration check.

```typescript
any
```

**Members:**

- `total`
- `done`
- `pending`
- `blocked`
- `active`
- `percentComplete`

### `StartupSummary`

Startup summary for an epic.

```typescript
any
```

**Members:**

- `epicId`
- `epicTitle`
- `initialized`
- `summary`
- `firstWave`

### `OrchestratorSession`

Orchestrator session state.

```typescript
any
```

**Members:**

- `epicId`
- `startedAt`
- `status`
- `currentWave`
- `completedTasks`
- `spawnedAgents`

### `SpawnContext`

Spawn context for a subagent.

```typescript
any
```

**Members:**

- `taskId`
- `protocol`
- `prompt`
- `tokenResolution`

### `TaskReadiness`

Task readiness assessment.

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `ready`
- `blockers`
- `protocol`

### `AnalysisResult`

Orchestrator analysis result.

```typescript
any
```

**Members:**

- `epicId`
- `totalTasks`
- `waves`
- `readyTasks`
- `blockedTasks`
- `completedTasks`

### `SessionBridgeData`

Session data needed to create a memory bridge observation.

```typescript
any
```

**Members:**

- `sessionId`
- `scope`
- `tasksCompleted`
- `duration`

### `StoreDecisionParams`

Parameters for storing a new decision.

```typescript
any
```

**Members:**

- `type`
- `decision`
- `rationale`
- `confidence`
- `outcome`
- `alternatives`
- `contextEpicId`
- `contextTaskId`
- `contextPhase`

### `SearchDecisionParams`

Parameters for searching decisions.

```typescript
any
```

**Members:**

- `type`
- `confidence`
- `outcome`
- `query`
- `limit`

### `ListDecisionParams`

Parameters for listing decisions.

```typescript
any
```

**Members:**

- `limit`
- `offset`

### `CompleteTaskOptions`

Options for completing a task.

```typescript
any
```

**Members:**

- `taskId`
- `notes`
- `changeset`

### `CompleteTaskResult`

Result of completing a task.

```typescript
any
```

**Members:**

- `task`
- `autoCompleted`
- `unblockedTasks`

### `UpdateTaskOptions`

Options for updating a task.

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `status`
- `priority`
- `type`
- `size`
- `phase`
- `description`
- `labels`
- `addLabels`
- `removeLabels`
- `depends`
- `addDepends`
- `removeDepends`
- `notes`
- `acceptance`
- `files`
- `blockedBy`
- `parentId`
- `noAutoComplete`

### `UpdateTaskResult`

Result of updating a task.

```typescript
any
```

**Members:**

- `task`
- `changes`

### `ArtifactType`

Supported artifact types.

```typescript
any
```

### `ArtifactConfig`

Artifact configuration from release config.

```typescript
any
```

**Members:**

- `type`
- `buildCommand`
- `publishCommand`
- `package`
- `registry`
- `options`

### `ArtifactResult`

Result of an artifact operation.

```typescript
any
```

**Members:**

- `success`
- `output`
- `dryRun`

### `ArtifactHandler`

Artifact handler interface.

```typescript
any
```

**Members:**

- `build`
- `validate`
- `publish`

### `ReleaseConfig`

Release configuration shape.

```typescript
any
```

**Members:**

- `versioningScheme`
- `tagPrefix`
- `changelogFormat`
- `changelogFile`
- `artifactType`
- `gates`
- `versionBump`
- `security`
- `gitflow`
- `channels`
- `push`

### `ReleaseGate`

Release gate definition.

```typescript
any
```

**Members:**

- `name`
- `type`
- `command`
- `required`

### `GitFlowConfig`

GitFlow branch configuration.

```typescript
any
```

**Members:**

- `enabled`
- `branches`

### `ChannelConfig`

Channel-to-branch mapping for npm dist-tag resolution.

```typescript
any
```

**Members:**

- `main`
- `develop`
- `feature`
- `custom`

### `PushMode`

Push mode: direct push vs PR creation vs auto-detect.

```typescript
any
```

### `ReleaseChannel`

npm dist-tag channel for a release.

```typescript
any
```

### `ChannelValidationResult`

Result of validating a version string against a channel's expectations.

```typescript
any
```

**Members:**

- `valid`
- `expected`
- `actual`
- `message`

### `CIPlatform`

Supported CI/CD platforms.

```typescript
any
```

### `BranchProtectionResult`

```typescript
any
```

**Members:**

- `protected`
- `detectionMethod`
- `error`

### `PRCreateOptions`

```typescript
any
```

**Members:**

- `base`
- `head`
- `title`
- `body`
- `labels`
- `version`
- `epicId`
- `projectRoot`

### `PRResult`

```typescript
any
```

**Members:**

- `mode`
- `prUrl`
- `prNumber`
- `instructions`
- `error`

### `RepoIdentity`

```typescript
any
```

**Members:**

- `owner`
- `repo`

### `EpicCompletenessResult`

Epic completeness result.

```typescript
any
```

**Members:**

- `hasIncomplete`
- `epics`
- `orphanTasks`

### `DoubleListingResult`

Double-listing check result.

```typescript
any
```

**Members:**

- `hasDoubleListing`
- `duplicates`

### `BumpType`

Bump type for version calculation.

```typescript
any
```

### `VersionBumpTarget`

Version bump target config from .cleo/config.json.

```typescript
any
```

**Members:**

- `file`
- `strategy`
- `field`
- `key`
- `section`
- `pattern`

### `BumpResult`

Bump result for a single file.

```typescript
any
```

**Members:**

- `file`
- `strategy`
- `success`
- `previousVersion`
- `newVersion`
- `error`

### `ReleaseManifest`

Release manifest structure.

```typescript
any
```

**Members:**

- `version`
- `status`
- `createdAt`
- `preparedAt`
- `committedAt`
- `taggedAt`
- `pushedAt`
- `tasks`
- `notes`
- `changelog`
- `previousVersion`
- `commitSha`
- `gitTag`

### `ReleaseListOptions`

```typescript
any
```

**Members:**

- `status`
- `limit`
- `offset`

### `ReleaseTaskRecord`

Task record shape needed for release operations.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `parentId`
- `completedAt`
- `labels`
- `type` — Structured task type — 'epic' | 'task' | 'subtask'. Used for changelog filtering and categorization.
- `description` — Task description. Used to enrich changelog entries when meaningfully different from the title.

### `ReleaseGateMetadata`

Metadata captured during gate evaluation, returned alongside gate results. Downstream (engine layer) uses this to determine PR vs direct push.

```typescript
any
```

**Members:**

- `channel` — npm dist-tag channel resolved from the current branch.
- `requiresPR` — Whether the target branch requires a PR (branch protection detected or mode='pr').
- `targetBranch` — Branch that should be targeted for this release type.
- `currentBranch` — Branch the repo is currently on.

### `PushPolicy`

Push policy configuration from config.release.push.

```typescript
any
```

**Members:**

- `enabled`
- `remote`
- `requireCleanTree`
- `allowedBranches`
- `mode` — Push mode override: 'direct' | 'pr' | 'auto' (default: 'direct').
- `prBase` — Override PR target branch (default: auto-detected from GitFlow config).

### `DimensionScore`

```typescript
any
```

**Members:**

- `score`
- `max`
- `evidence`

### `GradeResult`

```typescript
any
```

**Members:**

- `sessionId`
- `taskId`
- `totalScore`
- `maxScore`
- `dimensions`
- `flags`
- `timestamp`
- `entryCount`

### `RecordAssumptionParams`

```typescript
any
```

**Members:**

- `sessionId`
- `taskId`
- `assumption`
- `confidence`

### `BulkLinkEntry`

A link to be created in bulk.

```typescript
any
```

**Members:**

- `memoryType`
- `memoryId`
- `taskId`
- `linkType`

### `SessionMemoryResult`

Result of persisting session memory to brain.db.

```typescript
any
```

**Members:**

- `observationsCreated` — Number of observations created
- `linksCreated` — Number of links created
- `observationIds` — IDs of created observations
- `errors` — Whether any errors occurred (best-effort -- errors don't fail the operation)

### `MemoryItem`

A memory item to be persisted to brain.db.

```typescript
any
```

**Members:**

- `text`
- `title`
- `type`
- `sourceSessionId`
- `sourceType`
- `linkTaskId` — Optional task ID to link this observation to

### `SessionMemoryContext`

Memory context returned for session start/resume enrichment.

```typescript
any
```

**Members:**

- `recentDecisions` — Recent decisions relevant to this scope
- `relevantPatterns` — Patterns relevant to this scope
- `recentObservations` — Recent observations from prior sessions
- `recentLearnings` — Recent learnings relevant to this scope
- `tokensEstimated` — Total token estimate for this context

### `BriefingTask`

Task summary for briefing output.

```typescript
any
```

**Members:**

- `id`
- `title`
- `leverage`
- `score`

### `BriefingBug`

Bug summary for briefing output.

```typescript
any
```

**Members:**

- `id`
- `title`
- `priority`

### `BriefingBlockedTask`

Blocked task summary for briefing output.

```typescript
any
```

**Members:**

- `id`
- `title`
- `blockedBy`

### `BriefingEpic`

Active epic summary for briefing output.

```typescript
any
```

**Members:**

- `id`
- `title`
- `completionPercent`

### `PipelineStageInfo`

Pipeline stage data for briefing output.

```typescript
any
```

**Members:**

- `currentStage`
- `stageStatus`

### `LastSessionInfo`

Last session info with handoff data.

```typescript
any
```

**Members:**

- `endedAt`
- `duration`
- `handoff`

### `CurrentTaskInfo`

Currently active task info.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `blockedBy`

### `SessionBriefing`

Session briefing result.

```typescript
any
```

**Members:**

- `lastSession`
- `currentTask`
- `nextTasks`
- `openBugs`
- `blockedTasks`
- `activeEpics`
- `pipelineStage`
- `warnings`
- `memoryContext` — Brain memory context -- decisions/patterns/observations relevant to this scope.

### `BriefingOptions`

Options for computing session briefing.

```typescript
any
```

**Members:**

- `maxNextTasks` — Maximum number of next tasks to include (default: 5)
- `maxBugs` — Maximum number of bugs to include (default: 10)
- `maxBlocked` — Maximum number of blocked tasks to include (default: 10)
- `maxEpics` — Maximum number of active epics to include (default: 5)
- `scope` — Scope filter: 'global' or 'epic:T###'

### `MinimalSessionRecord`

Minimal session record returned by findSessions().

```typescript
any
```

**Members:**

- `id`
- `name`
- `status`
- `startedAt`
- `scope`

### `FindSessionsParams`

Parameters for findSessions().

```typescript
any
```

**Members:**

- `status`
- `scope`
- `query`
- `limit`

### `ContextDriftResult`

```typescript
any
```

**Members:**

- `score`
- `factors`
- `completedInScope`
- `totalInScope`
- `outOfScope`

### `SessionHistoryEntry`

```typescript
any
```

**Members:**

- `id`
- `name`
- `status`
- `startedAt`
- `endedAt`
- `tasksCompleted`
- `focusChanges`
- `focusHistory`

### `SessionHistoryParams`

```typescript
any
```

**Members:**

- `sessionId`
- `limit`

### `SessionStatsResult`

```typescript
any
```

**Members:**

- `totalSessions`
- `activeSessions`
- `suspendedSessions`
- `endedSessions`
- `archivedSessions`
- `totalTasksCompleted`
- `totalFocusChanges`
- `averageResumeCount`
- `session`

### `RuntimeProviderContext`

```typescript
any
```

**Members:**

- `runtimeProviderId`
- `runtimeToolName`
- `runtimeVendor`
- `runtimeInstructionFile`
- `runtimeProjectDetected`
- `runtimeDetectionMethods`
- `runtimeCandidates`
- `inferredModelProvider`

### `RuntimeProviderSnapshot`

```typescript
any
```

**Members:**

- `cwd`
- `argv`
- `env`

### `StartSessionOptions`

Options for starting a session.

```typescript
any
```

**Members:**

- `name`
- `scope`
- `autoStart`
- `startTask`
- `focus`
- `agent`
- `grade` — Enable full query+mutation audit logging for this session (behavioral grading).
- `providerId` — Provider adapter ID active for this session (T5240).

### `EndSessionOptions`

Options for ending a session.

```typescript
any
```

**Members:**

- `sessionId`
- `note`

### `ListSessionsOptions`

Options for listing sessions.

```typescript
any
```

**Members:**

- `status`
- `limit`

### `StickyNoteStatus`

Sticky note status values.

```typescript
any
```

### `StickyNoteColor`

Sticky note color options.

```typescript
any
```

### `StickyNotePriority`

Sticky note priority levels.

```typescript
any
```

### `ConvertedTargetType`

Converted target type.

```typescript
any
```

### `ConvertedTarget`

Converted target reference.

```typescript
any
```

**Members:**

- `type`
- `id`

### `StickyNote`

Core sticky note interface.

```typescript
any
```

**Members:**

- `id` — Unique ID (SN-001, SN-002...)
- `content` — Raw note text
- `createdAt` — ISO 8601 creation timestamp
- `updatedAt` — ISO 8601 last update timestamp
- `tags` — Array of tags
- `status` — Current status
- `convertedTo` — Conversion target if converted
- `color` — Visual color
- `priority` — Priority level
- `sourceType` — Source type for BRAIN queries

### `CreateStickyParams`

Parameters for creating a sticky note.

```typescript
any
```

**Members:**

- `content`
- `tags`
- `color`
- `priority`

### `ListStickiesParams`

Parameters for listing sticky notes.

```typescript
any
```

**Members:**

- `status`
- `color`
- `priority`
- `limit`

### `ConvertStickyParams`

Parameters for converting a sticky note.

```typescript
any
```

**Members:**

- `targetType`
- `title` — Optional title when converting to task
- `memoryType` — Optional memory type when converting to memory
- `taskId` — Optional taskId when converting to task note

### `ArchiveTasksOptions`

Options for archiving tasks.

```typescript
any
```

**Members:**

- `before` — Only archive tasks completed before this date (ISO string).
- `taskIds` — Specific task IDs to archive.
- `includeCancelled` — Archive cancelled tasks too. Default: true.
- `dryRun` — Dry run mode.

### `ArchiveTasksResult`

Result of archiving tasks.

```typescript
any
```

**Members:**

- `archived`
- `skipped`
- `total`
- `dryRun`

### `DeleteTaskOptions`

Options for deleting a task.

```typescript
any
```

**Members:**

- `taskId`
- `force`
- `cascade`

### `DeleteTaskResult`

Result of deleting a task.

```typescript
any
```

**Members:**

- `deletedTask`
- `cascadeDeleted`

### `TasksAPI`

```typescript
any
```

**Members:**

- `add`
- `find`
- `show`
- `list`
- `update`
- `complete`
- `delete`
- `archive`

### `SessionsAPI`

```typescript
any
```

**Members:**

- `start`
- `end`
- `status`
- `resume`
- `list`
- `find`
- `show`
- `suspend`
- `briefing`
- `handoff`
- `gc`
- `recordDecision`
- `recordAssumption`
- `contextDrift`
- `decisionLog`
- `lastHandoff`

### `MemoryAPI`

```typescript
any
```

**Members:**

- `observe`
- `find`
- `fetch`
- `timeline`
- `search`
- `hybridSearch`

### `OrchestrationAPI`

```typescript
any
```

**Members:**

- `start`
- `analyze`
- `readyTasks`
- `nextTask`
- `context`
- `dependencyGraph`
- `epicStatus`
- `progress`

### `LifecycleAPI`

```typescript
any
```

**Members:**

- `status`
- `startStage`
- `completeStage`
- `skipStage`
- `checkGate`
- `history`
- `resetStage`
- `passGate`
- `failGate`
- `stages`

### `ReleaseAPI`

```typescript
any
```

**Members:**

- `prepare`
- `commit`
- `tag`
- `push`
- `rollback`
- `calculateVersion`
- `bumpVersion`

### `AdminAPI`

```typescript
any
```

**Members:**

- `export`
- `import`

### `StickyAPI`

```typescript
any
```

**Members:**

- `add`
- `show`
- `list`
- `archive`
- `purge`
- `convert`

### `NexusAPI`

```typescript
any
```

**Members:**

- `init`
- `register`
- `unregister`
- `list`
- `show`
- `sync`
- `discover`
- `search`
- `setPermission`
- `sharingStatus`

### `SyncAPI`

```typescript
any
```

**Members:**

- `reconcile`
- `readState`
- `writeState`
- `clearState`

### `CleoInitOptions`

```typescript
any
```

**Members:**

- `store`
- `caamp`

### `EngineResult`

Canonical EngineResult type used by all engines and core engine-compat modules.

```typescript
any
```

**Members:**

- `success`
- `data`
- `page`
- `error`

### `ExportMeta`

Export package metadata.

```typescript
any
```

**Members:**

- `format`
- `version`
- `exportedAt`
- `source`
- `checksum`
- `taskCount`
- `exportMode`

### `ExportSelection`

Export selection criteria.

```typescript
any
```

**Members:**

- `mode`
- `rootTaskIds`
- `includeChildren`
- `filters`

### `IdMapEntry`

ID map entry.

```typescript
any
```

**Members:**

- `type`
- `title`
- `status`
- `parentId`
- `depends`

### `RelationshipGraph`

Relationship graph.

```typescript
any
```

**Members:**

- `hierarchy`
- `dependencies`
- `roots`

### `ExportPackage`

Complete export package.

```typescript
any
```

**Members:**

- `$schema`
- `_meta`
- `selection`
- `idMap`
- `tasks`
- `relationshipGraph`

### `ExportTasksParams`

```typescript
any
```

**Members:**

- `taskIds`
- `output`
- `subtree`
- `filter`
- `includeDeps`
- `dryRun`
- `cwd`

### `ExportTasksResult`

```typescript
any
```

**Members:**

- `exportMode`
- `taskCount`
- `taskIds`
- `outputPath`
- `content`
- `dryRun`

### `HelpOperationDef`

Minimal operation definition consumed by help logic.

```typescript
any
```

**Members:**

- `gateway`
- `domain`
- `operation`
- `description`
- `tier`

### `CostHint`

Cost hint classification for an operation.

```typescript
any
```

### `GroupedOperations`

Domain-grouped operation format (compact).

```typescript
any
```

### `VerboseOperation`

Verbose operation entry with cost hints.

```typescript
any
```

**Members:**

- `gateway`
- `domain`
- `operation`
- `description`
- `costHint`

### `HelpResult`

Result of the help computation.

```typescript
any
```

**Members:**

- `tier`
- `operationCount`
- `quickStart`
- `operations`
- `guidance`
- `escalation`

### `RemapTable`

Forward and reverse remap tables.

```typescript
any
```

**Members:**

- `forward`
- `reverse`

### `ImportTasksParams`

```typescript
any
```

**Members:**

- `file`
- `dryRun`
- `parent`
- `phase`
- `addLabel`
- `provenance`
- `resetStatus`
- `onConflict`
- `onMissingDep`
- `force`
- `cwd`

### `ImportTasksResult`

```typescript
any
```

**Members:**

- `imported`
- `skipped`
- `idRemap`
- `dryRun`
- `preview`

### `ValidationError`

```typescript
any
```

**Members:**

- `file`
- `field`
- `message`

### `ValidationResult`

```typescript
any
```

**Members:**

- `valid`
- `errors`
- `checked`

### `AdrValidationError`

ValidationError — canonical name per ADR-017 spec

```typescript
any
```

### `AdrValidationResult`

ValidationResult — canonical name per ADR-017 spec

```typescript
any
```

### `ComplianceJsonlEntry`

```typescript
any
```

### `BuildConfig`

```typescript
any
```

### `RepositoryConfig`

```typescript
any
```

### `IssueTemplate`

Parsed issue template.

```typescript
any
```

**Members:**

- `name`
- `description`
- `title`
- `labels`
- `subcommand`
- `fileName`

### `AddIssueParams`

```typescript
any
```

**Members:**

- `issueType`
- `title`
- `body`
- `severity`
- `area`
- `dryRun`

### `AddIssueResult`

```typescript
any
```

**Members:**

- `type`
- `url`
- `number`
- `title`
- `labels`
- `body`
- `repo`
- `dryRun`

### `DecayResult`

Result from applying temporal decay.

```typescript
any
```

**Members:**

- `updated`
- `tablesProcessed`

### `ConsolidationResult`

Result from consolidating memories.

```typescript
any
```

**Members:**

- `grouped`
- `merged`
- `archived`

### `BrainMigrationResult`

Result from a migration run.

```typescript
any
```

**Members:**

- `patternsImported`
- `learningsImported`
- `duplicatesSkipped`
- `errors`

### `ResearchEntry`

Research entry attached to a task.

```typescript
any
```

**Members:**

- `id`
- `taskId`
- `topic`
- `findings`
- `sources`
- `status`
- `createdAt`
- `updatedAt`

### `ManifestEntry`

Manifest entry (JSONL line).

```typescript
any
```

**Members:**

- `id`
- `file`
- `title`
- `date`
- `status`
- `agent_type`
- `topics`
- `key_findings`
- `actionable`
- `needs_followup`
- `linked_tasks`

### `AddResearchOptions`

Options for adding research.

```typescript
any
```

**Members:**

- `taskId`
- `topic`
- `findings`
- `sources`

### `ListResearchOptions`

Options for listing research.

```typescript
any
```

**Members:**

- `taskId`
- `status`

### `ManifestQueryOptions`

Manifest query options.

```typescript
any
```

**Members:**

- `status`
- `agentType`
- `topic`
- `taskId`
- `limit`

### `ExtendedManifestEntry`

Extended manifest entry with optional fields used by the engine.

```typescript
any
```

**Members:**

- `confidence`
- `file_checksum`
- `duration_seconds`

### `ResearchFilter`

Research filter criteria used by the engine.

```typescript
any
```

**Members:**

- `taskId`
- `status`
- `agent_type`
- `topic`
- `limit`
- `offset`
- `actionable`
- `dateAfter`
- `dateBefore`

### `ContradictionDetail`

Contradiction detail between two manifest entries.

```typescript
any
```

**Members:**

- `entryA`
- `entryB`
- `topic`
- `conflictDetails`

### `SupersededDetail`

Superseded entry detail.

```typescript
any
```

**Members:**

- `old`
- `replacement`
- `topic`

### `ComplianceSummary`

Compliance summary shape.

```typescript
any
```

**Members:**

- `total`
- `pass`
- `fail`
- `rate`

### `OtelCaptureMode`

OTel capture mode.

```typescript
any
```

### `OtelTokenDataPoint`

Token data point parsed from OTel metrics.

```typescript
any
```

**Members:**

- `timestamp`
- `type`
- `model`
- `tokens`

### `AggregatedTokens`

Aggregated token counts.

```typescript
any
```

**Members:**

- `session_id`
- `tokens`
- `api_requests`
- `source`

### `ABVariant`

A/B test variant.

```typescript
any
```

### `ABEventType`

A/B test event types.

```typescript
any
```

### `ABTestSummary`

A/B test summary result.

```typescript
any
```

**Members:**

- `test_name`
- `variant`
- `start_time`
- `end_time`
- `duration_seconds`
- `tokens_consumed`
- `token_source`
- `tasks_completed`
- `validations`
- `notes`

### `Severity`

Violation severity levels.

```typescript
typeof Severity
```

**Members:**

- `Low`
- `Medium`
- `High`
- `Critical`

### `ManifestIntegrity`

Manifest integrity states.

```typescript
typeof ManifestIntegrity
```

**Members:**

- `Valid`
- `Partial`
- `Invalid`
- `Missing`

### `InstructionStability`

Instruction stability levels.

```typescript
typeof InstructionStability
```

**Members:**

- `Stable`
- `Clarified`
- `Revised`
- `Unstable`

### `SessionDegradation`

Session degradation levels.

```typescript
typeof SessionDegradation
```

**Members:**

- `None`
- `Mild`
- `Moderate`
- `Severe`

### `AgentReliability`

Agent reliability levels.

```typescript
typeof AgentReliability
```

**Members:**

- `High`
- `Medium`
- `Low`
- `Unreliable`

### `MetricCategory`

Metric categories.

```typescript
typeof MetricCategory
```

**Members:**

- `Compliance`
- `Efficiency`
- `Session`
- `Improvement`

### `MetricSource`

Metric sources.

```typescript
typeof MetricSource
```

**Members:**

- `Task`
- `Session`
- `Agent`
- `System`
- `Orchestrator`

### `AggregationPeriod`

Aggregation periods.

```typescript
typeof AggregationPeriod
```

**Members:**

- `Instant`
- `Hourly`
- `Daily`
- `Weekly`
- `Monthly`

### `TokenEventType`

Token event types.

```typescript
any
```

### `TokenEvent`

A token usage event entry.

```typescript
any
```

**Members:**

- `timestamp`
- `event_type`
- `estimated_tokens`
- `source`
- `task_id`
- `session_id`
- `context`

### `TokenSessionSummary`

Token session summary shape.

```typescript
any
```

**Members:**

- `session_id`
- `start`
- `end`
- `tokens`
- `savings`

### `VerificationResult`

Result of a backup verification operation.

```typescript
any
```

**Members:**

- `valid` — Whether the backup is valid
- `error` — Error message if verification failed
- `sourceChecksum` — SHA-256 checksum of the source file
- `backupChecksum` — SHA-256 checksum of the backup file

### `LogLevel`

Log entry severity level

```typescript
any
```

### `MigrationLogEntry`

Single migration log entry

```typescript
any
```

**Members:**

- `timestamp` — ISO 8601 timestamp
- `level` — Log level
- `phase` — Migration phase (init, backup, import, verify, complete, etc.)
- `operation` — Specific operation within phase
- `message` — Human-readable message
- `durationMs` — Duration since migration start in milliseconds
- `data` — Additional structured data

### `MigrationLoggerConfig`

Migration logger configuration

```typescript
any
```

**Members:**

- `maxLogFiles` — Maximum number of log files to retain
- `minLevel` — Minimum log level to record
- `consoleOutput` — Enable console output in addition to file logging

### `PreflightResult`

Pre-flight check result.

```typescript
any
```

**Members:**

- `migrationNeeded` — Whether a storage migration is needed.
- `currentEngine` — Current detected storage engine. Always 'sqlite' or 'none'.
- `summary` — Human-readable summary of what was detected.
- `fix` — Actionable fix command.
- `details` — Detailed diagnostics.

### `MigrationPhase`

Migration phase - tracks current step in the migration process

```typescript
any
```

### `SourceFileInfo`

Source file info with checksum for integrity verification

```typescript
any
```

**Members:**

- `path`
- `checksum`
- `taskCount`
- `sessionCount`
- `archivedCount`

### `MigrationProgress`

Migration progress tracking

```typescript
any
```

**Members:**

- `tasksImported`
- `archivedImported`
- `sessionsImported`
- `totalTasks`
- `totalArchived`
- `totalSessions`

### `MigrationState`

Complete migration state structure

```typescript
any
```

**Members:**

- `version`
- `startedAt`
- `phase`
- `sourceFiles`
- `backupPath`
- `tempPath`
- `progress`
- `errors`
- `warnings`
- `completedAt`

### `JsonFileValidation`

Result of validating a single JSON file.

```typescript
any
```

**Members:**

- `valid`
- `exists`
- `count`
- `error`
- `line`
- `column`

### `JsonValidationResult`

Complete validation result for all source files.

```typescript
any
```

**Members:**

- `valid`
- `todoJson`
- `sessionsJson`
- `archiveJson`
- `totalTasks`
- `warnings`

### `SchemaVersion`

Schema version info.

```typescript
any
```

**Members:**

- `current`
- `target`
- `needsMigration`

### `MigrationFn`

Migration function signature.

```typescript
any
```

### `MigrationDef`

Migration definition.

```typescript
any
```

**Members:**

- `fromVersion`
- `toVersion`
- `description`
- `migrate`

### `MigrationResult`

Migration run result.

```typescript
any
```

**Members:**

- `file`
- `fromVersion`
- `toVersion`
- `migrationsApplied`
- `success`
- `errors`
- `dryRun`

### `MigrationStatus`

Status of all data files.

```typescript
any
```

**Members:**

- `todoJson`
- `configJson`
- `archiveJson`

### `NexusGraphNode`

```typescript
any
```

**Members:**

- `id`
- `project`
- `status`
- `title`

### `NexusGraphEdge`

```typescript
any
```

**Members:**

- `from`
- `fromProject`
- `to`
- `toProject`

### `NexusGlobalGraph`

```typescript
any
```

**Members:**

- `nodes`
- `edges`

### `DepsResult`

Result of a dependency query.

```typescript
any
```

**Members:**

- `task`
- `project`
- `depends`
- `blocking`

### `DepsEntry`

Single dependency entry with resolution status.

```typescript
any
```

**Members:**

- `query`
- `project`
- `status`
- `title`

### `CriticalPathResult`

Critical path result.

```typescript
any
```

**Members:**

- `criticalPath`
- `length`
- `blockedBy`

### `BlockingAnalysisResult`

Blocking analysis result.

```typescript
any
```

**Members:**

- `task`
- `blocking`
- `impactScore`

### `OrphanEntry`

Orphan detection result.

```typescript
any
```

**Members:**

- `sourceProject`
- `sourceTask`
- `targetProject`
- `targetTask`
- `reason`

### `PinoLevel`

Pino log levels as written by CLEO's logger (uppercase).

```typescript
any
```

### `PinoLogEntry`

A parsed pino log entry from a CLEO log file. Core fields are always present; additional fields are captured in `extra`.

```typescript
any
```

**Members:**

- `level` — Uppercase log level
- `time` — ISO 8601 UTC timestamp
- `pid` — Process ID
- `hostname` — Machine hostname
- `msg` — Human-readable log message
- `subsystem` — Logical subsystem name (from child logger)
- `code` — CLEO error code (on warn/error entries)
- `exitCode` — Numeric exit code (on warn/error entries)
- `extra` — Any additional fields not in the core schema

### `LogFileInfo`

Metadata about a discovered log file.

```typescript
any
```

**Members:**

- `path` — Absolute path to the log file
- `name` — File name (e.g., 'cleo.2026-02-28.1.log')
- `size` — File size in bytes
- `mtime` — Last modification time (ISO string)
- `date` — Parsed date from filename, or null if unparseable
- `isActive` — Whether this is the currently active (latest) log file

### `LogFilter`

Filter criteria for log queries. All fields are optional; when multiple are provided, they are ANDed.

```typescript
any
```

**Members:**

- `minLevel` — Minimum log level (inclusive). E.g., 'WARN' returns WARN + ERROR + FATAL
- `level` — Exact log level match
- `since` — Start time (inclusive, ISO 8601)
- `until` — End time (inclusive, ISO 8601)
- `subsystem` — Filter by subsystem name (exact match)
- `code` — Filter by CLEO error code (exact match)
- `exitCode` — Filter by exit code (exact match)
- `msgContains` — Text search in msg field (case-insensitive substring)
- `pid` — Filter by PID
- `limit` — Maximum entries to return
- `offset` — Number of entries to skip (for pagination)

### `LogQueryResult`

Result of a log query operation.

```typescript
any
```

**Members:**

- `entries` — Matched entries
- `totalScanned` — Total entries scanned (before limit/offset)
- `totalMatched` — Total entries matching filters (before limit/offset)
- `files` — Files that were read

### `LogDiscoveryOptions`

Options for discovering log files.

```typescript
any
```

**Members:**

- `scope` — Which log directory to scan: 'project', 'global', or 'both' (default: 'project')
- `since` — Only include files modified after this date (ISO 8601)
- `includeMigration` — Include migration log files (default: false)

### `LogSummary`

Summary of log activity across files.

```typescript
any
```

**Members:**

- `totalEntries`
- `byLevel`
- `bySubsystem`
- `dateRange`
- `files`

### `RemoteConfig`

Remote configuration.

```typescript
any
```

**Members:**

- `name`
- `url`

### `PushResult`

Result of a push operation.

```typescript
any
```

**Members:**

- `success`
- `branch`
- `remote`
- `message`

### `PullResult`

Result of a pull operation.

```typescript
any
```

**Members:**

- `success`
- `branch`
- `remote`
- `message`
- `hasConflicts`
- `conflictFiles`

### `RemoteInfo`

Result of a remote list operation.

```typescript
any
```

**Members:**

- `name`
- `fetchUrl`
- `pushUrl`

### `ExecutionMode`

Execution mode for an operation

```typescript
any
```

### `GatewayType`

Gateway type

```typescript
any
```

### `PreferredChannel`

Preferred communication channel for token efficiency. Added for provider-agnostic skill routing (task T5240).

```typescript
any
```

### `OperationCapability`

```typescript
any
```

**Members:**

- `domain`
- `operation`
- `gateway`
- `mode`
- `preferredChannel`

### `CapabilityReport`

Capability report returned by system.doctor

```typescript
any
```

**Members:**

- `totalOperations`
- `native`
- `cli`
- `hybrid`
- `domains`

### `RateLimitConfig`

Rate limiter configuration

```typescript
any
```

**Members:**

- `maxRequests`
- `windowMs`

### `RateLimitResult`

Rate limit check result

```typescript
any
```

**Members:**

- `allowed`
- `remaining`
- `resetMs`
- `limit`

### `AgentClass`

Functional classification of an agent.

```typescript
any
```

### `PrivacyTier`

Visibility tier controlling agent discoverability.

```typescript
any
```

### `AgentStatus`

Current online status of an agent.

```typescript
any
```

### `MessageStatus`

Delivery status of a message.

```typescript
any
```

### `ContentType`

Content type for message payloads.

```typescript
any
```

### `ConversationVisibility`

Visibility setting for a conversation.

```typescript
any
```

### `Agent`

A registered agent.

```typescript
any
```

**Members:**

- `id`
- `name`
- `agentClass`
- `privacyTier`
- `status`
- `createdAt`
- `updatedAt`

### `NewAgent`

Payload for registering a new agent.

```typescript
any
```

**Members:**

- `name`
- `agentClass`
- `privacyTier`

### `Message`

A message exchanged between two agents.

```typescript
any
```

**Members:**

- `id`
- `conversationId`
- `fromAgentId`
- `toAgentId`
- `content`
- `contentType`
- `status`
- `createdAt`
- `deliveredAt`
- `readAt`

### `NewMessage`

Payload for creating a new message.

```typescript
any
```

**Members:**

- `conversationId`
- `fromAgentId`
- `toAgentId`
- `content`
- `contentType`

### `Conversation`

A conversation between agents.

```typescript
any
```

**Members:**

- `id`
- `participants`
- `visibility`
- `messageCount`
- `lastMessageAt`
- `createdAt`
- `updatedAt`

### `NewConversation`

Payload for creating a new conversation.

```typescript
any
```

**Members:**

- `participants`
- `visibility`

### `ApiResponse`

Standard API response envelope.

```typescript
any
```

**Members:**

- `success`
- `data`
- `error`
- `meta`

### `AgentRegistration`

Result of agent registration.

```typescript
any
```

**Members:**

- `agentId`
- `name`
- `agentClass`
- `privacyTier`

### `MessageResult`

Result of sending a message.

```typescript
any
```

**Members:**

- `messageId`
- `conversationId`
- `status`

### `AgentTransport`

Provider-neutral interface for inter-agent communication.  Implementations: - SignalDockTransport: HTTP client for SignalDock REST API (provider-neutral) - ClaudeCodeTransport: Wrapper around Claude Code SDK SendMessage (provider-specific)

```typescript
any
```

**Members:**

- `name` — Transport name for logging and diagnostics.
- `register` — Register an agent with the transport layer.
- `deregister` — Deregister an agent from the transport layer.
- `send` — Send a message to another agent.
- `poll` — Poll for new messages addressed to this agent.
- `heartbeat` — Send a heartbeat to keep the agent connection alive.
- `createConversation` — Create a conversation between agents.
- `getAgent` — Get agent info by ID.

### `SignalDockTransportConfig`

Configuration for SignalDockTransport.

```typescript
any
```

**Members:**

- `endpoint` — Base URL of the SignalDock API server.
- `agentPrefix` — Prefix for agent names (e.g., "cleo-" - "cleo-orchestrator").
- `privacyTier` — Default privacy tier for registered agents.

### `TransportFactoryConfig`

Configuration for transport selection.

```typescript
any
```

**Members:**

- `enabled`
- `mode`
- `endpoint`
- `agentPrefix`
- `privacyTier`

### `SkillFrontmatter`

Skill frontmatter parsed from SKILL.md YAML header.

```typescript
any
```

**Members:**

- `name`
- `description`
- `version`
- `author`
- `tags`
- `triggers`
- `dispatchPriority`
- `model`
- `allowedTools`
- `invocable`
- `command`
- `protocol`

### `Skill`

Skill definition loaded from disk.

```typescript
any
```

**Members:**

- `name`
- `dirName`
- `path`
- `skillMdPath`
- `frontmatter`
- `content`

### `SkillSummary`

Lightweight skill summary for manifest/listing.

```typescript
any
```

**Members:**

- `name`
- `dirName`
- `description`
- `tags`
- `version`
- `invocable`
- `command`
- `protocol`

### `SkillManifest`

Skill manifest (cached aggregate of all discovered skills).

```typescript
any
```

**Members:**

- `_meta`
- `skills`

### `SkillProtocolType`

RCASD-IVTR+C protocol types.

```typescript
any
```

### `AgentConfig`

Agent configuration from AGENT.md or agent definition.

```typescript
any
```

**Members:**

- `name`
- `description`
- `model`
- `allowedTools`
- `customInstructions`

### `AgentRegistryEntry`

Agent registry entry.

```typescript
any
```

**Members:**

- `name`
- `path`
- `config`
- `installedAt`

### `AgentRegistry`

Agent registry (persisted).

```typescript
any
```

**Members:**

- `_meta`
- `agents`

### `SkillSearchScope`

CAAMP search order for skill discovery.

```typescript
any
```

### `SkillSearchPath`

Ordered search path entry.

```typescript
any
```

**Members:**

- `scope`
- `path`
- `priority`

### `DispatchStrategy`

Dispatch strategy for skill selection.

```typescript
any
```

### `DispatchResult`

Dispatch result from skill_auto_dispatch.

```typescript
any
```

**Members:**

- `skill`
- `strategy`
- `confidence`
- `protocol`

### `TokenDefinition`

Token definition from placeholders.json.

```typescript
any
```

**Members:**

- `token`
- `description`
- `required`
- `default`
- `pattern`

### `TokenValidationResult`

Token validation result.

```typescript
any
```

**Members:**

- `valid`
- `token`
- `value`
- `error`

### `TokenContext`

Token injection context.

```typescript
any
```

**Members:**

- `taskId`
- `date`
- `topicSlug`
- `epicId`
- `sessionId`
- `outputDir`
- `manifestPath`

### `OrchestratorThresholds`

Orchestrator context thresholds.

```typescript
any
```

**Members:**

- `warning`
- `critical`

### `PreSpawnCheckResult`

Pre-spawn check result.

```typescript
any
```

**Members:**

- `canSpawn`
- `spawnStatus`
- `recommendation`
- `context`
- `reasons`
- `taskValidation`
- `complianceValidation`

### `SpawnPromptResult`

Spawn prompt result.

```typescript
any
```

**Members:**

- `taskId`
- `template`
- `topicSlug`
- `date`
- `outputDir`
- `outputFile`
- `prompt`

### `DependencyWave`

Dependency wave for parallel execution.

```typescript
any
```

**Members:**

- `wave`
- `tasks`

### `DependencyAnalysis`

Dependency analysis result.

```typescript
any
```

**Members:**

- `epicId`
- `totalTasks`
- `completedTasks`
- `pendingTasks`
- `activeTasks`
- `waves`
- `readyToSpawn`
- `blockedTasks`

### `HitlSummary`

HITL summary for session handoff.

```typescript
any
```

**Members:**

- `timestamp`
- `stopReason`
- `session`
- `progress`
- `completedTasks`
- `remainingTasks`
- `readyToSpawn`
- `handoff`

### `ManifestEntry`

Research manifest entry (MANIFEST.jsonl).

```typescript
any
```

**Members:**

- `id`
- `file`
- `title`
- `date`
- `status`
- `agent_type`
- `topics`
- `key_findings`
- `actionable`
- `needs_followup`
- `linked_tasks`
- `audit`

### `ManifestValidationResult`

Manifest validation result.

```typescript
any
```

**Members:**

- `exists`
- `passed`
- `stats`
- `issues`

### `ComplianceResult`

Compliance verification result.

```typescript
any
```

**Members:**

- `previousTaskId`
- `researchId`
- `checks`
- `canSpawnNext`
- `violations`
- `warnings`

### `InstalledSkill`

Installed skill tracking.

```typescript
any
```

**Members:**

- `name`
- `version`
- `installedAt`
- `sourcePath`
- `symlinkPath`

### `InstalledSkillsFile`

Installed skills file.

```typescript
any
```

**Members:**

- `_meta`
- `skills`

### `TokenValues`

Token values map: TOKEN_NAME - value.

```typescript
any
```

### `MultiSkillComposition`

Result of multi-skill composition.

```typescript
any
```

**Members:**

- `skillCount`
- `primarySkill`
- `skills`
- `totalEstimatedTokens`
- `prompt`

### `ContributionDecision`

A contribution decision from an agent.

```typescript
any
```

**Members:**

- `agentId`
- `taskId`
- `decision`
- `confidence`
- `rationale`

### `ContributionConflict`

Conflict between two agent decisions.

```typescript
any
```

**Members:**

- `field`
- `agent1`
- `agent2`
- `value1`
- `value2`
- `severity`

### `ConsensusResult`

Consensus result from weighted voting.

```typescript
any
```

**Members:**

- `decision`
- `confidence`
- `votes`
- `conflicts`

### `SkillsMpConfig`

SkillsMP configuration.

```typescript
any
```

**Members:**

- `enabled`
- `cacheDir`

### `MarketplaceSkill`

Marketplace skill result (CLEO-specific shape).

```typescript
any
```

**Members:**

- `id`
- `name`
- `description`
- `version`
- `author`
- `tags`
- `downloadUrl`

### `BatchSpawnEntry`

Result of a single spawn within a batch.

```typescript
any
```

**Members:**

- `taskId`
- `success`
- `result`
- `error`

### `BatchSpawnResult`

Result of a batch spawn operation.

```typescript
any
```

**Members:**

- `count`
- `succeeded`
- `failed`
- `spawns`

### `SessionInitResult`

Session init result.

```typescript
any
```

**Members:**

- `activeSessions`
- `activeSessionId`
- `activeScope`
- `hasFocus`
- `focusedTask`
- `hasPending`
- `recommendedAction`
- `actionReason`

### `PauseStatus`

Pause status result.

```typescript
any
```

**Members:**

- `pauseStatus`
- `pauseCode`
- `shouldPause`
- `shouldWrapUp`
- `contextPercentage`
- `recommendation`

### `SkillSourceType`

Source type classification for a skill directory.

```typescript
any
```

### `SkillSourceMode`

Skill source mode.

```typescript
any
```

### `SkillSearchPath`

Search path entry with its origin.

```typescript
any
```

**Members:**

- `path`
- `origin`

### `IssueSeverity`

Validation issue severity.

```typescript
any
```

### `ValidationIssue`

Single validation issue.

```typescript
any
```

**Members:**

- `severity`
- `code`
- `message`
- `path`

### `SkillValidationResult`

Validation result for a skill.

```typescript
any
```

**Members:**

- `valid`
- `skillName`
- `skillPath`
- `issues`
- `errorCount`
- `warningCount`

### `SnapshotMeta`

Snapshot metadata.

```typescript
any
```

**Members:**

- `format`
- `version`
- `createdAt`
- `source`
- `checksum`
- `taskCount`

### `SnapshotTask`

Portable task representation (subset of Task, omitting local-only fields).

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `priority`
- `type`
- `parentId`
- `size`
- `phase`
- `description`
- `depends`
- `labels`
- `createdAt`
- `updatedAt`
- `completedAt`

### `Snapshot`

Complete snapshot package.

```typescript
any
```

**Members:**

- `$schema`
- `_meta`
- `project`
- `tasks`

### `ImportResult`

Import result summary.

```typescript
any
```

**Members:**

- `added`
- `updated`
- `skipped`
- `conflicts`

### `SpawnCapability`

Spawn capability type - subset of provider capabilities related to spawning

```typescript
any
```

### `ArchiveMetadata`

Archive metadata that may be attached to archived task records.

```typescript
any
```

**Members:**

- `archivedAt`
- `cycleTimeDays`
- `archiveSource`

### `AnalyticsTask`

Archived task shape used internally for analytics.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `priority`
- `phase`
- `labels`
- `archive`

### `ArchiveReportType`

```typescript
any
```

### `SummaryReportData`

Summary report result.

```typescript
any
```

**Members:**

- `totalArchived`
- `byStatus`
- `byPriority`
- `averageCycleTime`
- `oldestArchived`
- `newestArchived`
- `archiveSourceBreakdown`

### `PhaseGroupEntry`

Phase group entry.

```typescript
any
```

**Members:**

- `phase`
- `count`
- `avgCycleTime`

### `LabelFrequencyEntry`

Label frequency entry.

```typescript
any
```

**Members:**

- `label`
- `count`

### `PriorityGroupEntry`

Priority group entry.

```typescript
any
```

**Members:**

- `priority`
- `count`
- `avgCycleTime`

### `CycleTimeDistribution`

Cycle time distribution buckets.

```typescript
any
```

**Members:**

- `'0-1 days'`
- `'2-7 days'`
- `'8-30 days'`
- `'30+ days'`

### `CycleTimePercentiles`

Cycle time percentiles.

```typescript
any
```

**Members:**

- `p25`
- `p50`
- `p75`
- `p90`

### `CycleTimesReportData`

Cycle times report result.

```typescript
any
```

**Members:**

- `count`
- `min`
- `max`
- `avg`
- `median`
- `distribution`
- `percentiles`

### `DailyArchiveEntry`

Daily archive entry.

```typescript
any
```

**Members:**

- `date`
- `count`

### `MonthlyArchiveEntry`

Monthly archive entry.

```typescript
any
```

**Members:**

- `month`
- `count`

### `TrendsReportData`

Trends report result.

```typescript
any
```

**Members:**

- `byDay`
- `byMonth`
- `totalPeriod`
- `averagePerDay`

### `EmptyArchiveData`

Empty archive sentinel (when totalArchived is 0).

```typescript
any
```

**Members:**

- `totalArchived`
- `message`

### `ArchiveReportDataMap`

Union type mapping report types to their data shapes.

```typescript
any
```

### `ArchiveAnalyticsResult`

The envelope returned by analyzeArchive.

```typescript
any
```

**Members:**

- `report`
- `filters`
- `data`

### `AnalyzeArchiveOptions`

Options for analyzeArchive.

```typescript
any
```

**Members:**

- `report`
- `since`
- `until`
- `cwd`

### `ArchiveStatsResult`

```typescript
any
```

**Members:**

- `totalArchived`
- `byReason`
- `averageCycleTimeDays`
- `archiveRate`
- `lastArchived`

### `AuditIssue`

```typescript
any
```

**Members:**

- `severity`
- `category`
- `message`
- `fix`

### `AuditResult`

```typescript
any
```

**Members:**

- `scope`
- `issues`
- `summary`

### `BackupResult`

```typescript
any
```

**Members:**

- `backupId`
- `path`
- `timestamp`
- `type`
- `files`

### `RestoreResult`

```typescript
any
```

**Members:**

- `restored`
- `backupId`
- `timestamp`
- `filesRestored`

### `CleanupResult`

```typescript
any
```

**Members:**

- `target`
- `deleted`
- `items`
- `dryRun`
- `prunedRows`
- `archivedRows`
- `archivePath`

### `Platform`

Detected platform.

```typescript
any
```

### `SystemInfo`

Structured snapshot of the host system for diagnostics, error reports, and logging.

```typescript
any
```

**Members:**

- `platform` — OS platform (linux, darwin, win32, etc.)
- `arch` — CPU architecture (x64, arm64, etc.)
- `osType` — OS type (Linux, Darwin, Windows_NT, etc.)
- `osRelease` — OS kernel release version
- `nodeVersion` — Node.js version (without 'v' prefix)
- `totalMemory` — Total system memory in bytes
- `freeMemory` — Free system memory in bytes
- `hostname` — Machine hostname (useful for multi-machine correlation)
- `homeDir` — User home directory path

### `CheckStatus`

```typescript
any
```

### `CheckResult`

```typescript
any
```

**Members:**

- `id`
- `category`
- `status`
- `message`
- `details`
- `fix`

### `HealthCheck`

```typescript
any
```

**Members:**

- `name`
- `status`
- `message`

### `HealthResult`

```typescript
any
```

**Members:**

- `overall`
- `checks`
- `version`
- `installation`

### `DiagnosticsCheck`

```typescript
any
```

**Members:**

- `name`
- `status`
- `details`
- `fix`

### `DiagnosticsResult`

```typescript
any
```

**Members:**

- `timestamp`
- `checks`
- `summary`

### `DoctorCheck`

```typescript
any
```

**Members:**

- `check`
- `status`
- `message`
- `details`
- `fix`

### `DoctorReport`

```typescript
any
```

**Members:**

- `healthy`
- `errors`
- `warnings`
- `checks`

### `FixResult`

```typescript
any
```

**Members:**

- `check`
- `action`
- `message`

### `StartupState`

Outcome of a startup health check. Tells the caller exactly what state the system is in so it can route to init, upgrade, or proceed normally.

```typescript
any
```

### `StartupHealthCheck`

```typescript
any
```

**Members:**

- `check`
- `status`
- `message`
- `repaired`

### `StartupHealthResult`

```typescript
any
```

**Members:**

- `state` — Overall system state after health check + auto-repair.
- `globalHealthy` — True if the global ~/.cleo scaffold is healthy (after auto-repair).
- `projectHealthy` — True if the project .cleo/ scaffold is present and healthy.
- `checks` — Individual check results for logging/diagnostics.
- `failures` — Checks that failed and could not be auto-repaired.
- `system` — Host system snapshot for diagnostics, error reports, and logging.

### `InjectGenerateResult`

```typescript
any
```

**Members:**

- `injection`
- `sizeBytes`
- `version`

### `LabelsResult`

```typescript
any
```

**Members:**

- `labels`
- `totalLabels`
- `totalTagged`
- `totalUntagged`

### `SystemMetricsResult`

```typescript
any
```

**Members:**

- `tokens`
- `compliance`
- `sessions`

### `MigrateResult`

```typescript
any
```

**Members:**

- `from`
- `to`
- `migrations`
- `dryRun`

### `RuntimeDiagnostics`

```typescript
any
```

**Members:**

- `channel`
- `mode`
- `source`
- `version`
- `installed`
- `dataRoot`
- `invocation`
- `naming`
- `node`
- `platform`
- `arch`
- `binaries`
- `package`
- `warnings`

### `SafestopResult`

```typescript
any
```

**Members:**

- `stopped`
- `reason`
- `sessionEnded`
- `handoff`
- `dryRun`

### `UncancelResult`

```typescript
any
```

**Members:**

- `taskId`
- `uncancelled`
- `previousStatus`
- `newStatus`
- `cascadeCount`
- `dryRun`

### `DependencyCheckResult`

Result of a dependency validation check.

```typescript
any
```

**Members:**

- `valid`
- `errors`
- `warnings`

### `DependencyError`

A dependency error.

```typescript
any
```

**Members:**

- `code`
- `taskId`
- `message`
- `relatedIds`

### `DependencyWarning`

A dependency warning.

```typescript
any
```

**Members:**

- `code`
- `taskId`
- `message`

### `TodoWriteItem`

```typescript
any
```

**Members:**

- `content`
- `status`
- `activeForm`

### `TodoWriteState`

```typescript
any
```

**Members:**

- `todos`

### `SyncSessionState`

```typescript
any
```

**Members:**

- `injected_tasks`
- `injectedPhase`
- `task_metadata`

### `ChangeSet`

```typescript
any
```

**Members:**

- `completed`
- `progressed`
- `newTasks`
- `removed`

### `TodoWriteMergeOptions`

```typescript
any
```

**Members:**

- `file` — Path to the TodoWrite JSON state file.
- `dryRun` — Show changes without modifying tasks.
- `defaultPhase` — Default phase for newly created tasks.
- `cwd` — Working directory (project root).
- `accessor` — Optional DataAccessor override.

### `TodoWriteMergeResult`

```typescript
any
```

**Members:**

- `dryRun`
- `changes`
- `sessionCleared`

### `TaskCurrentResult`

Result of getting current task.

```typescript
any
```

**Members:**

- `currentTask`
- `currentPhase`
- `sessionNote`
- `nextAction`

### `TaskStartResult`

Result of starting work on a task.

```typescript
any
```

**Members:**

- `taskId`
- `taskTitle`
- `previousTask`

### `TaskWorkHistoryEntry`

Task work history entry.

```typescript
any
```

**Members:**

- `taskId`
- `timestamp`

### `TemplateSection`

A single section/field within an issue template.

```typescript
any
```

**Members:**

- `id`
- `type`
- `label`
- `required`
- `options`
- `placeholder`

### `IssueTemplate`

A parsed issue template.

```typescript
any
```

**Members:**

- `filename`
- `subcommand`
- `name`
- `titlePrefix`
- `labels`
- `sections`

### `TemplateConfig`

The full template config output.

```typescript
any
```

**Members:**

- `templates`
- `generatedAt`
- `sourceDir`

### `TemplateResult`

Result type for template parser operations.

```typescript
any
```

**Members:**

- `success`
- `data`
- `error`

### `ShellType`

Supported shell types.

```typescript
any
```

### `ChangelogSection`

Grouped changelog sections.

```typescript
any
```

**Members:**

- `title`
- `entries`

### `CommandMeta`

Parsed command metadata.

```typescript
any
```

**Members:**

- `command`
- `category`
- `synopsis`
- `aliases`
- `relevance`
- `flags`
- `exits`
- `jsonOutput`
- `jsonDefault`
- `subcommands`
- `note`
- `aliasFor`
- `scriptName`

### `ParsedFlags`

Parsed flag state.

```typescript
any
```

**Members:**

- `format`
- `quiet`
- `dryRun`
- `verbose`
- `help`
- `force`
- `remaining`

### `ManifestIntegrity`

```typescript
any
```

### `Severity`

```typescript
any
```

### `ComplianceMetrics`

```typescript
any
```

**Members:**

- `timestamp`
- `category`
- `source`
- `sourceId`
- `period`
- `compliance`
- `tags`
- `context`

### `ManifestEntry`

```typescript
any
```

**Members:**

- `id`
- `research_id`
- `title`
- `status`
- `key_findings`
- `findings_summary`
- `linked_tasks`
- `task_ids`
- `agent_type`

### `TokenMetrics`

```typescript
any
```

**Members:**

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `maxTokens`
- `percentage`
- `status`

### `TokenEfficiency`

```typescript
any
```

**Members:**

- `tokensUsed`
- `maxTokens`
- `tasksCompleted`
- `contextUtilization`
- `tokenUtilizationRate`
- `contextEfficiency`
- `inputTokens`
- `outputTokens`

### `OrchestrationOverhead`

```typescript
any
```

**Members:**

- `orchestratorTokens`
- `totalSubagentTokens`
- `numSubagents`
- `overheadRatio`
- `tokensPerSubagent`

### `DriftIssue`

```typescript
any
```

**Members:**

- `type`
- `severity`
- `item`
- `message`

### `DriftReport`

```typescript
any
```

**Members:**

- `mode`
- `issues`
- `exitCode`

### `CommandIndexEntry`

```typescript
any
```

**Members:**

- `name`
- `script`
- `aliasFor`
- `note`

### `CommandIndex`

```typescript
any
```

**Members:**

- `commands`

### `SchemaVersions`

```typescript
any
```

**Members:**

- `todo`
- `config`
- `archive`
- `log`

### `FileHashes`

```typescript
any
```

**Members:**

- `'tasks.db'`
- `'config.json'`

### `ProjectCacheEntry`

```typescript
any
```

**Members:**

- `path`
- `lastValidated`
- `validationStatus`
- `schemaVersions`
- `fileHashes`
- `issues`
- `ttl`

### `DoctorProjectCache`

```typescript
any
```

**Members:**

- `version`
- `lastUpdated`
- `projects`

### `ProjectDetail`

```typescript
any
```

**Members:**

- `name`
- `path`
- `status`
- `issues`
- `isTemp`
- `isOrphaned`
- `reason`

### `CategorizedProjects`

```typescript
any
```

**Members:**

- `active`
- `temp`
- `orphaned`

### `UserJourneyStage`

```typescript
any
```

### `HealthSummary`

```typescript
any
```

**Members:**

- `total`
- `healthy`
- `warnings`
- `failed`
- `orphaned`
- `temp`

### `ValidationError`

```typescript
any
```

**Members:**

- `field`
- `message`
- `severity`
- `fix`

### `ValidationResult`

```typescript
any
```

**Members:**

- `valid`
- `errors`
- `warnings`

### `Task`

```typescript
any
```

**Members:**

- `id`
- `content`
- `title`
- `status`
- `activeForm`
- `created_at`
- `completed_at`
- `parentId`
- `type`
- `depends`
- `cancelledAt`
- `cancellationReason`

### `TaskFile`

```typescript
any
```

**Members:**

- `tasks`
- `project`

### `ArchiveFile`

```typescript
any
```

**Members:**

- `archived_tasks`

### `ComprehensiveValidationResult`

```typescript
any
```

**Members:**

- `schemaErrors`
- `semanticErrors`
- `exitCode`
- `checks`

### `ManifestDoc`

```typescript
any
```

**Members:**

- `id`
- `file`
- `title`
- `topics`
- `linked_tasks`
- `status`

### `GapEntry`

```typescript
any
```

**Members:**

- `type`
- `severity`
- `document`
- `topic`
- `fix`

### `CoverageEntry`

```typescript
any
```

**Members:**

- `document`
- `topic`

### `GapReport`

```typescript
any
```

**Members:**

- `epicId`
- `timestamp`
- `reviewDocs`
- `gaps`
- `coverage`
- `status`
- `canArchive`

### `ManifestEntry`

```typescript
any
```

**Members:**

- `id`
- `file`
- `title`
- `date`
- `status`
- `agent_type`
- `topics`
- `key_findings`
- `actionable`
- `needs_followup`
- `linked_tasks`

### `ManifestViolation`

```typescript
any
```

**Members:**

- `requirement`
- `severity`
- `message`
- `fix`

### `ManifestValidationResult`

```typescript
any
```

**Members:**

- `valid`
- `score`
- `pass`
- `agent_type`
- `violations`
- `note`

### `ComplianceEntry`

```typescript
any
```

**Members:**

- `timestamp`
- `source_id`
- `source_type`
- `compliance`
- `efficiency`
- `_context`

### `ProtocolViolation`

```typescript
any
```

**Members:**

- `requirement`
- `severity`
- `message`
- `fix`

### `ProtocolValidationResult`

```typescript
any
```

**Members:**

- `valid`
- `violations`
- `score`

### `GateName`

```typescript
any
```

### `AgentName`

```typescript
any
```

### `FailureLogEntry`

```typescript
any
```

**Members:**

- `gate`
- `agent`
- `reason`
- `timestamp`
- `round`

### `VerificationGates`

```typescript
any
```

**Members:**

- `implemented`
- `testsPassed`
- `qaPassed`
- `cleanupDone`
- `securityPassed`
- `documented`

### `Verification`

```typescript
any
```

**Members:**

- `passed`
- `round`
- `gates`
- `lastAgent`
- `lastUpdated`
- `failureLog`

### `VerificationStatus`

```typescript
any
```

### `CircularValidationResult`

```typescript
any
```

**Members:**

- `valid`
- `error`
- `code`

### `TaskForVerification`

```typescript
any
```

**Members:**

- `id`
- `status`
- `parentId`
- `type`
- `verification`
- `epicLifecycle`

### `ProjectInfo`

Fields consumed by logging, audit, and correlation subsystems.

```typescript
any
```

**Members:**

- `projectHash` — 12-char SHA-256 hex of the normalized project path (per-install identity).
- `projectId` — Stable UUID that survives directory moves (added by T5333).
- `projectRoot` — Absolute path to the project root directory.
- `projectName` — Human-readable project name (last segment of projectRoot).

### `SyncStatusResult`

Result for sync status operation.

```typescript
any
```

**Members:**

- `active`
- `sessionId`
- `injectedAt`
- `injectedPhase`
- `taskCount`
- `taskIds`
- `phases`
- `stateFile`

### `SyncClearResult`

Result for sync clear operation.

```typescript
any
```

**Members:**

- `cleared`
- `dryRun`
- `wouldDelete`
- `noChange`

### `RequirementLevel`

RFC 2119 requirement levels

```typescript
any
```

### `ViolationSeverity`

Violation severity

```typescript
any
```

### `ProtocolRule`

Protocol rule definition

```typescript
any
```

**Members:**

- `id` — Rule identifier (e.g., RSCH-001)
- `level` — RFC 2119 level
- `message` — Rule description
- `fix` — Suggested fix command
- `validate` — Validation function

### `ProtocolViolation`

Protocol violation result

```typescript
any
```

**Members:**

- `requirement`
- `severity`
- `message`
- `fix`

### `ProtocolValidationResult`

Protocol validation result

```typescript
any
```

**Members:**

- `valid`
- `violations`
- `score`

### `ErrorSeverity`

Error severity levels for protocol/gate validation.

```typescript
typeof ErrorSeverity
```

**Members:**

- `INFO`
- `WARNING`
- `ERROR`
- `CRITICAL`

### `ErrorCategory`

Error category for grouping protocol/gate violations.

```typescript
typeof ErrorCategory
```

**Members:**

- `GENERAL`
- `HIERARCHY`
- `CONCURRENCY`
- `SESSION`
- `VERIFICATION`
- `CONTEXT`
- `PROTOCOL`
- `NEXUS`
- `LIFECYCLE`
- `SPECIAL`

### `ProtocolExitCode`

Protocol-specific exit codes used by the RCASD-IVTR+C enforcement system.  These map to the protocol violation range (60-70) and lifecycle enforcement range (80-84) defined in the MCP server specification. The values here align with the protocol enforcement layer's own exit code semantics, which differ from the canonical CLI exit codes in src/types/exit-codes.ts.  The canonical CLI ExitCode enum at src/types/exit-codes.ts maps range 60-67 to orchestrator errors, while this enum maps them to protocol violations. Both are valid in their respective contexts — CLI vs protocol enforcement.

```typescript
typeof ProtocolExitCode
```

**Members:**

- `SUCCESS`
- `E_GENERAL_ERROR`
- `E_INVALID_INPUT`
- `E_FILE_ERROR`
- `E_NOT_FOUND`
- `E_DEPENDENCY_ERROR`
- `E_VALIDATION_ERROR`
- `E_PARENT_NOT_FOUND`
- `E_DEPTH_EXCEEDED`
- `E_SIBLING_LIMIT`
- `E_CIRCULAR_REFERENCE`
- `E_SESSION_REQUIRED`
- `E_PROTOCOL_RESEARCH`
- `E_PROTOCOL_CONSENSUS`
- `E_PROTOCOL_SPECIFICATION`
- `E_PROTOCOL_DECOMPOSITION`
- `E_PROTOCOL_IMPLEMENTATION`
- `E_PROTOCOL_CONTRIBUTION`
- `E_PROTOCOL_RELEASE`
- `E_PROTOCOL_GENERIC`
- `E_PROTOCOL_VALIDATION`
- `E_TESTS_SKIPPED`
- `E_LIFECYCLE_GATE_FAILED`

### `ProtocolRequest`

Request shape used by the protocol enforcement system. Minimal interface matching the fields needed by ProtocolEnforcer.

```typescript
any
```

**Members:**

- `gateway`
- `domain`
- `operation`
- `params`

### `ProtocolResponse`

Response shape used by the protocol enforcement system.

```typescript
any
```

**Members:**

- `_meta`
- `success`
- `data`
- `partial`
- `error`

### `ProtocolType`

Protocol types aligned with RCASD-IVTR+C lifecycle

```typescript
typeof ProtocolType
```

**Members:**

- `RESEARCH`
- `CONSENSUS`
- `SPECIFICATION`
- `DECOMPOSITION`
- `IMPLEMENTATION`
- `CONTRIBUTION`
- `RELEASE`
- `VALIDATION`
- `TESTING`

### `ViolationLogEntry`

Violation log entry

```typescript
any
```

**Members:**

- `timestamp`
- `taskId`
- `protocol`
- `violations`
- `score`
- `blocked`

### `ChainFindCriteria`

```typescript
any
```

**Members:**

- `query`
- `category`
- `tessera`
- `archetype`
- `limit`

### `ProtocolViolation`

Protocol violation entry.

```typescript
any
```

**Members:**

- `requirement`
- `severity`
- `message`
- `fix`

### `ProtocolValidationResult`

Protocol validation result.

```typescript
any
```

**Members:**

- `valid`
- `protocol`
- `violations`
- `score`

### `ManifestEntryInput`

Manifest entry structure for validation.

```typescript
any
```

**Members:**

- `id`
- `file`
- `title`
- `date`
- `status`
- `agent_type`
- `topics`
- `key_findings`
- `actionable`
- `needs_followup`
- `linked_tasks`
- `sources`

### `ProtocolType`

```typescript
any
```

### `VotingMatrix`

```typescript
any
```

**Members:**

- `options`
- `threshold`

### `ClaudeMemMigrationResult`

Result from a claude-mem migration run.

```typescript
any
```

**Members:**

- `observationsImported`
- `observationsSkipped`
- `learningsImported`
- `decisionsImported`
- `errors`
- `dryRun`

### `ClaudeMemMigrationOptions`

Options for the claude-mem migration.

```typescript
any
```

**Members:**

- `sourcePath` — Path to claude-mem.db. Default: ~/.claude-mem/claude-mem.db
- `project` — Project tag for imported entries.
- `dryRun` — If true, count what would be imported without inserting.
- `batchSize` — Number of rows to insert per transaction batch. Default: 100.

### `BlockerNode`

```typescript
any
```

**Members:**

- `taskId`
- `status`
- `reason`
- `decisions`

### `CausalTrace`

```typescript
any
```

**Members:**

- `taskId`
- `blockers`
- `rootCauses`
- `depth`

### `SimilarEntry`

```typescript
any
```

**Members:**

- `id`
- `distance`
- `type`
- `title`
- `text`

### `ManifestEntry`

```typescript
any
```

### `ModelProviderLookup`

```typescript
any
```

**Members:**

- `provider`
- `source`
- `candidates`

### `TokenMethod`

```typescript
any
```

### `TokenConfidence`

```typescript
any
```

### `TokenTransport`

```typescript
any
```

### `TokenExchangeInput`

```typescript
any
```

**Members:**

- `requestPayload`
- `responsePayload`
- `provider`
- `model`
- `transport`
- `gateway`
- `domain`
- `operation`
- `sessionId`
- `taskId`
- `requestId`
- `cwd`
- `metadata`

### `TokenMeasurement`

```typescript
any
```

**Members:**

- `inputChars`
- `outputChars`
- `inputTokens`
- `outputTokens`
- `totalTokens`
- `method`
- `confidence`
- `provider`
- `model`
- `requestHash`
- `responseHash`
- `metadata`

### `TokenUsageFilters`

```typescript
any
```

**Members:**

- `provider`
- `transport`
- `gateway`
- `domain`
- `operation`
- `sessionId`
- `taskId`
- `method`
- `confidence`
- `requestId`
- `since`
- `until`
- `limit`
- `offset`

### `TokenUsageSummary`

```typescript
any
```

**Members:**

- `totalRecords`
- `inputTokens`
- `outputTokens`
- `totalTokens`
- `byMethod`
- `byTransport`
- `byOperation`

### `SkillEntry`

```typescript
any
```

**Members:**

- `name`
- `path`
- `hasSkillFile`
- `description`

### `SkillContent`

```typescript
any
```

**Members:**

- `skill`
- `content`
- `contentLength`
- `estimatedTokens`
- `references`
- `path`

### `HighImpactTask`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `wouldUnblock`
- `dependents`

### `SingleBlockerTask`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `remainingBlocker`

### `CommonBlocker`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `blocksCount`
- `blockedTasks`

### `UnblockResult`

```typescript
any
```

**Members:**

- `highImpact`
- `singleBlocker`
- `commonBlockers`

### `ValidationIssue`

```typescript
any
```

**Members:**

- `code`
- `message`
- `severity`

### `SpawnValidationResult`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `ready`
- `issues`

### `ContextInjectionData`

Data returned by context injection.

```typescript
any
```

**Members:**

- `protocolType`
- `content`
- `path`
- `contentLength`
- `estimatedTokens`
- `taskId`
- `variant`

### `InsertTask`

```typescript
any
```

### `SelectTask`

```typescript
any
```

### `InsertTaskDependency`

```typescript
any
```

### `SelectTaskDependency`

```typescript
any
```

### `InsertTaskRelation`

```typescript
any
```

### `SelectTaskRelation`

```typescript
any
```

### `InsertSession`

```typescript
any
```

### `SelectSession`

```typescript
any
```

### `InsertWorkHistory`

```typescript
any
```

### `SelectWorkHistory`

```typescript
any
```

### `InsertLifecyclePipeline`

```typescript
any
```

### `SelectLifecyclePipeline`

```typescript
any
```

### `InsertLifecycleStage`

```typescript
any
```

### `SelectLifecycleStage`

```typescript
any
```

### `InsertLifecycleGateResult`

```typescript
any
```

### `SelectLifecycleGateResult`

```typescript
any
```

### `InsertLifecycleEvidence`

```typescript
any
```

### `SelectLifecycleEvidence`

```typescript
any
```

### `InsertLifecycleTransition`

```typescript
any
```

### `SelectLifecycleTransition`

```typescript
any
```

### `InsertSchemaMeta`

```typescript
any
```

### `SelectSchemaMeta`

```typescript
any
```

### `InsertAuditLog`

```typescript
any
```

### `SelectAuditLog`

```typescript
any
```

### `AuditLogInsert`

Canonical type alias for audit log insert (T4848).

```typescript
any
```

### `AuditLogSelect`

Canonical type alias for audit log select (T4848).

```typescript
any
```

### `InsertTokenUsage`

```typescript
any
```

### `SelectTokenUsage`

```typescript
any
```

### `InsertArchitectureDecision`

```typescript
any
```

### `SelectArchitectureDecision`

```typescript
any
```

### `InsertManifestEntry`

```typescript
any
```

### `SelectManifestEntry`

```typescript
any
```

### `DependencyWave`

A wave of parallelizable tasks.

```typescript
any
```

**Members:**

- `wave`
- `taskIds`

### `CancelResult`

Result of a cancel operation.

```typescript
any
```

**Members:**

- `success`
- `taskId`
- `reason`
- `cancelledAt`
- `error`

### `FlatTreeNode`

Tree node representation for task hierarchy.

```typescript
any
```

**Members:**

- `id`
- `title`
- `status`
- `type`
- `children`

### `ComplexityFactor`

Complexity factor.

```typescript
any
```

**Members:**

- `name`
- `value`
- `detail`

### `AnalysisResult`

```typescript
any
```

**Members:**

- `autoStarted`

### `StoreEngine`

Store engine type. SQLite is the only supported engine (ADR-006).  T4647

```typescript
any
```

### `TaskFilters`

Common task filter options.

```typescript
any
```

**Members:**

- `status`
- `parentId`
- `type`
- `phase`
- `limit`

### `SessionFilters`

Common session filter options.

```typescript
any
```

**Members:**

- `active`
- `limit`

### `StoreProvider`

Store provider interface. Backed by SQLite (ADR-006 canonical storage).

```typescript
any
```

**Members:**

- `engine`
- `createTask`
- `getTask`
- `updateTask`
- `deleteTask`
- `listTasks`
- `findTasks`
- `archiveTask`
- `createSession`
- `getSession`
- `updateSession`
- `listSessions`
- `endSession`
- `startTaskOnSession`
- `getCurrentTaskForSession`
- `stopTaskOnSession`
- `close`
- `addTask` — Add a task with full validation, ID generation, and logging.
- `completeTask` — Complete a task with dependency checks and optional auto-completion.
- `richUpdateTask` — Update a task with rich options (addLabels, removeDepends, etc.).
- `showTask` — Show a task by ID (throws CleoError if not found).
- `richDeleteTask` — Delete a task with force/cascade options.
- `richFindTasks` — Find tasks with fuzzy/ID/exact search and filtering.
- `richListTasks` — List tasks with full filtering and pagination.
- `richArchiveTasks` — Archive tasks in batch with filtering options.
- `startSession` — Start a new session with scope, auto-start, etc.
- `richEndSession` — End a session, optionally by ID with a note.
- `sessionStatus` — Get the current active session status.
- `resumeSession` — Resume a previously ended session.
- `richListSessions` — List sessions with status/limit filters.
- `gcSessions` — Garbage collect old sessions.
- `currentTask` — Show current task work state.
- `startTask` — Start working on a task by ID.
- `stopTask` — Stop working on the current task.
- `getWorkHistory` — Get task work history.
- `listLabels` — List all labels with task counts.
- `showLabelTasks` — Show tasks with a specific label.
- `getLabelStats` — Get detailed label statistics.
- `suggestRelated` — Suggest related tasks based on shared attributes.
- `addRelation` — Add a relationship between two tasks.
- `discoverRelated` — Discover related tasks using various methods.
- `listRelations` — List existing relations for a task.
- `analyzeTaskPriority` — Analyze task priority with leverage scoring.

### `MigrationResult`

Migration result.

```typescript
any
```

**Members:**

- `success`
- `tasksImported`
- `archivedImported`
- `sessionsImported`
- `errors`
- `warnings`
- `existingCounts`
- `jsonCounts`

### `MigrationOptions`

Options for migration.

```typescript
any
```

**Members:**

- `force`
- `dryRun`

### `RepairAction`

A single repair action with status.

```typescript
any
```

**Members:**

- `action`
- `status`
- `details`

### `UpgradeAction`

A single upgrade action with status.

```typescript
any
```

**Members:**

- `action`
- `status`
- `details`
- `fix`

### `UpgradeResult`

Full upgrade result.

```typescript
any
```

**Members:**

- `success`
- `upToDate`
- `dryRun`
- `actions`
- `applied`
- `errors`
- `storageMigration` — Storage migration sub-result (if migration was triggered).

### `GateLayer`

Gate layer enumeration

```typescript
typeof GateLayer
```

**Members:**

- `SCHEMA`
- `SEMANTIC`
- `REFERENTIAL`
- `PROTOCOL`

### `GateStatus`

Gate status for each layer

```typescript
typeof GateStatus
```

**Members:**

- `PENDING`
- `PASSED`
- `FAILED`
- `BLOCKED`
- `SKIPPED`

### `GateViolation`

Violation detail for a specific gate layer

```typescript
any
```

**Members:**

- `layer`
- `severity`
- `code`
- `message`
- `field`
- `value`
- `constraint`
- `fix`

### `LayerResult`

Result from a single gate layer validation

```typescript
any
```

**Members:**

- `layer`
- `status`
- `passed`
- `violations`
- `duration_ms`

### `VerificationResult`

Complete verification result across all 4 layers

```typescript
any
```

**Members:**

- `passed`
- `layers`
- `totalViolations`
- `exitCode`
- `category`
- `summary`
- `blockedAt`

### `OperationContext`

Operation context for gate validation

```typescript
any
```

**Members:**

- `domain`
- `operation`
- `gateway`
- `params`
- `taskId`
- `protocolType`

### `WorkflowGateName`

Workflow gate names per MCP-SERVER-SPECIFICATION.md Section 7.1   T3141

```typescript
typeof WorkflowGateName
```

**Members:**

- `IMPLEMENTED`
- `TESTS_PASSED`
- `QA_PASSED`
- `CLEANUP_DONE`
- `SECURITY_PASSED`
- `DOCUMENTED`

### `WorkflowGateStatus`

Workflow gate status values per Section 7.3

```typescript
any
```

### `WorkflowGateAgent`

Agent responsible for each gate per Section 7.2

```typescript
any
```

### `WorkflowGateDefinition`

Individual workflow gate definition per Section 7.2

```typescript
any
```

**Members:**

- `name`
- `agent`
- `dependsOn`
- `description`

### `WorkflowGateState`

State of a single workflow gate

```typescript
any
```

**Members:**

- `name`
- `status`
- `agent`
- `updatedAt`
- `failureReason`

### `JsonSchemaType`

```typescript
any
```

### `JsonSchemaProperty`

```typescript
any
```

**Members:**

- `type`
- `description`
- `enum`
- `items`

### `JSONSchemaObject`

```typescript
any
```

**Members:**

- `type`
- `properties`
- `required`

### `CommanderArgSplit`

```typescript
any
```

**Members:**

- `positionals` — Params that map to `.argument('<name>')` or `.argument('[name]')`.
- `options` — Params that map to `.option(...)` calls.

### `ValidationResult`

Validation result

```typescript
any
```

**Members:**

- `valid`
- `errors`

### `ValidationError`

Individual validation error

```typescript
any
```

**Members:**

- `path`
- `message`
- `keyword`
- `params`

### `SchemaType`

Schema types that can be validated via AJV/JSON Schema. SQLite-backed types (todo, archive, log, sessions) use drizzle-zod validation instead.

```typescript
any
```

### `RuleViolation`

Validation error from anti-hallucination checks

```typescript
any
```

**Members:**

- `rule`
- `field`
- `message`
- `severity`

### `ComplianceEntry`

Compliance entry stored in COMPLIANCE.jsonl

```typescript
any
```

**Members:**

- `timestamp`
- `taskId`
- `protocol`
- `result`
- `violations`
- `linkedTask`
- `agent`

### `CoherenceIssue`

Coherence issue found during graph validation.

```typescript
any
```

**Members:**

- `type`
- `taskId`
- `message`
- `severity`

### `ValidateCheckDetail`

```typescript
any
```

**Members:**

- `check`
- `status`
- `message`

### `ValidateReportResult`

```typescript
any
```

**Members:**

- `valid`
- `schemaVersion`
- `errors`
- `warnings`
- `details`

### `ValidateAndFixResult`

Result from validate + fix operation.

```typescript
any
```

**Members:**

- `repairsApplied`
- `repairs`

### `CriticalPathNode`

```typescript
any
```

**Members:**

- `taskId`
- `title`
- `status`
- `size`
- `blockerCount`

### `CriticalPathResult`

```typescript
any
```

**Members:**

- `path`
- `length`
- `totalEffort`
- `completedInPath`
- `remainingInPath`

### `SkillsPrecedenceConfig`

```typescript
any
```

**Members:**

- `defaultPrecedence`
- `providerOverrides`

### `ResolvedSkillPath`

```typescript
any
```

**Members:**

- `path`
- `source`
- `scope`
- `precedence`
- `providerId`

### `SkillInstallationContext`

```typescript
any
```

**Members:**

- `skillName`
- `source`
- `targetProviders`
- `precedenceMode`
- `projectRoot`

### `InProgressEpic`

In-progress epic entry.

```typescript
any
```

**Members:**

- `epicId`
- `epicTitle`
- `activeTasks`
- `completionPercent`

### `ReadyTask`

Ready task entry with leverage analysis.

```typescript
any
```

**Members:**

- `epicId`
- `leverage`
- `score`
- `reasons`

### `BlockedTask`

Blocked task entry.

```typescript
any
```

**Members:**

- `blockedBy`
- `blocksCount`

### `OpenBug`

Open bug entry.

```typescript
any
```

**Members:**

- `epicId`

### `PlanMetrics`

Planning metrics.

```typescript
any
```

**Members:**

- `totalEpics`
- `activeEpics`
- `totalTasks`
- `actionable`
- `blocked`
- `openBugs`
- `avgLeverage`

### `PlanResult`

Composite planning view result.

```typescript
any
```

**Members:**

- `inProgress`
- `ready`
- `blocked`
- `openBugs`
- `metrics`

### `RcasdIndex`

RCASD-INDEX.json top-level structure.

```typescript
any
```

**Members:**

- `$schema`
- `_meta`
- `authorities`
- `taskAnchored`
- `specs`
- `reports`
- `pipeline`
- `recentChanges`

### `IndexMeta`

Index metadata.

```typescript
any
```

**Members:**

- `version`
- `lastUpdated`
- `totals`
- `checksum`

### `IndexTotals`

Aggregate counts.

```typescript
any
```

**Members:**

- `tasks`
- `specs`
- `reports`
- `activeResearch`
- `pendingConsensus`

### `TaskAnchor`

Task-anchored RCASD artifact reference.

```typescript
any
```

**Members:**

- `shortName`
- `directory`
- `spec`
- `report`
- `status`
- `pipelineStage`
- `createdAt`
- `updatedAt`

### `SpecEntry`

Specification entry.

```typescript
any
```

**Members:**

- `file`
- `version`
- `status`
- `domain`
- `taskId`
- `lastUpdated`
- `category`
- `shortName`
- `synopsis`

### `ReportEntry`

Report entry.

```typescript
any
```

**Members:**

- `file`
- `relatedSpec`
- `taskId`
- `progress`
- `lastUpdated`
- `phase`
- `notes`

### `PipelineState`

Pipeline state.

```typescript
any
```

**Members:**

- `activeOperations`
- `queuedTasks`
- `lastCompleted`

### `PipelineOperation`

Active pipeline operation.

```typescript
any
```

**Members:**

- `operationId`
- `taskId`
- `stage`
- `startedAt`
- `progress`
- `message`

### `ChangeEntry`

Change entry.

```typescript
any
```

**Members:**

- `timestamp`
- `taskId`
- `changeType`
- `stage`
- `description`

### `Pipeline`

Pipeline entity representing a task's lifecycle state.   T4800  T4799 - Unified pipeline structure replaces scattered manifests

```typescript
any
```

**Members:**

- `id` — Unique identifier (task ID format: T####)
- `currentStage` — Current stage in the pipeline
- `createdAt` — When the pipeline was created
- `updatedAt` — When the pipeline was last updated
- `status` — Overall pipeline status
- `isActive` — Whether the pipeline is currently active (not completed/cancelled)
- `completedAt` — When the pipeline completed (if applicable)
- `cancelledReason` — Cancellation reason (if cancelled)
- `transitionCount` — Number of stage transitions made
- `version` — Version for optimistic locking

### `PipelineStageRecord`

Pipeline stage record linking pipeline to individual stages.   T4800  T4801 - Requires pipeline_stages table

```typescript
any
```

**Members:**

- `id` — Unique identifier
- `pipelineId` — Reference to the pipeline
- `stage` — Stage name
- `status` — Stage status
- `startedAt` — When the stage was started
- `completedAt` — When the stage was completed
- `durationMs` — Stage duration in milliseconds (computed)
- `assignedAgent` — Assigned agent for this stage
- `notes` — Stage-specific metadata/notes
- `order` — Stage order in pipeline

### `PipelineTransition`

Pipeline transition record for audit trail.   T4800  T4801 - Requires pipeline_transitions table

```typescript
any
```

**Members:**

- `id` — Unique identifier
- `pipelineId` — Pipeline reference
- `fromStage` — From stage
- `toStage` — To stage
- `transitionedAt` — When the transition occurred
- `transitionedBy` — Agent/user who initiated the transition
- `reason` — Reason for the transition
- `prerequisitesChecked` — Whether prerequisites were checked
- `validationErrors` — Any validation errors that occurred

### `InitializePipelineOptions`

Options for initializing a pipeline.   T4800

```typescript
any
```

**Members:**

- `startStage` — Starting stage (defaults to 'research')
- `initialStatus` — Initial status (defaults to 'active')
- `assignedAgent` — Assigning agent

### `AdvanceStageOptions`

Options for advancing pipeline stage.   T4800

```typescript
any
```

**Members:**

- `toStage` — Target stage to advance to
- `reason` — Reason for the advancement
- `initiatedBy` — Agent/user initiating the transition
- `skipPrerequisites` — Whether to skip prerequisite check (emergency only)
- `force` — Whether to force transition even if blocked

### `PipelineQueryOptions`

Pipeline query options.   T4800

```typescript
any
```

**Members:**

- `status` — Filter by status
- `currentStage` — Filter by current stage
- `isActive` — Filter by active state
- `limit` — Limit results
- `offset` — Offset for pagination
- `orderBy` — Order by (default: createdAt desc)
- `order` — Order direction

### `ResumablePipeline`

Resumable pipeline information returned to callers.   T4805  T4798

```typescript
any
```

**Members:**

- `taskId` — Task ID (e.g., T4805)
- `pipelineId` — Pipeline ID
- `currentStage` — Current stage in the pipeline
- `status` — Pipeline status
- `startedAt` — When the pipeline started
- `updatedAt` — When the pipeline was last updated
- `taskTitle` — Task title
- `stageStatus` — Current stage status
- `stageStartedAt` — Stage started at (if active)
- `blockReason` — Block reason if blocked
- `previousSessionId` — Previous session ID if known
- `resumePriority` — Resume priority (lower = higher priority)

### `PipelineContext`

Pipeline context for session resume.   T4805

```typescript
any
```

**Members:**

- `taskId` — Task ID
- `pipelineId` — Pipeline ID
- `currentStage` — Current stage
- `stages` — All stages with their status
- `gateResults` — Gate results for current stage
- `evidence` — Evidence linked to current stage
- `recentTransitions` — Recent transitions
- `task` — Task details

### `StageContext`

Stage context within a pipeline.   T4805

```typescript
any
```

**Members:**

- `stage` — Stage name
- `status` — Stage status
- `sequence` — Sequence order
- `startedAt` — When started
- `completedAt` — When completed
- `blockedAt` — Block information
- `blockReason`
- `skippedAt` — Skip information
- `skipReason`
- `notes` — Stage notes
- `metadata` — Stage metadata

### `GateResultContext`

Gate result context.   T4805  T4804

```typescript
any
```

**Members:**

- `gateName` — Gate name
- `result` — Result status
- `checkedAt` — When checked
- `checkedBy` — Who checked
- `details` — Details
- `reason` — Reason if failed

### `EvidenceContext`

Evidence context.   T4805  T4804

```typescript
any
```

**Members:**

- `id` — Evidence ID
- `uri` — URI to evidence
- `type` — Evidence type
- `recordedAt` — When recorded
- `recordedBy` — Who recorded
- `description` — Description

### `TransitionContext`

Transition context.   T4805

```typescript
any
```

**Members:**

- `fromStage` — From stage
- `toStage` — To stage
- `transitionedAt` — When transitioned
- `transitionedBy` — Who initiated
- `reason` — Reason

### `TaskContext`

Task context.   T4805

```typescript
any
```

**Members:**

- `id` — Task ID
- `title` — Task title
- `description` — Task description
- `status` — Task status
- `priority` — Task priority
- `parentId` — Parent task ID

### `ResumeResult`

Result of a resume operation.   T4805

```typescript
any
```

**Members:**

- `success` — Whether resume was successful
- `taskId` — Task ID
- `stage` — Stage resumed
- `previousStatus` — Previous status
- `newStatus` — New status
- `resumedAt` — Resume timestamp
- `message` — Message for user
- `warnings` — Any warnings

### `AutoResumeResult`

Auto-resume detection result.   T4805

```typescript
any
```

**Members:**

- `canResume` — Whether auto-resume is possible
- `taskId` — Task ID to resume
- `stage` — Stage to resume
- `context` — Pipeline context if available
- `options` — Resume options if multiple
- `recommendation` — Recommended action
- `message` — Message for user

### `FindResumableOptions`

Options for finding resumable pipelines.   T4805

```typescript
any
```

**Members:**

- `taskIds` — Filter by specific task IDs
- `stages` — Filter by stages
- `includeBlocked` — Include blocked pipelines
- `includeAborted` — Include aborted pipelines
- `limit` — Maximum results
- `minPriority` — Minimum priority (tasks with priority = this)

### `SessionResumeCheckOptions`

Options for session start with resume check.   T4805

```typescript
any
```

**Members:**

- `autoResume` — Whether to auto-resume if only one candidate
- `scope` — Scope to filter resumable pipelines
- `minPriority` — Minimum priority to consider
- `includeBlocked` — Whether to include blocked pipelines

### `SessionResumeCheckResult`

Result of session resume check.   T4805

```typescript
any
```

**Members:**

- `didResume` — Whether resume was performed
- `resumedTaskId` — Resumed task ID if auto-resumed
- `resumedStage` — Resumed stage if auto-resumed
- `options` — Available resume options if not auto-resumed
- `message` — Message for user
- `requiresUserChoice` — Whether user action is required

### `PrereqCheck`

Prerequisite check result.   T4800

```typescript
any
```

**Members:**

- `met` — Whether all prerequisites are met
- `prerequisites` — List of prerequisite stages
- `completed` — Stages that are completed or skipped
- `pending` — Stages that are pending or blocked
- `failed` — Stages that failed
- `blockers` — Blocking issues preventing progression
- `canForce` — Whether the check can be overridden with force
- `summary` — Human-readable summary

### `TransitionValidation`

Transition validation result.   T4800

```typescript
any
```

**Members:**

- `valid` — Whether the transition is valid
- `from` — Source stage
- `to` — Target stage
- `prerequisitesMet` — Whether prerequisites are met
- `ruleAllowed` — Whether the transition rule allows it
- `requiresForce` — Whether force is required
- `errors` — List of validation errors
- `warnings` — List of warnings
- `prereqCheck` — Prerequisite check details

### `StageState`

Stage state snapshot for state machine.   T4800

```typescript
any
```

**Members:**

- `stage`
- `status`
- `startedAt`
- `completedAt`
- `assignedAgent`
- `notes`

### `StateMachineContext`

State machine context for a pipeline.   T4800

```typescript
any
```

**Members:**

- `pipelineId`
- `currentStage`
- `stages`
- `transitionCount`
- `version`

### `StateTransition`

State transition request.   T4800

```typescript
any
```

**Members:**

- `from`
- `to`
- `reason`
- `initiatedBy`
- `force`
- `skipValidation`

### `StateTransitionResult`

State transition result.   T4800

```typescript
any
```

**Members:**

- `success`
- `transition`
- `previousState`
- `newState`
- `context`
- `timestamp`
- `errors`

### `ContextWindowInput`

Context window input from Claude Code.

```typescript
any
```

**Members:**

- `context_window`

### `ContextStatus`

Context status derived from input.

```typescript
any
```

### `HITLLevel`

HITL warning level.

```typescript
any
```

### `HITLWarning`

HITL warning entry.

```typescript
any
```

**Members:**

- `level`
- `type`
- `message`
- `details`
- `action`

### `HITLWarningsResult`

HITL warnings result.

```typescript
any
```

**Members:**

- `enabled`
- `level`
- `requiresHuman`
- `warnings`
- `activeLocks`
- `summary`

### `EnforcementMode`

Enforcement modes.

```typescript
any
```

### `ActiveSessionInfo`

Session info for enforcement checks.

```typescript
any
```

**Members:**

- `id`
- `name`
- `scope`

### `EnforcementResult`

Enforcement result.

```typescript
any
```

**Members:**

- `allowed`
- `mode`
- `session`
- `warning`

### `StatuslineStatus`

Statusline integration status.

```typescript
any
```

### `RoutingEntry`

Routing entry describing the preferred channel for an operation.

```typescript
any
```

**Members:**

- `domain` — Domain name (e.g. 'tasks', 'memory', 'session')
- `operation` — Operation name (e.g. 'brain.search', 'show')
- `preferredChannel` — Preferred channel for token efficiency
- `reason` — Reason for the channel preference

### `ProviderContext`

Provider capability context for dynamic skill generation.

```typescript
any
```

**Members:**

- `providerId`
- `providerName`
- `supportsMcp`
- `supportsHooks`
- `supportsSpawn`
- `instructionFilePattern`

### `IndexMap`

Cache index mapping labels/phases to task IDs.

```typescript
any
```

### `ImportPackageMeta`

Import package metadata extracted from the export file.

```typescript
any
```

**Members:**

- `sourceFile`
- `sourceProject`
- `exportedAt`
- `packageChecksum`
- `taskCount`

### `ImportConflictType`

Import conflict types.

```typescript
any
```

### `ImportConflictResolution`

Import conflict resolution strategies.

```typescript
any
```

### `ImportOptions`

Import options for logging context.

```typescript
any
```

**Members:**

- `parent`
- `phase`
- `resetStatus`

### `SortableTask`

Minimal task shape needed for topological sorting.

```typescript
any
```

**Members:**

- `id`
- `parentId`
- `depends`

### `PipelineStageTaskRow`

Row shape for pipeline + stage + task JOIN.

```typescript
any
```

**Members:**

- `pipeline`
- `stage`
- `task`

### `PipelineStageRow`

Row shape for pipeline + stage JOIN.

```typescript
any
```

**Members:**

- `pipeline`
- `stageRecord`

### `InsertProjectRegistry`

```typescript
any
```

### `SelectProjectRegistry`

```typescript
any
```

### `InsertNexusAuditLog`

```typescript
any
```

### `SelectNexusAuditLog`

```typescript
any
```

### `InsertNexusSchemaMeta`

```typescript
any
```

### `SelectNexusSchemaMeta`

```typescript
any
```

### `AtomicityResult`

```typescript
any
```

**Members:**

- `score`
- `passed`
- `violations`

### `AtomicityCriterion`

```typescript
any
```

### `RelatesType`

Valid relationship types for relates entries.

```typescript
any
```

### `RelatesEntry`

A single relates entry.

```typescript
any
```

**Members:**

- `taskId`
- `type`
- `reason`

### `Severity`

Impact severity levels.

```typescript
any
```

### `DeleteWarning`

An impact warning.

```typescript
any
```

**Members:**

- `severity`
- `code`
- `message`

### `AffectedTasks`

Affected tasks info.

```typescript
any
```

**Members:**

- `primary`
- `children`
- `totalCount`
- `error`

### `DeleteImpact`

Impact analysis.

```typescript
any
```

**Members:**

- `pendingLost`
- `activeLost`
- `blockedLost`
- `doneLost`
- `dependentsAffected`

### `DeletePreview`

Full preview result.

```typescript
any
```

**Members:**

- `success`
- `dryRun`
- `wouldDelete`
- `impact`
- `warnings`
- `warningCount`
- `strategy`
- `reason`
- `timestamp`
- `error`

### `ChildStrategy`

Valid child handling strategies.

```typescript
any
```

### `StrategyResult`

Result from a strategy handler.

```typescript
any
```

**Members:**

- `success`
- `strategy`
- `taskId`
- `affectedTasks`
- `affectedCount`
- `message`
- `error`

### `DiscoveryMethod`

Discovery method.

```typescript
any
```

### `DiscoveryMatch`

A single discovery match.

```typescript
any
```

**Members:**

- `taskId`
- `type`
- `reason`
- `score`
- `_hierarchyBoost`
- `_relationship`

### `PhaseProgress`

Phase progress information.

```typescript
any
```

**Members:**

- `name`
- `status`
- `total`
- `done`
- `active`
- `pending`
- `blocked`
- `percentComplete`

### `PhaseTransitionValidation`

Validate a phase transition.

```typescript
any
```

**Members:**

- `valid`
- `error`

### `ReparentOptions`

Options for reparenting a task.

```typescript
any
```

**Members:**

- `taskId`
- `newParentId` — New parent ID, or null to promote to root.
- `policy` — Optional resolved hierarchy policy. If not provided, uses llm-agent-first defaults.

### `ReparentResult`

Result of a reparent operation.

```typescript
any
```

**Members:**

- `oldParent`
- `newParent`
- `newType`

### `StalenessThresholds`

Staleness thresholds in days.

```typescript
any
```

**Members:**

- `stale` — Days before a task is considered stale.
- `critical` — Days before a task is critically stale.
- `abandoned` — Days before a task is considered abandoned.

### `StalenessLevel`

Staleness classification.

```typescript
any
```

### `StalenessInfo`

Staleness assessment for a single task.

```typescript
any
```

**Members:**

- `taskId`
- `level`
- `daysSinceUpdate`
- `lastActivity`

### `StalenessSummary`

Get staleness summary statistics.

```typescript
any
```

**Members:**

- `total`
- `fresh`
- `stale`
- `critical`
- `abandoned`

## Classes

### `ClaudeCodePathProvider`

Path provider for Anthropic Claude Code CLI.  Resolves Claude Code's standard directory layout: - Config dir: ~/.claude (or CLAUDE_HOME) - Settings: ~/.claude/settings.json (or CLAUDE_SETTINGS) - Agents: ~/.claude/agents - Memory DB: ~/.claude-mem/claude-mem.db (or CLAUDE_MEM_DB)

```typescript
typeof ClaudeCodePathProvider
```

**Members:**

- `getProviderDir`
- `getSettingsPath`
- `getAgentInstallDir`
- `getMemoryDbPath`

### `ClaudeCodeContextMonitorProvider`

Context monitor provider for Claude Code.  Processes context window JSON from Claude Code and writes state files for statusline display. Also provides statusline configuration and setup instructions specific to Claude Code's settings.json.

```typescript
typeof ClaudeCodeContextMonitorProvider
```

**Members:**

- `pathProvider`
- `processContextInput`
- `checkStatuslineIntegration`
- `getStatuslineConfig`
- `getSetupInstructions`

### `ClaudeCodeHookProvider`

Hook provider for Claude Code.  Claude Code registers hooks via a plugin directory with a hooks.json descriptor. The actual hook scripts are shell scripts that invoke CLEO's brain observation system.  Since hooks are registered through the plugin system (installed via the install provider), registerNativeHooks and unregisterNativeHooks are effectively no-ops here — the plugin installer handles registration.

```typescript
typeof ClaudeCodeHookProvider
```

**Members:**

- `registered`
- `mapProviderEvent` — Map a Claude Code native event name to a CAAMP hook event name.
- `registerNativeHooks` — Register native hooks for a project.  For Claude Code, hooks are registered via the plugin system (hooks.json descriptor), which is handled by the install provider. This method is a no-op since registration is managed through the plugin install lifecycle.
- `unregisterNativeHooks` — Unregister native hooks.  For Claude Code, this is a no-op since hooks are managed through the plugin system. Unregistration happens via the install provider's uninstall method.
- `isRegistered` — Check whether hooks have been registered via registerNativeHooks.
- `getEventMap` — Get the full event mapping for introspection/debugging.

### `ClaudeCodeInstallProvider`

Install provider for Claude Code.  Manages CLEO's integration with Claude Code by: 1. Registering the CLEO MCP server in the project's .mcp.json 2. Ensuring CLAUDE.md contains -references to CLEO instruction files 3. Registering the brain observation plugin in ~/.claude/settings.json

```typescript
typeof ClaudeCodeInstallProvider
```

**Members:**

- `installedProjectDir`
- `install` — Install CLEO into a Claude Code project.
- `uninstall` — Uninstall CLEO from the current Claude Code project.  Removes the MCP server registration from .mcp.json. Does not remove CLAUDE.md references (they are harmless if CLEO is not present).
- `isInstalled` — Check whether CLEO is installed in the current environment.  Checks for: 1. MCP server registered in .mcp.json 2. Plugin enabled in ~/.claude/settings.json  Returns true if either condition is met (partial install counts).
- `ensureInstructionReferences` — Ensure CLAUDE.md contains -references to CLEO instruction files.  Creates CLAUDE.md if it does not exist. Appends any missing references.
- `registerMcpServer` — Register the CLEO MCP server in .mcp.json.
- `updateInstructionFile` — Update CLAUDE.md with CLEO -references.
- `registerPlugin` — Register the CLEO brain plugin in ~/.claude/settings.json.

### `ClaudeCodeSpawnProvider`

Spawn provider for Claude Code.  Spawns detached Claude CLI processes for subagent execution. Each spawn writes its prompt to a temporary file, then runs `claude --allow-insecure --no-upgrade-check <tmpFile>` as a detached, unref'd child process.

```typescript
typeof ClaudeCodeSpawnProvider
```

**Members:**

- `processMap` — Map of instance IDs to tracked process info.
- `canSpawn` — Check if the Claude CLI is available in PATH.
- `spawn` — Spawn a subagent via Claude CLI.  Writes the prompt to a temporary file and spawns a detached Claude process. The process runs independently of the parent.
- `listRunning` — List currently running Claude subagent processes.  Checks each tracked process via kill(pid, 0) to verify it is still alive. Dead processes are automatically cleaned from the tracking map.
- `terminate` — Terminate a running spawn by instance ID.  Sends SIGTERM to the tracked process. If the process is not found or has already exited, this is a no-op.

### `ClaudeCodeTaskSyncProvider`

Claude Code TaskSyncProvider.  Reads Claude's TodoWrite JSON state, parses [T001]-prefixed task IDs and status, and returns normalized ExternalTask[].  Optional: accepts a custom file path for testing.

```typescript
typeof ClaudeCodeTaskSyncProvider
```

**Members:**

- `customFilePath`
- `getExternalTasks`
- `cleanup`

### `ClaudeCodeTransportProvider`

```typescript
typeof ClaudeCodeTransportProvider
```

**Members:**

- `transportName`
- `createTransport`

### `ClaudeCodeAdapter`

CLEO provider adapter for Anthropic Claude Code CLI.  Bridges CLEO's adapter system with Claude Code's native capabilities: - Hooks: Maps Claude Code events (SessionStart, PostToolUse, etc.) to CAAMP events - Spawn: Launches subagent processes via the `claude` CLI - Install: Registers MCP server, instruction files, and brain observation plugin

```typescript
typeof ClaudeCodeAdapter
```

**Members:**

- `id`
- `name`
- `version`
- `capabilities`
- `hooks`
- `spawn`
- `install`
- `paths`
- `contextMonitor`
- `transport`
- `taskSync`
- `projectDir`
- `initialized`
- `initialize` — Initialize the adapter for a given project directory.  Validates the environment by checking for the Claude CLI and Claude Code configuration directory.
- `dispose` — Dispose the adapter and clean up resources.  Unregisters hooks and releases any tracked state.
- `healthCheck` — Run a health check to verify Claude Code is accessible.  Checks: 1. Adapter has been initialized 2. Claude CLI is available in PATH 3. ~/.claude/ configuration directory exists
- `isInitialized` — Check whether the adapter has been initialized.
- `getProjectDir` — Get the project directory this adapter was initialized with.

### `CursorHookProvider`

Hook provider for Cursor (stub).  Cursor lacks a hook-based lifecycle event system. All mapping operations return null. Registration is a no-op.

```typescript
typeof CursorHookProvider
```

**Members:**

- `registered`
- `mapProviderEvent` — Map a provider event name to a CAAMP hook event name.  Always returns null since Cursor does not emit hook events.
- `registerNativeHooks` — Register native hooks for a project.  No-op for Cursor since it has no hook system.
- `unregisterNativeHooks` — Unregister native hooks.  No-op for Cursor since it has no hook system.
- `isRegistered` — Check whether hooks have been registered.

### `CursorInstallProvider`

Install provider for Cursor.  Manages CLEO's integration with Cursor by: 1. Registering the CLEO MCP server in .cursor/mcp.json 2. Creating/updating .cursorrules with -references (legacy) 3. Creating .cursor/rules/cleo.mdc with -references (modern)

```typescript
typeof CursorInstallProvider
```

**Members:**

- `installedProjectDir`
- `install` — Install CLEO into a Cursor project.
- `uninstall` — Uninstall CLEO from the current Cursor project.  Removes the MCP server registration from .cursor/mcp.json. Does not remove instruction file references (they are harmless if CLEO is not present).
- `isInstalled` — Check whether CLEO is installed in the current environment.  Checks for MCP server registered in .cursor/mcp.json.
- `ensureInstructionReferences` — Ensure instruction files contain -references to CLEO.  Updates .cursorrules (legacy) and creates .cursor/rules/cleo.mdc (modern).
- `registerMcpServer` — Register the CLEO MCP server in .cursor/mcp.json.  Cursor stores MCP server configuration in .cursor/mcp.json under the mcpServers key.
- `updateInstructionFiles` — Update instruction files with CLEO -references.  Handles both legacy (.cursorrules) and modern (.cursor/rules/cleo.mdc) formats.
- `updateLegacyRules` — Update legacy .cursorrules file with -references. Only modifies the file if it already exists (does not create it).
- `updateModernRules` — Create or update .cursor/rules/cleo.mdc with CLEO references.  MDC (Markdown Component) format is Cursor's modern rule file format. Each .mdc file in .cursor/rules/ is loaded as a rule set.
- `getUpdatedFileList` — Get list of instruction files that were updated.

### `CursorAdapter`

CLEO provider adapter for Cursor AI code editor.  Bridges CLEO's adapter system with Cursor's capabilities: - Install: Registers MCP server in .cursor/mcp.json and manages rule files - Hooks: Stub provider (Cursor has no lifecycle event system) - Spawn: Not supported (Cursor has no CLI for subagent spawning)

```typescript
typeof CursorAdapter
```

**Members:**

- `id`
- `name`
- `version`
- `capabilities`
- `hooks`
- `install`
- `projectDir`
- `initialized`
- `initialize` — Initialize the adapter for a given project directory.
- `dispose` — Dispose the adapter and clean up resources.
- `healthCheck` — Run a health check to verify Cursor is accessible.  Checks: 1. Adapter has been initialized 2. .cursor/ configuration directory exists in the project 3. CURSOR_EDITOR env var is set
- `isInitialized` — Check whether the adapter has been initialized.
- `getProjectDir` — Get the project directory this adapter was initialized with.

### `OpenCodeHookProvider`

Hook provider for OpenCode.  OpenCode registers hooks via its configuration system at .opencode/config.json. Hook handlers are defined as shell commands or script paths that execute when the corresponding event fires.  Since hooks are registered through the config system (managed by the install provider), registerNativeHooks and unregisterNativeHooks track registration state without performing filesystem operations.

```typescript
typeof OpenCodeHookProvider
```

**Members:**

- `registered`
- `mapProviderEvent` — Map an OpenCode native event name to a CAAMP hook event name.
- `registerNativeHooks` — Register native hooks for a project.  For OpenCode, hooks are registered via the config system (.opencode/config.json), which is handled by the install provider. This method marks hooks as registered without performing filesystem operations.
- `unregisterNativeHooks` — Unregister native hooks.  For OpenCode, this is a no-op since hooks are managed through the config system. Unregistration happens via the install provider's uninstall method.
- `isRegistered` — Check whether hooks have been registered via registerNativeHooks.
- `getEventMap` — Get the full event mapping for introspection/debugging.

### `OpenCodeInstallProvider`

Install provider for OpenCode.  Manages CLEO's integration with OpenCode by: 1. Registering the CLEO MCP server in .opencode/config.json 2. Ensuring AGENTS.md contains -references to CLEO instruction files

```typescript
typeof OpenCodeInstallProvider
```

**Members:**

- `installedProjectDir`
- `install` — Install CLEO into an OpenCode project.
- `uninstall` — Uninstall CLEO from the current OpenCode project.  Removes the MCP server registration from .opencode/config.json. Does not remove AGENTS.md references (they are harmless if CLEO is not present).
- `isInstalled` — Check whether CLEO is installed in the current environment.  Checks for MCP server registered in .opencode/config.json. Returns true if the CLEO MCP server entry is found.
- `ensureInstructionReferences` — Ensure AGENTS.md contains -references to CLEO instruction files.  Creates AGENTS.md if it does not exist. Appends any missing references.
- `registerMcpServer` — Register the CLEO MCP server in .opencode/config.json.  OpenCode stores its MCP server configuration in .opencode/config.json under the mcpServers key.
- `updateInstructionFile` — Update AGENTS.md with CLEO -references.

### `OpenCodeSpawnProvider`

Spawn provider for OpenCode.  Spawns detached OpenCode CLI processes for subagent execution. Each spawn ensures a CLEO subagent definition exists, then runs `opencode run --format json --agent <name> --title <title> <prompt>` as a detached, unref'd child process.

```typescript
typeof OpenCodeSpawnProvider
```

**Members:**

- `processMap` — Map of instance IDs to tracked process info.
- `canSpawn` — Check if the OpenCode CLI is available in PATH.
- `spawn` — Spawn a subagent via OpenCode CLI.  Ensures the CLEO subagent definition exists in the project's .opencode/agent/ directory, then spawns a detached OpenCode process. The process runs independently of the parent.
- `listRunning` — List currently running OpenCode subagent processes.  Checks each tracked process via kill(pid, 0) to verify it is still alive. Dead processes are automatically cleaned from the tracking map.
- `terminate` — Terminate a running spawn by instance ID.  Sends SIGTERM to the tracked process. If the process is not found or has already exited, this is a no-op.

### `OpenCodeAdapter`

CLEO provider adapter for OpenCode AI coding assistant.  Bridges CLEO's adapter system with OpenCode's native capabilities: - Hooks: Maps OpenCode events (session.start, tool.complete, etc.) to CAAMP events - Spawn: Launches subagent processes via the `opencode` CLI - Install: Registers MCP server in .opencode/config.json and ensures AGENTS.md references

```typescript
typeof OpenCodeAdapter
```

**Members:**

- `id`
- `name`
- `version`
- `capabilities`
- `hooks`
- `spawn`
- `install`
- `projectDir`
- `initialized`
- `initialize` — Initialize the adapter for a given project directory.  Validates the environment by checking for the OpenCode CLI and OpenCode configuration directory.
- `dispose` — Dispose the adapter and clean up resources.  Unregisters hooks and releases any tracked state.
- `healthCheck` — Run a health check to verify OpenCode is accessible.  Checks: 1. Adapter has been initialized 2. OpenCode CLI is available in PATH 3. .opencode/ configuration directory exists in the project
- `isInitialized` — Check whether the adapter has been initialized.
- `getProjectDir` — Get the project directory this adapter was initialized with.

### `CursorSpawnProvider`

Spawn provider for Cursor.  Cursor does not support subagent spawning via CLI. The adapter declares supportsSpawn: false in its capabilities. All methods either reject or return empty results.

```typescript
typeof CursorSpawnProvider
```

**Members:**

- `canSpawn` — Check if Cursor supports spawning subagents.
- `spawn` — Attempt to spawn a subagent via Cursor.  Always throws because Cursor does not support subagent spawning. Callers should check canSpawn() before calling this method.
- `listRunning` — List running Cursor subagent processes.
- `terminate` — Terminate a Cursor subagent process.  No-op because Cursor cannot spawn processes.

### `Dispatcher`

```typescript
typeof Dispatcher
```

**Members:**

- `handlers`
- `pipeline`
- `dispatch`

### `BackgroundJobManager`

Manages background jobs for long-running operations

```typescript
typeof BackgroundJobManager
```

**Members:**

- `jobs`
- `abortControllers`
- `maxJobs`
- `retentionMs`
- `cleanupTimer`
- `startJob` — Start a new background job
- `getJob` — Get a specific job by ID
- `listJobs` — List all jobs, optionally filtered by status
- `cancelJob` — Cancel a running job
- `updateProgress` — Update job progress (0-100)
- `cleanup` — Cleanup old completed/failed/cancelled jobs past retention period
- `destroy` — Destroy the manager: cancel all running jobs and clear state
- `executeJob` — Execute a job's executor function and update status on completion/failure

### `AdminHandler`

```typescript
typeof AdminHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`

### `CheckHandler`

```typescript
typeof CheckHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`

### `MemoryHandler`

```typescript
typeof MemoryHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`

### `NexusHandler`

```typescript
typeof NexusHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`

### `OrchestrateHandler`

```typescript
typeof OrchestrateHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`

### `PipelineHandler`

```typescript
typeof PipelineHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`
- `queryStage`
- `mutateStage`
- `queryRelease`
- `mutateRelease`
- `queryManifest`
- `queryPhase`
- `mutateManifest`
- `mutatePhase`
- `queryChain`
- `mutateChain`

### `SessionHandler`

```typescript
typeof SessionHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`

### `StickyHandler`

```typescript
typeof StickyHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`

### `TasksHandler`

```typescript
typeof TasksHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`

### `ToolsHandler`

```typescript
typeof ToolsHandler
```

**Members:**

- `projectRoot`
- `query`
- `mutate`
- `getSupportedOperations`
- `queryIssue`
- `mutateIssue`
- `querySkill`
- `mutateSkill`
- `queryProvider`
- `mutateProvider`
- `queryTodowrite`
- `mutateTodowrite`
- `queryAdapter`
- `mutateAdapter`
- `handleError`

### `RateLimiter`

Sliding window rate limiter  Tracks request timestamps per category and rejects requests that exceed the configured limit within the time window.

```typescript
typeof RateLimiter
```

**Members:**

- `buckets`
- `config`
- `check` — Check if a request is allowed and record it if so.
- `peek` — Get current rate limit status without recording a request.
- `reset` — Reset all rate limit buckets (for testing)
- `resetCategory` — Reset a specific category bucket (for testing)
- `updateConfig` — Update configuration at runtime
- `getConfig` — Get current configuration (for diagnostics)
- `resolveCategory` — Resolve the rate limit category for a given request.  Spawn operations get their own stricter limit. Everything else is categorized by gateway type.
- `getLimitConfig` — Get the limit configuration for a category
- `getOrCreateBucket` — Get or create a sliding window bucket for a category

### `ConfigValidationError`

Configuration validation error

```typescript
typeof ConfigValidationError
```

### `RateLimiter`

```typescript
typeof RateLimiter
```

**Members:**

- `buckets`
- `config`
- `check`
- `resolveCategory`
- `getLimitConfig`

### `CleoError`

Structured error class for CLEO operations. Carries an exit code, human-readable message, and optional fix suggestions. Produces LAFS-conformant error shapes via toLAFSError() and RFC 9457 Problem Details via toProblemDetails().

```typescript
typeof CleoError
```

**Members:**

- `code`
- `fix`
- `alternatives`
- `toLAFSError` — Produce a LAFS-conformant error object.   T4655
- `toProblemDetails` — Produce an RFC 9457 Problem Details object.   T5240
- `toJSON` — Structured JSON representation for LAFS output (backward compatible).
- `getHttpStatus` — Derive HTTP status from exit code range. Used as fallback when catalog lookup misses.

### `HookRegistry`

Central registry for hook handlers.  Manages registration, priority-based ordering, and async dispatch of hook handlers. Provides best-effort execution where errors in one handler do not block others.

```typescript
typeof HookRegistry
```

**Members:**

- `handlers`
- `config`
- `register` — Register a hook handler for a specific event.  Handlers are sorted by priority (highest first) and executed in parallel when the event is dispatched.
- `dispatch` — Dispatch an event to all registered handlers.  Executes handlers in parallel using Promise.allSettled for best-effort execution. Errors in individual handlers are logged but do not block other handlers or propagate to the caller.
- `isEnabled` — Check if a specific event is currently enabled.  Both the global enabled flag and the per-event flag must be true.
- `setConfig` — Update the hook system configuration.  Merges the provided config with the existing config.
- `getConfig` — Get the current hook configuration.
- `listHandlers` — List all registered handlers for a specific event.  Returns handlers in priority order (highest first).

### `DataSafetyError`

Safety violation error

```typescript
typeof DataSafetyError
```

### `SafetyDataAccessor`

Safety-enabled DataAccessor wrapper.  Wraps any DataAccessor implementation and automatically applies safety checks to all write operations. Read operations pass through.  This class CANNOT be bypassed - it's the only way to get a DataAccessor from the factory (unless emergency disable is active).

```typescript
typeof SafetyDataAccessor
```

**Members:**

- `inner` — The underlying accessor being wrapped.
- `cwd` — Working directory for operations.
- `config` — Safety configuration.
- `logVerbose` — Log safety operation if verbose mode is enabled.
- `getSafetyOptions` — Get safety options for data-safety-central operations.
- `loadArchive`
- `loadSessions`
- `saveSessions`
- `saveArchive`
- `appendLog`
- `upsertSingleTask`
- `archiveSingleTask`
- `removeSingleTask`
- `loadSingleTask`
- `addRelation`
- `getMetaValue`
- `setMetaValue`
- `getSchemaVersion`
- `queryTasks`
- `countTasks`
- `getChildren`
- `countChildren`
- `countActiveChildren`
- `getAncestorChain`
- `getSubtree`
- `getDependents`
- `getDependencyChain`
- `taskExists`
- `loadTasks`
- `updateTaskFields`
- `getNextPosition`
- `shiftPositions`
- `transaction`
- `getActiveSession`
- `upsertSingleSession`
- `removeSingleSession`
- `close`

### `SafetyError`

Safety violation error.

```typescript
typeof SafetyError
```

### `ShimCommand`

Minimal Commander-compatible Command class. Captures command definitions for later translation into citty commands.

```typescript
typeof ShimCommand
```

**Members:**

- `_name`
- `_description`
- `_aliases`
- `_options`
- `_args`
- `_action`
- `_subcommands`
- `_parent`
- `_isDefault`
- `command` — Register a subcommand. Returns the new subcommand for chaining.
- `description` — Set description (chaining).
- `description` — Get description (Commander compat).
- `description`
- `alias`
- `option`
- `requiredOption`
- `argument` — Add a positional argument after command creation. Commander compat: .argument('[name]', 'description')
- `action`
- `allowUnknownOption` — No-op for Commander compatibility. citty handles unknown options gracefully.
- `allowExcessArguments` — No-op for Commander compatibility.
- `name` — Get the command name. Commander compat method.
- `optsWithGlobals` — Return parsed global flags from process.argv. Commander compat: returns parent + own options merged.
- `opts` — Return parsed options. For shim purposes, same as optsWithGlobals().

### `ProgressTracker`

Simple progress tracker for CLI operations.

```typescript
typeof ProgressTracker
```

**Members:**

- `enabled`
- `prefix`
- `currentStep`
- `totalSteps`
- `steps`
- `start` — Start the progress tracker.
- `step` — Update to a specific step.
- `next` — Move to next step.
- `complete` — Mark as complete with optional summary.
- `error` — Report an error.

### `Spinner`

Simple spinner for indeterminate progress.

```typescript
typeof Spinner
```

**Members:**

- `enabled`
- `message`
- `timer`
- `frames`
- `frameIndex`
- `start` — Start the spinner.
- `stop` — Stop the spinner.
- `update` — Update the spinner message.

### `QueryCache`

Query cache with per-domain invalidation

```typescript
typeof QueryCache
```

**Members:**

- `store`
- `domainKeys`
- `stats`
- `ttl`
- `enabled`
- `cleanupTimer`
- `buildKey` — Build cache key from domain, operation, and params
- `get` — Get cached value, or undefined if not found/expired
- `set` — Store a value in the cache
- `invalidateDomain` — Invalidate all cached entries for a domain  Called on any mutate operation to ensure consistency.
- `clear` — Clear entire cache
- `getStats` — Get cache statistics
- `resetStats` — Reset statistics counters
- `evictExpired` — Evict all expired entries
- `destroy` — Stop the cleanup timer (call on shutdown)
- `isEnabled` — Check if cache is enabled
- `delete` — Delete a single key and update domain tracking

### `SecurityError`

Security validation error thrown when input fails sanitization

```typescript
typeof SecurityError
```

### `RateLimiter`

In-memory sliding window rate limiter  Tracks request timestamps per key and enforces configurable limits.

```typescript
typeof RateLimiter
```

**Members:**

- `windows`
- `configs`
- `check` — Check if a request is allowed under rate limits
- `record` — Record a request (call after check returns allowed: true)
- `consume` — Check and record in one step
- `reset` — Reset rate limit state for a specific key or all keys
- `getConfig` — Get current configuration for a key
- `setConfig` — Update configuration for a key

### `SessionView`

SessionView — typed wrapper over Session[] with collection helpers.  Provides discoverable query methods for common session lookups. Does NOT change the DataAccessor interface — consumers create views from Session[].

```typescript
typeof SessionView
```

**Members:**

- `_sessions`
- `from` — Create a SessionView from a Session array.
- `findActive` — Find the currently active session (if any).
- `findById` — Find a session by ID.
- `filterByStatus` — Filter sessions by one or more statuses.
- `findByScope` — Find sessions matching a scope type and optional rootTaskId.
- `sortByDate` — Sort sessions by a date field. Returns a new array (does not mutate).
- `mostRecent` — Get the most recently started session.
- `toArray` — Convert back to a plain Session array (shallow copy).
- `[Symbol.iterator]` — Support for-of iteration.

### `BrainDataAccessor`

```typescript
typeof BrainDataAccessor
```

**Members:**

- `addDecision`
- `getDecision`
- `findDecisions`
- `updateDecision`
- `addPattern`
- `getPattern`
- `findPatterns`
- `updatePattern`
- `addLearning`
- `getLearning`
- `findLearnings`
- `updateLearning`
- `addObservation`
- `getObservation`
- `findObservations`
- `updateObservation`
- `addLink`
- `getLinksForMemory`
- `getLinksForTask`
- `removeLink`
- `addStickyNote`
- `getStickyNote`
- `findStickyNotes`
- `updateStickyNote`
- `deleteStickyNote`
- `addPageNode`
- `getPageNode`
- `findPageNodes`
- `removePageNode`
- `addPageEdge`
- `getPageEdges`
- `getNeighbors`
- `removePageEdge`

### `AdapterManager`

Central adapter manager. Singleton per process.  Lifecycle:   1. discover() — scan for adapter packages and their manifests   2. activate(id) — load, initialize, and set as active adapter   3. getActive() — return the current active adapter   4. dispose() — clean up all initialized adapters

```typescript
typeof AdapterManager
```

**Members:**

- `instance`
- `adapters`
- `manifests`
- `hookCleanups`
- `activeId`
- `projectRoot`
- `getInstance`
- `resetInstance` — Reset singleton (for testing).
- `discover` — Discover adapter manifests from packages/adapters/. Returns manifests found (does not load adapter code yet).
- `detectActive` — Auto-detect which adapters match the current environment and return their manifest IDs.
- `activate` — Load and initialize an adapter by manifest ID. Dynamically imports from the manifest's packagePath — no hardcoded adapters.
- `getActive` — Get the currently active adapter, or null if none.
- `getActiveId` — Get the active adapter's ID, or null.
- `get` — Get a specific adapter by ID.
- `getManifest` — Get the manifest for a specific adapter.
- `listAdapters` — List all known adapters with summary info.
- `healthCheckAll` — Run health check on all initialized adapters.
- `healthCheck` — Health check a single adapter.
- `dispose` — Dispose all initialized adapters.
- `disposeAdapter` — Dispose a single adapter.
- `wireAdapterHooks` — Wire an adapter's hook event map into CLEO's HookRegistry. Creates bridging handlers at priority 50 for each mapped event.
- `cleanupAdapterHooks` — Clean up hook registrations for an adapter.

### `SessionView`

```typescript
typeof SessionView
```

**Members:**

- `_sessions`
- `from` — Create a SessionView from a Session array.
- `findActive` — Find the currently active session (if any).
- `findById` — Find a session by ID.
- `filterByStatus` — Filter sessions by one or more statuses.
- `findByScope` — Find sessions matching a scope type and optional rootTaskId.
- `sortByDate` — Sort sessions by a date field. Returns a new array (does not mutate).
- `mostRecent` — Get the most recently started session.
- `toArray` — Convert back to a plain Session array (shallow copy).
- `[Symbol.iterator]` — Support for-of iteration.

### `Cleo`

```typescript
typeof Cleo
```

**Members:**

- `projectRoot`
- `_store`
- `init`
- `forProject`

### `MigrationLogger`

Structured logger for migration operations

```typescript
typeof MigrationLogger
```

**Members:**

- `logPath`
- `entries`
- `startTime`
- `cleoDir`
- `config`
- `getLevelPriority` — Get numeric priority for log level comparison.
- `shouldLog` — Check if a log level should be recorded.
- `log` — Write a log entry.
- `info` — Log an info-level message.
- `warn` — Log a warning-level message.
- `error` — Log an error-level message.
- `debug` — Log a debug-level message.
- `logFileOperation` — Log file operation with size information.
- `logValidation` — Log validation result.
- `logImportProgress` — Log import progress.
- `phaseStart` — Log phase start.
- `phaseComplete` — Log phase completion.
- `phaseFailed` — Log phase failure.
- `cleanupOldLogs` — Clean up old log files, keeping only the most recent ones.
- `getLogPath` — Get the absolute path to the log file.
- `getRelativeLogPath` — Get the path to the log file relative to cleoDir.
- `getEntries` — Get all logged entries.
- `getEntriesByLevel` — Get entries filtered by level.
- `getEntriesByPhase` — Get entries for a specific phase.
- `getDurationMs` — Get the total duration of the migration so far.
- `getSummary` — Get summary statistics for the migration.

### `SecurityError`

Security validation error thrown when input fails sanitization

```typescript
typeof SecurityError
```

### `RateLimiter`

In-memory sliding window rate limiter

```typescript
typeof RateLimiter
```

**Members:**

- `windows`
- `configs`
- `check`
- `record`
- `consume`
- `reset`
- `getConfig`
- `setConfig`

### `ClaudeCodeTransport`

Claude Code transport — wraps the current provider-specific messaging.  Registration and deregistration are no-ops because the Claude Code Agent SDK manages agent identity internally. Message sending is logged but actual delivery happens through the SDK's SendMessage tool at the agent level.

```typescript
typeof ClaudeCodeTransport
```

**Members:**

- `name`
- `agents`
- `conversations`
- `messages`
- `register`
- `deregister`
- `send`
- `poll`
- `heartbeat`
- `createConversation`
- `getAgent`

### `SignalDockTransport`

SignalDock HTTP transport implementation.  Communicates with a SignalDock server via its REST API to provide provider-neutral inter-agent messaging with delivery guarantees.

```typescript
typeof SignalDockTransport
```

**Members:**

- `name`
- `config`
- `register`
- `deregister`
- `send`
- `poll`
- `heartbeat`
- `createConversation`
- `getAgent`
- `request` — Make an HTTP request to the SignalDock API.

### `SpawnAdapterRegistry`

Registry to manage spawn adapters.  Maintains mappings between adapter IDs, provider IDs, and adapter instances. Supports registration, lookup, and capability-based filtering.

```typescript
typeof SpawnAdapterRegistry
```

**Members:**

- `adapters` — Map of adapter ID to adapter instance
- `providerAdapters` — Map of provider ID to adapter ID
- `register` — Register an adapter with the registry.
- `get` — Get an adapter by its unique ID.
- `getForProvider` — Get the adapter registered for a specific provider.
- `hasAdapterForProvider` — Check if an adapter is registered for a given provider.
- `list` — List all registered adapters.
- `listSpawnCapable` — List adapters for providers that have spawn capability.  Queries CAAMP for spawn-capable providers and returns the corresponding registered adapters.
- `canProviderSpawn` — Check if a provider can spawn subagents.  Uses providerSupportsById to check if the provider supports the spawn.supportsSubagents capability.
- `clear` — Clear all adapter registrations.  Removes all adapters and provider mappings from the registry.

### `ProtocolEnforcer`

Main protocol enforcement class

```typescript
typeof ProtocolEnforcer
```

**Members:**

- `violations`
- `strictMode`
- `validateProtocol` — Validate protocol compliance for a manifest entry
- `validateRule` — Validate a single rule
- `checkLifecycleGate` — Check lifecycle gate prerequisites
- `recordViolation` — Record a protocol violation
- `getViolations` — Get recent violations
- `calculatePenalty` — Calculate penalty for violation severity
- `enforceProtocol` — Middleware function for domain router  Intercepts operations and validates protocol compliance before execution.
- `requiresProtocolValidation` — Determine if operation requires protocol validation
- `detectProtocol` — Detect protocol type from request/response
- `extractManifestEntry` — Extract manifest entry from response
- `setStrictMode` — Set strict mode
- `isStrictMode` — Get strict mode status

### `VerificationGate`

Main Verification Gate class  Orchestrates 4-layer validation and determines pass/fail status. Each layer must pass before proceeding to the next.

```typescript
typeof VerificationGate
```

**Members:**

- `protocolEnforcer`
- `strictMode`
- `verifyOperation` — Execute all 4 gate layers sequentially  Stops at first failure unless in advisory mode.
- `runLayer` — Run a single validation layer with timing
- `buildSuccessResult` — Build success result when all gates pass
- `buildFailureResult` — Build failure result when a gate fails
- `determineSemanticExitCode` — Determine semantic layer exit code from violations
- `determineReferentialExitCode` — Determine referential layer exit code from violations
- `determineProtocolExitCode` — Determine protocol layer exit code from violations
- `requiresValidation` — Check if an operation requires gate validation  All mutate operations require validation. Query operations skip validation for performance.
- `getLayerName` — Get human-readable layer name

### `WorkflowGateTracker`

WorkflowGateTracker  Tracks the status of all 6 workflow verification gates for a task. Implements Section 7.4 failure cascade behavior: when a gate fails, all downstream gates reset to null.   T3141

```typescript
typeof WorkflowGateTracker
```

**Members:**

- `gates`
- `getGateStatus` — Get the status of a specific gate
- `getGateState` — Get the full state of a specific gate
- `getAllGates` — Get all gate states
- `canAttempt` — Check if a gate can be attempted (all dependencies passed)
- `passGate` — Mark a gate as passed.
- `failGate` — Mark a gate as failed.  Per Section 7.4: When a gate fails, all downstream gates reset to null.
- `cascadeReset` — Reset a gate and all downstream gates to null.
- `updateBlockedStatus` — Update blocked status for all gates based on current state.
- `allPassed` — Check if all gates have passed
- `getPendingGates` — Get all gates that are currently blocked or have null status
- `getNextAttemptable` — Get the next gate that can be attempted
- `getDownstreamGates` — Get downstream gates of a given gate (not including the gate itself)
- `toRecord` — Serialize gate states to a plain record
- `fromRecord` — Restore gate states from a record
- `isValidGate` — Check if a gate name is valid

### `TaskCache`

In-memory cache for task indices with checksum-based staleness detection.

```typescript
typeof TaskCache
```

**Members:**

- `labelIndex`
- `phaseIndex`
- `parentIndex`
- `childrenIndex`
- `depthIndex`
- `checksum`
- `initialized`
- `computeChecksum` — Compute a checksum from task data for staleness detection.
- `init` — Initialize or rebuild cache from tasks. Returns true if cache was rebuilt, false if already valid.
- `buildLabelIndex`
- `buildPhaseIndex`
- `buildHierarchyIndex`
- `getTasksByLabel` — Get task IDs by label.
- `getTasksByPhase` — Get task IDs by phase.
- `getAllLabels` — Get all labels.
- `getAllPhases` — Get all phases.
- `getLabelCount` — Get label count for a specific label.
- `getParent` — Get parent ID for a task.
- `getChildren` — Get children IDs for a task.
- `getDepth` — Get depth for a task.
- `getChildCount` — Get child count.
- `getRootTasks` — Get root tasks (no parent).
- `getLeafTasks` — Get leaf tasks (no children).
- `invalidate` — Force invalidation and rebuild.
- `getStats` — Get cache statistics.

### `GraphCache`

Graph cache for expensive dependency calculations. Automatically invalidates when tasks change.

```typescript
typeof GraphCache
```

**Members:**

- `descendantsCache`
- `childrenCache`
- `dependentsCache`
- `wavesCache`
- `taskChecksum`
- `ttlMs`
- `computeChecksum` — Compute a simple checksum from task data to detect changes.
- `isValid` — Check if cache is still valid for given tasks.
- `isExpired` — Check if a cache entry has expired.
- `invalidate` — Invalidate all caches.
- `ensureFresh` — Ensure cache is fresh for the given task set.
- `getDescendants` — Get descendants of a task (cached).
- `getChildren` — Get children of a task (cached).
- `getDependents` — Get dependents of a task (cached).
- `getWaves` — Get dependency waves (cached).
- `getStats` — Get cache statistics.

## Constants

### `BOLD`

```typescript
string
```

### `DIM`

```typescript
string
```

### `NC`

```typescript
string
```

### `RED`

```typescript
string
```

### `GREEN`

```typescript
string
```

### `YELLOW`

```typescript
string
```

### `BLUE`

```typescript
string
```

### `MAGENTA`

```typescript
string
```

### `CYAN`

```typescript
string
```

### `BOX`

```typescript
{ tl: string; tr: string; bl: string; br: string; h: string; v: string; ml: string; mr: string; }
```

### `CANONICAL_DOMAINS`

The 10 canonical domain names.

```typescript
readonly ["tasks", "session", "memory", "check", "pipeline", "orchestrate", "tools", "admin", "nexus", "sticky"]
```

### `OPERATIONS`

The single source of truth for all operations in CLEO.

```typescript
OperationDef[]
```

### `STRING_TO_EXIT`

Canonical mapping from string error codes to numeric exit codes.  Source of truth: src/types/exit-codes.ts (ExitCode enum). Must stay in sync with ERROR_CODE_TO_EXIT in src/dispatch/adapters/cli.ts.

```typescript
Record<string, number>
```

### `DEFAULT_RATE_LIMITING`

Default rate limiting configuration per Section 13.3

```typescript
RateLimitingConfig
```

### `DEFAULT_LIFECYCLE_ENFORCEMENT`

Default lifecycle enforcement configuration

```typescript
LifecycleEnforcementConfig
```

### `DEFAULT_PROTOCOL_VALIDATION`

Default protocol validation configuration

```typescript
ProtocolValidationConfig
```

### `DEFAULT_CONFIG`

Default configuration values

```typescript
MCPConfig
```

### `ENV_PREFIX`

Environment variable prefix for CLEO configuration

```typescript
"CLEO_MCP_"
```

### `CONFIG_SCHEMA`

Configuration schema for validation

```typescript
{ readonly cliPath: { readonly type: "string"; readonly required: true; }; readonly timeout: { readonly type: "number"; readonly min: 1000; readonly max: 300000; }; readonly logLevel: { readonly type: "string"; readonly enum: readonly [...]; }; ... 5 more ...; readonly strictValidation: { ...; }; }
```

### `PROJECTIONS`

```typescript
Record<MviTier, ProjectionConfig>
```

### `DEFAULT_RATE_LIMITING`

```typescript
RateLimitingConfig
```

### `WARP_CHAIN_INSTANCE_STATUSES`

Chain instance status values.

```typescript
readonly ["pending", "active", "completed", "failed", "cancelled"]
```

### `warpChains`

Stored WarpChain definitions (serialized as JSON).

```typescript
SQLiteTableWithColumns<{ name: "warp_chains"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "warp_chains"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; ... 5 more ...; generated: undefined; }, {}>; ... 6 more ...; updatedAt: ...
```

### `warpChainInstances`

Runtime chain instances bound to epics.

```typescript
SQLiteTableWithColumns<{ name: "warp_chain_instances"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "warp_chain_instances"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 8 more ...; updatedAt: SQ...
```

### `TASK_PRIORITIES`

Task priorities matching DB CHECK constraint on tasks.priority.

```typescript
readonly ["critical", "high", "medium", "low"]
```

### `TASK_TYPES`

Task types matching DB CHECK constraint on tasks.type.

```typescript
readonly ["epic", "task", "subtask"]
```

### `TASK_SIZES`

Task size values matching DB CHECK constraint on tasks.size.

```typescript
readonly ["small", "medium", "large"]
```

### `LIFECYCLE_STAGE_NAMES`

Canonical lifecycle stage names matching DB CHECK constraint on lifecycle_stages.stage_name.

```typescript
readonly ["research", "consensus", "architecture_decision", "specification", "decomposition", "implementation", "validation", "testing", "release", "contribution"]
```

### `LIFECYCLE_GATE_RESULTS`

Gate result values matching DB CHECK constraint on lifecycle_gate_results.result.

```typescript
readonly ["pass", "fail", "warn"]
```

### `LIFECYCLE_EVIDENCE_TYPES`

Evidence type values matching DB CHECK constraint on lifecycle_evidence.type.

```typescript
readonly ["file", "url", "manifest"]
```

### `TOKEN_USAGE_METHODS`

Token measurement methods for central token telemetry.

```typescript
readonly ["otel", "provider_api", "tokenizer", "heuristic"]
```

### `TOKEN_USAGE_CONFIDENCE`

Confidence levels for token measurements.

```typescript
readonly ["real", "high", "estimated", "coarse"]
```

### `TOKEN_USAGE_TRANSPORTS`

Transport types for token telemetry.

```typescript
readonly ["cli", "mcp", "api", "agent", "unknown"]
```

### `tasks`

```typescript
SQLiteTableWithColumns<{ name: "tasks"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "tasks"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; ... 5 more ...; generated: undefined; }, {}>; ... 29 more ...; sessionId: SQLiteColum...
```

### `taskDependencies`

```typescript
SQLiteTableWithColumns<{ name: "task_dependencies"; schema: undefined; columns: { taskId: SQLiteColumn<{ name: string; tableName: "task_dependencies"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; dependsOn: SQLiteColumn<...>; }...
```

### `taskRelations`

```typescript
SQLiteTableWithColumns<{ name: "task_relations"; schema: undefined; columns: { taskId: SQLiteColumn<{ name: string; tableName: "task_relations"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; relatedTo: SQLiteColumn<...>; relatio...
```

### `sessions`

```typescript
SQLiteTableWithColumns<{ name: "sessions"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "sessions"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; ... 5 more ...; generated: undefined; }, {}>; ... 21 more ...; gradeMode: SQLit...
```

### `taskWorkHistory`

```typescript
SQLiteTableWithColumns<{ name: "task_work_history"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "task_work_history"; dataType: "number int53"; data: number; driverParam: number; notNull: true; hasDefault: true; ... 6 more ...; generated: undefined; }, {}>; sessionId: SQLiteColumn<...>; ...
```

### `lifecyclePipelines`

```typescript
SQLiteTableWithColumns<{ name: "lifecycle_pipelines"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "lifecycle_pipelines"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 6 more ...; version: SQLite...
```

### `lifecycleStages`

```typescript
SQLiteTableWithColumns<{ name: "lifecycle_stages"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "lifecycle_stages"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 17 more ...; provenanceChainJson:...
```

### `lifecycleGateResults`

```typescript
SQLiteTableWithColumns<{ name: "lifecycle_gate_results"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "lifecycle_gate_results"; dataType: "string"; data: string; driverParam: string; notNull: true; ... 7 more ...; generated: undefined; }, {}>; ... 6 more ...; reason: SQLiteColumn<...>; }...
```

### `lifecycleEvidence`

```typescript
SQLiteTableWithColumns<{ name: "lifecycle_evidence"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "lifecycle_evidence"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 5 more ...; description: SQLi...
```

### `lifecycleTransitions`

```typescript
SQLiteTableWithColumns<{ name: "lifecycle_transitions"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "lifecycle_transitions"; dataType: "string"; data: string; driverParam: string; notNull: true; ... 7 more ...; generated: undefined; }, {}>; ... 5 more ...; createdAt: SQLiteColumn<...>; ...
```

### `manifestEntries`

```typescript
SQLiteTableWithColumns<{ name: "manifest_entries"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "manifest_entries"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 11 more ...; createdAt: SQLiteCol...
```

### `pipelineManifest`

```typescript
SQLiteTableWithColumns<{ name: "pipeline_manifest"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "pipeline_manifest"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 12 more ...; archivedAt: SQLite...
```

### `releaseManifests`

```typescript
SQLiteTableWithColumns<{ name: "release_manifests"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "release_manifests"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 15 more ...; pushedAt: SQLiteCo...
```

### `schemaMeta`

```typescript
SQLiteTableWithColumns<{ name: "schema_meta"; schema: undefined; columns: { key: SQLiteColumn<{ name: string; tableName: "schema_meta"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; ... 5 more ...; generated: undefined; }, {}>; value: SQLiteColumn<...>; ...
```

### `auditLog`

Task change audit log — stores every add/update/complete/delete/archive operation. Migrated from legacy JSONL task logs to SQLite per ADR-006/ADR-012. No FK on taskId — log entries must survive task deletion.   T4837

```typescript
SQLiteTableWithColumns<{ name: "audit_log"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "audit_log"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; ... 5 more ...; generated: undefined; }, {}>; ... 16 more ...; projectHash: S...
```

### `tokenUsage`

Central provider-aware token telemetry for CLI, MCP, and external adapters. Stores measured request/response token counts plus method/confidence metadata.

```typescript
SQLiteTableWithColumns<{ name: "token_usage"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "token_usage"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; ... 5 more ...; generated: undefined; }, {}>; ... 19 more ...; metadataJs...
```

### `architectureDecisions`

Architecture Decision Records (ADRs) stored in the database. Corresponds to the physical ADR markdown files in .cleo/adrs/. Created by migration 20260225024442_sync-lifecycle-enums-and-arch-decisions. Self-referential FKs (supersedes_id, superseded_by_id) are enforced at the DB level by the migration; omitted here to avoid Drizzle circular-ref syntax.

```typescript
SQLiteTableWithColumns<{ name: "architecture_decisions"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "architecture_decisions"; dataType: "string"; data: string; driverParam: string; notNull: true; ... 7 more ...; generated: undefined; }, {}>; ... 16 more ...; topics: SQLiteColumn<...>; ...
```

### `adrTaskLinks`

ADR-to-Task links (soft FK — tasks can be purged)

```typescript
SQLiteTableWithColumns<{ name: "adr_task_links"; schema: undefined; columns: { adrId: SQLiteColumn<{ name: string; tableName: "adr_task_links"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; taskId: SQLiteColumn<...>; linkType: S...
```

### `adrRelations`

ADR cross-reference relationships

```typescript
SQLiteTableWithColumns<{ name: "adr_relations"; schema: undefined; columns: { fromAdrId: SQLiteColumn<{ name: string; tableName: "adr_relations"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; toAdrId: SQLiteColumn<...>; relation...
```

### `statusRegistryTable`

```typescript
SQLiteTableWithColumns<{ name: "status_registry"; schema: undefined; columns: { name: SQLiteColumn<{ name: string; tableName: "status_registry"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; entityType: SQLiteColumn<...>; namesp...
```

### `BRAIN_DECISION_TYPES`

Decision types from ADR-009.

```typescript
readonly ["architecture", "technical", "process", "strategic", "tactical"]
```

### `BRAIN_CONFIDENCE_LEVELS`

Confidence levels for decisions.

```typescript
readonly ["low", "medium", "high"]
```

### `BRAIN_OUTCOME_TYPES`

Outcome types for decision tracking.

```typescript
readonly ["success", "failure", "mixed", "pending"]
```

### `BRAIN_PATTERN_TYPES`

Pattern types for workflow analysis.

```typescript
readonly ["workflow", "blocker", "success", "failure", "optimization"]
```

### `BRAIN_IMPACT_LEVELS`

Impact levels for patterns.

```typescript
readonly ["low", "medium", "high"]
```

### `BRAIN_LINK_TYPES`

Link types for cross-referencing BRAIN entries with tasks.

```typescript
readonly ["produced_by", "applies_to", "informed_by", "contradicts"]
```

### `BRAIN_OBSERVATION_TYPES`

Observation types for claude-mem compatible observations.

```typescript
readonly ["discovery", "change", "feature", "bugfix", "decision", "refactor"]
```

### `BRAIN_OBSERVATION_SOURCE_TYPES`

Source types for observations (how the observation was created).

```typescript
readonly ["agent", "session-debrief", "claude-mem", "manual"]
```

### `BRAIN_MEMORY_TYPES`

Memory entity types for the links table.

```typescript
readonly ["decision", "pattern", "learning", "observation"]
```

### `BRAIN_STICKY_STATUSES`

Sticky note status values.

```typescript
readonly ["active", "converted", "archived"]
```

### `BRAIN_STICKY_COLORS`

Sticky note colors.

```typescript
readonly ["yellow", "blue", "green", "red", "purple"]
```

### `BRAIN_STICKY_PRIORITIES`

Sticky note priority levels.

```typescript
readonly ["low", "medium", "high"]
```

### `brainDecisions`

```typescript
SQLiteTableWithColumns<{ name: "brain_decisions"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "brain_decisions"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 10 more ...; updatedAt: SQLiteColum...
```

### `brainPatterns`

```typescript
SQLiteTableWithColumns<{ name: "brain_patterns"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "brain_patterns"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 10 more ...; updatedAt: SQLiteColumn<...
```

### `brainLearnings`

```typescript
SQLiteTableWithColumns<{ name: "brain_learnings"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "brain_learnings"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 7 more ...; updatedAt: SQLiteColumn...
```

### `brainObservations`

General-purpose observations — replaces claude-mem's observations table.

```typescript
SQLiteTableWithColumns<{ name: "brain_observations"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "brain_observations"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 14 more ...; updatedAt: SQLit...
```

### `brainStickyNotes`

Ephemeral sticky notes for quick capture before formal classification.

```typescript
SQLiteTableWithColumns<{ name: "brain_sticky_notes"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "brain_sticky_notes"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 8 more ...; sourceType: SQLit...
```

### `brainMemoryLinks`

Cross-references between BRAIN entries and tasks in tasks.db.

```typescript
SQLiteTableWithColumns<{ name: "brain_memory_links"; schema: undefined; columns: { memoryType: SQLiteColumn<{ name: string; tableName: "brain_memory_links"; dataType: "string enum"; data: "decision" | "pattern" | "learning" | "observation"; ... 9 more ...; generated: undefined; }, {}>; memoryId: SQLiteColumn<...>; t...
```

### `brainSchemaMeta`

```typescript
SQLiteTableWithColumns<{ name: "brain_schema_meta"; schema: undefined; columns: { key: SQLiteColumn<{ name: string; tableName: "brain_schema_meta"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; value: SQLiteColumn<...>; }; diale...
```

### `BRAIN_NODE_TYPES`

Node types for PageIndex graph.

```typescript
readonly ["task", "doc", "file", "concept"]
```

### `BRAIN_EDGE_TYPES`

Edge types for PageIndex graph.

```typescript
readonly ["depends_on", "relates_to", "implements", "documents"]
```

### `brainPageNodes`

Documents/concepts as graph nodes for cross-document linking.

```typescript
SQLiteTableWithColumns<{ name: "brain_page_nodes"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "brain_page_nodes"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; nodeType: SQLiteColumn<...>; label: S...
```

### `brainPageEdges`

Directed links between graph nodes.

```typescript
SQLiteTableWithColumns<{ name: "brain_page_edges"; schema: undefined; columns: { fromId: SQLiteColumn<{ name: string; tableName: "brain_page_edges"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; toId: SQLiteColumn<...>; edgeType...
```

### `BRAIN_SCHEMA_VERSION`

Schema version for newly created brain databases. Single source of truth.

```typescript
"1.0.0"
```

### `projectRegistry`

Central registry of all CLEO projects known to the Nexus.

```typescript
SQLiteTableWithColumns<{ name: "project_registry"; schema: undefined; columns: { projectId: SQLiteColumn<{ name: string; tableName: "project_registry"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 10 more ...; labelsJson: S...
```

### `nexusAuditLog`

Append-only audit log for all Nexus operations across projects.

```typescript
SQLiteTableWithColumns<{ name: "nexus_audit_log"; schema: undefined; columns: { id: SQLiteColumn<{ name: string; tableName: "nexus_audit_log"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; ... 13 more ...; errorMessage: SQLiteCo...
```

### `nexusSchemaMeta`

Key-value store for nexus.db schema versioning and metadata.

```typescript
SQLiteTableWithColumns<{ name: "nexus_schema_meta"; schema: undefined; columns: { key: SQLiteColumn<{ name: string; tableName: "nexus_schema_meta"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; ... 6 more ...; generated: undefined; }, {}>; value: SQLiteColumn<...>; }; diale...
```

### `NEXUS_SCHEMA_VERSION`

Schema version for newly created nexus databases. Single source of truth.

```typescript
"1.0.0"
```

### `SQLITE_SCHEMA_VERSION`

Schema version for newly created databases. Single source of truth.

```typescript
"2.0.0"
```

### `ERROR_CATALOG`

The unified error catalog. Keyed by numeric ExitCode value.

```typescript
ReadonlyMap<number, ErrorDefinition>
```

### `INTERNAL_HOOK_EVENTS`

CLEO-local coordination events used by the autonomous runtime.  These are internal lifecycle signals for worker orchestration and are not surfaced through CAAMP's provider capability registry.

```typescript
readonly ["onWorkAvailable", "onAgentSpawn", "onAgentComplete", "onCascadeStart", "onPatrol"]
```

### `CLEO_TO_CAAMP_HOOK_MAP`

Mapping from CLEO internal lifecycle events to CAAMP hook events This is where CLEO connects its lifecycle to CAAMP's event definitions

```typescript
{ readonly 'session.start': "onSessionStart"; readonly 'session.end': "onSessionEnd"; readonly 'task.start': "onToolStart"; readonly 'task.complete': "onToolComplete"; readonly 'file.change': "onFileChange"; readonly 'system.error': "onError"; readonly 'prompt.submit': "onPromptSubmit"; readonly 'response.complete':...
```

### `CLEO_INTERNAL_HOOK_MAP`

Internal CLEO lifecycle events that drive autonomous coordination.

```typescript
{ readonly 'agent.work.available': "onWorkAvailable"; readonly 'agent.spawn': "onAgentSpawn"; readonly 'agent.complete': "onAgentComplete"; readonly 'cascade.start': "onCascadeStart"; readonly 'watcher.patrol': "onPatrol"; }
```

### `hooks`

Singleton instance of the HookRegistry.  Use this instance for all hook operations throughout the application.

```typescript
HookRegistry
```

### `PIPELINE_STAGES`

```typescript
readonly ["research", "consensus", "architecture_decision", "specification", "decomposition", "implementation", "validation", "testing", "release"]
```

### `CONTRIBUTION_STAGE`

Cross-cutting contribution stage. Not part of the pipeline execution order, but tracked in the schema for attribution and provenance recording.   T4800

```typescript
"contribution"
```

### `STAGE_DEFINITIONS`

Canonical stage definitions with complete metadata.   T4800  T4799 - Replaces legacy STAGE_DEFINITIONS from index.ts

```typescript
Record<"research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", StageDefinition>
```

### `STAGE_ORDER`

Stage order mapping for quick lookups.   T4800

```typescript
Record<"research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", number>
```

### `STAGE_PREREQUISITES`

Prerequisites for each stage - which stages must be completed before entering.   T4800  T4799 - Canonical prerequisite map

```typescript
Record<"research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release", ("research" | "consensus" | ... 6 more ... | "release")[]>
```

### `TRANSITION_RULES`

Allowed transitions between stages.  By default, stages progress linearly. These rules define exceptions.   T4800

```typescript
TransitionRule[]
```

### `STAGE_COUNT`

Total number of stages in the pipeline.   T4800

```typescript
9
```

### `FIRST_STAGE`

First stage in the pipeline.   T4800

```typescript
"research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release"
```

### `LAST_STAGE`

Last stage in the pipeline.   T4800

```typescript
"research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release"
```

### `PLANNING_STAGES`

Planning stages.   T4800

```typescript
("research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release")[]
```

### `DECISION_STAGES`

Decision stages.   T4800

```typescript
("research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release")[]
```

### `EXECUTION_STAGES`

Execution stages (canonical).   T4800

```typescript
("research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release")[]
```

### `VALIDATION_STAGES`

Validation stages.   T4800

```typescript
("research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release")[]
```

### `DELIVERY_STAGES`

Delivery stages.   T4800

```typescript
("research" | "consensus" | "architecture_decision" | "specification" | "decomposition" | "implementation" | "validation" | "testing" | "release")[]
```

### `THRESHOLDS`

Context alert thresholds (percentage of context window).

```typescript
{ readonly WARNING: 70; readonly CAUTION: 85; readonly CRITICAL: 90; readonly EMERGENCY: 95; }
```

### `ENFORCEMENT_PROFILES`

```typescript
{ readonly 'llm-agent-first': { readonly maxSiblings: 0; readonly maxActiveSiblings: 0; readonly maxDepth: 3; readonly countDoneInLimit: false; }; readonly 'human-cognitive': { readonly maxSiblings: 7; readonly maxActiveSiblings: 3; readonly maxDepth: 3; readonly countDoneInLimit: false; }; }
```

### `VALID_PRIORITIES`

Valid string priority values.

```typescript
readonly TaskPriority[]
```

### `MUTATE_OPERATIONS`

Mutate operation matrix - all write operations by domain.  DERIVED from the dispatch registry — single source of truth. Contains canonical domains.  Reference: MCP-SERVER-SPECIFICATION.md Section 2.2.2

```typescript
Record<string, string[]>
```

### `QUERY_OPERATIONS`

Query operation matrix - all read operations by domain.  DERIVED from the dispatch registry — single source of truth. Contains canonical domains only.  Reference: MCP-SERVER-SPECIFICATION.md Section 2.1.2

```typescript
Record<string, string[]>
```

### `getAllProviders`

```typescript
Mock<() => never[]>
```

### `getProvider`

```typescript
Mock<() => null>
```

### `resolveAlias`

```typescript
Mock<(alias: string) => string>
```

### `detectAllProviders`

```typescript
Mock<() => never[]>
```

### `getInstalledProviders`

```typescript
Mock<() => never[]>
```

### `getProviderCount`

```typescript
Mock<() => number>
```

### `getRegistryVersion`

```typescript
Mock<() => string>
```

### `getInstructionFiles`

```typescript
Mock<() => never[]>
```

### `getProvidersByHookEvent`

```typescript
Mock<() => never[]>
```

### `getCommonHookEvents`

```typescript
Mock<() => never[]>
```

### `installMcpServer`

```typescript
Mock<() => Promise<{ installed: boolean; }>>
```

### `listMcpServers`

```typescript
Mock<() => Promise<never[]>>
```

### `listAllMcpServers`

```typescript
Mock<() => Promise<never[]>>
```

### `removeMcpServer`

```typescript
Mock<() => Promise<boolean>>
```

### `resolveConfigPath`

```typescript
Mock<() => null>
```

### `buildServerConfig`

```typescript
Mock<() => {}>
```

### `inject`

```typescript
Mock<() => Promise<string>>
```

### `checkInjection`

```typescript
Mock<() => Promise<{ injected: boolean; }>>
```

### `checkAllInjections`

```typescript
Mock<() => Promise<never[]>>
```

### `injectAll`

```typescript
Mock<() => Promise<Map<any, any>>>
```

### `generateInjectionContent`

```typescript
Mock<() => string>
```

### `installBatchWithRollback`

```typescript
Mock<() => Promise<{ success: boolean; results: never[]; rolledBack: boolean; }>>
```

### `configureProviderGlobalAndProject`

```typescript
Mock<() => Promise<{ global: { success: boolean; }; project: { success: boolean; }; }>>
```

### `getCanonicalSkillsDir`

```typescript
Mock<() => string>
```

### `parseSkillFile`

```typescript
Mock<() => Promise<null>>
```

### `discoverSkill`

```typescript
Mock<() => Promise<null>>
```

### `discoverSkills`

```typescript
Mock<() => Promise<never[]>>
```

### `getTrackedSkills`

```typescript
Mock<() => Promise<{}>>
```

### `recordSkillInstall`

```typescript
Mock<() => Promise<void>>
```

### `removeSkillFromLock`

```typescript
Mock<() => Promise<boolean>>
```

### `checkSkillUpdate`

```typescript
Mock<() => Promise<{ needsUpdate: boolean; }>>
```

### `catalog`

```typescript
{ getSkills: Mock<() => never[]>; listSkills: Mock<() => never[]>; getSkill: Mock<() => undefined>; getCoreSkills: Mock<() => never[]>; getSkillsByCategory: Mock<() => never[]>; ... 20 more ...; getLibraryRoot: Mock<...>; }
```

### `fixtures`

Test Fixtures

```typescript
{ task: (overrides?: Partial<Task> | undefined) => Task; minimalTask: (overrides?: Partial<MinimalTask> | undefined) => MinimalTask; session: (overrides?: any) => any; epic: (overrides?: Partial<...> | undefined) => Task; }
```

### `assertions`

Assertion helpers

```typescript
{ assertResponseMetadata(response: any, domain: string, operation: string): void; assertErrorResponse(response: any, expectedCode: string): void; assertSuccessResponse(response: any): void; }
```

### `mocks`

Mock builders for common test scenarios

```typescript
{ taskCreation: (taskId?: string) => ExecutorResult<Task>; taskNotFound: (taskId: string) => ExecutorResult<never>; validationError: (field: string) => ExecutorResult<...>; sessionStart: (sessionId?: string) => ExecutorResult<...>; emptyList: () => ExecutorResult<...>; internalError: () => ExecutorResult<...>; }
```

### `rcasdStates`

RCASD-IVTR+C Pipeline States

```typescript
{ noRCASD: { epicId: string; manifest: null; }; researchOnly: { epicId: string; manifest: { research: string; consensus: string; specification: string; decomposition: string; }; }; researchAndConsensus: { ...; }; upToSpecification: { ...; }; completeRCASD: { ...; }; consensusSkipped: { ...; }; specificationFailed: {...
```

### `ivtrStates`

IVTR Pipeline States

```typescript
{ implementationOnly: { epicId: string; manifest: { research: string; consensus: string; architecture_decision: string; specification: string; decomposition: string; implementation: string; validation: string; testing: string; release: string; }; }; validationComplete: { ...; }; readyForRelease: { ...; }; releaseCom...
```

### `gateFailures`

Gate Failure Scenarios

```typescript
{ skipToImplementation: { epicId: string; targetStage: string; currentManifest: null; expectedResult: { passed: boolean; missingPrerequisites: string[]; exitCode: number; }; }; consensusWithoutResearch: { ...; }; decompositionWithoutSpec: { ...; }; validationWithoutImplementation: { ...; }; releaseWithoutTesting: { ...
```

### `gateSuccesses`

Gate Success Scenarios

```typescript
{ researchToConsensus: { epicId: string; targetStage: string; currentManifest: { research: string; }; expectedResult: { passed: boolean; missingPrerequisites: never[]; }; }; withSkippedStage: { epicId: string; targetStage: string; currentManifest: { ...; }; expectedResult: { ...; }; }; completeRCASDToImplementation:...
```

### `enforcementModes`

Enforcement Mode Scenarios

```typescript
{ strict: { mode: string; gateFailure: { epicId: string; targetStage: string; currentManifest: null; expectedResult: { passed: boolean; missingPrerequisites: string[]; exitCode: number; }; }; expectedBehavior: string; }; advisory: { ...; }; off: { ...; }; }
```

### `bypassScenarios`

Gate Bypass Scenarios (emergency use only)

```typescript
{ configBypass: { epicId: string; targetStage: string; currentManifest: null; config: { lifecycleEnforcement: { mode: string; }; }; expectedResult: { passed: boolean; bypassUsed: boolean; }; }; stageSkip: { ...; }; }
```

### `lifecycleScenarios`

Combined lifecycle scenario export

```typescript
{ rcasd: { noRCASD: { epicId: string; manifest: null; }; researchOnly: { epicId: string; manifest: { research: string; consensus: string; specification: string; decomposition: string; }; }; researchAndConsensus: { ...; }; upToSpecification: { ...; }; completeRCASD: { ...; }; consensusSkipped: { ...; }; specification...
```

### `researchViolations`

Research Protocol Fixtures (Exit Code 60)

```typescript
{ codeModified: { manifestEntry: { id: string; file: string; date: string; title: string; status: string; agent_type: string; key_findings: string[]; linked_tasks: string[]; }; additionalData: { hasCodeChanges: boolean; }; }; insufficientFindings: { ...; }; wrongAgentType: { ...; }; missingLinkedTasks: { ...; }; val...
```

### `consensusViolations`

Consensus Protocol Fixtures (Exit Code 61)

```typescript
{ tooFewOptions: { manifestEntry: { id: string; file: string; date: string; status: string; agent_type: string; }; additionalData: { votingMatrix: { options: { confidence: number; }[]; }; }; }; invalidConfidence: { ...; }; thresholdNotMet: { ...; }; noEscalation: { ...; }; valid: { ...; }; }
```

### `specificationViolations`

Specification Protocol Fixtures (Exit Code 62)

```typescript
{ missingRFC2119: { manifestEntry: { id: string; file: string; date: string; status: string; agent_type: string; version: string; }; additionalData: { fileContent: string; }; }; missingVersion: { manifestEntry: { ...; }; additionalData: { ...; }; }; valid: { ...; }; }
```

### `decompositionViolations`

Decomposition Protocol Fixtures (Exit Code 63)

```typescript
{ depthExceeded: { manifestEntry: { id: string; file: string; date: string; status: string; agent_type: string; }; additionalData: { hierarchyDepth: number; }; }; tooManySiblings: { manifestEntry: { ...; }; additionalData: { ...; }; }; timeEstimates: { ...; }; valid: { ...; }; }
```

### `implementationViolations`

Implementation Protocol Fixtures (Exit Code 64)

```typescript
{ missingProvenanceTags: { manifestEntry: { id: string; file: string; date: string; status: string; agent_type: string; }; additionalData: { hasNewFunctions: boolean; hasProvenanceTags: boolean; }; }; wrongAgentType: { ...; }; valid: { ...; }; }
```

### `releaseViolations`

Release Protocol Fixtures (Exit Code 66)

```typescript
{ invalidSemver: { manifestEntry: { id: string; file: string; date: string; status: string; agent_type: string; }; additionalData: { version: string; changelogEntry: string; }; }; missingChangelog: { ...; }; valid: { ...; }; }
```

### `validationViolations`

Validation Protocol Fixtures (Exit Code 68)

```typescript
{ missingValidationResult: { manifestEntry: { id: string; file: string; date: string; status: string; agent_type: string; }; additionalData: {}; }; invalidStatus: { manifestEntry: { id: string; file: string; date: string; status: string; agent_type: string; validation_result: string; }; additionalData: {}; }; valid:...
```

### `testingViolations`

Testing Protocol Fixtures (Exit Codes 69/70)

```typescript
{ failingTests: { manifestEntry: { id: string; file: string; date: string; status: string; agent_type: string; key_findings: string[]; }; additionalData: { testResults: { pass_rate: number; }; }; }; missingTestSummary: { ...; }; valid: { ...; }; }
```

### `contributionViolations`

Contribution Protocol Fixtures (Exit Code 65)

```typescript
{ invalidCommitMessage: { manifestEntry: { id: string; file: string; date: string; status: string; agent_type: string; }; additionalData: { commitMessage: string; hasNewFunctions: boolean; }; }; validationNotPassed: { ...; }; valid: { ...; }; }
```

### `protocolFixtures`

Combined fixture export

```typescript
{ research: { codeModified: { manifestEntry: { id: string; file: string; date: string; title: string; status: string; agent_type: string; key_findings: string[]; linked_tasks: string[]; }; additionalData: { ...; }; }; insufficientFindings: { ...; }; wrongAgentType: { ...; }; missingLinkedTasks: { ...; }; valid: { .....
```

### `VALID_DOMAINS`

Known enum values for CLEO domains

```typescript
readonly ["tasks", "session", "orchestrate", "research", "lifecycle", "validate", "release", "system"]
```

### `VALID_GATEWAYS`

```typescript
readonly ["query", "mutate"]
```

### `VALID_MANIFEST_STATUSES`

```typescript
readonly ["completed", "partial", "blocked", "archived"]
```

### `VALID_LIFECYCLE_STAGE_STATUSES`

```typescript
readonly ["not_started", "in_progress", "blocked", "completed", "skipped", "failed"]
```

### `ALL_VALID_STATUSES`

```typescript
readonly ["pending", "active", "blocked", "done", "cancelled", "archived", "completed", "partial", "blocked", "archived"]
```

### `VALID_PRIORITIES`

```typescript
readonly ["critical", "high", "medium", "low"]
```

### `DEFAULT_RATE_LIMITS`

Default rate limit configurations per operation type

```typescript
Record<string, RateLimitConfig>
```

### `TASK_STATUSES`

```typescript
readonly ["pending", "active", "blocked", "done", "cancelled", "archived"]
```

### `SESSION_STATUSES`

```typescript
readonly ["active", "ended", "orphaned", "suspended"]
```

### `LIFECYCLE_PIPELINE_STATUSES`

```typescript
readonly ["active", "completed", "blocked", "failed", "cancelled", "aborted"]
```

### `LIFECYCLE_STAGE_STATUSES`

```typescript
readonly ["not_started", "in_progress", "blocked", "completed", "skipped", "failed"]
```

### `ADR_STATUSES`

```typescript
readonly ["proposed", "accepted", "superseded", "deprecated"]
```

### `GATE_STATUSES`

```typescript
readonly ["pending", "passed", "failed", "waived"]
```

### `MANIFEST_STATUSES`

```typescript
readonly ["completed", "partial", "blocked", "archived"]
```

### `TERMINAL_TASK_STATUSES`

```typescript
ReadonlySet<"cancelled" | "pending" | "active" | "blocked" | "done" | "archived">
```

### `TERMINAL_PIPELINE_STATUSES`

```typescript
ReadonlySet<"completed" | "failed" | "cancelled" | "active" | "blocked" | "aborted">
```

### `TERMINAL_STAGE_STATUSES`

```typescript
ReadonlySet<"completed" | "failed" | "blocked" | "not_started" | "in_progress" | "skipped">
```

### `STATUS_REGISTRY`

```typescript
Record<EntityType, readonly string[]>
```

### `PIPELINE_STATUS_ICONS`

Pipeline status → Unicode progress icon. Used wherever lifecycle pipeline status is rendered to a terminal.

```typescript
Record<"completed" | "failed" | "cancelled" | "active" | "blocked" | "aborted", string>
```

### `STAGE_STATUS_ICONS`

Stage status → Unicode progress icon. Used wherever pipeline stage status is rendered to a terminal.

```typescript
Record<"completed" | "failed" | "blocked" | "not_started" | "in_progress" | "skipped", string>
```

### `TASK_STATUS_SYMBOLS_UNICODE`

Task status → Unicode symbol (rich terminal / Unicode-enabled). Falls back to TASK_STATUS_SYMBOLS_ASCII when Unicode is unavailable.

```typescript
Record<"cancelled" | "pending" | "active" | "blocked" | "done" | "archived", string>
```

### `TASK_STATUS_SYMBOLS_ASCII`

Task status → ASCII fallback symbol (non-Unicode terminals, CI output).

```typescript
Record<"cancelled" | "pending" | "active" | "blocked" | "done" | "archived", string>
```

### `EMBEDDING_DIMENSIONS`

Matches the brain_embeddings vec0 table: FLOAT[384].

```typescript
384
```

### `REQUIRED_CLEO_SUBDIRS`

Required subdirectories under .cleo/.

```typescript
readonly ["backups/operational", "backups/safety", "agent-outputs", "logs", "rcasd", "adrs"]
```

### `CLEO_GITIGNORE_FALLBACK`

Embedded fallback for .cleo/.gitignore content (deny-by-default).

```typescript
"# .cleo/.gitignore — Deny-by-default for CLEO project data\n# Ignore everything, then explicitly allow only tracked files.\n\n# Step 1: Ignore everything\n*\n\n# Allow list\n!.gitignore\n!config.json\n!project-context.json\n!project-info.json\n!setup-otel.sh\n!DATA-SAFETY-IMPLEMENTATION-SUMMARY.md\n!adrs/\n!adrs/**...
```

### `REQUIRED_GLOBAL_SUBDIRS`

Required subdirectories under the global ~/.cleo/ home. These are infrastructure directories managed by CLEO itself, not project-specific data.

```typescript
readonly ["schemas", "templates"]
```

### `MANAGED_HOOKS`

Git hooks managed by CLEO.

```typescript
readonly ["commit-msg", "pre-commit"]
```

### `SUPPORTED_PLATFORMS`

All supported platforms.

```typescript
CIPlatform[]
```

### `CORE_PROTECTED_FILES`

Configuration files relative to .cleo/ that MUST remain tracked by project git. These are JSON/text config files only — NOT databases. SQLite databases (tasks.db) are excluded: they must be gitignored to prevent data-loss from merge conflicts (see ADR-013).  If any of these files are gitignored, cleo doctor reports a critical finding.

```typescript
readonly ["config.json", ".gitignore", "project-info.json", "project-context.json"]
```

### `BUILD_CONFIG`

BUILD CONFIGURATION - AUTO-GENERATED FILE  This file is generated by dev/generate-build-config.js DO NOT EDIT MANUALLY - Changes will be overwritten on next build  Source of truth: package.json Generated at: 2026-03-18T09:06:32.935Z   T5245 auto-generated

```typescript
{ readonly name: "@cleocode/cleo"; readonly version: "2026.3.36"; readonly description: "CLEO V2 - TypeScript task management CLI for AI coding agents"; readonly repository: { readonly owner: "kryptobaseddev"; readonly name: "cleo"; readonly fullName: "kryptobaseddev/cleo"; readonly url: "https://github.com/kryptoba...
```

### `PINO_LEVEL_VALUES`

Numeric pino level values for comparison.

```typescript
Record<PinoLevel, number>
```

### `VALID_DOMAINS`

Known enum values for CLEO domains

```typescript
readonly ["tasks", "session", "orchestrate", "research", "lifecycle", "validate", "release", "system"]
```

### `VALID_GATEWAYS`

```typescript
readonly ["query", "mutate"]
```

### `VALID_MANIFEST_STATUSES`

```typescript
readonly ["completed", "partial", "blocked", "archived"]
```

### `VALID_LIFECYCLE_STAGE_STATUSES`

```typescript
readonly ["not_started", "in_progress", "blocked", "completed", "skipped", "failed"]
```

### `ALL_VALID_STATUSES`

```typescript
readonly ["pending", "active", "blocked", "done", "cancelled", "archived", "completed", "partial", "blocked", "archived"]
```

### `VALID_PRIORITIES`

```typescript
readonly ["critical", "high", "medium", "low"]
```

### `DEFAULT_RATE_LIMITS`

Default rate limit configurations per operation type

```typescript
Record<string, RateLimitConfig>
```

### `SKILL_NAME_MAP`

Canonical skill name mapping (user-friendly to ct-prefixed).

```typescript
Record<string, string>
```

### `spawnRegistry`

Singleton registry instance.  Use this instance for all spawn adapter registration and lookup operations.

```typescript
SpawnAdapterRegistry
```

### `PLATFORM`

Cached platform value.

```typescript
Platform
```

### `MINIMUM_NODE_MAJOR`

Minimum required Node.js major version.

```typescript
24
```

### `getTaskHistory`

Get task work history (canonical verb alias for dispatch layer).  T5323

```typescript
(cwd?: string | undefined, accessor?: DataAccessor | undefined) => Promise<TaskWorkHistoryEntry[]>
```

### `ALIASES_VERSION`

Current alias version.

```typescript
"1.0.0"
```

### `INJECTION_VALIDATION_KEYS`

Validation key names for JSON output. Maps target filenames to JSON-safe key names used in validation results.

```typescript
Readonly<Record<string, string>>
```

### `CACHE_VERSION`

```typescript
"1.0.0"
```

### `CACHE_TTL_SECONDS`

```typescript
300
```

### `VALID_OPERATIONS`

```typescript
readonly ["create", "update", "complete", "archive", "restore", "delete", "validate", "backup"]
```

### `FIELD_LIMITS`

Field length limits matching the Bash implementation.

```typescript
{ readonly MAX_TITLE_LENGTH: 120; readonly MAX_DESCRIPTION_LENGTH: 2000; readonly MAX_NOTE_LENGTH: 5000; readonly MAX_BLOCKED_BY_LENGTH: 300; readonly MAX_SESSION_NOTE_LENGTH: 2500; readonly MIN_CANCEL_REASON_LENGTH: 5; readonly MAX_CANCEL_REASON_LENGTH: 300; }
```

### `VAL_SUCCESS`

Validation result exit codes.

```typescript
0
```

### `VAL_SCHEMA_ERROR`

```typescript
1
```

### `VAL_SEMANTIC_ERROR`

```typescript
2
```

### `VAL_BOTH_ERRORS`

```typescript
3
```

### `VERIFICATION_GATE_ORDER`

```typescript
readonly ["implemented", "testsPassed", "qaPassed", "cleanupDone", "securityPassed", "documented"]
```

### `VERIFICATION_VALID_AGENTS`

```typescript
readonly ["planner", "coder", "testing", "qa", "cleanup", "security", "docs"]
```

### `PROTOCOL_RULES`

Protocol rule registry

```typescript
Record<string, ProtocolRule[]>
```

### `protocolEnforcer`

Default protocol enforcer instance

```typescript
ProtocolEnforcer
```

### `PROTOCOL_TYPES`

All supported protocol types.

```typescript
readonly ["research", "consensus", "specification", "decomposition", "implementation", "contribution", "release", "artifact-publish", "provenance"]
```

### `PROTOCOL_EXIT_CODES`

Map protocol types to exit codes.

```typescript
Record<"research" | "consensus" | "specification" | "decomposition" | "implementation" | "release" | "contribution" | "provenance" | "artifact-publish", ExitCode>
```

### `DEFAULT_CHAIN_ID`

```typescript
"rcasd-ivtrc"
```

### `DEFAULT_PROTOCOL_STAGE_MAP`

Stage mapping for protocol validation gates in the default chain.  `contribution` is cross-cutting and is validated at implementation. `artifact-publish` and `provenance` are validated at release.   T5419

```typescript
Record<"research" | "consensus" | "specification" | "decomposition" | "implementation" | "release" | "contribution" | "provenance" | "artifact-publish", "research" | "consensus" | ... 6 more ... | "release">
```

### `insertTaskSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "tasks"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; hasRuntimeDefault: false; enumValues: [...]; baseColumn: never; identity: undefined; generated: undefined; ...
```

### `selectTaskSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "tasks"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; hasRuntimeDefault: false; enumValues: [...]; baseColumn: never; identity: undefined; generated: undefined; ...
```

### `insertTaskDependencySchema`

```typescript
BuildSchema<"insert", { taskId: SQLiteColumn<{ name: string; tableName: "task_dependencies"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: false; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; dependsOn: SQLiteColumn<...>; }, undefined, ...
```

### `selectTaskDependencySchema`

```typescript
BuildSchema<"select", { taskId: SQLiteColumn<{ name: string; tableName: "task_dependencies"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: false; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; dependsOn: SQLiteColumn<...>; }, undefined, ...
```

### `insertTaskRelationSchema`

```typescript
BuildSchema<"insert", { taskId: SQLiteColumn<{ name: string; tableName: "task_relations"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: false; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; relatedTo: SQLiteColumn<...>; relationType: SQL...
```

### `selectTaskRelationSchema`

```typescript
BuildSchema<"select", { taskId: SQLiteColumn<{ name: string; tableName: "task_relations"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: false; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; relatedTo: SQLiteColumn<...>; relationType: SQL...
```

### `insertSessionSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "sessions"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; hasRuntimeDefault: false; enumValues: [...]; baseColumn: never; identity: undefined; generated: undefine...
```

### `selectSessionSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "sessions"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; hasRuntimeDefault: false; enumValues: [...]; baseColumn: never; identity: undefined; generated: undefine...
```

### `insertWorkHistorySchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "task_work_history"; dataType: "number int53"; data: number; driverParam: number; notNull: true; hasDefault: true; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; sessionId: SQLiteColumn<...>; taskId: SQLite...
```

### `selectWorkHistorySchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "task_work_history"; dataType: "number int53"; data: number; driverParam: number; notNull: true; hasDefault: true; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; sessionId: SQLiteColumn<...>; taskId: SQLite...
```

### `insertLifecyclePipelineSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_pipelines"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 6 more ...; version: SQLiteColumn<...>; }, ...
```

### `selectLifecyclePipelineSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_pipelines"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 6 more ...; version: SQLiteColumn<...>; }, ...
```

### `insertLifecycleStageSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_stages"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 17 more ...; provenanceChainJson: SQLiteColumn...
```

### `selectLifecycleStageSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_stages"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 17 more ...; provenanceChainJson: SQLiteColumn...
```

### `insertLifecycleGateResultSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_gate_results"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 6 more ...; reason: SQLiteColumn<...>; }...
```

### `selectLifecycleGateResultSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_gate_results"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 6 more ...; reason: SQLiteColumn<...>; }...
```

### `insertLifecycleEvidenceSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_evidence"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 5 more ...; description: SQLiteColumn<...>; ...
```

### `selectLifecycleEvidenceSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_evidence"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 5 more ...; description: SQLiteColumn<...>; ...
```

### `insertLifecycleTransitionSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_transitions"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 5 more ...; createdAt: SQLiteColumn<...>;...
```

### `selectLifecycleTransitionSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "lifecycle_transitions"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 5 more ...; createdAt: SQLiteColumn<...>;...
```

### `insertSchemaMetaSchema`

```typescript
BuildSchema<"insert", { key: SQLiteColumn<{ name: string; tableName: "schema_meta"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; value: SQLiteColumn<...>; }, undefined, CoerceOptions>
```

### `selectSchemaMetaSchema`

```typescript
BuildSchema<"select", { key: SQLiteColumn<{ name: string; tableName: "schema_meta"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; value: SQLiteColumn<...>; }, undefined, CoerceOptions>
```

### `insertAuditLogSchema`

Zod schema for validating audit log insert payloads.  T4848

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "audit_log"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 16 more ...; projectHash: SQLiteColumn<...>; }, { ......
```

### `AuditLogInsertSchema`

Canonical named export for audit log insert schema (T4848). Alias for insertAuditLogSchema.

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "audit_log"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 16 more ...; projectHash: SQLiteColumn<...>; }, { ......
```

### `selectAuditLogSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "audit_log"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 16 more ...; projectHash: SQLiteColumn<...>; }, undef...
```

### `AuditLogSelectSchema`

Canonical named export for audit log select schema (T4848). Alias for selectAuditLogSchema.

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "audit_log"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 16 more ...; projectHash: SQLiteColumn<...>; }, undef...
```

### `insertArchitectureDecisionSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "architecture_decisions"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 16 more ...; topics: SQLiteColumn<...>; ...
```

### `selectArchitectureDecisionSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "architecture_decisions"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 16 more ...; topics: SQLiteColumn<...>; ...
```

### `insertTokenUsageSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "token_usage"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 19 more ...; metadataJson: SQLiteColumn<...>; }, un...
```

### `selectTokenUsageSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "token_usage"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 19 more ...; metadataJson: SQLiteColumn<...>; }, un...
```

### `insertManifestEntrySchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "manifest_entries"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 11 more ...; createdAt: SQLiteColumn<...>; }, ...
```

### `selectManifestEntrySchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "manifest_entries"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 11 more ...; createdAt: SQLiteColumn<...>; }, ...
```

### `GATE_SEQUENCE`

Export gate layer sequence for external use

```typescript
readonly [GateLayer.SCHEMA, GateLayer.SEMANTIC, GateLayer.REFERENTIAL, GateLayer.PROTOCOL]
```

### `WORKFLOW_GATE_DEFINITIONS`

Complete workflow gate definitions per Section 7.2

```typescript
WorkflowGateDefinition[]
```

### `WORKFLOW_GATE_SEQUENCE`

Ordered workflow gate sequence per Section 7.1

```typescript
WorkflowGateName[]
```

### `GATE_VALIDATION_RULES`

Validation rule definitions for reuse

```typescript
{ TASK_ID_PATTERN: RegExp; MANIFEST_ID_PATTERN: RegExp; DATE_FORMAT_PATTERN: RegExp; TITLE_MIN_LENGTH: number; TITLE_MAX_LENGTH: number; DESCRIPTION_MIN_LENGTH: number; ... 10 more ...; KEY_FINDINGS_MAX: number; }
```

### `VALID_WORKFLOW_AGENTS`

Valid workflow gate agent names per Section 7.2

```typescript
readonly ["coder", "testing", "qa", "cleanup", "security", "docs"]
```

### `VALID_WORKFLOW_GATE_STATUSES`

Valid workflow gate status values per Section 7.3

```typescript
readonly [null, "passed", "failed", "blocked"]
```

### `ROUTING_TABLE`

Static routing table for all canonical operations.  Operations are grouped by domain with channel preferences based on: - MCP: lower overhead (no CLI startup), direct DB access, structured JSON - CLI: human-readable output, shell integration, interactive prompts - Either: no significant difference or context-dependent

```typescript
RoutingEntry[]
```

### `insertProjectRegistrySchema`

```typescript
BuildSchema<"insert", { projectId: SQLiteColumn<{ name: string; tableName: "project_registry"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 10 more ...; labelsJson: SQLiteColumn<....
```

### `selectProjectRegistrySchema`

```typescript
BuildSchema<"select", { projectId: SQLiteColumn<{ name: string; tableName: "project_registry"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 10 more ...; labelsJson: SQLiteColumn<....
```

### `insertNexusAuditLogSchema`

```typescript
BuildSchema<"insert", { id: SQLiteColumn<{ name: string; tableName: "nexus_audit_log"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 13 more ...; errorMessage: SQLiteColumn<...>; }...
```

### `selectNexusAuditLogSchema`

```typescript
BuildSchema<"select", { id: SQLiteColumn<{ name: string; tableName: "nexus_audit_log"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; ... 13 more ...; errorMessage: SQLiteColumn<...>; }...
```

### `insertNexusSchemaMetaSchema`

```typescript
BuildSchema<"insert", { key: SQLiteColumn<{ name: string; tableName: "nexus_schema_meta"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; value: SQLiteColumn<...>; }, undefined, CoerceOp...
```

### `selectNexusSchemaMetaSchema`

```typescript
BuildSchema<"select", { key: SQLiteColumn<{ name: string; tableName: "nexus_schema_meta"; dataType: "string"; data: string; driverParam: string; notNull: true; hasDefault: false; isPrimaryKey: true; isAutoincrement: false; ... 4 more ...; generated: undefined; }, {}>; value: SQLiteColumn<...>; }, undefined, CoerceOp...
```

### `ATOMICITY_CRITERIA`

```typescript
readonly ["single-file-scope", "single-cognitive-concern", "clear-acceptance-criteria", "no-context-switching", "no-hidden-decisions", "programmatic-validation-possible"]
```

### `VALID_STRATEGIES`

```typescript
ChildStrategy[]
```

### `DEFAULT_THRESHOLDS`

Default thresholds.

```typescript
StalenessThresholds
```
