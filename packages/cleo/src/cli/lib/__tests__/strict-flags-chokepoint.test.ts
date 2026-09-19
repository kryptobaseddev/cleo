/**
 * Unknown flags are rejected for EVERY command that reaches the lazy-command
 * chokepoint (T12139 · GH #1245).
 *
 * Why this file exists separately from `strict-args`' own unit tests
 * -----------------------------------------------------------------
 * `assertKnownFlags` has been complete and passing its unit tests since
 * T10359 — while 110 of ~111 commands went unguarded, because `docs` was its
 * only caller. So a test of the FUNCTION proves nothing about the WIRING.
 * These tests assert the behaviour through the chokepoint, and through a
 * command that never opted in.
 *
 * @task T12139
 */

import { runCommand } from 'citty';
import { describe, expect, it, vi } from 'vitest';
import { assertKnownFlags, CLI_GLOBAL_FLAGS, UnknownFlagError } from '../strict-args.js';

describe('CLI_GLOBAL_FLAGS is the SSoT that index.ts parses (T12139)', () => {
  /**
   * A second hand-maintained list of global flags is the divergence this whole
   * cluster is about: a guard whose allowlist drifts from the entry point's
   * parser starts REJECTING valid flags, which is worse than the silence it
   * replaced. So the parser is asserted against the constant.
   */
  it('contains every flag the entry point strips from argv', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(join(here, '../../index.ts')), 'utf-8');

    // The global-flag parser is a chain of `arg === '--x'` comparisons.
    const parsed = new Set(
      [...source.matchAll(/arg === '(--[a-z-]+)'/g)].map((m) => m[1] as string),
    );
    expect(parsed.size).toBeGreaterThan(5); // guard against a regex that stops matching

    const missing = [...parsed].filter((f) => !CLI_GLOBAL_FLAGS.includes(f)).sort();
    expect(missing).toEqual([]);
  });

  it('is frozen, so a caller cannot mutate the allowlist at runtime', () => {
    expect(Object.isFrozen(CLI_GLOBAL_FLAGS)).toBe(true);
  });
});

