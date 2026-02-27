/**
 * Integration Test Setup and Fixtures
 *
 * Provides real CLI execution helpers, test fixtures, and cleanup utilities
 * for integration tests that verify full request/response flow through:
 * Gateway -> Domain Router -> Domain Handler -> CLI Executor -> Response Formatter
 *
 * Uses an isolated test CLEO environment (via test-environment.ts) to avoid
 * corrupting production data.
 *
 * The CLIExecutor class (previously in src/mcp/lib/executor.ts, deleted in
 * Phase 5 migration) is now defined inline here. It spawns the CLEO CLI as
 * a subprocess and parses JSON output.
 *
 * @task T2922
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnvironment,
  destroyTestEnvironment,
  type TestEnvironment,
} from './test-environment.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Exit code to name mapping (from ExitCode enum in src/types/exit-codes.ts)
// ---------------------------------------------------------------------------

const EXIT_CODE_NAMES: Record<number, string> = {
  0: 'SUCCESS',
  1: 'GENERAL_ERROR',
  2: 'INVALID_INPUT',
  3: 'FILE_ERROR',
  4: 'NOT_FOUND',
  5: 'DEPENDENCY_ERROR',
  6: 'VALIDATION_ERROR',
  7: 'LOCK_TIMEOUT',
  8: 'CONFIG_ERROR',
  10: 'PARENT_NOT_FOUND',
  11: 'DEPTH_EXCEEDED',
  12: 'SIBLING_LIMIT',
  13: 'INVALID_PARENT_TYPE',
  14: 'CIRCULAR_REFERENCE',
  15: 'ORPHAN_DETECTED',
  16: 'HAS_CHILDREN',
  17: 'TASK_COMPLETED',
  18: 'CASCADE_FAILED',
  19: 'HAS_DEPENDENTS',
  20: 'CHECKSUM_MISMATCH',
  21: 'CONCURRENT_MODIFICATION',
  22: 'ID_COLLISION',
  30: 'SESSION_EXISTS',
  31: 'SESSION_NOT_FOUND',
  32: 'SCOPE_CONFLICT',
  33: 'SCOPE_INVALID',
  34: 'TASK_NOT_IN_SCOPE',
  35: 'TASK_CLAIMED',
  36: 'SESSION_REQUIRED',
  37: 'SESSION_CLOSE_BLOCKED',
  38: 'ACTIVE_TASK_REQUIRED',
  39: 'NOTES_REQUIRED',
  50: 'CONTEXT_WARNING',
  51: 'CONTEXT_CAUTION',
  52: 'CONTEXT_CRITICAL',
  53: 'CONTEXT_EMERGENCY',
  54: 'CONTEXT_STALE',
  60: 'PROTOCOL_MISSING',
  75: 'NEXUS_REGISTRY_CORRUPT',
  80: 'LIFECYCLE_GATE_FAILED',
  100: 'NO_DATA',
  101: 'ALREADY_EXISTS',
  102: 'NO_CHANGE',
};

// ---------------------------------------------------------------------------
// ExecutorResult — the shape returned by CLIExecutor.execute()
// ---------------------------------------------------------------------------

interface ExecutorResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code?: string; message: string; details?: any };
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Execution duration in milliseconds */
  duration?: number;
}

// ---------------------------------------------------------------------------
// CLIExecutor — minimal replacement for deleted src/mcp/lib/executor.ts
// ---------------------------------------------------------------------------

/**
 * Executes CLEO CLI commands as subprocesses and parses JSON output.
 *
 * This is a minimal reimplementation of the CLIExecutor that was previously
 * in src/mcp/lib/executor.ts. It provides the same interface used by the
 * integration and E2E test suites.
 */
class CLIExecutor {
  constructor(
    private cliPath: string,
    private timeout: number = 60000,
    private maxRetries: number = 1,
  ) {}

  /**
   * Escape a shell argument using single quotes.
   */
  private escapeArg(arg: string | number | boolean): string {
    const str = String(arg);
    const escaped = str.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }

