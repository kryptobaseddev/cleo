/**
 * Tests for claude-migrate CLI command.
 * @task T4551
 * @epic T4545
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerClaudeMigrateCommand } from '../commands/claude-migrate.js';

describe('registerClaudeMigrateCommand', () => {
  it('registers a claude-migrate command on the program', () => {
    const program = new Command();
    registerClaudeMigrateCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'claude-migrate');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('legacy');
  });

  it('has --check, --global, --project, --all, --force options', () => {
    const program = new Command();
    registerClaudeMigrateCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'claude-migrate')!;
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain('--check');
    expect(optionNames).toContain('--global');
    expect(optionNames).toContain('--project');
    expect(optionNames).toContain('--all');
    expect(optionNames).toContain('--force');
  });
});
