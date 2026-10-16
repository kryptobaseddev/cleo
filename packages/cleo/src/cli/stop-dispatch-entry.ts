/**
 * `cleo hook stop --provider <p>`: the one Stop dispatcher (T13796).
 *
 * A goal runtime (OpenCode-Goal's `ocg tick`) and CLEO's `cleo session end`
 * both want the Stop event; as two hooks they fight (the session ends while
 * the goal keeps the turn going). This dispatcher owns the event, in order
 * goal tick → ask-enforce → session end:
 *
 * 1. Run the tick command (`CLEO_GOAL_TICK_COMMAND`, default `ocg tick`) with
 *    the harness's Stop JSON on stdin.
 * 2. `{"decision":"block","reason":…}` on its stdout: a live goal continues the
 *    turn. The answer goes to the harness verbatim and the session stays open.
 * 3. `{"final":false}`: a live goal that is not finished but does not
 *    continue the turn (paused, waiting on the owner). The session stays open.
 * 4. Otherwise ask-enforce (T13420) judges the turn. Its block wins next and
 *    the session is NOT ended, since the agent still owes the owner an ask; a
 *    `warn` answer is forwarded and the session still ends.
 * 5. Otherwise the session ends exactly as before. A tick that is missing
 *    (exit 127), fails, times out or prints non-JSON counts as no goal, and an
 *    ask-enforce step that throws counts as no block: every step fails open to
 *    today's behaviour, never trapping a session.
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
  /** The ask-enforce hook's stdout for this Stop (empty when it does not answer). */
  readonly askEnforce: (input: string) => Promise<string>;
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

/** Whether a hook answer is a `{"decision":"block"}` (Claude Code and Codex). */
function isBlock(stdout: string): boolean {
  try {
    const answer = JSON.parse(stdout) as HookJsonValue;
    return isRecord(answer) && answer.decision === 'block';
  } catch {
    return false;
  }
}

/**
 * Dispatch one Stop: the goal runtime first, then ask-enforce, and the session
 * end only when neither keeps the turn going.
 *
 * @param stdin - The harness's Stop JSON.
 * @param env - Environment (`CLEO_GOAL_TICK*`; ask-enforce reads `CLEO_ASK_ENFORCE`).
 * @param deps - Tick runner, ask-enforce and session end.
 * @returns What to print to the harness and whether the session ended.
 */
export async function stopDispatch(
  stdin: string,
  env: Readonly<Record<string, string | undefined>>,
  deps: StopDispatchDeps,
): Promise<{ readonly stdout: string; readonly sessionEnded: boolean }> {
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
  const asked = await deps.askEnforce(stdin).catch(() => '');
  if (asked !== '' && isBlock(asked)) return { stdout: asked, sessionEnded: false };
  deps.endSession();
  return { stdout: asked, sessionEnded: true };
}

/**
 * The real side effects: the tick through the shell (the command is the
 * project's own configuration), ask-enforce in-process, and
 * `cleo session end --quiet` through the running CLI, its envelope kept off
 * the harness's stdout.
 *
 * @param provider - Harness protocol ask-enforce answers in.
 * @param env - Environment ask-enforce reads.
 * @returns The default {@link StopDispatchDeps}.
 */
export function processStopDispatchDeps(
  provider: StopDispatchProvider,
  env: Readonly<Record<string, string | undefined>>,
): StopDispatchDeps {
  return {
    askEnforce: async (input) => {
      const entry = await import('./ask-enforce-entry.js');
      const answer = await entry.askEnforceHook(
        provider,
        input,
        env,
        await entry.caampAskToolLookup(),
      );
      return answer.stdout;
    },
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
