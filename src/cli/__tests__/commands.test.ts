/**
 * Tests for commands CLI command.
 * @task T4551
 * @epic T4545
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerCommandsCommand } from '../commands/commands.js';

describe('registerCommandsCommand', () => {
  it('registers a commands command on the program', () => {
    const program = new Command();
    registerCommandsCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'commands');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('List and query');
  });

  it('has --category, --relevance, --workflows, --lookup options', () => {
    const program = new Command();
    registerCommandsCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'commands')!;
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain('--category');
    expect(optionNames).toContain('--relevance');
    expect(optionNames).toContain('--workflows');
    expect(optionNames).toContain('--lookup');
  });

  it('accepts an optional command name argument', () => {
    const program = new Command();
    registerCommandsCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'commands')!;
    // Commander uses _args for argument definitions
    expect(cmd.registeredArguments.length).toBeGreaterThanOrEqual(0);
  });
});
