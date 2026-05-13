/**
 * CLI wiring tests for `cleo llm` subcommands (T9258).
 *
 * Verifies that every documented subcommand exists, has meta, and routes
 * through `dispatchFromCli('mutate' | 'query', 'llm', <op>, <params>)`.
 *
 * Engine-level redaction + envelope-shape tests live alongside the engine
 * code in `packages/core/src/llm/__tests__/cli-ops.test.ts` where relative
 * mock paths resolve cleanly — mocking the source modules from outside
 * `packages/core` would require aliasing every internal path, which the
 * vitest config does not (and should not) do for individual files.
 *
 * @task T9258
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the command module so the
// static `dispatchFromCli` binding inside llm.ts is replaced.
// ---------------------------------------------------------------------------

const mockDispatchFromCli = vi.fn().mockResolvedValue(undefined);

vi.mock('../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { CommandDef } from 'citty';
import { llmCommand } from '../commands/llm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getLlmSubs(): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof llmCommand.subCommands === 'function'
      ? await llmCommand.subCommands()
      : llmCommand.subCommands;
  return (resolved ?? {}) as Record<string, CommandDef>;
}

async function runSub(
  cmd: CommandDef,
  args: Record<string, unknown>,
  rawArgs: string[] = [],
): Promise<void> {
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('Subcommand has no run function');
  await runFn({ args, rawArgs, cmd: resolved });
}

// ---------------------------------------------------------------------------
// CLI wiring tests
// ---------------------------------------------------------------------------

describe('cleo llm — CLI wiring', () => {
  beforeEach(() => {
    mockDispatchFromCli.mockClear();
  });

  it('exposes every documented subcommand', async () => {
    const subs = await getLlmSubs();
    expect(Object.keys(subs).sort()).toEqual(
      ['add', 'list', 'profile', 'remove', 'test', 'use', 'whoami'].sort(),
    );
  });

  // ---------------------------------------------------------------------
  // S-11 — secret-on-argv mitigation
  // ---------------------------------------------------------------------

  it('add (S-11) — --api-key=<value> emits the verbatim deprecation warning on stderr', async () => {
    const subs = await getLlmSubs();
    // Capture by replacing process.stderr.write directly; vi.spyOn doesn't
    // intercept the `write` symbol once the citty `run` closure has bound
    // it earlier in the module-load chain.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((s: unknown) => {
      captured.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runSub(subs['add']!, {
        provider: 'anthropic',
        'api-key': 'sk-FAKE',
        label: 'test',
      });
    } finally {
      process.stderr.write = origWrite;
    }
    const warned = captured.find((s) =>
      s.includes(
        "[warning] --api-key exposes the secret to 'ps' listings and shell history. Prefer --api-key-stdin or --api-key-env=NAME for production use.",
      ),
    );
    expect(warned, 'verbatim S-11 deprecation warning must be emitted').toBeDefined();
    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[3]).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-FAKE',
      label: 'test',
      _source: 'flag',
    });
  });

  it('add (S-11) — --api-key-env=NAME reads from env + emits NO deprecation warning', async () => {
    const subs = await getLlmSubs();
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((s: unknown) => {
      captured.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    process.env['__LLM_TEST_KEY'] = 'sk-env-1234';
    try {
      await runSub(subs['add']!, {
        provider: 'openai',
        'api-key-env': '__LLM_TEST_KEY',
        label: 'env-test',
      });
    } finally {
      process.stderr.write = origWrite;
      delete process.env['__LLM_TEST_KEY'];
    }
    const warned = captured.find((s) => s.includes('[warning] --api-key exposes'));
    expect(warned, 'no S-11 deprecation warning on --api-key-env path').toBeUndefined();
    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[3]).toMatchObject({
      provider: 'openai',
      apiKey: 'sk-env-1234',
      label: 'env-test',
      _source: 'env',
    });
  });

  it('add (S-11) — --api-key-stdin reads from piped stdin + emits NO deprecation warning', async () => {
    const subs = await getLlmSubs();
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((s: unknown) => {
      captured.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    // Patch the stdin stream so the async iterator yields our buffered key
    // and isTTY=false (i.e. we're being piped).
    const origStdin = process.stdin;
    const fakeStdin = {
      isTTY: false,
      setEncoding: () => {},
      async *[Symbol.asyncIterator]() {
        yield 'sk-stdin-9999\n';
      },
    };
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    try {
      await runSub(subs['add']!, {
        provider: 'anthropic',
        'api-key-stdin': true,
        label: 'pipe',
      });
    } finally {
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
      process.stderr.write = origWrite;
    }
    const warned = captured.find((s) => s.includes('[warning] --api-key exposes'));
    expect(warned, 'no S-11 deprecation warning on --api-key-stdin path').toBeUndefined();
    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[3]).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-stdin-9999',
      label: 'pipe',
      _source: 'stdin',
    });
  });

  it('add (S-11) — --api-key-stdin takes priority over --api-key when both supplied', async () => {
    const subs = await getLlmSubs();
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((s: unknown) => {
      captured.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    const origStdin = process.stdin;
    const fakeStdin = {
      isTTY: false,
      setEncoding: () => {},
      async *[Symbol.asyncIterator]() {
        yield 'STDIN-WINS\n';
      },
    };
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    try {
      await runSub(subs['add']!, {
        provider: 'anthropic',
        'api-key-stdin': true,
        'api-key': 'FLAG-LOSES',
      });
    } finally {
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
      process.stderr.write = origWrite;
    }
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[3]).toMatchObject({ apiKey: 'STDIN-WINS', _source: 'stdin' });
    // The deprecation warning must NOT fire when stdin wins.
    const warned = captured.find((s) => s.includes('[warning] --api-key exposes'));
    expect(warned).toBeUndefined();
  });

  it('add — forwards base-url and priority when supplied', async () => {
    const subs = await getLlmSubs();
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await runSub(subs['add']!, {
        provider: 'moonshot',
        'api-key': 'tok',
        'base-url': 'https://example.test',
        priority: '5',
      });
    } finally {
      process.stderr.write = origWrite;
    }
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[3]).toMatchObject({
      provider: 'moonshot',
      apiKey: 'tok',
      baseUrl: 'https://example.test',
      priority: 5,
    });
  });

  it('list — dispatches query/llm/list with no params when provider absent', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['list']!, {});
    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('query');
    expect(call[2]).toBe('list');
    expect(call[3]).toEqual({});
  });

  it('list — forwards positional provider filter', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['list']!, { provider: 'openai' });
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[3]).toEqual({ provider: 'openai' });
  });

  it('remove — dispatches mutate/llm/remove with provider + label', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['remove']!, { provider: 'anthropic', label: 'work' });
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('mutate');
    expect(call[2]).toBe('remove');
    expect(call[3]).toEqual({ provider: 'anthropic', label: 'work' });
  });

  it('use — dispatches mutate/llm/use with provider + model', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['use']!, { provider: 'openai', model: 'gpt-5-mini' });
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('mutate');
    expect(call[2]).toBe('use');
    expect(call[3]).toEqual({ provider: 'openai', model: 'gpt-5-mini' });
  });

  it('profile — dispatches mutate/llm/profile with role + provider + model + credentialLabel', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['profile']!, {
      role: 'extraction',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      'credential-label': 'work',
    });
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('mutate');
    expect(call[2]).toBe('profile');
    expect(call[3]).toEqual({
      role: 'extraction',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      credentialLabel: 'work',
    });
  });

  it('test — dispatches query/llm/test with provider + label', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['test']!, { provider: 'anthropic', label: 'work' });
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('query');
    expect(call[2]).toBe('test');
    expect(call[3]).toEqual({ provider: 'anthropic', label: 'work' });
  });

  it('whoami — dispatches query/llm/whoami without role filter', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['whoami']!, {});
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('query');
    expect(call[2]).toBe('whoami');
    expect(call[3]).toEqual({});
  });

  it('whoami — forwards role filter when set', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['whoami']!, { role: 'extraction' });
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[3]).toEqual({ role: 'extraction' });
  });

  it('every subcommand has --json flag', async () => {
    const subs = await getLlmSubs();
    for (const [name, sub] of Object.entries(subs)) {
      const resolved = typeof sub === 'function' ? await sub() : sub;
      const args = (resolved as { args?: Record<string, unknown> }).args ?? {};
      expect(args, `subcommand '${name}' must expose --json`).toHaveProperty('json');
    }
  });
});
