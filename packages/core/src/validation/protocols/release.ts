/**
 * Release protocol — thin wrapper delegating to the canonical pure validator.
 *
 * Renamed from release-protocol.ts in T260. The release protocol orchestrates
 * version bumping, changelog generation, tagging, and pushing. It composes
 * with artifact-publish and provenance at the release stage (see release.md
 * Pipeline Integration + release-engine.ts releaseShip()).
 *
 * @task T4804
 * @task T260 — drop -protocol suffix, delegate to orchestration validator
 */

import {
  type ProtocolValidationResult,
  validateReleaseProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

/** Validate release protocol for a task. */
export async function validateReleaseTask(
  taskId: string,
  opts: { strict?: boolean; version?: string; hasChangelog?: boolean },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const result = validateReleaseProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'release', taskId);
  return result;
}

/** Validate release protocol from a manifest file. */
export async function checkReleaseManifest(
  manifestFile: string,
  opts: { strict?: boolean; version?: string; hasChangelog?: boolean },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateReleaseProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'release', taskId);
  return result;
}
