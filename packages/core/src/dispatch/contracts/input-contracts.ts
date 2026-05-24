/**
 * INPUT_CONTRACTS — SSoT registry of per-operation input contracts.
 *
 * Keyed by the canonical `<domain>.<verb>` operation identifier (e.g.
 * `'tasks.add'`, `'tasks.add-batch'`, `'tasks.update'`). The value type uses
 * `OperationInputContract<unknown>` so the map is assignable across
 * operations with different input shapes — callers that need the concrete
 * `T` must narrow via an operation-specific accessor.
 *
 * This registry is the discovery surface every retrofit (T9917+) wires
 * into. CLI commands look up their contract by operation name, hand the
 * raw payload to `validateOperationInput()` (T9915), then forward the
 * narrowed value through `dispatchRaw`.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/contracts/input-contracts
 *
 * @task T9917
 * @epic T9903
 * @saga T9855
 */

import {
  type OperationInputContractRegistry,
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
 */
export const INPUT_CONTRACTS: OperationInputContractRegistry = {
  'tasks.add': tasksAddInputContract,
  'tasks.add-batch': tasksAddBatchInputContract,
  'tasks.update': tasksUpdateInputContract,
};
