/**
 * Tests for export-tasks CLI command (native citty).
 * @task T4551
 * @epic T4545
 */

import { describe, expect, it } from 'vitest';
import { exportTasksCommand } from '../commands/export-tasks.js';

describe('exportTasksCommand (native citty)', () => {
  it('exports a command with the correct name', () => {
    expect(exportTasksCommand).toBeDefined();
    const meta =
      typeof exportTasksCommand.meta === 'function'
        ? exportTasksCommand.meta()
        : exportTasksCommand.meta;
    expect((meta as { name: string }).name).toBe('export-tasks');
  });

  it('has a description containing "portable"', () => {
    const meta =
      typeof exportTasksCommand.meta === 'function'
        ? exportTasksCommand.meta()
        : exportTasksCommand.meta;
    expect((meta as { description: string }).description).toContain('portable');
  });

  it('defines --output, --subtree, --filter, --include-deps, --dry-run args', () => {
    const args = exportTasksCommand.args as Record<string, { type: string }> | undefined;
    expect(args).toBeDefined();
    expect(args?.['output']).toBeDefined();
    expect(args?.['subtree']).toBeDefined();
    expect(args?.['filter']).toBeDefined();
    expect(args?.['include-deps']).toBeDefined();
    expect(args?.['dry-run']).toBeDefined();
  });

  it('accepts task IDs as positional argument', () => {
    const args = exportTasksCommand.args as
      | Record<string, { type: string; required?: boolean }>
      | undefined;
    const taskIdsArg = args?.['taskIds'];
    expect(taskIdsArg).toBeDefined();
    expect(taskIdsArg?.type).toBe('positional');
  });
});
