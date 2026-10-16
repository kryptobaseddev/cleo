/**
 * `cleo hook stop --provider <p>`: the one Stop dispatcher (T13796).
 *
 * A goal runtime (OpenCode-Goal's `ocg tick`) and CLEO's `cleo session end`
 * both want the Stop event; as two hooks they fight (the session ends while
 * the goal keeps the turn going). This dispatcher owns the event, in order
 * goal tick → ask-enforce → session end:
 *
 * 1. When a goal workspace exists (`.opencode/goals/` at or above the project),
 *    run the tick command (`CLEO_GOAL_TICK_COMMAND`, default `ocg tick`) with
 *    the harness's Stop JSON on stdin. With no workspace there is no tick: the
 *    no-goal path costs nothing, and an unrelated `ocg` on PATH never sees
 *    Stop JSON. The tick MUST write only JSON to stdout.
 * 2. `{"decision":"block","reason":…}` on its stdout: a live goal continues the
 *    turn. CLEO re-serialises exactly `{decision, reason}` (reason capped at
 *    {@link MAX_REASON_CHARS}), so a tick can never inject other hook fields
 *    (`continue`, `stopReason`, `systemMessage`, `hookSpecificOutput`). The
 *    session stays open.
 * 3. `{"final":false}`: a live goal that is not finished but does not
 *    continue the turn (paused, waiting on the owner). The session stays open.
 * 4. Otherwise ask-enforce (T13420) judges the turn. Its block wins next and
 *    the session is NOT ended, since the agent still owes the owner an ask; a
 *    `warn` answer is forwarded and the session still ends.
 * 5. Otherwise the session ends exactly as before, for a provider whose Stop
 *    ended it ({@link PROVIDER_ENDS_SESSION}: Claude Code yes, Codex never). A tick that is missing
 *    (exit 127), fails, times out or prints non-JSON counts as no goal, and an
 *    ask-enforce step that throws counts as no block: every step fails open to
 *    today's behaviour, never trapping a session.
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

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { HookJsonValue } from '@cleocode/contracts';

/** Harnesses `cleo hook stop` dispatches for. */
export const STOP_DISPATCH_PROVIDERS = ['claude-code', 'codex'] as const;

/** One of {@link STOP_DISPATCH_PROVIDERS}. */
export type StopDispatchProvider = (typeof STOP_DISPATCH_PROVIDERS)[number];

/**
 * Whether a provider's Stop ends the CLEO session, as its Stop hook did before
 * the dispatcher: Claude Code's always ran `cleo session end`; Codex's never
 * did, and its Stop fires every turn, so ending the session there would
 * unbind a Codex session mid-work.
 */
export const PROVIDER_ENDS_SESSION: Readonly<Record<StopDispatchProvider, boolean>> = {
  'claude-code': true,
  codex: false,
};

/** The goal runtime's tick when `CLEO_GOAL_TICK_COMMAND` is unset. */
export const DEFAULT_GOAL_TICK_COMMAND = 'ocg tick';

/** Deadline for one tick when `CLEO_GOAL_TICK_TIMEOUT_MS` is unset. */
const DEFAULT_TICK_TIMEOUT_MS = 30_000;

/** Longest tick deadline, kept well under the Stop hook's harness timeout (120 s). */
export const MAX_TICK_TIMEOUT_MS = 60_000;

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
  /** Whether a goal workspace exists for this Stop (no workspace, no tick). */
  readonly hasGoalWorkspace: (input: string) => boolean;
  /** Run the tick command with the Stop JSON on stdin, killed at the deadline. */
  readonly runTick: (command: string, input: string, timeoutMs: number) => Promise<TickRun>;
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
  // Only {decision, reason} reaches the harness; every other field the tick wrote is dropped.
  if (answer.decision === 'block' && typeof answer.reason === 'string') {
    const reason = answer.reason.slice(0, MAX_REASON_CHARS);
    return { kind: 'block', answer: `${JSON.stringify({ decision: 'block', reason })}\n` };
  }
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
 * @param endsSession - Whether this provider's Stop ends the session ({@link PROVIDER_ENDS_SESSION}).
 * @returns What to print to the harness and whether the session ended.
 */
export async function stopDispatch(
  stdin: string,
  env: Readonly<Record<string, string | undefined>>,
  deps: StopDispatchDeps,
  endsSession = true,
): Promise<{ readonly stdout: string; readonly sessionEnded: boolean }> {
  const timeout = Math.min(
    Number(env.CLEO_GOAL_TICK_TIMEOUT_MS) || DEFAULT_TICK_TIMEOUT_MS,
    MAX_TICK_TIMEOUT_MS,
  );
  const decision: TickDecision =
    env.CLEO_GOAL_TICK?.trim().toLowerCase() === 'off' || !deps.hasGoalWorkspace(stdin)
      ? { kind: 'final' }
      : parseTick(
          await deps.runTick(
            env.CLEO_GOAL_TICK_COMMAND?.trim() || DEFAULT_GOAL_TICK_COMMAND,
            stdin,
            timeout,
          ),
        );
  if (decision.kind === 'block') return { stdout: decision.answer, sessionEnded: false };
  if (decision.kind === 'hold') return { stdout: '', sessionEnded: false };
  const asked = await deps.askEnforce(stdin).catch(() => '');
  if ((asked !== '' && isBlock(asked)) || !endsSession)
    return { stdout: asked, sessionEnded: false };
  deps.endSession();
  return { stdout: asked, sessionEnded: true };
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
      if (await askEnforceOptedOut(env, process.cwd())) return '';
      const entry = await import('./ask-enforce-entry.js');
      const lookup = await entry.caampAskToolLookup();
      const answer = await entry.askEnforceHook(provider, input, env, lookup);
      return answer.stdout;
    },
    hasGoalWorkspace: (input) => hasGoalWorkspace(input, env),
    runTick: runTickKillable,
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

/**
 * Whether `.opencode/goals/` exists at or above the Stop's project: the harness
 * project directory (`CLAUDE_PROJECT_DIR`), else the payload's `cwd`, else the
 * process's.
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
 * @returns What the tick did.
 */
export function runTickKillable(
  command: string,
  input: string,
  timeoutMs: number,
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
