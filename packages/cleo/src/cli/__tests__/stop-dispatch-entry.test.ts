/**
 * The one Stop dispatcher (T13796): a live goal blocks with its continuation
 * and the session stays open; with no goal the session ends as today; a
 * missing or failing tick command fails open to the session end.
 *
 * @task T13796
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GOAL_TICK_COMMAND,
  processStopDispatchDeps,
  type StopDispatchDeps,
  stopDispatch,
  type TickRun,
} from '../stop-dispatch-entry.js';

const STOP = JSON.stringify({ session_id: 's', stop_hook_active: false });

function deps(run: TickRun | (() => TickRun)) {
  const endSession = vi.fn();
  const runTick = vi.fn(typeof run === 'function' ? run : () => run);
  return { endSession, runTick, deps: { runTick, endSession } satisfies StopDispatchDeps };
}

describe('stopDispatch (T13796)', () => {
  it('a live goal blocks with its continuation verbatim; the session stays open', () => {
    const block = '{"decision":"block","reason":"C2 is not proven yet: keep going"}';
    const d = deps({ status: 0, stdout: `${block}\n` });
    const r = stopDispatch(STOP, {}, d.deps);
    expect(r).toEqual({ stdout: `${block}\n`, sessionEnded: false });
    expect(d.endSession).not.toHaveBeenCalled();
    // The goal runtime got the harness's Stop JSON, with the default command.
    expect(d.runTick).toHaveBeenCalledWith(DEFAULT_GOAL_TICK_COMMAND, STOP, expect.any(Number));
  });

  it('a live goal that is not final but does not continue keeps the session open', () => {
    const d = deps({ status: 0, stdout: '{"final":false}' });
    expect(stopDispatch(STOP, {}, d.deps)).toEqual({ stdout: '', sessionEnded: false });
    expect(d.endSession).not.toHaveBeenCalled();
  });

  it.each([
    ['no live goal (empty answer)', { status: 0, stdout: '' }],
    ['the goal says the turn is final', { status: 0, stdout: '{"final":true}' }],
    ['no goal runtime installed (exit 127)', { status: 127, stdout: '' }],
    ['the tick fails', { status: 1, stdout: '{"decision":"block","reason":"x"}' }],
    ['the tick times out or is killed', { status: null, stdout: '' }],
    ['the tick prints something that is not JSON', { status: 0, stdout: 'hello' }],
    ['a block with no reason', { status: 0, stdout: '{"decision":"block"}' }],
  ])('%s: the session ends exactly as today', (_why, run) => {
    const d = deps(run);
    expect(stopDispatch(STOP, {}, d.deps)).toEqual({ stdout: '', sessionEnded: true });
    expect(d.endSession).toHaveBeenCalledTimes(1);
  });

  it('CLEO_GOAL_TICK=off skips the tick; CLEO_GOAL_TICK_COMMAND overrides it', () => {
    const off = deps({ status: 0, stdout: '{"decision":"block","reason":"x"}' });
    expect(stopDispatch(STOP, { CLEO_GOAL_TICK: 'off' }, off.deps).sessionEnded).toBe(true);
    expect(off.runTick).not.toHaveBeenCalled();
    const custom = deps({ status: 0, stdout: '' });
    stopDispatch(
      STOP,
      { CLEO_GOAL_TICK_COMMAND: 'my-goal tick', CLEO_GOAL_TICK_TIMEOUT_MS: '500' },
      custom.deps,
    );
    expect(custom.runTick).toHaveBeenCalledWith('my-goal tick', STOP, 500);
  });

  it('a real missing tick command fails open, and a real tick answers on stdout', () => {
    const real = processStopDispatchDeps();
    const endSession = vi.fn();
    const missing = stopDispatch(
      STOP,
      { CLEO_GOAL_TICK_COMMAND: 'cleo-no-such-goal-runtime-t13796 tick' },
      { runTick: real.runTick, endSession },
    );
    expect(missing.sessionEnded).toBe(true);
    // The tick reads the Stop JSON on stdin and answers with a block.
    const echo = `node -e "process.stdin.on('data',d=>{const s=JSON.parse(d);process.stdout.write(JSON.stringify({decision:'block',reason:'goal for '+s.session_id}))})"`;
    const live = stopDispatch(
      STOP,
      { CLEO_GOAL_TICK_COMMAND: echo },
      { runTick: real.runTick, endSession },
    );
    expect(live).toEqual({
      stdout: '{"decision":"block","reason":"goal for s"}\n',
      sessionEnded: false,
    });
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});
