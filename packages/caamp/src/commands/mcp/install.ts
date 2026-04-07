/**
 * `caamp mcp install` command.
 *
 * @remarks
 * Installs an MCP server entry into a provider's config file. Two
 * input shapes are supported:
 *
 * 1. Inline command + args after a `--` sentinel:
 *
 *    ```bash
 *    caamp mcp install github --provider claude-desktop -- \
 *      npx -y @modelcontextprotocol/server-github
 *    ```
 *
 * 2. JSON file containing a {@link McpServerConfig}:
 *
 *    ```bash
 *    caamp mcp install github --provider claude-desktop \
 *      --from ./github-mcp.json
 *    ```
 *
 * `--env KEY=VALUE` is repeatable and contributes to the `env` field of
 * the resulting payload (overriding values from `--from` when both are
 * supplied). `--force` overwrites an existing entry; without it the
 * call returns a typed `E_CONFLICT_VERSION` envelope.
 *
 * The verb does NOT speak the MCP protocol — it just writes a JSON/
 * YAML/TOML record to the right location using the format-agnostic
 * substrate from `core/formats`.
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { installMcpServer } from '../../core/mcp/index.js';
import type { McpServerConfig } from '../../types.js';
import { LAFSCommandError, runLafsCommand } from '../advanced/lafs.js';
import {
  MCP_ERROR_CODES,
  type McpCommandBaseOptions,
  parseEnvAssignment,
  parseScope,
  requireMcpProvider,
  resolveProjectDir,
} from './common.js';

/**
 * Options accepted by `caamp mcp install`.
 *
 * @public
 */
export interface McpInstallOptions extends McpCommandBaseOptions {
  /** Provider id to install into (required). */
  provider?: string;
  /** Optional path to a JSON file containing an `McpServerConfig`. */
  from?: string;
  /** Repeatable `KEY=VALUE` env assignments. */
  env?: string[];
  /** Overwrite an existing entry instead of failing. */
  force?: boolean;
}

/**
 * Validate that an arbitrary parsed JSON object is a usable
 * {@link McpServerConfig}.
 *
 * @remarks
 * Permissive validation: we accept any object with at least one of
 * `command`, `url`, or `type` because the MCP server config schema
 * across providers is loose (some require `command`, some accept
 * `url`-only remotes). The full transport-specific validation is the
 * downstream tool's responsibility — CAAMP just preserves the shape
 * the user supplied.
 *
 * @internal
 */
function coerceServerConfig(value: unknown, source: string): McpServerConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LAFSCommandError(
      MCP_ERROR_CODES.VALIDATION,
      `${source} did not contain a JSON object.`,
      'Pass an object with at least `command` or `url` (and optional `args`, `env`).',
      false,
    );
  }
  const obj = value as Record<string, unknown>;
  const hasCommand = typeof obj['command'] === 'string';
  const hasUrl = typeof obj['url'] === 'string';
  const hasType = typeof obj['type'] === 'string';
  if (!hasCommand && !hasUrl && !hasType) {
    throw new LAFSCommandError(
      MCP_ERROR_CODES.VALIDATION,
      `${source} must contain at least one of: command, url, type.`,
      'Provide either a stdio `command` (with optional `args`/`env`) or a remote `url`/`type`.',
      false,
    );
  }
  // Cast to the canonical shape — fields are optional in the type so any
  // subset of (command, args, env, url, type, headers) round-trips
  // through writeConfig untouched.
  return obj as McpServerConfig;
}

/**
 * Build the canonical {@link McpServerConfig} from the verb's input
 * sources, in this priority order:
 *
 * 1. Inline `command [args...]` after `--` (highest precedence for
 *    transport shape).
 * 2. JSON loaded from `--from <file>` (used as a base).
 * 3. `--env KEY=VALUE` (merged on top of any env from the JSON file).
 *
 * @internal
 */
