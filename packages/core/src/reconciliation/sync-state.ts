/**
 * Sync state persistence for the reconciliation engine.
 *
 * Each provider gets its own session state file under `.cleo/sync/`.
 *
 * @task T5800
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { SyncSessionState } from '@cleocode/contracts';
import { getCleoDir } from '../paths.js';
import { atomicWriteJson } from '../store/atomic.js';
import { readJson } from '../store/json.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSyncDir(cwd?: string): string {
  return join(getCleoDir(cwd), 'sync');
}

function getStateFilePath(providerId: string, cwd?: string): string {
  return join(getSyncDir(cwd), `${providerId}-session.json`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read sync session state for a provider.
 * Returns null if no state file exists.
 */
export async function readSyncState(
  providerId: string,
  cwd?: string,
): Promise<SyncSessionState | null> {
  const filePath = getStateFilePath(providerId, cwd);
  try {
    return await readJson<SyncSessionState>(filePath);
  } catch {
    return null;
  }
}

/**
 * Write sync session state for a provider.
 */
export async function writeSyncState(
  providerId: string,
  state: SyncSessionState,
  cwd?: string,
): Promise<void> {
  const syncDir = getSyncDir(cwd);
  await mkdir(syncDir, { recursive: true });
  const filePath = getStateFilePath(providerId, cwd);
  await atomicWriteJson(filePath, state);
}

/**
 * Clear (delete) sync session state for a provider.
 */
export async function clearSyncState(providerId: string, cwd?: string): Promise<void> {
  const filePath = getStateFilePath(providerId, cwd);
  try {
    await rm(filePath);
  } catch {
    // File may not exist — that's fine.
  }
}
