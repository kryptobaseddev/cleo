/**
 * Tests for extract CLI command.
 * @task T4551
 * @epic T4545
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerExtractCommand } from '../commands/extract.js';

describe('registerExtractCommand', () => {
  it('registers an extract command on the program', () => {
    const program = new Command();
    registerExtractCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'extract');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('TodoWrite');
  });

  it('requires a file argument', () => {
    const program = new Command();
    registerExtractCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'extract')!;
    expect(cmd.registeredArguments.length).toBe(1);
    expect(cmd.registeredArguments[0].required).toBe(true);
  });

  it('has --dry-run and --default-phase options', () => {
    const program = new Command();
    registerExtractCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'extract')!;
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain('--dry-run');
    expect(optionNames).toContain('--default-phase');
  });
});
