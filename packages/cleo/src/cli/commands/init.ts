/**
 * CLI init command - project initialization.
 *
 * Thin handler: parse args -> call core -> format output.
 * All business logic lives in src/core/init.ts (shared-core pattern).
 *
 * The `--workflows` flag dispatches to a separate scaffolder primitive
 * (`scaffoldWorkflows`) that renders `*.yml.tmpl` templates into the
 * project's `.github/workflows/` — see T9531 for details. The two
 * surfaces share the `init` command name to keep the project-setup
 * surface small.
 *
 * @task T4454
 * @task T4681
 * @task T4682
 * @task T4684
 * @task T4685
 * @task T4686
 * @task T4687
 * @task T4689
 * @task T4706
 * @task T4707
 * @task T9531
 * @epic T4663
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CleoError,
  getWorkflowTemplatesDir as getCoreWorkflowTemplatesDir,
  type InitOptions,
  initProject,
  pushWarning,
  scaffoldWorkflows,
  type WorkflowName,
} from '@cleocode/core';
import { getCredentialPool } from '@cleocode/core/llm/credential-pool.js';
import { getTemplatesByKind } from '@cleocode/core/templates/registry';
import { defineCommand } from 'citty';
import { ReadlineWizardIO } from '../lib/readline-wizard-io.js';
import { cliError, cliOutput, isHumanOutput } from '../renderers/index.js';
import { emitLoginResult, runLoginFrontDoor } from './login.js';

/**
 * Load the gitignore template from the package's templates/ directory.
 * Falls back to embedded content if file not found.
 *
 * Kept as export for backward compatibility (used by upgrade.ts).
 * @task T4700
 */
export function getGitignoreTemplate(): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const packageRoot = join(thisFile, '..', '..', '..', '..');
    // Try package-local templates first, then monorepo root
    const localTemplatePath = join(packageRoot, 'templates', 'cleo-gitignore');
    const monorepoTemplatePath = join(packageRoot, '..', '..', 'templates', 'cleo-gitignore');
    const templatePath = existsSync(localTemplatePath) ? localTemplatePath : monorepoTemplatePath;

    if (existsSync(templatePath)) {
      return readFileSync(templatePath, 'utf-8');
    }
  } catch {
    // fallback
  }
  return '# CLEO Project Data - Selective Git Tracking\nagent-outputs/\n';
}

/**
 * Root init command — initialize CLEO in a project directory.
 *
 * Dispatches to `initProject` from core.
 * @task T4681
 * @epic T4663
 */
/**
 * Resolve the absolute path to the `@cleocode/core` package's
 * `templates/workflows/` directory.
 *
 * Re-exported from `@cleocode/core` for backwards compatibility with
 * callers that imported this helper from `init.ts` (notably
 * `packages/cleo/src/cli/commands/upgrade.ts`). T9858 relocated the
 * workflow templates from `packages/cleo/templates/` to
 * `packages/core/templates/` per the Package-Boundary Check.
 *
 * @deprecated Use `getTemplatesByKind('workflow')` from
 * `@cleocode/core/templates/registry`. The directory-resolver pattern
 * hides the substitution + update policy each entry now declares. Rewire
 * planned in T9879 (Saga T9855).
 *
 * @task T9531
 * @task T9858
 */
export function getWorkflowTemplatesDir(): string {
  return getCoreWorkflowTemplatesDir();
}

