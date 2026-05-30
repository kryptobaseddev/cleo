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
 * @epic T11390
 * @task T11407
 * @saga T11387
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';
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
import { pathExists, readFileText, readJson, writeFileAtomic } from './fs.js';
import { executeShell, runGit, type ShellExecutor } from './shell.js';

const log = getLogger('tool-guard');

/** Enforcement posture for a {@link ToolGuard}. */
export type GuardMode = 'warn' | 'enforce';

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
  /** `'warn'` (default) logs + proceeds; `'enforce'` throws before the effect. */
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
  readFileText(input: ReadFileInput): Promise<ReadFileResult>;
  readJson<T>(path: string): Promise<T>;
  writeFileAtomic(input: WriteFileInput): Promise<WriteFileResult>;
  pathExists(input: PathExistsInput): Promise<PathExistsResult>;
  executeShell(input: ExecuteShellInput, executor?: ShellExecutor): Promise<ExecuteShellResult>;
  runGit(input: RunGitInput, executor?: ShellExecutor): Promise<ExecuteShellResult>;
}

/** True when `path` resolves under one of `roots`. */
function isPathAllowed(path: string, roots: readonly string[]): boolean {
  const abs = isAbsolute(path) ? path : resolvePath(path);
  return roots.some((root) => {
    const r = resolvePath(root);
    return abs === r || abs.startsWith(`${r}/`);
  });
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
  const mode: GuardMode = policy.mode ?? 'warn';

  const denyFs = (op: string, path: string): boolean => {
    if (!policy.allowedRoots || policy.allowedRoots.length === 0) return false;
    if (isPathAllowed(path, policy.allowedRoots)) return false;
    const msg = `tool-guard: fs.${op} path "${path}" is outside the allowed roots`;
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
    async readFileText(input) {
      denyFs('readFileText', input.path);
      return readFileText(input);
    },
    async readJson<T>(path: string) {
      denyFs('readJson', path);
      return readJson<T>(path);
    },
    async writeFileAtomic(input) {
      denyFs('writeFileAtomic', input.path);
      return writeFileAtomic(input);
    },
    async pathExists(input) {
      denyFs('pathExists', input.path);
      return pathExists(input);
    },
    async executeShell(input, executor) {
      denyShell('executeShell', input.command);
      return executeShell(input, executor);
    },
    async runGit(input, executor) {
      denyShell('runGit', 'git');
      return runGit(input, executor);
    },
  };
}
