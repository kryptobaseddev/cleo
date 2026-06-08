/**
 * Ensures-schema Zod registry — the cantbook `ensures.schema` name → Zod
 * validator SSoT (T11762 ST-1 · Lane A).
 *
 * ## Why this exists
 *
 * The playbook runtime (`packages/playbooks/src/runtime.ts`) validates a node's
 * post-merge `context` against a named shape declared as `ensures.schema:` in a
 * `.cantbook`. Historically the runtime HARDCODED two bespoke validators
 * (`validateDecompositionTaskTree` / `validateIvtrEvidenceOutput`) in an
 * `if (schema === 'task_tree') … else if (=== 'evidence')` block, and silently
 * SKIPPED any other schema name. T11762 replaces that hardcode with a
 * registry-driven lookup so:
 *
 *   - `ensures.schema` names resolve to a registered Zod validator (AC1).
 *   - the runtime no longer hardcodes `'task_tree'` / `'evidence'` (AC2).
 *   - an unknown schema name FAILS CLOSED instead of silently passing.
 *
 * This module holds ONLY the Gate-10 (`lint-no-runtime-in-contracts`)-ALLOWED
 * kinds: the Zod schema **const values**, the {@link EnsuresSchemaSpec} **type**,
 * and the registry **data** (a `ReadonlyMap` value). The bodied accessors
 * (`getEnsuresSchema` / `listEnsuresSchemaNames` / `defineEnsuresSchema`) live in
 * `@cleocode/core` (`packages/core/src/dispatch/contracts/ensures-schema.ts`,
 * ST-1b) because a `Map.get` helper is a net-new runtime function that the
 * contracts-purity gate forbids in this leaf package.
 *
 * ## Message parity (behavior preservation)
 *
 * The Zod schemas are crafted so that — for every input the deleted bespoke
 * validators rejected — the FIRST Zod issue message equals the SUFFIX of the
 * original human-readable violation string (the part after the
 * `ensures.schema[<name>] on <nodeId>: ` prefix). ST-2's runtime wrapper
 * re-applies that prefix, so the end-to-end violation strings are unchanged. The
 * ST-1 parity test asserts on these issue messages directly.
 *
 * ## Genkit-forward naming
 *
 * The registry surface is deliberately Genkit-shaped so a future Genkit
 * `ai.defineSchema(name, zodSchema)` bridge (T11768) is a thin adapter over this
 * SSoT, never a competing source.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/operations/ensures-schema-registry
 *
 * @epic T11762 — E-OUTPUT-SCHEMA-ENFORCEMENT
 * @task T11900 — ST-1: ensures-schema Zod registry DATA + schemas
 * @see validateDecompositionTaskTree — the ported bespoke task_tree validator
 * @see validateIvtrEvidenceOutput — the ported bespoke evidence validator
 */

import { type ZodType, z } from 'zod';

/**
 * One registered `ensures.schema` entry: the Zod validator plus which playbook
 * `context` key holds the value to validate.
 *
 * @public
 */
export interface EnsuresSchemaSpec {
  /**
   * The schema NAME used in `ensures.schema:` (e.g. `'task_tree'`, `'evidence'`).
   */
  readonly name: string;
  /**
   * The playbook `context` key whose value is validated. Defaults to {@link name}
   * (matching today's `context['task_tree']` / `context['evidence']` convention).
   */
  readonly contextKey: string;
  /**
   * The Zod validator applied to `context[contextKey]`.
   */
  readonly schema: ZodType;
}

// ─── task_tree — ports validateDecompositionTaskTree (runtime.ts:794-855) ──────

/**
 * Zod schema for a single `task_tree` entry.
 *
 * Parity rules ported from `validateDecompositionTaskTree`:
 *  - `title` must be a non-empty string (after trim).
 *  - `acceptance` must be a non-empty array containing at least one non-empty
 *    (after-trim) string.
 *  - `id` / `parentId` / `depends` are optional and not hard-validated (the
 *    bespoke validator was intentionally lenient on these).
 *
 * @remarks
 * The `title` check is split so the message echoes the bespoke
 * `entry[i].title must be a non-empty string` regardless of whether the field is
 * absent, the wrong type, or whitespace-only.
 */
