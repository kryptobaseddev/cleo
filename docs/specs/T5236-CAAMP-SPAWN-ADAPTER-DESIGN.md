# T5236: CAAMP Spawn Adapter Design Document

**Phase**: 1A - Design and Planning  
**Status**: Updated for CAAMP 1.6.0 API  
**Owner**: Team Alpha  
**Date**: 2026-03-03  

---

## 1. Executive Summary

This document outlines the design for implementing the CAAMP Spawn Adapter for CLEO's orchestrate domain (T5236), updated to align with the actual CAAMP 1.6.0 API specification.

### Current State
- `orchestrate.spawn` generates a fully-resolved prompt and spawn context
- Execution is left to the provider's native mechanism (e.g., Claude Code Task tool)
- No standardized adapter interface exists

### Target State
- `orchestrate.spawn.execute` operation executes the spawn through a provider adapter
- Standardized `SpawnAdapter` interface per **actual** CAAMP 1.6.0 specification
- Support for Claude Code (native) and subprocess (fallback) adapters
- Proper error handling and fallback strategies

---

## 2. Interface Design

### 2.1 CAAMP 1.6.0 SpawnAdapter Interface (Actual)

**CAAMP Provider Interface** (verbatim from CAAMP 1.6.0 spec):

```typescript
interface SpawnAdapter {
  canSpawn(provider: Provider): boolean;
  spawn(provider: Provider, options: SpawnOptions): Promise<SpawnResult>;
  listRunning(provider: Provider): Promise<SpawnResult[]>;
  terminate(provider: Provider, instanceId: string): Promise<void>;
}

interface SpawnOptions {
  prompt: string;
  model?: string;
  tools?: string[];
  timeout?: number;
  isolate?: boolean;
}

interface SpawnResult {
  instanceId: string;
  status: "running" | "completed" | "failed";
  output?: string;
}
```

**CAAMP Capability Checking**:

```typescript
// Check if a specific provider supports spawning
const supportsSpawn = providerSupportsById("claude-code", "spawn.supportsSubagents");

// Get all spawn-capable providers
const capableProviders = getSpawnCapableProviders();
```

### 2.2 CLEO's Concrete Adapter Implementation

CLEO implements concrete adapters that wrap CAAMP's provider-neutral interface:

```typescript
/**
 * CLEO's concrete adapter for executing subagent spawns
 * Wraps CAAMP's SpawnAdapter with CLEO-specific context handling
 */
export interface CLEOSpawnAdapter {
  /**
   * Unique identifier for this adapter type
   */
  readonly provider: string;

  /**
   * Human-readable description of the adapter
   */
  readonly description: string;

  /**
   * Check if this adapter can spawn given current environment
   */
  canSpawn(): boolean;

  /**
   * Execute a spawn using the provider's native mechanism
   * @param context - Fully-resolved spawn context from orchestrate.spawn
   * @returns Promise resolving to spawn result
   * @throws SpawnExecutionError if spawn fails
   */
  spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult>;

  /**
   * List currently running spawns
   */
  listRunning(): Promise<CLEOSpawnResult[]>;

  /**
   * Terminate a running spawn
   */
  terminate(instanceId: string): Promise<void>;

  /**
   * Check if this adapter supports a specific capability
   */
  supports(capability: SpawnCapability): boolean;
}

/**
 * CLEO-specific spawn context (extends CAAMP options)
 */
export interface CLEOSpawnContext {
  /** Unique spawn identifier */
  spawnId: string;
  
  /** Task being spawned */
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  
  /** Fully-resolved prompt to send to subagent */
  prompt: string;
  
  /** Protocol and skill information */
  protocol: string;
  skill?: string;
  
  /** Output configuration */
  output: {
    directory: string;
    manifestPath: string;
    expectedOutputFile?: string;
  };
  
  /** Epic context */
  epicId?: string;
  
  /** Spawn metadata */
  spawnedAt: string; // ISO timestamp
  
  /** CAAMP-compatible spawn options */
  options?: {
    model?: string;
    tools?: string[];
    timeout?: number;
    isolate?: boolean;
  };
  
  /** Provider-specific overrides */
  providerOptions?: Record<string, unknown>;
}

/**
 * CLEO-specific spawn result (extends CAAMP result)
 */
export interface CLEOSpawnResult {
  /** Unique spawn identifier (instanceId in CAAMP) */
  spawnId: string;
  
  /** Execution status (mapped from CAAMP status) */
  status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'running';
  
  /** Task that was spawned */
  taskId: string;
  
  /** Success indicator */
  success: boolean;
  
  /** Timing information */
  timing: {
    startedAt: string;
    completedAt?: string;
    durationMs: number;
  };
  
  /** Output information */
  output?: {
    /** Path to output file if captured */
    filePath?: string;
    /** Whether manifest entry was appended */
    manifestAppended: boolean;
    /** Captured output (from CAAMP output field) */
    content?: string;
  };
  
  /** Error information if failed */
  error?: {
    code: string;
    message: string;
    details?: unknown;
    isRetryable: boolean;
  };
  
  /** Provider-specific result data */
  providerData?: Record<string, unknown>;
}

/**
 * Spawn capabilities that adapters may support
 */
export type SpawnCapability =
  | 'parallel-spawn'      // Can spawn multiple agents simultaneously
  | 'agent-initiated'     // Agents can spawn other agents
  | 'inter-agent-comms'   // Agents can message each other
  | 'recursive-spawn'     // Agents can become orchestrators
  | 'token-tracking'      // Provider reports token usage
  | 'progress-monitoring' // Can monitor agent progress
  | 'cancellation'        // Can cancel running agents
  | 'output-capture';     // Can capture agent output files
```

