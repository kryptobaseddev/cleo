# @cleocode/adapters

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

Provider adapters for CLEO: the install, hook and instruction-injection code for each AI coding harness, plus the spawn providers behind `cleo orchestrate spawn-execute`.

## Overview

CLEO is a harness-agnostic core (ADR-098): the harness (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, Kimi) launches the agent, and CLEO installs its instructions and hooks into that harness. Each provider directory under `src/providers/` exports an adapter class implementing `CLEOProviderAdapter` from `@cleocode/contracts`, plus the hook, install and (where present) spawn providers it is built from.

### Providers

Capabilities below are the flags each adapter class declares in its `adapter.ts`.

| Provider | Install writes | Hooks | Spawn |
|----------|----------------|-------|-------|
| **claude-code** | `CLAUDE.md` references; PreCompact shim and heavy-command `PreToolUse` hook in the project's `.claude/` | Yes; also context monitor, statusline, provider paths, TodoWrite task sync | Starts the `claude` CLI as a child process. Lead spawns are supported (`leadToolStrip: 'enforced'`) |
| **opencode** | `AGENTS.md` references; PreCompact shim + `.opencode/plugins/cleo-precompact.js`; heavy-command plugin `.opencode/plugins/cleo-heavy-command.js` | Yes | Starts the `opencode` CLI as a child process |
| **cursor** | `AGENTS.md`, `.cursor/rules/cleo.mdc` and legacy `.cursorrules`; PreCompact shim wired into `.cursor/hooks.json` | Declared `true` in `adapter.ts`, `false` in `manifest.json` | None: `spawn()` throws |
| **codex** | `AGENTS.md` references; heavy-command `PreToolUse` hook in `.codex/hooks.json` | Yes (`SessionStart`, `UserPromptSubmit`, `Stop`) | Declared unsupported (see note) |
| **gemini-cli** | `GEMINI.md` references. A PreCompact shim ships, but the install path does not wire it yet | Yes | Declared unsupported (see note) |
| **kimi** | `AGENTS.md` references | No | Declared unsupported (see note) |
| **claude-sdk** | Nothing (no-op install) | No | Programmatic Claude run through the Vercel AI SDK; lead spawns supported (`leadToolStrip: 'enforced'`). The claude-code adapter switches to it when `provider.claude.mode` is `sdk` |
| **openai-sdk** | `AGENTS.md` references and a `.openai/` stub | No | Programmatic run through the Vercel AI SDK; needs `OPENAI_API_KEY` |
| **pi** | Frozen | Frozen | Frozen. ADR-098 retires the Pi/CleoOS harness: the `pi/` directory is still in the source and still registered, and is deleted after a release ships the freeze |

ADR-098 leaves one open owner call: whether to keep, freeze or delete the two SDK spawn adapters (`claude-sdk`, `openai-sdk`).

**Spawn note.** `cleo orchestrate spawn-execute` registers a provider's spawn provider only when its `manifest.json` sets `supportsSpawn: true` (`packages/core/src/spawn/adapter-registry.ts`, `initializeSpawnAdapters`). Codex, Gemini CLI and Kimi ship a `spawn.ts` (`codex` and `gemini` start their CLIs; Kimi calls the Moonshot API), but their manifests declare `supportsSpawn: false`, so that path does not use them. A lead spawn on a provider whose spawn provider does not declare `leadToolStrip: 'enforced'` is refused with `E_LEAD_TOOLS_UNSTRIPPED` before anything runs (`src/providers/shared/lead-tool-strip.ts`).

Per-provider hook detail: [`src/providers/README.md`](src/providers/README.md).

## Installation

```bash
pnpm add @cleocode/adapters
```

## Exports

| Subpath | Contents |
|---------|----------|
| `@cleocode/adapters` | Adapter classes and providers for claude-code, claude-sdk, codex, cursor, gemini-cli, kimi and opencode; `createClaudeCodeAdapter`, `createCodexAdapter`, `createCursorAdapter`, `createGeminiCliAdapter`, `createKimiAdapter`, `createOpenCodeAdapter`, `createClaudeSDKAdapter`; the CANT/NEXUS prompt-context builders; the PreCompact template installer; the heavy-command hook delivery API; `discoverProviders`, `getProviderManifests` |
| `@cleocode/adapters/manifests` | `getProviderManifests()` without loading provider code |
| `@cleocode/adapters/heavy-command-hook` | Project-level heavy-command hook delivery (T13124) |
| `@cleocode/adapters/project-hook-delivery`, `/project-hook-native` | Project-local delivery of shared checks and the provider payload adapters for them (T13344) |
| `@cleocode/adapters/orca-execution` | Local Orca execution |

