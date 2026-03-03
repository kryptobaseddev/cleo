# T5237: Universal Hooks Design Document

**Phase**: 1A - Design and Planning  
**Status**: Ready for Review  
**Owner**: Team Alpha  
**Date**: 2026-03-03  

---

## 1. Executive Summary

This document outlines the design for implementing the Universal Hooks system for CLEO (T5237). The goal is to integrate CAAMP's universal hook abstraction to enable automatic memory capture via BRAIN observers when lifecycle events occur.

### Key Distinction: CAAMP vs CLEO Responsibilities

**CAAMP (v1.6.0) provides:**
- Hook EVENT definitions (`HookEvent` type)
- Provider capability queries (`getProvidersByHookEvent`, `getCommonHookEvents`)

**CLEO builds:**
- Hook REGISTRY (handler registration/management)
- Hook EXECUTION layer (event firing and handler invocation)
- Lifecycle EVENT MAPPING (CLEO events → CAAMP events)

### Current State
- BRAIN has `brain.observe()` for manual memory capture
- No automatic trigger layer exists
- CAAMP #38 defines hook events but not execution

### Target State
- Hook registry with handler registration
- Automatic execution when lifecycle events fire
- CAAMP-aware: query which providers support which hooks
- Memory auto-capture via BRAIN observers

---

## 2. CAAMP Hook Event Reference

### 2.1 ACTUAL CAAMP HookEvent Type (v1.6.0)

```typescript
/**
 * Hook events defined by CAAMP 1.6.0
 * CAAMP defines events only - CLEO provides execution
 */
type HookEvent = 
  | "onSessionStart"      // Session begins
  | "onSessionEnd"        // Session ends
  | "onToolStart"         // Tool/agent operation starts
  | "onToolComplete"      // Tool/agent operation completes
  | "onFileChange"        // File modification detected
  | "onError"             // Error occurs
  | "onPromptSubmit"      // Prompt submitted to LLM
  | "onResponseComplete"; // LLM response received
```

### 2.2 CAAMP Provider Query Functions

```typescript
/**
 * Get all providers that support a specific hook event
 * @param event - The hook event to check
 * @returns Array of provider objects that support this event
 */
function getProvidersByHookEvent(event: HookEvent): Provider[];

/**
 * Get hook events common to all specified providers
 * @param providerIds - Optional array of provider IDs (uses active providers if omitted)
 * @returns Array of hook events supported by all specified providers
 */
function getCommonHookEvents(providerIds?: string[]): HookEvent[];
```

### 2.3 Provider Interface

```typescript
interface Provider {
  id: string;                    // e.g., "claude", "opencode", "codex"
  name: string;                  // Human-readable name
  version: string;               // Provider version
  supportedHooks: HookEvent[];   // Which CAAMP events this provider supports
  capabilities: string[];        // Additional capabilities
}
```

---

## 3. CLEO Lifecycle Event Mapping

### 3.1 Event Mapping Table

| CLEO Lifecycle Event | CAAMP HookEvent | Trigger Condition |
|---------------------|-----------------|-------------------|
| `session.start` | `onSessionStart` | User starts a CLEO session |
| `session.end` | `onSessionEnd` | User ends a CLEO session |
| `task.start` | `onToolStart` | Task becomes active (conceptually tool start) |
| `task.complete` | `onToolComplete` | Task marked done (conceptually tool completion) |
| `file.write` | `onFileChange` | File modified via CLEO operations |
| `error.caught` | `onError` | Error handled by CLEO error boundary |
| `prompt.submit` | `onPromptSubmit` | Prompt sent to LLM (if trackable) |
| `response.complete` | `onResponseComplete` | LLM response received (if trackable) |

### 3.2 Mapping Implementation

```typescript
/**
 * Maps CLEO internal lifecycle events to CAAMP HookEvent names
 * This is where CLEO connects its lifecycle to CAAMP's event definitions
 */
const CLEO_TO_CAAMP_EVENT_MAP: Record<string, HookEvent> = {
  // Session lifecycle
  'session.start': 'onSessionStart',
  'session.end': 'onSessionEnd',
  
  // Task lifecycle (mapped to tool events conceptually)
  'task.start': 'onToolStart',
  'task.complete': 'onToolComplete',
  
  // File operations
  'file.write': 'onFileChange',
  'file.delete': 'onFileChange',
  'file.rename': 'onFileChange',
  
  // Error handling
  'error.caught': 'onError',
  'error.uncaught': 'onError',
  
  // LLM interaction (if supported by provider)
  'llm.prompt': 'onPromptSubmit',
  'llm.response': 'onResponseComplete',
};

/**
 * Convert CLEO event name to CAAMP HookEvent
 */
function toCaampHookEvent(cleoEvent: string): HookEvent | undefined {
  return CLEO_TO_CAAMP_EVENT_MAP[cleoEvent];
}
```

