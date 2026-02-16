/**
 * Tests for web CLI command.
 * @task T4551
 * @epic T4545
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerWebCommand } from '../commands/web.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn().mockReturnValue({
    pid: 12345,
    unref: vi.fn(),
  }),
}));

vi.mock('../../core/paths.js', () => ({
  getCleoHome: vi.fn().mockReturnValue('/home/test/.cleo'),
}));

describe('registerWebCommand', () => {
  it('registers a web command with subcommands', () => {
    const program = new Command();
    registerWebCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'web');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Web UI');
  });

  it('has start, stop, status, open subcommands', () => {
    const program = new Command();
    registerWebCommand(program);
    const webCmd = program.commands.find((c) => c.name() === 'web')!;
    const subNames = webCmd.commands.map((c) => c.name());
    expect(subNames).toContain('start');
    expect(subNames).toContain('stop');
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
});
