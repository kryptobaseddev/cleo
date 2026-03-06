/**
 * Pipeline Phase Operations
 *
 * Core functions for phase management used by dispatch layer.
 * Thin wrappers around src/core/phases for dispatch compatibility.
 *
 * @task T5326
 * @epic T5323
 */

import {
  listPhases as coreListPhases,
  showPhase as coreShowPhase,
  type ListPhasesResult,
  type ShowPhaseResult,
} from '../phases/index.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/**
 * List all phases with status summaries.
 * @task T5326
 */
export async function listPhases(
  projectRoot: string,
  accessor?: DataAccessor,
): Promise<{ success: boolean; data?: ListPhasesResult; error?: { code: string; message: string } }> {
  try {
    const result = await coreListPhases(projectRoot, accessor);
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'E_PHASE_LIST_FAILED', message },
    };
  }
}

/**
 * Show phase details by slug or current phase.
 * @task T5326
 */
export async function showPhase(
  projectRoot: string,
  phaseId?: string,
  accessor?: DataAccessor,
): Promise<{ success: boolean; data?: ShowPhaseResult; error?: { code: string; message: string } }> {
  try {
    const result = await coreShowPhase(phaseId, projectRoot, accessor);
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'E_PHASE_SHOW_FAILED', message },
    };
  }
}
