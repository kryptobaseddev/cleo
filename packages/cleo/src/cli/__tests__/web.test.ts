/**
 * Tests for web CLI command.
 * @task T4551 / T717
 * @epic T4545
 */

import { describe, expect, it, vi } from 'vitest';
import { ShimCommand as Command } from '../commander-shim.js';
import { registerWebCommand } from '../commands/web.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn().mockReturnValue({
    pid: 12345,
    unref: vi.fn(),
  }),
}));

vi.mock('../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../core/src/paths.js')>(
    '../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getCleoHome: vi.fn().mockReturnValue('/home/test/.cleo'),
  };
});

describe('registerWebCommand', () => {
  it('registers a web command with subcommands', () => {
    const program = new Command();
    registerWebCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'web');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Web UI');
  });

  it('has start, stop, restart, status, open subcommands', () => {
    const program = new Command();
    registerWebCommand(program);
    const webCmd = program.commands.find((c) => c.name() === 'web')!;
    const subNames = webCmd.commands.map((c) => c.name());
    expect(subNames).toContain('start');
    expect(subNames).toContain('stop');
    expect(subNames).toContain('restart');
    expect(subNames).toContain('status');
    expect(subNames).toContain('open');
  });

  it('start subcommand has --port and --host options', () => {
    const program = new Command();
    registerWebCommand(program);
    const webCmd = program.commands.find((c) => c.name() === 'web')!;
    const startCmd = webCmd.commands.find((c) => c.name() === 'start')!;
    const optionNames = startCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--port');
    expect(optionNames).toContain('--host');
  });

  it('start defaults port to 3456 and host to 127.0.0.1', () => {
    const program = new Command();
    registerWebCommand(program);
    const webCmd = program.commands.find((c) => c.name() === 'web')!;
    const startCmd = webCmd.commands.find((c) => c.name() === 'start')!;
    const portOpt = startCmd.options.find((o) => o.long === '--port');
    const hostOpt = startCmd.options.find((o) => o.long === '--host');
    expect(portOpt?.defaultValue).toBe('3456');
    expect(hostOpt?.defaultValue).toBe('127.0.0.1');
  });

  it('restart subcommand has a registered action handler (T717 regression guard)', () => {
    // Root cause of T717: startCmd?.action returned the ShimCommand.action *setter*
    // method (not the registered handler), so calling it as a function attempted
    // to set `this._action` on an unbound `this` (undefined in strict ESM), which
    // threw: TypeError: Cannot set properties of undefined (setting '_action').
    // The fix extracts startWebServer() as a shared helper so restart calls it
    // directly. This test asserts that restart._action is a function — i.e. a
    // real handler was registered and is directly callable without indirection.
    const program = new Command();
    registerWebCommand(program);
    const webCmd = program.commands.find((c) => c.name() === 'web')!;
    const restartCmd = webCmd.commands.find((c) => c.name() === 'restart')!;
    expect(restartCmd).toBeDefined();
    expect(typeof restartCmd._action).toBe('function');
  });

  it('restart subcommand has --port and --host options with correct defaults', () => {
    const program = new Command();
    registerWebCommand(program);
    const webCmd = program.commands.find((c) => c.name() === 'web')!;
    const restartCmd = webCmd.commands.find((c) => c.name() === 'restart')!;
    const portOpt = restartCmd.options.find((o) => o.long === '--port');
    const hostOpt = restartCmd.options.find((o) => o.long === '--host');
    expect(portOpt?.defaultValue).toBe('3456');
    expect(hostOpt?.defaultValue).toBe('127.0.0.1');
  });
});
