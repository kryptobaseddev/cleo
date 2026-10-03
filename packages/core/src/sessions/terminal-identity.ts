/**
 * Terminal / harness identity keys for session binding (T12499 · Epic T12497).
 *
 * A CLEO session id names a row; it says nothing about WHICH terminal or agent
 * harness is calling. Before T12499 an unbound terminal fell through to the
 * newest active session row, so one agent's `cleo` call resolved another
 * agent's session. This module answers the missing question — "which terminal
 * am I?" — as an ordered list of opaque binding keys that `session start`
 * persists (terminal key → session id) and that resolution reads back before
 * any newest-active fallback.
 *
 * ## The key map is DATA
 *
 * {@link TERMINAL_KEY_SOURCES} is the single table of environment variables a
 * provider harness or terminal emulator exports with a per-session / per-pane
 * value. Adding a harness is one row, never a new `process.env[...]` check at a
 * call site. Order is precedence: the most specific identity first — an agent
 * harness session beats the multiplexer pane it runs in, which beats the
 * terminal tab that hosts the multiplexer.
 *
 * These values are NOT CLEO session ids (contrast `SESSION_ENV_KEY_PRECEDENCE`
 * in `session-id.ts`, whose values ARE CLEO ids). They are opaque identities
 * that only mean something through a persisted binding.
 *
 * ## Harness-ancestor fallback (T12864)
 *
 * When no environment key is present, the identity falls back to the nearest
 * ancestor that identifies ONE caller ({@link resolveAncestor}): a long-lived
 * interactive or script shell (the terminal tab's shell, a CI step or cron
 * script), or — past throwaway `sh -c` / `bash -c` layers — a KNOWN agent
 * harness process ({@link KNOWN_HARNESSES}: Kimi, aider, …). Such harnesses run every tool call in a fresh `bash -c`, so the
 * immediate parent changes on each call; the harness process does not. Any
 * other process (a node / python host that may run several agents, a daemon
 * spawning `cleo` directly) identifies nobody unless `CLEO_AGENT_ID` names the
 * agent. Pid 1 / launchd / systemd / init, an unreadable shell command line or
 * depth exhaustion also yield no key: the caller keeps the single-session guard.
 *
 * Env tab keys are inherited by every descendant, so when a harness (or a
 * `CLEO_AGENT_ID` agent) runs below one, its anchor is appended as a more
 * specific key — two harnesses in one ssh login or CI step stay apart.
 *
 * Before T12864 the fallback stopped at the first non-launcher ancestor, which
 * for a harness is the per-call `bash -c` — a new key on every call, so a
 * session started in one call was invisible to the next (T12530 therefore
 * stopped treating it as identity).
 *
 * @module
 * @task T12499
 * @epic T12497
 */

import { execFileSync } from 'node:child_process';
import { PS_STABLE_ENV } from '@cleocode/contracts/process-probe.js';

/**
 * Where a terminal key comes from. `process` is a long-lived ancestor shell
 * (tab tier) and `harness` one agent below it or anywhere (pane tier) — both
 * T12864; `ppid` is the pre-T12864 per-call fallback, never produced any more
 * and kept only so rows written before it still type-check.
 */
export type TerminalKeyKind =
  | 'provider'
  | 'multiplexer'
  | 'terminal'
  | 'process'
  | 'harness'
  | 'ppid';

/**
 * One row of the provider/terminal key map: an environment variable whose value
 * identifies a single harness session, multiplexer pane or terminal tab.
 */
export interface TerminalKeySource {
  /** Environment variable carrying the identity value. */
  readonly envVar: string;
  /** Category of identity (drives precedence documentation only). */
  readonly kind: Exclude<TerminalKeyKind, 'ppid' | 'process' | 'harness'>;
  /** Harness / terminal that exports the variable. */
  readonly origin: string;
  /**
   * Optional companion variable that disambiguates the value. `TMUX_PANE` is
   * `%0` on every tmux server, so it is qualified by `TMUX` (socket path, server
   * pid, session index) to stay unique across servers.
   */
  readonly qualifierEnvVar?: string;
  /**
   * Further qualifiers, applied after {@link qualifierEnvVar} (T12864). A
   * GitHub Actions run id alone is shared by every job of the run, so it is
   * qualified by the attempt and the job id.
   */
  readonly extraQualifierEnvVars?: readonly string[];
}

