/**
 * CLI testing command - validate testing protocol compliance.
 * Ported from scripts/testing.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getManifestPath } from '../../core/paths.js';

/** Violation entry from protocol validation. */
interface Violation {
  rule: string;
  severity: 'MUST' | 'SHOULD' | 'MAY';
  message: string;
}

/** Validation result for a manifest entry. */
interface ValidationResult {
  valid: boolean;
  score: number;
  violations: Violation[];
  taskId: string;
}

/**
 * Validate a manifest entry against testing protocol rules.
 * @task T4551
 */
function validateTestingProtocol(
  taskId: string,
  manifestEntry: Record<string, unknown>,
  _strict: boolean,
): ValidationResult {
  const violations: Violation[] = [];

  // TEST-007: agent_type must be "testing"
  if (manifestEntry['agent_type'] !== 'testing') {
    violations.push({
      rule: 'TEST-007',
      severity: 'MUST',
      message: `agent_type must be "testing", got "${manifestEntry['agent_type'] ?? 'undefined'}"`,
    });
  }

  // TEST-006: Must include test summary in key_findings
  const keyFindings = manifestEntry['key_findings'] as string[] | undefined;
  if (!keyFindings || keyFindings.length === 0) {
    violations.push({
      rule: 'TEST-006',
      severity: 'MUST',
      message: 'Missing test summary in key_findings',
    });
  }

  // TEST-001: Check for test framework indicators
  const status = manifestEntry['status'] as string | undefined;
  if (status !== 'complete') {
    violations.push({
      rule: 'TEST-004',
      severity: 'MUST',
      message: `Test status must be "complete", got "${status ?? 'undefined'}"`,
    });
  }

  // Check file path exists
  const file = manifestEntry['file'] as string | undefined;
  if (!file) {
    violations.push({
      rule: 'TEST-001',
      severity: 'MUST',
      message: 'Missing output file path in manifest entry',
    });
  }

  // Calculate score
  const mustViolations = violations.filter((v) => v.severity === 'MUST').length;
  const totalChecks = 4;
  const passed = totalChecks - mustViolations;
  const score = Math.round((passed / totalChecks) * 100);

  return {
    valid: mustViolations === 0,
    score,
    violations,
    taskId,
  };
}

/**
 * Register the testing command.
 * @task T4551
 */
export function registerTestingCommand(program: Command): void {
  const testingCmd = program
    .command('testing')
    .description('Validate testing protocol compliance');

  testingCmd
    .command('validate <taskId>')
    .description('Validate testing protocol compliance for a task')
    .option('--strict', 'Exit with error code on violations')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const strict = opts['strict'] as boolean ?? false;
        const manifestPath = getManifestPath();

        let manifestContent: string;
        try {
          manifestContent = await readFile(manifestPath, 'utf-8');
        } catch {
          throw new CleoError(ExitCode.NOT_FOUND, `Manifest not found: ${manifestPath}`);
        }

        // Find manifest entry for task
        const lines = manifestContent.trim().split('\n').filter(Boolean);
        let entry: Record<string, unknown> | null = null;

        for (const line of lines.reverse()) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const linkedTasks = parsed['linked_tasks'] as string[] | undefined;
            if (linkedTasks?.includes(taskId)) {
              entry = parsed;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!entry) {
          throw new CleoError(ExitCode.NOT_FOUND, `No manifest entry found for task ${taskId}`);
        }

        const result = validateTestingProtocol(taskId, entry, strict);

        console.log(formatSuccess(result));

        if (strict && !result.valid) {
          process.exit(ExitCode.TESTS_SKIPPED);
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  testingCmd
    .command('check <manifestFile>')
    .description('Validate testing protocol from a manifest file')
    .option('--strict', 'Exit with error code on violations')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      try {
        const strict = opts['strict'] as boolean ?? false;

        let content: string;
        try {
          content = await readFile(manifestFile, 'utf-8');
        } catch {
          throw new CleoError(ExitCode.NOT_FOUND, `Manifest file not found: ${manifestFile}`);
        }

        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(content) as Record<string, unknown>;
        } catch {
          throw new CleoError(ExitCode.VALIDATION_ERROR, `Invalid JSON in: ${manifestFile}`);
        }

        const linkedTasks = entry['linked_tasks'] as string[] | undefined;
        const taskId = linkedTasks?.[0] ?? 'UNKNOWN';

        const result = validateTestingProtocol(taskId, entry, strict);

        console.log(formatSuccess(result));

        if (strict && !result.valid) {
          process.exit(ExitCode.TESTS_SKIPPED);
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