The SDK factories take no arguments. An adapter is bound to a project with `initialize(projectDir)`:

```typescript
import { createClaudeCodeAdapter, checkStatuslineIntegration } from '@cleocode/adapters';

const adapter = createClaudeCodeAdapter();
await adapter.initialize('/path/to/project'); // registers the project's native hooks
const health = await adapter.healthCheck();   // { healthy, provider, details? }

// 'configured' | 'not_configured' | 'custom_no_cleo' | 'no_settings'
const statusline = checkStatuslineIntegration();

await adapter.dispose();
```

### Registry

```typescript
import { discoverProviders, getProviderManifests } from '@cleocode/adapters';

// Bundled manifests: every src/providers/<id>/manifest.json that parses.
const manifests = getProviderManifests();

// Lazy factories for claude-code, opencode, cursor and pi.
const factories = await discoverProviders();
const adapter = await factories.get('claude-code')?.();
```

`claude-sdk` has no `manifest.json`, so `getProviderManifests()` does not list it.

## Adapter contract

The contracts live in `@cleocode/contracts`. `CLEOProviderAdapter` (`adapter.ts`) has `id`, `name`, `version`, `capabilities`, a required `install` provider, the optional `hooks`, `spawn`, `paths`, `contextMonitor`, `transport` and `taskSync` providers, and the lifecycle methods `initialize(projectDir)`, `dispose()` and `healthCheck()`.

| Provider interface | Methods |
|--------------------|---------|
| `AdapterInstallProvider` (`install.ts`) | `install(options)`, `uninstall()`, `isInstalled()`, `ensureInstructionReferences(projectDir)` |
| `AdapterHookProvider` (`hooks.ts`) | `mapProviderEvent(event)`, `registerNativeHooks(projectDir)`, `unregisterNativeHooks()`, optional `getEventMap()`, `getTranscript()` |
| `AdapterSpawnProvider` (`spawn.ts`) | `canSpawn()`, `spawn(context)`, `listRunning()`, `terminate(instanceId)` |
| `AdapterPathProvider` (`provider-paths.ts`) | `getProviderDir()`, `getSettingsPath()`, `getAgentInstallDir()`, `getMemoryDbPath()` |
| `AdapterContextMonitorProvider` (`context-monitor.ts`) | `processContextInput()`, `checkStatuslineIntegration()`, `getStatuslineConfig()`, `getSetupInstructions()` |
| `AdapterTransportProvider` (`transport.ts`) | `createTransport()`, `transportName`. The claude-code transport is a stub that returns `null` |
| `ExternalTaskProvider` (`task-sync.ts`) | `getExternalTasks(projectDir)`, optional outbound push |

`AdapterCapabilities` (`capabilities.ts`) is a set of flags: `supportsHooks`, `supportedHookEvents`, `supportsSpawn`, `supportsInstall`, `supportsInstructionFiles`, `instructionFilePattern`, `supportsContextMonitor`, `supportsStatusline`, `supportsProviderPaths`, `supportsTransport`, `supportsTaskSync`.

## Manifest format

Each provider directory may ship a `manifest.json` matching `AdapterManifest` (`@cleocode/contracts`, `discovery.ts`). `packagePath` and `entryPoint` are filled in at discovery time.

```json
{
  "id": "claude-code",
  "name": "Claude Code Adapter",
  "version": "1.0.0",
  "description": "CLEO adapter for Anthropic Claude Code CLI",
  "provider": "claude-code",
  "entryPoint": "src/index.ts",
  "capabilities": { "supportsHooks": true, "supportsSpawn": true, "...": "..." },
  "detectionPatterns": [
    { "type": "env", "pattern": "CLAUDE_CODE_ENTRYPOINT", "description": "Claude Code sets this env var" },
    { "type": "file", "pattern": ".claude/settings.json", "description": "Claude Code config directory" },
    { "type": "cli", "pattern": "claude", "description": "Claude CLI available in PATH" }
  ]
}
```

Detection pattern types are `env`, `file`, `process` and `cli`.

## Dependencies

- `@cleocode/contracts`: adapter, spawn, hook and install contracts
- `@cleocode/caamp`: provider registry and hook event mappings
- `@cleocode/paths`: path resolution
- `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`: the SDK spawn adapters

## License

MIT License - see [LICENSE](../../LICENSE) for details.