---

## 4. Hook Registry Design

### 4.1 HookHandler Interface

```typescript
/**
 * Hook handler function signature
 * All handlers are async and receive event context
 */
type HookHandler<T = unknown> = (
  context: HookContext<T>
) => Promise<void> | void;

/**
 * Context passed to hook handlers
 */
interface HookContext<T = unknown> {
  /** CAAMP hook event that fired */
  event: HookEvent;
  
  /** Original CLEO event that triggered this */
  cleoEvent: string;
  
  /** Timestamp when event fired */
  timestamp: string;
  
  /** Session ID (if in a session) */
  sessionId?: string;
  
  /** Task ID (if in a task context) */
  taskId?: string;
  
  /** Provider that triggered the hook (if known) */
  provider?: string;
  
  /** Event-specific data payload */
  data: T;
  
  /** Whether this hook is cancellable (default: false) */
  cancellable: boolean;
  
  /** Cancel the operation (only if cancellable) */
  cancel?: (reason: string) => void;
}

/**
 * Handler registration options
 */
interface HookRegistrationOptions {
  /** Handler priority (lower = earlier, default: 100) */
  priority?: number;
  
  /** Only run for specific providers (default: all) */
  providers?: string[];
  
  /** Only run in specific session types (default: all) */
  sessionTypes?: string[];
  
  /** Maximum executions (default: unlimited) */
  maxExecutions?: number;
  
  /** Handler description for debugging */
  description?: string;
}

/**
 * Registered handler metadata
 */
interface RegisteredHandler {
  id: string;
  event: HookEvent;
  handler: HookHandler;
  options: Required<HookRegistrationOptions>;
  registrationTime: string;
  executionCount: number;
}
```

### 4.2 Hook Registry Interface

```typescript
/**
 * Hook Registry - CLEO's execution layer for CAAMP events
 * Manages handler registration and event firing
 */
export interface HookRegistry {
  /**
   * Register a handler for a CAAMP hook event
   * @param event - CAAMP HookEvent to listen for
   * @param handler - Handler function to execute
   * @param options - Registration options
   * @returns Handler ID for later unregistration
   */
  on<T>(
    event: HookEvent,
    handler: HookHandler<T>,
    options?: HookRegistrationOptions
  ): string;

  /**
   * Register a one-time handler
   * @param event - CAAMP HookEvent to listen for
   * @param handler - Handler function to execute once
   * @param options - Registration options
   * @returns Handler ID
   */
  once<T>(
    event: HookEvent,
    handler: HookHandler<T>,
    options?: HookRegistrationOptions
  ): string;

  /**
   * Unregister a handler
   * @param handlerId - ID returned from on() or once()
   * @returns true if handler was found and removed
   */
  off(handlerId: string): boolean;

  /**
   * Unregister all handlers for an event
   * @param event - CAAMP HookEvent to clear
   * @returns Number of handlers removed
   */
  offAll(event: HookEvent): number;

  /**
   * Fire a hook event (CLEO internal use)
   * This is called by CLEO lifecycle managers to trigger hooks
   * @param cleoEvent - CLEO lifecycle event name
   * @param data - Event-specific data
   * @returns Promise that resolves when all handlers complete
   */
  fire<T>(cleoEvent: string, data: T): Promise<HookFireResult>;

  /**
   * Get all registered handlers
   * @param event - Optional event filter
   * @returns Array of registered handlers
   */
  getHandlers(event?: HookEvent): RegisteredHandler[];

  /**
   * Check if any handlers are registered for an event
   * @param event - CAAMP HookEvent to check
   * @returns true if handlers exist
   */
  hasHandlers(event: HookEvent): boolean;

  /**
   * Get count of handlers for an event
   * @param event - CAAMP HookEvent to count
   * @returns Number of registered handlers
   */
  countHandlers(event: HookEvent): number;
}

/**
 * Result of firing a hook event
 */
interface HookFireResult {
  /** Event that was fired */
  event: HookEvent;
  
  /** Number of handlers executed */
  executed: number;
  
  /** Number of handlers that succeeded */
  succeeded: number;
  
  /** Number of handlers that failed */
  failed: number;
  
  /** Errors from failed handlers */
  errors: Array<{
    handlerId: string;
    error: Error;
  }>;
  
  /** Whether the operation was cancelled */
  cancelled: boolean;
  
  /** Duration in milliseconds */
  durationMs: number;
}
```

