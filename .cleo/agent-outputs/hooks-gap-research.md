# Hooks System Gap Research

**Researcher**: hooks-researcher
**Date**: 2026-03-04
**Status**: COMPLETE

---

## 1. Current Hooks Architecture

```
CAAMP 1.6.0 (npm)                    CLEO Hooks System
+---------------------------+        +------------------------------------------+
| HookEvent type (8 events) |        | src/core/hooks/                          |
| getProvidersByHookEvent() |        |   types.ts      - Re-exports CAAMP types |
| getCommonHookEvents()     |        |                   + CLEO payload types    |
+---------------------------+        |   registry.ts   - HookRegistry class      |
                                     |                   (singleton `hooks`)     |
                                     |   provider-hooks.ts - CAAMP query wrappers|
                                     |   index.ts      - Barrel exports          |
                                     |   handlers/                              |
                                     |     session-hooks.ts - 2 handlers         |
                                     |     task-hooks.ts    - 2 handlers         |
                                     |     index.ts         - Auto-registration  |
                                     +------------------------------------------+
                                                  |
                                     Dispatch Points (4 active):
                                     +------------------------------------------+
                                     | src/core/sessions/index.ts:159           |
                                     |   hooks.dispatch('onSessionStart', ...)  |
                                     | src/core/sessions/index.ts:210           |
                                     |   hooks.dispatch('onSessionEnd', ...)    |
                                     | src/core/task-work/index.ts:135          |
                                     |   hooks.dispatch('onToolStart', ...)     |
                                     | src/core/task-work/index.ts:181          |
                                     |   hooks.dispatch('onToolComplete', ...)  |
                                     +------------------------------------------+
                                                  |
                                     MCP Engine (query-only):
                                     +------------------------------------------+
                                     | src/dispatch/engines/hooks-engine.ts     |
                                     |   queryHookProviders(event)              |
                                     |   queryCommonHooks(providerIds?)         |
                                     +------------------------------------------+
```

### Dispatch Flow

All hook dispatches use fire-and-forget pattern:
```typescript
hooks.dispatch('onSessionStart', cwd ?? process.cwd(), payload)
  .catch(() => { /* Hooks are best-effort */ });
```

Handlers are executed in parallel via `Promise.allSettled` within `HookRegistry.dispatch()`. Errors are caught per-handler and logged via the logger. No handler failure propagates to the caller.

---

## 2. Four Wired Hooks: Status and Issues

### 2.1 onSessionStart -- WIRED, WORKING

**Dispatch**: `src/core/sessions/index.ts:159` (in `startSession()`)
**Handler**: `src/core/hooks/handlers/session-hooks.ts:20` (`handleSessionStart`)
**Action**: Calls `observeBrain()` with session name, scope, agent
**Error handling**: Swallows "no such table: brain_*" errors (graceful brain.db absence), rethrows others
**Test**: `session-hooks.test.ts` -- 4 tests covering success, schema-missing swallow, non-schema rethrow

**Issues**:
- Payload passes `scope` as-is (a SessionScope object), but the handler `JSON.stringify`s it. Works, but inconsistent with other handlers that pass primitives.

### 2.2 onSessionEnd -- WIRED, WORKING

**Dispatch**: `src/core/sessions/index.ts:210` (in `endSession()`)
**Handler**: `src/core/hooks/handlers/session-hooks.ts:42` (`handleSessionEnd`)
**Action**: Calls `observeBrain()` with session ID, duration, tasks completed
**Error handling**: Same brain schema swallow pattern
**Test**: Covered by same test file

**Issues**: None significant.

### 2.3 onToolStart -- WIRED, WORKING

**Dispatch**: `src/core/task-work/index.ts:135` (in `startTask()`)
**Handler**: `src/core/hooks/handlers/task-hooks.ts:14` (`handleToolStart`)
**Action**: Calls `observeBrain()` with task ID and title
**Error handling**: NO brain schema error swallowing -- will throw if brain.db absent
**Test**: No dedicated test file for task-hooks handlers

