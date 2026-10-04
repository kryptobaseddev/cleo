/**
 * T13124 acceptance: a sandboxed project with the heavy-command hook installed
 * routes `pnpm test`, `vitest` and `tsc` through `cleo run` admission, and
 * concurrent agent-style runs never hold more than the slot budget.
 *
 * End to end, as an agent harness would drive it:
 *
 * 1. `cleo upgrade`'s delivery step (core `deliverHeavyCommandHooks`, which
 *    loads `@cleocode/adapters` at run time) installs the hook into the
 *    project's `.claude/settings.local.json`.
 * 2. The INSTALLED hook command line runs under `/bin/sh -c` with a Claude
 *    Code `PreToolUse` payload, as Claude Code runs it: once in
 *    `bypassPermissions` mode, and once in `default` mode with allow rules
 *    for the commands (the T13124 pre-approval path, `permissionDecision:
 *    "allow"`).
 * 3. The rewritten command lines run concurrently through the compiled CLI.
 *    `pnpm`, `vitest` and `tsc` are fake tools on PATH that record how many
 *    of their class are running at once.
 *
 * The bound is the governor's own budget for each class, computed before and
 * after the runs (it depends on free memory). Each class gets one more
 * concurrent run than its budget (at least three), so admission has to hold
 * some back; a `cleo run` that admitted everything fails the test.
 *
 * Needs the compiled CLI (skipped without a build). HOME, CLEO_HOME, TMPDIR
 * and the project are temp directories; nothing outside them is written.
 *
 * @task T13124
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeClassBudget } from '@cleocode/core/resources/governor.js';
import { deliverHeavyCommandHooks } from '@cleocode/core/resources/heavy-command-hook-delivery.js';
import { defaultResourceBackend } from '@cleocode/core/resources/monitor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
/** Needs the compiled CLI: skipped without a build. */
const live = existsSync(CLI_DIST) ? it : it.skip;

let dir: string;
let project: string;
let bin: string;
const children: ChildProcess[] = [];

/** A fake heavy tool: records how many of its class run at once, then sleeps. */
function fakeTool(name: string, runningVar: string): void {
  writeFileSync(
    join(bin, name),
    [
      '#!/bin/sh',
      `r="$${runningVar}"`,
      'mkdir "$r/$$"',
      'ls "$r" | wc -l | tr -d " " >> "$r.log"',
      'sleep 2',
      'rmdir "$r/$$"',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, name), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-heavy-admission-'));
  project = join(dir, 'project');
  bin = join(dir, 'bin');
  for (const d of [
    project,
    join(project, '.claude'),
    bin,
    join(dir, 'home'),
    join(dir, 'cleo-home'),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  for (const d of ['running-test', 'running-build']) mkdirSync(join(dir, d));
  writeFileSync(join(bin, 'cleo'), `#!/bin/sh\nexec '${process.execPath}' '${CLI_DIST}' "$@"\n`);
  chmodSync(join(bin, 'cleo'), 0o755);
  fakeTool('pnpm', 'RUNNING_TEST');
  fakeTool('vitest', 'RUNNING_TEST');
  fakeTool('tsc', 'RUNNING_BUILD');
});

afterEach(async () => {
  await Promise.all(
    children
      .filter((c) => c.exitCode === null && c.signalCode === null)
      .map((c) => new Promise((done) => c.once('exit', done))),
  );
  children.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: join(dir, 'home'),
    CLEO_HOME: join(dir, 'cleo-home'),
    TMPDIR: dir,
    CLAUDE_PROJECT_DIR: project,
    RUNNING_TEST: join(dir, 'running-test'),
    RUNNING_BUILD: join(dir, 'running-build'),
  };
}

/** The hook command line the delivery wrote into settings.local.json. */
function installedHookCommand(): string {
  const settings = JSON.parse(
    readFileSync(join(project, '.claude', 'settings.local.json'), 'utf-8'),
  ) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
  const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command;
  if (command === undefined) throw new Error('no hook installed');
  return command;
}

/** Run the installed hook as Claude Code does; returns its PreToolUse answer. */
function askHook(
  hookCommand: string,
  command: string,
  permissionMode: string,
): { updatedInput?: { command: string }; permissionDecision?: string } {
  const stdout = execFileSync('/bin/sh', ['-c', hookCommand], {
    cwd: project,
    env: env(),
    encoding: 'utf-8',
    timeout: 60_000,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, description: 'agent run' },
      cwd: project,
      permission_mode: permissionMode,
    }),
  });
  return (JSON.parse(stdout) as { hookSpecificOutput: object }).hookSpecificOutput;
}

