/**
 * Lazily-loaded domain handlers for the CLI dispatcher (T13126).
 *
 * {@link createDomainHandlers} in `./index.ts` imports all 29 handler modules
 * statically, and with them every CORE subsystem each domain uses. The CLI runs
 * ONE operation per process, so it registers these proxies instead: each loads
 * its domain module on the first `query`/`mutate` and delegates to the real
 * handler from then on. `cleo show` loads the tasks domain and nothing else.
 *
 * The domain-to-module table below must list the same domains, in the same
 * order, as `createDomainHandlers`; `lazy-domains.test.ts` pins that, and that
 * each proxy reaches the class `createDomainHandlers` registers.
 *
 * @task T13126
 */

import { OPERATIONS } from '@cleocode/contracts/dispatch/operations-registry.js';
import type { DispatchResponse, DomainHandler } from '../types.js';

/** Loads and constructs one domain's real handler. */
type DomainLoader = () => Promise<DomainHandler>;

/**
 * Domain name -> loader, in `createDomainHandlers` order. Each entry imports
 * only its own module, so esbuild emits each domain as its own chunk.
 */
export const DOMAIN_LOADERS: ReadonlyArray<readonly [string, DomainLoader]> = [
  ['tasks', async () => new (await import('./tasks.js')).TasksHandler()],
  ['session', async () => new (await import('./session.js')).SessionHandler()],
  ['attention', async () => new (await import('./attention.js')).AttentionHandler()],
  ['memory', async () => new (await import('./memory.js')).MemoryHandler()],
  ['intelligence', async () => new (await import('./intelligence.js')).IntelligenceHandler()],
  ['check', async () => new (await import('./check.js')).CheckHandler()],
  ['pipeline', async () => new (await import('./pipeline.js')).PipelineHandler()],
  ['orchestrate', async () => new (await import('./orchestrate.js')).OrchestrateHandler()],
  ['tools', async () => new (await import('./tools.js')).ToolsHandler()],
  ['admin', async () => new (await import('./admin.js')).AdminHandler()],
  ['nexus', async () => new (await import('./nexus.js')).NexusHandler()],
  ['sticky', async () => new (await import('./sticky.js')).StickyHandler()],
  ['diagnostics', async () => new (await import('./diagnostics.js')).DiagnosticsHandler()],
  ['docs', async () => new (await import('./docs.js')).DocsHandler()],
  ['focus', async () => new (await import('./focus.js')).FocusHandler()],
  ['playbook', async () => new (await import('./playbook.js')).PlaybookHandler()],
  ['conduit', async () => new (await import('./conduit.js')).ConduitHandler()],
  ['sentient', async () => new (await import('./sentient.js')).SentientHandler()],
  ['release', async () => new (await import('./release.js')).ReleaseHandler()],
  ['provenance', async () => new (await import('./provenance.js')).ProvenanceHandler()],
  ['selfimprove', async () => new (await import('./selfimprove.js')).SelfimproveHandler()],
  ['service', async () => new (await import('./service.js')).ServiceHandler()],
  ['llm', async () => new (await import('./llm/index.js')).LlmHandler()],
  ['account', async () => new (await import('./entities.js')).AccountHandler()],
  ['provider', async () => new (await import('./entities.js')).ProviderHandler()],
  ['model', async () => new (await import('./entities.js')).ModelHandler()],
  ['profile', async () => new (await import('./entities.js')).ProfileHandler()],
  ['worktree', async () => new (await import('./worktree.js')).WorktreeHandler()],
  ['upgrade', async () => new (await import('./upgrade.js')).UpgradeHandler()],
];

/**
 * A {@link DomainHandler} that loads its real handler on first use.
 *
 * `getSupportedOperations()` is synchronous, so it answers from the operation
 * registry (the same source the dispatcher resolves against) instead of
 * loading the domain.
 */
export class LazyDomainHandler implements DomainHandler {
  private handler: Promise<DomainHandler> | null = null;

  /**
   * @param domain - Canonical domain name.
   * @param load - Loads and constructs the real handler.
   */
  constructor(
    private readonly domain: string,
    private readonly load: DomainLoader,
  ) {}

  /** The real handler, loaded once. A failed load is retried on the next call. */
  resolve(): Promise<DomainHandler> {
    this.handler ??= this.load().catch((err: Error) => {
      this.handler = null;
      throw err;
    });
    return this.handler;
  }

  /** @inheritdoc */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    return (await this.resolve()).query(operation, params);
  }

  /** @inheritdoc */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    return (await this.resolve()).mutate(operation, params);
  }

  /** @inheritdoc */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    const ops = OPERATIONS.filter((op) => op.domain === this.domain);
    return {
      query: ops.filter((op) => op.gateway === 'query').map((op) => op.operation),
      mutate: ops.filter((op) => op.gateway === 'mutate').map((op) => op.operation),
    };
  }
}

/**
 * The CLI's domain handler map: one {@link LazyDomainHandler} per domain.
 *
 * @returns Domain name -> lazy handler, with the same keys as `createDomainHandlers()`.
 * @example
 * ```ts
 * const dispatcher = new Dispatcher({ handlers: createLazyDomainHandlers() });
 * ```
 */
export function createLazyDomainHandlers(): Map<string, DomainHandler> {
  return new Map(
    DOMAIN_LOADERS.map(([domain, load]) => [domain, new LazyDomainHandler(domain, load)]),
  );
}

/**
 * Wrap a CORE operation so its module loads on the first call, not when the
 * domain module loads. A domain module imports every operation it serves, and
 * the CLI runs one operation per process, so static imports load modules the
 * command never calls (`cleo show` loaded sagas, sync and archive).
 *
 * @param load - Imports the module and returns the operation.
 * @returns An async function with the operation's parameters that resolves to
 *   its result. An import failure rejects the call instead of failing the
 *   domain module's load.
 * @example
 * ```ts
 * const taskShow = lazyOperation(async () => (await import('@cleocode/core/tasks/show')).taskShowOperation);
 * ```
 */
export function lazyOperation<A extends unknown[], R>(
  load: () => Promise<(...args: A) => R>,
): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => await (await load())(...args);
}