/**
 * The provider/terminal key map, in precedence order (T12499).
 *
 * Provider rows cover agent harnesses that export a per-session id to the shell
 * commands they run. Only variables whose export is documented upstream are
 * listed: `CLAUDE_CODE_SESSION_ID` (Claude Code), `CODEX_THREAD_ID` (Codex CLI,
 * `codex-rs/core/src/exec_env.rs`) and `GEMINI_SESSION_ID` (Gemini CLI; its docs
 * name it for the hook environment). The CAAMP provider definitions carry no
 * session-id variable for any provider, and none is known for Kimi, so none is
 * invented here; add a row once one is confirmed.
 */
export const TERMINAL_KEY_SOURCES: readonly TerminalKeySource[] = [
  { envVar: 'CLAUDE_CODE_SESSION_ID', kind: 'provider', origin: 'claude-code' },
  { envVar: 'CODEX_THREAD_ID', kind: 'provider', origin: 'codex' },
  { envVar: 'GEMINI_SESSION_ID', kind: 'provider', origin: 'gemini-cli' },
  { envVar: 'TMUX_PANE', kind: 'multiplexer', origin: 'tmux', qualifierEnvVar: 'TMUX' },
  {
    envVar: 'ZELLIJ_PANE_ID',
    kind: 'multiplexer',
    origin: 'zellij',
    qualifierEnvVar: 'ZELLIJ_SESSION_NAME',
  },
  {
    envVar: 'WEZTERM_PANE',
    kind: 'multiplexer',
    origin: 'wezterm',
    qualifierEnvVar: 'WEZTERM_UNIX_SOCKET',
  },
  { envVar: 'WT_SESSION', kind: 'terminal', origin: 'windows-terminal' },
  { envVar: 'ITERM_SESSION_ID', kind: 'terminal', origin: 'iterm2' },
  { envVar: 'TERM_SESSION_ID', kind: 'terminal', origin: 'macos-terminal' },
  { envVar: 'KITTY_WINDOW_ID', kind: 'terminal', origin: 'kitty', qualifierEnvVar: 'KITTY_PID' },
  { envVar: 'GNOME_TERMINAL_SCREEN', kind: 'terminal', origin: 'gnome-terminal' },
  {
    envVar: 'KONSOLE_DBUS_SESSION',
    kind: 'terminal',
    origin: 'konsole',
    qualifierEnvVar: 'KONSOLE_DBUS_SERVICE',
  },
  // T12864 — non-terminal callers whose platform exports a per-job / per-login id.
  // GitHub Actions: GITHUB_RUN_ID is per run and shared by its jobs, so it is
  // qualified by GITHUB_RUN_ATTEMPT and GITHUB_JOB ("Variables reference",
  // docs.github.com/en/actions/reference/workflows-and-actions/variables).
  // Every step of one job shares the key; the steps run sequentially.
  {
    envVar: 'GITHUB_RUN_ID',
    kind: 'terminal',
    origin: 'github-actions',
    qualifierEnvVar: 'GITHUB_RUN_ATTEMPT',
    extraQualifierEnvVars: ['GITHUB_JOB'],
  },
  // GitLab CI: CI_JOB_ID is unique per job across the instance ("Predefined
  // CI/CD variables reference", docs.gitlab.com/ci/variables/predefined_variables).
  { envVar: 'CI_JOB_ID', kind: 'terminal', origin: 'gitlab-ci' },
  // OpenSSH login with a tty: SSH_TTY names the login's tty and is set only
  // when one was allocated; SSH_CONNECTION ("client-ip client-port server-ip
  // server-port", ssh(1) ENVIRONMENT) disambiguates it across connections. A
  // one-shot `ssh host 'cmd'` has no tty and falls through to the ancestor walk.
  {
    envVar: 'SSH_TTY',
    kind: 'terminal',
    origin: 'openssh',
    qualifierEnvVar: 'SSH_CONNECTION',
  },
];

