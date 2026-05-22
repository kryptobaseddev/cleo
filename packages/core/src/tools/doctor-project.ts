/**
 * doctor-project SDK Tool — composes all synchronous `check*` calls into a
 * single typed diagnostic result.
 *
 * This is the pure, side-effect-free alternative to `coreDoctorReport()`
 * (which runs async dependency + SQLite integrity probes). `doctorProject`
 * runs ONLY the synchronous filesystem / configuration checks from
 * `packages/core/src/scaffold.ts` and
 * `packages/core/src/validation/doctor/checks.ts`, making it safe to call
 * in any context without worrying about database availability.
 *
 * Taxonomy: Category B SDK Tool (ADR-064).
 *
 * @example
 * ```typescript
 * import { doctorProject } from '@cleocode/core/tools/doctor-project';
 *
 * const result = await doctorProject({ projectRoot: '/my/project' });
 * if (result.exitCode !== 0) {
 *   const failed = result.checks.filter(c => c.status === 'failed');
 *   console.error('Failed checks:', failed.map(c => c.check));
 * }
 * ```
 *
 * @task T10069 (T9835b — Saga T9831)
 * @epic T9835
 */

import type { DoctorProjectOptions, DoctorProjectResult } from '@cleocode/contracts/project-tools';
import { resolveOrCwd } from '../paths.js';
import {
  checkBrainDb,
  checkCleoGitRepo,
  checkCleoStructure,
  checkConfig,
  checkLogDir,
  checkMemoryBridge,
  checkNexusBridge,
  checkProjectContext,
  checkProjectInfo,
  checkSqliteDb,
} from '../scaffold.js';
import { calculateHealthStatus, runAllGlobalChecks } from '../validation/doctor/checks.js';

export type { DoctorProjectOptions, DoctorProjectResult };

/**
 * Run all synchronous project and global diagnostic checks.
 *
 * Combines:
 * - Global checks from `runAllGlobalChecks()` (CLI version, node version,
 *   gitignore patterns, CAAMP injection chain, schema health, orphan audit)
 * - Project-scoped scaffold checks (structure, config, databases, git repo,
 *   memory bridge, nexus bridge, project info, project context, log dir)
 *
 * Excludes async operations (dependency network probes, SQLite integrity
 * check, adapter health) — use `coreDoctorReport()` for the full picture.
 *
 * @param options - Optional project root and cleo home override.
 * @returns Flat list of check results with rolled-up exit code.
 */
export async function doctorProject(
  options: DoctorProjectOptions = {},
): Promise<DoctorProjectResult> {
  const projectRoot = resolveOrCwd(options.projectRoot);
  const cleoHome = options.cleoHome;

  let globalChecks: import('@cleocode/contracts/scaffold-diagnostics').CheckResult[];
  try {
    globalChecks = runAllGlobalChecks(cleoHome, projectRoot);
  } catch (err) {
    globalChecks = [
      {
        id: 'global_checks',
        category: 'global',
        status: 'failed',
        message: `Global checks could not run: ${err instanceof Error ? err.message : String(err)}`,
        details: {},
        fix: 'cleo init',
      },
    ];
  }

  const projectChecks = [
    checkCleoStructure(projectRoot),
    checkConfig(projectRoot),
    checkSqliteDb(projectRoot),
    checkBrainDb(projectRoot),
    checkCleoGitRepo(projectRoot),
    checkLogDir(projectRoot),
    checkProjectInfo(projectRoot),
    checkProjectContext(projectRoot),
    checkMemoryBridge(projectRoot),
    checkNexusBridge(projectRoot),
  ];

  const checks = [...globalChecks, ...projectChecks];
  const rawStatus = calculateHealthStatus(checks);

  const exitCode = rawStatus === 52 ? 52 : rawStatus === 50 ? 50 : 0;

  return { projectRoot, checks, exitCode };
}
