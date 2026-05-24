/**
 * `cleo config show` — print the resolved CleoConfig envelope.
 *
 * Thin CLI wrapper over `resolveCleoConfig` from the CORE registry
 * (`@cleocode/core/config/registry`, T9878). Supports the cascade scope
 * selector documented by the registry: `'global'`, `'project'`, or
 * `'merged'` (default).
 *
 * @task T9887
 * @saga T9855
 * @epic E4-DOCS-SDK-BOUNDARY
 * @adr 076
 */

import { ExitCode } from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import {
  type MergedConfig,
  type ResolveScope,
  resolveCleoConfig,
} from '@cleocode/core/config/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/**
 * Result shape returned by `cleo config show`.
 *
 * Carries the resolved (or scoped) config plus the requested scope so the
 * envelope is self-describing — useful for JSON consumers chaining
 * subsequent calls.
 *
 * @public
 */
export interface ConfigShowResult {
  /** The scope that produced the contents. */
  scope: ResolveScope;
  /** The resolved config object (raw file for global/project, merged otherwise). */
  config: MergedConfig;
}

/**
 * citty command — `cleo config show [--scope ...]`.
 *
 * @public
 */
export const configShowCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Print the resolved CleoConfig envelope (default scope: merged)',
  },
  args: {
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
    const scope = parseResolveScope(args['scope'] as string | undefined);
    if (scope === null) {
      cliError(
        `config show failed: invalid --scope (must be global|project|merged)`,
        ExitCode.GENERAL_ERROR,
        { name: 'E_CONFIG_SHOW_FAILED' },
      );
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    try {
      const projectRoot = getProjectRoot();
      const config = await resolveCleoConfig({ scope, projectRoot });
      const result: ConfigShowResult = { scope, config };
      cliOutput(result, {
        command: 'config-show',
        operation: 'config.show',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`config show failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_CONFIG_SHOW_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

/**
 * Validate a string against the `ResolveScope` union. Returns `null` for
 * unknown inputs so the caller can emit a typed envelope error.
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
