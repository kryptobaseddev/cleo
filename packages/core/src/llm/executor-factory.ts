/**
 * Default LlmExecutor factory and singleton accessor.
 *
 * Wires {@link DefaultLlmSessionFactory} → {@link ConcreteExecutor} for a
 * given CLEO role, with an optional {@link ContextEngine} for context
 * compression. Provides a per-process singleton via {@link getLlmExecutor}
 * for callers that want a cached executor per role.
 *
 * @module llm/executor-factory
 * @task T9291
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §2.2
 */

import type {
  ExecutorFactoryOptions,
  LlmExecutor,
  LlmExecutorFactory,
} from '@cleocode/contracts/llm/interfaces.js';
import type { ContextEngine } from '@cleocode/contracts/memory/context-engine.js';
import { LlmSummarizationEngine } from '../memory/context-engines/llm-summarizer.js';
import { resolveAuxiliaryFallbackChain } from './auxiliary-fallback.js';
import { ConcreteExecutor } from './concrete-executor.js';
import {
  listContextEngines,
  registerContextEngine as registerPluginEngine,
} from './context-engines/index.js';
import { DefaultLlmSessionFactory } from './session-factory.js';

// Re-export so callers that only touch executor-factory have one import.
export { listContextEngines };

// ---------------------------------------------------------------------------
// DefaultLlmExecutorFactory
// ---------------------------------------------------------------------------

/**
 * Default factory for creating {@link LlmExecutor} instances.
 *
 * Resolves provider + credential via `DefaultLlmSessionFactory`, wraps the
 * session in a {@link ConcreteExecutor}, and optionally attaches a
 * {@link ContextEngine}. When `llm.auxiliaryFallback` is set in the project
 * config, the resolved chain is automatically passed to every {@link ConcreteExecutor}
 * so cross-provider fallover works without any call-site changes.
 *
 * @example
 * ```ts
 * const factory = new DefaultLlmExecutorFactory();
 * const executor = await factory.createForRole('consolidation');
 * for await (const event of executor.run({ messages: [...] })) {
 *   if (event.kind === 'done') console.log(event.usage);
 * }
 * ```
 */
export class DefaultLlmExecutorFactory implements LlmExecutorFactory {
  private readonly _sessionFactory: DefaultLlmSessionFactory;
  private readonly _contextEngine: ContextEngine | undefined;

  /**
   * @param opts - Optional factory-level configuration.
   * @param opts.contextEngine - Context engine applied to all created executors.
   */
  constructor(opts?: { contextEngine?: ContextEngine }) {
    this._sessionFactory = new DefaultLlmSessionFactory();
    this._contextEngine = opts?.contextEngine;
  }

  /**
   * Creates an executor resolved from the given role name.
   *
   * Resolution chain delegates to {@link DefaultLlmSessionFactory.createForRole}:
   * `role → config.llm.roles[role] → config.llm.default → config.llm.daemon
   *  → implicit anthropic/haiku fallback`.
   *
   * The resolved executor automatically receives the `llm.auxiliaryFallback`
   * chain from project config (if set), enabling cross-provider fallover.
   *
   * @param role - CLEO role name (e.g. `'orchestrator'`, `'sentient'`).
   * @returns A promise resolving to an initialized {@link LlmExecutor}.
   * @throws When no credential is available for the resolved provider.
   *
   * @task T9319 — auto-wire auxiliaryFallbackChain from config
   */
  async createForRole(role: string): Promise<LlmExecutor> {
    const [session, auxiliaryFallbackChain] = await Promise.all([
      this._sessionFactory.createForRole(role),
      resolveAuxiliaryFallbackChain(),
    ]);
    return new ConcreteExecutor({
      session,
      contextEngine: this._contextEngine,
      auxiliaryFallbackChain,
    });
  }