  /**
   * Map domain+operation to the actual CLI command structure.
   * Replicates the mapping from the deleted command-builder.ts.
   */
  private mapToCliCommand(domain: string, operation: string): { command: string; addOperationAsSubcommand: boolean } {
    // Tasks domain: operation IS the top-level CLI command
    const taskOps: Record<string, string> = {
      show: 'show', list: 'list', find: 'find', add: 'add',
      update: 'update', complete: 'complete', delete: 'delete',
      archive: 'archive', restore: 'restore task', reopen: 'restore task',
      exists: 'exists', next: 'next', current: 'current',
      start: 'start', stop: 'stop', depends: 'deps show',
      blockers: 'blockers', tree: 'tree', analyze: 'analyze',
    };
    if (domain === 'tasks' && taskOps[operation]) {
      return { command: taskOps[operation], addOperationAsSubcommand: false };
    }

    // Session domain: 'cleo session <operation>'
    if (domain === 'session') {
      if (operation === 'focus') return { command: 'focus', addOperationAsSubcommand: false };
      return { command: 'session', addOperationAsSubcommand: true };
    }

    // Lifecycle domain: 'cleo lifecycle <subcommand>'
    const lifecycleOps: Record<string, string> = {
      status: 'lifecycle show', show: 'lifecycle show', stages: 'lifecycle show',
      validate: 'lifecycle gate', record: 'lifecycle complete',
      start: 'lifecycle start', complete: 'lifecycle complete',
      enforce: 'lifecycle gate', skip: 'lifecycle skip',
      gate: 'lifecycle gate', gates: 'lifecycle show',
      prerequisites: 'lifecycle show', history: 'lifecycle show',
      reset: 'lifecycle start', report: 'lifecycle show',
      'gate.pass': 'lifecycle gate', 'gate.fail': 'lifecycle gate',
    };
    if (domain === 'lifecycle' && lifecycleOps[operation]) {
      return { command: lifecycleOps[operation], addOperationAsSubcommand: false };
    }
    if (domain === 'lifecycle') {
      return { command: 'lifecycle', addOperationAsSubcommand: true };
    }

    // Orchestrate domain: 'cleo orchestrate <operation>'
    const orchOps: Record<string, string> = {
      status: 'orchestrate context', waves: 'orchestrate analyze',
      parallel: 'orchestrate ready', check: 'orchestrate validate',
    };
    if (domain === 'orchestrate' && orchOps[operation]) {
      return { command: orchOps[operation], addOperationAsSubcommand: false };
    }
    if (domain === 'orchestrate') {
      return { command: 'orchestrate', addOperationAsSubcommand: true };
    }

    // Research domain: 'cleo research <operation>'
    const researchOps: Record<string, string> = {
      stats: 'research manifest',
      'manifest.append': 'research add',
      'manifest.read': 'research list',
      'manifest.archive': 'research archive',
    };
    if (domain === 'research' && researchOps[operation]) {
      return { command: researchOps[operation], addOperationAsSubcommand: false };
    }
    if (domain === 'research') {
      return { command: 'research', addOperationAsSubcommand: true };
    }

    // System domain
    const systemOps: Record<string, string> = {
      version: 'version', config: 'config', 'config.show': 'config',
      'config.get': 'config', 'config.set': 'config',
      backup: 'backup', cleanup: 'cleanup', health: 'doctor',
      stats: 'stats', context: 'context',
    };
    if (domain === 'system' && systemOps[operation]) {
      return { command: systemOps[operation], addOperationAsSubcommand: false };
    }

    // Validate domain
    if (domain === 'validate' && operation === 'compliance') {
      return { command: 'compliance', addOperationAsSubcommand: false };
    }
    if (domain === 'validate') {
      return { command: 'validate', addOperationAsSubcommand: false };
    }

    // Version (pseudo-domain)
    if (domain === 'version') {
      return { command: 'version', addOperationAsSubcommand: false };
    }

    // Default: domain as command, operation as subcommand
    return { command: domain, addOperationAsSubcommand: true };
  }

