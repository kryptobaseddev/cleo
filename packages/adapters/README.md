# @cleocode/adapters

Unified provider adapters for CLEO - Claude Code, OpenCode, Cursor integration.

## Overview

This package provides standardized adapters for integrating CLEO with various AI coding assistants and providers. Each adapter implements a common interface, allowing CLEO to work seamlessly across different environments.

### Supported Providers

| Provider | Status | Features |
|----------|--------|----------|
| **Claude Code** | ✅ Production | Full integration with statusline sync, context monitoring |
| **OpenCode** | ✅ Production | Spawn hooks, task synchronization |
| **Cursor** | ✅ Production | Basic adapter with install hooks |

## Installation

```bash
npm install @cleocode/adapters
```

```bash
pnpm add @cleocode/adapters
```

```bash
yarn add @cleocode/adapters
```

## API Overview

### Provider Adapters

Each provider has its own adapter class with specialized capabilities:

#### Claude Code Adapter

```typescript
import { 
  ClaudeCodeAdapter,
  createClaudeCodeAdapter,
  ClaudeCodeContextMonitorProvider,
  ClaudeCodeHookProvider,
  ClaudeCodeInstallProvider,
  ClaudeCodePathProvider,
  ClaudeCodeSpawnProvider,
  ClaudeCodeTransportProvider,
  checkStatuslineIntegration,
  getSetupInstructions,
  getStatuslineConfig
} from '@cleocode/adapters';

// Create adapter
const adapter = createClaudeCodeAdapter({
  projectPath: './my-project'
});

// Check statusline integration
const status = await checkStatuslineIntegration('./my-project');

// Get setup instructions
const instructions = getSetupInstructions();
```

#### OpenCode Adapter

```typescript
import { 
  OpenCodeAdapter,
  createOpenCodeAdapter,
  OpenCodeHookProvider,
  OpenCodeInstallProvider,
  OpenCodeSpawnProvider
} from '@cleocode/adapters';

// Create adapter
const adapter = createOpenCodeAdapter({
  projectPath: './my-project'
});
```

#### Cursor Adapter

```typescript
import { 
  CursorAdapter,
  createCursorAdapter,
  CursorHookProvider,
  CursorInstallProvider
} from '@cleocode/adapters';

// Create adapter
const adapter = createCursorAdapter({
  projectPath: './my-project'
});
```

### Registry

Discover and manage provider manifests:

```typescript
import { 
  discoverProviders, 
  getProviderManifests,
  type AdapterManifest 
} from '@cleocode/adapters';

// Discover available providers
const providers = await discoverProviders('./my-project');

// Get all manifests
const manifests = getProviderManifests();

// Check specific provider
const claudeManifest = manifests.find(m => m.name === 'claude-code');
```

## Adapter Capabilities

Each provider adapter implements specific capability interfaces:

### Install Provider

Handles installation and setup:

```typescript
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

const installProvider: AdapterInstallProvider = {
  async install(options: InstallOptions): Promise<InstallResult> {
    // Install provider-specific files
    return { success: true, installed: ['file1', 'file2'] };
  },
  
  async detect(projectPath: string): Promise<boolean> {
    // Check if provider is installed
    return fs.existsSync(path.join(projectPath, '.claude'));
  }
};
```

### Hook Provider

Provides lifecycle hooks:

```typescript
import type { AdapterHookProvider } from '@cleocode/contracts';

const hookProvider: AdapterHookProvider = {
  async onTaskCreate(context) {
    // Called when a task is created
  },
  
  async onTaskComplete(context) {
    // Called when a task is completed
  },
  
  async onSessionStart(context) {
    // Called when a session starts
  },
  
  async onSessionEnd(context) {
    // Called when a session ends
  }
};
```

### Spawn Provider

Handles subagent spawning:

