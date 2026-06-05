/**
 * describeOperation — SDK introspection of a CLEO operation's I/O contract.
 *
 * The programmatic counterpart to `cleo <op> --describe`. Given a canonical
 * `<domain>.<verb>` operation id (e.g. `'tasks.show'`), composes a single
 * typed {@link OperationDescriptor} from the three SSoT surfaces:
 *
 *   1. {@link OperationDef} (from `@cleocode/contracts`) — gateway, tier,
 *      idempotency, session requirement, and the declared `params`.
 *   2. The INPUT contract (`getInputContract`, T9918) — JSON Schema for the
 *      accepted request payload + worked examples. The schemas set
 *      `additionalProperties: false`, so unknown keys (e.g. `relates` on
 *      `tasks.add-batch`) are rejected LOUDLY (DHQ-033).
 *   3. The OUTPUT contract (`getOutputContract`, T11692) — JSON Schema for the
 *      LAFS envelope's `data` payload + the curated list of valid `--field`
 *      JSON pointers (DHQ-057). This is what lets an agent predict the result
 *      shape instead of guessing (`/data/task/title`, NOT `/data/title`).
 *
 * This is the root fix for "agents cannot predict the envelope" (T11692):
 * `--field` pointers, result parsing, and SDK consumers all resolve against
 * ONE declared contract rather than hand-sniffing per verb.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/describe-operation
 *
 * @epic T11679
 * @task T11692 — DHQ-057: per-operation output schema SSoT
 */

import {
  OPERATIONS,
  type OperationDef,
  type OperationInputContract,
  type OperationOutputContract,
} from '@cleocode/contracts';
import { describeOperation as describeParams, type OperationSchema } from '@cleocode/lafs';
import { getInputContract } from './contracts/input-contracts.js';
import { getOutputContract } from './contracts/output-contracts.js';

/**
 * Fully-resolved I/O contract for a single CLEO operation.
 *
 * Returned by {@link describeOperation}. Bundles the operation's identity, its
 * parameter signature (`params`/`gates` via the LAFS schema), the INPUT
 * contract, and the OUTPUT contract into one machine- and human-readable
 * descriptor. `inputContract` / `outputContract` are `null` for operations not
 * yet migrated to the schema-first surface — callers render the descriptor with
 * a "no contract yet" note rather than failing.
 */
export interface OperationDescriptor {
  /** Fully-qualified operation key, e.g. `"tasks.show"`. */
  operation: string;
  /** CQRS gateway — read-only (`"query"`) or state-modifying (`"mutate"`). */
  gateway: 'query' | 'mutate';
  /** One-line description of what the operation does. */
  description: string;
  /** Agent progressive-disclosure tier (0=basic, 1=memory/check, 2=full). */
  tier: number;
  /** Whether the operation is safe to retry. */
  idempotent: boolean;
  /** Whether the operation requires an active session. */
  sessionRequired: boolean;
  /**
   * Parameter signature + declared precondition gates, derived from the LAFS
   * {@link OperationSchema}. The authoritative human-readable param list.
   */
  params: OperationSchema;
  /**
   * Schema-first INPUT contract (JSON Schema + examples), or `null` when the
   * operation has no registered input contract yet.
   */
  inputContract: OperationInputContract<unknown> | null;
  /**
   * Schema-first OUTPUT contract (envelope `data` JSON Schema + valid `--field`
   * pointers), or `null` when the operation has no registered output contract
   * yet.
   */
  outputContract: OperationOutputContract | null;
}

/**
 * Resolve the {@link OperationDef} for a canonical `<domain>.<verb>` key.
 *
 * The first dot separates domain from operation, so dotted operation names like
 * `"complexity.estimate"` are handled correctly. When the key has no dot, an
 * unambiguous single-domain match is returned (else `null`).
 *
 * @param operation - The operation id (e.g. `"tasks.show"`).
 * @returns The matching {@link OperationDef}, or `null` if not found / ambiguous.
 *
 * @internal
 */
function resolveOperationDef(operation: string): OperationDef | null {
  const dotIdx = operation.indexOf('.');
  if (dotIdx === -1) {
    const matches = OPERATIONS.filter((op) => op.operation === operation);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }
  const domain = operation.slice(0, dotIdx);
  const op = operation.slice(dotIdx + 1);
  return OPERATIONS.find((o) => o.domain === domain && o.operation === op) ?? null;
}

/**
 * Describe a CLEO operation's full INPUT + OUTPUT contract.
 *
 * The SDK entry point behind `cleo <op> --describe`. Resolves the operation by
 * its canonical `<domain>.<verb>` id and returns a single typed
 * {@link OperationDescriptor}, or `null` when the operation id is unknown.
 *
 * Contract resolution prefers an inline contract carried on the
 * {@link OperationDef} (`def.inputSchema` / `def.outputSchema`) and falls back
 * to the SSoT registries (`getInputContract` / `getOutputContract`). This lets
 * a definition self-describe while keeping the registries authoritative.
 *
 * @param operation - Canonical `<domain>.<verb>` operation id (e.g. `"tasks.show"`).
 * @returns The resolved descriptor, or `null` when the operation is unknown.
 *
 * @example
 * ```ts
 * import { describeOperation } from '@cleocode/core';
 *
 * const d = describeOperation('tasks.show');
 * // d.outputContract.fieldPointers includes '/data/task/title'
 * //   → the correct pointer; '/data/title' would E_FIELD_NOT_FOUND.
 * ```
 *
 * @task T11692
 */
export function describeOperation(operation: string): OperationDescriptor | null {
  const def = resolveOperationDef(operation);
  if (def === null) return null;

  const key = `${def.domain}.${def.operation}`;
  const params = describeParams(def, { includeGates: true, includeExamples: true });
  const inputContract = def.inputSchema ?? getInputContract(key);
  const outputContract = def.outputSchema ?? getOutputContract(key);

  return {
    operation: key,
    gateway: def.gateway,
    description: def.description,
    tier: def.tier,
    idempotent: def.idempotent,
    sessionRequired: def.sessionRequired,
    params,
    inputContract,
    outputContract,
  };
}