/**
 * Launcher processes skipped by the ppid-chain walk: they sit between the shell
 * and the `cleo` process (`pnpm exec`, a mise shim, `npx`) and carry no terminal
 * identity of their own.
 */
export const PPID_CHAIN_LAUNCHERS: ReadonlySet<string> = new Set([
  'node',
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'bun',
  'bunx',
  'tsx',
  'corepack',
  'mise',
  'env',
  'cleo',
]);

/**
 * Environment overrides for the `ps` probe (T12500): UTC and the C locale make
 * the `lstart` start time — part of every ppid-chain key — independent of the
 * caller's `TZ` / `LANG`. Defined in `@cleocode/contracts` so the worktree
 * lock (T12506) renders start times identically.
 */
export { PS_STABLE_ENV };

/** Maximum number of ancestors the harness-ancestor walk inspects (T12864). */
export const PPID_CHAIN_MAX_DEPTH = 12 as const;

/**
 * Agent harnesses recognised by the ancestor walk (T12864), by PROGRAM name:
 * the executable, or the script / `-m` module a `node` / `python` runtime runs
 * (see {@link programName}). A listed process becomes a caller identity, even
 * though it runs every tool call in a fresh `bash -c`.
 *
 * List ONLY processes that host exactly ONE agent session for their whole
 * life. A process that hosts several (an IDE extension host, CrewAI,
 * LangGraph, OpenHands, a server that clients attach to) must NOT be listed:
 * its agents would share one session. Such hosts set `CLEO_AGENT_ID` per agent.
 * Avoid names that other common tools also use.
 *
 * To add a harness: append the program name its process shows (check with
 * `ps -o args= -p <pid>` while it runs a tool call), after confirming it is
 * single-agent.
 *
 * Deliberately NOT listed:
 * - `opencode`: `opencode serve` / `opencode web` run one server process that
 *   hosts many sessions and clients (`opencode attach`, `opencode run
 *   --attach`, `GET /session/status` for all sessions; opencode.ai/docs/server),
 *   and tools run in that server process.
 * - `goose`: collides with pressly/goose, the database migration tool.
 */
export const KNOWN_HARNESSES: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'aider',
  'gemini',
  'kimi',
  'cursor-agent',
  'amp',
]);

/**
 * Language runtimes whose program name is the script or module they run
 * (T12864): `node /usr/local/bin/gemini` is `gemini`, `python -m aider` is
 * `aider`. A runtime running an unknown program is a generic host.
 */
const RUNTIME_PATTERN = /^(node|nodejs|bun|deno|python[0-9.]*|pypy[0-9.]*|ruby|java|php|perl)$/;

/**
 * Thin wrappers between a caller and `cleo` (T12864). They live exactly as long
 * as the command they wrap, so the walk skips them. Matched on program name, so
 * `npm exec …` (npx's process title) and `node …/npm-cli.js` both match.
 */
export const ANCESTOR_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'timeout',
  'gtimeout',
  'nohup',
  'nice',
  'time',
  'xargs',
  'stdbuf',
  'sudo',
  'doas',
  'npm',
  'npm-cli',
  'npx',
  'npx-cli',
  'pnpm',
  'pnpx',
  'yarn',
  'bunx',
  'corepack',
  'mise',
  'cleo',
]);

/**
 * The system's init / service manager (T12864). An ancestor walk that reaches
 * one of these (or pid 1) found no caller-owned process.
 */
export const INIT_PROCESSES: ReadonlySet<string> = new Set(['launchd', 'systemd', 'init']);

/** One resolved identity key for the calling terminal. */
export interface TerminalKey {
  /** Opaque, stable binding key (`env:<VAR>=<value>`, `proc:<pid>@<start>` or `harness:…`). */
  readonly key: string;
  /** Environment variable name, or `'process'` for the harness-ancestor fallback. */
  readonly source: string;
  /** Identity category. */
  readonly kind: TerminalKeyKind;
}

