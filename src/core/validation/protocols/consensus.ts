/**
 * Consensus protocol validation.
 * @task T4537
 * @epic T4454
 */

import { readFileSync, existsSync } from 'node:fs';
import { CleoError } from '../../errors.js';
import { ExitCode } from '../../../types/exit-codes.js';

interface ValidationResult {
  valid: boolean;
  violations: Array<{ code: string; severity: string; message: string }>;
  score: number;
  protocol: string;
  taskId: string;
}

function findManifestEntry(taskId: string, manifestPath: string): string | null {
  if (!existsSync(manifestPath)) return null;
  const lines = readFileSync(manifestPath, 'utf-8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes(`"${taskId}"`)) return lines[i]!;
  }
  return null;
}

/** Validate consensus protocol for a task. */
export async function validateConsensusTask(
  taskId: string,
  opts: { strict?: boolean; votingMatrixFile?: string },
): Promise<ValidationResult> {
  const manifestPath = 'claudedocs/agent-outputs/MANIFEST.jsonl';
  const entry = findManifestEntry(taskId, manifestPath);
  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `No manifest entry found for task ${taskId}`);
  }

  const manifest = JSON.parse(entry);
  const violations: ValidationResult['violations'] = [];

  // CONS-007: agent_type check
  if (manifest.agent_type !== 'analysis') {
    violations.push({
      code: 'CONS-007',
      severity: 'high',
      message: `Expected agent_type "analysis", got "${manifest.agent_type}"`,
    });
  }

  // Load voting matrix if provided
  if (opts.votingMatrixFile && existsSync(opts.votingMatrixFile)) {
    const matrix = JSON.parse(readFileSync(opts.votingMatrixFile, 'utf-8'));
    const options = Object.keys(matrix.options ?? {});
    if (options.length < 2) {
      violations.push({
        code: 'CONS-001',
        severity: 'high',
        message: 'Voting matrix requires at least 2 options',
      });
    }
  }

  const score = violations.length === 0 ? 100 : Math.max(0, 100 - violations.length * 25);
  const result: ValidationResult = {
    valid: violations.length === 0,
    violations,
    score,
    protocol: 'consensus',
    taskId,
  };

  if (opts.strict && violations.length > 0) {
    throw new CleoError(61 as ExitCode, `Consensus protocol violations for ${taskId}`);
  }

  return result;
}

/** Validate consensus protocol from manifest file. */
export async function checkConsensusManifest(
  manifestFile: string,
  opts: { strict?: boolean; votingMatrixFile?: string },
): Promise<ValidationResult> {
  if (!existsSync(manifestFile)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Manifest file not found: ${manifestFile}`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
  const taskId = manifest.linked_tasks?.[0] ?? 'UNKNOWN';
  return validateConsensusTask(taskId, opts);
}
