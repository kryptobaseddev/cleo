/**
 * `cleo hook stop --provider <p>`: the one Stop dispatcher (T13796).
 *
 * A goal runtime (OpenCode-Goal's `ocg tick`) and CLEO's `cleo session end`
 * both want the Stop event; as two hooks they fight (the session ends while
 * the goal keeps the turn going). This dispatcher owns the event and asks the
 * goal runtime first:
 *
 * 1. Run the tick command (`CLEO_GOAL_TICK_COMMAND`, default `ocg tick`) with
 *    the harness's Stop JSON on stdin.
 * 2. `{"decision":"block","reason":…}` on its stdout: a live goal continues the
 *    turn. The answer goes to the harness verbatim and the session stays open.
 * 3. `{"final":false}`: a live goal that is not finished but does not
 *    continue the turn (paused, waiting on the owner). The session stays open.
 * 4. Anything else ends the session exactly as before: no output, `{"final":
 *    true}`, no goal runtime installed (exit 127), a tick that fails, times out
 *    or prints something that is not JSON. Fail open, never trap a session.
 *
 * `CLEO_GOAL_TICK=off` skips the tick. Claude Code and Codex answer a Stop
 * hook in the same `{"decision":"block","reason"}` shape.
 *
 * @epic T13791
 * @task T13796
 */

import { spawnSync } from 'node:child_process';
import type { HookJsonValue } from '@cleocode/contracts';

/** Harnesses `cleo hook stop` dispatches for. */
export const STOP_DISPATCH_PROVIDERS = ['claude-code', 'codex'] as const;

/** One of {@link STOP_DISPATCH_PROVIDERS}. */
export type StopDispatchProvider = (typeof STOP_DISPATCH_PROVIDERS)[number];

/** The goal runtime's tick when `CLEO_GOAL_TICK_COMMAND` is unset. */
export const DEFAULT_GOAL_TICK_COMMAND = 'ocg tick';

/** Deadline for one tick when `CLEO_GOAL_TICK_TIMEOUT_MS` is unset. */
const DEFAULT_TICK_TIMEOUT_MS = 30_000;

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
  /** Run the tick command with the Stop JSON on stdin. */
  readonly runTick: (command: string, input: string, timeoutMs: number) => TickRun;
  /** End the CLEO session, as the Stop hook always did. */
  readonly endSession: () => void;
}

/** The goal runtime's verdict on one stop. */
export type TickDecision =
  | { readonly kind: 'block'; readonly answer: string }
  | { readonly kind: 'hold' }
  | { readonly kind: 'final' };

/**
 * Read a tick's result. Only a clean exit with a JSON object counts; every
 * other outcome is `final`, so a missing or broken goal runtime ends the
 * session as before.
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
  if (answer.decision === 'block' && typeof answer.reason === 'string')
    return { kind: 'block', answer: `${text}\n` };
  return answer.final === false ? { kind: 'hold' } : { kind: 'final' };
}

/**
 * Dispatch one Stop: the goal runtime first, the session end only when the
 * goal says the turn is final or no goal is live.
 *
 * @param stdin - The harness's Stop JSON.
 * @param env - Environment (`CLEO_GOAL_TICK*`).
 * @param deps - Tick runner and session end.
 * @returns What to print to the harness and whether the session ended.
 */
export function stopDispatch(
  stdin: string,
  env: Readonly<Record<string, string | undefined>>,
  deps: StopDispatchDeps,
): { readonly stdout: string; readonly sessionEnded: boolean } {
  const decision: TickDecision =
    env.CLEO_GOAL_TICK?.trim().toLowerCase() === 'off'
      ? { kind: 'final' }
      : parseTick(
          deps.runTick(
            env.CLEO_GOAL_TICK_COMMAND?.trim() || DEFAULT_GOAL_TICK_COMMAND,
            stdin,
            Number(env.CLEO_GOAL_TICK_TIMEOUT_MS) || DEFAULT_TICK_TIMEOUT_MS,
          ),
        );
  if (decision.kind === 'block') return { stdout: decision.answer, sessionEnded: false };
  if (decision.kind === 'hold') return { stdout: '', sessionEnded: false };
  deps.endSession();
  return { stdout: '', sessionEnded: true };
}

/**
 * The real side effects: the tick through the shell (the command is the
 * project's own configuration), and `cleo session end --quiet` through the
 * running CLI, its envelope kept off the harness's stdout.
 *
 * @returns The default {@link StopDispatchDeps}.
 */
export function processStopDispatchDeps(): StopDispatchDeps {
  return {
    runTick: (command, input, timeoutMs) => {
      const r = spawnSync(command, {
        shell: true,
        input,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
    },
    endSession: () => {
      const cli = process.argv[1];
      spawnSync(
        cli ? process.execPath : 'cleo',
        [...(cli ? [cli] : []), 'session', 'end', '--quiet'],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
    },
  };
}
