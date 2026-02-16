/**
 * Tests for import-tasks CLI command.
 * @task T4551
 * @epic T4545
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerImportTasksCommand } from '../commands/import-tasks.js';

vi.mock('../../store/json.js', () => ({
  readJson: vi.fn(),
  saveJson: vi.fn(),
  computeChecksum: vi.fn().mockReturnValue('0000000000000000'),
}));

vi.mock('../../core/paths.js', () => ({
  getTodoPath: vi.fn().mockReturnValue('.cleo/todo.json'),
  getBackupDir: vi.fn().mockReturnValue('.cleo/backups/operational'),
}));

describe('registerImportTasksCommand', () => {
  it('registers an import-tasks command on the program', () => {
    const program = new Command();
    registerImportTasksCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'import-tasks');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('ID remapping');
  });

  it('requires a file argument', () => {
    const program = new Command();
    registerImportTasksCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'import-tasks')!;
    expect(cmd.registeredArguments.length).toBe(1);
    expect(cmd.registeredArguments[0].required).toBe(true);
  });

  it('has all conflict resolution options', () => {
    const program = new Command();
    registerImportTasksCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'import-tasks')!;
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain('--dry-run');
    expect(optionNames).toContain('--parent');
    expect(optionNames).toContain('--phase');
    expect(optionNames).toContain('--add-label');
    expect(optionNames).toContain('--no-provenance');
    expect(optionNames).toContain('--reset-status');
    expect(optionNames).toContain('--on-conflict');
    expect(optionNames).toContain('--on-missing-dep');
    expect(optionNames).toContain('--force');
  });

  it('defaults on-conflict to fail', () => {
    const program = new Command();
    registerImportTasksCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'import-tasks')!;
    const opt = cmd.options.find((o) => o.long === '--on-conflict');
    expect(opt?.defaultValue).toBe('fail');
  });

  it('defaults on-missing-dep to strip', () => {
    const program = new Command();
    registerImportTasksCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'import-tasks')!;
    const opt = cmd.options.find((o) => o.long === '--on-missing-dep');
    expect(opt?.defaultValue).toBe('strip');
  });
});
