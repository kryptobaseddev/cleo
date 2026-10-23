/**
 * `cleo hook stop --provider <p>`: the one Stop dispatcher (T13796).
 *
 * A goal runtime (CLEO Goal's `cleo-goal tick`) and CLEO's ask-enforce both
 * want the Stop event; as two hooks they fight. This dispatcher owns the
 * event, in order goal tick → ask-enforce. Stop fires at the end of EVERY
 * turn, so it never ends the CLEO session (T13913): ending there deleted the
 * terminal binding and ran the session-end snapshot work once per turn. The
 * provider's real session-end event does it instead, through
 * `cleo hook session-end` ({@link sessionEndHook}; Claude Code `SessionEnd`).
 *
 * 1. When a goal workspace exists (`.opencode/goals/` at or above the project),
 *    run the tick (`CLEO_GOAL_TICK_COMMAND`, else `<bin> tick` with the CLEO
 *    Goal bin resolved as `cleo-goal`, then its alias `ocg`) with the
 *    harness's Stop JSON on stdin. With no workspace, or no bin, there is no
 *    tick: the no-goal path costs nothing, and an unrelated binary never sees
 *    Stop JSON. The tick MUST write only JSON to stdout.
 * 2. `{"decision":"block","reason":…}` on its stdout: a live goal continues the
 *    turn. CLEO re-serialises exactly `{decision, reason}` (reason capped at
 *    {@link MAX_REASON_CHARS}), so a tick can never inject other hook fields
 *    (`continue`, `stopReason`, `systemMessage`, `hookSpecificOutput`).
 * 3. `{"final":false}`: a live goal that is not finished but does not
 *    continue the turn (paused, waiting on the owner). Nothing is printed.
 * 4. Otherwise ask-enforce (T13420) judges the turn and its answer (a block
 *    or a `warn`) is forwarded. A tick that is missing (exit 127), fails,
 *    times out or prints non-JSON counts as no goal, and an ask-enforce step
 *    that throws counts as no answer: every step fails open, never trapping a
 *    turn.
 *
 * `CLEO_GOAL_TICK=off` skips the tick. Claude Code and Codex answer a Stop
 * hook in the same `{"decision":"block","reason"}` shape. The tick runs in its
 * own process group and the whole group is SIGKILLed at its deadline
 * (`CLEO_GOAL_TICK_TIMEOUT_MS`, at most {@link MAX_TICK_TIMEOUT_MS}, under the
 * harness's hook timeout), so a tick that traps SIGTERM or leaves a
 * grandchild behind can never hold the stop past it.
 *
 * @epic T13791
 * @task T13796
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { HookJsonValue } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { GOAL_TICK_PROVIDER_ENV } from '@cleocode/contracts/goal-runtime.js';

/** Harnesses `cleo hook stop` dispatches for. */
export const STOP_DISPATCH_PROVIDERS = ['claude-code', 'codex'] as const;

/** One of {@link STOP_DISPATCH_PROVIDERS}. */
export type StopDispatchProvider = (typeof STOP_DISPATCH_PROVIDERS)[number];

/**
 * Harnesses with a real session-end event that `cleo hook session-end` serves
 * (T13913): Claude Code's `SessionEnd`. Codex has none, so a Codex session is
 * ended explicitly (`cleo session end`), never by a turn's Stop.
 */
export const SESSION_END_PROVIDERS = ['claude-code'] as const;

/** Deadline for one tick when `CLEO_GOAL_TICK_TIMEOUT_MS` is unset. */
const DEFAULT_TICK_TIMEOUT_MS = 30_000;

/** Longest tick deadline, kept well under the Stop hook's harness timeout (120 s). */
export const MAX_TICK_TIMEOUT_MS = 60_000;

/**
 * Longest the ask-enforce step may take once the tick is done (T13890): it is
 * in-process and normally instant, but nothing after the tick may stretch the
 * Stop toward the harness's own timeout.
 */
export const ASK_ENFORCE_DEADLINE_MS = 5_000;

/**
 * Longest the session-end hook waits for `cleo session end` (T13890, T13893).
 * Past it the session end is left to finish in the background, detached, so a
 * harness that kills its hook sooner never cuts the session end short.
 */
