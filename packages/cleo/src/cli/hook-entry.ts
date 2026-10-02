/**
 * `cleo hook <name>`: hooks CLEO installs into agent harnesses (T12983).
 *
 * `cleo hook heavy-command --provider <p>` runs before every shell command an
 * agent issues. It reads the harness's `PreToolUse` JSON on stdin, asks the
 * core planner whether the command line holds heavy work (tests, compiles,
 * builds, installs), and answers in the harness's own protocol: rewrite it to
 * `cleo run --wait --class <c> -- …` so it queues for the machine-wide budget,
 * or add a context line when a rewrite would not be safe.
 *
 * stdout is the HARNESS's hook protocol, not a LAFS envelope (the harness
 * parses it). Every failure is fail-open: exit 0 with nothing on stdout, so a
 * broken hook never blocks a command.
 *
 * The rewrite (`cleo run --wait --passthrough --class <c> -- <command>`,
 * wrapped in place) changes which permission rules match the command: an
 * allow rule such as `Bash(pnpm test:*)` stops matching, and a "don't ask
 * again" on `cleo run` would become a broad allow. So the hook rewrites only
 * when the harness reports `permission_mode` `bypassPermissions` or `auto`
 * (owner decision, 2026-10-01: modes where the user is not approving each
 * command); in `default`, `acceptEdits`, `plan`, `dontAsk` (which denies what
 * no allow rule matches) or an unknown mode it adds a context line with the
 * governed command instead.
 *
 * Providers:
 * - `claude-code`: `updatedInput` with no `permissionDecision`. The Bash
 *   `timeout` grows by the queue wait (honouring `BASH_DEFAULT_TIMEOUT_MS` /
 *   `BASH_MAX_TIMEOUT_MS`), never below the timeout the call already had.
 * - `codex`: Codex only applies `updatedInput` together with
 *   `permissionDecision: "allow"`; that only continues the call, and Codex's
 *   own approval and sandbox flow still runs. Codex reports
 *   `bypassPermissions` exactly when its approval policy is `never`.
 * - `kimi`: Kimi cannot rewrite input; the hook denies the call and names the
 *   governed command to re-run (the re-run goes through Kimi's approvals
 *   like any command). Warnings are plain stdout (added to context).
 * - `opencode`: a small `{ command, timeout, context }` answer for CLEO's
 *   plugin. The plugin reports no permission mode, so it gets context only.
 *
 * In those modes the deny and ask rules are the guardrail left, and they
 * match the command text the hook returns. So before a
 * rewrite the hook reads the provider's Bash deny/ask rules (Claude Code's
 * managed, user, project and local settings; Codex's `forbidden`/`prompt`
 * rule files) and warns instead when one names the heavy command's command
 * word. Only the permission arrays are read; nothing from those files is
 * printed except the matched word.
 *
 * `bin/cleo.js` imports this module directly for `cleo hook …`, skipping the
 * CLI bootstrap; keep its static imports to types and Node built-ins.
 *
 * @task T12983
 * @epic T12978
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  HeavyCommandHookProvider,
  HeavyCommandPlan,
  HeavyCommandSegment,
  HookJsonValue,
  OpencodeHeavyCommandAnswer,
  PreToolUseHookInput,
  PreToolUseHookOutput,
  ShellToolInput,
} from '@cleocode/contracts';

/** What {@link runHookCli} reads from and writes to (injectable for tests). */
export interface HookIo {
  /** The whole of stdin. */
  readonly readStdin: () => Promise<string>;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

/** Providers `cleo hook heavy-command` answers for. */
export const HEAVY_HOOK_PROVIDERS: readonly HeavyCommandHookProvider[] = [
  'claude-code',
  'codex',
  'kimi',
  'opencode',
];

/** Claude Code's (and opencode's) shell tool: default and maximum `timeout` (ms). */
const BASH_DEFAULT_MS = 120_000;
const BASH_MAX_MS = 600_000;

/** Queue-wait allowance bounds (seconds) added on top of a shell timeout. */
const MIN_WAIT_SEC = 30;
const MAX_WAIT_SEC = 300;

/** Queue wait for harnesses whose shell timeout the hook does not adjust. */
const DEFAULT_WAIT_SEC = 60;

/**
 * Permission modes in which the hook may rewrite (owner decision, 2026-10-01):
 * the user is not approving each command, so a rewrite changes no approval.
 */
const REWRITE_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'auto']);