  /**
   * Execute a CLEO CLI command.
   *
   * Translates the test-friendly { domain, operation, args, flags } format
   * into the proper CLI invocation using the domain-to-command mapping.
   */
  async execute<T = unknown>(options: {
    domain: string;
    operation: string;
    args?: string[];
    flags?: Record<string, unknown>;
    cwd?: string;
    maxRetries?: number;
    sessionId?: string;
  }): Promise<ExecutorResult<T>> {
    const { domain, operation, args = [], flags = {}, cwd } = options;

    // Build CLI command using domain-to-command mapping
    const parts: string[] = [this.cliPath];
    const mapping = this.mapToCliCommand(domain, operation);
    parts.push(mapping.command);
    if (mapping.addOperationAsSubcommand && operation) {
      parts.push(this.escapeArg(operation));
    }

    // Add positional arguments (escaped)
    for (const arg of args) {
      parts.push(this.escapeArg(arg));
    }

    // Convert flags to CLI flags
    for (const [key, value] of Object.entries(flags)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'boolean') {
        if (value) parts.push(`--${key}`);
        continue;
      }
      parts.push(`--${key}`, this.escapeArg(value as string | number | boolean));
    }

    const command = parts.join(' ');
    const retries = options.maxRetries ?? this.maxRetries;

    let lastResult: ExecutorResult<T> | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const startTime = Date.now();
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: this.timeout,
          env: { ...process.env },
          maxBuffer: 10 * 1024 * 1024,
        });

        const result = this.parseOutput<T>(stdout, stderr, 0);
        result.duration = Date.now() - startTime;
        if (result.success || attempt >= retries) return result;
        lastResult = result;
      } catch (err: any) {
        const stdout = err.stdout || '';
        const stderr = err.stderr || '';
        // Note: exec() is used here intentionally for test CLI execution
        // child_process errors: exit code may be in err.code (number)
        // or err.status; err.code can also be an error string like 'ERR_...'
        const exitCode = typeof err.code === 'number' ? err.code
          : (typeof err.status === 'number' ? err.status : 1);
        const result = this.parseOutput<T>(stdout, stderr, exitCode);
        result.duration = Date.now() - startTime;
        if (attempt >= retries) return result;
        lastResult = result;
      }
    }

    return lastResult!;
  }

  /**
   * Extract a JSON object from mixed output (warnings + JSON).
   * CLI may prepend warning text (e.g., storage migration notices) before JSON.
   * Scans for each '{' in the output and tries to parse valid JSON from it.
   */
  private extractJson(output: string): string | null {
    const trimmed = output.trim();
    if (!trimmed) return null;

    // If it starts with '{', try it directly
    if (trimmed.startsWith('{')) {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        // May have trailing content
      }
    }

    // Scan for JSON objects by finding each '{' and trying to parse
    let searchFrom = 0;
    while (searchFrom < trimmed.length) {
      const bracePos = trimmed.indexOf('{', searchFrom);
      if (bracePos === -1) break;

      const candidate = trimmed.slice(bracePos).trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Not valid JSON from this position, try next '{'
        searchFrom = bracePos + 1;
      }
    }

    return null;
  }

  /**
   * Parse CLI stdout into an ExecutorResult.
   * Matches the behavior of the deleted src/mcp/lib/executor.ts parseOutput method.
   */
  private parseOutput<T>(stdout: string, stderr: string, exitCode: number): ExecutorResult<T> {
    // Fall back to stderr when stdout is empty (some commands output JSON to stderr)
    // Extract JSON from mixed output (CLI may prepend warnings before JSON)
    const rawOutput = this.extractJson(stdout) || this.extractJson(stderr) || (stdout.trim() || stderr.trim());

    if (!rawOutput) {
      if (exitCode === 0) {
        return { success: true, data: undefined as T, stdout, stderr, exitCode };
      }
      return {
        success: false,
        error: { code: 'E_UNKNOWN', message: stderr.trim() || 'Command failed with no output' },
        stdout,
        stderr,
        exitCode,
      };
    }

    try {
      const parsed = JSON.parse(rawOutput);

      if (typeof parsed === 'object' && parsed !== null && 'success' in parsed) {
        if (parsed.success === true) {
          // Extract payload from V2 (.data), LAFS (.result), or V1 (top-level)
          const rawPayload = parsed.data ?? parsed.result ?? parsed;
          const unwrapped = this.unwrapPrimaryField(rawPayload);
          return {
            success: true,
            data: unwrapped as T,
            stdout,
            stderr,
            exitCode,
          };
        }

        // Structured error response
        // V2 CLI uses numeric codes (e.g., {code: 4}) matching ExitCode enum.
        // Normalize to string error codes (E_NOT_FOUND) for compatibility.
        let errorCode = parsed.error?.code;
        if (typeof errorCode === 'number') {
          const name = parsed.error?.name || EXIT_CODE_NAMES[errorCode];
          errorCode = name ? `E_${name}` : `E_EXIT_${errorCode}`;
        }
        const errorExitCode = typeof parsed.error?.code === 'number'
          ? parsed.error.code
          : (parsed.error?.exitCode || exitCode);

        return {
          success: false,
          error: {
            code: errorCode || 'E_UNKNOWN',
            exitCode: errorExitCode,
            message: parsed.error?.message || 'Command failed',
            details: parsed.error?.details,
          },
          stdout,
          stderr,
          exitCode,
        };
      }

      // JSON without success field - treat as data
      return {
        success: exitCode === 0,
        data: parsed as T,
        stdout,
        stderr,
        exitCode,
      };
    } catch {
      // Non-JSON output
      if (exitCode === 0) {
        return { success: true, data: stdout.trim() as T, stdout, stderr, exitCode };
      }
      return {
        success: false,
        error: {
          code: 'E_UNKNOWN',
          message: stderr.trim() || stdout.trim() || 'Command failed',
        },
        stdout,
        stderr,
        exitCode,
      };
    }
  }

  /**
   * Unwrap primary payload fields.
   * E.g. {tasks: [...]} -> [...], but {task: {id,...}, duplicate: true} stays as-is.
   */
  private unwrapPrimaryField(payload: any): any {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }

    const primaryFields = [
      'task', 'tasks', 'session', 'sessions', 'matches', 'results',
      'result', 'focus', 'entries', 'stages', 'summary',
    ];

    const metaKeys = new Set([
      'total', 'filtered', 'count', 'query', 'searchType',
      'message', 'mode', 'initialized', 'directory', 'created',
      'skipped', 'duplicate',
    ]);

    const found = primaryFields.find((f) => payload[f] !== undefined);
    if (!found) return payload;

    if (Array.isArray(payload[found])) {
      return payload[found];
    }

    const companions = Object.keys(payload).filter(
      (k) => k !== found && !metaKeys.has(k),
    );
    if (companions.length === 0) {
      return payload[found];
    }

    return payload;
  }

  /**
   * Get CLEO version.
   */
  async getVersion(): Promise<string> {
    const result = await this.execute<any>({
      domain: 'version',
      operation: '',
    });
    if (result.success && result.data?.version) {
      return result.data.version;
    }
    // Try parsing from stdout directly
    const match = result.stdout?.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  }

  /**
   * Test CLI connectivity.
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.execute({ domain: 'version', operation: '' });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}

/**
 * Create a CLIExecutor instance.
 */
