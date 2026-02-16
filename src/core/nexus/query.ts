/**
 * NEXUS query parser and resolver - cross-project task references.
 *
 * Supports the `project:taskId` syntax:
 *   - `my-app:T001`  - Named project
 *   - `.:T001`       - Current project
 *   - `*:T001`       - Wildcard (all projects)
 *   - `T001`         - Implicit current project
 *
 * @task T4574
 * @epic T4540
 */

import { join, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import { z } from 'zod';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task } from '../../types/task.js';
import {
  readRegistry,
  nexusGetProject,
} from './registry.js';

// ── Schemas ──────────────────────────────────────────────────────────

export const NexusParsedQuerySchema = z.object({
  project: z.string(),
  taskId: z.string(),
  wildcard: z.boolean(),
});
export type NexusParsedQuery = z.infer<typeof NexusParsedQuerySchema>;

/** Task with project context annotation. */
export type NexusResolvedTask = Task & { _project: string };

// ── Query syntax ─────────────────────────────────────────────────────

/** Regex for a bare task ID (T followed by 3+ digits). */
const TASK_ID_RE = /^T\d{3,}$/;

/** Regex for project:taskId syntax. */
const QUALIFIED_RE = /^([a-z0-9_-]+|\.|\*):T\d{3,}$/;

/**
 * Validate a query string matches expected syntax.
 */
export function validateSyntax(query: string): boolean {
  if (!query) return false;
  return TASK_ID_RE.test(query) || QUALIFIED_RE.test(query);
}

/**
 * Parse a query string into its components.
 * @throws CleoError with NEXUS_INVALID_SYNTAX for bad format.
 */
export function parseQuery(query: string, currentProject?: string): NexusParsedQuery {
  if (!validateSyntax(query)) {
    throw new CleoError(
      ExitCode.NEXUS_INVALID_SYNTAX,
      `Invalid query syntax: ${query}. Expected: T001, project:T001, .:T001, or *:T001`,
    );
  }

  // Check for colon separator
  const colonIdx = query.indexOf(':');
  if (colonIdx === -1) {
    // Bare task ID -- implicit current project
    const project = currentProject ?? getCurrentProject();
    return { project, taskId: query, wildcard: false };
  }

  const prefix = query.substring(0, colonIdx);
  const taskId = query.substring(colonIdx + 1);

  switch (prefix) {
    case '.': {
      const project = currentProject ?? getCurrentProject();
      return { project, taskId, wildcard: false };
    }
    case '*':
      return { project: '*', taskId, wildcard: true };
    default:
      return { project: prefix, taskId, wildcard: false };
  }
}

/**
 * Get the current project name from context.
 * Reads .cleo/project-info.json or falls back to directory name.
 */
export function getCurrentProject(): string {
  // Allow test/env override
  if (process.env['NEXUS_CURRENT_PROJECT']) {
    return process.env['NEXUS_CURRENT_PROJECT'];
  }

  // Try to read from .cleo/project-info.json (matches bash behavior)
  try {
    const infoPath = join(process.cwd(), '.cleo', 'project-info.json');
    if (existsSync(infoPath)) {
      const data = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
      if (typeof data.name === 'string' && data.name.length > 0) {
        return data.name;
      }
    }
  } catch {
    // Fall through to directory name
  }

  // Fallback to cwd directory name
  return basename(process.cwd());
}

/**
 * Resolve a project name to its filesystem path.
 * Handles special cases: "." (current), "*" (wildcard marker).
 */
export async function resolveProjectPath(projectName: string): Promise<string> {
  if (projectName === '*') {
    return 'WILDCARD';
  }

  if (projectName === '.') {
    // Current directory
    const todoPath = join(process.cwd(), '.cleo', 'todo.json');
    try {
      await access(todoPath);
      return process.cwd();
    } catch {
      throw new CleoError(
        ExitCode.NEXUS_PROJECT_NOT_FOUND,
        'Current directory is not a CLEO project',
      );
    }
  }

  // Look up in registry
  const project = await nexusGetProject(projectName);
  if (!project) {
    throw new CleoError(
      ExitCode.NEXUS_PROJECT_NOT_FOUND,
      `Project not found in registry: ${projectName}`,
      { fix: `cleo nexus register /path/to/project --name ${projectName}` },
    );
  }

  return project.path;
}

/**
 * Read tasks from a project's todo.json.
 */
async function readProjectTasks(projectPath: string): Promise<Task[]> {
  const todoPath = join(projectPath, '.cleo', 'todo.json');
  try {
    const raw = await readFile(todoPath, 'utf-8');
    const data = JSON.parse(raw) as { tasks: Task[] };
    return data.tasks ?? [];
  } catch {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Project todo.json not found: ${todoPath}`,
    );
  }
}

/**
 * Resolve a query to task data.
 * For wildcard queries, returns an array of matches from all projects.
 * For named projects, returns a single task with project context.
 */
export async function resolveTask(query: string, currentProject?: string): Promise<NexusResolvedTask | NexusResolvedTask[]> {
  const parsed = parseQuery(query, currentProject);

  if (parsed.wildcard) {
    return resolveWildcard(parsed.taskId);
  }

  // Resolve project path
  const projectPath = await resolveProjectPath(parsed.project);
  const tasks = await readProjectTasks(projectPath);
  const task = tasks.find(t => t.id === parsed.taskId);

  if (!task) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Task not found: ${parsed.taskId} in project ${parsed.project}`,
    );
  }

  return { ...task, _project: parsed.project };
}

/**
 * Search for a task ID across all registered projects.
 */
async function resolveWildcard(taskId: string): Promise<NexusResolvedTask[]> {
  const registry = await readRegistry();
  if (!registry) return [];

  const results: NexusResolvedTask[] = [];

  for (const project of Object.values(registry.projects)) {
    try {
      const tasks = await readProjectTasks(project.path);
      const match = tasks.find(t => t.id === taskId);
      if (match) {
        results.push({ ...match, _project: project.name });
      }
    } catch {
      // Skip projects with unreadable todo.json
    }
  }

  return results;
}

/**
 * Extract the project name from a query without full resolution.
 * Useful for permission checks before task lookup.
 */
export function getProjectFromQuery(query: string, currentProject?: string): string {
  const parsed = parseQuery(query, currentProject);
  return parsed.project;
}
