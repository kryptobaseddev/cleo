# T581: SDK-Backed Claude Agent Spawn Provider — Design

**Date**: 2026-04-14
**Status**: Design complete
**SDK**: `@anthropic-ai/claude-agent-sdk` (TS) — package name confirmed from docs

---

## Context

The current `ClaudeCodeSpawnProvider` shells out to `claude --print --dangerously-skip-permissions` and spawns a detached OS process. It is fire-and-forget: no multi-turn, no structured output, no session persistence beyond in-memory PID tracking. The SDK approach replaces the shell-out with the official programmatic API, enabling true persistent agents with tool use and MCP server wiring.

---

## New Provider Location

```
packages/adapters/src/providers/claude-sdk/
  index.ts          — barrel export + adapter class
  spawn.ts          — ClaudeSDKSpawnProvider (AdapterSpawnProvider)
  session-store.ts  — in-memory + conduit.db persistence for session IDs
  tool-bridge.ts    — maps CLEO tool allowlist to SDK allowedTools strings
  mcp-registry.ts   — resolves which CLEO MCP servers to register
  __tests__/
    spawn.test.ts
    session-store.test.ts
```

Sibling to `claude-code/`. Does NOT touch `claude-code/` — backwards compatible.

---

## AdapterSpawnProvider Implementation

### `canSpawn()`

```typescript
async canSpawn(): Promise<boolean> {
  return !!process.env.ANTHROPIC_API_KEY;
}
```

No binary dependency. Credential check only. Can extend to check `~/.claude/settings.json` for OAuth tokens if needed.

### `spawn(context)`

Use SDK `query()` function (v1 API — stable). The v2 `unstable_v2_createSession` API is explicitly marked unstable; avoid for production.

Flow:
1. Enrich prompt via existing `buildCantEnrichedPrompt()` (same as CLI provider).
2. Call `query({ prompt, options })` from `@anthropic-ai/claude-agent-sdk`.
3. Capture `session_id` from first message in the async iterator.
4. Persist `{ instanceId, sessionId, taskId, startTime }` in `SessionStore`.
5. Collect streamed output: aggregate `AssistantMessage` text blocks + final `ResultMessage`.
6. Return `SpawnResult` with `output`, `exitCode` (from result subtype), `status`.

Key `options` fields:
- `allowedTools`: built by `ToolBridge.resolve(context.options?.toolAllowlist)`
- `mcpServers`: from `McpRegistry.getServers(context.workingDirectory)`
- `permissionMode: "dontAsk"` — matches current `--dangerously-skip-permissions`
- `model`: from `context.options?.model ?? "claude-sonnet-4-5"` (configurable)

### `listRunning()`

Query `SessionStore.listActive()`. No OS-level PID checks needed — SDK sessions are tracked by session ID, not PID.

### `terminate(instanceId)`

Call `SessionStore.remove(instanceId)`. SDK sessions terminate naturally; no explicit kill signal needed (stateless HTTP underneath).

---

## Key Design Decisions

### Persistence Model

`SessionStore` class maintains two layers:
1. In-memory `Map<instanceId, SessionEntry>` — fast lookups during a process lifecycle.
2. Conduit.db write via `cleo agent` CLI — persists session IDs across restarts for resume support.

Session resume uses `options: { resume: sessionId }` in `query()`.

### Tool Registration

`ToolBridge` maps CLEO's tool allowlist to SDK format:

```typescript
// Input: SpawnContext.options.toolAllowlist (string[] | undefined)
// Default CLEO set: Read, Write, Edit, Bash, Glob, Grep
const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

function resolve(allowlist?: string[]): string[] {
  return allowlist ?? DEFAULT_TOOLS;
}
```

MCP tools prepend `mcp__<server>__<tool>` per SDK convention.

### MCP Server Registration

`McpRegistry` returns `StdioMcpServer` specs for CLEO's own MCP servers:

```typescript
// Servers to register when available:
// - cleo-brain: memory read/write
// - cleo-nexus: code intelligence  
// - cleo-tasks: task CRUD
// Resolution: check if server binary exists in PATH or node_modules/.bin/
```

Pass as `mcpServers: { brain: brainServer, nexus: nexusServer }` in options.

### CANT Injection

No change from CLI provider. `buildCantEnrichedPrompt()` is called before `query()` and returns an enriched string. The SDK `prompt` parameter accepts this directly. No structural changes to CANT pipeline.

### Streaming / Progress

The SDK returns an `AsyncIterable<SDKMessage>`. During `spawn()`, aggregate all messages synchronously (await full completion) and return `SpawnResult.output` as concatenated text. For future streaming to orchestrator, expose a `spawnStream(context)` method returning the raw async iterable — that is out of scope for T581 but the architecture leaves the door open.

---

## Config Toggle

```bash
cleo config set provider.claude.mode sdk   # use ClaudeSDKSpawnProvider
cleo config set provider.claude.mode cli   # use ClaudeCodeSpawnProvider (default)
```

Config key: `provider.claude.mode`, type `string`, enum `cli | sdk`, default `cli`.

The `ClaudeCodeAdapter` reads this at spawn time and delegates to the appropriate provider. No adapter-level changes needed beyond the delegation switch.

---

## Worker Tasks (6 subtasks)

| # | Task | Size | Description |
|---|------|------|-------------|
| T581-1 | Package skeleton | small | Create `claude-sdk/` directory, `index.ts`, `tsconfig` references, add `@anthropic-ai/claude-agent-sdk` to `packages/adapters/package.json` |
| T581-2 | `SessionStore` | small | In-memory session map with conduit persistence via `cleo agent` CLI; unit tests |
| T581-3 | `ToolBridge` + `McpRegistry` | small | Resolve tool allowlist and MCP server specs; unit tests |
| T581-4 | `ClaudeSDKSpawnProvider` | medium | Core provider: `canSpawn`, `spawn`, `listRunning`, `terminate`; integration with CANT enrichment; unit tests with SDK mocked |
| T581-5 | Adapter wiring + config toggle | small | Add `provider.claude.mode` config key; delegate in `ClaudeCodeAdapter.spawn()` based on config; update adapter exports |
| T581-6 | E2E test + docs | small | Integration test that verifies SDK spawn runs against real API (skipped in CI); update `packages/adapters/README` |

---

## Risks

- `@anthropic-ai/claude-agent-sdk` TS API is ahead of published npm — pin exact version `0.2.71` per task spec; check breaking changes before upgrading.
- `unstable_v2_createSession` is explicitly unstable — use `query()` only.
- MCP server startup within `query()` adds latency; benchmark against CLI approach.
- SDK sessions are HTTP-backed, so `listRunning()` reflects CLEO's own tracking, not server-side truth.
