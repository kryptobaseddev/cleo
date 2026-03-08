/**
 * Isolated Test CLEO Environment
 *
 * Creates a temporary CLEO project directory with minimal data files
 * for integration and E2E tests. Ensures tests don't corrupt production data.
 *
 * Uses `cleo init` to create a valid project, then configures it for testing:
 * - Disables session enforcement
 * - Pre-populates with test tasks and an epic
 * - Provides cleanup on teardown
 *
 * @task T2922
 */

import { exec } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TestEnvironment {
  /** Path to the temporary CLEO project root */
  projectRoot: string;

  /** Pre-created epic ID */
  epicId: string;

  /** Pre-created task IDs (children of the epic) */
  taskIds: string[];

  /** Path to the CLEO CLI */
  cliPath: string;
}

/**
 * Execute a CLEO command in the test environment
 */
async function cleoExec(
  cliPath: string,
  cwd: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(`${cliPath} ${command}`, {
      cwd,
      timeout: 30000,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.code || 1,
    };
  }
}

/**
 * Create an isolated test CLEO environment.
 *
 * This initializes a fresh CLEO project in a temporary directory,
 * disables session enforcement, and pre-populates test data.
 */
export async function createTestEnvironment(): Promise<TestEnvironment> {
  // Prefer the project's own built CLI so tests run against current source.
  // Fall back to CLEO_CLI_PATH env var or the globally installed 'cleo'.
  const projectCli = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'dist',
    'cli',
    'index.js',
  );
  const defaultCliPath = await fs.access(projectCli).then(
    () => `node ${projectCli}`,
    () => 'cleo',
  );
  const cliPath = process.env.CLEO_CLI_PATH || defaultCliPath;

  // Create temp directory
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'cleo-test-'));

  try {
    // Initialize CLEO project
    const initResult = await cleoExec(cliPath, tmpBase, 'init "mcp-test" --json');
    if (!initResult.stdout.includes('"success":true')) {
      throw new Error(`cleo init failed: ${initResult.stderr || initResult.stdout}`);
    }

    // Disable session enforcement so tests can run without sessions
    await cleoExec(cliPath, tmpBase, 'config set session.enforcement none --json');

    // Disable session-related requirements that block test operations
    await cleoExec(cliPath, tmpBase, 'config set session.requireSession false --json');
    await cleoExec(cliPath, tmpBase, 'config set session.requireSessionNote false --json');
    await cleoExec(cliPath, tmpBase, 'config set session.requireNotesOnComplete false --json');

    // Disable cancellation reason requirement for delete tests
    await cleoExec(cliPath, tmpBase, 'config set cancellation.requireReason false --json');

    // Keep integration/e2e flows focused on gateway behavior, not verification gates.
    await cleoExec(cliPath, tmpBase, 'config set verification.enabled false --json');

    // Explicitly set storage engine to json for test environments (@task T4699)
    // Prevents pre-flight migration warning from firing during test CLI calls
    await cleoExec(cliPath, tmpBase, 'config set storage.engine json --json');

    // Set hierarchy limits for validation gate tests
    // Use a limit of 15 - enough for test task creation but low enough
    // for the sibling limit test to trigger within reasonable iteration count.
    await cleoExec(cliPath, tmpBase, 'config set hierarchy.maxSiblings 15 --json');
    await cleoExec(cliPath, tmpBase, 'config set hierarchy.maxDepth 3 --json');

    // Create an epic for testing
    const epicResult = await cleoExec(
      cliPath,
      tmpBase,
      'add "Test Epic" --description "Epic for integration testing" --json',
    );
    const epicOutput = epicResult.stdout.trim() || epicResult.stderr.trim();
    let epicParsed: any;
    try {
      epicParsed = JSON.parse(epicOutput);
    } catch {
      throw new Error(
        `Failed to parse epic creation output (exit ${epicResult.exitCode}): ` +
          `stdout=${JSON.stringify(epicResult.stdout)}, stderr=${JSON.stringify(epicResult.stderr)}`,
      );
    }
    const epicId =
      epicParsed.result?.task?.id ??
      epicParsed.result?.id ??
      epicParsed.data?.task?.id ??
      epicParsed.data?.id ??
      epicParsed.task?.id ??
      epicParsed.id;
    if (!epicId) {
      throw new Error(`Failed to create test epic: ${epicOutput}`);
    }

    // Create child tasks under the epic
    const taskIds: string[] = [];
    const testTasks = [
      { title: 'Setup Task', desc: 'Setup task for test operations' },
      { title: 'Feature Task', desc: 'Feature implementation task for testing' },
      { title: 'Bug Fix Task', desc: 'Bug fix task for testing mutations' },
      { title: 'Review Task', desc: 'Code review task for testing queries' },
      { title: 'Docs Task', desc: 'Documentation task for testing updates' },
    ];

    for (const task of testTasks) {
      const result = await cleoExec(
        cliPath,
        tmpBase,
        `add "${task.title}" --description "${task.desc}" --parent ${epicId} --json`,
      );
      const taskOutput = result.stdout.trim() || result.stderr.trim();
      let parsed: any;
      try {
        parsed = JSON.parse(taskOutput);
      } catch {
        throw new Error(
          `Failed to parse task creation output for "${task.title}" (exit ${result.exitCode}): ` +
            `stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)}`,
        );
      }
      const taskId =
        parsed.result?.task?.id ??
        parsed.result?.id ??
        parsed.data?.task?.id ??
        parsed.data?.id ??
        parsed.task?.id ??
        parsed.id;
      if (taskId) {
        taskIds.push(taskId);
      }
    }

    return {
      projectRoot: tmpBase,
      epicId,
      taskIds,
      cliPath,
    };
  } catch (error) {
    // Cleanup on initialization failure
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Destroy the test environment and clean up all temporary files.
 */
export async function destroyTestEnvironment(env: TestEnvironment): Promise<void> {
  // Close all SQLite database connections before cleanup.
  // On Windows, SQLite holds exclusive file handles on .db/.db-wal/.db-shm
  // files, causing EBUSY errors during recursive directory removal.
  try {
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* module may not be loaded */
  }
  try {
    await fs.rm(env.projectRoot, { recursive: true, force: true });
  } catch (error) {
    console.warn('Failed to clean up test environment:', error);
  }
}

/**
 * Query audit log entries from the SQLite audit_log table in the test environment.
 * Replaces legacy todo-log.jsonl readers (T5338, ADR-024).
 */
export async function readAuditEntries(
  projectRoot: string,
  filter?: {
    action?: string;
    taskId?: string;
    sessionId?: string;
  },
): Promise<any[]> {
  try {
    const { getDb } = await import('../../store/sqlite.js');
    const { auditLog } = await import('../../store/tasks-schema.js');
    const db = await getDb(projectRoot);
    const rows = await db.select().from(auditLog).orderBy(auditLog.timestamp);

    let entries = rows.map((r) => ({
      action: r.action,
      taskId: r.taskId,
      sessionId: r.sessionId,
      timestamp: r.timestamp,
      domain: r.domain,
      operation: r.operation,
      detailsJson: r.detailsJson,
    }));

    if (filter) {
      entries = entries.filter((entry) => {
        if (filter.action && entry.action !== filter.action) return false;
        if (filter.taskId && entry.taskId !== filter.taskId) return false;
        if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
        return true;
      });
    }

    return entries;
  } catch {
    return [];
  }
}
