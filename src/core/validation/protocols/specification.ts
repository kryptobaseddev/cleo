/**
 * Specification protocol validation.
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

/** Validate specification protocol for a task. */
export async function validateSpecificationTask(
  taskId: string,
  opts: { strict?: boolean; specFile?: string },
): Promise<ValidationResult> {
  const manifestPath = '.cleo/agent-outputs/MANIFEST.jsonl';
  const entry = findManifestEntry(taskId, manifestPath);
  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `No manifest entry found for task ${taskId}`);
  }

  const manifest = JSON.parse(entry);
  const violations: ValidationResult['violations'] = [];

  // SPEC-007: agent_type check
  if (manifest.agent_type !== 'specification') {
    violations.push({
      code: 'SPEC-007',
      severity: 'high',
      message: `Expected agent_type "specification", got "${manifest.agent_type}"`,
    });
  }

  // SPEC-001: RFC 2119 keywords check
  if (opts.specFile && existsSync(opts.specFile)) {
    const specContent = readFileSync(opts.specFile, 'utf-8');
    const rfc2119Keywords = ['MUST', 'SHOULD', 'MAY', 'MUST NOT', 'SHOULD NOT'];
    const hasKeywords = rfc2119Keywords.some(kw => specContent.includes(kw));
    if (!hasKeywords) {
      violations.push({
        code: 'SPEC-001',
        severity: 'medium',
        message: 'Specification should contain RFC 2119 keywords (MUST/SHOULD/MAY)',
      });
    }
  }

  // SPEC-002: version check
  if (!manifest.version && opts.specFile) {
    const specContent = existsSync(opts.specFile) ? readFileSync(opts.specFile, 'utf-8') : '';
    const hasVersion = /version[:\s]+\d/i.test(specContent) || /^#+.*v\d/im.test(specContent);
    if (!hasVersion) {
      violations.push({
        code: 'SPEC-002',
        severity: 'medium',
        message: 'Specification should include version information',
      });
    }
  }

  const score = violations.length === 0 ? 100 : Math.max(0, 100 - violations.length * 20);
  const result: ValidationResult = {
    valid: violations.length === 0,
    violations,
    score,
    protocol: 'specification',
    taskId,
  };

  if (opts.strict && violations.length > 0) {
    throw new CleoError(62 as ExitCode, `Specification protocol violations for ${taskId}`);
  }

  return result;
}

/** Validate specification protocol from manifest file. */
export async function checkSpecificationManifest(
  manifestFile: string,
  opts: { strict?: boolean; specFile?: string },
): Promise<ValidationResult> {
  if (!existsSync(manifestFile)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Manifest file not found: ${manifestFile}`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
  const taskId = manifest.linked_tasks?.[0] ?? 'UNKNOWN';
  return validateSpecificationTask(taskId, opts);
}
