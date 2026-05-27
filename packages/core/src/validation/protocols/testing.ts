/**
 * Testing protocol — thin wrapper delegating to the canonical pure validator.
 *
 * Renamed from testing-protocol.ts in T260. The testing protocol is the
 * project-agnostic IVT loop closure stage: it checks that a detected test
 * framework ran, achieved 100% pass rate, and the Implement→Validate→Test
 * loop converged on the specification. Framework detection and loop logic
 * live in the `ct-ivt-looper` skill; this validator only certifies results.
 *
 * @task T4804
 * @task T260 — drop -protocol suffix, delegate, project-agnostic IVT
 */

import {
  type ProtocolValidationResult,
  type TestingOptions,
  validateTestingProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

/** Validate testing protocol for a task. */
export async function validateTestingTask(
  taskId: string,
  opts: { strict?: boolean } & TestingOptions,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const result = validateTestingProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'testing', taskId);
  return result;
}

/** Validate testing protocol from a manifest file. */
export async function checkTestingManifest(
  manifestFile: string,
  opts: { strict?: boolean } & TestingOptions,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateTestingProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'testing', taskId);
  return result;
}