function createExecutor(cliPath: string, timeout?: number, maxRetries?: number): CLIExecutor {
  return new CLIExecutor(cliPath, timeout, maxRetries);
}

// ---------------------------------------------------------------------------
// Payload unwrapping helpers (exported for use by other test utilities)
// ---------------------------------------------------------------------------

/**
 * Extract the actual payload from an executor result's data field.
 *
 * The LAFS envelope format uses `result` instead of `data` for the payload.
 * When the executor encounters `{success:true, result:{...}}`, it may place
 * the full envelope into `ExecutorResult.data` because it doesn't recognize
 * `result` as the payload wrapper. This helper unwraps that case.
 */
export function unwrapPayload<T = unknown>(data: any): T {
  if (data && typeof data === 'object' && !Array.isArray(data) && 'result' in data && 'success' in data) {
    // data is the full LAFS envelope — unwrap .result, then apply primary-field extraction
    const payload = data.result;
    return unwrapPrimaryField(payload) as T;
  }
  return data as T;
}

/**
 * Mirror the executor's primary-field unwrapping for a payload object.
 * E.g. {tasks: [...]} -> [...], {task: {...}} -> {task: {...}} (kept if no companions).
 */
function unwrapPrimaryField(payload: any): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const primaryPayloadFields = [
    'task', 'tasks', 'session', 'sessions', 'matches', 'results',
    'result', 'focus', 'entries', 'stages', 'summary',
  ];

  const metaKeys = new Set([
    'total', 'filtered', 'count', 'query', 'searchType',
    'message', 'mode', 'initialized', 'directory', 'created',
    'skipped', 'duplicate',
  ]);

  const found = primaryPayloadFields.find((f) => payload[f] !== undefined);
  if (!found) return payload;

  if (Array.isArray(payload[found])) {
    return payload[found];
  }

  const companions = Object.keys(payload).filter(
    (k) => k !== found && !metaKeys.has(k),
  );
  if (companions.length === 0) {
    return payload[found];
  }

  return payload;
}

