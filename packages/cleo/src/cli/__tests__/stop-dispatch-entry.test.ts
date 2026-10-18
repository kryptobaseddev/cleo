/**
 * The one Stop dispatcher (T13796), in order goal tick → ask-enforce →
 * session end: a live goal's block wins and skips the rest; an ask-enforce
 * block wins next and keeps the session open; otherwise the session ends as
 * today. Every step fails open.
 *
 * @task T13796
 */

import { GOAL_TICK_PROVIDER_ENV } from '@cleocode/contracts/goal-runtime.js';
import { describe, expect, it, vi } from 'vitest';
import {
  ASK_ENFORCE_DEADLINE_MS,
  askEnforceOptedOut,
  hasGoalWorkspace,
  MAX_REASON_CHARS,
  MAX_TICK_TIMEOUT_MS,
  PROVIDER_ENDS_SESSION,
  processStopDispatchDeps,
  runTickKillable,
  type StopDispatchDeps,
  stopDispatch,
  type TickRun,
} from '../stop-dispatch-entry.js';

const STOP = JSON.stringify({ session_id: 's', stop_hook_active: false });
const ASK_BLOCK = '{"decision":"block","reason":"Re-ask the owner with your ask tool"}\n';

/** The tick command for the default resolved CLEO Goal in these tests. */
const TICK = '/opt/bin/cleo-goal tick';

function deps(
  run: TickRun,
  ask: () => Promise<string> = async () => '',
  workspace = true,
  tick: string | null = TICK,
) {
  const endSession = vi.fn();
  const runTick = vi.fn(async () => run);
  const askEnforce = vi.fn(ask);
  const hasGoalWorkspace = vi.fn(() => workspace);
  const goalTick = vi.fn(async () => tick);
  return {
    endSession,
    runTick,
    askEnforce,
    goalTick,
    deps: {
      goalTick,
      hasGoalWorkspace,
      runTick,
      askEnforce,
      endSession,
    } satisfies StopDispatchDeps,
  };
}