### 4.3 Hook Registry Implementation

```typescript
/**
 * Concrete implementation of HookRegistry
 * Built by CLEO - uses CAAMP for provider queries but manages execution
 */
export class CLEOHookRegistry implements HookRegistry {
  private handlers: Map<HookEvent, RegisteredHandler[]> = new Map();
  private handlerIdCounter = 0;

  on<T>(
    event: HookEvent,
    handler: HookHandler<T>,
    options: HookRegistrationOptions = {}
  ): string {
    const id = `hook_${++this.handlerIdCounter}_${Date.now()}`;
    
    const registered: RegisteredHandler = {
      id,
      event,
      handler: handler as HookHandler,
      options: {
        priority: options.priority ?? 100,
        providers: options.providers ?? [],
        sessionTypes: options.sessionTypes ?? [],
        maxExecutions: options.maxExecutions ?? Infinity,
        description: options.description ?? `Handler for ${event}`,
      },
      registrationTime: new Date().toISOString(),
      executionCount: 0,
    };

    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    
    const eventHandlers = this.handlers.get(event)!;
    eventHandlers.push(registered);
    
    // Sort by priority (lower = earlier)
    eventHandlers.sort((a, b) => a.options.priority - b.options.priority);

    return id;
  }

  once<T>(
    event: HookEvent,
    handler: HookHandler<T>,
    options: HookRegistrationOptions = {}
  ): string {
    return this.on(event, handler, {
      ...options,
      maxExecutions: 1,
      description: options.description ?? `One-time handler for ${event}`,
    });
  }

  off(handlerId: string): boolean {
    for (const [event, handlers] of this.handlers) {
      const index = handlers.findIndex(h => h.id === handlerId);
      if (index !== -1) {
        handlers.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  offAll(event: HookEvent): number {
    const handlers = this.handlers.get(event);
    if (!handlers) return 0;
    const count = handlers.length;
    handlers.length = 0;
    return count;
  }

  async fire<T>(cleoEvent: string, data: T): Promise<HookFireResult> {
    const caampEvent = toCaampHookEvent(cleoEvent);
    if (!caampEvent) {
      return {
        event: caampEvent ?? ('unknown' as HookEvent),
        executed: 0,
        succeeded: 0,
        failed: 0,
        errors: [],
        cancelled: false,
        durationMs: 0,
      };
    }

    const handlers = this.handlers.get(caampEvent) ?? [];
    const result: HookFireResult = {
      event: caampEvent,
      executed: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
      cancelled: false,
      durationMs: 0,
    };

    const startTime = Date.now();
    let cancelled = false;

    for (const registered of handlers) {
      // Check max executions
      if (registered.executionCount >= registered.options.maxExecutions) {
        continue;
      }

      // Check provider filter
      if (registered.options.providers.length > 0) {
        // Would need to determine current provider
        const currentProvider = this.getCurrentProvider();
        if (!registered.options.providers.includes(currentProvider)) {
          continue;
        }
      }

      // Build context
      const context: HookContext<T> = {
        event: caampEvent,
        cleoEvent,
        timestamp: new Date().toISOString(),
        sessionId: this.getCurrentSessionId(),
        taskId: this.getCurrentTaskId(),
        provider: this.getCurrentProvider(),
        data,
        cancellable: false, // Most hooks are not cancellable
      };

      try {
        result.executed++;
        await registered.handler(context);
        registered.executionCount++;
        result.succeeded++;
      } catch (error) {
        result.failed++;
        result.errors.push({
          handlerId: registered.id,
          error: error as Error,
        });
      }

      if (cancelled) {
        result.cancelled = true;
        break;
      }
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  getHandlers(event?: HookEvent): RegisteredHandler[] {
    if (event) {
      return [...(this.handlers.get(event) ?? [])];
    }
    return Array.from(this.handlers.values()).flat();
  }

  hasHandlers(event: HookEvent): boolean {
    const handlers = this.handlers.get(event);
    return handlers !== undefined && handlers.length > 0;
  }

  countHandlers(event: HookEvent): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  // Helper methods (would be implemented with actual session/task tracking)
  private getCurrentSessionId(): string | undefined {
    // Integrate with session manager
    return undefined;
  }

  private getCurrentTaskId(): string | undefined {
    // Integrate with task work tracking
    return undefined;
  }

  private getCurrentProvider(): string {
    // Determine current provider (claude, opencode, etc.)
    return 'claude';
  }
}
```

