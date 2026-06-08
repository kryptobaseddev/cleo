/**
 * Ensures-schema accessors — the bodied lookup layer over the cantbook
 * `ensures.schema` Zod registry (T11762 ST-1b · Lane A).
 *
 * ## Why this lives in `core` (not `contracts`)
 *
 * The Zod schemas, the {@link EnsuresSchemaSpec} type, and the registry DATA
 * ({@link ENSURES_SCHEMA_REGISTRY}) live in the `@cleocode/contracts` leaf
 * package (ST-1) because those are exactly the Gate-10
 * (`lint-no-runtime-in-contracts`)-ALLOWED kinds. A `Map.get` accessor, by
 * contrast, is a net-new bodied runtime helper — NOT a type guard, Zod schema,
 * or `as const` data — and so MUST NOT live in `contracts` (it would trip the
 * contracts-purity gate). It is housed here in `core`, mirroring the
 * `getOutputContract` / `getInputContract` precedent in this same directory.
 *
 * The playbook runtime (`packages/playbooks/src/runtime.ts`, ST-2) imports these
 * accessors from `@cleocode/core` (already a playbooks dependency) to resolve a
 * declared `ensures.schema` name → its Zod validator, replacing the historical
 * hardcoded `if (schema === 'task_tree') … else if (=== 'evidence')` block.
 *
 * Import-time side-effect-free: this module only constructs a mutable working
 * copy of the immutable contracts registry at module load. No I/O, no global
 * state mutation beyond the module-local `REGISTRY` map.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/contracts/ensures-schema
 *
 * @epic T11762 — E-OUTPUT-SCHEMA-ENFORCEMENT
 * @task T11901 — ST-1b: ensures-schema accessors in core
 * @see ENSURES_SCHEMA_REGISTRY — the contracts-resident registry DATA (ST-1)
 */

import { ENSURES_SCHEMA_REGISTRY, type EnsuresSchemaSpec } from '@cleocode/contracts';

export type { EnsuresSchemaSpec };

/**
 * Module-local mutable working copy of the immutable contracts registry.
 *
 * Seeded from {@link ENSURES_SCHEMA_REGISTRY} (a `ReadonlyMap`). A mutable copy
 * is held so {@link defineEnsuresSchema} can register additional specs at
 * runtime (e.g. a future Genkit `ai.defineSchema` bridge — T11768) without
 * mutating the shared frozen contracts data.
 */
const REGISTRY = new Map<string, EnsuresSchemaSpec>(ENSURES_SCHEMA_REGISTRY);

/**
 * Resolve a registered `ensures.schema` spec by its declared name.
 *
 * The playbook runtime calls this with a node's `ensures.schema` value; a
 * `null` result signals an UNKNOWN schema name, which the runtime treats as a
 * fail-closed contract violation (it no longer silently skips unknown names —
 * AC1/AC2).
 *
 * @param name - The `ensures.schema:` name declared in a `.cantbook`
 *   (e.g. `'task_tree'`, `'evidence'`).
 * @returns The matching {@link EnsuresSchemaSpec}, or `null` when no schema is
 *   registered under that name.
 *
 * @task T11901
 */
export function getEnsuresSchema(name: string): EnsuresSchemaSpec | null {
  return REGISTRY.get(name) ?? null;
}

/**
 * Enumerate every registered `ensures.schema` name.
 *
 * Used by the runtime's fail-closed path to list the valid schema set in the
 * violation message (so a `.cantbook` author sees which names are accepted),
 * and by the parity tests to assert the registered set.
 *
 * @returns A read-only array of all registered schema names.
 *
 * @task T11901
 */
export function listEnsuresSchemaNames(): readonly string[] {
  return [...REGISTRY.keys()];
}

/**
 * Register (or override) an `ensures.schema` spec by name.
 *
 * Genkit-shaped registration alias provided for a future Genkit
 * `ai.defineSchema(name, zodSchema)` bridge (T11768): that bridge re-registers
 * the SAME named Zod schemas as a thin adapter over this SSoT, never as a
 * competing source. Mutates only the module-local working {@link REGISTRY}, not
 * the immutable contracts data.
 *
 * @param spec - The {@link EnsuresSchemaSpec} to register; an existing entry with
 *   the same {@link EnsuresSchemaSpec.name | name} is replaced.
 *
 * @task T11901
 */
export function defineEnsuresSchema(spec: EnsuresSchemaSpec): void {
  REGISTRY.set(spec.name, spec);
}