```typescript
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';

const spawnProvider: AdapterSpawnProvider = {
  async spawn(context: SpawnContext): Promise<SpawnResult> {
    // Spawn a subagent
    return {
      pid: 12345,
      stdout: process.stdout,
      stderr: process.stderr,
      exitCode: 0
    };
  }
};
```

### Context Monitor Provider

Monitors provider context:

```typescript
import type { AdapterContextMonitorProvider } from '@cleocode/contracts';

const contextProvider: AdapterContextMonitorProvider = {
  async getContext(projectPath: string) {
    return {
      activeTask: 'T1234',
      sessionId: 'session-abc',
      memoryUsage: 1024000
    };
  }
};
```

### Transport Provider

Handles communication:

```typescript
import type { AdapterTransportProvider } from '@cleocode/contracts';

const transportProvider: AdapterTransportProvider = {
  async send(message) {
    // Send message to provider
  },
  
  async receive() {
    // Receive message from provider
    return { type: 'response', data: {} };
  }
};
```

### Path Provider

Provides provider-specific paths:

```typescript
import type { AdapterPathProvider } from '@cleocode/contracts';

const pathProvider: AdapterPathProvider = {
  getConfigPath(projectPath: string) {
    return path.join(projectPath, '.claude', 'settings.json');
  },
  
  getDataPath(projectPath: string) {
    return path.join(projectPath, '.claude', 'data');
  }
};
```

### Task Sync Provider

Synchronizes tasks with provider:

```typescript
import type { AdapterTaskSyncProvider, ReconcileOptions, ReconcileResult } from '@cleocode/contracts';

const syncProvider: AdapterTaskSyncProvider = {
  async getExternalTasks(projectPath: string) {
    // Get tasks from provider
    return [];
  },
  
  async reconcile(options: ReconcileOptions): Promise<ReconcileResult> {
    // Reconcile tasks
    return {
      actions: [],
      conflicts: []
    };
  }
};
```

## Usage Examples

### Detecting Available Providers

```typescript
import { discoverProviders, getProviderManifests } from '@cleocode/adapters';

async function detectProviders() {
  const projectPath = './my-project';
  
  // Auto-detect installed providers
  const available = await discoverProviders(projectPath);
  
  console.log('Available providers:');
  for (const provider of available) {
    console.log(`  - ${provider.name}: ${provider.version}`);
  }
  
  // Get detailed manifests
  const manifests = getProviderManifests();
  for (const manifest of manifests) {
    console.log(`\n${manifest.name}:`);
    console.log(`  Capabilities: ${manifest.capabilities.join(', ')}`);
    console.log(`  Patterns: ${manifest.patterns.join(', ')}`);
  }
}
```

### Setting Up Claude Code Integration

```typescript
import { 
  createClaudeCodeAdapter,
  checkStatuslineIntegration,
  getSetupInstructions 
} from '@cleocode/adapters';

async function setupClaudeCode() {
  const projectPath = './my-project';
  
  // Check if already integrated
  const status = await checkStatuslineIntegration(projectPath);
  
  if (!status.integrated) {
    console.log('Claude Code not yet integrated');
    console.log(getSetupInstructions());
    
    // Create adapter and install
    const adapter = createClaudeCodeAdapter({ projectPath });
    const result = await adapter.install({ force: false });
    
    if (result.success) {
      console.log('Claude Code integration installed');
    }
  } else {
    console.log('Claude Code is already integrated ✓');
  }
}
```

### Working with Hooks

```typescript
import { createClaudeCodeAdapter } from '@cleocode/adapters';

async function setupHooks() {
  const adapter = createClaudeCodeAdapter({
    projectPath: './my-project'
  });
  
  // Register task creation hook
  adapter.hooks.register('onTaskCreate', async (context) => {
    console.log(`Task ${context.taskId} created in Claude Code`);
    // Update Claude Code statusline
    await adapter.updateStatusline({ activeTask: context.taskId });
  });
  
  // Register task completion hook
  adapter.hooks.register('onTaskComplete', async (context) => {
    console.log(`Task ${context.taskId} completed`);
    // Clear statusline
    await adapter.updateStatusline({ activeTask: null });
  });
}
```

