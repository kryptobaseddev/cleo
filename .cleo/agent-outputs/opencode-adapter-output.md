# OpenCode Adapter -- Task #5 Output

## Deliverables

### Package: `packages/adapters/opencode/`

**Files (pre-existing, verified):**
- `manifest.json` -- Adapter manifest with detection patterns (env: OPENCODE_VERSION, file: .opencode/config.json, cli: opencode)
- `package.json` -- `@cleocode/adapter-opencode` v1.0.0, depends on contracts + shared
- `tsconfig.json` -- Standalone strict TypeScript config
- `src/adapter.ts` -- `OpenCodeAdapter` implementing `CLEOProviderAdapter`
- `src/hooks.ts` -- `OpenCodeHookProvider` mapping 6 OpenCode events to CAAMP events
- `src/spawn.ts` -- `OpenCodeSpawnProvider` with subagent definition management
- `src/install.ts` -- `OpenCodeInstallProvider` managing .opencode/config.json and AGENTS.md
- `src/index.ts` -- Barrel exports + default export + factory function

### Tests: `src/core/adapters/__tests__/opencode-adapter.test.ts`

26 tests covering:
- Adapter identity, capabilities, lifecycle (init/dispose)
- 6/8 CAAMP hook events (onSessionStart, onSessionEnd, onToolStart, onToolComplete, onError, onPromptSubmit)
- Hook registration state tracking and event map introspection
- Spawn provider basics (canSpawn, listRunning, terminate)
- Install provider (AGENTS.md creation, reference appending, dedup, MCP registration in .opencode/config.json, uninstall)
- Factory function

## Key Differences from Claude Code Adapter

1. **Instruction file**: AGENTS.md (not CLAUDE.md)
2. **MCP config location**: `.opencode/config.json` (not `.mcp.json`)
3. **Hook events**: 6/8 CAAMP events (dot-delimited: `session.start`, `tool.complete`, etc.)
4. **Spawn**: Uses `opencode run --agent <name> --format json` with agent definition in `.opencode/agent/`
5. **No plugin system**: No settings.json registration needed

## Verification

- `npx tsc --noEmit` clean in adapter package
- 26/26 adapter tests passing
- All 84 adapter tests pass (discovery + manager + claude-code + opencode)
