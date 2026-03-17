# Claude Code Adapter — Task #10 Output

## Deliverables

### Package: `packages/adapters/claude-code/`

**Files:**
- `manifest.json` — Adapter manifest with detection patterns (env, file, cli)
- `package.json` — `@cleocode/adapter-claude-code` v1.0.0, depends on contracts + shared
- `tsconfig.json` — Standalone strict TypeScript config
- `src/adapter.ts` — `ClaudeCodeAdapter` implementing `CLEOProviderAdapter`
- `src/hooks.ts` — `ClaudeCodeHookProvider` mapping 4 Claude Code events to CAAMP events
- `src/spawn.ts` — `ClaudeCodeSpawnProvider` spawning detached `claude` CLI processes
- `src/install.ts` — `ClaudeCodeInstallProvider` managing .mcp.json, CLAUDE.md, plugin registration
- `src/index.ts` — Barrel exports + default export + factory function

### Tests: `src/core/adapters/__tests__/claude-code-adapter.test.ts`

23 tests covering:
- Adapter identity, capabilities, lifecycle (init/dispose)
- Health check states (uninitialized vs initialized)
- Hook event mapping (all 4 Claude Code events)
- Hook registration state tracking
- Spawn provider basics (canSpawn, listRunning, terminate)
- Install provider (CLAUDE.md creation, reference appending, dedup, MCP registration, uninstall)
- Factory function

## Architecture

```
ClaudeCodeAdapter (CLEOProviderAdapter)
  ├── hooks: ClaudeCodeHookProvider
  │   └── Maps: SessionStart→onSessionStart, PostToolUse→onToolComplete,
  │            UserPromptSubmit→onPromptSubmit, Stop→onSessionEnd
  ├── spawn: ClaudeCodeSpawnProvider
  │   └── Detached `claude` CLI process spawning with PID tracking
  └── install: ClaudeCodeInstallProvider
      ├── .mcp.json registration
      ├── CLAUDE.md @-reference injection
      └── ~/.claude/settings.json plugin registration
```

## Key Design Decisions

1. **Adapter does NOT write brain memories** — that's the memory bridge's job (Layer 1)
2. **Hook provider is a thin mapper** — actual hook registration is via the plugin install lifecycle
3. **Spawn uses detached processes** — unref'd child processes with temp file cleanup on exit
4. **Install is idempotent** — references are only added if missing, never duplicated

## Verification

- `npx tsc --noEmit` clean in adapter package
- `npm run build` clean at root
- 23/23 adapter tests passing
- Full suite: 4748 passed, 1 pre-existing failure (research-workflow.test.ts)