/** Run one shell command line in the project; resolves with its exit code. */
function runLine(line: string): Promise<number | null> {
  const child = spawn('/bin/sh', ['-c', line], { cwd: project, env: env(), stdio: 'ignore' });
  children.push(child);
  return new Promise((done) => child.once('exit', (code) => done(code)));
}

/** The most runs of one class the fake tools saw at once, and how many ran. */
function observed(running: string): { readonly max: number; readonly runs: number } {
  const log = join(dir, `${running}.log`);
  const counts = existsSync(log)
    ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map(Number)
    : [];
  return { max: Math.max(0, ...counts), runs: counts.length };
}

async function budgets(): Promise<{ readonly test: number; readonly build: number }> {
  const sample = await defaultResourceBackend().sample();
  return {
    test: computeClassBudget('test-run', sample),
    build: computeClassBudget('scoped-build', sample),
  };
}

describe('heavy-command hook admission end to end (T13124 AC1)', () => {
  live(
    'routes pnpm test, vitest and tsc through cleo run; concurrent runs never exceed the slot budget',
    async () => {
      // 1. Install through the init/upgrade delivery step.
      const { outcomes } = await deliverHeavyCommandHooks(project, {
        env: { HOME: join(dir, 'home'), PATH: bin },
        providers: ['claude-code'],
      });
      expect(outcomes).toEqual([
        expect.objectContaining({ provider: 'claude-code', status: 'installed' }),
      ]);
      const hook = installedHookCommand();

      // 2a. bypassPermissions: every heavy command is rewritten.
      const govern = (command: string): string => {
        const answer = askHook(hook, command, 'bypassPermissions');
        expect(answer.updatedInput?.command, command).toMatch(
          /^cleo run --wait --passthrough --timeout \d+ --class (test|build) -- /,
        );
        return answer.updatedInput?.command ?? '';
      };
      const pnpmTest = govern('pnpm test');
      const vitest = govern('vitest run a.test.ts');
      const tsc = govern('tsc --noEmit -p a');

      // 2b. default mode with allow rules: rewritten AND pre-approved.
      const settingsPath = join(project, '.claude', 'settings.local.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, object>;
      writeFileSync(
        settingsPath,
        JSON.stringify({
          ...settings,
          permissions: { allow: ['Bash(pnpm test:*)', 'Bash(vitest run *)', 'Bash(tsc *)'] },
        }),
      );
      const approved = askHook(hook, 'pnpm test 2>&1 | tail -20', 'default');
      expect(approved.permissionDecision).toBe('allow');
      expect(approved.updatedInput?.command).toMatch(
        /^cleo run --wait .* -- pnpm test 2>&1 \| tail -20$/,
      );
      // Without a matching allow rule the default-mode answer is a warning only.
      expect(askHook(hook, 'pnpm build', 'default').updatedInput).toBeUndefined();

      // 3. One more concurrent run per class than its budget allows (at least
      // three), all at once: admission must hold each class to its budget.
      const before = await budgets();
      const runs = Math.min(8, Math.max(3, before.test + 1, before.build + 1));
      const lines = [
        pnpmTest,
        ...Array.from({ length: runs - 1 }, () => vitest),
        ...Array.from({ length: runs }, () => tsc),
      ];
      const codes = await Promise.all(lines.map(runLine));
      const after = await budgets();
      expect(codes).toEqual(lines.map(() => 0));

      const test = observed('running-test');
      const build = observed('running-build');
      expect(test.runs).toBe(runs);
      expect(build.runs).toBe(runs);
      expect(test.max).toBeGreaterThanOrEqual(1);
      expect(test.max).toBeLessThanOrEqual(Math.max(before.test, after.test));
      expect(build.max).toBeLessThanOrEqual(Math.max(before.build, after.build));
      // Every slot was released.
      expect(readdirSync(join(dir, 'running-test'))).toEqual([]);
      expect(readdirSync(join(dir, 'running-build'))).toEqual([]);
    },
    180_000,
  );
});
