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
 * wrapped in place) changes which permission rules match the command: Claude
 * Code evaluates rules against the input a hook returns, so an allow rule such
 * as `Bash(pnpm test:*)` stops matching, and a "don't ask again" on
 * `cleo run` would become a broad allow. So:
 *
 * - `bypassPermissions` or `auto` (owner decision, 2026-10-01: the user is not
 *   approving each command): always rewrite.
 * - Claude Code `default`, `acceptEdits`, `dontAsk` (and `auto`), T13124:
 *   rewrite with `permissionDecision: "allow"` when the user's Bash allow
 *   rules already approve the ORIGINAL command (core `claudePreApproval`,
 *   never more permissive than Claude Code). The commands that ran without a
 *   prompt still do, and nothing else does; they now queue for the budget.
 *   Claude Code still applies deny and ask rules to the rewritten command
 *   whatever the hook answers. The hook claims nothing when something it
 *   cannot see may change the rules (managed `allowManagedPermissionRulesOnly`,
 *   an unreadable managed source, a macOS configuration profile, Windows, an
 *   Agent SDK or host-managed session, or `--disallowedTools` / `--settings` /
 *   `--setting-sources` on Claude Code's command line).
 * - Otherwise (`plan`, an unknown mode, a command no allow rule approves, or
 *   any Codex mode but `bypassPermissions`): a context line with the governed
 *   command instead.
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
 * @task T13124
 * @epic T12978
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * Claude Code modes in which the hook rewrites a command the user's allow
 * rules already approve, answering `permissionDecision: "allow"` (T13124).
 * Claude Code evaluates permission rules against the input a hook returns, so
 * without `allow` a rewrite would lose the allow rule's match and prompt; with
 * it, exactly the commands that ran unprompted before still do, now queued.
 * Deny and ask rules still apply to the rewritten command whatever the hook
 * answers. Plan mode is left out: it must not run the command at all.
 */
const PRE_APPROVE_MODES: ReadonlySet<string> = new Set([
  'default',
  'acceptEdits',
  'dontAsk',
  'auto',
]);

/** `permissionDecisionReason` for a pre-approved rewrite (Claude Code logs it in debug only). */
const PRE_APPROVED_REASON =
  '[cleo] your allow rules approve this command; the hook only queues it for the machine-wide budget';

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
 * @param preApproved - Claude Code: the user's allow rules already approve the
 *   original command, so the rewrite carries `permissionDecision: "allow"`.
 */
export function renderHeavyHookAnswer(
  provider: HeavyCommandHookProvider,
  toolInput: ShellToolInput,
  plan: HeavyCommandPlan,
  context: string,
  timeoutMs?: number,
  preApproved = false,
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
  // Codex applies updatedInput only with `allow`. Claude Code gets `allow` only
  // when the user's allow rules already approve the original command (T13124).
  const allow = rewrite && (provider === 'codex' || preApproved);
  const output: PreToolUseHookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...(allow ? { permissionDecision: 'allow' as const } : {}),
      ...(allow && provider === 'claude-code'
        ? { permissionDecisionReason: PRE_APPROVED_REASON }
        : {}),
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
  managedDir: string = claudeManagedDir(),
): readonly string[] {
  return [...claudeManagedFiles(env, managedDir), ...claudeSettingsFiles(projectDir, env)];
}

/**
 * Claude Code's file-based managed-settings directory on this platform.
 *
 * @param platform - the platform (injectable for tests).
 */
export function claudeManagedDir(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode'
    : platform === 'win32'
      ? 'C:\\Program Files\\ClaudeCode'
      : '/etc/claude-code';
}

/** Claude Code's user configuration directory (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
}

/**
 * Claude Code's managed-settings documents this hook can read: the
 * `managed-settings.json` file and its `managed-settings.d/*.json` drop-ins
 * (alphabetical, hidden files skipped), and the cached server-managed
 * settings (`remote-settings.json` in the user configuration directory).
 *
 * @param env - the hook's environment.
 * @param managedDir - the managed-settings directory (injectable for tests).
 */
export function claudeManagedFiles(
  env: Readonly<Record<string, string | undefined>>,
  managedDir: string = claudeManagedDir(),
): readonly string[] {
  const dropInDir = join(managedDir, 'managed-settings.d');
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(dropInDir)
      .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .sort()
      .map((n) => join(dropInDir, n));
  } catch (err) {
    // A drop-in directory that exists but cannot be listed is reported as
    // unreadable by whoever reads the returned list.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') dropIns = [dropInDir];
  }
  return [
    join(managedDir, 'managed-settings.json'),
    ...dropIns,
    join(claudeConfigDir(env), 'remote-settings.json'),
  ];
}

