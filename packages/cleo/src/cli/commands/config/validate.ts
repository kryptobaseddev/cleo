/**
 * `cleo config validate` — re-parse a scoped config file against its
 * manifest's schema and emit pass/fail with detailed issues.
 *
 * Thin wrapper over `validateConfig` from the CORE registry
 * (`@cleocode/core/config/registry`, T9878). Exits non-zero when the schema
 * rejects the file so consumers can chain `&&`-style checks.
 *
 * @task T9887
 * @saga T9855
 * @epic E4-DOCS-SDK-BOUNDARY
 * @adr 076
 */

import { ExitCode } from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import { type ValidateScope, validateConfig } from '@cleocode/core/config/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/**
 * Result shape returned by `cleo config validate`.
 *
 * @public
 */
export interface ConfigValidateResult {
  /** Scope that was validated. */
  scope: ValidateScope;
  /** `true` IFF the file passed every schema gate (or no schema was bound). */
  ok: boolean;
  /** Human-readable issues. Empty when `ok === true`. */
  issues: string[];
}

/**
 * citty command — `cleo config validate [--scope ...]`.
 *
 * @public
 */
export const configValidateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate a scoped config file against its schema (default scope: project)',
  },
  args: {
    scope: {
      type: 'string',
      description: 'Scope to validate: global | project (default project)',
      default: 'project',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const scope = parseValidateScope(args['scope'] as string | undefined);
    if (scope === null) {
      cliError(
        `config validate failed: invalid --scope (must be global|project)`,
        ExitCode.GENERAL_ERROR,
        { name: 'E_CONFIG_VALIDATE_FAILED' },
      );
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    let validate: Awaited<ReturnType<typeof validateConfig>>;
    try {
      const projectRoot = getProjectRoot();
      validate = await validateConfig(scope, projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`config validate failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_CONFIG_VALIDATE_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    const result: ConfigValidateResult = {
      scope,
      ok: validate.ok,
      issues: validate.issues,
    };
    cliOutput(result, {
      command: 'config-validate',
      operation: 'config.validate',
    });
    if (!validate.ok) {
      process.exit(ExitCode.VALIDATION_ERROR);
    }
  },
});

/**
 * Validate a string against the `ValidateScope` union.
 *
 * @internal
 */
function parseValidateScope(raw: string | undefined): ValidateScope | null {
  const value = raw ?? 'project';
  if (value === 'global' || value === 'project') {
    return value;
  }
  return null;
}