### 2.3 Adapter Mapping: CAAMP to CLEO

**CAAMP SpawnAdapter Methods -> CLEO Implementation**:

| CAAMP Method | CLEO Method | Description |
|--------------|-------------|-------------|
| `canSpawn(provider)` | `canSpawn()` | Check if adapter can spawn |
| `spawn(provider, options)` | `spawn(context)` | Execute spawn with CLEO context |
| `listRunning(provider)` | `listRunning()` | List running spawns |
| `terminate(provider, instanceId)` | `terminate(instanceId)` | Terminate a spawn |

**CAAMP SpawnOptions -> CLEO Context**:

| CAAMP Field | CLEO Field | Notes |
|-------------|------------|-------|
| `prompt` | `context.prompt` | Direct mapping |
| `model` | `context.options.model` | Optional model override |
| `tools` | `context.options.tools` | Tool restrictions |
| `timeout` | `context.options.timeout` | Execution timeout |
| `isolate` | `context.options.isolate` | Run in isolated context |
| N/A | `context.taskId` | CLEO-specific metadata |
| N/A | `context.output` | CLEO output configuration |
| N/A | `context.spawnId` | Unique spawn identifier |

**CAAMP SpawnResult -> CLEO Result**:

| CAAMP Field | CLEO Field | Mapping |
|-------------|------------|---------|
| `instanceId` | `spawnId` | Direct mapping |
| `status` | `status` | Maps to CLEO status enum |
| `output` | `output.content` | Captured output |

---

## 3. Adapter Implementations

### 3.1 Claude Code Adapter (Primary)

```typescript
/**
 * Claude Code Spawn Adapter
 * Wraps CAAMP provider for Claude Code with Task tool support
 */
export class ClaudeCodeAdapter implements CLEOSpawnAdapter {
  readonly provider = 'claude-code';
  readonly description = 'Claude Code Task tool adapter for native subagent spawning';
  
  private caampProvider: CAAMPProvider;
  
  constructor(caampProvider: CAAMPProvider) {
    this.caampProvider = caampProvider;
  }
  
  canSpawn(): boolean {
    // Use CAAMP capability check
    return providerSupportsById("claude-code", "spawn.supportsSubagents");
  }
  
  async spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult> {
    const startedAt = new Date().toISOString();
    
    // Build CAAMP-compatible options from CLEO context
    const caampOptions: SpawnOptions = {
      prompt: context.prompt,
      model: context.options?.model,
      tools: context.options?.tools,
      timeout: context.options?.timeout ?? 1800000, // Default 30 min
      isolate: context.options?.isolate ?? true,
    };
    
    // Execute via CAAMP provider
    const caampResult = await this.caampProvider.spawnAdapter.spawn(
      this.caampProvider,
      caampOptions
    );
    
    // Map CAAMP result to CLEO result
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    
    return {
      spawnId: caampResult.instanceId,
      status: this.mapCaampStatus(caampResult.status),
      taskId: context.taskId,
      success: caampResult.status === 'completed',
      timing: { startedAt, completedAt, durationMs },
      output: {
        manifestAppended: await this.checkManifestAppended(context),
        content: caampResult.output,
        filePath: context.output.expectedOutputFile,
      },
    };
  }
  
  async listRunning(): Promise<CLEOSpawnResult[]> {
    const caampResults = await this.caampProvider.spawnAdapter.listRunning(this.caampProvider);
    return caampResults.map(r => this.mapCaampResultToCLEO(r));
  }
  
  async terminate(instanceId: string): Promise<void> {
    await this.caampProvider.spawnAdapter.terminate(this.caampProvider, instanceId);
  }
  
  supports(capability: SpawnCapability): boolean {
    const supported: SpawnCapability[] = [
      'parallel-spawn',
      'agent-initiated',
      'inter-agent-comms',
      'recursive-spawn',
      'token-tracking',
      'progress-monitoring',
      'cancellation',
      'output-capture'
    ];
    return supported.includes(capability);
  }
  
  private mapCaampStatus(caampStatus: string): CLEOSpawnResult['status'] {
    switch (caampStatus) {
      case 'running': return 'running';
      case 'completed': return 'completed';
      case 'failed': return 'failed';
      default: return 'failed';
    }
  }
  
  private async checkManifestAppended(context: CLEOSpawnContext): Promise<boolean> {
    // Verify manifest was updated
    // Implementation details...
    return true;
  }
}
```

