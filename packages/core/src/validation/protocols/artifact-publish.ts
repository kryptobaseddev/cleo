/**
 * Artifact Publish protocol — thin wrapper delegating to the canonical pure validator.
 *
 * Artifact-publish is a cross-cutting protocol that composes with release:
 * release triggers artifact-publish for the distribution phase (see release.md
 * Pipeline Integration and release-engine.ts releaseShip()). Not every release
 * needs artifact-publish — source-only releases can skip it.
 *
 * @task T260 — create the missing artifact-publish protocol wrapper
 */

import {
  type ProtocolValidationResult,
  validateArtifactPublishProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

interface ArtifactPublishOpts {
  strict?: boolean;
  artifactType?: string;
  buildPassed?: boolean;
}

/** Validate artifact-publish protocol for a task. */
export async function validateArtifactPublishTask(
  taskId: string,
  opts: ArtifactPublishOpts,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const result = validateArtifactPublishProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'artifact-publish', taskId);
  return result;
}

/** Validate artifact-publish protocol from a manifest file. */
export async function checkArtifactPublishManifest(
  manifestFile: string,
  opts: ArtifactPublishOpts,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateArtifactPublishProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'artifact-publish', taskId);
  return result;
}
