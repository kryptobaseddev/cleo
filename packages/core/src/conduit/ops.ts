/**
 * Conduit operation signatures owned by Core.
 *
 * Dispatch uses these signatures as the type source for `OpsFromCore` while
 * conduit runtime behavior remains in the existing behavior-preserving handler.
 *
 * @task T1439
 */

import type { ConduitOps } from '@cleocode/contracts';

type ConduitOpName = keyof ConduitOps;
type ConduitOpParams<Op extends ConduitOpName> = ConduitOps[Op][0];
type ConduitOpResult<Op extends ConduitOpName> = ConduitOps[Op][1];
type ConduitCoreOperation<Op extends ConduitOpName> = (
  params: ConduitOpParams<Op>,
) => Promise<ConduitOpResult<Op>>;

/**
 * Conduit operation record used by dispatch for Core-derived operation inference.
 *
 * @example
 * ```ts
 * import type { conduit } from '@cleocode/core';
 * import type { OpsFromCore } from '../adapters/typed.js';
 *
 * type ConduitDispatchOps = OpsFromCore<typeof conduit.conduitCoreOps>;
 * ```
 */
export declare const conduitCoreOps: {
  readonly status: ConduitCoreOperation<'status'>;
  readonly peek: ConduitCoreOperation<'peek'>;
  readonly listen: ConduitCoreOperation<'listen'>;
  readonly start: ConduitCoreOperation<'start'>;
  readonly stop: ConduitCoreOperation<'stop'>;
  readonly send: ConduitCoreOperation<'send'>;
  readonly subscribe: ConduitCoreOperation<'subscribe'>;
  readonly publish: ConduitCoreOperation<'publish'>;
};