---

## 5. CAAMP Integration

### 5.1 Provider Hook Support Queries

```typescript
/**
 * CAAMP-aware hook utilities
 * Uses CAAMP functions to query provider capabilities
 */
export class CAAMPHookUtils {
  /**
   * Check which providers support a specific hook event
   * Uses CAAMP's getProvidersByHookEvent()
   */
  static getProvidersSupporting(event: HookEvent): Provider[] {
    // Call CAAMP function
    return getProvidersByHookEvent(event);
  }

  /**
   * Check if current provider supports a hook event
   */
  static isSupportedByCurrentProvider(event: HookEvent): boolean {
    const currentProvider = this.getCurrentProviderId();
    const providers = getProvidersByHookEvent(event);
    return providers.some(p => p.id === currentProvider);
  }

  /**
   * Get hook events supported by all specified providers
   * Uses CAAMP's getCommonHookEvents()
   */
  static getCommonEvents(providerIds?: string[]): HookEvent[] {
    return getCommonHookEvents(providerIds);
  }

  /**
   * Validate that registered hooks are supported
   * Warns about hooks that won't fire in current environment
   */
  static validateHookSupport(registry: HookRegistry): HookValidationResult {
    const currentProvider = this.getCurrentProviderId();
    const allEvents: HookEvent[] = [
      'onSessionStart',
      'onSessionEnd',
      'onToolStart',
      'onToolComplete',
      'onFileChange',
      'onError',
      'onPromptSubmit',
      'onResponseComplete',
    ];

    const unsupported: HookEvent[] = [];
    const supported: HookEvent[] = [];

    for (const event of allEvents) {
      const providers = getProvidersByHookEvent(event);
      const isSupported = providers.some(p => p.id === currentProvider);
      
      if (registry.hasHandlers(event) && !isSupported) {
        unsupported.push(event);
      } else if (isSupported) {
        supported.push(event);
      }
    }

    return {
      currentProvider,
      supported,
      unsupported,
      hasUnsupportedHandlers: unsupported.length > 0,
    };
  }

  private static getCurrentProviderId(): string {
    // Determine current provider from environment
    if (process.env.CLAUDE_CODE) return 'claude';
    if (process.env.OPEN_CODE) return 'opencode';
    return 'unknown';
  }
}

interface HookValidationResult {
  currentProvider: string;
  supported: HookEvent[];
  unsupported: HookEvent[];
  hasUnsupportedHandlers: boolean;
}
```

### 5.2 Provider-Specific Hook Support Matrix

Based on CAAMP 1.6.0 provider capabilities:

| HookEvent | Claude | OpenCode | Codex | Notes |
|-----------|--------|----------|-------|-------|
| `onSessionStart` | ✓ | ✓ | ✓ | Universal |
| `onSessionEnd` | ✓ | ✓ | ✓ | Universal |
| `onToolStart` | ✓ | ✓ | ✗ | Agent operations |
| `onToolComplete` | ✓ | ✓ | ✗ | Agent operations |
| `onFileChange` | ✓ | ✓ | ✓ | File watching |
| `onError` | ✓ | ✓ | ✓ | Error handling |
| `onPromptSubmit` | ✓ | ✗ | ✗ | LLM-specific |
| `onResponseComplete` | ✓ | ✗ | ✗ | LLM-specific |

**Note**: CLEO handlers will fire regardless of provider support for the CAAMP event. CAAMP queries are for informational/debug purposes. CLEO manages its own event lifecycle independently.

---

## 6. BRAIN Memory Integration

### 6.1 Memory Observer Pattern