export const SESSION_END_WAIT_MS = 20_000;

/** Longest block reason forwarded to the harness. */
export const MAX_REASON_CHARS = 4000;

/** Longest tick stdout read. */
const MAX_TICK_OUTPUT_BYTES = 1024 * 1024;

function isRecord(value: HookJsonValue): value is { readonly [key: string]: HookJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the tick command did. */
export interface TickRun {
  /** Exit status; null when it was killed or never started. */
  readonly status: number | null;
  /** Its stdout. */
  readonly stdout: string;
}

/** Side effects of the dispatcher, injectable for tests. */
export interface StopDispatchDeps {
  /** The CLEO Goal tick command (`cleo-goal`, then `ocg`), or null when it is not installed. */
  readonly goalTick: () => Promise<string | null>;
  /** Whether a goal workspace exists for this Stop (no workspace, no tick). */
  readonly hasGoalWorkspace: (input: string) => boolean;
  /** Run the tick command with the Stop JSON on stdin, killed at the deadline. */
  readonly runTick: (command: string, input: string, timeoutMs: number) => Promise<TickRun>;
  /** The ask-enforce hook's stdout for this Stop (empty when it does not answer). */
  readonly askEnforce: (input: string) => Promise<string>;
  /** One diagnostic line to stderr (a deadline hit). */
  readonly warn?: (line: string) => void;
}

/** The goal runtime's verdict on one stop. */
export type TickDecision =
  | { readonly kind: 'block'; readonly answer: string }
  | { readonly kind: 'hold' }
  | { readonly kind: 'final' };

/**
 * Read a tick's result. Only a clean exit with a JSON object counts; every
 * other outcome is `final`, so a missing or broken goal runtime falls through
 * to ask-enforce.
 *
 * @param run - What the tick command did.
 * @returns The decision.
 */
export function parseTick(run: TickRun): TickDecision {
  const text = run.stdout.trim();
  if (run.status !== 0 || text === '') return { kind: 'final' };
  let answer: HookJsonValue;
  try {
    answer = JSON.parse(text) as HookJsonValue;
  } catch {
    return { kind: 'final' };
  }
  if (!isRecord(answer)) return { kind: 'final' };
  // Only {decision, reason} reaches the harness; every other field the tick wrote is dropped.
  if (answer.decision === 'block' && typeof answer.reason === 'string') {
    const reason = answer.reason.slice(0, MAX_REASON_CHARS);
    return { kind: 'block', answer: `${JSON.stringify({ decision: 'block', reason })}\n` };
  }
  return answer.final === false ? { kind: 'hold' } : { kind: 'final' };
}

/** `work`, or `fallback` once `ms` pass (calling `onTimeout`) or `work` rejects; the timer never holds the process. */
function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((done) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      done(fallback);
    }, ms);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      () => {
        clearTimeout(timer);
        done(fallback);
      },
    );
  });
}

/**
 * Dispatch one Stop: the goal runtime first, then ask-enforce. The CLEO
 * session is never ended here (T13913).
 *
 * @param stdin - The harness's Stop JSON.
 * @param env - Environment (`CLEO_GOAL_TICK*`; ask-enforce reads `CLEO_ASK_ENFORCE`).
 * @param deps - Tick runner and ask-enforce.
 * @returns What to print to the harness.
 */
export async function stopDispatch(
  stdin: string,
  env: Readonly<Record<string, string | undefined>>,
  deps: StopDispatchDeps,
): Promise<{ readonly stdout: string }> {
  const timeout = Math.min(
    Number(env.CLEO_GOAL_TICK_TIMEOUT_MS) || DEFAULT_TICK_TIMEOUT_MS,
    MAX_TICK_TIMEOUT_MS,
  );
  const command =
    env.CLEO_GOAL_TICK?.trim().toLowerCase() === 'off' || !deps.hasGoalWorkspace(stdin)
      ? null
      : env.CLEO_GOAL_TICK_COMMAND?.trim() || (await deps.goalTick());
  const decision: TickDecision =
    command === null ? { kind: 'final' } : parseTick(await deps.runTick(command, stdin, timeout));
  if (decision.kind === 'block') return { stdout: decision.answer };
  if (decision.kind === 'hold') return { stdout: '' };
  const asked = await withDeadline(deps.askEnforce(stdin), ASK_ENFORCE_DEADLINE_MS, '', () =>
    deps.warn?.(
      `[cleo hook] ask-enforce gave no answer within ${ASK_ENFORCE_DEADLINE_MS} ms; treated as no block\n`,
    ),
  );
  return { stdout: asked };
}

