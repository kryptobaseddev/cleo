/**
 * Decomposition protocol — thin wrapper delegating to the canonical pure validator.
 *
 * The canonical validator enforces DCOMP-001 (max siblings), DCOMP-002 (clarity),
 * DCOMP-007 (`agent_type: decomposition`). The old validator here checked for
 * `agent_type: specification` which was a copy-paste bug from specification.ts.
 *
 * @task T4537
 * @task T260 — delegate to orchestration/protocol-validators, fix agent_type
 */

import {
  type ProtocolValidationResult,
  validateDecompositionProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

interface DecompositionOpts {
  strict?: boolean;
  epicId?: string;
  siblingCount?: number;
  descriptionClarity?: boolean;
  maxSiblings?: number;
  maxDepth?: number;
}

/** Validate decomposition protocol for a task. */
export async function validateDecompositionTask(
  taskId: string,
  opts: DecompositionOpts,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const result = validateDecompositionProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'decomposition', taskId);
  return result;
}

/** Validate decomposition protocol from a manifest file. */
export async function checkDecompositionManifest(
  manifestFile: string,
  opts: DecompositionOpts,
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const result = validateDecompositionProtocol(entry, opts);
  throwIfStrictFailed(result, opts, 'decomposition', taskId);
  return result;
}