describe('stopDispatch (T13796)', () => {
  it('a live goal blocks with its continuation; ask-enforce and session end are skipped', async () => {
    const block = '{"decision":"block","reason":"C2 is not proven yet: keep going"}';
    const d = deps({ status: 0, stdout: `${block}\n` }, async () => ASK_BLOCK);
    expect(await stopDispatch(STOP, {}, d.deps)).toEqual({
      stdout: `${block}\n`,
      sessionEnded: false,
    });
    expect(d.askEnforce).not.toHaveBeenCalled();
    expect(d.endSession).not.toHaveBeenCalled();
    expect(d.runTick).toHaveBeenCalledWith(TICK, STOP, expect.any(Number));
  });

  it('a live goal that is not final but does not continue keeps the session open', async () => {
    const d = deps({ status: 0, stdout: '{"final":false}' });
    expect(await stopDispatch(STOP, {}, d.deps)).toEqual({ stdout: '', sessionEnded: false });
    expect(d.endSession).not.toHaveBeenCalled();
  });

  it('with no goal, an ask-enforce block wins and the session is not ended', async () => {
    const d = deps({ status: 127, stdout: '' }, async () => ASK_BLOCK);
    expect(await stopDispatch(STOP, {}, d.deps)).toEqual({
      stdout: ASK_BLOCK,
      sessionEnded: false,
    });
    expect(d.askEnforce).toHaveBeenCalledWith(STOP);
    expect(d.endSession).not.toHaveBeenCalled();
  });

  it('an ask-enforce warning is forwarded and the session still ends', async () => {
    const warn = '{"systemMessage":"you asked in prose"}\n';
    const d = deps({ status: 0, stdout: '' }, async () => warn);
    expect(await stopDispatch(STOP, {}, d.deps)).toEqual({ stdout: warn, sessionEnded: true });
    expect(d.endSession).toHaveBeenCalledTimes(1);
  });

  it('an ask-enforce step that throws fails open to the session end', async () => {
    const d = deps({ status: 0, stdout: '' }, async () => {
      throw new Error('classifier missing');
    });
    expect(await stopDispatch(STOP, {}, d.deps)).toEqual({ stdout: '', sessionEnded: true });
  });

  it.each([
    ['no live goal (empty answer)', { status: 0, stdout: '' }],
    ['the goal says the turn is final', { status: 0, stdout: '{"final":true}' }],
    ['no goal runtime installed (exit 127)', { status: 127, stdout: '' }],
    ['the tick fails', { status: 1, stdout: '{"decision":"block","reason":"x"}' }],
    ['the tick times out or is killed', { status: null, stdout: '' }],
    ['the tick prints something that is not JSON', { status: 0, stdout: 'hello' }],
    ['a block with no reason', { status: 0, stdout: '{"decision":"block"}' }],
  ])('%s: the session ends exactly as today', async (_why, run) => {
    const d = deps(run);
    expect(await stopDispatch(STOP, {}, d.deps)).toEqual({ stdout: '', sessionEnded: true });
    expect(d.endSession).toHaveBeenCalledTimes(1);
  });

  it('Codex Stop never ends the session; Claude Code Stop does, as before', async () => {
    expect(PROVIDER_ENDS_SESSION).toEqual({ 'claude-code': true, codex: false });
    const warn = '{"systemMessage":"you asked in prose"}\n';
    for (const run of [
      { status: 0, stdout: '' },
      { status: 127, stdout: '' },
      { status: 0, stdout: '{"final":true}' },
    ]) {
      const codex = deps(run, async () => warn);
      expect(await stopDispatch(STOP, {}, codex.deps, PROVIDER_ENDS_SESSION.codex)).toEqual({
        stdout: warn,
        sessionEnded: false,
      });
      expect(codex.endSession).not.toHaveBeenCalled();
    }
    // Codex still gets the goal and ask-enforce steps.
    const ask = deps({ status: 0, stdout: '' }, async () => ASK_BLOCK);
    expect((await stopDispatch(STOP, {}, ask.deps, false)).stdout).toBe(ASK_BLOCK);
    const claude = deps({ status: 0, stdout: '' });
    expect(
      (await stopDispatch(STOP, {}, claude.deps, PROVIDER_ENDS_SESSION['claude-code']))
        .sessionEnded,
    ).toBe(true);
  });

  it('keeps the ask-enforce opt-out: heavy-command mode off (env or config) skips it', async () => {
    const config = (mode: string | undefined) => async () => mode;
    expect(
      await askEnforceOptedOut({ CLEO_HEAVY_COMMAND_HOOK: 'off' }, '/tmp', config('rewrite')),
    ).toBe(true);
    expect(await askEnforceOptedOut({}, '/tmp', config('off'))).toBe(true);
    // The environment wins over the config, as for the heavy-command hook itself.
    expect(
      await askEnforceOptedOut({ CLEO_HEAVY_COMMAND_HOOK: 'warn' }, '/tmp', config('off')),
    ).toBe(false);
    expect(await askEnforceOptedOut({}, '/tmp', config(undefined))).toBe(false);
    // Through the real deps: an opted-out project gets no ask-enforce answer at all.
    const real = processStopDispatchDeps('claude-code', { CLEO_HEAVY_COMMAND_HOOK: 'off' });
    const prose = JSON.stringify({
      session_id: 's',
      stop_hook_active: false,
      last_assistant_message: 'Which option do you want, A or B?',
    });
    expect(await real.askEnforce(prose)).toBe('');
    // Without the opt-out the same turn is blocked, so the empty answer above is the opt-out.
    const optedIn = processStopDispatchDeps('claude-code', { CLEO_HEAVY_COMMAND_HOOK: 'rewrite' });
    expect(await optedIn.askEnforce(prose)).toContain('"decision":"block"');
  });

  it('CLEO_GOAL_TICK=off skips the tick; CLEO_GOAL_TICK_COMMAND overrides it', async () => {
    const off = deps({ status: 0, stdout: '{"decision":"block","reason":"x"}' });
    expect((await stopDispatch(STOP, { CLEO_GOAL_TICK: 'off' }, off.deps)).sessionEnded).toBe(true);
    expect(off.runTick).not.toHaveBeenCalled();
    const custom = deps({ status: 0, stdout: '' });
    await stopDispatch(
      STOP,
      { CLEO_GOAL_TICK_COMMAND: 'my-goal tick', CLEO_GOAL_TICK_TIMEOUT_MS: '500' },
      custom.deps,
    );
    expect(custom.runTick).toHaveBeenCalledWith('my-goal tick', STOP, 500);
  });

  it('real processes: a missing tick fails open, a real tick answers, ask-enforce off stays silent', async () => {
    const env = { CLEO_ASK_ENFORCE: 'off' };
    const real = processStopDispatchDeps('claude-code', env);
    const endSession = vi.fn();
    const live = {
      goalTick: async () => null,
      hasGoalWorkspace: () => true,
      runTick: real.runTick,
      askEnforce: real.askEnforce,
      endSession,
    };
    const missing = await stopDispatch(
      STOP,
      { ...env, CLEO_GOAL_TICK_COMMAND: 'cleo-no-such-goal-runtime-t13796 tick' },
      live,
    );
    expect(missing).toEqual({ stdout: '', sessionEnded: true });
    const echo = `node -e "process.stdin.on('data',d=>{const s=JSON.parse(d);process.stdout.write(JSON.stringify({decision:'block',reason:'goal for '+s.session_id}))})"`;
    expect(await stopDispatch(STOP, { ...env, CLEO_GOAL_TICK_COMMAND: echo }, live)).toEqual({
      stdout: '{"decision":"block","reason":"goal for s"}\n',
      sessionEnded: false,
    });
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it('forwards only {decision, reason}: a tick cannot inject other hook fields; reason is capped', async () => {
    const injected = JSON.stringify({
      decision: 'block',
      reason: 'x'.repeat(MAX_REASON_CHARS + 50),
      continue: false,
      stopReason: 'pwned',
      systemMessage: 'pwned',
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'pwned' },
    });
    const d = deps({ status: 0, stdout: injected });
    const r = await stopDispatch(STOP, {}, d.deps);
    expect(r.sessionEnded).toBe(false);
    expect(JSON.parse(r.stdout)).toEqual({
      decision: 'block',
      reason: 'x'.repeat(MAX_REASON_CHARS),
    });
    expect(r.stdout).not.toContain('pwned');
  });

  it('the tick child sees CLEO_HOOK_PROVIDER set to the dispatching harness (T13884)', async () => {
    const echo = `node -e "process.stdout.write(JSON.stringify({p: process.env.${GOAL_TICK_PROVIDER_ENV}, h: process.env.HOME ?? null}))"`;
    for (const provider of ['claude-code', 'codex'] as const) {
      const run = await runTickKillable(echo, STOP, 5000, provider);
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ p: provider, h: process.env.HOME ?? null });
    }
  });

  it('returns within the deadline when the tick forks a grandchild that escapes the group and holds stdout (T13890)', async () => {
    const marker = `cleo-t13890-${process.pid}-${Date.now()}`;
    // The grandchild calls setsid (detached), so the group SIGKILL cannot reach it,
    // and it inherits the tick's stdout, so that pipe never reaches EOF on its own.
    const tick = `node -e "require('child_process').spawn('node',['-e','setTimeout(()=>{},30000)','${marker}'],{detached:true,stdio:['ignore','inherit','ignore']}).unref();setInterval(()=>{},1000)"`;
    const real = processStopDispatchDeps('codex', { CLEO_ASK_ENFORCE: 'off' });
    const endSession = vi.fn();
    const started = Date.now();
    try {
      const r = await stopDispatch(
        STOP,
        { CLEO_ASK_ENFORCE: 'off', CLEO_GOAL_TICK_COMMAND: tick, CLEO_GOAL_TICK_TIMEOUT_MS: '800' },
        { ...real, hasGoalWorkspace: () => true, endSession },
        true,
      );
      expect(r).toEqual({ stdout: '', sessionEnded: true });
      expect(Date.now() - started).toBeLessThan(800 + 5000);
      expect(endSession).toHaveBeenCalledTimes(1);
    } finally {
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('pkill', ['-f', marker]);
      } catch {
        // Already gone.
      }
    }
  });

  it('a hung ask-enforce cannot hold the stop past its own deadline (T13890)', async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ status: 127, stdout: '' }, () => new Promise<string>(() => {}));
      const pending = stopDispatch(STOP, {}, d.deps);
      await vi.advanceTimersByTimeAsync(ASK_ENFORCE_DEADLINE_MS);
      expect(await pending).toEqual({ stdout: '', sessionEnded: true });
      expect(d.endSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tick that traps SIGTERM is SIGKILLed with its group at the deadline, and fails open', async () => {
    const marker = `cleo-t13796-${process.pid}-${Date.now()}`;
    const trap = `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" ${marker}-trap`;
    const started = Date.now();
    const run = await runTickKillable(trap, STOP, 500);
    expect(run.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
    // A grandchild left behind in the group is reaped too.
    await runTickKillable(`(sleep 30 # ${marker}-grandchild\n) & sleep 30`, STOP, 300);
    await new Promise((r) => setTimeout(r, 300));
    const { execFileSync } = await import('node:child_process');
    const left = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(marker) && !l.includes('ps -axo'));
    // Neither the SIGTERM-trapping tick nor the grandchild survives the deadline.
    expect(left).toEqual([]);
    // And the dispatcher ends the session as before; the deadline is capped.
    const endSession = vi.fn();
    const ended = await stopDispatch(
      STOP,
      { CLEO_GOAL_TICK_COMMAND: trap, CLEO_GOAL_TICK_TIMEOUT_MS: '400', CLEO_ASK_ENFORCE: 'off' },
      {
        goalTick: async () => null,
        hasGoalWorkspace: () => true,
        runTick: runTickKillable,
        askEnforce: async () => '',
        endSession,
      },
    );
    expect(ended.sessionEnded).toBe(true);
    const capped = deps({ status: 0, stdout: '' });
    await stopDispatch(STOP, { CLEO_GOAL_TICK_TIMEOUT_MS: '999999' }, capped.deps);
    expect(capped.runTick).toHaveBeenCalledWith(TICK, STOP, MAX_TICK_TIMEOUT_MS);
  });

  it('with no goal workspace there is no tick at all', async () => {
    const d = deps(
      { status: 0, stdout: '{"decision":"block","reason":"x"}' },
      async () => '',
      false,
    );
    expect(await stopDispatch(STOP, {}, d.deps)).toEqual({ stdout: '', sessionEnded: true });
    expect(d.runTick).not.toHaveBeenCalled();
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'cleo-goal-ws-'));
    try {
      const sub = join(root, 'pkg', 'src');
      mkdirSync(sub, { recursive: true });
      expect(hasGoalWorkspace(JSON.stringify({ cwd: sub }), {})).toBe(false);
      mkdirSync(join(root, '.opencode', 'goals'), { recursive: true });
      expect(hasGoalWorkspace(JSON.stringify({ cwd: sub }), {})).toBe(true);
      expect(hasGoalWorkspace('{}', { CLAUDE_PROJECT_DIR: root })).toBe(true);
      // A goals folder ABOVE the repository root does not count.
      const repo = join(root, 'repo');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, 'pkg'), { recursive: true });
      expect(hasGoalWorkspace(JSON.stringify({ cwd: join(repo, 'pkg') }), {})).toBe(false);
      // A CLEO project root bounds it too; goals at that root still count (monorepo).
      const cleoRepo = join(root, 'cleo-repo');
      mkdirSync(join(cleoRepo, '.cleo'), { recursive: true });
      expect(hasGoalWorkspace('{}', { CLAUDE_PROJECT_DIR: cleoRepo })).toBe(false);
      mkdirSync(join(repo, '.opencode', 'goals'), { recursive: true });
      expect(hasGoalWorkspace(JSON.stringify({ cwd: join(repo, 'pkg') }), {})).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ticks the resolved CLEO Goal bin (cleo-goal, then ocg); no bin means no tick', async () => {
    const found = deps({ status: 0, stdout: '' });
    await stopDispatch(STOP, {}, found.deps);
    expect(found.runTick).toHaveBeenCalledWith(TICK, STOP, expect.any(Number));
    const missing = deps(
      { status: 0, stdout: '{"decision":"block","reason":"x"}' },
      async () => '',
      true,
      null,
    );
    expect(await stopDispatch(STOP, {}, missing.deps)).toEqual({ stdout: '', sessionEnded: true });
    expect(missing.runTick).not.toHaveBeenCalled();
    // An explicit CLEO_GOAL_TICK_COMMAND needs no bin.
    const custom = deps({ status: 0, stdout: '' }, async () => '', true, null);
    await stopDispatch(STOP, { CLEO_GOAL_TICK_COMMAND: 'my-goal tick' }, custom.deps);
    expect(custom.runTick).toHaveBeenCalledWith('my-goal tick', STOP, expect.any(Number));
    expect(custom.goalTick).not.toHaveBeenCalled();
  });
});
