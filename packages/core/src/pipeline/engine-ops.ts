/**
 * Pipeline Engine Operations — EngineResult wrapper layer.
 *
 * Contains all phase domain EngineResult wrappers migrated from
 * `packages/cleo/src/dispatch/engines/pipeline-engine.ts` (ENG-MIG-11 / T1578).
 *
 * Each exported function wraps a core phases primitive with EngineResult
 * (ADR-057 D1 uniform `(projectRoot, params)` signature where applicable).
 *
 * Importable from `@cleocode/core/internal` so the CLI dispatch layer can
 * call them without any intermediate engine file.
 *
 * @module pipeline/engine-ops
 * @task T1578 — ENG-MIG-11
 * @epic T1566
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import {
  advancePhase as coreAdvancePhase,
  completePhase as coreCompletePhase,
  deletePhase as coreDeletePhase,
  listPhases as coreListPhases,
  renamePhase as coreRenamePhase,
  setPhase as coreSetPhase,
  showPhase as coreShowPhase,
  startPhase as coreStartPhase,
} from '../phases/index.js';
import { getAccessor } from '../store/data-accessor.js';

// ============================================================================
// Phase Operations
// ============================================================================

/**
 * List all project phases with status summaries.
 *
 * @param projectRoot - Absolute project root path
 * @returns EngineResult with phase list and summary
 * @task T1578
 */
export async function phaseList(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = projectRoot ?? process.cwd();
    const accessor = await getAccessor(root);
    const data = await coreListPhases(root, accessor);
    return engineSuccess(data);
  } catch (err: unknown) {
    return engineError('E_PHASE_LIST', (err as Error).message);
  }
}

/**
 * Show details of a specific phase by slug, or the current phase if omitted.
 *
 * @param phaseId - Phase slug (optional; defaults to current phase)
 * @param projectRoot - Absolute project root path
 * @returns EngineResult with phase details
 * @task T1578
 */
export async function phaseShow(phaseId?: string, projectRoot?: string): Promise<EngineResult> {
  try {
    const root = projectRoot ?? process.cwd();
    const accessor = await getAccessor(root);
    const data = await coreShowPhase(phaseId, root, accessor);
    return engineSuccess(data);
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code =
      message.includes('not found') || message.includes('does not exist')
        ? 'E_NOT_FOUND'
        : 'E_PHASE_SHOW';
    return engineError(code, message);
  }
}

/**
 * Set the current phase, with optional rollback or dry-run support.
 *
 * @param params - Phase set parameters
 * @param params.phaseId - Target phase slug (required)
 * @param params.rollback - Allow rolling back to an earlier phase
 * @param params.force - Force the operation (required for rollback)
 * @param params.dryRun - Preview the operation without committing
 * @param projectRoot - Absolute project root path
 * @returns EngineResult with set operation result
 * @task T1578
 */
export async function phaseSet(
  params: {
    phaseId: string;
    rollback?: boolean;
    force?: boolean;
    dryRun?: boolean;
  },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.phaseId) {
    return engineError('E_INVALID_INPUT', 'phaseId is required');
  }

  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreSetPhase(
      {
        slug: params.phaseId,
        rollback: params.rollback,
        force: params.force,
        dryRun: params.dryRun,
      },
      undefined,
      accessor,
    );
    return engineSuccess(data);
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_SET';
    if (message.includes('not found') || message.includes('does not exist')) code = 'E_NOT_FOUND';
    else if (message.includes('requires')) code = 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * Start a pending phase (transitions it to active).
 *
 * @param phaseId - Phase slug to start (required)
 * @param projectRoot - Absolute project root path
 * @returns EngineResult with start timestamp
 * @task T1578
 */
export async function phaseStart(phaseId: string, projectRoot?: string): Promise<EngineResult> {
  if (!phaseId) {
    return engineError('E_INVALID_INPUT', 'phaseId is required');
  }

  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreStartPhase(phaseId, undefined, accessor);
    return engineSuccess(data);
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_START';
    if (message.includes('not found') || message.includes('does not exist')) code = 'E_NOT_FOUND';
    else if (message.includes('Can only start')) code = 'E_INVALID_STATE';
    return engineError(code, message);
  }
}

/**
 * Complete an active phase (transitions it to completed).
 *
 * @param phaseId - Phase slug to complete (required)
 * @param projectRoot - Absolute project root path
 * @returns EngineResult with completion timestamp
 * @task T1578
 */
export async function phaseComplete(phaseId: string, projectRoot?: string): Promise<EngineResult> {
  if (!phaseId) {
    return engineError('E_INVALID_INPUT', 'phaseId is required');
  }

  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreCompletePhase(phaseId, undefined, accessor);
    return engineSuccess(data);
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_COMPLETE';
    if (message.includes('not found') || message.includes('does not exist')) code = 'E_NOT_FOUND';
    else if (message.includes('Can only complete')) code = 'E_INVALID_STATE';
    else if (message.includes('incomplete task')) code = 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * Advance the project to the next phase in sequence.
 *
 * @param force - Skip completion threshold check (default: false)
 * @param projectRoot - Absolute project root path
 * @returns EngineResult with advance result including previous and next phase slugs
 * @task T1578
 */
export async function phaseAdvance(
  force: boolean = false,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreAdvancePhase(force, undefined, accessor);
    return engineSuccess(data);
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_ADVANCE';
    if (message.includes('not found') || message.includes('No more phases')) code = 'E_NOT_FOUND';
    else if (message.includes('Cannot advance')) code = 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * Rename a phase and update all task references.
 *
 * @param oldName - Current phase slug (required)
 * @param newName - New phase slug (required; must match `^[a-z][a-z0-9-]*$`)
 * @param projectRoot - Absolute project root path
 * @returns EngineResult with rename result including tasks updated count
 * @task T1578
 */
export async function phaseRename(
  oldName: string,
  newName: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!oldName || !newName) {
    return engineError('E_INVALID_INPUT', 'oldName and newName are required');
  }

  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreRenamePhase(oldName, newName, undefined, accessor);
    return engineSuccess(data);
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_RENAME';
    if (message.includes('does not exist')) code = 'E_NOT_FOUND';
    else if (message.includes('already exists')) code = 'E_ALREADY_EXISTS';
    else if (message.includes('Invalid phase name')) code = 'E_INVALID_INPUT';
    return engineError(code, message);
  }
}

/**
 * Delete a phase with optional task reassignment.
 *
 * @param phaseId - Phase slug to delete (required)
 * @param params - Delete options
 * @param params.reassignTo - Target phase slug for orphaned tasks
 * @param params.force - Required flag for safety
 * @param projectRoot - Absolute project root path
 * @returns EngineResult with delete result including tasks reassigned count
 * @task T1578
 */
export async function phaseDelete(
  phaseId: string,
  params: {
    reassignTo?: string;
    force?: boolean;
  } = {},
  projectRoot?: string,
): Promise<EngineResult> {
  if (!phaseId) {
    return engineError('E_INVALID_INPUT', 'phaseId is required');
  }

  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreDeletePhase(
      phaseId,
      { reassignTo: params.reassignTo, force: params.force },
      undefined,
      accessor,
    );
    return engineSuccess(data);
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_DELETE';
    if (message.includes('does not exist')) code = 'E_NOT_FOUND';
    else if (message.includes('Cannot delete')) code = 'E_VALIDATION_ERROR';
    else if (message.includes('requires --force')) code = 'E_INVALID_INPUT';
    return engineError(code, message);
  }
}
