# Adapter Development Guide

**Task**: T5240
**Epic**: T5240

---

## Overview

This guide covers how to create a new CLEO provider adapter. Provider adapters are entry-point connectors that handle how a specific AI coding tool (Claude Code, OpenCode, Cursor, etc.) connects to CLEO. They do not contain business logic -- that lives in `src/core/`.

## Prerequisites

- Node.js 20+
- The CLEO repository cloned with npm workspaces enabled (`npm install` at root)
- Familiarity with the target provider's configuration format (instruction files, hooks, CLI)

## Architecture

```
packages/
  contracts/          # Type-only interfaces (CLEOProviderAdapter, etc.)
  shared/             # Runtime utilities (observation formatter, CLI wrapper, hook dispatch)
  adapters/
    claude-code/      # Full-featured reference (hooks + spawn + install)
    opencode/         # Full-featured reference (hooks + spawn + install)
    cursor/           # Minimal reference (install only)
    your-provider/    # Your new adapter goes here
```

Each adapter implements a subset of the contracts defined in `packages/contracts/`:

| Contract | Purpose | Required |
|----------|---------|----------|
| `AdapterInstallProvider` | Write provider instruction files, register CLEO config | Yes |
| `AdapterHookProvider` | Lifecycle hooks (session start/end, tool use, errors) | No |
| `AdapterSpawnProvider` | Launch subagent processes | No |
| `CLEOProviderAdapter` | Top-level container binding all sub-contracts | Yes |

## Steps

### 1. Create the package directory

```bash
mkdir -p packages/adapters/your-provider/src
mkdir -p packages/adapters/your-provider/__tests__
```

### 2. Define manifest.json

Create `packages/adapters/your-provider/manifest.json`:

```json
{
  "id": "your-provider",
  "name": "Your Provider Adapter",
  "version": "1.0.0",
  "description": "CLEO adapter for Your Provider",
  "provider": "your-provider",
  "entryPoint": "src/index.ts",
  "capabilities": {
    "supportsHooks": false,
    "supportedHookEvents": [],
    "supportsSpawn": false,
    "supportsInstall": true,
    "supportsMcp": false,
    "supportsInstructionFiles": true,
    "instructionFilePattern": ".your-provider-rules"
  },
  "detectionPatterns": [
    { "type": "env", "pattern": "YOUR_PROVIDER_ENV_VAR", "description": "Set when running inside Your Provider" },
    { "type": "file", "pattern": ".your-provider/config.json", "description": "Your Provider config directory" },
    { "type": "cli", "pattern": "your-provider", "description": "Your Provider CLI available in PATH" }
  ]
}
```

The `detectionPatterns` array tells AdapterManager how to detect whether a project is using your provider. Patterns are evaluated in order; the first match wins.

Detection pattern types:
- `env`: Check if an environment variable is set
- `file`: Check if a file or directory exists relative to the project root
- `cli`: Check if a command is available in PATH

### 3. Create package.json

Create `packages/adapters/your-provider/package.json`:

```json
{
  "name": "@cleocode/adapter-your-provider",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@cleocode/contracts": "workspace:*",
    "@cleocode/shared": "workspace:*"
  }
}
```

### 4. Implement the adapter

Create `packages/adapters/your-provider/src/index.ts`:

```typescript
import type {
  CLEOProviderAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  AdapterInstallProvider,
} from '@cleocode/contracts';

const capabilities: AdapterCapabilities = {
  supportsHooks: false,
  supportedHookEvents: [],
  supportsSpawn: false,
  supportsInstall: true,
  supportsMcp: false,
  supportsInstructionFiles: true,
  instructionFilePattern: '.your-provider-rules',
};

const installProvider: AdapterInstallProvider = {
  async install(projectDir: string): Promise<void> {
    // Write your provider's instruction file with @.cleo/memory-bridge.md reference
    // Register CLEO in your provider's configuration
  },

  async uninstall(projectDir: string): Promise<void> {
    // Remove CLEO configuration from your provider
  },

  async isInstalled(projectDir: string): Promise<boolean> {
    // Check if CLEO is configured for your provider in this project
    return false;
  },
};

export const adapter: CLEOProviderAdapter = {
  id: 'your-provider',
  name: 'Your Provider Adapter',
  version: '1.0.0',
  capabilities,
  install: installProvider,

  async initialize(projectDir: string): Promise<void> {
    // Any setup needed when the adapter is activated
  },

  async dispose(): Promise<void> {
    // Cleanup when the adapter is deactivated
  },

  async healthCheck(): Promise<AdapterHealthStatus> {
    return { healthy: true, provider: 'your-provider' };
  },
};
```

