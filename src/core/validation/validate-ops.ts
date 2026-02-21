/**
 * Core validation operations - business logic extracted from validate-engine.ts.
 *
 * These are pure business logic functions that throw on failure and return
 * data directly (no EngineResult wrapper). The engine layer wraps these
 * in try/catch to produce EngineResult.
 *
 * @task T4786
 * @epic T4654
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { getManifestPath as getCentralManifestPath } from '../paths.js';
import { getAccessor } from '../../store/data-accessor.js';
import { validateSchema as ajvValidateSchema, type SchemaType } from '../../mcp/engine/schema-validator.js';
import {
  validateTitleDescription,
  validateTimestamps,
  validateIdUniqueness,
  validateNoDuplicateDescription,
  validateHierarchy,
  hasErrors,
  type RuleViolation,
} from '../../mcp/engine/validation-rules.js';
import { detectCircularDeps } from '../tasks/dependency-check.js';
import type { Task } from '../../types/task.js';

// ============================================================================
// Types
// ============================================================================

/** Compliance entry stored in COMPLIANCE.jsonl */
export interface ComplianceEntry {
  timestamp: string;
  taskId: string;
  protocol: string;
  result: 'pass' | 'fail' | 'partial';
  violations?: Array<{
    code: string;
    message: string;
    severity: 'error' | 'warning';
  }>;
  linkedTask?: string;
  agent?: string;
}

/** Task-like record used across validation operations. */
interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  type?: string;
  phase?: string;
  createdAt: string;
  updatedAt: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  parentId?: string | null;
  depends?: string[];
  relates?: Array<{ taskId: string; type: string; reason?: string }>;
  files?: string[];
  acceptance?: string[];
  notes?: string[];
  labels?: string[];
  [key: string]: unknown;
}

