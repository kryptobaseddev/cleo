/**
 * File Change Hook Handlers - Wave 2 of T5237
 *
 * Captures file change events to BRAIN via memory.observe.
 * Includes 5-second dedup to avoid noisy rapid writes.
 * Auto-registers on module load.
 */

import { relative, isAbsolute } from 'node:path';
import { hooks } from '../registry.js';
import type { OnFileChangePayload } from '../types.js';

function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

/** 5-second dedup map: filePath -> last dispatch timestamp */
const recentWrites = new Map<string, number>();
const DEDUP_INTERVAL_MS = 5_000;

/**
 * Handle onFileChange - capture file changes to BRAIN
 *
 * Deduplicates rapid writes to the same file within a 5-second window.
 * Converts absolute paths to project-relative paths.
 */
export async function handleFileChange(
  projectRoot: string,
  payload: OnFileChangePayload,
): Promise<void> {
  // 5-second dedup
  const now = Date.now();
  const lastWrite = recentWrites.get(payload.filePath);
  if (lastWrite && now - lastWrite < DEDUP_INTERVAL_MS) return;
  recentWrites.set(payload.filePath, now);

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  // Convert absolute paths to relative, normalize to forward slashes
  const relativePath = (isAbsolute(payload.filePath)
    ? relative(projectRoot, payload.filePath)
    : payload.filePath).replaceAll('\\', '/');

  try {
    await observeBrain(projectRoot, {
      text: `File ${payload.changeType}: ${relativePath}${payload.sizeBytes != null ? ` (${payload.sizeBytes} bytes)` : ''}`,
      title: `File changed: ${relativePath}`,
      type: 'change',
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

// Register handler on module load
hooks.register({
  id: 'brain-file-change',
  event: 'onFileChange',
  handler: handleFileChange,
  priority: 100,
});