/**
 * `cleo hook session-end` (T13913): the provider's real session end ends the
 * CLEO session with `cleo session end --quiet` through the running CLI,
 * detached, waited for at most `waitMs` ({@link SESSION_END_WAIT_MS}), its
 * output kept off the harness's streams. A Stop never calls this.
 *
 * @param warn - Receives a diagnostic line (failed or overrunning session end).
 * @param waitMs - Longest wait (tests shorten it).
 * @returns Resolves on exit or at the deadline; never rejects.
 */
export function sessionEndHook(
  warn: (line: string) => void,
  waitMs: number = SESSION_END_WAIT_MS,
): Promise<void> {
  const cli = process.argv[1];
  return runBounded(
    cli ? process.execPath : 'cleo',
    [...(cli ? [cli] : []), 'session', 'end', '--quiet'],
    waitMs,
    'session end',
    warn,
    SESSION_END_BENIGN_EXITS,
  );
}

/**
 * Whether the user opted out of ask-enforce the way that removed its separate
 * Stop hook before the dispatcher: the heavy-command mode `off`
 * (`CLEO_HEAVY_COMMAND_HOOK`, else `resources.heavyCommandHook`), read at run
 * time with the same resolver the heavy-command hook uses. (`CLEO_ASK_ENFORCE
 * =off` is honoured by ask-enforce itself.)
 *
 * @param env - Environment.
 * @param cwd - Where the hook runs; the project config is found from here.
 * @param configuredMode - Reads `resources.heavyCommandHook` (tests inject).
 * @returns True when ask-enforce must be skipped.
 */
export async function askEnforceOptedOut(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  configuredMode?: (projectRoot: string) => Promise<string | undefined>,
): Promise<boolean> {
  const core = await import('@cleocode/core/resources/heavy-command.js');
  const envMode = env.CLEO_HEAVY_COMMAND_HOOK;
  const projectRoot = env.CLAUDE_PROJECT_DIR || core.heavyHookProjectRoot(cwd);
  const read = configuredMode ?? core.configuredHeavyHookMode;
  const mode = core.resolveHeavyHookMode(
    envMode,
    core.isHeavyCommandHookMode(envMode) ? undefined : await read(projectRoot),
  );
  return mode === 'off';
}

/**
 * The real side effects: the tick through the shell (the command is the
 * project's own configuration) and ask-enforce in-process.
 *
 * @param provider - Harness protocol ask-enforce answers in.
 * @param env - Environment ask-enforce reads.
 * @returns The default {@link StopDispatchDeps}.
 */
export function processStopDispatchDeps(
  provider: StopDispatchProvider,
  env: Readonly<Record<string, string | undefined>>,
): StopDispatchDeps {
  const warn = (line: string): void => {
    process.stderr.write(line);
  };
  return {
    askEnforce: async (input) => {
      if (await askEnforceOptedOut(env, process.cwd())) return '';
      const entry = await import('./ask-enforce-entry.js');
      const lookup = await entry.caampAskToolLookup();
      const answer = await entry.askEnforceHook(provider, input, env, lookup);
      return answer.stdout;
    },
    goalTick: async () => {
      const { goalTickCommand } = await import('@cleocode/core/goal/runtime.js');
      return goalTickCommand({ ...process.env, ...env });
    },
    hasGoalWorkspace: (input) => hasGoalWorkspace(input, env),
    runTick: (command, input, timeoutMs) => runTickKillable(command, input, timeoutMs, provider),
    warn,
  };
}

/**
 * `cleo session end` exits that only mean there was no session to end (a
 * session end with no bound session): expected, so they print no warning.
 */