/** Coherence issue found during graph validation. */
export interface CoherenceIssue {
  type: string;
  taskId: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

// ============================================================================
// Schema Validation
// ============================================================================

/** Read a JSON file, returning parsed data or null. */
function readJsonFile<T = unknown>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Validate data against a JSON schema type.
 * @task T4786
 */
export function coreValidateSchema(
  type: string,
  data: unknown | undefined,
  projectRoot: string,
): { type: string; valid: boolean; errors: unknown[]; errorCount: number } {
  if (!type) {
    throw new Error('type is required (todo, config, archive, log)');
  }

  let dataToValidate = data;
  if (!dataToValidate) {
    const fileMap: Record<string, string> = {
      todo: '.cleo/todo.json',
      config: '.cleo/config.json',
      archive: '.cleo/todo-archive.json',
      log: '.cleo/todo-log.jsonl',
    };

    const filePath = fileMap[type];
    if (!filePath) {
      throw new Error(`Unknown schema type: ${type}. Valid types: ${Object.keys(fileMap).join(', ')}`);
    }

    const fullPath = join(projectRoot, filePath);
    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    dataToValidate = readJsonFile(fullPath);
  }

  const result = ajvValidateSchema(type as SchemaType, dataToValidate);
  return {
    type,
    valid: result.valid,
    errors: result.errors,
    errorCount: result.errors.length,
  };
}

// ============================================================================
// Task Validation (Anti-Hallucination)
// ============================================================================

/**
 * Validate a single task against anti-hallucination rules.
 * @task T4786
 */
export async function coreValidateTask(
  taskId: string,
  projectRoot: string,
): Promise<{
  taskId: string;
  valid: boolean;
  violations: RuleViolation[];
  errorCount: number;
  warningCount: number;
}> {
  if (!taskId) {
    throw new Error('taskId is required');
  }

  const accessor = await getAccessor(projectRoot);
  const todoData = await accessor.loadTaskFile() as unknown as { tasks: TaskRecord[] };
  const archiveData = await accessor.loadArchive() as unknown as { tasks: TaskRecord[] } | null;

  if (!todoData) {
    throw new Error('todo.json not found');
  }

  const allTasks = [
    ...(todoData.tasks || []),
    ...(archiveData?.tasks || []),
  ];

  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const violations: RuleViolation[] = [];

  violations.push(...validateTitleDescription(task.title, task.description));
  violations.push(...validateTimestamps(task as any));

  const allIds = new Set(allTasks.map((t) => t.id));
  violations.push(...validateIdUniqueness(task.id, allIds));

  const allDescriptions = allTasks
    .filter((t) => t.id !== task.id)
    .map((t) => t.description);
  violations.push(...validateNoDuplicateDescription(task.description, allDescriptions));

  if (task.parentId) {
    const parent = allTasks.find((t) => t.id === task.parentId);
    if (parent) {
      violations.push(...validateHierarchy(task.parentId, allTasks as any));
    }
  }

  return {
    taskId,
    valid: !hasErrors(violations),
    violations,
    errorCount: violations.filter((v) => v.severity === 'error').length,
    warningCount: violations.filter((v) => v.severity === 'warning').length,
  };
}

// ============================================================================
// Protocol Validation
// ============================================================================

/**
 * Check basic protocol compliance for a task.
 * @task T4786
 */
export async function coreValidateProtocol(
  taskId: string,
  protocolType: string | undefined,
  projectRoot: string,
): Promise<{
  taskId: string;
  protocolType: string;
  compliant: boolean;
  violations: Array<{ code: string; message: string; severity: string }>;
}> {
  if (!taskId) {
    throw new Error('taskId is required');
  }

  const accessor = await getAccessor(projectRoot);
  const todoData = await accessor.loadTaskFile() as unknown as { tasks: TaskRecord[] };

  if (!todoData) {
    throw new Error('todo.json not found');
  }

  const task = todoData.tasks?.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const violations: Array<{ code: string; message: string; severity: string }> = [];

  if (!task.title) {
    violations.push({ code: 'P_MISSING_TITLE', message: 'Task title is missing', severity: 'error' });
  }
  if (!task.description) {
    violations.push({ code: 'P_MISSING_DESCRIPTION', message: 'Task description is missing', severity: 'error' });
  }
  if (task.title === task.description) {
    violations.push({ code: 'P_SAME_TITLE_DESC', message: 'Title and description must be different', severity: 'error' });
  }

  const validStatuses = ['pending', 'active', 'blocked', 'done', 'cancelled'];
  if (!validStatuses.includes(task.status)) {
    violations.push({
      code: 'P_INVALID_STATUS',
      message: `Invalid status: ${task.status}. Valid: ${validStatuses.join(', ')}`,
      severity: 'error',
    });
  }

  return {
    taskId,
    protocolType: protocolType || 'generic',
    compliant: violations.filter((v) => v.severity === 'error').length === 0,
    violations,
  };
}

// ============================================================================
// Manifest Validation
// ============================================================================

/**
 * Validate manifest JSONL entries for required fields.
 * @task T4786
 */
export function coreValidateManifest(
  projectRoot: string,
): {
  valid: boolean;
  totalEntries: number;
  validEntries: number;
  invalidEntries: number;
  errors: Array<{ line: number; entryId: string; errors: string[] }>;
  message?: string;
} {
  const manifestPath = getCentralManifestPath(projectRoot);

  if (!existsSync(manifestPath)) {
    return {
      valid: true,
      totalEntries: 0,
      validEntries: 0,
      invalidEntries: 0,
      errors: [],
      message: 'No manifest file found',
    };
  }

  const content = readFileSync(manifestPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  let validCount = 0;
  let invalidCount = 0;
  const errors: Array<{ line: number; entryId: string; errors: string[] }> = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]!);
      const entryErrors: string[] = [];

