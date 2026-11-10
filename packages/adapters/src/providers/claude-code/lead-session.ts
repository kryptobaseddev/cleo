/**
 * The no-hands lead's Claude Code session (T14363): argv for both modes, the
 * session hooks, and the interactive run.
 *
 * - `interactive` (default): no `--print`; the lead opens in the caller's
 *   terminal (stdio inherited, not detached) and asks the owner with
 *   `AskUserQuestion`, its only built-in tool.
 * - `detached`: `--print`, no built-in tool at all; owner decisions go to the
 *   owner's AgentMBX mailbox (the prompt says how).
 *
 * In both, tools are an allow list (T14423): only the runner, mbx and (when
 * interactive) `AskUserQuestion`; `dontAsk`, no settings sources, and the
 * denied tools as a second layer.
 *
 * `cleo` and `agentmbx` in hooks and the runner entry are absolute paths
 * resolved at spawn time from the absolute entries of PATH, never relative
 * entries that would resolve inside the project.
 *
 * @task T14363
 * @epic T14351
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { LeadMode, SpawnContext } from '@cleocode/contracts';
import { LEAD_ASK_TOOL } from '@cleocode/contracts/operations/orchestrate.js';
import { findOnPath, pathDelimiterFor, pathEnvKey, splitPathEnv } from '@cleocode/paths';
import { type LeadMcpSetup, leadAllowedTools } from './lead-mcp.js';

/** The first user turn of a lead: its instructions are the appended system prompt. */
export const LEAD_KICKOFF_PROMPT =
  'You are the no-hands lead. Your full instructions are in your system prompt: follow them, using only your allowed tools.';

/**
 * The lead's pre-assigned provider session id (`options.leadSessionId`), when it
 * is a UUID; `undefined` otherwise.
 *
 * @param options - Spawn context options.
 * @returns The session id, or undefined.
 * @task T14363
 */
export function leadSessionId(options: SpawnContext['options']): string | undefined {
  const id = options?.leadSessionId;
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : undefined;
}

/**
 * The lead's mode (`options.leadMode`); anything but `detached` is interactive.
 *
 * @param options - Spawn context options.
 * @returns The mode.
 * @task T14363
 */
export function leadModeOf(options: SpawnContext['options']): LeadMode {
  return options?.leadMode === 'detached' ? 'detached' : 'interactive';
}

/**
 * Resolve a binary to an absolute path from the ABSOLUTE entries of PATH only,
 * so a relative entry (`.`, `node_modules/.bin`) can never pick a binary out
 * of the project the lead runs in.
 *
 * @param name - Binary name, e.g. `cleo`.
 * @param env - Environment. @defaultValue `process.env`
 * @returns The absolute path, or `null` when not found.
 * @task T14363
 */
export function resolveAbsoluteBinary(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const key = pathEnvKey(env);
  const absolute = splitPathEnv(env[key]).filter((dir) => isAbsolute(dir));
  return findOnPath(name, { env: { ...env, [key]: absolute.join(pathDelimiterFor()) } });
}

/** Single-quote a value for a hook's shell command; refuses one holding a quote. */
function shellQuote(value: string): string {
  if (value.includes("'")) throw new Error(`refusing a hook argument with a quote: ${value}`);
  return `'${value}'`;
}

/** Absolute binaries the lead's hooks call; `null` when not found. */
export interface LeadBinaries {
  readonly cleo: string | null;
  readonly agentmbx: string | null;
}

/**
 * Claude Code settings for a lead, passed with `--settings` (which still
 * applies under `--setting-sources ""`):
 *
 * - `SessionStart` deletes the MCP config file: Claude Code has read it, and
 *   it may hold the mbx server's env secrets.
 * - `SessionEnd` removes the spawn's temp directory, ends the lead's CLEO
 *   session (releasing its epic claim) and releases the lead mailbox held
 *   for this session. A lead killed before its hooks run is reaped by the
 *   next `cleo orchestrate lead` or `cleo orchestrate status`.
 *
 * @param input - Temp dir, MCP file, the lead's session id and absolute binaries.
 * @returns The settings JSON.
 * @task T14363
 */
