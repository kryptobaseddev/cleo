/**
 * INPUT_CONTRACTS — SSoT registry of per-operation input contracts.
 *
 * Keyed by the canonical `<domain>.<verb>` operation identifier (e.g.
 * `'tasks.add'`, `'tasks.add-batch'`, `'tasks.update'`). The value type uses
 * `OperationInputContract<unknown>` so the map is assignable across
 * operations with different input shapes — callers that need the concrete
 * `T` must narrow via an operation-specific accessor.
 *
 * Originally seeded by T9918 (PR #663) with a single `tasks.add-batch`
 * entry to back the `cleo schema <op> --input/--examples` introspection
 * surface. T9917 extends the registry to cover the full tasks.* mutate
 * surface (add + add-batch + update) and rewires the schemas to live in
 * `packages/contracts/src/operations/tasks.ts` so the CLI commands
 * import them via the contracts leaf package (no Core dependency hop).
 *
 * CLI commands look up their contract by operation name, hand the raw
 * payload to `validateOperationInput()` (T9915), then forward the
 * narrowed value through `dispatchRaw`. Every retrofit (T9917+) extends
 * this map.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/contracts/input-contracts
 *
 * @epic T9855
 * @task T9918 — original seed entry + getInputContract accessor
 * @task T9917 — tasks.add + tasks.update extension; schemas moved to contracts
 */

import {
  accountAddInputContract,
  accountListInputContract,
  accountRemoveInputContract,
  modelQueryInputContract,
  modelShowInputContract,
  type OperationInputContract,
  type OperationInputContractRegistry,
  profileCreateInputContract,
  profileListInputContract,
  profilePinInputContract,
  profileUseInputContract,
  providerConnectInputContract,
  providerListInputContract,
  providerShowInputContract,
  serviceConnectInputContract,
  serviceListInputContract,
  serviceRevokeInputContract,
  serviceStatusInputContract,
  tasksAddBatchInputContract,
  tasksAddInputContract,
  tasksUpdateInputContract,
} from '@cleocode/contracts';

/**
 * Registry of every {@link OperationInputContract} known to the CLEO
 * runtime, keyed by the contract's `operation` identifier.
 *
 * Extend this map every time a new operation is migrated to the
 * schema-first input contract surface.
 *
 * @example
 * ```ts
 * import { INPUT_CONTRACTS } from '@cleocode/core/dispatch/contracts/input-contracts';
 *
 * const contract = INPUT_CONTRACTS['tasks.add'];
 * if (!contract) throw new Error('unknown op');
 * const result = validateOperationInput(contract, payload);
 * ```
 *
 * @task T9917 — extended with tasks.add + tasks.update
 * @task T9918 — original tasks.add-batch seed
 */
export const INPUT_CONTRACTS: OperationInputContractRegistry = {
  'tasks.add': tasksAddInputContract,
  'tasks.add-batch': tasksAddBatchInputContract,
  'tasks.update': tasksUpdateInputContract,
  // service-vault CLI verbs (T11941 · epic T11765 · M2-W4)
  'service.connect': serviceConnectInputContract,
  'service.list': serviceListInputContract,
  'service.revoke': serviceRevokeInputContract,
  'service.status': serviceStatusInputContract,
  // 5-entity provider-experience ops (T11700 · epic T11666)
  'account.add': accountAddInputContract,
  'account.list': accountListInputContract,
  'account.remove': accountRemoveInputContract,
  'provider.list': providerListInputContract,
  'provider.show': providerShowInputContract,
  'provider.connect': providerConnectInputContract,
  'model.query': modelQueryInputContract,
  'model.show': modelShowInputContract,
  'profile.create': profileCreateInputContract,
  'profile.list': profileListInputContract,
  'profile.pin': profilePinInputContract,
  'profile.use': profileUseInputContract,
};

/**
 * Resolve the {@link OperationInputContract} for an operation id, or
 * return `null` when no contract is registered.
 *
 * Used by the `cleo schema <op> --input` / `--examples` introspection
 * surface (T9918) and by any caller that needs to render a null-safe
 * envelope when an operation has no schema-first contract yet.
 *
 * @param operation - Canonical `<domain>.<verb>` operation identifier.
 * @returns The matching contract, or `null` when no contract is registered.
 *
 * @task T9918
 */
export function getInputContract(operation: string): OperationInputContract<unknown> | null {
  return INPUT_CONTRACTS[operation] ?? null;
}