      if (!entry.id) entryErrors.push('missing id');
      if (!entry.file) entryErrors.push('missing file');
      if (!entry.title) entryErrors.push('missing title');
      if (!entry.date) entryErrors.push('missing date');
      if (!entry.status) entryErrors.push('missing status');
      if (!entry.agent_type) entryErrors.push('missing agent_type');
      if (!entry.topics) entryErrors.push('missing topics');
      if (entry.actionable === undefined) entryErrors.push('missing actionable');

      if (entryErrors.length > 0) {
        invalidCount++;
        errors.push({ line: i + 1, entryId: entry.id || `line-${i + 1}`, errors: entryErrors });
      } else {
        validCount++;
      }
    } catch {
      invalidCount++;
      errors.push({ line: i + 1, entryId: `line-${i + 1}`, errors: ['invalid JSON'] });
    }
  }

  return {
    valid: invalidCount === 0,
    totalEntries: lines.length,
    validEntries: validCount,
    invalidEntries: invalidCount,
    errors,
  };
}

// ============================================================================
// Output Validation
// ============================================================================

/**
 * Validate an output file for required sections.
 * @task T4786
 */
export function coreValidateOutput(
  filePath: string,
  taskId: string | undefined,
  projectRoot: string,
): {
  filePath: string;
  valid: boolean;
  issues: Array<{ code: string; message: string; severity: string }>;
  fileSize: number;
  lineCount: number;
} {
  if (!filePath) {
    throw new Error('filePath is required');
  }

  const fullPath = resolve(projectRoot, filePath);

  if (!existsSync(fullPath)) {
    throw new Error(`Output file not found: ${filePath}`);
  }

  const content = readFileSync(fullPath, 'utf-8');
  const issues: Array<{ code: string; message: string; severity: string }> = [];

  if (!content.includes('# ')) {
    issues.push({ code: 'O_MISSING_TITLE', message: 'Output file should have a markdown title', severity: 'warning' });
  }

  if (taskId && !content.includes(taskId)) {
    issues.push({ code: 'O_MISSING_TASK_REF', message: `Output file should reference task ${taskId}`, severity: 'warning' });
  }

  if (!content.includes('## Summary') && !content.includes('## summary')) {
    issues.push({ code: 'O_MISSING_SUMMARY', message: 'Output file should have a Summary section', severity: 'warning' });
  }

  return {
    filePath,
    valid: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
    fileSize: content.length,
    lineCount: content.split('\n').length,
  };
}

// ============================================================================
// Compliance Summary
// ============================================================================

/** Parse COMPLIANCE.jsonl entries. */
function parseComplianceEntries(projectRoot: string): ComplianceEntry[] {
  const compliancePath = join(projectRoot, '.cleo', 'metrics', 'COMPLIANCE.jsonl');

  if (!existsSync(compliancePath)) {
    return [];
  }

  const content = readFileSync(compliancePath, 'utf-8');
  const entries: ComplianceEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }

  return entries;
}

/**
 * Get aggregated compliance metrics.
 * @task T4786
 */
export function coreComplianceSummary(
  projectRoot: string,
): {
  total: number;
  pass: number;
  fail: number;
  partial: number;
  passRate: number;
  byProtocol: Record<string, { pass: number; fail: number; partial: number }>;
} {
  const entries = parseComplianceEntries(projectRoot);

  const pass = entries.filter((e) => e.result === 'pass').length;
  const fail = entries.filter((e) => e.result === 'fail').length;
  const partial = entries.filter((e) => e.result === 'partial').length;
  const total = entries.length;

  const byProtocol: Record<string, { pass: number; fail: number; partial: number }> = {};
  for (const entry of entries) {
    if (!byProtocol[entry.protocol]) {
      byProtocol[entry.protocol] = { pass: 0, fail: 0, partial: 0 };
    }
    byProtocol[entry.protocol]![entry.result]++;
  }

  return {
    total,
    pass,
    fail,
    partial,
    passRate: total > 0 ? Math.round((pass / total) * 100) : 0,
    byProtocol,
  };
}

