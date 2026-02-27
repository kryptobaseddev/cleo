/**
 * Release protocol validation.
 * IVTR Stage: R (Release)
 * @task T4804
 * @epic T4798
 */

import { readFileSync, existsSync } from 'node:fs';
import { CleoError } from '../../errors.js';
import { ExitCode } from '../../../types/exit-codes.js';
import { getManifestPath } from '../../paths.js';

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

/** Validate release protocol for a task. */
export async function validateReleaseTask(
  taskId: string,
  opts: { strict?: boolean },
): Promise<ValidationResult> {
  const manifestPath = getManifestPath();
  const entry = findManifestEntry(taskId, manifestPath);
  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `No manifest entry found for task ${taskId}`);
  }

  const manifest = JSON.parse(entry);
  const violations: ValidationResult['violations'] = [];

  // RLSE-007: agent_type check
  if (manifest.agent_type !== 'documentation') {
    violations.push({
      code: 'RLSE-007',
      severity: 'high',
      message: `Expected agent_type "documentation", got "${manifest.agent_type}"`,
    });
  }

  const score = violations.length === 0 ? 100 : Math.max(0, 100 - violations.length * 25);
  const result: ValidationResult = {
    valid: violations.length === 0,
    violations,
    score,
    protocol: 'release',
    taskId,
  };

  if (opts.strict && violations.length > 0) {
    throw new CleoError(66 as ExitCode, `Release protocol violations for ${taskId}`);
  }

  return result;
}

/** Validate release protocol from manifest file. */
export async function checkReleaseManifest(
  manifestFile: string,
  opts: { strict?: boolean },
): Promise<ValidationResult> {
  if (!existsSync(manifestFile)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Manifest file not found: ${manifestFile}`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
  const taskId = manifest.linked_tasks?.[0] ?? 'UNKNOWN';
  return validateReleaseTask(taskId, opts);
}
