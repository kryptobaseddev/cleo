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
 * ## ppid-chain fallback
 *
 * When no environment key is present, the identity falls back to the nearest
 * ancestor process that is not a launcher (node, pnpm, npx, mise, …) — in
 * practice the interactive shell of the terminal tab. The key carries the
 * process start time, so a recycled pid never matches a stale binding. The walk
 * is bounded ({@link PPID_CHAIN_MAX_DEPTH}) and never climbs past the first
 * non-launcher ancestor, because anything above the shell (the terminal
 * emulator, tmux server, launchd) is shared by every tab and would re-create the
 * cross-terminal bleed this module exists to remove.
 *
 * @module
 * @task T12499
 * @epic T12497
 */

import { execFileSync } from 'node:child_process';
import { PS_STABLE_ENV } from '@cleocode/contracts';

/** Where a terminal key comes from. */
export type TerminalKeyKind = 'provider' | 'multiplexer' | 'terminal' | 'ppid';

/**
 * One row of the provider/terminal key map: an environment variable whose value
 * identifies a single harness session, multiplexer pane or terminal tab.
 */
export interface TerminalKeySource {
  /** Environment variable carrying the identity value. */
  readonly envVar: string;
  /** Category of identity (drives precedence documentation only). */
  readonly kind: Exclude<TerminalKeyKind, 'ppid'>;
  /** Harness / terminal that exports the variable. */
  readonly origin: string;
  /**
   * Optional companion variable that disambiguates the value. `TMUX_PANE` is
   * `%0` on every tmux server, so it is qualified by `TMUX` (socket path, server
   * pid, session index) to stay unique across servers.
   */
  readonly qualifierEnvVar?: string;
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

/** Maximum number of ancestors the ppid-chain walk inspects. */
export const PPID_CHAIN_MAX_DEPTH = 4 as const;

/** One resolved identity key for the calling terminal. */
export interface TerminalKey {
  /** Opaque, stable binding key (`env:<VAR>=<value>` or `ppid:<pid>@<start>`). */
  readonly key: string;
  /** Environment variable name, or `'ppid'` for the process-chain fallback. */
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

/** Inputs for {@link resolveTerminalKeys}; every field defaults to the live process. */
export interface ResolveTerminalKeysOptions {
  /** Environment to read (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Parent pid to start the ppid-chain walk from (defaults to `process.ppid`). */
  readonly ppid?: number;
  /** Process-table reader (defaults to {@link readProcessEntry}). */
  readonly lookupProcess?: ProcessLookup;
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
 * Resolve the ppid-chain fallback key: the nearest non-launcher ancestor.
 *
 * @param ppid - Parent pid to start from.
 * @param lookupProcess - Process-table reader.
 * @returns The fallback key, or `null` when the chain cannot be read.
 */
function resolvePpidKey(ppid: number, lookupProcess: ProcessLookup): TerminalKey | null {
  let pid = ppid;
  for (let depth = 0; depth < PPID_CHAIN_MAX_DEPTH && pid > 1; depth++) {
    const entry = lookupProcess(pid);
    if (!entry) return null;
    if (!PPID_CHAIN_LAUNCHERS.has(entry.command)) {
      return { key: `ppid:${entry.pid}@${entry.startedAt}`, source: 'ppid', kind: 'ppid' };
    }
    pid = entry.ppid;
  }
  return null;
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
 * key. Only when NO row matches does the ppid-chain fallback run, so the common
 * case (an agent harness or a mainstream terminal) never spawns `ps`.
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
    const qualifier = envValue(env, source.qualifierEnvVar);
    keys.push({
      key: `env:${source.envVar}=${qualifier === null ? value : `${qualifier}|${value}`}`,
      source: source.envVar,
      kind: source.kind,
    });
  }
  if (keys.length > 0) return keys;
  const live = options.ppid === undefined && options.lookupProcess === undefined;
  let ppidKey: TerminalKey | null;
  if (live) {
    // The live process's ancestry cannot change, so `ps` runs at most once per
    // process even though identity resolution runs on every dispatch.
    if (livePpidKey === undefined) livePpidKey = resolvePpidKey(process.ppid, readProcessEntry);
    ppidKey = livePpidKey;
  } else {
    ppidKey = resolvePpidKey(
      options.ppid ?? process.ppid,
      options.lookupProcess ?? readProcessEntry,
    );
  }
  return ppidKey ? [ppidKey] : [];
}

/** Memoised ppid-chain key of the live process (`undefined` = not yet read). */
let livePpidKey: TerminalKey | null | undefined;
