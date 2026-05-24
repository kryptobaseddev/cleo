/**
 * `cleo config set <key> <value>` — write a value into project or global
 * `.cleo/config.json` via the CORE writer.
 *
 * The writer side of the SSoT config registry. Uses CORE's `setConfigValue`
 * (which already handles dot-notation, intermediate-object creation, and
 * atomic JSON write) and post-validates the file via `validateConfig` from
 * the T9878 registry — schema failures surface as a non-zero exit.
 *
 * Type coercion: by default values pass through `parseConfigValue` which
 * auto-detects `true|false|null|<number>|<json>`. Pass `--type` to force a
 * specific coercion.
 *
 * @task T9887
 * @saga T9855
 * @epic E4-DOCS-SDK-BOUNDARY
 * @adr 076
 */

import { ExitCode } from '@cleocode/contracts';
import { getProjectRoot, parseConfigValue, setConfigValue } from '@cleocode/core';
import { type ValidateScope, validateConfig } from '@cleocode/core/config/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/**
 * Explicit `--type` flag values supported by `cleo config set`.
 *
 * `string`  — write raw string (no parsing).
 * `number`  — parse as `Number(value)`; rejects `NaN`.
 * `boolean` — accepts `true`/`false` only (case-insensitive).
 * `json`    — parse as `JSON.parse(value)`.
 *
 * Omitting `--type` falls back to CORE's auto-detection via
 * `parseConfigValue` (matches the historical legacy behaviour).
 *
 * @public
 */
export type ConfigSetValueType = 'string' | 'number' | 'boolean' | 'json';

/**
 * Result shape returned by `cleo config set`.
 *
 * @public
 */
export interface ConfigSetResult {
  /** The scope written to (`project` or `global`). */
  scope: 'project' | 'global';
  /** The key path that was written. */
  key: string;
  /** The post-coercion value persisted to disk. */
  value: unknown;
  /** Schema validation result for the resulting file (always re-validated). */
  validate: { ok: boolean; issues: string[] };
}

/**
 * citty command — `cleo config set <key> <value> [--scope ...] [--type ...]`.
 *
 * @public
 */
export const configSetCommand = defineCommand({
  meta: {
    name: 'set',
    description: 'Write a value into project or global .cleo/config.json',
  },
  args: {
    key: {
      type: 'positional',
      required: true,
      description: 'Dot-separated key path',
    },
    value: {
      type: 'positional',
      required: true,
      description: 'Raw value (string). Use --type to coerce explicitly.',
    },
    scope: {
      type: 'string',
      description: 'Where to write: project | global (default project)',
      default: 'project',
    },
    type: {
      type: 'string',
      description: 'Explicit value type: string | number | boolean | json',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const key = String(args['key'] ?? '').trim();
    if (key.length === 0) {
      cliError(`config set failed: <key> is required`, ExitCode.INVALID_INPUT, {
        name: 'E_CONFIG_SET_FAILED',
      });
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }

    const rawValue = String(args['value'] ?? '');
    const scope = parseWriteScope(args['scope'] as string | undefined);
    if (scope === null) {
      cliError(
        `config set failed: invalid --scope (must be global|project)`,
        ExitCode.GENERAL_ERROR,
        { name: 'E_CONFIG_SET_FAILED' },
      );
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    const typeFlag = args['type'] as string | undefined;
    let coerced: unknown;
    try {
      coerced = coerceValue(rawValue, typeFlag);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`config set failed: ${message}`, ExitCode.INVALID_INPUT, {
        name: 'E_CONFIG_SET_FAILED',
      });
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }

    let written: Awaited<ReturnType<typeof setConfigValue>>;
    let validate: Awaited<ReturnType<typeof validateConfig>>;
    try {
      const projectRoot = getProjectRoot();
      written = await setConfigValue(key, coerced, projectRoot, {
        global: scope === 'global',
      });
      validate = await validateConfig(scope as ValidateScope, projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`config set failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_CONFIG_SET_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    const result: ConfigSetResult = {
      scope: written.scope,
      key: written.key,
      value: written.value,
      validate,
    };
    cliOutput(result, {
      command: 'config-set',
      operation: 'config.set',
    });
    if (!validate.ok) {
      // Schema failed — emit non-zero exit but the user still has visibility
      // into the value that was written. Mirrors `cleo config validate`.
      process.exit(ExitCode.VALIDATION_ERROR);
    }
  },
});

/**
 * Parse the `--scope` flag for write operations. Only `global` and `project`
 * are valid sinks (`merged` is read-only and would be ambiguous to write).
 *
 * @internal
 */
function parseWriteScope(raw: string | undefined): 'global' | 'project' | null {
  const value = raw ?? 'project';
  if (value === 'global' || value === 'project') {
    return value;
  }
  return null;
}

/**
 * Coerce a raw CLI string value into the requested JS type.
 *
 * When `typeFlag` is absent, defers to CORE's auto-detector via
 * `parseConfigValue`.
 *
 * @internal
 */
function coerceValue(raw: string, typeFlag: string | undefined): unknown {
  if (typeFlag === undefined) {
    return parseConfigValue(raw);
  }
  switch (typeFlag) {
    case 'string':
      return raw;
    case 'number': {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        throw new Error(`--type number cannot coerce "${raw}"`);
      }
      return n;
    }
    case 'boolean': {
      const lower = raw.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      throw new Error(`--type boolean accepts only "true"/"false" (got "${raw}")`);
    }
    case 'json':
      try {
        return JSON.parse(raw) as unknown;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`--type json failed to parse: ${msg}`);
      }
    default:
      throw new Error(
        `--type must be one of: string | number | boolean | json (got "${typeFlag}")`,
      );
  }
}