### Spawning Subagents

```typescript
import { createClaudeCodeAdapter } from '@cleocode/adapters';

async function spawnSubagent() {
  const adapter = createClaudeCodeAdapter({
    projectPath: './my-project'
  });
  
  // Spawn a Claude Code subagent
  const result = await adapter.spawn({
    taskId: 'T1234',
    context: {
      instructions: 'Implement the authentication endpoint',
      files: ['src/auth.ts', 'src/routes.ts']
    }
  });
  
  if (result.pid) {
    console.log(`Spawned subagent with PID ${result.pid}`);
    
    // Wait for completion
    result.stdout?.on('data', (data) => {
      console.log(`Output: ${data}`);
    });
  }
}
```

### Synchronizing Tasks

```typescript
import { createClaudeCodeAdapter } from '@cleocode/adapters';

async function syncTasks() {
  const adapter = createClaudeCodeAdapter({
    projectPath: './my-project'
  });
  
  // Get external tasks from Claude Code
  const externalTasks = await adapter.getExternalTasks();
  
  // Reconcile with CLEO tasks
  const result = await adapter.reconcile({
    conflictPolicy: 'prefer-external',
    dryRun: false
  });
  
  console.log(`Reconciliation complete:`);
  console.log(`  Created: ${result.created.length}`);
  console.log(`  Updated: ${result.updated.length}`);
  console.log(`  Conflicts: ${result.conflicts.length}`);
}
```

### Custom Provider Adapter

```typescript
import type { 
  CLEOProviderAdapter,
  AdapterCapabilities,
  AdapterHealthStatus 
} from '@cleocode/contracts';

class MyCustomAdapter implements CLEOProviderAdapter {
  name = 'my-custom-provider';
  version = '1.0.0';
  
  getCapabilities(): AdapterCapabilities {
    return {
      spawn: true,
      hooks: true,
      install: true,
      contextMonitor: false,
      transport: true,
      paths: true,
      taskSync: false
    };
  }
  
  async healthCheck(projectPath: string): Promise<AdapterHealthStatus> {
    const isInstalled = await this.detect(projectPath);
    return {
      healthy: isInstalled,
      message: isInstalled ? 'Ready' : 'Not installed'
    };
  }
  
  async detect(projectPath: string): Promise<boolean> {
    // Check for provider-specific files
    return fs.existsSync(path.join(projectPath, '.my-provider'));
  }
  
  // Implement other provider methods...
}

// Register adapter
import { discoverProviders } from '@cleocode/adapters';
discoverProviders.register(new MyCustomAdapter());
```

## Provider Manifest Format

Adapters expose their capabilities through manifests:

```typescript
interface AdapterManifest {
  name: string;
  version: string;
  description: string;
  capabilities: Array<'spawn' | 'hooks' | 'install' | 'contextMonitor' | 'transport' | 'paths' | 'taskSync'>;
  patterns: DetectionPattern[];
}

interface DetectionPattern {
  type: 'file' | 'directory' | 'config';
  path: string;
  content?: string; // Optional: check file content
}
```

Example manifest:

```json
{
  "name": "claude-code",
  "version": "1.0.0",
  "description": "Claude Code integration",
  "capabilities": ["spawn", "hooks", "install", "contextMonitor", "transport", "paths", "taskSync"],
  "patterns": [
    { "type": "directory", "path": ".claude" },
    { "type": "file", "path": ".claude/CLAUDE.md" }
  ]
}
```

## Dependencies

### Production Dependencies

- `@cleocode/contracts` - Type definitions and interfaces

### Development Dependencies

- `@types/node` - Node.js type definitions

## License

MIT License - see [LICENSE](../LICENSE) for details.
