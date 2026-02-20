/**
 * Pre-migration JSON validation.
 *
 * Validates all JSON source files BEFORE any destructive database operations.
 * This prevents data loss scenarios where the database is deleted but JSON parsing fails.
 *
 * @task T4725
 * @epic T4454
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Result of validating a single JSON file. */
export interface JsonFileValidation {
  valid: boolean;
  exists: boolean;
  count: number;
  error?: string;
  line?: number;
  column?: number;
}

/** Complete validation result for all source files. */
export interface JsonValidationResult {
  valid: boolean;
  todoJson: JsonFileValidation;
  sessionsJson: JsonFileValidation;
  archiveJson: JsonFileValidation;
  totalTasks: number;
  warnings: string[];
}

/**
 * Parse a JSON parse error to extract line and column information.
 */
function parseJsonError(error: unknown): { message: string; line?: number; column?: number } {
  const message = String(error);
  
  // Try to extract line/column from standard JSON parse errors
  // Format: "Unexpected token X in JSON at position Y" or similar
  const lineMatch = message.match(/line\s+(\d+)/i);
  const columnMatch = message.match(/column\s+(\d+)/i);
  
  return {
    message,
    line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
    column: columnMatch ? parseInt(columnMatch[1], 10) : undefined,
  };
}

/**
 * Validate a single JSON file.
 * 
 * @param filePath - Full path to the JSON file
 * @param countExtractor - Function to extract count from parsed data
 * @returns Validation result
 */
function validateJsonFile(
  filePath: string,
  countExtractor: (data: unknown) => number,
): JsonFileValidation {
  const result: JsonFileValidation = {
    valid: false,
    exists: false,
    count: 0,
  };

  if (!existsSync(filePath)) {
    // File doesn't exist - this is OK, just means no data of this type
    result.valid = true;
    return result;
  }

  result.exists = true;

  try {
    // Check if file is readable and non-empty
    const stats = statSync(filePath);
    if (stats.size === 0) {
      result.error = 'File is empty (0 bytes)';
      return result;
    }

    const content = readFileSync(filePath, 'utf-8');
    if (content.trim().length === 0) {
      result.error = 'File contains only whitespace';
      return result;
    }

    // Attempt to parse
    const data = JSON.parse(content);
    result.valid = true;
    result.count = countExtractor(data);
  } catch (err) {
    const parsed = parseJsonError(err);
    result.error = `Parse error: ${parsed.message}`;
    if (parsed.line) result.line = parsed.line;
    if (parsed.column) result.column = parsed.column;
  }

  return result;
}

/**
 * Validate all JSON source files before migration.
 * 
 * This function MUST be called BEFORE any destructive database operations.
 * It checks that all JSON files are parseable and contain expected data.
 * 
 * @param cleoDir - Path to the .cleo directory
 * @returns Validation result with details for each file
 * @task T4725
 */