**Key Implementation Details:**
- Wraps CAAMP's `spawnAdapter` interface
- Maps CAAMP's simple `SpawnOptions` to CLEO's richer `CLEOSpawnContext`
- Transforms CAAMP's `SpawnResult` to CLEO's `CLEOSpawnResult`
- Uses CAAMP capability checks via `providerSupportsById()`

### 3.2 Subprocess Adapter (Fallback)

```typescript
/**
 * Subprocess Spawn Adapter
 * Fallback adapter using CLI subprocess when CAAMP providers unavailable
 */
export class SubprocessAdapter implements CLEOSpawnAdapter {
  readonly provider = 'subprocess';
  readonly description = 'Subprocess-based adapter for CLI execution';
  
  private cliPath: string;
  
  constructor(cliPath: string = 'claude') {
    this.cliPath = cliPath;
  }
  
  canSpawn(): boolean {
    // Check if CLI binary exists in PATH
    try {
      execSync(`which ${this.cliPath}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  
  async spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult> {
    const startedAt = new Date().toISOString();
    const spawnId = context.spawnId;
    
    // Write prompt to temporary file
    const promptFile = path.join('/tmp', `cleo-spawn-${spawnId}.prompt.md`);
    await fs.writeFile(promptFile, context.prompt, 'utf8');
    
    // Build CLI command (mimics CAAMP spawn interface)
    const outputFile = context.output.expectedOutputFile || 
                       path.join(context.output.directory, `${spawnId}.md`);
    const timeout = context.options?.timeout ?? 1800000;
    
    const command = [
      this.cliPath,
      '--prompt-file', promptFile,
      '--output', outputFile,
      context.options?.isolate ? '--isolate' : '',
    ].filter(Boolean).join(' ');
    
    try {
      // Execute subprocess
      const { stdout, stderr } = await execAsync(command, { 
        timeout,
        cwd: process.cwd(),
      });
      
      const completedAt = new Date().toISOString();
      const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
      
      // Cleanup temp file
      await fs.unlink(promptFile).catch(() => {});
      
      return {
        spawnId,
        status: 'completed',
        taskId: context.taskId,
        success: true,
        timing: { startedAt, completedAt, durationMs },
        output: {
          manifestAppended: await this.checkManifestAppended(context),
          content: stdout,
          filePath: outputFile,
        },
      };
    } catch (error) {
      const failedAt = new Date().toISOString();
      const durationMs = new Date(failedAt).getTime() - new Date(startedAt).getTime();
      
      // Cleanup temp file
      await fs.unlink(promptFile).catch(() => {});
      
      return {
        spawnId,
        status: error.killed ? 'timeout' : 'failed',
        taskId: context.taskId,
        success: false,
        timing: { startedAt, completedAt: failedAt, durationMs },
        error: {
          code: error.killed ? 'E_SPAWN_TIMEOUT' : 'E_SPAWN_FAILED',
          message: error.message,
          isRetryable: error.killed, // Timeout is retryable
        },
      };
    }
  }
  
  async listRunning(): Promise<CLEOSpawnResult[]> {
    // Subprocess adapter cannot track running processes across invocations
    // Returns empty array
    return [];
  }
  
  async terminate(instanceId: string): Promise<void> {
    // Find and kill process by spawnId
    // Implementation depends on OS
    throw new Error('Subprocess adapter does not support termination');
  }
  
  supports(capability: SpawnCapability): boolean {
    const supported: SpawnCapability[] = ['output-capture'];
    return supported.includes(capability);
  }
  
  private async checkManifestAppended(context: CLEOSpawnContext): Promise<boolean> {
    // Verify manifest was updated
    // Implementation details...
    return true;
  }
}
```

**Key Implementation Details:**
- Mimics CAAMP interface but uses subprocess instead
- Writes prompt to temp file
- Executes CLI command directly
- Cannot track/list/terminate running processes reliably
- Used as fallback when no CAAMP providers available

---

## 4. Operation Design

### 4.1 orchestrate.spawn.execute Operation

**Operation Details:**
- **Domain**: orchestrate
- **Gateway**: mutate
- **Operation**: spawn.execute
- **Tier**: 2
- **Idempotent**: false (each execution creates a new spawn)
- **Session Required**: true (must have active session to spawn)

**Parameters:**

```typescript
interface OrchestrateSpawnExecuteParams {
  /** Task ID to spawn */
  taskId: string;
  
