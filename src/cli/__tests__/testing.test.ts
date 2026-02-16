/**
 * Tests for testing CLI command.
 * @task T4551
 * @epic T4545
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerTestingCommand } from '../commands/testing.js';

describe('registerTestingCommand', () => {
  it('registers a testing command with subcommands', () => {
    const program = new Command();
    registerTestingCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'testing');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('testing protocol');
  });

  it('has validate and check subcommands', () => {
    const program = new Command();
    registerTestingCommand(program);
    const testingCmd = program.commands.find((c) => c.name() === 'testing')!;
    const subNames = testingCmd.commands.map((c) => c.name());
    expect(subNames).toContain('validate');
    expect(subNames).toContain('check');
  });

  it('validate subcommand requires taskId argument', () => {
    const program = new Command();
    registerTestingCommand(program);
    const testingCmd = program.commands.find((c) => c.name() === 'testing')!;
    const validateCmd = testingCmd.commands.find((c) => c.name() === 'validate')!;
    expect(validateCmd.registeredArguments.length).toBe(1);
    expect(validateCmd.registeredArguments[0].required).toBe(true);
  });

  it('check subcommand requires manifestFile argument', () => {
    const program = new Command();
    registerTestingCommand(program);
    const testingCmd = program.commands.find((c) => c.name() === 'testing')!;
    const checkCmd = testingCmd.commands.find((c) => c.name() === 'check')!;
    expect(checkCmd.registeredArguments.length).toBe(1);
    expect(checkCmd.registeredArguments[0].required).toBe(true);
  });

  it('both subcommands have --strict option', () => {
    const program = new Command();
    registerTestingCommand(program);
    const testingCmd = program.commands.find((c) => c.name() === 'testing')!;

    const validateCmd = testingCmd.commands.find((c) => c.name() === 'validate')!;
    expect(validateCmd.options.map((o) => o.long)).toContain('--strict');

    const checkCmd = testingCmd.commands.find((c) => c.name() === 'check')!;
    expect(checkCmd.options.map((o) => o.long)).toContain('--strict');
  });
});