describe('the chokepoint actually reaches the guard (T12139)', () => {
  /**
   * The load-bearing assertion. `list` never called `assertKnownFlags`; it was
   * the command that returned all 3,173 tasks for `--severity P0` because the
   * flag did not exist and nothing rejected it. If the chokepoint is wired
   * correctly, an unknown flag on `list` now throws — WITHOUT `list` opting in.
   */
  it('rejects an unknown flag on a command that never opted in', async () => {
    const { listCommand } = await import('../../commands/list.js');
    expect(() => assertKnownFlags(['--bogus-flag', 'x'], listCommand.args, 'list')).toThrow(
      UnknownFlagError,
    );
  });

  it('passes a real flag on that same command', async () => {
    const { listCommand } = await import('../../commands/list.js');
    expect(() => assertKnownFlags(['--status', 'pending'], listCommand.args, 'list')).not.toThrow();
  });

  it('passes a GLOBAL flag that the command does not declare', async () => {
    // `--json` is stripped by index.ts and declared by no command. Without the
    // CLI_GLOBAL_FLAGS allowlist this would reject every piped invocation.
    const { listCommand } = await import('../../commands/list.js');
    for (const global of ['--json', '--quiet', '--output', '--field', '--summary']) {
      expect(() => assertKnownFlags([global, 'x'], listCommand.args, 'list')).not.toThrow();
    }
  });

  it('names the flag, the closest valid flag, and the full valid surface', async () => {
    const { listCommand } = await import('../../commands/list.js');
    let caught: UnknownFlagError | undefined;
    try {
      assertKnownFlags(['--stat'], listCommand.args, 'list');
    } catch (err) {
      caught = err instanceof UnknownFlagError ? err : undefined;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("unknown flag '--stat' for 'list'");
    expect(caught?.suggestions).toContain('--status');
    // knownFlags is the command's whole accepted surface — suggestions alone
    // tell a caller what is CLOSE to their typo, not what is valid.
    expect(caught?.knownFlags).toContain('--status');
    expect(caught?.knownFlags.length).toBeGreaterThan(3);
  });

  /**
   * The bug this PR would otherwise have reintroduced. `lazyCommand` exposes
   * `args` as an async thunk so the module stays unloaded; `assertKnownFlags`
   * deliberately BAILS OUT on a resolvable schema rather than throwing. Pass
   * the thunk and you get a guard that silently guards nothing.
   */
  it('bails out silently on a thunk schema — which is why the LOADED args must be used', () => {
    const thunk = (async () => ({ status: { type: 'string' } })) as never;
    // No throw: the guard cannot see the schema, so it declines to judge.
    expect(() => assertKnownFlags(['--definitely-not-a-flag'], thunk, 'list')).not.toThrow();
  });
});

describe('lazy-command wiring (T12139)', () => {
  it('validates child flags against the resolved child schema before any hooks', async () => {
    const { lazyCommand } = await import('../../lazy-command.js');
    const childRun = vi.fn();
    const parentSetup = vi.fn();
    const wrapper = lazyCommand({ name: 'doctor', description: 'fixture' }, async () => ({
      args: {},
      setup: parentSetup,
      subCommands: async () => ({
        knowledge: async () => ({
          args: async () => ({
            task: { type: 'string' as const },
            fix: { type: 'boolean' as const },
          }),
          run: childRun,
        }),
      }),
    }));
    await runCommand(wrapper, { rawArgs: ['knowledge', '--task', 'T448'] });
    expect(parentSetup).toHaveBeenCalledOnce();
    expect(childRun).toHaveBeenCalledOnce();
  });

  it('rejects unknown child flags before parent setup or child mutations', async () => {
    const { lazyCommand } = await import('../../lazy-command.js');
    const childSetup = vi.fn();
    const childRun = vi.fn();
    const parentSetup = vi.fn();
    const wrapper = lazyCommand({ name: 'doctor', description: 'fixture' }, async () => ({
      args: {},
      setup: parentSetup,
      subCommands: {
        knowledge: {
          args: { fix: { type: 'boolean' as const } },
          setup: childSetup,
          run: childRun,
        },
      },
    }));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit__');
    });
    try {
      await expect(
        runCommand(wrapper, { rawArgs: ['knowledge', '--fix', '--task-id', 'T448'] }),
      ).rejects.toThrow('__exit__');
      expect(parentSetup).not.toHaveBeenCalled();
      expect(childSetup).not.toHaveBeenCalled();
      expect(childRun).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('validates before delegating to the loaded command run', async () => {
    const { lazyCommand } = await import('../../lazy-command.js');
    const run = vi.fn();
    const wrapper = lazyCommand({ name: 'probe', description: 'p' }, async () => ({
      meta: { name: 'probe', description: 'p' },
      args: { real: { type: 'string' } },
      run,
    }));

    // A valid flag reaches the command.
    await wrapper.run?.({ args: { _: [] }, rawArgs: ['--real', 'v'], cmd: {}, data: {} } as never);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does NOT delegate when an unknown flag is present', async () => {
    const { lazyCommand } = await import('../../lazy-command.js');
    const run = vi.fn();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    const wrapper = lazyCommand({ name: 'probe', description: 'p' }, async () => ({
      meta: { name: 'probe', description: 'p' },
      args: { real: { type: 'string' } },
      run,
    }));

    try {
      await expect(
        wrapper.run?.({ args: { _: [] }, rawArgs: ['--nope'], cmd: {}, data: {} } as never),
      ).rejects.toThrow('__exit__');
      // The command body must never run on a rejected invocation.
      expect(run).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});

describe('a POSITIONAL parameter is accepted in --name form (T12139)', () => {
  /**
   * The regression this PR nearly shipped. `cleo add`'s `title` is declared
   * `type: 'positional'`, yet `cleo add --title "..."` is the form
   * CLEO-INJECTION.md documents everywhere and that every agent uses — it
   * works because citty's non-strict parse populates `args.title` for both
   * spellings. Skipping positionals in the known-flag set made the guard
   * reject the single most-used documented invocation in the system:
   *
   *   E_UNKNOWN_FLAG: unknown flag '--title' for 'add'.
   *                   Did you mean: --files, --note, --size, --type?
   */
  it('accepts --title on `add`, whose title is a positional', async () => {
    const { addCommand } = await import('../../commands/add.js');
    expect(() => assertKnownFlags(['--title', 'x'], addCommand.args, 'add')).not.toThrow();
  });

  it('still rejects a flag the command genuinely does not have', async () => {
    const { addCommand } = await import('../../commands/add.js');
    expect(() => assertKnownFlags(['--ttile', 'x'], addCommand.args, 'add')).toThrow(
      UnknownFlagError,
    );
  });
});

describe('a retired flag is rejected WITH the replacement mechanism (T12139)', () => {
  /**
   * My first implementation let retired flags PASS THROUGH, assuming dispatch's
   * `E_FLAG_REMOVED` would produce a better error. Measured against the built
   * binary, it does not: `complete.ts` never forwards `force` to dispatch, so
   * that error is reachable only by SDK/dispatch callers. From the CLI,
   * `--force` was silently ignored and the caller got an unrelated evidence-gate
   * failure instead.
   *
   * Passing it through would therefore have restored the exact defect this
   * guard removes — a flag accepted and silently discarded. So it is rejected,
   * and the rejection carries the remedy rather than a spelling suggestion.
   */
  it('rejects `complete --force` rather than silently ignoring it', async () => {
    const { completeCommand } = await import('../../commands/complete.js');
    expect(() => assertKnownFlags(['T123', '--force'], completeCommand.args, 'complete')).toThrow(
      UnknownFlagError,
    );
  });

  it('names the replacement mechanism instead of a did-you-mean', async () => {
    const { completeCommand } = await import('../../commands/complete.js');
    let caught: UnknownFlagError | undefined;
    try {
      assertKnownFlags(['T123', '--force'], completeCommand.args, 'complete');
    } catch (err) {
      caught = err instanceof UnknownFlagError ? err : undefined;
    }
    expect(caught?.retiredGuidance).toBeDefined();
    expect(caught?.fix).toContain('ADR-051');
    expect(caught?.fix).toContain('cleo verify');
    // The caller's problem is not a typo, so no spelling suggestion.
    expect(caught?.fix).not.toContain('Try one of:');
  });

  it('applies the guidance to the `done` alias too', () => {
    const args = { taskId: { type: 'positional' as const } };
    let caught: UnknownFlagError | undefined;
    try {
      assertKnownFlags(['T123', '--force'], args, 'done');
    } catch (err) {
      caught = err instanceof UnknownFlagError ? err : undefined;
    }
    expect(caught?.fix).toContain('ADR-051');
  });

  it('is scoped per command — a normal unknown flag keeps the did-you-mean', async () => {
    const { listCommand } = await import('../../commands/list.js');
    let caught: UnknownFlagError | undefined;
    try {
      assertKnownFlags(['--stat'], listCommand.args, 'list');
    } catch (err) {
      caught = err instanceof UnknownFlagError ? err : undefined;
    }
    expect(caught?.retiredGuidance).toBeUndefined();
    expect(caught?.fix).toContain('Try one of:');
  });
});
