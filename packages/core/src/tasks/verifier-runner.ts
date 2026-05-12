/**
 * Verifier runner — resolves and executes task acceptance verifier scripts.
 *
 * Extracted from packages/cleo/src/cli/commands/verify.ts (T9219 / ADR-070)
 * so that non-CLI contexts (orchestrator, sentient, playbook runtime) can
 * invoke verifier resolution and backfill without depending on the CLI layer.
 *
 * The backfill functions accept pre-fetched task records so that callers
 * can use any dispatch mechanism (CLI, direct engine call, etc.) to obtain
 * them — this avoids a core→cleo circular dependency.
 *
 * @task T9219
 * @adr ADR-070
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { generateVerifierStub, writeVerifierStub } from './verifier-stub-generator.js';

export interface VerifierResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BackfillSingleResult {
  taskId: string;
  status: 'generated' | 'skipped' | 'failed';
  path?: string;
  error?: string;
}

export interface BackfillAllResult {
  succeeded: number;
  skipped: number;
  failed: number;
  results: BackfillSingleResult[];
}

/**
 * Resolve the verifier script path for a given task ID.
 *
 * Search order:
 *   1. scripts/verify-<taskId>-fu.mjs  (recovery follow-up convention)
 *   2. scripts/verify-<taskId>.mjs      (general convention)
 *   3. scripts/verify-<lowercase-id>-fu.mjs
 *   4. scripts/verify-<lowercase-id>.mjs
 *
 * @param taskId - Task ID (e.g. "T9188").
 * @param projectRoot - Project root to search from.
 * @returns Absolute path to verifier script, or null if not found.
 */
export function resolveVerifierScript(taskId: string, projectRoot: string): string | null {
  const id = taskId.toLowerCase();
  const candidates = [
    join(projectRoot, 'scripts', `verify-${taskId}-fu.mjs`),
    join(projectRoot, 'scripts', `verify-${taskId}.mjs`),
    join(projectRoot, 'scripts', `verify-${id}-fu.mjs`),
    join(projectRoot, 'scripts', `verify-${id}.mjs`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run the verifier script for a task and return the exit code and output.
 *
 * @param verifierPath - Absolute path to the verifier script.
 * @returns Exit code and captured stdout/stderr.
 */
export function runVerifier(verifierPath: string): VerifierResult {
  const result = spawnSync('node', [verifierPath], { encoding: 'utf8' });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Generate a verifier stub for a single pre-fetched task and return a structured result.
 *
 * The caller is responsible for fetching the task (via CLI dispatch or direct
 * engine call) before passing it here.
 *
 * @param task - Pre-fetched task record.
 * @param projectRoot - Absolute path to the project root.
 * @param force - Overwrite existing verifier when true.
 * @returns Structured result indicating generated/skipped/failed.
 */
export function backfillVerifier(
  task: Task | Record<string, unknown>,
  projectRoot: string,
  force: boolean,
): BackfillSingleResult {
  const taskId = String((task as Record<string, unknown>).id ?? '');
  if (!taskId) {
    return { taskId: '', status: 'failed', error: 'task has no id' };
  }

  const existing = resolveVerifierScript(taskId, projectRoot);
  if (existing && !force) {
    return { taskId, status: 'skipped', path: existing };
  }

  try {
    const source = generateVerifierStub(
      task as unknown as Parameters<typeof generateVerifierStub>[0],
    );
    const outPath = writeVerifierStub(taskId, source, projectRoot, force);
    return { taskId, status: 'generated', path: outPath };
  } catch (err) {
    return { taskId, status: 'failed', error: (err as Error).message ?? String(err) };
  }
}

/**
 * Enumerate a list of pre-fetched tasks and generate verifier stubs for those lacking one.
 *
 * The caller is responsible for fetching and deduplicating the task list
 * before passing it here.
 *
 * @param tasks - Pre-fetched task records (deduplicated by caller).
 * @param projectRoot - Absolute path to the project root.
 * @param force - Overwrite existing verifiers when true.
 * @returns Structured summary of all processed tasks.
 */
export function backfillAllPendingVerifiers(
  tasks: Array<Task | Record<string, unknown>>,
  projectRoot: string,
  force: boolean,
): BackfillAllResult {
  const lacking = tasks.filter((t) => {
    const id = String((t as Record<string, unknown>).id ?? '');
    return id && !resolveVerifierScript(id, projectRoot);
  });

  const results: BackfillSingleResult[] = [];
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const task of lacking) {
    const result = backfillVerifier(task, projectRoot, force);
    results.push(result);
    if (result.status === 'generated') succeeded++;
    else if (result.status === 'skipped') skipped++;
    else failed++;
  }

  return { succeeded, skipped, failed, results };
}
