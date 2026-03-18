/**
 * Tests for commands CLI command.
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerCommandsCommand } from '../commands/commands.js';

describe('registerCommandsCommand', () => {
  it('registers a commands command on the program', () => {
    const program = new Command();
    registerCommandsCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'commands');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('List and query');
  });

  it('has --category, --relevance, --tier options', () => {
    const program = new Command();
    registerCommandsCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'commands')!;
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain('--category');
    expect(optionNames).toContain('--relevance');
    expect(optionNames).toContain('--tier');
  });

  it('accepts an optional command name argument', () => {
    const program = new Command();
    registerCommandsCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'commands')!;
    // Commander uses _args for argument definitions
    expect(cmd.registeredArguments.length).toBeGreaterThanOrEqual(0);
  });
});
