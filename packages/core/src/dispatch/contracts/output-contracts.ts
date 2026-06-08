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
 * `'tasks.show'`). A `null` lookup is expected (a genuinely-unregistered op)
 * and MUST NOT error.
 *
 * ## Resolution order (T11762 ST-3)
 *
 * The accessor resolves a contract in two tiers, most-authoritative first:
 *
 *   1. **Hand-authored** — the 7 high-traffic `tasks.*` entries in
 *      {@link OUTPUT_CONTRACTS}. These are precise and stay authoritative.
 *   2. **Derived** — {@link deriveOutputContract} synthesises a contract from
 *      existing shape registries (`OPERATION_RESULT_SCHEMAS`, `PROJECTION_PLANS`,
 *      `MinimalMutateEnvelope`) so the remaining ~404 operations resolve a
 *      contract without hand-authoring sprawl (closes the DHQ-057 coverage gap).
 *   3. **`null`** — the operation is not registered at all.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/contracts/output-contracts
 *
 * @epic T11679
 * @task T11692 — DHQ-057: per-operation output schema SSoT
 * @task T11762 ST-3 — generic per-op output schema coverage backfill
 */

import { type OperationOutputContract, OUTPUT_CONTRACTS } from '@cleocode/contracts';
import { deriveOutputContract } from './derive-output-contract.js';

export { OUTPUT_CONTRACTS };

/**
 * Resolve the {@link OperationOutputContract} for an operation id, or return
 * `null` when no contract can be resolved.
 *
 * Used by the SDK `describeOperation` and the `cleo <op> --describe`
 * introspection surface to render the result-shape contract (data schema +
 * valid `--field` pointers). Mirrors {@link getInputContract} exactly, with the
 * addition of the derived tier (T11762 ST-3).
 *
 * Resolution order: hand-authored {@link OUTPUT_CONTRACTS}[op] →
 * {@link deriveOutputContract}(op) → `null`. The hand-authored contracts stay
 * authoritative; the derived tier lifts coverage to near-100% for ops that lack
 * a bespoke entry. A `null` result is "no contract / unverified shape", never an
 * error.
 *
 * @param operation - Canonical `<domain>.<verb>` operation identifier.
 * @returns The matching contract (hand-authored or derived), or `null` when the
 *          operation is not registered.
 *
 * @task T11692
 * @task T11762 ST-3
 */
export function getOutputContract(operation: string): OperationOutputContract | null {
  return OUTPUT_CONTRACTS[operation] ?? deriveOutputContract(operation) ?? null;
}