const MAX_STDIN_BYTES = 1024 * 1024;

/** Read stdin to the end (empty when it is a terminal). */
async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_STDIN_BYTES) return '';
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** The real process streams. */
export function processHookIo(): HookIo {
  return {
    readStdin: readProcessStdin,
    writeStdout: (text) => process.stdout.write(text), // stdout-discipline-allowed: PreToolUse hook protocol, the harness parses this JSON (not LAFS, not rendered output) // stdout-write-allowed: PreToolUse hook protocol output read raw by the harness
    writeStderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
  };
}

function isRecord(
  value: HookJsonValue | undefined,
): value is { readonly [key: string]: HookJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a `PreToolUse` payload, keeping only a shell tool call with a string
 * command. Anything else is `null` (the hook stays silent).
 *
 * @param text - stdin as the harness wrote it.
 */
export function parseHookInput(text: string): PreToolUseHookInput | null {
  let raw: HookJsonValue;
  try {
    raw = JSON.parse(text) as HookJsonValue;
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const toolInput = raw.tool_input;
  if (!isRecord(toolInput) || typeof toolInput.command !== 'string') return null;
  const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
  if (toolName !== undefined && !/^(bash|shell|exec_command)$/i.test(toolName)) return null;
  const str = (v: HookJsonValue | undefined): string | undefined =>
    typeof v === 'string' ? v : undefined;
  return {
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    tool_input: { ...toolInput, command: toolInput.command },
    ...(str(raw.cwd) === undefined ? {} : { cwd: str(raw.cwd) }),
    ...(str(raw.permission_mode) === undefined
      ? {}
      : { permission_mode: str(raw.permission_mode) }),
  };
}

function positiveMs(value: string | undefined): number | undefined {
  const n = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * How long a governed command may queue, and (shell tools with a ms
 * `timeout`: Claude Code, opencode) the tool timeout that keeps the
 * command's own budget and adds the queue wait on top.
 *
 * The effective timeout is the call's `timeout` (or the harness default),
 * capped at the harness maximum; for Claude Code both come from
 * `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` when set. The wait
 * allowance matches the command's own budget, within 30-300 s and within the
 * room left under the maximum (30 s at least), and the new timeout is never
 * below the effective one. A background command keeps
 * `cleo run`'s own wait default.
 *
 * @param provider - the harness.
 * @param toolInput - the shell tool's input.
 * @param env - the hook's environment.
 */
export function heavyHookWaitBudget(
  provider: HeavyCommandHookProvider,
  toolInput: ShellToolInput,
  env: Readonly<Record<string, string | undefined>> = {},
): { readonly waitTimeoutSec?: number; readonly timeoutMs?: number } {
  if (toolInput.run_in_background === true) return {};
  if (provider !== 'claude-code' && provider !== 'opencode') {
    return { waitTimeoutSec: DEFAULT_WAIT_SEC };
  }
  const fromEnv = provider === 'claude-code';
  const def = (fromEnv ? positiveMs(env.BASH_DEFAULT_TIMEOUT_MS) : undefined) ?? BASH_DEFAULT_MS;
  const max = Math.max(
    (fromEnv ? positiveMs(env.BASH_MAX_TIMEOUT_MS) : undefined) ?? BASH_MAX_MS,
    def,
  );
  const asked =
    typeof toolInput.timeout === 'number' && toolInput.timeout > 0 ? toolInput.timeout : def;
  const effective = Math.min(asked, max);
  // The allowance matches the command's own budget (30-300 s), but never more
  // than the room left under the maximum, so a long command keeps its time.
  const room = Math.floor((max - effective) / 1000);
  const waitTimeoutSec = Math.max(
    MIN_WAIT_SEC,
    Math.min(MAX_WAIT_SEC, Math.round(effective / 1000), room),
  );
  return { waitTimeoutSec, timeoutMs: Math.min(max, effective + waitTimeoutSec * 1000) };
}

/**
 * The context line(s) for a plan, plus the pressure line when there is one.
 *
 * @param plan - the (possibly demoted) plan.
 * @param pressure - the pressure line, or `null`.
 * @param provider - the harness (Kimi's rewrite is a denial, worded as one).
 */
export function heavyHookContext(
  plan: HeavyCommandPlan,
  pressure: string | null,
  provider: HeavyCommandHookProvider = 'claude-code',
): string {
  const lines: string[] = [];
  const governed = plan.action === 'none' ? '' : plan.segments.map((s) => s.governed).join(' ; ');
  if (plan.action === 'rewrite' && provider === 'kimi') {
    lines.push(
      `[cleo] Not run: heavy commands share the machine-wide resource budget. Re-run it as: ${plan.command}`,
    );
  } else if (plan.action === 'rewrite') {
    lines.push(
      `[cleo] Routed heavy work through the machine-wide budget: ${governed}. ` +
        'cleo run passes the command its stdin, stdout, stderr and exit code; exit 75 means it ' +
        'was not admitted before the wait ran out (E_RESOURCE_DEFERRED on stderr lists holders ' +
        'and ways forward).',
    );
  } else if (plan.action === 'warn') {
    lines.push(
      `[cleo] Heavy command not rewritten because ${plan.reason}. Run it governed so it shares the ` +
        `machine-wide budget: ${governed}`,
    );
  }
  if (pressure !== null) lines.push(pressure);
  return lines.join('\n');
}

/** Turn a rewrite into a warning (mode `warn`, `cleo` missing, permission mode). */
function demote(plan: HeavyCommandPlan, reason: string): HeavyCommandPlan {
  return plan.action === 'rewrite' ? { action: 'warn', reason, segments: plan.segments } : plan;
}

/**
 * Render the provider's answer. Empty string = say nothing.
 *
 * @param provider - the harness.
 * @param toolInput - the original shell tool input.
 * @param plan - the (possibly demoted) plan.
 * @param context - the context text from {@link heavyHookContext}.
 * @param timeoutMs - the adjusted shell timeout (Claude Code, opencode), if any.
 */
export function renderHeavyHookAnswer(
  provider: HeavyCommandHookProvider,
  toolInput: ShellToolInput,
  plan: HeavyCommandPlan,
  context: string,
  timeoutMs?: number,
): string {
  if (plan.action === 'none' && context === '') return '';
  const rewrite = plan.action === 'rewrite';
  if (provider === 'opencode') {
    const answer: OpencodeHeavyCommandAnswer = {
      ...(rewrite ? { command: plan.command } : {}),
      ...(rewrite && timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      ...(context === '' ? {} : { context }),
    };
    return `${JSON.stringify(answer)}\n`;
  }
  if (provider === 'kimi') {
    if (!rewrite) return `${context}\n`;
    const deny: PreToolUseHookOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: context,
      },
    };
    return `${JSON.stringify(deny)}\n`;
  }
  const updatedInput: ShellToolInput | undefined = rewrite
    ? {
        ...toolInput,
        command: plan.command,
        ...(provider === 'claude-code' && timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      }
    : undefined;
  const output: PreToolUseHookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...(rewrite && provider === 'codex' ? { permissionDecision: 'allow' as const } : {}),
      ...(updatedInput === undefined ? {} : { updatedInput }),
      ...(context === '' ? {} : { additionalContext: context }),
    },
  };
  return `${JSON.stringify(output)}\n`;
}

function wordBase(word: string): string {
  return word.split('/').pop() ?? word;
}

/**
 * The words of a heavy command a permission rule could start with: its first
 * four words that are not assignments, flags or bare numbers (flag values
 * such as `nice -n 10`), as basenames. Prefix commands (`env`, `nice`, …)
 * stay in: a rule can name them too.
 *
 * @param argv - the heavy command's words.
 */
export function heavyRuleWords(argv: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const w of argv) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w.startsWith('-') || /^\d+$/.test(w)) continue;
    out.push(wordBase(w));
    if (out.length === 4) break;
  }
  return out;
}

