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
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

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
  command: string
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
    path.dirname(new URL(import.meta.url).pathname),
    '..', '..', '..', 'dist', 'cli', 'index.js'
  );
  const defaultCliPath = await fs.access(projectCli).then(
    () => `node ${projectCli}`,
    () => 'cleo'
  );
  const cliPath = process.env.CLEO_CLI_PATH || defaultCliPath;

  // Create temp directory
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'cleo-test-'));

  try {
    // Initialize CLEO project
    const initResult = await cleoExec(cliPath, tmpBase, 'init "mcp-test" --json');
    if (!initResult.stdout.includes('"success":true')) {
      throw new Error(
        `cleo init failed: ${initResult.stderr || initResult.stdout}`
      );
    }

    // Disable session enforcement so tests can run without sessions
    await cleoExec(cliPath, tmpBase, 'config set session.enforcement none --json');

    // Disable session-related requirements that block test operations
    await cleoExec(cliPath, tmpBase, 'config set session.requireSession false --json');
    await cleoExec(cliPath, tmpBase, 'config set session.requireSessionNote false --json');
    await cleoExec(cliPath, tmpBase, 'config set session.requireNotesOnComplete false --json');

    // Disable cancellation reason requirement for delete tests
    await cleoExec(cliPath, tmpBase, 'config set cancellation.requireReason false --json');

    // Set hierarchy limits for validation gate tests
    // Use a limit of 15 - enough for test task creation but low enough
    // for the sibling limit test to trigger within reasonable iteration count.
    await cleoExec(cliPath, tmpBase, 'config set hierarchy.maxSiblings 15 --json');
    await cleoExec(cliPath, tmpBase, 'config set hierarchy.maxDepth 3 --json');

    // Create an epic for testing
    const epicResult = await cleoExec(
      cliPath,
      tmpBase,
      'add "Test Epic" --description "Epic for integration testing" --json'
    );
    const epicParsed = JSON.parse(epicResult.stdout.trim());
    const epicId = epicParsed.data?.task?.id ?? epicParsed.task?.id;
    if (!epicId) {
      throw new Error(`Failed to create test epic: ${epicResult.stdout}`);
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
        `add "${task.title}" --description "${task.desc}" --parent ${epicId} --json`
      );
      const parsed = JSON.parse(result.stdout.trim());
      const taskId = parsed.data?.task?.id ?? parsed.task?.id;
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
  try {
    await fs.rm(env.projectRoot, { recursive: true, force: true });
  } catch (error) {
    console.warn('Failed to clean up test environment:', error);
  }
}

/**
 * Get the path to the CLEO log file in the test environment.
 * CLEO stores audit logs in .cleo/todo-log.jsonl (not audit-trail.jsonl).
 */
export function getLogFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.cleo', 'todo-log.jsonl');
}

/**
 * Read audit log entries from the test environment's todo-log.jsonl.
 * CLEO stores logs as a JSON object with an "entries" array, not JSONL.
 */
export async function readAuditEntries(
  projectRoot: string,
  filter?: {
    action?: string;
    taskId?: string;
    sessionId?: string;
  }
): Promise<any[]> {
  const logPath = getLogFilePath(projectRoot);
  try {
    const content = await fs.readFile(logPath, 'utf-8');
    const parsed = JSON.parse(content);
    let entries: any[] = parsed.entries || [];

    if (filter) {
      entries = entries.filter((entry: any) => {
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
