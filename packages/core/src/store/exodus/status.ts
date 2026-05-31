/**
 * Exodus status reporter.
 *
 * `runExodusStatus()` returns a structured view of the current exodus state
 * without performing any reads or writes beyond stat() calls.
 *
 * @task T11248 (E5 · AC3 · SG-DB-SUBSTRATE-V2)
 * @saga T11242
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCleoDir } from '../../paths.js';
import { resolveDualScopeDbPath } from '../dual-scope-db.js';
import { buildExodusPlan } from './plan.js';
import type { ExodusJournal, ExodusStatusResult } from './types.js';

// ---------------------------------------------------------------------------
// Journal reader (mirrors logic in migrate.ts — kept local for zero coupling)
// ---------------------------------------------------------------------------

const JOURNAL_FILENAME = 'exodus-journal.json' as const;

function readJournal(stagingDir: string): ExodusJournal | null {
  const p = join(stagingDir, JOURNAL_FILENAME);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ExodusJournal;
  } catch {
    return null;
  }
}

function findStagingDirs(cleoDir: string): string[] {
  try {
    return readdirSync(cleoDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('exodus-staging-'))
      .map((e) => join(cleoDir, e.name))
      .sort()
      .reverse(); // most-recent first
  } catch {
    return [];
  }
}

function safeBytes(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main status runner
// ---------------------------------------------------------------------------

/**
 * Return a structured status report for the exodus subsystem.
 *
 * This is a read-only operation — no mutations occur.
 *
 * @param cwd - Working directory used to resolve the project root.
 * @returns {@link ExodusStatusResult}
 *
 * @task T11248 (AC3)
 */
export function runExodusStatus(cwd?: string): ExodusStatusResult {
  const plan = buildExodusPlan(cwd);
  const cleoDir = resolveCleoDir(cwd);

  // Find staging directories
  const stagingDirs = findStagingDirs(cleoDir);
  const latestStaging = stagingDirs[0] ?? null;
  const journal = latestStaging ? readJournal(latestStaging) : null;

  const projectDbPath = resolveDualScopeDbPath('project', cwd);
  const globalDbPath = resolveDualScopeDbPath('global');

  const sourcesInfo = plan.sources.map((s) => ({
    name: s.name,
    path: s.path,
    exists: existsSync(s.path),
    bytes: safeBytes(s.path),
  }));

  return {
    hasStaging: latestStaging !== null,
    stagingDir: latestStaging,
    journal,
    projectDbExists: existsSync(projectDbPath),
    globalDbExists: existsSync(globalDbPath),
    sourcesPresent: sourcesInfo.some((s) => s.exists),
    sources: sourcesInfo,
  };
}