/** The words of one rule pattern (`pnpm add *` → `pnpm`, `add`). */
function ruleWords(pattern: string): string[] {
  return pattern
    .split(/[\s:*()]+/)
    .filter((w) => w !== '' && !w.startsWith('-'))
    .map(wordBase);
}

/**
 * The settings files whose Bash permission rules apply to a Claude Code
 * session in `projectDir`: managed, user (`CLAUDE_CONFIG_DIR` or
 * `~/.claude`), project and project-local.
 *
 * @param projectDir - the session's project directory.
 * @param env - the hook's environment.
 */
export function claudeRuleFiles(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const managed =
    process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : process.platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
        : '/etc/claude-code/managed-settings.json';
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  return [
    managed,
    join(configDir, 'settings.json'),
    join(projectDir, '.claude', 'settings.json'),
    join(projectDir, '.claude', 'settings.local.json'),
  ];
}

/** The Bash deny/ask rules found in Claude Code settings files. */
export interface ClaudeGuardedRules {
  /** Patterns of `Bash(…)` rules; a bare `Bash` rule is recorded as `*`. */
  readonly patterns: readonly string[];
  /** A settings file that exists but cannot be read or parsed, if any. */
  readonly unreadable: string | null;
}

/**
 * The patterns of every `Bash` / `Bash(…)` rule in `permissions.deny` and
 * `permissions.ask` of the given Claude Code settings files. Nothing else in
 * those files is read. A missing file is skipped; one that exists but cannot
 * be read or parsed is reported, so the hook can fail safe.
 *
 * @param files - settings files to read.
 */
