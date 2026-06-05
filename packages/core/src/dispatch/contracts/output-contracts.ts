/**
 * OUTPUT_CONTRACTS accessor — SSoT lookup for per-operation OUTPUT contracts.
 *
 * The OUTPUT-side mirror of {@link getInputContract}. The contract DATA lives
 * in `@cleocode/contracts` (a leaf, zero-runtime-dep package) as
 * {@link OUTPUT_CONTRACTS}; this module re-exports it and provides the null-safe
 * accessor that the SDK `describeOperation` and the `cleo <op> --describe`
 * surface consult.
 *
 * Keyed by the canonical `<domain>.<verb>` operation identifier (e.g.
 * `'tasks.show'`). A `null` lookup is expected (the registry is populated
 * incrementally, high-traffic ops first) and MUST NOT error.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/contracts/output-contracts
 *
 * @epic T11679
 * @task T11692 — DHQ-057: per-operation output schema SSoT
 */

import { type OperationOutputContract, OUTPUT_CONTRACTS } from '@cleocode/contracts';

export { OUTPUT_CONTRACTS };

/**
 * Resolve the {@link OperationOutputContract} for an operation id, or return
 * `null` when no contract is registered.
 *
 * Used by the SDK `describeOperation` and the `cleo <op> --describe`
 * introspection surface to render the result-shape contract (data schema +
 * valid `--field` pointers). Mirrors {@link getInputContract} exactly.
 *
 * @param operation - Canonical `<domain>.<verb>` operation identifier.
 * @returns The matching contract, or `null` when none is registered.
 *
 * @task T11692
 */
export function getOutputContract(operation: string): OperationOutputContract | null {
  return OUTPUT_CONTRACTS[operation] ?? null;
}
