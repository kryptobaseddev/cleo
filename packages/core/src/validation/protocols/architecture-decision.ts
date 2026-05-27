/**
 * Architecture Decision Record protocol — thin wrapper delegating to the
 * canonical pure validator.
 *
 * This file fills a long-standing gap: every other CLEO pipeline stage had
 * a TS validator, but the architecture_decision stage (added when RCSD was
 * renamed to RCASD) never got one. The ADR markdown spec at
 * `protocols-markdown/architecture-decision.md` defines ADR-001..008 MUST
 * requirements — all enforced by the pure validator in
 * `../../orchestration/protocol-validators.ts`.
 *
 * @task T260 — create the missing ADR protocol validator
 */

import {
  type ArchitectureDecisionOptions,
  type ManifestEntryInput,
  type ProtocolValidationResult,
  validateArchitectureDecisionProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

/** Validate architecture-decision protocol for a task. */
export async function validateArchitectureDecisionTask(
  taskId: string,
  opts: { strict?: boolean } & ArchitectureDecisionOptions,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId) as ManifestEntryInput & {
    consensus_manifest_id?: string;
  };
  const result = validateArchitectureDecisionProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'architecture-decision', taskId);
  return result;
}

/** Validate architecture-decision protocol from a manifest file. */
export async function checkArchitectureDecisionManifest(
  manifestFile: string,
  opts: { strict?: boolean } & ArchitectureDecisionOptions,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile) as ManifestEntryInput & {
    consensus_manifest_id?: string;
  };
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateArchitectureDecisionProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'architecture-decision', taskId);
  return result;
}