async function buildConfigFromOptions(
  inlineArgs: string[],
  opts: McpInstallOptions,
): Promise<McpServerConfig> {
  let base: McpServerConfig | null = null;

  if (opts.from !== undefined && opts.from.length > 0) {
    if (!existsSync(opts.from)) {
      throw new LAFSCommandError(
        MCP_ERROR_CODES.NOT_FOUND,
        `--from file does not exist: ${opts.from}`,
        'Check the path and try again.',
        false,
      );
    }
    let parsed: unknown;
    try {
      const content = await readFile(opts.from, 'utf8');
      parsed = JSON.parse(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LAFSCommandError(
        MCP_ERROR_CODES.VALIDATION,
        `Failed to read --from JSON: ${message}`,
        'Ensure the file is valid JSON containing an MCP server config object.',
        false,
      );
    }
    base = coerceServerConfig(parsed, `--from ${opts.from}`);
  }

  if (inlineArgs.length > 0) {
    const command = inlineArgs[0];
    if (command === undefined || command.length === 0) {
      throw new LAFSCommandError(
        MCP_ERROR_CODES.VALIDATION,
        'Inline command was empty.',
        'Pass `--` followed by a command, e.g. `-- npx -y @mcp/server-github`.',
        false,
      );
    }
    const args = inlineArgs.slice(1);
    base = {
      ...(base ?? {}),
      command,
      ...(args.length > 0 ? { args } : {}),
    };
  }

  if (base === null) {
    throw new LAFSCommandError(
      MCP_ERROR_CODES.VALIDATION,
      'Either an inline `-- <command> [args...]` or `--from <file>` is required.',
      'Pass an MCP server definition via inline command or a JSON file.',
      false,
    );
  }

  if (opts.env !== undefined && opts.env.length > 0) {
    const env: Record<string, string> = { ...(base.env ?? {}) };
    for (const entry of opts.env) {
      const [k, v] = parseEnvAssignment(entry);
      env[k] = v;
    }
    base = { ...base, env };
  }

  return base;
}

/**
 * Registers the `caamp mcp install` subcommand.
 *
 * @param parent - Parent `mcp` Command to attach the subcommand to.
 *
 * @example
 * ```bash
 * # Inline form
 * caamp mcp install github --provider claude-desktop -- \
 *   npx -y @modelcontextprotocol/server-github
 *
 * # From file
 * caamp mcp install github --provider cursor --from ./github.json
 *
 * # With env vars
 * caamp mcp install github --provider claude-code \
 *   --env GITHUB_TOKEN=ghp_xxx -- \
 *   npx -y @modelcontextprotocol/server-github
 * ```
 *
 * @public
 */
export function registerMcpInstallCommand(parent: Command): void {
  parent
    .command('install <serverName> [args...]')
    .description('Install an MCP server entry into a provider config file')
    .option('--provider <id>', 'Provider id to install into (required)')
    .option('--from <file>', 'Path to a JSON file containing an MCP server config')
    .option(
      '--env <kv>',
      'Repeatable env var KEY=VALUE',
      (value: string, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option('--scope <scope>', 'Scope: project|global (default: project)')
    .option('--force', 'Overwrite an existing server entry')
    .option('--project-dir <path>', 'Project directory for the project scope (default: cwd)')
    .action(async (serverName: string, inlineArgs: string[], opts: McpInstallOptions) =>
      runLafsCommand('mcp.install', 'standard', async () => {
        if (opts.provider === undefined || opts.provider.length === 0) {
          throw new LAFSCommandError(
            MCP_ERROR_CODES.VALIDATION,
            '--provider <id> is required',
            'Pass a provider id, e.g. --provider claude-desktop.',
            false,
          );
        }
        if (serverName.length === 0) {
          throw new LAFSCommandError(
            MCP_ERROR_CODES.VALIDATION,
            'Server name is required',
            'Pass a non-empty server name as the first positional argument.',
            false,
          );
        }
        const provider = requireMcpProvider(opts.provider);
        const scope = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(scope, opts.projectDir);
        const config = await buildConfigFromOptions(inlineArgs, opts);

        const result = await installMcpServer(provider, serverName, config, {
          scope,
          force: opts.force ?? false,
          projectDir,
        });

        if (!result.installed && result.conflicted) {
          throw new LAFSCommandError(
            MCP_ERROR_CODES.CONFLICT,
            `Server ${serverName} already exists in ${result.sourcePath}`,
            'Re-run with --force to overwrite the existing entry.',
            false,
            { sourcePath: result.sourcePath, providerId: result.providerId },
          );
        }

        return {
          installed: true,
          conflicted: result.conflicted,
          provider: provider.id,
          serverName,
          scope,
          sourcePath: result.sourcePath,
          config,
        };
      }),
    );
}