// ============================================================================
// Compliance Violations
// ============================================================================

/**
 * List compliance violations.
 * @task T4786
 */
export function coreComplianceViolations(
  limit: number | undefined,
  projectRoot: string,
): {
  violations: Array<{
    timestamp: string;
    taskId: string;
    protocol: string;
    result: string;
    violations?: ComplianceEntry['violations'];
  }>;
  total: number;
} {
  const entries = parseComplianceEntries(projectRoot);
  let violations = entries.filter((e) => e.result === 'fail' || e.result === 'partial');

  if (limit && limit > 0) {
    violations = violations.slice(-limit);
  }

  return {
    violations: violations.map((v) => ({
      timestamp: v.timestamp,
      taskId: v.taskId,
      protocol: v.protocol,
      result: v.result,
      violations: v.violations,
    })),
    total: violations.length,
  };
}

// ============================================================================
// Compliance Record
// ============================================================================

/**
 * Record a compliance check result to COMPLIANCE.jsonl.
 * @task T4786
 */
export function coreComplianceRecord(
  taskId: string,
  result: string,
  protocol: string | undefined,
  violations: Array<{ code: string; message: string; severity: string }> | undefined,
  projectRoot: string,
): { recorded: boolean; taskId: string; result: string; protocol: string } {
  if (!taskId || !result) {
    throw new Error('taskId and result are required');
  }

  const validResults = ['pass', 'fail', 'partial'];
  if (!validResults.includes(result)) {
    throw new Error(`Invalid result: ${result}. Valid: ${validResults.join(', ')}`);
  }

  const compliancePath = join(projectRoot, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
  const dir = dirname(compliancePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const entry: ComplianceEntry = {
    timestamp: new Date().toISOString(),
    taskId,
    protocol: protocol || 'generic',
    result: result as 'pass' | 'fail' | 'partial',
    violations: violations as any,
    linkedTask: taskId,
  };

  appendFileSync(compliancePath, JSON.stringify(entry) + '\n', 'utf-8');

  return {
    recorded: true,
    taskId,
    result,
    protocol: protocol || 'generic',
  };
}

// ============================================================================
// Test Status
// ============================================================================

/**
 * Check test suite availability.
 * @task T4786
 */
export function coreTestStatus(
  projectRoot: string,
): {
  batsTests: { available: boolean; directory: string | null };
  mcpTests: { available: boolean; directory: string | null };
  message: string;
} {
  const testDir = join(projectRoot, 'tests');
  const mcpTestDir = join(projectRoot, 'mcp-server', 'src', '__tests__');

  const hasBatsTests = existsSync(testDir);
  const hasMcpTests = existsSync(mcpTestDir);

  return {
    batsTests: {
      available: hasBatsTests,
      directory: hasBatsTests ? 'tests/' : null,
    },
    mcpTests: {
      available: hasMcpTests,
      directory: hasMcpTests ? 'mcp-server/src/__tests__/' : null,
    },
    message: 'Use validate.test.run to execute tests',
  };
}

// ============================================================================
// Coherence Check
// ============================================================================

/**
 * Cross-validate task graph for consistency.
 * @task T4786
 */
export async function coreCoherenceCheck(
  projectRoot: string,
): Promise<{ coherent: boolean; issues: CoherenceIssue[] }> {
  const accessor = await getAccessor(projectRoot);
  const todoData = await accessor.loadTaskFile() as unknown as { tasks: TaskRecord[] };

  if (!todoData || !todoData.tasks) {
    throw new Error('No todo.json found');
  }

  const tasks = todoData.tasks;
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const issues: CoherenceIssue[] = [];

  // 1. Done tasks with incomplete subtasks
  for (const task of tasks) {
    if (task.status === 'done') {
      const incompleteChildren = tasks.filter(
        (t) => t.parentId === task.id && t.status !== 'done' && t.status !== 'cancelled',
      );
      for (const child of incompleteChildren) {
        issues.push({
          type: 'done_with_incomplete_subtask',
          taskId: task.id,
          message: `Task ${task.id} is done but child ${child.id} ("${child.title}") has status "${child.status}"`,
          severity: 'error',
        });
      }
    }
  }

  // 2. Dependency cycles
  const reportedCycles = new Set<string>();
  for (const task of tasks) {
    if (task.depends && task.depends.length > 0) {
      const cycle = detectCircularDeps(task.id, tasks as unknown as Task[]);
      if (cycle.length > 0) {
        const cycleKey = [...cycle].sort().join(',');
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          issues.push({
            type: 'dependency_cycle',
            taskId: task.id,
            message: `Dependency cycle detected: ${cycle.join(' -> ')}`,
            severity: 'error',
          });
        }
      }
    }
  }

  // 3. Orphaned references
  for (const task of tasks) {
    if (task.depends) {
      for (const depId of task.depends) {
        if (!taskMap.has(depId)) {
          issues.push({
            type: 'orphaned_dependency',
            taskId: task.id,
            message: `Task ${task.id} depends on non-existent task ${depId}`,
            severity: 'error',
          });
        }
      }
    }
  }

  // 4. Stale tasks
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const task of tasks) {
    if (task.status === 'active') {
      const lastUpdate = task.updatedAt || task.createdAt;
      if (lastUpdate) {
        const ageMs = now - new Date(lastUpdate).getTime();
        if (ageMs > thirtyDaysMs) {
          const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
          issues.push({
            type: 'stale_task',
            taskId: task.id,
            message: `Task ${task.id} has been active for ${ageDays} days without update`,
            severity: 'warning',
          });
        }
      }
    }
  }

  // 5. Status inconsistencies
  for (const task of tasks) {
    if (task.parentId && (task.status === 'active' || task.status === 'pending')) {
      const parent = taskMap.get(task.parentId);
      if (parent && (parent.status === 'done' || parent.status === 'cancelled')) {
        issues.push({
          type: 'status_inconsistency',
          taskId: task.id,
          message: `Task ${task.id} is "${task.status}" but parent ${parent.id} is "${parent.status}"`,
          severity: 'error',
        });
      }
    }
  }

  // 6. Duplicate titles
  const titleMap = new Map<string, string[]>();
  for (const task of tasks) {
    const titleLower = task.title.toLowerCase().trim();
    if (!titleMap.has(titleLower)) {
      titleMap.set(titleLower, []);
    }
    titleMap.get(titleLower)!.push(task.id);
  }
  for (const [title, ids] of titleMap) {
    if (ids.length > 1) {
      issues.push({
        type: 'duplicate_title',
        taskId: ids[0]!,
        message: `Duplicate title "${title}" found on tasks: ${ids.join(', ')}`,
        severity: 'info',
      });
    }
  }

  return {
    coherent: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
  };
}