**Issues**:
- **Missing error guard**: Unlike session-hooks, task-hooks do NOT have `isMissingBrainSchemaError()` protection. If brain.db is absent, `handleToolStart` throws, which the registry catches and logs -- but this is an inconsistency.
- **No test coverage** for task hook handlers.

### 2.4 onToolComplete -- WIRED, WORKING

**Dispatch**: `src/core/task-work/index.ts:181` (in `stopTask()`)
**Handler**: `src/core/hooks/handlers/task-hooks.ts:31` (`handleToolComplete`)
**Action**: Calls `observeBrain()` with task ID and status
**Error handling**: Same issue as onToolStart -- no brain schema guard
**Test**: No dedicated test file

**Issues**:
- Same missing error guard as onToolStart.
- `stopTask()` dispatches `onToolComplete` with `status: 'done'` regardless of actual outcome. A task that is merely "stopped" (paused) is not necessarily "done". The CAAMP event name `onToolComplete` maps to CLEO's `task.complete`, but it is dispatched from `stopTask()` which is semantically different.

---

## 3. Four Unwired Hooks: Gap Analysis

### 3.1 onFileChange

**What should trigger it?**
- Atomic file writes via `saveJson()` in `src/store/json.ts` (the primary data mutation path)
- Database writes via `atomicWrite()` / `atomicWriteJson()` in `src/store/atomic.ts`
- NOT raw `fs.writeFile` calls (those go through atomic.ts anyway)
- NOT git-level changes (too noisy, different concern)

**Where should `hooks.dispatch('onFileChange', ...)` be called?**

Primary dispatch point (recommended):
- **`src/store/json.ts:79`** -- inside `saveJson()`, after the atomic write succeeds (line ~108, after `atomicWriteJson`). This covers ALL data file mutations (tasks.db, sessions, config, manifests) since `saveJson` is the canonical write path.

Secondary dispatch point (optional, for non-JSON atomic writes):
- **`src/store/atomic.ts:21`** -- at end of `atomicWrite()`, after successful write. This catches raw file writes that bypass `saveJson`.

**Payload spec:**
```typescript
interface OnFileChangePayload extends HookPayload {
  /** Absolute path of the file that changed */
  filePath: string;
  /** Type of change */
  changeType: 'write' | 'create' | 'delete';
  /** Size in bytes (optional) */
  sizeBytes?: number;
}
```

**BRAIN observation:**
- Type: `'change'`
- Title: `File changed: <relative-path>`
- Text: `File ${changeType}: ${filePath}` (truncate to relative path from project root)
- Should include deduplication: skip if same file changed within last N seconds (configurable, default 5s) to avoid BRAIN spam during rapid writes

**Scope**: medium -- requires touching the store layer and adding a new handler file

### 3.2 onError

**What should trigger it?**
- `CleoError` construction or throw sites in the dispatch pipeline
- Validation failures (schema validation, anti-hallucination checks)
- Unhandled errors caught at the MCP/CLI boundary
- NOT hook handler errors (would cause infinite loops)

**Where should `hooks.dispatch('onError', ...)` be called?**

Primary dispatch point (recommended):
- **`src/dispatch/dispatcher.ts`** -- Add a try/catch wrapper around the `terminal()` call at line ~95. When the domain handler throws, dispatch `onError` before returning the error response. This catches all operation-level errors flowing through the dispatch pipeline.

```typescript
// In dispatcher.ts, around line 87-93:
const terminal = async (): Promise<DispatchResponse> => {
  try {
    if (request.gateway === 'query') {
      return handler.query(resolved.operation, request.params);
    } else {
      return handler.mutate(resolved.operation, request.params);
    }
  } catch (err) {
    // Dispatch onError hook (best-effort, no await)
    hooks.dispatch('onError', getProjectRoot(), {
      timestamp: new Date().toISOString(),
      errorCode: err instanceof CleoError ? err.code : 'UNKNOWN',
      message: err instanceof Error ? err.message : String(err),
      domain: resolved.domain,
      operation: resolved.operation,
      gateway: request.gateway,
    }).catch(() => {});
    throw err; // Re-throw for normal error handling
  }
};
```

