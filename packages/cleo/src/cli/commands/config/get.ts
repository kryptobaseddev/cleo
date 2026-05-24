/**
 * `cleo config get <key>` — read a single value from the resolved cascade.
 *
 * Thin wrapper over `getConfigValue` from the CORE registry
 * (`@cleocode/core/config/registry`, T9878). Returns `E_NOT_FOUND` when the
 * key is absent — distinguishing missing keys from `null`/`false`/`0` values.
 *
 * @task T9887
 * @saga T9855
 * @epic E4-DOCS-SDK-BOUNDARY
 * @adr 076
 */

import { ExitCode } from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import { getConfigValue, type ResolveScope } from '@cleocode/core/config/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/**
 * Result shape returned by `cleo config get`.
 *
 * Carries the resolved scope, the requested key, and the value so JSON
 * consumers can compose the response without re-parsing.
 *
 * @public
 */
export interface ConfigGetResult {
  /** The scope that produced the value. */
  scope: ResolveScope;
  /** The key (dot-separated path) that was requested. */
  key: string;
  /** The resolved value (any JSON-serialisable shape). */
  value: unknown;
}

/**
 * citty command — `cleo config get <key> [--scope ...]`.
 *
 * @public
 */
export const configGetCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Read a single config value by dot-separated key (default scope: merged)',
  },
  args: {
    key: {
      type: 'positional',
      required: true,
      description: 'Dot-separated key path (e.g. release.branchModel)',
    },
    scope: {
      type: 'string',
      description: 'Cascade scope to read: global | project | merged (default merged)',
      default: 'merged',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const key = String(args['key'] ?? '').trim();
    if (key.length === 0) {
      cliError(`config get failed: <key> is required`, ExitCode.INVALID_INPUT, {
        name: 'E_CONFIG_GET_FAILED',
      });
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }

    const scope = parseResolveScope(args['scope'] as string | undefined);
    if (scope === null) {
      cliError(
        `config get failed: invalid --scope (must be global|project|merged)`,
        ExitCode.GENERAL_ERROR,
        { name: 'E_CONFIG_GET_FAILED' },
      );
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    let value: unknown;
    try {
      const projectRoot = getProjectRoot();
      value = await getConfigValue<unknown>(key, { scope, projectRoot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`config get failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_CONFIG_GET_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    if (value === undefined) {
      cliError(`config get failed: key "${key}" not found`, ExitCode.NOT_FOUND, {
        name: 'E_NOT_FOUND',
        details: { key, scope },
      });
      process.exit(ExitCode.NOT_FOUND);
      return;
    }

    const result: ConfigGetResult = { scope, key, value };
    cliOutput(result, {
      command: 'config-get',
      operation: 'config.get',
    });
  },
});

/**
 * Validate a string against the `ResolveScope` union. Returns `null` for
 * unknown inputs.
 *
 * @internal
 */
function parseResolveScope(raw: string | undefined): ResolveScope | null {
  const value = raw ?? 'merged';
  if (value === 'global' || value === 'project' || value === 'merged') {
    return value;
  }
  return null;
}