```typescript
/**
 * BRAIN observer that auto-captures memories on hook events
 * Uses CLEO's hook registry + CAAMP event definitions
 */
export class BRAINMemoryObserver {
  constructor(
    private brain: BrainInterface,
    private registry: HookRegistry,
    private options: MemoryObserverOptions = {}
  ) {}

  /**
   * Register all memory capture hooks
   */
  register(): void {
    // Session lifecycle
    this.registry.on('onSessionStart', this.onSessionStart.bind(this), {
      description: 'Capture session start observation',
      priority: 50, // Early
    });

    this.registry.on('onSessionEnd', this.onSessionEnd.bind(this), {
      description: 'Capture session end observation',
      priority: 50,
    });

    // Tool/task lifecycle (maps to task operations)
    this.registry.on('onToolStart', this.onToolStart.bind(this), {
      description: 'Capture task start observation',
      priority: 50,
    });

    this.registry.on('onToolComplete', this.onToolComplete.bind(this), {
      description: 'Capture task completion observation',
      priority: 50,
    });

    // File changes
    this.registry.on('onFileChange', this.onFileChange.bind(this), {
      description: 'Capture file change observation',
      priority: 100,
    });

    // Errors
    this.registry.on('onError', this.onError.bind(this), {
      description: 'Capture error observation',
      priority: 10, // Very early
    });
  }

  private async onSessionStart(context: HookContext<SessionStartData>): Promise<void> {
    await this.brain.observe({
      type: 'session.start',
      content: `Session started: ${context.data.sessionId}`,
      context: {
        sessionId: context.data.sessionId,
        timestamp: context.timestamp,
      },
      tags: ['session', 'lifecycle'],
    });
  }

  private async onSessionEnd(context: HookContext<SessionEndData>): Promise<void> {
    await this.brain.observe({
      type: 'session.end',
      content: `Session ended: ${context.data.sessionId}`,
      context: {
        sessionId: context.data.sessionId,
        duration: context.data.duration,
        timestamp: context.timestamp,
      },
      tags: ['session', 'lifecycle'],
    });
  }

  private async onToolStart(context: HookContext<TaskStartData>): Promise<void> {
    await this.brain.observe({
      type: 'task.start',
      content: `Task started: ${context.data.taskId} - ${context.data.taskTitle}`,
      context: {
        taskId: context.data.taskId,
        sessionId: context.sessionId,
        timestamp: context.timestamp,
      },
      tags: ['task', 'lifecycle'],
    });
  }

  private async onToolComplete(context: HookContext<TaskCompleteData>): Promise<void> {
    await this.brain.observe({
      type: 'task.complete',
      content: `Task completed: ${context.data.taskId}`,
      context: {
        taskId: context.data.taskId,
        result: context.data.result,
        timestamp: context.timestamp,
      },
      tags: ['task', 'lifecycle'],
    });
  }

  private async onFileChange(context: HookContext<FileChangeData>): Promise<void> {
    // Check if file type should be captured
    if (!this.shouldCaptureFile(context.data.path)) {
      return;
    }

    await this.brain.observe({
      type: 'file.change',
      content: `File changed: ${context.data.path}`,
      context: {
        path: context.data.path,
        changeType: context.data.changeType,
        timestamp: context.timestamp,
      },
      tags: ['file', 'change'],
    });
  }

  private async onError(context: HookContext<ErrorData>): Promise<void> {
    await this.brain.observe({
      type: 'error',
      content: `Error: ${context.data.message}`,
      context: {
        error: context.data.message,
        stack: context.data.stack,
        timestamp: context.timestamp,
      },
      tags: ['error'],
    });
  }

  private shouldCaptureFile(path: string): boolean {
    const includePatterns = this.options.includePatterns ?? ['**/*.ts', '**/*.js', '**/*.md'];
    const excludePatterns = this.options.excludePatterns ?? ['node_modules/**', '.git/**'];
    
    // Apply include/exclude patterns
    // Implementation would use glob matching
    return true; // Simplified
  }
}

interface MemoryObserverOptions {
  includePatterns?: string[];
  excludePatterns?: string[];
  maxObservationsPerEvent?: number;
  deduplicationWindowMs?: number;
}
```

### 6.2 Integration with CLEO Lifecycle

```typescript
/**
 * Wire hook registry into CLEO lifecycle managers
 * This is where CLEO events actually trigger CAAMP-mapped hooks
 */
export function wireLifecycleHooks(registry: HookRegistry): void {
  // Session lifecycle
  sessionManager.on('sessionStart', (session) => {
    registry.fire('session.start', {
      sessionId: session.id,
      type: session.type,
      metadata: session.metadata,
    });
  });

  sessionManager.on('sessionEnd', (session, duration) => {
    registry.fire('session.end', {
      sessionId: session.id,
      duration,
      summary: session.summary,
    });
  });

  // Task lifecycle
  taskWorkTracker.on('taskStart', (task) => {
    registry.fire('task.start', {
      taskId: task.id,
      taskTitle: task.title,
      taskType: task.type,
    });
  });

  taskWorkTracker.on('taskComplete', (task, result) => {
    registry.fire('task.complete', {
      taskId: task.id,
      result,
      completionTime: new Date().toISOString(),
    });
  });

  // File operations
  fileWatcher.on('change', (change) => {
    registry.fire('file.write', {
      path: change.path,
      changeType: change.type,
      size: change.size,
    });
  });

  // Error handling
  errorBoundary.on('caught', (error) => {
    registry.fire('error.caught', {
      message: error.message,
      stack: error.stack,
      code: error.code,
    });
  });
}
```

