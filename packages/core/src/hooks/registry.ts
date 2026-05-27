/**
 * Hook Registry System - Phase 2C of T5237
 *
 * Central registry for managing hook handlers with priority-based execution,
 * async dispatch, and best-effort error handling. Integrates with CAAMP 1.9.1
 * canonical event definitions while providing CLEO's execution engine.
 *
 * @module @cleocode/cleo/hooks/registry
 */

import { getLogger } from '../logger.js';
import type { HookConfig, HookEvent, HookPayload, HookRegistration } from './types.js';

/** Map from old `on`-prefix event names to new canonical names. Used for backward compat. */
const LEGACY_EVENT_MAP: Record<string, HookEvent> = {
  onSessionStart: 'SessionStart',
  onSessionEnd: 'SessionEnd',
  onToolStart: 'PreToolUse',
  onToolComplete: 'PostToolUse',
  onFileChange: 'Notification',
  onError: 'PostToolUseFailure',
  onPromptSubmit: 'PromptSubmit',
  onResponseComplete: 'ResponseComplete',
};

/**
 * Default configuration for the hook system.
 * All events are enabled by default.
 */
const DEFAULT_HOOK_CONFIG: HookConfig = {
  enabled: true,
  events: {
    // CAAMP canonical events (16)
    SessionStart: true,
    SessionEnd: true,
    PromptSubmit: true,
    ResponseComplete: true,
    PreToolUse: true,
    PostToolUse: true,
    PostToolUseFailure: true,
    PermissionRequest: true,
    SubagentStart: true,
    SubagentStop: true,
    PreModel: true,
    PostModel: true,
    PreCompact: true,
    PostCompact: true,
    Notification: true,
    ConfigChange: true,
    // CLEO internal coordination events (5)
    onWorkAvailable: true,
    onAgentSpawn: true,
    onAgentComplete: true,
    onCascadeStart: true,
    onPatrol: true,
  } as Record<HookEvent, boolean>,
};

/**
 * Central registry for hook handlers.
 *
 * Manages registration, priority-based ordering, and async dispatch
 * of hook handlers. Provides best-effort execution where errors in
 * one handler do not block others.
 *
 * Backward compatibility: handlers registered with legacy `on`-prefix
 * event names (e.g. `onSessionStart`) are automatically remapped to their
 * canonical equivalents (e.g. `SessionStart`) with a deprecation warning.
 */
export class HookRegistry {
  private handlers: Map<HookEvent, HookRegistration[]> = new Map();
  private config: HookConfig = DEFAULT_HOOK_CONFIG;

  /**
   * Resolve a potentially-legacy event name to its canonical equivalent.
   *
   * If the event name matches a known legacy `on`-prefix name, it is
   * remapped and a deprecation warning is logged. Unknown names pass through
   * unchanged so callers using the new canonical names are unaffected.
   */
  private resolveEvent(event: string): HookEvent {
    const canonical = LEGACY_EVENT_MAP[event];
    if (canonical) {
      getLogger('hooks').warn(
        { legacyEvent: event, canonicalEvent: canonical },
        `[DEPRECATED] Hook event '${event}' has been renamed to '${canonical}'. Update your handler registration.`,
      );
      return canonical;
    }
    return event as HookEvent;
  }