/** One ancestor process as read from the OS process table. */
export interface ProcessAncestor {
  /** Process id. */
  readonly pid: number;
  /** Parent process id. */
  readonly ppid: number;
  /** Process start time as reported by the OS (disambiguates recycled pids). */
  readonly startedAt: string;
  /** Executable base name (e.g. `zsh`, `node`). */
  readonly command: string;
}

/** Reads one process-table entry; returns `null` when the pid is unknown. */
export type ProcessLookup = (pid: number) => ProcessAncestor | null;

/** Reads a process's full command line; returns `null` when it cannot be read (T12864). */
export type ProcessArgsLookup = (pid: number) => string | null;

/** Inputs for {@link resolveTerminalKeys}; every field defaults to the live process. */
export interface ResolveTerminalKeysOptions {
  /** Environment to read (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Parent pid to start the ppid-chain walk from (defaults to `process.ppid`). */
  readonly ppid?: number;
  /** Process-table reader (defaults to {@link readProcessEntry}). */
  readonly lookupProcess?: ProcessLookup;
  /** Command-line reader for shells (defaults to {@link readProcessArgs}). */
  readonly lookupArgs?: ProcessArgsLookup;
}

/** Non-empty trimmed value of `name` in `env`, or `null`. */
function envValue(env: NodeJS.ProcessEnv, name: string | undefined): string | null {
  if (!name) return null;
  const raw = env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Read one entry from the OS process table via `ps` (POSIX only).
 *
 * Returns `null` on Windows, for an unknown pid, or when `ps` fails — the
 * ppid-chain fallback is best-effort and must never fail a command.
 *
 * @param pid - Process id to inspect.
 * @returns The process entry, or `null`.
 */
export function readProcessEntry(pid: number): ProcessAncestor | null {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return null;
  try {
    const out = execFileSync(
      'ps',
      ['-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-p', String(pid)],
      {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
        // T12500: `lstart` is rendered in the caller's time zone and locale, so
        // two shells with different TZ/LANG would derive different keys for
        // the same process and silently lose their binding. Pin both.
        env: { ...process.env, ...PS_STABLE_ENV },
      },
    ).trim();
    // `lstart` is five whitespace-separated fields: `Sat Sep 27 22:07:02 2026`.
    const match = /^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(out);
    if (!match) return null;
    const command = (match[3] ?? '').trim();
    return {
      pid,
      ppid: Number(match[1]),
      startedAt: (match[2] ?? '').replace(/\s+/g, ' '),
      command: command.slice(command.lastIndexOf('/') + 1).replace(/^-/, ''),
    };
  } catch {
    return null;
  }
}

/**
 * Read a process's command line via `ps -o args=` (POSIX only, T12864).
 *
 * Tells a throwaway `sh -c '…'` from a long-lived shell, and names the program
 * a runtime runs. Returns `null` on Windows, for an unknown pid, or when `ps`
 * fails.
 *
 * @param pid - Process id to inspect.
 * @returns The command line, or `null`.
 */
export function readProcessArgs(pid: number): string | null {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return null;
  try {
    const out = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...PS_STABLE_ENV },
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** Base name of a path-like token, without a leading login-shell `-`. */
function baseName(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1).replace(/^-/, '');
}

/**
 * The program a process runs, from its command line (T12864): the executable's
 * base name, or — for a language runtime ({@link RUNTIME_PATTERN}) — the
 * `-m` module or script it runs (extension stripped). Matches on the FIRST
 * word, so a process title such as `npm exec cleo` is `npm`.
 *
 * @param commandLine - `ps -o args=` output (or the bare command name).
 * @returns The program name.
 * @example
 * ```ts
 * programName('/usr/bin/python3.12 -m aider --yes'); // 'aider'
 * programName('npm exec cleo start T1');             // 'npm'
 * ```
 */
export function programName(commandLine: string): string {
  const tokens = commandLine.trim().split(/\s+/);
  const head = baseName(tokens[0] ?? '');
  if (!RUNTIME_PATTERN.test(head)) return head;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (token === '-m') return (tokens[i + 1] ?? head).split('.')[0] ?? head;
    if (token.startsWith('-')) continue;
    return baseName(token).replace(/\.(c|m)?(js|ts)$|\.py$/, '');
  }
  return head;
}

