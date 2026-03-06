/**
 * Thin reader for .cleo/project-info.json.
 *
 * The file is written by scaffold.ts (ensureProjectInfo). This module
 * provides a typed read interface for consumers that need projectHash
 * and projectId without importing the full scaffold machinery.
 *
 * @task T5333
 */

import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute } from './paths.js';

// ── Types ────────────────────────────────────────────────────────────

/** Fields consumed by logging, audit, and correlation subsystems. */
export interface ProjectInfo {
  /** 12-char SHA-256 hex of the normalized project path (per-install identity). */
  projectHash: string;
  /** Stable UUID that survives directory moves (added by T5333). */
  projectId: string;
  /** Absolute path to the project root directory. */
  projectRoot: string;
  /** Human-readable project name (last segment of projectRoot). */
  projectName: string;
}

// ── Implementation ───────────────────────────────────────────────────

/**
 * Read project-info.json and return a typed ProjectInfo.
 *
 * Falls back gracefully when projectId is missing (pre-T5333 installs)
 * by returning an empty string, allowing callers to detect and handle.
 *
 * @throws {Error} If .cleo/project-info.json does not exist or is invalid JSON.
 */
export async function getProjectInfo(cwd?: string): Promise<ProjectInfo> {
  const projectRoot = cwd ?? process.cwd();
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const infoPath = join(cleoDir, 'project-info.json');

  const raw = await readFile(infoPath, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;

  if (typeof data.projectHash !== 'string' || data.projectHash.length === 0) {
    throw new Error(`project-info.json missing required field: projectHash`);
  }

  const segments = projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/);
  const projectName = segments[segments.length - 1] ?? 'unknown';

  return {
    projectHash: data.projectHash,
    projectId: typeof data.projectId === 'string' ? data.projectId : '',
    projectRoot,
    projectName,
  };
}

/**
 * Synchronous variant for use in hot paths where async is not feasible.
 * Returns null if the file is missing or unparseable.
 */
export function getProjectInfoSync(cwd?: string): ProjectInfo | null {
  const projectRoot = cwd ?? process.cwd();
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const infoPath = join(cleoDir, 'project-info.json');

  if (!existsSync(infoPath)) return null;

  try {
    const raw = readFileSync(infoPath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;

    if (typeof data.projectHash !== 'string' || data.projectHash.length === 0) {
      return null;
    }

    const segments = projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/);
    const projectName = segments[segments.length - 1] ?? 'unknown';

    return {
      projectHash: data.projectHash,
      projectId: typeof data.projectId === 'string' ? data.projectId : '',
      projectRoot,
      projectName,
    };
  } catch {
    return null;
  }
}
