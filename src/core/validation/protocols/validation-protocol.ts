/**
 * Validation (verify) protocol validation.
 * IVTR Stage: V (Validation/Verify)
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

/** Validate verification/validation protocol for a task. */
export async function validateValidationTask(
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

  // VALID-006: agent_type check
  if (manifest.agent_type !== 'validation') {
    violations.push({
      code: 'VALID-006',
      severity: 'high',
      message: `Expected agent_type "validation", got "${manifest.agent_type}"`,
    });
  }

  // VALID-005: validation summary must be present
  if (!manifest.key_findings || !Array.isArray(manifest.key_findings) || manifest.key_findings.length === 0) {
    violations.push({
      code: 'VALID-005',
      severity: 'high',
      message: 'Validation output must include non-empty key_findings array with check results',
    });
  }

  const score = violations.length === 0 ? 100 : Math.max(0, 100 - violations.length * 25);
  const result: ValidationResult = {
    valid: violations.length === 0,
    violations,
    score,
    protocol: 'validation',
    taskId,
  };

  if (opts.strict && violations.length > 0) {
    throw new CleoError(67 as ExitCode, `Validation protocol violations for ${taskId}`);
  }

  return result;
}

/** Validate validation protocol from manifest file. */
export async function checkValidationManifest(
  manifestFile: string,
  opts: { strict?: boolean },
): Promise<ValidationResult> {
  if (!existsSync(manifestFile)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Manifest file not found: ${manifestFile}`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
  const taskId = manifest.linked_tasks?.[0] ?? 'UNKNOWN';
  return validateValidationTask(taskId, opts);
}