---

## 7. File Changes Plan

### 7.1 New Files to Create

| File | Purpose | Lines (est) |
|------|---------|-------------|
| `src/types/hooks.ts` | HookEvent type, HookRegistry interface, handler types | 150 |
| `src/core/hooks/registry.ts` | CLEOHookRegistry implementation | 200 |
| `src/core/hooks/caamp-utils.ts` | CAAMP integration utilities | 100 |
| `src/core/hooks/brain-observer.ts` | BRAINMemoryObserver implementation | 150 |
| `src/core/hooks/lifecycle-wiring.ts` | CLEO lifecycle → hook mapping | 100 |
| `src/core/hooks/errors.ts` | Hook-specific error classes | 30 |
| `src/core/hooks/index.ts` | Barrel exports | 15 |
| `src/core/hooks/__tests__/registry.test.ts` | Registry unit tests | 120 |
| `src/core/hooks/__tests__/brain-observer.test.ts` | Observer tests | 100 |
| `src/core/hooks/__tests__/caamp-utils.test.ts` | CAAMP integration tests | 80 |

**Total New Files**: 10  
**Estimated Lines**: ~1,045

### 7.2 Files to Modify

| File | Changes | Lines (est) |
|------|---------|-------------|
| `src/dispatch/engines/session-engine.ts` | Fire hooks on session start/end | +20 |
| `src/dispatch/engines/task-work-engine.ts` | Fire hooks on task start/complete | +20 |
| `src/core/sessions/manager.ts` | Integrate with lifecycle wiring | +15 |
| `src/core/task-work/tracker.ts` | Integrate with lifecycle wiring | +15 |
| `src/core/brain/index.ts` | Export BRAINMemoryObserver | +5 |
| `src/types/index.ts` | Export hook types | +5 |
| `src/cli/commands/start.ts` | Initialize hook system on session start | +10 |
| `src/cli/commands/stop.ts` | Fire session end hooks | +5 |

**Total Modified Files**: 8  
**Estimated Lines Added**: ~90

### 7.3 Detailed Change Specifications

#### src/types/hooks.ts (NEW)

Create comprehensive type definitions:
- `HookEvent` type (CAAMP-aligned: onSessionStart, onSessionEnd, etc.)
- `HookHandler` type signature
- `HookContext` interface
- `HookRegistry` interface
- `HookRegistrationOptions` interface
- `HookFireResult` interface
- Helper types for event data (SessionStartData, TaskCompleteData, etc.)

#### src/core/hooks/registry.ts (NEW)

Implement `CLEOHookRegistry`:
- Handler registration (on, once)
- Handler unregistration (off, offAll)
- Event firing with priority ordering
- Provider/session filtering
- Execution counting and limits

#### src/core/hooks/caamp-utils.ts (NEW)

Implement CAAMP integration:
- `getProvidersByHookEvent()` wrapper
- `getCommonHookEvents()` wrapper
- Provider support validation
- Current provider detection

#### src/core/hooks/brain-observer.ts (NEW)

Implement `BRAINMemoryObserver`:
- Constructor takes brain and registry
- `register()` method sets up all observers
- Handler methods for each event type
- File filtering logic

#### src/core/hooks/lifecycle-wiring.ts (NEW)

Implement `wireLifecycleHooks()`:
- Subscribe to CLEO lifecycle events
- Map to CAAMP events
- Fire hooks with proper data

---

## 8. Usage Examples

### 8.1 Basic Hook Registration

```typescript
import { getHookRegistry } from './hooks';

const registry = getHookRegistry();

// Register a handler for session start
registry.on('onSessionStart', async (context) => {
  console.log(`Session ${context.sessionId} started`);
});

// Register a one-time handler for task completion
registry.once('onToolComplete', async (context) => {
  console.log(`Task ${context.data.taskId} completed!`);
});
```

### 8.2 BRAIN Memory Auto-Capture

