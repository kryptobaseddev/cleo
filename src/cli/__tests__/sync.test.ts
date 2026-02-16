/**
 * Tests for sync CLI command.
 * @task T4551
 * @epic T4545
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerSyncCommand } from '../commands/sync.js';

vi.mock('../../store/json.js', () => ({
  readJson: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../core/paths.js', () => ({
  getCleoDir: vi.fn().mockReturnValue('.cleo'),
}));

describe('registerSyncCommand', () => {
  it('registers a sync command with subcommands', () => {
    const program = new Command();
    registerSyncCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'sync');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('TodoWrite');
  });

  it('has status, clear, inject, extract subcommands', () => {
    const program = new Command();
    registerSyncCommand(program);
    const syncCmd = program.commands.find((c) => c.name() === 'sync')!;
    const subNames = syncCmd.commands.map((c) => c.name());
    expect(subNames).toContain('status');
    expect(subNames).toContain('clear');
    expect(subNames).toContain('inject');
    expect(subNames).toContain('extract');
  });

  it('clear subcommand has --dry-run option', () => {
    const program = new Command();
    registerSyncCommand(program);
    const syncCmd = program.commands.find((c) => c.name() === 'sync')!;
    const clearCmd = syncCmd.commands.find((c) => c.name() === 'clear')!;
    const optionNames = clearCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--dry-run');
  });
});
