/**
 * Research protocol validation.
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

/** Validate research protocol for a task. */
export async function validateResearchTask(
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

  // RSCH-001: agent_type check
  if (manifest.agent_type !== 'research') {
    violations.push({
      code: 'RSCH-001',
      severity: 'high',
      message: `Expected agent_type "research", got "${manifest.agent_type}"`,
    });
  }

  // RSCH-002: key_findings must be present and non-empty
  if (!manifest.key_findings || !Array.isArray(manifest.key_findings) || manifest.key_findings.length === 0) {
    violations.push({
      code: 'RSCH-002',
      severity: 'high',
      message: 'Research output must include non-empty key_findings array',
    });
  }

  // RSCH-003: output file must exist
  if (manifest.file && !existsSync(manifest.file)) {
    violations.push({
      code: 'RSCH-003',
      severity: 'medium',
      message: `Output file "${manifest.file}" not found on disk`,
    });
  }

  const score = violations.length === 0 ? 100 : Math.max(0, 100 - violations.length * 25);
  const result: ValidationResult = {
    valid: violations.length === 0,
    violations,
    score,
    protocol: 'research',
    taskId,
  };

  if (opts.strict && violations.length > 0) {
    throw new CleoError(60 as ExitCode, `Research protocol violations for ${taskId}`);
  }

  return result;
}

/** Validate research protocol from manifest file. */
export async function checkResearchManifest(
  manifestFile: string,
  opts: { strict?: boolean },
): Promise<ValidationResult> {
  if (!existsSync(manifestFile)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Manifest file not found: ${manifestFile}`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
  const taskId = manifest.linked_tasks?.[0] ?? 'UNKNOWN';
  return validateResearchTask(taskId, opts);
}