export const initCommand = defineCommand({
  meta: { name: 'init', description: 'Initialize CLEO in a project directory' },
  args: {
    projectName: {
      type: 'positional',
      description: 'Project name (alternative to --name)',
      required: false,
    },
    name: {
      type: 'string',
      description: 'Project name',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      default: false,
    },
    detect: {
      type: 'boolean',
      description: 'Auto-detect project configuration',
      default: false,
    },
    'map-codebase': {
      type: 'boolean',
      description: 'Run codebase analysis and store findings to brain.db',
      default: false,
    },
    'install-seed-agents': {
      type: 'boolean',
      description: 'Install canonical CleoOS seed agent personas (.cant)',
      default: false,
    },
    workflows: {
      type: 'boolean',
      /**
       * @deprecated Use `cleo templates install --kind workflow` instead
       * (T9886 / Saga T9855). Removal target: v2026.7.0. T9888.
       */
      description:
        '[DEPRECATED — use `cleo templates install --kind workflow`] Scaffold release workflows into .github/workflows/. Will be removed in v2026.7.0.',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'With --workflows: print the rendered YAML without writing.',
      default: false,
    },
  },
  async run({ args }) {
    try {
      // T9888 — `cleo init --workflows` is deprecated. The SSoT install
      // surface is `cleo templates install --kind workflow` (T9886). This
      // branch now (a) emits a deprecation warning to stderr, (b) walks the
      // registry via `getTemplatesByKind('workflow')` to pick the workflow
      // set, and (c) delegates to `scaffoldWorkflows` (which itself is
      // registry-backed) so substitution behaviour is preserved. Removal
      // target: v2026.7.0.
      if (args.workflows) {
        // T9888 — surface the deprecation through the ALS WarningCollector
        // (T9768/T9769) so it lands in `envelope.meta.warnings`. Direct
        // `process.stderr.write` is forbidden by `lint-json-stream-hygiene`
        // for any command that emits a JSON envelope.
        pushWarning({
          code: 'W_INIT_WORKFLOWS_DEPRECATED',
          message:
            '[deprecated] cleo init --workflows: use `cleo templates install --kind workflow` instead. This alias will be removed in v2026.7.0.',
          severity: 'warn',
          deprecated: 'cleo init --workflows',
          replacement: 'cleo templates install --kind workflow',
          removeBy: 'v2026.7.0',
          context: { task: 'T9888', saga: 'T9855' },
        });
        const projectRoot = process.cwd();
        const templatesDir = getWorkflowTemplatesDir();
        const workflowEntries = getTemplatesByKind('workflow');
        const templates = workflowEntries
          .map((entry) => entry.id)
          .filter((id): id is WorkflowName => isWorkflowName(id));
        const result = await scaffoldWorkflows({
          projectRoot,
          templatesDir,
          ...(templates.length > 0 ? { templates } : {}),
          dryRun: !!args['dry-run'],
          force: !!args.force,
        });
        cliOutput(
          {
            scaffolded: result.outcomes.map((o) => ({
              template: o.template,
              targetPath: o.targetPath,
              status: o.status,
            })),
            resolvedTools: result.resolvedTools,
            ...(args['dry-run'] ? { rendered: result.outcomes.map((o) => o.rendered) } : {}),
          },
          { command: 'init' },
        );
        return;
      }

      const initOpts: InitOptions = {
        name: args.name || (args.projectName as string | undefined) || undefined,
        force: !!args.force,
        detect: !!args.detect,
        mapCodebase: !!args['map-codebase'],
        installSeedAgents: !!args['install-seed-agents'],
      };

      const result = await initProject(initOpts);

      // T11727 — first-run credential nudge. When the credential pool is empty
      // after init, emit a LAFS nextStep pointing at the onboarding front door.
      // On an interactive terminal this becomes an opt-in 'Configure now?'
      // prompt that launches the wizard inline; non-TTY / --json paths only
      // surface the nextStep and never prompt.
      const nextSteps = [...(result.nextSteps ?? [])];
      const launchedFrontDoor = await maybeNudgeFirstRunLogin(nextSteps);

      // Front-door already rendered its own result envelope/human line — avoid
      // double-emitting the init envelope on top of it.
      if (launchedFrontDoor) return;

      cliOutput(
        {
          initialized: result.initialized,
          directory: result.directory,
          created: result.created,
          skipped: result.skipped,
          ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          ...(result.updateDocsOnly ? { updateDocsOnly: true } : {}),
          // Phase 5 — greenfield/brownfield classification + LAFS nextSteps
          ...(result.classification ? { classification: result.classification } : {}),
          ...(nextSteps.length > 0 ? { nextSteps } : {}),
        },
        { command: 'init' },
      );
    } catch (err) {
      if (err instanceof CleoError) {
        cliError(`init failed: ${err.message}`, err.code, { name: 'E_INTERNAL' });
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/**
 * The first-run credential nextStep appended when the pool is empty (T11727).
 *
 * @internal
 */
export const FIRST_RUN_LOGIN_NEXT_STEP = {
  action: 'Add an LLM credential to start using CLEO',
  command: 'cleo login',
} as const;

/**
 * Returns `true` when the credential pool has no entries. Defensive: any read
 * error is treated as "not empty" so a transient pool failure never blocks init
 * or fires a spurious prompt.
 *
 * @internal
 */
export async function isCredentialPoolEmpty(): Promise<boolean> {
  try {
    const pool = getCredentialPool();
    const entries = await pool.list();
    return entries.length === 0;
  } catch {
    return false;
  }
}

/**
 * First-run credential nudge (T11727 · AC2/AC3).
 *
 * When the credential pool is empty:
 *   - Always appends {@link FIRST_RUN_LOGIN_NEXT_STEP} to `nextSteps` (mutated
 *     in place) so the LAFS envelope surfaces it (AC2).
 *   - On an interactive terminal (`isHumanOutput()` + TTY), prompts
 *     'Configure now? [Y/n]'. On 'yes' it launches the onboarding front door
 *     inline and returns `true` so the caller skips the init envelope (AC3).
 *   - Never prompts on non-TTY / --json paths — only the nextStep is emitted.
 *
 * @param nextSteps - The init result's nextSteps array, mutated in place.
 * @returns `true` when the front-door wizard was launched (and rendered its own
 *   output), else `false`.
 * @task T11727
 */
export async function maybeNudgeFirstRunLogin(
  nextSteps: Array<{ action: string; command: string }>,
): Promise<boolean> {
  if (!(await isCredentialPoolEmpty())) return false;

  // Always surface the nextStep (data path — AC2).
  nextSteps.push({ ...FIRST_RUN_LOGIN_NEXT_STEP });

  // Only prompt on a human-facing interactive terminal (AC3). The JSON/agent
  // path and any piped invocation get the nextStep and nothing else.
  if (!isHumanOutput() || process.stdin.isTTY !== true) return false;

  const io = new ReadlineWizardIO();
  let configureNow: boolean;
  try {
    configureNow = await io.confirm('No LLM credential found. Configure now?', true);
  } finally {
    io.close();
  }
  if (!configureNow) return false;

  // Launch the shared onboarding front door inline. It owns its own prompts +
  // result rendering, so the init handler must not also emit an envelope.
  const result = await runLoginFrontDoor({});
  emitLoginResult(result, 'init.login');
  return true;
}

/**
 * Type-guard: narrow a registry id string to a {@link WorkflowName}.
 *
 * The workflow registry currently lists exactly the four canonical names
 * declared by {@link WorkflowName} (release-prepare / release-publish /
 * release-fanout / release-rollback). The guard exists so that adding a
 * new workflow entry to the registry without extending the type union
 * fails closed (filtered out) instead of silently passing through.
 *
 * @internal
 * @task T9888
 */
function isWorkflowName(id: string): id is WorkflowName {
  return (
    id === 'release-prepare' ||
    id === 'release-publish' ||
    id === 'release-fanout' ||
    id === 'release-rollback'
  );
}