export function claudeGuardedBashRules(files: readonly string[]): ClaudeGuardedRules {
  const patterns: string[] = [];
  let unreadable: string | null = null;
  for (const file of files) {
    let raw: HookJsonValue;
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8')) as HookJsonValue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable ??= file;
      continue;
    }
    const permissions = isRecord(raw) ? raw.permissions : undefined;
    if (!isRecord(permissions)) continue;
    for (const key of ['deny', 'ask']) {
      const rules = permissions[key];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules) {
        if (typeof rule !== 'string') continue;
        const trimmed = rule.trim();
        if (trimmed === 'Bash') {
          patterns.push('*');
          continue;
        }
        const match = /^Bash\((.*)\)$/s.exec(trimmed);
        if (match?.[1] !== undefined) patterns.push(match[1]);
      }
    }
  }
  return { patterns, unreadable };
}

/**
 * Codex: the quoted words of every rule file (`$CODEX_HOME/rules`,
 * `<project>/.codex/rules`) that declares a `forbidden` or `prompt`
 * decision. Deliberately coarse: any word such a file quotes counts.
 *
 * @param projectDir - the session's project directory.
 * @param env - the hook's environment.
 */
export function codexGuardedWords(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  const out: string[] = [];
  for (const dir of [join(home, 'rules'), join(projectDir, '.codex', 'rules')]) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.rules'));
    } catch {
      continue;
    }
    for (const name of names) {
      let text: string;
      try {
        text = readFileSync(join(dir, name), 'utf-8');
      } catch {
        continue;
      }
      if (!/decision\s*=\s*["'](forbidden|prompt)["']/.test(text)) continue;
      for (const m of text.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)) {
        for (const w of ruleWords(m[1] ?? m[2] ?? '')) out.push(w);
      }
    }
  }
  return out;
}

