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
import type { LeadCommandBinary, LeadCommandRule, LeadFlagArity } from '@cleocode/contracts';
import {
  LEAD_CLEO_GLOBAL_FLAGS,
  LEAD_COMMAND_ALLOWLIST,
  LEAD_RUNNER_MCP_SERVER,
  LEAD_RUNNER_TOOL_NAME,
} from '@cleocode/contracts/operations/orchestrate.js';
import { type AgentMbxClient, createAgentMbxClient } from '../orchestrate/agentmbx.js';
import { listLeadRecords } from '../orchestrate/lead-records.js';
import { getProjectRoot } from '../paths.js';

/**
 * Characters refused in the binary and command words: command separators,
 * redirection, backticks and line breaks. Positionals and flag values are
 * never checked: the runner uses `execFile` with `shell: false`, so no value
 * ever reaches a shell, and verdict or comment text such as `A & B; x > y`
 * passes through verbatim.
 */
const SHELL_METACHARACTERS = /[;&|`<>\n\r\0]/;

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
  /** AgentMBX adapter for live mailbox verification before dispatch. */
  readonly mbxClient?: AgentMbxClient;
}

function metacharacters(word: string): LeadCommandCheck {
  return { allowed: false, reason: `shell metacharacters are refused: ${JSON.stringify(word)}` };
}

function isBinary(word: string): word is LeadCommandBinary {
  return Object.hasOwn(LEAD_COMMAND_ALLOWLIST, word);
}

/**
 * Parse the words after `rule.verb` against the rule, allow-only: positional
 * words first, then listed flags only. Refuses an unknown flag, any `--no-*`
 * form, a value on a boolean flag, a missing or swallowed value (the next word
 * starts with `-`), a repeated flag, a word after a boolean flag, too many
 * positionals, and a non-numeric positional where the rule wants a number. A required flag counts only when the parse set it.
 *
 * @returns `null` when allowed, else the reason.
 */
function parseRule(
  rule: LeadCommandRule,
  rest: readonly string[],
  globals: Readonly<Record<string, LeadFlagArity>>,
): string | null {
  const cmd = rule.verb.join(' ');
  const set = new Set<string>();
  let positionals = 0;
  let inFlags = false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? '';
    if (!word.startsWith('-')) {
      if (inFlags) return `"${word}" follows a flag that takes no value; put positionals first`;
      positionals++;
      if (positionals > (rule.positionals ?? 0)) return `too many positional words for "${cmd}"`;
      if (rule.numericPositionals && !/^[0-9]+$/.test(word)) {
        return `"${cmd}" takes only a number, not ${JSON.stringify(word)}`;
      }
      continue;
    }
    inFlags = true;
    if (word.startsWith('--no-')) return `negated flags are refused: ${word}`;
    const eq = word.indexOf('=');
    const name = eq === -1 ? word : word.slice(0, eq);
    const arity = Object.hasOwn(rule.flags ?? {}, name)
      ? rule.flags?.[name]
      : Object.hasOwn(globals, name)
        ? globals[name]
        : undefined;
    if (arity === undefined) return `flag ${name} is not allowed for "${cmd}"`;
    if (set.has(name)) return `flag ${name} is repeated`;
    if (arity === 'boolean') {
      if (eq !== -1) return `flag ${name} takes no value`;
    } else if (eq !== -1) {
      if (eq === word.length - 1) return `flag ${name} needs a value`;
    } else {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return `flag ${name} needs a value (write ${name}=<value> for one starting with "-")`;
      }
      i++;
    }
    set.add(name);
  }
  const missing = (rule.requireFlags ?? []).filter((f) => !set.has(f));
  if (missing.length > 0) return `"${cmd}" is allowed only with ${missing.join(' ')}`;
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
  const [bin, ...args] = argv;
  // Only the binary and command words are checked; see SHELL_METACHARACTERS.
  const bad = [bin, ...args.slice(0, 2)].find(
    (w, i) => w !== undefined && (i === 0 || !w.startsWith('-')) && SHELL_METACHARACTERS.test(w),
  );
  if (bin === undefined || !isBinary(bin)) {
    if (bad !== undefined) return metacharacters(bad);
    return { allowed: false, reason: `only cleo and gh may run, not ${JSON.stringify(bin)}` };
  }
  const rules = LEAD_COMMAND_ALLOWLIST[bin];
  const rule = rules.find((r) => r.verb.every((word, i) => args[i] === word));
  if (rule === undefined) {
    if (bad !== undefined) return metacharacters(bad);
    const lead = args.findIndex((w) => w.startsWith('-'));
    const words = lead === -1 ? args : args.slice(0, lead);
    const flagFirst =
      lead !== -1 &&
      rules.some((r) => words.every((w, i) => r.verb[i] === w) && r.verb.length > words.length);
    return {
      allowed: false,
      reason: flagFirst
        ? 'flags must follow the full command words'
        : `"${bin} ${args.slice(0, 2).join(' ')}" is not on the lead allow-list`,
    };
  }
  const globals = bin === 'cleo' ? LEAD_CLEO_GLOBAL_FLAGS : {};
  const reason = parseRule(rule, args.slice(rule.verb.length), globals);
  return reason === null ? { allowed: true } : { allowed: false, reason };
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
export async function runLeadCommand(
  argv: readonly string[],
  options: LeadCommandRunOptions = {},
): Promise<LeadCommandResult> {
  const check = checkLeadCommand(argv);
  if (!check.allowed) return check;
  const [bin = '', ...args] = argv;
  let env = options.env ?? process.env;
  if (
    bin === 'cleo' &&
    args[0] === 'orchestrate' &&
    ['spawn', 'spawn-execute', 'fanout', 'handoff'].includes(args[1] ?? '')
  ) {
    const lead = listLeadRecords(getProjectRoot(options.cwd)).find(
      (record) => record.cleoSessionId === env['CLEO_SESSION_ID'],
    );
    if (!lead?.mailbox)
      return {
        allowed: false,
        reason:
          'Dispatch requires the mailbox recorded for this lead session; start with cleo orchestrate lead <epicId>.',
      };
    const status = await (options.mbxClient ?? createAgentMbxClient()).status({
      cli: lead.providerCli,
      session: lead.providerSessionId,
    });
    if (
      !status.ok ||
      status.value.name !== lead.mailbox ||
      status.value.state !== 'bound' ||
      status.value.role !== 'lead'
    ) {
      return {
        allowed: false,
        reason: `Dispatch requires this provider session to hold ${lead.mailbox} with role lead. Use mbx_identity {"action":"claim","name":"${lead.mailbox}"}; if absent, use mbx_identity {"action":"register","name":"${lead.mailbox}","role":"lead"}. Verify with agentmbx status --cli ${lead.providerCli} --session ${lead.providerSessionId} --json --schema mbx.status/v1.`,
      };
    }
    const flag = args.findIndex((arg) => arg === '--lead-mbx' || arg.startsWith('--lead-mbx='));
    const explicit =
      flag === -1
        ? undefined
        : args[flag]?.startsWith('--lead-mbx=')
          ? args[flag]?.slice('--lead-mbx='.length)
          : args[flag + 1];
    if (explicit !== undefined && explicit !== lead.mailbox)
      return {
        allowed: false,
        reason: `Dispatch must report to this lead's held mailbox ${lead.mailbox}; remove --lead-mbx or use that name.`,
      };
    env = { ...env, CLEO_LEAD_MAILBOX: lead.mailbox };
  }
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        cwd: options.cwd,
        env,
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
    'Run one allow-listed cleo or gh command. Pass argv as an array of words (no shell), ' +
    'command words first, then positionals, then listed flags (--flag=value for a value starting with "-"; no --no-* forms): ' +
    'cleo orchestrate <read/plan/dispatch sub-verb>, cleo show/find/list, cleo review packet|check|verdict, ' +
    'cleo done --from-merge <pr> --dry-run, cleo memory find|fetch, cleo session status, cleo decide ask, ' +
    'cleo merge train; gh pr view|list|checks|diff <number>, gh pr comment <number> --body <text>, gh run list, gh run view <id>. Anything else is refused.',
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