  /** Optional: Specific adapter to use (auto-detected if not specified) */
  adapter?: 'claude-code' | 'subprocess' | 'auto';
  
  /** Optional: Override skill/protocol */
  skill?: string;
  
  /** Optional: Execution timeout in milliseconds (CAAMP-compatible) */
  timeout?: number;
  
  /** Optional: Model to use (CAAMP-compatible) */
  model?: string;
  
  /** Optional: Tools to allow (CAAMP-compatible) */
  tools?: string[];
  
  /** Optional: Run in isolated context (CAAMP-compatible) */
  isolate?: boolean;
  
  /** Optional: Provider-specific options */
  providerOptions?: Record<string, unknown>;
}
```

**Result:**

```typescript
interface OrchestrateSpawnExecuteResult {
  spawnId: string;
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'running';
  adapter: string;
  timing: {
    startedAt: string;
    completedAt?: string;
    durationMs: number;
  };
  output?: {
    filePath?: string;
    manifestAppended: boolean;
    content?: string;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
```

**Execution Flow:**

```
1. Validate parameters (taskId exists, session active)
2. Call orchestrate.validate to check task readiness
3. If not ready, return error with blockers
4. Call orchestrate.spawn to generate spawn context
5. Check CAAMP capability: providerSupportsById("claude-code", "spawn.supportsSubagents")
6. Select adapter:
   a. If user specified adapter, use it
   b. If CAAMP provider supports spawn, use ClaudeCodeAdapter
   c. Fall back to SubprocessAdapter
7. Validate adapter environment (adapter.canSpawn())
8. Execute spawn via adapter.spawn(context)
9. Update task status to 'active'
10. Return CLEOSpawnResult
```

**CAAMP Integration:**

```typescript
async function executeSpawn(params: OrchestrateSpawnExecuteParams): Promise<OrchestrateSpawnExecuteResult> {
  // Step 1: Check CAAMP capabilities
  const caampProviders = getSpawnCapableProviders();
  const claudeCodeProvider = caampProviders.find(p => p.id === 'claude-code');
  
  // Step 2: Select adapter
  let adapter: CLEOSpawnAdapter;
  if (params.adapter === 'claude-code' && claudeCodeProvider) {
    adapter = new ClaudeCodeAdapter(claudeCodeProvider);
  } else if (params.adapter === 'subprocess') {
    adapter = new SubprocessAdapter();
  } else {
    // Auto-select: prefer CAAMP provider, fallback to subprocess
    if (claudeCodeProvider && providerSupportsById("claude-code", "spawn.supportsSubagents")) {
      adapter = new ClaudeCodeAdapter(claudeCodeProvider);
    } else {
      adapter = new SubprocessAdapter();
    }
  }
  
  // Step 3: Validate adapter can spawn
  if (!adapter.canSpawn()) {
    throw new SpawnExecutionError('E_SPAWN_ADAPTER_UNAVAILABLE', 
      `Adapter ${adapter.provider} cannot spawn in current environment`);
  }
  
  // Step 4: Build CLEO context from CAAMP-compatible options
  const context: CLEOSpawnContext = {
    spawnId: generateSpawnId(),
    taskId: params.taskId,
    taskTitle: task.title,
    taskDescription: task.description,
    prompt: resolvedPrompt,
    protocol: task.protocol,
    skill: params.skill || task.skill,
    output: { /* ... */ },
    spawnedAt: new Date().toISOString(),
    options: {
      timeout: params.timeout,
      model: params.model,
      tools: params.tools,
      isolate: params.isolate,
    },
  };
  
  // Step 5: Execute via adapter (which internally uses CAAMP spawnAdapter)
  const result = await adapter.spawn(context);
  
  // Step 6: Return result
  return {
    spawnId: result.spawnId,
    taskId: result.taskId,
    status: result.status,
    adapter: adapter.provider,
    timing: result.timing,
    output: result.output,
    error: result.error,
  };
}
```

### 4.2 Additional Operations

**orchestrate.spawn.status** (query)
- Check status of a running spawn
- Parameters: `{ spawnId: string }`
- Returns: Current status and progress
- Uses: `adapter.listRunning()` to find spawn

**orchestrate.spawn.cancel** (mutate)
- Cancel a running spawn
- Parameters: `{ spawnId: string }`
- Returns: Cancellation result
- Uses: `adapter.terminate(instanceId)` via CAAMP

**orchestrate.spawn.adapter.list** (query)
- List available adapters
- Returns: Array of adapter metadata
- Uses: `getSpawnCapableProviders()` for CAAMP providers + subprocess check

**orchestrate.spawn.adapter.show** (query)
- Show adapter details and capabilities
- Parameters: `{ adapter: string }`
- Returns: Adapter capabilities and availability

---

## 5. Error Handling Strategy

### 5.1 Error Categories

| Code | Category | Description | Retryable |
|------|----------|-------------|-----------|
| E_SPAWN_ADAPTER_NOT_FOUND | Configuration | Requested adapter not available | No |
| E_SPAWN_ADAPTER_UNAVAILABLE | Environment | Adapter canSpawn() returned false | No |
| E_SPAWN_TASK_NOT_READY | Validation | Task dependencies not met | No |
| E_SPAWN_CAAMP_ERROR | CAAMP | CAAMP provider error | Depends |
| E_SPAWN_TIMEOUT | Execution | Spawn exceeded timeout | Yes |
| E_SPAWN_FAILED | Execution | Spawn failed | Yes |
| E_SPAWN_OUTPUT_MISSING | Validation | Expected output not produced | Yes |
| E_SPAWN_MANIFEST_MISSING | Validation | Manifest entry not appended | No |
| E_SPAWN_TERMINATION | User | Spawn was terminated | Yes |

### 5.2 CAAMP Error Mapping

**CAAMP Errors -> CLEO Errors**:

| CAAMP Error | CLEO Error | Action |
|-------------|------------|--------|
| Provider not found | E_SPAWN_ADAPTER_NOT_FOUND | No fallback |
| Provider does not support spawn | E_SPAWN_ADAPTER_UNAVAILABLE | Try subprocess fallback |
| Timeout | E_SPAWN_TIMEOUT | Retryable |
| Spawn failed | E_SPAWN_FAILED | Depends on error |

### 5.3 Fallback Strategy

```typescript
async function executeWithFallback(
  context: CLEOSpawnContext,
  params: OrchestrateSpawnExecuteParams
): Promise<CLEOSpawnResult> {
  // Try user-specified adapter first
  if (params.adapter && params.adapter !== 'auto') {
    const adapter = createAdapter(params.adapter);
    if (adapter.canSpawn()) {
      return await adapter.spawn(context);
    }
    throw new SpawnExecutionError('E_SPAWN_ADAPTER_UNAVAILABLE', 
      `Specified adapter ${params.adapter} is not available`);
  }
  
  // Auto-select: Try CAAMP providers first
  const caampProviders = getSpawnCapableProviders();
  for (const provider of caampProviders) {
    const adapter = new ClaudeCodeAdapter(provider);
    if (adapter.canSpawn()) {
      try {
        return await adapter.spawn(context);
      } catch (error) {
        if (error.isRetryable) {
          continue; // Try next provider
        }
        throw error;
      }
    }
  }
  
  // Fallback to subprocess
  const subprocessAdapter = new SubprocessAdapter();
  if (subprocessAdapter.canSpawn()) {
    return await subprocessAdapter.spawn(context);
  }
  
  // All adapters failed
  throw new SpawnExecutionError(
    'E_SPAWN_ALL_ADAPTERS_FAILED',
    'No spawn adapters available in current environment',
    context.spawnId,
    false
  );
}
```

### 5.4 Adapter Selection Priority

1. **User-specified CAAMP adapter** (if provided and available)
2. **Auto-detected CAAMP provider** (via `getSpawnCapableProviders()`)
3. **Subprocess adapter** (universal fallback)
4. **Error** if no adapters available

---

## 6. File Changes Plan

### 6.1 New Files to Create

| File | Purpose | Lines (est) |
|------|---------|-------------|
| `src/types/spawn.ts` | Spawn adapter types and interfaces | 200 |
| `src/core/spawn/adapters/claude-code-adapter.ts` | Claude Code CAAMP adapter | 150 |
| `src/core/spawn/adapters/subprocess-adapter.ts` | Subprocess fallback adapter | 120 |
| `src/core/spawn/adapter-registry.ts` | Adapter registration and CAAMP integration | 80 |
| `src/core/spawn/execution.ts` | Core spawn execution logic | 120 |
| `src/core/spawn/errors.ts` | Spawn-specific error classes | 40 |
| `src/core/spawn/index.ts` | Barrel exports | 15 |
| `src/core/spawn/caamp-types.ts` | CAAMP 1.6.0 type definitions | 50 |
| `src/dispatch/engines/spawn-engine.ts` | Spawn engine functions | 100 |
| `src/core/spawn/__tests__/claude-code-adapter.test.ts` | Claude adapter tests | 120 |
| `src/core/spawn/__tests__/subprocess-adapter.test.ts` | Subprocess adapter tests | 80 |
| `src/core/spawn/__tests__/execution.test.ts` | Execution logic tests | 100 |

**Total New Files**: 12  
**Estimated Lines**: ~1,195

### 6.2 Files to Modify

| File | Changes | Lines (est) |
|------|---------|-------------|
| `src/dispatch/engines/orchestrate-engine.ts` | Add `orchestrateSpawnExecute` function | +50 |
| `src/dispatch/domains/orchestrate.ts` | Add `spawn.execute` case to mutate handler | +35 |
| `src/dispatch/registry.ts` | Add `orchestrate.spawn.execute` operation definition | +18 |
| `src/dispatch/lib/engine.ts` | Export spawn engine functions | +8 |
| `src/types/index.ts` | Export spawn types | +5 |

**Total Modified Files**: 5  
**Estimated Lines Added**: ~116

### 6.3 Detailed Change Specifications

#### src/core/spawn/caamp-types.ts (NEW)

CAAMP 1.6.0 type definitions (verbatim from spec):

```typescript
/**
 * CAAMP 1.6.0 Spawn Adapter Interface
 * @see CAAMP Specification 1.6.0
 */
export interface SpawnAdapter {
  canSpawn(provider: Provider): boolean;
  spawn(provider: Provider, options: SpawnOptions): Promise<SpawnResult>;
  listRunning(provider: Provider): Promise<SpawnResult[]>;
  terminate(provider: Provider, instanceId: string): Promise<void>;
}

export interface SpawnOptions {
  prompt: string;
  model?: string;
  tools?: string[];
  timeout?: number;
  isolate?: boolean;
}

export interface SpawnResult {
  instanceId: string;
  status: "running" | "completed" | "failed";
  output?: string;
}

// CAAMP utility functions
export declare function providerSupportsById(
  providerId: string, 
  capability: string
): boolean;

export declare function getSpawnCapableProviders(): Provider[];
```

#### src/types/spawn.ts (NEW)

CLEO's concrete adapter types:

```typescript
import type { SpawnAdapter, SpawnOptions, SpawnResult } from '../core/spawn/caamp-types.js';

/**
 * CLEO's concrete adapter interface (wraps CAAMP)
 */
export interface CLEOSpawnAdapter {
  readonly provider: string;
  readonly description: string;
  canSpawn(): boolean;
  spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult>;
  listRunning(): Promise<CLEOSpawnResult[]>;
  terminate(instanceId: string): Promise<void>;
  supports(capability: SpawnCapability): boolean;
}

export interface CLEOSpawnContext {
  spawnId: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  prompt: string;
  protocol: string;
  skill?: string;
  output: {
    directory: string;
    manifestPath: string;
    expectedOutputFile?: string;
  };
  epicId?: string;
  spawnedAt: string;
  options?: SpawnOptions;  // CAAMP-compatible options
  providerOptions?: Record<string, unknown>;
}

export interface CLEOSpawnResult {
  spawnId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'running';
  taskId: string;
  success: boolean;
  timing: {
    startedAt: string;
    completedAt?: string;
    durationMs: number;
  };
  output?: {
    filePath?: string;
    manifestAppended: boolean;
    content?: string;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
    isRetryable: boolean;
  };
  providerData?: Record<string, unknown>;
}

export type SpawnCapability =
  | 'parallel-spawn'
  | 'agent-initiated'
  | 'inter-agent-comms'
  | 'recursive-spawn'
  | 'token-tracking'
  | 'progress-monitoring'
  | 'cancellation'
  | 'output-capture';
```

#### src/core/spawn/adapters/claude-code-adapter.ts (NEW)

Implements `CLEOSpawnAdapter` wrapping CAAMP's `SpawnAdapter`:

```typescript
import { CLEOSpawnAdapter, CLEOSpawnContext, CLEOSpawnResult } from '../../types/spawn.js';
import { SpawnAdapter, Provider, providerSupportsById } from '../caamp-types.js';

export class ClaudeCodeAdapter implements CLEOSpawnAdapter {
  readonly provider = 'claude-code';
  readonly description = 'Claude Code Task tool adapter via CAAMP';
  
  constructor(private caampProvider: Provider & { spawnAdapter: SpawnAdapter }) {}
  
  canSpawn(): boolean {
    return providerSupportsById("claude-code", "spawn.supportsSubagents");
  }
  
  async spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult> {
    const startedAt = new Date().toISOString();
    
    // Map CLEO context to CAAMP options
    const caampOptions = {
      prompt: context.prompt,
      model: context.options?.model,
      tools: context.options?.tools,
      timeout: context.options?.timeout ?? 1800000,
      isolate: context.options?.isolate ?? true,
    };
    
    // Execute via CAAMP
    const caampResult = await this.caampProvider.spawnAdapter.spawn(
      this.caampProvider,
      caampOptions
    );
    
    // Map back to CLEO result
    return this.mapToCLEOResult(caampResult, context, startedAt);
  }
  
  async listRunning(): Promise<CLEOSpawnResult[]> {
    const results = await this.caampProvider.spawnAdapter.listRunning(this.caampProvider);
    return results.map(r => this.mapToCLEOResult(r, /* context */ null, /* startedAt */ null));
  }
  
  async terminate(instanceId: string): Promise<void> {
    await this.caampProvider.spawnAdapter.terminate(this.caampProvider, instanceId);
  }
  
  supports(capability: string): boolean {
    // Implementation
    return false;
  }
  
  private mapToCLEOResult(
    caampResult: any, 
    context: CLEOSpawnContext | null, 
    startedAt: string | null
  ): CLEOSpawnResult {
    // Implementation
  }
}
```

#### src/dispatch/engines/orchestrate-engine.ts (MODIFY)

Add new function:

```typescript
export async function orchestrateSpawnExecute(
  taskId: string,
  adapter?: string,
  projectRoot?: string,
  options?: {
    timeout?: number;
    model?: string;
    tools?: string[];
    isolate?: boolean;
  },
): Promise<EngineResult> {
  // 1. Validate task readiness
  // 2. Get spawn context via orchestrate.spawn
  // 3. Check CAAMP capabilities via getSpawnCapableProviders()
  // 4. Select and instantiate adapter
  // 5. Execute via adapter.spawn()
  // 6. Return result
}
```

---

## 7. Test Plan

### 7.1 Unit Tests

| Test Suite | Coverage | Cases |
|------------|----------|-------|
| ClaudeCodeAdapter | 90%+ | CAAMP integration, status mapping, error handling |
| SubprocessAdapter | 90%+ | CLI detection, spawning, timeout handling |
| AdapterRegistry | 90%+ | CAAMP provider discovery, fallback logic |
| SpawnExecution | 90%+ | Adapter selection, CAAMP integration, result validation |

### 7.2 Integration Tests

| Test | Description |
|------|-------------|
| CAAMP integration | Verify integration with CAAMP providerSupportsById() and getSpawnCapableProviders() |
| End-to-end spawn | Full flow: validate -> spawn -> execute via CAAMP -> verify |
| Fallback chain | CAAMP unavailable -> fallback to subprocess |
| CAAMP error handling | Verify CAAMP errors mapped to CLEO errors correctly |

### 7.3 Test Scenarios

```typescript
// Scenario 1: Successful CAAMP spawn
describe('CAAMP spawn via Claude Code', () => {
  it('should execute via CAAMP spawnAdapter and return result', async () => {
    // Mock CAAMP providerSupportsById() to return true
    // Mock getSpawnCapableProviders() to return claude-code provider
    // Execute spawn
    // Verify CAAMP spawn() called with correct options
    // Verify CLEO result correctly mapped from CAAMP result
  });
});

// Scenario 2: CAAMP capability check
describe('CAAMP capability checking', () => {
  it('should use providerSupportsById to check spawn support', async () => {
    // Mock providerSupportsById("claude-code", "spawn.supportsSubagents")
    // Verify adapter.canSpawn() uses CAAMP check
  });
});

// Scenario 3: Subprocess fallback when CAAMP unavailable
describe('Subprocess fallback', () => {
  it('should fallback when no CAAMP providers support spawn', async () => {
    // Mock getSpawnCapableProviders() to return empty
    // Execute spawn with auto adapter
    // Verify subprocess adapter used
  });
});
```

---

## 8. Dependencies and Prerequisites

### 8.1 Required For Implementation

1. **CAAMP 1.6.0** library available
2. **Task T4820** (orchestrate domain) completed and stable
3. **Node.js 20+** for subprocess APIs
4. **Claude Code Task tool** API documentation

### 8.2 CAAMP Integration Points

**Required CAAMP Functions:**
- `providerSupportsById(providerId, capability)` - Check spawn support
- `getSpawnCapableProviders()` - Discover spawn-capable providers
- `Provider.spawnAdapter` - Access provider's SpawnAdapter interface

**CAAMP Types Needed:**
- `SpawnAdapter` interface
- `SpawnOptions` interface
- `SpawnResult` interface
- `Provider` type

---

## 9. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| CAAMP API changes | High | Low | Abstract behind CLEO adapter interface |
| CAAMP library unavailable | High | Low | Subprocess adapter as fallback |
| Claude Code Task API changes | High | Medium | Use CAAMP abstraction layer |
| Subprocess spawning security | Medium | Low | Validate prompt content, use temp files with restricted permissions |
| CAAMP capability detection fails | Medium | Low | Multiple validation checks, user override option |

---

## 10. Open Questions

### 10.1 Clarifications Needed

1. **Q**: How does CLEO access the CAAMP library? Is it a peer dependency or bundled?
   - **Recommendation**: Treat as peer dependency, provide clear installation instructions

2. **Q**: Should we cache CAAMP capability checks to avoid repeated calls?
   - **Recommendation**: Yes, cache for the duration of the session

3. **Q**: What's the expected behavior when `isolate=true` vs `isolate=false`?
   - **Recommendation**: Document CAAMP semantics in CLEO docs

### 10.2 Design Decisions Pending

1. **CAAMP version compatibility**: Support 1.6.0+ only or backward compatibility?
2. **Multi-provider spawning**: Spawn to multiple CAAMP providers simultaneously?
3. **Provider configuration**: How to configure provider-specific options?

---

## 11. Acceptance Criteria

- [ ] `CLEOSpawnAdapter` interface defined aligning with CAAMP's `SpawnAdapter`
- [ ] `ClaudeCodeAdapter` implemented wrapping CAAMP provider
- [ ] `SubprocessAdapter` implemented as fallback
- [ ] `orchestrate.spawn.execute` operation added to dispatch layer
- [ ] Adapter auto-detection uses `getSpawnCapableProviders()`
- [ ] Capability checking uses `providerSupportsById()`
- [ ] Fallback to subprocess when no CAAMP providers available
- [ ] Task readiness validation before spawn
- [ ] Proper error codes mapping CAAMP errors to CLEO errors
- [ ] Unit tests for all adapters with 90%+ coverage
- [ ] Integration tests for CAAMP integration
- [ ] Documentation updated with CAAMP integration details

---

## 12. Implementation Phases

### Phase 1B: CAAMP Types and Interfaces
- Create `src/core/spawn/caamp-types.ts` with CAAMP 1.6.0 types
- Create `src/types/spawn.ts` with CLEO adapter types
- Define adapter interface mapping CAAMP -> CLEO

### Phase 1C: Subprocess Adapter
- Implement `SubprocessAdapter` as fallback
- CLI detection logic
- Basic spawn execution without CAAMP

### Phase 1D: Claude Code CAAMP Adapter
- Implement `ClaudeCodeAdapter` wrapping CAAMP
- Integration with `providerSupportsById()` and `getSpawnCapableProviders()`
- CAAMP result mapping to CLEO results

### Phase 1E: Dispatch Integration
- Add `orchestrateSpawnExecute` to engine
- Update domain handler with CAAMP capability checks
- Update registry
- Add tests

---

## 13. Summary of Changes from Previous Design

### Key Changes to Align with CAAMP 1.6.0:

1. **SpawnAdapter Interface**: Updated from custom interface to CAAMP's actual interface with 4 methods (`canSpawn`, `spawn`, `listRunning`, `terminate`)

2. **SpawnOptions**: Aligned with CAAMP's simpler structure (`prompt`, `model`, `tools`, `timeout`, `isolate`) instead of complex CLEO-specific options

3. **SpawnResult**: Updated to map CAAMP's simple result (`instanceId`, `status`, `output`) to CLEO's richer result structure

4. **Capability Checking**: Added `providerSupportsById()` and `getSpawnCapableProviders()` usage instead of adapter `supports()` method being primary

5. **Adapter Architecture**: Changed from direct implementation to **wrapper pattern** where CLEO adapters wrap CAAMP providers

6. **Simplified Execution**: Removed `execute()` method in favor of CAAMP's `spawn()` method signature

7. **Error Handling**: Added explicit CAAMP error mapping section

8. **File Structure**: Added `caamp-types.ts` for CAAMP type definitions, clarified separation between CAAMP types and CLEO concrete adapters

---

**End of Updated Design Document**

**Next Step**: Review changes and proceed to Phase 1B implementation.