/**
 * Why a deny or ask rule stops a rewrite: it names one of the command's
 * words, it covers every Bash command (a bare `Bash`, `Bash(*)`), or a
 * settings file that may hold such a rule cannot be read.
 */
export type GuardHit =
  | { readonly kind: 'word'; readonly word: string }
  | { readonly kind: 'all' }
  | { readonly kind: 'unreadable'; readonly file: string };

/**
 * Whether one of the provider's deny or ask rules could match a heavy command,
 * or `null` when none can (or the provider has no such rules). Conservative,
 * so a false alarm only costs a rewrite:
 *
 * - a Claude Code rule counts when its first word is among the command's
 *   leading words (`playwright install` for `npx playwright install`) or it
 *   mentions the command word anywhere; a rule with no word at all (bare
 *   `Bash`, `Bash(*)`) covers everything;
 * - a Claude Code settings file that exists but cannot be parsed fails safe;
 * - a Codex rule file counts when it quotes one of the command's first three
 *   words.
 *
 * @param provider - the harness.
 * @param segments - the plan's heavy commands.
 * @param projectDir - the session's project directory.
 * @param env - the hook's environment.
 * @param files - Claude Code settings files (injectable for tests).
 */
export function guardedHeavyCommand(
  provider: HeavyCommandHookProvider,
  segments: readonly HeavyCommandSegment[],
  projectDir: string,
  env: Readonly<Record<string, string | undefined>>,
  files: readonly string[] = claudeRuleFiles(projectDir, env),
): GuardHit | null {
  let rules: readonly (readonly string[])[];
  if (provider === 'claude-code') {
    const found = claudeGuardedBashRules(files);
    if (found.unreadable !== null) return { kind: 'unreadable', file: found.unreadable };
    rules = found.patterns.map(ruleWords);
    if (rules.some((words) => words.length === 0)) return { kind: 'all' };
  } else if (provider === 'codex') {
    const words = codexGuardedWords(projectDir, env);
    rules = words.length === 0 ? [] : [words];
  } else {
    return null;
  }
  for (const segment of segments) {
    const words = heavyRuleWords(segment.argv);
    const first = words[0];
    if (first === undefined) continue;
    for (const rule of rules) {
      if (provider === 'codex') {
        const hit = words.slice(0, 3).find((w) => rule.includes(w));
        if (hit !== undefined) return { kind: 'word', word: hit };
        continue;
      }
      // Claude Code rules are prefixes: the rule's first word anywhere in the
      // command's leading words, or the command word anywhere in the rule.
      const lead = rule[0];
      if (lead !== undefined && words.includes(lead)) return { kind: 'word', word: lead };
      if (rule.includes(first)) return { kind: 'word', word: first };
    }
  }
  return null;
}

/**
 * The project directory a provider names in the hook's environment, when it
 * names one: Claude Code's `CLAUDE_PROJECT_DIR`. Other harnesses pass only the
 * session `cwd`.
 */
function providerProjectDir(
  provider: HeavyCommandHookProvider,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return provider === 'claude-code' ? env.CLAUDE_PROJECT_DIR || undefined : undefined;
}

/**
 * Answer one `PreToolUse` call for `provider`. Returns the text to print
 * (empty = print nothing).
 *
 * @param provider - the harness.
 * @param stdin - the harness's JSON payload.
 * @param io - environment and working directory.
 */