/** Shell options whose NEXT token is their argument, not an operand. */
const SHELL_OPTIONS_WITH_ARGUMENT: ReadonlySet<string> = new Set([
  '-o',
  '+o',
  '-O',
  '+O',
  '--rcfile',
  '--init-file',
]);

/** PowerShell switches (case-insensitive) that run a command string. */
const PWSH_COMMAND_SWITCHES: ReadonlySet<string> = new Set([
  '-c',
  '-command',
  '-commandwithargs',
  '-cwa',
  '-e',
  '-ec',
  '-encodedcommand',
]);

/**
 * Whether a shell's command line runs a single command string (`sh -c '…'`,
 * `bash -lc '…'`, `pwsh -Command …`) — a throwaway shell that exits with the
 * command — rather than an interactive or script shell that outlives it (T12864).
 *
 * POSIX-style shells: options are read up to the first operand. `-c`,
 * `--command` / `--commands` (fish, nu), or a short-option cluster containing
 * `c` means command mode; the arguments of `-o` / `+o` / `-O` / `+O` /
 * `--rcfile` / `--init-file` are skipped rather than read as the operand.
 * PowerShell: any `-Command` / `-c` / `-EncodedCommand` / `-CommandWithArgs`.
 *
 * @param args - The shell's full command line.
 * @returns `true` for a command-string shell.
 */
export function isCommandStringShell(args: string): boolean {
  const tokens = args.trim().split(/\s+/);
  const shell = programName(args);
  // A shell run by a runtime (`python3 /usr/bin/xonsh -c …`): its own options
  // start after the script path.
  let first = 1;
  if (RUNTIME_PATTERN.test(baseName(tokens[0] ?? ''))) {
    while (first < tokens.length && (tokens[first] ?? '').startsWith('-')) first++;
    first++;
  }
  const rest = tokens.slice(first);
  if (shell === 'pwsh' || shell === 'powershell') {
    return rest.some((t) => PWSH_COMMAND_SWITCHES.has(t.toLowerCase()));
  }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (token === '--') return false;
    if (token === '--command' || token === '--commands') return true;
    if (SHELL_OPTIONS_WITH_ARGUMENT.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('--')) continue;
    if (!/^[-+][A-Za-z]+$/.test(token)) return false;
    if (token.startsWith('-') && token.slice(1).includes('c')) return true;
  }
  return false;
}

/** What the ancestor walk anchored on (T12864). */
export interface AncestorAnchor {
  /** The anchoring process. */
  readonly entry: ProcessAncestor;
  /** Its program name ({@link programName}). */
  readonly program: string;
  /**
   * `shell` — a long-lived interactive / login / script shell (the terminal's
   * own identity); `harness` — a {@link KNOWN_HARNESSES} process; `host` — any
   * other process, anchored ONLY because `CLEO_AGENT_ID` names the agent. Set
   * `CLEO_AGENT_ID` only in a LONG-LIVED host: with it, the first non-harness
   * ancestor anchors, even a short-lived `make`, and the key then changes on
   * every call.
   */
  readonly type: 'shell' | 'harness' | 'host';
}

/**
 * Walk to the nearest ancestor that identifies ONE caller across its `cleo`
 * calls (T12864).
 *
 * From `cleo`'s parent upwards, by program name ({@link programName}):
 *
 * - wrappers ({@link ANCESTOR_WRAPPERS}) are skipped;
 * - a shell that is not a command-string shell ({@link isCommandStringShell})
 *   is long-lived — one per terminal tab, CI step or script: `shell`;
 * - a command-string shell (`bash -c`) is skipped;
 * - a {@link KNOWN_HARNESSES} process is `harness`;
 * - any other process ends the walk: it may host SEVERAL agents (a node or
 *   python orchestrator, an IDE extension host, a daemon spawning `cleo`
 *   directly), so it identifies nobody — unless `agentId` (`CLEO_AGENT_ID`)
 *   names the agent, which makes it a `host` anchor.
 *
 * Returns `null` — no identity, the single-session guard applies — at pid 1 or
 * an init process, when a shell's command line cannot be read, when the
 * process table cannot be read, or past {@link PPID_CHAIN_MAX_DEPTH}.
 *
 * @param ppid - Parent pid to start from.
 * @param lookupProcess - Process-table reader.
 * @param lookupArgs - Command-line reader.
 * @param agentId - `CLEO_AGENT_ID`, when set.
 * @returns The anchor, or `null`.
 * @task T12864
 */
