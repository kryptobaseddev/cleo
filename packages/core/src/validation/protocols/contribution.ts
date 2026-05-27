/**
 * Contribution protocol — thin wrapper delegating to the canonical pure validator.
 *
 * Contribution is a cross-cutting protocol that tracks multi-agent attribution
 * at the implementation stage (see default-chain.ts DEFAULT_PROTOCOL_STAGE_MAP).
 *
 * @task T4537
 * @task T260
 */

import {
  type ProtocolValidationResult,
  validateContributionProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

/** Validate contribution protocol for a task. */
export async function validateContributionTask(
  taskId: string,
  opts: { strict?: boolean; hasContributionTags?: boolean },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const result = validateContributionProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'contribution', taskId);
  return result;
}

/** Validate contribution protocol from a manifest file. */
export async function checkContributionManifest(
  manifestFile: string,
  opts: { strict?: boolean; hasContributionTags?: boolean },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateContributionProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'contribution', taskId);
  return result;
}
