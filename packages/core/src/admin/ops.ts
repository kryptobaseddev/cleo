/**
 * Admin operation signatures owned by Core.
 *
 * Dispatch uses these signatures as the type source for `OpsFromCore` while
 * admin runtime behavior remains in the existing handlers.
 *
 * @task T1437
 */

import type { AdminOps } from '@cleocode/contracts';

type AdminOpName = AdminOps['op'];
type AdminOpParams<Op extends AdminOpName> = Extract<AdminOps, { op: Op }>['params'];
type AdminOpResult<Op extends AdminOpName> = Extract<AdminOps, { op: Op }>['result'];
type AdminCoreOperation<Op extends AdminOpName> = (
  params: AdminOpParams<Op>,
) => Promise<AdminOpResult<Op>>;

/**
 * Admin operation record used by dispatch for Core-derived operation inference.
 *
 * @example
 * ```ts
 * import type { admin } from '@cleocode/core';
 * import type { OpsFromCore } from '../adapters/typed.js';
 *
 * type AdminDispatchOps = OpsFromCore<typeof admin.adminCoreOps>;
 * ```
 */
export declare const adminCoreOps: {
  readonly version: AdminCoreOperation<'admin.version'>;
  readonly health: AdminCoreOperation<'admin.health'>;
  readonly 'config.show': AdminCoreOperation<'admin.config.show'>;
  readonly 'config.presets': AdminCoreOperation<'admin.config.presets'>;
  readonly stats: AdminCoreOperation<'admin.stats'>;
  readonly context: AdminCoreOperation<'admin.context'>;
  readonly 'context.pull': AdminCoreOperation<'admin.context.pull'>;
  readonly runtime: AdminCoreOperation<'admin.runtime'>;
  readonly paths: AdminCoreOperation<'admin.paths'>;
  readonly job: AdminCoreOperation<'admin.job'>;
  readonly dash: AdminCoreOperation<'admin.dash'>;
  readonly log: AdminCoreOperation<'admin.log'>;
  readonly sequence: AdminCoreOperation<'admin.sequence'>;
  readonly help: AdminCoreOperation<'admin.help'>;
  readonly token: AdminCoreOperation<'admin.token'>;
  readonly 'adr.find': AdminCoreOperation<'admin.adr.find'>;
  readonly 'adr.show': AdminCoreOperation<'admin.adr.show'>;
  readonly backup: AdminCoreOperation<'admin.backup'>;
  readonly export: AdminCoreOperation<'admin.export'>;
  readonly map: AdminCoreOperation<'admin.map'>;
  readonly roadmap: AdminCoreOperation<'admin.roadmap'>;
  readonly smoke: AdminCoreOperation<'admin.smoke'>;
  readonly 'smoke.provider': AdminCoreOperation<'admin.smoke.provider'>;
  readonly 'hooks.matrix': AdminCoreOperation<'admin.hooks.matrix'>;
  readonly init: AdminCoreOperation<'admin.init'>;
  readonly 'scaffold-hub': AdminCoreOperation<'admin.scaffold-hub'>;
  readonly 'health.mutate': AdminCoreOperation<'admin.health.mutate'>;
  readonly 'config.set': AdminCoreOperation<'admin.config.set'>;
  readonly 'config.set-preset': AdminCoreOperation<'admin.config.set-preset'>;
  readonly 'backup.mutate': AdminCoreOperation<'admin.backup.mutate'>;
  readonly migrate: AdminCoreOperation<'admin.migrate'>;
  readonly cleanup: AdminCoreOperation<'admin.cleanup'>;
  readonly 'job.cancel': AdminCoreOperation<'admin.job.cancel'>;
  readonly safestop: AdminCoreOperation<'admin.safestop'>;
  readonly 'inject.generate': AdminCoreOperation<'admin.inject.generate'>;
  readonly 'adr.sync': AdminCoreOperation<'admin.adr.sync'>;
  readonly import: AdminCoreOperation<'admin.import'>;
  readonly detect: AdminCoreOperation<'admin.detect'>;
  readonly 'token.mutate': AdminCoreOperation<'admin.token.mutate'>;
  readonly 'context.inject': AdminCoreOperation<'admin.context.inject'>;
  readonly 'map.mutate': AdminCoreOperation<'admin.map.mutate'>;
  readonly 'install.global': AdminCoreOperation<'admin.install.global'>;
};