export function resolveAncestor(
  ppid: number,
  lookupProcess: ProcessLookup,
  lookupArgs: ProcessArgsLookup,
  agentId: string | null = null,
): AncestorAnchor | null {
  let pid = ppid;
  for (let depth = 0; depth < PPID_CHAIN_MAX_DEPTH; depth++) {
    if (pid <= 1) return null;
    const entry = lookupProcess(pid);
    if (!entry || entry.pid <= 1) return null;
    const args = lookupArgs(entry.pid);
    const program = programName(args ?? entry.command);
    if (INIT_PROCESSES.has(program) || INIT_PROCESSES.has(entry.command)) return null;
    if (OWNER_PROCESS_SHELLS.has(program)) {
      if (args === null) return null;
      if (!isCommandStringShell(args)) return { entry, program, type: 'shell' };
    } else if (!ANCESTOR_WRAPPERS.has(program)) {
      if (KNOWN_HARNESSES.has(program)) return { entry, program, type: 'harness' };
      return agentId ? { entry, program, type: 'host' } : null;
    }
    pid = entry.ppid;
  }
  return null;
}

/**
 * Key for an ancestor anchor. A plain long-lived shell is the terminal's own
 * identity (`process`, tab tier). A harness, a `CLEO_AGENT_ID`-named host, or a
 * shell with `CLEO_AGENT_ID` identifies one agent (`harness`, pane tier: more
 * specific than the tab), qualified by the env key it runs under, if any.
 */
function anchorKey(
  anchor: AncestorAnchor,
  agentId: string | null,
  under: TerminalKey | undefined,
): TerminalKey {
  const proc = `${anchor.entry.pid}@${anchor.entry.startedAt}`;
  if (anchor.type === 'shell' && !agentId) {
    return { key: `proc:${proc}`, source: 'process', kind: 'process' };
  }
  const agent = agentId ? `#agent=${agentId}` : '';
  const scope = under ? `|${under.key}` : '';
  return {
    key: `harness:${anchor.program}:${proc}${agent}${scope}`,
    source: 'process',
    kind: 'harness',
  };
}

/** Interactive / script shells skipped by {@link resolveOwnerProcess}, beyond the launchers. */
export const OWNER_PROCESS_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'tcsh',
  'csh',
  'pwsh',
  'powershell',
  'nu',
  'xonsh',
]);

/** Maximum number of ancestors {@link resolveOwnerProcess} inspects. */
export const OWNER_PROCESS_MAX_DEPTH = 8 as const;

/**
 * Resolve the long-lived process that OWNS the calling `cleo` invocation
 * (T12506): the nearest ancestor that is neither a launcher
 * ({@link PPID_CHAIN_LAUNCHERS}) nor a shell ({@link OWNER_PROCESS_SHELLS}).
 *
 * Agent harnesses run each tool call in a fresh `sh -c`, so the parent shell
 * dies the moment `cleo orchestrate spawn` returns; the harness above it
 * (e.g. `claude`, `codex`) lives as long as the agents it spawned. The worktree
 * lock records this process so its liveness keeps the lock held. When every
 * inspected ancestor is skippable, the last one read is returned.
 *
 * @param ppid - Parent pid to start from (defaults to `process.ppid`).
 * @param lookupProcess - Process-table reader (defaults to {@link readProcessEntry}).
 * @returns The owner process, or `null` when the chain cannot be read.
 */
