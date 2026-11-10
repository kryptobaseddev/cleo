/**
 * Lead command runner: the one way a no-hands lead runs a command (T14374).
 *
 * A lead has no Bash ({@link LEAD_DENIED_TOOLS}), yet it dispatches and
 * reviews through `cleo` and `gh`. This module gives it a narrow route: an
 * argv array is checked against {@link LEAD_COMMAND_ALLOWLIST} and, if
 * allowed, executed with `execFile` semantics (no shell, ever). Anything else
 * is refused before a process starts.
 *
 * {@link serveLeadCommandRunner} exposes the runner as a one-tool MCP stdio
 * server ({@link LEAD_RUNNER_TOOL_NAME}), started by
 * `cleo orchestrate lead-runner` and declared in the lead's agent definition.
 *
 * @module orchestration/lead-command-runner
 * @task T14374
 * @epic T14351
 */

import { execFile } from 'node:child_process';
import * as readline from 'node:readline';
import type { LeadCommandBinary, LeadCommandRule } from '@cleocode/contracts';
import {
  LEAD_COMMAND_ALLOWLIST,
  LEAD_RUNNER_MCP_SERVER,
  LEAD_RUNNER_TOOL_NAME,
} from '@cleocode/contracts/operations/orchestrate.js';

/**
 * Characters refused in any argv word. `execFile` never hands argv to a shell,
 * so these are harmless to the runner itself; refusing them keeps a word from
 * becoming a shell command if a callee ever re-evaluates it.
 */
