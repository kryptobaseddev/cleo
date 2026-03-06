/**
 * Admin Sync Operations
 *
 * Core functions for sync state management used by dispatch layer.
 *
 * @task T5326
 * @epic T5323
 */

import { join } from 'node:path';
import { rm, rmdir, stat } from 'node:fs/promises';
import { readJson } from '../../store/json.js';
import { getCleoDir } from '../paths.js';

/** Sync session state stored in .cleo/sync/todowrite-session.json. */
interface SyncSessionState {
  session_id: string;
  injected_at: string;
  injectedPhase?: string;
  injected_tasks: string[];
  task_metadata?: Record<string, { phase?: string }>;
}

/** Result for sync status operation. */
export interface SyncStatusResult {
  active: boolean;
  sessionId?: string;
  injectedAt?: string;
  injectedPhase?: string;
  taskCount?: number;
  taskIds?: string[];
  phases?: Array<{ phase: string; count: number }>;
  stateFile: string;
}

/** Result for sync clear operation. */
export interface SyncClearResult {
  cleared?: { stateFile: string };
  dryRun?: boolean;
  wouldDelete?: { stateFile: string; syncDirectory: string };
  noChange?: boolean;
}

/**
 * Get current sync status.
 * @task T5326
 */
export async function getSyncStatus(
  projectRoot: string,
): Promise<{ success: boolean; data?: SyncStatusResult; error?: { code: string; message: string } }> {
  try {
    const cleoDir = getCleoDir(projectRoot);
    const stateFile = join(cleoDir, 'sync', 'todowrite-session.json');
    const sessionState = await readJson<SyncSessionState>(stateFile);

    if (!sessionState) {
      return {
        success: true,
        data: {
          active: false,
          stateFile,
        },
      };
    }

    // Build phase distribution from metadata
    let phases: Array<{ phase: string; count: number }> | undefined;
    if (sessionState.task_metadata) {
      const phaseMap = new Map<string, number>();
      for (const meta of Object.values(sessionState.task_metadata)) {
        const phase = meta.phase ?? 'unknown';
        phaseMap.set(phase, (phaseMap.get(phase) ?? 0) + 1);
      }
      phases = [...phaseMap.entries()].map(([phase, count]) => ({ phase, count }));
    }

    return {
      success: true,
      data: {
        active: true,
        sessionId: sessionState.session_id,
        injectedAt: sessionState.injected_at,
        injectedPhase: sessionState.injectedPhase ?? 'none',
        taskCount: sessionState.injected_tasks.length,
        taskIds: sessionState.injected_tasks,
        phases,
        stateFile,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'E_SYNC_STATUS_FAILED', message },
    };
  }
}

/**
 * Clear sync state.
 * @task T5326
 */
export async function clearSyncState(
  projectRoot: string,
  dryRun?: boolean,
): Promise<{ success: boolean; data?: SyncClearResult; error?: { code: string; message: string } }> {
  try {
    const cleoDir = getCleoDir(projectRoot);
    const syncDir = join(cleoDir, 'sync');
    const stateFile = join(syncDir, 'todowrite-session.json');

    let exists = false;
    try {
      await stat(stateFile);
      exists = true;
    } catch {
      // File doesn't exist
    }

    if (!exists) {
      return {
        success: true,
        data: { noChange: true },
      };
    }

    if (dryRun) {
      return {
        success: true,
        data: {
          dryRun: true,
          wouldDelete: { stateFile, syncDirectory: syncDir },
        },
      };
    }

    await rm(stateFile, { force: true });
    // Clean up empty sync directory
    try {
      await rmdir(syncDir);
    } catch {
      // not empty or doesn't exist
    }

    return {
      success: true,
      data: {
        cleared: { stateFile },
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'E_SYNC_CLEAR_FAILED', message },
    };
  }
}