export function resolveOwnerProcess(
  ppid: number = process.ppid,
  lookupProcess: ProcessLookup = readProcessEntry,
): ProcessAncestor | null {
  let pid = ppid;
  let last: ProcessAncestor | null = null;
  for (let depth = 0; depth < OWNER_PROCESS_MAX_DEPTH && pid > 1; depth++) {
    const entry = lookupProcess(pid);
    if (!entry) break;
    last = entry;
    if (!PPID_CHAIN_LAUNCHERS.has(entry.command) && !OWNER_PROCESS_SHELLS.has(entry.command)) {
      return entry;
    }
    pid = entry.ppid;
  }
  return last;
}

/**
 * Resolve the calling terminal's identity keys, most specific first (T12499).
 *
 * Every {@link TERMINAL_KEY_SOURCES} row whose variable is set contributes one
 * key. Unless a provider key is present, the ancestor walk
 * ({@link resolveAncestor}) then runs: with no env key its anchor is the only
 * key; under env keys an agent-level anchor (a harness, or `CLEO_AGENT_ID`) is
 * appended as the most specific key. The walk is memoised per process.
 *
 * Synchronous and database-free; binding persistence and lookup live in
 * `store/session-binding-store.ts`.
 *
 * @param options - Environment / process-table overrides (tests inject these).
 * @returns Ordered identity keys; empty when nothing identifies the terminal.
 *
 * @example
 * ```ts
 * resolveTerminalKeys({ env: { TMUX: '/tmp/tmux-501/default,123,0', TMUX_PANE: '%3' } });
 * // → [{ key: 'env:TMUX_PANE=/tmp/tmux-501/default,123,0|%3', source: 'TMUX_PANE', kind: 'multiplexer' }]
 * ```
 */
export function resolveTerminalKeys(options: ResolveTerminalKeysOptions = {}): TerminalKey[] {
  const env = options.env ?? process.env;
  const keys: TerminalKey[] = [];
  for (const source of TERMINAL_KEY_SOURCES) {
    const value = envValue(env, source.envVar);
    if (value === null) continue;
    const qualifiers = [source.qualifierEnvVar, ...(source.extraQualifierEnvVars ?? [])]
      .map((name) => envValue(env, name))
      .filter((q): q is string => q !== null);
    keys.push({
      key: `env:${source.envVar}=${[...qualifiers, value].join('|')}`,
      source: source.envVar,
      kind: source.kind,
    });
  }
  // A provider key already names one agent session: nothing is more specific.
  if (keys.some((k) => k.kind === 'provider')) return keys;
  const agentId = envValue(env, 'CLEO_AGENT_ID');
  const live =
    options.ppid === undefined &&
    options.lookupProcess === undefined &&
    options.lookupArgs === undefined;
  let anchor: AncestorAnchor | null;
  if (live) {
    // The live process's ancestry cannot change, so `ps` runs at most once per
    // ancestor per process (and agent id) even though resolution runs per dispatch.
    const memoKey = agentId ?? '';
    if (!liveAnchors.has(memoKey))
      liveAnchors.set(
        memoKey,
        resolveAncestor(process.ppid, readProcessEntry, readProcessArgs, agentId),
      );
    anchor = liveAnchors.get(memoKey) ?? null;
  } else {
    anchor = resolveAncestor(
      options.ppid ?? process.ppid,
      options.lookupProcess ?? readProcessEntry,
      options.lookupArgs ?? readProcessArgs,
      agentId,
    );
  }
  if (!anchor) return keys;
  if (keys.length === 0) return [anchorKey(anchor, agentId, undefined)];
  // Env tab / pane keys are inherited by every descendant, so two harnesses
  // (or two CLEO_AGENT_ID agents) under one ssh login, CI step or tab would
  // share them. An agent-level anchor below them is appended as the more
  // specific key; a plain shell anchor IS the tab and adds nothing.
  if (anchor.type === 'shell' && !agentId) return keys;
  return [...keys, anchorKey(anchor, agentId, keys[0])];
}

/** Memoised ancestor anchors of the live process, by `CLEO_AGENT_ID` ('' = unset). */
const liveAnchors = new Map<string, AncestorAnchor | null>();
