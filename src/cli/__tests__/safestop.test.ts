/**
 * Tests for safestop CLI command.
 * @task T4551
 * @epic T4545
 *  T4904
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerSafestopCommand } from '../commands/safestop.js';

vi.mock('../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn().mockResolvedValue(undefined),
}));

describe('registerSafestopCommand', () => {
  it('registers a safestop command on the program', () => {
    const program = new Command();
    registerSafestopCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'safestop');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Graceful shutdown');
  });

  it('requires --reason option', () => {
    const program = new Command();
    registerSafestopCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'safestop')!;
    const reasonOpt = cmd.options.find((o) => o.long === '--reason');
    expect(reasonOpt).toBeDefined();
    expect(reasonOpt!.required).toBe(true);
  });

  it('has --commit, --handoff, --no-session-end, --dry-run options', () => {
    const program = new Command();
    registerSafestopCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'safestop')!;
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain('--commit');
    expect(optionNames).toContain('--handoff');
    expect(optionNames).toContain('--no-session-end');
    expect(optionNames).toContain('--dry-run');
  });
});