```typescript
import { BRAINMemoryObserver } from './hooks/brain-observer';
import { getBrain } from './brain';
import { getHookRegistry } from './hooks';

// Initialize
const brain = getBrain();
const registry = getHookRegistry();
const observer = new BRAINMemoryObserver(brain, registry);

// Register all memory observers
observer.register();

// Now all lifecycle events automatically capture to BRAIN
```

### 8.3 Provider Hook Support Check

```typescript
import { CAAMPHookUtils } from './hooks/caamp-utils';

// Check which providers support onFileChange
const providers = CAAMPHookUtils.getProvidersSupporting('onFileChange');
console.log('Providers supporting file hooks:', providers.map(p => p.id));

// Check if current provider supports tool events
if (CAAMPHookUtils.isSupportedByCurrentProvider('onToolComplete')) {
  console.log('Task completion hooks will fire');
}

// Validate all registered hooks
const validation = CAAMPHookUtils.validateHookSupport(registry);
if (validation.hasUnsupportedHandlers) {
  console.warn('Unsupported hooks:', validation.unsupported);
}
```

### 8.4 Custom Handler with Filtering

```typescript
// Only run for specific providers
registry.on('onFileChange', async (context) => {
  await analyzeFileChange(context.data.path);
}, {
  providers: ['claude'],  // Only run in Claude Code
  priority: 10,           // Run early
  description: 'Claude-specific file analysis',
});

// Only run for specific session types
registry.on('onToolComplete', async (context) => {
  await notifySlack(context.data.taskId);
}, {
  sessionTypes: ['ci', 'automated'],
  maxExecutions: 100,     // Limit to prevent spam
});
```

---

## 9. Test Plan

### 9.1 Unit Tests

| Test Suite | Coverage | Cases |
|------------|----------|-------|
| CLEOHookRegistry | 90%+ | Registration, unregistration, firing, priority, filtering |
| CAAMPHookUtils | 90%+ | Provider queries, support validation, current provider |
| BRAINMemoryObserver | 90%+ | All event handlers, file filtering, brain integration |

### 9.2 Integration Tests

| Test | Description |
|------|-------------|
| End-to-end hook flow | CLEO event → hook fire → handler execution → result |
| Session lifecycle hooks | Start session → onSessionStart fires → end session → onSessionEnd fires |
| Task lifecycle hooks | Start task → onToolStart fires → complete task → onToolComplete fires |
| Multiple handlers | Register multiple handlers, verify priority ordering |
| Provider filtering | Handler with provider filter, verify correct filtering |
| BRAIN integration | Event fires → brain.observe called with correct data |

### 9.3 Test Scenarios

```typescript
// Scenario 1: Hook registration and firing
describe('Hook registry', () => {
  it('should fire handlers when events occur', async () => {
    const registry = new CLEOHookRegistry();
    const handler = vi.fn();
    
    registry.on('onSessionStart', handler);
    await registry.fire('session.start', { sessionId: 'S123' });
    
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'onSessionStart',
        cleoEvent: 'session.start',
        data: { sessionId: 'S123' },
      })
    );
  });
});

// Scenario 2: Priority ordering
describe('Handler priority', () => {
  it('should execute handlers in priority order', async () => {
    const registry = new CLEOHookRegistry();
    const order: number[] = [];
    
    registry.on('onToolStart', () => order.push(2), { priority: 20 });
    registry.on('onToolStart', () => order.push(1), { priority: 10 });
    registry.on('onToolStart', () => order.push(3), { priority: 30 });
    
    await registry.fire('task.start', { taskId: 'T123' });
    
    expect(order).toEqual([1, 2, 3]);
  });
});

// Scenario 3: CAAMP provider queries
describe('CAAMP integration', () => {
  it('should query provider hook support', () => {
    const providers = CAAMPHookUtils.getProvidersSupporting('onSessionStart');
    expect(providers).toContainEqual(
      expect.objectContaining({ id: 'claude' })
    );
  });
});

// Scenario 4: BRAIN memory capture
describe('BRAIN observer', () => {
  it('should capture session start to BRAIN', async () => {
    const brain = { observe: vi.fn() };
    const registry = new CLEOHookRegistry();
    const observer = new BRAINMemoryObserver(brain, registry);
    
    observer.register();
    await registry.fire('session.start', { sessionId: 'S123' });
    
    expect(brain.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.start',
        content: expect.stringContaining('S123'),
      })
    );
  });
});
```

---

## 10. Dependencies and Prerequisites