export async function heavyCommandHook(
  provider: HeavyCommandHookProvider,
  stdin: string,
  io: Pick<HookIo, 'env' | 'cwd'>,
): Promise<string> {
  const envMode = io.env.CLEO_HEAVY_COMMAND_HOOK?.trim().toLowerCase();
  if (envMode === 'off') return '';
  const input = parseHookInput(stdin);
  if (input?.tool_input === undefined) return '';
  const core = await import('@cleocode/core/resources/heavy-command.js');
  const cwd = input.cwd ?? io.cwd;
  const budget = heavyHookWaitBudget(provider, input.tool_input, io.env);
  let plan = core.planHeavyCommand(input.tool_input.command, {
    cwd,
    ...(budget.waitTimeoutSec === undefined ? {} : { waitTimeoutSec: budget.waitTimeoutSec }),
  });
  if (plan.action === 'none') return '';

  const projectRoot = providerProjectDir(provider, io.env) ?? core.heavyHookProjectRoot(cwd);
  const mode = core.resolveHeavyHookMode(
    envMode,
    core.isHeavyCommandHookMode(envMode)
      ? undefined
      : await core.configuredHeavyHookMode(projectRoot),
  );
  if (mode === 'off') return '';
  if (mode === 'warn') {
    plan = demote(
      plan,
      'the hook is in warn mode (CLEO_HEAVY_COMMAND_HOOK or resources.heavyCommandHook)',
    );
  }
  if (!core.executableOnPath('cleo', io.env.PATH)) plan = demote(plan, '`cleo` is not on PATH');
  if (provider !== 'kimi' && !REWRITE_MODES.has(input.permission_mode ?? '')) {
    plan = demote(
      plan,
      `rewriting it would change which permission rules match it, so the hook rewrites only in ` +
        `bypassPermissions or auto mode (this session: ${input.permission_mode ?? 'unknown'})`,
    );
  }
  if (plan.action === 'rewrite') {
    const hit = guardedHeavyCommand(provider, plan.segments, projectRoot, io.env);
    const where = provider === 'codex' ? 'Codex rules' : 'Claude Code settings';
    if (hit?.kind === 'word') {
      plan = demote(
        plan,
        `a deny or ask rule in your ${where} names \`${hit.word}\`, and a rewrite would hide the command from it`,
      );
    } else if (hit?.kind === 'all') {
      plan = demote(
        plan,
        `a deny or ask rule in your ${where} covers every Bash command, and a rewrite would hide the command from it`,
      );
    } else if (hit?.kind === 'unreadable') {
      plan = demote(
        plan,
        `${hit.file} could not be read or parsed, so the hook cannot tell whether a deny or ask rule names the command`,
      );
    }
  }
  const context = heavyHookContext(plan, await core.heavyPressureNotice(), provider);
  return renderHeavyHookAnswer(provider, input.tool_input, plan, context, budget.timeoutMs);
}

const USAGE =
  'usage: cleo hook heavy-command [--provider claude-code|codex|kimi|opencode] < hook-input.json\n';

/**
 * Entry point for `cleo hook …` (from `bin/cleo.js` or the `hook` command).
 *
 * @param argv - the arguments after `hook`, e.g. `['heavy-command', '--provider', 'codex']`.
 * @param io - process streams (injectable for tests).
 * @returns the exit code: 0 always for a known hook (fail-open), 1 on a usage error.
 */
export async function runHookCli(
  argv: readonly string[],
  io: HookIo = processHookIo(),
): Promise<number> {
  const [name, ...rest] = argv;
  if (name !== 'heavy-command') {
    io.writeStderr(USAGE);
    return 1;
  }
  const flag = rest.findIndex((a) => a === '--provider' || a.startsWith('--provider='));
  const value = flag === -1 ? 'claude-code' : (rest[flag]?.split('=')[1] ?? rest[flag + 1]);
  const provider = HEAVY_HOOK_PROVIDERS.find((p) => p === value);
  if (provider === undefined) {
    io.writeStderr(USAGE);
    return 1;
  }
  try {
    const answer = await heavyCommandHook(provider, await io.readStdin(), io);
    if (answer !== '') io.writeStdout(answer);
  } catch (err) {
    // Fail open: the command runs unchanged.
    io.writeStderr(
      `[cleo hook] heavy-command skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return 0;
}