  /**
   * Creates an executor with the given options.
   *
   * When `opts.session` is supplied, wraps it directly. Otherwise delegates
   * to `sessionFactory.create(opts.sessionOptions)`.
   *
   * The resolved executor automatically receives the `llm.auxiliaryFallback`
   * chain from project config (if set), enabling cross-provider fallover.
   *
   * @param opts - Executor construction options.
   * @returns A promise resolving to an initialized {@link LlmExecutor}.
   * @throws When neither `session` nor valid session options are supplied.
   *
   * @task T9319 — auto-wire auxiliaryFallbackChain from config
   */
  async create(opts: ExecutorFactoryOptions): Promise<LlmExecutor> {
    const auxiliaryFallbackChain = await resolveAuxiliaryFallbackChain();

    if (opts.session !== undefined) {
      return new ConcreteExecutor({
        session: opts.session,
        contextEngine: this._contextEngine,
        auxiliaryFallbackChain,
      });
    }

    const session = await this._sessionFactory.create(opts.sessionOptions ?? {});
    return new ConcreteExecutor({
      session,
      contextEngine: this._contextEngine,
      auxiliaryFallbackChain,
    });
  }
}

// ---------------------------------------------------------------------------
// Per-role ContextEngine registry + singleton executor cache
// ---------------------------------------------------------------------------

/**
 * Per-role ContextEngine registry.
 *
 * Seeded with the default {@link LlmSummarizationEngine} for the
 * `'compression'` role. Callers can swap or add engines via
 * {@link registerContextEngine} without touching core code.
 *
 * The `LlmSummarizationEngine` is also registered in the plugin registry
 * under the name `'llm-summarization'` so it appears in `cleo llm
 * context-engines list` alongside the built-in rule-based engine.
 */
const _engineRegistry = new Map<string, ContextEngine>([
  ['compression', new LlmSummarizationEngine()],
]);

// Register the LLM summarizer in the named plugin registry so it is visible
// in `cleo llm context-engines list`.
registerPluginEngine('llm-summarization', _engineRegistry.get('compression') as ContextEngine);

const _executorCache = new Map<string, LlmExecutor>();

/**
 * Register a {@link ContextEngine} for a given role.
 *
 * The registered engine is supplied to all executors created for that role
 * via {@link getLlmExecutor}. Call before the first {@link getLlmExecutor}
 * for the role, or call {@link clearLlmExecutorCache} first to invalidate
 * the cached executor.
 *
 * Also registers the engine in the plugin registry under the same name so
 * it appears in `cleo llm context-engines list`.
 *
 * @param role - CLEO role name to bind the engine to.
 * @param engine - The context engine implementation to register.
 */
export function registerContextEngine(role: string, engine: ContextEngine): void {
  _engineRegistry.set(role, engine);
  // Mirror into the named plugin registry for discovery.
  registerPluginEngine(role, engine);
  // Invalidate the cached executor so the next call rebuilds with the new engine.
  _executorCache.delete(role);
}

/**
 * Returns a cached {@link LlmExecutor} for the given role.
 *
 * The first call for a given role creates and caches the executor. Subsequent
 * calls return the same instance. Use for callers that want a stable executor
 * across multiple calls without re-resolving credentials per call.
 *
 * The executor receives the {@link ContextEngine} registered for this role
 * (if any) via the {@link _engineRegistry}. The default registry seeds
 * `'compression'` with a {@link LlmSummarizationEngine}.
 *
 * NOTE: The executor's session history accumulates across calls. Callers
 * that need a fresh conversation should use `new DefaultLlmExecutorFactory()
 * .createForRole(role)` directly instead.
 *
 * @param role - CLEO role name (e.g. `'orchestrator'`, `'compression'`).
 * @returns A promise resolving to the cached {@link LlmExecutor} for this role.
 */
export async function getLlmExecutor(role: string): Promise<LlmExecutor> {
  const cached = _executorCache.get(role);
  if (cached !== undefined) return cached;

  const contextEngine = _engineRegistry.get(role);
  const factory = new DefaultLlmExecutorFactory({ contextEngine });
  const executor = await factory.createForRole(role);
  _executorCache.set(role, executor);
  return executor;
}

/**
 * Clear the per-role executor cache.
 *
 * Useful in tests or when credential rotation requires a fresh session.
 *
 * @param role - When provided, clears only the cached executor for this role.
 *   When omitted, clears all cached executors.
 */
export function clearLlmExecutorCache(role?: string): void {
  if (role !== undefined) {
    _executorCache.delete(role);
  } else {
    _executorCache.clear();
  }
}
