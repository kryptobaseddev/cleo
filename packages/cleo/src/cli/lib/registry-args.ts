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

/**
 * Forward every registry-declared param from parsed citty args into a dispatch
 * payload, coercing each value to its declared `type`.
 *
 * Why this exists (T12120 · GH #1245, #1248)
 * ------------------------------------------
 * {@link paramsToCittyArgs} derives a command's citty *flags* from the
 * registry, so `--help` advertises exactly the registry's surface. But
 * commands historically hand-wrote the other half — a block of
 * `if (args['x'] !== undefined) params['x'] = args['x'];` lines — so the
 * advertised surface and the *forwarded* surface were free to drift. They did:
 * `cleo list` declared 10 params, hand-copied 7, and `--compact` was therefore
 * accepted, documented, implemented in core, and never delivered (GH #1248).
 *
 * Deriving the payload from the same `ParamDef[]` that derives the flags makes
 * that divergence unrepresentable — a param cannot be advertised without also
 * being forwarded.
 *
 * @param params - The operation's declared `ParamDef[]` (from {@link getOperationParams}).
 * @param args - Parsed citty args for the invocation.
 * @returns Dispatch payload containing only the params actually supplied,
 *          keyed by canonical `param.name` (not the CLI flag spelling).
 *
 * @example
 * ```typescript
 * const params = getOperationParams('query', 'tasks', 'list');
 * const payload = registryParamsToDispatchPayload(params, args);
 * await dispatchRaw('query', 'tasks', 'list', payload);
 * ```
 */
export function registryParamsToDispatchPayload(
  params: ParamDef[],
  args: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const param of params) {
    const flag = param.cli?.flag ?? param.name;
    const raw = args[flag];
    if (raw === undefined || raw === null) continue;

    if (param.type === 'number') {
      const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
      if (!Number.isNaN(parsed)) payload[param.name] = parsed;
      continue;
    }
    if (param.type === 'boolean') {
      payload[param.name] = typeof raw === 'boolean' ? raw : String(raw) !== 'false';
      continue;
    }
    if (param.type === 'array') {
      payload[param.name] = Array.isArray(raw)
        ? raw
        : String(raw)
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
      continue;
    }
    payload[param.name] = raw;
  }

  return payload;
}

export { paramsToCittyArgs } from '@cleocode/contracts';
// Re-export paramsToCittyArgs and types so command files only need one import.
export type { CittyArgDef, ParamDef };
