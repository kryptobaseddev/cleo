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
import { ConcreteExecutor } from './concrete-executor.js';
import { DefaultLlmSessionFactory } from './session-factory.js';

// ---------------------------------------------------------------------------
// DefaultLlmExecutorFactory
// ---------------------------------------------------------------------------

/**
 * Default factory for creating {@link LlmExecutor} instances.
 *
 * Resolves provider + credential via `DefaultLlmSessionFactory`, wraps the
 * session in a {@link ConcreteExecutor}, and optionally attaches a
 * {@link ContextEngine}.
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
   * @param role - CLEO role name (e.g. `'orchestrator'`, `'sentient'`).
   * @returns A promise resolving to an initialized {@link LlmExecutor}.
   * @throws When no credential is available for the resolved provider.
   */
  async createForRole(role: string): Promise<LlmExecutor> {
    const session = await this._sessionFactory.createForRole(role);
    return new ConcreteExecutor({ session, contextEngine: this._contextEngine });
  }

  /**
   * Creates an executor with the given options.
   *
   * When `opts.session` is supplied, wraps it directly. Otherwise delegates
   * to `sessionFactory.create(opts.sessionOptions)`.
   *
   * @param opts - Executor construction options.
   * @returns A promise resolving to an initialized {@link LlmExecutor}.
   * @throws When neither `session` nor valid session options are supplied.
   */
  async create(opts: ExecutorFactoryOptions): Promise<LlmExecutor> {
    if (opts.session !== undefined) {
      return new ConcreteExecutor({ session: opts.session, contextEngine: this._contextEngine });
    }

    const session = await this._sessionFactory.create(opts.sessionOptions ?? {});
    return new ConcreteExecutor({ session, contextEngine: this._contextEngine });
  }
}

// ---------------------------------------------------------------------------
// Per-role singleton cache
// ---------------------------------------------------------------------------

let _defaultFactory: DefaultLlmExecutorFactory | undefined;
const _executorCache = new Map<string, LlmExecutor>();

/**
 * Returns a cached {@link LlmExecutor} for the given role.
 *
 * The first call for a given role creates and caches the executor. Subsequent
 * calls return the same instance. Use for callers that want a stable executor
 * across multiple calls without re-resolving credentials per call.
 *
 * When `role === 'compression'`, the executor is constructed with a default
 * {@link LlmSummarizationEngine} so callers receive a compression-capable
 * executor without additional configuration.
 *
 * NOTE: The executor's session history accumulates across calls. Callers
 * that need a fresh conversation should use `new DefaultLlmExecutorFactory()
 * .createForRole(role)` directly instead.
 *
 * @param role - CLEO role name (e.g. `'orchestrator'`, `'sentient'`).
 * @returns A promise resolving to the cached {@link LlmExecutor} for this role.
 */
export async function getLlmExecutor(role: string): Promise<LlmExecutor> {
  const cached = _executorCache.get(role);
  if (cached !== undefined) return cached;

  // TODO(T9312): Plugin engine registration hook — Phase 5 will allow plugins to
  // register custom ContextEngine implementations here before the factory is used.
  const contextEngine: ContextEngine | undefined =
    role === 'compression' ? new LlmSummarizationEngine() : undefined;

  if (_defaultFactory === undefined) {
    _defaultFactory = new DefaultLlmExecutorFactory({ contextEngine });
  }

  const executor = await _defaultFactory.createForRole(role);
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
    _defaultFactory = undefined;
  }
}