  /**
   * Register a hook handler for a specific event.
   *
   * Handlers are sorted by priority (highest first) and executed
   * in parallel when the event is dispatched.
   *
   * Backward compatibility: legacy `on`-prefix event names are automatically
   * remapped to their canonical equivalents.
   *
   * @param registration - The hook registration containing event, handler, priority, and ID
   * @returns A function to unregister the handler
   *
   * @example
   * ```typescript
   * const unregister = hooks.register({
   *   id: 'my-handler',
   *   event: 'SessionStart',
   *   handler: async (root, payload) => { console.log('Session started'); },
   *   priority: 100
   * });
   *
   * // Later: unregister()
   * ```
   */
  register<T extends HookPayload>(registration: HookRegistration<T>): () => void {
    const resolvedEvent = this.resolveEvent(registration.event as string);
    const resolvedRegistration = { ...registration, event: resolvedEvent } as HookRegistration;

    const list = this.handlers.get(resolvedEvent) || [];
    list.push(resolvedRegistration);
    // Sort by priority (highest first)
    list.sort((a, b) => b.priority - a.priority);
    this.handlers.set(resolvedEvent, list);

    // Return unregister function
    return () => {
      const handlers = this.handlers.get(resolvedEvent);
      if (handlers) {
        const idx = handlers.findIndex((h) => h.id === registration.id);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  /**
   * Dispatch an event to all registered handlers.
   *
   * Executes handlers in parallel using Promise.allSettled for best-effort
   * execution. Errors in individual handlers are logged but do not block
   * other handlers or propagate to the caller.
   *
   * Backward compatibility: legacy `on`-prefix event names are automatically
   * remapped to their canonical equivalents.
   *
   * @param event - The CAAMP canonical hook event to dispatch
   * @param projectRoot - The project root directory path
   * @param payload - The event payload (typed by event)
   * @returns Promise that resolves when all handlers have completed
   *
   * @example
   * ```typescript
   * await hooks.dispatch('SessionStart', '/project', {
   *   timestamp: new Date().toISOString(),
   *   sessionId: 'sess-123',
   *   name: 'My Session',
   *   scope: 'feature'
   * });
   * ```
   */
  async dispatch<T extends HookPayload>(
    event: HookEvent,
    projectRoot: string,
    payload: T,
  ): Promise<void> {
    // Check if hooks enabled globally
    if (!this.config.enabled) return;

    const resolvedEvent = this.resolveEvent(event as string);

    // Check if this event enabled
    if (!this.config.events[resolvedEvent]) return;

    const handlers = this.handlers.get(resolvedEvent);
    if (!handlers || handlers.length === 0) return;

    // Execute all handlers in parallel (best-effort)
    await Promise.allSettled(
      handlers.map(async (reg) => {
        try {
          await reg.handler(projectRoot, payload);
        } catch (error) {
          // Hooks are best-effort - log but don't throw
          getLogger('hooks').warn(
            { err: error, hookId: reg.id, event: resolvedEvent },
            'Hook handler failed',
          );
        }
      }),
    );
  }

  /**
   * Check if a specific event is currently enabled.
   *
   * Both the global enabled flag and the per-event flag must be true.
   * Automatically resolves legacy `on`-prefix event names.
   *
   * @param event - The CAAMP hook event to check
   * @returns True if the event is enabled
   */
  isEnabled(event: HookEvent): boolean {
    const resolvedEvent = this.resolveEvent(event as string);
    return this.config.enabled && this.config.events[resolvedEvent];
  }

  /**
   * Update the hook system configuration.
   *
   * Merges the provided config with the existing config.
   *
   * @param config - Partial configuration to apply
   *
   * @example
   * ```typescript
   * hooks.setConfig({ enabled: false }); // Disable all hooks
   * hooks.setConfig({ events: { PostToolUseFailure: false } }); // Disable specific event
   * ```
   */
  setConfig(config: Partial<HookConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get the current hook configuration.
   *
   * @returns A copy of the current configuration
   */
  getConfig(): HookConfig {
    return { ...this.config };
  }

  /**
   * List all registered handlers for a specific event.
   *
   * Returns handlers in priority order (highest first).
   * Automatically resolves legacy `on`-prefix event names.
   *
   * @param event - The CAAMP hook event
   * @returns Array of hook registrations
   */
  listHandlers(event: HookEvent): HookRegistration[] {
    const resolvedEvent = this.resolveEvent(event as string);
    return [...(this.handlers.get(resolvedEvent) || [])];
  }
}

/**
 * Singleton instance of the HookRegistry.
 *
 * Use this instance for all hook operations throughout the application.
 */
export const hooks = new HookRegistry();
