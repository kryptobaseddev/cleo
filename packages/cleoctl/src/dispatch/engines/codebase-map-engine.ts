/**
 * Codebase Map Engine
 *
 * Thin wrapper around core codebase-map module for dispatch layer.
 *
 * @epic cognitive-cleo
 */

import { type EngineResult, engineError } from './_error.js';

/**
 * Analyze a codebase and return structured mapping.
 * When storeToBrain is true, findings are persisted to brain.db.
 */
export async function mapCodebase(
  projectRoot: string,
  options?: {
    focus?: string;
    storeToBrain?: boolean;
  },
): Promise<EngineResult> {
  try {
    const { mapCodebase: coreMapCodebase } = await import('@cleocode/core');

    const result = await coreMapCodebase(projectRoot, {
      focus: options?.focus as
        | 'stack'
        | 'architecture'
        | 'structure'
        | 'conventions'
        | 'testing'
        | 'integrations'
        | 'concerns'
        | undefined,
      storeToBrain: options?.storeToBrain,
    });

    return {
      success: true,
      data: result,
    };
  } catch (err) {
    return engineError('E_GENERAL', err instanceof Error ? err.message : String(err));
  }
}
