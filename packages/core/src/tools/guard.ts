/**
 * Tool guardrail chokepoint (E3 · T11407 · SG-PACKAGE-ARCH).
 *
 * A SINGLE deny-first validation layer wrapping every atomic primitive
 * ({@link ./fs.js} + {@link ./shell.js}). All side-effecting tool calls flow
 * through `createToolGuard()` so policy lives in ONE place:
 *   - **fs** → path **allowlist** (deny-first: when `allowedRoots` is set, a path
 *     must resolve under one of them, else it is denied).
 *   - **shell** → command **denylist** (a command whose name matches the
 *     denylist is rejected before spawning).
 *
 * Ships **warn-then-enforce**: the default `mode: 'warn'` logs a structured
 * warning and proceeds, so NO existing call site breaks when it adopts the
 * guard; `mode: 'enforce'` throws {@link GuardDeniedError} before any side
 * effect. The boundary lint (T11409) later makes the guarded surface the only
 * public one.
 *
 * ## Date-gated default flip (T11474 · AC4)
 *
 * The default posture is governed by {@link resolveDefaultGuardMode}, a
 * date-gated mechanism keyed on {@link GUARD_ENFORCE_DEADLINE}. Until that
 * deadline passes the default stays `warn`; on/after it the date-gate WOULD
 * yield `enforce`.
 *
 * The flip is, however, an **owner-gated decision** and is NOT auto-applied.
 * Per the owner-ratified self-shaping hard-gate (BRAIN `O-mpt8gjdx-0`,
 * 2026-05-30), flipping this default to `enforce` is one of THREE gates that
 * together unblock dynamic tool/skill forging; the other two — an approval-token
 * CONDUIT gate and a discretion rate-limit (`DiscretionEvaluator`) — are NOT yet
 * live. So the live default is held at `warn` behind
 * {@link GUARD_ENFORCE_FLIP_ENABLED} (currently `false`); the mechanism is
 * encoded but the flip awaits explicit owner confirmation that (a) the deadline
 * has passed AND (b) the full suite is green with `enforce` on. Flip by setting
 * `GUARD_ENFORCE_FLIP_ENABLED = true` once those conditions hold.
 *
 * @epic T11390
 * @task T11407
 * @saga T11387
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { RunShellInput, RunShellResult } from '@cleocode/contracts/tools/agent-tools';
import type {
  ExecuteShellInput,
  ExecuteShellResult,
  PathExistsInput,
  PathExistsResult,
  ReadFileInput,
  ReadFileResult,
  RunGitInput,
  WriteFileInput,
  WriteFileResult,
} from '@cleocode/contracts/tools/atomic';
import { getLogger } from '../logger.js';
import { scrubSubprocessEnv } from './env-scrub.js';
import { canonicalizePath, pathExists, readFileText, readJson, writeFileAtomic } from './fs.js';
import { runPty } from './pty.js';
import { executeShell, runGit, type ShellExecutor } from './shell.js';

const log = getLogger('tool-guard');

/** Enforcement posture for a {@link ToolGuard}. */
export type GuardMode = 'warn' | 'enforce';

/**
 * Owner-set deadline (ISO-8601 date, UTC) after which the guard's DATE-GATE
 * would yield `enforce` as the default posture.
 *
 * This is the date leg of the warn→enforce flip (T11474 · AC4). It is a single
 * source of truth — change this one const to move the date. The flip is NOT
 * applied on this date alone: it is additionally held behind
 * {@link GUARD_ENFORCE_FLIP_ENABLED} (an owner-gated kill-switch), because the
 * owner-ratified self-shaping hard-gate (BRAIN `O-mpt8gjdx-0`) requires two
 * sibling systems (approval-token CONDUIT gate + discretion rate-limit) to be
 * live before `enforce` becomes the default.
 *
 * @remarks Placeholder owner-TBD value held one year out — the live default
 *   stays `warn` regardless via {@link GUARD_ENFORCE_FLIP_ENABLED}. Replace with
 *   the real ratified date when the owner sets it.
 */
export const GUARD_ENFORCE_DEADLINE = '2027-01-01T00:00:00.000Z';

/**
 * Owner-gated master switch for the warn→enforce default flip.
 *
 * When `false` (the current, held state), the live default is ALWAYS `warn`
 * regardless of {@link GUARD_ENFORCE_DEADLINE} — the date-gate is encoded but
 * inert. Set to `true` ONLY when the owner confirms (a) the deadline has passed,
 * (b) the full suite is green with `enforce` on, and (c) the sibling self-shaping
 * gates are live (BRAIN `O-mpt8gjdx-0`). This indirection keeps the mechanism in
 * source without a silent, date-triggered behavior change.
 */
