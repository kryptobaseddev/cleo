/**
 * Research protocol — thin wrapper delegating to the canonical pure validator.
 *
 * @task T4804
 * @task T260
 */

import {
  type ProtocolValidationResult,
  validateResearchProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

/** Validate research protocol for a task. */
export async function validateResearchTask(
  taskId: string,
  opts: { strict?: boolean; hasCodeChanges?: boolean },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const result = validateResearchProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'research', taskId);
  return result;
}

/** Validate research protocol from a manifest file. */
export async function checkResearchManifest(
  manifestFile: string,
  opts: { strict?: boolean; hasCodeChanges?: boolean },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateResearchProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'research', taskId);
  return result;
}
