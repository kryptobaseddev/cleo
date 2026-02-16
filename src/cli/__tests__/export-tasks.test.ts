/**
 * Tests for export-tasks CLI command.
 * @task T4551
 * @epic T4545
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerExportTasksCommand } from '../commands/export-tasks.js';

vi.mock('../../store/json.js', () => ({
  readJson: vi.fn(),
}));

vi.mock('../../core/paths.js', () => ({
  getTodoPath: vi.fn().mockReturnValue('.cleo/todo.json'),
}));

vi.mock('../../store/export.js', () => ({
  buildExportPackage: vi.fn().mockReturnValue({
    _meta: { format: 'cleo-export', taskCount: 0 },
    tasks: [],
  }),
}));

describe('registerExportTasksCommand', () => {
  it('registers an export-tasks command on the program', () => {
    const program = new Command();
    registerExportTasksCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'export-tasks');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('portable');
  });

  it('has expected options', () => {
    const program = new Command();
    registerExportTasksCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'export-tasks')!;
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain('--output');
    expect(optionNames).toContain('--subtree');
    expect(optionNames).toContain('--filter');
    expect(optionNames).toContain('--include-deps');
    expect(optionNames).toContain('--dry-run');
  });

  it('accepts variadic task ID arguments', () => {
    const program = new Command();
    registerExportTasksCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'export-tasks')!;
    expect(cmd.registeredArguments.length).toBe(1);
    expect(cmd.registeredArguments[0].variadic).toBe(true);
  });
});
