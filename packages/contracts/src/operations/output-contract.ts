/**
 * OperationOutputContract — schema-first OUTPUT contract for CLEO operations.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the per-operation OUTPUT
 * (result) shape introspection surface (DHQ-057 · T11692 · EP-DHQ-CORE-FIXES
 * T11679 · SG-CORE-SELF-TOOLING T11480). It is the OUTPUT-side mirror of
 * {@link OperationInputContract}.
 *
 * ## Why this exists
 *
 * Before this contract, {@link OperationDef} declared INPUT (`params`) but had
 * NO machine-readable description of the OUTPUT envelope's `data` payload.
 * Consequently:
 *
 *   - `cleo show T123 --field /data/title` returned `E_FIELD_NOT_FOUND` because
 *     the real shape is `/data/task/title` — agents had no way to predict the
 *     envelope `data` shape and `--field` JSON pointers were guesswork.
 *   - Every consumer (CLI `--field`, REST clients, the SDK) hand-sniffed the
 *     result per verb instead of resolving against a declared contract.
 *
 * An {@link OperationOutputContract} pairs a stable operation identifier with
 * the JSON Schema (draft-07) document describing the envelope's `data` payload
 * AND the curated set of valid `--field` JSON pointers (rooted at `/data`) that
 * an agent can use without trial and error.
 *
 * ZERO runtime dependencies: `contracts` is a leaf package. JSON Schema
 * documents are modeled as the loose {@link JsonSchema} alias (re-used from the
 * input-contract module) so this module does not pull in a JSON Schema typings
 * package.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/operations/output-contract
 *
 * @see {@link https://json-schema.org/draft-07/schema}
 * @see OperationInputContract — the INPUT-side mirror of this contract
 *
 * @epic T11679
 * @task T11692 — DHQ-057: per-operation output schema SSoT
 */

import type { JsonSchema } from './input-contract.js';

// ---------------------------------------------------------------------------
// OperationOutputContract
// ---------------------------------------------------------------------------

/**
 * Schema-first OUTPUT (result) contract for a single CLEO operation.
 *
 * Pairs a stable operation identifier with the JSON Schema draft-07 document
 * that describes the LAFS envelope's `data` payload, plus the curated list of
 * valid `--field` JSON pointers an agent can rely on.
 *
 * The `dataSchema` describes the shape of `envelope.data` — i.e. the value the
 * dispatch handler returns, BEFORE the LAFS `{ success, data, meta }` wrapper
 * is applied. For example, `tasks.show` returns
 * `{ task, view, attachments, acRows?, relations? }`, so its `dataSchema` has
 * `task` as a required property and `/data/task/title` is the canonical pointer
 * for the task title — NOT `/data/title`.
 *
 * @example
 * ```ts
 * const showOutput: OperationOutputContract = {
 *   operation: 'tasks.show',
 *   dataSchema: {
 *     type: 'object',
 *     required: ['task'],
 *     properties: {
 *       task: { type: 'object', description: 'Full task record' },
 *       view: { type: ['object', 'null'] },
 *       attachments: { type: 'array' },
 *     },
 *   },
 *   fieldPointers: ['/data/task/id', '/data/task/title', '/data/task/status'],
 * };
 * ```
 */
export interface OperationOutputContract {
  /**
   * Stable, fully-qualified operation identifier in `<domain>.<verb>` form
   * (e.g. `'tasks.show'`, `'tasks.add-batch'`). Used as the registry key in
   * {@link OperationOutputContractRegistry}.
   */
  operation: string;

  /**
   * JSON Schema draft-07 document describing the shape of the LAFS envelope's
   * `data` payload returned by this operation.
   *
   * This is the shape of `envelope.data` — the dispatch handler's return value
   * BEFORE the `{ success, data, meta }` wrapper. Pointers used by `--field`
   * are therefore rooted at `/data` (e.g. `/data/task/title` resolves against
   * `dataSchema.properties.task.properties.title`).
   */
  dataSchema: JsonSchema;

  /**
   * Curated, copy-pasteable list of valid `--field` JSON pointers an agent can
   * use without trial and error. Each pointer is rooted at the envelope root
   * (`/data/...`), matching the resolution semantics of `cleo <op> --field`.
   *
   * This is the direct remediation for the `--field /data/title` →
   * `E_FIELD_NOT_FOUND` class of failures: instead of guessing, an agent runs
   * `cleo show --describe` and reads the exact pointers that resolve.
   *
   * Conventionally lists the high-value scalar/leaf pointers (ids, titles,
   * statuses, counts) — not every possible deep pointer.
   */
  fieldPointers: string[];

  /**
   * Optional one-line note clarifying non-obvious shape facts (e.g. "task body
   * is nested under `task`, not the root"). Surfaced in `--describe` output to
   * pre-empt the exact mistakes this contract is designed to prevent.
   */
  shapeNote?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry of every {@link OperationOutputContract} known to the CLEO runtime,
 * keyed by the contract's `operation` identifier (e.g. `'tasks.show'`).
 *
 * The OUTPUT-side mirror of `OperationInputContractRegistry`. Populated
 * incrementally — high-traffic operations first. A `null` lookup (operation
 * absent from the registry) is expected and MUST NOT error: callers render a
 * structured "no output contract yet" payload instead.
 *
 * @example
 * ```ts
 * const registry: OperationOutputContractRegistry = {
 *   'tasks.show': showOutputContract,
 *   'tasks.list': listOutputContract,
 * };
 * ```
 */
export type OperationOutputContractRegistry = Record<string, OperationOutputContract>;
