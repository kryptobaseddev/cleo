/**
 * CLI field extraction context.
 *
 * Singleton that holds the resolved field extraction options for the current
 * CLI invocation. Set once in the Commander.js preAction hook; read by
 * dispatchFromCli() to apply field filtering and MVI control universally
 * across all commands.
 *
 * Delegates to @cleocode/lafs-protocol v1.5.0 resolveFieldExtraction()
 * for canonical conflict detection, flag parsing, and type resolution.
 * Mirrors the format-context.ts pattern for --json/--human/--quiet.
 *
 * @epic T4953
 * @task T4979
 */

import {
  resolveFieldExtraction,
  type FieldExtractionInput,
  type FieldExtractionResolution,
} from '@cleocode/lafs-protocol';

export type { FieldExtractionResolution as FieldContext };

let currentContext: FieldExtractionResolution = {
  mvi: 'standard',
  mviSource: 'default',
  expectsCustomMvi: false,
};

/**
 * Set the field extraction context for this CLI invocation.
 * Called once from the preAction hook in src/cli/index.ts.
 */
export function setFieldContext(ctx: FieldExtractionResolution): void {
  currentContext = ctx;
}

/**
 * Get the current field extraction context.
 */
export function getFieldContext(): FieldExtractionResolution {
  return currentContext;
}

/**
 * Parse global field options from Commander.js parsed opts and resolve via
 * the canonical LAFS SDK resolver (conflict detection, type narrowing).
 */
export function resolveFieldContext(opts: Record<string, unknown>): FieldExtractionResolution {
  const input: FieldExtractionInput = {
    fieldFlag: typeof opts['field'] === 'string' ? opts['field'] : undefined,
    fieldsFlag: typeof opts['fields'] === 'string' ? opts['fields'] : undefined,
    mviFlag: typeof opts['mvi'] === 'string' ? opts['mvi'] : undefined,
  };
  return resolveFieldExtraction(input);
}
