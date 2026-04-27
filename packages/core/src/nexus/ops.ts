/**
 * Nexus domain Core operation signatures.
 *
 * Declares the `nexusCoreOps` registry — the type source for
 * `OpsFromCore<typeof nexus.nexusCoreOps>` inference in the dispatch layer.
 *
 * Every key maps to a typed operation function signature derived from the
 * canonical `NexusOps` tuple record in `@cleocode/contracts`.
 *
 * @module nexus/ops
 * @task T1440 — nexus dispatch OpsFromCore migration
 *
 * @example
 * ```ts
 * import type { nexus as coreNexus } from '@cleocode/core';
 * import type { OpsFromCore } from '../adapters/typed.js';
 *
 * type NexusOps = OpsFromCore<typeof coreNexus.nexusCoreOps>;
 * ```
 */

import type { NexusOps } from '@cleocode/contracts';

/** Extract the param type for a nexus operation. */
type NexusOpParams<K extends keyof NexusOps> = NexusOps[K][0];

/** Extract the result type for a nexus operation. */
type NexusOpResult<K extends keyof NexusOps> = NexusOps[K][1];

/** Typed function signature for a nexus core operation. */
type NexusCoreOperation<K extends keyof NexusOps> = (
  params: NexusOpParams<K>,
) => Promise<NexusOpResult<K>>;

/**
 * Nexus operation registry used by the dispatch layer for
 * `OpsFromCore<typeof nexusCoreOps>` inference.
 *
 * @example
 * ```ts
 * import type { nexus } from '@cleocode/core';
 * import type { OpsFromCore } from '../adapters/typed.js';
 *
 * type NexusOps = OpsFromCore<typeof nexus.nexusCoreOps>;
 * const handler = defineTypedHandler<NexusOps>('nexus', { ... });
 * ```
 *
 * @task T1440 — nexus dispatch refactor (OpsFromCore inference)
 */
export declare const nexusCoreOps: {
  // -------------------------------------------------------------------------
  // Query ops (30)
  // -------------------------------------------------------------------------
  readonly status: NexusCoreOperation<'status'>;
  readonly list: NexusCoreOperation<'list'>;
  readonly show: NexusCoreOperation<'show'>;
  readonly resolve: NexusCoreOperation<'resolve'>;
  readonly deps: NexusCoreOperation<'deps'>;
  readonly graph: NexusCoreOperation<'graph'>;
  readonly 'path.show': NexusCoreOperation<'path.show'>;
  readonly 'blockers.show': NexusCoreOperation<'blockers.show'>;
  readonly 'orphans.list': NexusCoreOperation<'orphans.list'>;
  readonly discover: NexusCoreOperation<'discover'>;
  readonly search: NexusCoreOperation<'search'>;
  readonly augment: NexusCoreOperation<'augment'>;
  readonly 'share.status': NexusCoreOperation<'share.status'>;
  readonly 'transfer.preview': NexusCoreOperation<'transfer.preview'>;
  readonly 'top-entries': NexusCoreOperation<'top-entries'>;
  readonly impact: NexusCoreOperation<'impact'>;
  readonly 'full-context': NexusCoreOperation<'full-context'>;
  readonly 'task-footprint': NexusCoreOperation<'task-footprint'>;
  readonly 'brain-anchors': NexusCoreOperation<'brain-anchors'>;
  readonly why: NexusCoreOperation<'why'>;
  readonly 'impact-full': NexusCoreOperation<'impact-full'>;
  readonly 'route-map': NexusCoreOperation<'route-map'>;
  readonly 'shape-check': NexusCoreOperation<'shape-check'>;
  readonly 'search-code': NexusCoreOperation<'search-code'>;
  readonly wiki: NexusCoreOperation<'wiki'>;
  readonly 'contracts-show': NexusCoreOperation<'contracts-show'>;
  readonly 'task-symbols': NexusCoreOperation<'task-symbols'>;
  readonly 'profile.view': NexusCoreOperation<'profile.view'>;
  readonly 'profile.get': NexusCoreOperation<'profile.get'>;
  readonly 'sigil.list': NexusCoreOperation<'sigil.list'>;
  // -------------------------------------------------------------------------
  // Mutate ops (18)
  // -------------------------------------------------------------------------
  readonly init: NexusCoreOperation<'init'>;
  readonly register: NexusCoreOperation<'register'>;
  readonly unregister: NexusCoreOperation<'unregister'>;
  readonly sync: NexusCoreOperation<'sync'>;
  readonly 'permission.set': NexusCoreOperation<'permission.set'>;
  readonly reconcile: NexusCoreOperation<'reconcile'>;
  readonly 'share.snapshot.export': NexusCoreOperation<'share.snapshot.export'>;
  readonly 'share.snapshot.import': NexusCoreOperation<'share.snapshot.import'>;
  readonly transfer: NexusCoreOperation<'transfer'>;
  readonly 'contracts-sync': NexusCoreOperation<'contracts-sync'>;
  readonly 'contracts-link-tasks': NexusCoreOperation<'contracts-link-tasks'>;
  readonly 'conduit-scan': NexusCoreOperation<'conduit-scan'>;
  readonly 'profile.import': NexusCoreOperation<'profile.import'>;
  readonly 'profile.export': NexusCoreOperation<'profile.export'>;
  readonly 'profile.reinforce': NexusCoreOperation<'profile.reinforce'>;
  readonly 'profile.upsert': NexusCoreOperation<'profile.upsert'>;
  readonly 'profile.supersede': NexusCoreOperation<'profile.supersede'>;
  readonly 'sigil.sync': NexusCoreOperation<'sigil.sync'>;
};
