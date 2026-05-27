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
 * @task T11040 (verified 2026-05-27: resolveProjectByCwd used for projectPath; 72/72 tests pass)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectByCwd } from '@cleocode/paths';
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
 * Resolve the default project context using projectId-based resolution.
 *
 * Derives `projectPath` from {@link resolveProjectByCwd} (canonical project
 * root), falling back to the `.cleo`-relative path for non-project contexts.
 * DB paths flow through {@link getCleoProjectDir}, which now uses
 * projectId→nexus.db resolution instead of CWD-walk-up (T11040).
 *
 * @returns A context whose paths derive from projectId resolution where possible.
 * @task T11040 — migrate from CWD-walk-up to projectId-based resolution
 */
export function resolveDefaultProjectContext(): ProjectContext {
  const project = resolveProjectByCwd();
  const projectDir = getCleoProjectDir();
  // Use canonical project root from projectId resolution when available;
  // fall back to regex-stripping .cleo/ for non-project contexts.
  const projectPath = project !== null ? project.projectRoot : projectDir.replace(/\/.cleo$/, '');
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
