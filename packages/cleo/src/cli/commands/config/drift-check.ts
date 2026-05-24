/**
 * `cleo config drift-check` — apply the manifest entry's drift-detection
 * strategy to a scoped file and emit a typed drift verdict.
 *
 * Thin wrapper over `checkDrift` from the CORE registry
 * (`@cleocode/core/config/registry`, T9878). Exits non-zero when drift is
 * detected so it composes with CI gates.
 *
 * The `'metadata'` scope walks both `project-info.json` and
 * `project-context.json` and returns the first drift hit (worst-case
 * semantics — matches the underlying registry behaviour).
 *
 * @task T9887
 * @saga T9855
 * @epic E4-DOCS-SDK-BOUNDARY
 * @adr 076
 */

import { ExitCode } from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import { checkDrift, type DriftScope } from '@cleocode/core/config/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/**
 * Result shape returned by `cleo config drift-check`.
 *
 * @public
 */
export interface ConfigDriftCheckResult {
  /** Scope that was checked. */
  scope: DriftScope;
  /** `true` IFF drift was detected. */
  drift: boolean;
  /** Optional human-readable reason for the verdict (only meaningful when `drift === true`). */
  reason?: string;
}

/**
 * citty command — `cleo config drift-check [--scope ...]`.
 *
 * @public
 */
export const configDriftCheckCommand = defineCommand({
  meta: {
    name: 'drift-check',
    description:
      'Check a scoped config file for drift (default scope: project; metadata covers project-info/project-context)',
  },
  args: {
    scope: {
      type: 'string',
      description: 'Scope to check: global | project | metadata (default project)',
      default: 'project',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const scope = parseDriftScope(args['scope'] as string | undefined);
    if (scope === null) {
      cliError(
        `config drift-check failed: invalid --scope (must be global|project|metadata)`,
        ExitCode.GENERAL_ERROR,
        { name: 'E_CONFIG_DRIFT_CHECK_FAILED' },
      );
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    let driftResult: Awaited<ReturnType<typeof checkDrift>>;
    try {
      const projectRoot = getProjectRoot();
      driftResult = await checkDrift(scope, projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`config drift-check failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_CONFIG_DRIFT_CHECK_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    const result: ConfigDriftCheckResult = {
      scope,
      drift: driftResult.drift,
      ...(driftResult.reason !== undefined ? { reason: driftResult.reason } : {}),
    };
    cliOutput(result, {
      command: 'config-drift-check',
      operation: 'config.drift-check',
    });
    if (driftResult.drift) {
      process.exit(ExitCode.VALIDATION_ERROR);
    }
  },
});

/**
 * Validate a string against the `DriftScope` union.
 *
 * @internal
 */
function parseDriftScope(raw: string | undefined): DriftScope | null {
  const value = raw ?? 'project';
  if (value === 'global' || value === 'project' || value === 'metadata') {
    return value;
  }
  return null;
}
