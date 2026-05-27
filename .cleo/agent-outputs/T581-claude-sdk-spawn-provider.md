# T581: Claude Agent SDK Spawn Provider — Implementation Report

**Date**: 2026-04-14
**Status**: complete
**Task**: T581 — Build SDK-backed Claude Agent spawn provider

---

## Summary

Implemented `ClaudeSDKSpawnProvider` — a full `AdapterSpawnProvider` using
`@anthropic-ai/claude-agent-sdk` v0.2.108 instead of shelling out to the `claude` CLI.

---

## Files Created

### `packages/adapters/src/providers/claude-sdk/`

| File | Purpose |
|------|---------|
| `spawn.ts` | `ClaudeSDKSpawnProvider` — core provider, `canSpawn/spawn/listRunning/terminate` |
| `session-store.ts` | `SessionStore` — in-memory `Map<instanceId, SessionEntry>` |
| `tool-bridge.ts` | `resolveTools()` — maps CLEO tool allowlist to SDK `allowedTools` strings |
| `mcp-registry.ts` | `getServers()` — resolves CLEO MCP server binaries from `node_modules/.bin/` |
| `index.ts` | Barrel export for all public symbols |
| `__tests__/spawn.test.ts` | 19 tests covering all provider methods + SessionStore + ToolBridge |

### `packages/contracts/src/config.ts`

Added `ClaudeSpawnMode`, `ClaudeProviderConfig`, `ProviderConfig` types and appended
`provider?: ProviderConfig` to `CleoConfig`.

### `packages/adapters/src/providers/claude-code/adapter.ts`

- `spawn` property type widened from `ClaudeCodeSpawnProvider` to `AdapterSpawnProvider`
- `initialize()` reads `cleo config get provider.claude.mode` and swaps to
  `ClaudeSDKSpawnProvider` when mode is `'sdk'`; defaults to CLI provider

### `packages/adapters/src/index.ts`

Exports `ClaudeSDKSpawnProvider`, `SessionStore`, `resolveTools`, `DEFAULT_TOOLS`,
`getServers` and related types.

---

## Key Design Decisions

- **`permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`**
  mirrors `--dangerously-skip-permissions` in the CLI provider
- **CANT enrichment** unchanged — `buildCantEnrichedPrompt()` called before `query()`
- **Session ID capture** from first SDK message with `session_id` field; stored in
  `SessionStore` for future resume support via `options.resumeSessionId`
- **Error subtypes** (`error_max_turns`, `error_during_execution`, etc.) all map to
  `status: 'failed'` with `exitCode: 1`
- **MCP registry** is best-effort: missing binaries are silently omitted

---

## Quality Gates

- biome check: PASS (no issues)
- tsc --noEmit --skipLibCheck on new files: PASS (0 errors)
- pnpm run test: PASS (214/214 tests, 8 test files)
- Pre-existing `@openai/agents` build errors in `packages/adapters` are unrelated to T581

---

## Config Toggle

```bash
cleo config set provider.claude.mode sdk   # ClaudeSDKSpawnProvider
cleo config set provider.claude.mode cli   # ClaudeCodeSpawnProvider (default)
```
