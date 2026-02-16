/**
 * Tests for docs CLI command.
 * @task T4551
 * @epic T4545
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerDocsCommand } from '../commands/docs.js';

describe('registerDocsCommand', () => {
  it('registers a docs command with subcommands', () => {
    const program = new Command();
    registerDocsCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'docs');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Documentation');
  });

  it('has sync and gap-check subcommands', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const subNames = docsCmd.commands.map((c) => c.name());
    expect(subNames).toContain('sync');
    expect(subNames).toContain('gap-check');
  });

  it('sync subcommand has --quick and --strict options', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const syncCmd = docsCmd.commands.find((c) => c.name() === 'sync')!;
    const optionNames = syncCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--quick');
    expect(optionNames).toContain('--strict');
  });

  it('gap-check subcommand has --epic and --task options', () => {
    const program = new Command();
    registerDocsCommand(program);
    const docsCmd = program.commands.find((c) => c.name() === 'docs')!;
    const gapCmd = docsCmd.commands.find((c) => c.name() === 'gap-check')!;
    const optionNames = gapCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--epic');
    expect(optionNames).toContain('--task');
  });
});
