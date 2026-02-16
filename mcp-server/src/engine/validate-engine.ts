/**
 * Validate Engine
 *
 * Native TypeScript implementation of validate domain operations.
 * Handles schema validation, protocol compliance, task validation,
 * and compliance tracking.
 *
 * @task T4477
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { resolveProjectRoot, readJsonFile, getDataPath } from './store.js';
import { validateSchema as ajvValidateSchema, type SchemaType, type ValidationResult } from './schema-validator.js';
import {
  validateTitleDescription,
  validateTimestamps,
  validateIdUniqueness,
  validateNoDuplicateDescription,
  validateHierarchy,
  hasErrors,
  type RuleViolation,
} from './validation-rules.js';
import type { TaskRecord } from './task-engine.js';

/**
 * Engine result type
 */
interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * Compliance entry stored in COMPLIANCE.jsonl
 */
interface ComplianceEntry {
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

/**
 * validate.schema - JSON Schema validation
 * @task T4477
 */
export function validateSchemaOp(
  type: string,
  data?: unknown,
  projectRoot?: string
): EngineResult {
  if (!type) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'type is required (todo, config, archive, log)' } };
  }

  const root = projectRoot || resolveProjectRoot();

  // If no data provided, read from the default file
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
      return {
        success: false,
        error: {
          code: 'E_INVALID_TYPE',
          message: `Unknown schema type: ${type}. Valid types: ${Object.keys(fileMap).join(', ')}`,
        },
      };
    }

    const fullPath = join(root, filePath);
    if (!existsSync(fullPath)) {
      return {
        success: false,
        error: {
          code: 'E_NOT_FOUND',
          message: `File not found: ${filePath}`,
        },
      };
    }

    dataToValidate = readJsonFile(fullPath);
  }

  try {
    const result = ajvValidateSchema(type as SchemaType, dataToValidate);
    return {
      success: true,
      data: {
        type,
        valid: result.valid,
        errors: result.errors,
        errorCount: result.errors.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_VALIDATION_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * validate.task - Anti-hallucination task validation
 * @task T4477
 */
export function validateTask(
  taskId: string,
  projectRoot?: string
): EngineResult {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  const root = projectRoot || resolveProjectRoot();
  const todoPath = getDataPath(root, 'todo.json');
  const archivePath = getDataPath(root, 'todo-archive.json');

  const todoData = readJsonFile<{ tasks: TaskRecord[] }>(todoPath);
  const archiveData = readJsonFile<{ tasks: TaskRecord[] }>(archivePath);

  if (!todoData) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'todo.json not found' },
    };
  }

  const allTasks = [
    ...(todoData.tasks || []),
    ...(archiveData?.tasks || []),
  ];

  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Task ${taskId} not found` },
    };
  }

  // Run anti-hallucination checks
  const violations: RuleViolation[] = [];

  // Title/description check
  violations.push(...validateTitleDescription(task.title, task.description));

  // Timestamp check
  violations.push(...validateTimestamps(task as any));

  // ID uniqueness check
  const allIds = new Set(allTasks.map((t) => t.id));
  violations.push(...validateIdUniqueness(task.id, allIds));

  // Duplicate description check
  const allDescriptions = allTasks
    .filter((t) => t.id !== task.id)
    .map((t) => t.description);
  violations.push(...validateNoDuplicateDescription(task.description, allDescriptions));

  // Hierarchy check
  if (task.parentId) {
    const parent = allTasks.find((t) => t.id === task.parentId);
    if (parent) {
      violations.push(...validateHierarchy(task.parentId, allTasks as any));
    }
  }

  return {
    success: true,
    data: {
      taskId,
      valid: !hasErrors(violations),
      violations,
      errorCount: violations.filter((v) => v.severity === 'error').length,
      warningCount: violations.filter((v) => v.severity === 'warning').length,
    },
  };
}

/**
 * validate.protocol - Protocol compliance check
 * @task T4477
 */
export function validateProtocol(
  taskId: string,
  protocolType?: string,
  projectRoot?: string
): EngineResult {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  const root = projectRoot || resolveProjectRoot();
  const todoPath = getDataPath(root, 'todo.json');
  const todoData = readJsonFile<{ tasks: TaskRecord[] }>(todoPath);

  if (!todoData) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'todo.json not found' },
    };
  }

  const task = todoData.tasks?.find((t) => t.id === taskId);
  if (!task) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Task ${taskId} not found` },
    };
  }

  // Check basic protocol compliance
  const violations: Array<{ code: string; message: string; severity: string }> = [];

  // Check title/description anti-hallucination
  if (!task.title) {
    violations.push({ code: 'P_MISSING_TITLE', message: 'Task title is missing', severity: 'error' });
  }
  if (!task.description) {
    violations.push({ code: 'P_MISSING_DESCRIPTION', message: 'Task description is missing', severity: 'error' });
  }
  if (task.title === task.description) {
    violations.push({ code: 'P_SAME_TITLE_DESC', message: 'Title and description must be different', severity: 'error' });
  }

  // Check status validity
  const validStatuses = ['pending', 'active', 'blocked', 'done', 'cancelled'];
  if (!validStatuses.includes(task.status)) {
    violations.push({
      code: 'P_INVALID_STATUS',
      message: `Invalid status: ${task.status}. Valid: ${validStatuses.join(', ')}`,
      severity: 'error',
    });
  }

  return {
    success: true,
    data: {
      taskId,
      protocolType: protocolType || 'generic',
      compliant: violations.filter((v) => v.severity === 'error').length === 0,
      violations,
    },
  };
}