export const GUARD_ENFORCE_FLIP_ENABLED = false;

/**
 * Resolve the date-gated default {@link GuardMode}.
 *
 * Returns `enforce` only when BOTH the owner master switch
 * ({@link GUARD_ENFORCE_FLIP_ENABLED}) is on AND `now` is at/after
 * {@link GUARD_ENFORCE_DEADLINE}; otherwise `warn`. Callers that pass an
 * explicit `policy.mode` to {@link createToolGuard} bypass this entirely.
 *
 * @param now - The instant to evaluate the deadline against; defaults to the
 *   current time. Injectable so unit tests can assert both sides of the gate
 *   without clock manipulation.
 * @returns `'enforce'` once the gate fully opens, else `'warn'`.
 *
 * @example
 * ```ts
 * // Today (switch off): always 'warn'
 * resolveDefaultGuardMode(); // 'warn'
 * ```
 */
export function resolveDefaultGuardMode(now: Date = new Date()): GuardMode {
  if (!GUARD_ENFORCE_FLIP_ENABLED) return 'warn';
  return now.getTime() >= Date.parse(GUARD_ENFORCE_DEADLINE) ? 'enforce' : 'warn';
}

/** Deny-first policy for the tool guard. */
export interface ToolGuardPolicy {
  /**
   * Absolute roots that fs primitives may touch. When set, a path NOT resolving
   * under any root is a violation. When omitted, fs paths are unrestricted
   * (the guard still funnels them through the chokepoint for logging).
   */
  readonly allowedRoots?: readonly string[];
  /**
   * Command names (basenames) that shell primitives may NOT run, e.g.
   * `['rm', 'shutdown', 'mkfs']`. Matched against the command's last path
   * segment.
   */
  readonly deniedCommands?: readonly string[];
  /**
   * `'warn'` logs + proceeds; `'enforce'` throws before the effect. When
   * omitted, the default comes from the date-gated {@link resolveDefaultGuardMode}
   * (held at `'warn'` until the owner-gated flip — see {@link GUARD_ENFORCE_DEADLINE}).
   */
  readonly mode?: GuardMode;
}

/** Thrown by an `enforce`-mode guard when a primitive call violates policy. */
export class GuardDeniedError extends Error {
  /** Machine-readable code. */
  readonly code = 'E_TOOL_GUARD_DENIED';
  constructor(message: string) {
    super(message);
    this.name = 'GuardDeniedError';
  }
}

/** The guarded primitive surface returned by {@link createToolGuard}. */
export interface ToolGuard {
  /**
   * The resolved enforcement posture this guard was constructed with. Exposed so
   * a security-sensitive consumer (e.g. the Pi adapter) can ASSERT it received an
   * `enforce`-mode guard before handing it untrusted work — in `warn` mode the
   * allowlist/denylist are advisory (log-and-proceed) and provide no boundary.
   */
  readonly mode: GuardMode;
  readFileText(input: ReadFileInput): Promise<ReadFileResult>;
  readJson<T>(path: string): Promise<T>;
  writeFileAtomic(input: WriteFileInput): Promise<WriteFileResult>;
  pathExists(input: PathExistsInput): Promise<PathExistsResult>;
  executeShell(input: ExecuteShellInput, executor?: ShellExecutor): Promise<ExecuteShellResult>;
  /**
   * Run a command under a PTY (or a non-PTY spawn fallback) through the guard.
   * The command basename is checked against the denylist BEFORE any process is
   * spawned and the child env is scrubbed — same policy point as
   * {@link ToolGuard.executeShell}.
   */
  executePty(input: RunShellInput): Promise<RunShellResult>;
  runGit(input: RunGitInput, executor?: ShellExecutor): Promise<ExecuteShellResult>;
}

/** True when the resolved absolute `abs` is equal to or under one of `roots`. */
function isUnderRoots(abs: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const r = resolvePath(root);
    return abs === r || abs.startsWith(`${r}/`);
  });
}

/**
 * Whether `path` is allowed under `roots` after SYMLINK RESOLUTION.
 *
 * Both the candidate path AND each allowed root are canonicalized via
 * {@link canonicalizePath} (which follows every symlink component, including a
 * symlinked parent of a not-yet-existing write target) BEFORE the containment
 * comparison. A purely lexical check is symlink-blind — a symlink planted inside
 * an allowed root that points outside it would pass, then the underlying fs
 * primitive would follow it. Resolving first closes that escape.
 *
 * @param path - The candidate path.
 * @param roots - The allowed roots.
 * @returns `true` when the real target is contained.
 */
