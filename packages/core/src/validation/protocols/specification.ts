/**
 * Specification protocol — thin wrapper delegating to the canonical pure validator.
 *
 * @task T4537
 * @task T260
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  type ProtocolValidationResult,
  validateSpecificationProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

/** Validate specification protocol for a task. */
export async function validateSpecificationTask(
  taskId: string,
  opts: { strict?: boolean; specFile?: string },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const specContent =
    opts.specFile && existsSync(opts.specFile) ? readFileSync(opts.specFile, 'utf-8') : undefined;
  const result = validateSpecificationProtocol(entry, specContent);
  throwIfStrictFailed(result, opts, 'specification', taskId);
  return result;
}

/** Validate specification protocol from a manifest file. */
export async function checkSpecificationManifest(
  manifestFile: string,
  opts: { strict?: boolean; specFile?: string },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const specContent =
    opts.specFile && existsSync(opts.specFile) ? readFileSync(opts.specFile, 'utf-8') : undefined;
  const result = validateSpecificationProtocol(entry, specContent);
  throwIfStrictFailed(result, opts, 'specification', taskId);
  return result;
}