**Important guard**: The handler MUST check that it is not being triggered by a hook handler error, to prevent infinite recursion. The registry already isolates handler errors via try/catch in `dispatch()`, but the `onError` handler itself should guard:

```typescript
// In the onError handler:
if (payload.metadata?.fromHook) return; // Prevent infinite loop
```

**Payload spec:**
```typescript
interface OnErrorPayload extends HookPayload {
  /** CleoError exit code or 'UNKNOWN' */
  errorCode: number | string;
  /** Error message */
  message: string;
  /** Domain where error occurred */
  domain?: string;
  /** Operation where error occurred */
  operation?: string;
  /** Gateway (query/mutate) */
  gateway?: string;
  /** Stack trace (truncated) */
  stack?: string;
}
```

**BRAIN observation:**
- Type: `'discovery'` (errors are things we learn from)
- Title: `Error: ${domain}.${operation} - ${errorCode}`
- Text: Error message + domain/operation context
- Should include error code for later search/analysis

**Scope**: medium -- requires wrapping the dispatcher terminal call and adding a new handler

### 3.3 onPromptSubmit

**What should trigger it?**
- When an MCP `cleo_query` or `cleo_mutate` tool call is received by the MCP server
- This maps to "a prompt/request was submitted to CLEO" -- the LLM is asking CLEO to do something
- NOT when the CLI receives a command (CLI is human-driven, not LLM-driven)

**Where should `hooks.dispatch('onPromptSubmit', ...)` be called?**

Primary dispatch point:
- **`src/dispatch/adapters/mcp.ts:83`** -- at the top of `handleMcpToolCall()`, before the dispatcher executes. This is the single entry point for all MCP requests.

```typescript
// In handleMcpToolCall(), after validation but before dispatch:
hooks.dispatch('onPromptSubmit', getProjectRoot(), {
  timestamp: new Date().toISOString(),
  gateway,
  domain,
  operation,
  // Do NOT include full params (may contain sensitive data)
}).catch(() => {});
```

**Payload spec:**
```typescript
interface OnPromptSubmitPayload extends HookPayload {
  /** Which gateway was called */
  gateway: string;
  /** Target domain */
  domain: string;
  /** Target operation */
  operation: string;
  /** Request source identifier */
  source?: string;
}
```

**BRAIN observation:**
- Type: `'discovery'`
- Title: `MCP call: ${gateway} ${domain}.${operation}`
- Text: `Agent requested ${gateway}:${domain}.${operation}`
- Consider: HIGH VOLUME -- this fires on every MCP call. Should have configurable capture:
  - Default: do NOT capture to BRAIN (too noisy)
  - Config option to enable BRAIN capture for specific domains or during grade-mode sessions
  - Even without BRAIN capture, the hook fires so other handlers (metrics, audit) can use it

**Scope**: small -- single dispatch point addition, handler is optional/configurable

### 3.4 onResponseComplete

**What should trigger it?**
- When the MCP server has finished processing and is about to return the response
- After the dispatcher has produced a `DispatchResponse`

**Where should `hooks.dispatch('onResponseComplete', ...)` be called?**

Primary dispatch point:
- **`src/dispatch/adapters/mcp.ts:143`** -- at the end of `handleMcpToolCall()`, after `dispatcher.dispatch(req)` returns but before returning to caller.

```typescript
// In handleMcpToolCall(), after dispatch completes:
const response = await dispatcher.dispatch(req);

hooks.dispatch('onResponseComplete', getProjectRoot(), {
  timestamp: new Date().toISOString(),
  gateway: normalizedGateway,
  domain,
  operation,
  success: response.success,
  durationMs: response._meta?.duration_ms,
}).catch(() => {});

return response;
```

**Payload spec:**
```typescript
interface OnResponseCompletePayload extends HookPayload {
  /** Which gateway was called */
  gateway: string;
  /** Target domain */
  domain: string;
  /** Target operation */
  operation: string;
  /** Whether the operation succeeded */
  success: boolean;
  /** Processing duration in ms */
  durationMs?: number;
  /** Error code if failed */
  errorCode?: string;
}
```