async function isPathAllowed(path: string, roots: readonly string[]): Promise<boolean> {
  const realAbs = await canonicalizePath(isAbsolute(path) ? path : resolvePath(path));
  const realRoots = await Promise.all(roots.map((r) => canonicalizePath(resolvePath(r))));
  return isUnderRoots(realAbs, realRoots);
}

/** The denied command name matched by the policy, or null when allowed. */
function deniedCommand(command: string, denied: readonly string[]): string | null {
  const base = command.split('/').pop() ?? command;
  return denied.includes(base) || denied.includes(command) ? base : null;
}

/**
 * Build a deny-first {@link ToolGuard} from a {@link ToolGuardPolicy}. Every
 * returned primitive validates against the policy, then (when allowed, or in
 * `warn` mode) delegates to the raw `core/src/tools` primitive.
 *
 * @example
 * ```ts
 * const tools = createToolGuard({ allowedRoots: [projectRoot], mode: 'enforce' });
 * await tools.writeFileAtomic({ path: join(projectRoot, 'x'), content: '1' }); // ok
 * await tools.writeFileAtomic({ path: '/etc/passwd', content: 'x' });          // throws
 * ```
 */
export function createToolGuard(policy: ToolGuardPolicy = {}): ToolGuard {
  // Explicit policy.mode always wins; otherwise the date-gated default applies
  // (held at 'warn' behind the owner-gated flip — T11474 · AC4).
  const mode: GuardMode = policy.mode ?? resolveDefaultGuardMode();

  const denyFs = async (op: string, path: string): Promise<boolean> => {
    if (!policy.allowedRoots || policy.allowedRoots.length === 0) return false;
    // Symlink-resolving containment — a lexically-inside path whose REAL target
    // (via a symlinked component) escapes the roots is rejected here.
    if (await isPathAllowed(path, policy.allowedRoots)) return false;
    const msg = `tool-guard: fs.${op} path "${path}" resolves outside the allowed roots`;
    if (mode === 'enforce') throw new GuardDeniedError(msg);
    log.warn({ op, path, allowedRoots: policy.allowedRoots }, msg);
    return false; // warn-then-proceed
  };

  const denyShell = (op: string, command: string): boolean => {
    const hit = policy.deniedCommands?.length
      ? deniedCommand(command, policy.deniedCommands)
      : null;
    if (!hit) return false;
    const msg = `tool-guard: shell.${op} command "${hit}" is on the denylist`;
    if (mode === 'enforce') throw new GuardDeniedError(msg);
    log.warn({ op, command }, msg);
    return false;
  };

  // NOTE: every method is `async` so a deny-check throw in `enforce` mode
  // surfaces as a REJECTED promise (not a synchronous throw) — the API contract
  // is `Promise<…>`, and callers (+ vitest `.rejects`) expect rejection.
  return {
    mode,
    async readFileText(input) {
      await denyFs('readFileText', input.path);
      return readFileText(input);
    },
    async readJson<T>(path: string) {
      await denyFs('readJson', path);
      return readJson<T>(path);
    },
    async writeFileAtomic(input) {
      await denyFs('writeFileAtomic', input.path);
      return writeFileAtomic(input);
    },
    async pathExists(input) {
      await denyFs('pathExists', input.path);
      return pathExists(input);
    },
    async executeShell(input, executor) {
      denyShell('executeShell', input.command);
      // Scrub the child env at the chokepoint: never inherit the daemon's
      // secrets, never forward a Pi-controlled loader hook / PATH. The
      // caller-supplied `env` is merged ON TOP but itself scrubbed (a forbidden
      // key — loader hook, PATH, secret — is dropped here). `defaultShellExecutor`
      // also scrubs as a redundant net, but the guard is the policy point.
      const env = scrubSubprocessEnv({ extra: input.env });
      return executeShell({ ...input, env }, executor);
    },
    async executePty(input) {
      // Same policy point as executeShell: deny-check the command basename
      // BEFORE spawning any PTY/process. `runPty` re-scrubs the env internally
      // (PTY + spawn paths both use `scrubSubprocessEnv`), so the daemon's
      // secrets and any Pi-controlled loader hook can never reach the child.
      denyShell('executePty', input.command);
      return runPty(input);
    },
    async runGit(input, executor) {
      denyShell('runGit', 'git');
      return runGit(input, executor);
    },
  };
}