/**
 * Wrapped executor that automatically uses project root as cwd
 * and unwraps LAFS envelope payloads.
 */
class WrappedExecutor {
  constructor(
    private executor: CLIExecutor,
    private defaultCwd: string
  ) {}

  async execute<T = unknown>(options: any): Promise<any> {
    // Always use project root as cwd unless explicitly overridden
    const result = await this.executor.execute<T>({
      ...options,
      cwd: options.cwd || this.defaultCwd,
    });
    // Unwrap LAFS envelope if the executor didn't handle `result` field
    if (result.success && result.data) {
      result.data = unwrapPayload(result.data);
    }
    return result;
  }

  async getVersion(): Promise<string> {
    return this.executor.getVersion();
  }

  async testConnection(): Promise<boolean> {
    return this.executor.testConnection();
  }
}

/**
 * Test context for integration tests
 */
export interface IntegrationTestContext {
  /** CLI executor instance (wrapped to use project root) */
  executor: WrappedExecutor;

  /** Test session ID */
  sessionId: string;

  /** Test epic ID for scoped operations */
  epicId?: string;

  /** Created task IDs for cleanup */
  createdTaskIds: string[];

  /** Project root (isolated temp directory) */
  originalCwd: string;

  /** Test data directory */
  testDataDir: string;

  /** Isolated test environment handle */
  testEnv: TestEnvironment;
}

/**
 * Setup integration test context with isolated CLEO environment
 */
