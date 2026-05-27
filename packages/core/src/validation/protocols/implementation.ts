/**
 * Implementation protocol — thin wrapper delegating to the canonical pure validator.
 *
 * @task T4537
 * @task T260
 */

import {
  type ProtocolValidationResult,
  validateImplementationProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

/** Validate implementation protocol for a task. */
export async function validateImplementationTask(
  taskId: string,
  opts: { strict?: boolean; hasTaskTags?: boolean },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const result = validateImplementationProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'implementation', taskId);
  return result;
}

/** Validate implementation protocol from a manifest file. */
export async function checkImplementationManifest(
  manifestFile: string,
  opts: { strict?: boolean; hasTaskTags?: boolean },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateImplementationProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'implementation', taskId);
  return result;
}
