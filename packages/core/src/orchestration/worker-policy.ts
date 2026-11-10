import {
  type ProjectWorkerPolicy,
  projectWorkerPolicySchema,
} from '@cleocode/contracts/config/worker-policy.js';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { getConfigValue } from '../config/registry.js';
import { EngineResultError } from '../engine-result.js';

/**
 * Resolve project-only worker policy, refusing malformed rules before dispatch.
 *
 * @remarks Global configuration cannot supply another project's worker rules.
 * @param projectRoot - Project whose `.cleo/config.json` owns the policy.
 * @returns Validated rules, or undefined when the project declares none.
 * @throws An EngineResultError with a repair command for invalid configuration.
 * @example
 * ```typescript
 * const policy = await resolveProjectWorkerPolicy(projectRoot);
 * ```
 * @public
 */
export async function resolveProjectWorkerPolicy(
  projectRoot: string,
): Promise<ProjectWorkerPolicy | undefined> {
  const fix =
    "Preserve existing project instructions and repair the invalid fields: cleo config set orchestrate.workerPolicy '<valid-policy-json>' --type json";
  try {
    const raw = await getConfigValue('orchestrate.workerPolicy', {
      projectRoot,
      scope: 'project',
    });
    if (raw === undefined) return undefined;
    const parsed = projectWorkerPolicySchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // @sync-invariant none:input-shape malformed project policy cannot authorize dispatch
    throw new EngineResultError({
      code: 'E_WORKER_POLICY_INVALID',
      exitCode: ExitCode.CONFIG_ERROR,
      message: `Invalid orchestrate.workerPolicy: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}. Repair: ${fix}`,
      fix,
    });
  } catch (error) {
    if (error instanceof EngineResultError) throw error;
    const repair = 'Repair .cleo/config.json, then run cleo config validate --scope project';
    // @sync-invariant none:input-shape unreadable project configuration cannot authorize dispatch
    throw new EngineResultError({
      code: 'E_WORKER_POLICY_INVALID',
      exitCode: ExitCode.CONFIG_ERROR,
      message: `Cannot read project worker policy: ${error instanceof Error ? error.message : String(error)}. ${repair}`,
      fix: repair,
    });
  }
}

/**
 * Render project instructions verbatim, without interpreting prompt template tokens.
 *
 * @remarks Owner instructions and evidence obligations remain authoritative.
 * @param policy - Validated project rules from the canonical resolver.
 * @returns One policy section shared by every tier and execution backend.
 * @example
 * ```typescript
 * const block = buildProjectWorkerPolicyBlock({ instructions: ['Follow AGENTS.md'] });
 * ```
 * @public
 */
export function buildProjectWorkerPolicyBlock(policy: ProjectWorkerPolicy): string {
  return [
    '## Project Worker Policy',
    '',
    "Source: `orchestrate.workerPolicy` in this project's `.cleo/config.json`. Explicit owner instructions remain authoritative. Project verification placement takes precedence over generic protocol examples; evidence and independent review remain mandatory.",
    ...(policy.verification
      ? [
          `Full verification (build, full tests, lint and typecheck): ${policy.verification.full === 'ci' ? 'required CI only' : 'local'}.`,
          `Local iteration checks: ${policy.verification.local === 'single-file' ? 'single changed or failing test files only; formatting/lint may target changed files' : 'affected checks only'}.`,
        ]
      : []),
    ...(policy.instructions ?? []).map((instruction) => `- ${instruction}`),
  ].join('\n');
}
