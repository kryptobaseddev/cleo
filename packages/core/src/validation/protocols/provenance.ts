/**
 * Provenance protocol — thin wrapper delegating to the canonical pure validator.
 *
 * Provenance is a cross-cutting protocol that composes with release via
 * artifact-publish: artifact-publish delegates signing, SBOM generation, and
 * in-toto attestation chain assembly to provenance (see provenance.md Pipeline
 * Integration and release-engine.ts releaseShip()). The CI pipeline already
 * uses `npm publish --provenance` for SLSA L3 keyless attestation via OIDC.
 *
 * @task T260 — create the missing provenance protocol wrapper
 */

import {
  type ProtocolValidationResult,
  validateProvenanceProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

interface ProvenanceOpts {
  strict?: boolean;
  hasAttestation?: boolean;
  hasSbom?: boolean;
}

/** Validate provenance protocol for a task. */
export async function validateProvenanceTask(
  taskId: string,
  opts: ProvenanceOpts,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const result = validateProvenanceProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'provenance', taskId);
  return result;
}

/** Validate provenance protocol from a manifest file. */
export async function checkProvenanceManifest(
  manifestFile: string,
  opts: ProvenanceOpts,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateProvenanceProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'provenance', taskId);
  return result;
}