export const taskTreeEntrySchema: ZodType = z.object({
  title: z
    .string({ message: 'title must be a non-empty string' })
    .refine((s) => s.trim().length > 0, { message: 'title must be a non-empty string' }),
  acceptance: z
    .array(z.unknown(), { message: 'must have a non-empty acceptance array' })
    .min(1, { message: 'must have a non-empty acceptance array' })
    .refine((arr) => arr.some((s) => typeof s === 'string' && s.trim().length > 0), {
      message: 'acceptance array contains no non-empty strings',
    }),
  id: z.string().optional(),
  parentId: z.string().optional(),
  depends: z.array(z.string()).optional(),
});

/**
 * Zod schema for the `task_tree` context value emitted by a RCASD decomposition
 * node — a non-empty array of {@link taskTreeEntrySchema} entries.
 *
 * Parity: an empty array is rejected with `task_tree is an empty array …`; a
 * non-array is rejected by Zod's base array type error.
 *
 * @public
 */
export const taskTreeSchema: ZodType = z
  .array(taskTreeEntrySchema, { message: 'task_tree must be a non-empty array' })
  .min(1, { message: 'task_tree is an empty array — decomposition produced no tasks' });

// ─── evidence — ports validateIvtrEvidenceOutput (runtime.ts:873-902) ──────────

/**
 * Zod schema for the `evidence` context value emitted by an IVTR validation
 * node.
 *
 * Parity rules ported from `validateIvtrEvidenceOutput`. Valid evidence is one
 * of:
 *  - a non-empty (after-trim) string,
 *  - a non-empty array,
 *  - an object with at least one key.
 *
 * `null` / `undefined`, the empty string, the empty array, the empty object, and
 * any other primitive (number, boolean) are rejected — matching the bespoke
 * validator exactly.
 *
 * @remarks
 * A `z.union` of the three valid shapes would reject the SAME set of inputs, but
 * collapses every rejection to a generic `"Invalid input"` union error. To
 * preserve the bespoke validator's branch-specific messages (`evidence must be
 * present …`, `evidence string must not be empty`, `evidence array must not be
 * empty`, `evidence object must have at least one key (got {})`, `evidence must
 * be a string, array, or object (got <type>)`), this schema replicates the
 * original branch order in a single `superRefine`. The `superRefine` callback is
 * an inline argument — NOT an exported bodied function/arrow — so it does not
 * trip the Gate-10 contracts-purity lint.
 *
 * @public
 */
export const evidenceSchema: ZodType = z.unknown().superRefine((value, ctx) => {
  if (value === null || value === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'evidence must be present (non-null, non-undefined)',
    });
    return;
  }
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: 'evidence string must not be empty' });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'evidence array must not be empty' });
    }
    return;
  }
  if (typeof value === 'object') {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'evidence object must have at least one key (got {})',
      });
    }
    return;
  }
  // Numbers, booleans, symbols, bigints, functions — not valid evidence shapes.
  ctx.addIssue({
    code: 'custom',
    message: `evidence must be a string, array, or object (got ${typeof value})`,
  });
});

/**
 * The ensures-schema registry DATA — a `ReadonlyMap` from `ensures.schema` name
 * to its {@link EnsuresSchemaSpec}.
 *
 * This is a VALUE (data), not a bodied function, so it is Gate-10-safe in the
 * `@cleocode/contracts` leaf package. The bodied accessor layer in
 * `@cleocode/core` (ST-1b) reads this map.
 *
 * @public
 */
export const ENSURES_SCHEMA_REGISTRY: ReadonlyMap<string, EnsuresSchemaSpec> = new Map<
  string,
  EnsuresSchemaSpec
>([
  ['task_tree', { name: 'task_tree', contextKey: 'task_tree', schema: taskTreeSchema }],
  ['evidence', { name: 'evidence', contextKey: 'evidence', schema: evidenceSchema }],
]);