/**
 * validate.manifest - Manifest entry validation
 * @task T4477
 */
export function validateManifest(
  projectRoot?: string
): EngineResult {
  const root = projectRoot || resolveProjectRoot();
  const manifestPath = resolve(root, 'claudedocs/agent-outputs/MANIFEST.jsonl');

  if (!existsSync(manifestPath)) {
    return {
      success: true,
      data: {
        valid: true,
        totalEntries: 0,
        validEntries: 0,
        invalidEntries: 0,
        errors: [],
        message: 'No manifest file found',
      },
    };
  }

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    let validCount = 0;
    let invalidCount = 0;
    const errors: Array<{ line: number; entryId: string; errors: string[] }> = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
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
      success: true,
      data: {
        valid: invalidCount === 0,
        totalEntries: lines.length,
        validEntries: validCount,
        invalidEntries: invalidCount,
        errors,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * validate.output - Output file validation
 * @task T4477
 */
export function validateOutput(
  filePath: string,
  taskId?: string,
  projectRoot?: string
): EngineResult {
  if (!filePath) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'filePath is required' } };
  }

  const root = projectRoot || resolveProjectRoot();
  const fullPath = resolve(root, filePath);

  if (!existsSync(fullPath)) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Output file not found: ${filePath}` },
    };
  }

  const content = readFileSync(fullPath, 'utf-8');
  const issues: Array<{ code: string; message: string; severity: string }> = [];

  // Check for required sections in output files
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
    success: true,
    data: {
      filePath,
      valid: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
      fileSize: content.length,
      lineCount: content.split('\n').length,
    },
  };
}

/**
 * validate.compliance.summary - Aggregated compliance metrics
 * @task T4477
 */
export function validateComplianceSummary(
  projectRoot?: string
): EngineResult {
  const root = projectRoot || resolveProjectRoot();
  const compliancePath = join(root, '.cleo', 'metrics', 'COMPLIANCE.jsonl');

  if (!existsSync(compliancePath)) {
    return {
      success: true,
      data: {
        total: 0,
        pass: 0,
        fail: 0,
        partial: 0,
        passRate: 0,
        entries: [],
      },
    };
  }

  try {
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

    const pass = entries.filter((e) => e.result === 'pass').length;
    const fail = entries.filter((e) => e.result === 'fail').length;
    const partial = entries.filter((e) => e.result === 'partial').length;
    const total = entries.length;

    // Group by protocol
    const byProtocol: Record<string, { pass: number; fail: number; partial: number }> = {};
    for (const entry of entries) {
      if (!byProtocol[entry.protocol]) {
        byProtocol[entry.protocol] = { pass: 0, fail: 0, partial: 0 };
      }
      byProtocol[entry.protocol][entry.result]++;
    }

    return {
      success: true,
      data: {
        total,
        pass,
        fail,
        partial,
        passRate: total > 0 ? Math.round((pass / total) * 100) : 0,
        byProtocol,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_COMPLIANCE_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * validate.compliance.violations - List compliance violations
 * @task T4477
 */
export function validateComplianceViolations(
  limit?: number,
  projectRoot?: string
): EngineResult {
  const root = projectRoot || resolveProjectRoot();
  const compliancePath = join(root, '.cleo', 'metrics', 'COMPLIANCE.jsonl');

  if (!existsSync(compliancePath)) {
    return {
      success: true,
      data: {
        violations: [],
        total: 0,
      },
    };
  }

  try {
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

    let violations = entries.filter((e) => e.result === 'fail' || e.result === 'partial');

    if (limit && limit > 0) {
      violations = violations.slice(-limit); // Most recent
    }

    return {
      success: true,
      data: {
        violations: violations.map((v) => ({
          timestamp: v.timestamp,
          taskId: v.taskId,
          protocol: v.protocol,
          result: v.result,
          violations: v.violations,
        })),
        total: violations.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_COMPLIANCE_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * validate.compliance.record - Record compliance check result
 * @task T4477
 */
export function validateComplianceRecord(
  taskId: string,
  result: string,
  protocol?: string,
  violations?: Array<{ code: string; message: string; severity: string }>,
  projectRoot?: string
): EngineResult {
  if (!taskId || !result) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId and result are required' },
    };
  }

  const validResults = ['pass', 'fail', 'partial'];
  if (!validResults.includes(result)) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: `Invalid result: ${result}. Valid: ${validResults.join(', ')}` },
    };
  }

  const root = projectRoot || resolveProjectRoot();
  const compliancePath = join(root, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
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
    success: true,
    data: {
      recorded: true,
      taskId,
      result,
      protocol: protocol || 'generic',
    },
  };
}

/**
 * validate.test.status - Test suite status
 * @task T4477
 */
export function validateTestStatus(
  projectRoot?: string
): EngineResult {
  const root = projectRoot || resolveProjectRoot();

  // Check for test directories
  const testDir = join(root, 'tests');
  const mcpTestDir = join(root, 'mcp-server', 'src', '__tests__');

  const hasBatsTests = existsSync(testDir);
  const hasMcpTests = existsSync(mcpTestDir);

  return {
    success: true,
    data: {
      batsTests: {
        available: hasBatsTests,
        directory: hasBatsTests ? 'tests/' : null,
      },
      mcpTests: {
        available: hasMcpTests,
        directory: hasMcpTests ? 'mcp-server/src/__tests__/' : null,
      },
      message: 'Use validate.test.run to execute tests',
    },
  };
}

/**
 * validate.test.coverage - Coverage metrics
 * @task T4477
 */
export function validateTestCoverage(
  projectRoot?: string
): EngineResult {
  const root = projectRoot || resolveProjectRoot();
  const coveragePath = join(root, 'mcp-server', 'coverage', 'coverage-summary.json');

  if (!existsSync(coveragePath)) {
    return {
      success: true,
      data: {
        available: false,
        message: 'No coverage data found. Run tests with coverage first.',
      },
    };
  }

  try {
    const coverageData = readJsonFile<Record<string, unknown>>(coveragePath);
    return {
      success: true,
      data: {
        available: true,
        ...coverageData,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_COVERAGE_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