### 5. Add hook support (optional)

If your provider supports lifecycle hooks, implement `AdapterHookProvider`:

```typescript
import type { AdapterHookProvider } from '@cleocode/contracts';
import { dispatchHook } from '@cleocode/shared';

const hookProvider: AdapterHookProvider = {
  async onSessionStart(context): Promise<void> {
    await dispatchHook('onSessionStart', context);
  },

  async onSessionEnd(context): Promise<void> {
    await dispatchHook('onSessionEnd', context);
  },

  async onToolComplete(context): Promise<void> {
    await dispatchHook('onToolComplete', context);
  },

  async onError(context): Promise<void> {
    await dispatchHook('onError', context);
  },
};

// Add to your adapter:
// hooks: hookProvider,
```

### 6. Add spawn support (optional)

If your provider can launch subagent processes, implement `AdapterSpawnProvider`:

```typescript
import type { AdapterSpawnProvider } from '@cleocode/contracts';

const spawnProvider: AdapterSpawnProvider = {
  async spawn(config): Promise<SpawnResult> {
    // Launch a subagent process using your provider's CLI
  },

  async isAvailable(): Promise<boolean> {
    // Check if your provider's CLI is available for spawning
    return false;
  },
};
```

### 7. Add tests

Create `packages/adapters/your-provider/__tests__/adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { adapter } from '../src/index.js';

describe('your-provider adapter', () => {
  it('has correct id and name', () => {
    expect(adapter.id).toBe('your-provider');
    expect(adapter.name).toBe('Your Provider Adapter');
  });

  it('reports install capability', () => {
    expect(adapter.capabilities.supportsInstall).toBe(true);
  });

  it('health check returns healthy', async () => {
    const status = await adapter.healthCheck();
    expect(status.healthy).toBe(true);
    expect(status.provider).toBe('your-provider');
  });
});
```

### 8. Register in workspace

Add your adapter to the root `package.json` workspaces array if not already covered by a glob pattern.

## Memory Bridge Integration

Every adapter's install logic MUST ensure the provider's instruction file includes an `@`-reference to the memory bridge:

```
@.cleo/memory-bridge.md
```

This gives the provider access to CLEO's brain memory system without any provider-specific memory injection code.

## Testing

Run your adapter's tests:

```bash
npx vitest run packages/adapters/your-provider/
```

## Reference Implementations

- **Full-featured**: `packages/adapters/claude-code/` -- implements all four contracts (hooks, spawn, install, adapter). 32 tests.
- **Full-featured**: `packages/adapters/opencode/` -- implements all four contracts. 35 tests.
- **Minimal**: `packages/adapters/cursor/` -- implements install only (no hooks or spawn support). 33 tests.

## Troubleshooting

### AdapterManager does not detect my adapter

- Verify `manifest.json` exists at `packages/adapters/your-provider/manifest.json`
- Check that `detectionPatterns` match your local environment
- Run `cleo adapter.list` to see all discovered adapters

### Install writes the wrong instruction file

- Check `capabilities.instructionFilePattern` in your manifest
- Verify the install provider writes to the correct path relative to `projectDir`

### Hooks are not firing

- Confirm `capabilities.supportsHooks` is `true` in your manifest
- Verify your provider calls CLEO's hook endpoints at the correct lifecycle points
- Check adapter health: `cleo adapter.health`
