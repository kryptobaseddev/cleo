/**
 * CLI verify command - manage verification gates for tasks.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { readJson, saveJson, computeChecksum } from '../../store/json.js';
import { getTodoPath, getBackupDir } from '../../core/paths.js';
import type { TodoFile, TaskVerification, VerificationGate } from '../../types/task.js';

const VALID_GATES: VerificationGate[] = [
  'implemented', 'testsPassed', 'qaPassed', 'cleanupDone', 'securityPassed', 'documented',
];

const DEFAULT_REQUIRED_GATES: VerificationGate[] = [
  'implemented', 'testsPassed', 'qaPassed', 'securityPassed', 'documented',
];

function initVerification(): TaskVerification {
  return {
    passed: false,
    round: 0,
    gates: {},
    lastAgent: null,
    lastUpdated: null,
    failureLog: [],
  };
}

function computePassed(verification: TaskVerification): boolean {
  for (const gate of DEFAULT_REQUIRED_GATES) {
    if (verification.gates[gate] !== true) return false;
  }
  return true;
}

function getMissingGates(verification: TaskVerification): VerificationGate[] {
  return DEFAULT_REQUIRED_GATES.filter((g) => verification.gates[g] !== true);
}

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify <task-id>')
    .description('View or modify verification gates for a task')
    .option('--gate <name>', 'Set specific gate')
    .option('--value <bool>', 'Gate value: true or false', 'true')
    .option('--agent <name>', 'Agent setting the gate')
    .option('--all', 'Mark all required gates as passed')
    .option('--reset', 'Reset verification to initial state')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID format: ${taskId}`);
        }

        const todoPath = getTodoPath();
        const data = await readJson<TodoFile>(todoPath);
        if (!data) {
          throw new CleoError(ExitCode.NOT_FOUND, 'No todo.json found. Run: cleo init');
        }

        const task = data.tasks.find((t) => t.id === taskId);
        if (!task) {
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
        }

        // View mode (no gate, --all, or --reset specified)
        if (!opts['gate'] && !opts['all'] && !opts['reset']) {
          const verification = task.verification ?? initVerification();
          const missing = getMissingGates(verification);
          console.log(formatSuccess({
            task: taskId,
            title: task.title,
            status: task.status,
            type: task.type ?? 'task',
            verification,
            verificationStatus: verification.passed ? 'passed' : 'pending',
            passed: verification.passed,
            round: verification.round,
            requiredGates: DEFAULT_REQUIRED_GATES,
            missingGates: missing,
          }));
          return;
        }

        let verification = task.verification ?? initVerification();
        const now = new Date().toISOString();

        if (opts['reset']) {
          verification = initVerification();
        } else if (opts['all']) {
          for (const gate of DEFAULT_REQUIRED_GATES) {
            verification.gates[gate] = true;
          }
          if (opts['agent']) {
            verification.lastAgent = opts['agent'] as never;
          }
          verification.lastUpdated = now;
        } else if (opts['gate']) {
          const gate = opts['gate'] as string;
          if (!VALID_GATES.includes(gate as VerificationGate)) {
            throw new CleoError(ExitCode.INVALID_GATE, `Invalid gate: ${gate}. Valid: ${VALID_GATES.join(', ')}`);
          }

          const value = opts['value'] === 'false' ? false : true;
          verification.gates[gate as VerificationGate] = value;

          if (opts['agent']) {
            verification.lastAgent = opts['agent'] as never;
          }
          verification.lastUpdated = now;

          if (!value) {
            verification.round++;
            verification.failureLog.push({
              round: verification.round,
              agent: (opts['agent'] as string) ?? 'unknown',
              reason: `Gate ${gate} set to false`,
              timestamp: now,
            });
          }
        }

        verification.passed = computePassed(verification);
        task.verification = verification;
        task.updatedAt = now;

        data._meta.checksum = computeChecksum(data.tasks);
        data.lastUpdated = now;

        await saveJson(todoPath, data, { backupDir: getBackupDir() });

        if (opts['reset']) {
          console.log(formatSuccess({
            task: taskId,
            action: 'reset',
            verification,
          }));
        } else if (opts['all']) {
          console.log(formatSuccess({
            task: taskId,
            action: 'set_all',
            gatesSet: DEFAULT_REQUIRED_GATES,
            verification,
            passed: verification.passed,
          }));
        } else {
          console.log(formatSuccess({
            task: taskId,
            gate: opts['gate'],
            value: opts['value'] === 'false' ? false : true,
            agent: opts['agent'] ?? null,
            verification,
            passed: verification.passed,
          }));
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