export function validateSourceFiles(cleoDir: string): JsonValidationResult {
  const warnings: string[] = [];

  // Validate todo.json
  const todoPath = join(cleoDir, 'todo.json');
  const todoJson = validateJsonFile(todoPath, (data) => {
    const record = data as Record<string, unknown>;
    return Array.isArray(record.tasks) ? record.tasks.length : 0;
  });

  if (todoJson.exists && todoJson.valid && todoJson.count === 0) {
    warnings.push(`todo.json has 0 tasks (file exists but task array is empty)`);
  }

  if (todoJson.exists && !todoJson.valid) {
    const location = todoJson.line 
      ? ` at line ${todoJson.line}${todoJson.column ? `, column ${todoJson.column}` : ''}`
      : '';
    todoJson.error = `${todoJson.error}${location} in ${todoPath}`;
  }

  // Validate sessions.json
  const sessionsPath = join(cleoDir, 'sessions.json');
  const sessionsJson = validateJsonFile(sessionsPath, (data) => {
    const record = data as Record<string, unknown>;
    return Array.isArray(record.sessions) ? record.sessions.length : 0;
  });

  if (sessionsJson.exists && sessionsJson.valid && sessionsJson.count === 0) {
    warnings.push(`sessions.json has 0 sessions`);
  }

  if (sessionsJson.exists && !sessionsJson.valid) {
    const location = sessionsJson.line 
      ? ` at line ${sessionsJson.line}${sessionsJson.column ? `, column ${sessionsJson.column}` : ''}`
      : '';
    sessionsJson.error = `${sessionsJson.error}${location} in ${sessionsPath}`;
  }

  // Validate todo-archive.json
  const archivePath = join(cleoDir, 'todo-archive.json');
  const archiveJson = validateJsonFile(archivePath, (data) => {
    const record = data as Record<string, unknown>;
    // Support both 'tasks' and 'archivedTasks' keys
    const tasks = Array.isArray(record.tasks) ? record.tasks : [];
    const archivedTasks = Array.isArray(record.archivedTasks) ? record.archivedTasks : [];
    return tasks.length + archivedTasks.length;
  });

  if (archiveJson.exists && archiveJson.valid && archiveJson.count === 0) {
    warnings.push(`todo-archive.json has 0 archived tasks`);
  }

  if (archiveJson.exists && !archiveJson.valid) {
    const location = archiveJson.line 
      ? ` at line ${archiveJson.line}${archiveJson.column ? `, column ${archiveJson.column}` : ''}`
      : '';
    archiveJson.error = `${archiveJson.error}${location} in ${archivePath}`;
  }

  // Calculate totals
  const totalTasks = 
    (todoJson.valid ? todoJson.count : 0) + 
    (archiveJson.valid ? archiveJson.count : 0);

  // Determine overall validity
  const valid = todoJson.valid && sessionsJson.valid && archiveJson.valid;

  return {
    valid,
    todoJson,
    sessionsJson,
    archiveJson,
    totalTasks,
    warnings,
  };
}

/**
 * Format validation result for human-readable output.
 * 
 * @param result - Validation result
 * @returns Formatted string
 */
export function formatValidationResult(result: JsonValidationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push('✓ All JSON files are valid');
  } else {
    lines.push('✗ JSON validation failed');
  }

  // todo.json status
  if (result.todoJson.exists) {
    if (result.todoJson.valid) {
      lines.push(`  todo.json: ${result.todoJson.count} tasks`);
    } else {
      lines.push(`  todo.json: ERROR - ${result.todoJson.error}`);
    }
  } else {
    lines.push('  todo.json: not found (will be skipped)');
  }

  // sessions.json status
  if (result.sessionsJson.exists) {
    if (result.sessionsJson.valid) {
      lines.push(`  sessions.json: ${result.sessionsJson.count} sessions`);
    } else {
      lines.push(`  sessions.json: ERROR - ${result.sessionsJson.error}`);
    }
  } else {
    lines.push('  sessions.json: not found (will be skipped)');
  }

  // archive.json status
  if (result.archiveJson.exists) {
    if (result.archiveJson.valid) {
      lines.push(`  todo-archive.json: ${result.archiveJson.count} archived tasks`);
    } else {
      lines.push(`  todo-archive.json: ERROR - ${result.archiveJson.error}`);
    }
  } else {
    lines.push('  todo-archive.json: not found (will be skipped)');
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push('\nWarnings:');
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  // Total
  if (result.valid) {
    lines.push(`\nTotal tasks to migrate: ${result.totalTasks}`);
  }

  return lines.join('\n');
}

/**
 * Check for task count mismatch between existing database and JSON.
 * 
 * This helps detect cases where the database has data but JSON is empty
 * (indicating a potential configuration or path issue).
 * 
 * @param cleoDir - Path to .cleo directory
 * @param jsonTaskCount - Number of tasks found in JSON
 * @returns Warning message if mismatch detected, null otherwise
 */
export function checkTaskCountMismatch(
  cleoDir: string, 
  jsonTaskCount: number,
): string | null {
  const dbPath = join(cleoDir, 'tasks.db');
  
  if (!existsSync(dbPath)) {
    return null; // No existing DB, no mismatch possible
  }

  try {
    const stats = statSync(dbPath);
    if (stats.size === 0) {
      return null; // Empty DB file
    }

    // DB exists and has content, but JSON has 0 tasks
    if (jsonTaskCount === 0) {
      return `WARNING: Existing database (${stats.size} bytes) found but JSON has 0 tasks. ` +
        `This may indicate wrong directory or missing JSON files. ` +
        `Migration will result in data loss unless JSON files are in the correct location.`;
    }
  } catch {
    // Can't stat the DB, ignore
  }

  return null;
}
