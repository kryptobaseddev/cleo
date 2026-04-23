/**
 * Smoke tests for the `cleo conduit` command group.
 *
 * Verifies:
 *   1. conduitCommand is exported
 *   2. All 5 subcommands are present with correct names
 *   3. Args definitions match registry params
 *   4. dispatchFromCli is called with correct (gateway, domain, operation, params)
 *
 * @task T469
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dispatchFromCli before importing the command under test
// ---------------------------------------------------------------------------

const mockDispatchFromCli = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import { conduitCommand } from '../conduit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract subcommand definition from conduitCommand.subCommands */
async function getSubCommands(): Promise<Record<string, import('citty').CommandDef>> {
  const resolved =
    typeof conduitCommand.subCommands === 'function'
      ? await conduitCommand.subCommands()
      : conduitCommand.subCommands;
  return (resolved ?? {}) as Record<string, import('citty').CommandDef>;
}

/** Resolve meta from a CommandDef (may be a function) */
async function getMeta(
  cmd: import('citty').CommandDef,
): Promise<{ name?: string; description?: string }> {
  return (typeof cmd.meta === 'function' ? await cmd.meta() : cmd.meta) ?? {};
}

/** Invoke a subcommand's run function with the given args */
async function invokeSubCommand(
  subCmds: Record<string, import('citty').CommandDef>,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const cmd = subCmds[name];
  if (!cmd) throw new Error(`Subcommand "${name}" not found`);
  // run may be async function or sync function
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error(`Subcommand "${name}" has no run function`);
  await runFn({ args, rawArgs: [], cmd: resolved });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('conduit command group (T469)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Export + meta
  // -------------------------------------------------------------------------

  it('conduitCommand is exported', () => {
    expect(conduitCommand).toBeDefined();
  });

  it('root meta name is "conduit"', async () => {
    const meta = await getMeta(conduitCommand);
    expect(meta.name).toBe('conduit');
  });

  it('root meta description mentions Conduit', async () => {
    const meta = await getMeta(conduitCommand);
    expect(meta.description).toContain('Conduit');
  });

  // -------------------------------------------------------------------------
  // 2. All subcommands present (5 base T469 + 3 topic T1254 = 8)
  // -------------------------------------------------------------------------

  it('has exactly 8 subcommands (5 base + 3 topic A2A verbs per T1254)', async () => {
    const subs = await getSubCommands();
    expect(Object.keys(subs)).toHaveLength(8);
  });

  it('has status subcommand', async () => {
    const subs = await getSubCommands();
    expect(subs).toHaveProperty('status');
  });

  it('has peek subcommand', async () => {
    const subs = await getSubCommands();
    expect(subs).toHaveProperty('peek');
  });

  it('has start subcommand', async () => {
    const subs = await getSubCommands();
    expect(subs).toHaveProperty('start');
  });

  it('has stop subcommand', async () => {
    const subs = await getSubCommands();
    expect(subs).toHaveProperty('stop');
  });

  it('has send subcommand', async () => {
    const subs = await getSubCommands();
    expect(subs).toHaveProperty('send');
  });

  // -------------------------------------------------------------------------
  // 3. Subcommand meta names
  // -------------------------------------------------------------------------

  for (const name of ['status', 'peek', 'start', 'stop', 'send']) {
    it(`${name} subcommand meta.name is "${name}"`, async () => {
      const subs = await getSubCommands();
      const meta = await getMeta(subs[name]);
      expect(meta.name).toBe(name);
    });
  }

  // -------------------------------------------------------------------------
  // 4. Args definitions match registry params
  // -------------------------------------------------------------------------

  it('peek subcommand has limit arg', async () => {
    const subs = await getSubCommands();
    const peek = (typeof subs['peek'] === 'function' ? await subs['peek']() : subs['peek']) as {
      args?: Record<string, unknown>;
    };
    expect(peek.args).toHaveProperty('limit');
  });

  it('peek subcommand has agent-id arg', async () => {
    const subs = await getSubCommands();
    const peek = (typeof subs['peek'] === 'function' ? await subs['peek']() : subs['peek']) as {
      args?: Record<string, unknown>;
    };
    expect(peek.args).toHaveProperty('agent-id');
  });

  it('send subcommand has content arg (required)', async () => {
    const subs = await getSubCommands();
    const send = (typeof subs['send'] === 'function' ? await subs['send']() : subs['send']) as {
      args?: Record<string, { required?: boolean }>;
    };
    expect(send.args).toHaveProperty('content');
    expect(send.args?.content?.required).toBe(true);
  });

  it('send subcommand has to arg', async () => {
    const subs = await getSubCommands();
    const send = (typeof subs['send'] === 'function' ? await subs['send']() : subs['send']) as {
      args?: Record<string, unknown>;
    };
    expect(send.args).toHaveProperty('to');
  });

  it('start subcommand has interval arg', async () => {
    const subs = await getSubCommands();
    const start = (typeof subs['start'] === 'function' ? await subs['start']() : subs['start']) as {
      args?: Record<string, unknown>;
    };
    expect(start.args).toHaveProperty('interval');
  });

  // -------------------------------------------------------------------------
  // 5. Dispatch wiring — correct gateway, domain, operation
  // -------------------------------------------------------------------------

  it('status dispatches to query conduit.status (T964)', async () => {
    const subs = await getSubCommands();
    await invokeSubCommand(subs, 'status', {});
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
    const [gateway, domain, operation] = mockDispatchFromCli.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(gateway).toBe('query');
    expect(domain).toBe('conduit');
    expect(operation).toBe('status');
  });

  it('peek dispatches to query conduit.peek (T964)', async () => {
    const subs = await getSubCommands();
    await invokeSubCommand(subs, 'peek', { limit: '10' });
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
    const [gateway, domain, operation] = mockDispatchFromCli.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(gateway).toBe('query');
    expect(domain).toBe('conduit');
    expect(operation).toBe('peek');
  });

  it('start dispatches to mutate conduit.start (T964)', async () => {
    const subs = await getSubCommands();
    await invokeSubCommand(subs, 'start', { interval: '5000' });
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
    const [gateway, domain, operation] = mockDispatchFromCli.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(gateway).toBe('mutate');
    expect(domain).toBe('conduit');
    expect(operation).toBe('start');
  });

  it('stop dispatches to mutate conduit.stop (T964)', async () => {
    const subs = await getSubCommands();
    await invokeSubCommand(subs, 'stop', {});
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
    const [gateway, domain, operation] = mockDispatchFromCli.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(gateway).toBe('mutate');
    expect(domain).toBe('conduit');
    expect(operation).toBe('stop');
  });

  it('send dispatches to mutate conduit.send with content (T964)', async () => {
    const subs = await getSubCommands();
    await invokeSubCommand(subs, 'send', {
      to: 'agent-b',
      content: 'hello from test',
    });
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
    const [gateway, domain, operation, params] = mockDispatchFromCli.mock.calls[0] as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(gateway).toBe('mutate');
    expect(domain).toBe('conduit');
    expect(operation).toBe('send');
    expect(params.to).toBe('agent-b');
    expect(params.content).toBe('hello from test');
  });

  it('peek passes limit as number to dispatch', async () => {
    const subs = await getSubCommands();
    await invokeSubCommand(subs, 'peek', { limit: '5' });
    const [, , , params] = mockDispatchFromCli.mock.calls[0] as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(typeof params.limit).toBe('number');
    expect(params.limit).toBe(5);
  });
});
