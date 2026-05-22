/**
 * Handler Toolkit — shared SDK surface for CLI dispatch glue.
 *
 * Provides five primitives that fat-handler extractions (T10062 / T9833c)
 * will consume. Promotes the `makeMemorySubcommand` pattern from memory.ts
 * into a generic `makeDispatchSubcommand` factory.
 *
 * @module handler-toolkit
 * @epic T9833
 * @task T10060
 */

import readline from 'node:readline';
import type { Gateway } from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import type { ArgDef, CommandDef } from 'citty';
import { defineCommand } from 'citty';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';
import type { DispatchResponse } from '../../dispatch/types.js';
import { type CliOutputOptions, cliError, cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// 1. dispatchAndRender
// ---------------------------------------------------------------------------

/**
 * Options for {@link dispatchAndRender}.
 */
export interface DispatchAndRenderOptions {
  /**
   * Output rendering options forwarded to `dispatchFromCli`.
   * At minimum, `command` should match a registered human renderer key.
   */
  output?: CliOutputOptions;
}

/**
 * Dispatch an operation through the engine and render its output.
 *
 * Thin wrapper around `dispatchFromCli` that accepts a plain `params`
 * object and the canonical `output` rendering options. Returns the raw
 * `DispatchResponse` so callers can inspect `success` or `data` when
 * needed (though output has already been emitted).
 *
 * @param gateway - `'query'` for read-only, `'mutate'` for side-effecting
 * @param domain - Dispatch domain (e.g. `'tasks'`, `'memory'`)
 * @param operation - Operation within the domain (e.g. `'show'`)
 * @param params - Operation parameters
 * @param opts - Rendering options
 * @returns The raw `DispatchResponse` (output already rendered to stdout)
 *
 * @example
 * await dispatchAndRender('query', 'tasks', 'show', { taskId: 'T1234' }, {
 *   output: { command: 'show', operation: 'tasks.show' },
 * });
 */
export async function dispatchAndRender(
  gateway: Gateway,
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
  opts?: DispatchAndRenderOptions,
): Promise<DispatchResponse> {
  const response = await dispatchRaw(gateway, domain, operation, params);
  applyOutputFlags(response, {
    command: opts?.output?.command ?? operation,
    operation: opts?.output?.operation ?? `${domain}.${operation}`,
    ...opts?.output,
  });
  return response;
}

// ---------------------------------------------------------------------------
// 2. applyOutputFlags
// ---------------------------------------------------------------------------

/**
 * Apply output flags (json / quiet / format) to a raw `DispatchResponse`.
 *
 * Delegates to `dispatchFromCli`'s internal rendering path by re-emitting
 * the response via the CLI output layer. Exits the process with a non-zero
 * code on failure, matching `dispatchFromCli` behavior.
 *
 * @param response - Raw response from `dispatchRaw`
 * @param outputOpts - Rendering options (command, operation, message, etc.)
 *
 * @example
 * const response = await dispatchRaw('query', 'tasks', 'list', {});
 * applyOutputFlags(response, { command: 'list', operation: 'tasks.list' });
 */
export function applyOutputFlags(response: DispatchResponse, outputOpts: CliOutputOptions): void {
  if (response.success) {
    const opts: CliOutputOptions = {
      ...outputOpts,
    };
    if (opts.page === undefined && response.page !== undefined) {
      opts.page = response.page;
    }
    if (opts.responseMeta === undefined) {
      opts.responseMeta = response.meta;
    }
    cliOutput(response.data, opts);
  } else {
    const errorCode = response.error?.code ?? 'E_GENERAL';
    const exitCode = response.error?.exitCode ?? 1;
    cliError(
      response.error?.message ?? 'Unknown error',
      exitCode,
      {
        name: String(errorCode),
        details: response.error?.details,
        fix: response.error?.fix,
        alternatives: response.error?.alternatives,
      },
      {
        operation: outputOpts.operation ?? 'cli.error',
        requestId: response.meta.requestId,
        duration_ms: response.meta.duration_ms,
        timestamp: response.meta.timestamp,
      },
    );
    process.exit(exitCode);
  }
}

// ---------------------------------------------------------------------------
// 3. withConfirmationFlow
// ---------------------------------------------------------------------------

/**
 * Options for {@link withConfirmationFlow}.
 */
export interface ConfirmationFlowOptions {
  /**
   * Skip interactive prompt and proceed immediately.
   * Equivalent to the `--yes` flag.
   */
  yes?: boolean;
  /**
   * Preview the action without executing it.
   * When `true`, the `action` callback is NOT invoked.
   */
  dryRun?: boolean;
  /**
   * Question shown to the user (default: `'Proceed? [y/N]'`).
   */
  question?: string;
  /**
   * Message printed when `dryRun` is `true` instead of executing.
   */
  dryRunMessage?: string;
}

/**
 * Wrap a destructive action with `--yes` / `--dry-run` confirmation logic.
 *
 * - If `dryRun` is true: print `dryRunMessage` and return without calling `action`.
 * - If `yes` is true: call `action` immediately without prompting.
 * - Otherwise: prompt interactively via stderr (preserves clean stdout for JSON consumers).
 *   If the user declines, return without calling `action`.
 *
 * @param action - Async callback to execute when confirmed
 * @param opts - Confirmation options
 *
 * @example
 * await withConfirmationFlow(
 *   () => performDeletion(),
 *   { yes: args.yes, dryRun: args['dry-run'], question: 'Delete this task? [y/N]' },
 * );
 */
export async function withConfirmationFlow(
  action: () => Promise<void>,
  opts: ConfirmationFlowOptions = {},
): Promise<void> {
  if (opts.dryRun) {
    const msg = opts.dryRunMessage ?? '[dry-run] Action skipped — no changes made.';
    process.stderr.write(`${msg}\n`);
    return;
  }

  if (!opts.yes) {
    const question = opts.question ?? 'Proceed?';
    const confirmed = await promptYesNo(question);
    if (!confirmed) {
      process.stderr.write('Aborted.\n');
      return;
    }
  }

  await action();
}

/**
 * Prompt the user with a yes/no question via TTY readline (stderr).
 *
 * @internal
 */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [y/N]: `, (answer: string) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// 4. loadAgentRegistry
// ---------------------------------------------------------------------------

/**
 * Return type for {@link loadAgentRegistry}.
 */
export interface LoadedAgentRegistry {
  /** The `AgentRegistryAccessor` instance bound to the current project root. */
  registry: import('@cleocode/core/agents').AgentRegistryAccessor;
  /** The project root path used to open the registry. */
  projectRoot: string;
}

/**
 * Canonical agent registry loader.
 *
 * Lazily imports `AgentRegistryAccessor` from `@cleocode/core/agents`
 * and constructs it bound to the current `getProjectRoot()`. Centralizes
 * the repeated dynamic-import pattern scattered across agent command
 * handlers.
 *
 * @returns The accessor instance and the resolved project root.
 *
 * @example
 * const { registry } = await loadAgentRegistry();
 * const agents = await registry.list();
 */
export async function loadAgentRegistry(): Promise<LoadedAgentRegistry> {
  const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
  const projectRoot = getProjectRoot();
  const registry = new AgentRegistryAccessor(projectRoot);
  return { registry, projectRoot };
}

// ---------------------------------------------------------------------------
// 5. execCleoCommand
// ---------------------------------------------------------------------------

/**
 * Options for {@link execCleoCommand}.
 */
export interface ExecCleoCommandOptions {
  /**
   * Working directory for the child process.
   * Defaults to `process.cwd()`.
   */
  cwd?: string;
  /**
   * Additional environment variables merged into `process.env`.
   */
  env?: Record<string, string>;
  /**
   * Timeout in milliseconds (default: 30 000).
   */
  timeoutMs?: number;
}

/**
 * Result returned by {@link execCleoCommand}.
 */
export interface ExecCleoCommandResult {
  /** Exit code of the child process (null if killed by signal). */
  exitCode: number | null;
  /** Text written to stdout by the child. */
  stdout: string;
  /** Text written to stderr by the child. */
  stderr: string;
  /** `true` when `exitCode === 0`. */
  ok: boolean;
}

/**
 * Invoke a sibling `cleo` CLI command in a child process.
 *
 * Resolves the CLI entry-point via the module resolution chain
 * (dist/cli/index.js relative to this file's package root).
 * Useful for composition — e.g. a handler that needs to trigger
 * `cleo session end` before proceeding.
 *
 * @param args - CLI arguments after the `cleo` binary (e.g. `['session', 'status']`)
 * @param opts - Child process options
 * @returns The exit code, stdout, and stderr of the child process.
 *
 * @example
 * const result = await execCleoCommand(['session', 'status', '--json']);
 * if (!result.ok) throw new Error(`cleo failed: ${result.stderr}`);
 * const data = JSON.parse(result.stdout);
 */
export async function execCleoCommand(
  args: string[],
  opts: ExecCleoCommandOptions = {},
): Promise<ExecCleoCommandResult> {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const thisFile = fileURLToPath(import.meta.url);
  // Resolve: packages/cleo/src/cli/lib/ → packages/cleo/dist/cli/index.js
  const cliDist = join(dirname(thisFile), '..', '..', '..', '..', 'dist', 'cli', 'index.js');

  const result = spawnSync('node', [cliDist, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 30_000,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
  });

  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ok: result.status === 0,
  };
}

// ---------------------------------------------------------------------------
// 6. makeDispatchSubcommand factory
// ---------------------------------------------------------------------------

/**
 * Options for {@link makeDispatchSubcommand}.
 */
export interface MakeDispatchSubcommandOptions {
  /** Subcommand name (e.g. `'digest'`, `'precompact-flush'`). */
  name: string;
  /** One-line description surfaced in `--help`. */
  description: string;
  /**
   * citty-shaped args record (positional + flags).
   * A `--json` boolean flag is merged automatically.
   */
  args: Record<string, ArgDef>;
  /** `'query'` (read-only) or `'mutate'` (side-effecting) gateway. */
  gateway: Gateway;
  /** Dispatch domain (e.g. `'memory'`, `'tasks'`). */
  domain: string;
  /** Dispatch operation within the domain (e.g. `'digest'`, `'backfill.run'`). */
  operation: string;
  /** Output render options — CLI command key + qualified operation label. */
  output: { command: string; operation: string };
  /**
   * Build the dispatch params from the parsed citty args.
   *
   * @param args - The raw citty args object
   * @returns Params forwarded to the dispatch handler
   */
  paramBuilder: (args: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Generic subcommand factory — promotes the `makeMemorySubcommand` pattern
 * from `memory.ts` to a shared, domain-agnostic primitive.
 *
 * Creates a citty `CommandDef` that:
 * 1. Merges a shared `--json` flag into the provided `args`.
 * 2. Calls `dispatchFromCli` with the mapped params.
 *
 * @param opts - Subcommand configuration
 * @returns A citty `CommandDef` ready for use in `subCommands: { ... }`.
 *
 * @example
 * const digestCommand = makeDispatchSubcommand({
 *   name: 'digest',
 *   description: 'Show memory digest',
 *   args: { brief: { type: 'boolean', description: 'Compact output' } },
 *   gateway: 'query',
 *   domain: 'memory',
 *   operation: 'digest',
 *   output: { command: 'memory-digest', operation: 'memory.digest' },
 *   paramBuilder: (args) => ({ brief: args['brief'] as boolean | undefined }),
 * });
 */
export function makeDispatchSubcommand(opts: MakeDispatchSubcommandOptions): CommandDef {
  const mergedArgs: Record<string, ArgDef> = {
    ...opts.args,
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  };

  return defineCommand({
    meta: { name: opts.name, description: opts.description },
    args: mergedArgs,
    async run({ args }) {
      const params = opts.paramBuilder(args as Record<string, unknown>);
      await dispatchFromCli(opts.gateway, opts.domain, opts.operation, params, opts.output);
    },
  });
}