**BRAIN observation:**
- Same volume concern as onPromptSubmit -- default to NOT capturing to BRAIN
- Useful for metrics collection (success rate, latency tracking)
- Grade-mode sessions could enable BRAIN capture for behavioral analysis
- Handler should focus on metrics/telemetry, not BRAIN storage

**Scope**: small -- single dispatch point addition, handler is optional/configurable

---

## 4. Dispatch Point Summary

| Hook Event | Status | File:Line | Function |
|---|---|---|---|
| onSessionStart | WIRED | `src/core/sessions/index.ts:159` | `startSession()` |
| onSessionEnd | WIRED | `src/core/sessions/index.ts:210` | `endSession()` |
| onToolStart | WIRED | `src/core/task-work/index.ts:135` | `startTask()` |
| onToolComplete | WIRED | `src/core/task-work/index.ts:181` | `stopTask()` |
| onFileChange | UNWIRED | `src/store/json.ts:~108` (after atomicWriteJson) | `saveJson()` |
| onError | UNWIRED | `src/dispatch/dispatcher.ts:~87` (wrap terminal) | `Dispatcher.dispatch()` |
| onPromptSubmit | UNWIRED | `src/dispatch/adapters/mcp.ts:~134` (before dispatch) | `handleMcpToolCall()` |
| onResponseComplete | UNWIRED | `src/dispatch/adapters/mcp.ts:~143` (after dispatch) | `handleMcpToolCall()` |

---

## 5. Handler Implementation Specs

### 5.1 New File: `src/core/hooks/handlers/file-hooks.ts`

```typescript
// Handler for onFileChange
// - observeBrain with type 'change'
// - Deduplication: skip if same filePath within 5s window
// - Convert absolute path to relative (from projectRoot)
// - Include isMissingBrainSchemaError guard (like session-hooks)
// Priority: 100
// Registration ID: 'brain-file-change'
```

### 5.2 New File: `src/core/hooks/handlers/error-hooks.ts`

```typescript
// Handler for onError
// - observeBrain with type 'discovery'
// - Guard against infinite loop (check payload.metadata?.fromHook)
// - Include error code, domain, operation in observation
// - Include isMissingBrainSchemaError guard
// Priority: 100
// Registration ID: 'brain-error'
```

### 5.3 New File: `src/core/hooks/handlers/mcp-hooks.ts`

```typescript
// Handler for onPromptSubmit and onResponseComplete
// - Default: metrics/logging only, NO brain capture (too noisy)
// - Configurable: check env CLEO_SESSION_GRADE or hook config
// - If grade mode: observeBrain with type 'discovery'
// - Include isMissingBrainSchemaError guard
// Priority: 100
// Registration IDs: 'brain-prompt-submit', 'brain-response-complete'
```

### 5.4 New Payload Types Needed

Add to `src/core/hooks/types.ts`:
- `OnFileChangePayload`
- `OnErrorPayload`
- `OnPromptSubmitPayload`
- `OnResponseCompletePayload`

Currently, only 4 payload types exist (OnSessionStart, OnSessionEnd, OnToolStart, OnToolComplete). The 4 new ones are needed for type safety in the new handlers.

Also need to update `CLEO_TO_CAAMP_HOOK_MAP` in types.ts to include:
```typescript
'file.write': 'onFileChange',
'error.caught': 'onError',
'prompt.submit': 'onPromptSubmit',
'response.complete': 'onResponseComplete',
```

---

## 6. TODO / Import Audit Results

### TODOs in src/core/hooks/
- **None found.** No TODO, FIXME, HACK, or XXX comments exist in any hooks source files.

### Unused Imports
- **None found.** All imports in hooks files are used.

### Error Handling Consistency
- **session-hooks.ts**: Has `isMissingBrainSchemaError()` guard -- GOOD
- **task-hooks.ts**: MISSING the guard -- handlers will throw on absent brain.db, caught by registry's try/catch but logged as warning. Should be fixed for consistency.