### 10.1 Required For Implementation

1. **CAAMP 1.6.0** installed and available (`@cleocode/caamp@1.6.0`)
2. **T4820** (orchestrate domain) - for spawn hooks (optional)
3. **T5149** or **T1084** - BRAIN observation API (existing)
4. **Task work tracking** - existing `task.start`/`task.complete` events

### 10.2 Optional Enhancements (Future)

1. **Async hooks**: Allow handlers to block/await (currently fire-and-forget)
2. **Hook metrics**: Track handler execution time, success rates
3. **Hook debugger**: CLI command to inspect registered hooks
4. **Conditional hooks**: Only fire based on task metadata
5. **Hook plugins**: Third-party handler packages

---

## 11. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Handler errors break execution | High | Medium | Try-catch each handler, log errors, continue |
| Too many handlers = slow | Medium | Low | Priority system, async execution, timeout |
| Memory leaks from handlers | Medium | Low | Auto-unregister after maxExecutions |
| CAAMP version mismatch | Medium | Low | Version check on init, graceful degradation |
| Provider detection incorrect | Low | Medium | Override via env var, validation warning |

---

## 12. Open Questions

### 12.1 Clarifications Needed

1. **Q**: Should handlers be able to cancel operations?
   - **Recommendation**: Support cancellation for specific events (session end, file change)

2. **Q**: How to handle handler timeouts?
   - **Recommendation**: 5s default timeout per handler, configurable per registration

3. **Q**: Should we persist hook registrations across sessions?
   - **Recommendation**: No - re-register each session, keep in memory only

4. **Q**: How to handle errors in BRAIN observer?
   - **Recommendation**: Log error, don't fail the hook chain

5. **Q**: Should file change hooks include file content?
   - **Recommendation**: Optional via config, default to metadata only (path, size, hash)

### 12.2 Design Decisions Pending

1. **Synchronous hooks**: Allow sync handlers or async only?
2. **Hook composition**: Chain handlers (output of one → input of next)?
3. **Hook debugging**: CLI command to list active hooks and recent fires?
4. **Rate limiting**: Max fires per minute for noisy events like file changes?

---

## 13. Acceptance Criteria

- [ ] `HookEvent` type uses CAAMP 1.6.0 event names (camelCase)
- [ ] `HookRegistry` interface and `CLEOHookRegistry` implementation
- [ ] CAAMP integration with `getProvidersByHookEvent()` and `getCommonHookEvents()`
- [ ] CLEO lifecycle → CAAMP event mapping implemented
- [ ] `BRAINMemoryObserver` with all 4 core event handlers
- [ ] Session lifecycle hooks fire correctly (onSessionStart, onSessionEnd)
- [ ] Task lifecycle hooks fire correctly (onToolStart, onToolComplete)
- [ ] Provider support validation warns about unsupported hooks
- [ ] Unit tests for registry with 90%+ coverage
- [ ] Integration tests for end-to-end hook flow
- [ ] Documentation with usage examples
- [ ] Supports 9+ providers via CAAMP abstraction

---

## 14. Implementation Phases

### Phase 1B: Core Types and Registry (Follow-up Agent)
- Create `src/types/hooks.ts`
- Implement `CLEOHookRegistry`
- Create error classes

### Phase 1C: CAAMP Integration (Follow-up Agent)
- Implement `CAAMPHookUtils`
- Add provider support queries
- Create validation logic

### Phase 1D: BRAIN Observer (Follow-up Agent)
- Implement `BRAINMemoryObserver`
- File filtering logic
- Memory capture handlers

### Phase 1E: Lifecycle Wiring (Follow-up Agent)
- Implement `wireLifecycleHooks()`
- Integrate with session manager
- Integrate with task work tracker
- Add tests

---

## 15. Summary

This design document specifies how CLEO implements universal hooks using CAAMP's event definitions while building its own execution layer:

1. **CAAMP defines events**: `onSessionStart`, `onToolComplete`, etc.
2. **CLEO builds execution**: Registry, handlers, firing logic
3. **Mapping connects them**: `session.start` → `onSessionStart`
4. **CAAMP queries support**: Which providers support which hooks
5. **BRAIN auto-captures**: Memory observations on lifecycle events

**Key Principle**: CAAMP is the contract (HookEvent types, provider queries), CLEO is the implementation (registry, execution, lifecycle mapping).

---

**End of Design Document**

**Next Step**: Review and approve design, then proceed to Phase 1B implementation.