export async function setupIntegrationTest(): Promise<IntegrationTestContext> {
  // Create isolated test environment
  const testEnv = await createTestEnvironment();

  const cliPath = testEnv.cliPath;
  const projectRoot = testEnv.projectRoot;

  const executor = createExecutor(cliPath, 60000, 1); // 60s timeout, no retries

  // Verify CLI is accessible
  const canConnect = await executor.testConnection();
  if (!canConnect) {
    throw new Error(
      `Cannot connect to CLEO CLI at ${cliPath}. ` +
        `Ensure CLEO is installed and the path is correct. ` +
        `You can set CLEO_CLI_PATH environment variable to specify the CLI location.`
    );
  }

  // Wrap executor to automatically use the isolated project root as cwd
  const wrappedExecutor = new WrappedExecutor(executor, projectRoot);

  const testDataDir = path.join(projectRoot, '__test_data__');
  await fs.mkdir(testDataDir, { recursive: true });

  const sessionId = `test_session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  return {
    executor: wrappedExecutor,
    sessionId,
    epicId: testEnv.epicId,
    createdTaskIds: [...testEnv.taskIds],
    originalCwd: projectRoot,
    testDataDir,
    testEnv,
  };
}

/**
 * Cleanup integration test resources
 */
export async function cleanupIntegrationTest(context: IntegrationTestContext | undefined | null): Promise<void> {
  if (!context) {
    return;
  }

  // End any active session
  try {
    await context.executor.execute({
      domain: 'session',
      operation: 'end',
      flags: { note: 'Test cleanup', json: true },
      maxRetries: 1,
      cwd: context.originalCwd,
    });
  } catch {
    // Ignore if session not active
  }

  // Destroy isolated test environment
  if (context.testEnv) {
    await destroyTestEnvironment(context.testEnv);
  }
}

/**
 * Create a test task and track for cleanup
 */
export async function createTestTask(
  context: IntegrationTestContext,
  title: string,
  description: string,
  options?: {
    parent?: string;
    status?: string;
    priority?: string;
    labels?: string[];
  }
): Promise<string> {
  const result = await context.executor.execute<any>({
    domain: 'tasks',
    operation: 'add',
    args: [title],
    flags: {
      description,
      parent: options?.parent,
      status: options?.status || 'pending',
      priority: options?.priority,
      labels: options?.labels?.join(','),
      json: true,
    },
    sessionId: context.sessionId,
    cwd: context.originalCwd,
  });

  // CLEO CLI returns {success: true, task: {id: "T..."}} as payload.
  // The executor strips envelope fields and may unwrap single payload keys.
  // Handle both unwrapped (data = {id, ...}) and non-unwrapped (data = {task: {id, ...}}) cases.
  const taskId = result.data?.task?.id || result.data?.taskId || result.data?.id;

  if (!result.success || !taskId) {
    throw new Error(
      `Failed to create test task: ${result.error?.message || 'No task ID in response'}` +
      (result.stdout ? ` (stdout: ${result.stdout.substring(0, 200)})` : '')
    );
  }

  context.createdTaskIds.push(taskId);
  return taskId;
}

/**
 * Create a test epic (task without parent)
 */
export async function createTestEpic(
  context: IntegrationTestContext,
  title: string,
  description: string
): Promise<string> {
  const epicId = await createTestTask(context, title, description, {
    labels: ['epic'],
  });
  context.epicId = epicId;
  return epicId;
}

/**
 * Start a test session
 */
export async function startTestSession(
  context: IntegrationTestContext,
  epicId: string
): Promise<void> {
  const result = await context.executor.execute({
    domain: 'session',
    operation: 'start',
    flags: {
      scope: `epic:${epicId}`,
      'auto-focus': true,
      name: `Integration Test ${context.sessionId}`,
      json: true,
    },
    cwd: context.originalCwd,
  });

  if (!result.success) {
    // Session start may fail if enforcement is disabled - that's ok for tests
    if (result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed.sessionId || parsed.session?.sessionId) {
          context.sessionId = parsed.sessionId || parsed.session?.sessionId;
          return;
        }
      } catch {
        // Ignore parse errors
      }
    }
    // Don't throw - tests can work without sessions when enforcement is disabled
    return;
  }

  // Update context with the real session ID from CLEO
  const sessionData = result.data as any;
  if (sessionData?.sessionId) {
    context.sessionId = sessionData.sessionId;
  } else if (sessionData?.session?.sessionId) {
    context.sessionId = sessionData.session.sessionId;
  } else if (sessionData?.id) {
    context.sessionId = sessionData.id;
  } else if (result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      const payload = parsed.result ?? parsed.data ?? parsed;
      if (payload.sessionId) {
        context.sessionId = payload.sessionId;
      } else if (payload.session?.sessionId) {
        context.sessionId = payload.session.sessionId;
      }
    } catch {
      // Ignore parse errors - keep existing sessionId
    }
  }
}

/**
 * Get current CLEO version
 */
export async function getCleoVersion(executor: WrappedExecutor): Promise<string> {
  return executor.getVersion();
}

/**
 * Check if a task exists
 */
export async function taskExists(
  executor: WrappedExecutor,
  taskId: string,
  cwd?: string
): Promise<boolean> {
  const result = await executor.execute<{ exists: boolean }>({
    domain: 'tasks',
    operation: 'exists',
    args: [taskId],
    flags: { json: true },
    maxRetries: 1,
    cwd,
  });

  return result.success && result.data?.exists === true;
}

/**
 * Wait for a condition to be true (polling helper)
 */
export async function waitForCondition(
  condition: () => Promise<boolean>,
  options?: {
    timeout?: number;
    interval?: number;
    errorMessage?: string;
  }
): Promise<void> {
  const timeout = options?.timeout || 10000;
  const interval = options?.interval || 500;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    options?.errorMessage || `Condition not met within ${timeout}ms`
  );
}

/**
 * Capture audit log entries from the isolated test environment.
 * CLEO stores audit logs in .cleo/todo-log.jsonl as a JSON object with an "entries" array.
 */
export async function getAuditLogEntries(
  projectRootOrTestDataDir: string,
  filter?: {
    domain?: string;
    operation?: string;
    sessionId?: string;
    action?: string;
  }
): Promise<any[]> {
  // Try the given path directly, then try parent (in case testDataDir was passed).
  // The log file may be named 'tasks-log.jsonl' (current) or 'todo-log.jsonl' (legacy).
  const candidates = [
    path.join(projectRootOrTestDataDir, '.cleo', 'tasks-log.jsonl'),
    path.join(projectRootOrTestDataDir, '.cleo', 'todo-log.jsonl'),
    path.join(projectRootOrTestDataDir, '..', '.cleo', 'tasks-log.jsonl'),
    path.join(projectRootOrTestDataDir, '..', '.cleo', 'todo-log.jsonl'),
  ];

  for (const logPath of candidates) {
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      let entries: any[] = [];

      // Try parsing as JSON first (initial format with entries array)
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.entries)) {
          entries = parsed.entries;
        } else {
          // Not the expected {entries:[]} format - fall through to JSONL
          throw new Error('Not entries format');
        }
      } catch {
        // Hybrid format: JSON object followed by JSONL entries.
        // Parse each line that looks like valid JSON.
        const lines = content.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{')) {
            try {
              const entry = JSON.parse(trimmed);
              // Skip the initial JSON object (it has "entries" key)
              if (entry.action || entry.taskId) {
                entries.push(entry);
              } else if (Array.isArray(entry.entries)) {
                entries.push(...entry.entries);
              }
            } catch {
              // Skip malformed lines
            }
          }
        }
      }

      if (!filter) {
        return entries;
      }

      return entries.filter((entry: any) => {
        if (filter.action && entry.action !== filter.action) return false;
        // CLEO logs actions like "task_created", "task_updated" etc.
        // Match domain by checking if action contains the domain
        if (filter.domain && !entry.action?.includes(filter.domain)) return false;
        if (filter.operation && !entry.action?.includes(filter.operation)) return false;
        if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
        return true;
      });
    } catch {
      continue;
    }
  }

  return [];
}

/**
 * Create a manifest entry fixture
 */
export function createManifestEntry(taskId: string, overrides?: any): any {
  return {
    id: `${taskId}-integration-test`,
    file: `test-output/${taskId}.md`,
    title: `Integration Test Output for ${taskId}`,
    date: new Date().toISOString().split('T')[0],
    status: 'completed',
    agent_type: 'testing',
    topics: ['integration', 'testing', 'mcp'],
    key_findings: [
      'Gateway validation passed',
      'Domain routing successful',
      'CLI execution completed',
    ],
    actionable: true,
    needs_followup: [],
    linked_tasks: [taskId],
    ...overrides,
  };
}

/**
 * Verify response format matches specification.
 *
 * Note: The response here is an ExecutorResult, not the raw MCP gateway
 * envelope. The executor parses CLI output and populates its own fields.
 * Gateway-level _meta is only present in the raw stdout, not the executor result.
 */
export function verifyResponseFormat(
  response: any,
  _expectedGateway: 'cleo_query' | 'cleo_mutate',
  _expectedDomain: string,
  _expectedOperation: string
): void {
  // Verify success field exists
  expect(typeof response.success).toBe('boolean');

  // If successful, should have data (or result via LAFS)
  if (response.success) {
    expect(response.data ?? response.result).toBeDefined();
  } else {
    // If failed, should have error
    expect(response.error).toBeDefined();
    expect(response.error.code).toBeDefined();
    expect(response.error.message).toBeDefined();
  }
}

/**
 * Mock expect for TypeScript (when running without Jest in this context)
 */
function expect(value: any) {
  return {
    toBeDefined: () => {
      if (value === undefined || value === null) {
        throw new Error(`Expected value to be defined, got ${value}`);
      }
    },
    toBe: (expected: any) => {
      if (value !== expected) {
        throw new Error(`Expected ${value} to be ${expected}`);
      }
    },
  };
}