### Singleton Initialization
- `hooks` singleton in `registry.ts:193` is created at module scope -- works correctly
- Handler auto-registration happens via `import '../hooks/handlers/index.js'` in both:
  - `src/core/sessions/index.ts:16`
  - `src/core/task-work/index.ts:18`
- The dual import is harmless (modules only execute once) but adds coupling. Both imports ensure handlers are registered regardless of which module loads first.

---

## 7. Scope Estimates

| Hook | Scope | Rationale |
|---|---|---|
| onFileChange | **medium** | Touches store layer (`json.ts`), new handler file, new payload type, dedup logic |
| onError | **medium** | Touches dispatcher core, infinite-loop guard needed, new handler file |
| onPromptSubmit | **small** | Single dispatch point in `mcp.ts`, handler is optional/configurable |
| onResponseComplete | **small** | Single dispatch point in `mcp.ts`, paired with onPromptSubmit |
| Fix task-hooks error guard | **small** | Add `isMissingBrainSchemaError` to 2 existing handlers |
| Add task-hooks tests | **small** | Mirror session-hooks.test.ts pattern |
| New payload types | **small** | 4 new interfaces in types.ts |

### Recommended Implementation Order
1. Fix task-hooks error guard + add tests (quick win, consistency)
2. Add 4 new payload types to types.ts
3. onError (high value -- error visibility)
4. onFileChange (medium value -- change tracking)
5. onPromptSubmit + onResponseComplete (pair them -- metrics/observability)

### Total New Files
- `src/core/hooks/handlers/file-hooks.ts`
- `src/core/hooks/handlers/error-hooks.ts`
- `src/core/hooks/handlers/mcp-hooks.ts`
- `src/core/hooks/handlers/__tests__/task-hooks.test.ts`
- `src/core/hooks/handlers/__tests__/file-hooks.test.ts`
- `src/core/hooks/handlers/__tests__/error-hooks.test.ts`
- `src/core/hooks/handlers/__tests__/mcp-hooks.test.ts`

### Files to Modify
- `src/core/hooks/types.ts` -- add 4 payload interfaces, update CLEO_TO_CAAMP_HOOK_MAP
- `src/core/hooks/handlers/index.ts` -- import new handler files
- `src/core/hooks/handlers/task-hooks.ts` -- add isMissingBrainSchemaError guard
- `src/store/json.ts` -- add onFileChange dispatch in saveJson()
- `src/dispatch/dispatcher.ts` -- wrap terminal() for onError
- `src/dispatch/adapters/mcp.ts` -- add onPromptSubmit and onResponseComplete dispatches

---

## 8. Design Spec vs Implementation Delta

The T5237 design doc (`docs/specs/T5237-UNIVERSAL-HOOKS-DESIGN.md`) describes a more elaborate `CLEOHookRegistry` with `on()`, `once()`, `off()`, `fire()` methods, provider filtering, max executions, and a `HookContext` wrapper. The actual implementation in `src/core/hooks/registry.ts` is simpler:

| Design Spec Feature | Implemented? | Notes |
|---|---|---|
| `register()` method | Yes | Simpler than `on()` but functional |
| `dispatch()` method | Yes | Replaces design's `fire()` |
| Priority ordering | Yes | Higher = earlier (inverted from design's lower = earlier) |
| `Promise.allSettled` execution | Yes | Best-effort pattern |
| Provider filtering | No | Design proposed it; not implemented |
| Max executions | No | Design proposed it; not implemented |
| `once()` method | No | Not implemented |
| `off()` / `offAll()` | Partial | `register()` returns unregister fn; no offAll |
| `HookContext` wrapper | No | Handlers receive `(projectRoot, payload)` directly |
| CLEO event mapping (`toCaampHookEvent`) | Partial | `CLEO_TO_CAAMP_HOOK_MAP` exists but dispatch calls use CAAMP event names directly |
| `BRAINMemoryObserver` class | No | Handlers directly call `observeBrain()` instead |
| `CAAMPHookUtils` class | No | `provider-hooks.ts` has simpler wrappers |

The implementation is leaner than the design but fully functional for current needs. The 4 unwired hooks can be added without changing the registry architecture.
