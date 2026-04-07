/**
 * Consensus protocol — thin wrapper delegating to the canonical pure validator.
 *
 * The actual rules live in `../../orchestration/protocol-validators.ts`. This
 * file exists so the CLI / dispatch layer can validate a task by ID (loading
 * the manifest entry) without duplicating logic.
 *
 * @task T4537
 * @task T260
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  type ProtocolValidationResult,
  type VotingMatrix,
  validateConsensusProtocol,
} from '../../orchestration/protocol-validators.js';
import {
  loadManifestEntryByTaskId,
  loadManifestEntryFromFile,
  throwIfStrictFailed,
} from './_shared.js';

function loadVotingMatrix(votingMatrixFile: string | undefined): VotingMatrix {
  if (!votingMatrixFile || !existsSync(votingMatrixFile)) return { options: [] };
  const raw = JSON.parse(readFileSync(votingMatrixFile, 'utf-8')) as Partial<VotingMatrix> & {
    options?: unknown;
  };
  const options = Array.isArray(raw.options) ? raw.options : Object.values(raw.options ?? {});
  return {
    options: options.filter(
      (o): o is { name: string; confidence: number; rationale?: string } =>
        typeof o === 'object' && o !== null && 'name' in o && 'confidence' in o,
    ),
    threshold: raw.threshold,
  };
}

/** Validate consensus protocol for a task. */
export async function validateConsensusTask(
  taskId: string,
  opts: { strict?: boolean; votingMatrixFile?: string },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryByTaskId(taskId);
  const matrix = loadVotingMatrix(opts.votingMatrixFile);
  const result = validateConsensusProtocol(entry, matrix);
  throwIfStrictFailed(result, opts, 'consensus', taskId);
  return result;
}

/** Validate consensus protocol from a manifest file. */
export async function checkConsensusManifest(
  manifestFile: string,
  opts: { strict?: boolean; votingMatrixFile?: string },
): Promise<ProtocolValidationResult> {
  const entry = loadManifestEntryFromFile(manifestFile);
  const taskId = entry.linked_tasks?.[0] ?? 'UNKNOWN';
  const matrix = loadVotingMatrix(opts.votingMatrixFile);
  const result = validateConsensusProtocol(entry, matrix);
  throwIfStrictFailed(result, opts, 'consensus', taskId);
  return result;
}
