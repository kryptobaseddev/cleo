/**
 * Registry-to-CLI args bridge.
 *
 * Provides helpers that CLI command files use to derive their citty `args`
 * directly from the OPERATIONS registry rather than declaring inline duplicates.
 *
 * Usage in a command file:
 * ```typescript
 * import { getOperationParams, paramsToCittyArgs } from '../lib/registry-args.js';
 *
 * export const showCommand = defineCommand({
 *   args: paramsToCittyArgs(getOperationParams('query', 'tasks', 'show')),
 *   async run({ args }) { ... },
 * });
 * ```
 *
 * @module registry-args
 */

import type { CittyArgDef, ParamDef } from '@cleocode/contracts';
import { OPERATIONS } from '../../dispatch/registry.js';
import type { Gateway } from '../../dispatch/types.js';

const IDEMPOTENCY_KEY_PARAM: ParamDef = {
  name: 'idempotencyKey',
  type: 'string',
  required: false,
  description: 'Optional retry token for safely replaying idempotent mutating commands.',
  cli: { flag: 'idempotency-key' },
};

/**
 * Retrieve the declared `params[]` for a specific operation from the registry.
 *
 * Returns an empty array when:
 * - The operation is not found in the registry.
 * - The operation exists but has no `params` array yet (legacy entry).
 *
 * @param gateway - The CQRS gateway: `'query'` or `'mutate'`.
 * @param domain  - The canonical domain name (e.g. `'tasks'`, `'check'`).
 * @param operation - The operation name (e.g. `'show'`, `'list'`).
 * @returns The `ParamDef[]` from the registry, or `[]` if none declared.
 */
export function getOperationParams(
  gateway: Gateway,
  domain: string,
  operation: string,
): ParamDef[] {
  const def = OPERATIONS.find(
    (o) => o.gateway === gateway && o.domain === domain && o.operation === operation,
  );
  const params = def?.params ?? [];
  if (!def || def.gateway !== 'mutate' || !def.idempotent) return params;
  if (params.some((param) => param.name === IDEMPOTENCY_KEY_PARAM.name)) return params;
  return [...params, IDEMPOTENCY_KEY_PARAM];
}

export { paramsToCittyArgs } from '@cleocode/contracts';
// Re-export paramsToCittyArgs and types so command files only need one import.
export type { CittyArgDef, ParamDef };