/**
 * The user, project and project-local Claude Code settings files.
 *
 * @param projectDir - the session's project directory.
 * @param env - the hook's environment.
 */
export function claudeSettingsFiles(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return [
    join(claudeConfigDir(env), 'settings.json'),
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
    patterns.push(...bashRulePatterns(raw, ['deny', 'ask'], 4));
  }
  return { patterns, unreadable };
}

/**
 * The patterns of the `Bash` / `Bash(…)` rules under `permissions.<key>` in a
 * parsed settings document (a bare `Bash` is `*`). With `depth > 0`, a
 * `permissions` object nested up to that many levels down counts too: a
 * cached server-managed payload may wrap the settings, and for deny and ask
 * rules finding more is the safe side.
 *
 * @param doc - the parsed settings document.
 * @param keys - `allow`, `deny` and/or `ask`.
 * @param depth - how far below the top to look for `permissions` objects.
 */
export function bashRulePatterns(
  doc: HookJsonValue,
  keys: readonly string[],
  depth = 0,
): readonly string[] {
  if (!isRecord(doc)) return [];
  const out: string[] = [];
  const permissions = doc.permissions;
  if (isRecord(permissions)) {
    for (const key of keys) {
      const rules = permissions[key];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules) {
        if (typeof rule !== 'string') continue;
        const trimmed = rule.trim();
        if (trimmed === 'Bash') {
          out.push('*');
          continue;
        }
        const match = /^Bash\((.*)\)$/s.exec(trimmed);
        if (match?.[1] !== undefined) out.push(match[1]);
      }
    }
  }
  if (depth > 0) {
    for (const [key, value] of Object.entries(doc)) {
      if (key !== 'permissions') out.push(...bashRulePatterns(value, keys, depth - 1));
    }
  }
  return out;
}

/** Whether `doc` sets `key` to `true` anywhere down to `depth` levels. */
function setsTrue(doc: HookJsonValue, key: string, depth: number): boolean {
  if (!isRecord(doc)) return false;
  if (doc[key] === true) return true;
  return depth > 0 && Object.values(doc).some((v) => setsTrue(v, key, depth - 1));
}

/**
 * Claude Code command-line flags that add rules or settings sources the hook
 * cannot read: deny rules (`--disallowedTools`), an extra settings file
 * (`--settings`), or a narrowed set of settings sources (`--setting-sources`,
 * which can drop the user or project rules the hook would count).
 */
const CLAUDE_RULE_FLAGS =
  /(?:^|\s)--(?:disallowedTools|disallowed-tools|settings|setting-sources)(?=[=\s]|$)/;

/** Ancestor processes the hook looks at for {@link CLAUDE_RULE_FLAGS}. */
const ANCESTOR_DEPTH = 8;

/**
 * The command lines of this process's ancestors (up to
 * {@link ANCESTOR_DEPTH}, nearest first), concatenated, or `null` when they
 * cannot be read. Only ever searched for {@link CLAUDE_RULE_FLAGS}, so which
 * ancestor a line belongs to does not matter (`ps` prints a command line that
 * holds newlines across several lines). Linux reads `/proc`; elsewhere one
 * `ps` call for the parent chain and one for the command lines.
 */
