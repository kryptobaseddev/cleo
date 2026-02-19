/**
 * Implementation protocol validation.
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

/** Validate implementation protocol for a task. */
export async function validateImplementationTask(
  taskId: string,
  opts: { strict?: boolean },
): Promise<ValidationResult> {
  const manifestPath = '.cleo/agent-outputs/MANIFEST.jsonl';
  const entry = findManifestEntry(taskId, manifestPath);
  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `No manifest entry found for task ${taskId}`);
  }

  const manifest = JSON.parse(entry);
  const violations: ValidationResult['violations'] = [];

  // IMPL-007: agent_type check
  if (manifest.agent_type !== 'implementation') {
    violations.push({
      code: 'IMPL-007',
      severity: 'high',
      message: `Expected agent_type "implementation", got "${manifest.agent_type}"`,
    });
  }

  const score = violations.length === 0 ? 100 : Math.max(0, 100 - violations.length * 25);
  const result: ValidationResult = {
    valid: violations.length === 0,
    violations,
    score,
    protocol: 'implementation',
    taskId,
  };

  if (opts.strict && violations.length > 0) {
    throw new CleoError(64 as ExitCode, `Implementation protocol violations for ${taskId}`);
  }

  return result;
}

/** Validate implementation protocol from manifest file. */
export async function checkImplementationManifest(
  manifestFile: string,
  opts: { strict?: boolean },
): Promise<ValidationResult> {
  if (!existsSync(manifestFile)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Manifest file not found: ${manifestFile}`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
  const taskId = manifest.linked_tasks?.[0] ?? 'UNKNOWN';
  return validateImplementationTask(taskId, opts);
}