export const SESSION_END_BENIGN_EXITS: readonly number[] = [
  ExitCode.SESSION_UNBOUND,
  ExitCode.SESSION_NOT_FOUND,
];

/**
 * Run a detached process and wait for it at most `waitMs`. A non-zero exit or
 * a spawn error gets one `warn` line with the duration. Past the wait the
 * process keeps running, unref'd, with one `warn` line. Never rejects.
 *
 * @param command - Executable.
 * @param args - Its arguments.
 * @param waitMs - Longest wait.
 * @param label - Name used in the warning.
 * @param warn - Receives the diagnostic line.
 * @param benignExits - Non-zero exit codes that are expected and get no warning.
 * @returns Resolves on exit or at the deadline, whichever comes first.
 */
export function runBounded(
  command: string,
  args: readonly string[],
  waitMs: number,
  label: string,
  warn: (line: string) => void,
  benignExits: readonly number[] = [],
): Promise<void> {
  return new Promise((done) => {
    const started = Date.now();
    let settled = false;
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      settled = true;
      child.unref();
      warn(
        `[cleo hook] ${label} still running after ${Date.now() - started} ms; left to finish in the background\n`,
      );
      done();
    }, waitMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      warn(`[cleo hook] ${label} failed after ${Date.now() - started} ms: ${err.message}\n`);
      done();
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && (code === null || !benignExits.includes(code))) {
        warn(
          `[cleo hook] ${label} failed after ${Date.now() - started} ms (${signal ?? `exit ${code}`})\n`,
        );
      }
      done();
    });
  });
}

/**
 * Whether `.opencode/goals/` exists at or above the Stop's project (the harness
 * project directory `CLAUDE_PROJECT_DIR`, else the payload's `cwd`, else the
 * process's), searching no higher than the repository: the first directory
 * holding `.git` or `.cleo`.
 *
 * @param input - The Stop JSON.
 * @param env - Environment.
 * @returns True when a goal workspace exists.
 */
export function hasGoalWorkspace(
  input: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  let cwd: string | undefined;
  try {
    const payload = JSON.parse(input) as HookJsonValue;
    if (isRecord(payload) && typeof payload.cwd === 'string') cwd = payload.cwd;
  } catch {
    // No payload cwd: fall back below.
  }
  let dir = resolve(env.CLAUDE_PROJECT_DIR || cwd || process.cwd());
  for (;;) {
    if (existsSync(join(dir, '.opencode', 'goals'))) return true;
    // The repository root bounds the search (a monorepo keeps goals there): a stray
    // `~/.opencode/goals` above it must not turn the tick on for every project below.
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.cleo'))) return false;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/**
 * Run a tick through the shell (the command is the project's own
 * configuration) in its own process group; at the deadline the whole group is
 * SIGKILLed and the run counts as killed, so neither a SIGTERM trap nor a
 * daemonised grandchild holding stdout can hold the stop.
 *
 * @param command - The tick command line.
 * @param input - The Stop JSON for its stdin.
 * @param timeoutMs - Deadline.
 * @param provider - The harness whose Stop this is, passed to the tick as
 *   {@link GOAL_TICK_PROVIDER_ENV}; the rest of the environment is inherited.
 * @returns What the tick did.
 */
export function runTickKillable(
  command: string,
  input: string,
  timeoutMs: number,
  provider?: StopDispatchProvider,
): Promise<TickRun> {
  return new Promise((done) => {
    let stdout = '';
    let settled = false;
    const finish = (run: TickRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(run);
    };
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(provider === undefined
        ? {}
        : { env: { ...process.env, [GOAL_TICK_PROVIDER_ENV]: provider } }),
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      // A grandchild that escaped the group may still hold stdout: stop waiting on it.
      child.stdout.destroy();
      child.unref();
      finish({ status: null, stdout: '' });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_TICK_OUTPUT_BYTES) stdout += chunk;
    });
    child.on('error', () => finish({ status: null, stdout: '' }));
    child.on('close', (code) => finish({ status: code, stdout }));
    child.stdin.on('error', () => {}); // a tick that never reads stdin
    child.stdin.end(input);
  });
}
