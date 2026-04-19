/**
 * Project context resolution for the Living Brain substrate.
 *
 * `ProjectContext` carries the resolved absolute paths for the per-project
 * databases (brain.db, tasks.db) so substrate adapters can route queries to
 * the correct project without depending on SvelteKit request locals.
 *
 * The `ProjectContext` shape defined here is structurally compatible with
 * (i.e. a subtype of) the studio's richer `ProjectContext` in
 * `packages/studio/src/lib/server/project-context.ts`. Studio callers may
 * pass their full context directly; it will satisfy this interface via
 * structural typing.
 *
 * `resolveDefaultProjectContext` derives a fallback context from
 * `CLEO_ROOT` / `process.cwd()` when no explicit context is supplied.
 *
 * @task T969
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoProjectDir } from './cleo-home.js';

/**
 * Resolved paths for the active project context.
 *
 * Studio's `ProjectContext` type carries additional fields (projectId, name,
 * brainDbExists, tasksDbExists). TypeScript structural typing allows Studio to
 * pass its richer type wherever this interface is expected.
 */
export interface ProjectContext {
  /** Absolute path to the project root. */
  projectPath: string;
  /** Absolute path to brain.db for this project. */
  brainDbPath: string;
  /** Absolute path to tasks.db for this project. */
  tasksDbPath: string;
}

/**
 * Resolve the default project context (current project from `CLEO_ROOT` / cwd).
 * Used as fallback when no explicit project context is supplied.
 *
 * @returns A context whose paths derive from `getCleoProjectDir()`.
 */
export function resolveDefaultProjectContext(): ProjectContext {
  const projectDir = getCleoProjectDir();
  const projectPath = projectDir.replace(/\/.cleo$/, '');
  const brainDbPath = join(projectDir, 'brain.db');
  const tasksDbPath = join(projectDir, 'tasks.db');
  // existsSync is referenced to match the studio surface, and documents intent;
  // adapters re-check existence before opening to avoid stale races.
  void existsSync;
  return {
    projectPath,
    brainDbPath,
    tasksDbPath,
  };
}
