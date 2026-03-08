/**
 * Pipeline Engine
 *
 * Handles pipeline phase management and other pipeline-specific operations.
 * Delegates to src/core/phases/index.ts.
 *
 * @task T5676
 * @epic T5517
 */

import { getAccessor } from '../../store/data-accessor.js';
import {
  listPhases as coreListPhases,
  showPhase as coreShowPhase,
  setPhase as coreSetPhase,
  startPhase as coreStartPhase,
  completePhase as coreCompletePhase,
  advancePhase as coreAdvancePhase,
  renamePhase as coreRenamePhase,
  deletePhase as coreDeletePhase,
} from '../../core/phases/index.js';
import { engineError, type EngineResult } from './_error.js';

// ============================================================================
// Phase Operations
// ============================================================================

/**
 * phase.list - List all project phases
 */
export async function phaseList(
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreListPhases(undefined, accessor);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    return engineError('E_PHASE_LIST', message);
  }
}

/**
 * phase.show - Show details of a specific phase
 */
export async function phaseShow(
  phaseId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreShowPhase(phaseId, undefined, accessor);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found') || message.includes('does not exist')
      ? 'E_NOT_FOUND'
      : 'E_PHASE_SHOW';
    return engineError(code, message);
  }
}

/**
 * phase.set - Set the current phase
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
    const data = await coreSetPhase({
      slug: params.phaseId,
      rollback: params.rollback,
      force: params.force,
      dryRun: params.dryRun,
    }, undefined, accessor);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_SET';
    if (message.includes('not found') || message.includes('does not exist')) code = 'E_NOT_FOUND';
    else if (message.includes('requires')) code = 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * phase.start - Start a pending phase
 */
export async function phaseStart(
  phaseId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!phaseId) {
    return engineError('E_INVALID_INPUT', 'phaseId is required');
  }

  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreStartPhase(phaseId, undefined, accessor);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_START';
    if (message.includes('not found') || message.includes('does not exist')) code = 'E_NOT_FOUND';
    else if (message.includes('Can only start')) code = 'E_INVALID_STATE';
    return engineError(code, message);
  }
}

/**
 * phase.complete - Complete an active phase
 */
export async function phaseComplete(
  phaseId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!phaseId) {
    return engineError('E_INVALID_INPUT', 'phaseId is required');
  }

  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreCompletePhase(phaseId, undefined, accessor);
    return { success: true, data };
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
 * phase.advance - Advance to the next phase
 */
export async function phaseAdvance(
  force: boolean = false,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const accessor = await getAccessor(projectRoot);
    const data = await coreAdvancePhase(force, undefined, accessor);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_ADVANCE';
    if (message.includes('not found') || message.includes('No more phases')) code = 'E_NOT_FOUND';
    else if (message.includes('Cannot advance')) code = 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * phase.rename - Rename a phase
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
    return { success: true, data };
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
 * phase.delete - Delete a phase
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
    const data = await coreDeletePhase(phaseId, {
      reassignTo: params.reassignTo,
      force: params.force,
    }, undefined, accessor);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_PHASE_DELETE';
    if (message.includes('does not exist')) code = 'E_NOT_FOUND';
    else if (message.includes('Cannot delete')) code = 'E_VALIDATION_ERROR';
    else if (message.includes('requires --force')) code = 'E_INVALID_INPUT';
    return engineError(code, message);
  }
}
