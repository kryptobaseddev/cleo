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
import type {
  HookConfig,
  HookDispatchOutcome,
  HookEvent,
  HookPayload,
  HookPayloadFor,
  HookRegistration,
} from './types.js';

/**
 * Longest a transport waits for `awaitBeforeResponse` handlers before it
 * responds (T14553). A handler still running at the budget is handed to the
 * caller's background lifecycle and reported as deferred, so one contended
 * store write (a held brain-lane lease waits up to 30 s) can no longer hold a
 * command's envelope. Handlers that write durably bound themselves below this.
 */
export const RESPONSE_HOOK_BUDGET_MS = 2_000;

/** A dispatch that ran no handler, or deferred nothing. */
const NOTHING_DEFERRED: HookDispatchOutcome = Object.freeze({ deferred: Object.freeze([]) });

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
   * @param defer - Tracks optional handlers in the caller's background lifecycle;
   *   when provided, only `awaitBeforeResponse` handlers delay this call.
   * @param budgetMs - With `defer`, the longest wait for `awaitBeforeResponse`
   *   handlers ({@link RESPONSE_HOOK_BUDGET_MS} for transports); a handler still
   *   running then is passed to `defer` and reported as deferred (T14553).
   * @returns The handlers that deferred, once required handlers (or, by
   *   default, all handlers) complete or the budget ends
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
  // T12071: keyed on the EVENT so the payload shape is checked against
  // `HookEventPayloadMap`. The previous `<T extends HookPayload>` form inferred
  // T from the argument, relating the event and the payload not at all — which
  // is how `PostToolUse` came to be dispatched with `newStatus` instead of
  // `status` and filled 29% of BRAIN with "status: undefined".
  async dispatch<E extends HookEvent>(
    event: E,
    projectRoot: string,
    payload: HookPayloadFor<E>,
    defer?: (work: Promise<void>) => void,
    budgetMs?: number,
  ): Promise<HookDispatchOutcome> {
    // Check if hooks enabled globally
    if (!this.config.enabled) return NOTHING_DEFERRED;

    const resolvedEvent = this.resolveEvent(event as string);

    // Check if this event enabled
    if (!this.config.events[resolvedEvent]) return NOTHING_DEFERRED;

    const handlers = this.handlers.get(resolvedEvent);
    if (!handlers || handlers.length === 0) return NOTHING_DEFERRED;

    // Response-dependent writes settle before the envelope, within the budget.
    // Optional handlers retain the caller's bounded background lifecycle.
    const deferred: string[] = [];
    let responded = false;
    const required: Array<{ id: string; work: Promise<void>; settled: () => boolean }> = [];
    for (const reg of handlers) {
      let settled = false;
      const work = (async () => {
        try {
          const outcome = await reg.handler(projectRoot, payload);
          if (outcome === 'deferred' && !responded) deferred.push(reg.id);
        } catch (error) {
          getLogger('hooks').warn(
            { err: error, hookId: reg.id, event: resolvedEvent },
            'Hook handler failed',
          );
        } finally {
          settled = true;
        }
      })();
      if (defer && !reg.awaitBeforeResponse) {
        defer(work);
        continue;
      }
      required.push({ id: reg.id, work, settled: () => settled });
    }
    const all = Promise.allSettled(required.map((r) => r.work));
    if (!defer || budgetMs === undefined) {
      await all;
    } else {
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref();
      });
      try {
        await Promise.race([all, budget]);
      } finally {
        clearTimeout(timer);
      }
      for (const r of required) {
        if (r.settled()) continue;
        defer(r.work);
        deferred.push(r.id);
        getLogger('hooks').warn(
          { hookId: r.id, event: resolvedEvent, budgetMs },
          'Hook handler outlived the response budget; deferred',
        );
      }
    }
    responded = true;
    return deferred.length === 0 ? NOTHING_DEFERRED : { deferred };
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
