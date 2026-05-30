/**
 * scaffold-project SDK Tool — composes the 11 canonical `ensure*` calls
 * from `packages/core/src/scaffold.ts` in execution order.
 *
 * This is a pure-functional wrapper: it accepts a project root, runs each
 * idempotent `ensure*` step in sequence, and returns a typed result
 * envelope. It never interacts with a CLI renderer, a harness adapter, or
 * any I/O surface beyond the scaffold primitives it delegates to.
 *
 * Taxonomy: Category B SDK Tool (ADR-064).
 *
 * @example
 * ```typescript
 * import { scaffoldProject } from '@cleocode/core/tools/scaffold-project';
 *
 * const result = await scaffoldProject({ projectRoot: '/my/project' });
 * if (!result.success) {
 *   console.error('Some scaffold steps failed:', result.steps.filter(s => s.error));
 * }
 * ```
 *
 * @task T10069 (T9835b — Saga T9831)
 * @epic T9835
 */

import type {
  ScaffoldProjectOptions,
  ScaffoldProjectResult,
  ScaffoldProjectStep,
} from '@cleocode/contracts/project-tools';
import { resolveOrCwd } from '../paths.js';
import {
  ensureBrainDb,
  ensureCleoGitRepo,
  ensureCleoStructure,
  ensureConfig,
  ensureGitignore,
  ensureProjectContext,
  ensureProjectGitInitialCommit,
  ensureProjectInfo,
  ensureSqliteDb,
  ensureWorktreeInclude,
} from '../scaffold.js';

export type { ScaffoldProjectOptions, ScaffoldProjectResult, ScaffoldProjectStep };

/**
 * Run the canonical 11-step project scaffold sequence.
 *
 * Each step is idempotent: calling `scaffoldProject` on an already-
 * initialised project root returns all steps as `"skipped"` with
 * `success: true`.
 *
 * Steps (in canonical order matching `cleo init`):
 * 1. `cleo-structure`      — `.cleo/` subdirectory tree
 * 2. `config`              — `.cleo/config.json`
 * 3. `sqlite-db`           — `.cleo/tasks.db`
 * 4. `brain-db`            — `.cleo/brain.db`
 * 5. `gitignore`           — `.cleo/.gitignore`
 * 6. `worktreeinclude`     — `.worktreeinclude` (T9983 canonical; legacy `.cleo/worktree-include` is migrated via `cleo doctor --migrate-worktree-include`)
 * 7. `cleo-git-repo`       — `.cleo/.git` (isolated checkpoint)
 * 8. `initial-commit`      — empty initial commit when HEAD is unborn
 * 9. `project-info`        — `.cleo/project-info.json`
 * 10. `project-context`   — `.cleo/project-context.json`
 * 11. `contributor-mcp`   — `.cleo/contributor-mcp.json` (best-effort)
 *
 * Note: `ensureContributorMcp` is intentionally excluded from this tool
 * because it requires network access (fetching MCP server metadata) and
 * would violate the pure/side-effect-isolated contract for SDK Tools.
 * Callers that need contributor-MCP setup should invoke it directly.
 *
 * @param options - Optional project root and force flag.
 * @returns Aggregated step results and success flag.
 */
export async function scaffoldProject(
  options: ScaffoldProjectOptions = {},
): Promise<ScaffoldProjectResult> {
  const projectRoot = resolveOrCwd(options.projectRoot);
  const force = options.force ?? false;

  const steps: ScaffoldProjectStep[] = [];

  async function run(
    name: string,
    fn: () => Promise<import('@cleocode/contracts/scaffold-diagnostics').ScaffoldResult>,
  ): Promise<void> {
    try {
      const result = await fn();
      steps.push({ name, result });
    } catch (err) {
      steps.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await run('cleo-structure', () => ensureCleoStructure(projectRoot));
  await run('config', () => ensureConfig(projectRoot, { force }));
  await run('sqlite-db', () => ensureSqliteDb(projectRoot));
  await run('brain-db', () => ensureBrainDb(projectRoot));
  await run('gitignore', () => ensureGitignore(projectRoot));
  await run('worktreeinclude', () => ensureWorktreeInclude(projectRoot));
  await run('cleo-git-repo', () => ensureCleoGitRepo(projectRoot));
  await run('initial-commit', () => ensureProjectGitInitialCommit(projectRoot));
  await run('project-info', () => ensureProjectInfo(projectRoot, { force }));
  await run('project-context', () => ensureProjectContext(projectRoot, { force }));

  const errorSteps = steps.filter((s) => s.error !== undefined);
  const created = steps.filter((s) => s.result?.action === 'created').length;
  const repaired = steps.filter((s) => s.result?.action === 'repaired').length;
  const skipped = steps.filter((s) => s.result?.action === 'skipped').length;

  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (repaired > 0) parts.push(`${repaired} repaired`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (errorSteps.length > 0) parts.push(`${errorSteps.length} errored`);

  return {
    projectRoot,
    steps,
    success: errorSteps.length === 0,
    summary: parts.join(', ') || 'no steps run',
  };
}