const SHELL_METACHARACTERS = /[;&|`$<>\\\n\r\0]/;

/** Most bytes kept from each of stdout and stderr. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Default wall-clock limit for one command. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Outcome of {@link checkLeadCommand}. */
export type LeadCommandCheck = { allowed: true } | { allowed: false; reason: string };

/** Outcome of {@link runLeadCommand}. */
export type LeadCommandResult =
  | { allowed: false; reason: string }
  | { allowed: true; exitCode: number; stdout: string; stderr: string };

/** Options for {@link runLeadCommand} and {@link serveLeadCommandRunner}. */
export interface LeadCommandRunOptions {
  /** Working directory. @defaultValue `process.cwd()` */
  readonly cwd?: string;
  /** Environment. @defaultValue `process.env` */
  readonly env?: NodeJS.ProcessEnv;
  /** Wall-clock limit in milliseconds. @defaultValue 10 minutes */
  readonly timeoutMs?: number;
}

function isBinary(word: string): word is LeadCommandBinary {
  return Object.hasOwn(LEAD_COMMAND_ALLOWLIST, word);
}

/** Whether `args` satisfies `rule`, or why not. */
function matchRule(rule: LeadCommandRule, args: readonly string[]): string | null {
  if (!rule.verb.every((word, i) => args[i] === word)) return 'no match';
  const sub = args[rule.verb.length];
  if (sub !== undefined && rule.denySubcommands?.includes(sub)) {
    return `"${rule.verb.join(' ')} ${sub}" is not allowed for a lead`;
  }
  for (const flag of rule.requireFlags ?? []) {
    const negated = `--no-${flag.replace(/^--/, '')}`;
    if (!args.includes(flag) || args.some((a) => a === negated || a.startsWith(`${flag}=`))) {
      return `"${rule.verb.join(' ')}" is allowed only with ${(rule.requireFlags ?? []).join(' ')}`;
    }
  }
  return null;
}

/**
 * Check an argv array against the lead allow-list without running it.
 *
 * @param argv - Binary followed by its arguments, e.g. `['cleo', 'show', 'T1']`.
 * @returns `allowed: true`, or the reason it is refused.
 *
 * @example
 * ```typescript
 * checkLeadCommand(['gh', 'pr', 'merge', '1']).allowed; // false
 * ```
 */
export function checkLeadCommand(argv: readonly string[]): LeadCommandCheck {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((w) => typeof w === 'string')) {
    return { allowed: false, reason: 'argv must be a non-empty array of strings' };
  }
  const bad = argv.find((w) => SHELL_METACHARACTERS.test(w));
  if (bad !== undefined) {
    return { allowed: false, reason: `shell metacharacters are refused: ${JSON.stringify(bad)}` };
  }
  const [bin, ...args] = argv;
  if (bin === undefined || !isBinary(bin)) {
    return { allowed: false, reason: `only cleo and gh may run, not ${JSON.stringify(bin)}` };
  }
  let reason = `"${bin} ${args.slice(0, 2).join(' ')}" is not on the lead allow-list`;
  for (const rule of LEAD_COMMAND_ALLOWLIST[bin]) {
    const miss = matchRule(rule, args);
    if (miss === null) return { allowed: true };
    if (miss !== 'no match') reason = miss;
  }
  return { allowed: false, reason };
}

/**
 * Run an allowed command with `execFile` (no shell). A refused argv never
 * starts a process.
 *
 * @param argv - Binary followed by its arguments.
 * @param options - Working directory, environment and timeout.
 * @returns The refusal, or the exit code and captured output.
 *
 * @example
 * ```typescript
 * const r = await runLeadCommand(['cleo', 'show', 'T1', '--full']);
 * ```
 */
export function runLeadCommand(
  argv: readonly string[],
  options: LeadCommandRunOptions = {},
): Promise<LeadCommandResult> {
  const check = checkLeadCommand(argv);
  if (!check.allowed) return Promise.resolve(check);
  const [bin = '', ...args] = argv;
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        const spawnFailure = err && typeof err.code === 'string' ? `${err.message}\n` : '';
        resolve({ allowed: true, exitCode: code, stdout, stderr: `${spawnFailure}${stderr}` });
      },
    );
    // The command gets no input: a verb that waits on stdin sees EOF, never hangs.
    child.stdin?.end();
  });
}

/** Inbound JSON-RPC frame. */
interface JsonRpcRequest {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: { name?: string; arguments?: { argv?: unknown } };
}

/** MCP protocol revision the runner speaks. */
const PROTOCOL_VERSION = '2024-11-05';

/** The runner's single tool, as listed by `tools/list`. */
const RUNNER_TOOL = {
  name: LEAD_RUNNER_TOOL_NAME,
  description:
    'Run one allow-listed cleo or gh command. Pass argv as an array of words (no shell): ' +
    'cleo orchestrate/show/find/list/briefing, cleo review packet|check|verdict, ' +
    'cleo done --from-merge --dry-run, cleo memory find|fetch, cleo session status, ' +
    'cleo decide ask, cleo merge train; gh pr view|list|checks|diff|comment, gh run list|view. Anything else is refused.',
  inputSchema: {
    type: 'object',
    properties: {
      argv: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Binary and arguments, e.g. ["cleo", "show", "T123", "--full"].',
      },
    },
    required: ['argv'],
    additionalProperties: false,
  },
} as const;

/** Answer one JSON-RPC request; `null` for a notification. */
async function handle(req: JsonRpcRequest, options: LeadCommandRunOptions): Promise<object | null> {
  const id = req.id ?? null;
  const reply = (result: object) => ({ jsonrpc: '2.0', id, result });
  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: LEAD_RUNNER_MCP_SERVER, version: '1.0.0' },
      });
    case 'tools/list':
      return reply({ tools: [RUNNER_TOOL] });
    case 'tools/call': {
      if (req.params?.name !== LEAD_RUNNER_TOOL_NAME) {
        return reply({ content: [{ type: 'text', text: 'Unknown tool' }], isError: true });
      }
      const argv = req.params.arguments?.argv;
      const result: LeadCommandResult = Array.isArray(argv)
        ? await runLeadCommand(argv, options)
        : { allowed: false, reason: 'argv must be an array of strings' };
      const isError = !result.allowed || result.exitCode !== 0;
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError });
    }
    case 'ping':
      return reply({});
    default:
      if (req.id === undefined) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found` } };
  }
}

/**
 * Serve the runner as a one-tool MCP server over newline-delimited JSON-RPC.
 *
 * @param io - Streams to read requests from and write responses to.
 * @param options - Working directory, environment and timeout for each command.
 * @returns Resolves when the input stream closes.
 *
 * @example
 * ```typescript
 * await serveLeadCommandRunner({ input: process.stdin, output: process.stdout });
 * ```
 */
export function serveLeadCommandRunner(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  options: LeadCommandRunOptions = {},
): Promise<void> {
  const rl = readline.createInterface({ input: io.input, terminal: false });
  const pending: Promise<void>[] = [];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      const error = { code: -32700, message: 'Parse error' };
      io.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error })}\n`);
      return;
    }
    pending.push(
      handle(req, options).then((res) => {
        if (res) io.output.write(`${JSON.stringify(res)}\n`);
      }),
    );
  });
  return new Promise((resolve) => {
    rl.on('close', () => {
      void Promise.all(pending).then(() => resolve());
    });
  });
}