export function ancestorCommandText(): string | null {
  const chain: number[] = [];
  let pid = process.ppid;
  if (process.platform === 'linux') {
    const lines: string[] = [];
    for (let d = 0; d < ANCESTOR_DEPTH && pid > 1; d++) {
      try {
        lines.push(readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').join(' '));
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      } catch {
        return null;
      }
    }
    return lines.join('\n');
  }
  const ps = (args: readonly string[]): string | null => {
    try {
      return execFileSync('ps', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
  const table = ps(['-A', '-o', 'pid=,ppid=']);
  if (table === null) return null;
  const parent = new Map<number, number>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m?.[1] && m[2]) parent.set(Number(m[1]), Number(m[2]));
  }
  for (let d = 0; d < ANCESTOR_DEPTH && pid > 1; d++) {
    chain.push(pid);
    const next = parent.get(pid);
    if (next === undefined) break;
    pid = next;
  }
  if (chain.length === 0) return null;
  return ps(['-ww', '-o', 'args=', '-p', chain.join(',')]);
}

/** Where the hook looks for the user's Claude Code allow rules, and what could override them. */
export interface ClaudeAllowContext {
  /** Managed-settings documents (read only for `allowManagedPermissionRulesOnly`). */
  readonly managedFiles: readonly string[];
  /** Managed configuration profiles present that the hook cannot read (macOS plists). */
  readonly profiles: readonly string[];
  /** User, project and project-local settings files, whose Bash allow rules count. */
  readonly settingsFiles: readonly string[];
  /** The hook's ancestor command lines (concatenated), or `null` when unknown. */
  readonly ancestors: string | null;
  /** The platform. */
  readonly platform: NodeJS.Platform;
}

/**
 * Gather the {@link ClaudeAllowContext} for a Claude Code session.
 *
 * @param projectDir - Claude Code's project directory (`CLAUDE_PROJECT_DIR`).
 * @param env - the hook's environment.
 */
export function claudeAllowContext(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>>,
): ClaudeAllowContext {
  const user = env.USER || env.LOGNAME;
  const profileDir = '/Library/Managed Preferences';
  const profiles =
    process.platform === 'darwin'
      ? [
          join(profileDir, 'com.anthropic.claudecode.plist'),
          ...(user ? [join(profileDir, user, 'com.anthropic.claudecode.plist')] : []),
        ].filter((f) => existsSync(f))
      : [];
  return {
    managedFiles: claudeManagedFiles(env),
    profiles,
    settingsFiles: claudeSettingsFiles(projectDir, env),
    ancestors: ancestorCommandText(),
    platform: process.platform,
  };
}

/** The user's Claude Code Bash allow rules, or why they cannot be trusted here. */
export type ClaudeAllowRules =
  | { readonly trusted: true; readonly patterns: readonly string[] }
  | { readonly trusted: false; readonly reason: string };

/**
 * The patterns of the Bash allow rules Claude Code applies in this session,
 * from the user, project and project-local settings, or `trusted: false` when
 * something the hook cannot see may change them. The hook only claims a
 * command is pre-approved from rules it is sure Claude Code applies, so it
 * fails safe (no claim) when:
 *
 * - managed settings set `allowManagedPermissionRulesOnly` (Claude Code then
 *   ignores the user's allow rules), or a managed document exists but cannot
 *   be read or parsed, or a managed configuration profile (macOS plist) or the
 *   Windows registry may hold policy;
 * - an embedding host supplies settings (`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`)
 *   or the session runs on the Agent SDK (`CLAUDE_CODE_ENTRYPOINT=sdk-*`,
 *   which chooses its own settings sources);
 * - Claude Code was started with `--disallowedTools`, `--settings` or
 *   `--setting-sources`, or its command line cannot be read.
 *
 * Managed allow rules themselves are never counted, and an unreadable user
 * settings file contributes nothing. Rules from `--allowedTools` and
 * session-only approvals are invisible here, which only means fewer claims.
 *
 * @param ctx - where to look (see {@link claudeAllowContext}).
 * @param env - the hook's environment.
 */
export function claudeAllowedBashRules(
  ctx: ClaudeAllowContext,
  env: Readonly<Record<string, string | undefined>>,
): ClaudeAllowRules {
  const untrusted = (reason: string): ClaudeAllowRules => ({ trusted: false, reason });
  if (ctx.platform === 'win32') {
    return untrusted(
      'managed policy on Windows lives in the registry, which the hook does not read',
    );
  }
  if (env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) {
    return untrusted('a host application supplies managed settings');
  }
  if (env.CLAUDE_CODE_ENTRYPOINT?.startsWith('sdk')) {
    return untrusted('an Agent SDK session chooses its own settings sources');
  }
  if (ctx.profiles.length > 0) {
    return untrusted(
      `a managed configuration profile (${ctx.profiles[0]}) may restrict permission rules`,
    );
  }
  for (const file of ctx.managedFiles) {
    let doc: HookJsonValue;
    try {
      doc = JSON.parse(readFileSync(file, 'utf-8')) as HookJsonValue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return untrusted(`managed settings ${file} cannot be read or parsed`);
    }
    if (setsTrue(doc, 'allowManagedPermissionRulesOnly', 4)) {
      return untrusted('managed settings make managed permission rules the only ones that apply');
    }
  }
  if (ctx.ancestors === null) {
    return untrusted(
      'the Claude Code command line cannot be read for --disallowedTools or --settings',
    );
  }
  if (CLAUDE_RULE_FLAGS.test(ctx.ancestors)) {
    return untrusted(
      'Claude Code was started with --disallowedTools, --settings or --setting-sources, whose rules the hook cannot read',
    );
  }
  const patterns: string[] = [];
  for (const file of ctx.settingsFiles) {
    try {
      patterns.push(
        ...bashRulePatterns(JSON.parse(readFileSync(file, 'utf-8')) as HookJsonValue, ['allow']),
      );
    } catch {
      // Missing or unreadable: no allow rules from it.
    }
  }
  return { trusted: true, patterns };
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
 * words, it covers every Bash command (a bare `Bash`, `Bash(*)`), it matches
 * the governed `cleo run …` form itself (T13124: it would block or prompt for
 * the rewritten command), or a settings file that may hold such a rule cannot
 * be read.
 */
export type GuardHit =
  | { readonly kind: 'word'; readonly word: string }
  | { readonly kind: 'all' }
  | { readonly kind: 'governed' }
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
 * @param matches - Claude Code rule matcher; when given, a deny or ask rule
 *   that matches the governed `cleo run …` form counts as naming `cleo`.
 */
export function guardedHeavyCommand(
  provider: HeavyCommandHookProvider,
  segments: readonly HeavyCommandSegment[],
  projectDir: string,
  env: Readonly<Record<string, string | undefined>>,
  files: readonly string[] = claudeRuleFiles(projectDir, env),
  matches?: (pattern: string, text: string) => boolean,
): GuardHit | null {
  let rules: readonly (readonly string[])[];
  if (provider === 'claude-code') {
    const found = claudeGuardedBashRules(files);
    if (found.unreadable !== null) return { kind: 'unreadable', file: found.unreadable };
    rules = found.patterns.map(ruleWords);
    if (rules.some((words) => words.length === 0)) return { kind: 'all' };
    // The rewrite runs `cleo run …`: a deny rule matching that would block the
    // agent's command, an ask rule would prompt for it (T13124).
    const governed = segments.map((s) =>
      s.governed.slice(Math.max(0, s.governed.indexOf('cleo run '))),
    );
    if (matches && found.patterns.some((p) => governed.some((text) => matches(p, text)))) {
      return { kind: 'governed' };
    }
  } else if (provider === 'codex') {
    const words = codexGuardedWords(projectDir, env);
    rules = words.length === 0 ? [] : [words];
    if (words.includes('cleo')) return { kind: 'governed' };
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

/** Seams of {@link heavyCommandHook} (tests). */
export interface HeavyHookDeps {
  /** Replaces {@link claudeAllowContext}: where Claude Code allow rules are read from. */
  readonly allowContext?: (
    projectDir: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => ClaudeAllowContext;
}

/**
 * Answer one `PreToolUse` call for `provider`. Returns the text to print
 * (empty = print nothing).
 *
 * @param provider - the harness.
 * @param stdin - the harness's JSON payload.
 * @param io - environment and working directory.
 * @param deps - seams for tests.
 */
export async function heavyCommandHook(
  provider: HeavyCommandHookProvider,
  stdin: string,
  io: Pick<HookIo, 'env' | 'cwd'>,
  deps: HeavyHookDeps = {},
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
  const permissionMode = input.permission_mode ?? '';
  // T13124: in Claude Code's prompting modes, a command the user's allow rules
  // already approve is rewritten with `allow`; anything else only warns.
  let preApproved = false;
  if (
    plan.action === 'rewrite' &&
    provider === 'claude-code' &&
    PRE_APPROVE_MODES.has(permissionMode)
  ) {
    const projectDir = io.env.CLAUDE_PROJECT_DIR;
    const verdict = claudePreApprovalVerdict(
      input.tool_input.command,
      cwd,
      io.env,
      core,
      projectDir && deps.allowContext ? deps.allowContext(projectDir, io.env) : undefined,
    );
    preApproved = verdict.approved;
    if (!verdict.approved && !REWRITE_MODES.has(permissionMode)) {
      plan = demote(
        plan,
        `rewriting it would change which permission rules match it, so in ${permissionMode} mode ` +
          `the hook rewrites only a command your Claude Code allow rules already approve, and ` +
          `${verdict.reason} (bypassPermissions or auto mode rewrite every heavy command)`,
      );
    }
  }
  if (provider !== 'kimi' && !preApproved && !REWRITE_MODES.has(permissionMode)) {
    plan = demote(
      plan,
      `rewriting it would change which permission rules match it, so the hook rewrites only in ` +
        `bypassPermissions or auto mode (this session: ${input.permission_mode ?? 'unknown'})`,
    );
  }
  if (plan.action === 'rewrite') {
    const hit = guardedHeavyCommand(
      provider,
      plan.segments,
      projectRoot,
      io.env,
      claudeRuleFiles(projectRoot, io.env),
      core.claudeBashRuleMatches,
    );
    const where = provider === 'codex' ? 'Codex rules' : 'Claude Code settings';
    if (hit?.kind === 'word') {
      plan = demote(
        plan,
        `a deny or ask rule in your ${where} names \`${hit.word}\`, and a rewrite would hide the command from it`,
      );
    } else if (hit?.kind === 'governed') {
      plan = demote(
        plan,
        `a deny or ask rule in your ${where} matches \`cleo run\`, which the rewrite would run`,
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
  return renderHeavyHookAnswer(
    provider,
    input.tool_input,
    plan,
    context,
    budget.timeoutMs,
    preApproved && plan.action === 'rewrite',
  );
}

/** The core functions {@link claudePreApprovalVerdict} needs (the hook loads core lazily). */
interface PreApprovalCore {
  readonly claudePreApproval: (
    command: string,
    allowPatterns: readonly string[],
    opts: { readonly cwd: string; readonly workingDir: string },
  ) => { readonly approved: true } | { readonly approved: false; readonly reason: string };
}

/**
 * Whether Claude Code would run `command` unprompted because the user's allow
 * rules approve it, or why the hook cannot say so. Needs `CLAUDE_PROJECT_DIR`
 * (Claude Code sets it for every hook): it names the project settings Claude
 * Code reads and the working directory a `cd` must stay in.
 *
 * @param command - the original command line.
 * @param cwd - where it starts.
 * @param env - the hook's environment.
 * @param core - the core planner module.
 * @param ctx - where to look for rules (injectable for tests).
 */
export function claudePreApprovalVerdict(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  core: PreApprovalCore,
  ctx?: ClaudeAllowContext,
): { readonly approved: true } | { readonly approved: false; readonly reason: string } {
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (!projectDir) return { approved: false, reason: 'CLAUDE_PROJECT_DIR is not set' };
  const rules = claudeAllowedBashRules(ctx ?? claudeAllowContext(projectDir, env), env);
  if (!rules.trusted) return { approved: false, reason: rules.reason };
  const verdict = core.claudePreApproval(command, rules.patterns, { cwd, workingDir: projectDir });
  return verdict.approved
    ? verdict
    : { approved: false, reason: `it is not pre-approved: ${verdict.reason}` };
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