// ============================================================================
// Test Run
// ============================================================================

/**
 * Execute test suite via subprocess.
 * @task T4786
 */
export function coreTestRun(
  params: { scope?: string; pattern?: string; parallel?: boolean } | undefined,
  projectRoot: string,
): {
  ran: boolean;
  runner?: string;
  output?: unknown;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  passed?: boolean;
  message?: string;
} {
  const hasVitest = existsSync(join(projectRoot, 'node_modules', '.bin', 'vitest'));
  const hasBats = existsSync(join(projectRoot, 'tests'));

  if (!hasVitest && !hasBats) {
    return {
      ran: false,
      message: 'No test runner found (vitest or bats tests/ directory)',
    };
  }

  try {
    const args: string[] = ['vitest', 'run', '--reporter=json'];

    if (params?.scope) {
      args.push(params.scope);
    }

    if (params?.pattern) {
      args.push('--testNamePattern', params.pattern);
    }

    const result = execFileSync('npx', args, {
      cwd: projectRoot,
      timeout: 120000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = null;
    }

    return {
      ran: true,
      runner: 'vitest',
      output: parsed || result.slice(0, 2000),
      exitCode: 0,
    };
  } catch (error: unknown) {
    const execError = error as { status?: number; stdout?: string; stderr?: string };
    return {
      ran: true,
      runner: 'vitest',
      exitCode: execError.status || 1,
      stdout: (execError.stdout || '').slice(0, 2000),
      stderr: (execError.stderr || '').slice(0, 2000),
      passed: false,
    };
  }
}

// ============================================================================
// Batch Validate
// ============================================================================

/**
 * Batch validate all tasks against schema and rules.
 * @task T4786
 */
export async function coreBatchValidate(
  projectRoot: string,
): Promise<{
  totalTasks: number;
  validTasks: number;
  invalidTasks: number;
  totalErrors: number;
  totalWarnings: number;
  results: Array<{
    taskId: string;
    valid: boolean;
    errorCount: number;
    warningCount: number;
    violations: RuleViolation[];
  }>;
}> {
  const accessor = await getAccessor(projectRoot);
  const todoData = await accessor.loadTaskFile() as unknown as { tasks: TaskRecord[] };

  if (!todoData) {
    throw new Error('todo.json not found');
  }

  const archiveData = await accessor.loadArchive() as unknown as { tasks: TaskRecord[] } | null;
  const allTasks = [
    ...(todoData.tasks || []),
    ...(archiveData?.tasks || []),
  ];

  const results: Array<{
    taskId: string;
    valid: boolean;
    errorCount: number;
    warningCount: number;
    violations: RuleViolation[];
  }> = [];

  let totalErrors = 0;
  let totalWarnings = 0;
  const allIds = new Set(allTasks.map((t) => t.id));
  const allDescriptions = allTasks.map((t) => t.description);

  for (const task of allTasks) {
    const violations: RuleViolation[] = [];

    violations.push(...validateTitleDescription(task.title, task.description));
    violations.push(...validateTimestamps(task as any));
    violations.push(...validateIdUniqueness(task.id, allIds));

    const otherDescs = allDescriptions.filter((_, i) => allTasks[i]!.id !== task.id);
    violations.push(...validateNoDuplicateDescription(task.description, otherDescs));

    if (task.parentId) {
      const parent = allTasks.find((t) => t.id === task.parentId);
      if (parent) {
        violations.push(...validateHierarchy(task.parentId, allTasks as any));
      }
    }

    const errors = violations.filter((v) => v.severity === 'error').length;
    const warnings = violations.filter((v) => v.severity === 'warning').length;
    totalErrors += errors;
    totalWarnings += warnings;

    results.push({
      taskId: task.id,
      valid: errors === 0,
      errorCount: errors,
      warningCount: warnings,
      violations,
    });
  }

  return {
    totalTasks: allTasks.length,
    validTasks: results.filter((r) => r.valid).length,
    invalidTasks: results.filter((r) => !r.valid).length,
    totalErrors,
    totalWarnings,
    results: results.filter((r) => !r.valid),
  };
}

// ============================================================================
// Test Coverage
// ============================================================================

/**
 * Get test coverage metrics.
 * @task T4786
 */
export function coreTestCoverage(
  projectRoot: string,
): { available: boolean; message?: string; [key: string]: unknown } {
  const coveragePath = join(projectRoot, 'mcp-server', 'coverage', 'coverage-summary.json');

  if (!existsSync(coveragePath)) {
    return {
      available: false,
      message: 'No coverage data found. Run tests with coverage first.',
    };
  }

  const coverageData = readJsonFile<Record<string, unknown>>(coveragePath);
  if (!coverageData) {
    throw new Error('Failed to read coverage data');
  }

  return {
    available: true,
    ...coverageData,
  };
}
