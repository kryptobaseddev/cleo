/**
 * Hook Registry System - Phase 2C of T5237
 *
 * Central registry for managing hook handlers with priority-based execution,
 * async dispatch, and best-effort error handling. Integrates with CAAMP 1.6.0
 * event definitions while providing CLEO's execution engine.
 *
 * @module @cleocode/cleo/hooks/registry
 */

import type {
  HookEvent,
  HookPayload,
  HookRegistration,
  HookConfig
} from './types.js';
import { getLogger } from '../logger.js';

/**
 * Default configuration for the hook system.
 * All events are enabled by default.
 */
const DEFAULT_HOOK_CONFIG: HookConfig = {
  enabled: true,
  events: {
    'onSessionStart': true,
    'onSessionEnd': true,
    'onToolStart': true,
    'onToolComplete': true,
    'onFileChange': true,
    'onError': true,
    'onPromptSubmit': true,
    'onResponseComplete': true,
    'onWorkAvailable': true,
    'onAgentSpawn': true,
    'onAgentComplete': true,
    'onCascadeStart': true,
    'onPatrol': true,
  } as Record<HookEvent, boolean>,
};

/**
 * Central registry for hook handlers.
 *
 * Manages registration, priority-based ordering, and async dispatch
 * of hook handlers. Provides best-effort execution where errors in
 * one handler do not block others.
 */
export class HookRegistry {
  private handlers: Map<HookEvent, HookRegistration[]> = new Map();
  private config: HookConfig = DEFAULT_HOOK_CONFIG;

  /**
   * Register a hook handler for a specific event.
   *
   * Handlers are sorted by priority (highest first) and executed
   * in parallel when the event is dispatched.
   *
   * @param registration - The hook registration containing event, handler, priority, and ID
   * @returns A function to unregister the handler
   *
   * @example
   * ```typescript
   * const unregister = hooks.register({
   *   id: 'my-handler',
   *   event: 'onSessionStart',
   *   handler: async (root, payload) => { console.log('Session started'); },
   *   priority: 100
   * });
   *
   * // Later: unregister()
   * ```
   */
  register<T extends HookPayload>(
    registration: HookRegistration<T>
  ): () => void {
    const list = this.handlers.get(registration.event) || [];
    list.push(registration as HookRegistration);
    // Sort by priority (highest first)
    list.sort((a, b) => b.priority - a.priority);
    this.handlers.set(registration.event, list);

    // Return unregister function
    return () => {
      const handlers = this.handlers.get(registration.event);
      if (handlers) {
        const idx = handlers.findIndex(h => h.id === registration.id);
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
   * @param event - The CAAMP hook event to dispatch
   * @param projectRoot - The project root directory path
   * @param payload - The event payload (typed by event)
   * @returns Promise that resolves when all handlers have completed
   *
   * @example
   * ```typescript
   * await hooks.dispatch('onSessionStart', '/project', {
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
    payload: T
  ): Promise<void> {
    // Check if hooks enabled globally
    if (!this.config.enabled) return;

    // Check if this event enabled
    if (!this.config.events[event]) return;

    const handlers = this.handlers.get(event);
    if (!handlers || handlers.length === 0) return;

    // Execute all handlers in parallel (best-effort)
    await Promise.allSettled(
      handlers.map(async (reg) => {
        try {
          await reg.handler(projectRoot, payload);
        } catch (error) {
          // Hooks are best-effort - log but don't throw
          getLogger('hooks').warn({ err: error, hookId: reg.id, event }, 'Hook handler failed');
        }
      })
    );
  }

  /**
   * Check if a specific event is currently enabled.
   *
   * Both the global enabled flag and the per-event flag must be true.
   *
   * @param event - The CAAMP hook event to check
   * @returns True if the event is enabled
   */
  isEnabled(event: HookEvent): boolean {
    return this.config.enabled && this.config.events[event];
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
   * hooks.setConfig({ events: { onError: false } }); // Disable specific event
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
   *
   * @param event - The CAAMP hook event
   * @returns Array of hook registrations
   */
  listHandlers(event: HookEvent): HookRegistration[] {
    return [...(this.handlers.get(event) || [])];
  }
}

/**
 * Singleton instance of the HookRegistry.
 *
 * Use this instance for all hook operations throughout the application.
 */
export const hooks = new HookRegistry();
