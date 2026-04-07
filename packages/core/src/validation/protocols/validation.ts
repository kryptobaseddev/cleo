/**
 * Validation protocol — thin wrapper delegating to the canonical pure validator.
 *
 * Renamed from validation-protocol.ts in T260. The validation stage runs
 * static analysis, type checking, and pre-test quality gates. It is the
 * first half of the IVT loop (Implement → Validate → Test); the validator
 * here only verifies that a validation run produced a proper manifest
 * entry — runtime gate enforcement is in the lifecycle state machine.
 *
 * @task T4804
 * @task T260 — drop -protocol suffix, delegate to orchestration validator
 */

import {
  type ProtocolValidationResult,
  type ValidationStageOptions,
  validateValidationProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

/** Validate validation-stage protocol for a task. */
export async function validateValidationTask(
  taskId: string,
  opts: { strict?: boolean } & ValidationStageOptions,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const result = validateValidationProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'validation', taskId);
  return result;
}

/** Validate validation-stage protocol from a manifest file. */
export async function checkValidationManifest(
  manifestFile: string,
  opts: { strict?: boolean } & ValidationStageOptions,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateValidationProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'validation', taskId);
  return result;
}