export function leadSessionSettings(input: {
  readonly dir: string;
  readonly mcpFile: string;
  readonly sessionId?: string;
  readonly binaries: LeadBinaries;
}): string {
  const end = [`rm -rf ${shellQuote(input.dir)}`];
  if (input.binaries.cleo) {
    end.push(`${shellQuote(input.binaries.cleo)} session end --note 'lead exited'`);
  }
  if (input.binaries.agentmbx && input.sessionId !== undefined) {
    end.push(
      `${shellQuote(input.binaries.agentmbx)} identity release --cli claude --session ${input.sessionId} --json`,
    );
  }
  const hook = (command: string) => [{ hooks: [{ type: 'command', command }] }];
  return JSON.stringify({
    hooks: {
      SessionStart: hook(`rm -f ${shellQuote(input.mcpFile)}`),
      SessionEnd: hook(`${end.join('; ')}; true`),
    },
  });
}

/**
 * The lead's `claude` argv. An allow list, layered:
 *
 * - `--restricted --tools <built-ins>`: interactive gets `AskUserQuestion`
 *   only; detached gets no built-in tool at all;
 * - `--mcp-config <file> --strict-mcp-config`: only the runner and a
 *   validated mbx; `--allowedTools` names exactly the allowed tools;
 * - `--permission-mode dontAsk` and `--setting-sources ""`: anything not
 *   allowed is denied whatever the user's settings say;
 * - `--disallowedTools <denied>` as a second layer.
 *
 * Interactive drops `--print` and `--output-format`; detached keeps both.
 * The prompt file is the appended system prompt (the lead cannot Read
 * files); the user turn is {@link LEAD_KICKOFF_PROMPT}.
 *
 * @param input - Mode, denied tools, MCP setup, prompt file, session id, extra settings args.
 * @returns Argument list for the `claude` binary.
 * @task T14363
 */
export function buildLeadArgs(input: {
  readonly mode: LeadMode;
  readonly denied: readonly string[];
  readonly leadMcp: LeadMcpSetup;
  readonly promptFile: string;
  readonly sessionId?: string;
  readonly settingsArgs?: readonly string[];
}): string[] {
  const interactive = input.mode === 'interactive';
  const allowed = [
    ...leadAllowedTools(input.leadMcp.report),
    ...(interactive ? [LEAD_ASK_TOOL] : []),
  ];
  // Variadic flags are each followed by another flag, so none swallows the kickoff prompt.
  return [
    ...(interactive ? [] : ['--print']),
    '--restricted',
    '--tools',
    interactive ? LEAD_ASK_TOOL : '',
    '--allowedTools',
    allowed.join(','),
    '--disallowedTools',
    input.denied.join(','),
    '--mcp-config',
    input.leadMcp.config,
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    '',
    ...(input.sessionId !== undefined ? ['--session-id', input.sessionId] : []),
    ...(input.settingsArgs ?? []),
    '--append-system-prompt-file',
    input.promptFile,
    ...(interactive ? [] : ['--output-format', 'json']),
    LEAD_KICKOFF_PROMPT,
  ];
}

/** Outcome of {@link runInteractiveLead}. */
export interface InteractiveLeadExit {
  /** The lead's pid while it ran. */
  readonly pid: number | undefined;
  /** Exit code; `null` when killed by a signal. */
  readonly exitCode: number | null;
}

/**
 * Run an interactive lead in the caller's terminal: stdio inherited, not
 * detached, awaited until the owner ends the session.
 *
 * @param command - The `claude` binary.
 * @param args - From {@link buildLeadArgs} with mode `interactive`.
 * @param opts - Working directory, environment and a started-pid callback.
 * @returns The pid and exit code once the session ends.
 * @task T14363
 */
export function runInteractiveLead(
  command: string,
  args: readonly string[],
  opts: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    /** Called with the lead's pid once it started (the lead record names it). */
    readonly onStart?: (pid: number) => void;
  },
): Promise<InteractiveLeadExit> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, [...args], {
      stdio: 'inherit',
      detached: false,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    child.once('error', reject);
    if (child.pid !== undefined) opts.onStart?.(child.pid);
    child.once('exit', (code) => resolve({ pid: child.pid, exitCode: code }));
  });
}
